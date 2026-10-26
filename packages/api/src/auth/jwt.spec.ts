import type { IUser } from '@librechat/data-schemas';
import { buildAuthUserDocReverseIndexKey } from './userDocCache';
import { cacheConfig } from '~/cache/cacheConfig';
import { JWT_USER_PROJECTION, loadJwtUser } from './jwt';

const ORIGINAL_MODE = process.env.AUTH_USER_CACHE_MODE;
const ORIGINAL_USE_REDIS = cacheConfig.USE_REDIS;
const ORIGINAL_FORCED = [...cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES];

function makeStore() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async <T = unknown>(key: string) => values.get(key) as T | undefined,
    set: jest.fn(async (key: string, value: unknown) => {
      values.set(key, value);
      return true;
    }),
    delete: jest.fn(async (key: string) => values.delete(key)),
  };
}

function makeUser(overrides: Partial<IUser> = {}): IUser {
  return { _id: 'user-1', role: 'USER', email: 'a@example.com', ...overrides } as unknown as IUser;
}

function makeDeps(user: IUser | null, active = true) {
  const store = makeStore();
  return {
    store,
    deps: {
      getUserById: jest.fn(async () => user),
      isPrincipalActive: jest.fn(async () => active),
      getCacheStore: () => store,
    },
  };
}

function enableCache(on: boolean) {
  if (on) {
    process.env.AUTH_USER_CACHE_MODE = 'on';
    cacheConfig.USE_REDIS = true;
    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [];
  } else {
    delete process.env.AUTH_USER_CACHE_MODE;
  }
}

describe('loadJwtUser', () => {
  afterEach(() => {
    if (ORIGINAL_MODE === undefined) {
      delete process.env.AUTH_USER_CACHE_MODE;
    } else {
      process.env.AUTH_USER_CACHE_MODE = ORIGINAL_MODE;
    }
    cacheConfig.USE_REDIS = ORIGINAL_USE_REDIS;
    cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES = [...ORIGINAL_FORCED];
  });

  it('reads the user every request while the cache is off', async () => {
    enableCache(false);
    const { deps, store } = makeDeps(makeUser());

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    await loadJwtUser('user-1', deps);

    expect(deps.getUserById).toHaveBeenCalledTimes(2);
    expect(deps.getUserById).toHaveBeenCalledWith('user-1', JWT_USER_PROJECTION);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('serves a request burst from the cache and still reads the deletion fence', async () => {
    enableCache(true);
    const { deps, store } = makeDeps(makeUser());

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    const second = await loadJwtUser('user-1', deps);

    expect(deps.getUserById).toHaveBeenCalledTimes(1);
    expect(deps.isPrincipalActive).toHaveBeenCalledTimes(1);
    expect(second.user).toMatchObject({ _id: 'user-1', role: 'USER' });
    expect(second.deleting).toBe(false);
    /** The reverse index lets every user mutation evict this entry. */
    expect(store.values.get(buildAuthUserDocReverseIndexKey('user-1'))).toHaveLength(1);
  });

  it('falls back to the database when a cached principal is no longer active', async () => {
    enableCache(true);
    const { deps } = makeDeps(makeUser());
    await (await loadJwtUser('user-1', deps)).remember(false);

    deps.getUserById.mockResolvedValueOnce(
      makeUser({ agentTriggerDeletionStartedAt: new Date('2026-10-01T00:00:00.000Z') }),
    );
    deps.isPrincipalActive.mockResolvedValueOnce(false);
    const fenced = await loadJwtUser('user-1', deps);
    expect(fenced.deleting).toBe(true);

    deps.getUserById.mockResolvedValueOnce(null);
    deps.isPrincipalActive.mockResolvedValueOnce(false);
    const removed = await loadJwtUser('user-1', deps);
    expect(removed.user).toBeNull();
    expect(removed.deleting).toBe(false);
  });

  it('never caches a fenced user', async () => {
    enableCache(true);
    const { deps, store } = makeDeps(
      makeUser({ agentTriggerDeletionStartedAt: new Date('2026-10-01T00:00:00.000Z') }),
    );

    const lookup = await loadJwtUser('user-1', deps);
    await lookup.remember(false);

    expect(lookup.deleting).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('evicts instead of caching when the caller wrote to the user', async () => {
    enableCache(true);
    const { deps, store } = makeDeps(makeUser({ role: undefined }));

    await (await loadJwtUser('user-1', deps)).remember(true);
    await loadJwtUser('user-1', deps);

    expect(store.set).not.toHaveBeenCalled();
    expect(deps.getUserById).toHaveBeenCalledTimes(2);
  });
});
