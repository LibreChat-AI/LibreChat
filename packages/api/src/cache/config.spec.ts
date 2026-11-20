import { Keyv } from 'keyv';
import { ConfigMemoryStore } from './config';

function fixture(maxEntries = 3, maxBytes = 4096) {
  const store = new ConfigMemoryStore();
  store.configure({ maxEntries, maxBytes });
  const cache = new Keyv({
    namespace: 'APP_CONFIG',
    store,
    serialize: JSON.stringify,
    deserialize: JSON.parse,
  });
  return { store, cache };
}

describe('ConfigMemoryStore', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('evicts least-recently-read entries without changing serialization or key prefixes', async () => {
    const { store, cache } = fixture(2);
    await cache.set('a', { nested: [1] }, 1000);
    await cache.set('b', { nested: [2] }, 1000);
    const first = await cache.get<{ nested: number[] }>('a');
    first!.nested.push(3);
    await cache.set('c', { nested: [4] }, 1000);
    expect(await cache.get('b')).toBeUndefined();
    expect(await cache.get('a')).toEqual({ nested: [1] });
    expect([...store.keys()]).toEqual(['APP_CONFIG:c', 'APP_CONFIG:a']);
    expect(typeof store.get('APP_CONFIG:a')).toBe('string');
    await cache.clear();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('expires cold keys with one unrefed timer while keeping non-expiring entries', async () => {
    const { store, cache } = fixture();
    await cache.set('_BASE_', { base: true });
    await cache.set('long', 'long', 2000);
    await cache.set('short', 'short', 1000);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1001);
    expect([...store.keys()]).toEqual(['APP_CONFIG:_BASE_', 'APP_CONFIG:long']);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect([...store.keys()]).toEqual(['APP_CONFIG:_BASE_']);
    expect(jest.getTimerCount()).toBe(0);
    await cache.clear();
  });

  it('bounds bytes, skips oversized entries, and reclaims accounting on replacement/delete/clear', async () => {
    const { store, cache } = fixture(10, 512);
    await cache.set('large', 'x'.repeat(300), 1000);
    expect(store.size).toBe(0);
    await cache.set('a', 'x'.repeat(100), 1000);
    await cache.set('b', 'x'.repeat(100), 1000);
    expect(store.size).toBe(1);
    expect(await cache.get('a')).toBeUndefined();
    await cache.set('b', 'small', 1000);
    await cache.set('c', 'small', 1000);
    expect(store.size).toBe(2);
    await cache.delete('b');
    expect(store.size).toBe(1);
    await cache.clear();
    await cache.set('a', 'x'.repeat(100), 1000);
    expect(store.size).toBe(1);
    await cache.clear();
  });

  it('does not let an old expiry remove a replacement and checks expiry even before the timer runs', async () => {
    const { store, cache } = fixture();
    await cache.set('a', 'old', 1000);
    await cache.set('a', 'new', 2000);
    await jest.advanceTimersByTimeAsync(1001);
    expect(await cache.get('a')).toBe('new');
    jest.setSystemTime(Date.now() + 1000);
    expect(await cache.get('a')).toBeUndefined();
    expect(store.size).toBe(0);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('applies smaller reload limits immediately and restores defaults when removed', async () => {
    const { store, cache } = fixture();
    await cache.set('a', 'a');
    await cache.set('b', 'b');
    await cache.set('c', 'c');
    store.configure({ maxEntries: 1 });
    expect([...store.keys()]).toEqual(['APP_CONFIG:c']);
    store.configure();
    await cache.set('d', 'd');
    expect(store.size).toBe(2);
    await cache.clear();
  });
});
