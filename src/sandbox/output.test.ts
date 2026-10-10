import { describe, expect, it } from 'vitest';
import { CappedOutput } from './output.js';

describe('CappedOutput', () => {
  it('keeps short output as it is', () => {
    const output = new CappedOutput();
    output.write('hello ');
    output.write(Buffer.from('world\n'));

    expect(output.text()).toBe('hello world\n');
    expect(output.truncated).toBe(false);
  });

  it('removes terminal escape codes', () => {
    const output = new CappedOutput();
    // What a test runner prints when it thinks it is talking to a terminal.
    output.write('[32m[1mPASS[22m[39m 12 tests\n');

    expect(output.text()).toBe('PASS 12 tests\n');
  });

  it('keeps the start and the end, and drops the middle', () => {
    const output = new CappedOutput({ headChars: 10, tailChars: 5 });
    output.write('HEADHEADHE');
    output.write('xxxxxxxxxxxxxxxxxxxx');
    output.write('TAILS');

    const text = output.text();
    expect(output.truncated).toBe(true);
    expect(text.startsWith('HEADHEADHE')).toBe(true);
    expect(text.endsWith('TAILS')).toBe(true);
    // 20 x's plus the first 15 characters of the final chunks were dropped.
    expect(text).toContain('characters of output removed');
  });

  it('keeps only the most recent output in the tail', () => {
    const output = new CappedOutput({ headChars: 4, tailChars: 4 });
    for (const chunk of ['head', 'aaaa', 'bbbb', 'cccc']) {
      output.write(chunk);
    }

    const text = output.text();
    expect(text.startsWith('head')).toBe(true);
    expect(text.endsWith('cccc')).toBe(true);
    expect(text).not.toContain('aaaa');
  });

  it('keeps everything from the start when the tail is switched off', () => {
    // What exec() does with maxOutputChars, for JSON that is useless when cut.
    const output = new CappedOutput({ headChars: 5, tailChars: 0 });
    output.write('12345678');

    expect(output.truncated).toBe(true);
    expect(output.text().startsWith('12345\n... 3 characters of output removed ...')).toBe(true);
  });

  it('reports exactly how much it dropped', () => {
    const output = new CappedOutput({ headChars: 2, tailChars: 2 });
    output.write('12345678');

    expect(output.text()).toBe('12\n... 4 characters of output removed ...\n78');
  });

  it('survives a multi-byte character split across two chunks', () => {
    const output = new CappedOutput();
    // The check mark is three bytes; Docker can split a chunk anywhere.
    const bytes = Buffer.from('ok ✓\n', 'utf8');
    output.write(bytes.subarray(0, 4));
    output.write(bytes.subarray(4));

    expect(output.text()).toBe('ok ✓\n');
  });

  it('can be read more than once', () => {
    const output = new CappedOutput();
    output.write(Buffer.from('once'));

    expect(output.text()).toBe('once');
    expect(output.text()).toBe('once');
  });

  it('collects what is piped into its sink', async () => {
    const output = new CappedOutput();
    const sink = output.sink();
    sink.write(Buffer.from('from '));
    sink.write(Buffer.from('a stream'));
    await new Promise<void>((resolve) => sink.end(resolve));

    expect(output.text()).toBe('from a stream');
  });
});
