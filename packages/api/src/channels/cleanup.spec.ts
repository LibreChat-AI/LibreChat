import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type { ChannelRunRecord } from '@librechat/data-schemas';
import type { ChannelCleanupDependencies } from './cleanup';
import { createChannelCleanupRuntime } from './cleanup';

let mongo: MongoMemoryReplSet;
let db: ReturnType<typeof createMethods>;
let storage: ReturnType<typeof createChannelRunStorage>;
let deps: ChannelCleanupDependencies;
let runtime: ReturnType<typeof createChannelCleanupRuntime>;
let retired: ChannelRunRecord[];
let allowed: boolean;
let enabled: boolean;
let stoppedResult: 'stopped' | 'pending';
let clock: number;
const tenantId = 'cleanup-tenant';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  storage = createChannelRunStorage(mongoose);
  await Promise.all([mongoose.models.ChannelRun.init(), mongoose.models.ChannelLane.init()]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(() =>
    Promise.all(
      ['ChannelRun', 'ChannelLane', 'AgentChannel'].map((name) =>
        mongoose.models[name].deleteMany({}),
      ),
    ),
  );
  clock = Date.now();
  allowed = true;
  enabled = true;
  retired = [];
  stoppedResult = 'stopped';
  await scope(() =>
    db.createAgentChannel({
      channelId: 'channel',
      tenantId,
      agentId: 'agent',
      createdBy: 'user-a',
      type: 'slack',
      credentialMode: 'per_user',
      status: 'active',
      revision: 'v1',
      encryptedBotToken: 'not-a-real-token',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    }),
  );
  deps = {
    storage,
    channels: db,
    now: () => clock,
    getConfig: async () =>
      channelConfigSchema.parse({
        enabled,
        cleanup: { intervalMs: 60_000, maxIdleIntervalMs: 60_000, batchSize: 2 },
      }),
    resolvePrincipal: async () =>
      allowed
        ? { userId: 'user-a', channelRevision: 'v1', linkId: 'link', linkRevision: 'link-v1' }
        : null,
    retireForAuthorityLoss: async (run) => {
      expect(tenantStorage.getStore()?.tenantId).toBe(run.tenantId);
      retired.push(run);
      return stoppedResult;
    },
    deleteApiKey: async () => true,
    onError: jest.fn(),
  };
  runtime = createChannelCleanupRuntime(deps);
});
afterEach(async () => {
  await runtime.stop();
});
async function admit(eventId = 'event') {
  return scope(() =>
    storage.admit(
      {
        tenantId,
        channelId: 'channel',
        agentId: 'agent',
        principal: {
          userId: 'user-a',
          channelRevision: 'v1',
          linkId: 'link',
          linkRevision: 'link-v1',
        },
        admission: {
          eventId,
          externalChannelId: 'C1',
          externalThreadKey: 'C1:1',
          externalMessageKey: `C1:${eventId}`,
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
          input: 'private input',
        },
      },
      clock,
    ),
  );
}
async function restart() {
  await runtime.stop();
  runtime = createChannelCleanupRuntime(deps);
  await runtime.initialize();
}

it('does not start by construction, initializes once, and leaves authorized active work untouched', async () => {
  const { run } = await admit();
  expect(retired).toHaveLength(0);
  await Promise.all([runtime.initialize(), runtime.initialize()]);
  expect(retired).toHaveLength(0);
  expect(await scope(() => storage.read(tenantId, 'channel', run.runId))).toMatchObject({
    state: 'queued',
    leaseEpoch: 0,
    cancellationRequested: false,
  });
  await runtime.stop();
  allowed = false;
  await runtime.initialize();
  expect(retired).toHaveLength(0);
});

it.each(['revoked', 'disabled', 'feature-off', 'orphan'] as const)(
  'cleans %s work without a gateway or any credential bundle',
  async (reason) => {
    const { run } = await admit();
    await scope(() => storage.claim(tenantId, 'channel', 'absent-gateway', clock, 60_000));
    if (reason === 'revoked') allowed = false;
    if (reason === 'disabled')
      await scope(() => db.updateAgentChannel('channel', 'user-a', { status: 'disabled' }));
    if (reason === 'feature-off') enabled = false;
    if (reason === 'orphan')
      await scope(() => mongoose.models.AgentChannel.deleteOne({ channelId: 'channel' }));
    const bundles = jest.spyOn(db, 'getAgentChannel');
    await runtime.initialize();
    expect(bundles).not.toHaveBeenCalled();
    expect(retired).toHaveLength(1);
    expect(retired[0]).toMatchObject({ runId: run.runId, tenantId, principal: run.principal });
    expect(await scope(() => storage.read(tenantId, 'channel', run.runId))).toMatchObject({
      state: 'cancelled',
      errorCode: 'channel_authority_changed',
    });
    expect(deps.onError).not.toHaveBeenCalled();
  },
);

