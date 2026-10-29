import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createChannelFeedbackStorage,
  createChannelRunStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
  SYSTEM_TENANT_ID,
} from '@librechat/data-schemas';
import type { AppConfig, ChannelRunRecord } from '@librechat/data-schemas';
import type { ChannelFeedbackHostDependencies } from './feedbackHost';
import { getLangfuseDestinationId } from '~/langfuse/destinations';
import { createChannelFeedbackHandlers } from './feedbackHttp';
import { createChannelFeedbackWorker } from './feedbackWorker';
import { createChannelFeedbackHost } from './feedbackHost';
import { sendFeedbackScore } from '~/langfuse/feedback';
import { traceIdForMessage } from '~/langfuse/trace';
import { createChannelHandlers } from './service';

const tenantId = 'tenant-a';
const serviceToken = 'local-channel-feedback-test-token-32-characters';
let mongo: MongoMemoryServer;
let app: express.Express;
let db: ReturnType<typeof createMethods>;
let feedback: ReturnType<typeof createChannelFeedbackHost>;
let deps: ChannelFeedbackHostDependencies;
let config: AppConfig;
let central: boolean | null;
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
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
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
  await runAsSystem(async () => {
    for (const name of [
      'AgentChannel',
      'ChannelRun',
      'ChannelReply',
      'ChannelFeedback',
      'ChannelFeedbackEvent',
      'Message',
    ])
      await mongoose.models[name].deleteMany({});
  });
  central = true;
  config = {
    interfaceConfig: { feedback: true },
    endpoints: { agents: { channels: { enabled: true } } },
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
      runId: 'run-a',
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
        requestId: 'request-a',
        conversationId: 'conversation-a',
        parentMessageId: 'parent-a',
      },
      snapshot: { responseId: 'message-a', status: 'completed', text: 'answer', elapsedMs: 1 },
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
    await mongoose.models.ChannelRun.create(run);
    await mongoose.models.Message.create({
      tenantId,
      messageId: 'message-a',
      conversationId: 'conversation-a',
      user: 'user-a',
      isCreatedByUser: false,
      text: 'answer',
      langfuseRunId: 'actual-run',
      langfuseSampled: true,
      langfuseDestinationIds: ['recorded-project'],
      feedback: { rating: 'thumbsDown' },
    });
  });
  deps = {
    channels: db,
    runs: createChannelRunStorage(mongoose),
    storage: createChannelFeedbackStorage(mongoose),
    getAppConfig: async () => config,
    getMessage: (filter) => db.getMessage(filter),
    currentTracePolicy: async () =>
      central === null ? null : { centralTraceExportEnabled: central },
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
    deleteApiKey: async () => false,
    verifySlackToken: async () => null,
    logError: () => {},
  });
  const handlers = createChannelFeedbackHandlers({
    guard: channel.service,
    runs: deps.runs,
    feedback,
  });
  app = express();
  app.use(express.json());
  app.post('/service/:channelId/reactions', handlers.reaction);
});

test('resolves confirmed delivered receipt and actual message trace, keeping browser feedback untouched', async () => {
  const result = await post().expect(200);
  expect(result.body).toEqual({
    messageId: 'message-a',
    conversationId: 'conversation-a',
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
    const message = await db.getMessage({ user: 'user-a', messageId: 'message-a' });
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
          { messageId: 'message-a' },
          {
            $set: {
              isTemporary: isTemporary === true,
              langfuseDestinationIds: [
                getLangfuseDestinationId('https://langfuse.invalid', 'recorded-project'),
              ],
            },
          },
        ),
      );
      await post().expect(200);
      await scope(async () => {
        const reply = await mongoose.models.ChannelReply.findOne({ messageId: 'message-a' }).lean<{
          isTemporary?: boolean;
        }>();
        const ledger = await mongoose.models.ChannelFeedback.findOne({}).lean<{
          mapping: { isTemporary?: boolean };
        }>();
        const receipt = await mongoose.models.ChannelFeedbackEvent.findOne({}).lean<{
          mapping: { isTemporary?: boolean };
        }>();
        expect(reply?.isTemporary).toBe(isTemporary === true);
        expect(ledger?.mapping.isTemporary).toBe(isTemporary === true);
        expect(receipt?.mapping.isTemporary).toBe(isTemporary === true);
        if (isTemporary === undefined) {
          // Simulate an accepted legacy receipt, without inventing provenance from today's message.
          await mongoose.models.ChannelReply.updateMany({}, { $unset: { isTemporary: '' } });
          for (const name of ['ChannelFeedback', 'ChannelFeedbackEvent']) {
            await mongoose.models[name].updateMany({}, { $unset: { 'mapping.isTemporary': '' } });
          }
        }
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
    mongoose.models.ChannelRun.updateOne({ runId: 'run-a' }, { $set: { state: 'delivering' } }),
  );
  await post().expect(404);
  expect(deps.sendScore).not.toHaveBeenCalled();
});

test('rejects changed channel revision or a user-authored/cross-principal assistant record', async () => {
  await scope(async () =>
    mongoose.models.ChannelRun.updateOne(
      { runId: 'run-a' },
      { $set: { 'principal.channelRevision': 'old' } },
    ),
  );
  await post().expect(404);
  await scope(async () => {
    await mongoose.models.ChannelRun.updateOne(
      { runId: 'run-a' },
      { $set: { 'principal.channelRevision': 'rev-1' } },
    );
    await mongoose.models.Message.updateOne(
      { messageId: 'message-a' },
      { $set: { isCreatedByUser: true } },
    );
  });
  await post().expect(404);
  expect(deps.sendScore).not.toHaveBeenCalled();
});

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

test('missing trace provenance is explicit unavailable rather than guessed sampling or routing', async () => {
  await scope(async () =>
    mongoose.models.Message.updateOne(
      { messageId: 'message-a' },
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
