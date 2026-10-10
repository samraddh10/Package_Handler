import { execFile } from 'node:child_process';
import type { Stats } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { pack as packDirectory } from 'tar-fs';
import { extract, pack } from 'tar-stream';
import { SandboxError, SandboxPathError } from './errors.js';
import { toRelativePath } from './paths.js';

/**
 * Moving files in and out of the container.
 *
 * Docker's only file API is "give me a tar stream" / "here is a tar stream"
 * (that is all `docker cp` does underneath), so this module is the translation
 * layer: a host folder becomes a tar stream going in, and a tar stream coming
 * out becomes a file on disk, but only after we check what is inside it.
 *
 * Two problems it has to solve:
 *  - **Ownership.** The container runs as the unprivileged `node` user, but tar
 *    entries carry the uid/gid they had on the host (0 on Windows). Without
 *    rewriting them, `npm ci` inside the container could not write to its own
 *    project folder.
 *  - **Trust.** Files coming out were produced by untrusted code, so a tar entry
 *    may be a symlink to `/etc/shadow`, or a path like `../../.git/hooks/pre-commit`.
 *    We accept regular files only, at the exact path we asked for, under a size cap,
 *    and the host write refuses to follow a symlink out of the destination folder.
 *
 * One wrinkle: tar-stream 3 is built on `streamx`, not `node:stream`. The two
 * behave the same way when piping (that is the whole point of streamx), but
 * TypeScript sees unrelated classes, so this file holds the few casts that say
 * "yes, this really is a stream" and nothing outside it has to care.
 */

const execFileAsync = promisify(execFile);

/** The uid/gid every entry we send in is rewritten to: the container's `node` user. */
export interface Ownership {
  uid: number;
  gid: number;
}

/**
 * Top-level folders never copied into the container. A nested `node_modules` is
 * copied: in a clone it can only be there because the repo committed it, e.g. as
 * a test fixture, and the tests may need it.
 */
const SKIPPED_DIRS = new Set([
  // Git history is useless inside the sandbox, and it is the biggest part of a clone.
  '.git',
  // Installed fresh by `npm ci` in the container; a host copy may hold Windows binaries.
  'node_modules',
]);

/** The most we will ever write back to the host from one file. */
export const MAX_COPY_OUT_BYTES = 5 * 1024 * 1024;

export interface PackRepoOptions {
  owner: Ownership;
  /** Repo-relative paths that must keep the executable bit, from readGitExecutableBits(). */
  executables?: ReadonlySet<string>;
}

/**
 * Turns a host folder into a tar stream for `putArchive`.
 *
 * Every entry is rewritten so the container's `node` user owns it, and modes are
 * forced to fixed values instead of whatever the host reported. Windows has no
 * real file modes, so without this the same repo would arrive with different
 * permissions depending on which machine ran the agent.
 */
export function packRepo(hostDir: string, options: PackRepoOptions): NodeJS.ReadableStream {
  const { owner, executables = new Set<string>() } = options;
  return packDirectory(hostDir, {
    // Called with the full host path of every child before it is walked into.
    ignore: (hostPath) => {
      const [firstSegment] = toPosixPath(relative(hostDir, hostPath)).split('/');
      return firstSegment !== undefined && SKIPPED_DIRS.has(firstSegment);
    },
    map: (header) => {
      header.name = toPosixPath(header.name);
      header.uid = owner.uid;
      header.gid = owner.gid;
      if (header.type === 'directory') {
        header.mode = 0o755;
      } else if (header.type === 'symlink') {
        header.mode = 0o777;
      } else {
        header.mode = executables.has(header.name) ? 0o755 : 0o644;
      }
      return header;
    },
  }) as unknown as NodeJS.ReadableStream;
}

/** A one-file tar stream, used to write a file into a running container. */
export function packSingleFile(
  name: string,
  content: string | Buffer,
  owner: Ownership,
  options: { executable?: boolean } = {},
): NodeJS.ReadableStream {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  const archive = pack();
  archive.entry(
    {
      name,
      size: body.byteLength,
      mode: options.executable ? 0o755 : 0o644,
      uid: owner.uid,
      gid: owner.gid,
      mtime: new Date(),
      type: 'file',
    },
    body,
  );
  archive.finalize();
  return archive as unknown as NodeJS.ReadableStream;
}

/**
 * Reads exactly one regular file out of a tar stream that came from the container.
 *
 * `expectedName` is the name we asked Docker for. Anything else (a second entry,
 * a directory, a symlink, a nested path, or more bytes than `maxBytes`) is
 * refused, because this is the moment untrusted data would reach the host
 * filesystem.
 */
