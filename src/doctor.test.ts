import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { type DockerCheck, describeConfig, describeDockerCheck } from './doctor.js';

describe('describeConfig', () => {
  it('never prints secret values', () => {
    const secret = 'sk-test-SECRET-123';
    const config = parseConfig({
      GROQ_API_KEY: secret,
      GROQ_MODEL: 'some-model',
      GITHUB_TOKEN: secret,
      REDIS_URL: `redis://user:${secret}@localhost:6379`,
      REDIS_PASSWORD: secret,
    });

    const report = describeConfig(config, true).join('\n');

    expect(report).not.toContain(secret);
    expect(report).toContain('GitHub token: set');
    expect(report).toContain('redis://user:***@localhost:6379, password set');
  });

  it('marks providers without a key or a model as skipped', () => {
    const config = parseConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: 'key',
      GEMINI_MODEL: 'gemini-model',
      GROQ_API_KEY: 'key',
    });

    const report = describeConfig(config, true);

    expect(report).toContain('  gemini      ready (model: gemini-model)');
    expect(report).toContain('  groq        no model set, will be skipped');
    expect(report).toContain('  openrouter  no API key, will be skipped');
    expect(report.join('\n')).not.toContain('Warning');
  });

  it('warns when no provider is ready', () => {
    const report = describeConfig(parseConfig({}), false);

    expect(report[0]).toContain('not found');
    expect(report.join('\n')).toContain('Warning: no provider is ready');
  });
});

describe('describeDockerCheck', () => {
  const working: DockerCheck = {
    ok: true,
    serverVersion: '29.6.2',
    image: { name: 'node:22-bookworm', pulled: false },
    sweptContainers: 0,
    smoke: { nodeVersion: 'v22.21.0' },
    error: null,
  };

  it('reports a healthy Docker setup', () => {
    const report = describeDockerCheck(working).join('\n');

    expect(report).toContain('Docker:       running (server 29.6.2)');
    expect(report).toContain('Image:        node:22-bookworm (already on this machine)');
    expect(report).toContain('Sandbox:      smoke test passed (v22.21.0, files writable)');
    expect(report).not.toContain('failed');
  });

  it('says when the image had to be pulled and leftovers were cleaned up', () => {
    const report = describeDockerCheck({
      ...working,
      image: { name: 'node:22-bookworm', pulled: true },
      sweptContainers: 2,
    }).join('\n');

    expect(report).toContain('(pulled just now)');
    expect(report).toContain('removed 2 leftover containers');
  });

  it('tells the user to start Docker when the daemon is unreachable', () => {
    const report = describeDockerCheck({
      ok: false,
      serverVersion: null,
      image: null,
      sweptContainers: 0,
      smoke: null,
      error: 'could not reach the Docker daemon: connect ENOENT',
    });

    expect(report[0]).toContain('not reachable');
    expect(report[1]).toContain('Start Docker Desktop');
    // Nothing else ran, so nothing else is claimed.
    expect(report).toHaveLength(2);
  });

  it('reports a failed smoke test even though Docker itself answered', () => {
    const report = describeDockerCheck({
      ...working,
      ok: false,
      smoke: null,
      error: 'could not create a container from "node:22-bookworm": no such image',
    }).join('\n');

    expect(report).toContain('Docker:       running');
    expect(report).toContain('Sandbox:      smoke test failed (could not create a container');
  });
});
