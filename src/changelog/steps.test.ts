import semver from 'semver';
import { describe, expect, it } from 'vitest';
import { belongsToStep, lineOf, planSteps } from './steps.js';

const parse = (version: string) => semver.parse(version) as semver.SemVer;

describe('lineOf', () => {
  it('uses the leftmost non-zero number', () => {
    expect(lineOf(parse('5.3.0'))).toBe('5.x');
    expect(lineOf(parse('5.0.0-alpha.1'))).toBe('5.x');
    expect(lineOf(parse('0.4.2'))).toBe('0.4.x');
    expect(lineOf(parse('0.0.3'))).toBe('0.0.3');
  });
});

describe('planSteps', () => {
  const express = ['4.21.2', '5.0.0-alpha.1', '5.0.0-beta.3', '5.0.0', '5.0.1', '5.3.0', '4.22.2'];

  it('gives one step for one major, with notes up to the first stable release', () => {
    expect(planSteps('4.21.2', '5.3.0', express)).toEqual([
      { from: '4.x', to: '5.x', notesUpTo: '5.0.0' },
    ]);
  });

  it('gives one step per major crossed', () => {
    const dateFns = ['2.30.0', '3.0.0-alpha.1', '3.0.0', '3.6.0', '4.0.0', '4.1.0'];
    expect(planSteps('2.30.0', '4.1.0', dateFns)).toEqual([
      { from: '2.x', to: '3.x', notesUpTo: '3.0.0' },
      { from: '3.x', to: '4.x', notesUpTo: '4.0.0' },
    ]);
  });

  it('skips majors that were never published', () => {
    expect(planSteps('1.2.0', '3.0.0', ['1.2.0', '3.0.0'])).toEqual([
      { from: '1.x', to: '3.x', notesUpTo: '3.0.0' },
    ]);
  });

  it('treats each 0.x minor as its own breaking line', () => {
    expect(planSteps('0.3.1', '0.5.2', ['0.3.1', '0.4.0', '0.4.3', '0.5.0', '0.5.2'])).toEqual([
      { from: '0.3.x', to: '0.4.x', notesUpTo: '0.4.0' },
      { from: '0.4.x', to: '0.5.x', notesUpTo: '0.5.0' },
    ]);
  });

  it('stops at the target when the target is a prerelease', () => {
    expect(planSteps('5.3.0', '6.0.0-beta.2', ['6.0.0-beta.1', '6.0.0-beta.2', '6.0.0'])).toEqual([
      { from: '5.x', to: '6.x', notesUpTo: '6.0.0-beta.2' },
    ]);
  });

  it('returns no steps for minor or patch bumps, or downgrades', () => {
    expect(planSteps('4.17.0', '4.21.2', express)).toEqual([]);
    expect(planSteps('5.0.0', '4.0.0', express)).toEqual([]);
    expect(planSteps('latest', '5.0.0', express)).toEqual([]);
  });

  it('assumes every major in between exists when the registry list is missing', () => {
    expect(planSteps('2.30.0', '4.1.0', null)).toEqual([
      { from: '2.x', to: '3.x', notesUpTo: '3.0.0' },
      { from: '3.x', to: '4.x', notesUpTo: '4.1.0' },
    ]);
  });
});

describe('belongsToStep', () => {
  const step = { from: '4.x', to: '5.x', notesUpTo: '5.0.0' };

  it('includes the first release of the new line and its prereleases', () => {
    expect(belongsToStep('5.0.0', step)).toBe(true);
    expect(belongsToStep('5.0.0-alpha.1', step)).toBe(true);
  });

  it('excludes later releases, other lines and non-versions', () => {
    expect(belongsToStep('5.0.1', step)).toBe(false);
    expect(belongsToStep('4.22.0', step)).toBe(false);
    expect(belongsToStep('6.0.0', step)).toBe(false);
    expect(belongsToStep('unreleased', step)).toBe(false);
  });
});
