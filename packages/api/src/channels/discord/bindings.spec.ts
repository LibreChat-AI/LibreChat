import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { PermissionBits, ResourceType, channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createDiscordInstallationStorage,
  createDiscordRouteStorage,
  createDiscordInboxStorage,
  createDiscordCommandStorage,
  createDiscordGatewayStorage,
  createChannelIdentityStorage,
  createChannelRunStorage,
  tenantStorage,
  runAsSystem,
  getTenantId,
} from '@librechat/data-schemas';
import type { DiscordGuild } from 'librechat-data-provider';
import type { DiscordManagementPrincipal } from './service';
import { createDiscordBindingHandlers, createDiscordRouteHandlers } from './bindingHttp';
import { createDiscordChannelRuntime, createDiscordPolicyReader } from './host';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createDiscordBindingService } from './bindings';
import { createDiscordProviderClient } from './client';
import { createDiscordRouteResolver } from './routes';
import { createChannelAuthority } from '../authority';

const db = new mongoose.Mongoose();
const principal = { id: '000000000000000000000001', tenantId: 'bindings-api' };
const applicationId = '123456789012345678';
const botUserId = '234567890123456789';
const guildId = '345678901234567890';
const externalChannelId = '456789012345678901';
const token = 'private-bot-token';
const serviceToken = 'private-service-'.repeat(4);
const scope = <T>(action: () => Promise<T>, tenantId = principal.tenantId) =>
  tenantStorage.run({ tenantId }, action);
const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!result.ok) throw new Error(result.error.code);
  return result.value;
};
let mongo: MongoMemoryReplSet;
let installations: ReturnType<typeof createDiscordInstallationStorage>;
let channels: ReturnType<typeof createMethods>;
let routes: ReturnType<typeof createDiscordRouteStorage>;
let service: ReturnType<typeof createDiscordBindingService>;
let resolver: ReturnType<typeof createDiscordRouteResolver>;
let app: express.Express;
let guild: DiscordGuild;
let applicationRevision: string;
let enabled: boolean;
let authenticated: boolean;
let editable: Set<string>;
let viewable: Set<string>;
let onRequest: ((path: string) => Promise<void>) | undefined;
let fetchProvider: jest.Mock<Promise<Response>, [string, RequestInit]>;
const input = () => ({ agentId: 'agent', installationId: guild.installationId, externalChannelId });
const bind = () => service.bind(principal, input());
const resolveInput = () => ({
  applicationId,
  guildId,
  externalChannelId,
  expectedApplicationRevision: applicationRevision,
});

beforeAll(async () => {
  mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  await db.connect(mongo.getUri(), { autoIndex: false });
  createModels(db);
  installations = createDiscordInstallationStorage(db);
  channels = createMethods(db);
  routes = createDiscordRouteStorage(db);
}, 60000);
afterAll(async () => {
  await db.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  await runAsSystem(async () => {
    for (const name of [
      'User',
      'DiscordApplication',
      'DiscordGuild',
      'DiscordRoute',
      'AgentChannel',
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
      _id: principal.id,
      tenantId: principal.tenantId,
      provider: 'local',
      email: 'admin@example.test',
      role: 'ADMIN',
    });
    const saved = unwrap(
      await installations.configureApplication({
        actorId: principal.id,
        applicationId,
        botUserId,
        publicKey: 'a'.repeat(64),
        encryptedBotToken: await encryptCredential(token),
        encryptedClientSecret: await encryptCredential('private-client-secret'),
      }),
    );
    applicationRevision = saved.revision;
    guild = unwrap(
      await installations.connectGuild({
        actorId: principal.id,
        applicationId,
        applicationRevision,
        guildId,
        guildName: 'Guild',
      }),
    );
  });
  enabled = authenticated = true;
  editable = new Set(['agent', 'other']);
  viewable = new Set();
  onRequest = undefined;
  fetchProvider = jest.fn<Promise<Response>, [string, RequestInit]>(async (url) => {
    const path = new URL(url).pathname.replace('/api/v10', '');
    await onRequest?.(path);
    const bodies: Record<string, object> = {
      '/applications/@me': {
        id: applicationId,
        name: 'Bot',
        verify_key: 'a'.repeat(64),
        bot_require_code_grant: true,
      },
      '/users/@me': { id: botUserId, bot: true },
      [`/channels/${externalChannelId}`]: {
        id: externalChannelId,
        guild_id: guildId,
        type: 0,
        name: 'agent',
      },
      [`/channels/${externalChannelId}/permissions/member/${botUserId}`]: { permissions: '68608' },
    };
    if (!bodies[path]) return new Response('{}', { status: 404 });
    return Response.json(bodies[path]);
  });
  const active = async (actor: DiscordManagementPrincipal) =>
    Boolean(
      await db.models.User.exists({
        _id: actor.id,
        tenantId: actor.tenantId,
        role: 'ADMIN',
        agentTriggerDeletionStartedAt: { $exists: false },
      }),
    );
  service = createDiscordBindingService({
    installations,
    channels,
    routes,
    decrypt: decryptCredential,
    enabled: async () => enabled,
    canEditAgent: async (actor, agentId) => editable.has(agentId) && (await active(actor)),
    canManageInstallation: async (actor) => active(actor),
    getAgentName: async (_actor, agentId) =>
      viewable.has(agentId) ? `Name ${agentId}` : undefined,
    provider: createDiscordProviderClient({
      fetch: fetchProvider,
      config: {
        redirectUri: 'https://chat.example/callback',
        requestTimeoutMs: 1000,
        maxResponseBytes: 8192,
        botPermissions: '68608',
      },
    }),
  });
  resolver = createDiscordRouteResolver({
    installations,
    channels,
    routes,
    enabled: async () => {
      expect(getTenantId()).toBe(principal.tenantId);
      return enabled;
    },
  });
  const browser = createDiscordBindingHandlers(service);
  const gateway = createDiscordRouteHandlers({ resolver, serviceToken: () => serviceToken });
  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (authenticated) Object.assign(req, { user: principal });
    tenantStorage.run({ tenantId: principal.tenantId }, next);
  });
  app.get('/agents/:agentId/binding', browser.status);
  app.post('/agents/:agentId/binding', browser.bind);
  app.delete('/agents/:agentId/binding', browser.remove);
  app.get('/service/:applicationId/security', gateway.security);
  app.post('/service/resolve', gateway.resolve);
});

