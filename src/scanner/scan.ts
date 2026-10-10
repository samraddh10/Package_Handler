import type { Config } from '../config.js';
import type { ExecResult, Sandbox } from '../sandbox/sandbox.js';
import { makeFailureDigest } from '../sandbox/test-output.js';
import { type Bump, classifyBump, compareUpgrades, isOutsideRange } from './classify.js';
import {
  type Advisory,
  type AuditReport,
  NpmOutputError,
  type OutdatedPackage,
  parseAudit,
  parseOutdated,
  SEVERITIES,
  type Severity,
  summarizeNpmError,
} from './parse.js';
import {
  checkRepo,
  type DependencyType,
  dependencyTypeOf,
  type Manifest,
  readRepoFacts,
} from './repo-checks.js';

/**
 * The scan: from a fresh clone to an ordered list of upgrades.
 *
 *   1. repo checks, on the host (repo-checks.ts)
 *   2. in one sandbox: npm ci → npm outdated → npm audit → cut the network →
 *      npm test, with one free re-run if the tests fail
 *   3. classify each outdated package and put them in order (classify.ts)
 *
 * The baseline test run is the point of step 2. If the tests already fail
 * before anything is upgraded, a failure after an upgrade would prove nothing,
 * so the scan stops there with a digest of what failed.
 *
 * Nothing here talks to Docker directly: it is handed a function that creates a
 * sandbox, so unit tests can hand it a scripted fake instead.
 */

/** The parts of a Sandbox the scan uses. */
export type BaselineSandbox = Pick<Sandbox, 'copyIn' | 'exec' | 'disconnectNetwork' | 'destroy'>;

export interface ScanOptions {
  /** Timeouts, plus the memory limit for explaining a failure. */
  limits: Pick<Config['sandbox'], 'installTimeoutSec' | 'testTimeoutSec' | 'memoryMb'>;
  createSandbox: () => Promise<BaselineSandbox>;
  onProgress?: (message: string) => void;
}

/** Why a scan stopped. Each one maps to a row of the error-handling table in PLAN.md §12. */
export type ScanFailure =
  | 'unsupported-repo'
  | 'install-failed'
  | 'outdated-failed'
  | 'tests-failing';

export class ScanError extends Error {
  readonly reason: ScanFailure;
  /** More to show under the message: the list of repo problems, or a failure digest. */
  readonly details: string | null;

  constructor(reason: ScanFailure, message: string, details: string | null = null) {
    super(message);
    this.name = 'ScanError';
    this.reason = reason;
    this.details = details;
  }
}

export interface SecurityNote {
  severity: Severity;
  advisories: Advisory[];
  /** True when the version we upgrade to is outside npm audit's vulnerable range. */
  fixedByUpgrade: boolean;
}

export interface UpgradeCandidate {
  name: string;
  /** The installed version. */
  from: string;
  /** The registry's latest version: what the upgrade installs. */
  to: string;
  /** The newest version the current range allows, for reference. */
  wanted: string;
  bump: Bump;
  dependencyType: Exclude<DependencyType, 'peerDependencies'>;
  security: SecurityNote | null;
}

export interface SkippedPackage {
  name: string;
  reason: string;
}

export interface ScanResult {
  packageName: string | null;
  /** In the order they should be attempted. */
  upgrades: UpgradeCandidate[];
  skipped: SkippedPackage[];
  /** null when npm audit could not run; the reason is in `warnings`. */
  audit: AuditReport | null;
  baseline: { installMs: number; testMs: number; flaky: boolean };
  warnings: string[];
}

/** A registry query takes about a second; offline, `npm outdated` retries for about 70. */
const REGISTRY_TIMEOUT_SEC = 120;

/** npm's JSON is only useful whole, so it is captured whole, up to this many characters. */
const JSON_OUTPUT_CHARS = 16 * 1024 * 1024;

