import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeFailureDigest } from './test-output.js';

/**
 * The fixtures are real output, captured from `npm test` inside the sandbox for
 * the same three tests under each runner: one passes, one fails an assertion
 * (multiply(2, 3) returns 5), and one throws a TypeError inside src/math.js.
 */
function digestOf(runner: string): string {
  const read = (stream: string) =>
    readFileSync(
      new URL(`../../tests/fixtures/test-output/${runner}.${stream}.txt`, import.meta.url),
      'utf8',
    );
  return makeFailureDigest(read('stdout'), read('stderr'));
}

describe('makeFailureDigest', () => {
  it('keeps what mocha says failed and where', () => {
    const digest = digestOf('mocha');

    expect(digest).toContain('1) math');
    expect(digest).toContain('5 !== 6');
    expect(digest).toContain("TypeError: Cannot read properties of null (reading 'replace')");
    expect(digest).toContain('at parsePrice (src/math.js:10:22)');
    expect(digest).toContain('2 failing');
    expect(digest).not.toContain('✔ adds');
    expect(digest).not.toContain('node:internal');
    expect(digest).not.toContain('> mocha');
  });

  it('keeps what jest says failed and where, from stderr', () => {
    const digest = digestOf('jest');

    expect(digest).toContain('● math › multiplies');
    expect(digest).toContain('Received: 5');
    expect(digest).toContain('at replace (src/math.js:10:22)');
    expect(digest).toContain('Tests:       2 failed, 1 passed, 3 total');
    expect(digest).not.toContain('✓ adds');
    expect(digest).not.toContain('Time:');
    expect(digest).not.toContain('> jest');
  });

  it('keeps what vitest says failed, across both streams', () => {
    const digest = digestOf('vitest');

    expect(digest).toContain('Failed Tests 2');
    expect(digest).toContain('FAIL  test/math.test.mjs > math > multiplies');
    expect(digest).toContain('❯ parsePrice src/math.js:10:22');
    expect(digest).toContain('Tests  2 failed | 1 passed (3)');
    expect(digest).not.toContain('✓ adds');
    expect(digest).not.toContain('⎯');
    expect(digest).not.toContain('Start at');
  });

  it('keeps what node:test says failed, and makes its paths repo-relative', () => {
    const digest = digestOf('node-test');

    expect(digest).toContain('not ok 2 - multiplies');
    expect(digest).toContain('5 !== 6');
    expect(digest).toContain('parsePrice (src/math.js:10:22)');
    expect(digest).toContain('# fail 2');
    expect(digest).not.toMatch(/^\s*ok 1 - adds/m);
    expect(digest).not.toContain('/home/node/project/');
    expect(digest).not.toContain('node:internal');
    expect(digest).not.toContain('duration_ms');
  });

  it('keeps the first frame of a trace even when it is inside a dependency', () => {
    const stack = [
      'TypeError: Missing parameter name at index 1: *',
      '    at name (/home/node/project/node_modules/path-to-regexp/dist/index.js:96:19)',
      '    at lexer (/home/node/project/node_modules/path-to-regexp/dist/index.js:114:21)',
      '    at createApp (/home/node/project/src/app.js:47:7)',
      '    at Context.<anonymous> (/home/node/project/test/app.test.js:9:11)',
      '    at process.processImmediate (node:internal/timers:484:21)',
    ].join('\n');

    expect(makeFailureDigest(stack, '').split('\n')).toEqual([
      'TypeError: Missing parameter name at index 1: *',
      '    at name (node_modules/path-to-regexp/dist/index.js:96:19)',
      '    at createApp (src/app.js:47:7)',
      '    at Context.<anonymous> (test/app.test.js:9:11)',
    ]);
  });

  it('cuts a long digest in the middle, keeping the start and the summary', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `  ${i + 1}) failure number ${i + 1}`);
    const digest = makeFailureDigest(`${lines.join('\n')}\n\n  400 failing`, '', 2_000);

    expect(digest.length).toBeLessThanOrEqual(2_000);
    expect(digest).toMatch(/^ {2}1\) failure number 1\n/);
    expect(digest).toMatch(/\.\.\. \d+ more lines cut from the middle \.\.\./);
    expect(digest.endsWith('400 failing')).toBe(true);
  });

  it('shortens a single enormous line', () => {
    const digest = makeFailureDigest(`Error in bundle: ${'x'.repeat(50_000)}`, '');

    expect(digest.length).toBeLessThan(600);
  });

  it('says so when there was no output at all', () => {
    expect(makeFailureDigest('', '\n')).toBe('(the test command printed nothing)');
  });
});
