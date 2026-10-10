import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createWorkspace,
  diffWorkspace,
  newRunId,
  parseTarget,
  removeWorkspace,
  restoreFiles,
  WorkspaceError,
} from './workspace.js';

/** Runs git in a throwaway repo, with an identity so commits work on any machine. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args],
    {
      cwd,
      encoding: 'utf8',
    },
  ).trim();
}

describe('parseTarget', () => {
  it('accepts GitHub https URLs, with or without .git', () => {
    for (const url of [
      'https://github.com/someone/demo-express-api',
      'https://github.com/someone/demo-express-api.git',
      'https://github.com/someone/demo-express-api/',
    ]) {
      expect(parseTarget(url)).toEqual({
        kind: 'github',
        owner: 'someone',
        repo: 'demo-express-api',
        url: 'https://github.com/someone/demo-express-api.git',
        label: 'github.com/someone/demo-express-api',
      });
    }
  });

  it('refuses every other kind of URL', () => {
    for (const url of [
      'http://github.com/someone/repo',
      'https://gitlab.com/someone/repo',
      'git@github.com:someone/repo.git',
      'https://github.com/someone/repo/tree/main',
      'ssh://git@github.com/someone/repo',
    ]) {
      expect(() => parseTarget(url), url).toThrow(WorkspaceError);
    }
  });

  it('refuses a git "ext::" URL, which would run a program', () => {
    expect(() => parseTarget('ext::sh -c touch% /tmp/pwned')).toThrow(/neither a GitHub URL/);
  });
});

describe('local workspaces', () => {
  let scratch: string;
  let source: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'upgrade-agent-ws-'));
    source = join(scratch, 'source');
    mkdirSync(join(source, 'scripts'), { recursive: true });
    writeFileSync(join(source, 'package.json'), '{"name":"demo"}\n');
    writeFileSync(join(source, 'scripts', 'test.sh'), '#!/bin/sh\necho ok\n');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'first commit');
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it('turns a local repo into a file:// target with a short label', () => {
    const target = parseTarget('source', scratch);

    expect(target).toMatchObject({ kind: 'local', path: source, label: 'source' });
    expect(target.url).toMatch(/^file:\/\/\/.*source$/);
  });

  it('refuses a folder that is not a git repository', () => {
    mkdirSync(join(scratch, 'plain'));

    expect(() => parseTarget('plain', scratch)).toThrow(/make a commit first/);
    expect(() => parseTarget('missing', scratch)).toThrow(/neither a GitHub URL/);
  });

  it('makes a shallow, byte-exact clone of the last commit', async () => {
    const workspace = await createWorkspace(parseTarget(source), {
      workspaceDir: join(scratch, 'ws'),
      runId: 'run-1',
    });

    expect(workspace.repoDir).toBe(join(scratch, 'ws', 'run-1', 'repo'));
    expect(readFileSync(join(workspace.repoDir, 'scripts', 'test.sh'), 'utf8')).toBe(
      '#!/bin/sh\necho ok\n',
    );
    expect(workspace.commit).toBe(git(source, 'rev-parse', 'HEAD'));
    expect(workspace.branch).toBe('main');
    expect(git(workspace.repoDir, 'config', 'core.autocrlf')).toBe('false');
    expect(git(workspace.repoDir, 'rev-parse', '--is-shallow-repository')).toBe('true');
    expect(workspace.warnings).toEqual([]);
  });

  it('warns that uncommitted changes are left out', async () => {
    writeFileSync(join(source, '.env'), 'GITHUB_TOKEN=secret\n');

    const workspace = await createWorkspace(parseTarget(source), {
      workspaceDir: join(scratch, 'ws'),
    });

    expect(existsSync(join(workspace.repoDir, '.env'))).toBe(false);
    expect(workspace.warnings[0]).toMatch(/has uncommitted changes; they are not part of this run/);
  });

  it('explains a repository with no commits, and cleans up after itself', async () => {
    const empty = join(scratch, 'empty');
    mkdirSync(empty);
    git(empty, 'init', '-q');

    await expect(
      createWorkspace(parseTarget(empty), { workspaceDir: join(scratch, 'ws'), runId: 'run-2' }),
    ).rejects.toThrow(/has no commits yet/);
    expect(existsSync(join(scratch, 'ws', 'run-2'))).toBe(false);
  });

  it('removes the whole run folder', async () => {
    const workspace = await createWorkspace(parseTarget(source), {
      workspaceDir: join(scratch, 'ws'),
    });

    await removeWorkspace(workspace);
    await removeWorkspace(workspace);

    expect(existsSync(workspace.root)).toBe(false);
  });
});

describe('newRunId', () => {
  it('is sortable by time and readable', () => {
    const id = newRunId(new Date('2026-10-10T14:32:05.123Z'));

    expect(id).toMatch(/^20261010-143205-[a-z0-9]{1,4}$/);
  });
});

describe('diffWorkspace and restoreFiles', () => {
  let repoDir: string;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-diff-'));
    git(repoDir, 'init', '-q', '-b', 'main');
    mkdirSync(join(repoDir, 'src'));
    writeFileSync(join(repoDir, 'src', 'app.js'), 'app.del(x);\n');
    writeFileSync(join(repoDir, 'README.md'), 'hello\n');
    git(repoDir, 'add', '-A');
    git(repoDir, 'commit', '-q', '-m', 'init');
  });

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('diffs changed and new files, and only the paths asked for', async () => {
    writeFileSync(join(repoDir, 'src', 'app.js'), 'app.delete(x);\n');
    writeFileSync(join(repoDir, 'src', 'routes.js'), 'module.exports = {};\n');
    writeFileSync(join(repoDir, 'README.md'), 'changed too\n');

    const diff = await diffWorkspace(repoDir, ['src/app.js', 'src/routes.js']);
    expect(diff).toContain('-app.del(x);\n+app.delete(x);');
    expect(diff).toContain('new file mode');
    expect(diff).toContain('+module.exports = {};');
    expect(diff).not.toContain('README');
    expect(await diffWorkspace(repoDir, [])).toBe('');
  });

  it('takes paths literally, not as git patterns', async () => {
    // As a pattern, "[ab].md" would also match a.md.
    writeFileSync(join(repoDir, '[ab].md'), 'odd name\n');
    writeFileSync(join(repoDir, 'a.md'), 'innocent\n');
    const diff = await diffWorkspace(repoDir, ['[ab].md']);
    expect(diff).toContain('+odd name');
    expect(diff).not.toContain('innocent');
  });

  it('includes a new file that .gitignore matches', async () => {
    writeFileSync(join(repoDir, '.gitignore'), 'generated/\n');
    mkdirSync(join(repoDir, 'generated'));
    writeFileSync(join(repoDir, 'generated', 'out.js'), 'made by the agent\n');

    const diff = await diffWorkspace(repoDir, ['generated/out.js']);
    expect(diff).toContain('+made by the agent');

    await restoreFiles(repoDir, [{ path: 'generated/out.js', isNew: true }]);
    expect(existsSync(join(repoDir, 'generated', 'out.js'))).toBe(false);
  });

  it('restores changed files and removes new ones', async () => {
    writeFileSync(join(repoDir, 'src', 'app.js'), 'app.delete(x);\n');
    writeFileSync(join(repoDir, 'src', 'routes.js'), 'new\n');
    await diffWorkspace(repoDir, ['src/app.js', 'src/routes.js']);

    await restoreFiles(repoDir, [
      { path: 'src/app.js', isNew: false },
      { path: 'src/routes.js', isNew: true },
    ]);
    expect(readFileSync(join(repoDir, 'src', 'app.js'), 'utf8')).toBe('app.del(x);\n');
    expect(existsSync(join(repoDir, 'src', 'routes.js'))).toBe(false);
    expect(git(repoDir, 'status', '--porcelain')).toBe('');
  });
});
