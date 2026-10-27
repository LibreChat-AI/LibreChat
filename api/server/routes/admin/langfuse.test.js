const express = require('express');
const request = require('supertest');

let deniedCapability;
let canManageLangfuse;
const middlewareCalls = [];
const mockHasConfigCapability = jest.fn(() => Promise.resolve(canManageLangfuse));
const mockRequireJwtAuth = jest.fn((req, _res, next) => {
  req.user = { id: 'user-1', role: 'DELEGATED_ADMIN', tenantId: 'tenant-a' };
  middlewareCalls.push('jwt');
  next();
});
const mockRequireCapability = jest.fn((capability) => (req, res, next) => {
  middlewareCalls.push(capability);
  if (deniedCapability === capability) {
    return res.status(403).json({ message: 'Forbidden' });
  }
  next();
});
const mockHandlers = {
  getConnection: jest.fn((_req, res) => res.status(200).json({ handler: 'get' })),
  getSessionLink: jest.fn((_req, res) => res.status(200).json({ handler: 'session' })),
  updateConnection: jest.fn((_req, res) => res.status(200).json({ handler: 'update' })),
  testConnection: jest.fn((_req, res) => res.status(200).json({ handler: 'test' })),
  updatePromptSync: jest.fn((_req, res) => res.status(200).json({ handler: 'prompt-sync' })),
  listPrompts: jest.fn((_req, res) => res.status(200).json({ handler: 'prompts' })),
  syncPrompts: jest.fn((_req, res) => res.status(200).json({ handler: 'sync' })),
  getPrompt: jest.fn((req, res) =>
    res.status(200).json({ handler: 'prompt', name: req.params.name }),
  ),
};
const mockSyncPromptCatalog = jest.fn();
const mockLogger = { warn: jest.fn(), error: jest.fn() };

jest.mock('@librechat/data-schemas', () => ({
  logger: mockLogger,
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin', MANAGE_PROMPTS: 'manage:prompts' },
}));

jest.mock('@librechat/api', () => ({
  createAdminLangfuseHandlers: jest.fn(() => mockHandlers),
}));

jest.mock('~/server/services/LangfusePromptSync', () => ({
  syncLangfusePromptCatalog: mockSyncPromptCatalog,
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: mockRequireCapability,
  hasConfigCapability: mockHasConfigCapability,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockRequireJwtAuth,
}));

jest.mock('~/server/services/Config', () => ({
  invalidateConfigCaches: jest.fn(),
}));

const mockConfigMiddleware = jest.fn((req, _res, next) => {
  middlewareCalls.push('config');
  req.config = { langfuse: { headers: { 'CF-Access-Client-Id': 'proxy-client' } } };
  next();
});

jest.mock(
  '~/server/middleware/config/app',
  () => (req, res, next) => mockConfigMiddleware(req, res, next),
);

jest.mock('~/models', () => ({
  findConfigByPrincipal: jest.fn(),
  patchConfigFields: jest.fn(),
  toggleConfigActive: jest.fn(),
  getMessages: jest.fn(),
}));