export async function scanWorkspace(repoDir: string, options: ScanOptions): Promise<ScanResult> {
  const { limits, onProgress = () => {} } = options;

  const facts = await readRepoFacts(repoDir);
  const check = checkRepo(facts.packageJsonText, facts.rootFiles);
  if (!check.ok) {
    throw new ScanError(
      'unsupported-repo',
      'this repo is not one v1 can upgrade',
      check.problems.map((problem) => `- ${problem}`).join('\n'),
    );
  }

  const warnings: string[] = [];
  const sandbox = await options.createSandbox();
  let install: ExecResult;
  let outdated: OutdatedPackage[];
  let audit: AuditReport | null;
  let tests: { testMs: number; flaky: boolean };
  try {
    onProgress('copying the repo into a fresh container');
    await sandbox.copyIn(repoDir);

    onProgress('npm ci: installing the exact versions in the lockfile');
    install = await sandbox.exec(['npm', 'ci'], { timeoutSec: limits.installTimeoutSec });
    if (install.outcome !== 'ok') {
      throw installFailure(install, limits);
    }

    onProgress('npm outdated: asking the registry for newer versions');
    outdated = await readOutdated(sandbox);

    onProgress('npm audit: looking up known vulnerabilities');
    audit = await readAudit(sandbox, warnings);

    onProgress('cutting the network before any test code runs');
    await sandbox.disconnectNetwork();

    tests = await runBaselineTests(sandbox, limits, onProgress, warnings);
  } finally {
    // A container that won't go away is left for the next startup sweep; it
    // must not hide the error that got us here.
    await sandbox.destroy().catch((error: unknown) => {
      warnings.push(`could not remove the scan container: ${errorMessage(error)}`);
    });
  }

  const plan = planUpgrades(check.manifest, outdated, audit);
  return {
    packageName: check.manifest.name,
    upgrades: plan.upgrades,
    skipped: plan.skipped,
    audit,
    baseline: { installMs: install.durationMs, ...tests },
    warnings: [...warnings, ...plan.warnings],
  };
}

/**
 * Turns npm's lists into upgrades. Pure, so every skip rule is unit tested.
 *
 * Only direct dependencies are considered (npm outdated lists nothing else), and
 * the target is always the `latest` tag: `wanted` is what `npm update` would do
 * already, and the agent exists for the jumps that need more than that.
 */
export function planUpgrades(
  manifest: Manifest,
  outdated: OutdatedPackage[],
  audit: AuditReport | null,
): { upgrades: UpgradeCandidate[]; skipped: SkippedPackage[]; warnings: string[] } {
  const upgrades: UpgradeCandidate[] = [];
  const skipped: SkippedPackage[] = [];

  for (const pkg of outdated) {
    const { name } = pkg;
    const type = dependencyTypeOf(manifest, name);
    if (type === null) {
      skipped.push({ name, reason: 'not listed in package.json' });
      continue;
    }
    if (type === 'peerDependencies') {
      skipped.push({
        name,
        reason:
          'only a peer dependency: its range is a promise to the people who use this package, ' +
          'so changing it is a human decision',
      });
      continue;
    }
    if (pkg.current === null) {
      skipped.push({
        name,
        reason: 'not installed (an optional dependency for another platform?)',
      });
      continue;
    }
    const bump = classifyBump(pkg.current, pkg.latest);
    if (bump === null) {
      skipped.push({
        name,
        reason: `npm reports ${pkg.current} → ${pkg.latest}, which is not a semver upgrade`,
      });
      continue;
    }
    upgrades.push({
      name,
      from: pkg.current,
      to: pkg.latest,
      wanted: pkg.wanted,
      bump,
      dependencyType: type,
      security: securityNote(audit, name, pkg.latest),
    });
  }
  upgrades.sort(compareUpgrades);

  const warnings: string[] = [];
  for (const finding of audit?.findings ?? []) {
    const upgrade = upgrades.find((candidate) => candidate.name === finding.name);
    const count = plural(finding.advisories.length, 'advisory', 'advisories');
    if (upgrade === undefined) {
      warnings.push(
        `${finding.name} has ${count} (${finding.severity}) and no upgrade in this scan can fix it`,
      );
    } else if (upgrade.security?.fixedByUpgrade === false) {
      warnings.push(
        `${finding.name} ${upgrade.to} is still inside the vulnerable range ${finding.vulnerableRange}, ` +
          `so the upgrade will not fix its ${count}`,
      );
    }
  }
  return { upgrades, skipped, warnings };
}

