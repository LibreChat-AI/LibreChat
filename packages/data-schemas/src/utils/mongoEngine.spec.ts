import mongoose from 'mongoose';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server';
import type { Connection } from 'mongoose';
import { detectMongoEngine, resolveAuthorizationQueryOptions } from './mongoEngine';

describe('resolveAuthorizationQueryOptions', () => {
  it('resolves replica-set options with linearizable reads and majority writes with a wtimeout', () => {
    expect(resolveAuthorizationQueryOptions('replicaSet', { maxTimeMS: 2000 })).toEqual({
      read: { readPreference: 'primary', readConcern: { level: 'linearizable' }, maxTimeMS: 2000 },
      write: { writeConcern: { w: 'majority', wtimeoutMS: 2000 } },
    });
  });

  it('resolves standalone options with local reads, maxTimeMS and w:1 writes with no wtimeout', () => {
    expect(resolveAuthorizationQueryOptions('standalone', { maxTimeMS: 2000 })).toEqual({
      read: { readPreference: 'primary', readConcern: { level: 'local' }, maxTimeMS: 2000 },
      write: { writeConcern: { w: 1 } },
    });
  });

  it('resolves DocumentDB options without a readConcern but with maxTimeMS and a wtimeout', () => {
    expect(resolveAuthorizationQueryOptions('documentdb', { maxTimeMS: 2000 })).toEqual({
      read: { readPreference: 'primary', maxTimeMS: 2000 },
      write: { writeConcern: { w: 'majority', wtimeoutMS: 2000 } },
    });
  });
});

describe('detectMongoEngine', () => {
  let mongoServer: MongoMemoryServer;
  let connection: Connection;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
  });

  afterAll(async () => {
    await connection.close();
    await mongoServer?.stop();
  });

  it('returns the caller override without inspecting the connection', async () => {
    await expect(detectMongoEngine(connection, 'documentdb')).resolves.toBe('documentdb');
  });

  it('detects a standalone deployment from hello when override is auto or omitted', async () => {
    await expect(detectMongoEngine(connection, 'auto')).resolves.toBe('standalone');
    await expect(detectMongoEngine(connection)).resolves.toBe('standalone');
  });

  it('detects a DocumentDB host before ever inspecting the wire reply', async () => {
    const docdbConnection = mongoose.createConnection(
      'mongodb://node-1.cluster-abc.us-east-2.docdb.amazonaws.com:27017/test?replicaSet=rs0',
      { serverSelectionTimeoutMS: 50 },
    );
    docdbConnection.on('error', () => {});
    try {
      await expect(detectMongoEngine(docdbConnection)).resolves.toBe('documentdb');
    } finally {
      await docdbConnection.close().catch(() => {});
    }
  });

  it('detects a DocumentDB Elastic host', async () => {
    const docdbConnection = mongoose.createConnection(
      'mongodb://node-1.us-east-2.docdb-elastic.amazonaws.com:27017/test',
      { serverSelectionTimeoutMS: 50 },
    );
    docdbConnection.on('error', () => {});
    try {
      await expect(detectMongoEngine(docdbConnection)).resolves.toBe('documentdb');
    } finally {
      await docdbConnection.close().catch(() => {});
    }
  });

  it('falls back to isMaster when hello fails', async () => {
    const admin = connection.db!.admin();
    jest.spyOn(connection.db!, 'admin').mockReturnValue(admin);
    const command = jest
      .spyOn(admin, 'command')
      .mockRejectedValueOnce(new Error('hello not supported'))
      .mockResolvedValueOnce({ setName: 'rs0' });

    await expect(detectMongoEngine(connection)).resolves.toBe('replicaSet');
    expect(command).toHaveBeenNthCalledWith(1, { hello: 1 });
    expect(command).toHaveBeenNthCalledWith(2, { isMaster: 1 });
  });
});

describe('detectMongoEngine on a replica set', () => {
  let replSet: MongoMemoryReplSet;
  let connection: Connection;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    connection = await mongoose.createConnection(replSet.getUri()).asPromise();
  });

  afterAll(async () => {
    await connection.close();
    await replSet?.stop();
  });

  it('detects a replica set from hello when no DocumentDB host and no override are given', async () => {
    await expect(detectMongoEngine(connection)).resolves.toBe('replicaSet');
  });
});
