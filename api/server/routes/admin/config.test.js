const express = require('express');
const request = require('supertest');
const mongoSanitize = require('express-mongo-sanitize');
const { createRequestSanitizer } = require('@librechat/api');

let hasAdminAccess;
/** Whether the deployment asks for terms acceptance, which the signed-in admin has not given. */
let mockTermsRequired = false;
/** Authenticates, then runs the real terms gate, as `requireJwtAuth` chains it. */
const mockRequireJwtAuth = jest.fn((req, res, next) => {
  if (req.headers.authorization !== 'Bearer admin') {
    return res.status(401).json({ message: 'Unauthorized' });
  }
  req.user = { id: 'user-1', _id: 'user-1', role: 'ADMIN', termsAccepted: !mockTermsRequired };
  const { createTermsAcceptanceGate } = require('@librechat/api');
  const gate = createTermsAcceptanceGate({
    getAppConfig: async () => ({
      interfaceConfig: { termsOfService: { modalAcceptance: mockTermsRequired } },
    }),
  });
  return gate(req, res, next);
});
const mockRequireCapability = jest.fn(() => (_req, res, next) => {
  if (!hasAdminAccess) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
});
const mockDb = {
  listAllConfigs: jest.fn(),
  findConfigByPrincipal: jest.fn(),
  writeConfigDocument: jest.fn(),
  unsetConfigField: jest.fn(),
  deleteConfig: jest.fn(),
  toggleConfigActiveTracked: jest.fn(),
  recordAuditEntry: jest.fn(),
  principalExists: jest.fn(async () => true),
  findPrincipalUser: jest.fn(async () => null),
  getUserPrincipals: jest.fn(async () => []),
  getApplicableConfigs: jest.fn(async () => []),
};

jest.mock('~/server/middleware', () => ({ requireJwtAuth: mockRequireJwtAuth }));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: mockRequireCapability,
  hasCapability: jest.fn(async () => true),
  hasConfigCapability: jest.fn(async () => true),
  hasAnyConfigReadAccess: jest.fn(async () => true),
  getReadableConfigSections: jest.fn(async () => ({ broad: true, sections: new Set() })),
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async () => ({ config: {} })),
  resolveConfigLayers: jest.fn(async () => ({ yaml: {}, merged: {}, resolved: {}, layers: [] })),
  getEndpointsConfig: jest.fn(async () => ({})),
  loadDefaultModels: jest.fn(async () => ({})),
  loadConfigModels: jest.fn(async () => ({})),
  getCachedTools: jest.fn(async () => ({})),
  overrideCacheTtl: 15_000,
  invalidateConfigCaches: jest.fn(async () => undefined),
  reloadConfigCaches: jest.fn(async () => ({ cleared: true, broadcast: 'sent' })),
}));

jest.mock('~/app/clients/tools', () => ({ availableTools: [], toolkits: [] }));

jest.mock('~/models', () => mockDb);

/** The app-level order of `api/server/index.js`: body parsing, writable query, sanitizer, router. */
function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'query', {
      ...Object.getOwnPropertyDescriptor(req, 'query'),
      value: req.query,
      writable: true,
    });
    next();
  });
  app.use(createRequestSanitizer(mongoSanitize));
  app.use('/api/admin/config', require('./config'));
  return app;
}

const PROFILE = 'us.anthropic.claude-sonnet-4-6';
const ARN =
  'arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6';

