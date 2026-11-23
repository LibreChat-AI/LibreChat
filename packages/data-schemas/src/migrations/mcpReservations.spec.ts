import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { migrateMCPReservationIndex } from './mcpReservations';

let mongo: MongoMemoryServer;
const collection = () => mongoose.connection.db!.collection('mcpnames');

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
afterEach(() => jest.restoreAllMocks());

it('previews an absent collection without creating it', async () => {
  expect(await migrateMCPReservationIndex(mongoose.connection, { dryRun: true })).toEqual({
    compoundIndex: false,
    legacyIndex: false,
  });
  expect(await mongoose.connection.db!.listCollections().toArray()).toEqual([]);
});

it('replaces only the legacy index, preserves documents/custom indexes and is idempotent', async () => {
  await collection().insertMany([{ name: 'retired' }, { name: 'active', tenantId: 'a' }]);
  await collection().createIndex({ name: 1 }, { unique: true });
  await collection().createIndex({ tenantId: 1 }, { name: 'custom_tenant' });
  const before = await collection().find().toArray();
  await expect(migrateMCPReservationIndex(mongoose.connection, { dryRun: true })).resolves.toEqual({
    compoundIndex: false,
    legacyIndex: true,
  });
  expect(await collection().indexExists('name_1')).toBe(true);
  await expect(migrateMCPReservationIndex(mongoose.connection)).resolves.toEqual({
    compoundIndex: true,
    legacyIndex: false,
  });
  expect(await collection().find().toArray()).toEqual(before);
  expect(await collection().indexExists('custom_tenant')).toBe(true);
  await collection().insertOne({ name: 'active', tenantId: 'b' });
  await expect(collection().insertOne({ name: 'active', tenantId: 'a' })).rejects.toMatchObject({
    code: 11000,
  });
  await expect(collection().insertOne({ name: 'retired' })).rejects.toMatchObject({ code: 11000 });
  await expect(migrateMCPReservationIndex(mongoose.connection)).resolves.toEqual({
    compoundIndex: true,
    legacyIndex: false,
  });
});

it('retains the global constraint when the replacement build fails', async () => {
  await collection().createIndex({ name: 1 }, { unique: true });
  jest
    .spyOn(mongoose.mongo.Collection.prototype, 'createIndex')
    .mockRejectedValueOnce(new Error('denied'));
  await expect(migrateMCPReservationIndex(mongoose.connection)).rejects.toThrow('denied');
  expect(await collection().indexExists('name_1')).toBe(true);
});

it('can resume after dropping the legacy index fails', async () => {
  await collection().createIndex({ name: 1 }, { unique: true });
  jest
    .spyOn(mongoose.mongo.Collection.prototype, 'dropIndex')
    .mockRejectedValueOnce(new Error('denied'));
  await expect(migrateMCPReservationIndex(mongoose.connection)).rejects.toThrow('denied');
  expect(await collection().indexExists('name_1')).toBe(true);
  expect(await collection().indexExists('name_1_tenantId_1')).toBe(true);
  await expect(migrateMCPReservationIndex(mongoose.connection)).resolves.toEqual({
    compoundIndex: true,
    legacyIndex: false,
  });
});

it('refuses a custom global constraint instead of claiming success', async () => {
  await collection().createIndex({ name: 1 }, { unique: true, name: 'custom_global' });
  await expect(migrateMCPReservationIndex(mongoose.connection)).rejects.toThrow(
    'Unexpected global',
  );
  expect(await collection().indexExists('custom_global')).toBe(true);
});

it('creates the constraint on a fresh database', async () => {
  await expect(migrateMCPReservationIndex(mongoose.connection)).resolves.toEqual({
    compoundIndex: true,
    legacyIndex: false,
  });
  expect(await collection().countDocuments()).toBe(0);
});

it('does not touch unrelated collections', async () => {
  const users = mongoose.connection.db!.collection('users');
  await users.insertOne({ email: 'fixture@example.test' });
  await users.createIndex({ email: 1 }, { unique: true });
  const before = await users.indexes();
  await migrateMCPReservationIndex(mongoose.connection);
  expect(await users.indexes()).toEqual(before);
  expect(await users.countDocuments()).toBe(1);
});
