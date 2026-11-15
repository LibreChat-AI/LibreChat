import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  channelConfigSchema,
  Permissions,
  PermissionTypes,
  PermissionBits,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createChannelIdentityStorage,
  createChannelFeedbackStorage,
  createChannelRunStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { AppConfig, DiscordCommandScope, ChannelRunRecord } from '@librechat/data-schemas';
import type { DiscordAgentChannel, ChannelRating } from 'librechat-data-provider';
import { createDiscordFeedbackHandler, createDiscordFeedbackProjection } from './feedback';
import { createChannelApplicationPolicy } from '../applicationPolicy';
import { getLangfuseDestinationId } from '~/langfuse/destinations';
import { createChannelFeedbackRuntime } from '../feedbackRuntime';
import { createChannelFeedbackHost } from '../feedbackHost';
import { sendFeedbackScore } from '~/langfuse/feedback';
import { createChannelAuthority } from '../authority';
import { createChannelRunHandlers } from '../runs';
import { createChannelHandlers } from '../service';

const db = new mongoose.Mongoose();
const tenantId = 'discord-feedback-api';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const messageId = '678901234567890123';
const runId = '18d821ae-3497-4b1f-8656-e27aa98579f1';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
const destinationId = getLangfuseDestinationId('https://langfuse.invalid', 'fixture-project');
const originalEnv = { ...process.env };
let mongo: MongoMemoryReplSet;
let methods: ReturnType<typeof createMethods>;
let channel: DiscordAgentChannel;
let applicationRevision: string;
let config: AppConfig;
let creatorPolicy: AppConfig | undefined;
let onProjectionRead: () => Promise<void> = async () => {};
let now: number;
let fetched: jest.SpiedFunction<typeof fetch>;
let runtime: ReturnType<typeof createChannelFeedbackRuntime> | undefined;
let feedback: ReturnType<typeof createChannelFeedbackHost>;
const storage = createChannelFeedbackStorage(db);
const inbox = createDiscordInboxStorage(db);
const policy = createChannelApplicationPolicy({
  readAppConfig: async (options) =>
    options?.userId === '000000000000000000000002' ? (creatorPolicy ?? config) : config,
  findUser: (query) => methods.findUser(query),
  isPrincipalActive: async (id) =>
    Boolean(
      await db.models.User.exists({ _id: id, agentTriggerDeletionStartedAt: { $exists: false } }),
    ),
});
const hostDeps = () => ({
  channels: methods,
  storage,
  getPolicy: policy.feedbackPolicy,
  sendScore: sendFeedbackScore,
  maxConflictRetries: 5,
  exportTimeoutMs: 1000,
  exportLeaseMs: 10000,
  exportRetryMs: 1000,
  now: () => now,
});
async function job(
  id = '700000000000000001',
  rating: ChannelRating = 'thumbsUp',
): Promise<DiscordCommandScope> {
  unwrap(
    await inbox.submit(
      {
        eventId: id,
        applicationId,
        applicationRevision,
        guildId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        externalChannelId,
        externalUserId,
        action: { kind: 'feedback', reference: runId, messageId, rating },
        encryptedToken: 'sealed-token',
        tokenHash: 'a'.repeat(64),
        expiresAt: now + 900000,
      },
      now,
    ),
  );
  const record = await inbox.claim(applicationId, 'worker', now);
  if (!record || record.routing === 'inspection') throw new Error('Missing claim');
  return {
    record,
    fence: { applicationId, eventId: id, owner: 'worker', epoch: record.leaseEpoch },
    principal: {
      userId,
      channelRevision: channel.revision,
      linkId: 'link',
      linkRevision: 'link-revision',
    },
  };
}
async function finish(work: DiscordCommandScope) {
  unwrap(await inbox.prepareReply(work.fence, 'sealed-reply', now));
  await inbox.finish(work.fence, 'completed', now);
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
  methods = createMethods(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  now = Date.now();
  creatorPolicy = undefined;
  onProjectionRead = async () => {};
  for (const key of Object.keys(process.env))
    if (key.startsWith('LANGFUSE_')) delete process.env[key];
  Object.assign(process.env, {
    LANGFUSE_PUBLIC_KEY: 'fixture-public',
    LANGFUSE_SECRET_KEY: 'fixture-secret',
    LANGFUSE_PROJECT_ID: 'fixture-project',
    LANGFUSE_BASE_URL: 'https://langfuse.invalid',
  });
  fetched = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  config = {
    interfaceConfig: { feedback: true },
    endpoints: {
      agents: {
        channels: channelConfigSchema.parse({ enabled: true, discord: { enabled: true } }),
      },
    },
  } as AppConfig;
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'Message',
      'ResponseScope',
      'AgentChannel',
      'ChannelScope',
      'ChannelRun',
      'ChannelLane',
      'ChannelIdentity',
      'ChannelReply',
      'ChannelFeedbackEvent',
      'ChannelFeedback',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordReservation',
      'DiscordInbox',
      'DiscordReceipt',
      'DiscordRoute',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create({
      _id: userId,
      tenantId,
      email: 'user@example.test',
      provider: 'local',
    });
    const installations = createDiscordInstallationStorage(db);
    applicationRevision = unwrap(
      await installations.configureApplication({
        actorId: userId,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'sealed',
        encryptedClientSecret: 'sealed',
      }),
    ).revision;
    const guild = unwrap(
      await installations.connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision,
        guildId,
        guildName: 'Guild',
      }),
    );
    await methods.createAgentChannel({
      type: 'discord',
      tenantId,
      channelId: 'channel',
      agentId: 'agent',
      createdBy: userId,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'initial',
      installationId: guild.installationId,
      installationRevision: guild.revision,
      applicationRevision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    });
    unwrap(
      await createDiscordRouteStorage(db).assign({
        actorId: userId,
        installationId: guild.installationId,
        installationRevision: guild.revision,
        applicationRevision,
        channelId: 'channel',
        channelRevision: 'initial',
        externalChannelId,
      }),
    );
    const current = await methods.getAgentChannelMetadata('channel');
    if (!current || current.type !== 'discord') throw new Error('Missing binding');
    channel = current;
    const identity = {
      provider: 'discord' as const,
      tenantId,
      channelId: channel.channelId,
      channelRevision: channel.revision,
      agentId: channel.agentId,
      applicationId,
      guildId,
      externalUserId,
    };
    if (
      !(await createChannelIdentityStorage(db).saveChannelIdentity(
        {
          tenantId,
          identity,
          userId,
          linkId: 'link',
          revision: 'link-revision',
          state: 'active',
          ticketHash: 'ticket',
          ticketExpiresAtMs: now + 900000,
          expiresAtMs: now + 900000,
        },
        null,
        applicationRevision,
      ))
    )
      throw new Error('Missing identity');
    await db.models.ChannelRun.create({
      tenantId,
      channelId: channel.channelId,
      agentId: channel.agentId,
      runId,
      laneId: 'lane',
      state: 'delivered',
      sequence: 1,
      payloadHash: 'hash',
      receivedAt: now,
      leaseEpoch: 1,
      leaseExpiresAt: 0,
      cancellationRequested: false,
      principal: {
        userId,
        channelRevision: channel.revision,
        linkId: 'link',
        linkRevision: 'link-revision',
      },
      admission: {
        eventId: '600000000000000001',
        externalChannelId,
        externalThreadKey: 'thread',
        externalMessageKey: 'input',
        actor: { provider: 'discord', applicationId, guildId, externalUserId },
        input: 'question',
      },
      execution: {
        protocol: 'responses',
        requestId: 'request',
        responseId: 'response',
        conversationId: 'conversation',
        parentMessageId: 'parent',
      },
      snapshot: { status: 'completed', responseId: 'response', text: 'answer', elapsedMs: 1 },
      plan: {
        revision: 'plan',
        rendererVersion: 'discord-text-v1',
        parts: [{ operationId: 'answer', kind: 'message', required: true, text: 'answer' }],
      },
      receipts: [
        {
          operationId: 'answer',
          outcome: 'confirmed',
          attempts: 1,
          externalMessageKey: `${externalChannelId}:${messageId}`,
        },
      ],
    });
    await db.models.Message.create({
      tenantId,
      user: userId,
      conversationId: 'conversation',
      messageId: 'response',
      isCreatedByUser: false,
      isTemporary: false,
      sender: 'Agent',
      endpoint: 'agents',
      text: 'answer',
      langfuseSampled: true,
      langfuseDestinationIds: [destinationId],
      langfuseCentralTraceExportEnabled: true,
    });
  });
  feedback = createChannelFeedbackHost(hostDeps());
});
afterEach(async () => {
  await runtime?.stop();
  runtime = undefined;
  fetched.mockRestore();
  process.env = { ...originalEnv };
});

