process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

// Loaded via dynamic import in beforeAll so the crypto module initializes
// after CREDS_KEY is set above (encryptV3 reads the key at module load).
let encryptV3: typeof import('@librechat/data-schemas').encryptV3;
let createAdminLangfuseHandlers: typeof import('./langfuse').createAdminLangfuseHandlers;
let getLangfuseDestinationId: typeof import('../langfuse/destinations').getLangfuseDestinationId;
// Imported as a namespace, rather than destructured, so a test can `jest.spyOn`
// the live binding `./langfuse` calls through — the only way to exercise its
// defensive catch-all, since every real fetch failure already arrives wrapped
// as a `LangfusePromptRequestError`.
let promptsModule: typeof import('../langfuse/prompts');
const realFetch = global.fetch;

function projectResponse(projectId = 'project-1') {
  return {
    ok: true,
    status: 200,
    json: jest.fn().mockResolvedValue({ data: [{ id: projectId, name: 'Project' }] }),
  };
}

beforeAll(async () => {
  ({ encryptV3 } = await import('@librechat/data-schemas'));
  ({ createAdminLangfuseHandlers } = await import('./langfuse'));
  ({ getLangfuseDestinationId } = await import('../langfuse/destinations'));
  promptsModule = await import('../langfuse/prompts');
});

beforeEach(() => {
  process.env.TENANT_ISOLATION_STRICT = 'true';
  process.env.LANGFUSE_FANOUT_ENABLED = 'true';
  process.env.LANGFUSE_FANOUT_COLLECTOR_URL = 'http://langfuse-fanout:4318';
  global.fetch = jest.fn().mockResolvedValue(projectResponse()) as unknown as typeof fetch;
});

afterEach(() => {
  delete process.env.LANGFUSE_FANOUT_ENABLED;
  delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
  delete process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL;
  delete process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED;
  delete process.env.LANGFUSE_PUBLIC_KEY;
  delete process.env.LANGFUSE_SECRET_KEY;
  delete process.env.LANGFUSE_TRACING_ENABLED;
  delete process.env.LANGFUSE_SAMPLE_RATE;
  delete process.env.TENANT_ISOLATION_STRICT;
  delete process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE;
  global.fetch = realFetch;
});

/** A stored tenant connection valid enough for `resolveLangfusePromptConnection`
 *  to resolve (the suite's `beforeEach` keeps multi-tenant routing on, so this
 *  always resolves through the tenant's own destination, never the central env
 *  project). */
function tenantLangfuseConnection(overrides: Record<string, unknown> = {}) {
  return {
    destination: 'eu',
    publicKey: 'pk-lf-1',
    secretKey: encryptV3('sk-lf-secret'),
    ...overrides,
  };
}

function withPromptSync(enabled: boolean, connection: Record<string, unknown> = {}) {
  return { ...tenantLangfuseConnection(connection), promptSync: { enabled } };
}

/** The stored base config the list/get prompt routes' tenant-switch gate
 *  reads, independent of whatever `req.config` a test also sets up for
 *  `resolveLangfusePromptConnection`. Most tests want both in agreement. */
function createPromptSyncHandlers(storedEnabled: boolean, overrides: Record<string, unknown> = {}) {
  return createHandlers({
    findConfigByPrincipal: jest
      .fn()
      .mockResolvedValue(baseConfigDoc({ promptSync: { enabled: storedEnabled } })),
    ...overrides,
  });
}

function fetchJsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn().mockResolvedValue(body) };
}

function promptListBody() {
  return {
    data: [
      {
        name: 'greeting',
        type: 'text',
        versions: [1, 2],
        labels: ['production'],
        tags: ['demo'],
        lastUpdatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        name: 'support-chat',
        type: 'chat',
        versions: [1],
        labels: [],
        tags: [],
        lastUpdatedAt: '2026-01-02T00:00:00.000Z',
      },
    ],
    meta: { page: 1, limit: 10, totalItems: 2, totalPages: 1 },
  };
}

function mockReq(overrides = {}) {
  return {
    user: { id: 'u1', role: 'ADMIN', tenantId: 't1' },
    params: {},
    body: {},
    query: {},
    ...overrides,
  } as Partial<ServerRequest> as ServerRequest;
}

interface MockRes {
  statusCode: number;
  body: undefined | Record<string, unknown>;
  status: jest.Mock;
  json: jest.Mock;
}

