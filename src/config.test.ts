import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadEnvFile, parseConfig } from './config.js';

/** Runs parseConfig on a bad environment and returns the problems it reports. */
function problemsFor(env: Record<string, string>): string[] {
  try {
    parseConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error('expected parseConfig to throw a ConfigError');
}

describe('parseConfig', () => {
  it('fills in defaults when nothing is set', () => {
    const config = parseConfig({});

    expect(config.llm.providerOrder).toEqual(['gemini', 'groq', 'openrouter']);
    expect(config.llm.maxCallsPerRun).toBe(60);
    expect(config.llm.providers.groq).toEqual({
      apiKey: undefined,
      model: undefined,
      maxInputTokens: 6000,
    });
    expect(config.github.token).toBeUndefined();
    expect(config.redis.url).toBe('redis://localhost:6379');
    expect(config.sandbox).toEqual({
      image: 'node:22-bookworm',
      cpus: 2,
      memoryMb: 2048,
      installTimeoutSec: 300,
      testTimeoutSec: 300,
    });
    expect(config.fixAgent).toEqual({ maxAttempts: 3, maxSteps: 20 });
    expect(config.workspaceDir).toBe('.workspaces');
  });

  it('turns number strings into numbers', () => {
    const config = parseConfig({ SANDBOX_CPUS: '4', TEST_TIMEOUT_SEC: '120' });

    expect(config.sandbox.cpus).toBe(4);
    expect(config.sandbox.testTimeoutSec).toBe(120);
  });

  it('treats blank values as not set', () => {
    const config = parseConfig({ GROQ_API_KEY: '', GROQ_MODEL: '   ', SANDBOX_CPUS: '' });

    expect(config.llm.providers.groq.apiKey).toBeUndefined();
    expect(config.llm.providers.groq.model).toBeUndefined();
    expect(config.sandbox.cpus).toBe(2);
  });

  it('gives each provider its own key and model', () => {
    const config = parseConfig({
      GOOGLE_GENERATIVE_AI_API_KEY: 'g-key',
      GEMINI_MODEL: 'g-model',
      OPENROUTER_API_KEY: 'o-key',
      OPENROUTER_MODEL: 'o-model',
    });

    expect(config.llm.providers.gemini).toMatchObject({ apiKey: 'g-key', model: 'g-model' });
    expect(config.llm.providers.openrouter).toMatchObject({ apiKey: 'o-key', model: 'o-model' });
    expect(config.llm.providers.groq.apiKey).toBeUndefined();
  });

  it('reads the provider order as a comma-separated list', () => {
    const config = parseConfig({ LLM_PROVIDER_ORDER: ' groq , gemini ' });

    expect(config.llm.providerOrder).toEqual(['groq', 'gemini']);
  });

  it('rejects an unknown provider name', () => {
    const problems = problemsFor({ LLM_PROVIDER_ORDER: 'gemini,chatgpt' });

    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^LLM_PROVIDER_ORDER: /);
  });

  it('rejects a provider listed twice', () => {
    const problems = problemsFor({ LLM_PROVIDER_ORDER: 'groq,groq' });

    expect(problems).toEqual(['LLM_PROVIDER_ORDER: lists the same provider twice']);
  });

  it('reports every bad number at once, by variable name', () => {
    const problems = problemsFor({ SANDBOX_CPUS: 'two', FIX_MAX_STEPS: '0' });

    expect(problems).toHaveLength(2);
    expect(problems.some((problem) => problem.startsWith('SANDBOX_CPUS: '))).toBe(true);
    expect(problems.some((problem) => problem.startsWith('FIX_MAX_STEPS: '))).toBe(true);
  });

  it('rejects a Redis URL that is not redis:// or rediss://', () => {
    const problems = problemsFor({ REDIS_URL: 'http://localhost:6379' });

    expect(problems).toEqual(['REDIS_URL: must be a redis:// or rediss:// URL']);
  });
});

describe('loadEnvFile', () => {
  it('returns false when the file does not exist', () => {
    expect(loadEnvFile(join(tmpdir(), 'upgrade-agent-no-such-file.env'))).toBe(false);
  });

  it('loads the file into process.env', () => {
    const dir = mkdtempSync(join(tmpdir(), 'upgrade-agent-'));
    const file = join(dir, '.env');
    writeFileSync(file, 'UPGRADE_AGENT_TEST_VALUE=hello\n');

    try {
      expect(loadEnvFile(file)).toBe(true);
      expect(process.env.UPGRADE_AGENT_TEST_VALUE).toBe('hello');
    } finally {
      delete process.env.UPGRADE_AGENT_TEST_VALUE;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
