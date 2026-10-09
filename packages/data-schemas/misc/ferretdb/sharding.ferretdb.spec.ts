import mongoose, { Schema, type Connection, type Model } from 'mongoose';
import { getModelSchemas } from './schemas';

/**
 * Sharding PoC — self-contained proof-of-concept that exercises:
 *   1. Multi-pool connection management via mongoose.createConnection()
 *   2. Persistent org→pool assignment table with capacity limits
 *   3. Lazy per-org model registration using every current org-local LibreChat schema
 *   4. Cross-pool data isolation
 *   5. Routing overhead measurement
 *   6. Capacity overflow handling
 *
 * Both "pools" point to the same FerretDB for the PoC.
 * In production each pool URI would be a separate FerretDB+Postgres pair.
 *
 * Run:
 *   FERRETDB_URI="mongodb://ferretdb:ferretdb@127.0.0.1:27020/shard_poc" \
 *     npx jest sharding.ferretdb --testTimeout=120000
 */

const FERRETDB_URI = process.env.FERRETDB_URI;
const describeIfFerretDB = FERRETDB_URI ? describe : describe.skip;

const DB_PREFIX = 'shard_poc_';

// ─── TYPES ──────────────────────────────────────────────────────────────────

interface PoolConfig {
  id: string;
  uri: string;
  maxOrgs: number;
}

interface PoolStats {
  orgCount: number;
  maxOrgs: number;
  available: number;
}

// ─── LIBRECHAT ORG-LOCAL SCHEMAS (derived from the live model registry) ────

const MODEL_SCHEMAS: Record<string, Schema> = getModelSchemas(mongoose);

const MODEL_COUNT = Object.keys(MODEL_SCHEMAS).length;

// ─── TENANT ROUTER (INLINE POC) ────────────────────────────────────────────

const assignmentSchema = new Schema({
  orgId: { type: String, required: true, unique: true, index: true },
  poolId: { type: String, required: true, index: true },
  createdAt: { type: Date, default: Date.now },
});

class TenantRouter {
  private pools: PoolConfig[] = [];
  private poolConns = new Map<string, Connection>();
  private orgConns = new Map<string, Connection>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private orgModels = new Map<string, Record<string, Model<any>>>();
  private assignmentCache = new Map<string, string>();
  private controlConn!: Connection;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private Assignment!: Model<any>;

  async initialize(pools: PoolConfig[], controlUri: string): Promise<void> {
    this.pools = pools;

    this.controlConn = await mongoose.createConnection(controlUri).asPromise();
    this.Assignment = this.controlConn.model('OrgAssignment', assignmentSchema);
    await this.Assignment.createCollection();
    await this.Assignment.createIndexes();

    for (const pool of pools) {
      const conn = await mongoose.createConnection(pool.uri).asPromise();
      this.poolConns.set(pool.id, conn);
    }
  }

  /** Resolve orgId → Mongoose Connection for that org's database */
  async getOrgConnection(orgId: string): Promise<Connection> {
    const cached = this.orgConns.get(orgId);
    if (cached) {
      return cached;
    }

    const poolId = await this.resolvePool(orgId);
    const poolConn = this.poolConns.get(poolId);
    if (!poolConn) {
      throw new Error(`Pool ${poolId} not configured`);
    }

    const orgConn = poolConn.useDb(`${DB_PREFIX}org_${orgId}`, { useCache: true });
    this.orgConns.set(orgId, orgConn);
    return orgConn;
  }

  /** Get every model registered on an org's connection (lazy) */
  async getOrgModels(orgId: string): Promise<Record<string, Model<unknown>>> {
    const cached = this.orgModels.get(orgId);
    if (cached) {
      return cached;
    }

    const conn = await this.getOrgConnection(orgId);
    const models: Record<string, Model<unknown>> = {};
    for (const [name, schema] of Object.entries(MODEL_SCHEMAS)) {
      models[name] = conn.models[name] || conn.model(name, schema);
    }
    this.orgModels.set(orgId, models);
    return models;
  }

