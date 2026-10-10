import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Cache, openCache } from '../../src/cache/cache.js';
import { loadEnvFile, parseConfig } from '../../src/config.js';

/**
 * The cache against a real Redis. Needs `docker compose up -d redis` and
 * REDIS_PASSWORD in .env (the same one Redis was started with).
 */

loadEnvFile();
const { redis } = parseConfig(process.env);

describe('Redis cache', () => {
  let cache: Cache;
  const warnings: string[] = [];

  beforeAll(async () => {
    cache = await openCache({ ...redis, onWarning: (message) => warnings.push(message) });
  });

  afterAll(async () => {
    await cache.close();
  });

  it('connects with the password from .env', () => {
    expect(warnings).toEqual([]);
    expect(cache.kind).toBe('redis');
  });

  it('round-trips a value, and Redis itself expires it', async () => {
    const key = `test:${randomUUID()}`;
    await cache.set(key, '{"hello":"world"}', 1);
    expect(await cache.get(key)).toBe('{"hello":"world"}');

    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await cache.get(key)).toBeNull();
  });

  it('falls back to memory with a clear warning when the password is wrong', async () => {
    const messages: string[] = [];
    const fallback = await openCache({
      url: redis.url,
      password: 'wrong-password',
      onWarning: (message) => messages.push(message),
    });

    expect(fallback.kind).toBe('memory');
    expect(messages[0]).toMatch(/WRONGPASS/);
    expect(messages[0]).toMatch(/REDIS_PASSWORD/);
    await fallback.close();
  });

  it('falls back to memory within a few seconds when nothing listens', async () => {
    const messages: string[] = [];
    const started = Date.now();
    const fallback = await openCache({
      url: 'redis://127.0.0.1:6390',
      password: undefined,
      onWarning: (message) => messages.push(message),
    });

    expect(fallback.kind).toBe('memory');
    expect(messages[0]).toMatch(/ECONNREFUSED/);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
