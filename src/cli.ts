#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Command, InvalidArgumentError } from 'commander';
import Docker from 'dockerode';
import semver from 'semver';
import { describeAgentEvent } from './agent/fix-agent.js';
import { openCache } from './cache/cache.js';
import { analyzeUpgrade, describeAnalysis } from './changelog/analyze.js';
import { GitHubChangelogSource, PackageNotFoundError } from './changelog/source.js';
import { type Config, ConfigError, loadEnvFile, parseConfig } from './config.js';
import { checkDocker, checkRedis, describeConfig, describeDockerCheck } from './doctor.js';
import {
  createWorkspace,
  diffWorkspace,
  parseTarget,
  removeWorkspace,
  WorkspaceError,
} from './git/workspace.js';
import { buildProviders } from './llm/providers.js';
import { describeLlmEvent, LlmRouter } from './llm/router.js';
import { describeUpgrade, upgradePackage } from './pipeline/upgrade-package.js';
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
  .command('analyze')
  .description(
    'Read the release notes of a major upgrade and list what can break. ' +
      'Uses one LLM call per major version crossed; results are cached in Redis.',
  )
  .argument('<package>', 'npm package name, e.g. express')
  .argument('<from>', 'the version you have, e.g. 4.21.2')
  .argument('<to>', 'the version to upgrade to, e.g. 5.3.0')
  .option('--refresh', 'ignore cached analyses and ask the LLM again')
  .action(async (packageName: string, from: string, to: string, options: { refresh?: boolean }) => {
    for (const version of [from, to]) {
      if (semver.valid(version) === null) {
        console.error(`"${version}" is not a version number like 4.21.2.`);
        process.exitCode = 1;
        return;
      }
    }
    const loaded = loadConfig();
    if (loaded === null) {
      return;
    }
    const { config } = loaded;

    const providers = buildProviders(config.llm);
    if (providers.length === 0) {
      console.warn(
        'Warning: no LLM provider is ready (see `doctor`); breaking changes will be unknown.',
      );
    }
    const router = new LlmRouter({
      providers,
      maxCallsPerRun: config.llm.maxCallsPerRun,
      onEvent: (event) => console.log(`  llm: ${describeLlmEvent(event)}`),
    });
    const cache = await openCache({
      ...config.redis,
      onWarning: (message) => console.warn(`Warning: ${message}`),
    });

    try {
      console.log(`Analyzing ${packageName} ${from} → ${to}`);
      const analysis = await analyzeUpgrade(packageName, from, to, {
        cache,
        router,
        source: new GitHubChangelogSource({ githubToken: config.github.token }),
        refresh: options.refresh === true,
        onProgress: (message) => console.log(`  ${message}`),
      });
      console.log('');
      for (const line of describeAnalysis(analysis)) {
        console.log(line);
      }
      const stats = router.getStats();
      const tokens =
        stats.calls > 0 ? `, ${stats.inputTokens} input + ${stats.outputTokens} output tokens` : '';
      console.log(`\nLLM calls: ${stats.calls}${tokens}. Cache: ${cache.kind}.`);
    } catch (error) {
      if (!(error instanceof PackageNotFoundError)) {
        throw error;
      }
      console.error(`\nAnalyze stopped: ${error.message}`);
      process.exitCode = 1;
    } finally {
      await cache.close();
    }
  });