  /** Convenience: get a single model for an org */
  async getModel(orgId: string, modelName: string): Promise<Model<unknown>> {
    const models = await this.getOrgModels(orgId);
    const model = models[modelName];
    if (!model) {
      throw new Error(`Unknown model: ${modelName}`);
    }
    return model;
  }

  /** Provision a new org: create all collections + indexes (with deadlock retry) */
  async initializeOrg(orgId: string): Promise<number> {
    const models = await this.getOrgModels(orgId);
    const t0 = Date.now();
    for (const model of Object.values(models)) {
      await model.createCollection();
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await model.createIndexes();
          break;
        } catch (err: unknown) {
          const msg = (err as Error).message || '';
          if (msg.includes('deadlock') && attempt < 2) {
            await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
            continue;
          }
          throw err;
        }
      }
    }
    return Date.now() - t0;
  }

  /** Assign org to a pool with capacity, or return existing assignment */
  async assignOrg(orgId: string): Promise<string> {
    const cached = this.assignmentCache.get(orgId);
    if (cached) {
      return cached;
    }

    const existing = (await this.Assignment.findOne({ orgId }).lean()) as Record<
      string,
      unknown
    > | null;
    if (existing) {
      const poolId = existing.poolId as string;
      this.assignmentCache.set(orgId, poolId);
      return poolId;
    }

    const poolId = await this.selectPoolWithCapacity();

    try {
      await this.Assignment.create({ orgId, poolId });
    } catch (err: unknown) {
      if ((err as Record<string, unknown>).code === 11000) {
        const doc = (await this.Assignment.findOne({ orgId }).lean()) as Record<string, unknown>;
        const existingPoolId = doc.poolId as string;
        this.assignmentCache.set(orgId, existingPoolId);
        return existingPoolId;
      }
      throw err;
    }

    this.assignmentCache.set(orgId, poolId);
    return poolId;
  }

  /** Get per-pool statistics */
  async getPoolStats(): Promise<Record<string, PoolStats>> {
    const stats: Record<string, PoolStats> = {};
    for (const pool of this.pools) {
      const orgCount = await this.Assignment.countDocuments({ poolId: pool.id });
      stats[pool.id] = {
        orgCount,
        maxOrgs: pool.maxOrgs,
        available: pool.maxOrgs - orgCount,
      };
    }
    return stats;
  }

  /** Which pool is an org on? (for test assertions) */
  getAssignment(orgId: string): string | undefined {
    return this.assignmentCache.get(orgId);
  }

  /** Drop all org databases and the control database */
  async destroyAll(): Promise<void> {
    const assignments = (await this.Assignment.find({}).lean()) as Array<Record<string, unknown>>;

    for (const a of assignments) {
      const orgId = a.orgId as string;
      const conn = this.orgConns.get(orgId);
      if (conn) {
        try {
          await conn.dropDatabase();
        } catch {
          /* best-effort */
        }
      }
    }

    try {
      await this.controlConn.dropDatabase();
    } catch {
      /* best-effort */
    }
  }

  async shutdown(): Promise<void> {
    for (const conn of this.poolConns.values()) {
      await conn.close();
    }
    await this.controlConn.close();
  }

  private async resolvePool(orgId: string): Promise<string> {
    return this.assignOrg(orgId);
  }

  private async selectPoolWithCapacity(): Promise<string> {
    for (const pool of this.pools) {
      const count = await this.Assignment.countDocuments({ poolId: pool.id });
      if (count < pool.maxOrgs) {
        return pool.id;
      }
    }
    throw new Error('All pools at capacity. Add a new pool.');
  }
}

// ─── TESTS ──────────────────────────────────────────────────────────────────

