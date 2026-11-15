import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { discordChannelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordRuntimeStorage,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
} from '@librechat/data-schemas';
import type { DiscordChannelConfig, DiscordRuntimeApplication } from 'librechat-data-provider';
import { createDiscordRuntimeHandlers } from './discoveryHttp';
import { createDiscordRuntimeService } from './discovery';

const db = new mongoose.Mongoose();
const models = createModels(db);
const methods = createMethods(db);
const installations = createDiscordInstallationStorage(db);
const routes = createDiscordRouteStorage(db);
const storage = createDiscordRuntimeStorage(db);
const serviceToken = 'private-discovery-service-token'.repeat(2);
let mongo: MongoMemoryReplSet;
let policy: DiscordChannelConfig;
let disabled: Set<string>;
const service = createDiscordRuntimeService({
  storage,
  settings: async () => ({
    ...policy,
    enabled: policy.enabled && !disabled.has(getTenantId() || '_'),
  }),
});
const fixtures: (DiscordRuntimeApplication & { channelId: string; ownerId: string })[] = [];
function server(value = service) {
  const app = express();
  const handlers = createDiscordRuntimeHandlers({
    service: value,
    serviceToken: () => serviceToken,
  });
  for (const [path, handler] of Object.entries(handlers)) app.get(`/${path}`, handler);
  return app;
}
async function fixture(index: number, tenantId?: string) {
  return tenantStorage.run({ tenantId }, async () => {
    const ownerId = index.toString(16).padStart(24, '0');
    const applicationId = String(BigInt('123456789012345670') + BigInt(index));
    const botUserId = String(BigInt('223456789012345670') + BigInt(index));
    const guildId = String(BigInt('323456789012345670') + BigInt(index));
    const destination = String(BigInt('423456789012345670') + BigInt(index));
    const channelId = `channel-${index}`;
    await models.User.create({
      _id: ownerId,
      tenantId,
      provider: 'local',
      role: 'USER',
      email: `owner${index}@example.test`,
    });
    const app = await installations.configureApplication({
      actorId: ownerId,
      applicationId,
      botUserId,
      publicKey: 'a'.repeat(64),
      encryptedBotToken: 'private-bot-token',
      encryptedClientSecret: 'private-client-secret',
    });
    if (!app.ok) throw new Error('Fixture app unavailable');
    const guild = await installations.connectGuild({
      actorId: ownerId,
      applicationId,
      applicationRevision: app.value.revision,
      guildId,
      guildName: 'Private guild',
    });
    if (!guild.ok) throw new Error('Fixture guild unavailable');
    await methods.createAgentChannel({
      type: 'discord',
      tenantId,
      channelId,
      agentId: 'agent',
      createdBy: ownerId,
      status: 'pending_install',
      credentialMode: 'per_user',
      revision: 'channel-revision',
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      discord: { applicationId, guildId, botUserId, externalChannelId: destination },
      applicationRevision: app.value.revision,
    });
    const assigned = await routes.assign({
      actorId: ownerId,
      installationId: guild.value.installationId,
      installationRevision: guild.value.revision,
      applicationRevision: app.value.revision,
      externalChannelId: destination,
      channelId,
      channelRevision: 'channel-revision',
    });
    if (!assigned.ok) throw new Error('Fixture route unavailable');
    return {
      applicationId,
      applicationRevision: app.value.revision,
      tenantId: tenantId || '_',
      channelId,
      ownerId,
    };
  });
}
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
  policy = discordChannelConfigSchema.parse({ enabled: true, gateway: { discoveryBatchSize: 1 } });
  disabled = new Set();
  fixtures.length = 0;
  fixtures.push(await fixture(1, 'first-org'), await fixture(2, 'second-org'), await fixture(3));
});
it('requires service authentication and rejects caller-selected tenants, limits, invalid cursors and bootstrap queries', async () => {
  const app = server();
  for (const path of ['bootstrap', 'applications', 'channels'])
    expect((await request(app).get(`/${path}`)).status).toBe(401);
  for (const query of [{ tenantId: 'foreign' }, { limit: '1000' }, { cursor: 'invalid' }]) {
    expect(
      (
        await request(app)
          .get('/applications')
          .set('Authorization', `Bearer ${serviceToken}`)
          .query(query)
      ).status,
    ).toBe(400);
  }
  expect(
    (
      await request(app)
        .get('/bootstrap')
        .set('Authorization', `Bearer ${serviceToken}`)
        .query({ cursor: 'a'.repeat(24) })
    ).status,
  ).toBe(400);
});
it('discovers active applications fairly across tenants and advances through filtered empty pages', async () => {
  disabled.add('first-org');
  const app = server();
  const first = await request(app)
    .get('/applications')
    .set('Authorization', `Bearer ${serviceToken}`)
    .set('X-Tenant-Id', 'untrusted');
  expect(first.status).toBe(200);
  expect(first.body.applications).toEqual([]);
  expect(first.body.next).toMatch(/^[a-f0-9]{24}$/);
  const second = await service.applications(first.body.next);
  expect(second.applications).toEqual([
    {
      applicationId: fixtures[1].applicationId,
      applicationRevision: fixtures[1].applicationRevision,
      tenantId: 'second-org',
    },
  ]);
  const last = await service.applications(second.next);
  expect(last.applications[0].tenantId).toBe('_');
  expect(last.next).toBeUndefined();
  expect(first.headers['cache-control']).toBe('no-store');
  expect(JSON.stringify([first.body, second, last])).not.toMatch(
    /private-|encrypted|publicKey|ownerId/,
  );
});
it('filters stale routes and erased owners while retaining bounded channel pagination', async () => {
  await runAsSystem(async () => {
    await models.DiscordRoute.deleteOne({ channelId: fixtures[0].channelId });
  });
  const first = await service.channels();
  expect(first.channels).toEqual([]);
  expect(first.next).toBeDefined();
  const second = await service.channels(first.next);
  expect(second.channels).toEqual([
    {
      applicationId: fixtures[1].applicationId,
      applicationRevision: fixtures[1].applicationRevision,
      tenantId: 'second-org',
      channelId: fixtures[1].channelId,
    },
  ]);
  await runAsSystem(async () => {
    await models.AgentChannel.updateOne(
      { channelId: fixtures[2].channelId },
      { $set: { createdBy: fixtures[0].ownerId } },
    );
  });
  expect((await service.channels(second.next)).channels).toEqual([]);
  expect(
    (await storage.applications(undefined, 100)).applications.some(
      (app) => app.applicationId === fixtures[2].applicationId,
    ),
  ).toBe(true);
  await runAsSystem(async () => {
    await models.User.updateOne(
      { _id: fixtures[2].ownerId },
      { $set: { agentTriggerDeletionStartedAt: new Date() } },
    );
  });
  expect((await service.channels(second.next)).channels).toEqual([]);
  const apps = await storage.applications(second.next, 100);
  expect(apps.applications.some((app) => app.applicationId === fixtures[2].applicationId)).toBe(
    false,
  );
});
it('keeps nonsecret discovery independent of optional sockets and stops on current policy disablement', async () => {
  const bootstrap = await service.bootstrap();
  expect(bootstrap.discord.gateway.enabled).toBe(false);
  expect((await service.applications()).applications).toHaveLength(1);
  expect((await service.channels()).channels).toHaveLength(1);
  policy = { ...policy, enabled: false };
  expect((await service.bootstrap()).discord.enabled).toBe(false);
  expect(await service.applications()).toEqual({ applications: [] });
  expect(await service.channels()).toEqual({ channels: [] });
});
it('rechecks canonical tenant policy after a discovery query and reports outages without secret details', async () => {
  const original = storage.applications;
  const spy = jest.spyOn(storage, 'applications').mockImplementationOnce(async (cursor, limit) => {
    const page = await original(cursor, limit);
    disabled.add('first-org');
    return page;
  });
  expect((await service.applications()).applications).toEqual([]);
  spy.mockRestore();
  const broken = createDiscordRuntimeService({
    storage,
    settings: async () => {
      throw new Error('private-bot-token private-session');
    },
  });
  const response = await request(server(broken))
    .get('/bootstrap')
    .set('Authorization', `Bearer ${serviceToken}`);
  expect(response.status).toBe(503);
  expect(response.body).toEqual({ error: 'discord_discovery_unavailable' });
});
