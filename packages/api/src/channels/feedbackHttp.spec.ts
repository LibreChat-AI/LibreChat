import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelRunStorage,
  createChannelIdentityStorage,
  channelRunFence,
  createManagedMessageId,
  createChannelFeedbackStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type { AppConfig, ChannelRunRecord } from '@librechat/data-schemas';
import type { IUser } from '@librechat/data-schemas';
import type { ChannelFeedbackHostDependencies } from './feedbackHost';
import { createChannelApplicationPolicy } from './applicationPolicy';
import { getLangfuseDestinationId } from '~/langfuse/destinations';
import { createChannelFeedbackRuntime } from './feedbackRuntime';
import { createChannelFeedbackHandlers } from './feedbackHttp';
import { createChannelFeedbackWorker } from './feedbackWorker';
import { createChannelFeedbackHost } from './feedbackHost';
import { sendFeedbackScore } from '~/langfuse/feedback';
import { traceIdForMessage } from '~/langfuse/trace';
import { createChannelHandlers } from './service';
import * as configSecrets from '~/admin/secrets';

const tenantId = 'tenant-a';
const messageId = createManagedMessageId();
let conversationId: string;
let runId: string;
const serviceToken = 'local-channel-feedback-test-token-32-characters';
let mongo: MongoMemoryReplSet;
let app: express.Express;
let db: ReturnType<typeof createMethods>;
let feedback: ReturnType<typeof createChannelFeedbackHost>;
let deps: ChannelFeedbackHostDependencies;
let config: AppConfig;
let central: boolean | null;
let policyEnabled: boolean;
let readPolicyConfig: (tenantId: string, principalId?: string) => Promise<AppConfig | undefined>;
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const event = {
  eventId: 'Ev1',
  eventTimestampUs: 1760000000000001,
  externalMessageKey: 'C1:123.456',
  externalUserId: 'U2',
  reaction: '+1',
  action: 'added',
};
const post = (body: object = event) =>
  request(app)
    .post('/service/channel-a/reactions')
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('x-tenant-id', tenantId)
    .send(body);

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    instanceOpts: [{ args: ['--nounixsocket'] }],
  });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await Promise.all(
    ['AgentChannel', 'ChannelRun', 'ChannelReply', 'ChannelFeedback', 'ChannelFeedbackEvent'].map(
      (name) => mongoose.models[name].init(),
    ),
  );
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  conversationId = randomUUID();
  runId = randomUUID();
  await runAsSystem(async () => {
    for (const name of [
      'AgentChannel',
      'ChannelRun',
      'ChannelLane',
      'ChannelIdentity',
      'ChannelReply',
      'ChannelFeedback',
      'ChannelFeedbackEvent',
      'Message',
      'ResponseScope',
    ])
      await mongoose.models[name].deleteMany({});
  });
  central = true;
  policyEnabled = true;
  config = {
    interfaceConfig: { feedback: true },
    endpoints: { agents: {} },
  } as AppConfig;
  await scope(async () => {
    await db.createAgentChannel({
      channelId: 'channel-a',
      agentId: 'agent-a',
      createdBy: 'user-a',
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'rev-1',
      slack: { teamId: 'T1', appId: 'A1', botUserId: 'UBOT' },
    });
    const run: ChannelRunRecord = {
      tenantId,
      channelId: 'channel-a',
      agentId: 'agent-a',
      runId: runId,
      laneId: 'lane-a',
      state: 'delivered',
      sequence: 1,
      payloadHash: 'hash',
      receivedAt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: 0,
      principal: {
        userId: 'user-a',
        channelRevision: 'rev-1',
        linkId: 'link-a',
        linkRevision: 'link-rev',
      },
      admission: {
        eventId: 'original',
        externalChannelId: 'C1',
        externalThreadKey: 'C1:1',
        externalMessageKey: 'C1:1',
        actor: { teamId: 'T1', appId: 'A1', externalUserId: 'U1' },
        input: 'hello',
      },
      execution: {
        protocol: 'responses',
        responseId: messageId,
        requestId: 'request-a',
        conversationId: conversationId,
        parentMessageId: 'parent-a',
      },
      snapshot: { responseId: messageId, status: 'completed', text: 'answer', elapsedMs: 1 },
      receipts: [
        {
          operationId: 'part-a',
          outcome: 'confirmed',
          attempts: 1,
          externalMessageKey: event.externalMessageKey,
        },
      ],
      cancellationRequested: false,
    };
    const linked = await createChannelIdentityStorage(mongoose).saveChannelIdentity(
      {
        tenantId,
        linkId: 'link-a',
        revision: 'link-rev',
        state: 'active',
        userId: 'user-a',
        ticketHash: randomUUID(),
        ticketExpiresAtMs: Date.now() + 60000,
        expiresAtMs: Date.now() + 600000,
        identity: {
          tenantId,
          channelId: run.channelId,
          channelRevision: 'rev-1',
          agentId: run.agentId,
          teamId: 'T1',
          externalUserId: 'U1',
        },
      },
      null,
    );
    if (!linked) throw new Error('Could not create feedback actor fixture');
    const runs = createChannelRunStorage(mongoose);
    await runs.admit(
      {
        tenantId,
        channelId: run.channelId,
        agentId: run.agentId,
        principal: run.principal,
        admission: run.admission,
      },
      Date.now(),
    );
    const claimed = (await runs.claim(
      tenantId,
      run.channelId,
      'feedback-fixture',
      Date.now(),
      60000,
    ))!;
    const prepared = await runs.prepareExecution(tenantId, channelRunFence(claimed), Date.now());
    runId = prepared.runId;
    conversationId = prepared.execution!.conversationId;
    // Ownership is published by storage; execution and confirmed transport fields are reader fixtures.
    await mongoose.models.ChannelRun.collection.updateOne(
      { runId, tenantId, '_managed.incarnation': prepared._managed!.incarnation },
      {
        $set: {
          state: run.state,
          execution: { ...prepared.execution, responseId: messageId },
          snapshot: run.snapshot,
          receipts: run.receipts,
        },
      },
    );
    await mongoose.models.Message.create({
      tenantId,
      messageId: messageId,
      conversationId: conversationId,
      user: 'user-a',
      isCreatedByUser: false,
      text: 'answer',
      langfuseRunId: 'actual-run',
      langfuseSampled: true,
      langfuseCentralTraceExportEnabled: true,
      langfuseDestinationIds: ['recorded-project'],
      feedback: { rating: 'thumbsDown' },
    });
  });
  readPolicyConfig = async () => config;
  deps = {
    channels: db,
    storage: createChannelFeedbackStorage(mongoose),
    getPolicy: async ({ tenantId: scopeTenant, userId }) => {
      const appConfig = await readPolicyConfig(scopeTenant, userId);
      return policyEnabled && appConfig && appConfig.interfaceConfig?.feedback !== false
        ? { appConfig, centralTraceExportEnabled: central === true }
        : null;
    },
    sendScore: jest.fn().mockResolvedValue(undefined),
    maxConflictRetries: 8,
    exportTimeoutMs: 500,
    exportLeaseMs: 1000,
    exportRetryMs: 100,
  };
  feedback = createChannelFeedbackHost(deps);
  const channel = createChannelHandlers({
    db,
    serviceToken: () => serviceToken,
    config: async () => ({ enabled: true }),
    getAgent: async () => ({ id: 'agent-a' }),
    verifySlackToken: async () => null,
    logError: () => {},
  });
  const handlers = createChannelFeedbackHandlers({
    guard: channel.service,
    feedback,
  });
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', handlers.reaction);
});

