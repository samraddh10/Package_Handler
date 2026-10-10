import type { ModelMessage, ToolResultPart } from 'ai';
import { LlmUnavailableError } from '../llm/errors.js';
import type { LlmRouter } from '../llm/router.js';
import { SandboxError } from '../sandbox/errors.js';
import { compactMessages } from './compact.js';
import { buildFirstMessage, type FixTask, INSTRUCTIONS } from './prompt.js';
import { type ChangedFile, type FixSandbox, fixTools, ToolRunner } from './tools.js';

/**
 * The fix agent: an LLM in a loop with five tools, trying to make the tests
 * pass again after an upgrade broke them.
 *
 * The loop is our own plain code, not the SDK's: each turn makes exactly one
 * LLM call (one "step"), runs the tool calls the model asked for, appends the
 * results to the conversation, and then checks the stop rules. Owning the loop
 * means the rules live in a dozen readable lines, every step is logged, and if
 * a provider hits its rate limit mid-task, the router can carry on with the
 * next provider from the same conversation.
 *
 * Success is decided by our own `npm test` run (through run_tests), never by the
 * model saying it is done.
 */

export type FixStatus =
  /** Our own test run passed, and nothing changed after it. */
  | 'fixed'
  /** Every test attempt was used, and the last one failed. */
  | 'attempts-exhausted'
  /** The model stopped calling tools without a passing test run. */
  | 'gave-up'
  /** FIX_MAX_STEPS LLM calls were made without a result. */
  | 'step-limit'
  /** FIX_MAX_TOKENS was used up. */
  | 'token-budget'
  /** No provider could answer, or the run's LLM call budget is spent. */
  | 'llm-unavailable'
  /** The container stopped working; no tool can run after that. */
  | 'sandbox-error';

/** What the agent did, for the report and the pull request. */
export interface FixResult {
  status: FixStatus;
  /** Test runs used (only runs after an edit count). */
  attempts: number;
  /** LLM calls made by the loop (one per step; the router's retries are in `llm.calls`). */
  steps: number;
  changedFiles: ChangedFile[];
  /** The model's one-sentence summaries, one per test run. */
  changeSummaries: string[];
  /** The model's last words: why it stopped, or what it thinks is still broken. */
  explanation: string | null;
  /** The digest of the last failing test run; null when fixed. */
  lastFailureDigest: string | null;
  /** Why the agent could not go on, for `llm-unavailable` and `sandbox-error`. */
  problem: string | null;
  llm: { calls: number; inputTokens: number; outputTokens: number };
}

/** One line of the live trace per step and per tool call. */
export type AgentEvent =
  | {
      type: 'agent.step';
      step: number;
      provider: string;
      model: string;
      /** What the model said besides calling tools, if anything. */
      text: string | null;
      toolCalls: number;
      inputTokens: number;
      outputTokens: number;
    }
  | {
      type: 'agent.tool';
      step: number;
      tool: string;
      /** e.g. "src/app.js" for read_file. */
      target: string | null;
      isError: boolean;
      /** The first line of the result, e.g. "PASS: npm test passed." */
      summary: string;
    };

export interface FixAgentLimits {
  maxAttempts: number;
  maxSteps: number;
  /** Input + output tokens for this package, summed over all its steps. */
  maxTokens: number;
  testTimeoutSec: number;
}

export interface FixAgentDeps {
  router: Pick<LlmRouter, 'callLLM' | 'getStats'>;
  sandbox: FixSandbox;
  limits: FixAgentLimits;
  onEvent?: (event: AgentEvent) => void;
}

