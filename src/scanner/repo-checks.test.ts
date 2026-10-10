import { describe, expect, it } from 'vitest';
import { checkRepo, dependencyTypeOf, type RepoCheck } from './repo-checks.js';

const goodPackage = {
  name: 'demo',
  scripts: { test: 'mocha' },
  dependencies: { express: '^4.21.2' },
  devDependencies: { mocha: '^12.0.3' },
};

function check(pkg: object | string | undefined, files = ['package.json', 'package-lock.json']) {
  const text = pkg === undefined || typeof pkg === 'string' ? pkg : JSON.stringify(pkg);
  return checkRepo(text, files);
}

function problemsOf(result: RepoCheck): string[] {
  return result.ok ? [] : result.problems;
}

describe('checkRepo', () => {
  it('accepts an npm project with a lockfile and a test script', () => {
    const result = check(goodPackage);

    expect(result.ok).toBe(true);
    expect(result.ok && result.manifest.dependencies).toEqual({ express: '^4.21.2' });
  });

  it('accepts a package.json that starts with a byte-order mark, as npm does', () => {
    expect(check(`﻿${JSON.stringify(goodPackage)}`).ok).toBe(true);
  });

  it('accepts npm-shrinkwrap.json as the lockfile', () => {
    expect(check(goodPackage, ['package.json', 'npm-shrinkwrap.json']).ok).toBe(true);
  });

  it('needs a package.json that parses', () => {
    expect(problemsOf(check(undefined))).toEqual(['there is no package.json in the repo root']);
    expect(problemsOf(check('{ "name": '))[0]).toMatch(/^package.json is not valid JSON/);
    expect(problemsOf(check({ dependencies: ['express'] }))[0]).toMatch(/unexpected shape/);
  });

  it('refuses other package managers, by lockfile or by packageManager', () => {
    const files = ['package.json', 'package-lock.json', 'yarn.lock'];
    expect(problemsOf(check(goodPackage, files))).toEqual([
      'it has a yarn.lock, so it is managed with Yarn; v1 supports npm only',
    ]);
    expect(problemsOf(check({ ...goodPackage, packageManager: 'pnpm@9.12.0' }))[0]).toMatch(
      /"packageManager": "pnpm@9.12.0"/,
    );
    expect(check({ ...goodPackage, packageManager: 'npm@10.9.2' }).ok).toBe(true);
  });

  it('refuses a monorepo', () => {
    expect(problemsOf(check({ ...goodPackage, workspaces: ['packages/*'] }))[0]).toMatch(
      /npm workspaces/,
    );
  });

  it('needs a lockfile', () => {
    expect(problemsOf(check(goodPackage, ['package.json']))[0]).toMatch(
      /^there is no package-lock.json/,
    );
  });

  it('needs a real test script', () => {
    expect(problemsOf(check({ ...goodPackage, scripts: {} }))[0]).toMatch(/no test script/);
    const placeholder = 'echo "Error: no test specified" && exit 1';
    expect(problemsOf(check({ ...goodPackage, scripts: { test: placeholder } }))[0]).toMatch(
      /placeholder/,
    );
  });

  it('reports every problem at once', () => {
    const result = check({ name: 'x', workspaces: ['a'] }, ['package.json', 'pnpm-lock.yaml']);

    expect(problemsOf(result)).toHaveLength(4);
  });
});

describe('dependencyTypeOf', () => {
  const result = check({
    ...goodPackage,
    peerDependencies: { react: '>=18', mocha: '*' },
    optionalDependencies: { fsevents: '^2.3.3' },
  });
  const manifest = result.ok ? result.manifest : null;

  it('names the section a dependency is listed in', () => {
    expect(manifest && dependencyTypeOf(manifest, 'express')).toBe('dependencies');
    expect(manifest && dependencyTypeOf(manifest, 'fsevents')).toBe('optionalDependencies');
    expect(manifest && dependencyTypeOf(manifest, 'react')).toBe('peerDependencies');
    expect(manifest && dependencyTypeOf(manifest, 'left-pad')).toBeNull();
  });

  it('prefers the installed section over peerDependencies', () => {
    expect(manifest && dependencyTypeOf(manifest, 'mocha')).toBe('devDependencies');
  });
});
