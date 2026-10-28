import mongoose from 'mongoose';
import { execSync } from 'child_process';
import { getModelSchemas } from './schemas';

/**
 * FerretDB Multi-Tenancy Benchmark
 *
 * Validates whether FerretDB can handle LibreChat's multi-tenancy model
 * at scale using database-per-org isolation via Mongoose useDb().
 *
 * Phases:
 *   1. useDb schema mapping: verifies per-org PostgreSQL schema creation and data isolation
 *   2. Index initialization: validates every current org-local collection + its
 *      indexes, tests for deadlocks
 *   3. Scaling curve: measures catalog growth, init time, and query latency at 10/50/100 orgs
 *   4. Write amplification: compares update cost on high-index vs zero-index collections
 *   5. Shared-collection alternative: benchmarks orgId-discriminated shared collections
 *
 * Run:
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/mt_bench" \
 *     npx jest multiTenancy.ferretdb --testTimeout=600000
 *
 * Env vars:
 *   FERRETDB_URI     : Required. FerretDB connection string.
 *   PG_CONTAINER     : Docker container name for psql (default: librechat-ferretdb-postgres-1)
 *   SCALE_TIERS      : Comma-separated org counts (default: 10,50,100)
 *   WRITE_AMP_DOCS   : Number of docs for write amp test (default: 200)
 */

const FERRETDB_URI = process.env.FERRETDB_URI;
const describeIfFerretDB = FERRETDB_URI ? describe : describe.skip;

const PG_CONTAINER = process.env.PG_CONTAINER || 'librechat-ferretdb-postgres-1';
const PG_USER = 'ferretdb';
const ORG_PREFIX = 'mt_bench_';

const DEFAULT_TIERS = [10, 50, 100];
const SCALE_TIERS: number[] = process.env.SCALE_TIERS
  ? process.env.SCALE_TIERS.split(',').map(Number)
  : DEFAULT_TIERS;

const WRITE_AMP_DOCS = parseInt(process.env.WRITE_AMP_DOCS || '200', 10);

/** Org-local schema map derived from the live `createModels` registry (see ./schemas) */
const MODEL_SCHEMAS: Record<string, mongoose.Schema> = getModelSchemas(mongoose);

const MODEL_COUNT = Object.keys(MODEL_SCHEMAS).length;

/** Register every model in MODEL_SCHEMAS on a given Mongoose Connection */
function registerModels(conn: mongoose.Connection): Record<string, mongoose.Model<unknown>> {
  const models: Record<string, mongoose.Model<unknown>> = {};
  for (const [name, schema] of Object.entries(MODEL_SCHEMAS)) {
    models[name] = conn.models[name] || conn.model(name, schema);
  }
  return models;
}

/** Initialize one org database: create all collections then build all indexes sequentially */
async function initializeOrgDb(conn: mongoose.Connection): Promise<{
  models: Record<string, mongoose.Model<unknown>>;
  durationMs: number;
}> {
  const models = registerModels(conn);
  const start = Date.now();
  for (const model of Object.values(models)) {
    await model.createCollection();
    await model.createIndexes();
  }
  return { models, durationMs: Date.now() - start };
}

/** Execute a psql command against the FerretDB PostgreSQL backend via docker exec */
function psql(query: string): string {
  try {
    const escaped = query.replace(/"/g, '\\"');
    return execSync(
      `docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d postgres -t -A -c "${escaped}"`,
      { encoding: 'utf-8', timeout: 30_000 },
    ).trim();
  } catch {
    return '';
  }
}

/**
 * Snapshot of DocumentDB catalog + PostgreSQL system catalog sizes.
 * FerretDB with DocumentDB stores all data in a single `documentdb_data` schema.
 * Each MongoDB collection → `documents_<id>` + `retry_<id>` table pair.
 * The catalog lives in `documentdb_api_catalog.collections` and `.collection_indexes`.
 */
function catalogMetrics() {
  return {
    collections: parseInt(psql('SELECT count(*) FROM documentdb_api_catalog.collections'), 10) || 0,
    databases:
      parseInt(
        psql('SELECT count(DISTINCT database_name) FROM documentdb_api_catalog.collections'),
        10,
      ) || 0,
    catalogIndexes:
      parseInt(psql('SELECT count(*) FROM documentdb_api_catalog.collection_indexes'), 10) || 0,
    dataTables:
      parseInt(
        psql(
          "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'documentdb_data'",
        ),
        10,
      ) || 0,
    pgClassTotal: parseInt(psql('SELECT count(*) FROM pg_class'), 10) || 0,
    pgStatRows: parseInt(psql('SELECT count(*) FROM pg_statistic'), 10) || 0,
  };
}

/** Measure point-query latency over N iterations and return percentile stats */
async function measureLatency(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: mongoose.Model<any>,
  filter: Record<string, unknown>,
  iterations = 50,
) {
  await model.findOne(filter).lean();

  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = process.hrtime.bigint();
    await model.findOne(filter).lean();
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }

  times.sort((a, b) => a - b);
  return {
    min: times[0],
    max: times[times.length - 1],
    median: times[Math.floor(times.length / 2)],
    p95: times[Math.floor(times.length * 0.95)],
    avg: times.reduce((s, v) => s + v, 0) / times.length,
  };
}

