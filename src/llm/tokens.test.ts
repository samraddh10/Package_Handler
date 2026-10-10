import { describe, expect, it } from 'vitest';
import { estimateRequestTokens, estimateTokens, trimToTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('counts about one token per 4 characters, rounding up', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('estimateRequestTokens', () => {
  it('adds up instructions, prompt, messages and tools', () => {
    const base = estimateRequestTokens({ instructions: 'a'.repeat(400), prompt: 'b'.repeat(400) });
    expect(base).toBe(200);

    const withMessages = estimateRequestTokens({
      messages: [{ role: 'user', content: 'c'.repeat(400) }],
    });
    expect(withMessages).toBeGreaterThan(100);

    const withTools = estimateRequestTokens({ toolNames: ['read_file', 'write_file'] });
    expect(withTools).toBe(300);
  });
});

describe('trimToTokens', () => {
  it('leaves short text alone', () => {
    expect(trimToTokens('hello', 10)).toBe('hello');
  });

  it('cuts long text to the budget and says it was cut', () => {
    const text = 'x'.repeat(1000);
    const trimmed = trimToTokens(text, 50);
    expect(trimmed.length).toBeLessThanOrEqual(200);
    expect(trimmed).toMatch(/cut to fit the size budget\]$/);
  });

  it('cuts at a line break near the end of the budget', () => {
    // 50 tokens = 200 chars, minus the marker leaves ~167: the break at 150 is close enough.
    const text = `${'a'.repeat(150)}\n${'b'.repeat(500)}`;
    const trimmed = trimToTokens(text, 50);
    expect(trimmed).toBe(`${'a'.repeat(150)}\n[... cut to fit the size budget]`);
  });
});
