import { mkdir, writeFile as writeHostFile } from 'node:fs/promises';
import { dirname, posix, relative, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import Docker from 'dockerode';
import { SandboxError, SandboxPathError } from './errors.js';
import { CappedOutput } from './output.js';
import { PROJECT_DIR, toContainerPath, toRelativePath } from './paths.js';
import {
  MAX_COPY_OUT_BYTES,
  type Ownership,
  packRepo,
  packSingleFile,
  readGitExecutableBits,
  readSingleFileFromArchive,
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

/** Shared npm cache, so `npm ci` does not re-download the registry for every package. */
export const NPM_CACHE_VOLUME = 'upgrade-agent-npm-cache';
const NPM_CACHE_DIR = '/home/node/.npm';

/** The user inside the image that owns the project and runs every command. */
const CONTAINER_USER = 'node';

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
   * The container's command is `mkdir -p <project> && exec sleep infinity`, run as
   * `node`. Two reasons: `sleep infinity` keeps it alive for later `exec` calls,
   * and creating the project folder from inside means the `node` user owns it.
   * That second part matters more than it looks: if we instead set the container's
   * WorkingDir to a folder that does not exist, Docker creates it as root and
   * every later `npm ci` fails with EACCES in its own project folder.
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
        // Must be a folder that already exists and belongs to `node`; see above.
        WorkingDir: '/home/node',
        Entrypoint: ['/bin/sh', '-c'],
        Cmd: [`mkdir -p ${PROJECT_DIR} && exec sleep infinity`],
        Env: [
          // Test runners check CI to stay out of interactive watch mode, which
          // would otherwise hang every `npm test` until the timeout.
          'CI=true',
          'NO_COLOR=1',
          'HOME=/home/node',
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
      await sandbox.detectOwner();
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
   * Asks the container which uid/gid the `node` user has, instead of hardcoding
   * 1000:1000, so a custom image with a different `node` user still ends up with
   * files it can write.
   */
  private async detectOwner(): Promise<void> {
    const result = await this.exec(['/bin/sh', '-c', 'id -u; id -g'], { timeoutSec: 15 });
    const [uidText, gidText] = result.stdout.trim().split('\n');
    const uid = Number(uidText);
    const gid = Number(gidText);
    if (result.outcome !== 'ok' || !Number.isInteger(uid) || !Number.isInteger(gid)) {
      throw new SandboxError(
        `could not read the container user id: ${firstLine(result.stderr || result.stdout)}`,
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
   * normal case this whole project is built around.
   */
  async exec(command: string[], options: ExecOptions): Promise<ExecResult> {
    if (command.length === 0) {
      throw new SandboxError('exec() needs a command');
    }
    if (this.removed) {
      throw new SandboxError('this sandbox has been destroyed');
    }

    const { timeoutSec, cwd, env } = options;
    const wrapped = ['timeout', '-s', 'KILL', String(timeoutSec), ...command];
    const stdout = new CappedOutput();
    const stderr = new CappedOutput();
    const startedAt = Date.now();
    let watchdogFired = false;

    const exec = await this.container.exec({
      Cmd: wrapped,
      WorkingDir: cwd === undefined ? PROJECT_DIR : toContainerPath(cwd),
      Env: env === undefined ? undefined : Object.entries(env).map(([key, v]) => `${key}=${v}`),
      AttachStdin: false,
      AttachStdout: true,
      AttachStderr: true,
      Tty: false,
    });

    const stream = await exec.start({ hijack: true, stdin: false });
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
      outcome: await this.classifyExit(exitCode, durationMs, timeoutSec, watchdogFired),
      exitCode,
      stdout: stdout.text(),
      stderr: stderr.text(),
      durationMs,
      truncated: stdout.truncated || stderr.truncated,
    };
  }

  /** Reads a text file from the repo. Throws when the file does not exist. */
  async readFile(path: string): Promise<string> {
    const result = await this.exec(['cat', '--', toContainerPath(path)], { timeoutSec: 30 });
    if (result.outcome !== 'ok') {
      throw new SandboxError(`could not read "${path}": ${firstLine(result.stderr)}`);
    }
    return result.stdout;
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
      if (mkdirResult.outcome !== 'ok') {
        throw new SandboxError(
          `could not create the folder for "${path}": ${firstLine(mkdirResult.stderr)}`,
        );
      }
    }

    const archive = packSingleFile(relativePath, content, this.owner);
    try {
      await this.container.putArchive(archive, { path: PROJECT_DIR });
    } catch (error) {
      throw new SandboxError(`could not write "${path}": ${describe(error)}`, { cause: error });
    }
  }

  /** Lists one folder of the repo. Folder names come back with a trailing slash. */
  async listFiles(path = '.', options: { limit?: number } = {}): Promise<string[]> {
    const result = await this.exec(['ls', '-A', '-p', '--', toContainerPath(path)], {
      timeoutSec: 30,
    });
    if (result.outcome !== 'ok') {
      throw new SandboxError(`could not list "${path}": ${firstLine(result.stderr)}`);
    }
    const entries = result.stdout.split('\n').filter((entry) => entry !== '');
    return entries.slice(0, options.limit ?? 200);
  }

  /**
   * Greps the repo, skipping `node_modules` and `.git`.
   *
   * The pattern is passed to grep as an argument, never through a shell, so a
   * pattern full of quotes and semicolons is just a pattern.
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
    // grep exits 1 when there are simply no matches, which is not an error.
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
    const info = await this.container.inspect();
    const networks = Object.keys(info.NetworkSettings?.Networks ?? {});
    for (const network of networks) {
      await this.docker.getNetwork(network).disconnect({ Container: this.container.id });
    }
  }

  /**
   * Copies named files out of the container onto the host.
   *
   * Only the exact paths asked for are fetched, and tar.ts then refuses anything
   * that is not a plain file under the size cap. Writing to the host is the one
   * place where container content can affect this machine, so it is the one place
   * that double-checks everything.
   */
  async copyOut(paths: string[], destDir: string): Promise<string[]> {
    const destRoot = resolve(destDir);
    const written: string[] = [];

    for (const path of paths) {
      const relativePath = toRelativePath(path);
      const containerPath = toContainerPath(path);
      const destination = resolve(destRoot, relativePath);
      // Paths are validated already; this is the last line of defence before a write.
      const insideDest = relative(destRoot, destination);
      if (insideDest.startsWith('..') || insideDest === '') {
        throw new SandboxPathError(`refusing to write "${path}" outside "${destRoot}"`);
      }

      let archive: NodeJS.ReadableStream;
      try {
        archive = await this.container.getArchive({ path: containerPath });
      } catch (error) {
        throw new SandboxError(`could not copy out "${path}": ${describe(error)}`, {
          cause: error,
        });
      }

      const contents = await readSingleFileFromArchive(
        archive as Readable,
        posix.basename(relativePath),
        MAX_COPY_OUT_BYTES,
      );
      await mkdir(dirname(destination), { recursive: true });
      await writeHostFile(destination, contents);
      written.push(destination);
    }

    return written;
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

  /**
   * Works out why a command ended.
   *
   * `timeout -s KILL` and the kernel's out-of-memory killer both end up as exit
   * code 137 (128 + SIGKILL), so the code alone cannot tell them apart. Two extra
   * clues do: how long the command ran, and the container's OOMKilled flag.
   */
  private async classifyExit(
    exitCode: number | null,
    durationMs: number,
    timeoutSec: number,
    watchdogFired: boolean,
  ): Promise<ExecOutcome> {
    if (exitCode === 0) {
      return 'ok';
    }
    if (watchdogFired) {
      return 'timeout';
    }
    // 124 is what `timeout` returns when it has to give up on a command.
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
      return (await this.wasOomKilled()) ? 'out-of-memory' : 'failed';
    }
    return 'failed';
  }

  private async wasOomKilled(): Promise<boolean> {
    try {
      return (await this.container.inspect()).State?.OOMKilled === true;
    } catch {
      return false;
    }
  }
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
 */
export async function sweepContainers(
  docker: Docker,
  options: { keepIds?: readonly string[] } = {},
): Promise<number> {
  const keep = new Set(options.keepIds ?? []);
  const containers = await docker.listContainers({
    all: true,
    filters: JSON.stringify({ label: [`${CONTAINER_LABEL}=1`] }),
  });

  let removed = 0;
  for (const info of containers) {
    if (keep.has(info.Id)) {
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
