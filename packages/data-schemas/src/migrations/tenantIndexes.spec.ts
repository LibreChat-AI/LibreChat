import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  dropSupersededTenantIndexes,
  migrateTenantIndexes,
  SUPERSEDED_INDEXES,
} from './tenantIndexes';

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

describe('dropSupersededTenantIndexes', () => {
  describe('with pre-existing superseded unique indexes (simulates upgrade)', () => {
    beforeAll(async () => {
      const db = mongoose.connection.db!;

      await db.createCollection('users');
      const users = db.collection('users');
      await users.createIndex({ email: 1 }, { unique: true, name: 'email_1' });
      await users.createIndex({ googleId: 1 }, { unique: true, sparse: true, name: 'googleId_1' });
      await users.createIndex(
        { facebookId: 1 },
        { unique: true, sparse: true, name: 'facebookId_1' },
      );
      await users.createIndex({ openidId: 1 }, { unique: true, sparse: true, name: 'openidId_1' });
      await users.createIndex(
        { openidId: 1, tenantId: 1 },
        { unique: true, name: 'openidId_1_tenantId_1' },
      );
      await users.createIndex({ samlId: 1 }, { unique: true, sparse: true, name: 'samlId_1' });
      await users.createIndex({ ldapId: 1 }, { unique: true, sparse: true, name: 'ldapId_1' });
      await users.createIndex({ githubId: 1 }, { unique: true, sparse: true, name: 'githubId_1' });
      await users.createIndex(
        { discordId: 1 },
        { unique: true, sparse: true, name: 'discordId_1' },
      );
      await users.createIndex({ appleId: 1 }, { unique: true, sparse: true, name: 'appleId_1' });

      await db.createCollection('roles');
      await db.collection('roles').createIndex({ name: 1 }, { unique: true, name: 'name_1' });

      await db.createCollection('agents');
      await db.collection('agents').createIndex({ id: 1 }, { unique: true, name: 'id_1' });

      await db.createCollection('conversations');
      await db
        .collection('conversations')
        .createIndex({ conversationId: 1 }, { unique: true, name: 'conversationId_1' });
      await db
        .collection('conversations')
        .createIndex(
          { conversationId: 1, user: 1 },
          { unique: true, name: 'conversationId_1_user_1' },
        );

      await db.createCollection('messages');
      await db
        .collection('messages')
        .createIndex({ messageId: 1 }, { unique: true, name: 'messageId_1' });
      await db
        .collection('messages')
        .createIndex({ messageId: 1, user: 1 }, { unique: true, name: 'messageId_1_user_1' });

      await db.createCollection('presets');
      await db
        .collection('presets')
        .createIndex({ presetId: 1 }, { unique: true, name: 'presetId_1' });

      await db.createCollection('agentcategories');
      await db
        .collection('agentcategories')
        .createIndex({ value: 1 }, { unique: true, name: 'value_1' });

      await db.createCollection('accessroles');
      await db
        .collection('accessroles')
        .createIndex({ accessRoleId: 1 }, { unique: true, name: 'accessRoleId_1' });

      await db.createCollection('conversationtags');
      await db
        .collection('conversationtags')
        .createIndex({ tag: 1, user: 1 }, { unique: true, name: 'tag_1_user_1' });

      await db.createCollection('mcpservers');
      await db
        .collection('mcpservers')
        .createIndex({ serverName: 1 }, { unique: true, name: 'serverName_1' });

      await db.createCollection('files');
      await db
        .collection('files')
        .createIndex(
          { filename: 1, conversationId: 1, context: 1 },
          { unique: true, name: 'filename_1_conversationId_1_context_1' },
        );

      await db.createCollection('groups');
      await db
        .collection('groups')
        .createIndex(
          { idOnTheSource: 1, source: 1 },
          { unique: true, name: 'idOnTheSource_1_source_1' },
        );

      await db.createCollection('skillsyncstatuses');
      await db
        .collection('skillsyncstatuses')
        .createIndex({ provider: 1, sourceId: 1 }, { unique: true, name: 'provider_1_sourceId_1' });
    });

    it('drops all superseded indexes', async () => {
      const result = await dropSupersededTenantIndexes(mongoose.connection);

      expect(result.errors).toHaveLength(0);
      expect(result.dropped.length).toBeGreaterThan(0);

      const totalExpected = Object.values(SUPERSEDED_INDEXES).reduce(
        (sum, arr) => sum + arr.length,
        0,
      );
      expect(result.dropped).toHaveLength(totalExpected);
    });

    it('reports no superseded indexes on second run (idempotent)', async () => {
      const result = await dropSupersededTenantIndexes(mongoose.connection);

      expect(result.errors).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThan(0);
    });

    it('old unique indexes are actually gone from users collection', async () => {
      const indexes = await mongoose.connection.db!.collection('users').indexes();
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).not.toContain('email_1');
      expect(indexNames).not.toContain('googleId_1');
      expect(indexNames).not.toContain('openidId_1');
      expect(indexNames).not.toContain('openidId_1_tenantId_1');
      expect(indexNames).toContain('_id_');
    });

    it('old unique indexes are actually gone from roles collection', async () => {
      const indexes = await mongoose.connection.db!.collection('roles').indexes();
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).not.toContain('name_1');
    });

    it('old compound unique indexes are gone from conversations collection', async () => {
      const indexes = await mongoose.connection.db!.collection('conversations').indexes();
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).not.toContain('conversationId_1_user_1');
    });

    it('old skill sync status unique index is gone', async () => {
      const indexes = await mongoose.connection.db!.collection('skillsyncstatuses').indexes();
      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).not.toContain('provider_1_sourceId_1');
    });
  });

  describe('multi-tenant writes after migration', () => {
    beforeAll(async () => {
      const db = mongoose.connection.db!;

      const users = db.collection('users');
      await users.createIndex(
        { email: 1, tenantId: 1 },
        { unique: true, name: 'email_1_tenantId_1' },
      );
    });

    it('allows same email in different tenants after old index is dropped', async () => {
      const users = mongoose.connection.db!.collection('users');

      await users.insertOne({
        email: 'shared@example.com',
        tenantId: 'tenant-a',
        name: 'User A',
      });
      await users.insertOne({
        email: 'shared@example.com',
        tenantId: 'tenant-b',
        name: 'User B',
      });

      const countA = await users.countDocuments({
        email: 'shared@example.com',
        tenantId: 'tenant-a',
      });
      const countB = await users.countDocuments({
        email: 'shared@example.com',
        tenantId: 'tenant-b',
      });

      expect(countA).toBe(1);
      expect(countB).toBe(1);
    });

    it('still rejects duplicate email within same tenant', async () => {
      const users = mongoose.connection.db!.collection('users');

      await users.insertOne({
        email: 'unique-within@example.com',
        tenantId: 'tenant-dup',
        name: 'First',
      });

      await expect(
        users.insertOne({
          email: 'unique-within@example.com',
          tenantId: 'tenant-dup',
          name: 'Second',
        }),
      ).rejects.toThrow(/E11000|duplicate key/);
    });
  });

  describe('on a fresh database (no pre-existing collections)', () => {
    let freshServer: InstanceType<typeof MongoMemoryServer>;
    let freshConnection: mongoose.Connection;

    beforeAll(async () => {
      freshServer = await MongoMemoryServer.create();
      freshConnection = mongoose.createConnection(freshServer.getUri());
      await freshConnection.asPromise();
    });

    afterAll(async () => {
      await freshConnection.close();
      await freshServer.stop();
    });

    it('skips all indexes gracefully (no errors)', async () => {
      const result = await dropSupersededTenantIndexes(freshConnection);

      expect(result.errors).toHaveLength(0);
      expect(result.dropped).toHaveLength(0);
      expect(result.skipped.length).toBeGreaterThan(0);
    });
  });

  describe('partial migration (some indexes exist, some do not)', () => {
    let partialServer: InstanceType<typeof MongoMemoryServer>;
    let partialConnection: mongoose.Connection;

    beforeAll(async () => {
      partialServer = await MongoMemoryServer.create();
      partialConnection = mongoose.createConnection(partialServer.getUri());
      await partialConnection.asPromise();

      const db = partialConnection.db!;
      await db.createCollection('users');
      await db.collection('users').createIndex({ email: 1 }, { unique: true, name: 'email_1' });
    });

    afterAll(async () => {
      await partialConnection.close();
      await partialServer.stop();
    });

    it('drops existing indexes and skips missing ones', async () => {
      const result = await dropSupersededTenantIndexes(partialConnection);

      expect(result.errors).toHaveLength(0);
      expect(result.dropped).toContain('users.email_1');
      expect(result.skipped.length).toBeGreaterThan(0);

      const skippedCollections = result.skipped.filter((s) => s.includes('does not exist'));
      expect(skippedCollections.length).toBeGreaterThan(0);
    });
  });

  describe('SUPERSEDED_INDEXES coverage', () => {
    it('covers all collections with unique index changes', () => {
      const expectedCollections = [
        'users',
        'roles',
        'conversations',
        'messages',
        'agentcategories',
        'accessroles',
        'conversationtags',
        'mcpservers',
        'files',
        'groups',
        'skillsyncstatuses',
      ];

      for (const col of expectedCollections) {
        expect(SUPERSEDED_INDEXES).toHaveProperty(col);
        expect(SUPERSEDED_INDEXES[col].length).toBeGreaterThan(0);
      }
    });

    it('users collection lists all superseded OAuth and email indexes', () => {
      expect(SUPERSEDED_INDEXES.users).toHaveLength(10);
      expect(SUPERSEDED_INDEXES.users).toContain('email_1');
      expect(SUPERSEDED_INDEXES.users).toContain('googleId_1');
      expect(SUPERSEDED_INDEXES.users).toContain('openidId_1');
      expect(SUPERSEDED_INDEXES.users).toContain('openidId_1_tenantId_1');
    });
  });
});

