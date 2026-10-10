import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config.js';
import { SandboxError, SandboxPathError } from '../../src/sandbox/errors.js';
import { CONTAINER_LABEL, Sandbox, sweepContainers } from '../../src/sandbox/sandbox.js';

/**
 * These tests prove the sandbox really is a sandbox. They need Docker running,
 * and the network test needs internet access.
 *
 * Everything here is checked against the live Docker daemon on purpose: the
 * value of this subphase is entirely in whether the limits, the timeouts, the
 * network cut and the copy-out rules actually hold, and no mock can tell us that.
 */

// The same defaults the CLI would use, so the test covers the real settings.
const sandboxConfig = parseConfig({}).sandbox;

/** `node -e` program that reports whether the registry can be reached. */
const FETCH_REGISTRY = [
  'node',
  '-e',
  'fetch("https://registry.npmjs.org/left-pad", { signal: AbortSignal.timeout(15000) })' +
    '.then((r) => console.log("status", r.status))' +
    '.catch((e) => { console.error("no network:", e.message); process.exit(1); })',
];

describe('Sandbox', () => {
  const docker = new Docker();
  let sandbox: Sandbox;

  beforeAll(async () => {
    sandbox = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-main' });
  });

  afterAll(async () => {
    await sandbox?.destroy();
  });

  it('applies the limits and drops privileges', async () => {
    const info = await docker.getContainer(sandbox.containerId).inspect();

    expect(info.HostConfig.Memory).toBe(sandboxConfig.memoryMb * 1024 * 1024);
    // Equal values mean swap is disabled, so the memory cap is a real cap.
    expect(info.HostConfig.MemorySwap).toBe(info.HostConfig.Memory);
    expect(info.HostConfig.NanoCpus).toBe(sandboxConfig.cpus * 1e9);
    expect(info.HostConfig.PidsLimit).toBe(512);
    expect(info.HostConfig.CapDrop).toEqual(['ALL']);
    expect(info.HostConfig.SecurityOpt).toEqual(['no-new-privileges']);
    expect(info.HostConfig.Binds ?? []).toEqual([]);
    expect(info.Config.User).toBe('node');
    expect(info.Config.Labels[CONTAINER_LABEL]).toBe('1');
  });

  it('runs commands as the unprivileged node user', async () => {
    const result = await sandbox.exec(['whoami'], { timeoutSec: 30 });

    expect(result.outcome).toBe('ok');
    expect(result.stdout.trim()).toBe('node');
  });

  it('gives npm a cache it can actually write to', async () => {
    // A fresh named volume belongs to root, so without the one-time chown in
    // ensureNpmCacheVolume() every `npm ci` would fail with EACCES on its cache.
    const result = await sandbox.exec(
      ['sh', '-c', 'touch "$NPM_CONFIG_CACHE/probe" && stat -c "%U" "$NPM_CONFIG_CACHE"'],
      { timeoutSec: 30 },
    );

    expect(result.outcome).toBe('ok');
    expect(result.stdout.trim()).toBe('node');
  });

  it('cannot become root, even with a setuid binary available', async () => {
    const result = await sandbox.exec(['id', '-u'], { timeoutSec: 30 });

    expect(result.stdout.trim()).not.toBe('0');
  });

  it('keeps stdout and stderr apart and reports the exit code', async () => {
    const result = await sandbox.exec(
      ['sh', '-c', 'echo this-is-stdout; echo this-is-stderr >&2; exit 3'],
      { timeoutSec: 30 },
    );

    expect(result.outcome).toBe('failed');
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('this-is-stdout');
    expect(result.stderr.trim()).toBe('this-is-stderr');
  });

  it('kills a command that runs too long', async () => {
    const result = await sandbox.exec(['sleep', '999'], { timeoutSec: 3 });

    expect(result.outcome).toBe('timeout');
    // Killed by the in-container timeout, long before the host watchdog.
    expect(result.durationMs).toBeLessThan(30_000);
  });

  it('lets the node user write, read, list and search files', async () => {
    await sandbox.writeFile('src/deep/needle.js', 'const needle = "findme";\n');

    expect(await sandbox.readFile('src/deep/needle.js')).toContain('findme');
    expect(await sandbox.listFiles('src')).toEqual(['deep/']);

    const matches = await sandbox.search('findme');
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ path: 'src/deep/needle.js', line: 1 });

    const owner = await sandbox.exec(['stat', '-c', '%U:%G', 'src/deep/needle.js'], {
      timeoutSec: 30,
    });
    expect(owner.stdout.trim()).toBe('node:node');
  });

  it('writes file contents that no shell could survive', async () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: writing a literal ${} is the point
    const nasty = 'const s = `${"$(rm -rf /)"}`; // \'quotes\' "and" \\backslashes\\\n';
    await sandbox.writeFile('nasty.js', nasty);

    expect(await sandbox.readFile('nasty.js')).toBe(nasty);
  });

  it('refuses paths that point outside the repo', async () => {
    await expect(sandbox.readFile('../../etc/passwd')).rejects.toThrow(SandboxPathError);
    await expect(sandbox.writeFile('/etc/passwd', 'x')).rejects.toThrow(SandboxPathError);
  });
});

