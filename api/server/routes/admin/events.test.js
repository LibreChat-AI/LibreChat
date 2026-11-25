const express = require('express');
const request = require('supertest');

const ID = '507f1f77bcf86cd799439011';
const middlewareCalls = [];
const mockRequireJwtAuth = jest.fn((req, _res, next) => {
  middlewareCalls.push('jwt');
  req.user = { id: 'admin-1', role: 'ADMIN' };
  next();
});
const mockRequireCapability = jest.fn((capability) => (_req, _res, next) => {
  middlewareCalls.push(capability);
  next();
});
const mockHandlers = {
  list: jest.fn((_req, res) => res.status(200).json({ operation: 'list' })),
  requeue: jest.fn((req, res) => res.status(200).json({ operation: 'requeue', id: req.params.id })),
  dismiss: jest.fn((req, res) => res.status(200).json({ operation: 'dismiss', id: req.params.id })),
};
const mockCreateHandlers = jest.fn(() => mockHandlers);
const mockConnectionHandlers = {
  list: jest.fn((_req, res) => res.status(200).json({ operation: 'connections.list' })),
  install: jest.fn((_req, res) => res.status(200).json({ operation: 'connections.install' })),
  bind: jest.fn((_req, res) => res.status(201).json({ operation: 'connections.bind' })),
  mark: jest.fn((req, res) =>
    res.status(200).json({ operation: 'connections.mark', id: req.params.id }),
  ),
  remove: jest.fn((req, res) =>
    res.status(200).json({ operation: 'connections.remove', id: req.params.id }),
  ),
};
const mockCreateConnectionHandlers = jest.fn(() => mockConnectionHandlers);
const mockConnections = { bind: jest.fn(), get: jest.fn(), list: jest.fn() };
const mockFetch = jest.fn();
const mockGetAppConfig = jest.fn();
const mockLetters = { list: jest.fn(), get: jest.fn(), requeue: jest.fn(), dismiss: jest.fn() };
const mockRecordAuditEntry = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    READ_EVENTS: 'read:events',
    MANAGE_EVENTS: 'manage:events',
  },
  createConnections: jest.fn(() => mockConnections),
}));

jest.mock('@librechat/api', () => ({
  createAdminDeadLetterHandlers: (...args) => mockCreateHandlers(...args),
  createAdminConnectionHandlers: (...args) => mockCreateConnectionHandlers(...args),
  createProxyAwareFetch: jest.fn(() => mockFetch),
  isAuditFailClosed: jest.fn(() => true),
}));

jest.mock('~/server/services/Config/app', () => ({
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: mockRequireCapability,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockRequireJwtAuth,
}));

jest.mock('~/server/services/Agents/triggers', () => ({
  agentTriggerDeadLetters: mockLetters,
}));

jest.mock('~/models', () => ({
  recordAuditEntry: mockRecordAuditEntry,
}));

function createApp() {
  delete require.cache[require.resolve('./events')];
  const router = require('./events');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/events', router);
  return app;
}

describe('admin event routes', () => {
  beforeEach(() => {
    middlewareCalls.length = 0;
    jest.clearAllMocks();
  });

  it('builds the handlers from the trigger queue and the audit log, failing closed', () => {
    createApp();

    expect(mockCreateHandlers).toHaveBeenCalledWith({
      letters: mockLetters,
      recordAuditEntry: mockRecordAuditEntry,
      auditFailClosed: true,
    });
  });

  it('builds the connection handlers from the store, the base config and the environment', async () => {
    // Jest keeps its own module registry, so the router is evaluated afresh in an isolated one.
    jest.isolateModules(() => require('./events'));

    expect(mockCreateConnectionHandlers).toHaveBeenCalledTimes(1);
    const [deps] = mockCreateConnectionHandlers.mock.calls[0];
    const { env, getAppConfig, ...rest } = deps;
    // Compared by identity, so a failure never prints the environment.
    expect(env === process.env).toBe(true);
    expect(rest).toEqual({
      connections: mockConnections,
      fetch: mockFetch,
      recordAuditEntry: mockRecordAuditEntry,
      auditFailClosed: true,
    });
    mockGetAppConfig.mockResolvedValue({ endpoints: {} });
    await expect(getAppConfig()).resolves.toEqual({ endpoints: {} });
    expect(mockGetAppConfig).toHaveBeenCalledWith();
  });

  it('lists connections behind admin access and the read capability', async () => {
    const response = await request(createApp()).get('/api/admin/events/connections').expect(200);

    expect(response.body).toEqual({ operation: 'connections.list' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:events']);
  });

  it.each([
    ['post', '/api/admin/events/connections/install', 'install', 200],
    ['post', '/api/admin/events/connections', 'bind', 201],
    ['patch', '/api/admin/events/connections/conn_1', 'mark', 200],
    ['delete', '/api/admin/events/connections/conn_1', 'remove', 200],
  ])(
    'gates %s %s behind admin access and the manage capability',
    async (method, path, name, status) => {
      await request(createApp())[method](path).expect(status);

      expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:events']);
      expect(mockConnectionHandlers[name]).toHaveBeenCalledTimes(1);
      expect(mockConnectionHandlers.list).not.toHaveBeenCalled();
    },
  );

  it('lists dead letters behind admin access and the read capability', async () => {
    const response = await request(createApp()).get('/api/admin/events/dead?limit=5').expect(200);

    expect(response.body).toEqual({ operation: 'list' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'read:events']);
  });

  it.each([
    ['post', `/api/admin/events/dead/${ID}/requeue`, 'requeue'],
    ['delete', `/api/admin/events/dead/${ID}`, 'dismiss'],
  ])('gates %s %s behind admin access and the manage capability', async (method, path, name) => {
    const response = await request(createApp())[method](path).expect(200);

    expect(response.body).toEqual({ operation: name, id: ID });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:events']);
    expect(mockHandlers[name]).toHaveBeenCalledTimes(1);
    expect(mockHandlers.list).not.toHaveBeenCalled();
  });

  it('exposes no other route on a dead letter', async () => {
    const app = createApp();

    await request(app).get(`/api/admin/events/dead/${ID}`).expect(404);
    await request(app).post(`/api/admin/events/dead/${ID}`).expect(404);
    await request(app).delete('/api/admin/events/dead').expect(404);
    expect(mockHandlers.requeue).not.toHaveBeenCalled();
    expect(mockHandlers.dismiss).not.toHaveBeenCalled();
  });
});