function securityNote(audit: AuditReport | null, name: string, to: string): SecurityNote | null {
  const finding = audit?.findings.find((candidate) => candidate.name === name);
  if (finding === undefined) {
    return null;
  }
  return {
    severity: finding.severity,
    advisories: finding.advisories,
    fixedByUpgrade: isOutsideRange(to, finding.vulnerableRange),
  };
}

async function readOutdated(sandbox: BaselineSandbox): Promise<OutdatedPackage[]> {
  const result = await sandbox.exec(['npm', 'outdated', '--json'], {
    timeoutSec: REGISTRY_TIMEOUT_SEC,
    maxOutputChars: JSON_OUTPUT_CHARS,
  });
  try {
    return parseOutdated(jsonFrom('npm outdated', result));
  } catch (error) {
    throw new ScanError(
      'outdated-failed',
      `could not get the list of outdated packages: ${errorMessage(error)}`,
    );
  }
}

/** Audit data is useful but not essential, so a failure here is a warning, not a stop. */
async function readAudit(
  sandbox: BaselineSandbox,
  warnings: string[],
): Promise<AuditReport | null> {
  const result = await sandbox.exec(['npm', 'audit', '--json'], {
    timeoutSec: REGISTRY_TIMEOUT_SEC,
    maxOutputChars: JSON_OUTPUT_CHARS,
  });
  try {
    return parseAudit(jsonFrom('npm audit', result));
  } catch (error) {
    warnings.push(`no security information: ${errorMessage(error)}`);
    return null;
  }
}

/**
 * The JSON a command printed, if it can be trusted. The exit code is ignored on
 * purpose: npm outdated and npm audit both exit 1 when they find something.
 */
function jsonFrom(command: string, result: ExecResult): string {
  if (result.outcome === 'timeout' || result.outcome === 'out-of-memory') {
    throw new NpmOutputError(`${command} ended with ${result.outcome}`);
  }
  if (result.truncated) {
    throw new NpmOutputError(`${command} printed more than ${JSON_OUTPUT_CHARS} characters`);
  }
  // npm normally reports its own failures as JSON, but if it dies before it
  // gets that far, the only explanation is on stderr.
  if (result.stdout.trim() === '' && result.stderr.trim() !== '') {
    throw new NpmOutputError(
      `${command} printed no JSON: ${summarizeNpmError(result.stderr).message}`,
    );
  }
  return result.stdout;
}

/** Runs the tests once, and once more if they fail, to tell a broken suite from a flaky one. */
async function runBaselineTests(
  sandbox: BaselineSandbox,
  limits: ScanOptions['limits'],
  onProgress: (message: string) => void,
  warnings: string[],
): Promise<{ testMs: number; flaky: boolean }> {
  onProgress('npm test: the baseline run, before any upgrade');
  const first = await sandbox.exec(['npm', 'test'], { timeoutSec: limits.testTimeoutSec });
  if (first.outcome === 'ok') {
    return { testMs: first.durationMs, flaky: false };
  }
  // A timeout or a memory kill would only happen again, 5 minutes later.
  if (first.outcome !== 'failed') {
    throw testsFailure(first, limits);
  }

  onProgress('npm test failed; running it once more in case a test is flaky');
  const second = await sandbox.exec(['npm', 'test'], { timeoutSec: limits.testTimeoutSec });
  if (second.outcome === 'ok') {
    warnings.push(
      "npm test failed once and then passed: some tests look flaky, so a later failure is not always the upgrade's fault",
    );
    return { testMs: second.durationMs, flaky: true };
  }
  throw testsFailure(second, limits);
}

function installFailure(result: ExecResult, limits: ScanOptions['limits']): ScanError {
  if (result.outcome === 'failed') {
    const { code, message } = summarizeNpmError(result.stderr);
    return new ScanError('install-failed', `npm ci failed${code ? ` (${code})` : ''}: ${message}`);
  }
  return new ScanError(
    'install-failed',
    outcomeProblem(
      'npm ci',
      result,
      { seconds: limits.installTimeoutSec, setting: 'INSTALL_TIMEOUT_SEC' },
      limits.memoryMb,
    ),
  );
}

