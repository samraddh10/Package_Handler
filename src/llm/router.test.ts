import { APICallError, Output } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { ProviderName } from '../config.js';
import { LlmUnavailableError } from './errors.js';
import type { LlmProvider } from './providers.js';
import { backoffMs, describeLlmEvent, type LlmCallEvent, LlmRouter } from './router.js';

/**
 * The router's fallback matrix, driven by scripted mock models. Each mock
 * plays back a list of outcomes, one per request: an error to throw, or text
 * to answer with. No network, no real waiting: `sleep` only records the delay.
 */

type Step = Error | string;

function usage() {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
}

/** A mock model that plays back `steps` in order, then repeats the last one. */
function scriptedModel(steps: Step[]) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      const step = steps[Math.min(call, steps.length - 1)] as Step;
      call++;
      if (step instanceof Error) {
        throw step;
      }
      return {
        content: [{ type: 'text', text: step }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: usage(),
        warnings: [],
      };
    },
  });
  return { model, calls: () => call };
}

function apiError(statusCode: number | undefined, headers: Record<string, string> = {}, body = '') {
  return new APICallError({
    message: `HTTP ${statusCode ?? 'none'}`,
    url: 'https://example.test/v1/generate',
    requestBodyValues: {},
    statusCode,
    responseHeaders: headers,
    responseBody: body,
  });
}

function provider(name: ProviderName, steps: Step[], maxInputTokens = 100_000) {
  const scripted = scriptedModel(steps);
  const entry: LlmProvider = {
    name,
    modelId: `${name}-model`,
    model: scripted.model,
    maxInputTokens,
  };
  return { entry, calls: scripted.calls };
}