function fmt(n: number): string {
  return n.toFixed(2);
}

describeIfFerretDB('FerretDB Multi-Tenancy Benchmark', () => {
  const createdDbs: string[] = [];

  beforeAll(async () => {
    await mongoose.connect(FERRETDB_URI as string, { autoIndex: false });
  });

  afterAll(async () => {
    for (const db of createdDbs) {
      try {
        await mongoose.connection.useDb(db, { useCache: false }).dropDatabase();
      } catch {
        /* best-effort cleanup */
      }
    }
    try {
      await mongoose.connection.dropDatabase();
    } catch {
      /* best-effort */
    }
    await mongoose.disconnect();
  }, 600_000);

  // ─── PHASE 1: DATABASE-PER-ORG SCHEMA MAPPING ────────────────────────────

  describe('Phase 1: useDb Schema Mapping', () => {
    const org1Db = `${ORG_PREFIX}iso_1`;
    const org2Db = `${ORG_PREFIX}iso_2`;
    let org1Models: Record<string, mongoose.Model<unknown>>;
    let org2Models: Record<string, mongoose.Model<unknown>>;

    beforeAll(() => {
      createdDbs.push(org1Db, org2Db);
    });

    it('creates separate databases with all collections via useDb()', async () => {
      const c1 = mongoose.connection.useDb(org1Db, { useCache: true });
      const c2 = mongoose.connection.useDb(org2Db, { useCache: true });

      const r1 = await initializeOrgDb(c1);
      const r2 = await initializeOrgDb(c2);
      org1Models = r1.models;
      org2Models = r2.models;

      console.log(`[Phase 1] org1 init: ${r1.durationMs}ms | org2 init: ${r2.durationMs}ms`);

      expect(Object.keys(org1Models)).toHaveLength(MODEL_COUNT);
      expect(Object.keys(org2Models)).toHaveLength(MODEL_COUNT);
    }, 120_000);

    it('maps each useDb database to a separate entry in the DocumentDB catalog', () => {
      const raw = psql(
        `SELECT database_name FROM documentdb_api_catalog.collections WHERE database_name LIKE '${ORG_PREFIX}%' GROUP BY database_name ORDER BY database_name`,
      );
      const dbNames = raw.split('\n').filter(Boolean);
      console.log('[Phase 1] DocumentDB databases:', dbNames);

      expect(dbNames).toContain(org1Db);
      expect(dbNames).toContain(org2Db);

      const perDb = psql(
        `SELECT database_name, count(*) FROM documentdb_api_catalog.collections WHERE database_name LIKE '${ORG_PREFIX}%' GROUP BY database_name ORDER BY database_name`,
      );
      console.log('[Phase 1] Collections per database:\n' + perDb);
    });

    it('isolates data between org databases', async () => {
      await org1Models.User.create({
        name: 'Org1 User',
        email: 'u@org1.test',
        username: 'org1user',
      });
      await org2Models.User.create({
        name: 'Org2 User',
        email: 'u@org2.test',
        username: 'org2user',
      });

      const u1 = await org1Models.User.find({}).lean();
      const u2 = await org2Models.User.find({}).lean();

      expect(u1).toHaveLength(1);
      expect(u2).toHaveLength(1);
      expect((u1[0] as Record<string, unknown>).email).toBe('u@org1.test');
      expect((u2[0] as Record<string, unknown>).email).toBe('u@org2.test');
    }, 30_000);
  });

  // ─── PHASE 2: INDEX INITIALIZATION ────────────────────────────────────────

  describe('Phase 2: Index Initialization', () => {
    const seqDb = `${ORG_PREFIX}idx_seq`;

    beforeAll(() => {
      createdDbs.push(seqDb);
    });

    it('creates all indexes sequentially and reports per-model breakdown', async () => {
      const conn = mongoose.connection.useDb(seqDb, { useCache: true });
      const models = registerModels(conn);

      const stats: { name: string; ms: number; idxCount: number }[] = [];
      for (const [name, model] of Object.entries(models)) {
        const t0 = Date.now();
        await model.createCollection();
        await model.createIndexes();
        const idxs = await model.collection.indexes();
        stats.push({ name, ms: Date.now() - t0, idxCount: idxs.length - 1 });
      }

      const totalMs = stats.reduce((s, r) => s + r.ms, 0);
      const totalIdx = stats.reduce((s, r) => s + r.idxCount, 0);

      console.log(`[Phase 2] Sequential: ${totalMs}ms total, ${totalIdx} custom indexes`);
      console.log('[Phase 2] Slowest 10:');
      for (const s of stats.sort((a, b) => b.ms - a.ms).slice(0, 10)) {
        console.log(`  ${s.name.padEnd(20)} ${String(s.idxCount).padStart(3)} indexes  ${s.ms}ms`);
      }

      expect(totalIdx).toBeGreaterThanOrEqual(90);
    }, 120_000);

    it('tests concurrent index creation for deadlock risk', async () => {
      const concDb = `${ORG_PREFIX}idx_conc`;
      createdDbs.push(concDb);
      const conn = mongoose.connection.useDb(concDb, { useCache: false });
      const models = registerModels(conn);

      for (const model of Object.values(models)) {
        await model.createCollection();
      }

      const t0 = Date.now();
      let failure: Error | undefined;
      try {
        await Promise.all(Object.values(models).map((m) => m.createIndexes()));
        console.log(`[Phase 2] Concurrent: ${Date.now() - t0}ms, no deadlock`);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
        console.warn(
          `[Phase 2] Concurrent: DEADLOCKED after ${Date.now() - t0}ms: ${failure.message}`,
        );
      }
      expect(failure).toBeUndefined();
    }, 120_000);

    it('verifies sparse, partial, and TTL index types on FerretDB', async () => {
      const conn = mongoose.connection.useDb(seqDb, { useCache: true });

      const userIdxs = await conn.model('User').collection.indexes();
      const sparseCount = userIdxs.filter((i: Record<string, unknown>) => i.sparse).length;
      const ttlCount = userIdxs.filter(
        (i: Record<string, unknown>) => i.expireAfterSeconds !== undefined,
      ).length;
      console.log(
        `[Phase 2] User: ${userIdxs.length} total, ${sparseCount} sparse, ${ttlCount} TTL`,
      );
      /**
       * Counts are deliberately not pinned — the point is that FerretDB reports
       * each index *type* back, and the User schema's sparse/TTL declarations
       * change independently of this harness.
       */
      expect(sparseCount).toBeGreaterThanOrEqual(1);
      expect(ttlCount).toBeGreaterThanOrEqual(1);

      const fileIdxs = await conn.model('File').collection.indexes();
      const partialFile = fileIdxs.find(
        (i: Record<string, unknown>) => i.partialFilterExpression != null,
      );
      console.log(`[Phase 2] File partialFilterExpression: ${partialFile ? 'YES' : 'NO'}`);
      expect(partialFile).toBeDefined();

      const groupIdxs = await conn.model('Group').collection.indexes();
      const sparseGroup = groupIdxs.find((i: Record<string, unknown>) => i.sparse);
      const partialGroup = groupIdxs.find(
        (i: Record<string, unknown>) => i.partialFilterExpression != null,
      );
      console.log(
        `[Phase 2] Group: sparse=${sparseGroup ? 'YES' : 'NO'}, partial=${partialGroup ? 'YES' : 'NO'}`,
      );
      expect(sparseGroup).toBeDefined();
      expect(partialGroup).toBeDefined();
    }, 60_000);
  });

  // ─── PHASE 3: SCALING CURVE ───────────────────────────────────────────────

  describe('Phase 3: Scaling Curve', () => {
    interface TierResult {
      tier: number;
      batchMs: number;
      avgPerOrg: number;
      catalog: ReturnType<typeof catalogMetrics>;
      latency: Awaited<ReturnType<typeof measureLatency>>;
    }

    const tierResults: TierResult[] = [];
    let orgsCreated = 0;
    let firstOrgConn: mongoose.Connection | null = null;

    beforeAll(() => {
      const baseline = catalogMetrics();
      console.log(
        `[Phase 3] Baseline, collections: ${baseline.collections}, ` +
          `databases: ${baseline.databases}, catalog indexes: ${baseline.catalogIndexes}, ` +
          `data tables: ${baseline.dataTables}, pg_class: ${baseline.pgClassTotal}`,
      );
    });

    it.each(SCALE_TIERS)(
      'scales to %i orgs',
      async (target) => {
        const t0 = Date.now();

        for (let i = orgsCreated + 1; i <= target; i++) {
          const dbName = `${ORG_PREFIX}s${i}`;
          createdDbs.push(dbName);

          const conn = mongoose.connection.useDb(dbName, { useCache: i === 1 });
          if (i === 1) {
            firstOrgConn = conn;
          }

          const models = registerModels(conn);
          for (const model of Object.values(models)) {
            await model.createCollection();
            await model.createIndexes();
          }

          if (i === 1) {
            await models.User.create({
              name: 'Latency Probe',
              email: 'probe@scale.test',
              username: 'probe',
            });
          }

          if (i % 10 === 0) {
            process.stdout.write(`  ${i}/${target} orgs\n`);
          }
        }

        const batchMs = Date.now() - t0;
        const batchSize = target - orgsCreated;
        orgsCreated = target;

        const lat = await measureLatency(firstOrgConn!.model('User'), {
          email: 'probe@scale.test',
        });
        const cat = catalogMetrics();

        tierResults.push({
          tier: target,
          batchMs,
          avgPerOrg: batchSize > 0 ? Math.round(batchMs / batchSize) : 0,
          catalog: cat,
          latency: lat,
        });

        console.log(`\n[Phase 3] === ${target} orgs ===`);
        console.log(
          `  Init: ${batchMs}ms total (${batchSize > 0 ? Math.round(batchMs / batchSize) : 0}ms/org, batch=${batchSize})`,
        );
        console.log(
          `  Query: avg=${fmt(lat.avg)}ms  median=${fmt(lat.median)}ms  p95=${fmt(lat.p95)}ms`,
        );
        console.log(
          `  Catalog: ${cat.collections} collections, ${cat.catalogIndexes} indexes, ` +
            `${cat.dataTables} data tables, pg_class=${cat.pgClassTotal}`,
        );

        expect(cat.collections).toBeGreaterThan(0);
      },
      600_000,
    );

    afterAll(() => {
      if (tierResults.length === 0) {
        return;
      }

      const hdr = [
        'Orgs',
        'Colls',
        'CatIdx',
        'DataTbls',
        'pg_class',
        'Init/org',
        'Qry avg',
        'Qry p95',
      ];
      const w = [8, 10, 10, 10, 12, 12, 12, 12];

      console.log('\n[Phase 3] SCALING SUMMARY');
      console.log('─'.repeat(w.reduce((a, b) => a + b)));
      console.log(hdr.map((h, i) => h.padEnd(w[i])).join(''));
      console.log('─'.repeat(w.reduce((a, b) => a + b)));

      for (const r of tierResults) {
        const row = [
          String(r.tier),
          String(r.catalog.collections),
          String(r.catalog.catalogIndexes),
          String(r.catalog.dataTables),
          String(r.catalog.pgClassTotal),
          `${r.avgPerOrg}ms`,
          `${fmt(r.latency.avg)}ms`,
          `${fmt(r.latency.p95)}ms`,
        ];
        console.log(row.map((v, i) => v.padEnd(w[i])).join(''));
      }
      console.log('─'.repeat(w.reduce((a, b) => a + b)));
    });
  });

  // ─── PHASE 4: WRITE AMPLIFICATION ────────────────────────────────────────

  describe('Phase 4: Write Amplification', () => {
    it('compares update cost: high-index (User, 11+ idx) vs zero-index collection', async () => {
      const db = `${ORG_PREFIX}wamp`;
      createdDbs.push(db);
      const conn = mongoose.connection.useDb(db, { useCache: false });

      const HighIdx = conn.model('User', MODEL_SCHEMAS['User']);
      await HighIdx.createCollection();
      await HighIdx.createIndexes();

      const bareSchema = new mongoose.Schema({ name: String, email: String, ts: Date });
      const LowIdx = conn.model('BareDoc', bareSchema);
      await LowIdx.createCollection();

      const N = WRITE_AMP_DOCS;

      await HighIdx.insertMany(
        Array.from({ length: N }, (_, i) => ({
          name: `U${i}`,
          email: `u${i}@wamp.test`,
          username: `u${i}`,
        })),
      );
      await LowIdx.insertMany(
        Array.from({ length: N }, (_, i) => ({
          name: `U${i}`,
          email: `u${i}@wamp.test`,
          ts: new Date(),
        })),
      );

      const walBefore = psql('SELECT wal_bytes FROM pg_stat_wal');

      const highStart = Date.now();
      for (let i = 0; i < N; i++) {
        await HighIdx.updateOne({ email: `u${i}@wamp.test` }, { $set: { name: `X${i}` } });
      }
      const highMs = Date.now() - highStart;

      const walMid = psql('SELECT wal_bytes FROM pg_stat_wal');

      const lowStart = Date.now();
      for (let i = 0; i < N; i++) {
        await LowIdx.updateOne({ email: `u${i}@wamp.test` }, { $set: { name: `X${i}` } });
      }
      const lowMs = Date.now() - lowStart;

      const walAfter = psql('SELECT wal_bytes FROM pg_stat_wal');

      console.log(`\n[Phase 4] Write Amplification (${N} updates each)`);
      console.log(`  High-index (User, 11+ idx): ${highMs}ms  (${fmt(highMs / N)}ms/op)`);
      console.log(`  Zero-index (bare):           ${lowMs}ms  (${fmt(lowMs / N)}ms/op)`);
      console.log(`  Time ratio: ${fmt(highMs / Math.max(lowMs, 1))}x`);

      if (walBefore && walMid && walAfter) {
        const wHigh = BigInt(walMid) - BigInt(walBefore);
        const wLow = BigInt(walAfter) - BigInt(walMid);
        console.log(`  WAL: high-idx=${wHigh} bytes, bare=${wLow} bytes`);
        if (wLow > BigInt(0)) {
          console.log(`  WAL ratio: ${fmt(Number(wHigh) / Number(wLow))}x`);
        }
      }

      expect(highMs).toBeGreaterThan(0);
      expect(lowMs).toBeGreaterThan(0);
    }, 300_000);
  });

  // ─── PHASE 5: SHARED-COLLECTION ALTERNATIVE ──────────────────────────────

  describe('Phase 5: Shared Collection Alternative', () => {
    it('benchmarks shared collection with orgId discriminator field', async () => {
      const db = `${ORG_PREFIX}shared`;
      createdDbs.push(db);
      const conn = mongoose.connection.useDb(db, { useCache: false });

      const sharedSchema = new mongoose.Schema({
        orgId: { type: String, required: true, index: true },
        name: String,
        email: String,
        username: String,
        provider: { type: String, default: 'local' },
        role: { type: String, default: 'USER' },
      });
      sharedSchema.index({ orgId: 1, email: 1 }, { unique: true });

      const Shared = conn.model('SharedUser', sharedSchema);
      await Shared.createCollection();
      await Shared.createIndexes();

      const ORG_N = 100;
      const USERS_PER = 50;

      const docs = [];
      for (let o = 0; o < ORG_N; o++) {
        for (let u = 0; u < USERS_PER; u++) {
          docs.push({
            orgId: `org_${o}`,
            name: `User ${u}`,
            email: `u${u}@o${o}.test`,
            username: `u${u}_o${o}`,
          });
        }
      }

      const insertT0 = Date.now();
      await Shared.insertMany(docs, { ordered: false });
      const insertMs = Date.now() - insertT0;

      const totalDocs = ORG_N * USERS_PER;
      console.log(`\n[Phase 5] Shared collection: ${totalDocs} docs inserted in ${insertMs}ms`);

      const pointLat = await measureLatency(Shared, {
        orgId: 'org_50',
        email: 'u25@o50.test',
      });
      console.log(
        `  Point query: avg=${fmt(pointLat.avg)}ms  median=${fmt(pointLat.median)}ms  p95=${fmt(pointLat.p95)}ms`,
      );

      const listT0 = Date.now();
      const orgDocs = await Shared.find({ orgId: 'org_50' }).lean();
      const listMs = Date.now() - listT0;
      console.log(`  List org users (${orgDocs.length} docs): ${listMs}ms`);

      const countT0 = Date.now();
      const count = await Shared.countDocuments({ orgId: 'org_50' });
      const countMs = Date.now() - countT0;
      console.log(`  Count org users: ${count} in ${countMs}ms`);

      const cat = catalogMetrics();
      console.log(
        `  Catalog: ${cat.collections} collections, ${cat.catalogIndexes} indexes, ` +
          `${cat.dataTables} data tables (shared approach = 1 extra db, minimal overhead)`,
      );

      expect(orgDocs).toHaveLength(USERS_PER);
    }, 120_000);
  });
});
