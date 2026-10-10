import { existsSync } from 'node:fs';
import { z } from 'zod';

/** The LLM providers the agent knows how to call. */
export const PROVIDER_NAMES = ['gemini', 'groq', 'openrouter'] as const;
export type ProviderName = (typeof PROVIDER_NAMES)[number];

export interface ProviderSettings {
  apiKey: string | undefined;
  model: string | undefined;
  /** Requests estimated to be bigger than this skip the provider. */
  maxInputTokens: number;
}

/** Every setting the agent reads, already validated and converted to the right types. */
export interface Config {
  llm: {
    providerOrder: ProviderName[];
    providers: Record<ProviderName, ProviderSettings>;
    maxCallsPerRun: number;
  };
  github: { token: string | undefined };
  /** `password` is sent with AUTH; docker-compose.yml starts Redis with the same one. */
  redis: { url: string; password: string | undefined };
  sandbox: {
    image: string;
    cpus: number;
    memoryMb: number;
    installTimeoutSec: number;
    testTimeoutSec: number;
  };
  fixAgent: { maxAttempts: number; maxSteps: number };
  workspaceDir: string;
}

/** Thrown when the environment is invalid. `problems` holds one readable line per bad setting. */
export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`Invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join('\n')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

// Environment variables are always strings; z.coerce.number() turns "2" into 2.
const positiveInt = z.coerce.number().int().positive();

// "groq, gemini" -> ['groq', 'gemini'], rejecting unknown names and repeats.
const providerOrderSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
  )
  .pipe(
    z
      .array(z.enum(PROVIDER_NAMES))
      .min(1, 'must name at least one provider')
      .refine((names) => new Set(names).size === names.length, 'lists the same provider twice'),
  );

// One entry per environment variable. Keys missing from the environment get the default.
const envSchema = z.object({
  GOOGLE_GENERATIVE_AI_API_KEY: z.string().optional(),
  GEMINI_MODEL: z.string().optional(),
  GEMINI_MAX_INPUT_TOKENS: positiveInt.default(200_000),

  GROQ_API_KEY: z.string().optional(),
  GROQ_MODEL: z.string().optional(),
  GROQ_MAX_INPUT_TOKENS: positiveInt.default(6_000),

  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_MAX_INPUT_TOKENS: positiveInt.default(30_000),

  LLM_PROVIDER_ORDER: providerOrderSchema.default([...PROVIDER_NAMES]),
  LLM_MAX_CALLS_PER_RUN: positiveInt.default(60),

  GITHUB_TOKEN: z.string().optional(),

  REDIS_URL: z
    .url({ protocol: /^rediss?$/, error: 'must be a redis:// or rediss:// URL' })
    .default('redis://localhost:6379'),
  REDIS_PASSWORD: z.string().optional(),

  SANDBOX_IMAGE: z.string().default('node:22-bookworm'),
  SANDBOX_CPUS: positiveInt.default(2),
  SANDBOX_MEMORY_MB: positiveInt.default(2048),
  INSTALL_TIMEOUT_SEC: positiveInt.default(300),
  TEST_TIMEOUT_SEC: positiveInt.default(300),

  FIX_MAX_ATTEMPTS: positiveInt.default(3),
  FIX_MAX_STEPS: positiveInt.default(20),

  WORKSPACE_DIR: z.string().default('.workspaces'),
});

/**
 * Validates raw environment variables and turns them into a typed Config.
 * It takes `env` as a parameter instead of reading process.env itself,
 * so tests can pass plain objects. Throws ConfigError listing every problem at once.
 */
export function parseConfig(env: Record<string, string | undefined>): Config {
  const result = envSchema.safeParse(dropBlankValues(env));
  if (!result.success) {
    const problems = result.error.issues.map(
      (issue) => `${String(issue.path[0] ?? 'environment')}: ${issue.message}`,
    );
    throw new ConfigError(problems);
  }

  const values = result.data;
  return {
    llm: {
      providerOrder: values.LLM_PROVIDER_ORDER,
      providers: {
        gemini: {
          apiKey: values.GOOGLE_GENERATIVE_AI_API_KEY,
          model: values.GEMINI_MODEL,
          maxInputTokens: values.GEMINI_MAX_INPUT_TOKENS,
        },
        groq: {
          apiKey: values.GROQ_API_KEY,
          model: values.GROQ_MODEL,
          maxInputTokens: values.GROQ_MAX_INPUT_TOKENS,
        },
        openrouter: {
          apiKey: values.OPENROUTER_API_KEY,
          model: values.OPENROUTER_MODEL,
          maxInputTokens: values.OPENROUTER_MAX_INPUT_TOKENS,
        },
      },
      maxCallsPerRun: values.LLM_MAX_CALLS_PER_RUN,
    },
    github: { token: values.GITHUB_TOKEN },
    redis: { url: values.REDIS_URL, password: values.REDIS_PASSWORD },
    sandbox: {
      image: values.SANDBOX_IMAGE,
      cpus: values.SANDBOX_CPUS,
      memoryMb: values.SANDBOX_MEMORY_MB,
      installTimeoutSec: values.INSTALL_TIMEOUT_SEC,
      testTimeoutSec: values.TEST_TIMEOUT_SEC,
    },
    fixAgent: { maxAttempts: values.FIX_MAX_ATTEMPTS, maxSteps: values.FIX_MAX_STEPS },
    workspaceDir: values.WORKSPACE_DIR,
  };
}

/**
 * Loads KEY=value lines from a .env file into process.env, if the file exists,
 * using Node's built-in loader. Variables already set in the shell win over the file.
 * Returns whether a file was found.
 */
export function loadEnvFile(path = '.env'): boolean {
  if (!existsSync(path)) {
    return false;
  }
  process.loadEnvFile(path);
  return true;
}

/** `KEY=` in a .env file gives an empty string; treat that the same as "not set". */
function dropBlankValues(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    const trimmed = value?.trim();
    cleaned[key] = trimmed === '' ? undefined : trimmed;
  }
  return cleaned;
}
