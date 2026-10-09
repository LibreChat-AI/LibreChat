import mongoose from 'mongoose';
import { randomUUID } from 'crypto';
import {
  Permissions,
  PermissionBits,
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionTypes,
} from 'librechat-data-provider';
import type { ConnectOptions, Model } from 'mongoose';
import type { IConversationTag } from '~/schema/conversationTag';
import type * as t from '~/types';
import {
  createMCPAuthorityMethods,
  createMCPAuthorityBootRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
} from '~/methods/mcpAuthority';
import { decrementTagCounts } from '~/methods/conversationTag';
import { tenantStorage } from '~/config/tenantContext';
import { supportsTransactions } from '~/utils/transactions';
import { createScheduleMethods } from '~/methods/schedule';
import { createUserMethods } from '~/methods/user';
import { createFileMethods } from '~/methods/file';
import { createModels } from '~/models';

/**
 * Amazon DocumentDB live-compatibility suite.
 *
 * Exercises the operations that have historically broken on DocumentDB
 * (aggregation-pipeline updates — issue #14488) against a REAL cluster, plus
 * informational capability probes whose results print as a matrix at the end.
 * There is no faithful local emulator of Amazon DocumentDB (the open-source
 * "DocumentDB Local" image is an unrelated PostgreSQL-based engine), so this
 * suite only runs when DOCUMENTDB_URI is set and skips otherwise.
 *
 * Run (from packages/data-schemas, against a DEDICATED database):
 *   DOCUMENTDB_URI="mongodb://user:pass@127.0.0.1:27017/librechat_compat\
 *     ?tls=true&retryWrites=false&authSource=admin&authMechanism=SCRAM-SHA-1&directConnection=true" \
 *   DOCUMENTDB_TLS_CA_FILE="global-bundle.pem" \
 *     npx jest --config misc/documentdb/jest.documentdb.config.mjs
 *
 * `authSource`/`authMechanism`/`directConnection` are load-bearing against a
 * real cluster (see audit.documentdb.spec.ts for why each is required).
 *
 * Through an SSH tunnel, additionally set
 *   DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES=true
 * because the tunnel endpoint will not match the cluster certificate.
 *
 * Set DOCUMENTDB_EXPECT_PARTIAL_INDEXES=true when targeting DocumentDB 5.0+
 * instance-based clusters to turn the partial-index probe into a hard assertion.
 */
const DOCUMENTDB_URI = process.env.DOCUMENTDB_URI ?? '';
const describeLive = DOCUMENTDB_URI ? describe : describe.skip;

const HOUR = 3_600_000;
const runId = randomUUID().slice(0, 8);
const capabilities: Record<string, string> = {};

function getDb() {
  const db = mongoose.connection.db;
  if (!db) {
    throw new Error('MongoDB database handle not available');
  }
  return db;
}

