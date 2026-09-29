process.env.CREDS_KEY =
  process.env.CREDS_KEY ?? '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

import type { Response } from 'express';
import type { ServerRequest } from '~/types/http';

// Loaded via dynamic import in beforeAll so the crypto module initializes
// after CREDS_KEY is set above (encryptV3 reads the key at module load).
let encryptV3: typeof import('@librechat/data-schemas').encryptV3;
let createAdminLangfuseHandlers: typeof import('./langfuse').createAdminLangfuseHandlers;
let getLangfuseDestinationId: typeof import('../langfuse/destinations').getLangfuseDestinationId;
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
  global.fetch = realFetch;
});

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
});
