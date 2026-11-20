import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createDiscordGatewayStorage,
  createDiscordInstallationStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import type { DiscordChannelConfig, DiscordGatewayBatch } from 'librechat-data-provider';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createDiscordGatewayHandlers } from './gatewayHttp';
import { createDiscordGatewayService } from './gateway';

const db = new mongoose.Mongoose();
const models = createModels(db);
const tenantId = 'gateway-api';
const userId = '000000000000000000000001';
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const installs = createDiscordInstallationStorage(db);
let mongo: MongoMemoryReplSet;
let policy: DiscordChannelConfig | null;
let revision: string;
const scoped = <T>(work: () => Promise<T>) => tenantStorage.run({ tenantId }, work);
const storage = createDiscordGatewayStorage(db, async () =>
  policy?.enabled
    ? { ownershipLeaseMs: policy.gateway.ownershipLeaseMs, shardCount: policy.gateway.shardCount }
    : null,
);
const service = createDiscordGatewayService({
  storage,
  installations: installs,
  settings: async () => policy,
  encrypt: encryptCredential,
  decrypt: decryptCredential,
});
function server(value = service) {
  const app = express();
  app.use(express.json());
  const handlers = createDiscordGatewayHandlers({
    service: value,
    serviceToken: () => 'private-service-'.repeat(3),
  });
  for (const [name, handler] of Object.entries(handlers)) app.post(`/${name}`, handler);
  return app;
}
const current = () => ({ applicationId, applicationRevision: revision, ownerId: 'a'.repeat(32) });
const session = {
  sessionId: 'private-session',
  sequence: 12,
  shardId: 0,
  shardCount: 2,
  resumeURL: 'wss://gateway-us-east1-b.discord.gg/',
};
const batch = (): DiscordGatewayBatch => ({
  applicationId,
  applicationRevision: revision,
  botUserId,
  checkpoints: [{ shardId: 0, session: { ...session } }],
});
beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri());
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
  policy = discordChannelConfigSchema.parse({
    enabled: true,
    gateway: { enabled: true, shardCount: 2 },
  });
  await scoped(async () => {
    await models.User.create({
      _id: userId,
      tenantId,
      email: 'owner@example.test',
      role: 'USER',
      provider: 'local',
    });
    const result = await installs.configureApplication({
      actorId: userId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: await encryptCredential('private-bot-token'),
      encryptedClientSecret: 'encrypted-client',
    });
    if (!result.ok) throw new Error('Fixture application unavailable');
    revision = result.value.revision;
  });
});
it('requires bearer authentication on every endpoint and rejects caller-selected tenant, clock and lease expiry', async () => {
  const app = server();
  for (const path of [
    'acquire',
    'renew',
    'release',
    'bootstrap',
    'load',
    'save',
    'observeCredentials',
    'prepareGuildRemoval',
    'removeGuild',
  ]) {
    const denied = await request(app).post(`/${path}`).send({ owner: current(), batch: batch() });
    expect(denied.status).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
  }
  for (const extra of [
    { tenantId: 'foreign' },
    { leaseMs: 999999999 },
    { expiresAt: 9999999999999 },
    { now: 1 },
  ]) {
    expect(
      (
        await request(app)
          .post('/acquire')
          .auth('private-service-'.repeat(3), { type: 'bearer' })
          .send({ owner: { ...current(), ...extra } })
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await request(app)
        .post('/acquire')
        .auth('private-service-'.repeat(3), { type: 'bearer' })
        .send({ owner: current(), tenantId: 'foreign' })
    ).status,
  ).toBe(400);
});
it('derives guild removal scope from the application and fences the exact prepared installation', async () => {
  const guildId = '345678901234567890';
  await scoped(async () => {
    const result = await installs.connectGuild({
      actorId: userId,
      applicationId,
      applicationRevision: revision,
      guildId,
      guildName: 'Test',
    });
    if (!result.ok) throw new Error(result.error.code);
  });
  const app = server();
  const post = (path: string, body: object) =>
    request(app).post(`/${path}`).auth('private-service-'.repeat(3), { type: 'bearer' }).send(body);
  const input = { owner: current(), guildId };
  expect((await post('prepareGuildRemoval', input)).status).toBe(409);
  expect((await post('acquire', { owner: current(), leaseMs: 30000 })).status).toBe(204);
  const prepared = await post('prepareGuildRemoval', input);
  expect(prepared.status).toBe(200);
  expect(Object.keys(prepared.body.target).sort()).toEqual([
    'guildId',
    'installationId',
    'installationRevision',
  ]);
  expect((await post('prepareGuildRemoval', { ...input, tenantId: 'foreign' })).status).toBe(400);
  expect(
    (
      await post('removeGuild', {
        owner: current(),
        target: { ...prepared.body.target, actorId: userId },
      })
    ).status,
  ).toBe(400);
  expect(
    (
      await post('removeGuild', {
        owner: { ...current(), ownerId: 'b'.repeat(32) },
        target: prepared.body.target,
      })
    ).status,
  ).toBe(409);
  expect(
    (await post('removeGuild', { owner: current(), target: prepared.body.target })).status,
  ).toBe(204);
  expect((await post('prepareGuildRemoval', input)).body).toEqual({ target: null });
  expect(
    (await post('removeGuild', { owner: current(), target: prepared.body.target })).status,
  ).toBe(409);
});
it('redacts unexpected preparation/removal failures as HTTP 503', async () => {
  const app = server({
    ...service,
    prepareGuildRemoval: async () => {
      throw new Error('private query and credentials');
    },
    removeGuild: async () => {
      throw new Error('private query and credentials');
    },
  });
  for (const path of ['prepareGuildRemoval', 'removeGuild']) {
    const response = await request(app)
      .post(`/${path}`)
      .auth('private-service-'.repeat(3), { type: 'bearer' })
      .send({
        owner: current(),
        ...(path === 'prepareGuildRemoval'
          ? { guildId: '345678901234567890' }
          : {
              target: {
                guildId: '345678901234567890',
                installationId: 'installation',
                installationRevision: 'revision',
              },
            }),
      });
    expect(response.status).toBe(503);
    expect(response.body).toEqual({ error: 'discord_gateway_unavailable' });
  }
});
it('reveals credentials and decrypted checkpoints only to a current owner and persists capabilities encrypted', async () => {
  const app = server();
  const post = (
    path: string,
    body: object = {
      owner: current(),
      ...(['acquire', 'renew'].includes(path) ? { leaseMs: 30000 } : {}),
    },
  ) =>
    request(app).post(`/${path}`).auth('private-service-'.repeat(3), { type: 'bearer' }).send(body);
  expect((await post('bootstrap')).status).toBe(409);
  expect((await post('acquire')).status).toBe(204);
  const bootstrap = await post('bootstrap');
  expect(bootstrap.status).toBe(200);
  expect(bootstrap.body).toMatchObject({
    applicationId,
    applicationRevision: revision,
    botUserId,
    botToken: 'private-bot-token',
    policy: { shardCount: 2 },
  });
  expect(bootstrap.body).not.toHaveProperty('publicKey');
  expect(bootstrap.body).not.toHaveProperty('encryptedBotToken');
  expect(
    (
      await request(app)
        .post('/save')
        .auth('private-service-'.repeat(3), { type: 'bearer' })
        .send({ owner: current(), batch: batch() })
    ).status,
  ).toBe(204);
  const raw = await db.connection
    .collection('discordgatewaycheckpoints')
    .findOne({ applicationId });
  expect(JSON.stringify(raw)).not.toContain('private-session');
  expect(JSON.stringify(raw)).not.toContain('wss://');
  expect(raw?.encryptedSession).toEqual(expect.any(String));
  const loaded = await post('load');
  expect(loaded.body).toEqual(batch());
  const intruder = { ...current(), ownerId: 'b'.repeat(32) };
  expect((await post('bootstrap', { owner: intruder })).status).toBe(409);
  expect((await post('load', { owner: intruder })).status).toBe(409);
  expect((await post('release')).status).toBe(204);
  expect((await post('bootstrap')).status).toBe(409);
});
it('rejects arbitrary resume URLs, mismatched shard topology and cross-application batches', async () => {
  await service.acquire(current(), 30000);
  const app = server();
  for (const resumeURL of [
    'wss://attacker.test/',
    'wss://gateway.discord.gg.attacker.test/',
    'https://gateway.discord.gg/',
    'wss://token@gateway.discord.gg/',
    'wss://gateway.discord.gg/?token=private',
    'wss://gateway.discord.gg/path',
  ]) {
    const payload = batch();
    payload.checkpoints[0].session!.resumeURL = resumeURL;
    const result = await request(app)
      .post('/save')
      .auth('private-service-'.repeat(3), { type: 'bearer' })
      .send({ owner: current(), batch: payload });
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).not.toContain(resumeURL);
  }
  const different = batch();
  different.applicationId = '345678901234567890';
  expect(await service.save(current(), different)).toBe(false);
  const topology = batch();
  topology.checkpoints[0].session!.shardCount = 1;
  expect(await service.save(current(), topology)).toBe(false);
});
it('rechecks ownership, application revision and enablement after asynchronous credential decryption', async () => {
  const originalOwner = current();
  await service.acquire(originalOwner, 30000);
  let rotate = true;
  const racing = createDiscordGatewayService({
    storage,
    installations: installs,
    settings: async () => policy,
    encrypt: encryptCredential,
    decrypt: async (value) => {
      const token = await decryptCredential(value);
      if (rotate)
        await scoped(async () => {
          await installs.configureApplication({
            actorId: userId,
            applicationId,
            botUserId,
            publicKey: 'b'.repeat(64),
            expectedRevision: revision,
          });
        });
      else policy = null;
      return token;
    },
  });
  expect(await racing.bootstrap(current())).toBeNull();
  // Disabled settings cannot disclose the old decrypted token either.
  rotate = false;
  const active = await installs.lookupApplication(applicationId);
  revision = active!.revision;
  expect(await service.release(originalOwner)).toBe(true);
  await service.acquire(current(), 30000);
  expect(await racing.bootstrap(current())).toBeNull();
});
it('redacts unexpected failures instead of forwarding provider tokens or stored checkpoint payloads', async () => {
  const broken = createDiscordGatewayService({
    storage,
    installations: installs,
    settings: async () => {
      throw new Error('private-bot-token private-session');
    },
    encrypt: encryptCredential,
    decrypt: decryptCredential,
  });
  const response = await request(server(broken))
    .post('/bootstrap')
    .auth('private-service-'.repeat(3), { type: 'bearer' })
    .send({ owner: current() });
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'discord_gateway_unavailable' });
});

