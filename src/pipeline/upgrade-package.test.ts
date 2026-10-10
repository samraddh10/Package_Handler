import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeSandbox, failingTests } from '../../tests/helpers/fake-sandbox.js';
import { type ScriptedTurn, scriptedRouter } from '../../tests/helpers/scripted-model.js';
import type { UpgradeCandidate } from '../scanner/scan.js';
import { type UpgradeOptions, upgradePackage } from './upgrade-package.js';

/**
 * The upgrade runner against a fake container and a real git clone on disk.
 *
 * The container side is a FakeSandbox: `npm install` is scripted to rewrite
 * package.json and the lockfile the way npm would, and `npm test` passes or
 * fails depending on src/app.js. The host side is real: files are written into
 * a temporary git repo, and the "needs review" path really diffs and restores.
 */

const BROKEN = "app.del('/todos/:id', remove);\n";
const FIXED = "app.delete('/todos/:id', remove);\n";
const PACKAGE_JSON = `${JSON.stringify(
  {
    name: 'demo',
    scripts: { test: 'mocha' },
    dependencies: { cors: '^2.8.4', express: '^4.21.2' },
  },
  null,
  2,
)}\n`;
const INSTALL = 'npm install express@5.3.0 --save-prod --save-exact=false --save-prefix=^';

const express: UpgradeCandidate = {
  name: 'express',
  from: '4.21.2',
  to: '5.3.0',
  wanted: '4.22.3',
  bump: 'major',
  dependencyType: 'dependencies',
  security: null,
};

/** What `npm install express@5.3.0` does to the files. */
function npmInstall(files: Map<string, string>) {
  files.set('package.json', PACKAGE_JSON.replace('"^4.21.2"', '"^5.3.0"'));
  files.set('package-lock.json', '{"lockfileVersion":3,"express":"5.3.0"}\n');
  files.set('node_modules/express/package.json', '{"name":"express","version":"5.3.0"}');
}

