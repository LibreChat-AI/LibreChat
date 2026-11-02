import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  createResponseStorage,
  runAsSystem,
  tenantStorage,
} from '@librechat/data-schemas';
import type { ChannelRunRecord } from '@librechat/data-schemas';
import type { ChannelCleanupDependencies } from './cleanup';
import { createResponseRetirement } from '~/agents/responses/retirement';
import { createChannelResponseRetirement } from './responses';
import { createChannelExecutionAdapter } from './execution';
import { createChannelCleanupRuntime } from './cleanup';
import * as recovery from '~/agents/recovery';

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
      [
        'ChannelRun',
        'ChannelLane',
        'AgentChannel',
        'ChannelIdentity',
        'ChannelScope',
        'ResponseScope',
        'StoredResponse',
      ].map((name) => mongoose.models[name].deleteMany({})),
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
  await scope(() =>
    mongoose.models.ChannelIdentity.create({
      tenantId,
      linkId: 'link',
      revision: 'link-v1',
      state: 'active',
      userId: 'user-a',
      ticketHash: 'ticket',
      ticketExpiresAtMs: clock + 60000,
      expiresAtMs: clock + 600000,
      identity: {
        tenantId,
        channelId: 'channel',
        channelRevision: 'v1',
        teamId: 'T1',
        externalUserId: 'U1',
        agentId: 'agent',
      },
    }),
  );
  deps = {
    storage,
    isCredentialCurrent: async () => true,
    channels: db,
    now: () => clock,
    getWorkerSettings: async () =>
      channelConfigSchema.parse({
        enabled,
        cleanup: { intervalMs: 60_000, maxIdleIntervalMs: 60_000, batchSize: 2 },
      }),
    resolvePrincipal: async () =>
      allowed && enabled
        ? { userId: 'user-a', channelRevision: 'v1', linkId: 'link', linkRevision: 'link-v1' }
        : null,
    retireForAuthorityLoss: async (run) => {
      expect(tenantStorage.getStore()?.tenantId).toBe(
        run.tenantId === '_' ? undefined : run.tenantId,
      );
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
  expect(await scope(() => db.deleteAgentChannel('channel', 'user-a'))).toEqual({
    status: 'pending_drain',
  });
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
  await scope(() => db.updateAgentChannel('channel', 'user-a', { apiKeyId: 'legacy-key-id' }));
  await scope(() => db.beginAgentChannelDeletion('channel', 'user-a'));
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
  expect(config.claimBatchSize).toBe(25);
  for (const cleanup of [
    { batchSize: 0 },
    { batchSize: 101 },
    { intervalMs: 999 },
    { maxIdleIntervalMs: 300_001 },
  ]) {
    expect(channelConfigSchema.safeParse({ cleanup }).success).toBe(false);
  }
});

