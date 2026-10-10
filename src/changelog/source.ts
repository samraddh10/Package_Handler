import { Octokit } from '@octokit/rest';
import {
  type NotesSection,
  type Release,
  sectionsFromReleases,
  splitChangelog,
} from './sections.js';

/**
 * Finding a package's release notes: npm registry → GitHub repo → a CHANGELOG
 * file, or the GitHub releases page when there is no usable file.
 *
 * The file is tried first, through raw.githubusercontent.com. That host serves
 * plain files and is not counted against GitHub's API limit, which is only 60
 * requests an hour without a token. Hand-written changelogs also tend to be
 * better: express's History.md lists every removed API for 5.0, while its
 * 5.0.0 release on GitHub is mostly a list of merged pull requests.
 */

/** A GitHub repository, and the package's folder inside it for monorepos. */
export interface RepoRef {
  owner: string;
  repo: string;
  /** e.g. "packages/core"; null when the package is the whole repo. */
  directory: string | null;
}

export interface PackageInfo {
  /** Every published version, or null if the registry list could not be read. */
  versions: string[] | null;
  /** Null when package.json names no GitHub repository. */
  repository: RepoRef | null;
  /** The target version's `engines.node`, e.g. ">= 18": a fact, unlike what notes say. */
  nodeEngine: string | null;
}

export interface FoundNotes {
  /** Where a human can read the same notes. */
  url: string;
  sections: NotesSection[];
}

/** What analyze.ts needs from the outside world; tests pass a fake. */
export interface ChangelogSource {
  packageInfo(name: string, version: string): Promise<PackageInfo>;
  /**
   * The first source that has entries for which `belongs` is true, or null
   * when there is none. Throws NotesUnavailableError when a lookup failed for
   * a reason that may pass (rate limit, network), so the miss is not cached.
   */
  findNotes(
    name: string,
    repository: RepoRef,
    belongs: (version: string) => boolean,
  ): Promise<FoundNotes | null>;
}

/** The package does not exist on npm (or that version does not). Not worth retrying. */
export class PackageNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageNotFoundError';
  }
}

/** A lookup failed for a reason that may pass: rate limit, timeout, network. */
export class NotesUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'NotesUnavailableError';
  }
}

/**
 * Reads the `repository` field of a package.json. It comes in many spellings:
 * "git+https://github.com/expressjs/express.git", "git://github.com/a/b",
 * "git@github.com:a/b.git", "github:a/b", or the bare shorthand "a/b".
 * Returns null for repositories not on GitHub.
 */
export function parseRepository(repository: unknown): RepoRef | null {
  let url: unknown = repository;
  let directory: string | null = null;
  if (typeof repository === 'object' && repository !== null) {
    url = (repository as { url?: unknown }).url;
    const dir = (repository as { directory?: unknown }).directory;
    directory =
      typeof dir === 'string' && dir.trim() !== '' ? dir.trim().replace(/^\.?\/+|\/+$/g, '') : null;
  }
  if (typeof url !== 'string') {
    return null;
  }

  const trimmed = url.trim();
  const shorthand = /^(?:github:)?([\w.-]+)\/([\w.-]+)$/.exec(trimmed);
  const full = /github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(trimmed);
  const match = full ?? shorthand;
  if (match?.[1] === undefined || match[2] === undefined) {
    return null;
  }
  return { owner: match[1], repo: match[2].replace(/\.git$/, ''), directory };
}

/** File names tried for a changelog, most common first. raw.githubusercontent.com is case-sensitive. */
export const CHANGELOG_FILE_NAMES = [
  'CHANGELOG.md',
  'History.md',
  'HISTORY.md',
  'CHANGES.md',
  'changelog.md',
  'RELEASES.md',
  'CHANGELOG',
];

/** Biggest changelog we read. The biggest real ones are a few hundred KB. */
const MAX_FILE_BYTES = 3 * 1024 * 1024;
/** GitHub returns at most 100 releases per page; three pages reach back years. */
const MAX_RELEASE_PAGES = 3;
const REQUEST_TIMEOUT_MS = 15_000;

/** The real source: registry.npmjs.org, raw.githubusercontent.com and the GitHub API. */
export class GitHubChangelogSource implements ChangelogSource {
  private readonly octokit: Octokit;
  private readonly fetch: typeof fetch;
  // Several steps (2 → 3, 3 → 4) read the same files: fetch each once per run,
  // and remember failures too, so one rate limit costs one request.
  private readonly files = new Map<string, Promise<FoundNotes | null>>();
  private readonly releases = new Map<string, Promise<FoundNotes | null>>();

  constructor(options: { githubToken?: string | undefined; fetch?: typeof fetch } = {}) {
    this.fetch = options.fetch ?? fetch;
    this.octokit = new Octokit({
      auth: options.githubToken,
      userAgent: 'upgrade-agent',
      request: { fetch: this.fetch },
      // Octokit logs failed requests to the console by default; we report them ourselves.
      log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    });
  }

