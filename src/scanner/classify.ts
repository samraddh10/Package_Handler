import semver from 'semver';
import { SEVERITIES, type Severity } from './parse.js';

/**
 * Sizing upgrades, and putting them in order.
 *
 * Plain arithmetic on version numbers, no LLM: semver already encodes the
 * author's own claim about what might break, and the agent only needs to read
 * it correctly, including the parts people often get wrong (0.x versions and
 * prereleases).
 */

/** How big a version jump is, judged by what it is allowed to break. */
export type Bump = 'patch' | 'minor' | 'major';

/**
 * Classifies the jump from `from` to `to`, or returns null when there is nothing
 * to upgrade: the versions are equal, `to` is older, or either one is not a
 * semver version at all (a git URL, a dist-tag).
 *
 * Semver says only a major bump may break you. Below 1.0.0 that promise moves
 * one place to the right: 0.x packages use the minor number for breaking
 * changes, which is why npm's `^0.3.1` means ">=0.3.1 <0.4.0", and in 0.0.x
 * even the patch number can break (`^0.0.3` means exactly 0.0.3). So the number
 * that counts as "major" is the leftmost non-zero one, and a change there is
 * classed as major.
 *
 * A prerelease (1.0.0-beta.2) comes with no compatibility promise at all, so any
 * jump that starts or ends on one is treated as major.
 */
export function classifyBump(from: string, to: string): Bump | null {
  const a = semver.parse(from);
  const b = semver.parse(to);
  if (a === null || b === null || semver.lte(b, a)) {
    return null;
  }
  if (a.prerelease.length > 0 || b.prerelease.length > 0) {
    return 'major';
  }
  if (a.major !== b.major) {
    return 'major';
  }
  if (a.major === 0) {
    // 0.3.1 → 0.4.0 changes the leftmost non-zero number. So does 0.0.3 → 0.0.4,
    // because there the patch number is the leftmost non-zero one.
    if (a.minor !== b.minor || a.minor === 0) {
      return 'major';
    }
    return 'patch';
  }
  return a.minor !== b.minor ? 'minor' : 'patch';
}

/** What the ordering needs to know about an upgrade. */
export interface Prioritized {
  name: string;
  bump: Bump;
  /** Set when the upgrade fixes a known vulnerability. */
  security: { severity: Severity; fixedByUpgrade: boolean } | null;
}

const BUMP_ORDER: readonly Bump[] = ['patch', 'minor', 'major'];

/**
 * The order upgrades run in: security fixes first, worst severity first; then
 * patch, minor, major; then by name, so two scans of the same repo agree.
 *
 * Why this order: a vulnerability the upgrade actually fixes matters most.
 * Among the rest the safest go first, so if a run stops early (out of LLM
 * budget, out of time) it has already delivered the easy, green upgrades
 * instead of being stuck on the hard one.
 */
export function compareUpgrades(a: Prioritized, b: Prioritized): number {
  return (
    securityRank(a) - securityRank(b) ||
    BUMP_ORDER.indexOf(a.bump) - BUMP_ORDER.indexOf(b.bump) ||
    a.name.localeCompare(b.name)
  );
}

/** 0 for critical through 4 for info, and 5 for "not a security fix". */
function securityRank(upgrade: Prioritized): number {
  if (upgrade.security === null || !upgrade.security.fixedByUpgrade) {
    return SEVERITIES.length;
  }
  return SEVERITIES.length - 1 - SEVERITIES.indexOf(upgrade.security.severity);
}

/**
 * True when `version` is outside the range npm audit reported as vulnerable,
 * i.e. upgrading to it removes the problem. `includePrerelease` makes ranges
 * such as `5.0.0-alpha.1 - 5.0.1` behave as written.
 */
export function isOutsideRange(version: string, vulnerableRange: string): boolean {
  return !semver.satisfies(version, vulnerableRange, { includePrerelease: true });
}
