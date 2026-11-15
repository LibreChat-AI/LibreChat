import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordAgentChannel } from 'librechat-data-provider';
import type { SubmitDiscordInteraction, SubmitDiscordInspection } from './discordInbox';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInboxErasure } from './discordReceipt';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordInboxStorage } from './discordInbox';
import { createDiscordRouteStorage } from './discordRoute';
import { touchDiscordInbox } from './discordInboxScope';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { lockChannelScope } from './channelScope';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const tenantId = 'inbox-tenant';
const owner = '000000000000000000000001';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '678901234567890123';
const externalUserId = '456789012345678901';
const eventId = '567890123456789012';
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
let mongo: MongoMemoryReplSet;
let storage: ReturnType<typeof createDiscordInboxStorage>;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let applicationRevision: string;
let channel: DiscordAgentChannel;
let now: number;
function input(overrides: Partial<SubmitDiscordInteraction> = {}): SubmitDiscordInteraction {
  return {
    eventId,
    applicationId,
    applicationRevision,
    guildId,
    channelId: channel.channelId,
    channelRevision: channel.revision,
    agentId: channel.agentId,
    externalChannelId,
    externalUserId,
    action: { kind: 'ask', prompt: 'Private question' },
    encryptedToken: 'sealed-token',
    tokenHash: 'a'.repeat(64),
    expiresAt: now + 900000,
    ...overrides,
  };
}
async function claim(at = now, worker = 'worker') {
  const record = await storage.claim(applicationId, worker, at);
  if (!record) throw new Error('Missing claim');
  return { applicationId, eventId: record.eventId, owner: worker, epoch: record.leaseEpoch };
}
async function rotate() {
  const result = await installations.configureApplication({
    actorId: owner,
    applicationId,
    botUserId,
    publicKey: 'b'.repeat(64),
    encryptedBotToken: 'rotated',
    expectedRevision: applicationRevision,
  });
  if (!result.ok) throw new Error(result.error.code);
  return result.value.revision;
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
  installations = createDiscordInstallationStorage(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  now = Date.now();
  storage = createDiscordInboxStorage(db);
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'AgentChannel',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'DiscordInbox',
      'DiscordReceipt',
      'DiscordReservation',
      'ChannelScope',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
    ])
      await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create({
      _id: owner,
      email: 'owner@example.test',
      tenantId,
      provider: 'local',
    });
    const app = await installations.configureApplication({
      actorId: owner,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'token',
      encryptedClientSecret: 'secret',
    });
    if (!app.ok) throw new Error(app.error.code);
    applicationRevision = app.value.revision;
    const guild = await installations.connectGuild({
      actorId: owner,
      applicationId,
      applicationRevision,
      guildId,
      guildName: 'Guild',
    });
    if (!guild.ok) throw new Error(guild.error.code);
    const channels = createAgentChannelMethods(db);
    await channels.createAgentChannel({
      type: 'discord',
      channelId: 'channel',
      agentId: 'agent',
      tenantId,
      createdBy: owner,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'revision',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
      applicationRevision,
    });
    const assigned = await createDiscordRouteStorage(db).assign({
      actorId: owner,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision,
      externalChannelId,
      channelId: 'channel',
      channelRevision: 'revision',
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
    const record = await channels.getAgentChannelMetadata('channel');
    if (!record || record.type !== 'discord') throw new Error('Missing binding');
    channel = record;
  });
});

it('deduplicates persisted events without returning private payloads', () =>
  scope(async () => {
    expect(await storage.submit(input(), now)).toEqual({
      ok: true,
      value: { eventId, state: 'queued', duplicate: false },
    });
    expect(await storage.submit(input({ encryptedToken: 'new-ciphertext' }), now)).toMatchObject({
      ok: true,
      value: { duplicate: true },
    });
    expect(await storage.submit(input({ action: { kind: 'link' } }), now)).toMatchObject({
      ok: false,
      error: { code: 'event_conflict' },
    });
    expect(await storage.submit(input({ tokenHash: 'b'.repeat(64) }), now)).toMatchObject({
      ok: false,
      error: { code: 'event_conflict' },
    });
    const publicRecord = await db.models.DiscordInbox.findOne({ eventId }).lean();
    for (const field of ['action', 'encryptedToken', 'encryptedReply'])
      expect(publicRecord).not.toHaveProperty(field);
    expect(await storage.claim(applicationId, 'worker', now)).toMatchObject({
      action: input().action,
      encryptedToken: 'sealed-token',
    });
  }));

