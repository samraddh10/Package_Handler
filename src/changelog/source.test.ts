import { describe, expect, it } from 'vitest';
import {
  GitHubChangelogSource,
  NotesUnavailableError,
  PackageNotFoundError,
  parseRepository,
} from './source.js';

describe('parseRepository', () => {
  it.each([
    ['git+https://github.com/expressjs/express.git', 'expressjs', 'express'],
    ['https://github.com/date-fns/date-fns', 'date-fns', 'date-fns'],
    ['git://github.com/tj/commander.js.git', 'tj', 'commander.js'],
    ['git@github.com:chalk/chalk.git', 'chalk', 'chalk'],
    ['github:lodash/lodash', 'lodash', 'lodash'],
    ['lodash/lodash', 'lodash', 'lodash'],
    ['https://github.com/a/b/tree/main/packages/c', 'a', 'b'],
  ])('reads %s', (url, owner, repo) => {
    expect(parseRepository(url)).toEqual({ owner, repo, directory: null });
  });

  it('keeps the monorepo directory from the object form', () => {
    expect(
      parseRepository({
        type: 'git',
        url: 'https://github.com/babel/babel.git',
        directory: './packages/babel-core/',
      }),
    ).toEqual({ owner: 'babel', repo: 'babel', directory: 'packages/babel-core' });
  });

  it('returns null for missing or non-GitHub repositories', () => {
    expect(parseRepository(undefined)).toBeNull();
    expect(parseRepository({ type: 'git' })).toBeNull();
    expect(parseRepository('https://gitlab.com/a/b.git')).toBeNull();
  });
});

/**
 * A fake `fetch` that answers from a table of URL prefixes, and records every
 * URL asked for. Octokit is given the same fetch, so GitHub API calls go
 * through it too.
 */
function fakeFetch(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const fetchFn = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    for (const [prefix, respond] of Object.entries(routes)) {
      if (url.startsWith(prefix)) {
        return respond();
      }
    }
    return new Response('Not Found', { status: 404 });
  }) as typeof fetch;
  return { fetchFn, requested };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const repo = { owner: 'acme', repo: 'widget', directory: null };
const raw = 'https://raw.githubusercontent.com/acme/widget/HEAD/';
const releasesApi = 'https://api.github.com/repos/acme/widget/releases';
const isFive = (version: string) => version.startsWith('5.');

describe('GitHubChangelogSource', () => {
  it('reads versions and repository from the registry', async () => {
    const { fetchFn } = fakeFetch({
      'https://registry.npmjs.org/widget/5.0.0': () =>
        json({
          repository: { type: 'git', url: 'git+https://github.com/acme/widget.git' },
          engines: { node: '>= 18' },
        }),
      'https://registry.npmjs.org/widget': () => json({ versions: { '4.0.0': {}, '5.0.0': {} } }),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    expect(await source.packageInfo('widget', '5.0.0')).toEqual({
      versions: ['4.0.0', '5.0.0'],
      repository: repo,
      nodeEngine: '>= 18',
    });
  });

  it('reports a package missing from npm as PackageNotFoundError', async () => {
    const source = new GitHubChangelogSource({ fetch: fakeFetch({}).fetchFn });
    await expect(source.packageInfo('no-such-pkg', '1.0.0')).rejects.toBeInstanceOf(
      PackageNotFoundError,
    );
  });

  it('prefers a changelog file and never calls the GitHub API when it has the version', async () => {
    const { fetchFn, requested } = fakeFetch({
      [`${raw}History.md`]: () => new Response('5.0.0\n=====\n* remove `app.del`\n'),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    const notes = await source.findNotes('widget', repo, isFive);

    expect(notes?.url).toBe('https://github.com/acme/widget/blob/HEAD/History.md');
    expect(notes?.sections).toEqual([{ version: '5.0.0', body: '* remove `app.del`' }]);
    expect(requested.some((url) => url.startsWith('https://api.github.com'))).toBe(false);
  });

  it('falls back to GitHub releases when no file covers the step', async () => {
    const { fetchFn } = fakeFetch({
      [`${raw}CHANGELOG.md`]: () => new Response('## 4.0.0\nold only\n'),
      [releasesApi]: () =>
        json([{ tag_name: 'v5.0.0', name: 'v5', body: 'Breaking: x', draft: false }]),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    const notes = await source.findNotes('widget', repo, isFive);

    expect(notes?.url).toBe('https://github.com/acme/widget/releases');
    expect(notes?.sections).toEqual([{ version: '5.0.0', body: 'Breaking: x' }]);
  });

  it('returns null when nothing anywhere covers the step', async () => {
    const { fetchFn } = fakeFetch({ [releasesApi]: () => json([]) });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    expect(await source.findNotes('widget', repo, isFive)).toBeNull();
  });

  it('throws NotesUnavailableError on a rate limit instead of claiming there are no notes', async () => {
    const { fetchFn } = fakeFetch({
      [releasesApi]: () => json({ message: 'API rate limit exceeded' }, 403),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    const error = await source.findNotes('widget', repo, isFive).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotesUnavailableError);
    expect((error as Error).message).toMatch(/GITHUB_TOKEN/);
  });

  it('does not ask GitHub again in the same run after a rate limit', async () => {
    const { fetchFn, requested } = fakeFetch({
      [releasesApi]: () => json({ message: 'API rate limit exceeded' }, 403),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    await expect(source.findNotes('widget', repo, isFive)).rejects.toThrow(NotesUnavailableError);
    await expect(source.findNotes('widget', repo, () => true)).rejects.toThrow(
      NotesUnavailableError,
    );

    expect(requested.filter((url) => url.startsWith(releasesApi))).toHaveLength(1);
  });

  it('looks in a monorepo package’s folder before the root', async () => {
    const { fetchFn, requested } = fakeFetch({
      [`${raw}packages/core/CHANGELOG.md`]: () => new Response('## 5.0.0\ncore notes\n'),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    const notes = await source.findNotes(
      '@acme/core',
      { ...repo, directory: 'packages/core' },
      isFive,
    );

    expect(notes?.sections[0]?.body).toBe('core notes');
    expect(requested[0]).toBe(`${raw}packages/core/CHANGELOG.md`);
  });

  it('fetches each source once even when several steps ask', async () => {
    const { fetchFn, requested } = fakeFetch({
      [`${raw}CHANGELOG.md`]: () => new Response('## 4.0.0\nfour\n## 5.0.0\nfive\n'),
    });
    const source = new GitHubChangelogSource({ fetch: fetchFn });

    await source.findNotes('widget', repo, isFive);
    await source.findNotes('widget', repo, (version) => version.startsWith('4.'));

    expect(requested.filter((url) => url === `${raw}CHANGELOG.md`)).toHaveLength(1);
  });
});
