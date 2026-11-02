import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { CacheKeys, AUTH_USER_DOC_BY_ID_PREFIX } from 'librechat-data-provider';
import type { CacheStore, IUser } from '~/types';
import { buildAuthUserDocEvictionFenceKey } from '~/utils/eviction';
import { createModels } from '~/models';
import { createMethods } from './index';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createMethods>;
const values = new Map<string, unknown>();
const cache: CacheStore = {
  get: async (key) => values.get(key),
  set: async (key, value) => values.set(key, value),
  delete: async (key) => values.delete(key),
};
const originalMode = process.env.AUTH_USER_CACHE_MODE;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createMethods(mongoose, {
    getCache: (key) => (key === CacheKeys.AUTH_USER_DOC ? cache : undefined),
  });
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  if (originalMode === undefined) {
    delete process.env.AUTH_USER_CACHE_MODE;
  } else {
    process.env.AUTH_USER_CACHE_MODE = originalMode;
  }
});

beforeEach(async () => {
  process.env.AUTH_USER_CACHE_MODE = 'on';
  values.clear();
  await mongoose.connection.dropDatabase();
});

/** Seeds a cached auth document for the user, named by its reverse index. */
function cacheUser(user: IUser): string {
  const userId = String(user._id);
  const docKey = `auth-user-doc:v2:${userId}`;
  values.set(`${AUTH_USER_DOC_BY_ID_PREFIX}:${userId}`, [docKey]);
  values.set(docKey, { version: 2, user: { _id: userId, favorites: user.favorites } });
  return docKey;
}

function expectEvicted(user: IUser, docKey: string) {
  expect(values.has(docKey)).toBe(false);
  expect(values.has(buildAuthUserDocEvictionFenceKey(String(user._id)))).toBe(true);
}

function expectCached(user: IUser, docKey: string) {
  expect(values.has(docKey)).toBe(true);
  expect(values.has(buildAuthUserDocEvictionFenceKey(String(user._id)))).toBe(false);
}

async function createAgent(id: string, author: mongoose.Types.ObjectId) {
  return methods.createAgent({ id, name: id, provider: 'test', model: 'test-model', author });
}

async function createUser(email: string, agentIds: string[]): Promise<IUser> {
  const user = await mongoose.models.User.create({
    email,
    provider: 'local',
    favorites: agentIds.map((agentId) => ({ agentId })),
  });
  return user.toObject() as IUser;
}

describe('agent favorite cleanup evicts cached auth users', () => {
  it('evicts every user that favorited an agent when the agent is deleted', async () => {
    await createAgent('agent_deleted', new mongoose.Types.ObjectId());
    const holder = await createUser('holder@example.com', ['agent_deleted']);
    const bystander = await createUser('bystander@example.com', ['agent_other']);
    const holderKey = cacheUser(holder);
    const bystanderKey = cacheUser(bystander);

    await methods.deleteAgent({ id: 'agent_deleted' });

    const stored = await mongoose.models.User.findById(holder._id).lean<IUser>();
    expect(stored?.favorites).toEqual([]);
    expectEvicted(holder, holderKey);
    expectCached(bystander, bystanderKey);
  });

  it("evicts the favorite holders of a deleted user's agents", async () => {
    const author = new mongoose.Types.ObjectId();
    await createAgent('agent_owned', author);
    const holder = await createUser('owned-holder@example.com', ['agent_owned']);
    const bystander = await createUser('owned-bystander@example.com', []);
    const holderKey = cacheUser(holder);
    const bystanderKey = cacheUser(bystander);

    await methods.deleteUserAgents(author.toString());

    const stored = await mongoose.models.User.findById(holder._id).lean<IUser>();
    expect(stored?.favorites).toEqual([]);
    expectEvicted(holder, holderKey);
    expectCached(bystander, bystanderKey);
  });

  it('evicts the users an agent is removed from after losing access', async () => {
    const agent = await createAgent('agent_revoked', new mongoose.Types.ObjectId());
    const revoked = await createUser('revoked@example.com', ['agent_revoked']);
    const kept = await createUser('kept@example.com', ['agent_revoked']);
    const revokedKey = cacheUser(revoked);
    const keptKey = cacheUser(kept);

    await methods.removeAgentFromUserFavorites(String(agent._id), [String(revoked._id)]);

    const stored = await mongoose.models.User.findById(revoked._id).lean<IUser>();
    expect(stored?.favorites).toEqual([]);
    expectEvicted(revoked, revokedKey);
    expectCached(kept, keptKey);
  });

  it('does not read favorite holders when the auth user cache is off', async () => {
    delete process.env.AUTH_USER_CACHE_MODE;
    await createAgent('agent_uncached', new mongoose.Types.ObjectId());
    const holder = await createUser('uncached@example.com', ['agent_uncached']);
    const holderKey = cacheUser(holder);
    const distinct = jest.spyOn(mongoose.models.User, 'distinct');

    await methods.deleteAgent({ id: 'agent_uncached' });

    expect(distinct).not.toHaveBeenCalled();
    distinct.mockRestore();
    expectCached(holder, holderKey);
  });
});
