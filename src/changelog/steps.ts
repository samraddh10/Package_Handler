import semver, { type SemVer } from 'semver';

/**
 * Splitting an upgrade into "major steps", and deciding which versions' notes
 * describe each step.
 *
 * Semver puts breaking changes only where the leftmost non-zero number goes up
 * (see classify.ts for the 0.x rule). So express 4.21.2 → 5.3.0 can only break
 * at 5.0.0, and date-fns 2.30.0 → 4.1.0 only at 3.0.0 and 4.0.0. That gives
 * two useful rules:
 *
 * - One cache entry per step (4.x → 5.x), not per exact version pair, so
 *   4.18.0 → 5.1.0 and 4.21.2 → 5.3.0 share one analysis, and 2 → 4 is built
 *   from the 2 → 3 and 3 → 4 entries.
 * - For each step, only the notes of the first release of the new line (5.0.0,
 *   plus its alphas and betas) are read. Later 5.x minors may not break by the
 *   semver promise, so their notes would cost tokens without adding breaking
 *   changes.
 */

export interface UpgradeStep {
  /** The line we leave and the line we enter, as labels: "4.x" → "5.x", "0.3.x" → "0.4.x". */
  from: string;
  to: string;
  /** The highest version whose notes belong to this step: the line's first stable release. */
  notesUpTo: string;
}

/**
 * The "breaking line" a version belongs to: its leftmost non-zero number.
 * 5.3.0 → "5.x", 0.4.2 → "0.4.x", 0.0.3 → "0.0.3".
 */
export function lineOf(version: SemVer): string {
  if (version.major > 0) {
    return `${version.major}.x`;
  }
  if (version.minor > 0) {
    return `0.${version.minor}.x`;
  }
  return `0.0.${version.patch}`;
}

/**
 * The major steps between two versions. `published` is every version on the
 * registry; it says which lines exist (a package may skip a major) and where
 * each line starts. Without it, every major in between is assumed to exist.
 * Returns [] when both versions are on the same line (a minor or patch bump).
 */
export function planSteps(from: string, to: string, published: string[] | null): UpgradeStep[] {
  const start = semver.parse(from);
  const end = semver.parse(to);
  if (start === null || end === null || semver.lte(end, start)) {
    return [];
  }

  const crossed =
    published === null
      ? assumedVersions(start, end)
      : published
          .map((version) => semver.parse(version))
          .filter((version): version is SemVer => version !== null)
          .filter((version) => semver.gt(version, start) && semver.lte(version, end));
  crossed.push(end);
  crossed.sort(semver.compare);

  // Group by line, in ascending order, skipping the line we start on.
  const lines = new Map<string, SemVer[]>();
  for (const version of crossed) {
    const line = lineOf(version);
    if (line === lineOf(start)) {
      continue;
    }
    const group = lines.get(line) ?? [];
    group.push(version);
    lines.set(line, group);
  }

  const steps: UpgradeStep[] = [];
  let previous = lineOf(start);
  for (const [line, versions] of lines) {
    // The first stable release of the line, or (if the target itself is a
    // prerelease) the newest prerelease we go to.
    const firstStable = versions.find((version) => version.prerelease.length === 0);
    const notesUpTo = firstStable ?? (versions[versions.length - 1] as SemVer);
    steps.push({ from: previous, to: line, notesUpTo: notesUpTo.version });
    previous = line;
  }
  return steps;
}

/** Whether a version's notes belong to `step`: same line, and not past its first stable release. */
export function belongsToStep(version: string, step: UpgradeStep): boolean {
  const parsed = semver.parse(version);
  return parsed !== null && lineOf(parsed) === step.to && semver.lte(parsed, step.notesUpTo);
}

/** Offline fallback: one version per major in between (x.0.0), plus the target. */
function assumedVersions(start: SemVer, end: SemVer): SemVer[] {
  const versions: SemVer[] = [];
  if (start.major > 0 || end.major > 0) {
    for (let major = Math.max(start.major + 1, 1); major < end.major; major++) {
      versions.push(new semver.SemVer(`${major}.0.0`));
    }
  }
  return versions;
}