function testsFailure(result: ExecResult, limits: ScanOptions['limits']): ScanError {
  const digest = makeFailureDigest(result.stdout, result.stderr);
  if (result.outcome === 'failed') {
    return new ScanError(
      'tests-failing',
      `npm test already fails before any upgrade (exit code ${result.exitCode}, twice), so an ` +
        'upgrade could not be judged. Fix the tests first.',
      digest,
    );
  }
  return new ScanError(
    'tests-failing',
    outcomeProblem(
      'npm test',
      result,
      { seconds: limits.testTimeoutSec, setting: 'TEST_TIMEOUT_SEC' },
      limits.memoryMb,
    ),
    digest,
  );
}

/** Explains a timeout or a memory kill, and names the .env setting that controls it. */
function outcomeProblem(
  command: string,
  result: ExecResult,
  timeout: { seconds: number; setting: string },
  memoryMb: number,
): string {
  if (result.outcome === 'out-of-memory') {
    return `${command} was killed for using more than ${memoryMb} MB of memory (SANDBOX_MEMORY_MB in .env)`;
  }
  // Near its memory limit a process can thrash (slow to a crawl) instead of
  // being killed, so a timeout can be a memory problem in disguise.
  return (
    `${command} did not finish within ${timeout.seconds}s (${timeout.setting} in .env). It may ` +
    'be waiting on something that never ends, such as a watch mode or an open server, or be ' +
    `short of memory: close to the ${memoryMb} MB limit a process can slow to a crawl instead of being killed.`
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

const TYPE_LABEL: Record<UpgradeCandidate['dependencyType'], string> = {
  dependencies: 'prod',
  devDependencies: 'dev',
  optionalDependencies: 'optional',
};

/** The scan as report lines. Pure, so the wording is unit tested; the CLI prints it. */
export function describeScan(result: ScanResult): string[] {
  const { baseline, audit } = result;
  const lines = [
    `Baseline:  npm ci ${seconds(baseline.installMs)}, npm test passed in ${seconds(baseline.testMs)}` +
      (baseline.flaky ? ' (on the second try)' : ''),
    `Audit:     ${describeAudit(audit)}`,
    '',
  ];

  if (result.upgrades.length === 0) {
    lines.push('Nothing to upgrade: every direct dependency is on its latest version.');
  } else {
    lines.push(
      `${plural(result.upgrades.length, 'upgrade', 'upgrades')}, in the order they would run:`,
      ...table([
        ['#', 'package', 'from', 'to', 'bump', 'type', 'security'],
        ...result.upgrades.map((upgrade, index) => [
          String(index + 1),
          upgrade.name,
          upgrade.from,
          upgrade.to,
          upgrade.bump,
          TYPE_LABEL[upgrade.dependencyType],
          describeSecurity(upgrade.security),
        ]),
      ]).map((row) => `  ${row}`),
    );
  }

  if (result.skipped.length > 0) {
    lines.push('', 'Skipped:', ...result.skipped.map((skip) => `  - ${skip.name}: ${skip.reason}`));
  }
  if (result.warnings.length > 0) {
    lines.push('', 'Warnings:', ...result.warnings.map((warning) => `  - ${warning}`));
  }
  return lines;
}

function describeAudit(audit: AuditReport | null): string {
  if (audit === null) {
    return 'not available (see the warnings below)';
  }
  if (audit.counts.total === 0) {
    return 'no known vulnerabilities';
  }
  const bySeverity = [...SEVERITIES]
    .reverse()
    .filter((severity) => audit.counts[severity] > 0)
    .map((severity) => `${audit.counts[severity]} ${severity}`);
  return `${plural(audit.counts.total, 'vulnerable package', 'vulnerable packages')} in the tree (${bySeverity.join(', ')})`;
}

function describeSecurity(security: SecurityNote | null): string {
  if (security === null) {
    return '-';
  }
  const count = plural(security.advisories.length, 'advisory', 'advisories');
  return `${security.severity}, ${count}, ${security.fixedByUpgrade ? 'fixed by this upgrade' : 'NOT fixed'}`;
}

/** Pads every column but the last to the width of its longest cell. */
function table(rows: string[][]): string[] {
  const widths = rows[0]?.map((_, column) =>
    Math.max(...rows.map((row) => (row[column] ?? '').length)),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1 ? cell : cell.padEnd(widths?.[column] ?? 0),
      )
      .join('  '),
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
