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
const mockLetters = { list: jest.fn(), get: jest.fn(), requeue: jest.fn(), dismiss: jest.fn() };
const mockRecordAuditEntry = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    READ_EVENTS: 'read:events',
    MANAGE_EVENTS: 'manage:events',
  },
}));

jest.mock('@librechat/api', () => ({
  createAdminDeadLetterHandlers: (...args) => mockCreateHandlers(...args),
  isAuditFailClosed: jest.fn(() => true),
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