it('binds a verified destination and returns only browser-safe channel metadata', () =>
  scope(async () => {
    const bound = unwrap(await bind());
    expect(bound.channel).toMatchObject({
      type: 'discord',
      status: 'active',
      agentId: 'agent',
      discord: { applicationId, guildId, externalChannelId },
    });
    expect(JSON.stringify(bound)).not.toMatch(/private-|encrypted|applicationRevision/);
    expect((await routes.read(guild.installationId, externalChannelId))?.revision).toBe(
      bound.routeRevision,
    );
  }));

it('recovers a committed assignment after its acknowledgement is lost', () =>
  scope(async () => {
    const assign = routes.assign.bind(routes);
    const uncertain = jest.spyOn(routes, 'assign').mockImplementationOnce(async (input) => {
      unwrap(await assign(input));
      throw new Error('Acknowledgement lost');
    });
    try {
      const bound = unwrap(await bind());
      expect((await routes.read(guild.installationId, externalChannelId))?.channelId).toBe(
        bound.channel.channelId,
      );
      expect((await channels.getAgentChannelMetadata(bound.channel.channelId))?.status).toBe(
        'active',
      );
    } finally {
      uncertain.mockRestore();
    }
  }));

it('holds an unconfirmed assignment without claiming failure or deleting a possible successor', () =>
  scope(async () => {
    const uncertain = jest
      .spyOn(routes, 'assign')
      .mockRejectedValueOnce(new Error('Database acknowledgement unavailable'));
    try {
      expect(await bind()).toEqual({ ok: false, error: { code: 'binding_uncertain' } });
      expect(await routes.read(guild.installationId, externalChannelId)).toBeNull();
      const candidate = (await channels.listAgentChannels('agent')).find(
        (channel) => channel.status === 'pending_install',
      );
      if (!candidate) throw new Error('Missing held binding candidate');
      expect(await channels.getActiveAgentChannel(candidate.channelId)).toBeNull();
    } finally {
      uncertain.mockRestore();
    }
  }));

it.each(['editor', 'manager', 'disabled', 'application', 'guild'] as const)(
  'rechecks %s authority after Discord I/O before creating a candidate',
  (kind) =>
    scope(async () => {
      onRequest = async (path) => {
        if (path !== `/channels/${externalChannelId}`) return;
        if (kind === 'editor') editable.clear();
        if (kind === 'manager')
          await db.models.User.updateOne({ _id: principal.id }, { $set: { role: 'USER' } });
        if (kind === 'disabled') enabled = false;
        if (kind === 'application')
          await installations.configureApplication({
            actorId: principal.id,
            applicationId,
            botUserId,
            publicKey: 'b'.repeat(64),
            expectedRevision: applicationRevision,
          });
        if (kind === 'guild')
          await installations.disconnectGuild({
            actorId: principal.id,
            installationId: guild.installationId,
            expectedRevision: guild.revision,
          });
      };
      const expected = {
        editor: 'forbidden',
        manager: 'forbidden',
        disabled: 'not_configured',
        application: 'application_changed',
        guild: 'installation_unavailable',
      };
      expect(await bind()).toMatchObject({
        ok: false,
        error: {
          code: expected[kind],
        },
      });
      expect(await db.models.AgentChannel.countDocuments({})).toBe(0);
    }),
);

