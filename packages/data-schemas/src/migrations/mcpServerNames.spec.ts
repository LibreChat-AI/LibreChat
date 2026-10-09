import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { MCPServerNameMigrationError, backfillMCPServerNormalizedNames } from './mcpServerNames';

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

describe('backfillMCPServerNormalizedNames', () => {
  test('backfills legacy rows and creates the normalized identity index', async () => {
    const collection = mongoose.connection.db!.collection('mcpservers');
    await collection.insertMany([
      { serverName: 'selected server', tenantId: 'tenant-a' },
      { serverName: 'selected/server', tenantId: 'tenant-b' },
      { serverName: 'another-server' },
    ]);

    await expect(backfillMCPServerNormalizedNames(mongoose.connection)).resolves.toEqual({
      scanned: 3,
      updated: 3,
    });
    expect(
      await collection
        .find({}, { projection: { _id: 0, serverName: 1, normalizedServerName: 1 } })
        .sort({ serverName: 1 })
        .toArray(),
    ).toEqual([
      { serverName: 'another-server', normalizedServerName: 'another-server' },
      { serverName: 'selected server', normalizedServerName: 'selected_server' },
      { serverName: 'selected/server', normalizedServerName: 'selected_server' },
    ]);
    expect(await collection.indexExists('normalizedServerName_1_tenantId_1')).toBe(true);

    await expect(backfillMCPServerNormalizedNames(mongoose.connection)).resolves.toEqual({
      scanned: 3,
      updated: 0,
    });
  });

  test('detects all tenant collisions before writing any normalized names', async () => {
    const collection = mongoose.connection.db!.collection('mcpservers');
    await collection.insertMany([
      { serverName: 'selected server', tenantId: 'tenant-a' },
      { serverName: 'selected/server', tenantId: 'tenant-a' },
    ]);

    await expect(backfillMCPServerNormalizedNames(mongoose.connection)).rejects.toEqual(
      expect.objectContaining({
        name: MCPServerNameMigrationError.name,
        message: expect.stringContaining('normalize to the same identity'),
      }),
    );
    expect(await collection.countDocuments({ normalizedServerName: { $exists: true } })).toBe(0);
    expect(await collection.indexExists('normalizedServerName_1_tenantId_1')).toBe(false);
  });

  test('pins both migration scans to primary with majority read concern', async () => {
    const collection = mongoose.connection.db!.collection('mcpservers');
    await collection.insertOne({ serverName: 'selected server', tenantId: 'tenant-a' });
    const findSpy = jest.spyOn(mongoose.mongo.Collection.prototype, 'find');

    try {
      await backfillMCPServerNormalizedNames(mongoose.connection);

      expect(findSpy).toHaveBeenCalledTimes(2);
      expect(
        findSpy.mock.calls.every(
          ([, options]) =>
            options?.readPreference === 'primary' &&
            typeof options.readConcern === 'object' &&
            options.readConcern.level === 'majority',
        ),
      ).toBe(true);
    } finally {
      findSpy.mockRestore();
    }
  });
});
