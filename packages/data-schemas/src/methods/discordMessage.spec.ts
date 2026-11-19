import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { tenantStorage, runAsSystem } from '~/config/tenantContext';
import { createChannelIdentityStorage } from './channelIdentity';
import { createDiscordMessageStorage } from './discordMessage';
import { createDiscordGatewayStorage } from './discordGateway';
import { createDiscordInstallationStorage } from './discord';
import { createDiscordRouteStorage } from './discordRoute';
import { createChannelRunStorage } from './channelRun';
import { createAgentChannelMethods } from './channel';
import { createUserMethods } from './user';
import { createModels } from '~/models';

const db = new mongoose.Mongoose();
const models = createModels(db);
const tenantId = 'discord-message';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const guildId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const messageId = '678901234567890123';
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const channels = createAgentChannelMethods(db);
const installs = createDiscordInstallationStorage(db);
const gateway = createDiscordGatewayStorage(db, async () => ({
  ownershipLeaseMs: 30000,
  shardCount: 1,
}));
const messages = createDiscordMessageStorage(db);
const runs = createChannelRunStorage(db);
const route = {
  channelId: 'channel',
  channelRevision: 'revision',
  agentId: 'agent',
  guildId,
  externalChannelId,
};
let mongo: MongoMemoryReplSet;
let revision: string;
const owner = () => ({ applicationId, applicationRevision: revision, ownerId: 'a'.repeat(32) });
const occurrence = () => ({
  applicationId,
  messageId,
  fingerprint: 'a'.repeat(64),
  purgeAt: Date.now() + 900000,
});
const enrollment = () => ({
  tenantId,
  channelId: route.channelId,
  agentId: route.agentId,
  applicationRevision: revision,
  discordGateway: { owner: owner(), occurrence: occurrence() },
  principal: {
    userId,
    channelRevision: route.channelRevision,
    linkId: 'link',
    linkRevision: 'link-revision',
  },
  admission: {
    eventId: messageId,
    externalChannelId,
    externalThreadKey: `${externalChannelId}:${messageId}`,
    externalMessageKey: `${externalChannelId}:${messageId}`,
    actor: { provider: 'discord' as const, applicationId, guildId, externalUserId },
    input: 'question',
  },
});
async function linked() {
  expect(
    await createChannelIdentityStorage(db).saveChannelIdentity(
      {
        tenantId,
        linkId: 'link',
        revision: 'link-revision',
        state: 'active',
        ticketHash: 'private-ticket',
        ticketExpiresAtMs: Date.now() + 900000,
        expiresAtMs: Date.now() + 900000,
        userId,
        identity: {
          tenantId,
          channelId: route.channelId,
          channelRevision: route.channelRevision,
          agentId: route.agentId,
          provider: 'discord',
          applicationId,
          guildId,
          externalUserId,
        },
      },
      null,
      revision,
    ),
  ).toBe(true);
  await models.ChannelIdentity.updateOne(
    { linkId: 'link' },
    { $set: { discordActivatedAtMs: Number(BigInt(messageId) >> BigInt(22)) + 1420070400000 - 1 } },
  );
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  await scoped(async () => {
    await models.User.create({
      _id: userId,
      tenantId,
      email: 'owner@example.test',
      provider: 'local',
      role: 'USER',
    });
    const app = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'encrypted-bot',
      encryptedClientSecret: 'encrypted-client',
    });
    if (!app.ok) throw new Error('Fixture app unavailable');
    revision = app.value.revision;
    const guild = await installs.connectGuild({
      actorId: userId,
      applicationId,
      applicationRevision: revision,
      guildId,
      guildName: 'Guild',
    });
    if (!guild.ok) throw new Error('Fixture guild unavailable');
    await channels.createAgentChannel({
      type: 'discord',
      tenantId,
      channelId: route.channelId,
      agentId: route.agentId,
      createdBy: userId,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'revision',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
      applicationRevision: revision,
    });
    const assigned = await createDiscordRouteStorage(db).assign({
      actorId: userId,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision: revision,
      externalChannelId,
      channelId: route.channelId,
      channelRevision: 'revision',
    });
    if (!assigned.ok) throw new Error('Fixture route unavailable');
    const active = await channels.getAgentChannelMetadata(route.channelId);
    if (!active) throw new Error('Fixture active channel unavailable');
    route.channelRevision = active.revision;
    if (!(await gateway.acquire(owner(), 30000))) throw new Error('Fixture owner unavailable');
  });
});
it('atomically records run admission and globally consumes a replay before any second lane is allocated', () =>
  scoped(async () => {
    await linked();
    await runs.admit(enrollment(), Date.now());
    expect(await models.ChannelRun.countDocuments()).toBe(1);
    expect(
      await models.DiscordMessageReceipt.findOne({ applicationId, messageId }).lean(),
    ).toMatchObject({ outcome: 'admitted', fingerprint: 'a'.repeat(64) });
    await expect(runs.admit(enrollment(), Date.now())).rejects.toMatchObject({
      code: 'event_consumed',
    });
    expect(await models.ChannelLane.countDocuments()).toBe(1);
    const changed = enrollment();
    changed.discordGateway.occurrence.fingerprint = 'b'.repeat(64);
    await expect(runs.admit(changed, Date.now())).rejects.toMatchObject({ code: 'event_conflict' });
  }));
