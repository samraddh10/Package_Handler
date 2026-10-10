import { tool } from 'ai';
import { z } from 'zod';
import { SandboxRequestError } from '../sandbox/errors.js';
import type { ExecOutcome, Sandbox } from '../sandbox/sandbox.js';
import { makeFailureDigest } from '../sandbox/test-output.js';
import { checkReadPath, checkWritePath, isTestFile } from './guard.js';

/**
 * The fix agent's five tools: what the model may ask for, and the code that
 * carries each request out inside the sandbox.
 *
 * The definitions below have a description and an input schema but no
 * `execute` function, on purpose. Without one, `generateText` returns the
 * model's tool calls instead of running them, and the agent loop runs them
 * itself through ToolRunner. That gives us three things the SDK would not:
 *
 * - Tools run one at a time, in the order the model asked. The SDK runs a
 *   step's tool calls in parallel, and run_tests must not start while a
 *   write_file is still going. A plain `for ... await` loop is the mutex.
 * - A slow `npm test` (up to 5 minutes) runs outside the LLM call, so the
 *   router's 90-second per-call timer never cuts it off, and a retried LLM
 *   call never runs a tool twice.
 * - Every result can be counted and logged in one place.
 *
 * Results are plain text with hard caps, because every character goes back to
 * the model and costs tokens. Mistakes (a missing file, a forbidden path)
 * come back as error text so the model can correct itself.
 */

/** Most entries list_files returns. */
export const MAX_LIST_ENTRIES = 200;
/** Most lines read_file returns per call. */
export const MAX_READ_LINES = 200;
/** Most characters read_file returns per call: 200 long lines would be ~100K. */
export const MAX_READ_CHARS = 16_000;
/** Most matches search_code returns. */
export const MAX_SEARCH_MATCHES = 50;
/** A minified bundle can put 100 KB on one line; the model needs the start of it at most. */
const MAX_LINE_CHARS = 500;
/** Most characters write_file accepts: source files are far smaller, and this caps a runaway. */
export const MAX_WRITE_CHARS = 200_000;

/** Each tool's input. The `.describe()` texts reach the model as part of the schema. */
const inputs = {
  list_files: z.object({
    path: z.string().describe('Folder relative to the project root; "." is the root'),
  }),
  read_file: z.object({
    path: z.string().describe('File path relative to the project root'),
    startLine: z.number().int().min(1).nullable().describe('First line to read; null = 1'),
    endLine: z
      .number()
      .int()
      .min(1)
      .nullable()
      .describe('Last line to read; null = as far as allowed'),
  }),
  search_code: z.object({
    pattern: z.string().min(1).describe('Text to look for, or an extended regex'),
    isRegex: z.boolean().describe('true: pattern is an extended regex; false: plain text'),
    path: z
      .string()
      .nullable()
      .describe('Folder or file to search; null = the whole project minus node_modules'),
  }),
  write_file: z.object({
    path: z.string().describe('File path relative to the project root'),
    content: z.string().describe('Complete new file content'),
  }),
  run_tests: z.object({
    changeSummary: z.string().describe('One sentence: what you changed since the last run'),
  }),
};

export const fixTools = {
  list_files: tool({
    description: 'List the files and folders in one folder of the project. Folders end in "/".',
    inputSchema: inputs.list_files,
  }),
  read_file: tool({
    description:
      `Read a text file with line numbers, at most ${MAX_READ_LINES} lines per call. ` +
      'Use startLine/endLine to read a long file in parts.',
    inputSchema: inputs.read_file,
  }),
  search_code: tool({
    description:
      `Search the project's files for text, like grep. Returns at most ${MAX_SEARCH_MATCHES} ` +
      'matches as path:line: text. node_modules is skipped unless you search inside the ' +
      "upgraded package's folder.",
    inputSchema: inputs.search_code,
  }),
  write_file: tool({
    description:
      'Replace a whole file with new content, or create it. Send the complete file, not a ' +
      'diff or a fragment: whatever you send becomes the entire file.',
    inputSchema: inputs.write_file,
  }),
  run_tests: tool({
    description:
      'Run npm test on the project as it is now. Only counts as an attempt after you have ' +
      'changed a file; returns PASS, or FAIL with a digest of what failed.',
    inputSchema: inputs.run_tests,
  }),
};

