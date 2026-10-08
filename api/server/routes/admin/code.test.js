const express = require('express');
const request = require('supertest');

const middlewareCalls = [];
const mockRequireJwtAuth = jest.fn((req, _res, next) => {
  middlewareCalls.push('jwt');
  req.user = { id: 'admin-1', role: 'ADMIN' };
  next();
});
const mockRequireCapability = jest.fn((capability) => (req, _res, next) => {
  middlewareCalls.push(capability);
  next();
});
const mockHandlers = {
  createPairing: jest.fn((req, res) =>
    res.status(200).json({ operation: 'pair', environmentId: req.params.environmentId }),
  ),
  revokeWorker: jest.fn((req, res) =>
    res.status(200).json({ operation: 'revoke', environmentId: req.params.environmentId }),
  ),
};
const mockGetAppConfig = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
    MANAGE_CODE_ENVIRONMENTS: 'manage:code_environments',
  },
}));

jest.mock('@librechat/api', () => ({
  createAdminCodeEnvironmentHandlers: jest.fn(() => mockHandlers),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: mockRequireCapability,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockRequireJwtAuth,
}));

jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

function createApp() {
  delete require.cache[require.resolve('./code')];
  const router = require('./code');
  const app = express();
  app.use(express.json());
  app.use('/api/admin/code-environments', router);
  return app;
}

describe('admin code environment routes', () => {
  beforeEach(() => {
    middlewareCalls.length = 0;
    jest.clearAllMocks();
  });

  it.each([
    ['pairings', 'createPairing', 'pair'],
    ['revoke', 'revokeWorker', 'revoke'],
  ])('protects and delegates the %s operation', async (path, handlerName, operation) => {
    const response = await request(createApp())
      .post(`/api/admin/code-environments/attached-vm/${path}`)
      .expect(200);

    expect(response.body).toEqual({ operation, environmentId: 'attached-vm' });
    expect(middlewareCalls).toEqual(['jwt', 'access:admin', 'manage:code_environments']);
    expect(mockHandlers[handlerName]).toHaveBeenCalledTimes(1);
    if (path === 'pairings') {
      expect(mockRequireCapability).toHaveBeenCalledWith('manage:code_environments', {
        platformOnly: true,
      });
    }
  });
});
