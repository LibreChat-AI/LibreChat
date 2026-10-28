import mongoose from 'mongoose';
import { Collection } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import type { Document, FindOptions } from 'mongodb';
import {
  searchTokenIndexes,
  USER_SEARCH_TOKEN_FIELDS,
  GROUP_SEARCH_TOKEN_FIELDS,
} from '~/utils/search';
import { backfillSearchTokens, warnOnMissingSearchTokens } from './searchTokens';
import logger from '~/config/winston';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

let mongoServer: MongoMemoryServer;

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
  jest.clearAllMocks();
});

const users = () => mongoose.connection.db!.collection('users');
const groups = () => mongoose.connection.db!.collection('groups');

describe('backfillSearchTokens', () => {
  it('backfills users and groups across tenants in batches and is idempotent', async () => {
    await users().insertMany([
      { name: 'Ana Lima', email: 'ana@x.io', username: 'ana', tenantId: 'tenant-a' },
      { name: 'Ben Ode', email: 'ben@y.io', tenantId: 'tenant-b' },
      { email: 'noname@z.io' },
      {
        name: 'Already Done',
        email: 'done@z.io',
        nameTokens: ['already', 'done'],
        emailTokens: ['done@z.io', 'done', 'z', 'io'],
        usernameTokens: [],
      },
    ]);
    await groups().insertMany([{ name: 'Core Team', source: 'local' }]);

    const result = await backfillSearchTokens(mongoose.connection, { batchSize: 2 });
    expect(result).toEqual({
      pending: { users: 3, groups: 1 },
      updated: { users: 3, groups: 1 },
    });

    const ana = await users().findOne({ email: 'ana@x.io' });
    expect(ana).toMatchObject({
      tenantId: 'tenant-a',
      nameTokens: ['ana', 'lima'],
      emailTokens: ['ana@x.io', 'ana', 'x', 'io'],
      usernameTokens: ['ana'],
    });
    expect(await users().findOne({ email: 'noname@z.io' })).toMatchObject({
      nameTokens: [],
      usernameTokens: [],
    });
    expect(await groups().findOne({ name: 'Core Team' })).toMatchObject({
      nameTokens: ['core', 'team'],
      emailTokens: [],
    });

    await expect(backfillSearchTokens(mongoose.connection)).resolves.toEqual({
      pending: { users: 0, groups: 0 },
      updated: { users: 0, groups: 0 },
    });
  });

  it('completes documents that a partial update tokenized for only one field', async () => {
    await users().insertOne({ name: 'Part Ial', email: 'p@x.io', emailTokens: ['p@x.io'] });
    await backfillSearchTokens(mongoose.connection);
    expect(await users().findOne({ email: 'p@x.io' })).toMatchObject({
      nameTokens: ['part', 'ial'],
      emailTokens: ['p@x.io', 'p', 'x', 'io'],
    });
  });

  it('repairs tokens left stale by a writer that did not maintain them', async () => {
    await users().insertOne({
      name: 'New Name',
      email: 'stale@x.io',
      nameTokens: ['old', 'name'],
      emailTokens: ['stale@x.io', 'stale', 'x', 'io'],
      usernameTokens: [],
    });
    await expect(backfillSearchTokens(mongoose.connection, { dryRun: true })).resolves.toEqual({
      pending: { users: 1, groups: 0 },
      updated: { users: 0, groups: 0 },
    });
    await expect(backfillSearchTokens(mongoose.connection)).resolves.toEqual({
      pending: { users: 1, groups: 0 },
      updated: { users: 1, groups: 0 },
    });
    expect(await users().findOne({ email: 'stale@x.io' })).toMatchObject({
      nameTokens: ['new', 'name'],
    });
  });

  it('creates the token indexes when the schema indexes were never built', async () => {
    await users().insertOne({ name: 'No Index', email: 'noindex@x.io' });
    await groups().insertOne({ name: 'Plain Group' });
    await backfillSearchTokens(mongoose.connection);
    const userIndexes = (await users().indexes()).map((index) => index.name);
    const groupIndexes = (await groups().indexes()).map((index) => index.name);
    expect(userIndexes).toEqual(
      expect.arrayContaining([
        'nameTokens_1_tenantId_1',
        'emailTokens_1_tenantId_1',
        'usernameTokens_1_tenantId_1',
        'tenantId_1_nameTokens_1',
        'tenantId_1_emailTokens_1',
        'tenantId_1_usernameTokens_1',
      ]),
    );
    expect(groupIndexes).toEqual(
      expect.arrayContaining([
        'nameTokens_1_tenantId_1',
        'emailTokens_1_tenantId_1',
        'tenantId_1_nameTokens_1',
        'tenantId_1_emailTokens_1',
      ]),
    );
  });

  it('writes nothing on a dry run', async () => {
    await users().insertOne({ name: 'Dry Run', email: 'dry@x.io' });
    await expect(backfillSearchTokens(mongoose.connection, { dryRun: true })).resolves.toEqual({
      pending: { users: 1, groups: 0 },
      updated: { users: 0, groups: 0 },
    });
    expect(await users().findOne({ email: 'dry@x.io' })).not.toHaveProperty('nameTokens');
  });
});

