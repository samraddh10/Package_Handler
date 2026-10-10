import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type AgentEvent, type FixResult, runFixAgent } from '../agent/fix-agent.js';
import type { FixTask } from '../agent/prompt.js';
import type { UpgradeAnalysis } from '../changelog/analyze.js';
import type { Config } from '../config.js';
import { diffWorkspace, restoreFiles } from '../git/workspace.js';
import type { LlmRouter } from '../llm/router.js';
import type { ExecResult, Sandbox } from '../sandbox/sandbox.js';
import { writeCopiedOutFile } from '../sandbox/tar.js';
import { makeFailureDigest } from '../sandbox/test-output.js';
import type { UpgradeCandidate } from '../scanner/scan.js';
import { checkManifestChange, describeInstallFailure, planSave, rangeIn } from './manifest.js';

/**
 * One package, from "express is outdated" to "these files, ready to commit".
 *
 *   1. a fresh container with the untouched project: npm ci
 *   2. npm install <pkg>@<version>, keeping the range style and the section
 *   3. tamper check: package.json changed in that one place only, and the new
 *      version is really what got installed
 *   4. cut the network, npm test, plus one free re-run if it fails
 *   5. still failing: the fix agent gets the failure (and the changelog's
 *      breaking changes) and tries to make the tests pass
 *   6. package.json, the lockfile and the agent's fixes are written into the
 *      clone on the host. If the agent did not succeed, only the version bump is
 *      kept, and its attempt is saved as a diff for the reviewer.
 *
 * Every package starts from the same clean state, so one bad upgrade can never
 * leak into the next. Nothing here commits or pushes: that is the PR step's job.
 */

/** The parts of a Sandbox an upgrade uses. */
export type UpgradeSandbox = Pick<
  Sandbox,
  | 'copyIn'
  | 'exec'
  | 'disconnectNetwork'
  | 'destroy'
  | 'readFile'
  | 'writeFile'
  | 'listFiles'
  | 'search'
>;

export type UpgradeStatus =
  /** The tests passed with the new version, no changes needed. */
  | 'passed'
  /** The tests failed, and the fix agent made them pass. */
  | 'fixed'
  /** The tests fail and the agent could not fix them; the PR gets this label. */
  | 'needs-human-review'
  /** npm could not install the new version; skipped. */
  | 'install-failed'
  /** package.json or the lockfile changed in ways the upgrade does not explain; skipped. */
  | 'tampered';

export interface UpgradeResult {
  candidate: UpgradeCandidate;
  status: UpgradeStatus;
  /** What package.json says after the upgrade, e.g. "^5.3.0"; null when nothing was installed. */
  newRange: string | null;
  /** Why the upgrade was skipped or needs review, in words; null when it passed or was fixed. */
  reason: string | null;
  /** Files written into the clone, ready to commit: package.json, the lockfile and the agent's fixes. */
  files: string[];
  /** The test files among `files`, which a reviewer must check were not weakened. */
  testFiles: string[];
  /** The failure digest right after the upgrade, before any fix; null when the tests passed. */
  failureDigest: string | null;
  /** True when the tests failed once and passed on the free re-run. */
  flaky: boolean;
  fix: FixResult | null;
  /** The agent's changes when they are left out of the commit (needs-human-review), cut to a size a PR can show. */
  attemptedDiff: string | null;
  warnings: string[];
  timings: { installMs: number; testMs: number };
}

export interface UpgradeOptions {
  limits: Pick<Config['sandbox'], 'installTimeoutSec' | 'testTimeoutSec' | 'memoryMb'>;
  fixAgent: Config['fixAgent'];
  createSandbox: () => Promise<UpgradeSandbox>;
  router: Pick<LlmRouter, 'callLLM' | 'getStats'>;
  /** The changelog reader's answer, for majors; null when there is none. */
  analysis?: UpgradeAnalysis | null;
  onProgress?: (message: string) => void;
  onAgentEvent?: (event: AgentEvent) => void;
}

/** Most diff lines shown for a failed fix attempt (PLAN.md §8). */
export const MAX_ATTEMPTED_DIFF_LINES = 150;

