import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  DiscordChannelReplyMapping,
  DiscordGuildThreadSource,
  ChannelRating,
  DiscordAgentChannel,
} from 'librechat-data-provider';
import type { ChannelRunRecord } from '~/models/channelRun';
import {
  createChannelFeedbackModel,
  createChannelFeedbackEventModel,
} from '~/models/channelFeedback';
import { createChannelFeedbackStorage, ChannelFeedbackAuthorityError } from './channelFeedback';
import { createDiscordInboxResolutionStorage } from './discordInboxResolution';
import { isLaterChannelFeedbackEvent } from './channelFeedbackProtocol';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createDiscordGatewayStorage } from './discordGateway';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordThreadStorage } from './discordThread';
import { createDiscordInboxStorage } from './discordInbox';
import { createDiscordRouteStorage } from './discordRoute';
import { createAgentChannelMethods } from './channel';
import { closeResponseScopes } from './responseScope';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const tenantId = 'discord-feedback';
const userId = '000000000000000000000001';
const otherId = '000000000000000000000002';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const messageId = '678901234567890123';
const secondMessageId = '678901234567890124';
const runId = '18d821ae-3497-4b1f-8656-e27aa98579f1';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let now: number;
let mapping: DiscordChannelReplyMapping;
let channel: DiscordAgentChannel;
let applicationRevision: string;
const installations = createDiscordInstallationStorage(db);
const inbox = createDiscordInboxStorage(db);
const storage = createChannelFeedbackStorage(db);
const channels = createAgentChannelMethods(db);
const principal = () => ({
  userId,
  channelRevision: channel.revision,
  linkId: 'link',
  linkRevision: 'link-revision',
});
const actor = () => ({
  provider: 'discord' as const,
  tenantId,
  channelId: channel.channelId,
  channelRevision: channel.revision,
  agentId: channel.agentId,
  applicationId,
  guildId,
});
async function job(eventId: string, rating: ChannelRating, source = messageId) {
  value(
    await inbox.submit(
      {
        eventId,
        applicationId,
        applicationRevision,
        guildId,
        channelId: channel.channelId,
        channelRevision: channel.revision,
        agentId: channel.agentId,
        externalChannelId,
        externalUserId,
        action: { kind: 'feedback', reference: runId, messageId: source, rating },
        encryptedToken: 'private-token',
        tokenHash: 'a'.repeat(64),
        expiresAt: now + 900000,
      },
      now,
    ),
  );
  const record = await inbox.claim(applicationId, 'worker', now);
  if (!record || record.routing === 'inspection' || record.eventId !== eventId)
    throw new Error('Missing feedback claim');
  return {
    record,
    fence: { applicationId, eventId, owner: 'worker', epoch: record.leaseEpoch },
    principal: principal(),
  };
}
async function vote(eventId: string, rating: ChannelRating, source = messageId) {
  const work = await job(eventId, rating, source);
  const result = await storage.recordDiscordFeedback(
    work,
    { ...mapping, externalMessageKey: `${externalChannelId}:${source}` },
    now,
  );
  value(await inbox.prepareReply(work.fence, 'private-reply', now));
  expect(await inbox.finish(work.fence, 'completed', now)).toBe(true);
  return result;
}
const ledger = () => createChannelFeedbackModel(db).findOne().lean();
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false, readPreference: 'secondaryPreferred' });
  createModels(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  jest.restoreAllMocks();
  now = Date.now();
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
      'DiscordThreadRoute',
      'DiscordThreadPin',
      'ResourceLock',
      'DiscordReceipt',
      'DiscordRoute',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create(
      [userId, otherId].map((_id) => ({
        _id,
        tenantId,
        email: `${_id}@example.test`,
        provider: 'local',
      })),
    );
    applicationRevision = value(
      await installations.configureApplication({
        actorId: userId,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'private-token',
        encryptedClientSecret: 'private-secret',
      }),
    ).revision;
    const guild = value(
      await installations.connectGuild({
        actorId: userId,
        applicationId,
        applicationRevision,
        guildId,
        guildName: 'Guild',
      }),
    );
    await channels.createAgentChannel({
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
    value(
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
    const parent = await channels.getAgentChannelMetadata('channel');
    if (!parent || parent.type !== 'discord') throw new Error('Missing binding');
    channel = parent;
    if (
      !(await createChannelIdentityStorage(db).saveChannelIdentity(
        {
          tenantId,
          identity: { ...actor(), externalUserId },
          linkId: 'link',
          revision: 'link-revision',
          state: 'active',
          userId,
          ticketHash: 'ticket',
          ticketExpiresAtMs: now + 900000,
          expiresAtMs: now + 900000,
        },
        null,
        applicationRevision,
      ))
    )
      throw new Error('Missing active feedback identity');
    mapping = {
      ...actor(),
      externalChannelId,
      externalUserId,
      linkId: 'link',
      linkRevision: 'link-revision',
      externalMessageKey: `${externalChannelId}:${messageId}`,
      runId,
      responseId: 'response',
      messageId: 'response',
      conversationId: 'conversation',
      principalId: userId,
      traceId: 'trace',
      sampled: true,
      destinationIds: ['destination'],
      centralTraceExportEnabled: false,
    };
    const delivered: ChannelRunRecord = {
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
      principal: principal(),
      admission: {
        eventId: '700000000000000000',
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
        parts: [messageId, secondMessageId].map((id) => ({
          operationId: id,
          kind: 'message',
          required: true,
          text: 'answer',
        })),
      },
      receipts: [messageId, secondMessageId].map((id) => ({
        operationId: id,
        outcome: 'confirmed',
        attempts: 1,
        externalMessageKey: `${externalChannelId}:${id}`,
      })),
    };
    await db.models.ChannelRun.create(delivered);
    await db.models.Message.create({
      tenantId,
      user: userId,
      conversationId: 'conversation',
      messageId: 'response',
      isCreatedByUser: false,
      text: 'answer',
      sender: 'Agent',
      endpoint: 'agents',
      model: 'agent',
      langfuseSampled: true,
    });
  });
});