it('serializes duplicate admission and per-actor capacity', () =>
  scope(async () => {
    storage = createDiscordInboxStorage(db, async () => ({ maxPendingPerActor: 1 }));
    const duplicates = await Promise.all([
      storage.submit(input(), now),
      storage.submit(input(), now),
    ]);
    expect(duplicates.every((result) => result.ok)).toBe(true);
    expect(duplicates.filter((result) => result.ok && result.value.duplicate)).toHaveLength(1);
    expect(await storage.submit(input({ eventId: '567890123456789013' }), now)).toMatchObject({
      ok: false,
      error: { code: 'capacity' },
    });
  }));

it('serializes the application cap across different actors', () =>
  scope(async () => {
    storage = createDiscordInboxStorage(db, async () => ({ maxPendingPerApplication: 1 }));
    const results = await Promise.all([
      storage.submit(input(), now),
      storage.submit(
        input({ eventId: '567890123456789013', externalUserId: '456789012345678902' }),
        now,
      ),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'capacity' } },
    ]);
  }));

it.each([
  'applicationId',
  'guildId',
  'externalChannelId',
  'channelRevision',
  'applicationRevision',
  'agentId',
] as const)('rejects mismatched %s', (field) =>
  scope(async () => {
    expect(await storage.submit(input({ [field]: '789012345678901234' }), now)).toMatchObject({
      ok: false,
      error: { code: 'authority_changed' },
    });
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
  }),
);

it('rejects foreign tenants and system context', async () => {
  await tenantStorage.run({ tenantId: 'foreign' }, async () => {
    expect(await storage.submit(input(), now)).toMatchObject({
      ok: false,
      error: { code: 'authority_changed' },
    });
    expect(await storage.claim(applicationId, 'worker', now)).toBeNull();
  });
  await expect(runAsSystem(async () => storage.submit(input(), now))).rejects.toThrow(
    'tenant scope',
  );
});

it('reclaims expired leases and fences every stale worker mutation', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const first = await claim();
    expect(await storage.claim(applicationId, 'other', now + 1)).toBeNull();
    const second = await claim(now + 30000, 'replacement');
    expect(second.epoch).toBe(first.epoch + 1);
    expect(await storage.renew(first, now + 30001)).toBe(false);
    expect(await storage.prepareReply(first, 'stale', now + 30001)).toMatchObject({
      ok: false,
      error: { code: 'stale_fence' },
    });
    expect(await storage.defer(first, now + 40000, now + 30001)).toBe(false);
    expect(await storage.finish(first, 'unavailable', now + 30001)).toBe(false);
    expect(await storage.renew(second, now + 30001)).toBe(true);
    expect(await storage.finish(second, 'completed', now + 30001)).toBe(false);
  }));

it('persists an immutable reply through retries and erases private data on completion', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const fence = await claim();
    expect(await storage.prepareReply(fence, 'sealed-reply', now)).toMatchObject({
      ok: true,
      value: { state: 'reply', encryptedReply: 'sealed-reply' },
    });
    expect(await storage.prepareReply(fence, 'replacement', now)).toMatchObject({
      ok: true,
      value: { encryptedReply: 'sealed-reply' },
    });
    expect(await storage.defer(fence, now + 1000, now)).toBe(true);
    expect(await storage.claim(applicationId, 'worker', now + 999)).toBeNull();
    const retry = await storage.claim(applicationId, 'worker', now + 1000);
    expect(retry).toMatchObject({ state: 'reply', encryptedReply: 'sealed-reply' });
    expect(
      await storage.finish({ ...fence, epoch: retry!.leaseEpoch }, 'completed', now + 1000),
    ).toBe(true);
    const record = await db.models.DiscordInbox.findOne({ eventId })
      .select('+action +encryptedToken +encryptedReply')
      .lean();
    expect(record).toMatchObject({ state: 'done', result: 'completed' });
    for (const field of ['action', 'encryptedToken', 'encryptedReply', 'leaseOwner'])
      expect(record).not.toHaveProperty(field);
    expect(await storage.submit(input(), now + 1001)).toMatchObject({
      ok: true,
      value: { state: 'done', duplicate: true },
    });
  }));

