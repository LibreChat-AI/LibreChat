import { Keyv } from 'keyv';
import { consumeCacheEntry, restoreCacheEntry } from './consume';

describe('restoreCacheEntry', () => {
  it('does not restore an entry whose remaining time has already passed', async () => {
    const cache = new Keyv({ ttl: 30_000 });
    await cache.set('code', 'value', 30_000);
    const consumed = await consumeCacheEntry<string>(cache, 'code');
    expect(consumed?.expires).toBeDefined();

    const setSpy = jest.spyOn(cache, 'set');
    await restoreCacheEntry(cache, 'code', consumed!, consumed!.expires! + 1);

    expect(setSpy).not.toHaveBeenCalled();
    await expect(cache.get('code')).resolves.toBeUndefined();
  });

  it('restores a live entry with its remaining ttl', async () => {
    const cache = new Keyv({ ttl: 30_000 });
    await cache.set('code', 'value', 30_000);
    const consumed = await consumeCacheEntry<string>(cache, 'code');
    expect(consumed?.expires).toBeDefined();

    const setSpy = jest.spyOn(cache, 'set');
    const now = consumed!.expires! - 10_000;
    await restoreCacheEntry(cache, 'code', consumed!, now);

    expect(setSpy).toHaveBeenCalledWith('code', 'value', 10_000);
    await expect(cache.get('code')).resolves.toBe('value');
  });

  it("uses the cache's default ttl when the consumed entry carries no expiry", async () => {
    const cache = new Keyv({ ttl: 5_000 });
    const setSpy = jest.spyOn(cache, 'set');

    await restoreCacheEntry(cache, 'code', { value: 'value' });

    expect(setSpy).toHaveBeenCalledWith('code', 'value', 5_000);
  });

  it('does not restore an entry whose remaining time has exactly elapsed', async () => {
    const cache = new Keyv({ ttl: 30_000 });
    const setSpy = jest.spyOn(cache, 'set');
    const now = 1_000;

    await restoreCacheEntry(cache, 'code', { value: 'value', expires: now }, now);

    expect(setSpy).not.toHaveBeenCalled();
  });

  it('falls back to the cache default ttl for a non-numeric expires instead of treating it as already elapsed', async () => {
    const cache = new Keyv({ ttl: 5_000 });
    const setSpy = jest.spyOn(cache, 'set');

    await restoreCacheEntry(cache, 'code', {
      value: 'value',
      expires: null as unknown as number,
    });

    expect(setSpy).toHaveBeenCalledWith('code', 'value', 5_000);
  });
});