describe('operator migration', () => {
  let instance: mongoose.Mongoose;

  beforeEach(async () => {
    instance = new mongoose.Mongoose();
    await instance.connect(mongoServer.getUri(), {
      dbName: 'operator',
      autoIndex: false,
      autoCreate: false,
    });
    await instance.connection.dropDatabase();
  });

  afterEach(async () => {
    await instance.disconnect();
  });

  it('previews without changing indexes or creating collections', async () => {
    const roles = instance.connection.db!.collection('roles');
    await roles.createIndex({ name: 1 }, { unique: true });
    const before = await roles.indexes();
    const result = await migrateTenantIndexes(instance.connection, { dryRun: true });
    expect(result.planned).toEqual(['roles.name_1']);
    expect(result.dropped).toEqual([]);
    expect(await roles.indexes()).toEqual(before);
    expect(await instance.connection.db!.listCollections().toArray()).toHaveLength(1);
  });

  it('upgrades legacy indexes, preserves custom indexes, and can be rerun', async () => {
    const roles = instance.connection.db!.collection('roles');
    await roles.insertOne({ name: 'USER' });
    await roles.createIndex({ name: 1 }, { unique: true });
    await roles.createIndex({ custom: 1 }, { name: 'operator_custom' });
    for (const [name, indexNames] of Object.entries(SUPERSEDED_INDEXES)) {
      for (const indexName of indexNames) {
        const fields = indexName.split('_').filter((field) => field !== '1');
        const keys = Object.fromEntries(fields.map((field) => [field, 1 as const]));
        await instance.connection.db!.collection(name).createIndex(keys, { unique: true });
      }
    }
    const result = await migrateTenantIndexes(instance.connection);
    expect(result.errors).toEqual([]);
    expect(result.dropped).toHaveLength(Object.values(SUPERSEDED_INDEXES).flat().length);
    const indexes = await roles.indexes();
    expect(indexes.find((index) => index.name === 'name_1')?.unique).toBeUndefined();
    expect(indexes.find((index) => index.name === 'name_1_tenantId_1')?.unique).toBe(true);
    expect(indexes.some((index) => index.name === 'operator_custom')).toBe(true);
    await expect(roles.insertOne({ name: 'USER' })).rejects.toThrow(/E11000/);
    await roles.insertOne({ name: 'USER', tenantId: 'another-tenant' });
    const rerun = await migrateTenantIndexes(instance.connection);
    expect(rerun.errors).toEqual([]);
    expect(rerun.dropped).toEqual([]);
    expect(await roles.indexes()).toEqual(indexes);
  });

  it('retains legacy constraints when replacement creation fails', async () => {
    const users = instance.connection.db!.collection('users');
    await users.insertMany([{ email: 'a@example.com' }, { email: 'a@example.com' }]);
    const roles = instance.connection.db!.collection('roles');
    await roles.createIndex({ name: 1 }, { unique: true });
    await expect(migrateTenantIndexes(instance.connection)).rejects.toThrow(/E11000/);
    expect((await roles.indexes()).find((index) => index.name === 'name_1')?.unique).toBe(true);
  });

  it('reports index-listing failures instead of treating them as missing collections', async () => {
    const roles = instance.connection.db!.collection('roles');
    const collection = jest.spyOn(instance.connection.db!, 'collection');
    collection.mockReturnValue(roles);
    jest.spyOn(roles, 'indexes').mockRejectedValue(new Error('not authorized'));
    const result = await dropSupersededTenantIndexes(instance.connection);
    expect(result.errors).toHaveLength(Object.keys(SUPERSEDED_INDEXES).length);
    expect(result.skipped).toEqual([]);
    expect(result.dropped).toEqual([]);
  });
});