describe('admin Langfuse routes', () => {
  function createApp() {
    delete require.cache[require.resolve('./langfuse')];
    const router = require('./langfuse');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/langfuse', router);
    return app;
  }

  // The router module builds its handler dependencies once, at `require`
  // time, not per request. `createApp()` only reloads the module the first
  // time it runs in this file (later `beforeEach` clears already took effect
  // by the time any other test observes it), so this captures that one
  // load's dependency wiring before anything can clear it.
  let handlerDepsAtLoad;
  beforeAll(() => {
    createApp();
    const { createAdminLangfuseHandlers } = require('@librechat/api');
    handlerDepsAtLoad = createAdminLangfuseHandlers.mock.calls[0]?.[0];
  });

  beforeEach(() => {
    deniedCapability = undefined;
    canManageLangfuse = true;
    middlewareCalls.length = 0;
    jest.clearAllMocks();
  });

  it('requires admin access and Langfuse manage access for connection reads', async () => {
    const response = await request(createApp()).get('/api/admin/langfuse/connection').expect(200);

    expect(response.body).toEqual({ handler: 'get' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'config']);
    expect(mockHasConfigCapability).toHaveBeenCalledWith(
      {
        id: 'user-1',
        role: 'DELEGATED_ADMIN',
        tenantId: 'tenant-a',
        idOnTheSource: null,
      },
      'langfuse',
    );
    expect(mockHandlers.getConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'GET',
      '/api/admin/langfuse/connection/session/conversation-1',
      'getSessionLink',
      { handler: 'session' },
    ],
    ['PUT', '/api/admin/langfuse/connection', 'updateConnection', { handler: 'update' }],
    ['POST', '/api/admin/langfuse/connection/test', 'testConnection', { handler: 'test' }],
    ['PUT', '/api/admin/langfuse/prompt-sync', 'updatePromptSync', { handler: 'prompt-sync' }],
    ['GET', '/api/admin/langfuse/prompts', 'listPrompts', { handler: 'prompts' }],
    [
      'GET',
      '/api/admin/langfuse/prompts/greeting',
      'getPrompt',
      { handler: 'prompt', name: 'greeting' },
    ],
  ])(
    'requires Langfuse manage access for %s %s',
    async (method, path, handlerName, expectedBody) => {
      const app = createApp();
      const response = await request(app)[method.toLowerCase()](path).send({}).expect(200);

      expect(response.body).toEqual(expectedBody);
      expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'config']);
      expect(mockHandlers[handlerName]).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['GET', '/api/admin/langfuse/connection/session/conversation-1', 'getSessionLink'],
    ['PUT', '/api/admin/langfuse/connection', 'updateConnection'],
    ['POST', '/api/admin/langfuse/connection/test', 'testConnection'],
    ['PUT', '/api/admin/langfuse/prompt-sync', 'updatePromptSync'],
    ['GET', '/api/admin/langfuse/prompts', 'listPrompts'],
    ['GET', '/api/admin/langfuse/prompts/greeting', 'getPrompt'],
    ['POST', '/api/admin/langfuse/prompts/sync', 'syncPrompts'],
  ])('blocks %s %s without Langfuse manage access', async (method, path, handlerName) => {
    canManageLangfuse = false;

    await request(createApp())[method.toLowerCase()](path).send({}).expect(403);

    expect(mockHandlers[handlerName]).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/admin/langfuse/prompts', 'listPrompts'],
    ['GET', '/api/admin/langfuse/prompts/greeting', 'getPrompt'],
    ['POST', '/api/admin/langfuse/prompts/sync', 'syncPrompts'],
  ])('rejects %s %s for an unauthenticated caller', async (method, path, handlerName) => {
    mockRequireJwtAuth.mockImplementationOnce((_req, res) => {
      middlewareCalls.push('jwt');
      res.status(401).json({ message: 'Authentication required' });
    });

    await request(createApp())[method.toLowerCase()](path).expect(401);

    expect(mockHandlers[handlerName]).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', '/api/admin/langfuse/prompts', 'listPrompts'],
    ['GET', '/api/admin/langfuse/prompts/greeting', 'getPrompt'],
    ['POST', '/api/admin/langfuse/prompts/sync', 'syncPrompts'],
  ])('rejects %s %s for a non-admin caller', async (method, path, handlerName) => {
    deniedCapability = 'access:admin';

    await request(createApp())[method.toLowerCase()](path).expect(403);

    expect(mockHandlers[handlerName]).not.toHaveBeenCalled();
  });

  it('decodes an encoded slash in the prompt name before it reaches the handler', async () => {
    await request(createApp()).get('/api/admin/langfuse/prompts/a%2Fb').expect(200);

    expect(mockHandlers.getPrompt).toHaveBeenCalledTimes(1);
    const [req] = mockHandlers.getPrompt.mock.calls[0];
    expect(req.params.name).toBe('a/b');
  });

  /**
   * Credential verification reads the deployment's Langfuse headers off
   * `req.config`. The handler unit tests inject `config` into their mock
   * requests, so only the mounted router proves the middleware supplying it is
   * actually wired up — without it a proxied Langfuse host rejects every
   * verification while the handler suite stays green.
   */
  it.each([
    ['PUT', '/api/admin/langfuse/connection', 'updateConnection'],
    ['POST', '/api/admin/langfuse/connection/test', 'testConnection'],
  ])('resolves the app config before %s %s reaches its handler', async (method, path, handler) => {
    await request(createApp())[method.toLowerCase()](path).send({}).expect(200);

    expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
    const [req] = mockHandlers[handler].mock.calls[0];
    expect(req.config?.langfuse?.headers).toEqual({ 'CF-Access-Client-Id': 'proxy-client' });
  });

  it('resolves the app config only after the access checks reject', async () => {
    canManageLangfuse = false;

    await request(createApp()).post('/api/admin/langfuse/connection/test').send({}).expect(403);

    expect(mockConfigMiddleware).not.toHaveBeenCalled();
  });

  it('passes the composed Langfuse prompt-sync runner to the handler factory, not its dependencies', () => {
    expect(handlerDepsAtLoad).toMatchObject({ syncPromptCatalog: mockSyncPromptCatalog });
    expect(handlerDepsAtLoad).not.toHaveProperty('lock');
    expect(handlerDepsAtLoad).not.toHaveProperty('grantPermission');
    expect(handlerDepsAtLoad).not.toHaveProperty('findLangfusePromptGroup');
    expect(handlerDepsAtLoad).not.toHaveProperty('createLangfusePromptGroup');
    expect(handlerDepsAtLoad).not.toHaveProperty('deletePromptGroup');
    expect(handlerDepsAtLoad).not.toHaveProperty('promptService');
  });

  it('requires manage:prompts access, in addition to Langfuse manage access, for POST /prompts/sync', async () => {
    const response = await request(createApp())
      .post('/api/admin/langfuse/prompts/sync')
      .send({})
      .expect(200);

    expect(response.body).toEqual({ handler: 'sync' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'config', 'manage:prompts']);
    expect(mockHandlers.syncPrompts).toHaveBeenCalledTimes(1);
  });

  it('blocks POST /prompts/sync for a caller without manage:prompts access', async () => {
    deniedCapability = 'manage:prompts';

    await request(createApp()).post('/api/admin/langfuse/prompts/sync').send({}).expect(403);

    expect(mockHandlers.syncPrompts).not.toHaveBeenCalled();
  });
});
