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
};

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: { ACCESS_ADMIN: 'access:admin' },
}));

jest.mock('@librechat/api', () => ({
  createAdminLangfuseHandlers: jest.fn(() => mockHandlers),
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
    ['GET', '/api/admin/langfuse/connection/session/conversation-1', 'getSessionLink'],
    ['PUT', '/api/admin/langfuse/connection', 'updateConnection'],
    ['POST', '/api/admin/langfuse/connection/test', 'testConnection'],
  ])('requires Langfuse manage access for %s %s', async (method, path, handlerName) => {
    const app = createApp();
    const response = await request(app)[method.toLowerCase()](path).send({}).expect(200);
    const expectedHandlers = {
      getSessionLink: 'session',
      updateConnection: 'update',
      testConnection: 'test',
    };

    expect(response.body).toEqual({ handler: expectedHandlers[handlerName] });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'config']);
    expect(mockHandlers[handlerName]).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['GET', '/api/admin/langfuse/connection/session/conversation-1', 'getSessionLink'],
    ['PUT', '/api/admin/langfuse/connection', 'updateConnection'],
    ['POST', '/api/admin/langfuse/connection/test', 'testConnection'],
  ])('blocks %s %s without Langfuse manage access', async (method, path, handlerName) => {
    canManageLangfuse = false;

    await request(createApp())[method.toLowerCase()](path).send({}).expect(403);

    expect(mockHandlers[handlerName]).not.toHaveBeenCalled();
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
});