it('records native controls and exports the shared stable score with safe private acknowledgements', () =>
  scope(async () => {
    const callback = createDiscordFeedbackHandler({ feedback });
    const first = await job();
    const acknowledgement = await callback(first.record, first.fence, first.principal);
    expect(acknowledgement).toEqual({ content: 'Feedback received.' });
    expect(JSON.stringify(acknowledgement)).not.toMatch(/response|conversation|trace|sealed|token/);
    await finish(first);
    expect(await feedback.flush(tenantId, 10)).toBe(1);
    const second = await job('700000000000000002', 'thumbsDown');
    await callback(second.record, second.fence, second.principal);
    await finish(second);
    expect(await feedback.flush(tenantId, 10)).toBe(1);
    const bodies = fetched.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({ value: 1, metadata: { source: 'channel' } });
    expect(bodies[1]).toMatchObject({ id: bodies[0].id, timestamp: bodies[0].timestamp, value: 0 });
    expect(await db.models.ChannelFeedback.countDocuments()).toBe(1);
  }));

it.each([
  'feedback',
  'channels',
  'discord',
  'sampled',
  'destination',
  'central',
  'temporary',
  'unknown_temporary',
])('denies native recording when %s policy cannot export the retained source', (change) =>
  scope(async () => {
    const work = await job();
    if (change === 'feedback') config.interfaceConfig!.feedback = false;
    if (change === 'channels') config.endpoints!.agents!.channels!.enabled = false;
    if (change === 'discord') config.endpoints!.agents!.channels!.discord!.enabled = false;
    if (change === 'sampled')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseSampled: false } },
      );
    if (change === 'destination')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseDestinationIds: ['other'] } },
      );
    if (change === 'central')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseCentralTraceExportEnabled: false } },
      );
    if (change === 'temporary')
      await db.models.Message.updateOne({ messageId: 'response' }, { $set: { isTemporary: true } });
    if (change === 'unknown_temporary')
      await db.models.Message.updateOne({ messageId: 'response' }, { $unset: { isTemporary: '' } });
    const result = await createDiscordFeedbackHandler({ feedback })(
      work.record,
      work.fence,
      work.principal,
    );
    expect(result).toEqual({ content: 'Feedback is unavailable for this reply.' });
    expect(await db.models.ChannelFeedback.countDocuments()).toBe(0);
    expect(fetched).not.toHaveBeenCalled();
  }),
);

