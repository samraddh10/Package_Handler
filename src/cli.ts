#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import Docker from 'dockerode';
import { type Config, ConfigError, loadEnvFile, parseConfig } from './config.js';
import { checkDocker, describeConfig, describeDockerCheck } from './doctor.js';
import { createWorkspace, parseTarget, removeWorkspace, WorkspaceError } from './git/workspace.js';
import { SandboxError } from './sandbox/errors.js';
import { pingDocker, Sandbox, sweepContainers } from './sandbox/sandbox.js';
import { describeScan, ScanError, scanWorkspace } from './scanner/scan.js';

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

/** Loads .env and validates it. Prints the problems and returns null when it is invalid. */
function loadConfig(): { config: Config; envFileFound: boolean } | null {
  const envFileFound = loadEnvFile();
  try {
    return { config: parseConfig(process.env), envFileFound };
  } catch (error) {
    if (!(error instanceof ConfigError)) {
      throw error;
    }
    console.error(error.message);
    console.error('Fix these in .env (.env.example lists every setting).');
    process.exitCode = 1;
    return null;
  }
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
  .command('scan')
  .description(
    'Clone a repo, check that its tests pass in the sandbox, and list its outdated ' +
      'dependencies in the order they would be upgraded. Changes nothing.',
  )
  .argument('<repo>', 'GitHub URL or local path of the repo')
  .action(async (repo: string) => {
    const loaded = loadConfig();
    if (loaded === null) {
      return;
    }
    const { config } = loaded;

    const docker = new Docker();
    try {
      await pingDocker(docker);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      console.error(`${reason}\nStart Docker Desktop, then run scan again.`);
      process.exitCode = 1;
      return;
    }

    try {
      // Containers left behind by a run that crashed; live runs' containers are kept.
      await sweepContainers(docker);
      const target = parseTarget(repo);
      console.log(`Cloning ${target.label} ...`);
      const workspace = await createWorkspace(target, { workspaceDir: config.workspaceDir });
      try {
        console.log(
          `Repo:      ${target.label}, commit ${workspace.commit.slice(0, 7)} on ${workspace.branch}`,
        );
        for (const warning of workspace.warnings) {
          console.log(`Warning:   ${warning}`);
        }
        const result = await scanWorkspace(workspace.repoDir, {
          limits: config.sandbox,
          createSandbox: () =>
            Sandbox.create({ ...config.sandbox, docker, name: `scan-${target.label}` }),
          onProgress: (message) => console.log(`  ${message}`),
        });
        console.log('');
        for (const line of describeScan(result)) {
          console.log(line);
        }
      } finally {
        // A scan changes nothing, so the clone has no further use.
        await removeWorkspace(workspace);
      }
    } catch (error) {
      if (
        !(error instanceof ScanError) &&
        !(error instanceof WorkspaceError) &&
        !(error instanceof SandboxError)
      ) {
        throw error;
      }
      console.error(`\nScan stopped: ${error.message}`);
      if (error instanceof ScanError && error.details !== null) {
        console.error(error.details.replace(/^/gm, '  '));
      }
      process.exitCode = 1;
    }
  });

program
  .command('doctor')
  .description('Check that your setup is valid: config, Docker, and a sandbox smoke test')
  .option('--skip-docker', 'only check the config, without talking to Docker')
  .action(async (options: { skipDocker?: boolean }) => {
    const loaded = loadConfig();
    if (loaded === null) {
      return;
    }
    const { config, envFileFound } = loaded;

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
