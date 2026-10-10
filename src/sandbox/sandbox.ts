import { posix } from 'node:path';
import type { Duplex, Readable } from 'node:stream';
import Docker from 'dockerode';
import { SandboxError, SandboxPathError, SandboxRequestError } from './errors.js';
import { CappedOutput } from './output.js';
import { PROJECT_DIR, toContainerPath, toRelativePath } from './paths.js';
import {
  MAX_COPY_OUT_BYTES,
  type Ownership,
  packRepo,
  packSingleFile,
  readGitExecutableBits,
  readSingleFileFromArchive,
  writeCopiedOutFile,
} from './tar.js';

/**
 * The Docker sandbox: one throwaway container that holds one copy of a target repo.
 *
 * Why it exists: this agent runs `npm ci`, `npm install` and `npm test` on code
 * it did not write. An npm install script or a test file can do anything the
 * process can do, so none of it may run on the host. A container gives us a
 * cheap, disposable machine where that code can misbehave without consequence,
 * and where we can take the network away before tests run.
 *
 * The container is created, used for one package upgrade, and destroyed. It is
 * kept alive by `sleep infinity` so that many commands can run inside the same
 * filesystem state; every command goes through `exec()`.
 *
 * What the container is NOT given: the GitHub token, the LLM keys, any host
 * folder. The only thing mounted is a named volume holding npm's download cache,
 * which makes the second and later installs much faster. So the worst a hostile
 * package can do is waste 5 minutes of CPU inside a box with no network and
 * nothing worth stealing.
 */

/** Every container and volume we create carries this label, so a crash can be cleaned up. */
export const CONTAINER_LABEL = 'upgrade-agent';

/** Records which process created a container, so the sweep can tell leftovers from live runs. */
export const OWNER_PID_LABEL = `${CONTAINER_LABEL}.pid`;

/** Shared npm cache, so `npm ci` does not re-download the registry for every package. */
export const NPM_CACHE_VOLUME = 'upgrade-agent-npm-cache';
const NPM_CACHE_DIR = '/home/node/.npm';

/** The user inside the image that owns the project and runs every command. */
const CONTAINER_USER = 'node';

/** That user's home folder. It exists in the image and already belongs to `node`. */
const HOME_DIR = '/home/node';

/**
 * Hard caps on the container. A runaway test suite then hits a wall instead of
 * taking the whole machine down with it.
 */
const PIDS_LIMIT = 512;

/** How long after the in-container timeout the host gives up and kills the container. */
const WATCHDOG_GRACE_SEC = 30;

export interface CreateSandboxOptions {
  image: string;
  cpus: number;
  memoryMb: number;
  /** Shared by callers that already have a client; a new one talks to the local daemon. */
  docker?: Docker;
  /** Added to the container name, e.g. a package name, to make `docker ps` readable. */
  name?: string;
  /** Set to false to skip the shared npm cache volume (tests that want full isolation). */
  useNpmCache?: boolean;
  /** Called with image pull progress lines, so the CLI can show something. */
  onProgress?: (message: string) => void;
}

export interface ExecOptions {
  /** Killed inside the container after this many seconds. Required: every command gets a limit. */
  timeoutSec: number;
  /** Folder to run in, relative to the repo root. Defaults to the repo root. */
  cwd?: string;
  env?: Record<string, string>;
  /**
   * Keep up to this many characters of stdout and of stderr from the start,
   * instead of the usual first 20k + last 40k. For machine-readable output such
   * as JSON, where a copy with the middle cut out is useless. Anything longer is
   * still dropped and `truncated` is set, so the caller can refuse to parse it.
   */
  maxOutputChars?: number;
}

/**
 * How a command ended.
 * - `ok`: exit code 0.
 * - `failed`: it ran and exited non-zero (a failing `npm test` lands here).
 * - `timeout`: it was killed for taking too long.
 * - `out-of-memory`: the kernel killed it for exceeding the memory limit.
 */
export type ExecOutcome = 'ok' | 'failed' | 'timeout' | 'out-of-memory';

