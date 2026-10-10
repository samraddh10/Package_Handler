import { APICallError } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { MemoryCache } from '../cache/cache.js';
import { LlmRouter } from '../llm/router.js';
import {
  ANALYSIS_TTL_SEC,
  analyzeUpgrade,
  cacheKey,
  describeAnalysis,
  NO_NOTES_TTL_SEC,
} from './analyze.js';
import type { ChangelogAnalysis } from './schema.js';
import type { NotesSection } from './sections.js';
import {
  type ChangelogSource,
  type FoundNotes,
  NotesUnavailableError,
  type RepoRef,
} from './source.js';

/**
 * The whole changelog pipeline with fakes: an in-memory source, a MemoryCache
 * that records TTLs, and a router over a mock model that records every prompt.
 */

const repo: RepoRef = { owner: 'expressjs', repo: 'express', directory: null };

function analysisJson(overrides: Partial<ChangelogAnalysis> = {}): string {
  const analysis: ChangelogAnalysis = {
    breakingChanges: [
      {
        title: 'app.del() removed',
        details: 'The alias is gone.',
        affectedApis: ['app.del()'],
        migration: 'Use app.delete()',
      },
    ],
    runtimeRequirement: 'Node.js >= 18',
    summary: 'Express 5 removes old APIs.',
    notesQuality: 'clear',
    ...overrides,
  };
  return JSON.stringify(analysis);
}

/** A source with fixed versions and notes; counts lookups. */
function fakeSource(options: {
  versions?: string[];
  sections?: NotesSection[];
  repository?: RepoRef | null;
  unavailable?: boolean;
}): ChangelogSource & { lookups: number } {
  const source = {
    lookups: 0,
    async packageInfo() {
      return {
        versions: options.versions ?? ['4.21.2', '5.0.0-alpha.1', '5.0.0', '5.3.0'],
        repository: options.repository === undefined ? repo : options.repository,
        nodeEngine: '>= 18',
      };
    },
    async findNotes(_name: string, _repo: RepoRef, belongs: (version: string) => boolean) {
      source.lookups++;
      if (options.unavailable === true) {
        throw new NotesUnavailableError('GitHub API rate limit reached');
      }
      const sections = (options.sections ?? []).filter((section) => belongs(section.version));
      const found: FoundNotes = {
        url: 'https://example.test/History.md',
        sections: options.sections ?? [],
      };
      return sections.length > 0 ? found : null;
    },
  };
  return source;
}

