import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { channelConfigSchema } from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createSlackWorkspaceStorage,
  createSlackRouteStorage,
  createSlackDispatchStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import { createSlackDispatchHandlers } from './slackDispatch';
import { encryptCredential } from '~/crypto/credentials';
import { resolveSlackWorkspaceApp } from './workspaces';
import { createChannelHandlers } from './service';

describe('shared Slack service routing', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let storage: ReturnType<typeof createSlackWorkspaceStorage>;
  let routes: ReturnType<typeof createSlackRouteStorage>;
  let channels: ReturnType<typeof createMethods>;
  let request: ReturnType<typeof supertest>;
  const provider = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const serviceToken = 'shared-test-service-token-at-least-32';
  let enabled = true;
  let sequence = 0;
  const config = channelConfigSchema.parse({
    enabled: true,
    transport: 'webhook',
    maxMetadataPageSize: 2,
    slackApp: {
      enabled: true,
      appId: 'A123',
      clientId: '123.456',
      clientSecret: 'oauth-secret',
      signingSecret: 'signing-secret',
    },
  });
  const scoped = <T>(task: () => Promise<T>, tenantId = 'org-a') =>
    tenantStorage.run({ tenantId }, task);
  const query = (teamId = 'T123') => ({
    appId: 'A123',
    teamId,
    target: {
      kind: 'thread',
      actorId: 'UACTOR',
      externalChannelId: 'C123',
      externalThreadKey: 'C123:1.000001',
    },
  });
  const post = (path: string, body: object) =>
    request.post(path).set('Authorization', `Bearer ${serviceToken}`).send(body);
  async function install(teamId = 'T123', token = 'xoxb-first') {
    const stateHash = `install-${++sequence}`;
    await storage.startInstall({
      stateHash,
      appId: 'A123',
      clientId: '123.456',
      userId: 'admin',
      expiresAt: new Date(Date.now() + 60000),
    });
    const claim = await storage.claimInstall(stateHash, 'admin', new Date());
    if (!claim) throw new Error('Missing test claim');
    const result = await storage.completeInstall(
      stateHash,
      claim.callbackId,
      {
        appId: 'A123',
        teamId,
        teamName: 'Sandbox',
        botUserId: 'U123',
        scopes: [],
        encryptedBotToken: await encryptCredential(token),
      },
      new Date(),
    );
    if (!result.ok) throw new Error(result.code);
    return result.workspace;
  }
  async function bind(workspaceId: string, channelId = 'binding-a') {
    await channels.createAgentChannel({
      workspaceId,
      channelId,
      agentId: 'agent',
      createdBy: 'owner',
      type: 'slack',
      status: 'active',
      credentialMode: 'per_user',
      revision: 'consent',
    });
    const result = await routes.assign({ workspaceId, channelId, userId: 'admin' });
    if (!result.ok) throw new Error(result.code);
  }
  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri());
    createModels(db);
    channels = createMethods(db);
    storage = createSlackWorkspaceStorage(db);
    routes = createSlackRouteStorage(db);
    const dispatch = createSlackDispatchStorage(db, async () => config);
    await runAsSystem(() => dispatch.ready());
    const handlers = createSlackDispatchHandlers({
      workspaces: storage,
      routes,
      channels,
      dispatch,
      readSettings: async () => ({
        channels: config,
        app: enabled ? resolveSlackWorkspaceApp(config, 'https://api.example/callback') : undefined,
      }),
      serviceToken: () => serviceToken,
      fetch: provider,
      logError: jest.fn(),
    });
    const bound = createChannelHandlers({
      db: channels,
      config: async () => config,
      serviceToken: () => serviceToken,
      getAgent: async (id) => ({ id }),
      verifySlackToken: async () => null,
      logError: jest.fn(),
    });
    const app = express();
    app.use(express.json());
    app.get('/bootstrap', handlers.bootstrap);
    app.post('/resolve', handlers.resolve);
    app.post('/discover', handlers.discover);
    app.post('/lifecycle', handlers.lifecycle);
    app.get('/bundle/:tenantId/:channelId', bound.bundle);
    request = supertest(app);
  }, 60000);
  beforeEach(async () => {
    enabled = true;
    provider
      .mockReset()
      .mockImplementation(
        async () => new Response(JSON.stringify({ ok: true, team_id: 'T123', user_id: 'U123' })),
      );
    await runAsSystem(async () => {
      for (const name of [
        'AgentChannel',
        'SlackWorkspace',
        'SlackInstall',
        'SlackInstallGeneration',
        'SlackRoute',
        'SlackThreadRoute',
        'ResponseScope',
        'ChannelScope',
        'ChannelIdentity',
        'ChannelRun',
        'ChannelLane',
      ])
        await db.models[name]?.deleteMany({});
    });
  });
  afterAll(async () => {
    await db.disconnect();
    await mongo?.stop();
  });

  it('requires the service token before returning app secrets and fails closed when disabled', async () => {
    await request.get('/bootstrap').expect(401);
    const bootstrap = await request
      .get('/bootstrap')
      .set('Authorization', `Bearer ${serviceToken}`)
      .expect(200);
    expect(bootstrap.body.signingSecret).toBe('signing-secret');
    expect(bootstrap.body.workers.discoveryBatchSize).toBe(2);
    expect(JSON.stringify(bootstrap.body)).not.toContain('oauth-secret');
    enabled = false;
    await request.get('/bootstrap').set('Authorization', `Bearer ${serviceToken}`).expect(404);
    await post('/resolve', query()).expect(404);
  });
  it('resolves two workspaces to their saved tenants regardless of a supplied tenant header', async () => {
    const first = await scoped(async () => {
      const workspace = await install();
      await bind(workspace.workspaceId);
      return workspace;
    });
    const second = await scoped(async () => {
      const workspace = await install('T456');
      await bind(workspace.workspaceId, 'binding-b');
      return workspace;
    }, 'org-b');
    const a = await post('/resolve', query()).set('X-Tenant-Id', 'org-b').expect(200);
    expect(a.body).toEqual({
      kind: 'bound',
      tenantId: 'org-a',
      channelId: 'binding-a',
      workspaceId: first.workspaceId,
    });
    const b = await post('/resolve', query('T456')).expect(200);
    expect(b.body).toEqual({
      kind: 'bound',
      tenantId: 'org-b',
      channelId: 'binding-b',
      workspaceId: second.workspaceId,
    });
    await post('/resolve', { ...query(), appId: 'AOTHER' }).expect(404);
    await post('/resolve', query('TUNKNOWN')).expect(404);
    await post('/resolve', { ...query(), tenantId: 'org-b' }).expect(400);
    expect(JSON.stringify([a.body, b.body])).not.toContain('xoxb');
  });
  it('reads the live credential for a binding and makes disconnect effective at the existing service guard', async () => {
    const workspace = await scoped(async () => {
      const workspace = await install();
      await bind(workspace.workspaceId);
      return workspace;
    });
    const bundle = () =>
      request.get('/bundle/org-a/binding-a').set('Authorization', `Bearer ${serviceToken}`);
    expect((await bundle().expect(200)).body.credentials).toEqual({
      botToken: 'xoxb-first',
      signingSecret: 'signing-secret',
    });
    await scoped(() => install('T123', 'xoxb-replacement'));
    expect((await bundle().expect(200)).body.credentials.botToken).toBe('xoxb-replacement');
    expect(await scoped(() => channels.getAgentChannel('binding-a'))).not.toHaveProperty(
      'encryptedBotToken',
    );
    await scoped(() => storage.disconnect(workspace.workspaceId));
    await bundle().expect(404);
    await post('/resolve', query()).expect(404);
    const replacement = await scoped(() => install());
    expect(replacement.workspaceId).not.toBe(workspace.workspaceId);
    await bundle().expect(404);
  });
  it('keeps an established thread on its original binding instead of falling back after retirement', async () => {
    await scoped(async () => {
      const workspace = await install();
      await bind(workspace.workspaceId);
      await db.models.SlackThreadRoute.create({
        workspaceId: workspace.workspaceId,
        externalUserId: 'UACTOR',
        externalThreadKey: 'C123:1.000001',
        channelId: 'retired',
        userId: 'member',
      });
    });
    const result = await post('/resolve', query()).expect(200);
    expect(result.body.kind).toBe('retired_thread');
    expect(result.body.botToken).toBe('xoxb-first');
  });
  it('returns a private unmapped result but never falls back for unknown action references', async () => {
    await scoped(() => install());
    expect((await post('/resolve', query()).expect(200)).body.kind).toBe('unmapped');
    for (const target of [
      { kind: 'run', runId: 'missing' },
      { kind: 'link', linkId: 'missing' },
      { kind: 'message', externalMessageKey: 'C123:1.000001' },
    ])
      await post('/resolve', { ...query(), target }).expect(404);
    await post('/discover', { limit: 3 }).expect(400);
    expect((await post('/discover', { limit: 2 }).expect(200)).body).toEqual([]);
  });
  it.each(['rate-limit', 'malformed', 'network'])(
    'does not disconnect on a %s credential probe failure',
    async (failure) => {
      const workspace = await scoped(() => install());
      if (failure === 'network') provider.mockRejectedValueOnce(new Error('Network unavailable'));
      else
        provider.mockResolvedValueOnce(
          failure === 'malformed'
            ? new Response('not json')
            : new Response(JSON.stringify({ ok: false, error: 'ratelimited' })),
        );
      await post('/lifecycle', { appId: 'A123', teamId: 'T123' }).expect(503);
      expect((await scoped(() => storage.read(workspace.workspaceId)))?.status).toBe('active');
    },
  );
  it('retires only a definitively invalid credential, conditional on its verified revision', async () => {
    const workspace = await scoped(() => install());
    provider.mockImplementationOnce(async () => {
      await scoped(() => install('T123', 'xoxb-new'));
      return new Response(JSON.stringify({ ok: false, error: 'token_revoked' }));
    });
    await post('/lifecycle', { appId: 'A123', teamId: 'T123' }).expect(204);
    expect((await scoped(() => storage.read(workspace.workspaceId)))?.status).toBe('active');
    provider.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })),
    );
    await post('/lifecycle', { appId: 'A123', teamId: 'T123' }).expect(204);
    const current = await scoped(() => storage.read(workspace.workspaceId));
    expect(current?.status).toBe('disconnected');
    expect(current).not.toHaveProperty('encryptedBotToken');
  });
});
