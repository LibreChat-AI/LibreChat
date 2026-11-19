import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  PermissionTypes,
  Permissions,
  PermissionBits,
  discordChannelConfigSchema,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordGatewayStorage,
  createDiscordMessageStorage,
  createChannelIdentityStorage,
  createChannelRunStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type {
  DiscordAgentChannel,
  DiscordMessageSubmission,
  DiscordChannelConfig,
} from 'librechat-data-provider';
import { createDiscordMessageHandlers } from './messageHttp';
import { createDiscordMessageService } from './messages';
import { createDiscordRouteResolver } from './routes';
import { createChannelAuthority } from '../authority';

const db = new mongoose.Mongoose();
const models = createModels(db);
const channels = createMethods(db);
const installations = createDiscordInstallationStorage(db);
const identities = createChannelIdentityStorage(db);
const runs = createChannelRunStorage(db);
const tenantId = 'message-api';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const guildId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const token = 'private-service-token'.repeat(2);
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
let mongo: MongoMemoryReplSet;
let revision: string;
let channel: DiscordAgentChannel;
let policy: DiscordChannelConfig;
let allowed: boolean;
let clock: number;
let sequence: number;
const gateway = createDiscordGatewayStorage(db, async () => ({
  ownershipLeaseMs: 30000,
  shardCount: 1,
}));
const authority = createChannelAuthority({
  channels,
  identityStorage: identities,
  getConfig: async () => ({ enabled: policy.enabled }),
  findUser: (id) => channels.findUser({ _id: id }),
  getRole: (name) => models.Role.findOne({ name }),
  isPrincipalActive: async () => true,
  getAgentPermissions: async () => (allowed ? PermissionBits.VIEW : 0),
});
const resolver = createDiscordRouteResolver({
  installations,
  channels,
  routes: createDiscordRouteStorage(db),
  enabled: async () => policy.enabled,
});
const service = createDiscordMessageService({
  installations,
  channels,
  authority,
  resolver,
  messages: createDiscordMessageStorage(db),
  runs,
  settings: async () => policy,
  now: () => clock,
});
const owner = () => ({ applicationId, applicationRevision: revision, ownerId: 'a'.repeat(32) });
function submission(content = `<@${botUserId}> question`, age = 0): DiscordMessageSubmission {
  const messageId = String(
    (BigInt(clock - age - 1420070400000) << BigInt(22)) + BigInt(++sequence),
  );
  return {
    owner: owner(),
    event: {
      ...owner(),
      kind: 'message',
      shardId: 0,
      sequence,
      messageId,
      channelId: externalChannelId,
      guildId,
      authorId: externalUserId,
      mentionsBot: true,
      content,
    },
    source: {
      kind: 'guild_text',
      applicationId,
      botUserId,
      guildId,
      channelId: externalChannelId,
      permissions: String(1024 | 2048 | 65536),
    },
  };
}
async function linked() {
  expect(
    await identities.saveChannelIdentity(
      {
        tenantId,
        linkId: 'link',
        revision: 'link-revision',
        state: 'active',
        userId,
        ticketHash: 'private-ticket',
        ticketExpiresAtMs: clock + 900000,
        expiresAtMs: clock + 900000,
        identity: {
          tenantId,
          channelId: channel.channelId,
          channelRevision: channel.revision,
          agentId: channel.agentId,
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
}
function server(value = service) {
  const app = express();
  app.use(express.json());
  app.post(
    '/messages',
    createDiscordMessageHandlers({ service: value, serviceToken: () => token }).submit,
  );
  return app;
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
  clock = Date.now();
  sequence = 0;
  allowed = true;
  policy = discordChannelConfigSchema.parse({ enabled: true, gateway: { enabled: true } });
  await scoped(async () => {
    await models.User.create({
      _id: userId,
      tenantId,
      provider: 'local',
      role: 'USER',
      email: 'owner@example.test',
    });
    await models.Role.create({
      name: 'USER',
      permissions: {
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
      },
    });
    const app = await installations.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'sealed',
      encryptedClientSecret: 'sealed',
    });
    if (!app.ok) throw new Error('Fixture app unavailable');
    revision = app.value.revision;
    const guild = await installations.connectGuild({
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
      channelId: 'channel',
      agentId: 'agent',
      createdBy: userId,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'initial',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision: revision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    });
    const assigned = await createDiscordRouteStorage(db).assign({
      actorId: userId,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision: revision,
      externalChannelId,
      channelId: 'channel',
      channelRevision: 'initial',
    });
    if (!assigned.ok) throw new Error('Fixture route unavailable');
    const active = await channels.getAgentChannelMetadata('channel');
    if (!active || active.type !== 'discord') throw new Error('Fixture active channel unavailable');
    channel = active;
    if (!(await gateway.acquire(owner(), 30000))) throw new Error('Fixture owner unavailable');
  });
});
it('admits exact text mentions, strips only the bot token and deduplicates sequence replay into one fresh lane', async () => {
  await scoped(linked);
  const input = submission(`<@!${botUserId}> question <@999>`);
  expect(await service.submit(input)).toEqual({ ok: true, value: { outcome: 'admitted' } });
  expect(
    await service.submit({ ...input, event: { ...input.event, sequence: 900, shardId: 0 } }),
  ).toEqual({ ok: true, value: { outcome: 'duplicate' } });
  await scoped(async () => {
    const run = await models.ChannelRun.findOne().lean();
    expect(run?.admission).toMatchObject({
      input: 'question <@999>',
      externalChannelId,
      externalThreadKey: `${externalChannelId}:${input.event.messageId}`,
    });
    expect(await models.ChannelRun.countDocuments()).toBe(1);
    expect(await models.ChannelLane.countDocuments()).toBe(1);
  });
});
it('durably ignores unlinked or denied prompts and never replays them automatically after consent or permission changes', async () => {
  const old = submission();
  expect(await service.submit(old)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'link_required' },
  });
  await scoped(linked);
  expect(await service.submit(old)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
  allowed = false;
  const denied = submission();
  expect(await service.submit(denied)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  allowed = true;
  expect(await service.submit(denied)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
  await scoped(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  });
  expect(JSON.stringify(await models.DiscordMessageReceipt.find().lean())).not.toContain(
    'question',
  );
});
it('rejects forged source identifiers, stale owners and fingerprint conflicts while keeping the physical event consumed across rotation', async () => {
  await scoped(linked);
  const input = submission();
  expect(
    (
      await service.submit({
        ...input,
        source: { ...input.source!, channelId: '999999999999999999' },
      })
    ).ok,
  ).toBe(false);
  expect(
    (
      await service.submit({
        ...input,
        owner: { ...owner(), ownerId: 'b'.repeat(32) },
        event: { ...input.event, ownerId: 'b'.repeat(32) },
      })
    ).ok,
  ).toBe(false);
  expect((await service.submit(input)).ok).toBe(true);
  expect(
    await service.submit({
      ...input,
      event: { ...input.event, content: `<@${botUserId}> changed` },
    }),
  ).toEqual({ ok: false, error: { code: 'event_conflict' } });
  const oldOwner = owner();
  await scoped(async () => {
    const rotated = await installations.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      expectedRevision: revision,
    });
    if (!rotated.ok) throw new Error('Fixture rotation unavailable');
    revision = rotated.value.revision;
    await gateway.release(oldOwner);
    await gateway.acquire(owner(), 30000);
  });
  expect(
    await service.submit({ ...input, owner: owner(), event: { ...input.event, ...owner() } }),
  ).toEqual({ ok: true, value: { outcome: 'duplicate' } });
});
it('keeps the physical event consumed when its text channel is rebound to a different agent', async () => {
  await scoped(linked);
  const input = submission();
  expect((await service.submit(input)).ok).toBe(true);
  await scoped(async () => {
    const routes = createDiscordRouteStorage(db);
    const old = await routes.read(channel.installationId, externalChannelId);
    if (!old) throw new Error('Fixture original route unavailable');
    await routes.remove({
      actorId: userId,
      installationId: channel.installationId,
      externalChannelId,
      expectedRevision: old.revision,
    });
    await channels.createAgentChannel({
      ...channel,
      channelId: 'replacement',
      agentId: 'other-agent',
      revision: 'initial',
      status: 'pending_install',
      applicationRevision: revision,
    });
    const assigned = await routes.assign({
      actorId: userId,
      installationId: channel.installationId,
      installationRevision: channel.installationRevision,
      applicationRevision: revision,
      externalChannelId,
      channelId: 'replacement',
      channelRevision: 'initial',
    });
    if (!assigned.ok) throw new Error('Fixture replacement route unavailable');
  });
  expect(await service.submit(input)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
  await scoped(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(1);
  });
});
it('filters implicit replies, other mentions, unsupported DMs and missing current permissions without creating runs', async () => {
  await scoped(linked);
  expect(await service.submit(submission('reply without literal mention'))).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unsupported' },
  });
  expect(await service.submit(submission('<@999> question'))).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unsupported' },
  });
  const dm = submission();
  delete dm.event.guildId;
  dm.source = null;
  expect(await service.submit(dm)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unsupported' },
  });
  const noPermission = submission();
  noPermission.source = null;
  expect(await service.submit(noPermission)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  const thread = submission();
  thread.event.channelType = 11;
  thread.source = null;
  expect((await service.submit(thread)).ok).toBe(true);
  await scoped(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  });
});
it('bounds message age through receipt cleanup and retains future-clock receipts past the event freshness deadline', async () => {
  await scoped(linked);
  const ancient = submission(undefined, 900001);
  expect(await service.submit(ancient)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'expired' },
  });
  const future = submission(undefined, -1000);
  expect((await service.submit(future)).ok).toBe(true);
  const receipt = await models.DiscordMessageReceipt.findOne({
    messageId: future.event.messageId,
  }).lean();
  expect(receipt!.purgeAt.getTime()).toBeGreaterThanOrEqual(
    clock + 1000 + policy.inbox.retentionMs,
  );
  policy = { ...policy, gateway: { ...policy.gateway, messageMaxAgeMs: 1000 } };
  const expired = submission(undefined, 2000);
  expect(await service.submit(expired)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'expired' },
  });
  policy = { ...policy, gateway: { ...policy.gateway, messageMaxAgeMs: 900000 } };
  expect(await service.submit(expired)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
});
it('rechecks freshness after asynchronous principal authorization before creating the run', async () => {
  await scoped(linked);
  const input = submission();
  let reads = 0;
  const delayed = createDiscordMessageService({
    installations,
    channels,
    authority,
    resolver,
    messages: createDiscordMessageStorage(db),
    runs,
    settings: async () => {
      if (++reads === 2) clock += 900001;
      return policy;
    },
    now: () => clock,
  });
  expect(await delayed.submit(input)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'expired' },
  });
  await scoped(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  });
});
it('protects HTTP ingress, ignores caller tenant headers and sanitizes unexpected failures', async () => {
  const app = server();
  const input = submission();
  expect((await request(app).post('/messages').send(input)).status).toBe(401);
  expect(
    (
      await request(app)
        .post('/messages')
        .set('Authorization', `Bearer ${token}`)
        .send({ ...input, tenantId: 'foreign' })
    ).status,
  ).toBe(400);
  const accepted = await request(app)
    .post('/messages')
    .set('Authorization', `Bearer ${token}`)
    .set('X-Tenant-Id', 'foreign')
    .send(input);
  expect(accepted.status).toBe(200);
  expect(accepted.headers['cache-control']).toBe('no-store');
  expect(accepted.body).toEqual({ outcome: 'ignored', reason: 'link_required' });
  const broken = createDiscordMessageService({
    installations,
    channels,
    authority,
    resolver,
    messages: createDiscordMessageStorage(db),
    runs,
    settings: async () => {
      throw new Error('private-bot-token private-prompt');
    },
  });
  const failed = await request(server(broken))
    .post('/messages')
    .set('Authorization', `Bearer ${token}`)
    .send(input);
  expect(failed.status).toBe(503);
  expect(failed.body).toEqual({ error: 'discord_message_unavailable' });
});
