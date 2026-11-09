import mongoose from 'mongoose';
import { MongoMemoryServer, MongoMemoryReplSet } from 'mongodb-memory-server';
import type { PermissionPrincipalChange } from './provisioning';
import { createPermissionPrincipalMethods } from './provisioning';
import { createModels } from '../models';

describe.each([false, true])('principal storage with transactions: %s', (transactions) => {
  let mongo: MongoMemoryServer | MongoMemoryReplSet;
  const invalidate = jest.fn().mockResolvedValue(undefined);
  let storage: ReturnType<typeof createPermissionPrincipalMethods>;

  beforeAll(async () => {
    mongo = transactions
      ? await MongoMemoryReplSet.create({
          replSet: { count: 1, storageEngine: 'wiredTiger' },
          instanceOpts: [{ args: ['--nounixsocket'] }],
        })
      : await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongo.getUri());
    createModels(mongoose);
    // Transactions must not race the fixture’s background collection/index initialization.
    await Promise.all([mongoose.models.User.init(), mongoose.models.Group.init()]);
    storage = createPermissionPrincipalMethods(mongoose, invalidate);
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    jest.restoreAllMocks();
    invalidate.mockClear();
    await Promise.all([mongoose.models.User.deleteMany({}), mongoose.models.Group.deleteMany({})]);
  });

  it('rolls back earlier membership and account writes when a later insert fails', async () => {
    const group = await mongoose.models.Group.create({
      name: 'Stored',
      source: 'entra',
      idOnTheSource: 'stored',
      memberIds: ['old-member'],
    });
    const before = await mongoose.models.Group.findById(group._id).lean<{ memberIds: string[] }>();
    const changes: PermissionPrincipalChange[] = [
      { kind: 'group', id: group._id.toString(), data: { memberIds: ['new-member'] } },
      {
        kind: 'user',
        data: {
          name: 'Directory',
          email: 'directory@example.com',
          provider: 'openid',
          emailVerified: false,
        },
      },
      {
        kind: 'group',
        data: { name: 'New', source: 'entra', idOnTheSource: 'new', memberIds: ['new-member'] },
      },
    ];
    jest.spyOn(mongoose.models.Group, 'create').mockRejectedValueOnce(new Error('Write failure'));
    await expect(storage.persistPermissionPrincipals(changes)).rejects.toThrow('Write failure');
    expect(await mongoose.models.User.countDocuments()).toBe(0);
    expect(await mongoose.models.Group.countDocuments()).toBe(1);
    expect(
      (await mongoose.models.Group.findById(group._id).lean<{ memberIds: string[] }>())?.memberIds,
    ).toEqual(before?.memberIds);
    if (transactions) expect(invalidate).not.toHaveBeenCalled();
    else
      expect(invalidate).toHaveBeenCalledWith(expect.arrayContaining(['old-member', 'new-member']));
  });

  it('persists the entire staged batch in input order and invalidates affected members', async () => {
    const group = await mongoose.models.Group.create({ name: 'Stored', memberIds: ['old'] });
    const ids = await storage.persistPermissionPrincipals([
      {
        kind: 'user',
        data: { email: 'new@example.com', provider: 'openid', emailVerified: false },
      },
      { kind: 'group', id: group._id.toString(), data: { memberIds: [] } },
    ]);
    expect(ids[1]).toBe(group._id.toString());
    expect((await mongoose.models.User.findById(ids[0]).lean<{ email: string }>())?.email).toBe(
      'new@example.com',
    );
    expect(
      (await mongoose.models.Group.findById(group._id).lean<{ memberIds: string[] }>())?.memberIds,
    ).toEqual([]);
    expect(invalidate).toHaveBeenCalledWith(['old']);
  });
  it('does not roll back a concurrent writer over its newer group state', async () => {
    if (transactions) return;
    const group = await mongoose.models.Group.create({ name: 'Stored', memberIds: ['old'] });
    jest.spyOn(mongoose.models.User, 'create').mockImplementationOnce(async () => {
      await mongoose.models.Group.updateOne(
        { _id: group._id },
        { $set: { memberIds: ['concurrent'], updatedAt: new Date(Date.now() + 1000) } },
      );
      throw new Error('Later write failed');
    });
    await expect(
      storage.persistPermissionPrincipals([
        { kind: 'group', id: group._id.toString(), data: { memberIds: ['attempted'] } },
        {
          kind: 'user',
          data: { email: 'new@example.com', provider: 'openid', emailVerified: false },
        },
      ]),
    ).rejects.toThrow('Principal rollback failed');
    expect(
      (await mongoose.models.Group.findById(group._id).lean<{ memberIds: string[] }>())?.memberIds,
    ).toEqual(['concurrent']);
  });
});
