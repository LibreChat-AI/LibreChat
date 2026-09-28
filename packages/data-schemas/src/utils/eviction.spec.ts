import { AUTH_USER_DOC_BY_ID_PREFIX } from 'librechat-data-provider';
import { evictAuthUserDocs } from './eviction';

const INDEX_KEY = `${AUTH_USER_DOC_BY_ID_PREFIX}:user-1`;
const OTHER_INDEX_KEY = `${AUTH_USER_DOC_BY_ID_PREFIX}:user-2`;

/** A Map-backed store that rejects the operations named for a key, as a throwing Redis store does. */
function makeStore(failures: { get?: string[]; delete?: string[] } = {}) {
  const values = new Map<string, unknown>([
    [INDEX_KEY, ['doc-a', 'doc-b']],
    ['doc-a', { id: 'user-1' }],
    ['doc-b', { id: 'user-1' }],
    ['doc-c', { id: 'user-1' }],
    [OTHER_INDEX_KEY, ['doc-other']],
    ['doc-other', { id: 'user-2' }],
  ]);
  return {
    values,
    get: jest.fn(async (key: string) => {
      if (failures.get?.includes(key)) {
        throw new Error(`GET ${key} failed`);
      }
      return values.get(key);
    }),
    delete: jest.fn(async (key: string) => {
      if (failures.delete?.includes(key)) {
        throw new Error(`DEL ${key} failed`);
      }
      return values.delete(key);
    }),
  };
}

function expectOtherUserCached(store: ReturnType<typeof makeStore>) {
  expect(store.values.get(OTHER_INDEX_KEY)).toEqual(['doc-other']);
  expect(store.values.get('doc-other')).toEqual({ id: 'user-2' });
}

describe('evictAuthUserDocs', () => {
  it('lets a retry find a document an earlier failed delete left behind', async () => {
    const store = makeStore({ delete: ['doc-a'] });
    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    store.delete.mockImplementation(async (key: string) => store.values.delete(key));
    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(true);

    expect(store.values.has('doc-a')).toBe(false);
    expect(store.values.has(INDEX_KEY)).toBe(false);
  });

  it('deletes the indexed and explicit documents and the index', async () => {
    const store = makeStore();

    await expect(evictAuthUserDocs(store, { userId: 'user-1', cacheKey: 'doc-c' })).resolves.toBe(
      true,
    );

    for (const key of [INDEX_KEY, 'doc-a', 'doc-b', 'doc-c']) {
      expect(store.values.has(key)).toBe(false);
    }
    expectOtherUserCached(store);
  });

  it('reports a failed index read and keeps the index for a retry', async () => {
    const store = makeStore({ get: [INDEX_KEY] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1', cacheKey: 'doc-c' })).resolves.toBe(
      false,
    );

    expect(store.values.has('doc-c')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expect(store.values.has('doc-a')).toBe(true);
    expectOtherUserCached(store);
  });

  it.each([
    ['a string', 'doc-a'],
    ['a list with a non-string entry', ['doc-a', 42]],
  ])('treats a reverse index holding %s as unreadable', async (_label, indexed) => {
    const store = makeStore();
    store.values.set(INDEX_KEY, indexed);

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    expect(store.values.get(INDEX_KEY)).toEqual(indexed);
    expect(store.values.has('doc-a')).toBe(true);
  });

  it('reports a failed document delete, deletes the others and keeps the index for a retry', async () => {
    const store = makeStore({ delete: ['doc-a'] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(false);

    expect(store.values.has('doc-a')).toBe(true);
    expect(store.values.has('doc-b')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expectOtherUserCached(store);
  });

  it('counts documents as evicted when only the index delete fails', async () => {
    const store = makeStore({ delete: [INDEX_KEY] });

    await expect(evictAuthUserDocs(store, { userId: 'user-1' })).resolves.toBe(true);

    expect(store.values.has('doc-a')).toBe(false);
    expect(store.values.has('doc-b')).toBe(false);
    expect(store.values.get(INDEX_KEY)).toEqual(['doc-a', 'doc-b']);
    expectOtherUserCached(store);
  });
});
