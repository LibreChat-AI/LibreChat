import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  PermissionBits,
  Permissions,
  PermissionTypes,
  discordChannelConfigSchema,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createChannelIdentityStorage,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordDmStorage,
  tenantStorage,
  runAsSystem,
  hashDiscordDmCode,
  createChannelRunStorage,
  createDiscordMessageStorage,
  createDiscordGatewayStorage,
} from '@librechat/data-schemas';
import type {
  DiscordAgentChannel,
  DiscordDmMessagePrepared,
  DiscordGatewayMessage,
} from 'librechat-data-provider';
import { createDiscordDmMessageHandlers } from './dmMessageHttp';
import { createDiscordDmMessageService } from './dmMessages';
import { createChannelAuthority } from '../authority';
import { createDiscordDmHandlers } from './dmHttp';
import { createDiscordDmService } from './dm';

const db = new mongoose.Mongoose();
const models = createModels(db);
const owner = '000000000000000000000001';
const userId = '000000000000000000000002';
const other = '000000000000000000000003';
const tenantId = 'dm-api';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const externalUserId = '345678901234567890';
const dmChannelId = '456789012345678901';
const token = 'private-service-token'.repeat(3);
const scope = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
let mongo: MongoMemoryReplSet;
let applicationRevision: string;
let enabled: boolean;
let permission: number;
let now: number;
let channel: DiscordAgentChannel;
const channels = createMethods(db);
const identities = createChannelIdentityStorage(db);
const installations = createDiscordInstallationStorage(db);
const settings = async () => discordChannelConfigSchema.parse({ dm: { enabled } }).dm;
const storage = createDiscordDmStorage(db, settings);
const runStorage = createChannelRunStorage(db);
const authority = createChannelAuthority({
  channels,
  identityStorage: identities,
  discordDm: storage,
  authorizeDestination: (channel, admission, principal) =>
    runStorage.authorizeDestination(
      {
        tenantId: channel.tenantId,
        channelId: channel.channelId,
        agentId: channel.agentId,
        principal,
        admission,
      },
      Date.now(),
    ),
  getConfig: async () => ({ enabled: true }),
  findUser: (id) => channels.findUser({ _id: id }),
  getRole: async (name) => models.Role.findOne({ name }),
  isPrincipalActive: async () => true,
  getAgentPermissions: async () => permission,
});
const service = createDiscordDmService({
  storage,
  identities,
  installations,
  channels,
  authority,
  settings,
  now: () => now,
  principalAllowed: async (principal) =>
    principal.tenantId === tenantId && Boolean(await models.User.exists({ _id: principal.id })),
});
function server(value = service) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const id = req.get('x-user');
    if (id) req.user = { id, tenantId };
    tenantStorage.run({ tenantId: req.get('x-context') || tenantId }, next);
  });
  const handlers = createDiscordDmHandlers({ service: value, serviceToken: () => token });
  app.post('/codes', handlers.issue);
  app.get('/selections', handlers.list);
  app.delete('/selections/:selectionId', handlers.revoke);
  app.post('/select', handlers.select);
  return app;
}
const browser = (app: express.Express) =>
  request(app)
    .post('/codes')
    .set('x-user', userId)
    .send({ linkId: 'link', expectedLinkRevision: 'link-rev' });
