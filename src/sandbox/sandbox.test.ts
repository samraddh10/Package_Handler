import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { classifyExit, type ExitFacts, isLeftover, OWNER_PID_LABEL } from './sandbox.js';

/**
 * The parts of sandbox.ts that are decisions rather than Docker calls. Everything
 * that needs a real container is in tests/integration/sandbox.test.ts.
 */

/** A command with a 300-second limit that ended after 42 seconds. */
const facts: ExitFacts = { exitCode: 0, durationMs: 42_000, timeoutSec: 300, watchdogFired: false };

/** For cases where asking Docker for the OOM flag would be a wasted call. */
const mustNotAsk = async (): Promise<boolean> => {
  throw new Error('the OOM flag should not be needed here');
};

describe('classifyExit', () => {
  it('calls exit code 0 ok and any other plain exit code failed', async () => {
    expect(await classifyExit(facts, mustNotAsk)).toBe('ok');
    expect(await classifyExit({ ...facts, exitCode: 1 }, mustNotAsk)).toBe('failed');
  });

  it('calls a SIGKILL at the deadline a timeout', async () => {
    const atDeadline = { ...facts, exitCode: 137, durationMs: 300_050 };

    expect(await classifyExit(atDeadline, mustNotAsk)).toBe('timeout');
  });

  it('calls a SIGKILL well before the deadline out of memory', async () => {
    expect(await classifyExit({ ...facts, exitCode: 137 }, mustNotAsk)).toBe('out-of-memory');
  });

  it('calls it a timeout whenever the host watchdog had to step in', async () => {
    const killed = { ...facts, exitCode: null, durationMs: 330_000, watchdogFired: true };

    expect(await classifyExit(killed, mustNotAsk)).toBe('timeout');
  });

  it('treats exit code 124 as a timeout', async () => {
    expect(await classifyExit({ ...facts, exitCode: 124 }, mustNotAsk)).toBe('timeout');
  });

  it('asks for the OOM flag only when the exit code is unknown', async () => {
    const unknown = { ...facts, exitCode: null };

    expect(await classifyExit(unknown, async () => true)).toBe('out-of-memory');
    expect(await classifyExit(unknown, async () => false)).toBe('failed');
  });
});

describe('isLeftover', () => {
  it('keeps a container whose creator is still running', () => {
    expect(isLeftover({ [OWNER_PID_LABEL]: String(process.pid) })).toBe(false);
  });

  it('sweeps a container whose creator has exited', () => {
    // A process that has already finished stands in for a crashed run.
    const { pid } = spawnSync(process.execPath, ['-e', '']);

    expect(isLeftover({ [OWNER_PID_LABEL]: String(pid) })).toBe(true);
  });

  it('sweeps a container with no usable creator label', () => {
    expect(isLeftover(undefined)).toBe(true);
    expect(isLeftover({})).toBe(true);
    expect(isLeftover({ [OWNER_PID_LABEL]: 'not-a-pid' })).toBe(true);
  });
});
