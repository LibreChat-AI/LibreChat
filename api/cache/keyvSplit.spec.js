const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { CacheKeys, ViolationTypes } = require('librechat-data-provider');

/**
 * Collection reach for the `logs` → `bans` Keyv split.
 *
 * Reach is observed from the driver's own command monitoring rather than from
 * stored documents, because a read leaves no residue: counting documents in
 * `logs` cannot distinguish "never read `logs`" from "read `logs` and found
 * nothing", and only the former is what the split promises.
 */
describe('Keyv `logs` / `bans` split', () => {
  let mongoServer;
  let db;
  let commands;
  let getLogStores;
  let checkBan;
  let domainParser;
  let keyvMongo;
  let keyvMongoBans;

  const collectionsTouched = () => [...new Set(commands.map(({ collection }) => collection))];
  const collectionNames = async () =>
    (await db.listCollections().toArray()).map(({ name }) => name);

  beforeAll(async () => {
    process.env.MONGO_AUTO_CREATE = 'false';
    process.env.BAN_VIOLATIONS = 'true';
    delete process.env.USE_REDIS;

    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { monitorCommands: true });
    db = mongoose.connection.db;

    commands = [];
    mongoose.connection.getClient().on('commandStarted', (event) => {
      const collection = event.command[event.commandName];
      if (typeof collection === 'string') {
        commands.push({ commandName: event.commandName, collection });
      }
    });

    ({ getLogStores } = require('~/cache'));
    ({ keyvMongo, keyvMongoBans } = require('@librechat/api'));
    checkBan = require('~/server/middleware/checkBan');
    ({ domainParser } = require('~/server/services/ActionService'));
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(() => {
    commands.length = 0;
  });

  it('materializes `bans` on its first write while `MONGO_AUTO_CREATE` is false', async () => {
    expect(process.env.MONGO_AUTO_CREATE).toBe('false');
    expect(await collectionNames()).not.toContain('bans');

    await getLogStores(ViolationTypes.BAN).set('198.51.100.4', {
      expiresAt: Date.now() + 3_600_000,
    });

    expect(await collectionNames()).toContain('bans');
  });

  it('the `BANS` namespace reads and writes `bans` and issues no `logs` access', async () => {
    const key = '203.0.113.7';
    const banData = { expiresAt: Date.now() + 3_600_000 };
    const banLogs = getLogStores(ViolationTypes.BAN);

    await banLogs.set(key, banData);
    const readBack = await banLogs.get(key);
    const touched = collectionsTouched();

    expect(readBack).toEqual(banData);
    expect(touched).toContain('bans');
    expect(touched).not.toContain('logs');

    expect(await db.collection('bans').findOne({ key: `${CacheKeys.BANS}:${key}` })).not.toBeNull();
    expect(await db.collection('logs').countDocuments()).toBe(0);
  });

  it('a ban check resolves through `bans`, caches there, and issues no `logs` access', async () => {
    const ip = '192.0.2.55';
    await getLogStores(ViolationTypes.BAN).set(ip, { expiresAt: Date.now() + 3_600_000 });

    const json = jest.fn();
    const req = { ip, headers: {}, body: {} };
    const res = { status: jest.fn(() => ({ json })) };
    const next = jest.fn();

    commands.length = 0;
    await checkBan(req, res, next);
    const touched = collectionsTouched();

    expect(req.banned).toBe(true);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(touched).toContain('bans');
    expect(touched).not.toContain('logs');

    expect(
      await db.collection('bans').findOne({ key: `${ViolationTypes.BAN}:${ip}` }),
    ).not.toBeNull();
    expect(await db.collection('logs').countDocuments()).toBe(0);
  });

  it('an unbanned request passes through without reaching `logs`', async () => {
    const req = { ip: '192.0.2.99', headers: {}, body: {} };
    const res = { status: jest.fn(() => ({ json: jest.fn() })) };
    const next = jest.fn();

    await checkBan(req, res, next);
    const touched = collectionsTouched();

    expect(next).toHaveBeenCalledWith();
    expect(req.banned).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(touched).not.toContain('logs');
  });

  it('`ENCODED_DOMAINS` round-trips a long hostname through `logs` only', async () => {
    const hostname = 'very-long-hostname.example.com';

    const encoded = await domainParser(hostname, true);
    const decoded = await domainParser(encoded, false);
    const touched = collectionsTouched();

    expect(decoded).toBe(hostname);
    expect(touched).toContain('logs');
    expect(touched).not.toContain('bans');

    const key = `${CacheKeys.ENCODED_DOMAINS}:${encoded}`;
    expect(await db.collection('logs').findOne({ key })).not.toBeNull();
    expect(await db.collection('bans').countDocuments({ key })).toBe(0);
  });

  it('both store instances coexist without a `storeMap` collision', async () => {
    expect(keyvMongoBans).not.toBe(keyvMongo);

    await keyvMongo.set('coexist:logs', 'logs-value');
    await keyvMongoBans.set('coexist:bans', 'bans-value');

    expect(await keyvMongo.get('coexist:logs')).toBe('logs-value');
    expect(await keyvMongoBans.get('coexist:bans')).toBe('bans-value');
    expect(await keyvMongo.get('coexist:bans')).toBeUndefined();
    expect(await keyvMongoBans.get('coexist:logs')).toBeUndefined();

    expect(await db.collection('logs').countDocuments({ key: 'coexist:bans' })).toBe(0);
    expect(await db.collection('bans').countDocuments({ key: 'coexist:logs' })).toBe(0);
  });
});
