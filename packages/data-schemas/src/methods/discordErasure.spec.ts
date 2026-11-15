import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import type {
  DiscordGuild,
  DiscordApplication,
  DiscordAgentChannel,
} from 'librechat-data-provider';
import { discordTextAuthority, ownDiscordAuthority } from './test-helpers';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createDiscordInstallStorage } from './discordInstall';
import { withRequiredTransaction } from '~/utils/transactions';
import { createDiscordGatewayStorage } from './discordGateway';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordInboxErasure } from './discordReceipt';
import { createDiscordInboxStorage } from './discordInbox';
import { createDiscordRouteStorage } from './discordRoute';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { touchChannelScope } from './channelScope';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const tenantId = 'discord-erasure';
const installer = '000000000000000000000001';
const admin = '000000000000000000000002';
const member = '000000000000000000000003';
const applicationId = '123456789012345678';
const botUserId = '345678901234567890';
const guildId = '234567890123456789';
const externalChannelId = '678901234567890123';
const externalUserId = '456789012345678901';
const eventId = '567890123456789012';
const scope = <T>(work: () => Promise<T>, tenant = tenantId) =>
  tenantStorage.run({ tenantId: tenant }, work);
const value = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let now: number;
let app: DiscordApplication;
let guild: DiscordGuild;
let channel: DiscordAgentChannel;
const installations = createDiscordInstallationStorage(db);
const channels = createAgentChannelMethods(db);
const inbox = createDiscordInboxStorage(db);
const users = createUserMethods(db, {
  getChannelStorageConfig: async () => ({ erasureBatchSize: 1 }),
});
const configuration = (actorId = installer) => ({
  actorId,
  applicationId,
  botUserId,
  publicKey: 'a'.repeat(64),
  encryptedBotToken: 'private-bot-token',
  encryptedClientSecret: 'private-secret',
});
async function binding(id = 'channel', destination = externalChannelId, installation = guild) {
  await channels.createAgentChannel({
    type: 'discord',
    tenantId,
    channelId: id,
    agentId: 'agent',
    createdBy: admin,
    status: 'pending_install',
    credentialMode: 'per_user',
    revision: 'revision',
    installationId: installation.installationId,
    installationRevision: installation.revision,
    discord: {
      applicationId,
      guildId: installation.guildId,
      botUserId,
      externalChannelId: destination,
    },
    applicationRevision: app.revision,
  });
  value(
    await createDiscordRouteStorage(db).assign({
      actorId: admin,
      installationId: installation.installationId,
      installationRevision: installation.revision,
      applicationRevision: app.revision,
      externalChannelId: destination,
      channelId: id,
      channelRevision: 'revision',
    }),
  );
  const result = await channels.getAgentChannelMetadata(id);
  if (!result || result.type !== 'discord') throw new Error('Missing binding');
  return result;
}
function input(record = channel, overrides: { eventId?: string; externalUserId?: string } = {}) {
  return {
    eventId,
    applicationId,
    applicationRevision: app.revision,
    guildId: record.discord.guildId,
    channelId: record.channelId,
    channelRevision: record.revision,
    agentId: record.agentId,
    externalChannelId: record.discord.externalChannelId,
    externalUserId,
    action: { kind: 'ask' as const, prompt: 'private question' },
    encryptedToken: 'private-token',
    tokenHash: 'a'.repeat(64),
    expiresAt: now + 900000,
    ...overrides,
  };
}
async function link(userId = member, actor = externalUserId) {
  const record = {
    tenantId,
    linkId: `link-${userId}`,
    revision: 'one',
    state: 'active' as const,
    ticketHash: `ticket-${userId}`,
    ticketExpiresAtMs: now + 100000,
    expiresAtMs: now + 100000,
    userId,
    accountLabel: 'Private account',
    identity: {
      tenantId,
      channelId: channel.channelId,
      channelRevision: channel.revision,
      agentId: channel.agentId,
      provider: 'discord' as const,
      applicationId,
      guildId: channel.discord.guildId,
      externalUserId: actor,
    },
  };
  expect(
    await createChannelIdentityStorage(db).saveChannelIdentity(record, null, app.revision),
  ).toBe(true);
  await db.models.ChannelIdentity.updateOne(
    { linkId: record.linkId },
    { $set: { discordActivatedAtMs: Number(BigInt(eventId) >> BigInt(22)) + 1420070400000 - 1 } },
  );
  await ownDiscordAuthority(
    db,
    discordTextAuthority({
      applicationId,
      applicationRevision: app.revision,
      botUserId,
      guildId,
      channelId: externalChannelId,
      authorId: actor,
    }).owner,
  );
  return record;
}
async function pendingState(installation = guild) {
  const result = await createDiscordInstallStorage(db).start({
    userId: admin,
    stateHash: 'b'.repeat(64),
    sessionHash: 'c'.repeat(64),
    applicationId,
    applicationRevision: app.revision,
    installationId: installation.installationId,
    installationRevision: installation.revision,
    expiresAt: new Date(now + 600000),
  });
  expect(result.ok).toBe(true);
}
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
      'AgentChannel',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'DiscordInbox',
      'DiscordReceipt',
      'DiscordReservation',
      'DiscordGatewayCheckpoint',
      'ResourceLock',
      'DiscordInstall',
      'ChannelScope',
      'ChannelIdentity',
      'ChannelRun',
      'ChannelLane',
      'ResponseScope',
      'StoredResponse',
      'ChannelFeedback',
    ])
      if (db.models[name]) await db.models[name].deleteMany({});
  });
  await scope(async () => {
    await db.models.User.create(
      [installer, admin, member].map((_id) => ({
        _id,
        tenantId,
        email: `${_id}@example.test`,
        provider: 'local',
      })),
    );
    app = value(await installations.configureApplication(configuration()));
    guild = value(
      await installations.connectGuild({
        actorId: installer,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'Private guild',
      }),
    );
    channel = await binding();
    await ownDiscordAuthority(
      db,
      discordTextAuthority({
        applicationId,
        applicationRevision: app.revision,
        botUserId,
        guildId,
        channelId: externalChannelId,
        authorId: externalUserId,
      }).owner,
    );
  });
});

