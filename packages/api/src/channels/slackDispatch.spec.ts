import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  FileSources,
  channelConfigSchema,
  PermissionBits,
  PrincipalType,
  PrincipalModel,
  ResourceType,
} from 'librechat-data-provider';
import {
  createModels,
  createMethods,
  createSlackWorkspaceStorage,
  createSlackRouteStorage,
  createSlackDispatchStorage,
  tenantStorage,
  runAsSystem,
  TransactionUnavailableError,
} from '@librechat/data-schemas';
import { createSlackWorkspaceBindingHandlers } from './workspaceBindings';
import { createSlackWorkspaceSettingsReader } from './workspaceRuntime';
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
  let manageAllowed = true;
  let principalActive = true;
  let sequence = 0;
  const readAgentName = jest.fn((...args: Parameters<typeof channels.getAgentName>) =>
    channels.getAgentName(...args),
  );
  const config = channelConfigSchema.parse({
    enabled: true,
    transport: 'webhook',
    maxMetadataPageSize: 2,
    slackApp: {
      enabled: true,
    },
  });
  const scoped = <T>(task: () => Promise<T>, tenantId = 'org-a') =>
    tenantStorage.run({ tenantId }, task);
  const query = (teamId = 'T123', appId = 'A123') => ({
    tenantId:
      ({ T456: 'org-b', TDOT: 'org.with.periods' } as Record<string, string>)[teamId] ?? 'org-a',
    appId,
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
  async function install(teamId = 'T123', token = 'xoxb-first', appId = 'A123') {
    const registration = await storage.app(appId);
    if (!registration?.clientId)
      await storage.configureApp(
        {
          appId,
          clientId: '123.456',
          encryptedClientSecret: await encryptCredential('oauth-secret'),
          encryptedSigningSecret: await encryptCredential('signing-secret'),
        },
        'admin',
      );
    const stateHash = `install-${++sequence}`;
    await storage.startInstall({
      stateHash,
      appId,
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
        appId,
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
    const result = await routes.assign({
      workspaceId,
      channelId,
      userId: 'admin',
      isBotAdmin: true,
      channelRevision: 'consent',
    });
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
    const readSettings = createSlackWorkspaceSettingsReader({
      storage,
      publicBaseUrl: 'https://api.example',
      clientBaseUrl: 'https://chat.example',
      readAppConfig: async () => ({
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'png',
        endpoints: { agents: { channels: { ...config, enabled } } },
      }),
    });
    const handlers = createSlackDispatchHandlers({
      workspaces: storage,
      routes,
      channels,
      dispatch,
      readSettings,
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
    app.post('/app', handlers.app);
    app.post('/resolve', handlers.resolve);
    app.post('/discover', handlers.discover);
    app.post('/lifecycle', handlers.lifecycle);
    app.get('/bundle/:tenantId/:channelId', bound.bundle);
    const bindings = createSlackWorkspaceBindingHandlers({
      channels,
      workspaces: storage,
      routes,
      readSettings,
      canManage: async () => manageAllowed,
      isPrincipalActive: async () => principalActive,
      getAgentName: readAgentName,
      logError: jest.fn(),
    });
    app.use('/ui', (req, _res, next) => {
      if (req.get('x-test-user'))
        Object.assign(req, {
          user: { id: req.get('x-test-user'), tenantId: req.get('x-test-user-tenant') || 'org-a' },
        });
      tenantStorage.run({ tenantId: req.get('x-test-tenant') || 'org-a' }, () => next());
    });
    app.post('/ui/:agentId/connections', bindings.create);
    app.get('/ui/:agentId/:channelId/routes', bindings.read);
    app.post('/ui/:agentId/:channelId/routes', bindings.assign);
    app.delete('/ui/:agentId/:channelId/routes', bindings.remove);
    app.patch('/ui/:agentId/:channelId/manual', bound.update);
    app.delete('/ui/:agentId/:channelId', bound.remove);
    app.get('/ui/:agentId/:channelId/manual-manifest', bound.manifest);
    request = supertest(app);
  }, 60000);
  beforeEach(async () => {
    enabled = true;
    manageAllowed = true;
    principalActive = true;
    readAgentName.mockClear();
    provider
      .mockReset()
      .mockImplementation(
        async () => new Response(JSON.stringify({ ok: true, team_id: 'T123', user_id: 'U123' })),
      );
    await runAsSystem(async () => {
      for (const name of [
        'User',
        'Agent',
        'AclEntry',
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

  const browserPost = (path: string, body: object) =>
    request
      .post('/ui/' + path)
      .set('x-test-user', 'admin')
      .send(body);
  async function pending(workspaceId: string, agentId = 'agent') {
    return (await browserPost(agentId + '/connections', { workspaceId }).expect(201)).body;
  }

  it('preserves thread/channel refinement when adding the service tenant scope', async () => {
    await scoped(() => install());
    const invalid = await post('/resolve', {
      tenantId: 'org-a',
      appId: 'A123',
      teamId: 'T123',
      target: {
        kind: 'thread',
        actorId: 'U123',
        externalChannelId: 'C123',
        externalThreadKey: 'C999:1.000001',
      },
    });
    expect(invalid.status).toBe(400);
  });

  it('creates a usable workspace binding through the browser API without accepting credentials', async () => {
    const workspace = await scoped(() => install());
    const channel = await pending(workspace.workspaceId);
    expect(channel).toMatchObject({
      workspaceId: workspace.workspaceId,
      status: 'pending_install',
      credentialMode: 'per_user',
    });
    const active = (
      await browserPost(`agent/${channel.channelId}/routes`, {
        channelRevision: channel.revision,
      }).expect(200)
    ).body;
    expect(active.status).toBe('active');
    expect(active.revision).not.toBe(channel.revision);
    expect(JSON.stringify(active)).not.toMatch(/xoxb|encrypted|signing/);
    await request
      .patch(`/ui/agent/${channel.channelId}/manual`)
      .set('x-test-user', 'admin')
      .send({ credentialMode: 'shared', revision: active.revision })
      .expect(409, { error: 'workspace_managed_connection' });
    await request
      .get(`/ui/agent/${channel.channelId}/manual-manifest`)
      .set('x-test-user', 'admin')
      .expect(409, { error: 'workspace_managed_connection' });
    const resolved = await post('/resolve', query()).expect(200);
    expect(resolved.body.channelId).toBe(channel.channelId);
    expect(
      (
        await request
          .get(`/bundle/org-a/${channel.channelId}`)
          .set('Authorization', `Bearer ${serviceToken}`)
          .expect(200)
      ).body.credentials.botToken,
    ).toBe('xoxb-first');
    await browserPost('agent/connections', {
      workspaceId: workspace.workspaceId,
      botToken: 'xoxb-copy',
    }).expect(400);
  });

  const managerId = '000000000000000000000002';
  async function managers(workspaceId: string, userIds = [managerId]) {
    return scoped(async () => {
      const adminId = '000000000000000000000001';
      for (const id of [adminId, managerId])
        await db.models.User.updateOne(
          { _id: id },
          { $setOnInsert: { email: `${id}@example.com` } },
          { upsert: true },
        );
      const workspace = await storage.metadata(workspaceId);
      if (!workspace) throw new Error('Missing workspace');
      const result = await storage.setBotManagers({
        workspaceId,
        revision: workspace.revision,
        actorId: adminId,
        userIds,
        maxManagers: 50,
      });
      if (!result.ok) throw new Error(result.code);
    });
  }

  it('lets an explicitly granted manager route without credentials and remove assignments after revocation', async () => {
    const workspace = await scoped(() => install());
    await managers(workspace.workspaceId);
    manageAllowed = false;
    const member = managerId;
    const channel = (
      await request
        .post('/ui/member-agent/connections')
        .set('x-test-user', member)
        .send({ workspaceId: workspace.workspaceId })
        .expect(201)
    ).body;
    const active = (
      await request
        .post(`/ui/member-agent/${channel.channelId}/routes`)
        .set('x-test-user', member)
        .send({ channelRevision: channel.revision, externalChannelId: 'CMEMBER' })
        .expect(200)
    ).body;
    expect(active.status).toBe('active');
    expect(JSON.stringify(active)).not.toMatch(/xoxb|encrypted|signing/);
    const target = (
      await request
        .get(`/ui/member-agent/${channel.channelId}/routes?target=CMEMBER`)
        .set('x-test-user', member)
        .expect(200)
    ).body;
    expect(target).toMatchObject({ assignedToThisChannel: true, canReplace: true });
    expect(readAgentName).not.toHaveBeenCalled();
    await managers(workspace.workspaceId, []);
    await request
      .post(`/ui/member-agent/${channel.channelId}/routes`)
      .set('x-test-user', member)
      .send({ channelRevision: active.revision, externalChannelId: 'COTHER' })
      .expect(403, { error: 'bot_access_required' });
    await request
      .delete(`/ui/member-agent/${channel.channelId}/routes`)
      .set('x-test-user', member)
      .send({ externalChannelId: 'CMEMBER', expectedRevision: target.revision })
      .expect(204);
    expect(await scoped(() => routes.read(workspace.workspaceId, 'CMEMBER'))).toBeNull();
  });

  it('names the assigned agent only with tenant-local VIEW permission, including after permission revocation', async () => {
    const viewer = '000000000000000000000003';
    const workspace = await scoped(() => install());
    const original = await pending(workspace.workspaceId);
    await browserPost(`agent/${original.channelId}/routes`, {
      channelRevision: original.revision,
    }).expect(200);
    const member = (
      await request
        .post('/ui/member-agent/connections')
        .set('x-test-user', viewer)
        .send({ workspaceId: workspace.workspaceId })
        .expect(201)
    ).body;
    const agent = await scoped(() =>
      db.models.Agent.create({
        id: 'agent',
        name: 'Research Assistant',
        author: new mongoose.Types.ObjectId(),
        provider: 'openAI',
        model: 'test',
      }),
    );
    const read = () =>
      request
        .get(`/ui/member-agent/${member.channelId}/routes?target=default`)
        .set('x-test-user', viewer)
        .expect(200);
    expect((await read()).body).not.toHaveProperty('assignedAgentName');
    const acl = await scoped(() =>
      db.models.AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: new mongoose.Types.ObjectId(viewer),
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        permBits: PermissionBits.VIEW,
        grantedBy: new mongoose.Types.ObjectId(viewer),
        grantedAt: new Date(),
      }),
    );
    expect((await read()).body.assignedAgentName).toBe('Research Assistant');
    expect(
      await scoped(() => channels.getAgentName('agent', 'org-b', { userId: viewer })),
    ).toBeUndefined();
    await scoped(() => db.models.AclEntry.deleteOne({ _id: acl._id }));
    expect((await read()).body).not.toHaveProperty('assignedAgentName');
  });

  it('requires an admin-granted bot permission and rejects browser attempts to forge it', async () => {
    const workspace = await scoped(() => install());
    const original = await pending(workspace.workspaceId);
    await browserPost(`agent/${original.channelId}/routes`, {
      channelRevision: original.revision,
    }).expect(200);
    manageAllowed = false;
    const create = () =>
      request
        .post('/ui/member-agent/connections')
        .set('x-test-user', managerId)
        .send({ workspaceId: workspace.workspaceId });
    await create().expect(403, { error: 'bot_access_required' });
    await managers(workspace.workspaceId);
    const channel = (await create().expect(201)).body;
    const target = (
      await request
        .get(`/ui/member-agent/${channel.channelId}/routes?target=default`)
        .set('x-test-user', managerId)
        .expect(200)
    ).body;
    expect(target).toMatchObject({ occupied: true, canReplace: true });
    const body = { channelRevision: channel.revision, expectedRevision: target.revision };
    await request
      .post(`/ui/member-agent/${channel.channelId}/routes`)
      .set('x-test-user', managerId)
      .send({ ...body, isBotAdmin: true })
      .expect(400);
    const assigned = await request
      .post(`/ui/member-agent/${channel.channelId}/routes`)
      .set('x-test-user', managerId)
      .send(body);
    expect({ status: assigned.status, body: assigned.body }).toMatchObject({
      status: 200,
      body: { status: 'active' },
    });
    expect((await scoped(() => routes.read(workspace.workspaceId)))?.channelId).toBe(
      channel.channelId,
    );
  });

  it('preserves administrator authority when a direct manager grant is revoked after preflight', async () => {
    const workspace = await scoped(() => install());
    await managers(workspace.workspaceId);
    const channel = (
      await request
        .post('/ui/admin-agent/connections')
        .set('x-test-user', managerId)
        .send({ workspaceId: workspace.workspaceId })
        .expect(201)
    ).body;
    const assign = routes.assign.bind(routes);
    const write = jest.spyOn(routes, 'assign').mockImplementationOnce(async (input) => {
      await managers(workspace.workspaceId, []);
      return assign(input);
    });
    try {
      await request
        .post(`/ui/admin-agent/${channel.channelId}/routes`)
        .set('x-test-user', managerId)
        .send({ channelRevision: channel.revision })
        .expect(200);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ isBotAdmin: true }));
    } finally {
      write.mockRestore();
    }
  });

  it('leaves a conflicting connection pending until an explicit route revision is supplied', async () => {
    const workspace = await scoped(() => install());
    const first = await pending(workspace.workspaceId);
    await browserPost(`agent/${first.channelId}/routes`, {
      channelRevision: first.revision,
    }).expect(200);
    const second = await pending(workspace.workspaceId, 'second-agent');
    await browserPost(`second-agent/${second.channelId}/routes`, {
      channelRevision: second.revision,
    }).expect(409);
    expect((await scoped(() => channels.getAgentChannel(second.channelId)))?.status).toBe(
      'pending_install',
    );
    const observed = (
      await request
        .get(`/ui/second-agent/${second.channelId}/routes?target=default`)
        .set('x-test-user', 'admin')
        .expect(200)
    ).body;
    expect(observed).toEqual({
      canReplace: true,
      occupied: true,
      assignedToThisChannel: false,
      revision: expect.any(String),
    });
    expect(JSON.stringify(observed)).not.toContain(first.channelId);
    await browserPost(`second-agent/${second.channelId}/routes`, {
      channelRevision: second.revision,
      expectedRevision: observed.revision,
    }).expect(200);
    expect((await post('/resolve', query()).expect(200)).body.channelId).toBe(second.channelId);
  });

  it('checks current activity, creator, tenant and binding revision at management boundaries', async () => {
    const workspace = await scoped(() => install());
    await request
      .post('/ui/agent/connections')
      .send({ workspaceId: workspace.workspaceId })
      .expect(401);
    const channel = await pending(workspace.workspaceId);
    principalActive = false;
    await browserPost(`agent/${channel.channelId}/routes`, {
      channelRevision: channel.revision,
    }).expect(403);
    principalActive = true;
    await request
      .get(`/ui/agent/${channel.channelId}/routes`)
      .set('x-test-user', 'other-admin')
      .expect(404);
    await request
      .get(`/ui/other-agent/${channel.channelId}/routes`)
      .set('x-test-user', 'admin')
      .expect(404);
    await request
      .get(`/ui/agent/${channel.channelId}/routes`)
      .set('x-test-user', 'admin')
      .set('x-test-tenant', 'org-b')
      .expect(403);
    await browserPost(`agent/${channel.channelId}/routes`, { channelRevision: 'stale' }).expect(
      409,
    );
    await scoped(() => storage.disconnect(workspace.workspaceId));
    await browserPost(`agent/${channel.channelId}/routes`, {
      channelRevision: channel.revision,
    }).expect(409);
    expect((await scoped(() => channels.getAgentChannel(channel.channelId)))?.status).toBe(
      'pending_install',
    );
  });

  it('pages only this binding’s routes and prevents removing a route belonging to another binding', async () => {
    const workspace = await scoped(() => install());
    const first = await pending(workspace.workspaceId);
    const active = (
      await browserPost(`agent/${first.channelId}/routes`, {
        channelRevision: first.revision,
      }).expect(200)
    ).body;
    for (const externalChannelId of ['C123', 'C456'])
      await browserPost(`agent/${first.channelId}/routes`, {
        channelRevision: active.revision,
        externalChannelId,
      }).expect(200);
    const page = (
      await request
        .get(`/ui/agent/${first.channelId}/routes`)
        .set('x-test-user', 'admin')
        .expect(200)
    ).body;
    expect(page.routes).toHaveLength(2);
    expect(page.next).toEqual(expect.any(String));
    const last = (
      await request
        .get(`/ui/agent/${first.channelId}/routes?cursor=${page.next}`)
        .set('x-test-user', 'admin')
        .expect(200)
    ).body;
    expect(last.routes).toHaveLength(1);
    expect(last.next).toBeUndefined();
    const second = await pending(workspace.workspaceId, 'second-agent');
    const target = (
      await request
        .get(`/ui/second-agent/${second.channelId}/routes?target=C456`)
        .set('x-test-user', 'admin')
        .expect(200)
    ).body;
    await request
      .delete(`/ui/second-agent/${second.channelId}/routes`)
      .set('x-test-user', 'admin')
      .send({ externalChannelId: 'C456', expectedRevision: target.revision })
      .expect(409);
    await scoped(() => storage.disconnect(workspace.workspaceId));
    await request
      .delete(`/ui/agent/${first.channelId}/routes`)
      .set('x-test-user', 'admin')
      .send({ externalChannelId: 'C456', expectedRevision: target.revision })
      .expect(204);
    await request
      .get(`/ui/agent/${first.channelId}/routes?cursor=invalid`)
      .set('x-test-user', 'admin')
      .expect(400);
  });

  it('atomically admits only one competing first route and accepts dotted browser tenants', async () => {
    const workspace = await scoped(() => install());
    const first = await pending(workspace.workspaceId);
    const second = await pending(workspace.workspaceId, 'other-agent');
    const results = await Promise.all([
      browserPost(`agent/${first.channelId}/routes`, { channelRevision: first.revision }),
      browserPost(`other-agent/${second.channelId}/routes`, { channelRevision: second.revision }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
    expect(
      (
        await scoped(() =>
          Promise.all([
            channels.getAgentChannel(first.channelId),
            channels.getAgentChannel(second.channelId),
          ]),
        )
      )
        .map((channel) => channel?.status)
        .sort(),
    ).toEqual(['active', 'pending_install']);
    const dotted = await scoped(() => install('TDOT', 'xoxb-dotted', 'ADOT'), 'org.with.periods');
    const created = await request
      .post('/ui/dotted-agent/connections')
      .set('x-test-user', 'admin')
      .set('x-test-user-tenant', 'org.with.periods')
      .set('x-test-tenant', 'org.with.periods')
      .send({ workspaceId: dotted.workspaceId })
      .expect(201);
    await request
      .post(`/ui/dotted-agent/${created.body.channelId}/routes`)
      .set('x-test-user', 'admin')
      .set('x-test-user-tenant', 'org.with.periods')
      .set('x-test-tenant', 'org.with.periods')
      .send({ channelRevision: created.body.revision })
      .expect(200);
    expect((await post('/resolve', query('TDOT', 'ADOT')).expect(200)).body.tenantId).toBe(
      'org.with.periods',
    );
  });

  it('requires the service token before returning app secrets and fails closed when disabled', async () => {
    await request.get('/bootstrap').expect(401);
    const bootstrap = await request
      .get('/bootstrap')
      .set('Authorization', `Bearer ${serviceToken}`)
      .expect(200);
    expect(bootstrap.body).not.toHaveProperty('signingSecret');
    await request.post('/app').send({ tenantId: 'org-a', appId: 'A123' }).expect(401);
    await post('/app', { tenantId: 'org-a', appId: 'A123' }).expect(404);
    await scoped(() => install());
    expect(
      (await post('/app', { tenantId: 'org-a', appId: 'A123' }).expect(200)).body.signingSecret,
    ).toBe('signing-secret');
    await post('/app', { tenantId: 'org-b', appId: 'A123' }).expect(404);
    expect(bootstrap.body.workers.discoveryBatchSize).toBe(2);
    expect(JSON.stringify(bootstrap.body)).not.toContain('oauth-secret');
    enabled = false;
    await request.get('/bootstrap').set('Authorization', `Bearer ${serviceToken}`).expect(404);
    await post('/resolve', query()).expect(404);
  });
  it('shares successful readiness, retries failure and still refreshes current signing policy', async () => {
    const dispatch = createSlackDispatchStorage(db);
    const ready = jest
      .spyOn(dispatch, 'ready')
      .mockRejectedValueOnce(new TransactionUnavailableError());
    let secret = 'first-policy';
    let configured = true;
    const handlers = createSlackDispatchHandlers({
      workspaces: storage,
      routes,
      channels,
      dispatch,
      readSettings: async (appId?: string) => {
        const current = channelConfigSchema.parse({
          ...config,
          slackApp: config.slackApp,
        });
        return {
          channels: { ...current, enabled: configured },
          app:
            configured && appId === 'A123'
              ? resolveSlackWorkspaceApp(
                  current,
                  'https://chat.example/api/channels/workspaces/oauth/callback',
                  {
                    appId: 'A123',
                    clientId: '123.456',
                    clientSecret: 'oauth-secret',
                    signingSecret: secret,
                  },
                )
              : undefined,
        };
      },
      serviceToken: () => serviceToken,
      fetch: provider,
      logError: jest.fn(),
    });
    const server = supertest(
      express()
        .use(express.json())
        .get('/bootstrap', handlers.bootstrap)
        .post('/app', handlers.app),
    );
    const bootstrap = () => server.get('/bootstrap').set('Authorization', `Bearer ${serviceToken}`);
    await server.get('/bootstrap').expect(401);
    expect(ready).not.toHaveBeenCalled();
    expect((await bootstrap().expect(503)).body.error).toBe('transactions_unavailable');
    await Promise.all([bootstrap().expect(200), bootstrap().expect(200), bootstrap().expect(200)]);
    expect(ready).toHaveBeenCalledTimes(2);
    secret = 'replacement-policy';
    expect(
      (
        await server
          .post('/app')
          .set('Authorization', `Bearer ${serviceToken}`)
          .send({ tenantId: 'org-a', appId: 'A123' })
          .expect(200)
      ).body.signingSecret,
    ).toBe(secret);
    configured = false;
    await bootstrap().expect(404);
    expect(ready).toHaveBeenCalledTimes(2);
    ready.mockRestore();
  });
  it('resolves two workspaces to their saved tenants regardless of a supplied tenant header', async () => {
    const first = await scoped(async () => {
      const workspace = await install();
      await bind(workspace.workspaceId);
      return workspace;
    });
    const second = await scoped(async () => {
      const workspace = await install('T456', 'xoxb-second', 'A456');
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
    const b = await post('/resolve', query('T456', 'A456')).expect(200);
    expect(b.body).toEqual({
      kind: 'bound',
      tenantId: 'org-b',
      channelId: 'binding-b',
      workspaceId: second.workspaceId,
    });
    await post('/resolve', { ...query(), appId: 'AOTHER' }).expect(404);
    await post('/resolve', query('TUNKNOWN')).expect(404);
    await post('/resolve', { ...query(), tenantId: 'org-b' }).expect(404);
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
  it('keeps different app secrets isolated and reads replacements immediately', async () => {
    await scoped(() => install());
    await scoped(
      async () =>
        storage.configureApp(
          {
            appId: 'A456',
            clientId: '456.789',
            encryptedClientSecret: await encryptCredential('second-oauth'),
            encryptedSigningSecret: await encryptCredential('second-signature'),
          },
          'admin',
        ),
      'org-b',
    );
    const read = (tenantId: string, appId: string) => post('/app', { tenantId, appId });
    expect((await read('org-a', 'A123').expect(200)).body.signingSecret).toBe('signing-secret');
    expect((await read('org-b', 'A456').expect(200)).body.signingSecret).toBe('second-signature');
    await read('org-a', 'A456').expect(404);
    await read('org-b', 'A123').expect(404);
    await scoped(async () => {
      const app = await storage.app('A123');
      await storage.configureApp(
        {
          appId: 'A123',
          clientId: '123.456',
          encryptedClientSecret: await encryptCredential('replacement-oauth'),
          encryptedSigningSecret: await encryptCredential('replacement-signature'),
        },
        'admin',
        app?.revision,
      );
    });
    expect((await read('org-a', 'A123').expect(200)).body.signingSecret).toBe(
      'replacement-signature',
    );
  });
  it('deletes routes through the existing connection API while preserving retired thread identity', async () => {
    const workspace = await scoped(async () => {
      const installed = await install();
      await bind(installed.workspaceId);
      return installed;
    });
    const specific = await pending(workspace.workspaceId);
    await browserPost(`agent/${specific.channelId}/routes`, {
      channelRevision: specific.revision,
      externalChannelId: 'C123',
    }).expect(200);
    await scoped(() =>
      db.models.SlackThreadRoute.create({
        workspaceId: workspace.workspaceId,
        externalUserId: 'UACTOR',
        externalThreadKey: 'C123:2.000002',
        channelId: specific.channelId,
        userId: 'member',
      }),
    );
    await request.delete(`/ui/agent/${specific.channelId}`).set('x-test-user', 'admin').expect(204);
    expect((await post('/resolve', query()).expect(200)).body.channelId).toBe('binding-a');
    expect(
      (
        await post('/resolve', {
          ...query(),
          target: {
            kind: 'thread',
            actorId: 'UACTOR',
            externalChannelId: 'C123',
            externalThreadKey: 'C123:2.000002',
          },
        }).expect(200)
      ).body.kind,
    ).toBe('retired_thread');
    expect(await scoped(() => routes.read(workspace.workspaceId, 'C123'))).toBeNull();
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
      await post('/lifecycle', { tenantId: 'org-a', appId: 'A123', teamId: 'T123' }).expect(503);
      expect((await scoped(() => storage.read(workspace.workspaceId)))?.status).toBe('active');
    },
  );
  it('retires only a definitively invalid credential, conditional on its verified revision', async () => {
    const workspace = await scoped(() => install());
    provider.mockImplementationOnce(async () => {
      await scoped(() => install('T123', 'xoxb-new'));
      return new Response(JSON.stringify({ ok: false, error: 'token_revoked' }));
    });
    await post('/lifecycle', { tenantId: 'org-a', appId: 'A123', teamId: 'T123' }).expect(204);
    expect((await scoped(() => storage.read(workspace.workspaceId)))?.status).toBe('active');
    provider.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })),
    );
    await post('/lifecycle', { tenantId: 'org-a', appId: 'A123', teamId: 'T123' }).expect(204);
    const current = await scoped(() => storage.read(workspace.workspaceId));
    expect(current?.status).toBe('disconnected');
    expect(current).not.toHaveProperty('encryptedBotToken');
  });
});
