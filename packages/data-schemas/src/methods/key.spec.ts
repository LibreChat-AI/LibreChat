import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { createKeyMethods as CreateKeyMethods } from './key';
import type * as Crypto from '~/crypto';

process.env.CREDS_KEY = 'a'.repeat(64);
process.env.CREDS_IV = 'b'.repeat(32);

let mongoServer: MongoMemoryServer;
let methods: ReturnType<typeof CreateKeyMethods>;
let crypto: typeof Crypto;
const userId = new mongoose.Types.ObjectId().toString();

beforeAll(async () => {
  crypto = await import('~/crypto');
  const { createKeyMethods } = await import('./key');
  const { createModels } = await import('../models');
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  methods = createKeyMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.models.Key.deleteMany({});
});

const stored = async (name: string) =>
  (await mongoose.models.Key.findOne({ userId, name }).lean()) as unknown as { value: string };

describe('user provider keys', () => {
  it('writes the random-IV v3 format by default and reads it back', async () => {
    await methods.updateUserKey({ userId, name: 'openAI', value: 'sk-test' });
    await methods.updateUserKey({ userId, name: 'anthropic', value: 'sk-test' });
    const first = await stored('openAI');
    const second = await stored('anthropic');
    expect(first.value).toMatch(/^v3:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(first.value).not.toBe(second.value);
    await expect(methods.getUserKey({ userId, name: 'openAI' })).resolves.toBe('sk-test');
  });

  it('writes the fixed-IV format only when writeFormat is legacy', async () => {
    await methods.updateUserKey({
      userId,
      name: 'openAI',
      value: 'sk-test',
      writeFormat: 'legacy',
    });
    const row = await stored('openAI');
    expect(row.value).toMatch(/^[0-9a-f]+$/);
    await expect(methods.getUserKey({ userId, name: 'openAI' })).resolves.toBe('sk-test');
  });

  it('still reads legacy values written by earlier releases', async () => {
    await mongoose.models.Key.create({
      userId,
      name: 'google',
      value: await crypto.encrypt(JSON.stringify({ apiKey: 'legacy-key' })),
    });
    await expect(methods.getUserKeyValues({ userId, name: 'google' })).resolves.toEqual({
      apiKey: 'legacy-key',
    });
  });
});

describe('user key indexes', () => {
  it('reads a user key by user and name through an index', async () => {
    await mongoose.models.Key.syncIndexes();
    await methods.updateUserKey({ userId, name: 'openAI', value: 'sk-test' });

    const plan = await mongoose.models.Key.find({ userId, name: 'openAI' }).explain();

    expect(JSON.stringify(plan)).toContain('"IXSCAN"');
  });
});
