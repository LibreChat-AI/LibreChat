import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createModels } from '~/models';
import { hashToken } from '~/crypto';

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof createAgentApiKeyMethods>;
const userId = new mongoose.Types.ObjectId();

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
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
    expect(stored?.keyHash).toBe(await hashToken(`bound:${created.key}`));
    expect(stored?.keyHash).not.toBe(await hashToken(created.key));
    expect(
      await mongoose.models.AgentApiKey.findOne({ keyHash: await hashToken(created.key) }),
    ).toBeNull();
    expect(await methods.validateAgentApiKey(created.key)).toEqual({
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
  });

  it('rejects a bound-prefix token when its stored grant is missing', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'missing-binding', binding });
    // Seed an inconsistent stored row without bypassing the validator under test.
    await mongoose.models.AgentApiKey.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $unset: { binding: 1 } },
    );

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
  });

  it('rejects an ordinary-prefix token with a stored binding', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'wrong-prefix' });
    await mongoose.models.AgentApiKey.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(created.id) },
      { $set: { binding } },
    );

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
  });

  it.each([false, true])('rejects expired keys (bound=%s)', async (bound) => {
    const created = await methods.createAgentApiKey({
      userId,
      name: `expired-${bound}`,
      expiresAt: new Date(Date.now() - 60_000),
      ...(bound ? { binding } : {}),
    });

    await expect(methods.validateAgentApiKey(created.key)).resolves.toBeNull();
  });

  it('propagates a bound-key lookup failure instead of treating it as absence', async () => {
    const created = await methods.createAgentApiKey({ userId, name: 'lookup-failure', binding });
    jest.spyOn(mongoose.models.AgentApiKey, 'findOne').mockImplementation(() => {
      throw new Error('bound lookup unavailable');
    });

    await expect(methods.validateAgentApiKey(created.key)).rejects.toThrow(
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
