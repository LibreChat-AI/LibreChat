import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { COLLECTION_INDEXES, ensureArtifactAppIndexes } from './artifactAppIndexes';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

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

describe('ensureArtifactAppIndexes', () => {
  test('creates every required artifact index idempotently', async () => {
    const expectedCount = Object.values(COLLECTION_INDEXES).reduce(
      (total, definitions) => total + definitions.length,
      0,
    );

    const first = await ensureArtifactAppIndexes(mongoose.connection);
    const second = await ensureArtifactAppIndexes(mongoose.connection);

    expect(first.errors).toEqual([]);
    expect(first.created).toHaveLength(expectedCount);
    expect(second.errors).toEqual([]);
    expect(second.created).toHaveLength(expectedCount);
    expect(
      await mongoose.connection
        .db!.collection('artifactapps')
        .indexExists([
          'tenantId_1_artifactAppId_1',
          'tenantId_1_createdBy_1_sourceMetadata.conversationId_1_sourceMetadata.sourceKey_1',
        ]),
    ).toBe(true);
    expect(
      await mongoose.connection
        .db!.collection('artifactversions')
        .indexExists([
          'tenantId_1_artifactAppId_1_versionNumber_1',
          'tenantId_1_artifactVersionId_1',
        ]),
    ).toBe(true);
    expect(
      await mongoose.connection
        .db!.collection('artifactsourcetombstones')
        .indexExists(['tenantId_1_createdBy_1_conversationId_1']),
    ).toBe(true);
  });

  test('accepts the source index definition already present in existing deployments', async () => {
    const collection = mongoose.connection.db!.collection('artifactapps');
    await collection.createIndex(
      {
        tenantId: 1,
        createdBy: 1,
        'sourceMetadata.conversationId': 1,
        'sourceMetadata.sourceKey': 1,
      },
      {
        unique: true,
        partialFilterExpression: {
          'sourceMetadata.conversationId': { $type: 'string' },
          'sourceMetadata.sourceKey': { $type: 'string' },
        },
      },
    );

    await expect(ensureArtifactAppIndexes(mongoose.connection)).resolves.toMatchObject({
      errors: [],
    });
  });

  test('rejects startup when existing data violates a required unique index', async () => {
    await mongoose.connection.db!.collection('artifactapps').insertMany([
      {
        artifactAppId: 'app-1',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
        sourceMetadata: { conversationId: 'conversation-1', sourceKey: 'identifier:chart' },
      },
      {
        artifactAppId: 'app-2',
        tenantId: 'tenant-1',
        createdBy: 'user-1',
        sourceMetadata: { conversationId: 'conversation-1', sourceKey: 'identifier:chart' },
      },
    ]);

    await expect(ensureArtifactAppIndexes(mongoose.connection)).rejects.toThrow(
      /required index operation.*duplicate key/,
    );
  });
});
