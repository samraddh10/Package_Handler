import { z } from 'zod';

/**
 * The shape of a changelog analysis.
 *
 * `ChangelogAnalysis` is the only thing the LLM fills in. It is kept flat, with
 * every field required and `nullable()` instead of optional, because that is
 * the subset of JSON Schema that Gemini, Groq and OpenRouter all accept in
 * structured-output mode. The `.describe()` texts are sent to the model as part
 * of the schema, so they double as field-by-field instructions.
 *
 * Facts we already know (package, versions, where the notes came from, which
 * model answered) are added by code, never asked of the model: it cannot get
 * them wrong if it is never asked.
 */

export const BreakingChange = z.object({
  title: z.string().describe('Short name, e.g. "req.param() removed"'),
  details: z.string().describe('What changed and how it breaks old code (1-2 sentences)'),
  affectedApis: z
    .array(z.string())
    .describe('Exact functions/options/imports/CLI flags, e.g. "app.del()"'),
  migration: z.string().nullable().describe('How to update code, if the notes say; else null'),
});
export type BreakingChange = z.infer<typeof BreakingChange>;

export const ChangelogAnalysis = z.object({
  breakingChanges: z
    .array(BreakingChange)
    .describe('Only changes that can break existing code; empty if none'),
  runtimeRequirement: z.string().nullable().describe('e.g. "Node.js >= 18", or null'),
  summary: z.string().describe('2-3 plain sentences for a PR description'),
  notesQuality: z
    .enum(['clear', 'partial', 'unclear'])
    .describe('How clearly the notes describe breaking changes'),
});
export type ChangelogAnalysis = z.infer<typeof ChangelogAnalysis>;

/** Bump when the cached shape changes, so old entries are ignored instead of misread. */
export const CACHE_SCHEMA_VERSION = 1;

/**
 * What is cached per major step (e.g. express 4.x → 5.x). A "no notes found"
 * result is cached too, for a shorter time, so a package without a changelog
 * does not cost a GitHub lookup on every run.
 */
export const CachedStep = z.object({
  schemaVersion: z.literal(CACHE_SCHEMA_VERSION),
  status: z.enum(['analyzed', 'no-notes']),
  analysis: ChangelogAnalysis.nullable(),
  sourceUrl: z.string().nullable(),
  /** The versions whose notes were sent to the model, oldest first. */
  notesVersions: z.array(z.string()),
  provider: z.string().nullable(),
  model: z.string().nullable(),
  analyzedAt: z.string(),
});
export type CachedStep = z.infer<typeof CachedStep>;
