import { APICallError } from 'ai';
import { describe, expect, it } from 'vitest';
import { FakeSandbox, failingTests } from '../../tests/helpers/fake-sandbox.js';
import {
  type ScriptedTurn,
  scriptedRouter,
  TOKENS_PER_CALL,
} from '../../tests/helpers/scripted-model.js';
import { LlmRouter } from '../llm/router.js';
import { SandboxError } from '../sandbox/errors.js';
import {
  type AgentEvent,
  describeAgentEvent,
  type FixAgentLimits,
  runFixAgent,
} from './fix-agent.js';
import type { FixTask } from './prompt.js';

/**
 * The agent loop, driven by a scripted model against an in-memory project.
 *
 * The project is a trimmed demo-express-api after the express 5 upgrade: its
 * tests pass only once src/app.js stops calling the removed app.del(). Each
 * test scripts what "the model" does step by step and checks where the loop
 * stops and what it reports.
 */

const BROKEN = "app.del('/todos/:id', remove);\n";
const FIXED = "app.delete('/todos/:id', remove);\n";

function project() {
  return new FakeSandbox({
    files: { 'src/app.js': BROKEN, 'package.json': '{"name":"demo"}' },
    testResult: (files) =>
      files.get('src/app.js') === FIXED ? {} : failingTests('TypeError: app.del is not a function'),
  });
}

const task: FixTask = {
  packageName: 'express',
  fromVersion: '4.21.2',
  toVersion: '5.3.0',
  breakingChanges: [
    {
      title: 'app.del() removed',
      details: 'Use app.delete() instead.',
      affectedApis: ['app.del()'],
      migration: 'app.delete()',
    },
  ],
  breakingChangesNote: null,
  nodeEngine: '>= 18',
  failureDigest: 'TypeError: app.del is not a function\n    at src/app.js:1:5',
  maxAttempts: 3,
};

const limits: FixAgentLimits = {
  maxAttempts: 3,
  maxSteps: 20,
  maxTokens: 200_000,
  testTimeoutSec: 300,
};

const read = { name: 'read_file', input: { path: 'src/app.js', startLine: null, endLine: null } };
const write = (content: string) => ({ name: 'write_file', input: { path: 'src/app.js', content } });
const test = (changeSummary: string) => ({ name: 'run_tests', input: { changeSummary } });

async function run(turns: ScriptedTurn[], options: { limits?: Partial<FixAgentLimits> } = {}) {
  const sandbox = project();
  const scripted = scriptedRouter(turns);
  const events: AgentEvent[] = [];
  const result = await runFixAgent(task, {
    router: scripted.router,
    sandbox,
    limits: { ...limits, ...options.limits },
    onEvent: (event) => events.push(event),
  });
  return { result, sandbox, events, prompts: scripted.prompts };
}

