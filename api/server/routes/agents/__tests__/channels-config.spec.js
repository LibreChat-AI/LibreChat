const express = require('express');
const request = require('supertest');
const mockReadConfig = jest.fn(async () => ({
  endpoints: { agents: { channels: { enabled: true } } },
}));
let mockPolicy;
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: () => (_req, _res, next) => next(),
}));
jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
jest.mock(
  '~/server/controllers/agents/v1',
  () => new Proxy({}, { get: () => (_req, res) => res.sendStatus(204) }),
);
jest.mock('~/server/middleware', () => ({
  configMiddleware: async (req, _res, next) => {
    req.config = await mockReadConfig();
    next();
  },
  canAccessAgentResource: () => (_req, _res, next) => next(),
}));
jest.mock('../middleware', () => ({ checkRemoteAgentsFeature: (_req, _res, next) => next() }));
jest.mock('../actions', () => require('express').Router());
jest.mock('../tools', () => require('express').Router());
jest.mock(
  '~/server/services/Channels',
  () =>
    new Proxy({}, { get: () => async (req, res) => res.json(await mockPolicy.requestConfig(req)) }),
);

it('resolves strict effective management configuration once through the actual v1 mount', async () => {
  const { createChannelApplicationPolicy } = jest.requireActual('@librechat/api');
  mockPolicy = createChannelApplicationPolicy({
    readAppConfig: mockReadConfig,
    findUser: jest.fn(),
    isPrincipalActive: async () => true,
  });
  const app = express();
  app.use((req, _res, next) => {
    req.user = { id: 'owner', _id: 'owner', role: 'USER' };
    next();
  });
  app.use('/agents', require('../v1').v1);
  await request(app).get('/agents/agent/channels').expect(200);
  expect(mockReadConfig).toHaveBeenCalledTimes(1);
  expect(mockReadConfig).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'owner', failClosed: true }),
  );
});
