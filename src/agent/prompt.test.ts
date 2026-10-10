import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeFailureDigest } from '../sandbox/test-output.js';
import { buildFirstMessage, type FixTask, stackPaths } from './prompt.js';

function digestOf(runner: string): string {
  const read = (stream: string) =>
    readFileSync(
      new URL(`../../tests/fixtures/test-output/${runner}.${stream}.txt`, import.meta.url),
      'utf8',
    );
  return makeFailureDigest(read('stdout'), read('stderr'));
}

describe('stackPaths', () => {
  it.each(['mocha', 'jest', 'vitest', 'node-test'])(
    'finds the project files in real %s output',
    (runner) => {
      const paths = stackPaths(digestOf(runner));
      expect(paths).toContain('src/math.js');
      expect(paths.some((path) => path.startsWith('test/math.test.'))).toBe(true);
      expect(paths.every((path) => !path.includes('node_modules'))).toBe(true);
    },
  );

  it('orders by how often a file appears and skips dependencies and Node', () => {
    const digest = [
      'at handle (node_modules/express/lib/router/layer.js:95:5)',
      'at Object.<anonymous> (src/app.js:41:7)',
      'at createApp (src/app.js:12:3)',
      'at Context.<anonymous> (test/app.test.js:9:11)',
      'at process.processTicksAndRejections (node:internal/process/task_queues:105:5)',
    ].join('\n');
    expect(stackPaths(digest)).toEqual(['src/app.js', 'test/app.test.js']);
  });
});

describe('buildFirstMessage', () => {
  const task: FixTask = {
    packageName: 'express',
    fromVersion: '4.21.2',
    toVersion: '5.3.0',
    breakingChanges: [
      {
        title: 'app.del() removed',
        details: 'The alias was deprecated in 4.x.',
        affectedApis: ['app.del()'],
        migration: 'Use app.delete()',
      },
      {
        title: 'req.param() removed',
        details: 'Read req.params, req.body or req.query instead.',
        affectedApis: [],
        migration: null,
      },
    ],
    breakingChangesNote: null,
    nodeEngine: '>= 18',
    failureDigest: 'TypeError: app.del is not a function\n    at createApp (src/app.js:43:7)',
    maxAttempts: 3,
  };

  it('gives the model everything it needs to start', () => {
    const message = buildFirstMessage(task);
    expect(message).toContain('express was upgraded from 4.21.2 to 5.3.0, and npm test now fails.');
    expect(message).toContain('1. app.del() removed: The alias was deprecated in 4.x.');
    expect(message).toContain('   APIs: app.del()');
    expect(message).toContain('   Instead: Use app.delete()');
    expect(message).toContain('2. req.param() removed');
    expect(message).toContain('The new version needs Node.js >= 18.');
    expect(message).toContain('<test-output>\nTypeError: app.del is not a function');
    expect(message).toContain(
      'Project files in the stack traces (a good place to start):\n- src/app.js',
    );
    expect(message).toContain('You have 3 test runs.');
  });

  it('says why there are no breaking changes when there are none', () => {
    const message = buildFirstMessage({
      ...task,
      breakingChanges: [],
      breakingChangesNote: 'no release notes were found',
      nodeEngine: null,
    });
    expect(message).toContain(
      'Breaking changes from the release notes: no release notes were found.',
    );
    expect(message).not.toContain('Node.js');
  });
});