it('redacts a collision name without VIEW and cleans up a losing pending candidate', () =>
  scope(async () => {
    const initial = unwrap(await bind());
    const target = { ...input(), agentId: 'other' };
    expect(unwrap(await service.status(principal, target))).toEqual({
      occupied: true,
      assignedToThisAgent: false,
      canReplace: true,
      revision: initial.routeRevision,
    });
    viewable.add('agent');
    expect(unwrap(await service.status(principal, target))).toMatchObject({
      assignedAgentName: 'Name agent',
    });
    expect(await service.bind(principal, target)).toMatchObject({
      ok: false,
      error: { code: 'route_changed' },
    });
    expect(await db.models.AgentChannel.countDocuments({})).toBe(1);
    expect((await routes.read(guild.installationId, externalChannelId))?.channelId).toBe(
      initial.channel.channelId,
    );
    const changed = unwrap(
      await service.bind(principal, { ...target, expectedRevision: initial.routeRevision }),
    );
    expect(changed.channel.agentId).toBe('other');
    expect((await channels.getAgentChannel(initial.channel.channelId))?.status).toBe('deleting');
  }));

it('allows removal after disablement but rejects removing another agent through the wrong path', () =>
  scope(async () => {
    const bound = unwrap(await bind());
    expect(
      await service.remove(principal, {
        ...input(),
        agentId: 'other',
        expectedRevision: bound.routeRevision,
      }),
    ).toMatchObject({ ok: false });
    enabled = false;
    expect(
      await service.remove(principal, { ...input(), expectedRevision: bound.routeRevision }),
    ).toEqual({ ok: true, value: null });
    expect(await routes.read(guild.installationId, externalChannelId)).toBeNull();
  }));

