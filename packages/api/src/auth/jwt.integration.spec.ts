import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMethods, createModels } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import { AUTH_USER_FRESHNESS_PROJECTION } from './userDocCache';
import { JWT_USER_PROJECTION, loadJwtUser } from './jwt';

/**
 * Cache admission for local JWT bearers against the real user schema and methods: the hidden
 * deletion fence, projections, and the `updatedAt` stamp mongoose writes on every update.
 */

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;

/** Round-trips values through JSON, as the Redis-backed store does. */
function makeStore() {
  const values = new Map<string, string>();
  return {
    get: async <T = unknown>(key: string) => {
      const value = values.get(key);
      return (value === undefined ? undefined : JSON.parse(value)) as T | undefined;
    },
    set: async (key: string, value: unknown) => {
      values.set(key, JSON.stringify(value));
      return true;
    },
    delete: async (key: string) => values.delete(key),
  };
}

async function createUser(): Promise<string> {
  const doc = await mongoose.models.User.create({
    email: `jwt-${new mongoose.Types.ObjectId().toString()}@example.com`,
    provider: 'local',
    role: 'USER',
  });
  return doc._id.toString();
}

function makeDeps() {
  const getUserById = jest.fn((userId: string, fields: string) =>
    methods.getUserById(userId, fields),
  );
  return {
    getUserById,
    deps: { cacheMode: 'on' as const, getUserById },
  };
}

let store = makeStore();

const projections = (spy: jest.Mock) => spy.mock.calls.map(([, fields]) => fields);

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(() => {
  store = makeStore();
});

function lookup(userId: string, deps: ReturnType<typeof makeDeps>['deps']) {
  /** Read at call time so each test sees its own store. */
  return loadJwtUser(userId, { ...deps, getCacheStore: () => store });
}

describe('loadJwtUser against MongoDB', () => {
  it('serves a burst from the cache after one freshness read per hit', async () => {
    const userId = await createUser();
    const { getUserById, deps } = makeDeps();

    await (await lookup(userId, deps)).remember(false);
    const hit = await lookup(userId, deps);

    expect(hit.user).toMatchObject({ _id: userId, role: 'USER' });
    expect(projections(getUserById)).toEqual([JWT_USER_PROJECTION, AUTH_USER_FRESHNESS_PROJECTION]);
  });

  it('never serves a document cached from a read that raced a credential change', async () => {
    const userId = await createUser();
    const { getUserById, deps } = makeDeps();
    const first = await lookup(userId, deps);

    /** The reset commits (and would evict) before this request writes its cache entry. */
    const changedAt = new Date();
    await methods.updateUser(userId, { credentialsChangedAt: changedAt } as Partial<IUser>);
    await first.remember(false);

    const next = await lookup(userId, deps);
    expect(projections(getUserById)).toEqual([
      JWT_USER_PROJECTION,
      AUTH_USER_FRESHNESS_PROJECTION,
      JWT_USER_PROJECTION,
    ]);
    expect(new Date(next.user?.credentialsChangedAt as Date).getTime()).toBe(changedAt.getTime());
  });

  it('rejects a cached document once a write bypassing updatedAt changes authorization', async () => {
    const userId = await createUser();
    const { deps } = makeDeps();
    await (await lookup(userId, deps)).remember(false);

    /** Same updatedAt, as two writes stamped in one millisecond would leave it. */
    await mongoose.models.User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(userId) },
      { $set: { role: 'ADMIN' } },
    );

    const next = await lookup(userId, deps);
    expect(next.user).toMatchObject({ role: 'ADMIN' });
  });

  it('falls back to the database read once the hidden deletion fence is set', async () => {
    const userId = await createUser();
    const { deps } = makeDeps();
    await (await lookup(userId, deps)).remember(false);

    await mongoose.models.User.updateOne(
      { _id: userId },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );

    const fenced = await lookup(userId, deps);
    expect(fenced.deleting).toBe(true);
  });
});