it('uses one application owner for bot delivery while the optional Gateway socket is disabled', async () => {
  policy = discordChannelConfigSchema.parse({ enabled: true, gateway: { enabled: false } });
  expect(await service.acquire(current(), 30000)).toBe(true);
  expect(await service.acquire({ ...current(), ownerId: 'b'.repeat(32) }, 30000)).toBe(false);
  expect(await service.bootstrap(current())).toMatchObject({
    botToken: 'private-bot-token',
    policy: { enabled: false },
  });
});

it('records only authenticated owner-fenced credential states with a server timestamp', async () => {
  const app = server();
  const send = (body: object) =>
    request(app)
      .post('/observeCredentials')
      .auth('private-service-'.repeat(3), { type: 'bearer' })
      .send(body);
  expect((await send({ owner: current(), state: 'invalid' })).status).toBe(409);
  await service.acquire(current(), 30000);
  for (const extra of [{ checkedAt: 1 }, { tenantId: 'foreign' }, { error: 'private-token' }]) {
    expect((await send({ owner: current(), state: 'invalid', ...extra })).status).toBe(400);
  }
  for (const state of ['permission_denied', 'unavailable', 'private-token']) {
    expect((await send({ owner: current(), state })).status).toBe(400);
  }
  const before = Date.now();
  expect((await send({ owner: current(), state: 'invalid' })).status).toBe(204);
  await scoped(async () => {
    const record = await installs.readApplication(applicationId);
    expect(record?.credentialHealth?.state).toBe('invalid');
    expect(record?.credentialHealth?.checkedAt).toBeGreaterThanOrEqual(before);
    expect(record?.revision).toBe(revision);
  });
  expect(
    (await send({ owner: { ...current(), applicationRevision: 'stale' }, state: 'valid' })).status,
  ).toBe(409);
  await service.release(current());
  expect((await send({ owner: current(), state: 'valid' })).status).toBe(409);
});
