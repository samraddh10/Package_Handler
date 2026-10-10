import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../llm/tokens.js';
import {
  type NotesSection,
  type Release,
  sectionsFromReleases,
  selectSections,
  splitChangelog,
  versionFromHeading,
  versionFromTag,
} from './sections.js';
import { belongsToStep } from './steps.js';

/** Real changelogs, captured from GitHub on 2026-10-10. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/changelogs/${name}`, import.meta.url), 'utf8');
}

const expressStep = { from: '4.x', to: '5.x', notesUpTo: '5.0.0' };

describe('versionFromHeading', () => {
  it.each([
    ['5.0.0 / 2024-09-09', '5.0.0'],
    ['5.0.0-alpha.1', '5.0.0-alpha.1'],
    ['[15.0.0] (2026-05-29)', '15.0.0'],
    ['v3.0.0 - 2023-12-18', '3.0.0'],
    ['Version 2.1.0', '2.1.0'],
    ['express@5.0.0', '5.0.0'],
    ['@scope/pkg@1.2.3', '1.2.3'],
  ])('reads %s', (heading, version) => {
    expect(versionFromHeading(heading)).toBe(version);
  });

  it.each(['Bug fixes', 'Unreleased', 'Migrating to 5.0.0', '4.0.0.1', '2024-09-09'])(
    'ignores %s',
    (heading) => {
      expect(versionFromHeading(heading)).toBeNull();
    },
  );
});

describe('splitChangelog', () => {
  it('splits express’s History.md (setext headings) into one section per version', () => {
    const sections = splitChangelog(fixture('express-History.md'));
    const versions = sections.map((section) => section.version);

    expect(versions[0]).toBe('5.3.0');
    expect(versions).toContain('5.0.0-alpha.1');
    expect(versions).toContain('4.20.0');
    // The underline is not part of the body, and the body is the entry's text.
    const alpha1 = sections.find((section) => section.version === '5.0.0-alpha.1') as NotesSection;
    expect(alpha1.body.startsWith('This is the first Express 5.0 alpha release')).toBe(true);
    expect(alpha1.body).toContain('`app.del` - use `app.delete`');
  });

  it('splits a Keep a Changelog file (ATX headings with brackets)', () => {
    const sections = splitChangelog(fixture('commander-CHANGELOG.md'));
    expect(sections[0]?.version).toBe('15.0.0');
    expect(sections[1]?.version).toBe('15.0.0-0');
    // Subheadings such as "### Added" stay inside their version's section.
    expect(sections[0]?.body).toContain('### Migration Tips');
  });

  it('ignores headings inside code blocks and text before the first version', () => {
    const markdown = [
      '# Changelog',
      'intro text',
      '## 2.0.0',
      '```md',
      '## 9.9.9',
      '```',
      'real notes',
      '## 1.0.0',
      'first',
    ].join('\r\n');
    expect(splitChangelog(markdown)).toEqual([
      { version: '2.0.0', body: '```md\n## 9.9.9\n```\nreal notes' },
      { version: '1.0.0', body: 'first' },
    ]);
  });
});

describe('versionFromTag', () => {
  it('reads the usual tag styles', () => {
    expect(versionFromTag('v5.0.0', 'express', false)).toBe('5.0.0');
    expect(versionFromTag('5.0.0-beta.2', 'express', false)).toBe('5.0.0-beta.2');
    expect(versionFromTag('express@5.0.0', 'express', false)).toBe('5.0.0');
    expect(versionFromTag('@babel/core@7.0.0', '@babel/core', true)).toBe('7.0.0');
    expect(versionFromTag('core-v7.0.0', '@babel/core', true)).toBe('7.0.0');
  });

  it('rejects other packages’ tags, and bare tags in a monorepo', () => {
    expect(versionFromTag('react-dom@19.0.0', 'react', true)).toBeNull();
    expect(versionFromTag('v19.0.0', 'react', true)).toBeNull();
    expect(versionFromTag('nightly', 'react', false)).toBeNull();
  });
});

describe('sectionsFromReleases', () => {
  it('turns express’s releases page into sections, skipping drafts', () => {
    const releases = JSON.parse(fixture('express-releases-page1.json')) as Release[];
    const sections = sectionsFromReleases(
      [...releases, { tag_name: 'v9.9.9', name: null, body: 'draft', draft: true }],
      'express',
      false,
    );

    expect(sections.length).toBe(releases.length);
    expect(sections.map((section) => section.version)).toContain('5.0.0');
    expect(sections.some((section) => section.version === '9.9.9')).toBe(false);
    expect(sections.every((section) => !section.body.includes('\r'))).toBe(true);
  });
});

describe('selectSections', () => {
  it('keeps exactly the express 5.0.0 entries, oldest first, within 4K tokens', () => {
    const sections = splitChangelog(fixture('express-History.md'));
    const notes = selectSections(sections, (version) => belongsToStep(version, expressStep), 4000);

    expect(notes).not.toBeNull();
    expect(notes?.versions[0]).toBe('5.0.0-alpha.1');
    expect(notes?.versions.at(-1)).toBe('5.0.0');
    expect(notes?.versions).not.toContain('5.0.1');
    expect(notes?.versions).not.toContain('4.21.2');
    expect(notes?.trimmed).toBe(false);
    expect(estimateTokens(notes?.text ?? '')).toBeLessThanOrEqual(4000);
    // The removals the demo repo trips over are in there.
    expect(notes?.text).toContain('`app.del` - use `app.delete`');
    expect(notes?.text).toContain('req.param');
  });

  it('fills a tight budget with the breaking entries first and says what was left out', () => {
    const sections = splitChangelog(fixture('express-History.md'));
    const notes = selectSections(sections, (version) => belongsToStep(version, expressStep), 600);

    expect(notes?.trimmed).toBe(true);
    expect(estimateTokens(notes?.text ?? '')).toBeLessThanOrEqual(600);
    expect(notes?.text).toMatch(/breaking|remove/i);
    expect(notes?.text).toMatch(/left out to fit the size budget\]$/);
  });

  it('reduces a single oversized entry to its breaking lines', () => {
    const filler = Array.from({ length: 400 }, (_, index) => `* deps: thing-${index}@1.0.0`);
    const body = [...filler.slice(0, 200), '* removed `app.del()`', ...filler.slice(200)].join(
      '\n',
    );
    const notes = selectSections([{ version: '5.0.0', body }], () => true, 300);

    expect(notes?.text).toBe('## 5.0.0\n* removed `app.del()`');
    expect(notes?.trimmed).toBe(true);
  });

  it('returns null when no entry belongs to the step', () => {
    const sections = [{ version: '4.0.0', body: 'old' }];
    expect(
      selectSections(sections, (version) => belongsToStep(version, expressStep), 4000),
    ).toBeNull();
  });
});
