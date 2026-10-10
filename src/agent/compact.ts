import type { ModelMessage, ToolResultPart } from 'ai';
import { estimateRequestTokens } from '../llm/tokens.js';

/**
 * Context compaction: keeping the conversation small as the agent works.
 *
 * Every LLM call resends the whole conversation, so a file read in step 2 is
 * paid for again in steps 3, 4, 5 and so on. Most old tool output has done its
 * job by then (the model read the file, then rewrote it), so once the
 * conversation passes a size threshold, old tool results are replaced with a
 * one-line stub that says what was there. The model's own messages, the task,
 * and the most recent tool results stay whole, and the stub tells the model it
 * can call the tool again if it needs the content back.
 *
 * The message structure is never changed, only the text inside old results:
 * providers reject a conversation where a tool call has no matching result.
 */

/** Compact once the conversation is estimated above this many tokens. */
export const COMPACT_ABOVE_TOKENS = 20_000;
/** The most recent tool messages are always kept whole. */
const KEEP_RECENT_TOOL_MESSAGES = 2;
/** Results this short are cheaper to keep than to describe. */
const MIN_STUB_CHARS = 300;

/**
 * Returns the messages with old tool results replaced by stubs when the
 * conversation is over the threshold; otherwise the same array. Pure: the
 * input is not modified.
 */
export function compactMessages(
  messages: ModelMessage[],
  options: { instructions?: string; maxTokens?: number } = {},
): ModelMessage[] {
  const maxTokens = options.maxTokens ?? COMPACT_ABOVE_TOKENS;
  if (estimateRequestTokens({ instructions: options.instructions, messages }) <= maxTokens) {
    return messages;
  }

  const toolMessageIndexes = messages.flatMap((message, index) =>
    message.role === 'tool' ? [index] : [],
  );
  const keep = new Set(toolMessageIndexes.slice(-KEEP_RECENT_TOOL_MESSAGES));
  const calls = toolCallsById(messages);

  return messages.map((message, index) => {
    if (message.role !== 'tool' || keep.has(index)) {
      return message;
    }
    return {
      ...message,
      content: message.content.map((part) =>
        part.type === 'tool-result' ? stubResult(part, calls.get(part.toolCallId)) : part,
      ),
    };
  });
}

function stubResult(part: ToolResultPart, input: unknown): ToolResultPart {
  const { output } = part;
  if (output.type !== 'text' && output.type !== 'error-text') {
    return part;
  }
  if (output.value.length < MIN_STUB_CHARS || output.value.startsWith('[removed')) {
    return part;
  }
  const what = describeCall(part.toolName, input);
  return {
    ...part,
    output: {
      type: output.type,
      value: `[removed to save space: the output of ${what}. Call the tool again if you still need it.]`,
    },
  };
}

/** "read_file src/app.js", "search_code \"app.del\"", ... for the stub text. */
function describeCall(toolName: string, input: unknown): string {
  const args = (typeof input === 'object' && input !== null ? input : {}) as Record<
    string,
    unknown
  >;
  const target = args.path ?? args.pattern;
  if (typeof target === 'string') {
    return `${toolName} ${toolName === 'search_code' ? JSON.stringify(target) : target}`;
  }
  return toolName;
}

/** The input of every tool call in the conversation, by call id. */
function toolCallsById(messages: ModelMessage[]): Map<string, unknown> {
  const calls = new Map<string, unknown>();
  for (const message of messages) {
    if (message.role !== 'assistant' || typeof message.content === 'string') {
      continue;
    }
    for (const part of message.content) {
      if (part.type === 'tool-call') {
        calls.set(part.toolCallId, part.input);
      }
    }
  }
  return calls;
}
