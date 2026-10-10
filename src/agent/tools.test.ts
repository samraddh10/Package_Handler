import { describe, expect, it } from 'vitest';
import { FakeSandbox, failingTests } from '../../tests/helpers/fake-sandbox.js';
import { SandboxError } from '../sandbox/errors.js';
import {
  keepFileConventions,
  MAX_LIST_ENTRIES,
  MAX_READ_LINES,
  MAX_SEARCH_MATCHES,
  ToolRunner,
} from './tools.js';

function runnerFor(sandbox: FakeSandbox, maxAttempts = 3) {
  return new ToolRunner({ sandbox, upgradedPackage: 'express', maxAttempts, testTimeoutSec: 300 });
}

const lines = (count: number) =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

describe('read_file', () => {
  it('numbers the lines and says how many there are', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'src/a.js': 'one\ntwo\nthree\n' } }));
    const output = await runner.run('read_file', {
      path: 'src/a.js',
      startLine: null,
      endLine: null,
    });
    expect(output).toEqual({
      isError: false,
      text: 'src/a.js, lines 1-3 of 3:\n1| one\n2| two\n3| three',
    });
  });

  it(`returns at most ${MAX_READ_LINES} lines and says where to read on`, async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'big.js': lines(500) } }));
    const first = await runner.run('read_file', { path: 'big.js', startLine: null, endLine: null });
    expect(first.text).toMatch(/^big\.js, lines 1-200 of 500:/);
    expect(first.text).toContain('call read_file with startLine 201 to read on');

    const part = await runner.run('read_file', { path: 'big.js', startLine: 490, endLine: 999 });
    expect(part.text).toMatch(/^big\.js, lines 490-500 of 500:\n490\| line 490/);
    expect(part.text).not.toContain('read on');
  });

  it('cuts very long lines and stops at the character cap', async () => {
    const minified = 'x'.repeat(5000);
    const runner = runnerFor(
      new FakeSandbox({ files: { 'dist.js': Array(100).fill(minified).join('\n') } }),
    );
    const output = await runner.run('read_file', {
      path: 'dist.js',
      startLine: null,
      endLine: null,
    });
    expect(output.text).toContain('[line cut]');
    expect(output.text.length).toBeLessThan(17_000);
    expect(output.text).toMatch(/call read_file with startLine \d+ to read on/);
  });

  it('reports mistakes as errors the model can act on', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'a.js': 'one', 'img.png': 'PNG\0\0' } }));
    const read = (path: string, startLine: number | null = null) =>
      runner.run('read_file', { path, startLine, endLine: null });
    expect(await read('missing.js')).toEqual({
      isError: true,
      text: 'Error: "missing.js" does not exist',
    });
    expect((await read('a.js', 5)).text).toBe('Error: a.js has only 1 lines');
    expect((await read('img.png')).text).toMatch(/binary/);
    expect((await read('../../etc/passwd')).text).toMatch(/must stay inside the repo/);
    expect((await read('node_modules/lodash/index.js')).text).toMatch(/off limits/);
  });

  it('lets the model read the upgraded package', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'node_modules/express/index.js': 'x' } }));
    const output = await runner.run('read_file', {
      path: 'node_modules/express/index.js',
      startLine: null,
      endLine: null,
    });
    expect(output.isError).toBe(false);
  });
});

