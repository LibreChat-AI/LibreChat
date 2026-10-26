import type { IUser } from '@librechat/data-schemas';
import type { AuthUserDocCacheMode } from './userDocCache';
import { buildAuthUserDocReverseIndexKey } from './userDocCache';
import { JWT_USER_PROJECTION, loadJwtUser } from './jwt';

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

function makeDeps(
  user: IUser | null,
  { active = true, cacheMode = 'on' as AuthUserDocCacheMode } = {},
) {
  const store = makeStore();
  return {
    store,
    deps: {
      cacheMode,
      getUserById: jest.fn(async (): Promise<IUser | null> => user),
      isPrincipalActive: jest.fn(async () => active),
      getCacheStore: () => store,
    },
  };
}

describe('loadJwtUser', () => {
  it('reads the user every request while the cache is off', async () => {
    const { deps, store } = makeDeps(makeUser(), { cacheMode: 'off' });

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    await loadJwtUser('user-1', deps);

    expect(deps.getUserById).toHaveBeenCalledTimes(2);
    expect(deps.getUserById).toHaveBeenCalledWith('user-1', JWT_USER_PROJECTION);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('serves a request burst from the cache and still reads the deletion fence', async () => {
    const { deps, store } = makeDeps(makeUser());

    const first = await loadJwtUser('user-1', deps);
    await first.remember(false);
    const second = await loadJwtUser('user-1', deps);

    /** The miss reads twice (the second confirms the cache write); the hit reads none. */
    expect(deps.getUserById).toHaveBeenCalledTimes(2);
    expect(deps.isPrincipalActive).toHaveBeenCalledTimes(1);
    expect(second.user).toMatchObject({ _id: 'user-1', role: 'USER' });
    expect(second.deleting).toBe(false);
    /** The reverse index lets every user mutation evict this entry. */
    expect(store.values.get(buildAuthUserDocReverseIndexKey('user-1'))).toHaveLength(1);
  });

  it('falls back to the database when a cached principal is no longer active', async () => {
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
    const { deps, store } = makeDeps(
      makeUser({ agentTriggerDeletionStartedAt: new Date('2026-10-01T00:00:00.000Z') }),
    );

    const lookup = await loadJwtUser('user-1', deps);
    await lookup.remember(false);

    expect(lookup.deleting).toBe(true);
    expect(store.set).not.toHaveBeenCalled();
  });

  it('evicts instead of caching when the caller wrote to the user', async () => {
    const { deps, store } = makeDeps(makeUser({ role: undefined }));

    await (await loadJwtUser('user-1', deps)).remember(true);
    await loadJwtUser('user-1', deps);

    expect(store.set).not.toHaveBeenCalled();
    expect(deps.getUserById).toHaveBeenCalledTimes(2);
  });

  it('drops its own cache write when the user changed after the database read', async () => {
    const { deps, store } = makeDeps(makeUser());
    const lookup = await loadJwtUser('user-1', deps);

    /** A credential change commits and evicts between the read and the cache write. */
    deps.getUserById.mockResolvedValueOnce(
      makeUser({ credentialsChangedAt: new Date('2026-10-26T00:00:00.000Z') } as Partial<IUser>),
    );
    await lookup.remember(false);

    expect(store.set).toHaveBeenCalled();
    const next = await loadJwtUser('user-1', deps);
    expect(deps.getUserById).toHaveBeenCalledTimes(3);
    expect(next.user).toMatchObject({ _id: 'user-1' });
    expect(deps.isPrincipalActive).not.toHaveBeenCalled();
  });

  it('evicts its own cache write when the confirming read fails', async () => {
    const { deps } = makeDeps(makeUser());
    const lookup = await loadJwtUser('user-1', deps);

    deps.getUserById.mockRejectedValueOnce(new Error('connection reset'));
    await expect(lookup.remember(false)).resolves.toBeUndefined();

    await loadJwtUser('user-1', deps);
    expect(deps.isPrincipalActive).not.toHaveBeenCalled();
  });
});
