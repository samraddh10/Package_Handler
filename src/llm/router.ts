import {
  type GenerateTextResult,
  generateText,
  type ModelMessage,
  type OutputInterface,
  type ToolChoice,
  type ToolSet,
} from 'ai';
import type { ProviderName } from '../config.js';
import { type ClassifiedError, classifyLlmError, LlmUnavailableError } from './errors.js';
import type { LlmProvider } from './providers.js';
import { estimateRequestTokens } from './tokens.js';

/**
 * The LLM router: the only code in the project that calls the AI SDK.
 *
 * Free tiers fail often and in different ways: rate limits, daily quotas,
 * overloaded servers, models that return broken JSON. Instead of every caller
 * handling that, callers ask the router for "one answer to this request" and
 * the router decides which provider to ask, when to wait and retry, when to
 * move on to the next provider, and when to give up with LlmUnavailableError.
 * If a provider's API changes, this is the one file to fix.
 */

/** What the call is for. Only used for logging and per-task statistics. */
export type LlmTask = 'changelog' | 'fix' | 'pr-summary';

/** The SDK's runtime-context type parameter; we pass no runtime context. */
type NoContext = Record<string, unknown>;

/** What callers pass in: `generateText` options minus everything the router controls. */
export type LlmRequest<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputInterface = never> = {
  instructions?: string;
  tools?: TOOLS;
  toolChoice?: ToolChoice<TOOLS>;
  /** A structured-output spec, e.g. `Output.object({ schema })`. */
  output?: OUTPUT;
  maxOutputTokens?: number;
  temperature?: number;
  /** Per-attempt time limit. Defaults to the router's (90 s). */
  timeoutMs?: number;
  /** Lets the caller cancel. A cancelled call is not retried. */
  abortSignal?: AbortSignal;
} & ({ prompt: string; messages?: never } | { messages: ModelMessage[]; prompt?: never });

export interface LlmResponse<TOOLS extends ToolSet, OUTPUT extends OutputInterface> {
  result: GenerateTextResult<TOOLS, NoContext, OUTPUT>;
  provider: ProviderName;
  modelId: string;
}

/** What the router decided after one attempt. */
export type LlmNextStep = 'done' | 'retry' | 'next-provider' | 'disable-provider';

/** One line of the trace per attempt, successful or not (`llm.call` in the plan). */
export interface LlmCallEvent {
  type: 'llm.call';
  task: LlmTask;
  provider: ProviderName;
  model: string;
  /** 1-based attempt number on this provider. */
  attempt: number;
  ok: boolean;
  errorKind: ClassifiedError['kind'] | null;
  statusCode: number | null;
  message: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
  next: LlmNextStep;
  /** How long the router waits before the retry, when `next` is "retry". */
  waitMs: number | null;
}

export interface LlmStats {
  /** Requests actually sent, including failed ones. This is what the budget counts. */
  calls: number;
  failedCalls: number;
  inputTokens: number;
  outputTokens: number;
}

/** The router is pausing because every usable provider is cooling down for a short while. */
export interface LlmWaitEvent {
  type: 'llm.wait';
  task: LlmTask;
  waitMs: number;
  providers: ProviderName[];
}

export interface LlmRouterOptions {
  providers: LlmProvider[];
  maxCallsPerRun: number;
  onEvent?: (event: LlmCallEvent) => void;
  onWait?: (event: LlmWaitEvent) => void;
  /** Per-attempt time limit in ms. */
  timeoutMs?: number;
  // Injected so tests control time and randomness instead of really sleeping.
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** Tries per provider before moving on. */
export const MAX_ATTEMPTS_PER_PROVIDER = 3;
/** A 429 asking us to wait longer than this cools the provider down instead. */
export const MAX_RATE_LIMIT_WAIT_SEC = 20;
/** Cool-down after a provider used all its tries on 429s without saying how long to wait. */
export const DEFAULT_COOLDOWN_SEC = 60;
/**
 * When every usable provider is cooling down and one is free again within this
 * many seconds, the router waits for it once instead of giving up. That covers
 * per-minute limits; a daily quota asks for hours and still fails fast.
 */
export const MAX_COOLDOWN_WAIT_SEC = 60;
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Exponential backoff with jitter: about 1 s, 2 s, 4 s, ... capped at 20 s.
 * "Exponential" so a struggling server gets more breathing room each time;
 * "jitter" (a random ±25 %) so many clients that failed together do not all
 * retry at the same instant and knock the server over again.
 */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), MAX_RATE_LIMIT_WAIT_SEC * 1000);
  return Math.round(base * (0.75 + random() * 0.5));
}