describe('runFixAgent', () => {
  it('fixes the code on the second test attempt', async () => {
    const { result, sandbox, events } = await run([
      { tools: [read] },
      {
        text: 'app.del was removed.',
        tools: [write("app.remove('/todos/:id', remove);\n"), test('Renamed app.del.')],
      },
      { tools: [write(FIXED), test('Use app.delete instead.')] },
    ]);

    expect(result).toMatchObject({
      status: 'fixed',
      attempts: 2,
      steps: 3,
      changedFiles: [{ path: 'src/app.js', original: BROKEN, content: FIXED, isTest: false }],
      changeSummaries: ['Renamed app.del.', 'Use app.delete instead.'],
      explanation: 'app.del was removed.',
      lastFailureDigest: null,
      llm: {
        calls: 3,
        inputTokens: 3 * TOKENS_PER_CALL.input,
        outputTokens: 3 * TOKENS_PER_CALL.output,
      },
    });
    expect(sandbox.files.get('src/app.js')).toBe(FIXED);
    expect(events.map(describeAgentEvent)).toEqual([
      'step 1 (gemini/scripted): 1 tool call, 10 → 5 tokens',
      '  read_file src/app.js: src/app.js, lines 1-1 of 1:',
      'step 2 (gemini/scripted): 2 tool calls, 10 → 5 tokens',
      '  write_file src/app.js: OK: wrote src/app.js (2 lines).',
      '  run_tests Renamed app.del.: FAIL (attempt 1 of 3, 2 left).',
      'step 3 (gemini/scripted): 2 tool calls, 10 → 5 tokens',
      '  write_file src/app.js: OK: wrote src/app.js (2 lines).',
      '  run_tests Use app.delete instead.: PASS: npm test passed.',
    ]);
  });

  it('shows the model the task, the breaking changes and every tool result', async () => {
    const { prompts } = await run([{ tools: [read] }, { text: 'Giving up.' }]);
    const first = JSON.stringify(prompts[0]);
    expect(first).toContain('express was upgraded from 4.21.2 to 5.3.0');
    expect(first).toContain('app.del() removed');
    expect(first).toContain('- src/app.js');

    const second = JSON.stringify(prompts[1]);
    expect(second).toContain('"type":"tool-result"');
    expect(second).toContain("app.del('/todos/:id', remove);");
  });

  it('stops when the model gives up, keeping its explanation', async () => {
    const { result } = await run([
      { tools: [read] },
      { text: 'The fix needs a new route library; I cannot do that here.' },
    ]);
    expect(result).toMatchObject({
      status: 'gave-up',
      attempts: 0,
      steps: 2,
      explanation: 'The fix needs a new route library; I cannot do that here.',
      lastFailureDigest: task.failureDigest,
    });
  });

  it('stops at the step limit', async () => {
    const { result } = await run(Array(10).fill({ tools: [read] }), { limits: { maxSteps: 4 } });
    expect(result).toMatchObject({ status: 'step-limit', steps: 4, attempts: 0 });
  });

  it('stops when every test attempt has failed', async () => {
    const wrong = (n: number) => ({ tools: [write(`attempt ${n}\n`), test(`Attempt ${n}.`)] });
    const { result } = await run([wrong(1), wrong(2), wrong(3), wrong(4)]);
    expect(result).toMatchObject({ status: 'attempts-exhausted', attempts: 3, steps: 3 });
    expect(result.lastFailureDigest).toContain('app.del is not a function');
  });

  it('does not count test runs without an edit', async () => {
    const { result } = await run([
      { tools: [test('Just checking.')] },
      { tools: [test('Checking again.')] },
      { tools: [write(FIXED), test('Use app.delete.')] },
    ]);
    expect(result).toMatchObject({ status: 'fixed', attempts: 1, steps: 3 });
  });

  it('is not fixed when a file changes after the passing run in the same step', async () => {
    const { result } = await run([
      { tools: [write(FIXED), test('Fixed.'), write(`${FIXED}// tidy\n`)] },
      { tools: [write(FIXED), test('Back to the tested version.')] },
    ]);
    expect(result).toMatchObject({ status: 'fixed', attempts: 2, steps: 2 });
  });

  it('turns guard violations into errors the model sees, and changes nothing', async () => {
    const { result, sandbox, prompts } = await run([
      {
        tools: [
          { name: 'write_file', input: { path: 'package.json', content: '{"name":"hacked"}' } },
          {
            name: 'read_file',
            input: { path: '../../etc/passwd', startLine: null, endLine: null },
          },
          { name: 'list_files', input: { path: 'node_modules/lodash' } },
        ],
      },
      { text: 'I am not allowed to do that.' },
    ]);

    expect(result.status).toBe('gave-up');
    expect(result.changedFiles).toEqual([]);
    expect(sandbox.files.get('package.json')).toBe('{"name":"demo"}');
    const shown = JSON.stringify(prompts[1]);
    expect(shown.match(/"type":"error-text"/g)).toHaveLength(3);
    expect(shown).toContain('npm owns this file');
    expect(shown).toContain('must stay inside the repo');
    expect(shown).toContain('only read node_modules/express');
  });

  it('passes the SDK’s error back when the model calls a tool wrongly', async () => {
    const { result, prompts, events } = await run([
      {
        tools: [
          { name: 'read_file', input: { file: 'src/app.js' } },
          { name: 'rm_rf', input: {} },
        ],
      },
      { tools: [write(FIXED), test('Fixed.')] },
    ]);
    expect(result.status).toBe('fixed');
    const shown = JSON.stringify(prompts[1]);
    expect(shown).toContain('Invalid input for tool read_file');
    expect(shown).toContain("unavailable tool 'rm_rf'");
    expect(events.filter((event) => event.type === 'agent.tool' && event.isError)).toHaveLength(2);
  });

  it('stops when the token budget is used up', async () => {
    const perCall = TOKENS_PER_CALL.input + TOKENS_PER_CALL.output;
    const { result } = await run(Array(10).fill({ tools: [read] }), {
      limits: { maxTokens: perCall * 2 },
    });
    expect(result).toMatchObject({ status: 'token-budget', steps: 2 });
  });

  it('stops cleanly when no LLM can answer', async () => {
    const unauthorized = new APICallError({
      message: 'bad key',
      url: 'https://example.test',
      requestBodyValues: {},
      statusCode: 401,
    });
    const { result } = await run([{ error: unauthorized }]);
    expect(result).toMatchObject({ status: 'llm-unavailable', steps: 0, attempts: 0 });
    expect(result.problem).toMatch(/every LLM provider failed/);
  });

  it('reports a sandbox that stopped working', async () => {
    const sandbox = project();
    sandbox.failNextExec = new SandboxError('could not start "npm test": container is not running');
    const result = await runFixAgent(task, {
      router: scriptedRouter([{ tools: [write(FIXED), test('Fixed.')] }]).router,
      sandbox,
      limits,
    });
    expect(result).toMatchObject({ status: 'sandbox-error', steps: 1 });
    expect(result.problem).toMatch(/container is not running/);
  });

  it('counts only its own calls when the router is shared by the run', async () => {
    const scripted = scriptedRouter([{ text: 'earlier call' }, { text: 'Giving up.' }]);
    await scripted.router.callLLM('changelog', { prompt: 'analyze something' });
    const result = await runFixAgent(task, { router: scripted.router, sandbox: project(), limits });
    expect(result.llm.calls).toBe(1);
    expect(scripted.router).toBeInstanceOf(LlmRouter);
  });
});