test('resolves confirmed delivered receipt and actual message trace, keeping browser feedback untouched', async () => {
  const result = await post().expect(200);
  expect(result.body).toEqual({
    messageId: messageId,
    conversationId: conversationId,
    feedback: { rating: 'thumbsUp' },
    ignored: false,
  });
  await scope(async () => {
    await feedback.flush(tenantId, 10);
    expect(deps.sendScore).toHaveBeenCalledWith(
      expect.objectContaining({
        traceId: traceIdForMessage('actual-run'),
        sampled: true,
        isTemporary: false,
        destinationIds: ['recorded-project'],
        centralTraceExportEnabled: true,
      }),
    );
    const message = await db.getMessage({ user: 'user-a', messageId: messageId });
    expect(message?.feedback).toMatchObject({ rating: 'thumbsDown' });
  });
});

test.each([false, true, undefined])(
  'rechecks temporary-chat export policy against durable provenance %s after restart',
  async (isTemporary) => {
    const originalEnv = { ...process.env };
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('LANGFUSE_')) delete process.env[key];
    }
    Object.assign(process.env, {
      TENANT_ISOLATION_STRICT: 'false',
      LANGFUSE_PUBLIC_KEY: 'fixture-public',
      LANGFUSE_SECRET_KEY: 'fixture-secret',
      LANGFUSE_PROJECT_ID: 'recorded-project',
      LANGFUSE_BASE_URL: 'https://langfuse.invalid',
    });
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(new Response(null, { status: 200 }));
    try {
      config.langfuse = { trace: { temporaryChats: true } };
      await scope(async () =>
        mongoose.models.Message.updateOne(
          { messageId: messageId },
          {
            $set: {
              ...(isTemporary !== undefined && { isTemporary }),
              langfuseDestinationIds: [
                getLangfuseDestinationId('https://langfuse.invalid', 'recorded-project'),
              ],
            },
          },
        ),
      );
      if (isTemporary === undefined)
        await scope(async () =>
          mongoose.models.Message.collection.updateOne(
            { messageId: messageId },
            { $unset: { isTemporary: '' } },
          ),
        );
      await post().expect(200);
      await scope(async () => {
        const reply = await mongoose.models.ChannelReply.findOne({ messageId: messageId }).lean<{
          isTemporary?: boolean;
        }>();
        const ledger = await mongoose.models.ChannelFeedback.findOne({}).lean<{
          mapping: { isTemporary?: boolean };
        }>();
        const receipt = await mongoose.models.ChannelFeedbackEvent.findOne({}).lean<{
          mapping: { isTemporary?: boolean };
        }>();
        expect(reply?.isTemporary).toBe(isTemporary);
        expect(ledger?.mapping.isTemporary).toBe(isTemporary);
        expect(receipt?.mapping.isTemporary).toBe(isTemporary);
      });
      config.langfuse.trace!.temporaryChats = false;
      const restarted = createChannelFeedbackHost({ ...deps, sendScore: sendFeedbackScore });
      await scope(async () => restarted.flush(tenantId, 10));
      expect(fetchMock).toHaveBeenCalledTimes(isTemporary === false ? 1 : 0);
    } finally {
      fetchMock.mockRestore();
      process.env = originalEnv;
    }
  },
);

