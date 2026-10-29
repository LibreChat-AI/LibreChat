import type { IUser } from '@librechat/data-schemas';
import type { AuthUserDocCacheMode } from './userDocCache';
import {
  AUTH_USER_DOC_CACHE_TTL_MS,
  AUTH_USER_FRESHNESS_PROJECTION,
  buildAuthUserDocReverseIndexKey,
} from './userDocCache';
import { JWT_USER_PROJECTION, loadJwtUser } from './jwt';

const UPDATED_AT = new Date('2026-10-20T00:00:00.000Z');

function makeStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    /** Round-trips through JSON, as Redis does, so dates come back as strings. */
    get: async <T = unknown>(key: string) => {
      const value = values.get(key);
      return (value === undefined ? undefined : JSON.parse(JSON.stringify(value))) as T;
    },
    set: jest.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => values.delete(key)),
  };
}

function makeUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: 'user-1',
    role: 'USER',
    email: 'a@example.com',
    updatedAt: UPDATED_AT,
    ...overrides,
  } as unknown as IUser;
}

/** `stored` is the database: each read sees whatever it holds at that moment. */
function makeDeps(initial: IUser | null, cacheMode: AuthUserDocCacheMode = 'on') {
  const store = makeStore();
  const db = { stored: initial };
  return {
    store,
    db,
    deps: {
      cacheMode,
      getUserById: jest.fn(async (): Promise<IUser | null> => db.stored),
      getCacheStore: () => store,
    },
  };
}

const fullReads = (getUserById: jest.Mock) =>
  getUserById.mock.calls.filter(([, projection]) => projection === JWT_USER_PROJECTION).length;

describe('loadJwtUser', () => {
  it('reads the user every request while the cache is off', async () => {
    const { deps, store } = makeDeps(makeUser(), 'off');

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    await loadJwtUser('user-1', deps);

    expect(deps.getUserById).toHaveBeenCalledTimes(2);
    expect(deps.getUserById).toHaveBeenCalledWith('user-1', JWT_USER_PROJECTION);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('serves a request burst from the cache after a small freshness read', async () => {
    const { deps, store } = makeDeps(makeUser());

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    const second = await loadJwtUser('user-1', deps);

    expect(fullReads(deps.getUserById)).toBe(1);
    expect(deps.getUserById).toHaveBeenLastCalledWith('user-1', AUTH_USER_FRESHNESS_PROJECTION);
    expect(second.user).toMatchObject({ _id: 'user-1', role: 'USER' });
    expect(second.deleting).toBe(false);
    /** The reverse index lets every user mutation evict this entry. */
    expect(store.values.get(buildAuthUserDocReverseIndexKey('user-1'))).toHaveLength(1);
  });

  it('never serves a document cached from a read that raced a user mutation', async () => {
    const { deps, db } = makeDeps(makeUser());
    const lookup = await loadJwtUser('user-1', deps);

    /** A credential change commits and runs its eviction before this cache write lands. */
    db.stored = makeUser({
      credentialsChangedAt: new Date('2026-10-26T00:00:00.000Z'),
      updatedAt: new Date('2026-10-26T00:00:00.000Z'),
    } as Partial<IUser>);
    await lookup.remember(false);

    const next = await loadJwtUser('user-1', deps);
    expect(fullReads(deps.getUserById)).toBe(2);
    expect(next.user).toMatchObject({ credentialsChangedAt: db.stored.credentialsChangedAt });
  });

  it('falls back to the database when the cached user is fenced or gone', async () => {
    const { deps, db } = makeDeps(makeUser());
    await (await loadJwtUser('user-1', deps)).remember(false);

    db.stored = makeUser({ agentTriggerDeletionStartedAt: new Date('2026-10-01T00:00:00.000Z') });
    const fenced = await loadJwtUser('user-1', deps);
    expect(fenced.deleting).toBe(true);

    db.stored = null;
    const removed = await loadJwtUser('user-1', deps);
    expect(removed.user).toBeNull();
    expect(removed.deleting).toBe(false);
  });

  it('never caches a fenced user', async () => {
    const { deps, store } = makeDeps(
      makeUser({ agentTriggerDeletionStartedAt: new Date('2026-10-01T00:00:00.000Z') }),
    );

    const lookup = await loadJwtUser('user-1', deps);
    await lookup.remember(false);

    expect(lookup.deleting).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('does not cache a document whose lookup outlived the cache window', async () => {
    const { deps, store } = makeDeps(makeUser());
    const start = Date.now();
    const now = jest.spyOn(Date, 'now').mockReturnValue(start);
    /** The read finishes after a mutation could already have evicted the key. */
    deps.getUserById.mockImplementationOnce(async () => {
      now.mockReturnValue(start + AUTH_USER_DOC_CACHE_TTL_MS + 1);
      return makeUser();
    });

    try {
      await (await loadJwtUser('user-1', deps)).remember(false);
    } finally {
      now.mockRestore();
    }

    expect(store.set).not.toHaveBeenCalled();
  });

  it('evicts instead of caching when the caller wrote to the user', async () => {
    const { deps, store } = makeDeps(makeUser({ role: undefined }));

    await (await loadJwtUser('user-1', deps)).remember(true);
    await loadJwtUser('user-1', deps);

    /** Eviction writes its fence marker; the user document itself is never cached. */
    const documentWrites = store.set.mock.calls.filter(
      ([key]) => !String(key).startsWith('auth-user-doc-evicted:'),
    );
    expect(documentWrites).toEqual([]);
    expect(fullReads(deps.getUserById)).toBe(2);
  });
});
