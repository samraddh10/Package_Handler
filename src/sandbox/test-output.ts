import { stripVTControlCharacters } from 'node:util';
import { PROJECT_DIR } from './paths.js';

/**
 * The failure digest: the part of a failed test run worth reading.
 *
 * A failing `npm test` can print thousands of lines, and most of them are noise:
 * npm's banner, every passing test, test-framework internals in stack traces,
 * timing lines. What a person needs, and from 1.5 what the LLM needs, is which
 * tests failed, the assertion or error, and where in the project's own code it
 * happened. This module drops the lines it recognises as noise and caps what is
 * left at about 1,500 tokens.
 *
 * It works line by line with rules that apply to any test runner, instead of
 * one parser per framework. mocha, jest, vitest and node:test all go through the
 * same rules (each rule says which runner it mostly exists for), and output from
 * a runner we have never seen still comes out shorter and readable.
 */

/** About 1,500 tokens, at the usual estimate of 4 characters per token. */
export const DEFAULT_DIGEST_CHARS = 6_000;

/** Lines that never help explain a failure. */
const NOISE: readonly RegExp[] = [
  /^> /, // npm's "> pkg@1.0.0 test" banner
  /^npm (error|ERR!) /, // npm's "command failed" trailer: we know that already
  /^\s*[✓✔√]\s/, // a passing test (mocha, jest, vitest)
  /^\s*ok \d+ /, // a passing test (node:test's TAP output)
  /^\s*PASS\s/, // a passing test file (jest)
  /^TAP version \d+/, // node:test
  /^\s*# Subtest: /, // node:test: repeats the test name on the next line
  /^\s*\d+\.\.\d+$/, // TAP's plan line, e.g. "1..3"
  /^\s*(---|\.\.\.)$/, // TAP's YAML block markers
  /^\s*(duration_ms|type|failureType): /, // TAP YAML fields that say nothing about the failure
  /^\s*(at\s+)?async Promise\.all \(index \d+\)$/, // a stack line with no file in it (node:test)
  /^# (cancelled|skipped|todo) 0$|^# duration_ms /, // node:test's zero counters and timing
  /^\s*RUN\s+v\d/, // vitest's banner
  /^\s*(Start at|Duration)\s/, // vitest's timing
  /^(Snapshots|Time):\s|^Ran all test suites/, // jest's summary noise
];

/** A stack-frame line: "at fn (file:1:2)", node:test's "fn (file:1:2)", vitest's "❯ file:1:2". */
const FRAME = /^\s*(at\s+|❯\s+)?\S.*:\d+:\d+\)?$/;

/** A frame inside Node itself, e.g. `(node:internal/timers:484:21)`. Never worth showing. */
const NODE_FRAME = /\bnode:[a-z_]+/;

/** A frame inside a dependency. Paths are repo-relative by now, so `node_modules/` may follow a `(`. */
const DEPENDENCY_FRAME = /(^|[\s(/])node_modules\//;

/** Project frames kept per stack trace. The top few say where; the rest is rarely needed. */
const MAX_FRAMES = 3;

/** A minified bundle in a stack trace or code frame can put 100 KB on one line. */
const MAX_LINE_CHARS = 500;

/**
 * Turns a test run's output into a short digest of what failed.
 *
 * Steps: strip terminal codes, drop noise lines, make container paths relative
 * to the repo, trim stack traces, squeeze blank lines, then cap the length.
 */
export function makeFailureDigest(
  stdout: string,
  stderr: string,
  maxChars: number = DEFAULT_DIGEST_CHARS,
): string {
  // jest prints everything to stderr and vitest splits its report across both,
  // so the two streams are read as one.
  const text = [stdout, stderr]
    .map((stream) => stripVTControlCharacters(stream).replaceAll('\r\n', '\n'))
    .filter((stream) => stream.trim() !== '')
    .join('\n');

  const lines = trimStackTraces(
    text
      .split('\n')
      .map(cleanLine)
      .filter((line) => !NOISE.some((rule) => rule.test(line))),
  );
  const digest = squeezeBlankLines(lines).join('\n');
  if (digest === '') {
    return '(the test command printed nothing)';
  }
  return capLength(digest, maxChars);
}

/** Per-line rewrites that keep the line but make it shorter or clearer. */
function cleanLine(line: string): string {
  const cleaned = line
    // Absolute container paths become repo-relative, matching the paths the
    // rest of the agent uses (node:test and ESM stack traces print them in full).
    .replaceAll(`file://${PROJECT_DIR}/`, '')
    .replaceAll(`${PROJECT_DIR}/`, '')
    // vitest's "⎯⎯⎯ Failed Tests 2 ⎯⎯⎯" rules: keep the words, lose the line.
    .replace(/⎯+(\[\d+\/\d+\])?⎯*/g, '')
    .trimEnd();
  return cleaned.length > MAX_LINE_CHARS ? `${cleaned.slice(0, MAX_LINE_CHARS)} ...` : cleaned;
}

/**
 * Keeps the top of each stack trace and drops the rest.
 *
 * Frames inside Node itself always go. The first remaining frame stays even when
 * it is inside a dependency, because it says which package threw. After that
 * only the project's own frames are kept, at most MAX_FRAMES in all: dependency
 * frames show where the error passed through, not where it can be fixed.
 */
function trimStackTraces(lines: string[]): string[] {
  const kept: string[] = [];
  let framesSeen = 0;
  let framesKept = 0;
  for (const line of lines) {
    if (!FRAME.test(line)) {
      framesSeen = 0;
      framesKept = 0;
      kept.push(line);
      continue;
    }
    if (NODE_FRAME.test(line)) {
      continue;
    }
    const isFirst = framesSeen === 0;
    framesSeen++;
    if (isFirst || (!DEPENDENCY_FRAME.test(line) && framesKept < MAX_FRAMES)) {
      framesKept++;
      kept.push(line);
    }
  }
  return kept;
}

/** At most one blank line in a row, and none at the start or end. */
function squeezeBlankLines(lines: string[]): string[] {
  const squeezed: string[] = [];
  for (const line of lines) {
    const blank = line.trim() === '';
    if (blank && (squeezed.length === 0 || squeezed.at(-1) === '')) {
      continue;
    }
    squeezed.push(blank ? '' : line);
  }
  while (squeezed.at(-1) === '') {
    squeezed.pop();
  }
  return squeezed;
}

/**
 * Cuts a long digest down to `maxChars`, keeping whole lines from the start and
 * from the end. The start holds the first failures; the end holds the summary
 * ("2 failing", "Tests: 2 failed, 1 passed") for most runners.
 */
function capLength(digest: string, maxChars: number): string {
  if (digest.length <= maxChars) {
    return digest;
  }
  const lines = digest.split('\n');
  const head = takeLines(lines, Math.floor(maxChars * 0.75));
  const tail = takeLines([...lines].reverse(), Math.floor(maxChars * 0.2)).reverse();
  const omitted = lines.length - head.length - tail.length;
  return [...head, `... ${omitted} more lines cut from the middle ...`, ...tail].join('\n');
}

/** As many leading lines as fit in `budget` characters, counting each newline. */
function takeLines(lines: string[], budget: number): string[] {
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    used += line.length + 1;
    if (used > budget) {
      break;
    }
    taken.push(line);
  }
  return taken;
}
