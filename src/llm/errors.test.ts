import { APICallError, RetryError } from 'ai';
import { describe, expect, it } from 'vitest';
import { classifyLlmError, retryAfterOf } from './errors.js';

function apiError(
  statusCode: number | undefined,
  extra: Partial<{ body: string; message: string }> = {},
) {
  return new APICallError({
    message: extra.message ?? 'failed',
    url: 'https://example.test',
    requestBodyValues: {},
    statusCode,
    responseBody: extra.body,
  });
}

describe('classifyLlmError', () => {
  it.each([
    [429, 'rate-limit'],
    [401, 'auth'],
    [403, 'auth'],
    [404, 'not-found'],
    [413, 'too-large'],
    [400, 'bad-request'],
    [422, 'bad-request'],
    [500, 'server'],
    [503, 'server'],
  ] as const)('HTTP %i → %s', (status, kind) => {
    expect(classifyLlmError(apiError(status), false)?.kind).toBe(kind);
  });

  it('treats a 400 that complains about length as too-large', () => {
    const error = apiError(400, {
      body: '{"error":{"message":"This model\'s maximum context length is 8192 tokens"}}',
    });
    expect(classifyLlmError(error, false)?.kind).toBe('too-large');
  });

  it('calls an API error without a status a network error', () => {
    expect(classifyLlmError(apiError(undefined), false)?.kind).toBe('network');
  });

  it('reports our own timeout as a timeout, whatever was thrown', () => {
    expect(classifyLlmError(new Error('aborted'), true)?.kind).toBe('timeout');
  });

  it('looks inside a RetryError at the last attempt', () => {
    const wrapped = new RetryError({
      message: 'gave up',
      reason: 'maxRetriesExceeded',
      errors: [apiError(503), apiError(429)],
    });
    expect(classifyLlmError(wrapped, false)?.kind).toBe('rate-limit');
  });

  it('returns null for errors that are not provider failures', () => {
    expect(classifyLlmError(new TypeError('x is undefined'), false)).toBeNull();
  });
});

describe('retryAfterOf', () => {
  const base = { responseBody: undefined, responseHeaders: undefined };

  it('reads retry-after in seconds, in any letter case', () => {
    expect(retryAfterOf({ ...base, responseHeaders: { 'Retry-After': '12' } })).toBe(12);
  });

  it('reads retry-after as an HTTP date', () => {
    const now = Date.parse('2026-10-10T12:00:00Z');
    const header = { 'retry-after': 'Sat, 10 Oct 2026 12:00:30 GMT' };
    expect(retryAfterOf({ ...base, responseHeaders: header }, now)).toBe(30);
  });

  it('prefers retry-after-ms when present', () => {
    const headers = { 'retry-after-ms': '1500', 'retry-after': '2' };
    expect(retryAfterOf({ ...base, responseHeaders: headers })).toBe(1.5);
  });

  it('reads Gemini’s retryDelay from the JSON body', () => {
    const body = JSON.stringify({
      error: { code: 429, details: [{ '@type': 'RetryInfo', retryDelay: '37s' }] },
    });
    expect(retryAfterOf({ ...base, responseBody: body })).toBe(37);
  });

  it('returns null when the provider gives no hint', () => {
    expect(retryAfterOf(base)).toBeNull();
  });
});
