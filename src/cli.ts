#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import { ConfigError, loadEnvFile, parseConfig } from './config.js';
import { checkDocker, describeConfig, describeDockerCheck } from './doctor.js';

// Read the version from package.json. The path works from both src/ (tsx) and dist/ (built).
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const version: string = packageJson.version;

function parsePositiveInt(value: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new InvalidArgumentError('must be a whole number of 1 or more.');
  }
  return number;
}

const program = new Command()
  .name('upgrade-agent')
  .description(
    'Upgrades outdated npm dependencies one package at a time: tests each upgrade in Docker, ' +
      'fixes breakages with an LLM agent, and opens a pull request per package.',
  )
  .version(version);

program
  .command('run')
  .description('Upgrade the outdated dependencies of a repo, one pull request per package')
  .argument('<repo>', 'GitHub URL or local path of the repo')
  .option('--dry-run', 'do everything except pushing branches and opening pull requests')
  .option('--only <packages...>', 'only upgrade these packages')
  .option('--max <n>', 'upgrade at most this many packages', parsePositiveInt)
  .action(() => {
    console.error('The run command is not implemented yet.');
    process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Check that your setup is valid: config, Docker, and a sandbox smoke test')
  .option('--skip-docker', 'only check the config, without talking to Docker')
  .action(async (options: { skipDocker?: boolean }) => {
    const envFileFound = loadEnvFile();

    let config: ReturnType<typeof parseConfig>;
    try {
      config = parseConfig(process.env);
    } catch (error) {
      if (!(error instanceof ConfigError)) {
        throw error;
      }
      console.error(error.message);
      console.error('Fix these in .env (.env.example lists every setting).');
      process.exitCode = 1;
      return;
    }

    for (const line of describeConfig(config, envFileFound)) {
      console.log(line);
    }
    if (options.skipDocker === true) {
      return;
    }

    console.log('');
    const check = await checkDocker(config, {
      onProgress: (message) => console.log(`  ${message}`),
    });
    for (const line of describeDockerCheck(check)) {
      console.log(line);
    }
    if (!check.ok) {
      process.exitCode = 1;
    }
  });

await program.parseAsync();
