import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../sandbox/sandbox.js';
import type { AuditReport } from './parse.js';
import { checkRepo, type Manifest } from './repo-checks.js';
import {
  type BaselineSandbox,
  describeScan,
  planUpgrades,
  ScanError,
  type ScanResult,
  scanWorkspace,
} from './scan.js';

function fixture(path: string): string {
  return readFileSync(new URL(`../../tests/fixtures/${path}`, import.meta.url), 'utf8');
}

/** demo-express-api's package.json, which the outdated and audit fixtures came from. */
const expressApiPackage = {
  name: 'demo-express-api',
  scripts: { test: 'mocha' },
  dependencies: { cors: '^2.8.4', express: '^4.21.2', morgan: '^1.10.0' },
  devDependencies: { mocha: '^12.0.3', supertest: '^7.1.4' },
};

const limits = { installTimeoutSec: 300, testTimeoutSec: 300, memoryMb: 2048 };

/**
 * A sandbox that plays back scripted results, one per call, keyed by the command
 * line, and records every call so the tests can check the order of the steps.
 * Unscripted commands succeed with no output.
 */
function fakeSandbox(script: Record<string, Partial<ExecResult>[]> = {}) {
  const calls: string[] = [];
  const sandbox: BaselineSandbox = {
    async copyIn() {
      calls.push('copyIn');
    },
    async exec(command) {
      const key = command.join(' ');
      calls.push(key);
      return {
        command,
        outcome: 'ok',
        exitCode: 0,
        stdout: '',
        stderr: '',
        durationMs: 1500,
        truncated: false,
        ...script[key]?.shift(),
      };
    },
    async disconnectNetwork() {
      calls.push('disconnectNetwork');
    },
    async destroy() {
      calls.push('destroy');
    },
  };
  return { sandbox, calls };
}

/** What a healthy demo-express-api baseline returns, using the captured npm output. */
function healthyScript(): Record<string, Partial<ExecResult>[]> {
  return {
    'npm outdated --json': [
      { outcome: 'failed', exitCode: 1, stdout: fixture('npm/outdated-demo-express-api.json') },
    ],
    'npm audit --json': [
      { outcome: 'failed', exitCode: 1, stdout: fixture('npm/audit-demo-express-api.json') },
    ],
  };
}

