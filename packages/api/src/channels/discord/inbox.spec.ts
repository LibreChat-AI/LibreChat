import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
} from '@librechat/data-schemas';
import type { DiscordInboxSubmission, DiscordPrivateReply } from 'librechat-data-provider';
import type { DiscordInboxRecord } from '@librechat/data-schemas';
import type { DiscordInboxServiceDependencies } from './inbox';
import { createDiscordInboxService, discordInteractionExpiry } from './inbox';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createDiscordInboxHandlers } from './inboxHttp';
import { createDiscordRouteResolver } from './routes';

const db = new mongoose.Mongoose();
const tenantId = 'discord-inbox-api';
const owner = '000000000000000000000001';
const applicationId = '123456789012345678';
const guildId = '234567890123456789';
const botUserId = '345678901234567890';
const externalChannelId = '456789012345678901';
const externalUserId = '567890123456789012';
const token = 'private-interaction-token';
const serviceToken = 'service-private-'.repeat(4);
const scope = <T>(run: () => Promise<T>) => tenantStorage.run({ tenantId }, run);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let storage: ReturnType<typeof createDiscordInboxStorage>;
let resolver: ReturnType<typeof createDiscordRouteResolver>;
let service: ReturnType<typeof createDiscordInboxService>;
let deps: DiscordInboxServiceDependencies;
let app: express.Express;
let applicationRevision: string;
let now: number;
let eventId: string;
let enabled: boolean;
let executions: number;
let execute: () => Promise<DiscordPrivateReply>;
function input(overrides: Partial<DiscordInboxSubmission> = {}): DiscordInboxSubmission {
  return {
    applicationId,
    expectedApplicationRevision: applicationRevision,
    guildId,
    externalChannelId,
    externalUserId,
    eventId,
    token,
    action: { kind: 'ask', prompt: 'Private question' },
    ...overrides,
  };
}
function mount(instance = service) {
  const handlers = createDiscordInboxHandlers({
    service: instance,
    serviceToken: () => serviceToken,
  });
  app = express();
  app.use(express.json());
  for (const name of ['submit', 'claim', 'finish', 'defer'] as const)
    app.post(`/${name}`, handlers[name]);
}
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  now = Date.now();
  eventId = ((BigInt(now - 10) - BigInt(1420070400000)) << BigInt(22)).toString();
  enabled = true;
  executions = 0;
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'DiscordInbox',
      'AgentChannel',
      'ChannelScope',
    ])
      await db.models[name].deleteMany({});
  });
  installations = createDiscordInstallationStorage(db);
  const channels = createMethods(db);
  const routes = createDiscordRouteStorage(db);
  storage = createDiscordInboxStorage(db);
  resolver = createDiscordRouteResolver({
    installations,
    channels,
    routes,
    enabled: async () => enabled,
  });
  await scope(async () => {
    await db.models.User.create({
      _id: owner,
      tenantId,
      email: 'owner@example.test',
      provider: 'local',
    });
    const application = unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: 'sealed',
        encryptedClientSecret: 'sealed-secret',
      }),
    );
    applicationRevision = application.revision;
    const guild = unwrap(
      await installations.connectGuild({
        actorId: owner,
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
      createdBy: owner,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'initial',
      installationId: guild.installationId,
      installationRevision: guild.revision,
      applicationRevision,
      discord: { applicationId, guildId, botUserId, externalChannelId },
    });
    unwrap(
      await routes.assign({
        actorId: owner,
        installationId: guild.installationId,
        installationRevision: guild.revision,
        applicationRevision,
        externalChannelId,
        channelId: 'channel',
        channelRevision: 'initial',
      }),
    );
  });
  execute = async () => ({ content: 'Accepted.' });
  deps = {
    storage,
    resolver,
    encrypt: encryptCredential,
    decrypt: decryptCredential,
    retryDelayMs: async () => 1000,
    now: () => now,
    execute: async (record, fence) => {
      expect(getTenantId()).toBe(tenantId);
      expect(record.applicationRevision).toBe(applicationRevision);
      expect(fence).toMatchObject({ applicationId, eventId });
      executions++;
      return execute();
    },
  };
  service = createDiscordInboxService(deps);
  mount();
});

it('persists before admission and exposes tokens only through authenticated claims', async () => {
  const response = await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(201);
  expect(JSON.stringify(response.body)).not.toContain(token);
  expect(response.headers['cache-control']).toBe('no-store');
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record?.encryptedToken).not.toContain(token);
    if (!record?.encryptedToken) throw new Error('Missing encrypted token');
    expect(await decryptCredential(record.encryptedToken)).toBe(token);
  });
  const claimed = await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(200);
  expect(claimed.body).toMatchObject({
    token,
    reply: { content: 'Accepted.' },
    fence: { applicationId, eventId, owner: 'worker' },
  });
  expect(executions).toBe(1);
  await request(app)
    .post('/finish')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ fence: claimed.body.fence, result: 'completed' })
    .expect(204);
  await request(app)
    .post('/submit')
    .set('authorization', `Bearer ${serviceToken}`)
    .send(input())
    .expect(200);
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken +encryptedReply +action')
      .lean();
    expect(record).toMatchObject({ state: 'done' });
    for (const key of ['encryptedToken', 'encryptedReply', 'action'])
      expect(record).not.toHaveProperty(key);
  });
});