export async function upgradePackage(
  repoDir: string,
  candidate: UpgradeCandidate,
  options: UpgradeOptions,
): Promise<UpgradeResult> {
  const { limits, onProgress = () => {} } = options;
  const { name, to, dependencyType } = candidate;
  const lockfile = existsSync(join(repoDir, 'npm-shrinkwrap.json'))
    ? 'npm-shrinkwrap.json'
    : 'package-lock.json';

  const result: UpgradeResult = {
    candidate,
    status: 'passed',
    newRange: null,
    reason: null,
    files: [],
    testFiles: [],
    failureDigest: null,
    flaky: false,
    fix: null,
    attemptedDiff: null,
    warnings: [],
    timings: { installMs: 0, testMs: 0 },
  };
  const skip = (status: 'install-failed' | 'tampered', reason: string): UpgradeResult => ({
    ...result,
    status,
    reason,
  });

  let manifest: string;
  let lock: string;
  const sandbox = await options.createSandbox();
  try {
    onProgress('copying the project into a fresh container');
    await sandbox.copyIn(repoDir);
    onProgress('npm ci: the project as it is today');
    const ci = await sandbox.exec(['npm', 'ci'], { timeoutSec: limits.installTimeoutSec });
    if (ci.outcome !== 'ok') {
      return skip('install-failed', `npm ci failed before the upgrade: ${npmProblem(ci, limits)}`);
    }

    // 2. The upgrade itself.
    const before = await sandbox.readFile('package.json');
    const currentRange = rangeIn(before, name, dependencyType);
    if (currentRange === null) {
      return skip('install-failed', `package.json does not list ${name} in ${dependencyType}`);
    }
    const save = planSave(currentRange, to, dependencyType);
    if (save.note !== null) {
      result.warnings.push(save.note);
    }
    onProgress(`npm install ${name}@${to} (${dependencyType}, saved as ${save.newRange})`);
    const install = await sandbox.exec(['npm', 'install', `${name}@${to}`, ...save.flags], {
      timeoutSec: limits.installTimeoutSec,
    });
    result.timings.installMs = install.durationMs;
    if (install.outcome !== 'ok') {
      return skip('install-failed', npmProblem(install, limits));
    }

    // 3. Tamper check, and the version really installed.
    manifest = await sandbox.readFile('package.json');
    lock = await sandbox.readFile(lockfile);
    const problems = checkManifestChange(before, manifest, {
      name,
      type: dependencyType,
      newRange: save.newRange,
    });
    if (problems.length > 0) {
      return skip(
        'tampered',
        `npm install changed package.json beyond the upgrade, which an install script may have done: ${problems.join('; ')}`,
      );
    }
    result.newRange = save.newRange;
    const installed = await installedVersion(sandbox, name);
    if (installed !== to) {
      return skip(
        'install-failed',
        `npm installed ${name} ${installed ?? '(nothing)'} instead of ${to}`,
      );
    }

    // 4. Tests, offline, with one free re-run.
    onProgress('cutting the network before any test code runs');
    await sandbox.disconnectNetwork();
    const tests = await runTests(sandbox, limits.testTimeoutSec, onProgress);
    result.timings.testMs = tests.last.durationMs;
    result.flaky = tests.flaky;

    // 5. The fix agent, when the tests still fail.
    if (tests.last.outcome !== 'ok') {
      const digest = makeFailureDigest(tests.last.stdout, tests.last.stderr);
      result.failureDigest = digest;
      onProgress(`tests fail with ${name} ${to}; starting the fix agent`);
      result.fix = await runFixAgent(
        fixTask(candidate, options.analysis ?? null, digest, tests.last, options),
        {
          router: options.router,
          sandbox,
          limits: { ...options.fixAgent, testTimeoutSec: limits.testTimeoutSec },
          onEvent: options.onAgentEvent,
        },
      );
      result.status = result.fix.status === 'fixed' ? 'fixed' : 'needs-human-review';
      if (result.status === 'needs-human-review') {
        result.reason = describeFixFailure(result.fix);
      }
    }

    // Test code is untrusted and has run since the check above (twice, plus
    // every run_tests). It could have rewritten package.json or the lockfile on
    // disk, so they must still be exactly what npm wrote.
    const changed = [];
    if ((await sandbox.readFile('package.json')) !== manifest) {
      changed.push('package.json');
    }
    if ((await sandbox.readFile(lockfile)) !== lock) {
      changed.push(lockfile);
    }
    if (changed.length > 0) {
      return skip('tampered', `${changed.join(' and ')} changed while the tests ran`);
    }
  } finally {
    await sandbox.destroy().catch((error: unknown) => {
      result.warnings.push(`could not remove the container: ${errorMessage(error)}`);
    });
  }

  // 6. Into the clone. Everything is written from what we hold in memory, not
  // read back from the container, and through the same symlink-refusing writer
  // as any copy-out.
  await writeCopiedOutFile(repoDir, 'package.json', Buffer.from(manifest));
  await writeCopiedOutFile(repoDir, lockfile, Buffer.from(lock));
  result.files = ['package.json', lockfile];

  const agentFiles = result.fix?.changedFiles ?? [];
  for (const file of agentFiles) {
    await writeCopiedOutFile(repoDir, file.path, Buffer.from(file.content));
  }
  if (result.status === 'fixed') {
    result.files.push(...agentFiles.map((file) => file.path));
    result.testFiles = agentFiles.filter((file) => file.isTest).map((file) => file.path);
  } else if (agentFiles.length > 0) {
    // Only the version bump is kept. The attempt goes to the reviewer as a diff,
    // so they start from a known state instead of half-working edits.
    const paths = agentFiles.map((file) => file.path);
    result.attemptedDiff = capLines(await diffWorkspace(repoDir, paths), MAX_ATTEMPTED_DIFF_LINES);
    await restoreFiles(
      repoDir,
      agentFiles.map((file) => ({ path: file.path, isNew: file.original === null })),
    );
  }
  return result;
}

