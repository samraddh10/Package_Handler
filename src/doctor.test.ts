import { describe, expect, it } from 'vitest';
import { parseConfig } from './config.js';
import { describeConfig } from './doctor.js';

describe('describeConfig', () => {
  it('never prints secret values', () => {
    const secret = 'sk-test-SECRET-123';
    const config = parseConfig({
      GROQ_API_KEY: secret,
      GROQ_MODEL: 'some-model',
      GITHUB_TOKEN: secret,
      REDIS_URL: `redis://user:${secret}@localhost:6379`,
    });

    const report = describeConfig(config, true).join('\n');

    expect(report).not.toContain(secret);
    expect(report).toContain('GitHub token: set');
    expect(report).toContain('redis://user:***@localhost:6379');
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
