/**
 * Path rules for everything that crosses the sandbox boundary.
 *
 * The repo lives at one fixed place inside the container, and every path we are
 * given (by our own code, and later by the fix agent's LLM) is relative to it.
 * This module is the single place that turns such a path into a container path,
 * and it refuses anything that could point outside the project.
 *
 * It is plain string work with no Docker involved, so it is cheap to unit test.
 */

import { SandboxPathError } from './errors.js';

/** Where the target repo is copied inside the container. Owned by the `node` user. */
export const PROJECT_DIR = '/home/node/project';

/**
 * Turns a repo-relative path into an absolute path inside the container.
 *
 * Rejected: absolute paths, `..` segments, Windows drive letters, NUL bytes and
 * empty segments. Accepted and cleaned up: `./` prefixes, `.` (meaning the repo
 * root) and Windows backslashes, because `path.join()` on Windows produces them.
 *
 * `..` is rejected rather than resolved: resolving would let `a/../../etc/passwd`
 * quietly become a legal path, and we want the caller to hear about it instead.
 */
export function toContainerPath(relativePath: string): string {
  if (relativePath.includes('\0')) {
    throw new SandboxPathError('path contains a NUL byte');
  }

  // On Windows our own code builds paths with backslashes; Linux would read them
  // as part of the filename, so treat them as separators before validating.
  const path = relativePath.replaceAll('\\', '/').trim();
  if (path === '') {
    throw new SandboxPathError('path is empty');
  }
  if (path.startsWith('/')) {
    throw new SandboxPathError(`path must be relative to the repo root, got "${relativePath}"`);
  }
  if (/^[a-zA-Z]:/.test(path)) {
    throw new SandboxPathError(`path must be relative to the repo root, got "${relativePath}"`);
  }

  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '..') {
      throw new SandboxPathError(`path must stay inside the repo, got "${relativePath}"`);
    }
    if (segment === '.' || segment === '') {
      // "./src", "src/" and "src//index.js" all mean the same thing as "src".
      continue;
    }
    segments.push(segment);
  }

  if (segments.length === 0) {
    // The path was "." or "./": the repo root itself.
    return PROJECT_DIR;
  }
  return `${PROJECT_DIR}/${segments.join('/')}`;
}

/** The cleaned-up relative form of a path, e.g. `./src\index.js` -> `src/index.js`. */
export function toRelativePath(relativePath: string): string {
  const containerPath = toContainerPath(relativePath);
  return containerPath === PROJECT_DIR ? '.' : containerPath.slice(PROJECT_DIR.length + 1);
}
