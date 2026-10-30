import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createAgentApiKeyMethods } from './agentApiKey';
import { runAsSystem } from '~/config/tenantContext';
import { createUserMethods } from './user';
import { createModels } from '~/models';
import { hashToken } from '~/crypto';

let mongoServer: MongoMemoryReplSet;
let methods: ReturnType<typeof createAgentApiKeyMethods>;
const userId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongoServer.getUri(), { autoIndex: false });
  createModels(mongoose);
  methods = createAgentApiKeyMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('validateAgentApiKey', () => {
  const binding = { kind: 'test-grant', id: 'grant-1' };

  it('persists and returns the exact bound grant with a domain-separated hash', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'bound', binding });
    const stored = await mongoose.models.AgentApiKey.findById(created.id)
      .select('+keyHash')
      .lean<{ keyHash: string } | null>();

    expect(created.key).toMatch(/^sk-bound-[a-f0-9]{64}$/);
    expect(stored?.keyHash).toBe(`bound-v1:${await hashToken(`bound:${created.key}`)}`);
    expect(stored?.keyHash).not.toBe(await hashToken(created.key));
    expect(
      await mongoose.models.AgentApiKey.findOne({ keyHash: await hashToken(created.key) }),
    ).toBeNull();
    expect(await methods.validateAgentApiKey(created.key)).toBeNull();
    expect(await methods.validateBoundAgentApiKey(created.key)).toEqual({
      userId,
      keyId: new mongoose.Types.ObjectId(created.id),
      binding,
    });
    expect(await methods.getAgentApiKeyById(created.id, userId)).toEqual(
      expect.objectContaining({ binding }),
    );
  });

  it('keeps ordinary keys compatible with the existing raw-token hash', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'ordinary' });
    const stored = await mongoose.models.AgentApiKey.findById(created.id)
      .select('+keyHash')
      .lean<{ keyHash: string } | null>();

    expect(created.key).toMatch(/^sk-[a-f0-9]{64}$/);
    expect(stored?.keyHash).toBe(await hashToken(created.key));
    expect(await methods.validateAgentApiKey(created.key)).toEqual({
      userId,
      keyId: new mongoose.Types.ObjectId(created.id),
    });
    expect(await methods.validateBoundAgentApiKey(created.key)).toBeNull();
  });

  it('rejects a bound-prefix token when its stored grant is missing', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'missing-binding', binding });
    // Seed an inconsistent stored row without bypassing the validator under test.
    await mongoose.models.AgentApiKey.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $unset: { binding: 1 } },
    );

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
    await expect(methods.validateBoundAgentApiKey(created.key)).resolves.toBeNull();
  });

  it('rejects an ordinary-prefix token with a stored binding', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'wrong-prefix' });
    await mongoose.models.AgentApiKey.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $set: { binding } },
    );

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
    await expect(methods.validateBoundAgentApiKey(created.key)).resolves.toBeNull();
  });

  it.each([false, true])('rejects expired keys (bound=%s)', async (bound) => {
    const created = await methods.createAgentApiKey({
      userId,
      name: `expired-${bound}`,
      expiresAt: new Date(Date.now() - 60_000),
      ...(bound ? { binding } : {}),
    });

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
    await expect(methods.validateBoundAgentApiKey(created.key)).resolves.toBeNull();
  });

  it('propagates a bound-key lookup failure instead of treating it as absence', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'lookup-failure', binding });
    jest.spyOn(mongoose.models.AgentApiKey, 'findOne').mockImplementation(() => {
      throw new Error('bound lookup unavailable');
    });

    await expect(methods.validateBoundAgentApiKey(created.key)).rejects.toThrow(
      'bound lookup unavailable',
    );
  });

  it('resolves the owner of a stored key', async () => {
    const { key } = await methods.createAgentApiKey({ userId, name: 'remote' });

    const result = await methods.validateAgentApiKey(key);

    expect(result?.userId.toString()).toBe(userId.toString());
  });

  it('reports an unknown key as absent', async () => {
    await expect(methods.validateAgentApiKey('lc-unknown')).resolves.toBeNull();
  });

  it('rejects when the lookup fails instead of reporting the key as invalid', async () => {
    jest.spyOn(mongoose.models.AgentApiKey, 'findOne').mockImplementation(() => {
      throw new Error('connection reset');
    });

    await expect(methods.validateAgentApiKey('lc-any')).rejects.toThrow('connection reset');
  });
});

it('keeps every attacker-chosen public wrapper outside the legacy validator digest namespace', async () => {
  const created = await methods.createAgentApiKey({
    userId,
    name: 'legacy-namespace',
    binding: { kind: 'grant', id: 'one' },
  });
  const legacyLookup = async (token: string) =>
    mongoose.models.AgentApiKey.findOne({ keyHash: await hashToken(token) }).lean();
  for (const token of [
    created.key,
    `bound:${created.key}`,
    `bound-v1:${created.key}`,
    `bound:bound:${created.key}`,
  ]) {
    expect(await legacyLookup(token)).toBeNull();
    if (token !== created.key) expect(await methods.validateAgentApiKey(token)).toBeNull();
  }
  const ordinary = await methods.createAgentApiKey({ userId, name: 'legacy-control' });
  expect(await legacyLookup(ordinary.key)).not.toBeNull();
  expect(await methods.validateAgentApiKey(created.key)).toBeNull();
  expect(await methods.validateBoundAgentApiKey(created.key)).toMatchObject({
    binding: { id: 'one' },
  });
});

it('serializes bound-key creation with final account erasure', async () => {
  const user = await mongoose.models.User.create({
    email: 'bound-key-owner@example.com',
    provider: 'local',
  });
  const ownerId = String(user._id);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const collection = mongoose.models.AgentApiKey.collection;
  const insert = collection.insertOne.bind(collection);
  const paused = jest.spyOn(collection, 'insertOne').mockImplementation(async (...args) => {
    entered();
    await gate;
    return insert(...args);
  });
  const creating = methods.createAgentApiKey({
    userId: ownerId,
    name: 'in-flight',
    binding: { kind: 'grant', id: 'one' },
  });
  await started;
  let deleted = false;
  const deleting = createUserMethods(mongoose)
    .deleteUserById(ownerId)
    .then((value) => {
      deleted = true;
      return value;
    });
  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(deleted).toBe(false);
  } finally {
    release();
    paused.mockRestore();
  }
  const created = await creating;
  await deleting;
  expect(await methods.validateAgentApiKey(created.key)).toBeNull();
  expect(await methods.validateBoundAgentApiKey(created.key)).toBeNull();
  expect(await mongoose.models.AgentApiKey.exists({ userId: user._id })).toBeNull();
  await expect(
    methods.createAgentApiKey({
      userId: ownerId,
      name: 'late',
      binding: { kind: 'grant', id: 'one' },
    }),
  ).rejects.toThrow('owner unavailable');
});

it('uses the real owner partition when a system operation issues a bound grant', async () => {
  const user = await runAsSystem(async () =>
    mongoose.models.User.create({
      email: 'system-bound-key-owner@example.com',
      provider: 'local',
      tenantId: 'owner-tenant',
    }),
  );
  const created = await runAsSystem(async () =>
    methods.createAgentApiKey({
      userId: String(user._id),
      name: 'system-grant',
      binding: { kind: 'grant', id: 'one' },
    }),
  );
  expect(
    await runAsSystem(async () => mongoose.models.AgentApiKey.findById(created.id).lean()),
  ).toMatchObject({ tenantId: 'owner-tenant' });
});
