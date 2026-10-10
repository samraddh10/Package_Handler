import type { Config } from './config.js';

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
    `Redis:        ${redactPassword(config.redis.url)}`,
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
