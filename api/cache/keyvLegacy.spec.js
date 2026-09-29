const { Keyv } = require('keyv');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { CacheKeys, ViolationTypes } = require('librechat-data-provider');

/**
 * Backward compatibility for the ban entries a pre-relocation deployment left in `logs`. No
 * migration ships for this pair, so the documents stay where they were written and the relocated
 * layout must simply not see them.
 *
 * Seeding goes through a `Keyv` bound to the `logs` store under the same two namespaces the
 * pre-relocation code used, so each seeded document carries Keyv's own serialized envelope rather
 * than a hand-built approximation. The seeds are written without a TTL, so a "no ban present"
 * outcome cannot be attributed to expiry — only to the read never reaching `logs`.
 *
 * Requirements: 1.11, 8.27
 */
describe('pre-relocation ban entries left in `logs`', () => {
  let mongoServer;
  let db;
  let commands;
  let getLogStores;
  let checkBan;
  let keyvMongo;
  let legacyBanCache;
  let legacyBanLogs;

  const ip = '198.51.100.9';
  const banData = { expiresAt: Date.now() + 3_600_000 };

  const collectionsTouched = () => [...new Set(commands.map(({ collection }) => collection))];
  const collectionNames = async () =>
    (await db.listCollections().toArray()).map(({ name }) => name);
  const logDocs = () => db.collection('logs').find({}).sort({ key: 1 }).toArray();

  /** Runs the middleware over a fresh command window, so `touched` covers only its own reach. */
  const runCheckBan = async () => {
    const json = jest.fn();
    const req = { ip, headers: {}, body: {} };
    const res = { status: jest.fn(() => ({ json })), json };
    const next = jest.fn();

    commands.length = 0;
    await checkBan(req, res, next);
    const touched = collectionsTouched();

    return { req, res, next, touched };
  };

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
    ({ keyvMongo } = require('@librechat/api'));
    checkBan = require('~/server/middleware/checkBan');

    /* The two pre-relocation bindings: both ban namespaces on the `logs` store. */
    legacyBanLogs = new Keyv({ store: keyvMongo, namespace: CacheKeys.BANS, ttl: 0 });
    legacyBanCache = new Keyv({ store: keyvMongo, namespace: ViolationTypes.BAN, ttl: 0 });
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([db.collection('logs').deleteMany({}), db.collection('bans').deleteMany({})]);
    commands.length = 0;
  });

  it('resolves a `BANS` entry left in `logs` as no ban present, leaving it in place', async () => {
    await legacyBanLogs.set(ip, banData);
    const seeded = await logDocs();
    expect(seeded).toHaveLength(1);
    expect(seeded[0].key).toBe(`${CacheKeys.BANS}:${ip}`);

    commands.length = 0;
    const readBack = await getLogStores(ViolationTypes.BAN).get(ip);
    const touched = collectionsTouched();

    expect(readBack).toBeUndefined();
    expect(touched).toContain('bans');
    expect(touched).not.toContain('logs');
    expect(await logDocs()).toEqual(seeded);
    expect(await collectionNames()).not.toContain('bans');
  });

  it('admits a request whose `BANS` entry is only in `logs`, leaving it in place', async () => {
    await legacyBanLogs.set(ip, banData);
    const seeded = await logDocs();

    const { req, res, next, touched } = await runCheckBan();

    expect(next).toHaveBeenCalledWith();
    expect(req.banned).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(touched).not.toContain('logs');
    expect(await logDocs()).toEqual(seeded);
  });

  it('admits a request whose `ban` cache entry is only in `logs`, leaving it in place', async () => {
    await legacyBanCache.set(ip, banData);
    const seeded = await logDocs();
    expect(seeded[0].key).toBe(`${ViolationTypes.BAN}:${ip}`);

    const { req, res, next, touched } = await runCheckBan();

    expect(next).toHaveBeenCalledWith();
    expect(req.banned).toBeUndefined();
    expect(res.status).not.toHaveBeenCalled();
    expect(touched).not.toContain('logs');
    expect(await logDocs()).toEqual(seeded);
  });

  it('copies neither namespace into `bans` while both entries sit in `logs`', async () => {
    await legacyBanLogs.set(ip, banData);
    await legacyBanCache.set(ip, banData);
    const seeded = await logDocs();
    expect(seeded).toHaveLength(2);

    const { req, next, touched } = await runCheckBan();

    expect(next).toHaveBeenCalledWith();
    expect(req.banned).toBeUndefined();
    expect(touched).toContain('bans');
    expect(touched).not.toContain('logs');
    expect(await logDocs()).toEqual(seeded);
    expect(await db.collection('bans').countDocuments()).toBe(0);
  });

  it('enforces a ban written after the relocation while the `logs` entries remain', async () => {
    await legacyBanLogs.set(ip, banData);
    await legacyBanCache.set(ip, banData);
    const seeded = await logDocs();

    await getLogStores(ViolationTypes.BAN).set(ip, banData);
    const { req, res, next } = await runCheckBan();

    expect(req.banned).toBe(true);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    expect(await logDocs()).toEqual(seeded);
  });
});