test('rejects unsigned ingress, forged provenance, unsafe timestamps and non-delivered replies', async () => {
  await request(app).post('/service/channel-a/reactions').send(event).expect(401);
  await post({ ...event, conversationId: 'forged' }).expect(400);
  await post({ ...event, eventTimestampUs: Number.MAX_SAFE_INTEGER + 1 }).expect(400);
  await post({ ...event, externalMessageKey: 'C1:missing' }).expect(404);
  await scope(async () =>
    mongoose.models.ChannelRun.updateOne({ runId: runId }, { $set: { state: 'delivering' } }),
  );
  await post().expect(404);
  expect(deps.sendScore).not.toHaveBeenCalled();
});

test.each(['unmanaged', 'unpublished'] as const)(
  'does not accept a delivered-looking %s Run as source authority',
  async (kind) => {
    await scope(async () => {
      const result = await mongoose.models.ChannelRun.collection.updateOne(
        { runId },
        kind === 'unmanaged'
          ? { $unset: { _managed: 1 } }
          : { $set: { '_managed.phase': 'registered' } },
      );
      expect(result.matchedCount).toBe(1);
    });
    await post().expect(404);
    expect(deps.sendScore).not.toHaveBeenCalled();
  },
);

test.each(['channel revision', 'user-authored', 'cross-principal'] as const)(
  'rejects a %s source instead of exporting feedback',
  async (kind) => {
    await scope(async () => {
      if (kind === 'channel revision')
        expect(
          await db.updateAgentChannel('channel-a', 'user-a', { revision: 'rotated' }),
        ).not.toBeNull();
      else {
        const result = await mongoose.models.Message.collection.updateOne(
          { messageId },
          {
            $set:
              kind === 'user-authored' ? { isCreatedByUser: true } : { user: 'other-principal' },
          },
        );
        expect(result.matchedCount).toBe(1);
      }
    });
    await post().expect(404);
    expect(deps.sendScore).not.toHaveBeenCalled();
  },
);