it('expires tokens and bounds retry delays to permit prompt cleanup', () =>
  scope(async () => {
    expect(await storage.submit(input({ expiresAt: now }), now)).toMatchObject({
      ok: false,
      error: { code: 'expired' },
    });
    expect(await storage.submit(input({ expiresAt: now + 900001 }), now)).toMatchObject({
      ok: false,
      error: { code: 'expired' },
    });
    await storage.submit(input(), now);
    const fence = await claim();
    expect(await storage.defer(fence, now + 99999999, now)).toBe(true);
    expect(await storage.claim(applicationId, 'replacement', now + 900000)).toBeNull();
    const record = await db.models.DiscordInbox.findOne({ eventId })
      .select('+action +encryptedToken')
      .lean();
    expect(record).toMatchObject({ state: 'failed', result: 'expired' });
    expect(record).not.toHaveProperty('encryptedToken');
    expect(record).not.toHaveProperty('action');
  }));

it.each(['queued', 'reply'] as const)(
  'retires %s jobs when application authority rotates',
  (stage) =>
    scope(async () => {
      await storage.submit(input(), now);
      if (stage === 'reply') {
        const fence = await claim();
        await storage.prepareReply(fence, 'sealed-reply', now);
        await rotate();
        expect(await storage.prepareReply(fence, 'sealed-reply', now + 1)).toMatchObject({
          ok: false,
          error: { code: 'authority_changed' },
        });
        await storage.defer(fence, now + 1, now);
      } else await rotate();
      expect(await storage.claim(applicationId, 'worker', now + 1)).toBeNull();
      expect(
        await db.models.DiscordInbox.findOne({ eventId })
          .select('+encryptedToken +encryptedReply')
          .lean(),
      ).toMatchObject({ state: 'failed', result: 'authority_changed' });
    }),
);

it('joins action writes to the current processing lease only', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const first = await claim();
    const identity = {
      tenantId,
      channelId: channel.channelId,
      externalUserId,
      applicationRevision,
    };
    const touch = (fence = first, userId = externalUserId) =>
      withRequiredTransaction(db, async (session) =>
        touchDiscordInbox(db, { ...identity, externalUserId: userId }, fence, now, session),
      );
    expect(await touch()).toBe(true);
    expect(await touch(first, '789012345678901234')).toBe(false);
    const next = await claim(now + 30000, 'replacement');
    expect(await touch()).toBe(false);
    expect(await touch(next)).toBe(true);
    await storage.prepareReply(next, 'reply', now + 30001);
    expect(await touch(next)).toBe(false);
  }));

it('rejects admission and clears queued secrets when the owner is erased', () =>
  scope(async () => {
    await storage.submit(input(), now);
    await db.models.User.updateOne(
      { _id: owner },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );
    expect(await storage.submit(input({ eventId: '567890123456789013' }), now)).toMatchObject({
      ok: false,
      error: { code: 'authority_changed' },
    });
    expect(await storage.claim(applicationId, 'worker', now)).toBeNull();
    const record = await db.models.DiscordInbox.findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record).toMatchObject({ state: 'failed', result: 'authority_changed' });
    expect(record).not.toHaveProperty('encryptedToken');
  }));

it('does not reuse a lease fence in another application', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const fence = { ...(await claim()), applicationId: '789012345678901234' };
    expect(await storage.renew(fence, now)).toBe(false);
    expect(await storage.prepareReply(fence, 'reply', now)).toMatchObject({
      ok: false,
      error: { code: 'stale_fence' },
    });
    expect(await storage.defer(fence, now + 1, now)).toBe(false);
    expect(await storage.finish(fence, 'unavailable', now)).toBe(false);
  }));