/** npm test, and once more if it fails: a re-run is free, an LLM call is not. */
async function runTests(
  sandbox: UpgradeSandbox,
  timeoutSec: number,
  onProgress: (message: string) => void,
): Promise<{ last: ExecResult; flaky: boolean }> {
  onProgress('npm test with the new version');
  const first = await sandbox.exec(['npm', 'test'], { timeoutSec });
  // A timeout or a memory kill would only happen again, minutes later.
  if (first.outcome !== 'failed') {
    return { last: first, flaky: false };
  }
  onProgress('npm test failed; running it once more in case a test is flaky');
  const second = await sandbox.exec(['npm', 'test'], { timeoutSec });
  return { last: second, flaky: second.outcome === 'ok' };
}

/** What the fix agent is told about this upgrade. */
function fixTask(
  candidate: UpgradeCandidate,
  analysis: UpgradeAnalysis | null,
  digest: string,
  lastRun: ExecResult,
  options: UpgradeOptions,
): FixTask {
  let note: string | null = null;
  if (candidate.bump !== 'major') {
    note = `none expected, since this is a ${candidate.bump} upgrade`;
  } else if (analysis === null) {
    note = 'not available (the release notes were not read)';
  } else if (analysis.breakingChanges.length === 0) {
    note = analysis.complete
      ? 'none are listed in the release notes'
      : 'unknown (the release notes could not be read)';
  }
  const timedOut =
    lastRun.outcome === 'timeout'
      ? `npm test did not finish within ${options.limits.testTimeoutSec} s and was stopped.\n`
      : lastRun.outcome === 'out-of-memory'
        ? `npm test was killed for using more than ${options.limits.memoryMb} MB of memory.\n`
        : '';
  return {
    packageName: candidate.name,
    fromVersion: candidate.from,
    toVersion: candidate.to,
    breakingChanges: (analysis?.breakingChanges ?? []).map(
      ({ title, details, affectedApis, migration }) => ({
        title,
        details,
        affectedApis,
        migration,
      }),
    ),
    breakingChangesNote: note,
    nodeEngine: analysis?.nodeEngine ?? null,
    failureDigest: `${timedOut}${digest}`,
    maxAttempts: options.fixAgent.maxAttempts,
  };
}

/** The version npm actually installed, from node_modules/<name>/package.json. */
async function installedVersion(sandbox: UpgradeSandbox, name: string): Promise<string | null> {
  try {
    const manifest: unknown = JSON.parse(
      await sandbox.readFile(`node_modules/${name}/package.json`),
    );
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' ? version : null;
  } catch {
    return null;
  }
}