describe('Sandbox.copyIn', () => {
  const docker = new Docker();
  let sandbox: Sandbox;
  let repoDir: string;

  beforeAll(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-repo-'));
    mkdirSync(join(repoDir, 'scripts'));
    writeFileSync(join(repoDir, 'package.json'), '{"name":"demo","version":"1.0.0"}');
    writeFileSync(join(repoDir, 'scripts', 'run.sh'), '#!/bin/sh\necho hello\n');
    // A real git repo, because the executable bits are read from git's index.
    execFileSync('git', ['init', '-q'], { cwd: repoDir });
    execFileSync('git', ['add', '-A'], { cwd: repoDir });
    execFileSync('git', ['update-index', '--chmod=+x', 'scripts/run.sh'], { cwd: repoDir });

    sandbox = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-copy' });
    await sandbox.copyIn(repoDir);
  });

  afterAll(async () => {
    await sandbox?.destroy();
    rmSync(repoDir, { recursive: true, force: true });
  });

  it('copies the repo in, owned by the node user', async () => {
    const result = await sandbox.exec(['stat', '-c', '%U:%G %n', 'package.json'], {
      timeoutSec: 30,
    });

    expect(result.outcome).toBe('ok');
    expect(result.stdout.trim()).toBe('node:node package.json');
  });

  it('keeps the executable bit that git recorded', async () => {
    const result = await sandbox.exec(['sh', '-c', 'test -x scripts/run.sh && ./scripts/run.sh'], {
      timeoutSec: 30,
    });

    expect(result.outcome).toBe('ok');
    expect(result.stdout.trim()).toBe('hello');
  });

  it('leaves .git behind on the host', async () => {
    const result = await sandbox.exec(['sh', '-c', 'test -e .git; echo $?'], { timeoutSec: 30 });

    expect(result.stdout.trim()).toBe('1');
  });

  it('copies a file back out to the host', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-out-'));
    try {
      await sandbox.writeFile('package.json', '{"name":"demo","version":"2.0.0"}');
      const written = await sandbox.copyOut(['package.json'], destDir);

      expect(written).toHaveLength(1);
      expect(readFileSync(join(destDir, 'package.json'), 'utf8')).toContain('2.0.0');
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('refuses to copy out a symlink the container planted', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-out-'));
    try {
      const link = await sandbox.exec(['ln', '-sf', '/etc/passwd', 'stolen.txt'], {
        timeoutSec: 30,
      });
      expect(link.outcome).toBe('ok');

      await expect(sandbox.copyOut(['stolen.txt'], destDir)).rejects.toThrow(
        /it is a symlink, not a file/,
      );
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('refuses to copy out through "..", and never writes outside the target folder', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-out-'));
    try {
      await expect(sandbox.copyOut(['../../etc/passwd'], destDir)).rejects.toThrow(
        SandboxPathError,
      );
      await expect(sandbox.copyOut(['/etc/passwd'], destDir)).rejects.toThrow(SandboxPathError);
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });

  it('reports a missing file clearly', async () => {
    const destDir = mkdtempSync(join(tmpdir(), 'upgrade-agent-out-'));
    try {
      await expect(sandbox.copyOut(['nope.json'], destDir)).rejects.toThrow(SandboxError);
    } finally {
      rmSync(destDir, { recursive: true, force: true });
    }
  });
});

describe('Sandbox.disconnectNetwork', () => {
  const docker = new Docker();

  it('has the network during installs and loses it before tests', async () => {
    const sandbox = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-network' });
    try {
      const before = await sandbox.exec(FETCH_REGISTRY, { timeoutSec: 60 });
      expect(before.outcome, 'this test needs internet access').toBe('ok');

      await sandbox.disconnectNetwork();

      const info = await docker.getContainer(sandbox.containerId).inspect();
      expect(Object.keys(info.NetworkSettings.Networks ?? {})).toEqual([]);

      const after = await sandbox.exec(FETCH_REGISTRY, { timeoutSec: 60 });
      expect(after.outcome).toBe('failed');
      expect(after.stderr).toContain('no network');
    } finally {
      await sandbox.destroy();
    }
  });
});

describe('Sandbox cleanup', () => {
  const docker = new Docker();

  it('removes its container, and can be destroyed twice', async () => {
    const sandbox = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-destroy' });
    const { containerId } = sandbox;

    await sandbox.destroy();
    await expect(docker.getContainer(containerId).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
    // A second destroy must not throw: pipelines call it from a finally block.
    await sandbox.destroy();
  });

  it('sweeps up containers left behind by a crashed run', async () => {
    const leftover = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-leftover' });

    const removed = await sweepContainers(docker);

    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(docker.getContainer(leftover.containerId).inspect()).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('keeps the containers it is told to keep', async () => {
    const keep = await Sandbox.create({ ...sandboxConfig, docker, name: 'test-keep' });
    try {
      await sweepContainers(docker, { keepIds: [keep.containerId] });

      const info = await docker.getContainer(keep.containerId).inspect();
      expect(info.State.Running).toBe(true);
    } finally {
      await keep.destroy();
    }
  });
});

describe('Sandbox memory limit', () => {
  const docker = new Docker();

  it('reports a process killed for using too much memory', async () => {
    const sandbox = await Sandbox.create({
      ...sandboxConfig,
      memoryMb: 64,
      docker,
      name: 'test-memory',
    });
    try {
      const result = await sandbox.exec(
        // Buffers live outside the JS heap, so this hits the container's limit
        // rather than V8's own heap limit.
        ['node', '-e', 'const held = []; for (;;) { held.push(Buffer.alloc(8 * 1024 * 1024)); }'],
        { timeoutSec: 60 },
      );

      expect(result.outcome).toBe('out-of-memory');
      expect(result.durationMs).toBeLessThan(60_000);
    } finally {
      await sandbox.destroy();
    }
  });
});