it('lets the last owner erase an expired token without a subsequent claim', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const fence = await claim();
    expect(await storage.finish(fence, 'expired', now)).toBe(false);
    expect(
      await storage.finish({ ...fence, epoch: fence.epoch + 1 }, 'expired', now + 900000),
    ).toBe(false);
    expect(await storage.finish(fence, 'expired', now + 900000)).toBe(true);
    const record = await db.models.DiscordInbox.findOne({ eventId })
      .select('+action +encryptedToken')
      .lean();
    expect(record).toMatchObject({ state: 'failed', result: 'expired' });
    expect(record).not.toHaveProperty('encryptedToken');
    expect(record).not.toHaveProperty('action');
  }));

it('claims live work without first draining an expired backlog', () =>
  scope(async () => {
    storage = createDiscordInboxStorage(db, async () => ({ scanLimit: 1 }));
    await storage.submit(input({ expiresAt: now + 1000 }), now);
    await storage.submit(input({ eventId: '567890123456789013', expiresAt: now + 1000 }), now);
    await storage.submit(input({ eventId: '567890123456789014' }), now);
    expect(await storage.claim(applicationId, 'worker', now + 1001)).toMatchObject({
      eventId: '567890123456789014',
      state: 'processing',
    });
    expect(
      await db.models.DiscordInbox.countDocuments({ state: 'failed', result: 'expired' }),
    ).toBe(1);
  }));

it('fences consent replacement and run admission against inbox lease reclamation', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const first = await claim();
    const identities = createChannelIdentityStorage(db);
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
    const record = {
      tenantId,
      linkId: 'link',
      ticketHash: 'a'.repeat(64),
      revision: 'link-revision',
      identity,
      state: 'active' as const,
      userId: owner,
      ticketExpiresAtMs: now + 60000,
      expiresAtMs: now + 60000,
    };
    expect(
      await identities.saveChannelIdentity(record, null, applicationRevision, {
        fence: first,
        now,
      }),
    ).toBe(true);
    await db.models.ChannelIdentity.updateOne(
      { linkId: record.linkId },
      { $set: { discordActivatedAtMs: Number(BigInt(eventId) >> BigInt(22)) + 1420070400000 - 1 } },
    );
    const second = await claim(now + 30000, 'replacement');
    expect(
      await identities.saveChannelIdentity(
        { ...record, revision: 'stale' },
        record.revision,
        applicationRevision,
        { fence: first, now: now + 30001 },
      ),
    ).toBe(false);
    const runs = createChannelRunStorage(db);
    const enrollment = {
      tenantId,
      channelId: channel.channelId,
      agentId: channel.agentId,
      applicationRevision,
      discordInbox: first,
      principal: {
        userId: owner,
        channelRevision: channel.revision,
        linkId: record.linkId,
        linkRevision: record.revision,
      },
      admission: {
        actor: { provider: 'discord' as const, applicationId, guildId, externalUserId },
        eventId,
        externalChannelId,
        externalThreadKey: `${externalChannelId}:${eventId}`,
        externalMessageKey: `${externalChannelId}:${eventId}`,
        input: 'Private question',
      },
    };
    await expect(runs.admit(enrollment, now + 30001)).rejects.toMatchObject({
      code: 'stale_fence',
    });
    expect((await runs.admit({ ...enrollment, discordInbox: second }, now + 30001)).duplicate).toBe(
      false,
    );
    expect((await runs.admit({ ...enrollment, discordInbox: second }, now + 30001)).duplicate).toBe(
      true,
    );
    await storage.prepareReply(second, 'sealed-reply', now + 30001);
    await expect(
      runs.admit({ ...enrollment, discordInbox: second }, now + 30001),
    ).rejects.toMatchObject({ code: 'stale_fence' });
  }));