it('requires service authentication and rejects tenant injection on every route', async () => {
  for (const path of ['submit', 'claim', 'finish', 'defer']) {
    await request(app).post(`/${path}`).send(input()).expect(401);
    await request(app)
      .post(`/${path}`)
      .set('authorization', `Bearer ${serviceToken}`)
      .send({ ...input(), tenantId: 'foreign' })
      .expect(400);
  }
  expect(await scope(async () => db.models.DiscordInbox.countDocuments())).toBe(0);
});

it('derives the tenant from canonical ownership despite the caller context', async () => {
  await tenantStorage.run({ tenantId: 'foreign' }, async () => {
    expect((await service.submit(input())).ok).toBe(true);
    expect(await service.claim(applicationId, 'worker')).toMatchObject({ token });
  });
  expect(await scope(async () => db.models.DiscordInbox.countDocuments())).toBe(1);
});

it('uses the interaction timestamp for a stable token expiry and deduplication', async () => {
  expect(discordInteractionExpiry(eventId)).toBe(now - 10 + 900000);
  unwrap(await service.submit(input()));
  now += 5000;
  expect(unwrap(await service.submit(input())).duplicate).toBe(true);
  const expired = ((BigInt(now - 900001) - BigInt(1420070400000)) << BigInt(22)).toString();
  expect(await service.submit(input({ eventId: expired }))).toMatchObject({
    ok: false,
    error: { code: 'expired' },
  });
  const future = ((BigInt(now + 60000) - BigInt(1420070400000)) << BigInt(22)).toString();
  expect(await service.submit(input({ eventId: future }))).toMatchObject({
    ok: false,
    error: { code: 'expired' },
  });
});

it('replays a prepared reply after lease loss without executing the command twice', async () => {
  unwrap(await service.submit(input()));
  const first = await service.claim(applicationId, 'worker');
  expect(first).not.toBeNull();
  now += 30000;
  const second = await service.claim(applicationId, 'replacement');
  expect(second?.reply).toEqual(first?.reply);
  expect(second?.token).toBe(token);
  expect(executions).toBe(1);
  expect(await service.finish(first!.fence, 'completed')).toBe(false);
  expect(await service.finish(second!.fence, 'completed')).toBe(true);
});

it('defers operational failures and never exposes sensitive diagnostics', async () => {
  execute = async () => {
    throw new Error(`provider echo ${token}`);
  };
  unwrap(await service.submit(input()));
  const response = await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(503);
  expect(response.body).toEqual({ error: 'discord_interaction_unavailable' });
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  now += 1000;
  execute = async () => ({ content: 'Recovered.' });
  expect(await service.claim(applicationId, 'worker')).toMatchObject({
    reply: { content: 'Recovered.' },
  });
});

it('rejects stale routes, disabled ingress and rotated application authority', async () => {
  expect(await service.submit(input({ expectedApplicationRevision: 'stale' }))).toMatchObject({
    ok: false,
  });
  expect(await service.submit(input({ guildId: '789012345678901234' }))).toMatchObject({
    ok: false,
  });
  unwrap(await service.submit(input()));
  await scope(async () =>
    unwrap(
      await installations.configureApplication({
        actorId: owner,
        applicationId,
        botUserId,
        publicKey: 'b'.repeat(64),
        encryptedBotToken: 'rotated',
        expectedRevision: applicationRevision,
      }),
    ),
  );
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  enabled = false;
  expect(await service.submit(input())).toMatchObject({
    ok: false,
    error: { code: 'authority_changed' },
  });
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  expect(executions).toBe(0);
});

it('validates private reply size and link protocols before persistence', async () => {
  execute = async () => ({
    content: 'Unsafe',
    actions: [{ label: 'Open', url: 'javascript:alert(1)' }],
  });
  unwrap(await service.submit(input()));
  await request(app)
    .post('/claim')
    .set('authorization', `Bearer ${serviceToken}`)
    .send({ applicationId, owner: 'worker' })
    .expect(503);
  await scope(async () =>
    expect(
      await db.models.DiscordInbox.findOne({ eventId }).select('+encryptedReply').lean(),
    ).not.toHaveProperty('encryptedReply'),
  );
});

it('drops expired tokens even when command execution finishes after their lifetime', async () => {
  execute = async () => {
    now += 900000;
    return { content: 'Too late' };
  };
  unwrap(await service.submit(input()));
  expect(await service.claim(applicationId, 'worker')).toBeNull();
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record).not.toHaveProperty('encryptedToken');
  });
});

it('erases expired credentials when command execution fails after expiry', async () => {
  execute = async () => {
    now += 900000;
    throw new Error('Unavailable');
  };
  unwrap(await service.submit(input()));
  await expect(service.claim(applicationId, 'worker')).rejects.toThrow('Unavailable');
  await scope(async () => {
    const record = await db
      .model<DiscordInboxRecord>('DiscordInbox')
      .findOne({ eventId })
      .select('+encryptedToken')
      .lean();
    expect(record).toMatchObject({ state: 'failed', result: 'expired' });
    expect(record).not.toHaveProperty('encryptedToken');
  });
});