describeIfFerretDB('Sharding PoC', () => {
  let router: TenantRouter;

  const POOL_A = 'pool-a';
  const POOL_B = 'pool-b';
  const MAX_PER_POOL = 5;

  beforeAll(async () => {
    router = new TenantRouter();

    await router.initialize(
      [
        { id: POOL_A, uri: FERRETDB_URI as string, maxOrgs: MAX_PER_POOL },
        { id: POOL_B, uri: FERRETDB_URI as string, maxOrgs: MAX_PER_POOL },
      ],
      FERRETDB_URI as string,
    );
  }, 30_000);

  afterAll(async () => {
    await router.destroyAll();
    await router.shutdown();
  }, 120_000);

  describe('pool assignment and capacity', () => {
    it('assigns first 5 orgs to pool A', async () => {
      for (let i = 1; i <= 5; i++) {
        const poolId = await router.assignOrg(`org_${i}`);
        expect(poolId).toBe(POOL_A);
      }

      const stats = await router.getPoolStats();
      expect(stats[POOL_A].orgCount).toBe(5);
      expect(stats[POOL_A].available).toBe(0);
      expect(stats[POOL_B].orgCount).toBe(0);
    });

    it('spills orgs 6-10 to pool B when pool A is full', async () => {
      for (let i = 6; i <= 10; i++) {
        const poolId = await router.assignOrg(`org_${i}`);
        expect(poolId).toBe(POOL_B);
      }

      const stats = await router.getPoolStats();
      expect(stats[POOL_A].orgCount).toBe(5);
      expect(stats[POOL_B].orgCount).toBe(5);
    });

    it('throws when all pools are at capacity', async () => {
      await expect(router.assignOrg('org_overflow')).rejects.toThrow('All pools at capacity');
    });

    it('returns existing assignment on duplicate call (idempotent)', async () => {
      const first = await router.assignOrg('org_1');
      const second = await router.assignOrg('org_1');
      expect(first).toBe(second);
      expect(first).toBe(POOL_A);
    });
  });

  describe('org initialization and model registration', () => {
    it('initializes an org with all collections and indexes', async () => {
      const ms = await router.initializeOrg('org_1');
      console.log(`[Sharding] org_1 init: ${ms}ms (${MODEL_COUNT} collections)`);
      expect(ms).toBeGreaterThan(0);
    }, 60_000);

    it('registers every model lazily on the org connection', async () => {
      const models = await router.getOrgModels('org_1');
      expect(Object.keys(models)).toHaveLength(MODEL_COUNT);

      for (const name of Object.keys(MODEL_SCHEMAS)) {
        expect(models[name]).toBeDefined();
        expect(models[name].modelName).toBe(name);
      }
    });

    it('initializes a second org on pool B', async () => {
      const ms = await router.initializeOrg('org_6');
      console.log(`[Sharding] org_6 init: ${ms}ms (pool B)`);

      expect(router.getAssignment('org_1')).toBe(POOL_A);
      expect(router.getAssignment('org_6')).toBe(POOL_B);
    }, 60_000);
  });

  describe('cross-pool data isolation', () => {
    it('inserts data in org_1 (pool A) — invisible from org_6 (pool B)', async () => {
      const User1 = await router.getModel('org_1', 'User');
      const User6 = await router.getModel('org_6', 'User');

      await User1.create({ name: 'Alice', email: 'alice@org1.test', username: 'alice1' });
      await User6.create({ name: 'Bob', email: 'bob@org6.test', username: 'bob6' });

      const org1Users = await User1.find({}).lean();
      const org6Users = await User6.find({}).lean();

      expect(org1Users).toHaveLength(1);
      expect(org6Users).toHaveLength(1);
      expect((org1Users[0] as Record<string, unknown>).name).toBe('Alice');
      expect((org6Users[0] as Record<string, unknown>).name).toBe('Bob');
    });

    it('runs queries across orgs on different pools concurrently', async () => {
      const Message1 = await router.getModel('org_1', 'Message');
      const Message6 = await router.getModel('org_6', 'Message');

      await Promise.all([
        Message1.create({
          messageId: 'msg_a1',
          conversationId: 'conv_a1',
          user: 'user_org1',
          sender: 'user',
          text: 'hello from org 1',
          isCreatedByUser: true,
        }),
        Message6.create({
          messageId: 'msg_b1',
          conversationId: 'conv_b1',
          user: 'user_org6',
          sender: 'user',
          text: 'hello from org 6',
          isCreatedByUser: true,
        }),
      ]);

      const [m1, m6] = await Promise.all([
        Message1.findOne({ messageId: 'msg_a1' }).lean(),
        Message6.findOne({ messageId: 'msg_b1' }).lean(),
      ]);

      expect((m1 as Record<string, unknown>).text).toBe('hello from org 1');
      expect((m6 as Record<string, unknown>).text).toBe('hello from org 6');
    });
  });

  describe('routing performance', () => {
    it('measures cache-hit vs cold routing latency', async () => {
      const iterations = 100;

      const coldStart = process.hrtime.bigint();
      router['assignmentCache'].delete('org_2');
      router['orgConns'].delete('org_2');
      router['orgModels'].delete('org_2');
      await router.getOrgModels('org_2');
      const coldNs = Number(process.hrtime.bigint() - coldStart) / 1e6;

      const times: number[] = [];
      for (let i = 0; i < iterations; i++) {
        const t0 = process.hrtime.bigint();
        await router.getOrgModels('org_1');
        times.push(Number(process.hrtime.bigint() - t0) / 1e6);
      }
      times.sort((a, b) => a - b);

      const avg = times.reduce((s, v) => s + v, 0) / times.length;
      const p95 = times[Math.floor(times.length * 0.95)];

      console.log(`[Sharding] Routing overhead:`);
      console.log(`  Cold (cache miss + DB lookup + model registration): ${coldNs.toFixed(2)}ms`);
      console.log(
        `  Warm cache hit (${iterations} iters): avg=${avg.toFixed(4)}ms, p95=${p95.toFixed(4)}ms`,
      );

      expect(avg).toBeLessThan(1);
    });
  });

  describe('bulk provisioning simulation', () => {
    it('provisions all 10 assigned orgs with collections + indexes', async () => {
      const orgIds = Array.from({ length: 10 }, (_, i) => `org_${i + 1}`);
      const results: { orgId: string; pool: string; ms: number }[] = [];

      const totalStart = Date.now();
      for (const orgId of orgIds) {
        const pool = router.getAssignment(orgId);
        const ms = await router.initializeOrg(orgId);
        results.push({ orgId, pool: pool ?? '?', ms });
      }
      const totalMs = Date.now() - totalStart;

      console.log(`[Sharding] Bulk provisioned ${orgIds.length} orgs in ${totalMs}ms:`);
      const poolATimes = results.filter((r) => r.pool === POOL_A).map((r) => r.ms);
      const poolBTimes = results.filter((r) => r.pool === POOL_B).map((r) => r.ms);
      const avgA = poolATimes.reduce((s, v) => s + v, 0) / poolATimes.length;
      const avgB = poolBTimes.reduce((s, v) => s + v, 0) / poolBTimes.length;
      console.log(`  Pool A (${poolATimes.length} orgs): avg ${Math.round(avgA)}ms/org`);
      console.log(`  Pool B (${poolBTimes.length} orgs): avg ${Math.round(avgB)}ms/org`);
      console.log(`  Total: ${totalMs}ms (${Math.round(totalMs / orgIds.length)}ms/org)`);

      expect(results.every((r) => r.ms > 0)).toBe(true);
    }, 120_000);
  });

  describe('simulated Express middleware pattern', () => {
    it('demonstrates the request-scoped getModel pattern', async () => {
      const fakeReq = { orgId: 'org_1' } as {
        orgId: string;
        getModel?: (name: string) => Promise<Model<unknown>>;
      };

      fakeReq.getModel = (modelName: string) => router.getModel(fakeReq.orgId, modelName);

      const User = await fakeReq.getModel!('User');
      const user = await User.findOne({ email: 'alice@org1.test' }).lean();
      expect((user as Record<string, unknown>).name).toBe('Alice');

      fakeReq.orgId = 'org_6';
      const User6 = await fakeReq.getModel!('User');
      const user6 = await User6.findOne({ email: 'bob@org6.test' }).lean();
      expect((user6 as Record<string, unknown>).name).toBe('Bob');
    });
  });
});
