import { describe, expect, it } from 'vitest';
import { selectSections } from '../../src/changelog/sections.js';
import {
  GitHubChangelogSource,
  NotesUnavailableError,
  PackageNotFoundError,
} from '../../src/changelog/source.js';
import { belongsToStep, planSteps } from '../../src/changelog/steps.js';
import { loadEnvFile, parseConfig } from '../../src/config.js';

/**
 * Finding release notes against the real npm registry and GitHub. Needs
 * internet access. The releases test uses GITHUB_TOKEN when it is set; without
 * one, GitHub allows 60 API requests an hour per IP address, so that test is
 * skipped (not failed) when the limit is used up.
 */

loadEnvFile();
const config = parseConfig(process.env);
const source = new GitHubChangelogSource({ githubToken: config.github.token });

describe('changelog source, live', () => {
  it('finds express 4 → 5 in History.md, without using the GitHub API', async () => {
    const info = await source.packageInfo('express', '5.3.0');
    expect(info.repository).toEqual({ owner: 'expressjs', repo: 'express', directory: null });
    expect(info.nodeEngine).toMatch(/18/);
    expect(info.versions).toContain('5.0.0-alpha.1');

    const [step] = planSteps('4.21.2', '5.3.0', info.versions);
    expect(step).toEqual({ from: '4.x', to: '5.x', notesUpTo: '5.0.0' });
    if (step === undefined || info.repository === null) {
      return;
    }
    const belongs = (version: string) => belongsToStep(version, step);
    const found = await source.findNotes('express', info.repository, belongs);

    expect(found?.url).toBe('https://github.com/expressjs/express/blob/HEAD/History.md');
    const notes = selectSections(found?.sections ?? [], belongs, 4000);
    expect(notes?.versions.at(-1)).toBe('5.0.0');
    expect(notes?.text).toContain('app.del');
  });

  it('falls back to GitHub releases for chalk, which has no changelog file', async (context) => {
    const info = await source.packageInfo('chalk', '5.0.0');
    const step = planSteps('4.1.2', '5.0.0', info.versions)[0];
    if (step === undefined || info.repository === null) {
      throw new Error('expected one step and a repository');
    }
    const belongs = (version: string) => belongsToStep(version, step);

    try {
      const found = await source.findNotes('chalk', info.repository, belongs);
      expect(found?.url).toBe('https://github.com/chalk/chalk/releases');
      expect(found?.sections.some((section) => section.version === '5.0.0')).toBe(true);
    } catch (error) {
      if (error instanceof NotesUnavailableError && config.github.token === undefined) {
        context.skip('GitHub API rate limit used up and no GITHUB_TOKEN set');
      }
      throw error;
    }
  });

  it('reports a package that does not exist', async () => {
    await expect(
      source.packageInfo('this-package-does-not-exist-upgrade-agent-test', '1.0.0'),
    ).rejects.toBeInstanceOf(PackageNotFoundError);
  });
});