describe('list_files and search_code', () => {
  it('lists a folder, with folders marked', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'src/a.js': '', 'src/lib/b.js': '' } }));
    expect((await runner.run('list_files', { path: 'src' })).text).toBe('src:\na.js\nlib/');
    expect((await runner.run('list_files', { path: 'nope' })).isError).toBe(true);
  });

  it(`caps a long listing at ${MAX_LIST_ENTRIES} entries`, async () => {
    const files = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [`many/f${String(i).padStart(3, '0')}.js`, '']),
    );
    const output = await runnerFor(new FakeSandbox({ files })).run('list_files', { path: 'many' });
    expect(output.text.split('\n')).toHaveLength(1 + MAX_LIST_ENTRIES + 1);
    expect(output.text).toContain('more entries not shown');
  });

  it('finds matches as path:line: text', async () => {
    const runner = runnerFor(
      new FakeSandbox({ files: { 'src/app.js': 'const a = 1;\n  app.del("/x");\n' } }),
    );
    const output = await runner.run('search_code', {
      pattern: 'app.del',
      isRegex: false,
      path: null,
    });
    expect(output.text).toBe('src/app.js:2: app.del("/x");');
    expect(
      (await runner.run('search_code', { pattern: 'zzz', isRegex: false, path: null })).text,
    ).toBe('No matches.');
  });

  it(`caps matches at ${MAX_SEARCH_MATCHES}`, async () => {
    const runner = runnerFor(
      new FakeSandbox({ files: { 'a.js': Array(80).fill('hit').join('\n') } }),
    );
    const output = await runner.run('search_code', { pattern: 'hit', isRegex: false, path: null });
    expect(output.text).toContain(`showing the first ${MAX_SEARCH_MATCHES} matches`);
  });
});

describe('write_file', () => {
  it('writes the file and remembers what it held before', async () => {
    const sandbox = new FakeSandbox({ files: { 'src/app.js': 'old' } });
    const runner = runnerFor(sandbox);
    expect(await runner.run('write_file', { path: 'src/app.js', content: 'new\n' })).toEqual({
      isError: false,
      text: 'OK: wrote src/app.js (2 lines).',
    });
    await runner.run('write_file', { path: 'src/app.js', content: 'newer\n' });
    await runner.run('write_file', { path: 'src/util.js', content: 'made up' });

    expect(sandbox.files.get('src/app.js')).toBe('newer\n');
    expect(runner.changedFiles).toEqual([
      { path: 'src/app.js', original: 'old', content: 'newer\n', isTest: false },
      { path: 'src/util.js', original: null, content: 'made up', isTest: false },
    ]);
  });

  it('forgets a file that is written back to its original content', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'src/app.js': 'old' } }));
    await runner.run('write_file', { path: 'src/app.js', content: 'new' });
    const output = await runner.run('write_file', { path: 'src/app.js', content: 'old' });
    expect(output.text).toMatch(/matches the original file again/);
    expect(runner.changedFiles).toEqual([]);
  });

  it('keeps the file’s Windows line endings and final newline', async () => {
    const sandbox = new FakeSandbox({ files: { 'src/app.js': 'a();\r\nb();\r\n' } });
    const runner = runnerFor(sandbox);

    // The model sees plain lines, and writes plain \n without the last newline.
    const read = await runner.run('read_file', {
      path: 'src/app.js',
      startLine: null,
      endLine: null,
    });
    expect(read.text).toBe('src/app.js, lines 1-2 of 2:\n1| a();\n2| b();');
    await runner.run('write_file', { path: 'src/app.js', content: 'a();\nc();' });

    expect(sandbox.files.get('src/app.js')).toBe('a();\r\nc();\r\n');
    expect(runner.changedFiles[0]?.content).toBe('a();\r\nc();\r\n');
  });

  it('adds back a dropped final newline, and leaves new files as written', () => {
    expect(keepFileConventions('x\n', 'y')).toBe('y\n');
    expect(keepFileConventions('x', 'y')).toBe('y');
    expect(keepFileConventions(null, 'y')).toBe('y');
    expect(keepFileConventions('x\r\n', 'y\r\n')).toBe('y\r\n');
  });

  it('counts putting a file back as a change worth testing', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'a.js': 'old' } }));
    await runner.run('write_file', { path: 'a.js', content: 'new' });
    await runner.run('run_tests', { changeSummary: 'New.' });
    await runner.run('write_file', { path: 'a.js', content: 'old' });
    const output = await runner.run('run_tests', { changeSummary: 'Back to the original.' });
    expect(output.text).toBe('PASS: npm test passed.');
    expect(runner.attempts).toBe(2);
  });

  it('flags test files', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'test/app.test.js': 'old' } }));
    const output = await runner.run('write_file', { path: 'test/app.test.js', content: 'new' });
    expect(output.text).toMatch(/test file.*flagged for human review/);
    expect(runner.changedFiles[0]?.isTest).toBe(true);
  });

  it('refuses protected files and leaves them untouched', async () => {
    const sandbox = new FakeSandbox({ files: { 'package.json': '{}' } });
    const runner = runnerFor(sandbox);
    const output = await runner.run('write_file', { path: 'package.json', content: '{"x":1}' });
    expect(output.isError).toBe(true);
    expect(output.text).toMatch(/npm owns this file/);
    expect(sandbox.files.get('package.json')).toBe('{}');
    expect(runner.changedFiles).toEqual([]);
  });
});

