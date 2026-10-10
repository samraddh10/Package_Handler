import { MockLanguageModelV4 } from 'ai/test';
import { LlmRouter } from '../../src/llm/router.js';

/**
 * A mock LLM that plays a script: one turn per call, each a list of tool calls
 * and/or a text reply. Lets the fix agent's tests say exactly what "the model"
 * does at every step, with no network and no real model.
 */

export type ScriptedTurn =
  | { tools: Array<{ name: string; input: unknown }>; text?: string }
  | { text: string }
  | { error: Error };

/** Tokens each scripted call reports: 10 in, 5 out. */
export const TOKENS_PER_CALL = { input: 10, output: 5 };

export function scriptedModel(turns: ScriptedTurn[]) {
  let call = 0;
  /** The prompt of every call, so a test can check what the model was shown. */
  const prompts: unknown[] = [];
  const model = new MockLanguageModelV4({
    doGenerate: async (options) => {
      prompts.push(options.prompt);
      // Past the end of the script, the model keeps saying it is stuck.
      const turn = turns[call] ?? { text: 'I am out of ideas.' };
      call++;
      if ('error' in turn) {
        throw turn.error;
      }
      const toolCalls = 'tools' in turn ? turn.tools : [];
      return {
        content: [
          ...(turn.text === undefined ? [] : [{ type: 'text' as const, text: turn.text }]),
          ...toolCalls.map((toolCall, index) => ({
            type: 'tool-call' as const,
            toolCallId: `call-${call}-${index}`,
            toolName: toolCall.name,
            input: JSON.stringify(toolCall.input),
          })),
        ],
        finishReason: {
          unified: toolCalls.length > 0 ? ('tool-calls' as const) : ('stop' as const),
          raw: undefined,
        },
        usage: {
          inputTokens: {
            total: TOKENS_PER_CALL.input,
            noCache: TOKENS_PER_CALL.input,
            cacheRead: undefined,
            cacheWrite: undefined,
          },
          outputTokens: {
            total: TOKENS_PER_CALL.output,
            text: TOKENS_PER_CALL.output,
            reasoning: undefined,
          },
        },
        warnings: [],
      };
    },
  });
  return { model, prompts, calls: () => call };
}

/** A router with one scripted provider, which never really waits. */
export function scriptedRouter(turns: ScriptedTurn[], maxCallsPerRun = 100) {
  const scripted = scriptedModel(turns);
  const router = new LlmRouter({
    providers: [
      { name: 'gemini', modelId: 'scripted', model: scripted.model, maxInputTokens: 1_000_000 },
    ],
    maxCallsPerRun,
    sleep: async () => {},
  });
  return { router, ...scripted };
}