it('rejects uneditable agents, foreign principals and arbitrary destinations', () =>
  scope(async () => {
    expect(await service.bind({ ...principal, tenantId: 'foreign' }, input())).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await service.bind(principal, { ...input(), agentId: 'missing' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(fetchProvider).not.toHaveBeenCalled();
    expect(await service.bind(principal, { ...input(), externalChannelId: '999' })).toMatchObject({
      ok: false,
      error: { code: 'provider_refused' },
    });
    expect(await db.models.AgentChannel.countDocuments({})).toBe(0);
  }));

it('restores tenant from stored application ownership and resolves only its exact active route', async () => {
  const bound = await scope(async () => unwrap(await bind()));
  const security = await scope(() => resolver.security(applicationId), 'foreign');
  expect(security).toMatchObject({
    tenantId: principal.tenantId,
    applicationId,
    applicationRevision,
    botUserId,
  });
  const resolved = await scope(() => resolver.resolve(resolveInput()), 'foreign');
  expect(resolved).toMatchObject({
    channelId: bound.channel.channelId,
    channelRevision: bound.channel.revision,
    installationId: guild.installationId,
    installationRevision: guild.revision,
    tenantId: principal.tenantId,
  });
  expect(JSON.stringify(resolved)).not.toMatch(/private-|encrypted/);
  for (const change of [
    { guildId: '999' },
    { externalChannelId: '999' },
    { expectedApplicationRevision: 'obsolete' },
  ])
    expect(await resolver.resolve({ ...resolveInput(), ...change })).toBeNull();
});

it('refuses routing after installation disconnect or application-owner erasure', () =>
  scope(async () => {
    await bind();
    await installations.disconnectGuild({
      actorId: principal.id,
      installationId: guild.installationId,
      expectedRevision: guild.revision,
    });
    expect(await resolver.resolve(resolveInput())).toBeNull();
    await db.models.ResponseScope.updateMany({}, { $set: { closed: true } });
    expect(await resolver.security(applicationId)).toBeNull();
  }));

it('validates authenticated browser payloads and protects service key/route lookups', async () => {
  authenticated = false;
  await request(app).post('/agents/agent/binding').send(input()).expect(401);
  authenticated = true;
  await request(app)
    .post('/agents/agent/binding')
    .send({ installationId: guild.installationId, externalChannelId, tenantId: 'foreign' })
    .expect(400);
  const bound = await request(app)
    .post('/agents/agent/binding')
    .send({ installationId: guild.installationId, externalChannelId })
    .expect(200);
  expect(bound.headers['cache-control']).toBe('no-store');
  await request(app).get(`/service/${applicationId}/security`).expect(401);
  const security = await request(app)
    .get(`/service/${applicationId}/security`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(200);
  expect(security.body.applicationRevision).toBe(applicationRevision);
  expect(JSON.stringify(security.body)).not.toMatch(/private-|encrypted/);
  await request(app)
    .post('/service/resolve')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send({ ...resolveInput(), tenantId: 'foreign' })
    .expect(400);
  await request(app)
    .post('/service/resolve')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send(resolveInput())
    .expect(200);
});

it('composes binding permissions, protected routing, and policy changes around the canonical authority', async () => {
  let permission = PermissionBits.VIEW;
  let manage = true;
  const policy = createDiscordPolicyReader(async () => ({
    endpoints: {
      agents: { channels: channelConfigSchema.parse({ enabled, discord: { enabled: true } }) },
    },
  }));
  const access = {
    getAgent: async () => ({ _id: new mongoose.Types.ObjectId(principal.id), name: 'Agent' }),
    getEffectivePermissions: jest.fn(async () => permission),
  };
  const authority = createChannelAuthority({
    channels,
    identityStorage: createChannelIdentityStorage(db),
    getConfig: async () => ({ enabled }),
    findUser: (id) => channels.findUser({ _id: id }),
    getRole: (name) => db.models.Role.findOne({ name }),
    isPrincipalActive: async () => true,
    getAgentPermissions: async () => PermissionBits.VIEW,
    publicBaseUrl: 'https://chat.example',
  });
  const runtime = createDiscordChannelRuntime({
    channels,
    installations,
    routes,
    inbox: createDiscordInboxStorage(db, policy.inbox),
    commands: createDiscordCommandStorage(db),
    gateway: createDiscordGatewayStorage(db, policy.ownership),
    application: { authority, storage: createChannelRunStorage(db) },
    policy,
    access,
    findUser: (id) => channels.findUser({ _id: id }),
    isPrincipalActive: async () => true,
    hasCapability: async () => manage,
    serviceToken: () => serviceToken,
    fetch: fetchProvider,
    publicBaseUrl: 'https://chat.example',
    logError: jest.fn(),
  });
  app.put('/host/:agentId/binding', runtime.bindings.bind);
  app.get('/host/:agentId/binding', runtime.bindings.status);
  app.delete('/host/:agentId/binding', runtime.bindings.remove);
  app.get('/host/security/:applicationId', runtime.routes.security);
  app.post('/host/inbox/claim', runtime.inbox.claim);
  app.post('/host/gateway/acquire', runtime.gateway.acquire);
  app.post('/host/gateway/bootstrap', runtime.gateway.bootstrap);
  const { agentId, ...target } = input();
  const url = `/host/${agentId}/binding`;
  await request(app).put(url).send(target).expect(403);
  expect(access.getEffectivePermissions).toHaveBeenCalledWith(
    expect.objectContaining({
      resourceType: ResourceType.AGENT,
      userId: principal.id,
    }),
  );
  permission = PermissionBits.SHARE | PermissionBits.VIEW;
  manage = false;
  await request(app).put(url).send(target).expect(403);
  expect(fetchProvider).not.toHaveBeenCalled();
  manage = true;
  const assigned = await request(app).put(url).send(target).expect(200);
  await request(app).get(`/host/security/${applicationId}`).expect(401);
  await request(app)
    .get(`/host/security/${applicationId}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(200);
  await request(app).post('/host/inbox/claim').send({ applicationId, owner: 'worker' }).expect(401);
  const gatewayOwner = { applicationId, applicationRevision, ownerId: 'a'.repeat(32) };
  await request(app)
    .post('/host/gateway/acquire')
    .send({ owner: gatewayOwner, leaseMs: 30000 })
    .expect(401);
  await request(app)
    .post('/host/gateway/bootstrap')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send({ owner: gatewayOwner })
    .expect(409);
  await request(app)
    .post('/host/gateway/acquire')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send({ owner: gatewayOwner, leaseMs: 30000 })
    .expect(204);
  const bootstrap = await request(app)
    .post('/host/gateway/bootstrap')
    .set('Authorization', `Bearer ${serviceToken}`)
    .send({ owner: gatewayOwner })
    .expect(200);
  expect(bootstrap.body.botToken).toBe(token);
  expect(bootstrap.body.policy.enabled).toBe(false);
  enabled = false;
  await request(app)
    .get(`/host/security/${applicationId}`)
    .set('Authorization', `Bearer ${serviceToken}`)
    .expect(404);
  await request(app).put(url).send(target).expect(404);
  const status = await request(app).get(url).query(target).expect(200);
  expect(status.body.value.canReplace).toBe(false);
  await request(app)
    .delete(url)
    .send({ ...target, expectedRevision: assigned.body.value.routeRevision })
    .expect(200);
});