describeLive('Amazon DocumentDB live compatibility', () => {
  let User: Model<t.IUser>;
  let ConversationTag: Model<IConversationTag>;
  let userMethods: ReturnType<typeof createUserMethods>;
  let fileMethods: ReturnType<typeof createFileMethods>;

  const testEmail = (label: string) => `${label}-${runId}@compat.test`;

  beforeAll(async () => {
    const options: ConnectOptions = { autoIndex: false, autoCreate: false };
    if (process.env.DOCUMENTDB_TLS_CA_FILE) {
      options.tlsCAFile = process.env.DOCUMENTDB_TLS_CA_FILE;
    }
    if (process.env.DOCUMENTDB_TLS_ALLOW_INVALID_HOSTNAMES === 'true') {
      options.tlsAllowInvalidHostnames = true;
    }
    await mongoose.connect(DOCUMENTDB_URI, options);

    const models = createModels(mongoose);
    Object.assign(mongoose.models, models);
    User = mongoose.models.User;
    ConversationTag = mongoose.models.ConversationTag;
    userMethods = createUserMethods(mongoose);
    fileMethods = createFileMethods(mongoose);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState === 1) {
      await User.deleteMany({ email: { $regex: runId } });
      await ConversationTag.deleteMany({ tag: { $regex: runId } });
      await mongoose.models.File.deleteMany({ filename: { $regex: runId } });

      const rows = Object.entries(capabilities).map(
        ([capability, verdict]) => `  ${capability.padEnd(36)} ${verdict}`,
      );
      console.log(`\nDocumentDB capability matrix (run ${runId}):\n${rows.join('\n')}\n`);
      await mongoose.disconnect();
    }
  });

  describe('pipeline-form updates (bug class behind #14488)', () => {
    it('records whether the engine accepts pipeline updates and $$NOW', async () => {
      const probe = getDb().collection(`pipeline_probe_${runId}`);
      await probe.insertOne({ probe: 1 });

      capabilities['pipeline-form updateOne'] = await probe
        .updateOne({ probe: 1 }, [{ $set: { probed: true } }])
        .then(() => 'supported')
        .catch((error: Error) => `rejected (${error.message})`);
      capabilities['$$NOW system variable'] = await probe
        .updateOne({ probe: 1 }, [{ $set: { probedAt: '$$NOW' } }])
        .then(() => 'supported')
        .catch((error: Error) => `rejected (${error.message})`);

      await probe.drop().catch(() => undefined);
      expect(capabilities['pipeline-form updateOne']).toBeDefined();
    });

    it('acceptTerms stamps once and preserves the first timestamp', async () => {
      const user = await User.create({
        name: 'DocDB Terms',
        email: testEmail('terms'),
        provider: 'local',
      });
      const userId = String(user._id);

      const first = await userMethods.acceptTerms(userId);
      expect(first?.termsAccepted).toBe(true);
      expect(first?.termsAcceptedAt).toBeInstanceOf(Date);

      const repeat = await userMethods.acceptTerms(userId);
      expect((repeat?.termsAcceptedAt as Date).getTime()).toBe(
        (first?.termsAcceptedAt as Date).getTime(),
      );
    });

    it('acceptTerms converges under concurrent requests', async () => {
      const user = await User.create({
        name: 'DocDB Concurrent',
        email: testEmail('concurrent'),
        provider: 'local',
      });
      const userId = String(user._id);

      const results = await Promise.all(
        Array.from({ length: 5 }, () => userMethods.acceptTerms(userId)),
      );

      expect(results.every((result) => result?.termsAccepted === true)).toBe(true);
      const stamped = new Set(results.map((result) => (result?.termsAcceptedAt as Date).getTime()));
      expect(stamped.size).toBe(1);
    });

    it('decrementTagCounts clamps at zero', async () => {
      const user = `docdb-user-${runId}`;
      const tag = `tag-${runId}`;
      await ConversationTag.create({ user, tag, position: 1, count: 1 });

      await decrementTagCounts(mongoose, user, [tag, tag, tag]);

      const stored = await ConversationTag.findOne({ user, tag }).lean();
      expect(stored?.count).toBe(0);
    });

    it('extendFilesTTL widens toward the window and clamps to the ceiling', async () => {
      const userId = new mongoose.Types.ObjectId();
      const fileId = randomUUID();
      await fileMethods.createFile({
        file_id: fileId,
        user: userId,
        filename: `${fileId}-${runId}.txt`,
        filepath: `/uploads/${fileId}.txt`,
        type: 'text/plain',
        bytes: 1,
      });
      await mongoose.models.File.updateOne(
        { file_id: fileId },
        { $set: { expiresAt: new Date(Date.now() + 60_000) } },
        { timestamps: false },
      );

      const hold = { renewMs: 24 * HOUR, maxLifetimeMs: 48 * HOUR };
      const widened = await fileMethods.extendFilesTTL([fileId], hold, { user: String(userId) });
      expect(widened).toBe(1);

      const stored = await mongoose.models.File.findOne({ file_id: fileId }).lean<{
        createdAt: Date;
        expiresAt?: Date;
      }>();
      expect(stored?.expiresAt).toBeDefined();
      expect(stored!.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 23 * HOUR);
      expect(stored!.expiresAt!.getTime()).toBeLessThanOrEqual(
        stored!.createdAt.getTime() + hold.maxLifetimeMs,
      );
    });
  });

  describe('capability probes (informational)', () => {
    it('probes multi-document transaction support', async () => {
      const supported = await supportsTransactions(mongoose);
      capabilities['multi-document transactions'] = supported
        ? 'supported'
        : 'unsupported (runtime fallback engages)';
      expect(typeof supported).toBe('boolean');
    });

    it('executes the bounded MCP authority snapshot transaction', async () => {
      const tenantId = `authority-tenant-${runId}`;
      const roleName = `AUTHORITY_${runId}`;
      const serverName = `authority-server-${runId}`;
      const models = mongoose.models;
      const methods = createMCPAuthorityMethods(mongoose);
      const boot = createMCPAuthorityBootRevision(`docdb-${runId}`, { mcpServers: {} });
      const userId = new mongoose.Types.ObjectId();
      const serverId = new mongoose.Types.ObjectId();
      const agentIds = Array.from({ length: 3 }, () => new mongoose.Types.ObjectId());
      try {
        await tenantStorage.run({ tenantId, userId: userId.toHexString() }, async () => {
          await models.User.create({
            _id: userId,
            name: 'DocumentDB authority probe',
            email: testEmail('authority'),
            provider: 'local',
            role: roleName,
          });
          await models.Role.create({
            name: roleName,
            permissions: {
              [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
            },
          });
          await models.Config.create({
            principalType: PrincipalType.USER,
            principalId: userId.toHexString(),
            principalModel: PrincipalModel.USER,
            priority: 30,
            overrides: { mcpSettings: { allowedDomains: ['example.com'] } },
            tombstones: ['mcpSettings.autoStart'],
            isActive: true,
            configVersion: 1,
          });
          await models.MCPServer.create({
            _id: serverId,
            serverName,
            config: { type: 'sse', url: `https://${serverName}.example/mcp` },
            author: userId,
          });
          await models.Agent.insertMany(
            agentIds.map((agentId, index) => ({
              _id: agentId,
              id: `authority-agent-${runId}-${index}`,
              name: `DocumentDB authority probe agent ${index}`,
              provider: 'openAI',
              model: 'probe-model',
              author: userId,
              mcpServerNames: [serverName, `unselected-${runId}`],
            })),
          );
          await models.AclEntry.create({
            principalType: PrincipalType.USER,
            principalId: userId,
            principalModel: PrincipalModel.USER,
            resourceType: ResourceType.MCPSERVER,
            resourceId: serverId,
            permBits: PermissionBits.VIEW,
            grantedBy: userId,
          });
          /** The proof transaction READS PluginAuth and Token. On a database
           * where they do not exist yet, DocumentDB rejects the in-transaction
           * read of a non-existent collection and `asMCPError` reports it as
           * `proof_unavailable` — which is why this test failed on every live
           * cluster run while passing against MongoDB. Materialize both
           * before the transaction. */
          await models.PluginAuth.createCollection();
          await models.Token.createCollection();
          await models.Group.createCollection();
          const server = await models.MCPServer.findById(serverId).lean();
          if (!server) {
            throw new Error('DocumentDB authority probe server was not created');
          }
          const sourceRevision = createMCPAuthorityDatabaseSourceRevision({
            databaseId: server._id.toHexString(),
            serverName: server.serverName,
            author: server.author.toString(),
            config: server.config,
            createdAt: server.createdAt,
            updatedAt: server.updatedAt,
          });
          const proof = await methods.resolveMCPAuthorityProof({
            userId: userId.toHexString(),
            tenantId,
            boot,
            targets: [
              {
                serverName,
                source: 'database',
                databaseId: serverId.toHexString(),
                sourceRevision,
                expectedCredentialRevision: createMCPAuthorityCredentialRevision([], []),
                expectedOAuthGrantGeneration: null,
                resolvedConfig: server.config,
              },
            ],
          });
          expect(proof.servers[0].linkedAgentIds).toHaveLength(agentIds.length);
          await methods.assertMCPAuthorityProofsCurrent({ proofs: proof, boot });
        });
        capabilities['MCP authority snapshot'] = 'supported';
      } finally {
        await Promise.all([
          getDb().collection('aclentries').deleteMany({ resourceId: serverId }),
          getDb().collection('mcpservers').deleteMany({ _id: serverId }),
          getDb().collection('configs').deleteMany({ principalId: userId.toHexString() }),
          getDb()
            .collection('agents')
            .deleteMany({ _id: { $in: agentIds } }),
          getDb().collection('roles').deleteMany({ name: roleName }),
          getDb().collection('users').deleteMany({ _id: userId }),
        ]);
      }
    });

    it('probes partial unique index support (OAuth id uniqueness relies on it)', async () => {
      const probe = getDb().collection(`partial_index_probe_${runId}`);
      await probe.insertOne({ seeded: true });

      const outcome = await probe
        .createIndex(
          { googleId: 1, tenantId: 1 },
          { unique: true, partialFilterExpression: { googleId: { $exists: true } } },
        )
        .then(() => 'supported')
        .catch((error: Error) => `REJECTED (${error.message})`);
      capabilities['partial unique indexes'] = outcome;

      await probe.drop().catch(() => undefined);
      if (process.env.DOCUMENTDB_EXPECT_PARTIAL_INDEXES === 'true') {
        expect(outcome).toBe('supported');
      }
    });

    it('verifies TTL index support (session/token expiry relies on it)', async () => {
      const probe = getDb().collection(`ttl_probe_${runId}`);
      await probe.insertOne({ createdAt: new Date() });

      await expect(
        probe.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 }),
      ).resolves.toBeDefined();
      capabilities['TTL indexes'] = 'supported';

      await probe.drop().catch(() => undefined);
    });

    it('flags a connection string missing retryWrites=false', () => {
      const disabled = /retryWrites=false/i.test(DOCUMENTDB_URI);
      capabilities['retryWrites=false in URI'] = disabled
        ? 'present'
        : 'MISSING — DocumentDB rejects retryable writes';
      expect(typeof disabled).toBe('boolean');
    });
  });

  /**
   * The scheduler's rewritten write shapes (classic operators, worker clock — the
   * DocumentDB-portable replacements for its original pipeline/$$NOW CAS forms),
   * exercised through the real methods against the live engine.
   */
  describe('scheduler write shapes', () => {
    const scheduleMethods = () => createScheduleMethods(mongoose);
    const scheduleData = (overrides: Record<string, unknown> = {}) => ({
      id: `sched_compat_${runId}_${randomUUID().slice(0, 8)}`,
      user: new mongoose.Types.ObjectId(),
      name: `compat ${runId}`,
      prompt: 'compat probe',
      agent_id: 'agent_compat',
      cadence: { frequency: 'daily', hour: 8, minute: 0 },
      timezone: 'America/New_York',
      target: 'new',
      enabled: true,
      nextRunAt: new Date(Date.now() - 60_000),
      ...overrides,
    });

    afterAll(async () => {
      await mongoose.models.Schedule.deleteMany({ name: `compat ${runId}` });
      await mongoose.models.ScheduleRun.deleteMany({ scheduleId: { $regex: runId } });
    });

    it('claims a due schedule via the classic-operator lease CAS', async () => {
      const methods = scheduleMethods();
      const schedule = await methods.createSchedule(scheduleData() as never);
      const claimed = await methods.claimDueSchedule({
        instanceId: `compat-${runId}`,
        leaseMs: 60_000,
      });
      expect(claimed?.leaseUntil).toBeInstanceOf(Date);
      // Held lease: a second claim must not steal it.
      const contender = await methods.claimDueSchedule({
        instanceId: `compat2-${runId}`,
        leaseMs: 60_000,
      });
      expect(contender?.id).not.toBe(schedule.id);
      capabilities['scheduler lease CAS'] = 'supported';
    });

    it('stamps and resolves an abort request with guarded classic updates', async () => {
      const methods = scheduleMethods();
      const schedule = await methods.createSchedule(scheduleData() as never);
      const scheduledFor = new Date('2026-07-20T12:00:00Z');
      await mongoose.models.ScheduleRun.create({
        scheduleId: schedule.id,
        user: schedule.user,
        scheduledFor,
        status: 'started',
        firedAt: new Date(),
      });
      expect(await methods.requestRunAbort(schedule.id, scheduledFor, 'stop')).toBe(true);
      await methods.markRunAbortPersisted(schedule.id, scheduledFor);
      const state = await methods.getScheduleRunAbortState(schedule.id, scheduledFor);
      expect(state?.abortSource).toBe('stop');
      expect(state?.abortPersistedAt).toBeInstanceOf(Date);
      capabilities['scheduler abort stamps'] = 'supported';
    });

    it('arms only an unarmed row through the shared arming CAS', async () => {
      const methods = scheduleMethods();
      const schedule = await methods.createSchedule(
        scheduleData({ nextRunAt: undefined }) as never,
      );
      const armAt = new Date(Date.now() + HOUR);
      expect(await methods.armSchedule(schedule.id, armAt, 0)).toBe(true);
      expect(await methods.armSchedule(schedule.id, new Date(Date.now() + 2 * HOUR), 0)).toBe(
        false,
      );
      capabilities['scheduler arming CAS'] = 'supported';
    });
  });
});