it('consumes unlinked messages without storing the prompt, and later consent cannot revive them', () =>
  scoped(async () => {
    expect(await messages.ignore(owner(), occurrence(), route)).toBe('ignored');
    const receipt = await models.DiscordMessageReceipt.findOne({ applicationId, messageId }).lean();
    expect(Object.keys(receipt!).sort()).toEqual([
      '_id',
      'applicationId',
      'fingerprint',
      'messageId',
      'outcome',
      'purgeAt',
    ]);
    expect(await models.ChannelRun.countDocuments()).toBe(0);
    await linked();
    await expect(runs.admit(enrollment(), Date.now())).rejects.toMatchObject({
      code: 'event_consumed',
    });
    expect(await messages.ignore(owner(), occurrence(), route)).toBe('duplicate');
    expect(await models.ChannelRun.countDocuments()).toBe(0);
    expect((await createUserMethods(db).deleteUserById(userId)).deletedCount).toBe(1);
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(1);
  }));
it('rejects stale owners, revoked links, wrong physical destinations and rotated applications without creating receipts', () =>
  scoped(async () => {
    await linked();
    const stale = enrollment();
    stale.discordGateway.owner.ownerId = 'b'.repeat(32);
    await expect(runs.admit(stale, Date.now())).rejects.toMatchObject({ code: 'stale_fence' });
    const wrong = enrollment();
    wrong.admission.externalChannelId = '999999999999999999';
    await expect(runs.admit(wrong, Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    await models.ChannelIdentity.updateOne({ linkId: 'link' }, { $set: { state: 'revoked' } });
    await expect(runs.admit(enrollment(), Date.now())).rejects.toMatchObject({
      code: 'invalid_transition',
    });
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(0);
    await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      expectedRevision: revision,
    });
    await expect(messages.ignore(owner(), occurrence(), route)).rejects.toMatchObject({
      code: 'stale_fence',
    });
  }));
it('serializes concurrent ignore/admit decisions and rejects account closure', () =>
  scoped(async () => {
    await linked();
    const outcomes = await Promise.allSettled([
      messages.ignore(owner(), occurrence(), route),
      runs.admit(enrollment(), Date.now()),
    ]);
    expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true);
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(1);
    const receipt = await models.DiscordMessageReceipt.findOne({ applicationId, messageId }).lean();
    expect(await models.ChannelRun.countDocuments()).toBe(receipt?.outcome === 'admitted' ? 1 : 0);
    await models.User.updateOne(
      { _id: userId },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );
    await expect(
      messages.ignore(owner(), { ...occurrence(), messageId: '678901234567890124' }, route),
    ).rejects.toMatchObject({ code: 'stale_fence' });
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(1);
  }));