  async packageInfo(name: string, version: string): Promise<PackageInfo> {
    const base = `https://registry.npmjs.org/${name.replace('/', '%2F')}`;
    // The version document is small and has the repository field; the
    // "abbreviated" document (what npm install reads) lists every version.
    const versionDoc = await this.getJson(`${base}/${version}`, `${name}@${version}`);
    let versions: string[] | null = null;
    try {
      const all = await this.getJson(base, name, 'application/vnd.npm.install-v1+json');
      const map = (all as { versions?: Record<string, unknown> }).versions;
      versions = map !== undefined ? Object.keys(map) : null;
    } catch (error) {
      if (!(error instanceof NotesUnavailableError)) {
        throw error;
      }
      // Without the list, steps are planned from the version numbers alone.
    }
    const doc = versionDoc as { repository?: unknown; engines?: { node?: unknown } };
    return {
      versions,
      repository: parseRepository(doc.repository),
      nodeEngine: typeof doc.engines?.node === 'string' ? doc.engines.node : null,
    };
  }

  async findNotes(
    name: string,
    repository: RepoRef,
    belongs: (version: string) => boolean,
  ): Promise<FoundNotes | null> {
    const key = `${repository.owner}/${repository.repo}/${repository.directory ?? ''}`;
    const problems: unknown[] = [];

    for (const [cache, load] of [
      [this.files, () => this.loadChangelogFile(repository)],
      [this.releases, () => this.loadReleases(name, repository)],
    ] as const) {
      let pending = cache.get(key);
      if (pending === undefined) {
        pending = load();
        cache.set(key, pending);
      }
      try {
        const notes = await pending;
        if (notes?.sections.some((section) => belongs(section.version))) {
          return notes;
        }
      } catch (error) {
        if (!(error instanceof NotesUnavailableError)) {
          throw error;
        }
        // The failure stays memoised: a rate limit will not lift a second
        // later, so the next step should not spend another request on it.
        problems.push(error);
      }
    }

    if (problems.length > 0) {
      // We could not look everywhere, so "no notes" would be a guess.
      throw problems[0];
    }
    return null;
  }

  /** The first changelog file found: in the package's folder first (monorepos), then the root. */
  private async loadChangelogFile(repository: RepoRef): Promise<FoundNotes | null> {
    const folders = repository.directory === null ? [''] : [`${repository.directory}/`, ''];
    for (const folder of folders) {
      for (const fileName of CHANGELOG_FILE_NAMES) {
        const path = `${folder}${fileName}`;
        const url = `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/HEAD/${path}`;
        const text = await this.getText(url);
        if (text === null) {
          continue;
        }
        const sections = splitChangelog(text);
        if (sections.length > 0) {
          return {
            url: `https://github.com/${repository.owner}/${repository.repo}/blob/HEAD/${path}`,
            sections,
          };
        }
      }
    }
    return null;
  }

  /** The repository's GitHub releases, newest first, as sections. Costs 1-3 API requests. */
  private async loadReleases(name: string, repository: RepoRef): Promise<FoundNotes | null> {
    const releases: Release[] = [];
    try {
      for (let page = 1; page <= MAX_RELEASE_PAGES; page++) {
        const response = await this.octokit.rest.repos.listReleases({
          owner: repository.owner,
          repo: repository.repo,
          per_page: 100,
          page,
          request: { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
        });
        releases.push(...response.data);
        if (response.data.length < 100) {
          break;
        }
      }
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (status === 404) {
        return null;
      }
      if (status === 403 || status === 429) {
        throw new NotesUnavailableError(
          'GitHub API rate limit reached (60 requests an hour without a token); set GITHUB_TOKEN in .env to raise it',
          { cause: error },
        );
      }
      throw new NotesUnavailableError(`GitHub releases lookup failed: ${messageOf(error)}`, {
        cause: error,
      });
    }

    const sections = sectionsFromReleases(releases, name, repository.directory !== null);
    if (sections.length === 0) {
      return null;
    }
    return { url: `https://github.com/${repository.owner}/${repository.repo}/releases`, sections };
  }

  /** GETs a URL as text; null on 404. Anything else that is not a 200 is a temporary failure. */
  private async getText(url: string): Promise<string | null> {
    let response: Response;
    try {
      response = await this.fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
      throw new NotesUnavailableError(`could not reach ${new URL(url).host}: ${messageOf(error)}`, {
        cause: error,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotesUnavailableError(`${new URL(url).host} answered HTTP ${response.status}`);
    }
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_FILE_BYTES) {
      await response.body?.cancel();
      return null;
    }
    const text = await response.text();
    return text.length > MAX_FILE_BYTES ? null : text;
  }

  private async getJson(url: string, label: string, accept = 'application/json'): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetch(url, {
        headers: { accept },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new NotesUnavailableError(`could not reach the npm registry: ${messageOf(error)}`, {
        cause: error,
      });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new PackageNotFoundError(`${label} is not on the npm registry`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new NotesUnavailableError(
        `the npm registry answered HTTP ${response.status} for ${label}`,
      );
    }
    return response.json();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