describe('admin config routes', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  beforeEach(() => {
    hasAdminAccess = true;
    mockTermsRequired = false;
    mockDb.listAllConfigs.mockResolvedValue([]);
    mockDb.findConfigByPrincipal.mockResolvedValue(null);
    mockDb.writeConfigDocument.mockImplementation(async (principalType, principalId, draft) => ({
      _id: 'c1',
      principalType,
      principalId,
      configVersion: 1,
      ...draft,
    }));
  });

  const unsafeBody = {
    entries: [{ fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { $where: 'sleep(1)' } }],
  };

  it('answers 401 before the key guard for an unauthenticated `$` key', async () => {
    const response = await request(app)
      .patch('/api/admin/config/role/USER/fields')
      .send(unsafeBody)
      .expect(401);

    expect(response.body).toEqual({ message: 'Unauthorized' });
    expect(mockDb.writeConfigDocument).not.toHaveBeenCalled();
  });

  it('answers 403 before the key guard without admin access', async () => {
    hasAdminAccess = false;

    await request(app)
      .patch('/api/admin/config/role/USER/fields')
      .set('authorization', 'Bearer admin')
      .send(unsafeBody)
      .expect(403);

    expect(mockDb.writeConfigDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['a `$` operator key', unsafeBody],
    ['a `__proto__` key', JSON.parse('{"overrides":{"registration":{"__proto__":{"x":1}}}}')],
  ])('answers 400 CONFIG_UNSAFE_KEY for %s after auth', async (_label, body) => {
    const response = await request(app)
      .put('/api/admin/config/role/USER')
      .set('authorization', 'Bearer admin')
      .send(body)
      .expect(400);

    expect(response.body.code).toBe('CONFIG_UNSAFE_KEY');
    expect(JSON.stringify(response.body)).not.toMatch(/\$where|__proto__/);
    expect(mockDb.writeConfigDocument).not.toHaveBeenCalled();
  });

  it('delivers dotted record keys to the write method intact', async () => {
    const response = await request(app)
      .patch('/api/admin/config/role/USER/fields')
      .set('authorization', 'Bearer admin')
      .send({
        entries: [{ fieldPath: 'endpoints.bedrock.inferenceProfiles', value: { [PROFILE]: ARN } }],
      })
      .expect(200);

    expect(mockDb.writeConfigDocument).toHaveBeenCalledWith(
      'role',
      'USER',
      expect.objectContaining({
        overrides: { endpoints: { bedrock: { inferenceProfiles: { [PROFILE]: ARN } } } },
      }),
      'absent',
    );
    expect(response.body.config.overrides.endpoints.bedrock.inferenceProfiles).toEqual({
      [PROFILE]: ARN,
    });
  });

  it('takes config writes from an admin who has not accepted the terms, unlike other routes', async () => {
    mockTermsRequired = true;
    const gated = express();
    gated.use(express.json());
    gated.post('/api/agents/chat', mockRequireJwtAuth, (_req, res) => res.json({ ok: true }));

    const chat = await request(gated)
      .post('/api/agents/chat')
      .set('authorization', 'Bearer admin')
      .send({})
      .expect(403);
    expect(chat.body.code).toBe('terms_not_accepted');

    const response = await request(app)
      .patch('/api/admin/config/role/__base__/fields')
      .set('authorization', 'Bearer admin')
      .send({
        entries: [{ fieldPath: 'interface.termsOfService.modalAcceptance', value: false }],
      })
      .expect(200);
    expect(response.body.applied).toEqual([
      {
        path: 'interface.termsOfService.modalAcceptance',
        segments: ['interface', 'termsOfService', 'modalAcceptance'],
      },
    ]);
    expect(mockDb.writeConfigDocument).toHaveBeenCalledTimes(1);
  });

  it('serves the config contract behind the same auth', async () => {
    await request(app).get('/api/admin/config/meta').expect(401);

    const response = await request(app)
      .get('/api/admin/config/meta')
      .set('authorization', 'Bearer admin')
      .expect(200);

    expect(response.body.metaVersion).toBe(1);
    expect(response.body.features.dottedKeys).toBe(true);
    expect(response.body.limits).toEqual({
      maxPatchEntries: 100,
      maxChangeOps: 1000,
      maxEntryKeyLength: 256,
      overrideCacheTtlMs: 15_000,
      catalogModelsTtlMs: 120_000,
    });
  });

  it.each([
    '/api/admin/config/catalog',
    '/api/admin/config/env-status',
    '/api/admin/config/resolved/role/USER',
    '/api/admin/config/effective?userId=0123456789abcdef01234567',
  ])('serves the read view %s behind the same auth', async (path) => {
    const anonymous = await request(app).get(path);
    hasAdminAccess = false;
    const withoutAccess = await request(app).get(path).set('authorization', 'Bearer admin');

    expect(anonymous.status).toBe(401);
    expect(withoutAccess.status).toBe(403);
  });

  it('serves the catalog to a client that sends no User-Agent', async () => {
    const response = await request(app)
      .get('/api/admin/config/catalog?principalType=role&principalId=USER')
      .set('authorization', 'Bearer admin')
      .unset('User-Agent')
      .expect(200);

    expect(response.body).toMatchObject({ principalType: 'role', principalId: 'USER' });
    expect(response.body.endpoints).toBeDefined();
  });

  it('routes the resolved, effective and env status views to their handlers', async () => {
    const auth = (path) => request(app).get(path).set('authorization', 'Bearer admin');

    const resolved = await auth('/api/admin/config/resolved/role/USER').expect(200);
    expect(resolved.body).toEqual({
      principalType: 'role',
      principalId: 'USER',
      yaml: {},
      layers: [],
      resolved: {},
    });

    const effective = await auth('/api/admin/config/effective?userId=0123456789abcdef01234567');
    expect(effective.status).toBe(404);
    expect(effective.body.code).toBe('USER_NOT_FOUND');

    const envStatus = await auth('/api/admin/config/env-status').expect(200);
    expect(envStatus.body.vars).toBeDefined();
  });

  it('reloads the config behind the same auth, through the Config service reload', async () => {
    const { reloadConfigCaches, invalidateConfigCaches } = require('~/server/services/Config');
    await request(app).post('/api/admin/config/reload').expect(401);
    hasAdminAccess = false;
    await request(app)
      .post('/api/admin/config/reload')
      .set('authorization', 'Bearer admin')
      .expect(403);
    expect(reloadConfigCaches).not.toHaveBeenCalled();

    hasAdminAccess = true;
    const response = await request(app)
      .post('/api/admin/config/reload')
      .set('authorization', 'Bearer admin')
      .expect(200);

    expect(response.body).toEqual({ success: true, broadcast: true });
    expect(reloadConfigCaches).toHaveBeenCalledTimes(1);
    expect(invalidateConfigCaches).not.toHaveBeenCalled();
    expect(mockDb.writeConfigDocument).not.toHaveBeenCalled();
    expect(mockDb.recordAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'config.reloaded' }),
    );
  });

  it('answers 503 when the Config service could not tell the other instances', async () => {
    const { reloadConfigCaches } = require('~/server/services/Config');
    reloadConfigCaches.mockResolvedValueOnce({ cleared: true, broadcast: 'failed' });

    const response = await request(app)
      .post('/api/admin/config/reload')
      .set('authorization', 'Bearer admin')
      .expect(503);

    expect(response.body).toEqual({
      error: expect.any(String),
      code: 'CONFIG_RELOAD_BROADCAST_FAILED',
    });
  });
});
