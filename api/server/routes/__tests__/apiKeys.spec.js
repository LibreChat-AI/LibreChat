/**
 * Loads the real route against the real packages. Only the app's own singletons are stood in
 * for, so a dependency the handlers need and the route does not pass fails here.
 */
const express = require('express');
const request = require('supertest');
const { PermissionTypes, Permissions } = require('librechat-data-provider');

const mockKeys = [{ id: 'key-1', name: 'CI', keyPrefix: 'sk-abc', createdAt: '1970-01-01' }];

jest.mock('~/models', () => ({
  getAgentApiKeyById: jest.fn(),
  createAgentApiKey: jest.fn(),
  deleteAgentApiKey: jest.fn(),
  listAgentApiKeys: jest.fn(async () => mockKeys),
  getRoleByName: jest.fn(),
}));
jest.mock('~/server/services/Config/app', () => ({ getAppConfig: jest.fn() }));
jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, _res, next) => {
    req.user = { id: 'owner', role: 'USER', tenantId: 'tenant' };
    next();
  },
}));

const { getAppConfig } = require('~/server/services/Config/app');
const { getRoleByName } = require('~/models');
const router = require('../apiKeys');

describe('API key routes', () => {
  const app = express();
  app.use('/api/api-keys', router);

  beforeEach(() => {
    getRoleByName.mockResolvedValue({
      permissions: { [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true } },
    });
  });

  it('lists keys without the grants flag where key runs are not limited', async () => {
    getAppConfig.mockResolvedValueOnce({ endpoints: { agents: {} } });
    const response = await request(app).get('/api/api-keys');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ keys: mockKeys });
  });

  it('says grants are in use from the configuration resolved for the owner who asks', async () => {
    getAppConfig.mockResolvedValueOnce({
      endpoints: { agents: { remoteApi: { integrations: { mode: 'delegated' } } } },
    });
    const response = await request(app).get('/api/api-keys');
    expect(response.body).toEqual({ keys: mockKeys, grants: true });
    expect(getAppConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ userId: 'owner', role: 'USER', tenantId: 'tenant' }),
    );
  });
});