/** One line on why the agent's attempt is not part of the commit. */
export function describeFixFailure(fix: FixResult): string {
  switch (fix.status) {
    case 'fixed':
      return 'fixed';
    case 'attempts-exhausted':
      return `the fix agent used all ${fix.attempts} test runs and the tests still fail`;
    case 'gave-up':
      return 'the fix agent stopped without a fix';
    case 'step-limit':
      return `the fix agent reached its step limit (${fix.steps} steps) without a fix`;
    case 'token-budget':
      return 'the fix agent used up its token budget without a fix';
    case 'llm-unavailable':
      return `no LLM was available to fix the code (${oneLine(fix.problem)})`;
    case 'sandbox-error':
      return `the sandbox stopped working during the fix (${oneLine(fix.problem)})`;
  }
}

function npmProblem(result: ExecResult, limits: UpgradeOptions['limits']): string {
  if (result.outcome === 'timeout') {
    return `npm did not finish within ${limits.installTimeoutSec} s (INSTALL_TIMEOUT_SEC in .env)`;
  }
  if (result.outcome === 'out-of-memory') {
    return `npm was killed for using more than ${limits.memoryMb} MB of memory (SANDBOX_MEMORY_MB in .env)`;
  }
  return describeInstallFailure(result.stderr);
}

/** The first `max` lines, and a note saying how many more there were. */
function capLines(text: string, max: number): string {
  const lines = text.replace(/\n$/, '').split('\n');
  if (lines.length <= max) {
    return lines.join('\n');
  }
  return [...lines.slice(0, max), `... ${lines.length - max} more lines not shown`].join('\n');
}

/** LlmUnavailableError lists one provider per line; a report line wants them on one. */
function oneLine(text: string | null): string {
  const joined = (text ?? 'no details')
    .trim()
    .replace(/:\s*\n\s*/, ': ')
    .replace(/\s*\n\s*/g, '; ');
  return joined.length > 300 ? `${joined.slice(0, 300)}...` : joined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const STATUS_LINE: Record<UpgradeStatus, string> = {
  passed: 'tests pass with the new version, no code changes needed',
  fixed: 'tests failed, and the fix agent made them pass',
  'needs-human-review': 'tests fail; only the version bump is kept, for a human to finish',
  'install-failed': 'skipped: npm could not install it',
  tampered: 'skipped as suspicious: files changed that the upgrade does not explain',
};

/** The upgrade as report lines. Pure, so the wording is unit tested; the CLI prints it. */
export function describeUpgrade(result: UpgradeResult): string[] {
  const { candidate, fix } = result;
  const saved = result.newRange === null ? '' : `, saved as ${result.newRange}`;
  const lines = [
    `Package:   ${candidate.name} ${candidate.from} → ${candidate.to} (${candidate.bump}, ${candidate.dependencyType}${saved})`,
    `Result:    ${result.status}: ${STATUS_LINE[result.status]}${result.flaky ? ' (passed on the re-run: flaky tests?)' : ''}`,
  ];
  if (result.reason !== null) {
    lines.push(`Why:       ${result.reason}`);
  }
  if (fix !== null) {
    const tokens = `${fix.llm.inputTokens.toLocaleString('en-US')} → ${fix.llm.outputTokens.toLocaleString('en-US')} tokens`;
    lines.push(
      `Agent:     ${fix.status}, ${fix.attempts} test run${fix.attempts === 1 ? '' : 's'}, ` +
        `${fix.steps} step${fix.steps === 1 ? '' : 's'}, ${fix.llm.calls} LLM call${fix.llm.calls === 1 ? '' : 's'}, ${tokens}`,
    );
  }
  if (result.files.length > 0) {
    lines.push(`Files:     ${result.files.join(', ')}`);
  }
  if (result.testFiles.length > 0) {
    lines.push(
      `Warning:   the agent changed test files; check nothing was weakened: ${result.testFiles.join(', ')}`,
    );
  }
  for (const warning of result.warnings) {
    lines.push(`Warning:   ${warning}`);
  }
  if (fix !== null && fix.changeSummaries.length > 0) {
    lines.push('', 'What the agent tried, one line per test run:');
    lines.push(...fix.changeSummaries.map((summary, index) => `  ${index + 1}. ${summary}`));
  }
  if (fix?.explanation) {
    lines.push('', 'The agent’s last words:', ...indent(fix.explanation));
  }
  if (result.status === 'needs-human-review') {
    const digest = fix?.lastFailureDigest ?? result.failureDigest;
    if (digest !== null && digest !== undefined) {
      lines.push('', 'How the tests fail now:', ...indent(digest));
    }
  }
  return lines;
}

function indent(text: string): string[] {
  return text.split('\n').map((line) => `  ${line}`);
}
