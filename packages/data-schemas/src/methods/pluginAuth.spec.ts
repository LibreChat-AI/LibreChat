import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { PluginAuthMethods } from './pluginAuth';
import { createPluginAuthMethods } from './pluginAuth';
import { createModels } from '~/models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: InstanceType<typeof MongoMemoryServer>;
let methods: PluginAuthMethods;

const userId = new mongoose.Types.ObjectId().toString();
const key = { userId, pluginKey: 'web_search', authField: 'API_KEY' };

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  createModels(mongoose);
  methods = createPluginAuthMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.PluginAuth.deleteMany({});
});

describe('updatePluginAuth', () => {
  it('creates the credential when missing and returns it', async () => {
    const created = await methods.updatePluginAuth({ ...key, value: 'first' });

    expect(created).toMatchObject({ ...key, value: 'first' });
    expect(await mongoose.models.PluginAuth.countDocuments(key)).toBe(1);
  });

  it('updates the existing credential in place instead of inserting another', async () => {
    const created = await methods.updatePluginAuth({ ...key, value: 'first' });
    const updated = await methods.updatePluginAuth({ ...key, value: 'second' });

    expect(updated?._id?.toString()).toBe(created?._id?.toString());
    expect(updated?.value).toBe('second');
    expect(await mongoose.models.PluginAuth.countDocuments(key)).toBe(1);
  });
});