it('projects one idempotent replaceable vote using exact snowflake order across final delivery parts', () =>
  scope(async () => {
    const work = await job('9007199254740992', 'thumbsUp');
    const concurrent = await Promise.all([
      storage.recordDiscordFeedback(work, mapping, now),
      storage.recordDiscordFeedback(work, mapping, now),
    ]);
    for (const result of concurrent)
      expect(result).toMatchObject({ ok: true, value: { feedback: { rating: 'thumbsUp' } } });
    expect(await ledger()).toMatchObject({
      revision: 1,
      rating: 'thumbsUp',
      votes: [expect.objectContaining({ eventId: '9007199254740992' })],
    });
    value(await inbox.prepareReply(work.fence, 'reply', now));
    await inbox.finish(work.fence, 'completed', now);
    expect(await vote('9007199254740993', 'thumbsDown', secondMessageId)).toMatchObject({
      ok: true,
    });
    expect(await vote('9007199254740991', 'thumbsUp')).toMatchObject({
      ok: true,
      value: { feedback: { rating: 'thumbsDown' } },
    });
    expect(await vote('9007199254740994', 'thumbsDown')).toMatchObject({ ok: true });
    expect(await ledger()).toMatchObject({
      revision: 2,
      rating: 'thumbsDown',
      votes: [expect.objectContaining({ eventId: '9007199254740994' })],
    });
    expect(await db.models.ChannelFeedback.countDocuments()).toBe(1);
    expect(await db.models.ChannelFeedbackEvent.countDocuments({ processed: false })).toBe(0);
    expect(await db.models.ChannelFeedbackEvent.countDocuments({ receiptExpiresAt: null })).toBe(1);
    const saved = await ledger();
    expect(saved?.votes).toHaveLength(1);
    expect(JSON.stringify(saved)).not.toContain('eventTimestampUs');
  }));

it('does not trust caller copies of the canonical feedback action', () =>
  scope(async () => {
    const work = await job('700000000000000001', 'thumbsUp');
    work.record.action = { kind: 'feedback', reference: runId, messageId, rating: 'thumbsDown' };
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({
      ok: true,
      value: { feedback: { rating: 'thumbsUp' } },
    });
    await db.models.DiscordInbox.updateOne(
      { eventId: work.record.eventId },
      { $set: { action: { kind: 'feedback', reference: runId, messageId, rating: 'thumbsDown' } } },
    );
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({
      ok: false,
      error: { code: 'event_conflict' },
    });
  }));

