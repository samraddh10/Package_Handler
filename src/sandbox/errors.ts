/**
 * The error types the sandbox throws.
 *
 * A failing command is not an error: `exec()` returns a result with an exit
 * code, because a failing `npm test` is normal and the pipeline decides what it
 * means. These errors are for the sandbox itself going wrong, or for a request
 * we refuse to carry out.
 */

/** Something went wrong while driving Docker, e.g. the image could not be pulled. */
export class SandboxError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'SandboxError';
  }
}

/** A path broke the rules in paths.ts, or a copy-out was refused. Safe to show to an LLM. */
export class SandboxPathError extends SandboxError {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxPathError';
  }
}
