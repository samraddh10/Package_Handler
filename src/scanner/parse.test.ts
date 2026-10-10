import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { NpmOutputError, parseAudit, parseOutdated, summarizeNpmError } from './parse.js';

/** Output captured from real npm runs on the demo repos, inside the sandbox. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../tests/fixtures/npm/${name}`, import.meta.url), 'utf8');
}

describe('parseOutdated', () => {
  it('reads every outdated package with its three versions', () => {
    const outdated = parseOutdated(fixture('outdated-demo-express-api.json'));

    expect(outdated.map((pkg) => pkg.name)).toEqual(['cors', 'express', 'morgan', 'supertest']);
    expect(outdated).toContainEqual({
      name: 'express',
      current: '4.21.2',
      wanted: '4.22.3',
      latest: '5.3.0',
    });
  });

  it('returns nothing when nothing is outdated', () => {
    expect(parseOutdated('{}\n')).toEqual([]);
  });

  it('records a package that is not installed with current: null', () => {
    const outdated = parseOutdated('{"fsevents": {"wanted": "2.3.3", "latest": "2.3.3"}}');

    expect(outdated).toEqual([
      { name: 'fsevents', current: null, wanted: '2.3.3', latest: '2.3.3' },
    ]);
  });

  it('takes the first entry when npm lists a package once per dependent', () => {
    const json = JSON.stringify({
      lodash: [
        { current: '4.17.20', wanted: '4.18.1', latest: '4.18.1', dependent: 'a' },
        { current: '4.17.20', wanted: '4.18.1', latest: '4.18.1', dependent: 'b' },
      ],
    });

    expect(parseOutdated(json)).toEqual([
      { name: 'lodash', current: '4.17.20', wanted: '4.18.1', latest: '4.18.1' },
    ]);
  });

  it('does not mistake a package called "error" for an npm error', () => {
    const json = '{"error": {"current": "7.0.0", "wanted": "7.2.1", "latest": "10.4.0"}}';

    expect(parseOutdated(json)[0]?.name).toBe('error');
  });

  it("turns npm's own error report into an exception", () => {
    const json = '{"error": {"code": "ENOTFOUND", "summary": "request to registry failed"}}';

    expect(() => parseOutdated(json)).toThrow(/npm outdated failed: request to registry failed/);
  });

  it('refuses output that is empty, not JSON, or the wrong shape', () => {
    expect(() => parseOutdated('')).toThrow(NpmOutputError);
    expect(() => parseOutdated('npm warn something')).toThrow(/not JSON/);
    expect(() => parseOutdated('{"express": {"current": "4.21.2"}}')).toThrow(
      /shape this version does not understand \(express/,
    );
  });
});

describe('parseAudit', () => {
  it('finds a direct dependency with its own advisories, worst first', () => {
    const report = parseAudit(fixture('audit-demo-utils-lib.json'));

    expect(report.findings).toHaveLength(1);
    const [lodash] = report.findings;
    expect(lodash).toMatchObject({
      name: 'lodash',
      severity: 'high',
      vulnerableRange: '<=4.17.23',
    });
    expect(lodash?.advisories).toHaveLength(5);
    expect(lodash?.advisories[0]).toMatchObject({ id: 'GHSA-35jh-r3h4-6jhm', severity: 'high' });
    expect(lodash?.advisories.at(-1)?.severity).toBe('moderate');
  });

  it("follows `via` names to collect advisories from a dependency's dependencies", () => {
    const report = parseAudit(fixture('audit-demo-express-api.json'));

    // body-parser, path-to-regexp, qs and on-headers are vulnerable too, but
    // they are not in package.json, so only express and morgan are findings.
    expect(report.findings.map((finding) => finding.name).sort()).toEqual(['express', 'morgan']);

    const express = report.findings.find((finding) => finding.name === 'express');
    expect(express?.severity).toBe('high');
    // 1 from body-parser + 1 from path-to-regexp + 4 from qs, which body-parser
    // also reaches; each counted once.
    expect(express?.advisories).toHaveLength(6);
    expect(new Set(express?.advisories.map((advisory) => advisory.package))).toEqual(
      new Set(['body-parser', 'path-to-regexp', 'qs']),
    );

    const morgan = report.findings.find((finding) => finding.name === 'morgan');
    expect(morgan?.advisories.map((advisory) => advisory.package)).toContain('on-headers');
    expect(report.counts).toMatchObject({ high: 2, moderate: 3, low: 1, total: 6 });
  });

  it('reports a clean tree', () => {
    const report = parseAudit(fixture('audit-demo-cli-tool.json'));

    expect(report.findings).toEqual([]);
    expect(report.counts.total).toBe(0);
  });

  it("turns an offline audit into an exception with npm's reason", () => {
    expect(() => parseAudit(fixture('audit-offline.json'))).toThrow(
      /npm audit failed: request to https:\/\/registry\.npmjs\.org.*EAI_AGAIN/,
    );
  });

  it('refuses a report version it was not written for', () => {
    const json = '{"auditReportVersion": 3, "vulnerabilities": {}, "metadata": {}}';

    expect(() => parseAudit(json)).toThrow(/npm audit printed JSON in a shape/);
  });
});

describe('summarizeNpmError', () => {
  it('keeps the code and the explanation, and drops the usage text', () => {
    const summary = summarizeNpmError(fixture('ci-out-of-sync.stderr.txt'));

    expect(summary.code).toBe('EUSAGE');
    expect(summary.message).toContain('are in sync');
    expect(summary.message).toContain('Missing: left-pad@1.3.0 from lock file');
    expect(summary.message).not.toContain('Usage');
    expect(summary.message).not.toContain('complete log');
  });

  it("understands older npm's `npm ERR!` prefix", () => {
    const stderr = [
      'npm ERR! code ERESOLVE',
      'npm ERR! ERESOLVE unable to resolve dependency tree',
      'npm ERR! ',
      'npm ERR! Found: react@17.0.2',
    ].join('\n');

    expect(summarizeNpmError(stderr)).toEqual({
      code: 'ERESOLVE',
      message: 'ERESOLVE unable to resolve dependency tree Found: react@17.0.2',
    });
  });

  it('copes with no npm error lines at all', () => {
    expect(summarizeNpmError('Killed\n')).toEqual({
      code: null,
      message: 'npm gave no explanation',
    });
  });
});