describe('scanWorkspace', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-scan-'));
    writeFileSync(join(repoDir, 'package.json'), JSON.stringify(expressApiPackage));
    writeFileSync(join(repoDir, 'package-lock.json'), '{}');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('runs the baseline steps in order, with the network cut before the tests', async () => {
    const { sandbox, calls } = fakeSandbox(healthyScript());

    const result = await scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    expect(calls).toEqual([
      'copyIn',
      'npm ci',
      'npm outdated --json',
      'npm audit --json',
      'disconnectNetwork',
      'npm test',
      'destroy',
    ]);
    expect(result.baseline).toEqual({ installMs: 1500, testMs: 1500, flaky: false });
  });

  it('lists the upgrades with security fixes first, then patch, minor, major', async () => {
    const { sandbox } = fakeSandbox(healthyScript());

    const result = await scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    expect(result.upgrades.map((upgrade) => [upgrade.name, upgrade.bump])).toEqual([
      ['express', 'major'], // high severity, fixed by 5.3.0
      ['morgan', 'minor'], // moderate, fixed by 1.12.1
      ['cors', 'patch'],
      ['supertest', 'minor'],
    ]);
    expect(result.upgrades[0]).toMatchObject({
      from: '4.21.2',
      to: '5.3.0',
      wanted: '4.22.3',
      dependencyType: 'dependencies',
      security: { severity: 'high', fixedByUpgrade: true },
    });
    expect(result.upgrades.at(-1)?.dependencyType).toBe('devDependencies');
    expect(result.warnings).toEqual([]);
  });

  it('stops before creating a sandbox when the repo is unsupported', async () => {
    rmSync(join(repoDir, 'package-lock.json'));
    let created = false;

    const scan = scanWorkspace(repoDir, {
      limits,
      createSandbox: async () => {
        created = true;
        return fakeSandbox().sandbox;
      },
    });

    await expect(scan).rejects.toMatchObject({
      reason: 'unsupported-repo',
      details: expect.stringContaining('there is no package-lock.json'),
    });
    expect(created).toBe(false);
  });

  it("stops when npm ci fails, with npm's own reason, and still removes the container", async () => {
    const { sandbox, calls } = fakeSandbox({
      'npm ci': [
        { outcome: 'failed', exitCode: 1, stderr: fixture('npm/ci-out-of-sync.stderr.txt') },
      ],
    });

    const scan = scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    await expect(scan).rejects.toThrow(/npm ci failed \(EUSAGE\): `npm ci` can only install/);
    expect(calls).toEqual(['copyIn', 'npm ci', 'destroy']);
  });

  it('re-runs failing tests once, then stops with a digest of the failure', async () => {
    const mochaFailure: Partial<ExecResult> = {
      outcome: 'failed',
      exitCode: 2,
      stdout: fixture('test-output/mocha.stdout.txt'),
    };
    const { sandbox, calls } = fakeSandbox({
      ...healthyScript(),
      'npm test': [mochaFailure, { ...mochaFailure }],
    });

    const error: unknown = await scanWorkspace(repoDir, {
      limits,
      createSandbox: async () => sandbox,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).reason).toBe('tests-failing');
    expect((error as ScanError).message).toMatch(/already fails before any upgrade/);
    expect((error as ScanError).details).toContain('at parsePrice (src/math.js:10:22)');
    expect(calls.filter((call) => call === 'npm test')).toHaveLength(2);
    expect(calls.at(-1)).toBe('destroy');
  });

  it('carries on, with a warning, when the tests only fail the first time', async () => {
    const { sandbox } = fakeSandbox({
      ...healthyScript(),
      'npm test': [
        { outcome: 'failed', exitCode: 1 },
        { outcome: 'ok', durationMs: 900 },
      ],
    });

    const result = await scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    expect(result.baseline).toMatchObject({ testMs: 900, flaky: true });
    expect(result.warnings[0]).toMatch(/look flaky/);
  });

  it('does not re-run a timeout, and says memory may be the cause', async () => {
    const { sandbox, calls } = fakeSandbox({
      ...healthyScript(),
      'npm test': [{ outcome: 'timeout', exitCode: 137, durationMs: 300_000 }],
    });

    const scan = scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    await expect(scan).rejects.toThrow(/did not finish within 300s \(TEST_TIMEOUT_SEC.*2048 MB/);
    expect(calls.filter((call) => call === 'npm test')).toHaveLength(1);
  });

  it('carries on without security data when npm audit fails', async () => {
    const { sandbox } = fakeSandbox({
      ...healthyScript(),
      'npm audit --json': [
        { outcome: 'failed', exitCode: 1, stdout: fixture('npm/audit-offline.json') },
      ],
    });

    const result = await scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    expect(result.audit).toBeNull();
    expect(result.warnings[0]).toMatch(/^no security information: npm audit failed: request to/);
    expect(result.upgrades.map((upgrade) => upgrade.name)).toEqual([
      'cors',
      'morgan',
      'supertest',
      'express',
    ]);
  });

  it('explains a silent npm crash from what it printed on stderr', async () => {
    const { sandbox } = fakeSandbox({
      'npm outdated --json': [
        {
          outcome: 'failed',
          exitCode: 1,
          stderr: 'npm error code EJSONPARSE\nnpm error Invalid package.json\n',
        },
      ],
    });

    const scan = scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    await expect(scan).rejects.toThrow(/npm outdated printed no JSON: Invalid package.json/);
  });

  it('stops when npm outdated cannot answer', async () => {
    const { sandbox } = fakeSandbox({
      'npm outdated --json': [
        { outcome: 'failed', exitCode: 1, stdout: '{"error": {"summary": "registry is down"}}' },
      ],
    });

    const scan = scanWorkspace(repoDir, { limits, createSandbox: async () => sandbox });

    await expect(scan).rejects.toMatchObject({
      reason: 'outdated-failed',
      message: expect.stringContaining('registry is down'),
    });
  });
});