function mockRes() {
  const res: MockRes = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((data: MockRes['body']) => {
      res.body = data;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockRes;
}

function baseConfigDoc(langfuse: Record<string, unknown>) {
  return {
    _id: 'cfg1',
    principalType: 'role',
    principalId: '__base__',
    priority: 10,
    isActive: true,
    overrides: { langfuse },
    updatedAt: new Date('2026-06-29T00:00:00.000Z'),
  };
}

function createHandlers(overrides = {}) {
  const deps = {
    findConfigByPrincipal: jest.fn().mockResolvedValue(null),
    patchConfigFields: jest
      .fn()
      .mockImplementation((_pt, _pid, _pm, fields) =>
        Promise.resolve(baseConfigDoc(rehydrate(fields))),
      ),
    toggleConfigActive: jest.fn().mockImplementation((_pt, _pid, isActive) =>
      Promise.resolve({
        ...baseConfigDoc({}),
        isActive,
      }),
    ),
    getMessages: jest.fn().mockResolvedValue([]),
    invalidateConfigCaches: jest.fn().mockResolvedValue(undefined),
    recordConnectionUpdate: jest.fn(),
    ...overrides,
  };
  const handlers = createAdminLangfuseHandlers(deps);
  return { handlers, deps };
}

/** Turn dot-path field entries into a nested langfuse object for the fake DB. */
function rehydrate(fields: Record<string, unknown>): Record<string, unknown> {
  const langfuse: Record<string, unknown> = {};
  for (const [path, value] of Object.entries(fields)) {
    langfuse[path.replace(/^langfuse\./, '')] = value;
  }
  return langfuse;
}

describe('createAdminLangfuseHandlers', () => {
  describe('connection availability gate', () => {
    it('rejects connection reads when deployment fanout is disabled', async () => {
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Langfuse connection settings are not available' });
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('rejects connection updates when deployment fanout is disabled', async () => {
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({ body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' } }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Langfuse connection settings are not available' });
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it('rejects connection settings when the fanout collector URL is missing', async () => {
      delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Langfuse connection settings are not available' });
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('rejects connection tests when deployment fanout is disabled', async () => {
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      global.fetch = jest.fn() as unknown as typeof fetch;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({ body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' } }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Langfuse connection settings are not available' });
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('rejects connection settings when tenant fanout export is emergency-disabled', async () => {
      process.env.LANGFUSE_FANOUT_TENANT_EXPORT_DISABLED = 'true';
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ error: 'Langfuse connection settings are not available' });
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('allows connection settings without fanout in single-tenant mode', async () => {
      delete process.env.TENANT_ISOLATION_STRICT;
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(200);
    });

    it('rejects single-tenant settings when environment credentials are configured', async () => {
      delete process.env.TENANT_ISOLATION_STRICT;
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
      process.env.LANGFUSE_PUBLIC_KEY = 'pk-env';
      process.env.LANGFUSE_SECRET_KEY = 'sk-env';
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });

    it('rejects settings when tracing is disabled', async () => {
      process.env.LANGFUSE_TRACING_ENABLED = 'false';
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(deps.findConfigByPrincipal).not.toHaveBeenCalled();
    });
  });

  describe('getConnection', () => {
    it('reports not configured when no base config exists', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toMatchObject({ configured: false, enabled: false });
      expect(res.body?.secretKey).toBeUndefined();
    });

    it('returns metadata only and never the secret key', async () => {
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(
          baseConfigDoc({
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-lf-1',
            secretKey: encryptV3('sk-lf-secret'),
            secretKeyPreview: 'sk-lf...cret',
          }),
        ),
      });
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.body).toMatchObject({
        configured: true,
        enabled: true,
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKeyPreview: 'sk-lf...cret',
      });
      expect(res.body?.destinations).toEqual(
        expect.arrayContaining([{ key: 'eu', baseUrl: 'https://cloud.langfuse.com' }]),
      );
      expect(res.body?.secretKey).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('sk-lf-secret');
      expect(JSON.stringify(res.body)).not.toContain('v3:');
    });

    it('reports configured connections without an enabled field as disabled', async () => {
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(
          baseConfigDoc({
            destination: 'eu',
            publicKey: 'pk-lf-1',
            secretKey: encryptV3('sk-lf-secret'),
          }),
        ),
      });
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.body).toMatchObject({ configured: true, enabled: false });
    });

    it('reads only active base configs', async () => {
      const findConfigByPrincipal = jest.fn().mockResolvedValue(null);
      const { handlers } = createHandlers({ findConfigByPrincipal });
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(findConfigByPrincipal).toHaveBeenCalledWith('role', '__base__');
    });
  });

  describe('getSessionLink', () => {
    const storedConnection = {
      enabled: true,
      destination: 'eu',
      projectId: 'project-1',
      publicKey: 'pk-lf-1',
      secretKey: 'encrypted-secret',
    };

    it('returns the session URL when this user has a sampled message for the project', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(storedConnection)),
        getMessages: jest.fn().mockResolvedValue([{ _id: 'message-1' }]),
      });
      const res = mockRes();

      await handlers.getSessionLink(mockReq({ params: { conversationId: 'conversation-1' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        url: 'https://cloud.langfuse.com/project/project-1/sessions/conversation-1',
        destinationId: getLangfuseDestinationId('https://cloud.langfuse.com', 'project-1'),
      });
      expect(deps.getMessages).toHaveBeenCalledWith(
        {
          user: 'u1',
          conversationId: 'conversation-1',
          langfuseSampled: true,
          langfuseDestinationIds: getLangfuseDestinationId(
            'https://cloud.langfuse.com',
            'project-1',
          ),
        },
        '_id',
        { sort: false, limit: 1 },
      );
    });

    it("links to the tenant project resolved from that tenant's API keys in fanout mode", async () => {
      let persistedConfig: ReturnType<typeof baseConfigDoc> | null = null;
      const findConfigByPrincipal = jest
        .fn()
        .mockImplementation(() => Promise.resolve(persistedConfig));
      const patchConfigFields = jest.fn().mockImplementation((_pt, _pid, _pm, fields) => {
        persistedConfig = baseConfigDoc(rehydrate(fields));
        return Promise.resolve(persistedConfig);
      });
      const getMessages = jest.fn().mockResolvedValue([{ _id: 'message-1' }]);
      global.fetch = jest
        .fn()
        .mockResolvedValue(projectResponse('tenant-project-1')) as unknown as typeof fetch;
      const { handlers } = createHandlers({
        findConfigByPrincipal,
        patchConfigFields,
        getMessages,
      });

      const updateRes = mockRes();
      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-lf-tenant',
            secretKey: 'sk-lf-tenant',
          },
        }),
        updateRes,
      );

      expect(updateRes.statusCode).toBe(200);
      const [projectsUrl, projectsInit] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(projectsUrl).toBe('https://cloud.langfuse.com/api/public/projects');
      expect(
        Buffer.from(projectsInit.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
      ).toBe('pk-lf-tenant:sk-lf-tenant');
      expect(patchConfigFields.mock.calls[0][3]['langfuse.projectId']).toBe('tenant-project-1');

      const linkRes = mockRes();
      await handlers.getSessionLink(
        mockReq({ params: { conversationId: 'conversation-1' } }),
        linkRes,
      );

      expect(linkRes.body).toEqual({
        url: 'https://cloud.langfuse.com/project/tenant-project-1/sessions/conversation-1',
        destinationId: getLangfuseDestinationId('https://cloud.langfuse.com', 'tenant-project-1'),
      });
      expect(getMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          langfuseDestinationIds: getLangfuseDestinationId(
            'https://cloud.langfuse.com',
            'tenant-project-1',
          ),
        }),
        '_id',
        { sort: false, limit: 1 },
      );
    });

    it('preserves a destination base path in the session URL', async () => {
      process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL = 'https://langfuse.example/base/path';
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(storedConnection)),
        getMessages: jest.fn().mockResolvedValue([{ _id: 'message-1' }]),
      });
      const res = mockRes();

      await handlers.getSessionLink(mockReq({ params: { conversationId: 'conversation-1' } }), res);

      expect(res.body).toEqual({
        url: 'https://langfuse.example/base/path/project/project-1/sessions/conversation-1',
        destinationId: getLangfuseDestinationId('https://langfuse.example/base/path', 'project-1'),
      });
    });

    it('returns 401 when the authenticated user is missing', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.getSessionLink(
        mockReq({ user: undefined, params: { conversationId: 'conversation-1' } }),
        res,
      );

      expect(res.statusCode).toBe(401);
      expect(res.body).toEqual({ error: 'Authentication required' });
    });

    it('does not link a conversation without a sampled message for the current project', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(storedConnection)),
      });
      const res = mockRes();

      await handlers.getSessionLink(mockReq({ params: { conversationId: 'conversation-1' } }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ url: null });
      expect(deps.getMessages).toHaveBeenCalledTimes(1);
    });

    it('does not query messages when the saved connection is disabled', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue(baseConfigDoc({ ...storedConnection, enabled: false })),
      });
      const res = mockRes();

      await handlers.getSessionLink(mockReq({ params: { conversationId: 'conversation-1' } }), res);

      expect(res.body).toEqual({ url: null });
      expect(deps.getMessages).not.toHaveBeenCalled();
    });
  });

  describe('updateConnection', () => {
    it('requires destination', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.updateConnection(mockReq({ body: { publicKey: 'pk' } }), res);
      expect(res.statusCode).toBe(400);
    });

    it('requires publicKey', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.updateConnection(mockReq({ body: { destination: 'eu' } }), res);
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown destination', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.updateConnection(
        mockReq({ body: { destination: 'mars', publicKey: 'pk', secretKey: 'sk' } }),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects encrypted secret values from clients', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.updateConnection(
        mockReq({ body: { destination: 'eu', publicKey: 'pk', secretKey: encryptV3('sk') } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it('requires a secret key on first-time configuration', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();
      await handlers.updateConnection(
        mockReq({ body: { destination: 'eu', publicKey: 'pk' } }),
        res,
      );
      expect(res.statusCode).toBe(400);
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it('stores the secret through the shared config secret helper and never returns the secret', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-lf-1',
            secretKey: 'sk-lf-secret',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const fields = deps.patchConfigFields.mock.calls[0][3];
      expect(fields['langfuse.secretKey']).toMatch(/^v3:/);
      expect(fields['langfuse.secretKey']).not.toContain('sk-lf-secret');
      expect(fields['langfuse.secretKeyPreview']).toBe('sk-lf-...cret');
      expect(fields['langfuse.enabled']).toBe(true);
      expect(fields['langfuse.destination']).toBe('eu');
      expect(fields['langfuse.publicKey']).toBe('pk-lf-1');
      expect(fields['langfuse.projectId']).toBe('project-1');
      expect(res.body?.secretKey).toBeUndefined();
      expect(deps.invalidateConfigCaches).toHaveBeenCalledWith('t1');
      expect(deps.recordConnectionUpdate).toHaveBeenCalledWith({
        event_name: 'librechat.langfuse.connection.changed',
        tenant_id: 't1',
        configured: true,
        enabled: true,
        destination: 'eu',
        change: 'created',
        changes: ['created'],
        verification_result: 'success',
      });
      expect(JSON.stringify(deps.recordConnectionUpdate.mock.calls)).not.toContain('sk-lf-secret');
      expect(JSON.stringify(deps.recordConnectionUpdate.mock.calls)).not.toContain('pk-lf-1');
    });

    it('requires a new secret when connection fields change', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue(baseConfigDoc({ secretKey: encryptV3('sk-lf-secret') })),
      });
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: { enabled: false, destination: 'us', publicKey: 'pk-2' },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'secretKey is required when changing the destination or publicKey',
      });
      expect(global.fetch).not.toHaveBeenCalled();
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it('verifies changed connection fields with the submitted secret', async () => {
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(
          baseConfigDoc({
            destination: 'eu',
            publicKey: 'pk-1',
            secretKey: encryptV3('sk-lf-secret'),
          }),
        ),
      });
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'us',
            publicKey: 'pk-2',
            secretKey: 'sk-lf-replacement',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const fields = deps.patchConfigFields.mock.calls[0][3];
      expect(fields['langfuse.destination']).toBe('us');
      expect(fields['langfuse.publicKey']).toBe('pk-2');
      expect(fields['langfuse.projectId']).toBe('project-1');
      expect(global.fetch).toHaveBeenCalledTimes(2);
      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toBe('https://us.cloud.langfuse.com/api/public/projects');
      expect(
        Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
      ).toBe('pk-2:sk-lf-replacement');
    });

    it('rejects changed credentials before persisting when Langfuse verification fails', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-invalid',
            secretKey: 'sk-invalid',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({
        error: 'Langfuse rejected these keys. Check the destination and keys',
      });
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
      expect(deps.recordConnectionUpdate).not.toHaveBeenCalled();
    });

    it('rejects credentials when Langfuse does not return a stable project identity', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ data: [] }),
      }) as unknown as typeof fetch;
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-lf-1',
            secretKey: 'sk-lf-secret',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ error: 'Langfuse did not return a project identity' });
      expect(global.fetch).toHaveBeenCalledTimes(1);
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it('does not re-verify a pure enable or disable update', async () => {
      const stored = {
        enabled: false,
        destination: 'eu',
        publicKey: 'pk-lf-1',
        secretKey: encryptV3('sk-lf-secret'),
        projectId: 'project-1',
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(stored)),
      });
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({ body: { enabled: true, destination: 'eu', publicKey: 'pk-lf-1' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(deps.patchConfigFields).toHaveBeenCalledTimes(1);
      expect(deps.patchConfigFields.mock.calls[0][3]['langfuse.enabled']).toBe(true);
      expect(deps.patchConfigFields.mock.calls[0][3]['langfuse.projectId']).toBe('project-1');
      expect(deps.recordConnectionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenant_id: 't1',
          change: 'enabled',
          changes: ['enabled'],
          verification_result: 'skipped',
        }),
      );
    });

    it('allows an existing connection to be disabled after its destination is removed', async () => {
      const stored = {
        enabled: true,
        destination: 'removed-destination',
        publicKey: 'pk-lf-1',
        secretKey: encryptV3('sk-lf-secret'),
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(stored)),
      });
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: false,
            destination: 'removed-destination',
            publicKey: 'pk-lf-1',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(global.fetch).not.toHaveBeenCalled();
      expect(deps.patchConfigFields).toHaveBeenCalledTimes(1);
      expect(deps.patchConfigFields.mock.calls[0][3]).toMatchObject({
        'langfuse.enabled': false,
        'langfuse.destination': 'removed-destination',
        'langfuse.publicKey': 'pk-lf-1',
      });
    });

    it('reactivates an inactive base config updated by the field patch', async () => {
      const inactiveUpdated = {
        ...baseConfigDoc({
          enabled: true,
          destination: 'eu',
          publicKey: 'pk-lf-1',
          secretKey: encryptV3('sk-lf-secret'),
        }),
        isActive: false,
      };
      const activeUpdated = { ...inactiveUpdated, isActive: true };
      const inactiveExisting = {
        ...inactiveUpdated,
        priority: 42,
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(inactiveExisting),
        patchConfigFields: jest.fn().mockResolvedValue(inactiveUpdated),
        toggleConfigActive: jest.fn().mockResolvedValue(activeUpdated),
      });
      const res = mockRes();

      await handlers.updateConnection(
        mockReq({
          body: {
            enabled: true,
            destination: 'eu',
            publicKey: 'pk-lf-1',
            secretKey: 'sk-lf-secret',
          },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(deps.findConfigByPrincipal).toHaveBeenCalledWith('role', '__base__', {
        includeInactive: true,
      });
      expect(deps.patchConfigFields.mock.calls[0][4]).toBe(42);
      expect(deps.toggleConfigActive).toHaveBeenCalledWith('role', '__base__', true);
      expect(res.body).toMatchObject({ configured: true, enabled: true });
    });
  });

  describe('testConnection', () => {
    it('requires destination and publicKey', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.testConnection(mockReq({ body: { destination: 'eu' } }), res);
      expect(res.statusCode).toBe(400);
    });

    it('rejects an unknown destination', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.testConnection(
        mockReq({ body: { destination: 'mars', publicKey: 'pk', secretKey: 'sk' } }),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it('rejects encrypted secret values from clients', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();
      await handlers.testConnection(
        mockReq({ body: { destination: 'eu', publicKey: 'pk', secretKey: encryptV3('sk') } }),
        res,
      );
      expect(res.statusCode).toBe(400);
    });

    it('returns success when Langfuse responds ok', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
        }),
        res,
      );

      expect(res.body).toEqual({ success: true });
      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toBe('https://cloud.langfuse.com/api/public/projects');
      expect(init.headers.Authorization).toMatch(/^Basic /);
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const [publicUrl, publicInit] = (global.fetch as unknown as jest.Mock).mock.calls[1];
      expect(publicUrl).toBe('https://cloud.langfuse.com/api/public/ingestion');
      expect(publicInit.method).toBe('POST');
      expect(publicInit.headers.Authorization).toBe('Bearer pk');
      expect(publicInit.headers['X-Langfuse-Public-Key']).toBe('pk');
      expect(publicInit.headers['Content-Type']).toBe('application/json');
      expect(JSON.parse(publicInit.body)).toEqual({ batch: [] });
      expect(publicInit.signal).toBe(init.signal);
    });

    it('returns a timeout failure when Langfuse verification exceeds its deadline', async () => {
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockRejectedValueOnce(timeoutError) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
        }),
        res,
      );

      expect(res.body).toEqual({
        success: false,
        errorCode: 'timeout',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('rejects an invalid public key even when the secret key is valid', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: false, status: 401 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk-invalid', secretKey: 'sk-valid' },
        }),
        res,
      );

      expect(res.body).toEqual({
        success: false,
        errorCode: 'invalid_credentials',
      });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('returns a key-specific failure when Langfuse rejects the credentials', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 401 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
        }),
        res,
      );

      expect(res.body).toEqual({
        success: false,
        errorCode: 'invalid_credentials',
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    it('returns an incident-oriented failure when Langfuse returns a server error', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
        }),
        res,
      );

      expect(res.body).toEqual({
        success: false,
        errorCode: 'server_error',
      });
    });

    it.each([
      [403, 'access_denied'],
      [429, 'rate_limited'],
      [400, 'unexpected_response'],
    ])('maps Langfuse status %i to %s', async (status, errorCode) => {
      global.fetch = jest.fn().mockResolvedValue({ ok: false, status }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
        }),
        res,
      );

      expect(res.body).toEqual({ success: false, errorCode });
    });

    it('falls back to the stored secret only for the unchanged connection', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(
          baseConfigDoc({
            destination: 'eu',
            publicKey: 'pk',
            secretKey: encryptV3('sk-stored'),
          }),
        ),
      });
      const res = mockRes();

      await handlers.testConnection(mockReq({ body: { destination: 'eu', publicKey: 'pk' } }), res);

      expect(res.body).toEqual({ success: true });
      const [, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      const decoded = Buffer.from(
        init.headers.Authorization.replace('Basic ', ''),
        'base64',
      ).toString();
      expect(decoded).toBe('pk:sk-stored');
    });

    it('does not reuse the stored secret for a changed connection test', async () => {
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(
          baseConfigDoc({
            destination: 'eu',
            publicKey: 'pk-old',
            secretKey: encryptV3('sk-stored'),
          }),
        ),
      });
      const res = mockRes();

      await handlers.testConnection(
        mockReq({ body: { destination: 'us', publicKey: 'pk-new' } }),
        res,
      );

      expect(res.body).toEqual({ success: false, errorCode: 'missing_secret' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('sends the deployment headers on both verification requests', async () => {
      /** Single-tenant topology with one configured Langfuse origin — the
       *  self-hosted-behind-a-proxy case — so the header map is unambiguous. */
      delete process.env.TENANT_ISOLATION_STRICT;
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
      process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL = 'https://eu.langfuse.internal';
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
          config: { langfuse: { headers: { 'CF-Access-Client-Id': 'proxy-client' } } },
        }),
        res,
      );

      expect(res.body).toEqual({ success: true });
      const [, projectsInit] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(projectsInit.headers['CF-Access-Client-Id']).toBe('proxy-client');
      expect(projectsInit.headers.Authorization).toMatch(/^Basic /);
      const [, ingestionInit] = (global.fetch as unknown as jest.Mock).mock.calls[1];
      expect(ingestionInit.headers['CF-Access-Client-Id']).toBe('proxy-client');
      expect(ingestionInit.headers.Authorization).toBe('Bearer pk');
      delete process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL;
    });

    it('withholds deployment headers when several Langfuse origins are configured', async () => {
      /** The collector from `beforeEach` plus an explicit tenant URL: the map
       *  does not say which of them it authenticates to, so neither gets it. */
      process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL = 'https://eu.langfuse.internal';
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
          config: { langfuse: { headers: { 'CF-Access-Client-Id': 'ambiguous-token' } } },
        }),
        res,
      );

      expect(JSON.stringify((global.fetch as unknown as jest.Mock).mock.calls)).not.toContain(
        'ambiguous-token',
      );
      delete process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL;
    });

    it('withholds deployment headers when verifying an unconfigured destination', async () => {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce(projectResponse())
        .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.testConnection(
        mockReq({
          body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
          config: { langfuse: { headers: { 'CF-Access-Client-Id': 'internal-gateway' } } },
        }),
        res,
      );

      /** `eu` here is the built-in Langfuse Cloud default; an admin selecting it
       *  must not ship the internal gateway credential to that origin. */
      const calls = (global.fetch as unknown as jest.Mock).mock.calls;
      expect(JSON.stringify(calls)).not.toContain('internal-gateway');
    });

    it.each(['Authorization', 'authorization'])(
      'keeps the Langfuse authorization when a deployment %s header collides',
      async (headerName) => {
        global.fetch = jest
          .fn()
          .mockResolvedValueOnce(projectResponse())
          .mockResolvedValueOnce({ ok: true, status: 207 }) as unknown as typeof fetch;
        const { handlers } = createHandlers();
        const res = mockRes();

        delete process.env.TENANT_ISOLATION_STRICT;
        delete process.env.LANGFUSE_FANOUT_ENABLED;
        delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
        process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL = 'https://eu.langfuse.internal';
        await handlers.testConnection(
          mockReq({
            body: { destination: 'eu', publicKey: 'pk', secretKey: 'sk' },
            config: { langfuse: { headers: { [headerName]: 'Bearer proxy-token' } } },
          }),
          res,
        );
        delete process.env.LANGFUSE_FANOUT_TENANT_EU_BASE_URL;

        const [, projectsInit] = (global.fetch as unknown as jest.Mock).mock.calls[0];
        const headers = projectsInit.headers as Record<string, string>;
        /** A surviving case variant would be appended by fetch rather than
         *  replaced, sending both credentials in one combined value. */
        expect(
          Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization'),
        ).toHaveLength(1);
        expect(Object.values(headers)).not.toContain('Bearer proxy-token');
        expect(Object.values(headers).some((value) => value.startsWith('Basic '))).toBe(true);
      },
    );
  });

  describe('buildStatus promptSync', () => {
    it.each([
      [false, undefined, { available: false, enabled: false }],
      [false, true, { available: false, enabled: false }],
      [true, undefined, { available: true, enabled: false }],
      [true, false, { available: true, enabled: false }],
      [true, true, { available: true, enabled: true }],
    ])('available=%s stored enabled=%s -> %j', async (available, storedEnabled, expected) => {
      if (available) {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      }
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest
          .fn()
          .mockResolvedValue(
            baseConfigDoc(
              tenantLangfuseConnection(
                storedEnabled === undefined ? {} : { promptSync: { enabled: storedEnabled } },
              ),
            ),
          ),
      });
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.body?.promptSync).toEqual(expected);
    });

    it('reports unavailable promptSync when no base config exists', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.getConnection(mockReq(), res);

      expect(res.body?.promptSync).toEqual({ available: false, enabled: false });
    });
  });

  describe('updatePromptSync', () => {
    it('returns 404 when prompt sync is not available', async () => {
      const { handlers, deps } = createHandlers();
      const res = mockRes();

      await handlers.updatePromptSync(mockReq({ body: { enabled: true } }), res);

      expect(res.statusCode).toBe(404);
      expect(deps.patchConfigFields).not.toHaveBeenCalled();
    });

    it.each([[{}], [{ enabled: 'true' }], [{ enabled: true, extra: 'nope' }], [{ enabled: null }]])(
      'rejects an invalid body %j with 400 invalid_request',
      async (body) => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        const { handlers, deps } = createHandlers();
        const res = mockRes();

        await handlers.updatePromptSync(mockReq({ body }), res);

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ code: 'invalid_request' });
        expect(deps.patchConfigFields).not.toHaveBeenCalled();
      },
    );

    it('saves only langfuse.promptSync.enabled and clears the config caches', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const stored = tenantLangfuseConnection();
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(stored)),
        // The shared `createHandlers` default replaces the whole document from
        // the patched fields alone, which is accurate only when a caller patches
        // every connection field at once (as `updateConnection` always does).
        // This handler patches a single nested field, so the double here merges
        // onto the existing document the way the real patch does.
        patchConfigFields: jest
          .fn()
          .mockImplementation((_pt, _pid, _pm, fields: Record<string, unknown>) =>
            Promise.resolve(
              baseConfigDoc({
                ...stored,
                promptSync: { enabled: fields['langfuse.promptSync.enabled'] },
              }),
            ),
          ),
      });
      const res = mockRes();

      await handlers.updatePromptSync(mockReq({ body: { enabled: true } }), res);

      expect(res.statusCode).toBe(200);
      expect(deps.patchConfigFields).toHaveBeenCalledTimes(1);
      expect(deps.patchConfigFields.mock.calls[0].slice(0, 3)).toEqual([
        'role',
        '__base__',
        'Role',
      ]);
      expect(deps.patchConfigFields.mock.calls[0][3]).toEqual({
        'langfuse.promptSync.enabled': true,
      });
      expect(deps.invalidateConfigCaches).toHaveBeenCalledWith('t1');
      expect(res.body).toMatchObject({ promptSync: { available: true, enabled: true } });
    });

    it('keeps an inactive base config inactive, preserves its priority, and reports what GET /connection would report', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const stored = tenantLangfuseConnection({ promptSync: { enabled: false } });
      const inactiveExisting = { ...baseConfigDoc(stored), isActive: false, priority: 50 };
      const inactiveUpdated = {
        ...baseConfigDoc({ ...stored, promptSync: { enabled: true } }),
        isActive: false,
        priority: 50,
      };
      const { handlers, deps } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(inactiveExisting),
        patchConfigFields: jest.fn().mockResolvedValue(inactiveUpdated),
      });
      const res = mockRes();

      await handlers.updatePromptSync(mockReq({ body: { enabled: true } }), res);

      expect(deps.findConfigByPrincipal).toHaveBeenCalledWith('role', '__base__', {
        includeInactive: true,
      });
      expect(deps.patchConfigFields.mock.calls[0][4]).toBe(50);
      expect(deps.toggleConfigActive).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(200);

      const { handlers: getConnectionHandlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(null),
      });
      const getConnectionRes = mockRes();
      await getConnectionHandlers.getConnection(mockReq(), getConnectionRes);

      expect(res.body).toEqual(getConnectionRes.body);
    });

    it('returns the fresh connection status shape, same as GET /connection', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const stored = tenantLangfuseConnection();
      const { handlers } = createHandlers({
        findConfigByPrincipal: jest.fn().mockResolvedValue(baseConfigDoc(stored)),
        patchConfigFields: jest
          .fn()
          .mockImplementation((_pt, _pid, _pm, fields: Record<string, unknown>) =>
            Promise.resolve(
              baseConfigDoc({
                ...stored,
                promptSync: { enabled: fields['langfuse.promptSync.enabled'] },
              }),
            ),
          ),
      });
      const res = mockRes();

      await handlers.updatePromptSync(mockReq({ body: { enabled: false } }), res);

      expect(res.body).toMatchObject({
        configured: true,
        destination: 'eu',
        publicKey: 'pk-lf-1',
        promptSync: { available: true, enabled: false },
      });
      expect(res.body?.secretKey).toBeUndefined();
    });
  });

  describe('listPrompts', () => {
    it('returns 404 when prompt sync is not available at all', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.listPrompts(mockReq(), res);

      expect(res.statusCode).toBe(404);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 404 when available but the tenant switch is off', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const { handlers } = createPromptSyncHandlers(false);
      const res = mockRes();

      await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(false) } }), res);

      expect(res.statusCode).toBe(404);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 409 not_configured when both switches are on but no connection resolves', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({ config: { langfuse: { promptSync: { enabled: true } } } }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ code: 'not_configured' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 200 with the list when both switches are on and the connection is valid', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

      expect(res.statusCode).toBe(200);
      const items = res.body?.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[1]).toMatchObject({ name: 'support-chat', type: 'chat' });
      expect(res.body?.meta).toEqual({ page: 1, limit: 10, totalItems: 2, totalPages: 1 });
    });

    it('passes the query params through to Langfuse and never sends filter', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({
          config: { langfuse: withPromptSync(true) },
          query: { name: 'greeting', label: 'production', tag: 'demo', page: '2', limit: '5' },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [url] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('name=greeting');
      expect(url).toContain('label=production');
      expect(url).toContain('tag=demo');
      expect(url).toContain('page=2');
      expect(url).toContain('limit=5');
      expect(url).not.toContain('filter');
    });

    it.each([
      [{ page: '0' }],
      [{ page: 'abc' }],
      [{ limit: '0' }],
      [{ limit: '101' }],
      [{ name: '' }],
      [{ name: 'x'.repeat(257) }],
      [{ fromUpdatedAt: 'not-a-date' }],
    ])('rejects an invalid query %j with 400 invalid_request', async (query) => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({ config: { langfuse: withPromptSync(true) }, query }),
        res,
      );

      expect(res.statusCode).toBe(400);
      expect(res.body).toEqual({ code: 'invalid_request' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it.each([
      [401, 'unauthorized', 502],
      [403, 'unauthorized', 502],
      [500, 'upstream', 502],
      [503, 'upstream', 502],
    ])(
      'maps a Langfuse %i response to %s with status %i',
      async (upstreamStatus, code, httpStatus) => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        global.fetch = jest
          .fn()
          .mockResolvedValue(
            fetchJsonResponse({ message: 'MARKER_SECRET_LEAK_TOKEN' }, upstreamStatus),
          ) as unknown as typeof fetch;
        const { handlers } = createPromptSyncHandlers(true);
        const res = mockRes();

        await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

        expect(res.statusCode).toBe(httpStatus);
        expect(res.body?.code).toBe(code);
        if (code === 'upstream') {
          expect(res.body?.status).toBe(upstreamStatus);
        } else {
          expect(res.body?.status).toBeUndefined();
        }
        expect(JSON.stringify(res.body)).not.toContain('MARKER_SECRET_LEAK_TOKEN');
        expect(JSON.stringify(res.body)).not.toContain('pk-lf-1');
      },
    );

    it('maps a Langfuse timeout to 504 timeout', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const timeoutError = new Error('The operation was aborted due to timeout');
      timeoutError.name = 'TimeoutError';
      global.fetch = jest.fn().mockRejectedValue(timeoutError) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

      expect(res.statusCode).toBe(504);
      expect(res.body).toEqual({ code: 'timeout' });
    });

    it('maps an invalid Langfuse response body to 502 invalid_response', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse({ data: 'not-an-array' })) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ code: 'invalid_response' });
    });

    /**
     * Every real fetch failure is already wrapped as a `LangfusePromptRequestError`
     * by `prompts.ts`, so a plain `Error` can only reach the handler's catch-all
     * through a defensive, not-normally-reachable path. Spying on the live
     * binding is the only way to exercise that branch.
     */
    it('maps an unexpected thrown error to a generic 500 without leaking its message', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      jest
        .spyOn(promptsModule, 'listLangfusePrompts')
        .mockRejectedValueOnce(new Error('MARKER_SECRET_LEAK_TOKEN'));
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

      expect(res.statusCode).toBe(500);
      expect(res.body).toEqual({ code: 'upstream' });
      expect(JSON.stringify(res.body)).not.toContain('MARKER_SECRET_LEAK_TOKEN');
    });

    describe('tenant-switch gate reads the stored base config, not req.config', () => {
      it('returns 404 when req.config says enabled but the stored base config says disabled', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        const { handlers } = createPromptSyncHandlers(false);
        const res = mockRes();

        await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(true) } }), res);

        expect(res.statusCode).toBe(404);
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('is allowed when req.config says disabled but the stored base config says enabled', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        global.fetch = jest
          .fn()
          .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
        const { handlers } = createPromptSyncHandlers(true);
        const res = mockRes();

        await handlers.listPrompts(mockReq({ config: { langfuse: withPromptSync(false) } }), res);

        expect(res.statusCode).toBe(200);
      });

      it('fetches with the stored destination and credentials, never a stale req.config connection', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        global.fetch = jest
          .fn()
          .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
        const findConfigByPrincipal = jest.fn().mockResolvedValue(
          baseConfigDoc(
            withPromptSync(true, {
              destination: 'us',
              publicKey: 'pk-lf-new',
              secretKey: encryptV3('sk-lf-new'),
            }),
          ),
        );
        const { handlers, deps } = createHandlers({ findConfigByPrincipal });
        const res = mockRes();

        await handlers.listPrompts(
          mockReq({
            config: {
              langfuse: withPromptSync(true, {
                destination: 'eu',
                publicKey: 'pk-lf-old',
                secretKey: encryptV3('sk-lf-old'),
              }),
            },
          }),
          res,
        );

        expect(res.statusCode).toBe(200);
        const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
        expect(url).toContain('https://us.cloud.langfuse.com');
        expect(
          Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
        ).toBe('pk-lf-new:sk-lf-new');
        expect(deps.findConfigByPrincipal).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('getPrompt', () => {
    it('returns 404 when prompt sync is not available at all', async () => {
      const { handlers } = createHandlers();
      const res = mockRes();

      await handlers.getPrompt(mockReq({ params: { name: 'greeting' } }), res);

      expect(res.statusCode).toBe(404);
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('returns 404 when available but the tenant switch is off', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const { handlers } = createPromptSyncHandlers(false);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(false) }, params: { name: 'greeting' } }),
        res,
      );

      expect(res.statusCode).toBe(404);
    });

    it('returns 409 not_configured when both switches are on but no connection resolves', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({
          config: { langfuse: { promptSync: { enabled: true } } },
          params: { name: 'greeting' },
        }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ code: 'not_configured' });
    });

    it.each([[{ name: '' }], [{ name: 'x'.repeat(257) }]])(
      'rejects an invalid name %j with 400 invalid_request',
      async (params) => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        const { handlers } = createPromptSyncHandlers(true);
        const res = mockRes();

        await handlers.getPrompt(
          mockReq({ config: { langfuse: withPromptSync(true) }, params }),
          res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ code: 'invalid_request' });
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it.each([[{ version: '0' }], [{ version: '-1' }], [{ version: 'abc' }]])(
      'rejects an invalid version query %j with 400 invalid_request',
      async (query) => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        const { handlers } = createPromptSyncHandlers(true);
        const res = mockRes();

        await handlers.getPrompt(
          mockReq({
            config: { langfuse: withPromptSync(true) },
            params: { name: 'greeting' },
            query,
          }),
          res,
        );

        expect(res.statusCode).toBe(400);
        expect(res.body).toEqual({ code: 'invalid_request' });
        expect(global.fetch).not.toHaveBeenCalled();
      },
    );

    it('gets by the production label when no version is given', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest.fn().mockResolvedValue(
        fetchJsonResponse({
          name: 'greeting',
          version: 3,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'greeting' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        name: 'greeting',
        version: 3,
        labels: ['production'],
        prompt: 'Hello {{name}}',
      });
      const [url] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('label=production');
      expect(url).not.toContain('version=');
    });

    it('gets by an exact version when one is given', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest.fn().mockResolvedValue(
        fetchJsonResponse({
          name: 'greeting',
          version: 2,
          type: 'text',
          labels: [],
          prompt: 'Hi there',
        }),
      ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({
          config: { langfuse: withPromptSync(true) },
          params: { name: 'greeting' },
          query: { version: '2' },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({ name: 'greeting', version: 2, labels: [], prompt: 'Hi there' });
      const [url] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('version=2');
    });

    it('gets a prompt whose name contains a path separator', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest.fn().mockResolvedValue(
        fetchJsonResponse({
          name: 'folder/name',
          version: 1,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'folder/name' } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      expect(res.body).toEqual({
        name: 'folder/name',
        version: 1,
        labels: ['production'],
        prompt: 'Hello {{name}}',
      });
      const [url] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('/prompts/folder%2Fname');
    });

    it('maps a 404 from Langfuse to not_found', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse(null, 404)) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'missing' } }),
        res,
      );

      expect(res.statusCode).toBe(404);
      expect(res.body).toEqual({ code: 'not_found' });
    });

    it('maps a chat prompt to 422 unsupported_type without its content', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest.fn().mockResolvedValue(
        fetchJsonResponse({
          name: 'support-chat',
          version: 1,
          type: 'chat',
          labels: ['production'],
          prompt: [{ role: 'system', content: 'secret system content' }],
        }),
      ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'support-chat' } }),
        res,
      );

      expect(res.statusCode).toBe(422);
      expect(res.body).toEqual({ code: 'unsupported_type' });
      expect(JSON.stringify(res.body)).not.toContain('secret system content');
    });

    it('maps an upstream failure the same way as listPrompts', async () => {
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      global.fetch = jest
        .fn()
        .mockResolvedValue(
          fetchJsonResponse({ message: 'MARKER_SECRET_LEAK_TOKEN' }, 500),
        ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'greeting' } }),
        res,
      );

      expect(res.statusCode).toBe(502);
      expect(res.body).toEqual({ code: 'upstream', status: 500 });
      expect(JSON.stringify(res.body)).not.toContain('MARKER_SECRET_LEAK_TOKEN');
    });

    describe('tenant-switch gate reads the stored base config, not req.config', () => {
      it('returns 404 when req.config says enabled but the stored base config says disabled', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        const { handlers } = createPromptSyncHandlers(false);
        const res = mockRes();

        await handlers.getPrompt(
          mockReq({ config: { langfuse: withPromptSync(true) }, params: { name: 'greeting' } }),
          res,
        );

        expect(res.statusCode).toBe(404);
        expect(global.fetch).not.toHaveBeenCalled();
      });

      it('is allowed when req.config says disabled but the stored base config says enabled', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        global.fetch = jest.fn().mockResolvedValue(
          fetchJsonResponse({
            name: 'greeting',
            version: 3,
            type: 'text',
            labels: ['production'],
            prompt: 'Hello {{name}}',
          }),
        ) as unknown as typeof fetch;
        const { handlers } = createPromptSyncHandlers(true);
        const res = mockRes();

        await handlers.getPrompt(
          mockReq({ config: { langfuse: withPromptSync(false) }, params: { name: 'greeting' } }),
          res,
        );

        expect(res.statusCode).toBe(200);
      });

      it('fetches with the stored destination and credentials, never a stale req.config connection', async () => {
        process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
        global.fetch = jest.fn().mockResolvedValue(
          fetchJsonResponse({
            name: 'greeting',
            version: 3,
            type: 'text',
            labels: ['production'],
            prompt: 'Hello {{name}}',
          }),
        ) as unknown as typeof fetch;
        const findConfigByPrincipal = jest.fn().mockResolvedValue(
          baseConfigDoc(
            withPromptSync(true, {
              destination: 'us',
              publicKey: 'pk-lf-new',
              secretKey: encryptV3('sk-lf-new'),
            }),
          ),
        );
        const { handlers, deps } = createHandlers({ findConfigByPrincipal });
        const res = mockRes();

        await handlers.getPrompt(
          mockReq({
            config: {
              langfuse: withPromptSync(true, {
                destination: 'eu',
                publicKey: 'pk-lf-old',
                secretKey: encryptV3('sk-lf-old'),
              }),
            },
            params: { name: 'greeting' },
          }),
          res,
        );

        expect(res.statusCode).toBe(200);
        const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
        expect(url).toContain('https://us.cloud.langfuse.com');
        expect(
          Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
        ).toBe('pk-lf-new:sk-lf-new');
        expect(deps.findConfigByPrincipal).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe('listPrompts and getPrompt never use the central env project for a tenant', () => {
    /** Strict isolation and fanout off, with central env keys configured — the
     *  single-tenant topology where a tenant admin could otherwise read the
     *  operator's central prompts. */
    function setUpSingleTenantWithEnvKeys() {
      delete process.env.TENANT_ISOLATION_STRICT;
      delete process.env.LANGFUSE_FANOUT_ENABLED;
      delete process.env.LANGFUSE_FANOUT_COLLECTOR_URL;
      process.env.LANGFUSE_PROMPT_SYNC_AVAILABLE = 'true';
      process.env.LANGFUSE_PUBLIC_KEY = 'env-public';
      process.env.LANGFUSE_SECRET_KEY = 'env-secret';
    }

    it('listPrompts fetches from the tenant destination with the tenant Basic auth, never the env keys', async () => {
      setUpSingleTenantWithEnvKeys();
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({ config: { langfuse: withPromptSync(true, { destination: 'us' }) } }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('https://us.cloud.langfuse.com');
      expect(
        Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
      ).toBe('pk-lf-1:sk-lf-secret');
    });

    it('getPrompt fetches from the tenant destination with the tenant Basic auth, never the env keys', async () => {
      setUpSingleTenantWithEnvKeys();
      global.fetch = jest.fn().mockResolvedValue(
        fetchJsonResponse({
          name: 'greeting',
          version: 3,
          type: 'text',
          labels: ['production'],
          prompt: 'Hello {{name}}',
        }),
      ) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.getPrompt(
        mockReq({
          config: { langfuse: withPromptSync(true, { destination: 'us' }) },
          params: { name: 'greeting' },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toContain('https://us.cloud.langfuse.com');
      expect(
        Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
      ).toBe('pk-lf-1:sk-lf-secret');
    });

    it('returns 409 not_configured for a tenant user with no stored connection, even though env keys are set', async () => {
      setUpSingleTenantWithEnvKeys();
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({ config: { langfuse: { promptSync: { enabled: true } } } }),
        res,
      );

      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ code: 'not_configured' });
      expect(global.fetch).not.toHaveBeenCalled();
    });

    it('uses the env keys for a request without a tenantId in that same single-tenant setup', async () => {
      setUpSingleTenantWithEnvKeys();
      global.fetch = jest
        .fn()
        .mockResolvedValue(fetchJsonResponse(promptListBody())) as unknown as typeof fetch;
      const { handlers } = createPromptSyncHandlers(true);
      const res = mockRes();

      await handlers.listPrompts(
        mockReq({
          user: { id: 'u1', role: 'ADMIN' },
          config: { langfuse: { promptSync: { enabled: true } } },
        }),
        res,
      );

      expect(res.statusCode).toBe(200);
      const [url, init] = (global.fetch as unknown as jest.Mock).mock.calls[0];
      expect(url).toBe('https://cloud.langfuse.com/api/public/v2/prompts');
      expect(
        Buffer.from(init.headers.Authorization.replace('Basic ', ''), 'base64').toString(),
      ).toBe('env-public:env-secret');
    });
  });
});
