import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createAgentApiKeyMethods } from './agentApiKey';
import { createModels } from '~/models';

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