export class LlmRouter {
  private readonly providers: LlmProvider[];
  private readonly maxCallsPerRun: number;
  private readonly onEvent: (event: LlmCallEvent) => void;
  private readonly onWait: (event: LlmWaitEvent) => void;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  /** Providers that failed authentication: skipped for the rest of the run. */
  private readonly disabled = new Map<ProviderName, string>();
  /** Providers out of quota: skipped until the stored time (ms since epoch). */
  private readonly coolingUntil = new Map<ProviderName, number>();
  private readonly stats: LlmStats = { calls: 0, failedCalls: 0, inputTokens: 0, outputTokens: 0 };

  constructor(options: LlmRouterOptions) {
    this.providers = options.providers;
    this.maxCallsPerRun = options.maxCallsPerRun;
    this.onEvent = options.onEvent ?? (() => {});
    this.onWait = options.onWait ?? (() => {});
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** A copy of the running totals, e.g. to show "0 LLM calls" on a cache hit. */
  getStats(): LlmStats {
    return { ...this.stats };
  }

  /**
   * Sends one request, falling back through the providers until one answers.
   * Throws LlmUnavailableError when none can; every other error is a bug or a
   * cancellation and is rethrown as it is.
   *
   * If the only thing standing in the way is a short cool-down (a per-minute
   * limit), it waits for the first provider to come back and goes round once
   * more. With a single free-tier provider, a 20-step fix-agent session would
   * otherwise end at the first busy minute.
   */
  async callLLM<TOOLS extends ToolSet = ToolSet, OUTPUT extends OutputInterface = never>(
    task: LlmTask,
    request: LlmRequest<TOOLS, OUTPUT>,
  ): Promise<LlmResponse<TOOLS, OUTPUT>> {
    if (this.providers.length === 0) {
      throw new LlmUnavailableError('no-providers', []);
    }
    const estimatedTokens = estimateRequestTokens({
      instructions: request.instructions,
      prompt: request.prompt,
      messages: request.messages,
      toolNames: Object.keys(request.tools ?? {}),
    });
    for (let round = 1; ; round++) {
      const details: string[] = [];
      for (const provider of this.providers) {
        const skip = this.skipReason(provider, estimatedTokens);
        if (skip !== null) {
          details.push(`${provider.name}: skipped, ${skip}`);
          continue;
        }
        const outcome = await this.tryProvider(task, provider, request);
        if ('response' in outcome) {
          return outcome.response;
        }
        details.push(`${provider.name}: ${outcome.failure}`);
      }

      const wait = round === 1 ? this.shortCooldown(estimatedTokens) : null;
      if (wait === null) {
        throw new LlmUnavailableError('all-failed', details);
      }
      this.onWait({ type: 'llm.wait', task, ...wait });
      await this.sleep(wait.waitMs);
    }
  }

  /**
   * How long until the first usable provider's cool-down ends, when that is
   * within MAX_COOLDOWN_WAIT_SEC. null when no provider is cooling down, or
   * none would be back soon enough, or none could take this request anyway.
   */
  private shortCooldown(
    estimatedTokens: number,
  ): { waitMs: number; providers: ProviderName[] } | null {
    const now = this.now();
    const cooling = this.providers.filter((provider) => {
      const until = this.coolingUntil.get(provider.name);
      return (
        until !== undefined &&
        until > now &&
        !this.disabled.has(provider.name) &&
        estimatedTokens <= provider.maxInputTokens
      );
    });
    if (cooling.length === 0) {
      return null;
    }
    const waitMs = Math.min(
      ...cooling.map((provider) => (this.coolingUntil.get(provider.name) ?? now) - now),
    );
    if (waitMs > MAX_COOLDOWN_WAIT_SEC * 1000) {
      return null;
    }
    return { waitMs, providers: cooling.map((provider) => provider.name) };
  }

  /** Why a provider should not even be tried, or null to try it. */
  private skipReason(provider: LlmProvider, estimatedTokens: number): string | null {
    const disabledFor = this.disabled.get(provider.name);
    if (disabledFor !== undefined) {
      return `disabled for this run (${disabledFor})`;
    }
    const until = this.coolingUntil.get(provider.name);
    if (until !== undefined && until > this.now()) {
      return `cooling down for ${Math.ceil((until - this.now()) / 1000)} s after hitting its quota`;
    }
    if (estimatedTokens > provider.maxInputTokens) {
      return `request is ~${estimatedTokens} tokens, over its limit of ${provider.maxInputTokens}`;
    }
    return null;
  }

  /**
   * Up to three tries on one provider. Returns the response, or a one-line
   * reason for moving on to the next provider.
   */
  private async tryProvider<TOOLS extends ToolSet, OUTPUT extends OutputInterface>(
    task: LlmTask,
    provider: LlmProvider,
    request: LlmRequest<TOOLS, OUTPUT>,
  ): Promise<{ response: LlmResponse<TOOLS, OUTPUT> } | { failure: string }> {
    let invalidOutputRetried = false;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_PROVIDER; attempt++) {
      if (this.stats.calls >= this.maxCallsPerRun) {
        throw new LlmUnavailableError('budget', [`${this.stats.calls} calls made`]);
      }
      this.stats.calls++;

      const started = this.now();
      const event = {
        type: 'llm.call',
        task,
        provider: provider.name,
        model: provider.modelId,
        attempt,
      } as const;

      const { result, error, timedOut } = await this.attempt(provider, request);
      const latencyMs = this.now() - started;

      if (result !== undefined) {
        const inputTokens = result.usage.inputTokens ?? null;
        const outputTokens = result.usage.outputTokens ?? null;
        this.stats.inputTokens += inputTokens ?? 0;
        this.stats.outputTokens += outputTokens ?? 0;
        this.onEvent({
          ...event,
          ok: true,
          errorKind: null,
          statusCode: null,
          message: null,
          inputTokens,
          outputTokens,
          latencyMs,
          next: 'done',
          waitMs: null,
        });
        return { response: { result, provider: provider.name, modelId: provider.modelId } };
      }

      this.stats.failedCalls++;
      const failure = classifyLlmError(error, timedOut);
      if (failure === null) {
        // A bug in our code, or the caller cancelled: not a provider problem.
        throw error;
      }

      const decision = this.decide(provider, failure, attempt, invalidOutputRetried);
      if (failure.kind === 'invalid-output') {
        invalidOutputRetried = true;
      }
      this.onEvent({
        ...event,
        ok: false,
        errorKind: failure.kind,
        statusCode: failure.statusCode,
        message: failure.message,
        inputTokens: null,
        outputTokens: null,
        latencyMs,
        next: decision.next,
        waitMs: decision.waitMs,
      });

      const label = `${failure.kind}${failure.statusCode === null ? '' : ` (${failure.statusCode})`}: ${failure.message}`;
      if (decision.next !== 'retry') {
        return { failure: label };
      }
      await this.sleep(decision.waitMs);
    }
    // Unreachable: the last attempt always decides something other than retry.
    return { failure: 'out of attempts' };
  }

