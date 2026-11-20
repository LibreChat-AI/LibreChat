import mongoose from 'mongoose';
import { MongoServerError } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels } from './index';
import logger from '~/config/winston';

describe('index build diagnostics', () => {
  const instance = new mongoose.Mongoose();
  instance.set('autoIndex', false);
  instance.set('autoCreate', false);
  const models = createModels(instance);

  afterEach(() => jest.restoreAllMocks());

  it.each([85, 86])('explains offline migration for legacy index conflict code %i', (code) => {
    const error = new MongoServerError({ message: 'Index options conflict', code });
    const log = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    models.Role.emit('index', error);
    expect(log).toHaveBeenCalledWith('Index build failed for "Role": Index options conflict');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('This may be a legacy tenant-index conflict.'),
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stop all API replicas'));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('npm run migrate:tenant-indexes:dry-run'),
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Keep writers stopped until the migration succeeds.'),
    );
  });

  it.each([11000, 13, 67])(
    'does not prescribe a tenant migration for unrelated error code %i',
    (code) => {
      const error = new MongoServerError({ message: 'Other index failure', code });
      const log = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
      models.Role.emit('index', error);
      expect(log).toHaveBeenCalledWith('Index build failed for "Role": Other index failure');
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('does not suggest the migration for a collection outside its scope', () => {
    jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    models.Balance.emit('index', new MongoServerError({ message: 'Index conflict', code: 85 }));
    expect(warn).not.toHaveBeenCalled();
  });

  it('retains uniqueness and reports the remedy after a real legacy index conflict', async () => {
    const server = await MongoMemoryServer.create();
    const database = new mongoose.Mongoose();
    database.set('autoIndex', false);
    database.set('autoCreate', false);
    const log = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    try {
      await database.connect(server.getUri());
      const roles = database.connection.db!.collection('roles');
      await roles.createIndex({ name: 1 }, { unique: true });
      await roles.insertOne({ name: 'USER' });
      const { Role } = createModels(database);
      await expect(Role.createIndexes()).rejects.toThrow();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Index build failed for "Role"'));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm run migrate:tenant-indexes'));
      const indexes = await roles.indexes();
      expect(indexes.find((index) => index.name === 'name_1')?.unique).toBe(true);
      expect(indexes.find((index) => index.name === 'name_1_tenantId_1')?.unique).toBe(true);
      await expect(roles.insertOne({ name: 'USER' })).rejects.toThrow(/E11000/);
    } finally {
      await database.disconnect();
      await server.stop();
    }
  });

  it('does not attach duplicate listeners or log on a successful build', () => {
    const before = models.Role.listenerCount('index');
    createModels(instance);
    expect(models.Role.listenerCount('index')).toBe(before);
    const log = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    models.Role.emit('index', null);
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