const select = (code: string) => ({
  applicationId,
  applicationRevision,
  externalUserId,
  dmChannelId,
  confirmationEventId: '567890123456789012',
  codeHash: hashDiscordDmCode(code),
});
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri());
  await runAsSystem(() => Promise.all(Object.values(db.models).map((model) => model.init())));
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const collection of Object.values(db.connection.collections))
      await collection.deleteMany({});
  });
  enabled = true;
  permission = PermissionBits.VIEW;
  now = Date.now();
  await scope(async () => {
    await models.User.create([
      { _id: owner, email: 'owner@example.test', tenantId, provider: 'local', role: 'USER' },
      { _id: userId, email: 'user@example.test', tenantId, provider: 'local', role: 'USER' },
      { _id: other, email: 'other@example.test', tenantId, provider: 'local', role: 'USER' },
    ]);
    await models.Role.create({
      name: 'USER',
      permissions: {
        [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
      },
    });
    const app = await installations.configureApplication({
      actorId: owner,
      applicationId,
      botUserId: '678901234567890123',
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'encrypted',
      encryptedClientSecret: 'encrypted-client',
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
    await channels.createAgentChannel({
      type: 'discord',
      channelId: 'channel',
      revision: 'channel-rev',
      agentId: 'agent',
      tenantId,
      createdBy: owner,
      status: 'pending_install',
      credentialMode: 'per_user',
      applicationRevision,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: {
        applicationId,
        guildId,
        botUserId: '678901234567890123',
        externalChannelId: '789012345678901234',
      },
    });
    const assigned = await createDiscordRouteStorage(db).assign({
      actorId: owner,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision,
      channelId: 'channel',
      channelRevision: 'channel-rev',
      externalChannelId: '789012345678901234',
    });
    if (!assigned.ok) throw new Error(assigned.error.code);
    const record = await channels.getAgentChannelMetadata('channel');
    if (!record || record.type !== 'discord') throw new Error('Missing channel');
    channel = record;
    if (
      !(await identities.saveChannelIdentity(
        {
          tenantId,
          linkId: 'link',
          revision: 'link-rev',
          userId,
          state: 'active',
          ticketHash: 'b'.repeat(64),
          ticketExpiresAtMs: now + 600000,
          expiresAtMs: now + 172800000,
          identity: {
            provider: 'discord',
            tenantId,
            channelId: channel.channelId,
            channelRevision: channel.revision,
            agentId: channel.agentId,
            applicationId,
            guildId,
            externalUserId,
          },
        },
        null,
        applicationRevision,
      ))
    )
      throw new Error('Missing link');
  });
});
it('requires authenticated owner/service boundaries and rejects invented scope fields', async () => {
  const app = server();
  await request(app).post('/codes').send({}).expect(401);
  await request(app).get('/selections').expect(401);
  await request(app).post('/select').send({}).expect(401);
  await request(app)
    .post('/codes')
    .set('x-user', userId)
    .set('x-context', 'foreign')
    .send({ linkId: 'link', expectedLinkRevision: 'link-rev' })
    .expect(403);
  await request(app)
    .post('/codes')
    .set('x-user', userId)
    .send({ linkId: 'link', expectedLinkRevision: 'link-rev', userId: other })
    .expect(400);
  await request(app)
    .post('/codes')
    .set('x-user', other)
    .send({ linkId: 'link', expectedLinkRevision: 'link-rev' })
    .expect(409);
  const issued = await browser(app).expect(200);
  expect(issued.body.value.code).toHaveLength(43);
  await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .send({ ...select(issued.body.value.code), tenantId: 'foreign' })
    .expect(400);
});
it('consumes signed metadata under the canonical app tenant, idempotently acknowledges without any run', async () => {
  const app = server();
  const issued = await browser(app).expect(200);
  const input = select(issued.body.value.code);
  const first = await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .set('x-context', 'foreign')
    .send(input)
    .expect(200);
  const second = await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .send({ ...input, confirmationEventId: '999' })
    .expect(200);
  expect(second.body).toEqual(first.body);
  expect(first.headers['cache-control']).toBe('no-store');
  expect(first.body.value).toMatchObject({ applicationId, externalUserId, dmChannelId });
  expect(JSON.stringify(first.body)).not.toMatch(/codeHash|source|userId/);
  await scope(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
    expect(
      await storage.current(
        { applicationId, applicationRevision, externalUserId, dmChannelId },
        now,
      ),
    ).toMatchObject({ confirmationEventId: input.confirmationEventId });
  });
});
it('lists only owner metadata while disabled, projects source-link revocation/expiry unavailable and permits exact cleanup', async () => {
  const app = server();
  const issued = await browser(app).expect(200);
  const selected = await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .send(select(issued.body.value.code))
    .expect(200);
  const page = await request(app).get('/selections').set('x-user', userId).expect(200);
  expect(page.body.value.selections[0].state).toBe('active');
  for (const key of ['codeHash', 'code', 'source', 'userId'])
    expect(page.body.value.selections[0]).not.toHaveProperty(key);
  expect(
    (await request(app).get('/selections').set('x-user', other)).body.value.selections,
  ).toEqual([]);
  await scope(async () => {
    await models.ChannelIdentity.updateOne({ linkId: 'link' }, { $set: { expiresAtMs: now - 1 } });
  });
  expect(
    (await request(app).get('/selections').set('x-user', userId)).body.value.selections[0].state,
  ).toBe('unavailable');
  await scope(async () => {
    await identities.revokeChannelIdentity(
      { tenantId, userId, linkId: 'link', revision: 'link-rev' },
      'revoked',
    );
  });
  enabled = false;
  const disabled = await request(app).get('/selections').set('x-user', userId).expect(200);
  expect(disabled.body.value).toMatchObject({
    enabled: false,
    selections: [{ state: 'unavailable' }],
  });
  const id = selected.body.value.selectionId;
  await request(app)
    .delete(`/selections/${id}`)
    .set('x-user', userId)
    .send({ revision: 'old' })
    .expect(409);
  await request(app)
    .delete(`/selections/${id}`)
    .set('x-user', userId)
    .send({ revision: page.body.value.selections[0].revision })
    .expect(200);
  expect(
    (await request(app).get('/selections').set('x-user', userId)).body.value.selections[0].state,
  ).toBe('revoked');
});
it('rechecks agent permission before disclosing an issued code and refuses stale application revisions', async () => {
  const app = server();
  permission = 0;
  await browser(app).expect(403);
  permission = PermissionBits.VIEW;
  const issue = storage.issue.bind(storage);
  const changed = jest.spyOn(storage, 'issue').mockImplementationOnce(async (...args) => {
    const result = await issue(...args);
    permission = 0;
    return result;
  });
  const hidden = await browser(app).expect(409);
  expect(hidden.body).toEqual({ ok: false, error: { code: 'unavailable' } });
  changed.mockRestore();
  permission = PermissionBits.VIEW;
  const issued = await browser(app).expect(200);
  const stale = await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .send({ ...select(issued.body.value.code), applicationRevision: 'old' })
    .expect(409);
  expect(stale.body).toEqual({ ok: false, error: { code: 'unavailable' } });
});
it('returns only safe operational errors', async () => {
  const app = server({
    ...service,
    list: async () => {
      throw new Error('private query and selection hash');
    },
  });
  const response = await request(app).get('/selections').set('x-user', userId).expect(503);
  expect(response.body).toEqual({ ok: false, error: { code: 'unavailable' } });
});