test('honors feedback disable and rechecks central export policy without broadening captured destinations', async () => {
  config.interfaceConfig!.feedback = false;
  await post().expect(403);
  config.interfaceConfig!.feedback = true;
  await post().expect(200);
  central = null;
  await scope(async () => feedback.flush(tenantId, 10));
  expect(deps.sendScore).toHaveBeenCalledWith(
    expect.objectContaining({
      centralTraceExportEnabled: false,
      destinationIds: ['recorded-project'],
    }),
  );
});

it.each([
  { name: 'unresolved', sampled: true, ids: undefined, expected: undefined },
  { name: 'explicit empty', sampled: true, ids: [], expected: [] },
  { name: 'captured', sampled: true, ids: ['recorded-project'], expected: ['recorded-project'] },
  { name: 'not sampled', sampled: false, ids: undefined, expected: undefined },
  { name: 'missing sampling', sampled: undefined, ids: undefined, expected: [] },
])(
  'preserves $name trace routing through admission, persistence and restart',
  async ({ sampled, ids, expected }) => {
    await scope(async () => {
      await mongoose.models.Message.updateOne(
        { messageId: messageId },
        {
          ...(sampled === undefined ? {} : { $set: { langfuseSampled: sampled } }),
          $unset: {
            langfuseDestinationIds: '',
            ...(sampled === undefined ? { langfuseSampled: '' } : {}),
          },
        },
      );
      if (ids)
        await mongoose.models.Message.updateOne(
          { messageId: messageId },
          { $set: { langfuseDestinationIds: ids } },
        );
    });
    await post().expect(200);
    await scope(async () => createChannelFeedbackHost(deps).flush(tenantId, 10));
    expect(deps.sendScore).toHaveBeenCalledWith(
      expect.objectContaining({ sampled: sampled === true, destinationIds: expected }),
    );
  },
);

it.each([false, undefined])(
  'requires original central consent %s rather than a copied mapping or later opt-in',
  async (original) => {
    await post().expect(200);
    await scope(async () => {
      await mongoose.models.Message.collection.updateOne(
        { messageId: messageId },
        original === undefined
          ? { $unset: { langfuseCentralTraceExportEnabled: '' } }
          : { $set: { langfuseCentralTraceExportEnabled: original } },
      );
    });
    central = true;
    await scope(async () => createChannelFeedbackHost(deps).flush(tenantId, 10));
    expect(deps.sendScore).toHaveBeenCalledWith(
      expect.objectContaining({ centralTraceExportEnabled: false }),
    );
  },
);

