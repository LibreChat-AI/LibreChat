import '~/mcp/registry/__tests__/helpers/setupCredsEnv';
import express from 'express';
import mongoose from 'mongoose';
import supertest from 'supertest';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createModels,
  createSlackWorkspaceStorage,
  tenantStorage,
  runAsSystem,
} from '@librechat/data-schemas';
import {
  FileSources,
  Permissions,
  PermissionTypes,
  PrincipalType,
  channelConfigSchema,
  SLACK_CHANNEL_BOT_SCOPES,
} from 'librechat-data-provider';
import type { AppConfig, SlackWorkspaceStorage } from '@librechat/data-schemas';
import type { SlackWorkspaceApp, SlackWorkspaceService } from './workspaces';
import type { ServerRequest } from '~/types/http';
import { capabilityContextMiddleware, generateCapabilityCheck } from '~/middleware/capabilities';
import { encryptCredential, decryptCredential } from '~/crypto/credentials';
import { createSlackWorkspaceRuntime } from './workspaceRuntime';
import { createSlackWorkspaceHandlers } from './workspaceHttp';
import { createSlackWorkspaceService } from './workspaces';
import { createPeoplePickerAccess } from '~/acl/search';
import { setOAuthSession } from '~/oauth/csrf';

describe('Slack workspace installation', () => {
  const db = new mongoose.Mongoose();
  let mongo: MongoMemoryReplSet;
  let storage: SlackWorkspaceStorage;
  let service: SlackWorkspaceService;
  let app: SlackWorkspaceApp | undefined;
  const principal = { id: '000000000000000000000001', tenantId: 'org-a' };
  const request = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>();
  const canManage = jest.fn(async () => true);
  const previousJwtSecret = process.env.JWT_SECRET;
  const scoped = <T>(fn: () => Promise<T>) => tenantStorage.run({ tenantId: 'org-a' }, fn);
  const grant = {
    ok: true,
    app_id: 'A123',
    token_type: 'bot',
    access_token: 'xoxb-test-only-token',
    bot_user_id: 'U123',
    team: { id: 'T123', name: 'Test workspace' },
    scope: SLACK_CHANNEL_BOT_SCOPES.join(','),
  };
  const reply = (body = grant) => new Response(JSON.stringify(body), { status: 200 });
  const browserCookie = (response: supertest.Response, name: string): string => {
    const header = response.headers['set-cookie'];
    const cookies = Array.isArray(header) ? header : [header];
    const cookie = cookies.find((value) => value?.startsWith(`${name}=`));
    if (!cookie) throw new Error(`Missing ${name} test cookie`);
    return cookie.split(';')[0];
  };
  const start = async (workspaceId?: string) => {
    const result = await scoped(() => service.start(principal, workspaceId));
    if (!result.ok) throw new Error(result.error.code);
    const state = new URL(result.value.url).searchParams.get('state')!;
    const pending = await service.flow(state);
    if (!pending) throw new Error('Missing test flow');
    const flow = await scoped(() => service.claim(pending));
    if (!flow) throw new Error('Missing test claim');
    return { ...result.value, state, flow };
  };

  beforeAll(async () => {
    mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
    await db.connect(mongo.getUri());
    createModels(db);
    storage = createSlackWorkspaceStorage(db);
  }, 60000);
  afterAll(async () => {
    if (previousJwtSecret == null) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwtSecret;
    await db.disconnect();
    await mongo?.stop();
  });
  beforeEach(async () => {
    await runAsSystem(async () => {
      for (const name of [
        'SlackWorkspace',
        'SlackInstall',
        'SlackInstallGeneration',
        'AclEntry',
        'User',
        'ResponseScope',
      ])
        await db.models[name]?.deleteMany({});
    });
    app = {
      appId: 'A123',
      clientId: '123.456',
      clientSecret: 'test-client-secret',
      signingSecret: 'test-signing-secret',
      redirectUri: 'https://chat.example/base/api/channels/workspaces/oauth/callback',
      flowLifetimeMs: 600_000,
      requestTimeoutMs: 10_000,
      maxResponseBytes: 65_536,
    };
    canManage.mockReset().mockResolvedValue(true);
    request.mockReset().mockImplementation(async () => reply());
    service = createSlackWorkspaceService({
      storage,
      config: async () => app,
      canManage,
      fetch: request,
      encrypt: encryptCredential,
    });
    process.env.JWT_SECRET = 'slack-workspace-test-secret';
  });

  it('stores only the state hash, exchanges on the fixed Slack endpoint and encrypts the bot grant', async () => {
    const { state, flow, url } = await start();
    expect(new URL(url).origin).toBe('https://slack.com');
    expect(JSON.stringify(flow)).not.toContain(state);
    const result = await scoped(() => service.finish(flow, 'test-code'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.teamId).toBe('T123');
    expect(JSON.stringify(result)).not.toContain(grant.access_token);
    const stored = await scoped(() => storage.read(result.value.workspaceId));
    expect(stored?.encryptedBotToken).toMatch(/^v3:/);
    expect(await decryptCredential(stored!.encryptedBotToken!)).toBe(grant.access_token);
    expect(request).toHaveBeenCalledWith(
      'https://slack.com/api/oauth.v2.access',
      expect.objectContaining({
        redirect: 'error',
        method: 'POST',
      }),
    );
    expect(await service.flow(state)).toBeNull();
  });

  it('registers encrypted organization app credentials without returning either secret', async () => {
    const result = await scoped(() =>
      service.configureApp(principal, {
        appId: 'A123',
        clientId: '123.456',
        clientSecret: 'test-client-secret',
        signingSecret: 'test-signing-secret',
      }),
    );
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('secret');
    const stored = await scoped(() => storage.app('A123'));
    expect(stored?.encryptedClientSecret).toMatch(/^v3:/);
    expect(stored?.encryptedSigningSecret).toMatch(/^v3:/);
    expect(await decryptCredential(stored!.encryptedClientSecret!)).toBe('test-client-secret');
    expect(await decryptCredential(stored!.encryptedSigningSecret!)).toBe('test-signing-secret');
    expect(await tenantStorage.run({ tenantId: 'org-b' }, () => storage.app('A123'))).toBeNull();
  });

  it('validates display names and permits metadata-only edits without replacing encrypted secrets', async () => {
    const input = {
      appId: 'A123',
      clientId: '123.456',
      clientSecret: 'test-client-secret',
      signingSecret: 'test-signing-secret',
      name: '  Support bot  ',
    };
    const created = await scoped(() => service.configureApp(principal, input));
    if (!created.ok) throw new Error('Test registration failed');
    expect(created.value.name).toBe('Support bot');
    const before = await scoped(() => storage.app('A123'));
    const renamed = await scoped(() =>
      service.configureApp(principal, {
        appId: 'A123',
        clientId: '123.456',
        name: 'Help desk',
        expectedRevision: created.value.revision,
      }),
    );
    expect(renamed).toMatchObject({ ok: true, value: { name: 'Help desk' } });
    const after = await scoped(() => storage.app('A123'));
    expect(after?.encryptedClientSecret).toBe(before?.encryptedClientSecret);
    expect(after?.encryptedSigningSecret).toBe(before?.encryptedSigningSecret);
    expect(JSON.stringify(renamed)).not.toContain('secret');
    expect(
      await scoped(() => service.configureApp(principal, { appId: 'A999', clientId: '123.456' })),
    ).toEqual({ ok: false, error: { code: 'invalid_install' } });
    expect(
      await scoped(() => service.configureApp(principal, { ...input, name: 'x'.repeat(101) })),
    ).toEqual({ ok: false, error: { code: 'invalid_install' } });
    expect(
      await scoped(() => service.configureApp(principal, { ...input, clientSecret: '' })),
    ).toEqual({ ok: false, error: { code: 'invalid_install' } });
  });

  it('rejects users without organization management permission before creating an attempt', async () => {
    canManage.mockResolvedValue(false);
    expect(await scoped(() => service.start(principal))).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('refuses a principal from another tenant even when it has administrator privileges', async () => {
    expect(await scoped(() => service.start({ ...principal, tenantId: 'org-b' }))).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(canManage).not.toHaveBeenCalled();
  });

  it('rechecks admin permission after the provider exchange', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(async () => {
      canManage.mockResolvedValue(false);
      return reply();
    });
    expect(await scoped(() => service.finish(flow, 'test-code'))).toEqual({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  it('does not silently complete with a replaced app or a different workspace on reconnect', async () => {
    const { flow } = await start();
    app = { ...app!, clientId: 'different-client' };
    expect(await scoped(() => service.finish(flow, 'test-code'))).toEqual({
      ok: false,
      error: { code: 'invalid_install' },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('uses the workspace Slack actually installed, rather than a browser-supplied tenant or hint', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(async () =>
      reply({ ...grant, team: { id: 'TOTHER', name: 'Chosen in Slack' } }),
    );
    const result = await scoped(() => service.finish(flow, 'test-code'));
    expect(result).toMatchObject({
      ok: true,
      value: { tenantId: 'org-a', teamId: 'TOTHER', teamName: 'Chosen in Slack' },
    });
  });

  it('rejects another workspace installation early while allowing explicit reconnect', async () => {
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'first-code'));
    if (!installed.ok) throw new Error('Test setup failed');
    expect(await scoped(() => service.start(principal))).toEqual({
      ok: false,
      error: { code: 'workspace_in_use' },
    });
    expect(await scoped(() => service.start(principal, installed.value.workspaceId))).toMatchObject(
      { ok: true },
    );
    await scoped(() => storage.disconnect(installed.value.workspaceId));
    expect(await scoped(() => service.start(principal))).toMatchObject({ ok: true });
  });

  it('rejects a second-team callback even when both attempts started before installation', async () => {
    const first = await start();
    const second = await start();
    expect((await scoped(() => service.finish(first.flow, 'first-code'))).ok).toBe(true);
    request.mockImplementationOnce(async () =>
      reply({ ...grant, team: { id: 'TSECOND', name: 'Another workspace' } }),
    );
    expect(await scoped(() => service.finish(second.flow, 'second-code'))).toEqual({
      ok: false,
      error: { code: 'workspace_in_use' },
    });
    expect((await scoped(() => storage.list())).workspaces).toHaveLength(1);
  });

  it('rejects missing scopes and never stores the returned credential', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(async () => reply({ ...grant, scope: 'chat:write' }));
    expect(await scoped(() => service.finish(flow, 'test-code'))).toEqual({
      ok: false,
      error: { code: 'missing_scopes' },
    });
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  it('rejects org-wide or rotating grants rather than installing a credential it cannot maintain', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(
      async () =>
        new Response(JSON.stringify({ ...grant, expires_in: 3600, refresh_token: 'test-refresh' })),
    );
    expect(await scoped(() => service.finish(flow, 'test-code'))).toEqual({
      ok: false,
      error: { code: 'unsupported_installation' },
    });
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  it('reports an org-wide Slack grant with a null workspace as unsupported', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            ...grant,
            team: null,
            is_enterprise_install: true,
          }),
        ),
    );
    expect(await scoped(() => service.finish(flow, 'test-code'))).toEqual({
      ok: false,
      error: { code: 'unsupported_installation' },
    });
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  it('disconnect overtaking the Slack response prevents a delayed callback restoring access', async () => {
    const initial = await start();
    const installed = await scoped(() => service.finish(initial.flow, 'initial-code'));
    if (!installed.ok) throw new Error('Setup failed');
    const late = await start(installed.value.workspaceId);
    request.mockImplementationOnce(async () => {
      await scoped(() => storage.disconnect(installed.value.workspaceId));
      return reply();
    });
    expect(await scoped(() => service.finish(late.flow, 'late-code'))).toEqual({
      ok: false,
      error: { code: 'stale_install' },
    });
    expect(
      (await scoped(() => storage.read(installed.value.workspaceId)))?.encryptedBotToken,
    ).toBeUndefined();
  });

  it('does not turn a provider outage into missing credentials or expose its response', async () => {
    const { flow } = await start();
    request.mockImplementationOnce(
      async () => new Response('private-provider-error', { status: 503 }),
    );
    await expect(scoped(() => service.finish(flow, 'test-code'))).rejects.toThrow(
      'Slack OAuth service unavailable',
    );
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  function http(runtime?: ReturnType<typeof createSlackWorkspaceHandlers>) {
    const server = express();
    server.use(express.json());
    server.use((req, res, next) => capabilityContextMiddleware(req as ServerRequest, res, next));
    server.use((req, _res, next) => {
      const pairs = (req.get('cookie') ?? '').split(';').map((pair) => pair.trim().split('='));
      req.cookies = Object.fromEntries(pairs.filter(([name]) => name));
      next();
    });
    server.use((req, _res, next) => {
      if (req.header('x-test-user'))
        Object.assign(req, {
          user: {
            id: principal.id,
            role: 'WORKSPACE_ADMIN',
            tenantId: req.header('x-test-user-tenant') || 'org-a',
          },
        });
      tenantStorage.run({ tenantId: req.header('x-test-tenant') }, async () => next());
    });
    const handlers =
      runtime ??
      createSlackWorkspaceHandlers({
        service,
        storage,
        canManage,
        clientBaseUrl: 'https://client.example/librechat',
        settings: async () => ({
          configured: Boolean(app),
          appId: app?.appId,
          pageSize: 50,
          maxBotManagers: 50,
        }),
        logError: jest.fn(),
      });
    server.get('/workspaces', handlers.list);
    server.get('/workspaces/apps', handlers.apps);
    server.put('/workspaces/apps', handlers.configureApp);
    server.post('/workspaces/apps/:appId/remove', handlers.removeApp);
    server.get('/workspaces/:workspaceId/managers', handlers.managers);
    server.get('/workspaces/:workspaceId/managers/search', handlers.searchManagers);
    const legacyPeople = createPeoplePickerAccess({
      getRoleByName: async () => ({
        permissions: { [PermissionTypes.PEOPLE_PICKER]: { [Permissions.VIEW_USERS]: false } },
      }),
    });
    server.get(
      '/legacy/people',
      async (req, res, next) => {
        await legacyPeople(req, res, next);
      },
      (_req, res) => {
        res.json({ results: [] });
      },
    );
    server.put('/workspaces/:workspaceId/managers', handlers.updateManagers);
    server.get('/workspaces/:workspaceId', handlers.get);
    server.delete('/workspaces/:workspaceId', handlers.disconnect);
    server.post('/workspaces/:workspaceId/remove', handlers.remove);
    server.post('/workspaces/connect', setOAuthSession, handlers.connect);
    server.delete('/workspaces/attempts/:flowId', handlers.cancel);
    server.get('/api/channels/workspaces/oauth/callback', handlers.callback);
    return supertest(server);
  }

  it('lets a capability-authorized workspace admin find and grant managers without legacy people-picker access', async () => {
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'code'));
    if (!installed.ok) throw new Error(installed.error.code);
    const workspaceId = installed.value.workspaceId;
    const bob = '000000000000000000000002';
    await runAsSystem(() =>
      db.models.User.create([
        {
          _id: principal.id,
          email: 'admin@example.com',
          role: 'WORKSPACE_ADMIN',
          tenantId: 'org-a',
        },
        {
          _id: '000000000000000000000003',
          email: 'foreign@example.com',
          name: 'Bob foreign',
          tenantId: 'org-b',
        },
        {
          _id: '000000000000000000000000',
          email: 'erasing@example.com',
          name: 'Bob erasing',
          tenantId: 'org-a',
          agentTriggerDeletionStartedAt: new Date(),
        },
        { _id: bob, email: 'bob@example.com', name: 'Bob', tenantId: 'org-a' },
      ]),
    );
    let allowed = true;
    const runtime = createSlackWorkspaceRuntime({
      storage,
      publicBaseUrl: 'https://api.example',
      clientBaseUrl: 'https://chat.example',
      readAppConfig: async () => ({
        config: {},
        fileStrategy: FileSources.local,
        imageOutputType: 'png',
        endpoints: {
          agents: {
            channels: channelConfigSchema.parse({
              enabled: true,
              transport: 'webhook',
              maxMetadataPageSize: 1,
              slackApp: { enabled: true },
            }),
          },
        },
      }),
      findUser: async () => ({ ...principal, role: 'WORKSPACE_ADMIN' }),
      isPrincipalActive: async () => true,
      hasCapability: async () => allowed,
      fetch: request,
      logError: jest.fn(),
    });
    const get = (path: string) =>
      http(runtime).get(path).set('x-test-user', 'yes').set('x-test-tenant', 'org-a');
    await get('/legacy/people?types=user&q=bo').expect(403);
    const found = await get(`/workspaces/${workspaceId}/managers/search?q=bo`).expect(200);
    expect(found.body).toEqual([{ id: bob, name: 'Bob', email: 'bob@example.com' }]);
    expect(JSON.stringify(found.body)).not.toMatch(/tenantId|password|encrypted|role/);
    await get(`/workspaces/${workspaceId}/managers/search?q=b`).expect(400);
    await get(`/workspaces/${workspaceId}/managers/search?q=bo&types=role`).expect(400);
    await get('/workspaces/missing/managers/search?q=bo').expect(404);
    const metadata = await scoped(() => storage.metadata(workspaceId));
    await http(runtime)
      .put(`/workspaces/${workspaceId}/managers`)
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({ revision: metadata!.revision, userIds: [bob] })
      .expect(200);
    allowed = false;
    await get(`/workspaces/${workspaceId}/managers/search?q=bo`).expect(403);
    await get(`/workspaces/${workspaceId}/managers`).expect(403);
  });

  it('keeps manager grants admin-only, tenant-local, bounded and revision checked', async () => {
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'code'));
    if (!installed.ok) throw new Error(installed.error.code);
    const id = installed.value.workspaceId;
    const userId = '000000000000000000000002';
    await scoped(async () => {
      await db.models.User.create([
        { _id: principal.id, email: 'admin@example.com' },
        { _id: userId, email: 'member@example.com', name: 'Member' },
      ]);
    });
    const get = () =>
      http()
        .get(`/workspaces/${id}/managers`)
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a');
    const put = (body: object) =>
      http()
        .put(`/workspaces/${id}/managers`)
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a')
        .send(body);
    await http().get(`/workspaces/${id}/managers`).expect(401);
    const initial = (await get().expect(200)).body;
    expect(initial).toMatchObject({ managers: [], maxManagers: 50 });
    canManage.mockResolvedValue(false);
    await get().expect(403);
    await put({ revision: initial.revision, userIds: [userId] }).expect(403);
    canManage.mockResolvedValue(true);
    await put({ revision: initial.revision, userIds: [userId], role: 'admin' }).expect(400);
    await put({ revision: initial.revision, userIds: ['000000000000000000000099'] }).expect(409);
    const saved = (await put({ revision: initial.revision, userIds: [userId] }).expect(200)).body;
    expect(saved.revision).not.toBe(initial.revision);
    await put({ revision: initial.revision, userIds: [] }).expect(409);
    const listed = (await get().expect(200)).body;
    expect(listed.managers).toEqual([{ id: userId, name: 'Member', email: 'member@example.com' }]);
    expect(JSON.stringify(listed)).not.toMatch(/xoxb|encrypted|secret/);
    await http()
      .get(`/workspaces/${id}/managers`)
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-b')
      .expect(403);
  });

  it('requires fresh same-tenant admin authority to register an app and never echoes secrets', async () => {
    const input = {
      appId: 'A123',
      clientId: '123.456',
      clientSecret: 'private-client',
      signingSecret: 'private-signing',
    };
    await http().put('/workspaces/apps').send(input).expect(401);
    await http()
      .put('/workspaces/apps')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-b')
      .send(input)
      .expect(403);
    canManage.mockResolvedValueOnce(false);
    await http()
      .put('/workspaces/apps')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send(input)
      .expect(403);
    expect(await scoped(() => storage.app('A123'))).toBeNull();
    const saved = await http()
      .put('/workspaces/apps')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send(input)
      .expect(200);
    expect(saved.body).toMatchObject({ appId: 'A123', clientId: '123.456' });
    expect(JSON.stringify(saved.body)).not.toContain('private-');
    const listed = await http()
      .get('/workspaces/apps')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .expect(200);
    expect(listed.body.apps).toEqual([saved.body]);
    expect(JSON.stringify(listed.body)).not.toContain('private-');
    await http()
      .put('/workspaces/apps')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send(input)
      .expect(409);
    await http()
      .post('/workspaces/apps/A123/remove')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({ revision: saved.body.revision })
      .expect(204);
    expect(await scoped(() => storage.app('A123'))).toBeNull();
  });

  it('accepts app display-name edits without secrets and rejects incomplete creates', async () => {
    const put = (input: object) =>
      http()
        .put('/workspaces/apps')
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a')
        .send(input);
    await put({ appId: 'A123', clientId: '123.456', name: 'Incomplete' }).expect(400);
    const created = await put({
      appId: 'A123',
      clientId: '123.456',
      name: ' Support ',
      clientSecret: 'private-client',
      signingSecret: 'private-signing',
    }).expect(200);
    const edited = await put({
      appId: 'A123',
      clientId: '123.456',
      name: 'Help desk',
      expectedRevision: created.body.revision,
    }).expect(200);
    expect(edited.body.name).toBe('Help desk');
    expect(JSON.stringify(edited.body)).not.toMatch(/private-|encrypted/);
    await put({
      appId: 'A123',
      clientId: '123.456',
      name: 'x'.repeat(101),
      expectedRevision: edited.body.revision,
    }).expect(400);
    await put({
      appId: 'A123',
      clientId: '123.456',
      signingSecret: '',
      expectedRevision: edited.body.revision,
    }).expect(400);
    await put({
      appId: 'A123',
      clientId: '123.456',
      name: 'Stale',
      expectedRevision: created.body.revision,
    }).expect(409);
    const cleared = await put({
      appId: 'A123',
      clientId: '123.456',
      name: '',
      expectedRevision: edited.body.revision,
    }).expect(200);
    expect(cleared.body).not.toHaveProperty('name');
  });

  it('refuses a stale disconnect confirmation after another administrator reconnects', async () => {
    const { flow } = await start();
    const first = await scoped(() => service.finish(flow, 'first-code'));
    if (!first.ok) throw new Error(first.error.code);
    const secondFlow = await start(first.value.workspaceId);
    const second = await scoped(() => service.finish(secondFlow.flow, 'second-code'));
    if (!second.ok) throw new Error(second.error.code);
    expect(second.value.workspaceId).toBe(first.value.workspaceId);
    const disconnect = (revision?: string) =>
      http()
        .delete(`/workspaces/${first.value.workspaceId}`)
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a')
        .send(revision ? { revision } : {});
    await disconnect().expect(400);
    await disconnect(first.value.revision).expect(409);
    expect((await scoped(() => storage.metadata(first.value.workspaceId)))?.revision).toBe(
      second.value.revision,
    );
    expect((await scoped(() => storage.metadata(first.value.workspaceId)))?.status).toBe('active');
    await disconnect(second.value.revision).expect(204);
    expect((await scoped(() => storage.metadata(first.value.workspaceId)))?.status).toBe(
      'disconnected',
    );
  });

  it('requires current tenant-admin authority and a disconnected revision to remove a workspace', async () => {
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'code'));
    if (!installed.ok) throw new Error(installed.error.code);
    const { workspaceId, revision } = installed.value;
    const remove = (body: object, tenant = 'org-a') =>
      http()
        .post(`/workspaces/${workspaceId}/remove`)
        .set('x-test-user', 'yes')
        .set('x-test-tenant', tenant)
        .set('x-test-user-tenant', tenant)
        .send(body);
    await remove({}).expect(400);
    await remove({ revision }).expect(409);
    await scoped(() => storage.disconnect(workspaceId, revision));
    const retired = await scoped(() => storage.read(workspaceId));
    await remove({ revision: retired!.revision }, 'org-b').expect(409);
    canManage.mockResolvedValue(false);
    await remove({ revision: retired!.revision }).expect(403);
    canManage.mockResolvedValue(true);
    await remove({ revision }).expect(409);
    await remove({ revision: retired!.revision }).expect(204);
    expect((await scoped(() => storage.list())).workspaces).toEqual([]);
  });

  it('returns one saved workspace as credential-free tenant metadata', async () => {
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'test-code'));
    if (!installed.ok) throw new Error(installed.error.code);
    const response = await http()
      .get(`/workspaces/${installed.value.workspaceId}`)
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .expect(200);
    expect(response.body).toMatchObject({
      configured: true,
      canManage: true,
      workspace: { workspaceId: installed.value.workspaceId, teamName: 'Test workspace' },
    });
    expect(JSON.stringify(response.body)).not.toMatch(/xoxb|encrypted|clientSecret|signingSecret/);
    await http()
      .get(`/workspaces/${installed.value.workspaceId}`)
      .set('x-test-user', 'yes')
      .set('x-test-user-tenant', 'org-b')
      .set('x-test-tenant', 'org-b')
      .expect(404);
  });

  it('returns the saved app name in permitted browser workspace metadata without credentials', async () => {
    await scoped(() =>
      service.configureApp(principal, {
        appId: 'A123',
        clientId: '123.456',
        name: 'Support bot',
        clientSecret: 'private-client',
        signingSecret: 'private-signing',
      }),
    );
    const { flow } = await start();
    const installed = await scoped(() => service.finish(flow, 'test-code'));
    if (!installed.ok) throw new Error(installed.error.code);
    const browserGet = (path: string) =>
      http().get(path).set('x-test-user', 'yes').set('x-test-tenant', 'org-a');
    const listed = await browserGet('/workspaces').expect(200);
    expect(listed.body.workspaces[0].appName).toBe('Support bot');
    const detail = await browserGet(`/workspaces/${installed.value.workspaceId}`).expect(200);
    expect(detail.body.workspace.appName).toBe('Support bot');
    expect(JSON.stringify([listed.body, detail.body])).not.toMatch(
      /private-|encrypted|clientId|clientSecret|signingSecret/,
    );
    await http()
      .get(`/workspaces/${installed.value.workspaceId}`)
      .set('x-test-user', 'yes')
      .set('x-test-user-tenant', 'org-b')
      .set('x-test-tenant', 'org-b')
      .expect(404);
    canManage.mockResolvedValue(false);
    expect((await browserGet('/workspaces').expect(200)).body.workspaces).toEqual([]);
  });

  it('requires a signed-in same-tenant principal on browser management routes', async () => {
    const anonymous = await http().get('/workspaces').expect(401);
    expect(anonymous.body).toEqual({ ok: false, error: { code: 'forbidden' } });
    await http()
      .get('/workspaces')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-b')
      .expect(403);
  });

  it('uses organization app credentials with deployment policy and fresh admin capabilities', async () => {
    const config: AppConfig = {
      config: {},
      fileStrategy: FileSources.local,
      imageOutputType: 'png',
      endpoints: {
        agents: {
          channels: channelConfigSchema.parse({
            enabled: true,
            transport: 'webhook',
            slackApp: {
              enabled: true,
            },
          }),
        },
      },
    };
    const readAppConfig = jest.fn(async () => config);
    await scoped(async () =>
      storage.configureApp(
        {
          appId: 'A123',
          clientId: '123.456',
          encryptedClientSecret: await encryptCredential('test-secret'),
          encryptedSigningSecret: await encryptCredential('test-signature'),
        },
        principal.id,
      ),
    );
    const findUser = jest.fn(async () => ({ tenantId: 'org-a', role: 'ADMIN' }));
    const isPrincipalActive = jest.fn(async () => true);
    const hasCapability = jest.fn(async () => true);
    const runtime = createSlackWorkspaceRuntime({
      storage,
      readAppConfig,
      findUser,
      isPrincipalActive,
      hasCapability,
      publicBaseUrl: 'https://chat.example/base',
      clientBaseUrl: 'https://client.example/librechat',
      fetch: request,
      logError: jest.fn(),
    });
    const initial = await http(runtime)
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({ appId: 'A123' })
      .expect(200);
    expect(readAppConfig).toHaveBeenCalledWith({ baseOnly: true, failClosed: true });
    const destination = new URL(initial.body.url);
    expect(destination.searchParams.get('redirect_uri')).toBe(
      'https://chat.example/base/api/channels/workspaces/oauth/callback',
    );
    expect(hasCapability).toHaveBeenCalledTimes(2);
    hasCapability.mockResolvedValue(false);
    const denied = await http(runtime)
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({})
      .expect(403);
    expect(denied.body.error.code).toBe('forbidden');
    expect(findUser).toHaveBeenCalledTimes(2);
    findUser.mockResolvedValue({ tenantId: 'org-b', role: 'ADMIN' });
    hasCapability.mockResolvedValue(true).mockClear();
    await http(runtime)
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({})
      .expect(403);
    expect(hasCapability).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(['capability', 'principal'])(
    'honors %s revocation during Slack exchange despite an ambient request cache',
    async (revocation) => {
      await scoped(async () =>
        storage.configureApp(
          {
            appId: 'A123',
            clientId: '123.456',
            encryptedClientSecret: await encryptCredential('test-client-secret'),
            encryptedSigningSecret: await encryptCredential('test-signing-secret'),
          },
          principal.id,
        ),
      );
      let revoked = false;
      const checks = generateCapabilityCheck({
        getUserPrincipals: async () => [
          {
            principalType: PrincipalType.USER,
            principalId: revocation === 'principal' && revoked ? 'revoked-principal' : principal.id,
          },
        ],
        hasCapabilityForPrincipals: async ({ principals }) =>
          !(revocation === 'capability' && revoked) &&
          principals.some((entry) => entry.principalId === principal.id),
      });
      const runtime = createSlackWorkspaceRuntime({
        storage,
        readAppConfig: async () =>
          ({
            endpoints: {
              agents: {
                channels: {
                  enabled: true,
                  transport: 'webhook',
                  slackApp: { enabled: true },
                },
              },
            },
          }) as AppConfig,
        findUser: async () => ({ tenantId: 'org-a', role: 'ADMIN' }),
        isPrincipalActive: async () => true,
        hasCapability: checks.hasCapability,
        publicBaseUrl: 'https://chat.example/base',
        clientBaseUrl: 'https://client.example/librechat',
        fetch: request,
        logError: jest.fn(),
      });
      const started = await http(runtime)
        .post('/workspaces/connect')
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a')
        .send({ appId: 'A123' })
        .expect(200);
      request.mockImplementationOnce(async () => {
        revoked = true;
        return reply();
      });
      const result = await http(runtime)
        .get('/api/channels/workspaces/oauth/callback')
        .set('Cookie', browserCookie(started, 'oauth_csrf'))
        .query({ state: new URL(started.body.url).searchParams.get('state'), code: 'test-code' })
        .expect(302);
      expect(result.headers.location).toContain('error=slack_forbidden');
      expect(request).toHaveBeenCalledTimes(1);
      expect((await scoped(() => storage.list())).workspaces).toEqual([]);
    },
  );

  it('cancels through the authenticated browser route before a late callback can install', async () => {
    const started = await start();
    await http()
      .delete(`/workspaces/attempts/${started.flowId}`)
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .expect(204);
    expect(await service.flow(started.state)).toBeNull();
    const callback = await http()
      .get('/api/channels/workspaces/oauth/callback')
      .query({ state: started.state, code: 'late-code' })
      .expect(302);
    expect(callback.headers.location).toContain('error=invalid_state');
    expect(request).not.toHaveBeenCalled();
  });

  it('requires the initiating browser, restores its tenant and rejects callback replay', async () => {
    const started = await http()
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({})
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const cookie = browserCookie(started, 'oauth_csrf');
    const path = '/api/channels/workspaces/oauth/callback';
    const rejected = await http().get(path).query({ state, code: 'test-code' }).expect(302);
    expect(rejected.headers.location).toContain('error=invalid_state');
    expect(request).not.toHaveBeenCalled();
    const complete = await http()
      .get(path)
      .set('Cookie', cookie)
      .query({ state, code: 'test-code' })
      .expect(302);
    expect(complete.headers.location).toContain('/oauth/success?serverName=Slack');
    expect(new URL(complete.headers.location).origin).toBe('https://client.example');
    expect(new URL(complete.headers.location).pathname).toBe('/librechat/oauth/success');
    expect((await scoped(() => storage.list())).workspaces).toHaveLength(1);
    const replay = await http()
      .get(path)
      .set('Cookie', cookie)
      .query({ state, code: 'test-code' })
      .expect(302);
    expect(replay.headers.location).toContain('error=invalid_state');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(['denied', 'missing-code', 'outage'])(
    'retires a %s callback even with a reusable OAuth session',
    async (outcome) => {
      const started = await http()
        .post('/workspaces/connect')
        .set('x-test-user', 'yes')
        .set('x-test-tenant', 'org-a')
        .send({})
        .expect(200);
      const state = new URL(started.body.url).searchParams.get('state');
      const session = browserCookie(started, 'oauth_session');
      if (outcome === 'outage') request.mockRejectedValueOnce(new Error('Provider unavailable'));
      const result = await http()
        .get('/api/channels/workspaces/oauth/callback')
        .set('Cookie', session)
        .query({
          state,
          ...(outcome === 'denied' ? { error: 'access_denied' } : {}),
          ...(outcome === 'outage' ? { code: 'test-code' } : {}),
        })
        .expect(302);
      const destination = new URL(result.headers.location);
      expect(destination.origin).toBe('https://client.example');
      expect(destination.pathname).toBe('/librechat/oauth/error');
      expect(destination.searchParams.get('flow')).toBe(started.body.flowId);
      expect(await service.flow(state!)).toBeNull();
      const calls = request.mock.calls.length;
      const replay = await http()
        .get('/api/channels/workspaces/oauth/callback')
        .set('Cookie', session)
        .query({ state, code: 'replay' })
        .expect(302);
      expect(new URL(replay.headers.location).searchParams.has('flow')).toBe(false);
      expect(request).toHaveBeenCalledTimes(calls);
      expect((await scoped(() => storage.list())).workspaces).toEqual([]);
    },
  );

  it('claims a callback before exchanging its code and does not correlate a duplicate failure', async () => {
    const started = await http()
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({})
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const session = browserCookie(started, 'oauth_session');
    let release!: (value: Response) => void;
    let entered!: () => void;
    const exchanging = new Promise<void>((resolve) => {
      entered = resolve;
    });
    request.mockImplementationOnce(() => {
      entered();
      return new Promise((resolve) => {
        release = resolve;
      });
    });
    const first = http()
      .get('/api/channels/workspaces/oauth/callback')
      .set('Cookie', session)
      .query({ state, code: 'first' })
      .then((response) => response);
    try {
      await exchanging;
      const duplicate = await http()
        .get('/api/channels/workspaces/oauth/callback')
        .set('Cookie', session)
        .query({ state, code: 'duplicate' })
        .expect(302);
      expect(new URL(duplicate.headers.location).searchParams.has('flow')).toBe(false);
      expect(request).toHaveBeenCalledTimes(1);
    } finally {
      release(reply());
    }
    expect(new URL((await first).headers.location).pathname).toBe('/librechat/oauth/success');
    expect((await scoped(() => storage.list())).workspaces).toHaveLength(1);
  });

  it('does not let a tenant-bound host override the tenant in a valid browser flow', async () => {
    const started = await http()
      .post('/workspaces/connect')
      .set('x-test-user', 'yes')
      .set('x-test-tenant', 'org-a')
      .send({})
      .expect(200);
    const state = new URL(started.body.url).searchParams.get('state');
    const cookie = browserCookie(started, 'oauth_csrf');
    const result = await http()
      .get('/api/channels/workspaces/oauth/callback')
      .set('Cookie', cookie)
      .set('x-test-tenant', 'org-b')
      .query({ state, code: 'test-code' })
      .expect(302);
    expect(result.headers.location).toContain('error=invalid_state');
    expect(request).not.toHaveBeenCalled();
  });
});
