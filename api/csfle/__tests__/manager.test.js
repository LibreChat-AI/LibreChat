'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const { MongoClient } = require('mongodb');

/**
 * Mock buildAutoEncryptionOptions to return an empty object so the driver
 * uses a plain MongoClient — no real CSFLE setup required.  The manager
 * logic under test is state tracking, idempotency, and failure handling;
 * field-level encryption is tested separately by the integration validation.
 */
jest.mock('../index', () => ({
  buildAutoEncryptionOptions: jest.fn().mockResolvedValue({}),
}));

const {
  runMigrations,
  runStartupMigration,
  MIGRATIONS_COLL,
  STATUS,
  isEncrypted,
} = require('../manager');

const { POLICIES, computeChecksum } = require('../policies');

describe('CSFLE Migration Manager', () => {
  let mongod;
  let uri;
  let client;
  let db;

  beforeAll(async () => {
    mongod = await MongoMemoryServer.create();
    uri = mongod.getUri() + 'LibreChat';
    client = new MongoClient(uri);
    await client.connect();
    db = client.db('LibreChat');
  });

  afterAll(async () => {
    await client.close();
    await mongod.stop();
  });

  afterEach(async () => {
    const colls = await db.listCollections().toArray();
    for (const c of colls) {
      await db.collection(c.name).deleteMany({});
    }
  });

  // ---------------------------------------------------------------------------
  // isEncrypted helper
  // ---------------------------------------------------------------------------
  describe('isEncrypted()', () => {
    it('returns false for plain string', () => {
      expect(isEncrypted('hello@example.com')).toBe(false);
    });

    it('returns false for null/undefined', () => {
      expect(isEncrypted(null)).toBe(false);
      expect(isEncrypted(undefined)).toBe(false);
    });

    it('returns true for Binary subtype 6', () => {
      const { Binary } = require('bson');
      const bin = new Binary(Buffer.from('ciphertext'), 6);
      expect(isEncrypted(bin)).toBe(true);
    });

    it('returns false for Binary subtype != 6', () => {
      const { Binary } = require('bson');
      const bin = new Binary(Buffer.from('data'), 0);
      expect(isEncrypted(bin)).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // computeChecksum
  // ---------------------------------------------------------------------------
  describe('computeChecksum()', () => {
    it('returns a 16-char hex string', () => {
      const cs = computeChecksum(POLICIES[0]);
      expect(cs).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is stable across calls', () => {
      expect(computeChecksum(POLICIES[0])).toBe(computeChecksum(POLICIES[0]));
    });

    it('differs between policies', () => {
      expect(computeChecksum(POLICIES[0])).not.toBe(computeChecksum(POLICIES[1]));
    });
  });

  // ---------------------------------------------------------------------------
  // Applied-once semantics
  // ---------------------------------------------------------------------------
  describe('Applied-once semantics', () => {
    it('marks all target policies as applied after first run', async () => {
      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      const records = await db.collection(MIGRATIONS_COLL).find({}).toArray();
      const v1 = records.find((r) => r.version === 1);
      expect(v1).toBeDefined();
      expect(v1.status).toBe(STATUS.APPLIED);
    });

    it('does not re-apply an already-applied policy on second run', async () => {
      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      await db.collection('users').insertOne({ _sentinel: true, email: 'test@example.com' });

      const replaceOneSpy = jest.spyOn(db.collection('users'), 'replaceOne');

      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      expect(replaceOneSpy).not.toHaveBeenCalled();
      replaceOneSpy.mockRestore();
    });

    it('only applies policies up to targetVersion', async () => {
      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      const records = await db.collection(MIGRATIONS_COLL).find({}).toArray();
      const v2 = records.find((r) => r.version === 2);
      expect(v2).toBeUndefined();
    });

    it('applies all versions when targetVersion is null', async () => {
      await runMigrations({ mongoUri: uri, targetVersion: null });

      const records = await db.collection(MIGRATIONS_COLL).find({}).toArray();
      expect(records.length).toBe(2); // v1 + v2
      for (const record of records) {
        expect(record.status).toBe(STATUS.APPLIED);
      }
    });

    it('resumes from pending state (e.g. after a crash)', async () => {
      await db.collection(MIGRATIONS_COLL).insertOne({
        version: 1,
        status: STATUS.PENDING,
        checksum: computeChecksum(POLICIES[0]),
      });

      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      const record = await db.collection(MIGRATIONS_COLL).findOne({ version: 1 });
      expect(record.status).toBe(STATUS.APPLIED);
    });
  });

  // ---------------------------------------------------------------------------
  // Dry-run
  // ---------------------------------------------------------------------------
  describe('Dry-run', () => {
    it('does not mark policies as applied in dry-run mode', async () => {
      await runMigrations({ mongoUri: uri, targetVersion: 1, dryRun: true });

      const record = await db.collection(MIGRATIONS_COLL).findOne({ version: 1 });
      expect(record?.status).not.toBe(STATUS.APPLIED);
    });
  });

  // ---------------------------------------------------------------------------
  // Startup policy — strict mode
  // ---------------------------------------------------------------------------
  describe('runStartupMigration() — strict mode', () => {
    beforeEach(() => {
      process.env.CSFLE_STARTUP_POLICY = 'strict';
      process.env.MONGO_URI = uri;
    });

    afterEach(() => {
      delete process.env.CSFLE_STARTUP_POLICY;
      delete process.env.MONGO_URI;
      delete process.env.CSFLE_MIGRATION_TARGET_VERSION;
    });

    it('completes without throwing when migrations succeed', async () => {
      await expect(runStartupMigration(uri)).resolves.toBeUndefined();
    });

    it('throws when migration fails in strict mode', async () => {
      const { buildAutoEncryptionOptions } = require('../index');
      buildAutoEncryptionOptions.mockRejectedValueOnce(new Error('KMS unavailable'));

      await expect(runStartupMigration(uri)).rejects.toThrow('KMS unavailable');
    });

    it('respects CSFLE_MIGRATION_TARGET_VERSION', async () => {
      process.env.CSFLE_MIGRATION_TARGET_VERSION = '1';

      await runStartupMigration(uri);

      const records = await db.collection(MIGRATIONS_COLL).find({}).toArray();
      const versions = records.map((r) => r.version);
      expect(versions).toContain(1);
      expect(versions).not.toContain(2);
    });
  });

  // ---------------------------------------------------------------------------
  // Startup policy — warn mode
  // ---------------------------------------------------------------------------
  describe('runStartupMigration() — warn mode', () => {
    beforeEach(() => {
      process.env.CSFLE_STARTUP_POLICY = 'warn';
      process.env.MONGO_URI = uri;
    });

    afterEach(() => {
      delete process.env.CSFLE_STARTUP_POLICY;
      delete process.env.MONGO_URI;
    });

    it('does not throw when migration fails in warn mode', async () => {
      const { buildAutoEncryptionOptions } = require('../index');
      buildAutoEncryptionOptions.mockRejectedValueOnce(new Error('KMS unavailable'));

      await expect(runStartupMigration(uri)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Checksum mismatch warning
  // ---------------------------------------------------------------------------
  describe('Checksum mismatch detection', () => {
    it('logs a warning when a previously-applied policy has a different checksum', async () => {
      await db.collection(MIGRATIONS_COLL).insertOne({
        version: 1,
        status: STATUS.APPLIED,
        checksum: 'deadbeefdeadbeef',
      });

      const { logger } = require('@librechat/data-schemas');
      const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});

      await runMigrations({ mongoUri: uri, targetVersion: 1 });

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('CHECKSUM MISMATCH'),
      );
      warnSpy.mockRestore();
    });
  });
});