it.each([
  'actor',
  'run',
  'message',
  'unconfirmed',
  'progress',
  'trace',
  'orphan_receipt',
  'principal',
  'link',
  'application',
  'guild',
  'route',
  'revision',
  'lease',
  'reply',
])('rejects stale or forged %s authority without projecting a vote', (change) =>
  scope(async () => {
    const work = await job('700000000000000001', 'thumbsUp');
    let source = mapping;
    if (change === 'actor') source = { ...mapping, externalUserId: '567890123456789013' };
    if (change === 'run') source = { ...mapping, runId: 'other-run' };
    if (change === 'message')
      source = { ...mapping, externalMessageKey: `${externalChannelId}:999` };
    if (change === 'unconfirmed')
      await db.models.ChannelRun.updateOne(
        { runId },
        { $set: { 'receipts.0.outcome': 'unknown' } },
      );
    if (change === 'progress')
      await db.models.ChannelRun.updateOne(
        { runId },
        {
          $set: {
            receipts: [],
            progress: { outcome: 'confirmed', externalMessageKey: mapping.externalMessageKey },
          },
        },
      );
    if (change === 'trace')
      await db.models.ChannelRun.updateOne(
        { runId },
        {
          $set: {
            'plan.parts.0.traceUrl': 'https://chat.example/trace',
            'plan.parts.0.required': false,
          },
        },
      );
    if (change === 'orphan_receipt')
      await db.models.ChannelRun.updateOne(
        { runId },
        { $set: { 'plan.parts.0.operationId': 'unrelated' } },
      );
    if (change === 'principal') work.principal = { ...work.principal, userId: otherId };
    if (change === 'link')
      await db.models.ChannelIdentity.updateOne({ linkId: 'link' }, { $set: { state: 'revoked' } });
    if (change === 'application')
      value(
        await installations.configureApplication({
          actorId: userId,
          applicationId,
          botUserId,
          publicKey: 'b'.repeat(64),
          expectedRevision: applicationRevision,
        }),
      );
    if (change === 'guild')
      value(
        await installations.disconnectGuild({
          actorId: userId,
          installationId: channel.installationId,
          expectedRevision: channel.installationRevision,
        }),
      );
    if (change === 'route')
      await db.models.DiscordRoute.deleteOne({ channelId: channel.channelId });
    if (change === 'revision')
      await db.models.AgentChannel.updateOne(
        { channelId: channel.channelId },
        { $set: { revision: 'changed' } },
      );
    if (change === 'lease')
      await inbox.claim(applicationId, 'replacement', work.record.leaseExpiresAt);
    if (change === 'reply') value(await inbox.prepareReply(work.fence, 'reply', now));
    if (['unconfirmed', 'progress', 'trace', 'orphan_receipt'].includes(change))
      expect(await storage.readReplySource(actor(), mapping.externalMessageKey)).toBeNull();
    expect(await storage.recordDiscordFeedback(work, source, now)).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await db.models.ChannelFeedback.countDocuments()).toBe(0);
    expect(await db.models.ChannelFeedbackEvent.countDocuments()).toBe(0);
  }),
);

it('rejects noncanonical authored messages, expired sources and closed response/account anchors', () =>
  scope(async () => {
    const work = await job('700000000000000001', 'thumbsUp');
    await db.models.Message.updateOne(
      { messageId: mapping.messageId },
      { $set: { isUserSubmitted: true } },
    );
    expect(await storage.readReplySource(actor(), mapping.externalMessageKey)).toBeNull();
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({ ok: false });
    await db.models.Message.updateOne(
      { messageId: mapping.messageId },
      { $unset: { isUserSubmitted: '' }, $set: { expiredAt: new Date(now - 1) } },
    );
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({ ok: false });
    await db.models.Message.updateOne(
      { messageId: mapping.messageId },
      { $unset: { expiredAt: '' } },
    );
    await closeResponseScopes(db, { userId, tenantId }, [mapping.conversationId]);
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({ ok: false });
  }));

