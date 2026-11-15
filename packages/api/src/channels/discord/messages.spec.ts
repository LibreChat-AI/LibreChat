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
  discordGuildTextActorSourceSchema,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordGatewayStorage,
  createDiscordMessageStorage,
  createDiscordInboxStorage,
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
let interactionSequence: number;
let gatewayOwnerId: string;
const gateway = createDiscordGatewayStorage(db, async () => ({
  ownershipLeaseMs: 30000,
  shardCount: 1,
}));
const authority = createChannelAuthority({
  publicBaseUrl: 'http://127.0.0.1:3080',
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
const owner = () => ({ applicationId, applicationRevision: revision, ownerId: gatewayOwnerId });
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
      authorId: externalUserId,
      authorMember: true,
      authorPermissions: '1024',
    },
  };
}
async function linked(accountId = userId) {
  const unwrap = <T>(
    result: { ok: true; value: T } | { ok: false; error: { code: string } },
  ): T => {
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const identity = {
    tenantId,
    channelId: channel.channelId,
    channelRevision: channel.revision,
    agentId: channel.agentId,
    provider: 'discord' as const,
    applicationId,
    guildId,
    externalUserId,
  };
  const previous = await identities.readChannelIdentity(identity);
  if (previous?.userId && Number.isSafeInteger(previous.discordActivatedAtMs))
    unwrap(
      await authority.identity.revoke(
        { tenantId, userId: previous.userId, accountLabel: 'Previous account' },
        previous.linkId,
        previous.revision,
      ),
    );
  const inbox = createDiscordInboxStorage(db);
  const interaction = async (action: { kind: 'link' } | { kind: 'confirm'; reference: string }) => {
    const timestamp = Date.now();
    const eventId = String(
      (BigInt(timestamp - 1420070400000) << BigInt(22)) + BigInt(++interactionSequence),
    );
    unwrap(
      await inbox.submit(
        {
          eventId,
          applicationId,
          applicationRevision: revision,
          guildId,
          channelId: channel.channelId,
          channelRevision: channel.revision,
          agentId: channel.agentId,
          externalChannelId,
          externalUserId,
          action,
          encryptedToken: 'sealed',
          tokenHash: 'a'.repeat(64),
          expiresAt: timestamp + 900000,
        },
        timestamp,
      ),
    );
    const record = await inbox.claim(applicationId, 'consent-worker', timestamp);
    if (!record) throw new Error('Missing consent interaction');
    return {
      applicationRevision: revision,
      fence: { applicationId, eventId, owner: 'consent-worker', epoch: record.leaseEpoch },
    };
  };
  const finish = async (ingress: Awaited<ReturnType<typeof interaction>>) => {
    unwrap(await inbox.prepareReply(ingress.fence, 'sealed-reply', Date.now()));
    expect(await inbox.finish(ingress.fence, 'completed', Date.now())).toBe(true);
  };
  const issuedInteraction = await interaction({ kind: 'link' });
  const issued = unwrap(await authority.identity.issue(identity, issuedInteraction));
  await finish(issuedInteraction);
  const secret = new URL(issued.url).hash.slice(1);
  const principal = { tenantId, userId: accountId, accountLabel: 'Selected account' };
  const preview = unwrap(await authority.identity.preview(principal, secret));
  const accepted = unwrap(await authority.identity.accept(principal, secret, preview.revision));
  const confirmation = await interaction({
    kind: 'confirm',
    reference: accepted.linkId + accepted.revision,
  });
  unwrap(
    await authority.identity.confirm(identity, accepted.linkId, accepted.revision, confirmation),
  );
  await finish(confirmation);
  clock = Date.now() + 2;
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
  interactionSequence = 1000;
  gatewayOwnerId = 'a'.repeat(32);
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

it.each([false, true])(
  'does not replay an old prompt under replacement consent after owner loss %s',
  async (loseOwner) => {
    await scoped(() => linked());
    const otherId = '000000000000000000000002';
    await scoped(async () => {
      await models.User.create({
        _id: otherId,
        tenantId,
        provider: 'local',
        role: 'USER',
        email: 'other@example.test',
      });
    });
    const input = submission();
    let switched = false;
    const raced = createDiscordMessageService({
      installations,
      channels,
      resolver,
      messages: createDiscordMessageStorage(db),
      runs,
      settings: async () => policy,
      now: () => clock,
      authority: {
        ...authority,
        resolvePrincipal: async (bound, actor) => {
          const original = await authority.resolvePrincipal(bound, actor);
          if (!switched) {
            switched = true;
            if (loseOwner) {
              expect(await gateway.release(owner())).toBe(true);
              gatewayOwnerId = 'b'.repeat(32);
              expect(await gateway.acquire(owner(), 30000)).toBe(true);
            }
            await linked(otherId);
          }
          return original;
        },
      },
    });
    expect(await raced.submit(input)).not.toEqual({ ok: true, value: { outcome: 'admitted' } });
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(loseOwner ? 0 : 1);
    const replay = await service.submit({
      ...input,
      owner: owner(),
      event: { ...input.event, ...owner() },
    });
    expect(replay).not.toEqual({ ok: true, value: { outcome: 'admitted' } });
    expect(
      await models.DiscordMessageReceipt.findOne({ messageId: input.event.messageId }).lean(),
    ).toMatchObject({ outcome: 'ignored' });
    expect(await service.submit(submission())).toEqual({
      ok: true,
      value: { outcome: 'admitted' },
    });
    await scoped(async () => {
      const stored = await models.ChannelRun.findOne().lean();
      expect(stored?.principal.userId).toBe(otherId);
      expect(await models.ChannelRun.countDocuments()).toBe(1);
    });
  },
);

it('rejects first ingestion of a physical message created before native confirmation', async () => {
  const old = submission();
  await scoped(() => linked());
  expect(await service.submit(old)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  expect(await service.submit(old)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
  expect(await service.submit(submission())).toEqual({ ok: true, value: { outcome: 'admitted' } });
});

it('keeps confirmed consent stable across active saves, owner takeover and credential rotation', async () => {
  await scoped(() => linked());
  const input = submission();
  const oldOwner = owner();
  await scoped(async () => {
    const link = await models.ChannelIdentity.findOne().lean();
    if (!link || !link.discordActivatedAtMs) throw new Error('Missing native confirmation');
    const saved = await identities.readChannelLink(tenantId, link.linkId);
    if (!saved) throw new Error('Missing link');
    expect(
      await identities.saveChannelIdentity(
        { ...saved, accountLabel: 'Changed label', discordActivatedAtMs: Date.now() + 100000 },
        saved.revision,
        revision,
      ),
    ).toBe(true);
    expect((await identities.readChannelLink(tenantId, link.linkId))?.discordActivatedAtMs).toBe(
      link.discordActivatedAtMs,
    );
    const rotated = await installations.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'b'.repeat(64),
      encryptedBotToken: 'rotated',
      expectedRevision: revision,
    });
    if (!rotated.ok) throw new Error(rotated.error.code);
    revision = rotated.value.revision;
    await gateway.release(oldOwner);
    gatewayOwnerId = 'b'.repeat(32);
    expect(await gateway.acquire(owner(), 30000)).toBe(true);
  });
  expect(await service.submit(input)).toMatchObject({ ok: false });
  expect(await models.DiscordMessageReceipt.countDocuments()).toBe(0);
  const replay = { ...input, owner: owner(), event: { ...input.event, ...owner() } };
  expect(await service.submit(replay)).toEqual({ ok: true, value: { outcome: 'admitted' } });
  expect(await service.submit(replay)).toEqual({ ok: true, value: { outcome: 'duplicate' } });
});

it('keeps operational database failures retryable under unchanged consent', async () => {
  await scoped(() => linked());
  const input = submission();
  const failure = jest
    .spyOn(models.ChannelRun.collection, 'insertOne')
    .mockRejectedValueOnce(new Error('database outage'));
  try {
    await expect(service.submit(input)).rejects.toThrow('database outage');
  } finally {
    failure.mockRestore();
  }
  expect(await models.DiscordMessageReceipt.countDocuments()).toBe(0);
  expect(await service.submit(input)).toEqual({ ok: true, value: { outcome: 'admitted' } });
});

it('requires fresh native confirmation for restored markerless links without interrupting an authorized run', async () => {
  await scoped(() => linked());
  const input = submission();
  expect(await service.submit(input)).toEqual({ ok: true, value: { outcome: 'admitted' } });
  await scoped(async () => {
    await models.ChannelIdentity.updateMany({}, { $unset: { discordActivatedAtMs: '' } });
    const record = await models.ChannelIdentity.findOne().lean();
    if (!record) throw new Error('Missing restored link');
    const link = await identities.readChannelLink(tenantId, record.linkId);
    if (!link) throw new Error('Missing link');
    expect(
      await identities.saveChannelIdentity(
        { ...link, discordActivatedAtMs: 1 },
        link.revision,
        revision,
      ),
    ).toBe(true);
    expect(
      (await identities.readChannelLink(tenantId, link.linkId))?.discordActivatedAtMs,
    ).toBeUndefined();
    expect(await authority.identity.inspectActor(link.identity)).toMatchObject({
      ok: true,
      value: { state: 'expired' },
    });
    const claimed = await runs.claim(tenantId, channel.channelId, 'continuation', clock, 60000);
    if (!claimed) throw new Error('Missing authorized run');
    const fence = { runId: claimed.runId, owner: 'continuation', epoch: claimed.leaseEpoch };
    const prepared = await runs.prepareExecution(tenantId, fence, clock, {
      applicationRevision: revision,
      native: {
        kind: 'guild_text',
        owner: input.owner,
        source: discordGuildTextActorSourceSchema.parse(input.source),
      },
    });
    expect(prepared.execution).toBeDefined();
    const continued = await runs.prepareExecution(tenantId, fence, clock, revision);
    expect(continued.execution).toEqual(prepared.execution);
  });
  expect(await service.submit(submission())).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  await scoped(() => linked());
  expect(await service.submit(submission())).toEqual({ ok: true, value: { outcome: 'admitted' } });
});

it.each([false, true])(
  'does not revive an unconsumed old message after route replacement with reconnect %s',
  async (reconnect) => {
    await scoped(() => linked());
    const oldMessage = submission();
    await scoped(async () => {
      const routes = createDiscordRouteStorage(db);
      const oldRoute = await routes.read(channel.installationId, externalChannelId);
      if (!oldRoute) throw new Error('Missing original route');
      const removed = await routes.remove({
        actorId: userId,
        installationId: channel.installationId,
        externalChannelId,
        expectedRevision: oldRoute.revision,
      });
      if (!removed.ok) throw new Error(removed.error.code);
      let installationRevision = channel.installationRevision;
      if (reconnect) {
        const disconnected = await installations.disconnectGuild({
          actorId: userId,
          installationId: channel.installationId,
          expectedRevision: installationRevision,
        });
        if (!disconnected.ok) throw new Error(disconnected.error.code);
        const connected = await installations.connectGuild({
          actorId: userId,
          applicationId,
          applicationRevision: revision,
          guildId,
          guildName: 'Guild',
          installationId: channel.installationId,
          expectedRevision: disconnected.value.revision,
        });
        if (!connected.ok) throw new Error(connected.error.code);
        installationRevision = connected.value.revision;
      }
      await channels.createAgentChannel({
        ...channel,
        channelId: 'replacement',
        agentId: 'other-agent',
        status: 'pending_install',
        revision: 'initial',
        installationRevision,
        applicationRevision: revision,
      });
      const assigned = await routes.assign({
        actorId: userId,
        installationId: channel.installationId,
        installationRevision,
        applicationRevision: revision,
        externalChannelId,
        channelId: 'replacement',
        channelRevision: 'initial',
      });
      if (!assigned.ok) throw new Error(assigned.error.code);
      const current = await channels.getAgentChannelMetadata('replacement');
      if (!current || current.type !== 'discord') throw new Error('Missing replacement route');
      channel = current;
      await linked();
    });
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(0);
    expect(await service.submit(oldMessage)).toEqual({
      ok: true,
      value: { outcome: 'ignored', reason: 'unavailable' },
    });
    expect(await service.submit(submission())).toEqual({
      ok: true,
      value: { outcome: 'admitted' },
    });
    await scoped(async () => {
      expect(await models.ChannelRun.countDocuments()).toBe(1);
      expect(await models.ChannelRun.findOne().lean()).toMatchObject({
        channelId: 'replacement',
        agentId: 'other-agent',
      });
    });
  },
);

it('requires fresh actor visibility proof instead of legacy bot-only source observations', async () => {
  await scoped(() => linked());
  const legacy = submission();
  legacy.source = {
    kind: 'guild_text',
    applicationId,
    botUserId,
    guildId,
    channelId: externalChannelId,
    permissions: String(1024 | 2048 | 65536),
  };
  expect(await service.submit(legacy)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  const denied = submission();
  denied.source = {
    kind: 'guild_text',
    applicationId,
    botUserId,
    guildId,
    channelId: externalChannelId,
    permissions: String(1024 | 2048 | 65536),
    authorId: externalUserId,
    authorMember: true,
    authorPermissions: '0',
  };
  expect(await service.submit(denied)).toEqual({
    ok: true,
    value: { outcome: 'ignored', reason: 'unavailable' },
  });
  const forged = submission();
  forged.source = { ...denied.source, authorId: '567890123456789013', authorPermissions: '1024' };
  expect(await service.submit(forged)).toEqual({ ok: false, error: { code: 'invalid_input' } });
  await scoped(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
  });
});
