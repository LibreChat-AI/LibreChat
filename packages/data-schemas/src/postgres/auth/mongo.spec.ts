import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { createMongoAuthenticationSource } from './mongo';
import { fingerprintAuthentication } from './import';

/** Offline readers must not inherit a lag-tolerant application URI. */
describe('committed primary authentication migration source', () => {
  const database = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({
      replSet: { count: 2 },
      instanceOpts: [{ args: ['--nounixsocket'] }, { args: ['--nounixsocket'] }],
    });
    const uri = mongo.getUri();
    await database.connect(
      `${uri}${uri.includes('?') ? '&' : '?'}readPreference=secondaryPreferred`,
      {
        autoCreate: false,
        autoIndex: false,
        serverSelectionTimeoutMS: 750,
      },
    );
  }, 60000);
  afterAll(async () => {
    await database.disconnect();
    await mongo?.stop();
  });
  it('uses primary and majority for all five collections without registering or creating models', async () => {
    expect(database.connection.getClient().readPreference.mode).toBe('secondaryPreferred');
    const sessions = database.connection.collection('sessions');
    const id = new database.Types.ObjectId();
    await sessions.insertOne(
      {
        _id: id,
        user: new database.Types.ObjectId(),
        refreshTokenHash: 'revoked',
        expiration: new Date(Date.now() + 60000),
      },
      { writeConcern: { w: 'majority' } },
    );
    await sessions.deleteOne({ _id: id }, { writeConcern: { w: 'majority' } });
    const before = await database.connection.db!.listCollections().toArray();
    const find = jest.spyOn(database.Collection.prototype, 'find');
    try {
      expect(
        (await fingerprintAuthentication(createMongoAuthenticationSource(database))).count,
      ).toBe(0);
      expect(find).toHaveBeenCalledTimes(5);
      for (const [, options] of find.mock.calls) {
        expect(options).toMatchObject({
          readPreference: 'primary',
          readConcern: { level: 'majority' },
        });
      }
      expect(database.modelNames()).toEqual([]);
      expect(await database.connection.db!.listCollections().toArray()).toEqual(before);
    } finally {
      find.mockRestore();
    }
  });
  it('fails when only a secondary is available rather than returning its snapshot', async () => {
    const hello = await database.connection
      .db!.admin()
      .command({ hello: 1 }, { readPreference: 'primary' });
    const secondary = mongo.servers.find(
      (server) => hello.primary !== `127.0.0.1:${server.instanceInfo?.port}`,
    );
    expect(secondary).toBeDefined();
    const secondaryClient = new database.mongo.MongoClient(secondary!.getUri(), {
      directConnection: true,
      readPreference: 'secondary',
    });
    try {
      await secondaryClient.connect();
      await secondaryClient.db().admin().command({ replSetFreeze: 60 });
      await database.connection
        .db!.admin()
        .command({ replSetStepDown: 60, force: true }, { readPreference: 'primary' });
      await expect(
        fingerprintAuthentication(createMongoAuthenticationSource(database)),
      ).rejects.toBeInstanceOf(database.mongo.MongoServerSelectionError);
    } finally {
      await secondaryClient.close();
    }
  });
});
