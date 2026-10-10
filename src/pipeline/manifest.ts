import { isDeepStrictEqual } from 'node:util';
import semver from 'semver';
import { summarizeNpmError } from '../scanner/parse.js';
import type { DependencyType } from '../scanner/repo-checks.js';

/**
 * The package.json side of an upgrade: how to ask npm for it, and how to
 * check that npm did exactly that and nothing else.
 *
 * All pure functions, so each rule is a unit test.
 */

/** How `npm install` should save the new version. */
export interface SavePlan {
  /** Extra arguments for `npm install <name>@<version>`. */
  flags: string[];
  /** What package.json should say afterwards, e.g. "^5.3.0". */
  newRange: string;
  /** Set when the project's range style could not be kept, to say so in the report. */
  note: string | null;
}

const SAVE_FLAG: Record<Exclude<DependencyType, 'peerDependencies'>, string> = {
  dependencies: '--save-prod',
  devDependencies: '--save-dev',
  optionalDependencies: '--save-optional',
};

/**
 * Keeps the project's style for this dependency: `^1.2.3` stays a caret range,
 * `~1.2.3` a tilde range, and an exact `1.2.3` stays exact. Every setting is
 * passed explicitly, because the repo's own .npmrc could say `save-exact=true`
 * or a different prefix, and npm would quietly follow it. The section flag
 * keeps a devDependency a devDependency.
 */
export function planSave(
  currentRange: string,
  version: string,
  type: Exclude<DependencyType, 'peerDependencies'>,
): SavePlan {
  const range = currentRange.trim();
  const section = SAVE_FLAG[type];
  if (semver.valid(range) !== null) {
    return { flags: [section, '--save-exact'], newRange: version, note: null };
  }
  const prefix = range.startsWith('~') ? '~' : '^';
  const note =
    range.startsWith('^') || range.startsWith('~')
      ? null
      : `the range "${range}" is not ^, ~ or exact, so it becomes ^${version}`;
  return {
    flags: [section, '--save-exact=false', `--save-prefix=${prefix}`],
    newRange: `${prefix}${version}`,
    note,
  };
}

/** The range package.json gives `name` in `type`, or null when it is not there. */
export function rangeIn(
  packageJsonText: string,
  name: string,
  type: DependencyType,
): string | null {
  const manifest = parseObject(packageJsonText);
  const section = manifest?.[type];
  if (typeof section !== 'object' || section === null) {
    return null;
  }
  const range = (section as Record<string, unknown>)[name];
  return typeof range === 'string' ? range : null;
}

/**
 * The tamper check: did `npm install` change package.json in exactly one place?
 *
 * The new version's install scripts ran during that install, and a hostile
 * package could add a `postinstall` script or a new dependency to the project,
 * hoping it slips into the pull request. So the file after the install must
 * equal the file before it, with only this one dependency's range changed to
 * the expected value. Key order and formatting are ignored: npm sorts the
 * dependency lists when it saves.
 *
 * Returns the problems found; an empty list means the change is clean.
 */
export function checkManifestChange(
  beforeText: string,
  afterText: string,
  change: { name: string; type: DependencyType; newRange: string },
): string[] {
  const before = parseObject(beforeText);
  const after = parseObject(afterText);
  if (before === null || after === null) {
    return ['package.json is no longer a JSON object'];
  }

  const problems: string[] = [];
  const written = rangeIn(afterText, change.name, change.type);
  if (written !== change.newRange) {
    problems.push(
      `${change.type}.${change.name} is ${written === null ? 'missing' : `"${written}"`}, expected "${change.newRange}"`,
    );
  }

  // What package.json should be: the old file with only that one range changed.
  const expected = structuredClone(before);
  const section = { ...((expected[change.type] as Record<string, unknown> | undefined) ?? {}) };
  section[change.name] = change.newRange;
  expected[change.type] = section;
  for (const key of differingKeys(expected, after)) {
    // That key's problem, if any, is already reported above.
    if (key !== `${change.type}.${change.name}`) {
      problems.push(`${key} changed`);
    }
  }
  return problems;
}

/** Top-level keys, or `section.key` inside objects, whose values differ. */
function differingKeys(a: Record<string, unknown>, b: Record<string, unknown>): string[] {
  const keys: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const left = a[key];
    const right = b[key];
    if (isDeepStrictEqual(left, right)) {
      continue;
    }
    if (isPlainObject(left) && isPlainObject(right)) {
      for (const inner of new Set([...Object.keys(left), ...Object.keys(right)])) {
        if (!isDeepStrictEqual(left[inner], right[inner])) {
          keys.push(`${key}.${inner}`);
        }
      }
    } else {
      keys.push(key);
    }
  }
  return keys;
}

/**
 * Why `npm install <pkg>@<version>` failed, in one line.
 *
 * ERESOLVE (a peer dependency conflict) gets its own wording, because the fix
 * is not in the code: the package needs a partner upgraded at the same time,
 * e.g. react-dom 18 needs react 18. npm's report names both sides:
 *   Found: react@17.0.2
 *   Could not resolve dependency:
 *   peer react@"^18.3.1" from react-dom@18.3.1
 */
export function describeInstallFailure(stderr: string): string {
  const { code, message } = summarizeNpmError(stderr);
  if (code === 'ERESOLVE') {
    const found = /Found: (\S+)@(\S+)/.exec(stderr);
    const peer = /peer (\S+)@"([^"]+)" from (\S+)/.exec(stderr);
    if (found !== null && peer !== null) {
      const [, foundName, foundVersion] = found;
      const [, peerName, peerRange, requiredBy] = peer;
      return (
        `needs a coordinated upgrade: ${requiredBy} needs ${peerName}@${peerRange}, but the ` +
        `project has ${foundName}@${foundVersion}. Upgrade them together (npm ERESOLVE)`
      );
    }
  }
  return `npm install failed${code === null ? '' : ` (${code})`}: ${message}`;
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    // A byte-order mark is legal for npm but not for JSON.parse (see repo-checks.ts).
    const value: unknown = JSON.parse(text.replace(/^﻿/, ''));
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
