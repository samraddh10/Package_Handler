import { existsSync, statSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type SimpleGit, simpleGit } from 'simple-git';

/**
 * Getting the target repo onto this machine: one fresh, shallow clone per run.
 *
 * `git clone` is safe to run on the host because it executes nothing from the
 * repo: hooks are never cloned, and installing or testing happens later, in the
 * sandbox. Two settings matter:
 *
 *  - `--depth 1`: only the latest commit, no history. The agent never needs
 *    history, and for a big repo this is the difference between megabytes and
 *    gigabytes.
 *  - `core.autocrlf=false`: files are checked out byte for byte. With git's
 *    Windows default, text files would get CRLF line endings, and a shell
 *    script with CRLF fails inside the Linux container ("bad interpreter").
 *
 * A local folder is cloned too, through a `file://` URL, instead of being copied.
 * That way only committed files take part: an uncommitted `.env` with real
 * secrets in it never reaches the sandbox, and a scan always describes a commit.
 */

export type RepoTarget =
  | { kind: 'github'; owner: string; repo: string; url: string; label: string }
  | { kind: 'local'; path: string; url: string; label: string };

/** Thrown when the target can't be understood or cloned. The message says what to do. */
export class WorkspaceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkspaceError';
  }
}

export interface Workspace {
  runId: string;
  /** `<workspaceDir>/<runId>`: the clone lives in `repo/`, and later the run's report next to it. */
  root: string;
  repoDir: string;
  target: RepoTarget;
  /** The commit that was cloned, so a report can say exactly what it describes. */
  commit: string;
  branch: string;
  /** Things worth telling the user that don't stop the run. */
  warnings: string[];
}

const GITHUB_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9][A-Za-z0-9-]*)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/**
 * Works out what the user pointed at: `https://github.com/<owner>/<repo>` (with
 * or without `.git`), or a folder that is a git repository.
 *
 * Only https GitHub URLs are accepted, on purpose. The input ends up in a git
 * command line, and git understands URLs that run programs (`ext::sh -c ...`),
 * so the safest parser accepts one narrow, known shape and nothing else.
 */
export function parseTarget(input: string, cwd: string = process.cwd()): RepoTarget {
  const trimmed = input.trim();
  const github = GITHUB_URL.exec(trimmed);
  if (github !== null) {
    const [, owner = '', repo = ''] = github;
    if (repo !== '.' && repo !== '..') {
      return {
        kind: 'github',
        owner,
        repo,
        url: `https://github.com/${owner}/${repo}.git`,
        label: `github.com/${owner}/${repo}`,
      };
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) || trimmed.startsWith('git@')) {
    throw new WorkspaceError(
      `"${trimmed}" is not a supported URL; use https://github.com/<owner>/<repo> or a local folder`,
    );
  }

  const path = resolve(cwd, trimmed);
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new WorkspaceError(`"${trimmed}" is neither a GitHub URL nor an existing folder`);
  }
  if (!existsSync(join(path, '.git'))) {
    throw new WorkspaceError(
      `"${trimmed}" is not the root of a git repository. Local folders are cloned so that ` +
        'only committed files are used: run git init and make a commit first',
    );
  }
  return {
    kind: 'local',
    path,
    url: pathToFileURL(path).href,
    label: relative(cwd, path) || '.',
  };
}

/** A sortable, readable id such as `20261010-143205-k3x9`. */
export function newRunId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `${stamp}-${suffix}`;
}

/** Clones the target into `<workspaceDir>/<runId>/repo`. */
export async function createWorkspace(
  target: RepoTarget,
  options: { workspaceDir: string; runId?: string },
): Promise<Workspace> {
  const runId = options.runId ?? newRunId();
  const root = resolve(options.workspaceDir, runId);
  const repoDir = join(root, 'repo');
  await mkdir(root, { recursive: true });

  try {
    await git().clone(target.url, repoDir, ['--depth', '1', '--config', 'core.autocrlf=false']);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw new WorkspaceError(`could not clone ${target.label}: ${gitReason(error)}`, {
      cause: error,
    });
  }

  const repo = git(repoDir);
  let commit: string;
  try {
    commit = (await repo.revparse(['HEAD'])).trim();
  } catch (error) {
    // Cloning an empty repository works but leaves nothing checked out.
    await rm(root, { recursive: true, force: true });
    throw new WorkspaceError(`${target.label} has no commits yet; commit something first`, {
      cause: error,
    });
  }
  const branch = (await repo.revparse(['--abbrev-ref', 'HEAD'])).trim();

  const warnings: string[] = [];
  if (target.kind === 'local' && !(await git(target.path).status()).isClean()) {
    warnings.push(
      `${target.label} has uncommitted changes; they are not part of this run (commit ${commit.slice(0, 7)} is)`,
    );
  }
  return { runId, root, repoDir, target, commit, branch, warnings };
}