it('rechecks current feedback and trace policy before a delayed export', () =>
  scope(async () => {
    unwrap(await feedback.recordDiscordFeedback(await job()));
    config.interfaceConfig!.feedback = false;
    await feedback.flush(tenantId, 10);
    expect(fetched).not.toHaveBeenCalled();
    config.interfaceConfig!.feedback = true;
    now += 1001;
    await db.models.Message.updateOne({ messageId: 'response' }, { $set: { isTemporary: true } });
    await feedback.flush(tenantId, 10);
    expect(fetched).not.toHaveBeenCalled();
  }));

it('rechecks the current link and canonical delivery source before export', () =>
  scope(async () => {
    unwrap(await feedback.recordDiscordFeedback(await job()));
    await db.models.ChannelIdentity.updateOne({ linkId: 'link' }, { $set: { state: 'revoked' } });
    await feedback.flush(tenantId, 10);
    expect(fetched).not.toHaveBeenCalled();
  }));

it('shares runtime lifecycle and wake-up with the existing export worker', () =>
  scope(async () => {
    const guard = createChannelHandlers({
      db: methods,
      serviceToken: () => 'private-service-token',
      config: policy.requestConfig,
      getAgent: async () => ({ id: 'agent' }),
      verifySlackToken: async () => null,
      logError: () => {},
    }).service;
    runtime = createChannelFeedbackRuntime({
      hostDeps: hostDeps(),
      guard,
      getWorkerSettings: policy.workerSettings,
      workerDeps: { listChannels: methods.listAgentChannelTenants, onError: () => {} },
    });
    const work = await job();
    expect(await runtime.recordDiscordFeedback(work)).toMatchObject({ ok: false });
    await runtime.initialize();
    let observed!: () => void;
    const sent = new Promise<void>((resolve) => {
      observed = resolve;
    });
    fetched.mockImplementation(async () => {
      observed();
      return new Response(null, { status: 200 });
    });
    expect(await runtime.recordDiscordFeedback(work)).toMatchObject({ ok: true });
    await sent;
    await runtime.stop();
    expect(await runtime.recordDiscordFeedback(work)).toMatchObject({ ok: false });
    expect(fetched).toHaveBeenCalledTimes(1);
  }));