describe('warnOnMissingSearchTokens', () => {
  it('warns only while documents lack tokens', async () => {
    await users().insertOne({ name: 'Old User', email: 'old@x.io' });
    await groups().insertOne({ name: 'Old Group' });
    await warnOnMissingSearchTokens(mongoose.connection);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Some users and groups'));

    jest.clearAllMocks();
    await backfillSearchTokens(mongoose.connection);
    await warnOnMissingSearchTokens(mongoose.connection);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /** Runs the startup check and explains the `users` probe it actually issued. */
  const explainUserProbe = async () => {
    const findOne = jest.spyOn(Collection.prototype, 'findOne');
    try {
      await warnOnMissingSearchTokens(mongoose.connection);
      const call = findOne.mock.contexts.findIndex(
        (collection) => collection.collectionName === 'users',
      );
      const [filter, options] = findOne.mock.calls[call] as [Document, FindOptions];
      expect(options.maxTimeMS).toBeGreaterThan(0);
      return await users().find(filter).limit(1).explain('executionStats');
    } finally {
      findOne.mockRestore();
    }
  };

  it('warns without probing documents while the token indexes do not exist', async () => {
    await users().insertMany(
      Array.from({ length: 200 }, (_, i) => ({ name: `Old ${i}`, email: `old${i}@x.io` })),
    );
    const findOne = jest.spyOn(Collection.prototype, 'findOne');
    try {
      await warnOnMissingSearchTokens(mongoose.connection);
      const probed = findOne.mock.contexts.some(
        (collection) => collection.collectionName === 'users',
      );
      expect(probed).toBe(false);
    } finally {
      findOne.mockRestore();
    }
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Some users'));
  });

  it('examines no documents once the backfill has built the indexes and filled every token', async () => {
    await users().insertMany(
      Array.from({ length: 50 }, (_, i) => ({ name: `User ${i}`, email: `u${i}@x.io` })),
    );
    await backfillSearchTokens(mongoose.connection);
    jest.clearAllMocks();
    const explain = await explainUserProbe();
    expect(JSON.stringify(explain.queryPlanner.winningPlan)).not.toContain('COLLSCAN');
    expect(explain.executionStats.totalDocsExamined).toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('warns when every document has tokens but the token indexes were never built', async () => {
    await users().insertOne({
      name: 'Fresh User',
      email: 'fresh@x.io',
      nameTokens: ['fresh', 'user'],
      emailTokens: ['fresh@x.io', 'fresh', 'x', 'io'],
      usernameTokens: [],
    });
    await warnOnMissingSearchTokens(mongoose.connection);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Some users'));

    jest.clearAllMocks();
    await backfillSearchTokens(mongoose.connection);
    await warnOnMissingSearchTokens(mongoose.connection);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('stays quiet on a database with no users or groups yet', async () => {
    await warnOnMissingSearchTokens(mongoose.connection);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('logs a failed probe instead of failing startup', async () => {
    /** Every token index exists, so the check reaches the probe, which then fails. */
    const indexes = [...USER_SEARCH_TOKEN_FIELDS, ...GROUP_SEARCH_TOKEN_FIELDS]
      .flatMap(searchTokenIndexes)
      .map((key) => ({ key }));
    const findOne = jest.fn(() => Promise.reject(new Error('down')));
    const broken = {
      db: { collection: () => ({ indexes: async () => indexes, findOne }) },
    };
    await expect(
      warnOnMissingSearchTokens(broken as unknown as typeof mongoose.connection),
    ).resolves.toBeUndefined();
    expect(findOne).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
