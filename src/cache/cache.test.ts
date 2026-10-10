import { describe, expect, it } from 'vitest';
import { type Cache, FallbackCache, MemoryCache } from './cache.js';

describe('MemoryCache', () => {
  it('returns what was stored until it expires', async () => {
    let now = 0;
    const cache = new MemoryCache(() => now);
    await cache.set('k', 'v', 10);

    expect(await cache.get('k')).toBe('v');
    now = 9_999;
    expect(await cache.get('k')).toBe('v');
    now = 10_000;
    expect(await cache.get('k')).toBeNull();
  });

  it('returns null for keys never stored', async () => {
    expect(await new MemoryCache().get('missing')).toBeNull();
  });
});

/** A cache that works until `broken` is set, like a Redis that goes away mid-run. */
class FlakyCache implements Cache {
  readonly kind = 'redis';
  broken = false;
  closed = false;
  readonly store = new Map<string, string>();

  async get(key: string) {
    if (this.broken) throw new Error('Connection is closed.');
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.broken) throw new Error('Connection is closed.');
    this.store.set(key, value);
  }
  async close() {
    this.closed = true;
  }
}

describe('FallbackCache', () => {
  it('uses the primary while it works', async () => {
    const primary = new FlakyCache();
    const cache = new FallbackCache(primary, () => {});
    await cache.set('k', 'v', 60);

    expect(primary.store.get('k')).toBe('v');
    expect(await cache.get('k')).toBe('v');
    expect(cache.kind).toBe('redis');
  });

  it('switches to memory for good when the primary fails, warning only once', async () => {
    const primary = new FlakyCache();
    const warnings: string[] = [];
    const cache = new FallbackCache(primary, (message) => warnings.push(message));
    primary.broken = true;

    expect(await cache.get('k')).toBeNull();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');

    expect(cache.kind).toBe('memory');
    expect(primary.closed).toBe(true);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/Redis stopped answering \(Connection is closed\.\)/);
  });
});
