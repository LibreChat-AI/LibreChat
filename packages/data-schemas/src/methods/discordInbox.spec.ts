import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type { DiscordAgentChannel } from 'librechat-data-provider';
import type { SubmitDiscordInteraction } from './discordInbox';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordInboxStorage } from './discordInbox';
import { createDiscordRouteStorage } from './discordRoute';
import { touchDiscordInbox } from './discordInboxScope';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
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
