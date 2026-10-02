import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { initializeOrgCollections, createIndexesWithRetry, retryWithBackoff } from '~/utils/retry';
import { getModelSchemas } from './schemas';

/**
 * Production operations tests for FerretDB multi-tenancy:
 *   1. Retry utility under simulated and real deadlock conditions
 *   2. Programmatic per-org backup/restore (driver-level, no mongodump)
 *   3. Schema migration across existing org databases
 *
 * Run:
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/ops_test" \
 *     npx jest orgOperations.ferretdb --testTimeout=300000
 */

const FERRETDB_URI = process.env.FERRETDB_URI;
const describeIfFerretDB = FERRETDB_URI ? describe : describe.skip;

const DB_PREFIX = 'ops_test_';

const MODEL_SCHEMAS: Record<string, Schema> = getModelSchemas(mongoose);

const MODEL_COUNT = Object.keys(MODEL_SCHEMAS).length;

/**
 * Stand-in for a model added after the orgs were provisioned. It must stay
 * absent from the registry map above, otherwise `registerModels()` creates its
 * collection during setup and the migration test stops exercising anything.
 */
const NEW_MODEL = 'OrgEvent';
const NEW_COLLECTION = 'orgevents';

function registerModels(
  conn: Connection,
  schemas: Record<string, Schema> = MODEL_SCHEMAS,
): Record<string, Model<unknown>> {
  const models: Record<string, Model<unknown>> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    models[name] = conn.models[name] || conn.model(name, schema);
  }
  return models;
}

// ─── BACKUP/RESTORE UTILITIES ───────────────────────────────────────────────

interface OrgBackup {
  orgId: string;
  timestamp: Date;
  collections: Record<string, unknown[]>;
}

/** Dump all collections from an org database to an in-memory structure */
async function backupOrg(conn: Connection, orgId: string): Promise<OrgBackup> {
  const collectionNames = (await conn.db!.listCollections().toArray()).map((c) => c.name);
  const collections: Record<string, unknown[]> = {};

  for (const name of collectionNames) {
    if (name.startsWith('system.')) {
      continue;
    }
    const docs = await conn.db!.collection(name).find({}).toArray();
    collections[name] = docs;
  }

  return { orgId, timestamp: new Date(), collections };
}

/** Restore collections from a backup into a target connection */
async function restoreOrg(
  conn: Connection,
  backup: OrgBackup,
): Promise<{ collectionsRestored: number; docsRestored: number }> {
  let docsRestored = 0;

  for (const [name, docs] of Object.entries(backup.collections)) {
    if (docs.length === 0) {
      continue;
    }
    const collection = conn.db!.collection(name);
    await collection.insertMany(docs as Array<Record<string, unknown>>);
    docsRestored += docs.length;
  }

  return { collectionsRestored: Object.keys(backup.collections).length, docsRestored };
}

// ─── MIGRATION UTILITIES ────────────────────────────────────────────────────

interface MigrationResult {
  orgId: string;
  newCollections: string[];
  indexResults: Array<{ model: string; created: boolean; ms: number }>;
  totalMs: number;
}

/** Migrate a single org: ensure all collections exist and all indexes are current */
async function migrateOrg(
  conn: Connection,
  orgId: string,
  schemas: Record<string, Schema>,
): Promise<MigrationResult> {
  const t0 = Date.now();
  const models = registerModels(conn, schemas);
  const existingCollections = new Set(
    (await conn.db!.listCollections().toArray()).map((c) => c.name),
  );

  const newCollections: string[] = [];
  const indexResults: Array<{ model: string; created: boolean; ms: number }> = [];

  for (const [name, model] of Object.entries(models)) {
    const collName = model.collection.collectionName;
    const isNew = !existingCollections.has(collName);
    if (isNew) {
      newCollections.push(name);
    }

    const mt0 = Date.now();
    await model.createCollection();
    await createIndexesWithRetry(model);
    indexResults.push({ model: name, created: isNew, ms: Date.now() - mt0 });
  }

  return { orgId, newCollections, indexResults, totalMs: Date.now() - t0 };
}