it('resolves only provider-matched confirmed sources and rolls back a failed projection', () =>
  scope(async () => {
    const source = await storage.readReplySource(actor(), mapping.externalMessageKey);
    expect(source).toMatchObject({
      provider: 'discord',
      applicationId,
      guildId,
      principalId: userId,
      linkId: 'link',
      externalUserId,
    });
    expect(
      await storage.readReplySource(
        {
          tenantId,
          channelId: channel.channelId,
          channelRevision: channel.revision,
          agentId: 'agent',
          teamId: applicationId,
        },
        mapping.externalMessageKey,
      ),
    ).toBeNull();
    const work = await job('700000000000000001', 'thumbsUp');
    const spy = jest
      .spyOn(db.models.ChannelFeedback.collection, 'updateOne')
      .mockRejectedValueOnce(new Error('feedback unavailable'));
    await expect(storage.recordDiscordFeedback(work, mapping, now)).rejects.toThrow(
      'feedback unavailable',
    );
    spy.mockRestore();
    for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
      expect(await db.models[name].countDocuments()).toBe(0);
    expect(await storage.recordDiscordFeedback(work, mapping, now)).toMatchObject({ ok: true });
  }));

it('shares existing account erasure and export authority fences', () =>
  scope(async () => {
    expect(await vote('700000000000000001', 'thumbsUp')).toMatchObject({ ok: true });
    const pending = await storage.pendingChannelFeedbackExports(tenantId, now, 1);
    expect(pending).toHaveLength(1);
    expect(
      await storage.claimChannelFeedbackExport(pending[0], 'exporter', now, now + 10000),
    ).not.toBeNull();
    await createUserMethods(db).deleteUserById(userId);
    for (const name of ['ChannelReply', 'ChannelFeedbackEvent', 'ChannelFeedback'])
      expect(await db.models[name].countDocuments()).toBe(0);
    expect(await storage.isAuthorityCurrent(mapping)).toBe(false);
  }));

it('keeps Slack microseconds and exact Discord snowflake occurrence ordering separate', () => {
  expect(
    isLaterChannelFeedbackEvent(
      { eventId: 'a', eventTimestampUs: 2 },
      { eventId: 'z', eventTimestampUs: 1 },
    ),
  ).toBe(true);
  expect(
    isLaterChannelFeedbackEvent(
      { eventId: 'z', eventTimestampUs: 1 },
      { eventId: 'a', eventTimestampUs: 1 },
    ),
  ).toBe(true);
  expect(
    isLaterChannelFeedbackEvent(
      { provider: 'discord', eventId: '10' },
      { provider: 'discord', eventId: '9' },
    ),
  ).toBe(true);
  expect(
    isLaterChannelFeedbackEvent(
      { provider: 'discord', eventId: '9007199254740993' },
      { provider: 'discord', eventId: '9007199254740992' },
    ),
  ).toBe(true);
  expect(() =>
    isLaterChannelFeedbackEvent(
      { provider: 'discord', eventId: '10' },
      { eventId: 'a', eventTimestampUs: 1 },
    ),
  ).toThrow('Mixed feedback');
});

it('requires the native fenced writer and rejects mixed provider mappings and foreign tenant writes', () =>
  scope(async () => {
    expect(await vote('700000000000000001', 'thumbsUp')).toMatchObject({ ok: true });
    const saved = await ledger();
    if (!saved) throw new Error('Missing ledger');
    await expect(storage.ensureChannelFeedback(saved)).rejects.toBeInstanceOf(
      ChannelFeedbackAuthorityError,
    );
    const receipt = await createChannelFeedbackEventModel(db).findOne().lean();
    if (!receipt) throw new Error('Missing receipt');
    await expect(storage.admitChannelFeedbackEvent(receipt)).rejects.toBeInstanceOf(
      ChannelFeedbackAuthorityError,
    );
    await expect(storage.saveChannelFeedback(saved, saved.revision)).rejects.toBeInstanceOf(
      ChannelFeedbackAuthorityError,
    );
    await expect(db.models.ChannelReply.create({ ...mapping, teamId: 'T1' })).rejects.toThrow(
      'Invalid Discord feedback source',
    );
    const work = await job('700000000000000002', 'thumbsDown');
    await expect(
      tenantStorage.run({ tenantId: 'foreign' }, async () =>
        storage.recordDiscordFeedback(work, mapping, now),
      ),
    ).rejects.toThrow('authenticated scope');
    expect(await ledger()).toMatchObject({ rating: 'thumbsUp', revision: 1 });
  }));