it('defers deletion while cleanup is unknown and completes after restart and exact lease expiry', async () => {
  const { run } = await admit();
  await scope(() => db.updateAgentChannel('channel', 'user-a', { status: 'deleting' }));
  expect(await scope(() => db.deleteAgentChannel('channel', 'user-a'))).toBe(false);
  stoppedResult = 'pending';
  await runtime.initialize();
  expect(await scope(() => db.getAgentChannelMetadata('channel'))).toMatchObject({
    status: 'deleting',
  });
  await restart();
  expect(retired).toHaveLength(1);
  clock += 60_001;
  stoppedResult = 'stopped';
  await restart();
  expect(await scope(() => db.getAgentChannelMetadata('channel'))).toBeNull();
  expect(await scope(() => storage.read(tenantId, 'channel', run.runId))).toMatchObject({
    state: 'cancelled',
  });
});

it('recovers deleting parents with no remaining runs but never bypasses a failed legacy key revocation', async () => {
  await scope(() =>
    db.updateAgentChannel('channel', 'user-a', { status: 'deleting', apiKeyId: 'legacy-key-id' }),
  );
  deps.deleteApiKey = async () => {
    throw new Error('key store unavailable');
  };
  await runtime.initialize();
  expect(await scope(() => db.getAgentChannelMetadata('channel'))).toMatchObject({
    status: 'deleting',
  });
  deps.deleteApiKey = async () => true;
  await restart();
  expect(await scope(() => db.getAgentChannelMetadata('channel'))).toBeNull();
});

it('does not convert authority lookup outages into cleanup', async () => {
  const { run } = await admit();
  deps.resolvePrincipal = async () => {
    throw new Error('permissions unavailable');
  };
  await runtime.initialize();
  expect(retired).toHaveLength(0);
  expect(await scope(() => storage.read(tenantId, 'channel', run.runId))).toMatchObject({
    state: 'queued',
    cancellationRequested: false,
    leaseEpoch: 0,
  });
  expect(deps.onError).toHaveBeenCalledTimes(1);
});

it('enumerates only bounded metadata in system context then scopes every full read to its tenant', async () => {
  await admit('one');
  await admit('two');
  await admit('three');
  const metadata = await runAsSystem(() => storage.listPendingMetadata(undefined, 2));
  expect(metadata.runs).toHaveLength(2);
  expect(metadata.next).toBeDefined();
  expect(Object.keys(metadata.runs[0]).sort()).toEqual(['channelId', 'runId', 'tenantId']);
  const read = jest.spyOn(storage, 'read');
  allowed = false;
  await runtime.initialize();
  expect(retired).toHaveLength(2);
  expect(read.mock.calls.every(([tenant]) => tenant === tenantId)).toBe(true);
  expect(await scope(() => db.getAgentChannelMetadata('channel'))).not.toHaveProperty(
    'encryptedBotToken',
  );
});

it('waits for owned cleanup on shutdown and does not start the next run', async () => {
  await admit('one');
  await admit('two');
  allowed = false;
  let entered!: () => void;
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  deps.retireForAuthorityLoss = async (run) => {
    retired.push(run);
    entered();
    await gate;
    return 'stopped';
  };
  const initializing = runtime.initialize();
  await ready;
  let ended = false;
  const stopping = runtime.stop().then(() => {
    ended = true;
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(ended).toBe(false);
  release();
  await initializing;
  await stopping;
  expect(retired).toHaveLength(1);
});

it('uses an allowlist so future top-level or Slack credential fields cannot enter authority metadata', async () => {
  await mongoose.models.AgentChannel.collection.updateOne(
    { tenantId, channelId: 'channel' },
    { $set: { futureCredential: 'must-not-leak', 'slack.futureCredential': 'must-not-leak' } },
  );
  const metadata = await scope(() => db.getAgentChannelMetadata('channel'));
  expect(Object.keys(metadata!).sort()).toEqual([
    'agentId',
    'channelId',
    'createdBy',
    'credentialMode',
    'revision',
    'slack',
    'status',
    'tenantId',
    'type',
  ]);
  expect(metadata?.slack).toEqual({ teamId: 'T1', appId: 'A1', botUserId: 'UBOT' });
  expect(JSON.stringify(metadata)).not.toContain('must-not-leak');
});

it('defines bounded cleanup configuration without exposing the algorithmic claim batch as a policy knob', () => {
  const config = channelConfigSchema.parse({});
  expect(config.cleanup).toEqual({ batchSize: 25, intervalMs: 1000, maxIdleIntervalMs: 30_000 });
  expect(config).not.toHaveProperty('claimBatchSize');
  for (const cleanup of [
    { batchSize: 0 },
    { batchSize: 101 },
    { intervalMs: 999 },
    { maxIdleIntervalMs: 300_001 },
  ]) {
    expect(channelConfigSchema.safeParse({ cleanup }).success).toBe(false);
  }
});
