import { describe, expect, it } from 'vitest';
import { SandboxPathError } from '../sandbox/errors.js';
import { checkReadPath, checkWritePath, isTestFile } from './guard.js';

describe('checkReadPath', () => {
  it('accepts project files and cleans the path up', () => {
    expect(checkReadPath('./src\\app.js', 'express')).toBe('src/app.js');
    expect(checkReadPath('.', 'express')).toBe('.');
    expect(checkReadPath('package.json', 'express')).toBe('package.json');
  });

  it('lets the model read the upgraded package, and only that one', () => {
    expect(checkReadPath('node_modules/express/index.js', 'express')).toBe(
      'node_modules/express/index.js',
    );
    expect(checkReadPath('node_modules/express', 'express')).toBe('node_modules/express');
    expect(() => checkReadPath('node_modules/express-session/x.js', 'express')).toThrow(
      /only read node_modules\/express/,
    );
    expect(() => checkReadPath('node_modules', 'express')).toThrow(SandboxPathError);
    expect(() => checkReadPath('node_modules/lodash/index.js', 'express')).toThrow(
      SandboxPathError,
    );
  });

  it('handles scoped package names', () => {
    expect(checkReadPath('node_modules/@types/node/fs.d.ts', '@types/node')).toBe(
      'node_modules/@types/node/fs.d.ts',
    );
    expect(() => checkReadPath('node_modules/@types/express/index.d.ts', '@types/node')).toThrow(
      SandboxPathError,
    );
  });

  it('keeps the sandbox rules: nothing outside the project', () => {
    expect(() => checkReadPath('../../etc/passwd', 'express')).toThrow(SandboxPathError);
    expect(() => checkReadPath('/etc/passwd', 'express')).toThrow(SandboxPathError);
  });
});

describe('checkWritePath', () => {
  it('accepts source and test files', () => {
    expect(checkWritePath('src/app.js')).toBe('src/app.js');
    expect(checkWritePath('test/app.test.js')).toBe('test/app.test.js');
    // Only the root manifest is protected; a fixture's package.json is just a file.
    expect(checkWritePath('test/fixtures/pkg/package.json')).toBe('test/fixtures/pkg/package.json');
  });

  it('refuses the files that hold the upgrade', () => {
    for (const path of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc']) {
      expect(() => checkWritePath(path)).toThrow(/npm owns this file/);
    }
  });

  it('refuses case variants that would overwrite them on Windows or macOS', () => {
    expect(() => checkWritePath('PACKAGE.JSON')).toThrow(SandboxPathError);
    expect(() => checkWritePath('Package-Lock.json')).toThrow(SandboxPathError);
  });

  it('refuses node_modules, .git and .github at any depth where it matters', () => {
    expect(() => checkWritePath('node_modules/express/index.js')).toThrow(/node_modules/);
    expect(() => checkWritePath('packages/a/node_modules/x.js')).toThrow(/node_modules/);
    expect(() => checkWritePath('.git/hooks/pre-commit')).toThrow(/\.git/);
    expect(() => checkWritePath('.github/workflows/ci.yml')).toThrow(/CI workflows/);
  });

  it('refuses the project folder itself and paths outside it', () => {
    expect(() => checkWritePath('.')).toThrow(/needs a file path/);
    expect(() => checkWritePath('../outside.js')).toThrow(SandboxPathError);
  });
});

describe('isTestFile', () => {
  it('recognises test files by name and by folder', () => {
    expect(isTestFile('src/app.test.js')).toBe(true);
    expect(isTestFile('src/app.spec.ts')).toBe(true);
    expect(isTestFile('test/helpers.js')).toBe(true);
    expect(isTestFile('tests/unit/a.mjs')).toBe(true);
    expect(isTestFile('src/__tests__/a.js')).toBe(true);
  });

  it('leaves source files alone', () => {
    expect(isTestFile('src/app.js')).toBe(false);
    expect(isTestFile('src/testing.js')).toBe(false);
    expect(isTestFile('test')).toBe(false);
    expect(isTestFile('src/contest/a.js')).toBe(false);
  });
});