/** Deletes the run's folder. Safe to call twice. */
export async function removeWorkspace(workspace: Workspace): Promise<void> {
  // maxRetries: on Windows, a virus scanner or an editor can hold a file for a moment.
  await rm(workspace.root, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * The clone's changes to `paths` as a unified diff against the cloned commit.
 *
 * New files are included: `git add --intent-to-add` records that a file is
 * coming without staging its content, which is enough for `git diff HEAD` to
 * show it as a new file. `--force` includes a file that .gitignore matches,
 * which git would otherwise refuse to add. Paths are taken literally
 * (`--literal-pathspecs`), so a file named like a git pattern, e.g. `[ab].md`,
 * is still just a file name.
 */
export async function diffWorkspace(repoDir: string, paths: string[]): Promise<string> {
  if (paths.length === 0) {
    return '';
  }
  const repo = git(repoDir);
  await repo.raw(['--literal-pathspecs', 'add', '--intent-to-add', '--force', '--', ...paths]);
  return repo.raw(['--literal-pathspecs', 'diff', 'HEAD', '--', ...paths]);
}

/**
 * Puts files back the way the cloned commit has them. Files the commit does
 * not have are deleted, and forgotten by git's index.
 */
export async function restoreFiles(
  repoDir: string,
  files: Array<{ path: string; isNew: boolean }>,
): Promise<void> {
  const repo = git(repoDir);
  const tracked = files.filter((file) => !file.isNew).map((file) => file.path);
  if (tracked.length > 0) {
    await repo.raw(['--literal-pathspecs', 'checkout', 'HEAD', '--', ...tracked]);
  }
  for (const file of files.filter((candidate) => candidate.isNew)) {
    await repo.raw([
      '--literal-pathspecs',
      'rm',
      '--cached',
      '--quiet',
      '--ignore-unmatch',
      '--',
      file.path,
    ]);
    await rm(join(repoDir, file.path), { force: true });
  }
}

/**
 * Environment variables that simple-git guards: everything starting with GIT_
 * (several of them make git run another program, e.g. GIT_ASKPASS or
 * GIT_SSH_COMMAND), plus the editor, pager and prompt settings. simple-git
 * refuses to start git when an environment passed to it explicitly contains one,
 * so they are left out of the copy below. None are needed to clone.
 */
const GUARDED_ENV = /^(GIT_.*|EDITOR|VISUAL|PAGER|PREFIX|SSH_ASKPASS)$/i;

/**
 * A simple-git instance that never waits for a human. Without these settings,
 * cloning a private or misspelled GitHub repo makes git ask for a username, in
 * the terminal or in a Git Credential Manager window, and the run hangs.
 * GIT_TERMINAL_PROMPT=0 is itself a guarded name, hence `allowEnvironment`.
 */
function git(baseDir?: string): SimpleGit {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !GUARDED_ENV.test(key)) {
      env[key] = value;
    }
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GCM_INTERACTIVE = 'never';
  return simpleGit({
    ...(baseDir === undefined ? {} : { baseDir }),
    allowEnvironment: ['GIT_TERMINAL_PROMPT'],
  }).env(env);
}

/** git's own explanation, without the "Cloning into ..." chatter around it. */
function gitReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const lines = message
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('Cloning into'));
  const fatal = lines.find((line) => line.startsWith('fatal:'));
  return (fatal ?? lines[0] ?? 'unknown git error').replace(/^fatal:\s*/, '');
}
