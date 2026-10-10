import { Redis } from 'ioredis';

/**
 * A small key-value cache with expiry, used to remember changelog analyses.
 *
 * Analysing express 4 → 5 costs an LLM call and the answer does not change,
 * so it is stored and reused across runs (and, in Phase 2, across workers).
 * Redis is the real store; an in-memory map stands in when Redis is not
 * running, because the cache is an optimisation and never a reason to fail.
 */
export interface Cache {
  /** "redis" or "memory", for messages like "cache hit (redis)". */
  readonly kind: 'redis' | 'memory';
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`; it disappears after `ttlSec` seconds. */
  set(key: string, value: string, ttlSec: number): Promise<void>;
  close(): Promise<void>;
}

/** A Map with expiry times. Lives only as long as the process. */
export class MemoryCache implements Cache {
  readonly kind = 'memory';
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  async get(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (entry === undefined) {
      return null;
    }
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlSec * 1000 });
  }

  async close(): Promise<void> {
    this.entries.clear();
  }
}

/** The real store: Redis keeps entries across runs, and `EX` makes Redis itself expire them. */
export class RedisCache implements Cache {
  readonly kind = 'redis';

  constructor(private readonly redis: Redis) {}

  async get(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSec);
  }

  async close(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      this.redis.disconnect();
    }
  }
}

/**
 * Uses `primary` until it fails once, then warns once and uses an in-memory
 * cache for the rest of the run. Switching for good (rather than retrying
 * Redis on every call) keeps a dead Redis from adding a delay to every lookup.
 */
export class FallbackCache implements Cache {
  private active: Cache;
  private warned = false;

  constructor(
    primary: Cache,
    private readonly onWarning: (message: string) => void,
    private readonly fallback: Cache = new MemoryCache(),
  ) {
    this.active = primary;
  }

  get kind(): Cache['kind'] {
    return this.active.kind;
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.active.get(key);
    } catch (error) {
      await this.switchToFallback(error);
      return this.active.get(key);
    }
  }

  async set(key: string, value: string, ttlSec: number): Promise<void> {
    try {
      await this.active.set(key, value, ttlSec);
    } catch (error) {
      await this.switchToFallback(error);
      await this.active.set(key, value, ttlSec);
    }
  }

  async close(): Promise<void> {
    await this.active.close();
  }

  private async switchToFallback(error: unknown): Promise<void> {
    if (this.active === this.fallback) {
      throw error;
    }
    const failed = this.active;
    this.active = this.fallback;
    if (!this.warned) {
      this.warned = true;
      this.onWarning(`Redis stopped answering (${messageOf(error)}); using an in-memory cache.`);
    }
    await failed.close().catch(() => {});
  }
}

/**
 * Connects to Redis and checks it answers, or warns and returns an in-memory
 * cache. Never throws: no Redis means slower runs, not failed ones.
 *
 * The ioredis options make a dead Redis fail in about a second instead of
 * hanging: no queueing commands while disconnected (`enableOfflineQueue`),
 * one retry per command, and no reconnect loop.
 */
export async function openCache(options: {
  url: string;
  password: string | undefined;
  onWarning: (message: string) => void;
  connectTimeoutMs?: number;
}): Promise<Cache> {
  const redis = new Redis(options.url, {
    password: options.password,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: options.connectTimeoutMs ?? 2000,
    retryStrategy: () => null,
  });
  // Without a listener, ioredis prints every connection error to the console.
  // The listener also keeps the real reason: once ioredis gives up, the
  // promise only says "Connection is closed.", even for a wrong password.
  let lastError: unknown;
  redis.on('error', (error) => {
    lastError = error;
  });

  try {
    await redis.connect();
    // Proves the password was accepted, not just that the port is open.
    await redis.ping();
  } catch (error) {
    redis.disconnect();
    const reason = messageOf(lastError ?? error);
    const hint = /NOAUTH|WRONGPASS|AUTH/.test(reason)
      ? 'Check that REDIS_PASSWORD in .env matches the one Redis was started with.'
      : 'Start it with: docker compose up -d redis';
    options.onWarning(
      `Redis is not usable at ${redactUrl(options.url)} (${reason}); using an in-memory ` +
        `cache, so results are not kept between runs. ${hint}`,
    );
    return new MemoryCache();
  }
  return new FallbackCache(new RedisCache(redis), options.onWarning);
}

function messageOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message !== '') {
    return error.message;
  }
  // A refused connection to "localhost" tries IPv6 and IPv4 and fails with an
  // AggregateError whose message is empty; the useful part is the code.
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}

function redactUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.password) {
    parsed.password = '***';
  }
  return parsed.toString();
}
