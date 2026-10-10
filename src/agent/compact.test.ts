import type { ModelMessage } from 'ai';
import { describe, expect, it } from 'vitest';
import { compactMessages } from './compact.js';

/** A conversation of `turns` read_file calls, each returning `size` characters. */
function conversation(turns: number, size: number): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'Fix the tests.' }];
  for (let turn = 1; turn <= turns; turn++) {
    const toolCallId = `call-${turn}`;
    messages.push({
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId,
          toolName: 'read_file',
          input: { path: `src/file${turn}.js` },
        },
      ],
    });
    messages.push({
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId,
          toolName: 'read_file',
          output: { type: 'text', value: `${turn}`.repeat(size) },
        },
      ],
    });
  }
  return messages;
}

function resultText(message: ModelMessage | undefined): string {
  if (message?.role !== 'tool') {
    throw new Error('not a tool message');
  }
  const part = message.content[0];
  if (part?.type !== 'tool-result' || part.output.type !== 'text') {
    throw new Error('not a text result');
  }
  return part.output.value;
}

describe('compactMessages', () => {
  it('leaves a small conversation alone', () => {
    const messages = conversation(3, 1000);
    expect(compactMessages(messages)).toBe(messages);
  });

  it('replaces old tool output with a stub and keeps the last two whole', () => {
    const messages = conversation(5, 30_000);
    const compacted = compactMessages(messages);

    expect(resultText(compacted[2])).toBe(
      '[removed to save space: the output of read_file src/file1.js. Call the tool again if you still need it.]',
    );
    expect(resultText(compacted[6])).toMatch(
      /^\[removed to save space: the output of read_file src\/file3\.js/,
    );
    expect(resultText(compacted[8])).toBe('4'.repeat(30_000));
    expect(resultText(compacted[10])).toBe('5'.repeat(30_000));
  });

  it('keeps the structure: same messages, same tool call ids, input untouched', () => {
    const messages = conversation(5, 30_000);
    const before = JSON.stringify(messages);
    const compacted = compactMessages(messages);

    expect(compacted).toHaveLength(messages.length);
    expect(compacted.map((message) => message.role)).toEqual(
      messages.map((message) => message.role),
    );
    expect(compacted[0]).toBe(messages[0]);
    expect(compacted[1]).toBe(messages[1]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it('keeps short results, which cost less than a stub', () => {
    const messages = conversation(5, 30_000);
    const third = messages[6];
    if (third?.role === 'tool' && third.content[0]?.type === 'tool-result') {
      third.content[0].output = { type: 'text', value: 'PASS: npm test passed.' };
    }
    expect(resultText(compactMessages(messages)[6])).toBe('PASS: npm test passed.');
  });
});