const project = createDiscordFeedbackProjection({
  storage,
  getPolicy: async (subject) => {
    const snapshot = await policy.feedbackPolicy(subject);
    await onProjectionRead();
    return snapshot;
  },
});
async function currentRun(): Promise<ChannelRunRecord> {
  const run = await db.models.ChannelRun.findOne({ runId }).lean<ChannelRunRecord>();
  if (!run) throw new Error('Missing canonical run');
  return run;
}
it('projects eligibility before delivery without admitting feedback on an unconfirmed answer', () =>
  scope(async () => {
    await db.models.ChannelRun.updateOne(
      { runId },
      { $set: { state: 'delivering', receipts: [] } },
    );
    expect(await project(await currentRun())).toBe(true);
    expect(await feedback.recordDiscordFeedback(await job())).toMatchObject({ ok: false });
    expect(await db.models.ChannelFeedback.countDocuments()).toBe(0);
    expect(fetched).not.toHaveBeenCalled();
  }));
it.each([
  'feedback',
  'channels',
  'discord',
  'sampled',
  'destination',
  'central',
  'temporary',
  'unknown_temporary',
  'expired',
  'closed',
  'deleted',
  'authorship',
  'response',
  'conversation',
  'principal',
  'link',
  'executing',
  'failed',
  'cancelled',
  'slack',
])('omits native controls for ineligible retained run variant %s', (change) =>
  scope(async () => {
    if (change === 'feedback') config.interfaceConfig!.feedback = false;
    if (change === 'channels') config.endpoints!.agents!.channels!.enabled = false;
    if (change === 'discord') config.endpoints!.agents!.channels!.discord!.enabled = false;
    if (change === 'sampled')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseSampled: false } },
      );
    if (change === 'destination')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseDestinationIds: ['other'] } },
      );
    if (change === 'central')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { langfuseCentralTraceExportEnabled: false } },
      );
    if (change === 'temporary')
      await db.models.Message.updateOne({ messageId: 'response' }, { $set: { isTemporary: true } });
    if (change === 'unknown_temporary')
      await db.models.Message.updateOne({ messageId: 'response' }, { $unset: { isTemporary: '' } });
    if (change === 'expired')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { expiredAt: new Date(now - 1) } },
      );
    if (change === 'closed') {
      unwrap(await feedback.recordDiscordFeedback(await job()));
      await db.models.ResponseScope.updateMany({}, { $set: { closed: true } });
    }
    if (change === 'deleted') await db.models.Message.deleteOne({ messageId: 'response' });
    if (change === 'authorship')
      await db.models.Message.updateOne(
        { messageId: 'response' },
        { $set: { isCreatedByUser: true } },
      );
    if (change === 'response')
      await db.models.ChannelRun.updateOne({ runId }, { $set: { 'snapshot.responseId': 'wrong' } });
    if (change === 'conversation')
      await db.models.ChannelRun.updateOne(
        { runId },
        { $set: { 'execution.conversationId': 'wrong' } },
      );
    if (change === 'principal') {
      await db.models.User.create({
        _id: '000000000000000000000002',
        tenantId,
        email: 'other@example.test',
        provider: 'local',
      });
      await db.models.ChannelRun.updateOne(
        { runId },
        { $set: { 'principal.userId': '000000000000000000000002' } },
      );
    }
    if (change === 'link')
      await db.models.ChannelRun.updateOne({ runId }, { $unset: { 'principal.linkRevision': '' } });
    if (change === 'executing')
      await db.models.ChannelRun.updateOne({ runId }, { $set: { state: 'executing' } });
    if (change === 'failed')
      await db.models.ChannelRun.updateOne({ runId }, { $set: { 'snapshot.status': 'failed' } });
    if (change === 'cancelled')
      await db.models.ChannelRun.updateOne({ runId }, { $set: { cancellationRequested: true } });
    const run = await currentRun();
    if (change === 'slack') run.admission.actor = { teamId: 'T1', appId: 'A1', externalUserId };
    expect(await project(run)).toBe(false);
    expect(fetched).not.toHaveBeenCalled();
  }),
);

