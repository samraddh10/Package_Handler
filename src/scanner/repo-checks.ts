import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Can v1 handle this repo at all?
 *
 * These checks run on the host, on the fresh clone, before any container is
 * started. They only read files (package.json and the list of root files),
 * so they are cheap, and they turn "npm ci failed in a confusing way three
 * minutes later" into an immediate, specific reason.
 */

/** The parts of package.json the agent uses. Anything else in it is ignored. */
export interface Manifest {
  name: string | null;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
}

/** Which section of package.json a dependency is listed in. */
export type DependencyType =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies';

const dependencyMap = z.record(z.string(), z.string()).optional();

const manifestSchema = z.object({
  name: z.string().optional(),
  scripts: z.record(z.string(), z.string()).optional(),
  dependencies: dependencyMap,
  devDependencies: dependencyMap,
  optionalDependencies: dependencyMap,
  peerDependencies: dependencyMap,
  workspaces: z.unknown().optional(),
  packageManager: z.string().optional(),
});

/** Lockfiles of the other package managers. Any of these means "not an npm project". */
const FOREIGN_LOCKFILES: Readonly<Record<string, string>> = {
  'yarn.lock': 'Yarn',
  'pnpm-lock.yaml': 'pnpm',
  'bun.lock': 'Bun',
  'bun.lockb': 'Bun',
};

/** What `npm init` writes when there are no tests. */
const PLACEHOLDER_TEST = /no test specified/;

export type RepoCheck = { ok: true; manifest: Manifest } | { ok: false; problems: string[] };

/**
 * Checks a repo from its package.json text (undefined when the file is missing)
 * and the names of the files in its root folder. Pure, so every rule is a
 * one-line unit test. Reports every problem at once, not just the first.
 */
export function checkRepo(packageJsonText: string | undefined, rootFiles: string[]): RepoCheck {
  if (packageJsonText === undefined) {
    return { ok: false, problems: ['there is no package.json in the repo root'] };
  }
  let raw: unknown;
  try {
    // Some Windows editors start the file with a byte-order mark; npm accepts it, JSON.parse doesn't.
    raw = JSON.parse(packageJsonText.replace(/^﻿/, ''));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, problems: [`package.json is not valid JSON (${reason})`] };
  }
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      problems: [
        `package.json has an unexpected shape (${issue?.path.join('.')}: ${issue?.message})`,
      ],
    };
  }
  const pkg = parsed.data;
  const files = new Set(rootFiles);
  const problems: string[] = [];

  if (pkg.workspaces !== undefined) {
    problems.push('it uses npm workspaces (a monorepo), which v1 does not support');
  }
  if (pkg.packageManager !== undefined && !pkg.packageManager.startsWith('npm@')) {
    problems.push(
      `package.json says "packageManager": "${pkg.packageManager}"; v1 supports npm only`,
    );
  }
  for (const [file, manager] of Object.entries(FOREIGN_LOCKFILES)) {
    if (files.has(file)) {
      problems.push(`it has a ${file}, so it is managed with ${manager}; v1 supports npm only`);
    }
  }
  if (!files.has('package-lock.json') && !files.has('npm-shrinkwrap.json')) {
    problems.push(
      'there is no package-lock.json; v1 needs one so that installs are exact and repeatable ' +
        '(run npm install and commit the lockfile)',
    );
  }
  const testScript = pkg.scripts?.test;
  if (testScript === undefined || testScript.trim() === '') {
    problems.push('there is no test script; v1 needs a working `npm test` to judge an upgrade');
  } else if (PLACEHOLDER_TEST.test(testScript)) {
    problems.push('the test script is the "no test specified" placeholder from npm init');
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return {
    ok: true,
    manifest: {
      name: pkg.name ?? null,
      scripts: pkg.scripts ?? {},
      dependencies: pkg.dependencies ?? {},
      devDependencies: pkg.devDependencies ?? {},
      optionalDependencies: pkg.optionalDependencies ?? {},
      peerDependencies: pkg.peerDependencies ?? {},
    },
  };
}

/** Reads what checkRepo() needs from a folder on disk. */
export async function readRepoFacts(
  dir: string,
): Promise<{ packageJsonText: string | undefined; rootFiles: string[] }> {
  const rootFiles = await readdir(dir);
  const packageJsonText = rootFiles.includes('package.json')
    ? await readFile(join(dir, 'package.json'), 'utf8')
    : undefined;
  return { packageJsonText, rootFiles };
}

/**
 * Which section lists `name`. When a package is in more than one (a library
 * often has the same package in peerDependencies and devDependencies), the
 * section that actually gets installed wins.
 */
export function dependencyTypeOf(manifest: Manifest, name: string): DependencyType | null {
  const order: DependencyType[] = [
    'optionalDependencies',
    'dependencies',
    'devDependencies',
    'peerDependencies',
  ];
  return order.find((type) => name in manifest[type]) ?? null;
}