  /**
   * The policy table from the plan (§9), as code. Pure apart from recording
   * disabled and cooling-down providers, so the unit tests can walk every row.
   */
  private decide(
    provider: LlmProvider,
    failure: ClassifiedError,
    attempt: number,
    invalidOutputRetried: boolean,
  ): { next: 'retry'; waitMs: number } | { next: Exclude<LlmNextStep, 'retry'>; waitMs: null } {
    const lastAttempt = attempt >= MAX_ATTEMPTS_PER_PROVIDER;
    switch (failure.kind) {
      case 'auth':
      case 'not-found':
        // A wrong key or model id will not fix itself during this run.
        this.disabled.set(provider.name, `${failure.kind}, HTTP ${failure.statusCode}`);
        return { next: 'disable-provider', waitMs: null };

      case 'too-large':
      case 'bad-request':
        // The same request will be rejected the same way; another model may take it.
        return { next: 'next-provider', waitMs: null };

      case 'invalid-output':
        // Models sometimes slip once. Twice in a row means this one cannot do it.
        if (invalidOutputRetried || lastAttempt) {
          return { next: 'next-provider', waitMs: null };
        }
        return { next: 'retry', waitMs: 0 };

      case 'rate-limit': {
        const asked = failure.retryAfterSec;
        if (asked !== null && asked > MAX_RATE_LIMIT_WAIT_SEC) {
          // A long wait usually means a per-day or per-minute quota is used up.
          // Waiting would stall the run, so skip the provider until then.
          this.coolingUntil.set(provider.name, this.now() + asked * 1000);
          return { next: 'next-provider', waitMs: null };
        }
        if (lastAttempt) {
          this.coolingUntil.set(provider.name, this.now() + (asked ?? DEFAULT_COOLDOWN_SEC) * 1000);
          return { next: 'next-provider', waitMs: null };
        }
        return {
          next: 'retry',
          waitMs: asked !== null ? Math.ceil(asked * 1000) : backoffMs(attempt, this.random),
        };
      }

      case 'server':
      case 'network':
      case 'timeout':
        if (lastAttempt) {
          return { next: 'next-provider', waitMs: null };
        }
        return { next: 'retry', waitMs: backoffMs(attempt, this.random) };
    }
  }

