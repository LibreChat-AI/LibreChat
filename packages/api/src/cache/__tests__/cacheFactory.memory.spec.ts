import { standardCache } from '~/cache/cacheFactory';

describe('standardCache in-memory serialization', () => {
  it('returns copies, never references into the store', async () => {
    const cache = standardCache('memory-serializer-copies');
    const stored = { nested: { list: [1, 2, 3] } };
    await cache.set('key', stored);

    const first = await cache.get<typeof stored>('key');
    expect(first).toEqual(stored);
    expect(first).not.toBe(stored);
    first!.nested.list.push(4);

    const second = await cache.get<typeof stored>('key');
    expect(second!.nested.list).toEqual([1, 2, 3]);
  });

  it('keeps the JSON semantics readers already rely on: dates come back as ISO strings', async () => {
    const cache = standardCache('memory-serializer-dates');
    await cache.set('key', { at: new Date('2026-08-23T12:00:00.000Z') });

    const got = await cache.get<{ at: unknown }>('key');
    expect(got!.at).toBe('2026-08-23T12:00:00.000Z');
  });

  it('does not revive Buffers: a plain JSON round trip is the documented contract', async () => {
    /** The Buffer-aware reviver cost ~8x a plain JSON parse on every read, and an
     *  instrumented e2e sweep found no namespace caching a Buffer. If one ever needs
     *  to, it must not use the in-memory standardCache. */
    const cache = standardCache('memory-serializer-buffers');
    await cache.set('key', { blob: Buffer.from('hi') });

    const got = await cache.get<{ blob: unknown }>('key');
    expect(Buffer.isBuffer(got!.blob)).toBe(false);
    expect(got!.blob).toEqual({ type: 'Buffer', data: [104, 105] });
  });
});
