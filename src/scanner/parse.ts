import { z } from 'zod';

/**
 * Turns what npm prints into typed objects.
 *
 * npm's JSON output is an interface we don't control, so every shape is checked
 * with zod on the way in: if a future npm renames a field, the scan stops with
 * "npm audit printed JSON in a shape this version does not understand" instead
 * of quietly reporting zero vulnerabilities. The functions are pure (a string in,
 * objects out), and the tests feed them output captured from real npm runs.
 */

/** Thrown when npm's output is missing, is not JSON, or is npm reporting its own failure. */
export class NpmOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NpmOutputError';
  }
}

// ---------------------------------------------------------------------------
// npm outdated --json
// ---------------------------------------------------------------------------

/** A direct dependency that has a newer version on the registry. */
export interface OutdatedPackage {
  name: string;
  /** The installed version, or null when npm says it is not installed at all. */
  current: string | null;
  /** The newest version that the range in package.json allows. */
  wanted: string;
  /** The version the registry's `latest` tag points to. This is what we upgrade to. */
  latest: string;
}

const outdatedEntry = z.object({
  current: z.string().optional(),
  wanted: z.string(),
  latest: z.string(),
});

// With workspaces a package can have several entries, one per dependent.
const outdatedSchema = z.record(
  z.string(),
  z.union([outdatedEntry, z.array(outdatedEntry).min(1)]),
);

/**
 * Parses `npm outdated --json`: `{ "<name>": { current, wanted, latest, ... } }`.
 *
 * Note that npm exits with code 1 whenever something is outdated, so the exit
 * code says nothing about success; only the JSON does.
 */
export function parseOutdated(stdout: string): OutdatedPackage[] {
  const parsed = outdatedSchema.safeParse(parseNpmJson('npm outdated', stdout));
  if (!parsed.success) {
    throw unexpectedShape('npm outdated', parsed.error);
  }
  return Object.entries(parsed.data).flatMap(([name, value]) => {
    // Several entries only differ in which workspace depends on the package.
    const [entry] = Array.isArray(value) ? value : [value];
    if (entry === undefined) {
      return [];
    }
    return [{ name, current: entry.current ?? null, wanted: entry.wanted, latest: entry.latest }];
  });
}

// ---------------------------------------------------------------------------
// npm audit --json
// ---------------------------------------------------------------------------

export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** One published security advisory, e.g. GHSA-35jh-r3h4-6jhm. */
export interface Advisory {
  /** The GitHub advisory id when there is one, else npm's numeric id. */
  id: string;
  title: string;
  url: string;
  severity: Severity;
  /** The package the advisory is about, which may be deep in the tree. */
  package: string;
}

/** What the audit says about one direct dependency. */
export interface AuditFinding {
  name: string;
  /** The worst severity of anything reachable through this dependency. */
  severity: Severity;
  /**
   * The versions of this package that bring in a vulnerability, as a semver
   * range. If the version we upgrade to is outside it, the upgrade fixes it.
   */
  vulnerableRange: string;
  /** Every advisory reachable through this dependency, without duplicates. */
  advisories: Advisory[];
}

export interface AuditReport {
  /** Direct dependencies only, because those are the ones we can upgrade. */
  findings: AuditFinding[];
  /** How many vulnerable packages there are at each severity, across the whole tree. */
  counts: Record<Severity, number> & { total: number };
}

const severitySchema = z.enum(SEVERITIES);

const advisorySchema = z.object({
  source: z.number(),
  name: z.string(),
  title: z.string(),
  url: z.string(),
  severity: severitySchema,
});

const vulnerabilitySchema = z.object({
  name: z.string(),
  severity: severitySchema,
  isDirect: z.boolean(),
  // An object is an advisory about this package; a string names another
  // vulnerable package that this one depends on.
  via: z.array(z.union([z.string(), advisorySchema])),
  range: z.string(),
});

const auditSchema = z.object({
  auditReportVersion: z.literal(2),
  vulnerabilities: z.record(z.string(), vulnerabilitySchema),
  metadata: z.object({
    vulnerabilities: z.object({
      info: z.number(),
      low: z.number(),
      moderate: z.number(),
      high: z.number(),
      critical: z.number(),
      total: z.number(),
    }),
  }),
});

/**
 * Parses `npm audit --json` (report version 2, npm 7 and later).
 *
 * The report lists every vulnerable package in the tree, direct or not. A
 * direct dependency that is only vulnerable through one of its own dependencies
 * names that package in `via` instead of carrying the advisory itself, e.g.
 * express → `"via": ["body-parser", "qs"]`. So for each direct dependency we
 * follow those names down the report and collect every advisory on the way.
 */