export async function readSingleFileFromArchive(
  archive: Readable,
  expectedName: string,
  maxBytes: number = MAX_COPY_OUT_BYTES,
): Promise<Buffer> {
  const extractor = extract();
  // pipe() does not pass errors along. If Docker's connection broke halfway, the
  // extractor would wait forever for the rest of the archive; forwarding the
  // error makes the loop below throw instead.
  archive.on('error', (error) => extractor.destroy(error));
  archive.pipe(extractor as unknown as NodeJS.WritableStream);

  let contents: Buffer | undefined;
  try {
    for await (const entry of extractor) {
      const { name, type, size } = entry.header;
      if (contents !== undefined) {
        throw new SandboxPathError(
          `refusing to copy out "${expectedName}": the archive holds more than one entry`,
        );
      }
      if (type !== 'file') {
        throw new SandboxPathError(`refusing to copy out "${name}": it is a ${type}, not a file`);
      }
      if (name !== expectedName) {
        throw new SandboxPathError(
          `refusing to copy out "${name}": expected exactly "${expectedName}"`,
        );
      }
      if (size > maxBytes) {
        throw new SandboxPathError(
          `refusing to copy out "${name}": ${size} bytes is over the ${maxBytes} byte limit`,
        );
      }

      const chunks: Buffer[] = [];
      let bytesRead = 0;
      // A tar entry that is not in object mode always yields Buffers.
      for await (const chunk of entry as AsyncIterable<Buffer>) {
        // A tar parser stops at the size in the header, so this second count
        // should never be the one that fires. It stays as a cheap backstop in
        // case a future tar library is looser about it than this one.
        bytesRead += chunk.byteLength;
        if (bytesRead > maxBytes) {
          throw new SandboxPathError(
            `refusing to copy out "${name}": it sent more than the ${maxBytes} byte limit`,
          );
        }
        chunks.push(chunk);
      }
      contents = Buffer.concat(chunks);
    }
  } catch (error) {
    if (error instanceof SandboxError) {
      throw error;
    }
    // A broken connection or a truncated archive: the sandbox failed, not a rule.
    const reason = error instanceof Error ? error.message : String(error);
    throw new SandboxError(`could not read "${expectedName}" from the sandbox: ${reason}`, {
      cause: error,
    });
  } finally {
    archive.destroy();
    extractor.destroy();
  }

  if (contents === undefined) {
    throw new SandboxError(`the archive for "${expectedName}" was empty`);
  }
  return contents;
}

/**
 * Writes a file that came out of the container to `<destRoot>/<path>` on the host,
 * and returns where it went.
 *
 * `path` goes through the paths.ts rules like every other path, but text checks
 * alone are not enough here. The destination is normally a clone of the target
 * repo, and a repo can commit a symlink: with `lib -> ../../..` in the clone,
 * writing `lib/x.js` would follow the link and land outside the workspace. So
 * every folder on the way down from `destRoot`, and the file itself, must be a
 * real folder or file, never a symlink (or, on Windows, a junction). Folders that
 * do not exist yet are created by us, so they are real folders.
 */
export async function writeCopiedOutFile(
  destRoot: string,
  path: string,
  contents: Buffer,
): Promise<string> {
  const relativePath = toRelativePath(path);
  if (relativePath === '.') {
    throw new SandboxPathError('copy-out needs a file path, not the folder itself');
  }

  const root = resolve(destRoot);
  const segments = relativePath.split('/');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const stats = await lstatIfExists(current);
    if (stats === undefined) {
      // Nothing below a missing folder can exist either.
      break;
    }
    if (stats.isSymbolicLink()) {
      throw new SandboxPathError(
        `refusing to write "${relativePath}": "${toPosixPath(relative(root, current))}" is a symlink`,
      );
    }
  }

  const destination = join(root, ...segments);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, contents);
  return destination;
}

/** lstat() looks at a symlink itself instead of following it. Missing paths give undefined. */
async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }
}

/**
 * Repo-relative paths that git records as executable (mode 100755).
 *
 * Why this exists: Windows has no executable bit, so a clone made here loses it,
 * and a repo whose `npm test` runs `./scripts/test.sh` would then fail inside the
 * container for a reason that has nothing to do with the upgrade. Git keeps the
 * bit in its index, so we ask git and put it back while packing.
 *
 * Returns an empty set when the folder is not a git repo, which is the normal
 * case for a plain folder passed in by a test.
 */
export async function readGitExecutableBits(dir: string): Promise<ReadonlySet<string>> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', dir, 'ls-files', '--stage', '-z'], {
      maxBuffer: 32 * 1024 * 1024,
    });
    return parseGitLsFiles(stdout);
  } catch {
    return new Set<string>();
  }
}

/**
 * Parses `git ls-files --stage -z` output.
 *
 * Each record is `<mode> <sha> <stage>\t<path>`, and records are separated by NUL
 * bytes. We pass `-z` so paths with spaces or non-ASCII characters arrive
 * untouched; the default output would quote and escape them.
 */
export function parseGitLsFiles(stdout: string): ReadonlySet<string> {
  const executables = new Set<string>();
  for (const record of stdout.split('\0')) {
    const tab = record.indexOf('\t');
    if (tab !== -1 && record.startsWith('100755 ')) {
      executables.add(record.slice(tab + 1));
    }
  }
  return executables;
}

/** `src\index.js` -> `src/index.js`, and drops a leading `./`. Tar always uses forward slashes. */
function toPosixPath(hostPath: string): string {
  const posix = sep === '/' ? hostPath : hostPath.split(sep).join('/');
  return posix.startsWith('./') ? posix.slice(2) : posix;
}