it('erases private inbox rows atomically while retaining opaque replay receipts', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const fence = await claim();
    await storage.prepareReply(fence, 'private-reply', now);
    const erasure = createDiscordInboxErasure(db, async (scope, session) => {
      await lockChannelScope(db, scope.tenantId, scope.channelId, session);
    });
    await erasure.erase({ kind: 'channel', tenantId, channelId: channel.channelId }, 1);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
    const receipt = await db.models.DiscordReceipt.findOne({ applicationId, eventId }).lean();
    expect(receipt).toMatchObject({
      applicationId,
      eventId,
      fingerprint: expect.any(String),
      purgeAt: expect.any(Date),
    });
    for (const field of [
      'tenantId',
      'channelId',
      'externalUserId',
      'guildId',
      'action',
      'encryptedToken',
      'encryptedReply',
    ])
      expect(receipt).not.toHaveProperty(field);
    expect(await storage.renew(fence, now)).toBe(false);
    expect(await storage.prepareReply(fence, 'late', now)).toMatchObject({
      ok: false,
      error: { code: 'stale_fence' },
    });
    expect(await storage.submit(input(), now)).toMatchObject({
      ok: false,
      error: { code: 'expired' },
    });
    expect(
      await storage.submit(input({ action: { kind: 'ask', prompt: 'changed' } }), now),
    ).toMatchObject({ ok: false, error: { code: 'event_conflict' } });
    await erasure.erase({ kind: 'channel', tenantId, channelId: channel.channelId });
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(1);
  }));

it('rolls back the replay receipt when inbox erasure fails', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const erasure = createDiscordInboxErasure(db, async (scope, session) => {
      await lockChannelScope(db, scope.tenantId, scope.channelId, session);
    });
    const spy = jest
      .spyOn(db.models.DiscordInbox.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('erasure failed'));
    await expect(
      erasure.erase({ kind: 'channel', tenantId, channelId: channel.channelId }),
    ).rejects.toThrow('erasure failed');
    spy.mockRestore();
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(0);
    expect(
      await db.models.DiscordInbox.findOne({ eventId }).select('+encryptedToken').lean(),
    ).toHaveProperty('encryptedToken');
  }));

