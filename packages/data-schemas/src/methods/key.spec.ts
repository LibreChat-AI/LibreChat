import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { createKeyMethods } from './key';
import { runAsSystem, tenantStorage } from '~/config/tenantContext';
import { createKeyModel } from '~/models/key';

describe('user key storage', () => {
  let mongo: MongoMemoryServer;
  let methods: ReturnType<typeof createKeyMethods>;
  let userId: string;
  let decrypt: typeof import('~/crypto').decrypt;
  let encrypt: typeof import('~/crypto').encrypt;
  beforeAll(async () => {
    const previous = { key: process.env.CREDS_KEY, iv: process.env.CREDS_IV };
    process.env.CREDS_KEY = '11'.repeat(32);
    process.env.CREDS_IV = '22'.repeat(16);
    let factory!: typeof createKeyMethods;
    jest.isolateModules(() => {
      ({ encrypt, decrypt } = jest.requireActual('~/crypto'));
      ({ createKeyMethods: factory } = jest.requireActual('./key'));
    });
    if (previous.key === undefined) delete process.env.CREDS_KEY;
    else process.env.CREDS_KEY = previous.key;
    if (previous.iv === undefined) delete process.env.CREDS_IV;
    else process.env.CREDS_IV = previous.iv;
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    createKeyModel(mongoose);
    methods = factory(mongoose);
  }, 60000);
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
  });
  beforeEach(async () => {
    await runAsSystem(async () => {
      await mongoose.models.Key.deleteMany({});
    });
    userId = new mongoose.Types.ObjectId().toString();
  });
  it('replaces complete envelopes and clears expiry without changing the row identity', async () => {
    const identity = { userId, name: 'google' };
    await methods.updateUserKey({ ...identity, value: 'first', expiresAt: '2099-01-01' });
    const before = await methods.getUserKeySnapshot(identity);
    expect(before).toMatchObject({
      expiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(before!.value).not.toBe('first');
    expect(await decrypt(before!.value)).toBe('first');
    await methods.updateUserKey({ ...identity, value: 'replacement', expiresAt: null });
    expect(await methods.getUserKeySnapshot(identity)).toMatchObject({
      id: before!.id,
      expiresAt: null,
    });
    expect(await methods.getUserKey(identity)).toBe('replacement');
  });
  it('uses a single upsert and no read for a plain key update', async () => {
    const read = jest.spyOn(mongoose.models.Key, 'findOne');
    const write = jest.spyOn(mongoose.models.Key, 'findOneAndUpdate');
    await methods.updateUserKey({ userId, name: 'openAI', value: 'secret' });
    expect(read).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledTimes(1);
  });
  it('applies the shared tenant scope when reading encrypted snapshots', async () => {
    const identity = { userId, name: 'google' };
    await tenantStorage.run({ tenantId: 'tenant-one' }, async () => {
      await methods.updateUserKey({ ...identity, value: 'private' });
      expect(await methods.getUserKeySnapshot(identity)).not.toBeNull();
    });
    await tenantStorage.run({ tenantId: 'tenant-two' }, async () => {
      expect(await methods.getUserKeySnapshot(identity)).toBeNull();
    });
  });
  it('does not read another tenant key when the caller explicitly selects the default tenant', async () => {
    const identity = { userId, name: 'google' };
    const value = await encrypt('private');
    await mongoose.models.Key.create({
      ...identity,
      tenantId: 'other-tenant',
      value,
    });
    expect(await methods.getUserKeySnapshot({ ...identity, tenantId: null })).toBeNull();
    expect(
      await methods.getUserKeySnapshot({ ...identity, tenantId: 'other-tenant' }),
    ).toMatchObject({ value });
  });
});
