import {
  APICallError,
  JSONParseError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
  TypeValidationError,
} from 'ai';

/**
 * Sorting LLM failures into the few kinds the router reacts to differently.
 *
 * The router's whole job is "what do we do after this failure": wait and retry,
 * try another provider, or stop using a provider for the rest of the run. That
 * decision depends on the kind of failure, not on the exact message, so every
 * error is first boiled down to one of these kinds.
 */
export type LlmErrorKind =
  /** 429: too many requests or tokens for now. Waiting helps. */
  | 'rate-limit'
  /** 401/403: bad or missing key. Retrying cannot help for the whole run. */
  | 'auth'
  /** 404: usually a model id that does not exist (or is not free) for this key. */
  | 'not-found'
  /** 413, or a 400 that says the input is too long for this model. */
  | 'too-large'
  /** Any other 4xx: the provider rejected this request as it is. */
  | 'bad-request'
  /** 5xx: the provider is having trouble. Waiting may help. */
  | 'server'
  /** No HTTP response at all: DNS, refused connection, reset. */
  | 'network'
  /** Our own per-call timer ran out. */
  | 'timeout'
  /** The model answered, but not with JSON that matches the schema. */
  | 'invalid-output';

export interface ClassifiedError {
  kind: LlmErrorKind;
  statusCode: number | null;
  /** How long the provider asked us to wait, in seconds, when it said. */
  retryAfterSec: number | null;
  message: string;
}

/**
 * Classifies an error thrown by `generateText`. Returns null for errors that
 * are not a provider failure, such as a bug in our own code or the caller
 * cancelling: those must propagate instead of being retried on another provider.
 */
export function classifyLlmError(error: unknown, timedOut: boolean): ClassifiedError | null {
  if (timedOut) {
    return { kind: 'timeout', statusCode: null, retryAfterSec: null, message: 'timed out' };
  }
  // With maxRetries: 0 the SDK throws the provider error itself, but if it ever
  // wraps it in a RetryError, the last attempt's error is the one that counts.
  const cause = RetryError.isInstance(error) ? error.lastError : error;

  if (APICallError.isInstance(cause)) {
    const status = cause.statusCode ?? null;
    const message = shorten(cause.message);
    if (status === null) {
      return { kind: 'network', statusCode: null, retryAfterSec: null, message };
    }
    if (status === 429) {
      return {
        kind: 'rate-limit',
        statusCode: status,
        retryAfterSec: retryAfterOf(cause),
        message,
      };
    }
    if (status === 401 || status === 403) {
      return { kind: 'auth', statusCode: status, retryAfterSec: null, message };
    }
    if (status === 404) {
      return { kind: 'not-found', statusCode: status, retryAfterSec: null, message };
    }
    if (status === 413 || (status === 400 && looksTooLarge(cause))) {
      return { kind: 'too-large', statusCode: status, retryAfterSec: null, message };
    }
    if (status >= 500) {
      return { kind: 'server', statusCode: status, retryAfterSec: null, message };
    }
    return { kind: 'bad-request', statusCode: status, retryAfterSec: null, message };
  }

  if (
    NoObjectGeneratedError.isInstance(cause) ||
    NoOutputGeneratedError.isInstance(cause) ||
    TypeValidationError.isInstance(cause) ||
    JSONParseError.isInstance(cause)
  ) {
    return {
      kind: 'invalid-output',
      statusCode: null,
      retryAfterSec: null,
      message: shorten(cause.message),
    };
  }
  return null;
}

/**
 * Reads how long a 429 asks us to wait. Providers say it in different places:
 * the standard `retry-after` header (seconds, or an HTTP date), OpenAI-style
 * `retry-after-ms`, or, for Gemini, a `retryDelay: "37s"` field in the JSON body.
 */
export function retryAfterOf(
  error: Pick<APICallError, 'responseHeaders' | 'responseBody'>,
  now = Date.now(),
): number | null {
  const headers = lowerCaseKeys(error.responseHeaders ?? {});
  const ms = Number(headers['retry-after-ms']);
  if (headers['retry-after-ms'] !== undefined && Number.isFinite(ms) && ms >= 0) {
    return ms / 1000;
  }
  const header = headers['retry-after'];
  if (header !== undefined) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds;
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.max(0, (date - now) / 1000);
    }
  }
  const match = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(error.responseBody ?? '');
  if (match?.[1] !== undefined) {
    return Number(match[1]);
  }
  return null;
}

/** Providers report "your prompt is too long" as a plain 400, with varying words. */
function looksTooLarge(error: APICallError): boolean {
  const text = `${error.message} ${error.responseBody ?? ''}`;
  return /context.{0,20}(length|window)|too (long|large)|maximum.{0,30}tokens|token limit|exceeds/i.test(
    text,
  );
}

function lowerCaseKeys(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

/** Provider messages can include the whole request echo; logs need one line. */
function shorten(message: string): string {
  const oneLine = message.replace(/\s+/g, ' ').trim();
  return oneLine.length > 300 ? `${oneLine.slice(0, 300)}...` : oneLine;
}

/**
 * Thrown when no provider could answer. Callers catch it and carry on without
 * the LLM: the changelog reader reports "breaking changes unknown", the fix
 * agent stops, and the PR text falls back to its template.
 */
export class LlmUnavailableError extends Error {
  readonly reason: 'no-providers' | 'budget' | 'all-failed';
  /** One line per provider that was skipped or failed, for the report. */
  readonly details: string[];

  constructor(reason: LlmUnavailableError['reason'], details: string[]) {
    const headline = {
      'no-providers': 'no LLM provider is configured (set an API key and model in .env)',
      budget: 'the LLM call budget for this run is used up (LLM_MAX_CALLS_PER_RUN)',
      'all-failed': 'every LLM provider failed or was skipped',
    }[reason];
    super(details.length > 0 ? `${headline}:\n  ${details.join('\n  ')}` : headline);
    this.name = 'LlmUnavailableError';
    this.reason = reason;
    this.details = details;
  }
}
