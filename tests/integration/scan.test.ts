import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { createWorkspace, parseTarget, removeWorkspace } from '../../src/git/workspace.js';
import { Sandbox } from '../../src/sandbox/sandbox.js';
import { ScanError, scanWorkspace } from '../../src/scanner/scan.js';

/**
 * The whole scan against real git, real Docker and the real npm registry: a
 * fixture project is committed to a throwaway repo, cloned like any target,
 * and scanned. Needs Docker and internet access.
 */

const config = parseConfig({});
const fixture = new URL('../fixtures/projects/tiny-outdated', import.meta.url);

describe('scan, end to end', () => {
  const docker = new Docker();
  let scratch: string;
  let source: string;

  /** Commits the source folder, clones it and scans the clone. */
  async function commitAndScan() {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: source,
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');

    const workspace = await createWorkspace(parseTarget(source), {
      workspaceDir: join(scratch, 'workspaces'),
    });
    try {
      return await scanWorkspace(workspace.repoDir, {
        limits: config.sandbox,
        createSandbox: () => Sandbox.create({ ...config.sandbox, docker, name: 'test-scan' }),
      });
    } finally {
      await removeWorkspace(workspace);
    }
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'upgrade-agent-e2e-'));
    source = join(scratch, 'tiny-outdated');
    cpSync(fixture, source, { recursive: true });
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('lists the outdated dependency of a project whose tests pass', async () => {
    const scan = await commitAndScan();

    expect(scan.upgrades).toEqual([
      expect.objectContaining({
        name: 'is-number',
        from: '6.0.0',
        to: '7.0.0',
        bump: 'major',
        dependencyType: 'dependencies',
        security: null,
      }),
    ]);
    expect(scan.baseline.flaky).toBe(false);
    expect(scan.audit?.counts.total).toBe(0);
  });

  it('stops with a failure digest when the tests already fail', async () => {
    writeFileSync(
      join(source, 'test', 'broken.test.js'),
      "const assert = require('node:assert/strict');\n" +
        "require('node:test').test('is broken', () => assert.equal(1 + 1, 3));\n",
    );

    const error: unknown = await commitAndScan().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ScanError);
    expect((error as ScanError).reason).toBe('tests-failing');
    expect((error as ScanError).details).toContain('not ok');
    expect((error as ScanError).details).toContain('2 !== 3');
  });
});
