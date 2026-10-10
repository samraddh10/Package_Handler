/**
 * Rough token counting.
 *
 * Providers bill and rate-limit in tokens, not characters, but each model has
 * its own tokenizer and none of them ships with the SDK. For routing decisions
 * ("is this request too big for Groq?") and budgets an estimate is enough:
 * English text and code average about 4 characters per token. The estimate
 * leans high for code full of short symbols, which is the safe direction.
 */

const CHARS_PER_TOKEN = 4;
const TOOL_ALLOWANCE_CHARS = 600;

/** Estimated token count of a piece of text. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Estimated input tokens of a whole request: instructions, prompt or messages,
 * and the tool definitions, which the provider also sends to the model.
 * Everything is measured as JSON, which is close to what goes over the wire.
 */
export function estimateRequestTokens(parts: {
  instructions?: string | undefined;
  prompt?: string | undefined;
  messages?: unknown;
  toolNames?: string[] | undefined;
}): number {
  let chars = (parts.instructions ?? '').length + (parts.prompt ?? '').length;
  if (parts.messages !== undefined) {
    chars += JSON.stringify(parts.messages).length;
  }
  // Tool definitions (description + JSON Schema) are not plain strings here,
  // so each tool gets a flat allowance of ~150 tokens.
  chars += (parts.toolNames ?? []).length * TOOL_ALLOWANCE_CHARS;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

/**
 * Cuts `text` to roughly `maxTokens`, at a line break when there is one near
 * the cut, and says so at the end. The marker matters: a model that sees text
 * stop mid-sentence may guess at the rest, one that is told it was cut does not.
 */
export function trimToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) {
    return text;
  }
  const marker = '\n[... cut to fit the size budget]';
  let cut = text.slice(0, Math.max(0, maxChars - marker.length));
  const lastNewline = cut.lastIndexOf('\n');
  // Only back up to the line break if that keeps most of the text.
  if (lastNewline > cut.length * 0.8) {
    cut = cut.slice(0, lastNewline);
  }
  return cut + marker;
}
