import { randomUUID } from 'crypto';

type CacheCtor = typeof import('../ReadThroughAllCache').ReadThroughAllCache;

describe('ReadThroughAllCache (in-memory backing)', () => {
  let originalEnv: NodeJS.ProcessEnv;

  const load = async (): Promise<CacheCtor> =>
    (await import('../ReadThroughAllCache')).ReadThroughAllCache;

  beforeEach(() => {
    originalEnv = { ...process.env };
    process.env.USE_REDIS = 'false';
    jest.resetModules();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test('stores and returns values per key', async () => {
    const Cache = await load();
    const cache = new Cache<Record<string, number>>(`rtac-${randomUUID()}`, 60_000);
    await cache.set('user-1', { a: 1 });

    await expect(cache.get('user-1')).resolves.toEqual({ hit: true, value: { a: 1 } });
    await expect(cache.get('user-2')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('shares entries across instances of the same namespace', async () => {
    const Cache = await load();
    const namespace = `rtac-${randomUUID()}`;
    const writer = new Cache<string>(namespace, 60_000);
    const reader = new Cache<string>(namespace, 60_000);

    await writer.set('user-1', 'value-a');

    await expect(reader.get('user-1')).resolves.toEqual({ hit: true, value: 'value-a' });
  });

  test('invalidateAll orphans every entry without a keyspace scan', async () => {
    const Cache = await load();
    const namespace = `rtac-${randomUUID()}`;
    const writer = new Cache<string>(namespace, 60_000);
    /** A reader with no memoized entries: its next read must observe the new
     *  generation through the shared store, proving eviction comes from the
     *  generation tag rather than a local clear. */
    const reader = new Cache<string>(namespace, 60_000);

    await writer.set('user-1', 'value-a');
    await writer.set('user-2', 'value-b');
    await writer.invalidateAll();

    await expect(reader.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
    await expect(reader.get('user-2')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('entries expire after the ttl', async () => {
    const Cache = await load();
    const cache = new Cache<string>(`rtac-${randomUUID()}`, 40);
    await cache.set('user-1', 'ephemeral');
    await expect(cache.get('user-1')).resolves.toEqual({ hit: true, value: 'ephemeral' });

    await new Promise((resolve) => setTimeout(resolve, 80));

    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('a value written after invalidateAll is served under the new generation', async () => {
    const Cache = await load();
    const cache = new Cache<string>(`rtac-${randomUUID()}`, 60_000);
    await cache.set('user-1', 'before');
    await cache.invalidateAll();
    await cache.set('user-1', 'after');

    await expect(cache.get('user-1')).resolves.toEqual({ hit: true, value: 'after' });
  });

  test('ttl of 0 disables the cache entirely', async () => {
    /** Entries derive from ACL access, so without a TTL there is no bound on
     *  how long a revoked user could keep receiving a stale map. */
    const Cache = await load();
    const cache = new Cache<string>(`rtac-${randomUUID()}`, 0);
    await cache.set('user-1', 'never-cached');

    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
    await cache.invalidateAll();
    await expect(cache.get('user-1')).resolves.toEqual(expect.objectContaining({ hit: false }));
  });

  test('transforms keep the shared store ciphertext while serving plaintext', async () => {
    const Cache = await load();
    const namespace = `rtac-${randomUUID()}`;
    const writer = new Cache<Record<string, string>>(namespace, 60_000, {
      encode: (value) => `enc:${JSON.stringify(value)}`,
      decode: (raw) => JSON.parse(raw.slice(4)),
    });
    const reader = new Cache<Record<string, string>>(namespace, 60_000, {
      encode: (value) => `enc:${JSON.stringify(value)}`,
      decode: (raw) => JSON.parse(raw.slice(4)),
    });

    await writer.set('user-1', { secret: 'plaintext-value' });

    await expect(reader.get('user-1')).resolves.toEqual({
      hit: true,
      value: { secret: 'plaintext-value' },
    });
  });

  test('an undecodable stored entry fails open to a miss', async () => {
    const Cache = await load();
    const namespace = `rtac-${randomUUID()}`;
    /** Writer without transforms stores plaintext JSON-shaped data. */
    const plainWriter = new Cache<Record<string, string>>(namespace, 60_000);
    const decodingReader = new Cache<Record<string, string>>(namespace, 60_000, {
      encode: (value) => JSON.stringify(value),
      decode: () => {
        throw new Error('key rotation');
      },
    });

    await plainWriter.set('user-1', { secret: 'stale-across-rotation' });

    await expect(decodingReader.get('user-1')).resolves.toEqual(
      expect.objectContaining({ hit: false }),
    );
  });

  test('a failing encode degrades to the memo without failing the set', async () => {
    const Cache = await load();
    const cache = new Cache<string>(`rtac-${randomUUID()}`, 60_000, {
      encode: () => {
        throw new Error('no CREDS key');
      },
      decode: (raw) => raw,
    });

    await expect(cache.set('user-1', 'memo-only')).resolves.toBeUndefined();
    await expect(cache.get('user-1')).resolves.toEqual({ hit: true, value: 'memo-only' });
  });
});