  /** One request to one provider, with our own timer so a hung connection cannot stall the run. */
  private async attempt<TOOLS extends ToolSet, OUTPUT extends OutputInterface>(
    provider: LlmProvider,
    request: LlmRequest<TOOLS, OUTPUT>,
  ): Promise<{
    result?: GenerateTextResult<TOOLS, NoContext, OUTPUT>;
    error?: unknown;
    timedOut: boolean;
  }> {
    const { timeoutMs, abortSignal, ...options } = request;
    const timer = new AbortController();
    const handle = setTimeout(() => timer.abort(), timeoutMs ?? this.timeoutMs);
    const signal =
      abortSignal === undefined ? timer.signal : AbortSignal.any([timer.signal, abortSignal]);
    try {
      const result = await generateText<TOOLS, NoContext, OUTPUT>({
        ...options,
        model: provider.model,
        // Retries are the router's job; the SDK's own would hide them from us.
        maxRetries: 0,
        abortSignal: signal,
      } as Parameters<typeof generateText<TOOLS, NoContext, OUTPUT>>[0]);
      if (request.output !== undefined) {
        // `output` is a getter that throws when the answer did not match the
        // schema. Read it here, inside the retry logic, not later in the caller.
        void result.output;
      }
      return { result, timedOut: false };
    } catch (error) {
      if (abortSignal?.aborted === true) {
        throw error;
      }
      return { error, timedOut: timer.signal.aborted };
    } finally {
      clearTimeout(handle);
    }
  }
}

/** One trace line per attempt, e.g. "gemini/gemini-3.5-flash #1: ok, 1,234 → 456 tokens, 3.1 s". */
export function describeLlmEvent(event: LlmCallEvent): string {
  const who = `${event.provider}/${event.model} #${event.attempt}`;
  const seconds = `${(event.latencyMs / 1000).toFixed(1)} s`;
  if (event.ok) {
    const tokens = `${(event.inputTokens ?? 0).toLocaleString('en-US')} → ${(event.outputTokens ?? 0).toLocaleString('en-US')} tokens`;
    return `${who}: ok, ${tokens}, ${seconds}`;
  }
  const status = event.statusCode === null ? '' : ` ${event.statusCode}`;
  const next = {
    done: '',
    retry: `retrying in ${((event.waitMs ?? 0) / 1000).toFixed(1)} s`,
    'next-provider': 'trying the next provider',
    'disable-provider': 'provider disabled for this run',
  }[event.next];
  return `${who}: ${event.errorKind}${status} after ${seconds}, ${next}`;
}
