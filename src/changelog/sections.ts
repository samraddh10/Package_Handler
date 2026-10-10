import semver from 'semver';
import { estimateTokens, trimToTokens } from '../llm/tokens.js';

/**
 * Cutting release notes down to the part that matters.
 *
 * express's History.md is 120 KB (~30K tokens) and covers ten years of
 * releases. For a 4 → 5 upgrade only the 5.0.0 entries matter, about 2K
 * tokens. Plain code finds those entries; the LLM only reads what is left.
 * That is cheaper, fits free-tier limits, and the model cannot be confused by
 * a breaking change from some other major.
 */

/** One version's entry in a changelog, or one GitHub release. */
export interface NotesSection {
  /** A clean semver version, e.g. "5.0.0-alpha.1". */
  version: string;
  body: string;
}

/**
 * Pulls the version out of a changelog heading, or returns null when the
 * heading is not a version heading ("Bug fixes", "Unreleased").
 *
 * The version must come first, optionally after "[", "v", "Version",
 * "Release" or "<package>@", which covers the common styles:
 * `5.0.0 / 2024-09-09`, `## [15.0.0] (2026-05-29)`, `## v3.0.0 - 2023-12-18`,
 * `# express@5.0.0`. A version mentioned later ("Migrating to 5.0.0") does not
 * count, so prose headings inside an entry do not split it.
 */
export function versionFromHeading(heading: string): string | null {
  const match =
    /^\s*\[?\s*(?:(?:version|release)\s+)?(?:@?[\w./-]+@)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?![\w.])/i.exec(
      heading,
    );
  return match?.[1] !== undefined ? semver.valid(match[1]) : null;
}

/**
 * Splits a Markdown changelog into one section per version heading. Both
 * heading styles count: `## 5.0.0` (ATX) and a line underlined with `===` or
 * `---` (setext, which express uses). Text before the first version heading
 * (a title, an "Unreleased" block) is dropped.
 */
export function splitChangelog(markdown: string): NotesSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: NotesSection[] = [];
  let current: { version: string; lines: string[] } | null = null;
  let inCodeBlock = false;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] as string;
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
    }

    let version: string | null = null;
    let skipNext = false;
    if (!inCodeBlock) {
      const atx = /^#{1,6}\s+(.*)$/.exec(line);
      const next = lines[index + 1];
      if (atx?.[1] !== undefined) {
        version = versionFromHeading(atx[1]);
      } else if (
        line.trim() !== '' &&
        next !== undefined &&
        /^(=+|-+)\s*$/.test(next) &&
        next.trim().length >= 3
      ) {
        version = versionFromHeading(line);
        skipNext = version !== null;
      }
    }

    if (version !== null) {
      if (current !== null) {
        sections.push(finish(current));
      }
      current = { version, lines: [] };
      if (skipNext) {
        index++;
      }
    } else if (current !== null) {
      current.lines.push(line);
    }
  }
  if (current !== null) {
    sections.push(finish(current));
  }
  return sections;
}

function finish(section: { version: string; lines: string[] }): NotesSection {
  return { version: section.version, body: section.lines.join('\n').trim() };
}

/** A GitHub release, reduced to the fields we read. */
export interface Release {
  tag_name: string;
  name: string | null;
  body?: string | null | undefined;
  draft: boolean;
}

/**
 * Pulls the version out of a release tag: `v5.0.0`, `5.0.0`, `express@5.0.0`,
 * `@scope/pkg@1.2.3`, `pkg-v1.2.3`. In a monorepo many packages share one
 * releases page, so there the tag must name this package; a bare `v1.2.3`
 * could belong to any of them.
 */
export function versionFromTag(tag: string, packageName: string, monorepo: boolean): string | null {
  const match = /^(.*?)[@-]?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(tag.trim());
  if (match === null) {
    return null;
  }
  const prefix = (match[1] ?? '').replace(/[@-]$/, '');
  const version = semver.valid(match[2] ?? '');
  if (version === null) {
    return null;
  }
  if (prefix === '' || prefix === 'v') {
    return monorepo ? null : version;
  }
  const shortName = packageName.split('/').pop();
  return prefix === packageName || prefix === shortName ? version : null;
}

/** One section per published release whose tag names a version of this package. */
export function sectionsFromReleases(
  releases: Release[],
  packageName: string,
  monorepo: boolean,
): NotesSection[] {
  const sections: NotesSection[] = [];
  for (const release of releases) {
    const version = release.draft ? null : versionFromTag(release.tag_name, packageName, monorepo);
    if (version !== null) {
      sections.push({ version, body: (release.body ?? '').replace(/\r\n?/g, '\n').trim() });
    }
  }
  return sections;
}

/** Words that mark a line or a section as likely to describe a breaking change. */
const BREAKING_WORDS =
  /\b(breaking|removed?|renamed?|deprecat\w*|requires?|dropped|drop support|no longer|migrat\w*|instead)\b/i;

export interface SelectedNotes {
  text: string;
  /** The versions included, oldest first. */
  versions: string[];
  /** True when something had to be cut to fit the budget. */
  trimmed: boolean;
}

/**
 * Keeps the sections that belong to the step, oldest first, within
 * `maxTokens`. When they do not all fit, the sections that mention breaking
 * words are kept first, and a section too big to fit whole is reduced to its
 * breaking lines. Returns null when no section belongs to the step.
 */
export function selectSections(
  sections: NotesSection[],
  belongs: (version: string) => boolean,
  maxTokens: number,
): SelectedNotes | null {
  // A version can appear twice (a changelog listing a release twice); keep the longer entry.
  const byVersion = new Map<string, NotesSection>();
  for (const section of sections) {
    if (!belongs(section.version)) {
      continue;
    }
    const existing = byVersion.get(section.version);
    if (existing === undefined || section.body.length > existing.body.length) {
      byVersion.set(section.version, section);
    }
  }
  const chosen = [...byVersion.values()].sort((a, b) => semver.compare(a.version, b.version));
  if (chosen.length === 0) {
    return null;
  }

  const render = (section: NotesSection, body = section.body) =>
    `## ${section.version}\n${body === '' ? '(no notes)' : body}`;

  const whole = chosen.map((section) => render(section)).join('\n\n');
  if (estimateTokens(whole) <= maxTokens) {
    return { text: whole, versions: chosen.map((section) => section.version), trimmed: false };
  }

  // Too big: fill the budget in priority order, then print in version order.
  const priority = [...chosen].sort(
    (a, b) => Number(BREAKING_WORDS.test(b.body)) - Number(BREAKING_WORDS.test(a.body)),
  );
  const kept = new Map<string, string>();
  let left = maxTokens;
  for (const section of priority) {
    const full = render(section);
    if (estimateTokens(full) + 2 <= left) {
      kept.set(section.version, full);
      left -= estimateTokens(full) + 2;
      continue;
    }
    if (left < 150) {
      continue;
    }
    const breakingLines = section.body
      .split('\n')
      .filter((line) => BREAKING_WORDS.test(line))
      .join('\n');
    if (breakingLines === '') {
      continue;
    }
    const reduced = trimToTokens(render(section, breakingLines), left - 2);
    kept.set(section.version, reduced);
    left -= estimateTokens(reduced) + 2;
  }

  const included = chosen.filter((section) => kept.has(section.version));
  const omitted = chosen.length - included.length;
  let text = included.map((section) => kept.get(section.version) as string).join('\n\n');
  if (omitted > 0) {
    text += `\n\n[${omitted} more ${omitted === 1 ? 'entry' : 'entries'} left out to fit the size budget]`;
  }
  return { text, versions: included.map((section) => section.version), trimmed: true };
}