const snowflake = (at: number) => String((BigInt(at - 1420070400000) << BigInt(22)) + BigInt(1));
const gateway = createDiscordGatewayStorage(db, async () => ({
  ownershipLeaseMs: 30000,
  shardCount: 1,
}));
const dmMessages = createDiscordDmMessageService({
  selections: storage,
  gateway,
  installations,
  channels,
  messages: createDiscordMessageStorage(db),
  runs: runStorage,
  authority,
  settings: async () =>
    discordChannelConfigSchema.parse({
      enabled: true,
      gateway: { enabled: true },
      dm: { enabled },
    }),
  now: () => now,
});
function messageServer(value = dmMessages) {
  const app = express();
  app.use(express.json());
  const handlers = createDiscordDmMessageHandlers({ service: value, serviceToken: () => token });
  app.post('/prepare', handlers.prepare);
  app.post('/message', handlers.submit);
  return app;
}
async function messageFixture() {
  const app = server();
  const issued = await browser(app).expect(200);
  await request(app)
    .post('/select')
    .auth(token, { type: 'bearer' })
    .send({ ...select(issued.body.value.code), confirmationEventId: snowflake(now) })
    .expect(200);
  const nativeOwner = { applicationId, applicationRevision, ownerId: 'a'.repeat(32) };
  await scope(async () => {
    await models.ChannelIdentity.collection.updateOne(
      { linkId: 'link' },
      { $set: { discordActivatedAtMs: now - 1000 } },
    );
    expect(await gateway.acquire(nativeOwner, 30000)).toBe(true);
  });
  const event: DiscordGatewayMessage = {
    ...nativeOwner,
    kind: 'message',
    shardId: 0,
    sequence: 1,
    messageId: snowflake(now + 1),
    channelId: dmChannelId,
    authorId: externalUserId,
    content: 'A private prompt without a mention',
    mentionsBot: false,
    channelType: 1,
  };
  const source = {
    kind: 'guild_text',
    applicationId,
    botUserId: channel.discord.botUserId,
    guildId,
    channelId: channel.discord.externalChannelId,
    permissions: '68608',
    authorId: externalUserId,
    authorMember: true,
    authorPermissions: '1024',
  };
  const http = messageServer();
  const prepared = await request(http)
    .post('/prepare')
    .auth(token, { type: 'bearer' })
    .send({ owner: nativeOwner, event })
    .expect(200);
  const selection: DiscordDmMessagePrepared = prepared.body;
  return {
    app: http,
    event,
    nativeOwner,
    source,
    selection,
    input: {
      owner: nativeOwner,
      event,
      source,
      selectionId: selection.selectionId,
      selectionRevision: selection.selectionRevision,
    },
  };
}
it('prepares only exact owned DM selection hints without private credentials, source principals or execution', async () => {
  const f = await messageFixture();
  expect(f.selection).toEqual({
    applicationId,
    externalUserId,
    dmChannelId,
    guildId,
    parentChannelId: channel.discord.externalChannelId,
    botUserId: channel.discord.botUserId,
    selectionId: expect.any(String),
    selectionRevision: expect.any(String),
  });
  expect(JSON.stringify(f.selection)).not.toMatch(/encrypted|userId|linkId|codeHash|private/);
  await scope(async () => {
    expect(await models.ChannelRun.countDocuments()).toBe(0);
    const before = await models.DiscordDmSelection.findOne().lean();
    await request(f.app)
      .post('/prepare')
      .auth(token, { type: 'bearer' })
      .send({ owner: f.nativeOwner, event: f.event })
      .expect(200);
    const after = await models.DiscordDmSelection.findOne().lean();
    expect(after).toMatchObject({
      selectionId: before?.selectionId,
      revision: before?.revision,
      expiresAtMs: before?.expiresAtMs,
    });
  });
  enabled = false;
  expect(
    (
      await request(f.app)
        .post('/prepare')
        .auth(token, { type: 'bearer' })
        .send({ owner: f.nativeOwner, event: f.event })
        .expect(200)
    ).body,
  ).toBeNull();
});
it('authenticates private DM endpoints and rejects guild, group, mixed owner and tenant overrides', async () => {
  const f = await messageFixture();
  await request(f.app).post('/prepare').send({ owner: f.nativeOwner, event: f.event }).expect(401);
  for (const changed of [
    { event: { ...f.event, guildId } },
    { event: { ...f.event, channelType: 3 } },
    { event: { ...f.event, ownerId: 'b'.repeat(32) } },
    { tenantId: 'other' },
  ])
    await request(f.app)
      .post('/prepare')
      .auth(token, { type: 'bearer' })
      .send({ owner: f.nativeOwner, event: f.event, ...changed })
      .expect(400);
  expect(
    (
      await request(f.app)
        .post('/prepare')
        .auth(token, { type: 'bearer' })
        .send({
          owner: { ...f.nativeOwner, ownerId: 'b'.repeat(32) },
          event: { ...f.event, ownerId: 'b'.repeat(32) },
        })
        .expect(200)
    ).body,
  ).toBeNull();
});
it('admits the exact physical DM prompt under its selected source and consumes a replay once', async () => {
  const f = await messageFixture();
  expect(
    (
      await request(f.app)
        .post('/message')
        .auth(token, { type: 'bearer' })
        .send(f.input)
        .expect(200)
    ).body,
  ).toEqual({ outcome: 'admitted' });
  expect(
    (
      await request(f.app)
        .post('/message')
        .auth(token, { type: 'bearer' })
        .send(f.input)
        .expect(200)
    ).body,
  ).toEqual({ outcome: 'duplicate' });
  await scope(async () => {
    const run = await models.ChannelRun.findOne().lean();
    expect(run?.principal).toMatchObject({ userId, linkId: 'link', linkRevision: 'link-rev' });
    expect(run?.admission).toMatchObject({
      eventId: f.event.messageId,
      externalChannelId: dmChannelId,
      externalThreadKey: `${dmChannelId}:${snowflake(now)}`,
      externalMessageKey: `${dmChannelId}:${f.event.messageId}`,
      input: f.event.content,
      actor: {
        provider: 'discord',
        scope: 'dm',
        applicationId,
        externalUserId,
        selectionId: f.selection.selectionId,
        selectionRevision: f.selection.selectionRevision,
      },
      discordDestination: { kind: 'dm', parentChannelId: channel.discord.externalChannelId },
    });
    expect(run?.admission.actor).not.toHaveProperty('guildId');
    expect(await models.ChannelRun.countDocuments()).toBe(1);
    expect(await models.DiscordMessageReceipt.countDocuments()).toBe(1);
  });
});
it.each(['selection', 'visibility', 'source', 'permission', 'link', 'old-event', 'old-consent'])(
  'durably ignores a DM prompt after %s changes',
  async (changed) => {
    const f = await messageFixture();
    if (changed === 'selection') {
      const issued = await browser(server()).expect(200);
      await request(server())
        .post('/select')
        .auth(token, { type: 'bearer' })
        .send(select(issued.body.value.code))
        .expect(200);
    }
    if (changed === 'visibility') f.source.authorPermissions = '0';
    if (changed === 'source') f.source.channelId = '999';
    if (changed === 'permission') permission = 0;
    if (changed === 'link')
      await scope(async () => {
        await models.ChannelIdentity.updateOne({ linkId: 'link' }, { state: 'revoked' });
      });
    if (changed === 'old-event') {
      f.event.messageId = snowflake(now);
    }
    if (changed === 'old-consent')
      await scope(async () => {
        await models.ChannelIdentity.collection.updateOne(
          { linkId: 'link' },
          { $set: { discordActivatedAtMs: now + 1 } },
        );
      });
    expect(
      (
        await request(f.app)
          .post('/message')
          .auth(token, { type: 'bearer' })
          .send(f.input)
          .expect(200)
      ).body,
    ).toEqual({ outcome: 'ignored', reason: 'unavailable' });
    expect(
      (
        await request(f.app)
          .post('/message')
          .auth(token, { type: 'bearer' })
          .send(f.input)
          .expect(200)
      ).body,
    ).toEqual({ outcome: 'duplicate' });
    await scope(async () => expect(await models.ChannelRun.countDocuments()).toBe(0));
  },
);
it('retains provider denial and sanitizes operational preparation errors', async () => {
  const f = await messageFixture();
  expect(
    (
      await request(f.app)
        .post('/message')
        .auth(token, { type: 'bearer' })
        .send({ ...f.input, source: null })
        .expect(200)
    ).body,
  ).toEqual({ outcome: 'ignored', reason: 'unavailable' });
  const app = messageServer({
    ...dmMessages,
    prepare: async () => {
      throw new Error('private bot token');
    },
  });
  expect(
    (
      await request(app)
        .post('/prepare')
        .auth(token, { type: 'bearer' })
        .send({ owner: f.nativeOwner, event: f.event })
        .expect(503)
    ).body,
  ).toEqual({ error: 'discord_dm_message_unavailable' });
});
it('rejects future physical timestamps and never admits prompts older than receipt retention', async () => {
  const f = await messageFixture();
  expect(
    (
      await request(f.app)
        .post('/message')
        .auth(token, { type: 'bearer' })
        .send({ ...f.input, event: { ...f.event, messageId: snowflake(now + 300001) } })
        .expect(400)
    ).body,
  ).toEqual({ error: 'invalid_input' });
  expect(
    (
      await request(f.app)
        .post('/message')
        .auth(token, { type: 'bearer' })
        .send({ ...f.input, event: { ...f.event, messageId: snowflake(now - 900000) } })
        .expect(200)
    ).body,
  ).toEqual({ outcome: 'ignored', reason: 'expired' });
  await scope(async () => expect(await models.ChannelRun.countDocuments()).toBe(0));
});
it('resolves the real source-guild identity for an exact DM run while execution is disabled', async () => {
  const f = await messageFixture();
  await request(f.app).post('/message').auth(token, { type: 'bearer' }).send(f.input).expect(200);
  await scope(async () => {
    const run = await models.ChannelRun.findOne().lean();
    if (!run) throw new Error('Fixture DM run missing');
    enabled = false;
    expect(await authority.resolvePrincipal(channel, run.admission.actor, run.admission)).toEqual(
      run.principal,
    );
    expect(await authority.resolvePrincipal(channel, run.admission.actor)).toBeNull();
    expect(
      await authority.resolvePrincipal(channel, run.admission.actor, {
        ...run.admission,
        externalChannelId: '999',
      }),
    ).toBeNull();
    expect(
      await authority.resolvePrincipal(channel, run.admission.actor, {
        ...run.admission,
        externalChannelId: 'not-a-snowflake',
      }),
    ).toBeNull();
    await storage.revoke(userId, f.selection.selectionId, f.selection.selectionRevision);
    expect(
      await authority.resolvePrincipal(channel, run.admission.actor, run.admission),
    ).toBeNull();
  });
});
