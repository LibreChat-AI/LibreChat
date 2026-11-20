import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { repairAuthorizationDuplicates } from './authorization';

let mongo: MongoMemoryServer;
const db = () => mongoose.connection.db!;
const collection = (name: string) => db().collection(name);
const apply = () =>
  repairAuthorizationDuplicates(mongoose.connection, { dryRun: false, writersPaused: true });

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri(), { autoIndex: false, autoCreate: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

it('defaults to a preview without creating collections or indexes', async () => {
  const reports = await repairAuthorizationDuplicates(mongoose.connection);
  expect(reports).toHaveLength(3);
  expect(reports.every((report) => report.duplicateGroups === 0 && !report.uniqueIndex)).toBe(true);
  expect(await db().listCollections().toArray()).toEqual([]);
  await expect(
    repairAuthorizationDuplicates(mongoose.connection, { dryRun: false }),
  ).rejects.toThrow('paused');
});

it('archives equivalent duplicates, preserves survivors and tenant boundaries, and is resumable', async () => {
  const grants = collection('systemgrants');
  const grant = { principalType: 'role', principalId: 'CUSTOM', capability: 'read:users' };
  const first = { ...grant, grantedAt: new Date(1), grantedBy: new mongoose.Types.ObjectId() };
  const second = { ...grant, grantedAt: new Date(2), grantedBy: new mongoose.Types.ObjectId() };
  await grants.insertMany([first, second, { ...grant, tenantId: 'b' }]);
  const role = { name: 'CUSTOM', permissions: { USERS: { READ: true } } };
  await collection('roles').insertMany([role, { ...role }, { ...role, tenantId: 'b' }]);
  const category = { value: 'general', label: 'General', isActive: true };
  await collection('agentcategories').insertMany([category, { ...category }]);
  await collection('roles').createIndex({ name: 1 }, { name: 'custom_lookup' });
  const before = await grants.find().sort({ _id: 1 }).toArray();
  const preview = await repairAuthorizationDuplicates(mongoose.connection);
  expect(preview.map((report) => report.excessDocuments)).toEqual([1, 1, 1]);
  expect(await grants.countDocuments()).toBe(3);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(0);

  const result = await apply();
  expect(result.every((report) => report.uniqueIndex && report.removedDocuments === 1)).toBe(true);
  expect(await grants.findOne({ _id: before[0]._id })).toEqual(before[0]);
  expect(await grants.countDocuments()).toBe(2);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(3);
  const archive = await collection('authorization_duplicate_archive').findOne({
    '_id.collection': 'systemgrants',
  });
  expect(archive?.original).toEqual(before[1]);
  expect(await collection('roles').indexExists('custom_lookup')).toBe(true);
  await expect(grants.insertOne({ ...grant })).rejects.toMatchObject({ code: 11000 });
  await grants.insertOne({ ...grant, tenantId: 'c' });
  expect(
    (await apply()).every((report) => report.removedDocuments === 0 && report.uniqueIndex),
  ).toBe(true);
});

it.each([
  [
    'roles',
    { name: 'CUSTOM', permissions: { allowed: true } },
    { name: 'CUSTOM', permissions: { allowed: false } },
  ],
  ['agentcategories', { value: 'general', label: 'First' }, { value: 'general', label: 'Second' }],
  [
    'systemgrants',
    { principalType: 'role', principalId: 'CUSTOM', capability: 'read:users' },
    {
      principalType: 'role',
      principalId: 'CUSTOM',
      capability: 'read:users',
      expiresAt: new Date(),
    },
  ],
  ['roles', { name: 'CUSTOM' }, { name: 'CUSTOM', tenantId: null }],
])(
  'refuses conflicting %s data before deleting from any collection',
  async (name, first, second) => {
    await collection(name).insertMany([first, second]);
    const duplicate = { principalType: 'role', principalId: 'OTHER', capability: 'read:users' };
    await collection('systemgrants').insertMany([{ ...duplicate }, { ...duplicate }]);
    const report = await repairAuthorizationDuplicates(mongoose.connection);
    expect(report.find((item) => item.collection === name)?.conflictingGroups).toBe(1);
    await expect(apply()).rejects.toThrow('Conflicting');
    expect(await collection('systemgrants').countDocuments({ principalId: 'OTHER' })).toBe(2);
    expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(0);
  },
);

it('does not delete a source when archive persistence fails', async () => {
  await collection('roles').insertMany([{ name: 'CUSTOM' }, { name: 'CUSTOM' }]);
  const spy = jest
    .spyOn(mongoose.mongo.Collection.prototype, 'updateOne')
    .mockRejectedValueOnce(new Error('unavailable'));
  try {
    await expect(apply()).rejects.toThrow('unavailable');
    expect(await collection('roles').countDocuments()).toBe(2);
  } finally {
    spy.mockRestore();
  }
});

it('resumes safely when a run stops after archival but before deletion', async () => {
  await collection('roles').insertMany([{ name: 'CUSTOM' }, { name: 'CUSTOM' }]);
  const spy = jest
    .spyOn(mongoose.mongo.Collection.prototype, 'deleteOne')
    .mockRejectedValueOnce(new Error('interrupted'));
  try {
    await expect(apply()).rejects.toThrow('interrupted');
  } finally {
    spy.mockRestore();
  }
  expect(await collection('roles').countDocuments()).toBe(2);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(1);
  await apply();
  expect(await collection('roles').countDocuments()).toBe(1);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(1);
});

it('refuses an incompatible index and leaves duplicates untouched', async () => {
  await collection('roles').insertMany([{ name: 'CUSTOM' }, { name: 'CUSTOM' }]);
  await collection('roles').createIndex({ name: 1, tenantId: 1 });
  await expect(apply()).rejects.toThrow('Unexpected roles');
  expect(await collection('roles').countDocuments()).toBe(2);
});

it('bounds duplicate group memory and refuses deletion', async () => {
  await collection('roles').insertMany([
    { name: 'CUSTOM' },
    { name: 'CUSTOM' },
    { name: 'CUSTOM' },
  ]);
  await expect(
    repairAuthorizationDuplicates(mongoose.connection, { maxGroupSize: 2 }),
  ).rejects.toThrow('bound');
  expect(await collection('roles').countDocuments()).toBe(3);
});

it('refuses a second migrator without releasing its lock', async () => {
  const locks = db().collection<{ _id: string; owner: string }>('authorization_repair_locks');
  await locks.insertOne({ _id: 'authorization', owner: 'first-process' });
  await expect(apply()).rejects.toMatchObject({ code: 11000 });
  expect(await locks.findOne({ _id: 'authorization' })).toMatchObject({ owner: 'first-process' });
});

it('keeps archived records and can resume after a failed index build', async () => {
  const grant = { principalType: 'role', principalId: 'CUSTOM', capability: 'read:users' };
  await collection('systemgrants').insertMany([{ ...grant }, { ...grant }]);
  const spy = jest
    .spyOn(mongoose.mongo.Collection.prototype, 'createIndex')
    .mockRejectedValueOnce(
      Object.assign(new Error('sensitive duplicate identity'), { code: 11000 }),
    );
  try {
    await expect(apply()).rejects.toThrow('Authorization index build failed');
  } finally {
    spy.mockRestore();
  }
  expect(await collection('authorization_repair_locks').countDocuments()).toBe(0);
  expect(await collection('systemgrants').countDocuments()).toBe(1);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(1);
  await apply();
  expect(
    await collection('systemgrants').indexExists(
      'principalType_1_principalId_1_capability_1_tenantId_1',
    ),
  ).toBe(true);
  expect(await collection('authorization_duplicate_archive').countDocuments()).toBe(1);
});

it('never overwrites an archive with different source content', async () => {
  const roles = collection('roles');
  await roles.insertMany([{ name: 'CUSTOM' }, { name: 'CUSTOM' }]);
  const records = await roles.find().sort({ _id: 1 }).toArray();
  await db()
    .collection<{
      _id: { collection: string; sourceId: mongoose.Types.ObjectId };
      original: object;
    }>('authorization_duplicate_archive')
    .insertOne({
      _id: { collection: 'roles', sourceId: records[1]._id },
      original: { name: 'DIFFERENT' },
    });
  await expect(apply()).rejects.toThrow('archive differs');
  expect(await roles.countDocuments()).toBe(2);
});