/** A router over a mock model that answers `answers` in turn and records each prompt. */
function fakeRouter(answers: Array<string | Error>) {
  const prompts: string[] = [];
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      const answer = answers[Math.min(call++, answers.length - 1)] as string | Error;
      if (answer instanceof Error) {
        throw answer;
      }
      return {
        content: [{ type: 'text', text: answer }],
        finishReason: { unified: 'stop', raw: undefined },
        usage: {
          inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 50, text: 50, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  const router = new LlmRouter({
    providers: [{ name: 'gemini', modelId: 'mock', model, maxInputTokens: 100_000 }],
    maxCallsPerRun: 60,
    sleep: async () => {},
  });
  return { router, prompts };
}

class RecordingCache extends MemoryCache {
  readonly ttls = new Map<string, number>();
  override async set(key: string, value: string, ttlSec: number) {
    this.ttls.set(key, ttlSec);
    await super.set(key, value, ttlSec);
  }
}

const expressSections: NotesSection[] = [
  { version: '5.3.0', body: 'later minor: should not be sent' },
  { version: '5.0.0', body: '* breaking: res.status() accepts only integers' },
  { version: '5.0.0-alpha.1', body: '* remove: `app.del` - use `app.delete`' },
  { version: '4.20.0', body: 'old: should not be sent' },
];

describe('analyzeUpgrade', () => {
  it('analyzes a major step once, then answers from the cache with no LLM call', async () => {
    const cache = new RecordingCache();
    const source = fakeSource({ sections: expressSections });
    const { router, prompts } = fakeRouter([analysisJson()]);
    const deps = { cache, router, source };

    const first = await analyzeUpgrade('express', '4.21.2', '5.3.0', deps);

    expect(first.steps).toHaveLength(1);
    expect(first.steps[0]).toMatchObject({
      status: 'analyzed',
      fromCache: false,
      provider: 'gemini',
      notesVersions: ['5.0.0-alpha.1', '5.0.0'],
      cacheKey: 'changelog:v1:express@4.x->5.x',
    });
    expect(first.breakingChanges[0]).toMatchObject({
      title: 'app.del() removed',
      introducedIn: '5.x',
    });
    expect(first.complete).toBe(true);
    expect(cache.ttls.get('changelog:v1:express@4.x->5.x')).toBe(ANALYSIS_TTL_SEC);

    // Only the 5.0.0 entries went to the model, oldest first.
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0] as string;
    expect(prompt).toContain('app.del');
    expect(prompt).not.toContain('should not be sent');
    expect(prompt.indexOf('5.0.0-alpha.1')).toBeLessThan(prompt.indexOf('## 5.0.0\\n'));

    const second = await analyzeUpgrade('express', '4.18.0', '5.1.0', deps);

    expect(prompts).toHaveLength(1);
    expect(source.lookups).toBe(1);
    expect(second.steps[0]?.fromCache).toBe(true);
    expect(second.breakingChanges).toEqual(first.breakingChanges);
  });

  it('analyzes each major of a multi-major jump and merges them', async () => {
    const source = fakeSource({
      versions: ['2.30.0', '3.0.0', '3.6.0', '4.0.0', '4.1.0'],
      sections: [
        { version: '4.0.0', body: 'removed CommonJS default export' },
        { version: '3.0.0', body: 'removed default export' },
      ],
    });
    const { router, prompts } = fakeRouter([
      analysisJson({ runtimeRequirement: null, summary: 'three' }),
      analysisJson({ runtimeRequirement: 'Node.js >= 18', summary: 'four' }),
    ]);

    const result = await analyzeUpgrade('date-fns', '2.30.0', '4.1.0', {
      cache: new MemoryCache(),
      router,
      source,
    });

    expect(prompts).toHaveLength(2);
    expect(result.steps.map((step) => step.cacheKey)).toEqual([
      'changelog:v1:date-fns@2.x->3.x',
      'changelog:v1:date-fns@3.x->4.x',
    ]);
    expect(result.breakingChanges.map((change) => change.introducedIn)).toEqual(['3.x', '4.x']);
    expect(result.runtimeRequirement).toBe('Node.js >= 18');
    expect(result.summary).toBe('3.x: three\n4.x: four');
  });

  it('caches "no notes" for a day only, and does not look again while it lasts', async () => {
    const cache = new RecordingCache();
    const source = fakeSource({ sections: [] });
    const { router, prompts } = fakeRouter([analysisJson()]);

    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', { cache, router, source });
    await analyzeUpgrade('express', '4.21.2', '5.3.0', { cache, router, source });

    expect(result.steps[0]?.status).toBe('no-notes');
    expect(result.complete).toBe(false);
    expect(cache.ttls.get('changelog:v1:express@4.x->5.x')).toBe(NO_NOTES_TTL_SEC);
    expect(source.lookups).toBe(1);
    expect(prompts).toHaveLength(0);
  });

  it('does not cache a lookup that failed for a temporary reason', async () => {
    const cache = new RecordingCache();
    const { router } = fakeRouter([analysisJson()]);

    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', {
      cache,
      router,
      source: fakeSource({ unavailable: true }),
    });

    expect(result.steps[0]).toMatchObject({ status: 'notes-unavailable' });
    expect(result.steps[0]?.problem).toMatch(/rate limit/);
    expect(cache.ttls.size).toBe(0);
  });

  it('degrades to "unknown" without caching when no LLM can answer', async () => {
    const cache = new RecordingCache();
    const unauthorized = new APICallError({
      message: 'bad key',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode: 401,
    });
    const { router } = fakeRouter([unauthorized]);

    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', {
      cache,
      router,
      source: fakeSource({ sections: expressSections }),
    });

    expect(result.steps[0]?.status).toBe('llm-unavailable');
    expect(result.breakingChanges).toEqual([]);
    expect(cache.ttls.size).toBe(0);
    expect(describeAnalysis(result)[0]).toMatch(
      /^4\.x → 5\.x: breaking changes unknown \(every LLM provider failed or was skipped: gemini: auth \(401\): bad key\)$/,
    );
  });

  it('treats a package with no GitHub repository as having no notes', async () => {
    const { router } = fakeRouter([analysisJson()]);
    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', {
      cache: new MemoryCache(),
      router,
      source: fakeSource({ repository: null }),
    });
    expect(result.steps[0]).toMatchObject({ status: 'no-notes' });
  });

  it('ignores a cache entry written by an older schema', async () => {
    const cache = new MemoryCache();
    const step = { from: '4.x', to: '5.x', notesUpTo: '5.0.0' };
    await cache.set(cacheKey('express', step), JSON.stringify({ schemaVersion: 0 }), 60);
    const { router, prompts } = fakeRouter([analysisJson()]);

    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', {
      cache,
      router,
      source: fakeSource({ sections: expressSections }),
    });

    expect(result.steps[0]?.fromCache).toBe(false);
    expect(prompts).toHaveLength(1);
  });

  it('has nothing to do for a minor bump', async () => {
    const { router, prompts } = fakeRouter([analysisJson()]);
    const result = await analyzeUpgrade('express', '4.17.0', '4.21.2', {
      cache: new MemoryCache(),
      router,
      source: fakeSource({ sections: expressSections }),
    });

    expect(result.steps).toEqual([]);
    expect(prompts).toHaveLength(0);
    expect(describeAnalysis(result)[0]).toMatch(/does not cross a major version/);
  });
});

describe('describeAnalysis', () => {
  it('lists each breaking change with its APIs and fix', async () => {
    const { router } = fakeRouter([analysisJson()]);
    const result = await analyzeUpgrade('express', '4.21.2', '5.3.0', {
      cache: new MemoryCache(),
      router,
      source: fakeSource({ sections: expressSections }),
    });

    const text = describeAnalysis(result).join('\n');
    expect(text).toContain('4.x → 5.x: analyzed by gemini/mock, notes quality clear');
    expect(text).toContain('Breaking changes (1):');
    expect(text).toContain('  1. app.del() removed');
    expect(text).toContain('     APIs: app.del()');
    expect(text).toContain('     Fix: Use app.delete()');
    expect(text).toContain('Node.js: >= 18 (engines field of express 5.3.0)');
    expect(text).toContain('Runtime per the notes: Node.js >= 18');
  });
});