it('dispatches actual tenant feedback with unresolved optional project identity', async () => {
  const previous = { ...process.env };
  const encrypted = `v3:${'a'.repeat(32)}:${'b'.repeat(32)}`;
  const originalDecrypt = configSecrets.decryptConfigSecret;
  const decrypt = jest
    .spyOn(configSecrets, 'decryptConfigSecret')
    .mockImplementation((value) =>
      value === encrypted ? 'fixture-tenant-secret' : originalDecrypt(value),
    );
  const fetch = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  try {
    delete process.env.LANGFUSE_PUBLIC_KEY;
    delete process.env.LANGFUSE_SECRET_KEY;
    process.env.TENANT_ISOLATION_STRICT = 'false';
    central = true;
    config.langfuse = {
      enabled: true,
      publicKey: 'fixture-tenant-public',
      secretKey: encrypted,
      destination: 'eu',
    };
    await scope(async () =>
      mongoose.models.Message.updateOne(
        { messageId: messageId },
        { $set: { isTemporary: false }, $unset: { langfuseDestinationIds: '' } },
      ),
    );
    await post().expect(200);
    await scope(async () =>
      createChannelFeedbackHost({ ...deps, sendScore: sendFeedbackScore }).flush(tenantId, 10),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toMatch(/\/api\/public\/scores$/);
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toMatchObject({
      name: 'user-feedback',
      value: 1,
    });
  } finally {
    fetch.mockRestore();
    decrypt.mockRestore();
    process.env = previous;
  }
});

test('missing trace provenance is explicit unavailable rather than guessed sampling or routing', async () => {
  await scope(async () =>
    mongoose.models.Message.updateOne(
      { messageId: messageId },
      { $unset: { langfuseSampled: '', langfuseDestinationIds: '' } },
    ),
  );
  await post().expect(200);
  await scope(async () => feedback.flush(tenantId, 10));
  expect(deps.sendScore).toHaveBeenCalledWith(
    expect.objectContaining({ sampled: false, destinationIds: [] }),
  );
});

test('durable worker enumerates only metadata in system context then exports within exact tenant context', async () => {
  await post().expect(200);
  const observed: Array<string | undefined> = [];
  const worker = createChannelFeedbackWorker({
    feedback,
    batchSize: 10,
    intervalMs: 1000,
    maxIdleIntervalMs: 2000,
    onError: (error) => {
      throw error;
    },
    listChannels: async () => {
      observed.push(getTenantId());
      return {
        channels: await mongoose.models.AgentChannel.find({})
          .select('tenantId')
          .lean<Array<{ tenantId?: string }>>(),
      };
    },
  });
  jest.mocked(deps.sendScore).mockImplementation(async () => {
    observed.push(getTenantId());
  });
  await worker.start();
  await worker.stop();
  expect(observed).toEqual([SYSTEM_TENANT_ID, tenantId]);
});

it('refuses to move a frozen feedback mapping to a changed source trace', async () => {
  await post().expect(200);
  await scope(async () =>
    mongoose.models.Message.updateOne(
      { messageId: messageId },
      { $set: { langfuseRunId: 'different-trace' } },
    ),
  );
  await expect(scope(() => createChannelFeedbackHost(deps).flush(tenantId, 10))).rejects.toThrow(
    'trace identity changed',
  );
  expect(deps.sendScore).not.toHaveBeenCalled();
});

it('resolves delivered source metadata once and reuses the mapping on redelivery', async () => {
  const read = jest.spyOn(deps.storage, 'readReplySource');
  const history = jest.spyOn(mongoose.models.ChannelRun, 'findOne');
  await post().expect(200);
  await post().expect(200);
  expect(read).toHaveBeenCalledTimes(1);
  expect(history).not.toHaveBeenCalled();
  const source = await scope(() =>
    deps.storage.readReplySource(
      {
        tenantId,
        channelId: 'channel-a',
        channelRevision: 'rev-1',
        teamId: 'T1',
        agentId: 'agent-a',
      },
      event.externalMessageKey,
    ),
  );
  expect(source).toMatchObject({ messageId: messageId, principalId: 'user-a' });
  for (const field of ['text', 'admission', 'execution', 'encryptedApiKey', '_id'])
    expect(source).not.toHaveProperty(field);
});

it.each([
  'unbound',
  'response_changed',
  'foreign_owner',
  'foreign_conversation',
  'expired',
  'user_message',
  'unconfirmed',
] as const)('rejects %s source provenance without admitting feedback', async (change) => {
  await scope(async () => {
    if (change === 'unbound')
      await mongoose.models.ChannelRun.updateOne(
        { runId: runId },
        { $unset: { 'execution.responseId': '' } },
      );
    if (change === 'response_changed')
      await mongoose.models.ChannelRun.updateOne(
        { runId: runId },
        { $set: { 'execution.responseId': 'another-response' } },
      );
    if (change === 'foreign_owner')
      await mongoose.models.Message.updateOne(
        { messageId: messageId },
        { $set: { user: 'another-owner' } },
      );
    if (change === 'foreign_conversation')
      await mongoose.models.Message.updateOne(
        { messageId: messageId },
        { $set: { conversationId: 'another-conversation' } },
      );
    if (change === 'expired')
      await mongoose.models.Message.updateOne(
        { messageId: messageId },
        { $set: { expiredAt: new Date(0) } },
      );
    if (change === 'user_message')
      await mongoose.models.Message.updateOne(
        { messageId: messageId },
        { $set: { isCreatedByUser: true } },
      );
    if (change === 'unconfirmed')
      await mongoose.models.ChannelRun.updateOne(
        { runId: runId },
        { $set: { 'receipts.0.outcome': 'unknown' } },
      );
  });
  await post().expect(404, { error: 'mapping_not_found' });
  expect(await scope(() => mongoose.models.ChannelFeedbackEvent.countDocuments({}))).toBe(0);
  expect(deps.sendScore).not.toHaveBeenCalled();
});

it('carries the original deadline through delayed source configuration and rejects a late dispatch', async () => {
  await post().expect(200);
  let clock = 1000;
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let principalLookups = 0;
  deps.now = () => clock;
  readPolicyConfig = async (_tenant, principalId) => {
    if (principalId && ++principalLookups === 2) {
      enter();
      await gate;
    }
    return config;
  };
  const oldHost = createChannelFeedbackHost(deps);
  const old = scope(() => oldHost.flush(tenantId, 10)).then(
    () => undefined,
    (error) => error,
  );
  await entered;
  clock += 2001;
  await post({
    ...event,
    eventId: 'new-negative',
    eventTimestampUs: event.eventTimestampUs + 1,
    reaction: '-1',
  }).expect(200);
  await scope(() => createChannelFeedbackHost(deps).flush(tenantId, 10));
  release();
  expect(await old).toMatchObject({ message: 'Channel feedback export timed out' });
  expect(deps.sendScore).toHaveBeenCalledTimes(1);
  expect(jest.mocked(deps.sendScore).mock.calls[0][0].feedback).toEqual({ rating: 'thumbsDown' });
  expect(
    await scope(() => deps.storage.pendingChannelFeedbackExports(tenantId, clock, 10)),
  ).toHaveLength(0);
});

it('rechecks source authority after delayed configuration before dispatching to the provider', async () => {
  await post().expect(200);
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  readPolicyConfig = async (_tenant, principalId) => {
    if (principalId) {
      enter();
      await gate;
    }
    return config;
  };
  const exportResult = scope(() => feedback.flush(tenantId, 10)).then(
    () => undefined,
    (error) => error,
  );
  await entered;
  await scope(() => mongoose.models.Message.deleteOne({ messageId: messageId, user: 'user-a' }));
  release();
  expect(await exportResult).toMatchObject({ message: 'Channel feedback authority changed' });
  expect(deps.sendScore).not.toHaveBeenCalled();
});

it('honors the source principal feedback override before durable event admission', async () => {
  await scope(() =>
    mongoose.models.AgentChannel.updateOne(
      { channelId: 'channel-a' },
      { $set: { createdBy: 'channel-owner' } },
    ),
  );
  readPolicyConfig = async (_tenant, principalId) =>
    principalId === 'user-a'
      ? ({
          ...config,
          interfaceConfig: { ...config.interfaceConfig, feedback: false },
        } as AppConfig)
      : config;
  await post().expect(403, { error: 'forbidden' });
  for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
    expect(await scope(() => mongoose.models[name].countDocuments({}))).toBe(0);
  expect(deps.sendScore).not.toHaveBeenCalled();
});

it('rechecks a source principal override before export and retries only after re-enablement', async () => {
  await post().expect(200);
  let enabled = false;
  readPolicyConfig = async (_tenant, principalId) =>
    principalId === 'user-a' && !enabled
      ? ({
          ...config,
          interfaceConfig: { ...config.interfaceConfig, feedback: false },
        } as AppConfig)
      : config;
  await scope(() => feedback.flush(tenantId, 10));
  expect(deps.sendScore).not.toHaveBeenCalled();
  enabled = true;
  await scope(() => mongoose.models.ChannelFeedback.updateMany({}, { $set: { retryAtMs: 0 } }));
  await scope(() => feedback.flush(tenantId, 10));
  expect(deps.sendScore).toHaveBeenCalledTimes(1);
});

it('starts recovery and admits scoped feedback with a disabled deployment default', async () => {
  const readConfig = jest.fn(
    async (options) =>
      ({
        ...config,
        endpoints: {
          agents: { channels: { enabled: !options.baseOnly && options.tenantId === tenantId } },
        },
      }) as unknown as AppConfig,
  );
  const policy = createChannelApplicationPolicy({
    readAppConfig: readConfig,
    findUser: async ({ _id }) => ({ _id, tenantId, role: 'USER' }) as unknown as IUser,
    isPrincipalActive: async () => true,
  });
  const guard = createChannelHandlers({
    db,
    serviceToken: () => serviceToken,
    config: async (req, channel) => policy.requestConfig(req, channel),
    getAgent: async () => ({ id: 'agent-a' }),
    verifySlackToken: async () => null,
    logError: () => {},
  }).service;
  const onError = jest.fn();
  const observed: Array<string | undefined> = [];
  const sendScore = jest.fn(async () => {
    observed.push(getTenantId());
  });
  const runtime = createChannelFeedbackRuntime({
    getWorkerSettings: policy.workerSettings,
    guard,
    hostDeps: { ...deps, getPolicy: policy.feedbackPolicy, sendScore },
    workerDeps: { listChannels: db.listAgentChannelTenants, onError },
  });
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', runtime.handlers.reaction);
  try {
    // A real durable event is recovered at startup, even when the default tenant is disabled.
    await scope(() =>
      feedback.record(
        {
          tenantId,
          channelId: 'channel-a',
          channelRevision: 'rev-1',
          agentId: 'agent-a',
          teamId: 'T1',
        },
        { ...event, action: 'added' },
      ),
    );
    await runtime.initialize();
    expect(onError).not.toHaveBeenCalled();
    expect(sendScore).toHaveBeenCalledTimes(1);
    expect(observed).toEqual([tenantId]);
    expect(readConfig.mock.calls.some(([options]) => options.baseOnly)).toBe(true);
    expect(
      readConfig.mock.calls.some(
        ([options]) => options.tenantId === tenantId && options.userId === 'user-a',
      ),
    ).toBe(true);
    await post({ ...event, eventId: 'Ev2', eventTimestampUs: event.eventTimestampUs + 1 })
      .set('x-tenant-id', 'forged-tenant')
      .expect(404);
    await post({ ...event, eventId: 'Ev2', eventTimestampUs: event.eventTimestampUs + 1 }).expect(
      200,
    );
  } finally {
    await runtime.stop();
  }
});
