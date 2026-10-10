import { describe, expect, it } from 'vitest';
import { classifyBump, compareUpgrades, isOutsideRange, type Prioritized } from './classify.js';

describe('classifyBump', () => {
  it('reads ordinary versions the way semver says', () => {
    expect(classifyBump('4.21.2', '5.3.0')).toBe('major');
    expect(classifyBump('1.10.0', '1.12.1')).toBe('minor');
    expect(classifyBump('2.8.4', '2.8.6')).toBe('patch');
  });

  it('treats the minor number of a 0.x version as major', () => {
    expect(classifyBump('0.3.1', '0.4.0')).toBe('major');
    expect(classifyBump('0.3.1', '0.3.9')).toBe('patch');
    expect(classifyBump('0.9.0', '1.0.0')).toBe('major');
  });

  it('treats any change in a 0.0.x version as major', () => {
    expect(classifyBump('0.0.3', '0.0.4')).toBe('major');
  });

  it('treats any jump involving a prerelease as major', () => {
    expect(classifyBump('2.0.0-beta.3', '2.0.0')).toBe('major');
    expect(classifyBump('1.4.0', '1.5.0-rc.1')).toBe('major');
  });

  it('returns null when there is nothing to upgrade', () => {
    expect(classifyBump('1.2.3', '1.2.3')).toBeNull();
    expect(classifyBump('2.0.0', '1.9.9')).toBeNull();
    expect(classifyBump('git', 'git')).toBeNull();
    expect(classifyBump('1.2.3', 'latest')).toBeNull();
  });
});

describe('compareUpgrades', () => {
  const upgrade = (
    name: string,
    bump: Prioritized['bump'],
    security: Prioritized['security'] = null,
  ): Prioritized => ({ name, bump, security });

  it('puts security fixes first, worst first, then patch, minor, major', () => {
    const order = [
      upgrade('a-major', 'major'),
      upgrade('b-minor', 'minor'),
      upgrade('c-patch', 'patch'),
      upgrade('d-moderate', 'major', { severity: 'moderate', fixedByUpgrade: true }),
      upgrade('e-critical', 'minor', { severity: 'critical', fixedByUpgrade: true }),
    ]
      .sort(compareUpgrades)
      .map((u) => u.name);

    expect(order).toEqual(['e-critical', 'd-moderate', 'c-patch', 'b-minor', 'a-major']);
  });

  it('does not promote an upgrade that leaves the vulnerability in place', () => {
    const order = [
      upgrade('still-vulnerable', 'major', { severity: 'critical', fixedByUpgrade: false }),
      upgrade('plain-patch', 'patch'),
    ]
      .sort(compareUpgrades)
      .map((u) => u.name);

    expect(order).toEqual(['plain-patch', 'still-vulnerable']);
  });

  it('breaks ties by name, so the order is stable', () => {
    const order = [upgrade('zod', 'patch'), upgrade('axios', 'patch')]
      .sort(compareUpgrades)
      .map((u) => u.name);

    expect(order).toEqual(['axios', 'zod']);
  });
});

describe('isOutsideRange', () => {
  it("says whether the target version escapes npm audit's vulnerable range", () => {
    // Ranges exactly as npm audit reported them for the demo repos.
    expect(isOutsideRange('4.18.1', '<=4.17.23')).toBe(true);
    expect(isOutsideRange('4.17.21', '<=4.17.23')).toBe(false);
    expect(isOutsideRange('5.3.0', '4.0.0-rc1 - 4.22.2 || 5.0.0-alpha.1 - 5.0.1')).toBe(true);
    expect(isOutsideRange('5.0.0-beta.1', '4.0.0-rc1 - 4.22.2 || 5.0.0-alpha.1 - 5.0.1')).toBe(
      false,
    );
  });
});