function makeRouter(providers: LlmProvider[], maxCallsPerRun = 60) {
  const events: LlmCallEvent[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
  const router = new LlmRouter({
    providers,
    maxCallsPerRun,
    onEvent: (event) => events.push(event),
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
    random: () => 0.5,
  });
  return {
    router,
    events,
    waits,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const prompt = { prompt: 'hello' } as const;

describe('backoffMs', () => {
  it('doubles from about 1 s and caps at 20 s', () => {
    const middle = () => 0.5; // jitter factor exactly 1
    expect([1, 2, 3, 4, 5, 6].map((attempt) => backoffMs(attempt, middle))).toEqual([
      1000, 2000, 4000, 8000, 16000, 20000,
    ]);
  });

  it('spreads retries by ±25 %', () => {
    expect(backoffMs(1, () => 0)).toBe(750);
    expect(backoffMs(1, () => 1)).toBe(1250);
  });
});

describe('LlmRouter', () => {
  it('returns the first provider’s answer and logs one successful call', async () => {
    const gemini = provider('gemini', ['hi']);
    const { router, events } = makeRouter([gemini.entry]);

    const response = await router.callLLM('changelog', prompt);

    expect(response.result.text).toBe('hi');
    expect(response.provider).toBe('gemini');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'llm.call',
      task: 'changelog',
      provider: 'gemini',
      ok: true,
      inputTokens: 10,
      outputTokens: 5,
      next: 'done',
    });
    expect(router.getStats()).toEqual({
      calls: 1,
      failedCalls: 0,
      inputTokens: 10,
      outputTokens: 5,
    });
  });

  it('429 → backs off and retries, then moves to the next provider', async () => {
    const gemini = provider('gemini', [apiError(429)]);
    const groq = provider('groq', ['from groq']);
    const { router, events, waits } = makeRouter([gemini.entry, groq.entry]);

    const response = await router.callLLM('changelog', prompt);

    expect(response.provider).toBe('groq');
    expect(gemini.calls()).toBe(3);
    expect(waits).toEqual([1000, 2000]);
    expect(
      events.map((event) => `${event.provider}:${event.errorKind ?? 'ok'}:${event.next}`),
    ).toEqual([
      'gemini:rate-limit:retry',
      'gemini:rate-limit:retry',
      'gemini:rate-limit:next-provider',
      'groq:ok:done',
    ]);
  });

  it('429 with a short retry-after waits exactly that long', async () => {
    const gemini = provider('gemini', [apiError(429, { 'Retry-After': '7' }), 'ok']);
    const { router, waits } = makeRouter([gemini.entry]);

    await router.callLLM('changelog', prompt);

    expect(waits).toEqual([7000]);
  });

  it('429 with a long retry-after cools the provider down and skips it on later calls', async () => {
    const quotaBody = JSON.stringify({ error: { details: [{ retryDelay: '3600s' }] } });
    const gemini = provider('gemini', [apiError(429, {}, quotaBody), 'gemini again']);
    const groq = provider('groq', ['from groq']);
    const { router, waits, advance } = makeRouter([gemini.entry, groq.entry]);

    expect((await router.callLLM('changelog', prompt)).provider).toBe('groq');
    expect(waits).toEqual([]);

    // Still cooling down: gemini is not even asked.
    expect((await router.callLLM('changelog', prompt)).provider).toBe('groq');
    expect(gemini.calls()).toBe(1);

    // An hour later it is tried again.
    advance(3600 * 1000);
    expect((await router.callLLM('changelog', prompt)).provider).toBe('gemini');
  });

  it('401 → disables the provider for the rest of the run', async () => {
    const gemini = provider('gemini', [apiError(401)]);
    const groq = provider('groq', ['from groq']);
    const { router, events } = makeRouter([gemini.entry, groq.entry]);

    await router.callLLM('changelog', prompt);
    await router.callLLM('changelog', prompt);

    expect(gemini.calls()).toBe(1);
    expect(events[0]?.next).toBe('disable-provider');
  });

  it('request too big for a provider’s limit → skips it without calling it', async () => {
    const groq = provider('groq', ['never'], 100);
    const gemini = provider('gemini', ['from gemini']);
    const { router } = makeRouter([groq.entry, gemini.entry]);

    const response = await router.callLLM('changelog', { prompt: 'x'.repeat(4000) });

    expect(response.provider).toBe('gemini');
    expect(groq.calls()).toBe(0);
  });

  it('413 from the provider → next provider, no retry', async () => {
    const groq = provider('groq', [apiError(413)]);
    const gemini = provider('gemini', ['from gemini']);
    const { router, waits } = makeRouter([groq.entry, gemini.entry]);

    expect((await router.callLLM('changelog', prompt)).provider).toBe('gemini');
    expect(groq.calls()).toBe(1);
    expect(waits).toEqual([]);
  });

  it('5xx → retries with backoff, then falls back', async () => {
    const gemini = provider('gemini', [apiError(503), 'recovered']);
    const { router, waits } = makeRouter([gemini.entry]);

    expect((await router.callLLM('changelog', prompt)).result.text).toBe('recovered');
    expect(waits).toEqual([1000]);
  });

  it('a network error (no status code) is retried like a 5xx', async () => {
    const gemini = provider('gemini', [apiError(undefined), 'ok']);
    const { router, events } = makeRouter([gemini.entry]);

    await router.callLLM('changelog', prompt);

    expect(events[0]).toMatchObject({ errorKind: 'network', next: 'retry' });
  });

  it('invalid structured output → one retry on the same provider, then the next', async () => {
    const schema = z.object({ answer: z.string() });
    const gemini = provider('gemini', ['not json', 'still not json']);
    const groq = provider('groq', ['{"answer":"42"}']);
    const { router, events } = makeRouter([gemini.entry, groq.entry]);

    const response = await router.callLLM('changelog', {
      prompt: 'answer',
      output: Output.object({ schema }),
    });

    expect(response.result.output).toEqual({ answer: '42' });
    expect(gemini.calls()).toBe(2);
    expect(
      events.map((event) => `${event.provider}:${event.errorKind ?? 'ok'}:${event.next}`),
    ).toEqual([
      'gemini:invalid-output:retry',
      'gemini:invalid-output:next-provider',
      'groq:ok:done',
    ]);
  });

  it('output that is valid JSON but breaks the schema also counts as invalid output', async () => {
    const schema = z.object({ answer: z.string() });
    const gemini = provider('gemini', ['{"answer": 42}', '{"answer":"42"}']);
    const { router } = makeRouter([gemini.entry]);

    const response = await router.callLLM('changelog', {
      prompt: 'answer',
      output: Output.object({ schema }),
    });

    expect(response.result.output).toEqual({ answer: '42' });
  });

  it('all providers fail → a typed LlmUnavailableError listing each one', async () => {
    const gemini = provider('gemini', [apiError(401)]);
    const groq = provider('groq', [apiError(400)]);
    const { router } = makeRouter([gemini.entry, groq.entry]);

    const error = await router.callLLM('changelog', prompt).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmUnavailableError);
    const unavailable = error as LlmUnavailableError;
    expect(unavailable.reason).toBe('all-failed');
    expect(unavailable.details).toHaveLength(2);
    expect(unavailable.details[0]).toMatch(/^gemini: auth \(401\)/);
    expect(unavailable.details[1]).toMatch(/^groq: bad-request \(400\)/);
  });

  it('no providers configured → LlmUnavailableError("no-providers")', async () => {
    const { router } = makeRouter([]);
    await expect(router.callLLM('changelog', prompt)).rejects.toMatchObject({
      reason: 'no-providers',
    });
  });

  it('stops at the per-run call budget, counting failed calls too', async () => {
    const gemini = provider('gemini', [apiError(503), 'ok', 'ok']);
    const { router } = makeRouter([gemini.entry], 2);

    await router.callLLM('changelog', prompt); // 503 + ok = 2 calls
    await expect(router.callLLM('changelog', prompt)).rejects.toMatchObject({ reason: 'budget' });
    expect(gemini.calls()).toBe(2);
  });

  it('times out a hung call with its own timer and treats it like a server error', async () => {
    let call = 0;
    const hanging = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        call++;
        if (call === 1) {
          // Never answers; only the router's abort ends it.
          await new Promise((_, reject) => {
            abortSignal?.addEventListener('abort', () => reject(abortSignal.reason));
          });
        }
        return {
          content: [{ type: 'text', text: 'second try' }],
          finishReason: { unified: 'stop', raw: undefined },
          usage: usage(),
          warnings: [],
        };
      },
    });
    const router = new LlmRouter({
      providers: [{ name: 'gemini', modelId: 'm', model: hanging, maxInputTokens: 100_000 }],
      maxCallsPerRun: 10,
      timeoutMs: 20,
      sleep: async () => {},
    });

    const response = await router.callLLM('changelog', prompt);

    expect(response.result.text).toBe('second try');
  });

  it('rethrows errors that are not provider failures instead of falling back', async () => {
    const gemini = provider('gemini', [new TypeError('bug in our code')]);
    const groq = provider('groq', ['never']);
    const { router } = makeRouter([gemini.entry, groq.entry]);

    await expect(router.callLLM('changelog', prompt)).rejects.toThrow('bug in our code');
    expect(groq.calls()).toBe(0);
  });

  it('does not retry when the caller cancels', async () => {
    const controller = new AbortController();
    const slow = new MockLanguageModelV4({
      doGenerate: async ({ abortSignal }) => {
        controller.abort();
        throw abortSignal?.reason ?? new Error('aborted');
      },
    });
    const groq = provider('groq', ['never']);
    const router = new LlmRouter({
      providers: [
        { name: 'gemini', modelId: 'm', model: slow, maxInputTokens: 100_000 },
        groq.entry,
      ],
      maxCallsPerRun: 10,
      sleep: async () => {},
    });

    await expect(
      router.callLLM('changelog', { prompt: 'x', abortSignal: controller.signal }),
    ).rejects.toBeDefined();
    expect(groq.calls()).toBe(0);
  });
});

describe('describeLlmEvent', () => {
  const base = {
    type: 'llm.call',
    task: 'changelog',
    provider: 'gemini',
    model: 'gemini-3.5-flash',
    attempt: 1,
    latencyMs: 3100,
  } as const;

  it('describes a success with tokens and time', () => {
    const line = describeLlmEvent({
      ...base,
      ok: true,
      errorKind: null,
      statusCode: null,
      message: null,
      inputTokens: 1234,
      outputTokens: 456,
      next: 'done',
      waitMs: null,
    });
    expect(line).toBe('gemini/gemini-3.5-flash #1: ok, 1,234 → 456 tokens, 3.1 s');
  });

  it('describes a failure and what happens next', () => {
    const line = describeLlmEvent({
      ...base,
      ok: false,
      errorKind: 'rate-limit',
      statusCode: 429,
      message: 'quota',
      inputTokens: null,
      outputTokens: null,
      next: 'retry',
      waitMs: 2000,
    });
    expect(line).toBe('gemini/gemini-3.5-flash #1: rate-limit 429 after 3.1 s, retrying in 2.0 s');
  });
});