describe('planUpgrades', () => {
  const check = checkRepo(
    JSON.stringify({
      scripts: { test: 'node --test' },
      dependencies: { lodash: '^4.17.20', mylib: 'github:me/mylib' },
      optionalDependencies: { fsevents: '^2.3.0' },
      peerDependencies: { react: '^18.0.0' },
    }),
    ['package.json', 'package-lock.json'],
  );
  const manifest = check.ok ? check.manifest : ({} as Manifest);

  it('skips what it cannot or should not upgrade, and says why', () => {
    const { upgrades, skipped } = planUpgrades(
      manifest,
      [
        { name: 'react', current: '18.3.1', wanted: '18.3.1', latest: '19.2.0' },
        { name: 'fsevents', current: null, wanted: '2.3.3', latest: '2.3.3' },
        { name: 'mylib', current: 'git', wanted: 'git', latest: 'git' },
        { name: 'ghost', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' },
      ],
      null,
    );

    expect(upgrades).toEqual([]);
    expect(Object.fromEntries(skipped.map((skip) => [skip.name, skip.reason]))).toEqual({
      react: expect.stringMatching(/^only a peer dependency/),
      fsevents: expect.stringMatching(/^not installed/),
      mylib: 'npm reports git → git, which is not a semver upgrade',
      ghost: 'not listed in package.json',
    });
  });

  it('warns when the upgrade leaves a vulnerability in place', () => {
    const audit: AuditReport = {
      findings: [{ name: 'lodash', severity: 'high', vulnerableRange: '<=4.99.0', advisories: [] }],
      counts: { info: 0, low: 0, moderate: 0, high: 1, critical: 0, total: 1 },
    };

    const { upgrades, warnings } = planUpgrades(
      manifest,
      [{ name: 'lodash', current: '4.17.20', wanted: '4.18.1', latest: '4.18.1' }],
      audit,
    );

    expect(upgrades[0]?.security?.fixedByUpgrade).toBe(false);
    expect(warnings[0]).toMatch(/lodash 4\.18\.1 is still inside the vulnerable range <=4\.99\.0/);
  });
});

describe('describeScan', () => {
  const result: ScanResult = {
    packageName: 'demo-express-api',
    upgrades: [
      {
        name: 'express',
        from: '4.21.2',
        to: '5.3.0',
        wanted: '4.22.3',
        bump: 'major',
        dependencyType: 'dependencies',
        security: { severity: 'high', advisories: [], fixedByUpgrade: true },
      },
      {
        name: 'supertest',
        from: '7.1.4',
        to: '7.3.1',
        wanted: '7.3.1',
        bump: 'minor',
        dependencyType: 'devDependencies',
        security: null,
      },
    ],
    skipped: [{ name: 'react', reason: 'only a peer dependency' }],
    audit: {
      findings: [],
      counts: { info: 0, low: 1, moderate: 3, high: 2, critical: 0, total: 6 },
    },
    baseline: { installMs: 3200, testMs: 270, flaky: false },
    warnings: ['something to know'],
  };

  it('prints the baseline, the audit and the upgrades as a table', () => {
    expect(describeScan(result)).toEqual([
      'Baseline:  npm ci 3.2s, npm test passed in 0.3s',
      'Audit:     6 vulnerable packages in the tree (2 high, 3 moderate, 1 low)',
      '',
      '2 upgrades, in the order they would run:',
      '  #  package    from    to     bump   type  security',
      '  1  express    4.21.2  5.3.0  major  prod  high, 0 advisories, fixed by this upgrade',
      '  2  supertest  7.1.4   7.3.1  minor  dev   -',
      '',
      'Skipped:',
      '  - react: only a peer dependency',
      '',
      'Warnings:',
      '  - something to know',
    ]);
  });

  it('says so when there is nothing to upgrade', () => {
    const lines = describeScan({ ...result, upgrades: [], skipped: [], warnings: [], audit: null });

    expect(lines).toContain(
      'Nothing to upgrade: every direct dependency is on its latest version.',
    );
    expect(lines[1]).toBe('Audit:     not available (see the warnings below)');
  });
});