program
  .command('upgrade')
  .description(
    'Upgrade one package in a repo: scan, read the changelog (majors), install and test in ' +
      'Docker, and let the fix agent repair the code if the tests break. Opens no pull request.',
  )
  .argument('<repo>', 'GitHub URL or local path of the repo')
  .argument('<package>', 'the outdated dependency to upgrade, e.g. express')
  .option('--keep', 'keep the clone with the changes in it, to look at afterwards')
  .action(async (repo: string, packageName: string, options: { keep?: boolean }) => {
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
      console.error(`${reason}\nStart Docker Desktop, then run upgrade again.`);
      process.exitCode = 1;
      return;
    }

    const providers = buildProviders(config.llm);
    if (providers.length === 0) {
      console.warn(
        'Warning: no LLM provider is ready (see `doctor`); a broken upgrade cannot be fixed.',
      );
    }
    const router = new LlmRouter({
      providers,
      maxCallsPerRun: config.llm.maxCallsPerRun,
      // Successful calls already show up as agent steps; only trouble is worth a line.
      onEvent: (event) => {
        if (!event.ok) {
          console.log(`    llm: ${describeLlmEvent(event)}`);
        }
      },
      onWait: (event) =>
        console.log(
          `    llm: every provider is rate limited; waiting ${Math.ceil(event.waitMs / 1000)} s for ${event.providers.join(', ')}`,
        ),
    });
    const cache = await openCache({
      ...config.redis,
      onWarning: (message) => console.warn(`Warning: ${message}`),
    });

    try {
      await sweepContainers(docker);
      const target = parseTarget(repo);
      console.log(`Cloning ${target.label} ...`);
      const workspace = await createWorkspace(target, { workspaceDir: config.workspaceDir });
      try {
        console.log(
          `Repo:      ${target.label}, commit ${workspace.commit.slice(0, 7)} on ${workspace.branch}`,
        );
        const progress = (message: string) => console.log(`  ${message}`);

        console.log('\nScan:');
        const scan = await scanWorkspace(workspace.repoDir, {
          limits: config.sandbox,
          createSandbox: () =>
            Sandbox.create({ ...config.sandbox, docker, name: `scan-${target.label}` }),
          onProgress: progress,
        });
        const candidate = scan.upgrades.find((upgrade) => upgrade.name === packageName);
        if (candidate === undefined) {
          const skipped = scan.skipped.find((skip) => skip.name === packageName);
          console.error(
            skipped === undefined
              ? `\n${packageName} is not an outdated direct dependency of this repo.`
              : `\n${packageName} is skipped: ${skipped.reason}`,
          );
          process.exitCode = 1;
          return;
        }

        let analysis = null;
        if (candidate.bump === 'major') {
          console.log(`\nChangelog: ${candidate.name} ${candidate.from} → ${candidate.to}`);
          analysis = await analyzeUpgrade(candidate.name, candidate.from, candidate.to, {
            cache,
            router,
            source: new GitHubChangelogSource({ githubToken: config.github.token }),
            onProgress: progress,
          });
          console.log(
            `  ${analysis.breakingChanges.length} breaking change(s) listed` +
              (analysis.complete ? '' : ' (incomplete: some notes could not be read)'),
          );
        }

        console.log(`\nUpgrade: ${candidate.name} ${candidate.from} → ${candidate.to}`);
        const result = await upgradePackage(workspace.repoDir, candidate, {
          limits: config.sandbox,
          fixAgent: config.fixAgent,
          createSandbox: () =>
            Sandbox.create({ ...config.sandbox, docker, name: `upgrade-${candidate.name}` }),
          router,
          analysis,
          onProgress: progress,
          onAgentEvent: (event) => console.log(`  ${describeAgentEvent(event)}`),
        });

        console.log('');
        for (const line of describeUpgrade(result)) {
          console.log(line);
        }
        // The lockfile's diff is thousands of lines of hashes; the code diff is what matters.
        const codeFiles = result.files.filter(
          (file) => !/^(package-lock|npm-shrinkwrap)\.json$/.test(file),
        );
        const diff = await diffWorkspace(workspace.repoDir, codeFiles);
        if (diff !== '') {
          console.log('\nChanges (lockfile left out):', `\n${diff}`);
        }
        if (result.attemptedDiff !== null) {
          console.log('\nThe agent’s attempt (not kept):', `\n${result.attemptedDiff}`);
        }
        const stats = router.getStats();
        console.log(
          `\nLLM calls: ${stats.calls}, ${stats.inputTokens} input + ${stats.outputTokens} output tokens. Cache: ${cache.kind}.`,
        );
        if (options.keep === true) {
          console.log(`The clone, with these changes not committed: ${workspace.repoDir}`);
        }
        if (result.status === 'install-failed' || result.status === 'tampered') {
          process.exitCode = 1;
        }
      } finally {
        if (options.keep !== true) {
          await removeWorkspace(workspace);
        }
      }
    } catch (error) {
      if (
        !(error instanceof ScanError) &&
        !(error instanceof WorkspaceError) &&
        !(error instanceof SandboxError) &&
        !(error instanceof PackageNotFoundError)
      ) {
        throw error;
      }
      console.error(`\nUpgrade stopped: ${error.message}`);
      if (error instanceof ScanError && error.details !== null) {
        console.error(error.details.replace(/^/gm, '  '));
      }
      process.exitCode = 1;
    } finally {
      await cache.close();
    }
  });

program
  .command('doctor')
  .description('Check that your setup is valid: config, Docker, a sandbox smoke test, and Redis')
  .option('--skip-docker', 'only check the config, without talking to Docker or Redis')
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
    console.log((await checkRedis(config.redis)).line);
    if (!check.ok) {
      process.exitCode = 1;
    }
  });

await program.parseAsync();
