import { SandboxPathError } from '../sandbox/errors.js';
import { toRelativePath } from '../sandbox/paths.js';

/**
 * Where the fix agent may read and write.
 *
 * The sandbox already refuses paths that leave the project (`../`, absolute
 * paths; see sandbox/paths.ts). This file adds the agent's own rules on top,
 * because "inside the project" is not the same as "fine for an LLM to change":
 *
 * - package.json and the lockfile hold the upgrade itself. If the agent could
 *   edit them, its easiest "fix" would be to undo the upgrade.
 * - node_modules is installed code, rebuilt by every `npm ci`; an edit there
 *   would never reach the pull request. .git and .github (CI workflows that run
 *   with the repo's secrets) are never the agent's business.
 * - Reads may go into node_modules/<the upgraded package>, so the model can look
 *   at the new version's types, README and source, but not the other packages.
 *
 * Every refusal is a SandboxPathError, whose message is written for the model:
 * it says what was refused and what is allowed instead.
 */

/** Root files that only npm may change. Compared case-insensitively (see isForbiddenWrite). */
const PROTECTED_ROOT_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc'];

/** Folders whose contents the agent may never write, at any depth. */
const PROTECTED_FOLDERS = ['node_modules', '.git'];

/**
 * Checks a path the model wants to read (read_file, list_files, search_code)
 * and returns it cleaned up and repo-relative, e.g. `./src\app.js` → `src/app.js`.
 */
export function checkReadPath(path: string, upgradedPackage: string): string {
  const relative = toRelativePath(path);
  const segments = relative.split('/');
  if (segments[0] === 'node_modules') {
    const allowed = `node_modules/${upgradedPackage}`;
    if (relative !== allowed && !relative.startsWith(`${allowed}/`)) {
      throw new SandboxPathError(
        `"${relative}" is off limits: inside node_modules you may only read ${allowed}`,
      );
    }
  }
  return relative;
}

/** Checks a path the model wants to write (write_file) and returns it cleaned up. */
export function checkWritePath(path: string): string {
  const relative = toRelativePath(path);
  if (relative === '.') {
    throw new SandboxPathError('write_file needs a file path, not the project folder');
  }
  const reason = isForbiddenWrite(relative);
  if (reason !== null) {
    throw new SandboxPathError(`you may not write "${relative}": ${reason}`);
  }
  return relative;
}

/**
 * Why a write is refused, or null when it is allowed.
 *
 * Paths are compared in lower case. Linux treats `Package.json` as a different
 * file, but the changed files are later copied onto the host, and Windows and
 * macOS do not: `PACKAGE.JSON` would land on top of package.json there.
 */
function isForbiddenWrite(relative: string): string | null {
  const lower = relative.toLowerCase();
  const segments = lower.split('/');
  if (PROTECTED_ROOT_FILES.includes(lower)) {
    return 'npm owns this file, and the upgrade itself lives in it. Fix the code instead';
  }
  const folder = segments.find((segment) => PROTECTED_FOLDERS.includes(segment));
  if (folder !== undefined) {
    return `nothing inside ${folder}/ may be changed`;
  }
  if (segments[0] === '.github') {
    return 'CI workflows and repository settings are out of scope';
  }
  return null;
}

/**
 * Whether a path is a test file: `*.test.*`, `*.spec.*`, or anything under a
 * `test/`, `tests/` or `__tests__/` folder. The agent may edit tests (some
 * upgrades can only be fixed there), but every such edit is flagged for review.
 */
export function isTestFile(path: string): boolean {
  const segments = toRelativePath(path).toLowerCase().split('/');
  const name = segments.at(-1) ?? '';
  if (/\.(test|spec)\.[^/]+$/.test(name)) {
    return true;
  }
  return segments.slice(0, -1).some((segment) => ['test', 'tests', '__tests__'].includes(segment));
}