export type FixToolName = keyof typeof fixTools;

/** The parts of a Sandbox the tools use. */
export type FixSandbox = Pick<Sandbox, 'exec' | 'readFile' | 'writeFile' | 'listFiles' | 'search'>;

export interface ToolOutput {
  text: string;
  /** True when the request was refused or failed; the model sees it as an error. */
  isError: boolean;
}

/** One `npm test` run made through run_tests. */
export interface TestRun {
  passed: boolean;
  outcome: ExecOutcome;
  /** The failure digest; null when the tests passed. */
  digest: string | null;
  durationMs: number;
}

/** A file the agent changed: what it held before the first change, and what the agent wrote. */
export interface ChangedFile {
  path: string;
  /** null when the agent created the file. */
  original: string | null;
  /**
   * The content as the agent last wrote it. The pipeline commits this, not
   * what the container holds at the end: test code is untrusted and runs
   * after the write, so it could have changed the file on disk.
   */
  content: string;
  isTest: boolean;
}

export interface ToolRunnerOptions {
  sandbox: FixSandbox;
  upgradedPackage: string;
  maxAttempts: number;
  testTimeoutSec: number;
}

/**
 * Runs tool calls against one sandbox and remembers what they did: which files
 * changed, how many test attempts were used, and the last test result. The
 * agent loop reads that state to decide when to stop.
 */
export class ToolRunner {
  private readonly sandbox: FixSandbox;
  private readonly upgradedPackage: string;
  private readonly maxAttempts: number;
  private readonly testTimeoutSec: number;

  private readonly changes = new Map<string, ChangedFile>();
  /** Files changed since the last test run. A test run without changes would prove nothing new. */
  private dirty = false;
  private attemptsUsed = 0;
  private lastTestRun: TestRun | null = null;
  private readonly summaries: string[] = [];

  constructor(options: ToolRunnerOptions) {
    this.sandbox = options.sandbox;
    this.upgradedPackage = options.upgradedPackage;
    this.maxAttempts = options.maxAttempts;
    this.testTimeoutSec = options.testTimeoutSec;
  }

  /** Test runs used so far. Only runs after an edit count. */
  get attempts(): number {
    return this.attemptsUsed;
  }

  get lastRun(): TestRun | null {
    return this.lastTestRun;
  }

  /** True when the last test run passed and nothing has changed since. */
  get passing(): boolean {
    return this.lastTestRun?.passed === true && !this.dirty;
  }

  /** The files that now differ from the original project. */
  get changedFiles(): ChangedFile[] {
    return [...this.changes.values()];
  }

  /** The model's one-sentence summaries, one per counted test run. */
  get changeSummaries(): string[] {
    return [...this.summaries];
  }

  /**
   * Runs one tool call. Requests that cannot be carried out come back as error
   * text; a SandboxError that is not a SandboxRequestError (the container is
   * gone) is thrown, because no tool can work after that.
   */
  async run(toolName: string, input: unknown): Promise<ToolOutput> {
    // The SDK has already checked the input against the schema; checking again
    // keeps this class safe to call on its own, as the unit tests do.
    const parse = <T>(schema: z.ZodType<T>): T | ToolOutput => {
      const parsed = schema.safeParse(input);
      if (parsed.success) {
        return parsed.data;
      }
      const issue = parsed.error.issues[0];
      return error(`invalid input for ${toolName}: ${issue?.path.join('.')}: ${issue?.message}`);
    };
    try {
      switch (toolName) {
        case 'list_files': {
          const args = parse(inputs.list_files);
          return isOutput(args) ? args : await this.listFiles(args);
        }
        case 'read_file': {
          const args = parse(inputs.read_file);
          return isOutput(args) ? args : await this.readFile(args);
        }
        case 'search_code': {
          const args = parse(inputs.search_code);
          return isOutput(args) ? args : await this.searchCode(args);
        }
        case 'write_file': {
          const args = parse(inputs.write_file);
          return isOutput(args) ? args : await this.writeFile(args);
        }
        case 'run_tests': {
          const args = parse(inputs.run_tests);
          return isOutput(args) ? args : await this.runTests(args);
        }
        default:
          return error(`there is no tool called "${toolName}"`);
      }
    } catch (caught) {
      if (caught instanceof SandboxRequestError) {
        return error(caught.message);
      }
      throw caught;
    }
  }

