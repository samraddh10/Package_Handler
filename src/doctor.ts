import Docker from 'dockerode';
import { openCache } from './cache/cache.js';
import type { Config } from './config.js';
import { ensureImage, pingDocker, Sandbox, sweepContainers } from './sandbox/sandbox.js';

/**
 * Builds the setup report printed by `upgrade-agent doctor`.
 * It returns lines instead of printing them, so tests can check the output.
 * Secrets are never included: only whether they are set.
 */
export function describeConfig(config: Config, envFileFound: boolean): string[] {
  const lines = [
    envFileFound
      ? '.env file:    found'
      : '.env file:    not found (using environment variables and defaults)',
    'Config:       valid',
    '',
    'LLM providers, in fallback order:',
  ];

  let readyCount = 0;
  for (const name of config.llm.providerOrder) {
    const { apiKey, model } = config.llm.providers[name];
    let status: string;
    if (!apiKey) {
      status = 'no API key, will be skipped';
    } else if (!model) {
      status = 'no model set, will be skipped';
    } else {
      status = `ready (model: ${model})`;
      readyCount++;
    }
    lines.push(`  ${name.padEnd(12)}${status}`);
  }
  if (readyCount === 0) {
    lines.push('  Warning: no provider is ready. Add at least one API key and model to .env.');
  }

  const { sandbox, fixAgent } = config;
  lines.push(
    '',
    `GitHub token: ${config.github.token ? 'set' : 'not set (needed to open pull requests)'}`,
    `Redis:        ${redactPassword(config.redis.url)}, password ${config.redis.password ? 'set' : 'not set'}`,
    `Sandbox:      ${sandbox.image}, ${sandbox.cpus} CPUs, ${sandbox.memoryMb} MB memory`,
    `Timeouts:     install ${sandbox.installTimeoutSec}s, tests ${sandbox.testTimeoutSec}s`,
    `Fix agent:    up to ${fixAgent.maxAttempts} test attempts, ${fixAgent.maxSteps} steps`,
  );
  return lines;
}

/** Hides the password in a URL such as redis://user:secret@host:6379. */
function redactPassword(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) {
    parsed.password = '***';
  }
  return parsed.toString();
}

/**
 * What the Docker half of `doctor` found out. Each field is filled in as the
 * checks progress, so a failure halfway through still reports what worked.
 */
export interface DockerCheck {
  ok: boolean;
  /** The Docker daemon's version, or null when it could not be reached. */
  serverVersion: string | null;
  image: { name: string; pulled: boolean } | null;
  /** Containers left over by an earlier crashed run, now removed. */
  sweptContainers: number;
  /** Result of actually creating a container, running node in it and writing a file. */
  smoke: { nodeVersion: string } | null;
  error: string | null;
}

/**
 * Runs the real Docker checks: daemon reachable, image available, and a
 * throwaway container that can run node and write a file as the `node` user.
 *
 * It exists because every later subphase assumes Docker works. Finding out here,
 * with a message that says what to do, beats finding out in the middle of a run.
 */
export async function checkDocker(
  config: Config,
  options: { docker?: Docker; onProgress?: (message: string) => void } = {},
): Promise<DockerCheck> {
  const docker = options.docker ?? new Docker();
  const check: DockerCheck = {
    ok: false,
    serverVersion: null,
    image: null,
    sweptContainers: 0,
    smoke: null,
    error: null,
  };

  try {
    check.serverVersion = await pingDocker(docker);

    const { image } = config.sandbox;
    const { pulled } = await ensureImage(docker, image, options.onProgress);
    check.image = { name: image, pulled };

    // Only removes containers whose creating process has exited, so running doctor
    // while a run is going on in another terminal does not break that run.
    check.sweptContainers = await sweepContainers(docker);

    const sandbox = await Sandbox.create({ ...config.sandbox, docker, name: 'doctor' });
    try {
      const version = await sandbox.exec(['node', '--version'], { timeoutSec: 60 });
      if (version.outcome !== 'ok') {
        throw new Error(`"node --version" ended as ${version.outcome}: ${version.stderr.trim()}`);
      }
      // Proves the project folder belongs to the unprivileged user, which is what
      // `npm ci` needs later.
      await sandbox.writeFile('doctor-probe.txt', 'ok\n');
      const readBack = await sandbox.readFile('doctor-probe.txt');
      if (readBack.trim() !== 'ok') {
        throw new Error('wrote a file in the sandbox but read back something else');
      }
      check.smoke = { nodeVersion: version.stdout.trim() };
      check.ok = true;
    } finally {
      await sandbox.destroy();
    }
  } catch (error) {
    check.error = error instanceof Error ? error.message : String(error);
  }

  return check;
}

/** Formats a DockerCheck as report lines. Pure, so the wording is unit tested. */
export function describeDockerCheck(check: DockerCheck): string[] {
  const lines: string[] = [];

  if (check.serverVersion === null) {
    lines.push(`Docker:       not reachable (${check.error ?? 'unknown error'})`);
    lines.push('              Start Docker Desktop, then run doctor again.');
    return lines;
  }
  lines.push(`Docker:       running (server ${check.serverVersion})`);

  if (check.image !== null) {
    const how = check.image.pulled ? 'pulled just now' : 'already on this machine';
    lines.push(`Image:        ${check.image.name} (${how})`);
  }
  if (check.sweptContainers > 0) {
    const plural = check.sweptContainers === 1 ? 'container' : 'containers';
    lines.push(`Cleanup:      removed ${check.sweptContainers} leftover ${plural}`);
  }
  if (check.smoke !== null) {
    lines.push(`Sandbox:      smoke test passed (${check.smoke.nodeVersion}, files writable)`);
  }
  if (!check.ok) {
    lines.push(`Sandbox:      smoke test failed (${check.error ?? 'unknown error'})`);
  }
  return lines;
}

/**
 * Connects to Redis and logs in, the same way a run does. Redis is optional
 * (without it the changelog cache only lasts one run), so a failure is a
 * warning, not an error: the returned line says what happened.
 */
export async function checkRedis(redis: Config['redis']): Promise<{ ok: boolean; line: string }> {
  let warning: string | null = null;
  const cache = await openCache({
    ...redis,
    onWarning: (message) => {
      warning = message;
    },
  });
  await cache.close();
  if (warning === null) {
    return { ok: true, line: 'Redis check:  connected, password accepted (changelog cache is on)' };
  }
  return { ok: false, line: `Redis check:  warning: ${warning}` };
}