export async function runFixAgent(task: FixTask, deps: FixAgentDeps): Promise<FixResult> {
  const { router, sandbox, limits } = deps;
  const emit = deps.onEvent ?? (() => {});
  const runner = new ToolRunner({
    sandbox,
    upgradedPackage: task.packageName,
    maxAttempts: limits.maxAttempts,
    testTimeoutSec: limits.testTimeoutSec,
  });
  const statsBefore = router.getStats();

  let messages: ModelMessage[] = [{ role: 'user', content: buildFirstMessage(task) }];
  let steps = 0;
  let explanation: string | null = null;

  const finish = (status: FixStatus, problem: string | null = null): FixResult => {
    const stats = router.getStats();
    return {
      status,
      attempts: runner.attempts,
      steps,
      changedFiles: runner.changedFiles,
      changeSummaries: runner.changeSummaries,
      explanation,
      lastFailureDigest: status === 'fixed' ? null : (runner.lastRun?.digest ?? task.failureDigest),
      problem,
      llm: {
        calls: stats.calls - statsBefore.calls,
        inputTokens: stats.inputTokens - statsBefore.inputTokens,
        outputTokens: stats.outputTokens - statsBefore.outputTokens,
      },
    };
  };
  const tokensUsed = () => {
    const stats = router.getStats();
    return (
      stats.inputTokens - statsBefore.inputTokens + (stats.outputTokens - statsBefore.outputTokens)
    );
  };

  for (let step = 1; step <= limits.maxSteps; step++) {
    if (tokensUsed() >= limits.maxTokens) {
      return finish('token-budget');
    }
    messages = compactMessages(messages, { instructions: INSTRUCTIONS });

    let response: Awaited<ReturnType<typeof router.callLLM<typeof fixTools>>>;
    try {
      response = await router.callLLM('fix', {
        instructions: INSTRUCTIONS,
        messages,
        tools: fixTools,
      });
    } catch (error) {
      if (error instanceof LlmUnavailableError) {
        return finish('llm-unavailable', error.message);
      }
      throw error;
    }
    steps = step;
    const { result } = response;
    const text = result.text.trim();
    if (text !== '') {
      explanation = text;
    }
    emit({
      type: 'agent.step',
      step,
      provider: response.provider,
      model: response.modelId,
      text: text === '' ? null : text,
      toolCalls: result.toolCalls.length,
      inputTokens: result.usage.inputTokens ?? 0,
      outputTokens: result.usage.outputTokens ?? 0,
    });

    // The SDK's response holds the model's message and, when the model got a
    // tool call wrong (unknown tool, input that fails the schema), a tool
    // message with the error it wrote for that call. Valid calls have no
    // result yet: those are ours to run.
    const sdkResults = new Map<string, ToolResultPart>();
    for (const message of result.response.messages) {
      if (message.role === 'tool') {
        for (const part of message.content) {
          if (part.type === 'tool-result') {
            sdkResults.set(part.toolCallId, part);
          }
        }
      } else {
        messages.push(message);
      }
    }

    // One at a time, in the order the model asked: see tools.ts.
    const results: ToolResultPart[] = [];
    for (const call of result.toolCalls) {
      const fromSdk = sdkResults.get(call.toolCallId);
      if ('invalid' in call && call.invalid === true && fromSdk !== undefined) {
        results.push(fromSdk);
        emitTool(emit, step, call.toolName, call.input, true, firstLine(outputText(fromSdk)));
        continue;
      }
      let output: Awaited<ReturnType<ToolRunner['run']>>;
      try {
        output = await runner.run(call.toolName, call.input);
      } catch (error) {
        if (error instanceof SandboxError) {
          return finish('sandbox-error', error.message);
        }
        throw error;
      }
      results.push({
        type: 'tool-result',
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output: { type: output.isError ? 'error-text' : 'text', value: output.text },
      });
      emitTool(emit, step, call.toolName, call.input, output.isError, firstLine(output.text));
    }
    if (results.length > 0) {
      messages.push({ role: 'tool', content: results });
    }

    if (runner.passing) {
      return finish('fixed');
    }
    if (runner.attempts >= limits.maxAttempts) {
      return finish('attempts-exhausted');
    }
    if (result.toolCalls.length === 0) {
      return finish('gave-up');
    }
  }
  return finish('step-limit');
}

function emitTool(
  emit: (event: AgentEvent) => void,
  step: number,
  tool: string,
  input: unknown,
  isError: boolean,
  summary: string,
): void {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const target = args.path ?? args.pattern ?? args.changeSummary;
  emit({
    type: 'agent.tool',
    step,
    tool,
    target: typeof target === 'string' ? target : null,
    isError,
    summary,
  });
}

function outputText(part: ToolResultPart): string {
  const { output } = part;
  return output.type === 'text' || output.type === 'error-text'
    ? output.value
    : JSON.stringify(output);
}

function firstLine(text: string): string {
  const line = text.trim().split('\n')[0] ?? '';
  return line.length > 160 ? `${line.slice(0, 160)} ...` : line;
}

/** One trace line per event, e.g. "step 3 (gemini/gemini-3.5-flash): 2 tool calls, 4,210 → 380 tokens". */
export function describeAgentEvent(event: AgentEvent): string {
  if (event.type === 'agent.step') {
    const calls =
      event.toolCalls === 0
        ? 'no tool calls'
        : `${event.toolCalls} tool call${event.toolCalls === 1 ? '' : 's'}`;
    const tokens = `${event.inputTokens.toLocaleString('en-US')} → ${event.outputTokens.toLocaleString('en-US')} tokens`;
    return `step ${event.step} (${event.provider}/${event.model}): ${calls}, ${tokens}`;
  }
  const target = event.target === null ? '' : ` ${event.target}`;
  return `  ${event.tool}${target}: ${event.isError ? '✗ ' : ''}${event.summary}`;
}