  private async listFiles(input: { path: string }): Promise<ToolOutput> {
    const path = checkReadPath(input.path, this.upgradedPackage);
    const entries = await this.sandbox.listFiles(path, { limit: MAX_LIST_ENTRIES + 1 });
    if (entries.length === 0) {
      return ok(`${path} is empty`);
    }
    const shown = entries.slice(0, MAX_LIST_ENTRIES);
    const more =
      entries.length > MAX_LIST_ENTRIES
        ? `\n(more entries not shown: list a subfolder instead)`
        : '';
    return ok(`${path}:\n${shown.join('\n')}${more}`);
  }

  private async readFile(input: {
    path: string;
    startLine: number | null;
    endLine: number | null;
  }): Promise<ToolOutput> {
    const path = checkReadPath(input.path, this.upgradedPackage);
    const content = await this.sandbox.readFile(path);
    if (content.includes('\0')) {
      return error(`${path} looks like a binary file`);
    }
    if (content === '') {
      return ok(`${path} is empty`);
    }
    // Shown without `\r`, so a file with Windows line endings reads like any other;
    // write_file puts them back (see keepFileConventions).
    const lines = content.replace(/\r?\n$/, '').split(/\r?\n/);
    const start = input.startLine ?? 1;
    if (start > lines.length) {
      return error(`${path} has only ${lines.length} lines`);
    }
    const lastAllowed = start + MAX_READ_LINES - 1;
    const end = Math.min(input.endLine ?? lastAllowed, lastAllowed, lines.length);
    if (end < start) {
      return error(`endLine (${end}) is before startLine (${start})`);
    }

    const width = String(end).length;
    const body: string[] = [];
    let chars = 0;
    let lastShown = start - 1;
    for (let number = start; number <= end; number++) {
      const raw = lines[number - 1] ?? '';
      const text = raw.length > MAX_LINE_CHARS ? `${raw.slice(0, MAX_LINE_CHARS)} [line cut]` : raw;
      const line = `${String(number).padStart(width)}| ${text}`;
      if (chars + line.length > MAX_READ_CHARS && body.length > 0) {
        break;
      }
      body.push(line);
      chars += line.length + 1;
      lastShown = number;
    }

    const header = `${path}, lines ${start}-${lastShown} of ${lines.length}:`;
    const more =
      lastShown < lines.length
        ? `\n(lines ${lastShown + 1}-${lines.length} not shown; call read_file with startLine ${lastShown + 1} to read on)`
        : '';
    return ok(`${header}\n${body.join('\n')}${more}`);
  }

  private async searchCode(input: {
    pattern: string;
    isRegex: boolean;
    path: string | null;
  }): Promise<ToolOutput> {
    const path = checkReadPath(input.path ?? '.', this.upgradedPackage);
    const matches = await this.sandbox.search(input.pattern, {
      isRegex: input.isRegex,
      path,
      limit: MAX_SEARCH_MATCHES + 1,
    });
    if (matches.length === 0) {
      return ok('No matches.');
    }
    const shown = matches.slice(0, MAX_SEARCH_MATCHES).map((match) => {
      const text = match.text.trim();
      return `${match.path}:${match.line}: ${text.length > 200 ? `${text.slice(0, 200)} ...` : text}`;
    });
    const more =
      matches.length > MAX_SEARCH_MATCHES
        ? `\n(showing the first ${MAX_SEARCH_MATCHES} matches; narrow the pattern or the path)`
        : '';
    return ok(`${shown.join('\n')}${more}`);
  }