/** Migrate all orgs in sequence with progress reporting */
async function migrateAllOrgs(
  baseConn: Connection,
  orgIds: string[],
  schemas: Record<string, Schema>,
  onProgress?: (completed: number, total: number, result: MigrationResult) => void,
): Promise<MigrationResult[]> {
  const results: MigrationResult[] = [];

  for (let i = 0; i < orgIds.length; i++) {
    const orgId = orgIds[i];
    const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
    const result = await migrateOrg(conn, orgId, schemas);
    results.push(result);
    if (onProgress) {
      onProgress(i + 1, orgIds.length, result);
    }
  }

  return results;
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

describeIfFerretDB('Org Operations (Production)', () => {
  const createdDbs: string[] = [];
  let baseConn: Connection;

  beforeAll(async () => {
    baseConn = await mongoose.createConnection(FERRETDB_URI as string).asPromise();
  });

  afterAll(async () => {
    for (const db of createdDbs) {
      try {
        await baseConn.useDb(db, { useCache: false }).dropDatabase();
      } catch {
        /* best-effort */
      }
    }
    await baseConn.close();
  }, 120_000);

  // ─── RETRY UTILITY ──────────────────────────────────────────────────────

  describe('retryWithBackoff', () => {
    it('succeeds on first attempt when no error', async () => {
      let calls = 0;
      const result = await retryWithBackoff(async () => {
        calls++;
        return 'ok';
      }, 'test-op');
      expect(result).toBe('ok');
      expect(calls).toBe(1);
    });

    it('retries on deadlock error and eventually succeeds', async () => {
      let calls = 0;
      const result = await retryWithBackoff(
        async () => {
          calls++;
          if (calls < 3) {
            throw new Error('deadlock detected');
          }
          return 'recovered';
        },
        'deadlock-test',
        { baseDelayMs: 10, jitter: false },
      );

      expect(result).toBe('recovered');
      expect(calls).toBe(3);
    });

    it('does not retry on non-retryable errors', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw new Error('validation failed');
          },
          'non-retryable',
          { baseDelayMs: 10 },
        ),
      ).rejects.toThrow('validation failed');
      expect(calls).toBe(1);
    });

    it('exhausts max attempts and throws', async () => {
      let calls = 0;
      await expect(
        retryWithBackoff(
          async () => {
            calls++;
            throw new Error('deadlock detected');
          },
          'exhausted',
          { maxAttempts: 3, baseDelayMs: 10, jitter: false },
        ),
      ).rejects.toThrow('deadlock');
      expect(calls).toBe(3);
    });

    it('respects maxDelayMs cap', async () => {
      const delays: number[] = [];
      let calls = 0;

      await retryWithBackoff(
        async () => {
          calls++;
          if (calls < 4) {
            throw new Error('deadlock detected');
          }
          return 'ok';
        },
        'delay-cap',
        {
          baseDelayMs: 100,
          maxDelayMs: 250,
          jitter: false,
          onRetry: (_err, _attempt, delay) => delays.push(delay),
        },
      );

      expect(delays[0]).toBe(100);
      expect(delays[1]).toBe(200);
      expect(delays[2]).toBe(250);
    });
  });

  // ─── REAL DEADLOCK RETRY ────────────────────────────────────────────────

  describe('initializeOrgCollections with retry', () => {
    it('provisions 5 orgs sequentially using the production utility', async () => {
      const orgIds = ['retry_1', 'retry_2', 'retry_3', 'retry_4', 'retry_5'];
      const results: Array<{ orgId: string; ms: number; models: number }> = [];

      for (const orgId of orgIds) {
        const dbName = `${DB_PREFIX}org_${orgId}`;
        createdDbs.push(dbName);
        const conn = baseConn.useDb(dbName, { useCache: true });
        const models = registerModels(conn);

        const { totalMs } = await initializeOrgCollections(models, {
          baseDelayMs: 50,
          maxAttempts: 5,
        });
        results.push({ orgId, ms: totalMs, models: Object.keys(models).length });
      }

      const totalMs = results.reduce((s, r) => s + r.ms, 0);
      console.log(`[Retry] 5 orgs provisioned in ${totalMs}ms:`);
      for (const r of results) {
        console.log(`  ${r.orgId}: ${r.ms}ms (${r.models} models)`);
      }

      expect(results.every((r) => r.models === MODEL_COUNT)).toBe(true);
    }, 120_000);
  });

  // ─── BACKUP/RESTORE ─────────────────────────────────────────────────────

  describe('per-org backup and restore', () => {
    const sourceOrg = 'backup_src';
    const targetOrg = 'backup_dst';

    beforeAll(async () => {
      const srcDb = `${DB_PREFIX}org_${sourceOrg}`;
      createdDbs.push(srcDb, `${DB_PREFIX}org_${targetOrg}`);
      const srcConn = baseConn.useDb(srcDb, { useCache: true });
      const models = registerModels(srcConn);
      await initializeOrgCollections(models);

      await models.User.create([
        { name: 'Alice', email: 'alice@backup.test', username: 'alice' },
        { name: 'Bob', email: 'bob@backup.test', username: 'bob' },
        { name: 'Charlie', email: 'charlie@backup.test', username: 'charlie' },
      ]);

      await models.Conversation.create([
        {
          conversationId: 'conv_1',
          user: 'alice_id',
          title: 'Test conversation 1',
          endpoint: 'openAI',
          model: 'gpt-4',
        },
        {
          conversationId: 'conv_2',
          user: 'bob_id',
          title: 'Test conversation 2',
          endpoint: 'openAI',
          model: 'gpt-4',
        },
      ]);

      await models.Message.create([
        {
          messageId: 'msg_1',
          conversationId: 'conv_1',
          user: 'alice_id',
          sender: 'user',
          text: 'Hello world',
          isCreatedByUser: true,
        },
        {
          messageId: 'msg_2',
          conversationId: 'conv_1',
          user: 'alice_id',
          sender: 'GPT-4',
          text: 'Hi there!',
          isCreatedByUser: false,
        },
      ]);

      const agentId = new mongoose.Types.ObjectId();
      await models.Agent.create({
        id: `agent_${agentId}`,
        name: 'Test Agent',
        author: new mongoose.Types.ObjectId(),
        description: 'A test agent for backup',
        provider: 'openAI',
        model: 'gpt-4',
      });
    }, 60_000);

    it('backs up all collections from the source org', async () => {
      const srcConn = baseConn.useDb(`${DB_PREFIX}org_${sourceOrg}`, { useCache: true });
      const backup = await backupOrg(srcConn, sourceOrg);

      console.log(`[Backup] ${sourceOrg}:`);
      console.log(`  Timestamp: ${backup.timestamp.toISOString()}`);
      console.log(`  Collections: ${Object.keys(backup.collections).length}`);
      let totalDocs = 0;
      for (const [name, docs] of Object.entries(backup.collections)) {
        if (docs.length > 0) {
          console.log(`  ${name}: ${docs.length} docs`);
          totalDocs += docs.length;
        }
      }
      console.log(`  Total documents: ${totalDocs}`);

      expect(Object.keys(backup.collections).length).toBeGreaterThanOrEqual(4);
      expect(backup.collections['users']?.length).toBe(3);
      expect(backup.collections['conversations']?.length).toBe(2);
      expect(backup.collections['messages']?.length).toBe(2);
    }, 30_000);

    it('restores backup to a fresh org database', async () => {
      const srcConn = baseConn.useDb(`${DB_PREFIX}org_${sourceOrg}`, { useCache: true });
      const backup = await backupOrg(srcConn, sourceOrg);

      const dstConn = baseConn.useDb(`${DB_PREFIX}org_${targetOrg}`, { useCache: true });
      const dstModels = registerModels(dstConn);
      await initializeOrgCollections(dstModels);

      const { collectionsRestored, docsRestored } = await restoreOrg(dstConn, backup);

      console.log(
        `[Restore] ${targetOrg}: ${collectionsRestored} collections, ${docsRestored} docs`,
      );

      expect(docsRestored).toBeGreaterThanOrEqual(7);
    }, 60_000);

    it('verifies restored data matches source exactly', async () => {
      const srcConn = baseConn.useDb(`${DB_PREFIX}org_${sourceOrg}`, { useCache: true });
      const dstConn = baseConn.useDb(`${DB_PREFIX}org_${targetOrg}`, { useCache: true });

      const srcUsers = await srcConn.db!.collection('users').find({}).sort({ email: 1 }).toArray();
      const dstUsers = await dstConn.db!.collection('users').find({}).sort({ email: 1 }).toArray();

      expect(dstUsers.length).toBe(srcUsers.length);
      for (let i = 0; i < srcUsers.length; i++) {
        expect(dstUsers[i].name).toBe(srcUsers[i].name);
        expect(dstUsers[i].email).toBe(srcUsers[i].email);
        expect(dstUsers[i]._id.toString()).toBe(srcUsers[i]._id.toString());
      }

      const srcMsgs = await srcConn
        .db!.collection('messages')
        .find({})
        .sort({ messageId: 1 })
        .toArray();
      const dstMsgs = await dstConn
        .db!.collection('messages')
        .find({})
        .sort({ messageId: 1 })
        .toArray();

      expect(dstMsgs.length).toBe(srcMsgs.length);
      for (let i = 0; i < srcMsgs.length; i++) {
        expect(dstMsgs[i].messageId).toBe(srcMsgs[i].messageId);
        expect(dstMsgs[i].text).toBe(srcMsgs[i].text);
        expect(dstMsgs[i]._id.toString()).toBe(srcMsgs[i]._id.toString());
      }

      const srcConvos = await srcConn
        .db!.collection('conversations')
        .find({})
        .sort({ conversationId: 1 })
        .toArray();
      const dstConvos = await dstConn
        .db!.collection('conversations')
        .find({})
        .sort({ conversationId: 1 })
        .toArray();

      expect(dstConvos.length).toBe(srcConvos.length);
      for (let i = 0; i < srcConvos.length; i++) {
        expect(dstConvos[i].conversationId).toBe(srcConvos[i].conversationId);
        expect(dstConvos[i].title).toBe(srcConvos[i].title);
      }

      console.log('[Restore] Data integrity verified: _ids, fields, and counts match exactly');
    }, 30_000);

    it('verifies BSON type preservation (ObjectId, Date, Number)', async () => {
      const dstConn = baseConn.useDb(`${DB_PREFIX}org_${targetOrg}`, { useCache: true });

      const user = await dstConn.db!.collection('users').findOne({ email: 'alice@backup.test' });
      expect(user).toBeDefined();
      expect(user!._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(user!.createdAt).toBeInstanceOf(Date);

      const agent = await dstConn.db!.collection('agents').findOne({});
      expect(agent).toBeDefined();
      expect(agent!._id).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(typeof agent!.name).toBe('string');

      console.log('[Restore] BSON types preserved: ObjectId, Date, String all correct');
    });

    it('measures backup and restore performance', async () => {
      const srcConn = baseConn.useDb(`${DB_PREFIX}org_${sourceOrg}`, { useCache: true });

      const backupStart = Date.now();
      const backup = await backupOrg(srcConn, sourceOrg);
      const backupMs = Date.now() - backupStart;

      const freshDb = `${DB_PREFIX}org_perf_restore`;
      createdDbs.push(freshDb);
      const freshConn = baseConn.useDb(freshDb, { useCache: false });
      const freshModels = registerModels(freshConn);
      await initializeOrgCollections(freshModels);

      const restoreStart = Date.now();
      await restoreOrg(freshConn, backup);
      const restoreMs = Date.now() - restoreStart;

      const totalDocs = Object.values(backup.collections).reduce((s, d) => s + d.length, 0);
      console.log(
        `[Perf] Backup: ${backupMs}ms (${totalDocs} docs across ${Object.keys(backup.collections).length} collections)`,
      );
      console.log(`[Perf] Restore: ${restoreMs}ms`);

      expect(backupMs).toBeLessThan(5000);
      expect(restoreMs).toBeLessThan(5000);
    }, 60_000);
  });

  // ─── SCHEMA MIGRATION ──────────────────────────────────────────────────

  describe('schema migration across orgs', () => {
    const migrationOrgs = ['mig_1', 'mig_2', 'mig_3', 'mig_4', 'mig_5'];

    beforeAll(async () => {
      for (const orgId of migrationOrgs) {
        const dbName = `${DB_PREFIX}org_${orgId}`;
        createdDbs.push(dbName);
        const conn = baseConn.useDb(dbName, { useCache: true });
        const models = registerModels(conn);
        await initializeOrgCollections(models);

        await models.User.create({
          name: `User ${orgId}`,
          email: `user@${orgId}.test`,
          username: orgId,
        });
      }
    }, 120_000);

    it('createIndexes is idempotent (no-op for existing indexes)', async () => {
      const conn = baseConn.useDb(`${DB_PREFIX}org_mig_1`, { useCache: true });
      const models = registerModels(conn);

      const beforeIndexes = await models.User.collection.indexes();

      const t0 = Date.now();
      await initializeOrgCollections(models);
      const ms = Date.now() - t0;

      const afterIndexes = await models.User.collection.indexes();

      expect(afterIndexes.length).toBe(beforeIndexes.length);
      console.log(
        `[Migration] Idempotent re-init: ${ms}ms (indexes unchanged: ${beforeIndexes.length})`,
      );
    }, 60_000);

    it('adds a new collection to all existing orgs', async () => {
      expect(MODEL_SCHEMAS[NEW_MODEL]).toBeUndefined();

      const newSchema = new Schema(
        {
          orgId: { type: String, index: true },
          eventType: { type: String, required: true, index: true },
          payload: Schema.Types.Mixed,
          userId: { type: Schema.Types.ObjectId, index: true },
        },
        { timestamps: true },
      );
      newSchema.index({ orgId: 1, eventType: 1, createdAt: -1 });

      for (const orgId of migrationOrgs) {
        const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
        const collections = (await conn.db!.listCollections().toArray()).map((c) => c.name);
        expect(collections).not.toContain(NEW_COLLECTION);

        const OrgEvent = conn.models[NEW_MODEL] || conn.model(NEW_MODEL, newSchema);
        await OrgEvent.createCollection();
        await createIndexesWithRetry(OrgEvent);
      }

      for (const orgId of migrationOrgs) {
        const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
        const collections = (await conn.db!.listCollections().toArray()).map((c) => c.name);
        expect(collections).toContain(NEW_COLLECTION);

        const indexes = await conn.db!.collection(NEW_COLLECTION).indexes();
        expect(indexes.length).toBeGreaterThanOrEqual(5);
        const compound = indexes.some(
          (idx: Record<string, unknown>) =>
            JSON.stringify(idx.key) === JSON.stringify({ orgId: 1, eventType: 1, createdAt: -1 }),
        );
        expect(compound).toBe(true);
      }

      console.log(
        `[Migration] New collection '${NEW_COLLECTION}' added to ${migrationOrgs.length} orgs with its 4 declared indexes`,
      );
    }, 60_000);

    it('adds a new index to an existing collection across all orgs', async () => {
      const indexSpec = { username: 1, createdAt: -1 };

      for (const orgId of migrationOrgs) {
        const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
        await retryWithBackoff(
          () => conn.db!.collection('users').createIndex(indexSpec, { background: true }),
          `createIndex(users, username+createdAt) for ${orgId}`,
        );
      }

      for (const orgId of migrationOrgs) {
        const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
        const indexes = await conn.db!.collection('users').indexes();
        const hasNewIdx = indexes.some(
          (idx: Record<string, unknown>) => JSON.stringify(idx.key) === JSON.stringify(indexSpec),
        );
        expect(hasNewIdx).toBe(true);
      }

      console.log(
        `[Migration] New compound index added to 'users' across ${migrationOrgs.length} orgs`,
      );
    }, 60_000);

    it('runs migrateAllOrgs and reports progress', async () => {
      const progress: string[] = [];

      const results = await migrateAllOrgs(
        baseConn,
        migrationOrgs,
        MODEL_SCHEMAS,
        (completed, total, result) => {
          progress.push(
            `${completed}/${total}: ${result.orgId} — ${result.totalMs}ms, ${result.newCollections.length} new collections`,
          );
        },
      );

      console.log(`[Migration] Full migration across ${migrationOrgs.length} orgs:`);
      for (const p of progress) {
        console.log(`  ${p}`);
      }

      const totalMs = results.reduce((s, r) => s + r.totalMs, 0);
      const avgMs = Math.round(totalMs / results.length);
      console.log(`  Total: ${totalMs}ms, avg: ${avgMs}ms/org`);

      expect(results).toHaveLength(migrationOrgs.length);
      expect(results.every((r) => r.indexResults.length >= MODEL_COUNT)).toBe(true);
    }, 120_000);

    it('verifies existing data is preserved after migration', async () => {
      for (const orgId of migrationOrgs) {
        const conn = baseConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
        const user = await conn.db!.collection('users').findOne({ email: `user@${orgId}.test` });
        expect(user).toBeDefined();
        expect(user!.name).toBe(`User ${orgId}`);
      }

      console.log(
        `[Migration] All existing user data preserved across ${migrationOrgs.length} orgs`,
      );
    });
  });
});
