import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMCPAuthorityLookupIndexes } from './mcpAuthorityIndexes';

let mongoServer: InstanceType<typeof MongoMemoryServer>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

test('creates every bounded MCP authority lookup index idempotently', async () => {
  const expected = [
    ['groups', 'memberIds_1_tenantId_1'],
    ['agents', 'mcpServerNames_1_tenantId_1'],
    ['pluginauths', 'userId_1_pluginKey_1_authField_1_tenantId_1'],
    ['tokens', 'userId_1_type_1_identifier_1_tenantId_1'],
  ] as const;

  await expect(createMCPAuthorityLookupIndexes(mongoose.connection)).resolves.toEqual(
    expected.map(([, name]) => name),
  );
  await expect(createMCPAuthorityLookupIndexes(mongoose.connection)).resolves.toEqual(
    expected.map(([, name]) => name),
  );
  await Promise.all(
    expected.map(async ([collection, name]) => {
      expect(await mongoose.connection.db!.collection(collection).indexExists(name)).toBe(true);
    }),
  );
});