it('bounds pending work by physical Discord destination across different actors', () =>
  scope(async () => {
    storage = createDiscordInboxStorage(db, async () => ({ maxPendingPerChannel: 1 }));
    expect(await storage.submit(input(), now)).toMatchObject({ ok: true });
    expect(
      await storage.submit(
        input({ eventId: '567890123456789013', externalUserId: '456789012345678902' }),
        now,
      ),
    ).toMatchObject({ ok: false, error: { code: 'capacity' } });
    const channels = createAgentChannelMethods(db);
    await channels.createAgentChannel({
      ...channel,
      channelId: 'replacement',
      status: 'pending_install',
      revision: 'replacement-revision',
      applicationRevision,
    });
    const routes = createDiscordRouteStorage(db);
    const previous = await routes.read(channel.installationId, externalChannelId);
    if (!previous) throw new Error('Missing route');
    const assigned = await routes.assign({
      actorId: owner,
      installationId: channel.installationId,
      installationRevision: channel.installationRevision,
      applicationRevision,
      externalChannelId,
      channelId: 'replacement',
      channelRevision: 'replacement-revision',
      expectedRevision: previous.revision,
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
    const replacement = await channels.getAgentChannelMetadata('replacement');
    if (!replacement) throw new Error('Missing replacement');
    expect(
      await storage.submit(
        input({
          eventId: '567890123456789014',
          externalUserId: '456789012345678902',
          channelId: replacement.channelId,
          channelRevision: replacement.revision,
        }),
        now,
      ),
    ).toMatchObject({ ok: false, error: { code: 'capacity' } });
  }));

it('serializes processing effects per actor and destination while other actors progress', () =>
  scope(async () => {
    const second = '567890123456789013';
    const other = '567890123456789014';
    await storage.submit(input(), now);
    await storage.submit(input({ eventId: second }), now + 1);
    await storage.submit(input({ eventId: other, externalUserId: '456789012345678902' }), now + 2);
    const claims = await Promise.all([
      storage.claim(applicationId, 'worker1', now + 2),
      storage.claim(applicationId, 'worker2', now + 2),
    ]);
    expect(claims.map((row) => row?.eventId).sort()).toEqual([eventId, other]);
    expect(await storage.claim(applicationId, 'worker3', now + 3)).toBeNull();
    const first = claims.find((row) => row?.eventId === eventId)!;
    expect(
      await storage.prepareReply(
        { applicationId, eventId, owner: first.leaseOwner!, epoch: first.leaseEpoch },
        'reply',
        now + 3,
      ),
    ).toMatchObject({ ok: true });
    expect(await storage.claim(applicationId, 'worker3', now + 3)).toMatchObject({
      eventId: second,
    });
  }));

it('reclaims expired processing before starting a later event for that actor', () =>
  scope(async () => {
    await storage.submit(input(), now);
    const first = await storage.claim(applicationId, 'lost-worker', now);
    if (!first) throw new Error('Missing first claim');
    await storage.submit(input({ eventId: '567890123456789013' }), now + 1);
    const recovered = await storage.claim(
      applicationId,
      'replacement-worker',
      first.leaseExpiresAt,
    );
    expect(recovered).toMatchObject({ eventId, leaseEpoch: first.leaseEpoch + 1 });
    expect(await storage.claim(applicationId, 'later-worker', first.leaseExpiresAt)).toBeNull();
  }));

it('keeps deferred effects ahead of later commands while another actor progresses', () =>
  scope(async () => {
    const cancelId = '567890123456789013';
    const otherId = '567890123456789014';
    await storage.submit(input(), now);
    await storage.submit(input({ eventId: cancelId, action: { kind: 'cancel' } }), now + 1);
    await storage.submit(
      input({ eventId: otherId, externalUserId: '456789012345678902' }),
      now + 2,
    );
    const first = await claim(now + 2);
    expect(first.eventId).toBe(eventId);
    expect(await storage.defer(first, now + 1000, now + 3)).toBe(true);
    expect(await storage.claim(applicationId, 'independent', now + 4)).toMatchObject({
      eventId: otherId,
    });
    expect(await storage.claim(applicationId, 'later', now + 999)).toBeNull();
    const recovered = await claim(now + 1000, 'recovery');
    expect(recovered).toMatchObject({ eventId, epoch: first.epoch + 1 });
    expect(await storage.prepareReply(first, 'stale-reply', now + 1000)).toMatchObject({
      ok: false,
      error: { code: 'stale_fence' },
    });
    expect(await storage.prepareReply(recovered, 'reply', now + 1000)).toMatchObject({ ok: true });
    expect(await storage.claim(applicationId, 'later', now + 1001)).toMatchObject({
      eventId: cancelId,
    });
  }));

it.each(['queued', 'processing'] as const)(
  'keeps older queued due times ahead of later %s effects, using event IDs to break receive-time ties',
  (state) =>
    scope(async () => {
      const laterId = '567890123456789013';
      const otherId = '567890123456789014';
      await storage.submit(input(), now);
      await storage.submit(input({ eventId: laterId }), now);
      await storage.submit(
        input({ eventId: otherId, externalUserId: '456789012345678902' }),
        now + 1,
      );
      await db.models.DiscordInbox.updateOne({ eventId }, { $set: { nextAttemptAt: now + 1000 } });
      if (state === 'processing')
        await db.models.DiscordInbox.updateOne(
          { eventId: laterId },
          { $set: { state, leaseEpoch: 1, leaseExpiresAt: 0 } },
        );
      expect(await storage.claim(applicationId, 'independent', now + 2)).toMatchObject({
        eventId: otherId,
      });
      expect(await storage.claim(applicationId, 'later', now + 999)).toBeNull();
      const first = await claim(now + 1000, 'earlier');
      expect(first.eventId).toBe(eventId);
      expect(await storage.prepareReply(first, 'reply', now + 1000)).toMatchObject({ ok: true });
      expect(await storage.claim(applicationId, 'later', now + 1000)).toMatchObject({
        eventId: laterId,
      });
    }),
);

it('recovers the oldest expired processing peer without deadlocking behind later expired peers', () =>
  scope(async () => {
    const laterId = '567890123456789013';
    await storage.submit(input(), now);
    await storage.submit(input({ eventId: laterId }), now + 1);
    await db.models.DiscordInbox.updateMany(
      {},
      { $set: { state: 'processing', leaseEpoch: 1, leaseExpiresAt: 0 } },
    );
    const first = await claim(now + 2, 'recovery');
    expect(first).toMatchObject({ eventId, epoch: 2 });
    expect(await storage.claim(applicationId, 'parallel', now + 2)).toBeNull();
    expect(await storage.prepareReply(first, 'reply', now + 2)).toMatchObject({ ok: true });
    expect(await storage.claim(applicationId, 'next', now + 2)).toMatchObject({
      eventId: laterId,
      leaseEpoch: 2,
    });
  }));

it('keeps a deferred actor independent from their commands in another destination', () =>
  scope(async () => {
    const destination = '678901234567890124';
    const channels = createAgentChannelMethods(db);
    await channels.createAgentChannel({
      ...channel,
      channelId: 'second-channel',
      status: 'pending_install',
      revision: 'second-initial',
      applicationRevision,
      discord: { ...channel.discord, externalChannelId: destination },
    });
    const assigned = await createDiscordRouteStorage(db).assign({
      actorId: owner,
      installationId: channel.installationId,
      installationRevision: channel.installationRevision,
      applicationRevision,
      externalChannelId: destination,
      channelId: 'second-channel',
      channelRevision: 'second-initial',
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
    const second = await channels.getAgentChannelMetadata('second-channel');
    if (!second) throw new Error('Missing second destination');
    await storage.submit(input(), now);
    await storage.submit(
      input({
        eventId: '567890123456789013',
        channelId: second.channelId,
        channelRevision: second.revision,
        externalChannelId: destination,
      }),
      now + 1,
    );
    const first = await claim(now + 2);
    expect(await storage.defer(first, now + 1000, now + 2)).toBe(true);
    expect(await storage.claim(applicationId, 'independent', now + 3)).toMatchObject({
      channelId: second.channelId,
    });
  }));

it('does not starve an older due queued row behind a later expired processing peer at the scan limit', () =>
  scope(async () => {
    storage = createDiscordInboxStorage(db, async () => ({ scanLimit: 1 }));
    await storage.submit(input(), now);
    await storage.submit(input({ eventId: '567890123456789013' }), now + 1);
    await db.models.DiscordInbox.updateOne(
      { eventId: '567890123456789013' },
      {
        $set: { state: 'processing', leaseEpoch: 1, leaseExpiresAt: 0 },
      },
    );
    expect(await storage.claim(applicationId, 'earlier', now + 2)).toMatchObject({ eventId });
  }));

it('does not block later effects behind a prepared reply waiting for transport retry', () =>
  scope(async () => {
    await storage.submit(input(), now);
    await storage.submit(input({ eventId: '567890123456789013' }), now + 1);
    const first = await claim(now + 2);
    expect(await storage.prepareReply(first, 'reply', now + 2)).toMatchObject({ ok: true });
    expect(await storage.defer(first, now + 1000, now + 3)).toBe(true);
    expect(await storage.claim(applicationId, 'later', now + 4)).toMatchObject({
      eventId: '567890123456789013',
    });
  }));
describe('unresolved channel inspection', () => {
  async function unresolved(
    overrides: Partial<SubmitDiscordInspection> = {},
  ): Promise<SubmitDiscordInspection> {
    const guild = await installations.resolveGuild(applicationId, guildId);
    if (!guild) throw new Error('Missing guild');
    const physical = input();
    const { eventId, applicationRevision, action, encryptedToken, tokenHash, expiresAt } = physical;
    return {
      eventId,
      applicationId,
      applicationRevision,
      guildId,
      externalUserId,
      action,
      encryptedToken,
      tokenHash,
      expiresAt,
      routing: 'inspection',
      installationId: guild.installationId,
      installationRevision: guild.revision,
      externalChannelId: '789012345678901234',
      ...overrides,
    };
  }
  it('durably leases physical source without invented binding or executable authority', () =>
    scope(async () => {
      const pending = await unresolved();
      expect((await storage.submit(pending, now)).ok).toBe(true);
      const record = await storage.claim(applicationId, 'worker', now);
      expect(record).toMatchObject({
        routing: 'inspection',
        externalChannelId: pending.externalChannelId,
        externalUserId,
      });
      expect(record).not.toHaveProperty('channelId');
      expect(record).not.toHaveProperty('agentId');
      const fence = { applicationId, eventId, owner: 'worker', epoch: record!.leaseEpoch };
      expect(await storage.prepareReply(fence, 'sealed-reply', now)).toEqual({
        ok: false,
        error: { code: 'authority_changed' },
      });
      expect(
        await withRequiredTransaction(db, (session) =>
          touchDiscordInbox(
            db,
            {
              tenantId,
              channelId: channel.channelId,
              externalUserId,
              applicationRevision,
            },
            fence,
            now,
            session,
          ),
        ),
      ).toBe(false);
      expect(await storage.defer(fence, now + 1000, now)).toBe(true);
      const reclaimed = await storage.claim(applicationId, 'next-worker', now + 1000);
      expect(reclaimed).toMatchObject({
        routing: 'inspection',
        externalChannelId: pending.externalChannelId,
        action: pending.action,
      });
      expect(reclaimed!.leaseEpoch).toBe(fence.epoch + 1);
      expect(await storage.finish(fence, 'unavailable', now + 1000)).toBe(false);
    }));
  it('deduplicates unresolved jobs and rejects changed signed identity or payload', () =>
    scope(async () => {
      const pending = await unresolved();
      await storage.submit(pending, now);
      expect(await storage.submit(pending, now)).toMatchObject({
        ok: true,
        value: { duplicate: true },
      });
      for (const changed of [
        { externalChannelId },
        { externalUserId: '111111111111111111' },
        { action: { kind: 'ask' as const, prompt: 'Changed' } },
      ])
        expect(await storage.submit({ ...pending, ...changed }, now)).toEqual({
          ok: false,
          error: { code: 'event_conflict' },
        });
      await expect(
        storage.submit({ ...pending, channelId: 'fake' } as SubmitDiscordInspection, now),
      ).rejects.toThrow();
    }));
  it('serializes concurrent pending capacity with the canonical installation fence', () =>
    scope(async () => {
      storage = createDiscordInboxStorage(db, async () => ({ maxPendingPerApplication: 1 }));
      const pending = await unresolved();
      const results = await Promise.all([
        storage.submit(pending, now),
        storage.submit({ ...pending, eventId: '111111111111111111' }, now),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.find((result) => !result.ok)).toEqual({
        ok: false,
        error: { code: 'capacity' },
      });
    }));
  it('rejects stale installation and application revisions before private storage or claim', () =>
    scope(async () => {
      const pending = await unresolved();
      expect(await storage.submit({ ...pending, installationRevision: 'stale' }, now)).toEqual({
        ok: false,
        error: { code: 'authority_changed' },
      });
      await storage.submit(pending, now);
      await rotate();
      expect(await storage.claim(applicationId, 'worker', now)).toBeNull();
      const row = await db.models.DiscordInbox.findOne({ eventId })
        .select('+action +encryptedToken')
        .lean();
      expect(row).toMatchObject({ state: 'failed', result: 'authority_changed' });
      expect(row).not.toHaveProperty('action');
      expect(row).not.toHaveProperty('encryptedToken');
    }));
  it('erases unresolved private payload by actor and retains an opaque replay receipt', () =>
    scope(async () => {
      const pending = await unresolved();
      await storage.submit(pending, now);
      const other = await installations.connectGuild({
        actorId: owner,
        applicationId,
        applicationRevision,
        guildId: '222222222222222222',
        guildName: 'Other guild',
      });
      if (!other.ok) throw new Error(other.error.code);
      await storage.submit(
        {
          ...pending,
          eventId: '333333333333333333',
          guildId: other.value.guildId,
          installationId: other.value.installationId,
          installationRevision: other.value.revision,
        },
        now,
      );
      const fence = jest.fn(async () => {});
      await createDiscordInboxErasure(db, fence).erase({
        kind: 'actor',
        tenantId,
        channelId: channel.channelId,
        applicationId,
        guildId,
        externalUserId,
      });
      expect(fence).not.toHaveBeenCalled();
      expect(await db.models.DiscordInbox.countDocuments({ eventId })).toBe(0);
      expect(await db.models.DiscordInbox.countDocuments({ eventId: '333333333333333333' })).toBe(
        1,
      );
      expect(
        await db.models.DiscordReceipt.findOne({ applicationId, eventId }).lean(),
      ).toMatchObject({ applicationId, eventId });
      expect(await storage.submit(pending, now)).toEqual({ ok: false, error: { code: 'expired' } });
    }));
});