it('erases owned application credentials and every dependent binding while other users runs drain', () =>
  scope(async () => {
    const identity = await link();
    const runs = createChannelRunStorage(db);
    const enrollment = {
      tenantId,
      channelId: channel.channelId,
      agentId: channel.agentId,
      applicationRevision: app.revision,
      discordAuthority: discordTextAuthority({
        applicationId,
        applicationRevision: app.revision,
        botUserId,
        guildId,
        channelId: externalChannelId,
        authorId: externalUserId,
      }),
      principal: {
        userId: member,
        channelRevision: channel.revision,
        linkId: identity.linkId,
        linkRevision: identity.revision,
      },
      admission: {
        eventId,
        externalChannelId,
        externalThreadKey: 'thread',
        externalMessageKey: 'message',
        actor: { provider: 'discord' as const, applicationId, guildId, externalUserId },
        input: 'question',
      },
    };
    await runs.admit(enrollment, now);
    await inbox.submit(input(), now);
    const claimed = await inbox.claim(applicationId, 'worker', now);
    if (!claimed) throw new Error('Missing inbox claim');
    await inbox.prepareReply(
      { applicationId, eventId, owner: 'worker', epoch: claimed.leaseEpoch },
      'private-reply',
      now,
    );
    await pendingState();
    await inbox.submit(input(channel, { eventId: '567890123456789013' }), now);
    await inbox.submit(input(channel, { eventId: '567890123456789014' }), now);
    const erasedBatches = jest.spyOn(db.models.DiscordInbox.collection, 'deleteMany');
    const pending = await channels.createAgentChannel({
      ...channel,
      channelId: 'pending',
      status: 'pending_install',
      revision: 'pending-revision',
      applicationRevision: app.revision,
      discord: { ...channel.discord, externalChannelId: '678901234567890124' },
    });
    expect(pending.status).toBe('pending_install');
    expect((await runAsSystem(async () => users.deleteUserById(installer))).deletedCount).toBe(1);
    expect(erasedBatches).toHaveBeenCalledTimes(3);
    expect(await db.models.DiscordApplication.countDocuments()).toBe(0);
    expect(await db.models.DiscordGuild.countDocuments()).toBe(0);
    expect(await db.models.DiscordInstall.countDocuments()).toBe(0);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(3);
    expect(await db.models.DiscordRoute.countDocuments()).toBe(0);
    expect(await db.models.ChannelIdentity.countDocuments()).toBe(0);
    expect(await channels.getAgentChannel('pending')).toBeNull();
    expect(await channels.getAgentChannel(channel.channelId)).toMatchObject({
      createdBy: admin,
      status: 'deleting',
    });
    expect(
      await withRequiredTransaction(db, (session) =>
        touchChannelScope(db, tenantId, channel.channelId, session),
      ),
    ).toBe(false);
    expect(await installations.configureApplication(configuration(admin))).toMatchObject({
      ok: false,
      error: { code: 'application_unavailable' },
    });
    await expect(
      runs.admit(
        {
          ...enrollment,
          admission: { ...enrollment.admission, eventId: String(BigInt(eventId) + BigInt(1)) },
        },
        now + 1,
      ),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
    const run = await runs.claim(tenantId, channel.channelId, 'cleanup', now, 10000);
    if (!run) throw new Error('Missing drain claim');
    const fence = { runId: run.runId, owner: 'cleanup', epoch: run.leaseEpoch };
    await runs.markAuthorityLost(tenantId, fence, now);
    await runs.finishAuthorityLost(tenantId, fence, now);
    expect(await channels.deleteAgentChannel(channel.channelId, admin)).toEqual({
      status: 'deleted',
    });
    const oldApp = app;
    app = value(await installations.configureApplication(configuration(admin)));
    expect(app.createdBy).toBe(admin);
    expect(app.revision).not.toBe(oldApp.revision);
    const oldGuild = guild;
    guild = value(
      await installations.connectGuild({
        actorId: admin,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'New verified guild',
      }),
    );
    expect(guild.installationId).not.toBe(oldGuild.installationId);
    channel = await binding('recovered');
    expect(await inbox.submit(input(), now)).toMatchObject({
      ok: false,
      error: { code: 'event_conflict' },
    });
    const reservation = await db.models.DiscordReservation.findOne({ applicationId }).lean();
    expect(reservation).toMatchObject({ tenantId, applicationId, retiring: false });
    expect(reservation).not.toHaveProperty('createdBy');
  }));

it('erases terminal inbox metadata during ordinary binding deletion and preserves replay fences', () =>
  scope(async () => {
    await inbox.submit(input(), now);
    const row = await inbox.claim(applicationId, 'worker', now);
    if (!row) throw new Error('Missing claim');
    const fence = { applicationId, eventId, owner: 'worker', epoch: row.leaseEpoch };
    expect(await inbox.prepareReply(fence, 'terminal-reply', now)).toMatchObject({ ok: true });
    expect(await inbox.finish(fence, 'completed', now)).toBe(true);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(1);
    await inbox.submit(input(channel, { eventId: '567890123456789013' }), now);
    const erasedBatches = jest.spyOn(db.models.DiscordInbox.collection, 'deleteMany');
    const configuredChannels = createAgentChannelMethods(db, async () => ({ erasureBatchSize: 1 }));
    expect(await configuredChannels.deleteAgentChannel(channel.channelId, admin)).toEqual({
      status: 'deleted',
    });
    expect(erasedBatches).toHaveBeenCalledTimes(2);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(2);
  }));

it('retains discoverable application credentials when inbox cleanup fails and retries safely', () =>
  scope(async () => {
    await inbox.submit(input(), now);
    const spy = jest
      .spyOn(db.models.DiscordInbox.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('inbox unavailable'));
    await expect(users.deleteUserById(installer)).rejects.toThrow('inbox unavailable');
    spy.mockRestore();
    expect(await db.models.User.exists({ _id: installer })).not.toBeNull();
    expect(await installations.readApplicationCredentials(applicationId)).toHaveProperty(
      'encryptedBotToken',
      'private-bot-token',
    );
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(0);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(1);
    expect(await channels.getAgentChannel(channel.channelId)).toMatchObject({ status: 'deleting' });
    expect((await users.deleteUserById(installer)).deletedCount).toBe(1);
    expect(await db.models.DiscordApplication.countDocuments()).toBe(0);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(1);
    await scope(async () => {
      await db.models.User.create({
        _id: installer,
        tenantId: 'foreign-org',
        email: 'foreign@example.test',
        provider: 'local',
      });
      expect(await installations.configureApplication(configuration())).toMatchObject({
        ok: false,
        error: { code: 'application_in_use' },
      });
    }, 'foreign-org');
  }));

it('erases a linked members inbox without removing the application or other actors', () =>
  scope(async () => {
    await link();
    await inbox.submit(input(), now);
    await inbox.submit(
      input(channel, { eventId: '567890123456789013', externalUserId: '456789012345678902' }),
      now,
    );
    const spy = jest
      .spyOn(db.models.DiscordInbox.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('actor erase unavailable'));
    await expect(users.deleteUserById(member)).rejects.toThrow('actor erase unavailable');
    spy.mockRestore();
    expect(await db.models.ChannelIdentity.findOne({ userId: member }).lean()).toMatchObject({
      state: 'revoked',
    });
    expect((await users.deleteUserById(member)).deletedCount).toBe(1);
    expect(await db.models.ChannelIdentity.countDocuments({ userId: member })).toBe(0);
    expect(await db.models.DiscordInbox.find().lean()).toEqual([
      expect.objectContaining({ externalUserId: '456789012345678902' }),
    ]);
    expect(await db.models.DiscordReceipt.countDocuments()).toBe(1);
    expect(await installations.readApplicationCredentials(applicationId)).toHaveProperty(
      'encryptedBotToken',
    );
    expect(await channels.getActiveAgentChannel(channel.channelId)).toMatchObject({
      status: 'active',
    });
  }));

it('erases guild owner metadata while preserving an application and other guilds owned by another admin', () =>
  scope(async () => {
    // Recreate private setup through its real verified-metadata persistence boundary.
    await users.deleteUserById(installer);
    app = value(await installations.configureApplication(configuration(admin)));
    guild = value(
      await installations.connectGuild({
        actorId: member,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'Member guild',
      }),
    );
    channel = await binding('guild-owned');
    const other = value(
      await installations.connectGuild({
        actorId: admin,
        applicationId,
        applicationRevision: app.revision,
        guildId: '234567890123456790',
        guildName: 'Other guild',
      }),
    );
    const otherChannel = await binding('other', '678901234567890124', other);
    await inbox.submit(input(), now);
    await inbox.submit(input(otherChannel, { eventId: '567890123456789013' }), now);
    await pendingState();
    const identity = await link(admin);
    const runs = createChannelRunStorage(db);
    await runs.admit(
      {
        tenantId,
        channelId: channel.channelId,
        agentId: channel.agentId,
        applicationRevision: app.revision,
        discordAuthority: discordTextAuthority({
          applicationId,
          applicationRevision: app.revision,
          botUserId,
          guildId,
          channelId: externalChannelId,
          authorId: externalUserId,
        }),
        principal: {
          userId: admin,
          channelRevision: channel.revision,
          linkId: identity.linkId,
          linkRevision: identity.revision,
        },
        admission: {
          eventId,
          externalChannelId,
          externalThreadKey: 'thread',
          externalMessageKey: 'message',
          actor: { provider: 'discord', applicationId, guildId, externalUserId },
          input: 'question',
        },
      },
      now,
    );
    expect((await users.deleteUserById(member)).deletedCount).toBe(1);
    expect(await installations.readGuild(guild.installationId)).toBeNull();
    expect(await installations.readGuild(other.installationId)).toMatchObject({ status: 'active' });
    expect(await installations.readApplicationCredentials(applicationId)).toHaveProperty(
      'encryptedBotToken',
    );
    expect(await channels.getAgentChannel(channel.channelId)).toMatchObject({ status: 'deleting' });
    expect(await channels.getActiveAgentChannel(otherChannel.channelId)).toMatchObject({
      status: 'active',
    });
    expect(await db.models.DiscordInstall.countDocuments()).toBe(0);
    expect(await db.models.DiscordInbox.find().lean()).toEqual([
      expect.objectContaining({ guildId: other.guildId }),
    ]);
    expect(
      await installations.connectGuild({
        actorId: admin,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'Blocked recovery',
      }),
    ).toMatchObject({ ok: false, error: { code: 'installation_changed' } });
    const run = await runs.claim(tenantId, channel.channelId, 'cleanup', now, 10000);
    if (!run) throw new Error('Missing guild drain claim');
    const fence = { runId: run.runId, owner: 'cleanup', epoch: run.leaseEpoch };
    await runs.markAuthorityLost(tenantId, fence, now);
    await runs.finishAuthorityLost(tenantId, fence, now);
    expect(await channels.deleteAgentChannel(channel.channelId, admin)).toEqual({
      status: 'deleted',
    });
    const recovered = value(
      await installations.connectGuild({
        actorId: admin,
        applicationId,
        applicationRevision: app.revision,
        guildId,
        guildName: 'Verified recovery',
      }),
    );
    expect(recovered.installationId).not.toBe(guild.installationId);
  }));

it('keeps application secrets when a dependent closure fails and completes the cascade on retry', () =>
  scope(async () => {
    await inbox.submit(input(), now);
    const spy = jest
      .spyOn(db.models.ChannelScope.collection, 'updateOne')
      .mockRejectedValueOnce(new Error('scope closure unavailable'));
    await expect(users.deleteUserById(installer)).rejects.toThrow('scope closure unavailable');
    spy.mockRestore();
    expect(await installations.readApplicationCredentials(applicationId)).toHaveProperty(
      'encryptedClientSecret',
      'private-secret',
    );
    expect(await db.models.DiscordInbox.countDocuments()).toBe(1);
    expect(await db.models.DiscordReservation.findOne({ applicationId }).lean()).toMatchObject({
      retiring: true,
    });
    expect((await users.deleteUserById(installer)).deletedCount).toBe(1);
    expect(await db.models.DiscordApplication.countDocuments()).toBe(0);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
  }));

it('erases tenantless Discord setup without affecting an organization installation', async () => {
  await tenantStorage.run({ tenantId: undefined }, async () => {
    const userId = '000000000000000000000004';
    const appId = '123456789012345679';
    await db.models.User.create({
      _id: userId,
      email: 'tenantless@example.test',
      provider: 'local',
    });
    const configured = value(
      await installations.configureApplication({ ...configuration(userId), applicationId: appId }),
    );
    const installed = value(
      await installations.connectGuild({
        actorId: userId,
        applicationId: appId,
        applicationRevision: configured.revision,
        guildId,
        guildName: 'Tenantless guild',
      }),
    );
    await channels.createAgentChannel({
      type: 'discord',
      channelId: 'tenantless',
      agentId: 'agent',
      createdBy: userId,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'tenantless-revision',
      installationId: installed.installationId,
      installationRevision: installed.revision,
      discord: { applicationId: appId, guildId, botUserId, externalChannelId },
      applicationRevision: configured.revision,
    });
    value(
      await createDiscordRouteStorage(db).assign({
        actorId: userId,
        installationId: installed.installationId,
        installationRevision: installed.revision,
        applicationRevision: configured.revision,
        externalChannelId,
        channelId: 'tenantless',
        channelRevision: 'tenantless-revision',
      }),
    );
    // Restores may contain the legacy empty-string tenant partition.
    await db.models.DiscordReservation.collection.updateOne(
      { applicationId: appId },
      { $set: { tenantId: '' } },
    );
    const activated = await channels.getAgentChannelMetadata('tenantless');
    if (!activated) throw new Error('Missing tenantless binding');
    expect(
      await inbox.submit(
        {
          ...input(),
          applicationId: appId,
          applicationRevision: configured.revision,
          channelId: 'tenantless',
          channelRevision: activated.revision,
        },
        now,
      ),
    ).toMatchObject({ ok: true });
    expect((await runAsSystem(async () => users.deleteUserById(userId))).deletedCount).toBe(1);
    expect(await installations.readApplication(appId)).toBeNull();
    expect(await channels.getAgentChannel('tenantless')).toBeNull();
    expect(await db.models.DiscordInbox.countDocuments()).toBe(0);
    const reservation = await db.models.DiscordReservation.findOne({ applicationId: appId }).lean();
    expect(reservation).toHaveProperty('tenantId', '');
    expect(reservation).toMatchObject({ applicationId: appId, retiring: true });
    const recoveryId = '000000000000000000000005';
    await db.models.User.create({
      _id: recoveryId,
      email: 'recovery@example.test',
      provider: 'local',
    });
    await db.models.AgentChannel.create({
      tenantId: '',
      type: 'discord',
      channelId: 'restored-empty',
      createdBy: recoveryId,
      agentId: 'agent',
      status: 'deleting',
      revision: 'old',
      credentialMode: 'per_user',
      installationId: installed.installationId,
      installationRevision: installed.revision,
      discord: { applicationId: appId, guildId, botUserId, externalChannelId },
    });
    const recovery = { ...configuration(recoveryId), applicationId: appId };
    expect(await installations.configureApplication(recovery)).toMatchObject({
      ok: false,
      error: { code: 'application_unavailable' },
    });
    await db.models.AgentChannel.deleteOne({ channelId: 'restored-empty' });
    expect(await installations.configureApplication(recovery)).toMatchObject({
      ok: true,
      value: { createdBy: recoveryId },
    });
  });
  await scope(async () => {
    expect(await installations.readApplication(applicationId)).not.toBeNull();
    expect(await channels.getActiveAgentChannel(channel.channelId)).toMatchObject({
      status: 'active',
    });
  });
});

it('retires encrypted Gateway sessions and locks before removing their application, with retry after failure', () =>
  scope(async () => {
    const gateway = createDiscordGatewayStorage(db, async () => ({
      ownershipLeaseMs: 30000,
      shardCount: 1,
    }));
    const original = { applicationId, applicationRevision: app.revision, ownerId: 'a'.repeat(32) };
    expect(await gateway.acquire(original, 30000)).toBe(true);
    expect(
      await gateway.save(original, botUserId, [
        { shardId: 0, encryptedSession: 'private-session' },
      ]),
    ).toBe(true);
    const otherId = '123456789012345679';
    const other = value(
      await installations.configureApplication({ ...configuration(admin), applicationId: otherId }),
    );
    const replacement = {
      applicationId: otherId,
      applicationRevision: other.revision,
      ownerId: 'b'.repeat(32),
    };
    await gateway.acquire(replacement, 30000);
    await gateway.save(replacement, botUserId, [
      { shardId: 0, encryptedSession: 'other-private-session' },
    ]);
    const failure = jest
      .spyOn(db.models.DiscordGatewayCheckpoint.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('checkpoint unavailable'));
    await expect(users.deleteUserById(installer)).rejects.toThrow('checkpoint unavailable');
    failure.mockRestore();
    expect(await db.models.DiscordApplication.exists({ applicationId })).not.toBeNull();
    expect(await db.models.DiscordGatewayCheckpoint.countDocuments({ applicationId })).toBe(1);
    expect(
      await db.models.ResourceLock.exists({ key: `discord:gateway:${applicationId}` }),
    ).not.toBeNull();
    expect((await users.deleteUserById(installer)).deletedCount).toBe(1);
    expect(await db.models.DiscordApplication.exists({ applicationId })).toBeNull();
    expect(await db.models.DiscordGatewayCheckpoint.countDocuments({ applicationId })).toBe(0);
    expect(
      await db.models.ResourceLock.exists({ key: `discord:gateway:${applicationId}` }),
    ).toBeNull();
    expect((await gateway.load(replacement))?.checkpoints).toMatchObject([
      { encryptedSession: 'other-private-session' },
    ]);
  }));

it('drains orphaned private DM inbox payloads by their source account before deleting selection anchors and retains opaque dedup receipts', () =>
  scope(async () => {
    const seed = input();
    const base = { ...seed, guildId: undefined };
    await db.models.DiscordInbox.create([
      {
        ...base,
        tenantId,
        fingerprint: 'a'.repeat(64),
        state: 'queued',
        receivedAt: now,
        purgeAt: new Date(now + 900000),
        nextAttemptAt: now,
        leaseEpoch: 0,
        leaseExpiresAt: 0,
        authorityWrites: 0,
        dm: {
          selectionId: 'selection',
          selectionRevision: 'generation',
          parentChannelId: externalChannelId,
          confirmationEventId: '123456789012345678',
          source: { applicationId, guildId, userId: member },
        },
      },
      {
        ...base,
        eventId: '567890123456789013',
        tenantId,
        fingerprint: 'b'.repeat(64),
        state: 'queued',
        receivedAt: now,
        purgeAt: new Date(now + 900000),
        nextAttemptAt: now,
        leaseEpoch: 0,
        leaseExpiresAt: 0,
        authorityWrites: 0,
        dm: { source: { applicationId, guildId, userId: admin } },
      },
    ]);
    const failure = jest
      .spyOn(db.models.DiscordInbox.collection, 'deleteMany')
      .mockRejectedValueOnce(new Error('private cleanup unavailable'));
    await expect(users.deleteUserById(member)).rejects.toThrow('private cleanup unavailable');
    failure.mockRestore();
    expect(await db.models.DiscordInbox.countDocuments()).toBe(2);
    expect((await users.deleteUserById(member)).deletedCount).toBe(1);
    expect(await db.models.DiscordInbox.countDocuments()).toBe(1);
    expect(await db.models.DiscordInbox.findOne().lean()).toMatchObject({
      dm: { source: { userId: admin } },
    });
    expect(await db.models.DiscordReceipt.findOne({ eventId }).lean()).toMatchObject({
      fingerprint: 'a'.repeat(64),
    });
  }));

it('erases the DM inbox rows of an account addressed by the ObjectId createUser returns', () =>
  scope(async () => {
    // registerUser hands this ObjectId to the string-typed parameter when verification mail fails.
    const created = (await users.createUser(
      { email: 'registered@example.test', provider: 'local', tenantId },
      undefined,
      true,
      true,
    )) as { _id: mongoose.Types.ObjectId };
    expect(created._id).toBeInstanceOf(mongoose.Types.ObjectId);
    const row = {
      ...input(),
      guildId: undefined,
      tenantId,
      state: 'queued',
      receivedAt: now,
      purgeAt: new Date(now + 900000),
      nextAttemptAt: now,
      leaseEpoch: 0,
      leaseExpiresAt: 0,
      authorityWrites: 0,
    };
    await db.models.DiscordInbox.create([
      {
        ...row,
        fingerprint: 'a'.repeat(64),
        dm: { source: { applicationId, guildId, userId: created._id.toString() } },
      },
      {
        ...row,
        eventId: '567890123456789013',
        fingerprint: 'b'.repeat(64),
        dm: { source: { applicationId, guildId, userId: admin } },
      },
    ]);

    await expect(users.deleteUserById(created._id as unknown as string)).resolves.toMatchObject({
      deletedCount: 1,
    });

    expect(await db.models.User.exists({ _id: created._id })).toBeNull();
    expect(await db.models.DiscordInbox.find().lean()).toMatchObject([
      { dm: { source: { userId: admin } } },
    ]);
  }));

it('erases no-guild restored DM rows by their real source guild while preserving other guilds and tenants', () =>
  scope(async () => {
    const row = {
      ...input(),
      guildId: undefined,
      tenantId,
      channelId: 'retired-channel',
      fingerprint: 'c'.repeat(64),
      state: 'queued',
      receivedAt: now,
      purgeAt: new Date(now + 900000),
      nextAttemptAt: now,
      leaseEpoch: 0,
      leaseExpiresAt: 0,
      authorityWrites: 0,
    };
    await db.models.DiscordInbox.create([
      { ...row, dm: { source: { applicationId, guildId, userId: member } } },
      {
        ...row,
        eventId: '567890123456789013',
        dm: { source: { applicationId, guildId: '234567890123456790', userId: member } },
      },
      {
        ...row,
        eventId: '567890123456789014',
        tenantId: 'another-org',
        dm: { source: { applicationId, guildId, userId: member } },
      },
    ]);
    await createDiscordInboxErasure(db, async () => {}).erase(
      { kind: 'guild', tenantId, applicationId, guildId },
      1,
    );
    expect(await db.models.DiscordInbox.countDocuments()).toBe(1);
    expect(await db.models.DiscordReceipt.findOne({ eventId }).lean()).toMatchObject({
      fingerprint: 'c'.repeat(64),
    });
    await scope(
      async () => expect(await db.models.DiscordInbox.countDocuments()).toBe(1),
      'another-org',
    );
  }));
