import { describe, expect, it } from 'vitest';
import { SandboxPathError } from './errors.js';
import { PROJECT_DIR, toContainerPath, toRelativePath } from './paths.js';

describe('toContainerPath', () => {
  it('puts repo-relative paths under the project folder', () => {
    expect(toContainerPath('package.json')).toBe(`${PROJECT_DIR}/package.json`);
    expect(toContainerPath('src/index.js')).toBe(`${PROJECT_DIR}/src/index.js`);
  });

  it('treats "." as the repo root', () => {
    expect(toContainerPath('.')).toBe(PROJECT_DIR);
    expect(toContainerPath('./')).toBe(PROJECT_DIR);
  });

  it('cleans up the ways the same path can be written', () => {
    // Windows separators arrive from path.join(); the rest come from an LLM or a user.
    expect(toContainerPath('src\\lib\\index.js')).toBe(`${PROJECT_DIR}/src/lib/index.js`);
    expect(toContainerPath('./src/index.js')).toBe(`${PROJECT_DIR}/src/index.js`);
    expect(toContainerPath('src//index.js')).toBe(`${PROJECT_DIR}/src/index.js`);
    expect(toContainerPath('  src/index.js  ')).toBe(`${PROJECT_DIR}/src/index.js`);
    expect(toContainerPath('src/')).toBe(`${PROJECT_DIR}/src`);
  });

  it('refuses paths that could point outside the repo', () => {
    const rejected = [
      '',
      '   ',
      '/etc/passwd',
      '/',
      'C:\\Windows\\System32',
      '..',
      '../secrets.txt',
      'src/../../etc/passwd',
      '..\\..\\secrets.txt',
      'src/\0/etc/passwd',
    ];
    for (const path of rejected) {
      expect(() => toContainerPath(path), path).toThrow(SandboxPathError);
    }
  });

  it('does not quietly resolve ".." away', () => {
    // "a/../b" is a legal filesystem path, but accepting it would mean accepting
    // "a/../../b" too, so the rule is simpler: no ".." segments at all.
    expect(() => toContainerPath('a/../b')).toThrow(/stay inside the repo/);
  });
});

describe('toRelativePath', () => {
  it('gives back the cleaned-up relative path', () => {
    expect(toRelativePath('./src\\index.js')).toBe('src/index.js');
    expect(toRelativePath('package.json')).toBe('package.json');
    expect(toRelativePath('.')).toBe('.');
  });

  it('applies the same rules as toContainerPath', () => {
    expect(() => toRelativePath('../x')).toThrow(SandboxPathError);
  });
});