describe('run_tests', () => {
  it('does not run or count a test run when nothing changed', async () => {
    const sandbox = new FakeSandbox({ files: { 'a.js': 'x' } });
    const runner = runnerFor(sandbox);
    const output = await runner.run('run_tests', { changeSummary: 'nothing yet' });
    expect(output.text).toMatch(/^Not run: nothing has changed/);
    expect(runner.attempts).toBe(0);
    expect(sandbox.calls).not.toContain('npm test');
  });

  it('counts attempts, reports what is left and keeps the digest', async () => {
    const sandbox = new FakeSandbox({
      files: { 'a.js': 'x' },
      testResult: (files) => (files.get('a.js') === 'fixed' ? {} : failingTests('boom')),
    });
    const runner = runnerFor(sandbox);

    await runner.run('write_file', { path: 'a.js', content: 'try 1' });
    const fail = await runner.run('run_tests', { changeSummary: 'First try.' });
    expect(fail.text).toMatch(/^FAIL \(attempt 1 of 3, 2 left\)\.\n/);
    expect(fail.text).toContain('boom');
    expect(runner.lastRun?.passed).toBe(false);
    expect(runner.passing).toBe(false);

    await runner.run('write_file', { path: 'a.js', content: 'fixed' });
    expect(await runner.run('run_tests', { changeSummary: 'Second try.' })).toEqual({
      isError: false,
      text: 'PASS: npm test passed.',
    });
    expect(runner.attempts).toBe(2);
    expect(runner.passing).toBe(true);
    expect(runner.changeSummaries).toEqual(['First try.', 'Second try.']);
  });

  it('is no longer passing once a file changes after the run', async () => {
    const runner = runnerFor(new FakeSandbox({ files: { 'a.js': 'x' } }));
    await runner.run('write_file', { path: 'a.js', content: 'y' });
    await runner.run('run_tests', { changeSummary: 'y' });
    expect(runner.passing).toBe(true);
    await runner.run('write_file', { path: 'a.js', content: 'z' });
    expect(runner.passing).toBe(false);
  });

  it('explains a timeout', async () => {
    const runner = runnerFor(
      new FakeSandbox({
        files: { 'a.js': 'x' },
        testResult: () => ({ outcome: 'timeout', exitCode: 137 }),
      }),
    );
    await runner.run('write_file', { path: 'a.js', content: 'y' });
    const output = await runner.run('run_tests', { changeSummary: 'y' });
    expect(output.text).toMatch(/did not finish within 300 s/);
  });

  it('throws when the container is gone, instead of telling the model', async () => {
    const sandbox = new FakeSandbox({ files: { 'a.js': 'x' } });
    const runner = runnerFor(sandbox);
    await runner.run('write_file', { path: 'a.js', content: 'y' });
    sandbox.failNextExec = new SandboxError('could not start "npm test": container not running');
    await expect(runner.run('run_tests', { changeSummary: 'y' })).rejects.toThrow(SandboxError);
  });
});

describe('ToolRunner input checks', () => {
  it('refuses unknown tools and bad input as errors', async () => {
    const runner = runnerFor(new FakeSandbox());
    expect((await runner.run('delete_everything', {})).text).toBe(
      'Error: there is no tool called "delete_everything"',
    );
    expect((await runner.run('read_file', { path: 3 })).text).toMatch(
      /^Error: invalid input for read_file/,
    );
  });
});
