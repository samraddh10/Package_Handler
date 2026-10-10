import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { LanguageModel } from 'ai';
import type { Config, ProviderName } from '../config.js';

/**
 * Turning the provider settings from .env into model objects the router can call.
 *
 * Each AI SDK provider package exposes a factory (createGroq, ...) that takes
 * an API key and returns a function from model id to model object. The model
 * object is what `generateText` talks to; it hides each vendor's HTTP API
 * behind the same interface, which is why the router can swap providers freely.
 */

/** One provider the router may try. */
export interface LlmProvider {
  name: ProviderName;
  modelId: string;
  model: LanguageModel;
  /** Requests estimated above this many tokens skip this provider. */
  maxInputTokens: number;
}

/**
 * The usable providers, in fallback order. A provider needs both an API key
 * and a model id; one missing either is left out, so a single key is enough.
 */
export function buildProviders(llm: Config['llm']): LlmProvider[] {
  const providers: LlmProvider[] = [];
  for (const name of llm.providerOrder) {
    const { apiKey, model: modelId, maxInputTokens } = llm.providers[name];
    if (apiKey === undefined || modelId === undefined) {
      continue;
    }
    providers.push({ name, modelId, model: createModel(name, apiKey, modelId), maxInputTokens });
  }
  return providers;
}

function createModel(name: ProviderName, apiKey: string, modelId: string): LanguageModel {
  switch (name) {
    case 'gemini':
      return createGoogleGenerativeAI({ apiKey })(modelId);
    case 'groq':
      return createGroq({ apiKey })(modelId);
    case 'openrouter':
      return createOpenRouter({ apiKey })(modelId);
  }
}