it('keeps tenantless work authorized and deletes its closed parent in the application default tenant', async () => {
  const defaultScope = <T>(work: () => Promise<T>) =>
    tenantStorage.run({ tenantId: undefined }, work);
  await defaultScope(async () => {
    await db.createAgentChannel({
      channelId: 'default-channel',
      agentId: 'agent',
      createdBy: 'user-a',
      type: 'slack',
      credentialMode: 'per_user',
      status: 'active',
      revision: 'v1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    });
    await mongoose.models.ChannelIdentity.create({
      tenantId: '_',
      linkId: 'link',
      revision: 'link-v1',
      state: 'active',
      userId: 'user-a',
      ticketHash: 'default-ticket',
      ticketExpiresAtMs: clock + 60000,
      expiresAtMs: clock + 600000,
      identity: {
        tenantId: '_',
        channelId: 'default-channel',
        channelRevision: 'v1',
        teamId: 'T1',
        externalUserId: 'U1',
        agentId: 'agent',
      },
    });
    await storage.admit(
      {
        tenantId: '_',
        channelId: 'default-channel',
        agentId: 'agent',
        principal: {
          userId: 'user-a',
          channelRevision: 'v1',
          linkId: 'link',
          linkRevision: 'link-v1',
        },
        admission: {
          eventId: 'default-event',
          externalChannelId: 'C1',
          externalThreadKey: 'C1:1',
          externalMessageKey: 'C1:1',
          actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
          input: 'default tenant input',
        },
      },
      clock,
    );
  });
  await runtime.initialize();
  expect(retired).toHaveLength(0);
  expect(deps.onError).not.toHaveBeenCalled();
  await defaultScope(() => db.beginAgentChannelDeletion('default-channel', 'user-a'));
  await restart();
  expect(retired).toHaveLength(1);
  expect(retired[0].tenantId).toBe('_');
  expect(await defaultScope(() => db.getAgentChannelMetadata('default-channel'))).toBeNull();
  expect(deps.onError).not.toHaveBeenCalled();
});

it('caps maintenance pages by the storage policy and never turns a credential lookup outage into retirement', async () => {
  await admit('one');
  await admit('two');
  deps.getWorkerSettings = async () =>
    channelConfigSchema.parse({
      enabled: true,
      maxMetadataPageSize: 1,
      cleanup: { batchSize: 2, intervalMs: 60000, maxIdleIntervalMs: 60000 },
    });
  const read = jest.spyOn(storage, 'listPendingMetadata');
  deps.isCredentialCurrent = async () => {
    throw new Error('credential store unavailable');
  };
  await runtime.initialize();
  expect(read).toHaveBeenCalledWith(undefined, 1);
  expect(retired).toHaveLength(0);
  expect(deps.onError).toHaveBeenCalledTimes(1);
});

it('holds an invalid issued credential lane until exact retirement confirms provider drain', async () => {
  const { run } = await admit('expired-credential');
  const claimed = (await scope(() => storage.claim(tenantId, 'channel', 'gateway', clock, 60000)))!;
  const fence = { runId: run.runId, owner: 'gateway', epoch: claimed.leaseEpoch };
  await scope(() => storage.prepareExecution(tenantId, fence, clock));
  await scope(() =>
    storage.attachResponseCredential(
      tenantId,
      fence,
      { apiKeyId: 'expired-key', encryptedApiKey: 'encrypted-original' },
      clock,
    ),
  );
  deps.isCredentialCurrent = async (current) => {
    expect(current.execution?.apiKeyId).toBe('expired-key');
    return false;
  };
  stoppedResult = 'pending';
  await runtime.initialize();
  expect(retired).toHaveLength(1);
  expect(retired[0].execution?.apiKeyId).toBe('expired-key');
  expect(
    await scope(() => mongoose.models.ChannelLane.findOne({ activeRunId: run.runId }).lean()),
  ).not.toBeNull();
  expect((await scope(() => storage.read(tenantId, 'channel', run.runId)))?.state).not.toBe(
    'cancelled',
  );
  clock += 60001;
  stoppedResult = 'stopped';
  await restart();
  expect(retired).toHaveLength(2);
  expect((await scope(() => storage.read(tenantId, 'channel', run.runId)))?.state).toBe(
    'cancelled',
  );
  expect(
    await scope(() => mongoose.models.ChannelLane.findOne({ activeRunId: run.runId }).lean()),
  ).toBeNull();
  expect(deps.onError).not.toHaveBeenCalled();
});

it.each(['read', 'parse'] as const)(
  'retries failed %s initialization with one shared attempt',
  async (failure) => {
    await admit();
    allowed = false;
    const original = deps.getWorkerSettings;
    let fail = true;
    const read = jest.fn(async () => {
      if (fail) {
        if (failure === 'read') throw new Error('configuration unavailable');
        const invalid = channelConfigSchema.parse({});
        invalid.cleanup.intervalMs = 0;
        return invalid;
      }
      return original();
    });
    deps.getWorkerSettings = read;
    const first = runtime.initialize();
    expect(runtime.initialize()).toBe(first);
    await expect(first).rejects.toThrow();
    fail = false;
    const retry = runtime.initialize();
    expect(runtime.initialize()).toBe(retry);
    await retry;
    expect(retired).toHaveLength(1);
    const calls = read.mock.calls.length;
    await runtime.initialize();
    expect(read).toHaveBeenCalledTimes(calls);
  },
);

it('keeps stop permanent after an initialization failure', async () => {
  const read = jest.fn(async () => {
    throw new Error('configuration unavailable');
  });
  deps.getWorkerSettings = read;
  await expect(runtime.initialize()).rejects.toThrow('configuration unavailable');
  await runtime.stop();
  await runtime.initialize();
  runtime.wake();
  expect(read).toHaveBeenCalledTimes(1);
  expect(retired).toHaveLength(0);
});

it('disposes a partially started worker before retrying initialization', async () => {
  await admit();
  allowed = false;
  const create = recovery.createIdleRecoveryLoop;
  const partial = create({
    intervalMs: 60000,
    maxIdleIntervalMs: 60000,
    scan: async () => true,
    onError: jest.fn(),
  });
  const start = jest
    .spyOn(partial, 'start')
    .mockRejectedValueOnce(new Error('initial scan failed'));
  const stop = jest.spyOn(partial, 'stop');
  const factory = jest.spyOn(recovery, 'createIdleRecoveryLoop').mockReturnValueOnce(partial);
  try {
    await expect(runtime.initialize()).rejects.toThrow('initial scan failed');
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await runtime.initialize();
    expect(retired).toHaveLength(1);
    expect(factory).toHaveBeenCalledTimes(2);
  } finally {
    factory.mockRestore();
    start.mockRestore();
    stop.mockRestore();
  }
});

it('does not reopen when a pending initialization rejects during shutdown', async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<Awaited<ReturnType<typeof deps.getWorkerSettings>>>((_resolve, fail) => {
    reject = fail;
  });
  const read = jest.fn(() => gate);
  deps.getWorkerSettings = read;
  const initializing = runtime.initialize();
  const stopping = runtime.stop();
  reject(new Error('startup unavailable'));
  await expect(initializing).rejects.toThrow('startup unavailable');
  await stopping;
  await runtime.initialize();
  expect(read).toHaveBeenCalledTimes(1);
  expect(retired).toHaveLength(0);
});

it.each([false, true])(
  'releases an expired Response lane only after canonical retirement proof: pending=%s',
  async (pending) => {
    await admit();
    const claimed = (await scope(() =>
      storage.claim(tenantId, 'channel', 'worker', clock, 60000),
    ))!;
    const fence = { runId: claimed.runId, owner: claimed.leaseOwner!, epoch: claimed.leaseEpoch };
    const prepared = await scope(() => storage.prepareExecution(tenantId, fence, clock));
    await scope(() =>
      storage.attachResponseCredential(
        tenantId,
        fence,
        { apiKeyId: 'issued', encryptedApiKey: 'encrypted' },
        clock,
      ),
    );
    const responses = createResponseStorage(mongoose);
    const execution = prepared.execution!;
    const owner = { userId: prepared.principal.userId, tenantId };
    const responseId = `resp_${prepared.runId}`;
    const reservation = await scope(() =>
      responses.reserve({
        ...owner,
        responseId,
        requestKey: `channel:${prepared.runId}`,
        sourceKeyId: 'issued',
        fingerprint: 'cleanup',
        agentId: prepared.agentId,
        requestJSON: JSON.stringify({
          model: prepared.agentId,
          input: prepared.admission.input,
          background: true,
          store: true,
          ...(execution.parentMessageId === '00000000-0000-0000-0000-000000000000'
            ? {}
            : { previous_response_id: execution.parentMessageId }),
        }),
        conversationId: execution.conversationId,
        parentMessageId: execution.parentMessageId,
      }),
    );
    if (!reservation.ok) throw new Error('Reservation failed');
    await scope(() => storage.bindResponse(tenantId, fence, responseId, clock));
    await scope(() =>
      mongoose.models.StoredResponse.updateOne(
        { responseId },
        { $set: { expiredAt: new Date(0), ...(pending ? { generationCreatedAt: 1234 } : {}) } },
      ),
    );
    const jobs = {
      getJob: jest.fn(async () => undefined),
      abortJob: jest.fn(),
      finishProviderTerminalPersistence: jest.fn(),
    };
    const adapter = createChannelExecutionAdapter({
      responseProjection: async () => {
        throw new Error('Cleanup must not project or execute');
      },
      responseRetirement: createChannelResponseRetirement({
        storage: responses,
        recovery: storage,
        retireResponse: createResponseRetirement({ storage: responses, jobs }),
      }),
    });
    deps.retireForAuthorityLoss = adapter.retireForAuthorityLoss;
    deps.isCredentialCurrent = async () => false;
    await runtime.initialize();
    await runtime.stop();
    const next = await admit('next');
    const nextClaim = await scope(() =>
      storage.claim(tenantId, 'channel', 'next-worker', clock + 60001, 60000),
    );
    if (pending) {
      expect(nextClaim?.runId).toBe(claimed.runId);
      expect(nextClaim?.errorCode).toBe('channel_authority_changed');
    } else expect(nextClaim?.runId).toBe(next.run.runId);
    expect(jobs.abortJob).not.toHaveBeenCalled();
  },
);

it('uses scoped principal authority when deployment worker defaults are disabled', async () => {
  const { run } = await admit();
  const resolve = deps.resolvePrincipal;
  deps.getWorkerSettings = async () =>
    channelConfigSchema.parse({
      enabled: false,
      cleanup: { intervalMs: 60000, maxIdleIntervalMs: 60000 },
    });
  deps.resolvePrincipal = async (...args) => {
    expect(tenantStorage.getStore()?.tenantId).toBe(tenantId);
    return resolve(...args);
  };
  await runtime.initialize();
  expect(retired).toEqual([]);
  expect(await scope(() => storage.read(tenantId, 'channel', run.runId))).toMatchObject({
    state: 'queued',
    leaseEpoch: 0,
  });
});