export interface ExecResult {
  command: string[];
  outcome: ExecOutcome;
  /** null when the container died before we could read the exit code. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  /** True when output was so long that the middle was dropped. */
  truncated: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export class Sandbox {
  private readonly docker: Docker;
  private readonly container: Docker.Container;
  /** The uid/gid of the container's `node` user, read from the container at startup. */
  private owner: Ownership = { uid: 1000, gid: 1000 };
  private removed = false;

  private constructor(docker: Docker, container: Docker.Container) {
    this.docker = docker;
    this.container = container;
  }

  /** The container id, handy for logs and for the cleanup sweep. */
  get containerId(): string {
    return this.container.id;
  }

  /**
   * Pulls the image if needed, then creates and starts a locked-down container.
   *
   * The container's only process is `sleep infinity`, which keeps it alive for
   * later `exec` calls. The project folder is created afterwards by prepare().
   */
  static async create(options: CreateSandboxOptions): Promise<Sandbox> {
    const { image, cpus, memoryMb, name, useNpmCache = true, onProgress } = options;
    const docker = options.docker ?? new Docker();

    await ensureImage(docker, image, onProgress);
    if (useNpmCache) {
      await ensureNpmCacheVolume(docker, image);
    }

    const memoryBytes = memoryMb * 1024 * 1024;
    let container: Docker.Container;
    try {
      container = await docker.createContainer({
        name: containerName(name),
        Image: image,
        User: CONTAINER_USER,
        // Must be a folder that already exists and belongs to `node`; see prepare().
        WorkingDir: HOME_DIR,
        Entrypoint: ['sleep'],
        Cmd: ['infinity'],
        Env: [
          // Test runners check CI to stay out of interactive watch mode, which
          // would otherwise hang every `npm test` until the timeout.
          'CI=true',
          'NO_COLOR=1',
          `HOME=${HOME_DIR}`,
          `NPM_CONFIG_CACHE=${NPM_CACHE_DIR}`,
          // Noise we would only have to strip out of the logs again.
          'NPM_CONFIG_FUND=false',
          'NPM_CONFIG_AUDIT=false',
          'NPM_CONFIG_UPDATE_NOTIFIER=false',
          'NPM_CONFIG_PROGRESS=false',
        ],
        Labels: {
          [CONTAINER_LABEL]: '1',
          [`${CONTAINER_LABEL}.created`]: new Date().toISOString(),
          [OWNER_PID_LABEL]: String(process.pid),
        },
        HostConfig: {
          // Memory == MemorySwap means no swap: the limit is a real limit.
          Memory: memoryBytes,
          MemorySwap: memoryBytes,
          NanoCpus: Math.round(cpus * 1e9),
          PidsLimit: PIDS_LIMIT,
          // Least privilege: drop every Linux capability, and forbid gaining more
          // through a setuid binary.
          CapDrop: ['ALL'],
          SecurityOpt: ['no-new-privileges'],
          Privileged: false,
          Mounts: useNpmCache
            ? [{ Type: 'volume', Source: NPM_CACHE_VOLUME, Target: NPM_CACHE_DIR }]
            : [],
        },
      });
    } catch (error) {
      throw new SandboxError(`could not create a container from "${image}": ${describe(error)}`, {
        cause: error,
      });
    }

    const sandbox = new Sandbox(docker, container);
    try {
      await container.start();
      await sandbox.prepare();
      return sandbox;
    } catch (error) {
      // Never leave a container behind because startup failed half way.
      await sandbox.destroy().catch(() => {});
      throw error instanceof SandboxError
        ? error
        : new SandboxError(`could not start the sandbox container: ${describe(error)}`, {
            cause: error,
          });
    }
  }

  /**
   * Creates the project folder as `node`, and asks which uid/gid `node` has.
   *
   * The folder must be made by `node` itself. If Docker made it (by naming it as
   * the container's WorkingDir), it would belong to root, and every `npm ci` would
   * fail with EACCES in its own project folder. It must also exist before any
   * other command runs, because an exec whose working folder is missing fails
   * outright. Doing it here, in the first exec, rather than in the container's
   * start command avoids a race: `start()` returns as soon as the main process is
   * launched, not when a start command has finished.
   *
   * The uid/gid are asked for instead of hardcoded as 1000:1000, so a custom image
   * with a different `node` user still ends up with files it can write.
   */
  private async prepare(): Promise<void> {
    const result = await this.run(['/bin/sh', '-c', `mkdir -p ${PROJECT_DIR} && id -u && id -g`], {
      timeoutSec: 15,
      workingDir: HOME_DIR,
    });
    const [uidText, gidText] = result.stdout.trim().split('\n');
    const uid = Number(uidText);
    const gid = Number(gidText);
    if (result.outcome !== 'ok' || !Number.isInteger(uid) || !Number.isInteger(gid)) {
      throw new SandboxError(
        `could not set up the project folder: ${firstLine(result.stderr || result.stdout)}`,
      );
    }
    this.owner = { uid, gid };
  }

  /**
   * Copies a host folder into the repo root inside the container.
   *
   * `.git` and `node_modules` are skipped, ownership is rewritten to the `node`
   * user, and executable bits recorded by git are restored (see tar.ts).
   */
  async copyIn(hostDir: string): Promise<void> {
    const executables = await readGitExecutableBits(hostDir);
    const archive = packRepo(hostDir, { owner: this.owner, executables });
    try {
      await this.container.putArchive(archive, { path: PROJECT_DIR });
    } catch (error) {
      throw new SandboxError(`could not copy "${hostDir}" into the sandbox: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Runs one command in the container and waits for it to finish.
   *
   * Timeouts are enforced twice. Inside the container, `timeout -s KILL n` kills
   * the process group, which is what stops a hung `npm test`. On the host, a
   * watchdog kills the whole container n + 30s later, which covers the case where
   * the container itself stops responding. Belt and braces, because a stuck
   * command would otherwise stall the entire run.
   *
   * A non-zero exit code is a result, not an exception: `npm test` failing is the
   * normal case this whole project is built around. A SandboxError means the
   * sandbox itself broke, e.g. the container is gone.
   */
  async exec(command: string[], options: ExecOptions): Promise<ExecResult> {
    const { cwd, ...rest } = options;
    return this.run(command, {
      ...rest,
      workingDir: cwd === undefined ? PROJECT_DIR : toContainerPath(cwd),
    });
  }

  /** exec() with an absolute working folder, so prepare() can run outside the project. */
  private async run(
    command: string[],
    options: Omit<ExecOptions, 'cwd'> & { workingDir: string },
  ): Promise<ExecResult> {
    const { timeoutSec, workingDir, env, maxOutputChars } = options;
    if (command.length === 0) {
      throw new SandboxError('exec() needs a command');
    }
    // `timeout 0` means "no limit at all", so a 0 here would silently switch off
    // the one guarantee this method makes.
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      throw new SandboxError(`exec() needs a timeout above 0 seconds, got ${timeoutSec}`);
    }
    if (this.removed) {
      throw new SandboxError('this sandbox has been destroyed');
    }

    const wrapped = ['timeout', '-s', 'KILL', String(timeoutSec), ...command];
    const capture = maxOutputChars === undefined ? {} : { headChars: maxOutputChars, tailChars: 0 };
    const stdout = new CappedOutput(capture);
    const stderr = new CappedOutput(capture);
    const startedAt = Date.now();
    let watchdogFired = false;

    let exec: Docker.Exec;
    let stream: Duplex;
    try {
      exec = await this.container.exec({
        Cmd: wrapped,
        WorkingDir: workingDir,
        Env:
          env === undefined
            ? undefined
            : Object.entries(env).map(([key, value]) => `${key}=${value}`),
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        Tty: false,
      });
      stream = await exec.start({ hijack: true, stdin: false });
    } catch (error) {
      // Usually the container is no longer running, e.g. the watchdog killed it.
      throw new SandboxError(`could not start "${command.join(' ')}": ${describe(error)}`, {
        cause: error,
      });
    }
    // Without a TTY, Docker sends stdout and stderr down one connection with a
    // small header on each chunk saying which is which. demuxStream splits them.
    this.docker.modem.demuxStream(stream, stdout.sink(), stderr.sink());

    const watchdog = setTimeout(
      () => {
        watchdogFired = true;
        // The container is beyond saving at this point; the caller destroys it.
        this.container.kill().catch(() => {});
      },
      (timeoutSec + WATCHDOG_GRACE_SEC) * 1000,
    );

    try {
      await new Promise<void>((resolveStream, rejectStream) => {
        stream.on('end', resolveStream);
        stream.on('close', resolveStream);
        stream.on('error', rejectStream);
      });
    } catch (error) {
      throw new SandboxError(`lost the output of "${command.join(' ')}": ${describe(error)}`, {
        cause: error,
      });
    } finally {
      clearTimeout(watchdog);
    }

    const durationMs = Date.now() - startedAt;
    let exitCode: number | null = null;
    try {
      exitCode = (await exec.inspect()).ExitCode ?? null;
    } catch {
      // Killed containers cannot be inspected; outcome is decided below.
    }

    return {
      command: wrapped,
      outcome: await classifyExit({ exitCode, durationMs, timeoutSec, watchdogFired }, () =>
        this.wasOomKilled(),
      ),
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  /**
   * Reads a text file from the repo, exactly as it is on disk. A file that does
   * not exist is a SandboxRequestError.
   *
   * The file comes out through Docker's archive API, like copyOut(), and not
   * through `cat`: command output is capped and cleaned of terminal codes (see
   * output.ts), which would silently cut the middle out of a big file such as
   * package-lock.json. The copyOut() checks apply too: a regular file only (no
   * symlinks), up to 5 MB.
   */
  async readFile(path: string): Promise<string> {
    return (await this.fetchFile(path)).toString('utf8');
  }

  /**
   * Writes a text file into the repo, creating parent folders as needed.
   *
   * It goes in as a one-file tar rather than `sh -c "echo ... > file"`, because
   * file contents written by an LLM will contain quotes, backticks and newlines
   * that no amount of shell escaping makes safe.
   */
  async writeFile(path: string, content: string): Promise<void> {
    const relativePath = toRelativePath(path);
    if (relativePath === '.') {
      throw new SandboxPathError('writeFile needs a file path, not the repo root');
    }

    const parent = posix.dirname(relativePath);
    if (parent !== '.') {
      const mkdirResult = await this.exec(['mkdir', '-p', '--', toContainerPath(parent)], {
        timeoutSec: 30,
      });
      if (mkdirResult.outcome === 'failed') {
        // Usually a file already sits where a folder is needed.
        throw new SandboxRequestError(
          `could not create the folder for "${path}": ${firstLine(mkdirResult.stderr)}`,
        );
      }
      if (mkdirResult.outcome !== 'ok') {
        throw new SandboxError(`could not create the folder for "${path}": ${mkdirResult.outcome}`);
      }
    }

    const archive = packSingleFile(relativePath, content, this.owner);
    try {
      await this.container.putArchive(archive, { path: PROJECT_DIR });
    } catch (error) {
      throw new SandboxError(`could not write "${path}": ${describe(error)}`, { cause: error });
    }
  }

  /**
   * Lists one folder of the repo. Folder names come back with a trailing slash.
   * A folder that does not exist is a SandboxRequestError.
   */
  async listFiles(path = '.', options: { limit?: number } = {}): Promise<string[]> {
    const result = await this.exec(['ls', '-A', '-p', '--', toContainerPath(path)], {
      timeoutSec: 30,
    });
    if (result.outcome === 'failed') {
      throw new SandboxRequestError(`could not list "${path}": ${firstLine(result.stderr)}`);
    }
    if (result.outcome !== 'ok') {
      throw new SandboxError(`could not list "${path}": ${result.outcome}`);
    }
    const entries = result.stdout.split('\n').filter((entry) => entry !== '');
    return entries.slice(0, options.limit ?? 200);
  }

  /**
   * Greps the repo, skipping `node_modules` and `.git`.
   *
   * The pattern is passed to grep as an argument, never through a shell, so a
   * pattern full of quotes and semicolons is just a pattern.
   *
   * `--with-filename` is not optional: when `path` names a single file, grep
   * leaves the file name out (`12:text` instead of `a.js:12:text`), and every
   * match would fail to parse below.
   */
  async search(
    pattern: string,
    options: { isRegex?: boolean; path?: string | null; limit?: number } = {},
  ): Promise<SearchMatch[]> {
    const target = toContainerPath(options.path ?? '.');
    const result = await this.exec(
      [
        'grep',
        '--recursive',
        '--with-filename',
        '--line-number',
        // Skip binaries: a match inside a .png is noise and can be megabytes long.
        '--binary-files=without-match',
        '--exclude-dir=node_modules',
        '--exclude-dir=.git',
        options.isRegex ? '-E' : '-F',
        '--',
        pattern,
        target,
      ],
      { timeoutSec: 60 },
    );
    // grep exits 1 when there are simply no matches, which is not an error, and
    // 2 when it could not do what was asked: a missing path, a broken regex.
    if (result.outcome === 'failed' && result.exitCode === 2) {
      throw new SandboxRequestError(`search failed: ${firstLine(result.stderr)}`);
    }
    if (result.outcome !== 'ok' && result.exitCode !== 1) {
      throw new SandboxError(`search failed: ${firstLine(result.stderr)}`);
    }

    const matches: SearchMatch[] = [];
    const limit = options.limit ?? 50;
    for (const line of result.stdout.split('\n')) {
      if (matches.length >= limit) {
        break;
      }
      if (line === '') {
        continue;
      }
      // Lines look like /home/node/project/src/a.js:12:const x = 1
      const parsed = /^(.+?):(\d+):(.*)$/.exec(line);
      const [, filePath, lineNumber, text] = parsed ?? [];
      if (filePath === undefined || lineNumber === undefined) {
        continue;
      }
      matches.push({
        path: filePath.startsWith(`${PROJECT_DIR}/`)
          ? filePath.slice(PROJECT_DIR.length + 1)
          : filePath,
        line: Number(lineNumber),
        text: text ?? '',
      });
    }
    return matches;
  }

  /**
   * Takes the network away from the container.
   *
   * Installs need the registry, so the container starts connected. Tests do not,
   * and test code is the untrusted part, so the network is cut before every test
   * run. It also makes results comparable: a test that quietly calls an API fails
   * the same way in the baseline and after the upgrade, instead of passing once.
   */
  async disconnectNetwork(): Promise<void> {
    try {
      const info = await this.container.inspect();
      for (const network of Object.keys(info.NetworkSettings?.Networks ?? {})) {
        await this.docker.getNetwork(network).disconnect({ Container: this.container.id });
      }
    } catch (error) {
      // Tests must never run with the network still on, so this has to stop the caller.
      throw new SandboxError(`could not cut the sandbox's network: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  /**
   * Copies named files out of the container onto the host.
   *
   * Only the exact paths asked for are fetched; tar.ts then refuses anything that
   * is not a plain file under the size cap, and refuses to write through a symlink
   * on the host side. Writing to the host is the one place where container content
   * can affect this machine, so it is the one place that double-checks everything.
   */
  async copyOut(paths: string[], destDir: string): Promise<string[]> {
    const written: string[] = [];
    for (const path of paths) {
      const contents = await this.fetchFile(path);
      written.push(await writeCopiedOutFile(destDir, path, contents));
    }
    return written;
  }

  /** Fetches one regular file out of the container as raw bytes, checked by tar.ts. */
  private async fetchFile(path: string): Promise<Buffer> {
    const relativePath = toRelativePath(path);
    if (relativePath === '.') {
      throw new SandboxPathError('needs a file path, not the repo root');
    }

    let archive: NodeJS.ReadableStream;
    try {
      archive = await this.container.getArchive({ path: toContainerPath(relativePath) });
    } catch (error) {
      if (isNotFound(error)) {
        throw new SandboxRequestError(`"${relativePath}" does not exist`);
      }
      throw new SandboxError(`could not fetch "${path}" from the sandbox: ${describe(error)}`, {
        cause: error,
      });
    }
    // Docker names the entry after the last path segment, e.g. `index.js` for `src/index.js`.
    return readSingleFileFromArchive(
      archive as Readable,
      posix.basename(relativePath),
      MAX_COPY_OUT_BYTES,
    );
  }

  /** Removes the container. Safe to call twice, and safe to call on a dead container. */
  async destroy(): Promise<void> {
    if (this.removed) {
      return;
    }
    this.removed = true;
    try {
      await this.container.remove({ force: true, v: true });
    } catch (error) {
      if (!isNotFound(error)) {
        throw new SandboxError(
          `could not remove container ${this.container.id}: ${describe(error)}`,
          {
            cause: error,
          },
        );
      }
    }
  }

  private async wasOomKilled(): Promise<boolean> {
    try {
      return (await this.container.inspect()).State?.OOMKilled === true;
    } catch {
      return false;
    }
  }
}

/** What classifyExit() knows about a finished command. */
export interface ExitFacts {
  /** null when the exit code could not be read, e.g. the container was killed. */
  exitCode: number | null;
  durationMs: number;
  timeoutSec: number;
  /** True when the host watchdog had to kill the whole container. */
  watchdogFired: boolean;
}

/**
 * Works out why a command ended.
 *
 * `timeout -s KILL` and the kernel's out-of-memory killer both end up as exit
 * code 137 (128 + SIGKILL), so the code alone cannot tell them apart. Two extra
 * clues do: how long the command ran, and the container's OOMKilled flag. The
 * flag costs a call to Docker, so `wasOomKilled` is only asked when needed.
 *
 * npm passes a killed script's 137 straight through (checked by hand), so this
 * works for `npm test` as well as for a bare command.
 */
export async function classifyExit(
  facts: ExitFacts,
  wasOomKilled: () => Promise<boolean>,
): Promise<ExecOutcome> {
  const { exitCode, durationMs, timeoutSec, watchdogFired } = facts;
  if (exitCode === 0) {
    return 'ok';
  }
  if (watchdogFired) {
    return 'timeout';
  }
  // 124 is what `timeout` returns when it gives up on a command with a catchable
  // signal. With `-s KILL` it is 137 instead, but 124 still means "timed out".
  if (exitCode === 124) {
    return 'timeout';
  }
  if (exitCode === 137 || exitCode === null) {
    if (durationMs >= timeoutSec * 1000 - 1000) {
      return 'timeout';
    }
    // Killed well before the deadline, so the memory limit is the likely reason.
    // Exit 137 means "killed by SIGKILL", and inside a container with a memory
    // cap that is almost always the kernel's out-of-memory killer. The
    // container's own flag is only set when its main process died, so a missing
    // flag does not rule it out.
    if (exitCode === 137) {
      return 'out-of-memory';
    }
    return (await wasOomKilled()) ? 'out-of-memory' : 'failed';
  }
  return 'failed';
}

/**
 * Makes sure the image is on this machine, pulling it once if not.
 *
 * `node:22-bookworm` is about 1 GB, so the first run is slow and every run after
 * it is instant. We use the full image, not `-slim`, because packages with native
 * code need python3, make and g++ to build during `npm install`.
 */
export async function ensureImage(
  docker: Docker,
  image: string,
  onProgress?: (message: string) => void,
): Promise<{ pulled: boolean }> {
  try {
    await docker.getImage(image).inspect();
    return { pulled: false };
  } catch (error) {
    if (!isNotFound(error)) {
      throw new SandboxError(`could not check the image "${image}": ${describe(error)}`, {
        cause: error,
      });
    }
  }

  onProgress?.(`pulling ${image}, this happens once and takes a few minutes`);
  try {
    const stream = await docker.pull(image);
    let lastStatus = '';
    await new Promise<void>((resolvePull, rejectPull) => {
      // Docker streams pull progress as one JSON object per layer event;
      // followProgress parses them and calls back when the pull is finished.
      docker.modem.followProgress(
        stream,
        (error) => (error ? rejectPull(error) : resolvePull()),
        (event: { status?: string }) => {
          // Every layer reports the same handful of statuses, so only report changes.
          if (event.status !== undefined && event.status !== lastStatus) {
            lastStatus = event.status;
            onProgress?.(event.status);
          }
        },
      );
    });
  } catch (error) {
    // A typo in SANDBOX_IMAGE, no internet, or a registry rate limit.
    throw new SandboxError(`could not pull the image "${image}": ${describe(error)}`, {
      cause: error,
    });
  }
  return { pulled: true };
}

/**
 * Creates the shared npm cache volume, once.
 *
 * A fresh named volume is owned by root, but our containers run as `node`, so npm
 * would get EACCES on its own cache. Docker has no "create this volume owned by
 * uid 1000" option, so the fix is one throwaway root container that chowns the
 * volume. It runs only when the volume is created.
 */
export async function ensureNpmCacheVolume(docker: Docker, image: string): Promise<void> {
  try {
    await docker.getVolume(NPM_CACHE_VOLUME).inspect();
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw new SandboxError(`could not check the npm cache volume: ${describe(error)}`, {
        cause: error,
      });
    }
  }

  await docker.createVolume({ Name: NPM_CACHE_VOLUME, Labels: { [CONTAINER_LABEL]: '1' } });

  const container = await docker.createContainer({
    Image: image,
    User: '0:0',
    Cmd: ['chown', `${CONTAINER_USER}:${CONTAINER_USER}`, '/cache'],
    Labels: { [CONTAINER_LABEL]: '1' },
    HostConfig: {
      Mounts: [{ Type: 'volume', Source: NPM_CACHE_VOLUME, Target: '/cache' }],
      NetworkMode: 'none',
    },
  });
  try {
    await container.start();
    const result: { StatusCode?: number } = await container.wait();
    if (result.StatusCode !== 0) {
      throw new SandboxError(
        `could not take ownership of the npm cache volume (chown exited ${result.StatusCode})`,
      );
    }
  } finally {
    await container.remove({ force: true }).catch(() => {});
  }
}

/**
 * Removes containers left behind by a crashed run, and reports how many.
 *
 * Containers are normally destroyed in a `finally` block, but a power cut or a
 * killed terminal skips that. Everything we create carries the `upgrade-agent`
 * label, so one call at startup can find the leftovers.
 *
 * Labelled is not the same as left over, though. A run in another terminal (or,
 * from Phase 2, the worker process) has live containers with the same label, and
 * removing one would kill that run halfway through. So each container also
 * records the PID of the process that created it, and only containers whose
 * creator has exited are removed.
 */
export async function sweepContainers(docker: Docker): Promise<number> {
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${CONTAINER_LABEL}=1`] }),
  });

  let removed = 0;
  for (const info of containers) {
    if (!isLeftover(info.Labels)) {
      continue;
    }
    try {
      await docker.getContainer(info.Id).remove({ force: true, v: true });
      removed++;
    } catch (error) {
      if (!isNotFound(error)) {
        throw new SandboxError(`could not remove container ${info.Id}: ${describe(error)}`, {
          cause: error,
        });
      }
    }
  }
  return removed;
}

/**
 * True when nothing alive owns this container: its creator process has exited,
 * or it carries no creator PID at all (made by a version without the label).
 */
export function isLeftover(labels: Readonly<Record<string, string>> | undefined): boolean {
  const pid = Number(labels?.[OWNER_PID_LABEL]);
  if (!Number.isInteger(pid) || pid <= 0) {
    return true;
  }
  return !processIsAlive(pid);
}

/**
 * Signal 0 delivers nothing; it only asks whether the process exists. This works
 * on Windows too. PIDs are per machine, so this assumes the Docker daemon is not
 * shared with other computers.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user, which still means alive.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Checks that the Docker daemon is reachable and returns its version. */
export async function pingDocker(docker: Docker): Promise<string> {
  try {
    await docker.ping();
    const version = await docker.version();
    return version.Version ?? 'unknown version';
  } catch (error) {
    throw new SandboxError(`could not reach the Docker daemon: ${describe(error)}`, {
      cause: error,
    });
  }
}

/** Docker container names allow only `[a-zA-Z0-9][a-zA-Z0-9_.-]*`. */
function containerName(name: string | undefined): string {
  const slug = (name ?? 'run')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, 40);
  const suffix = Date.now().toString(36);
  return `${CONTAINER_LABEL}-${slug === '' ? 'run' : slug}-${suffix}`;
}

/** Dockerode reports a missing image, volume or container as a 404. */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { statusCode?: number }).statusCode === 404
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line === '' ? 'no error message' : line;
}