it('records feedback for the exact immutable native thread mapping and rejects a replaced parent', () =>
  scope(async () => {
    const threadChannelId = '789012345678901234';
    const owner = { applicationId, applicationRevision, ownerId: 'a'.repeat(32) };
    expect(
      await createDiscordGatewayStorage(db, async () => ({
        ownershipLeaseMs: 30000,
        shardCount: 1,
      })).acquire(owner, 30000),
    ).toBe(true);
    const source: DiscordGuildThreadSource = {
      kind: 'guild_thread',
      applicationId,
      guildId,
      botUserId,
      parentChannelId: externalChannelId,
      threadChannelId,
      authorId: externalUserId,
      threadType: 11,
      archived: false,
      locked: false,
      membership: { bot: false, author: false },
      permissions: {
        bot: String(BigInt(1024 | 65536) | (BigInt(1) << BigInt(38))),
        author: '1024',
      },
    };
    const parent = await createDiscordRouteStorage(db).read(
      channel.installationId,
      externalChannelId,
    );
    if (!parent) throw new Error('Missing parent');
    const route = value(
      await createDiscordThreadStorage(db, async () => ({ maxThreadRoutes: 10 })).bind(
        owner,
        source,
        {
          channelId: channel.channelId,
          channelRevision: channel.revision,
          routeRevision: parent.revision,
        },
      ),
    );
    const thread = { parentChannelId: externalChannelId, mappingRevision: route.mappingRevision };
    await db.models.ChannelRun.updateOne(
      { runId },
      {
        $set: {
          'admission.externalChannelId': threadChannelId,
          'admission.externalThreadKey': `${threadChannelId}:700000000000000000`,
          'admission.externalMessageKey': `${threadChannelId}:700000000000000000`,
          'admission.discordDestination': { kind: 'guild_thread', ...thread },
          receipts: [messageId, secondMessageId].map((id) => ({
            operationId: id,
            outcome: 'confirmed',
            attempts: 1,
            externalMessageKey: `${threadChannelId}:${id}`,
          })),
        },
      },
    );
    const nativeMapping = {
      ...mapping,
      externalChannelId: threadChannelId,
      externalMessageKey: `${threadChannelId}:${messageId}`,
    };
    const guild = await installations.resolveGuild(applicationId, guildId);
    if (!guild) throw new Error('Missing guild');
    const eventId = '9007199254740995';
    value(
      await inbox.submit(
        {
          routing: 'inspection',
          eventId,
          applicationId,
          applicationRevision,
          guildId,
          installationId: guild.installationId,
          installationRevision: guild.revision,
          externalChannelId: threadChannelId,
          externalUserId,
          action: { kind: 'feedback', reference: runId, messageId, rating: 'thumbsUp' },
          encryptedToken: 'sealed',
          tokenHash: 'a'.repeat(64),
          expiresAt: now + 900000,
        },
        now,
      ),
    );
    const record = await inbox.claim(applicationId, 'thread-feedback', now);
    if (!record) throw new Error('Missing claim');
    const fence = { applicationId, eventId, owner: 'thread-feedback', epoch: record.leaseEpoch };
    const resolved = value(
      await createDiscordInboxResolutionStorage(db).resolve(fence, owner, source, route, now),
    );
    const work = { record: resolved, fence, principal: principal() };
    expect(await storage.recordDiscordFeedback(work, nativeMapping, now)).toMatchObject({
      ok: true,
    });
    expect(await ledger()).toMatchObject({
      rating: 'thumbsUp',
      votes: [expect.objectContaining({ eventId })],
    });
    value(
      await createDiscordRouteStorage(db).remove({
        actorId: userId,
        installationId: channel.installationId,
        externalChannelId,
        expectedRevision: parent.revision,
      }),
    );
    expect(await storage.recordDiscordFeedback(work, nativeMapping, now)).toMatchObject({
      ok: false,
    });
  }));
