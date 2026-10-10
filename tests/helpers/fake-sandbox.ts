import { SandboxPathError, SandboxRequestError } from '../../src/sandbox/errors.js';
import { toRelativePath } from '../../src/sandbox/paths.js';
import type { ExecResult, SearchMatch } from '../../src/sandbox/sandbox.js';

/**
 * An in-memory stand-in for the Docker sandbox, for unit tests of the fix agent
 * and the upgrade runner.
 *
 * Files live in a Map. `npm test` is answered by a function of the current
 * files, so a test can say "the tests pass once src/app.js no longer calls
 * app.del", and the agent has to actually write that change to get a PASS.
 * Other commands play back scripted results, keyed by the command line, and
 * succeed with no output when unscripted. Every call is recorded in `calls`.
 */
export class FakeSandbox {
  readonly files: Map<string, string>;
  readonly calls: string[] = [];
  /** Scripted results for commands other than `npm test`, used up in order. */
  readonly script: Record<string, Partial<ExecResult>[]>;
  /** Decides each `npm test` run from the files as they are at that moment. */
  testResult: (files: Map<string, string>) => Partial<ExecResult>;
  /** Side effects of a command on the files, e.g. what `npm install` writes. */
  onCommand: (command: string, files: Map<string, string>) => void;
  /** Set to make the next command throw, as if the container had died. */
  failNextExec: Error | null = null;
  networkCut = false;
  destroyed = false;

  constructor(
    options: {
      files?: Record<string, string>;
      script?: Record<string, Partial<ExecResult>[]>;
      testResult?: (files: Map<string, string>) => Partial<ExecResult>;
      onCommand?: (command: string, files: Map<string, string>) => void;
    } = {},
  ) {
    this.files = new Map(Object.entries(options.files ?? {}));
    this.script = options.script ?? {};
    this.testResult = options.testResult ?? (() => ({}));
    this.onCommand = options.onCommand ?? (() => {});
  }

  async copyIn(hostDir: string): Promise<void> {
    this.calls.push(`copyIn ${hostDir}`);
  }

  async exec(command: string[], _options: { timeoutSec: number }): Promise<ExecResult> {
    const key = command.join(' ');
    this.calls.push(key);
    if (this.failNextExec !== null) {
      const error = this.failNextExec;
      this.failNextExec = null;
      throw error;
    }
    this.onCommand(key, this.files);
    const scripted = key === 'npm test' ? this.testResult(this.files) : this.script[key]?.shift();
    return {
      command,
      outcome: 'ok',
      exitCode: 0,
      stdout: '',
      stderr: '',
      durationMs: 1000,
      truncated: false,
      ...scripted,
    };
  }

  async readFile(path: string): Promise<string> {
    const relative = toRelativePath(path);
    const content = this.files.get(relative);
    if (content === undefined) {
      if (this.isFolder(relative)) {
        throw new SandboxPathError(`refusing to copy out "${relative}": it is a directory`);
      }
      throw new SandboxRequestError(`"${relative}" does not exist`);
    }
    return content;
  }

  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push(`writeFile ${path}`);
    this.files.set(toRelativePath(path), content);
  }

  async listFiles(path = '.', options: { limit?: number } = {}): Promise<string[]> {
    const relative = toRelativePath(path);
    if (this.files.has(relative)) {
      return [relative.split('/').at(-1) ?? relative];
    }
    if (!this.isFolder(relative)) {
      throw new SandboxRequestError(`could not list "${relative}": No such file or directory`);
    }
    const prefix = relative === '.' ? '' : `${relative}/`;
    const entries = new Set<string>();
    for (const file of this.files.keys()) {
      if (file.startsWith(prefix)) {
        const [first, ...rest] = file.slice(prefix.length).split('/');
        entries.add(rest.length > 0 ? `${first}/` : (first ?? ''));
      }
    }
    return [...entries].sort().slice(0, options.limit ?? 200);
  }

  async search(
    pattern: string,
    options: { isRegex?: boolean; path?: string | null; limit?: number } = {},
  ): Promise<SearchMatch[]> {
    const relative = toRelativePath(options.path ?? '.');
    const inNodeModules = relative.split('/')[0] === 'node_modules';
    const regex = options.isRegex ? new RegExp(pattern) : null;
    const matches: SearchMatch[] = [];
    for (const [file, content] of this.files) {
      const inside = relative === '.' || file === relative || file.startsWith(`${relative}/`);
      if (!inside || (!inNodeModules && file.split('/').includes('node_modules'))) {
        continue;
      }
      content.split('\n').forEach((text, index) => {
        if (regex ? regex.test(text) : text.includes(pattern)) {
          matches.push({ path: file, line: index + 1, text });
        }
      });
    }
    return matches.slice(0, options.limit ?? 50);
  }

  async disconnectNetwork(): Promise<void> {
    this.calls.push('disconnectNetwork');
    this.networkCut = true;
  }

  async destroy(): Promise<void> {
    this.calls.push('destroy');
    this.destroyed = true;
  }

  private isFolder(relative: string): boolean {
    if (relative === '.') {
      return true;
    }
    return [...this.files.keys()].some((file) => file.startsWith(`${relative}/`));
  }
}

/** A failing `npm test`, the way mocha reports one. */
export function failingTests(message: string): Partial<ExecResult> {
  return {
    outcome: 'failed',
    exitCode: 1,
    stdout: `  0 passing\n  1 failing\n\n  1) todo API\n     ${message}\n      at Context.<anonymous> (test/app.test.js:12:5)\n`,
  };
}
