import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import {
  createWorkspace,
  parseTarget,
  removeWorkspace,
  type Workspace,
} from '../../src/git/workspace.js';
import { upgradePackage } from '../../src/pipeline/upgrade-package.js';
import { Sandbox } from '../../src/sandbox/sandbox.js';
import type { UpgradeCandidate } from '../../src/scanner/scan.js';
import { type ScriptedTurn, scriptedRouter } from '../helpers/scripted-model.js';

/**
 * One package upgrade against real git, real Docker and the real npm registry,
 * with a scripted model standing in for the LLM. It proves the parts the unit
 * tests fake: npm really saves the range, the tamper check accepts what real
 * npm writes, tests really run offline, and the agent's tools really work in
 * a container. Needs Docker and internet access.
 *
 * The project is tests/fixtures/projects/tiny-outdated (is-number ^6.0.0).
 */

const config = parseConfig({});
const fixture = new URL('../fixtures/projects/tiny-outdated', import.meta.url);

const isNumber: UpgradeCandidate = {
  name: 'is-number',
  from: '6.0.0',
  to: '7.0.0',
  wanted: '6.0.0',
  bump: 'major',
  dependencyType: 'dependencies',
  security: null,
};

/** A version check that the upgrade breaks, standing in for a real breaking change. */
const VERSION_GUARD = `const { version } = require('is-number/package.json');
if (!version.startsWith('6.')) {
  throw new Error(\`is-number \${version} is not supported\`);
}
`;

describe('upgradePackage, end to end', () => {
  const docker = new Docker();
  let scratch: string;
  let source: string;
  let workspace: Workspace;

  /** Commits the source folder and clones it, like the CLI does with a target. */
  async function cloneSource() {
    const git = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
        cwd: source,
      });
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'fixture');
    workspace = await createWorkspace(parseTarget(source), {
      workspaceDir: join(scratch, 'workspaces'),
    });
  }

  function upgrade(turns: ScriptedTurn[]) {
    return upgradePackage(workspace.repoDir, isNumber, {
      limits: config.sandbox,
      fixAgent: config.fixAgent,
      createSandbox: () => Sandbox.create({ ...config.sandbox, docker, name: 'test-upgrade' }),
      router: scriptedRouter(turns).router,
    });
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'upgrade-agent-upgrade-'));
    source = join(scratch, 'tiny-outdated');
    cpSync(fixture, source, { recursive: true });
  });

  afterEach(async () => {
    if (workspace !== undefined) {
      await removeWorkspace(workspace);
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it('upgrades a package whose tests still pass, keeping the caret range', async () => {
    await cloneSource();
    const result = await upgrade([]);

    expect(result).toMatchObject({
      status: 'passed',
      newRange: '^7.0.0',
      files: ['package.json', 'package-lock.json'],
      fix: null,
      warnings: [],
    });
    const manifest = JSON.parse(readFileSync(join(workspace.repoDir, 'package.json'), 'utf8'));
    expect(manifest.dependencies['is-number']).toBe('^7.0.0');
    const lock = JSON.parse(readFileSync(join(workspace.repoDir, 'package-lock.json'), 'utf8'));
    expect(lock.packages['node_modules/is-number'].version).toBe('7.0.0');
  });

  it('lets the agent fix a breaking upgrade with real tools in a real container', async () => {
    const original = readFileSync(join(source, 'index.js'), 'utf8');
    writeFileSync(join(source, 'index.js'), VERSION_GUARD + original);
    await cloneSource();

    const result = await upgrade([
      // Look around the way a model would, through the real tools.
      {
        tools: [
          { name: 'read_file', input: { path: 'index.js', startLine: null, endLine: null } },
          { name: 'search_code', input: { pattern: 'is-number', isRegex: false, path: null } },
          { name: 'list_files', input: { path: 'node_modules/is-number' } },
          { name: 'write_file', input: { path: 'package.json', content: '{}' } },
        ],
      },
      {
        tools: [
          { name: 'write_file', input: { path: 'index.js', content: original } },
          { name: 'run_tests', input: { changeSummary: 'Removed the is-number 6 version check.' } },
        ],
      },
    ]);

    expect(result.status).toBe('fixed');
    expect(result.failureDigest).toContain('is-number 7.0.0 is not supported');
    expect(result.fix).toMatchObject({ status: 'fixed', attempts: 1, steps: 2 });
    expect(result.files).toEqual(['package.json', 'package-lock.json', 'index.js']);
    expect(readFileSync(join(workspace.repoDir, 'index.js'), 'utf8')).toBe(original);
    // The refused write never reached package.json.
    const manifest = JSON.parse(readFileSync(join(workspace.repoDir, 'package.json'), 'utf8'));
    expect(manifest.dependencies['is-number']).toBe('^7.0.0');
  });

  it('keeps only the bump, and the attempt as a diff, when the agent fails', async () => {
    const original = readFileSync(join(source, 'index.js'), 'utf8');
    writeFileSync(join(source, 'index.js'), VERSION_GUARD + original);
    await cloneSource();

    const result = await upgrade([
      {
        tools: [
          {
            name: 'write_file',
            input: { path: 'index.js', content: VERSION_GUARD.replace("'6.'", "'8.'") + original },
          },
          { name: 'run_tests', input: { changeSummary: 'Allow version 8.' } },
        ],
      },
      { text: 'I do not know which version to allow.' },
    ]);

    expect(result.status).toBe('needs-human-review');
    expect(result.files).toEqual(['package.json', 'package-lock.json']);
    expect(result.attemptedDiff).toContain("+if (!version.startsWith('8.')) {");
    expect(readFileSync(join(workspace.repoDir, 'index.js'), 'utf8')).toBe(
      VERSION_GUARD + original,
    );
  });
});