export function parseAudit(stdout: string): AuditReport {
  const parsed = auditSchema.safeParse(parseNpmJson('npm audit', stdout));
  if (!parsed.success) {
    throw unexpectedShape('npm audit', parsed.error);
  }
  const { vulnerabilities, metadata } = parsed.data;

  const findings: AuditFinding[] = [];
  for (const entry of Object.values(vulnerabilities)) {
    if (!entry.isDirect) {
      continue;
    }
    findings.push({
      name: entry.name,
      severity: entry.severity,
      vulnerableRange: entry.range,
      advisories: collectAdvisories(entry.name, vulnerabilities),
    });
  }
  return { findings, counts: metadata.vulnerabilities };
}

type Vulnerabilities = Record<string, z.infer<typeof vulnerabilitySchema>>;

/** Walks `via` from one package, depth first, with a visited set because the graph can loop. */
function collectAdvisories(start: string, vulnerabilities: Vulnerabilities): Advisory[] {
  const advisories = new Map<string, Advisory>();
  const visited = new Set<string>();
  const stack = [start];
  for (let name = stack.pop(); name !== undefined; name = stack.pop()) {
    if (visited.has(name)) {
      continue;
    }
    visited.add(name);
    for (const via of vulnerabilities[name]?.via ?? []) {
      if (typeof via === 'string') {
        stack.push(via);
        continue;
      }
      const id = /\/advisories\/(GHSA-[\w-]+)/.exec(via.url)?.[1] ?? `npm-${via.source}`;
      advisories.set(id, {
        id,
        title: via.title,
        url: via.url,
        severity: via.severity,
        package: via.name,
      });
    }
  }
  return [...advisories.values()].sort(
    (a, b) => SEVERITIES.indexOf(b.severity) - SEVERITIES.indexOf(a.severity),
  );
}

// ---------------------------------------------------------------------------
// npm's own errors
// ---------------------------------------------------------------------------

/** npm's error code and the lines that explain it, from a failed command's stderr. */
export interface NpmErrorSummary {
  /** e.g. EUSAGE, ERESOLVE, E404, or null when npm printed none. */
  code: string | null;
  message: string;
}

/**
 * Pulls the useful part out of npm's error output.
 *
 * npm prefixes every line with `npm error` (npm 9 and older: `npm ERR!`) and
 * pads the explanation with usage text and a log-file path. We keep the code and
 * the first few explanatory lines, e.g. for a lockfile that doesn't match
 * package.json: code EUSAGE, "`npm ci` can only install packages when your
 * package.json and package-lock.json ... are in sync ... Missing: left-pad@1.3.0
 * from lock file".
 */
export function summarizeNpmError(stderr: string): NpmErrorSummary {
  let code: string | null = null;
  const message: string[] = [];
  for (const raw of stderr.split('\n')) {
    const match = /^npm (?:error|ERR!) ?(.*)$/.exec(raw.trimEnd());
    if (match === null) {
      continue;
    }
    const line = (match[1] ?? '').trim();
    const codeMatch = /^code (\S+)$/.exec(line);
    if (codeMatch !== null) {
      code ??= codeMatch[1] ?? null;
      continue;
    }
    if (/^Usage:|^A complete log of this run/.test(line)) {
      break;
    }
    if (line === '' || /^(errno|syscall|path|command|cwd|signal) /.test(line)) {
      continue;
    }
    if (message.length < 3) {
      message.push(line);
    }
  }
  return {
    code,
    message: message.length > 0 ? message.join(' ') : 'npm gave no explanation',
  };
}

// ---------------------------------------------------------------------------

/**
 * Parses npm's JSON and turns npm's own error report into an exception.
 *
 * When npm itself fails (no network, registry down) it still prints JSON, but
 * of a different shape: `{ "error": { "code", "summary", "detail" } }`, or, as
 * captured from an offline `npm audit`, `{ "message": "...", "error": {...} }`.
 */
function parseNpmJson(command: string, stdout: string): unknown {
  const text = stdout.trim();
  if (text === '') {
    throw new NpmOutputError(`${command} printed nothing`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new NpmOutputError(
      `${command} printed something that is not JSON: ${text.slice(0, 200)}`,
    );
  }

  if (typeof value === 'object' && value !== null && 'error' in value) {
    const { error, message } = value as { error: unknown; message?: unknown };
    // A real package can be called "error"; npm's own error object has no `latest`.
    if (typeof error === 'object' && error !== null && !('latest' in error)) {
      const { summary, code } = error as { summary?: unknown; code?: unknown };
      const reason = [message, summary, code].find(
        (part): part is string => typeof part === 'string' && part.trim() !== '',
      );
      throw new NpmOutputError(`${command} failed: ${reason ?? 'npm gave no reason'}`);
    }
  }
  return value;
}

function unexpectedShape(command: string, error: z.ZodError): NpmOutputError {
  const first = error.issues[0];
  const where = first?.path.join('.') || 'the top level';
  return new NpmOutputError(
    `${command} printed JSON in a shape this version does not understand (${where}: ${first?.message})`,
  );
}