async function runApp() {
  await db.models.Role.updateOne(
    { name: 'USER' },
    {
      $set: {
        permissions: {
          [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
          [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        },
      },
    },
    { upsert: true },
  );
  const authority = createChannelAuthority({
    channels: methods,
    identityStorage: createChannelIdentityStorage(db),
    getConfig: async (user) =>
      channelConfigSchema.parse(
        (await policy.appConfig(tenantId, String(user._id))).endpoints?.agents?.channels,
      ),
    findUser: (id) => methods.findUser({ _id: id }),
    getRole: (name) => methods.getRoleByName(name),
    isPrincipalActive: async (id) =>
      Boolean(
        await db.models.User.exists({ _id: id, agentTriggerDeletionStartedAt: { $exists: false } }),
      ),
    getAgentPermissions: async () => PermissionBits.VIEW,
  });
  await db.models.ChannelRun.updateOne({ runId }, { $set: { state: 'delivering', receipts: [] } });
  await db.models.ChannelLane.create({
    tenantId,
    userId,
    channelId: channel.channelId,
    laneId: 'lane',
    nextSequence: 2,
    activeRunId: runId,
  });
  const handlers = createChannelHandlers({
    db: methods,
    serviceToken: () => 'private-service-token-for-feedback',
    config: policy.requestConfig,
    getAgent: async () => ({ id: 'agent' }),
    verifySlackToken: async () => null,
    logError: () => {},
  });
  const runs = createChannelRunHandlers({
    storage: createChannelRunStorage(db),
    guard: handlers.service,
    resolvePrincipal: authority.resolvePrincipal,
    feedbackEnabled: project,
    advance: async () => {
      throw new Error('Unexpected execution');
    },
    retireForAuthorityLoss: async () => 'stopped',
  });
  const app = express();
  app.use(express.json());
  app.post('/service/:channelId/claim', runs.claim);
  return app;
}
async function claimView(app: express.Express) {
  return request(app)
    .post('/service/channel/claim')
    .auth('private-service-token-for-feedback', { type: 'bearer' })
    .set('x-tenant-id', tenantId)
    .send({ owner: 'worker' });
}
it('decorates the real service run view using the linked principal instead of the channel creator', () =>
  scope(async () => {
    const creatorId = '000000000000000000000002';
    await db.models.User.create({
      _id: creatorId,
      tenantId,
      email: 'creator@example.test',
      provider: 'local',
    });
    await db.models.AgentChannel.updateOne(
      { channelId: channel.channelId },
      { $set: { createdBy: creatorId } },
    );
    creatorPolicy = { ...config, interfaceConfig: { ...config.interfaceConfig, feedback: false } };
    const response = await claimView(await runApp());
    expect(response.status).toBe(200);
    expect(response.body.run.feedbackEnabled).toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(
      /fixture-secret|fixture-public|langfuse.invalid|destinationIds|principalId|sealed/,
    );
    expect(
      await db.models.ChannelRun.exists({ runId, feedbackEnabled: { $exists: true } }),
    ).toBeNull();
  }));
it('rechecks live link authority after run projection policy work', () =>
  scope(async () => {
    const app = await runApp();
    onProjectionRead = async () => {
      await db.models.ChannelIdentity.updateOne({ linkId: 'link' }, { $set: { state: 'revoked' } });
    };
    const response = await claimView(app);
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: 'channel_authority_changed' });
  }));

it('hides controls on optional projection failure without exposing private diagnostics or losing the answer', () =>
  scope(async () => {
    const app = await runApp();
    onProjectionRead = async () => {
      throw new Error('private provider credential');
    };
    const response = await claimView(app);
    expect(response.status).toBe(200);
    expect(response.body.run.feedbackEnabled).toBe(false);
    expect(response.body.run.snapshot.text).toBe('answer');
    expect(JSON.stringify(response.body)).not.toContain('private provider credential');
  }));