  private async writeFile(input: { path: string; content: string }): Promise<ToolOutput> {
    const path = checkWritePath(input.path);
    if (input.content.length > MAX_WRITE_CHARS) {
      return error(
        `content is ${input.content.length} characters; the limit is ${MAX_WRITE_CHARS}`,
      );
    }

    // Remember what the file held before the agent's first change to it, so the
    // pipeline can show a diff and knows whether the file is new.
    const known = this.changes.get(path);
    const original = known !== undefined ? known.original : await this.readOriginal(path);
    const content = keepFileConventions(original, input.content);
    await this.sandbox.writeFile(path, content);

    // Any real change since the last test run makes a new run worth an attempt,
    // including putting a file back the way it was.
    if (content !== (known?.content ?? original)) {
      this.dirty = true;
    }
    const lineCount = content.split('\n').length;
    if (content === original) {
      // Written back to how it was: no longer a change.
      this.changes.delete(path);
      return ok(`OK: ${path} now matches the original file again (${lineCount} lines).`);
    }
    const isTest = isTestFile(path);
    this.changes.set(path, { path, original, content, isTest });
    const note = isTest
      ? ' Note: this is a test file, so the change will be flagged for human review.'
      : '';
    return ok(`OK: wrote ${path} (${lineCount} lines).${note}`);
  }

  private async readOriginal(path: string): Promise<string | null> {
    try {
      return await this.sandbox.readFile(path);
    } catch (caught) {
      if (caught instanceof SandboxRequestError) {
        return null;
      }
      throw caught;
    }
  }

  private async runTests(input: { changeSummary: string }): Promise<ToolOutput> {
    if (!this.dirty) {
      return ok(
        'Not run: nothing has changed since the last test run, so the result would be the same. ' +
          'Change a file with write_file first. This did not use up an attempt.',
      );
    }
    if (this.attemptsUsed >= this.maxAttempts) {
      return error('no test attempts left');
    }

    const result = await this.sandbox.exec(['npm', 'test'], { timeoutSec: this.testTimeoutSec });
    this.attemptsUsed++;
    this.dirty = false;
    this.summaries.push(input.changeSummary.trim());

    if (result.outcome === 'ok') {
      this.lastTestRun = {
        passed: true,
        outcome: result.outcome,
        digest: null,
        durationMs: result.durationMs,
      };
      return ok('PASS: npm test passed.');
    }

    const digest = makeFailureDigest(result.stdout, result.stderr);
    this.lastTestRun = {
      passed: false,
      outcome: result.outcome,
      digest,
      durationMs: result.durationMs,
    };
    const left = this.maxAttempts - this.attemptsUsed;
    const why = {
      failed: '',
      timeout: `\nnpm test did not finish within ${this.testTimeoutSec} s and was stopped.`,
      'out-of-memory': '\nnpm test was killed for using too much memory.',
      ok: '',
    }[result.outcome];
    return ok(
      `FAIL (attempt ${this.attemptsUsed} of ${this.maxAttempts}, ${left} left).${why}\n${digest}`,
    );
  }
}

/**
 * Gives new content the original file's line endings and final newline.
 *
 * Models write `\n` and often drop the last newline. Against a file with
 * Windows line endings (`\r\n`), or one that ends in a newline, that would turn
 * a one-line fix into a diff of the whole file, so the agent's content is
 * adjusted to match. New files are left as written.
 */
export function keepFileConventions(original: string | null, content: string): string {
  if (original === null || content === '') {
    return content;
  }
  let adjusted = content;
  if (original.includes('\r\n') && !adjusted.includes('\r\n')) {
    adjusted = adjusted.replaceAll('\n', '\r\n');
  }
  if (original.endsWith('\n') && !adjusted.endsWith('\n')) {
    adjusted += original.endsWith('\r\n') ? '\r\n' : '\n';
  }
  return adjusted;
}

function isOutput(value: object): value is ToolOutput {
  return 'isError' in value;
}

function ok(text: string): ToolOutput {
  return { text, isError: false };
}

function error(text: string): ToolOutput {
  return { text: `Error: ${text}`, isError: true };
}