describe('upgradePackage', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-upgrade-'));
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'package.json'), PACKAGE_JSON);
    writeFileSync(join(repoDir, 'package-lock.json'), '{"lockfileVersion":3,"express":"4.21.2"}\n');
    writeFileSync(join(repoDir, 'src', 'app.js'), BROKEN);
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: repoDir,
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  /** A container holding the project, where src/app.js decides whether the tests pass. */
  function container(overrides: ConstructorParameters<typeof FakeSandbox>[0] = {}) {
    return new FakeSandbox({
      files: {
        'package.json': PACKAGE_JSON,
        'package-lock.json': '{"lockfileVersion":3,"express":"4.21.2"}\n',
        'src/app.js': BROKEN,
        'node_modules/express/package.json': '{"name":"express","version":"4.21.2"}',
      },
      onCommand: (command, files) => {
        if (command === INSTALL) {
          npmInstall(files);
        }
      },
      testResult: (files) =>
        files.get('src/app.js') === FIXED
          ? {}
          : failingTests('TypeError: app.del is not a function'),
      ...overrides,
    });
  }

  function options(sandbox: FakeSandbox, turns: ScriptedTurn[] = []): UpgradeOptions {
    return {
      limits: { installTimeoutSec: 300, testTimeoutSec: 300, memoryMb: 2048 },
      fixAgent: { maxAttempts: 3, maxSteps: 20, maxTokens: 200_000 },
      createSandbox: async () => sandbox,
      router: scriptedRouter(turns).router,
    };
  }

  const repoFile = (path: string) => readFileSync(join(repoDir, path), 'utf8');

  it('installs, tests and writes the bump into the clone when the tests pass', async () => {
    const sandbox = container({ testResult: () => ({}) });
    const result = await upgradePackage(repoDir, express, options(sandbox));

    expect(result).toMatchObject({
      status: 'passed',
      newRange: '^5.3.0',
      reason: null,
      files: ['package.json', 'package-lock.json'],
      flaky: false,
      fix: null,
    });
    expect(sandbox.calls).toEqual([
      `copyIn ${repoDir}`,
      'npm ci',
      INSTALL,
      'disconnectNetwork',
      'npm test',
      'destroy',
    ]);
    expect(repoFile('package.json')).toContain('"express": "^5.3.0"');
    expect(repoFile('package-lock.json')).toContain('5.3.0');
  });

  it('re-runs failing tests once and calls a pass on the second run flaky', async () => {
    let runs = 0;
    const sandbox = container({
      testResult: () => (++runs === 1 ? failingTests('timing') : {}),
    });
    const result = await upgradePackage(repoDir, express, options(sandbox));
    expect(result).toMatchObject({ status: 'passed', flaky: true, fix: null });
  });

  it('lets the fix agent fix the code and writes its fix into the clone', async () => {
    const sandbox = container();
    const result = await upgradePackage(
      repoDir,
      express,
      options(sandbox, [
        {
          tools: [
            { name: 'write_file', input: { path: 'src/app.js', content: FIXED } },
            { name: 'run_tests', input: { changeSummary: 'Use app.delete.' } },
          ],
        },
      ]),
    );

    expect(result.status).toBe('fixed');
    expect(result.files).toEqual(['package.json', 'package-lock.json', 'src/app.js']);
    expect(result.failureDigest).toContain('app.del is not a function');
    expect(result.fix).toMatchObject({ status: 'fixed', attempts: 1 });
    expect(repoFile('src/app.js')).toBe(FIXED);
    // The first failure was re-run once before the agent was asked.
    expect(sandbox.calls.filter((call) => call === 'npm test')).toHaveLength(3);
  });

  it('keeps only the version bump when the agent fails, and saves its attempt as a diff', async () => {
    const sandbox = container();
    const result = await upgradePackage(
      repoDir,
      express,
      options(sandbox, [
        {
          tools: [
            { name: 'write_file', input: { path: 'src/app.js', content: 'app.remove();\n' } },
            {
              name: 'write_file',
              input: { path: 'src/compat.js', content: 'module.exports = {};\n' },
            },
            { name: 'run_tests', input: { changeSummary: 'Try app.remove.' } },
          ],
        },
        { text: 'I could not find the replacement for app.del.' },
      ]),
    );

    expect(result.status).toBe('needs-human-review');
    expect(result.reason).toBe('the fix agent stopped without a fix');
    expect(result.files).toEqual(['package.json', 'package-lock.json']);
    expect(result.attemptedDiff).toContain("-app.del('/todos/:id', remove);");
    expect(result.attemptedDiff).toContain('+app.remove();');
    expect(result.attemptedDiff).toContain('new file mode');
    // The clone holds the bump and nothing else.
    expect(repoFile('src/app.js')).toBe(BROKEN);
    expect(existsSync(join(repoDir, 'src', 'compat.js'))).toBe(false);
    expect(repoFile('package.json')).toContain('"express": "^5.3.0"');
  });

  it('says so when no LLM is configured, and still keeps the bump', async () => {
    const sandbox = container();
    const result = await upgradePackage(repoDir, express, {
      ...options(sandbox),
      router: scriptedRouter([{ error: new Error('unused') }], 0).router,
    });
    expect(result.status).toBe('needs-human-review');
    expect(result.reason).toMatch(/^no LLM was available to fix the code/);
    expect(repoFile('package.json')).toContain('^5.3.0');
  });

  it('skips a package npm cannot install, leaving the clone untouched', async () => {
    const stderr = readFileSync(
      new URL('../../tests/fixtures/npm/install-eresolve.stderr.txt', import.meta.url),
      'utf8',
    );
    const sandbox = container({
      onCommand: () => {},
      script: { [INSTALL]: [{ outcome: 'failed', exitCode: 1, stderr }] },
    });
    const result = await upgradePackage(repoDir, express, options(sandbox));

    expect(result.status).toBe('install-failed');
    expect(result.reason).toMatch(/^needs a coordinated upgrade: react-dom@18\.3\.1 needs react/);
    expect(sandbox.calls).not.toContain('npm test');
    expect(sandbox.calls.at(-1)).toBe('destroy');
    expect(repoFile('package.json')).toBe(PACKAGE_JSON);
  });

  it('flags an install that changes package.json beyond the upgrade', async () => {
    const sandbox = container({
      onCommand: (command, files) => {
        if (command === INSTALL) {
          npmInstall(files);
          const manifest = JSON.parse(files.get('package.json') ?? '{}');
          manifest.scripts.postinstall = 'node steal.js';
          files.set('package.json', JSON.stringify(manifest));
        }
      },
    });
    const result = await upgradePackage(repoDir, express, options(sandbox));

    expect(result.status).toBe('tampered');
    expect(result.reason).toMatch(/scripts\.postinstall changed/);
    expect(sandbox.calls).not.toContain('npm test');
    expect(repoFile('package.json')).toBe(PACKAGE_JSON);
  });

  it('flags test code that rewrites the lockfile while it runs', async () => {
    const sandbox = container({
      testResult: (files) => {
        files.set('package-lock.json', '{"tampered":true}');
        return {};
      },
    });
    const result = await upgradePackage(repoDir, express, options(sandbox));
    expect(result).toMatchObject({
      status: 'tampered',
      reason: 'package-lock.json changed while the tests ran',
    });
    expect(repoFile('package-lock.json')).toContain('4.21.2');
  });

  it('refuses an install that did not put the new version in node_modules', async () => {
    const sandbox = container({
      onCommand: (command, files) => {
        if (command === INSTALL) {
          npmInstall(files);
          files.set('node_modules/express/package.json', '{"version":"4.21.2"}');
        }
      },
    });
    const result = await upgradePackage(repoDir, express, options(sandbox));
    expect(result).toMatchObject({
      status: 'install-failed',
      reason: 'npm installed express 4.21.2 instead of 5.3.0',
    });
  });

  it('does not re-run a test run that timed out, and tells the agent', async () => {
    const sandbox = container({ testResult: () => ({ outcome: 'timeout', exitCode: 137 }) });
    const scripted = scriptedRouter([{ text: 'The tests hang; I cannot tell why.' }]);
    const result = await upgradePackage(repoDir, express, {
      ...options(sandbox),
      router: scripted.router,
    });

    expect(sandbox.calls.filter((call) => call === 'npm test')).toHaveLength(1);
    expect(result.status).toBe('needs-human-review');
    expect(JSON.stringify(scripted.prompts[0])).toContain(
      'npm test did not finish within 300 s and was stopped.',
    );
  });

  it('keeps the range style of the project', async () => {
    const tilde = PACKAGE_JSON.replace('"^4.21.2"', '"~4.21.2"');
    writeFileSync(join(repoDir, 'package.json'), tilde);
    const tildeInstall = 'npm install express@5.3.0 --save-prod --save-exact=false --save-prefix=~';
    const sandbox = container({
      testResult: () => ({}),
      onCommand: (command, files) => {
        if (command === tildeInstall) {
          npmInstall(files);
          files.set('package.json', tilde.replace('"~4.21.2"', '"~5.3.0"'));
        }
      },
    });
    sandbox.files.set('package.json', tilde);

    const result = await upgradePackage(repoDir, express, options(sandbox));
    expect(result).toMatchObject({ status: 'passed', newRange: '~5.3.0' });
    expect(sandbox.calls).toContain(tildeInstall);
  });
});
