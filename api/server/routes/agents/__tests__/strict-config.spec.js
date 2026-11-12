const express = require('express');
const request = require('supertest');
const mockReadConfig = jest.fn();
const mockWrite = jest.fn((_req, res) => res.sendStatus(204));
const mockUser = { id: 'user-1', role: 'USER', tenantId: 'tenant-1', idOnTheSource: null };
const mockBase = {
  modelSpecs: {
    list: [
      {
        name: 'base',
        label: 'Base',
        handoff: true,
        preset: { endpoint: 'openAI', model: 'gpt-4o' },
      },
    ],
  },
};

jest.mock('~/server/services/Config', () => ({
  getAppConfig: (...args) => mockReadConfig(...args),
}));
jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  generateCheckAccess: () => (_req, _res, next) => next(),
}));
jest.mock('~/models', () => ({ getRoleByName: jest.fn() }));
jest.mock('~/server/controllers/agents/v1', () => new Proxy({}, { get: () => mockWrite }));
jest.mock('~/server/middleware', () => ({
  configMiddleware: (req, _res, next) => {
    req.config = mockBase;
    next();
  },
  strictConfigMiddleware: (...args) =>
    jest.requireActual('~/server/middleware/config/app').strictConfigMiddleware(...args),
  canAccessAgentResource: () => (_req, _res, next) => next(),
}));
jest.mock('../actions', () => require('express').Router());
jest.mock('../tools', () => require('express').Router());
jest.mock('../channels', () => require('express').Router());

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    req.user = mockUser;
    req.config = mockBase;
    next();
  });
  server.use('/agents', require('../v1').v1);
  server.use((_error, _req, res, _next) =>
    res.status(503).json({ error: 'configuration_unavailable' }),
  );
  return server;
}

beforeEach(() => jest.clearAllMocks());

test('does not list a base preset disabled by the effective user configuration', async () => {
  mockReadConfig.mockResolvedValue({ modelSpecs: { list: [] } });
  await request(app()).get('/agents/handoff-targets').expect(200, []);
  expect(mockReadConfig).toHaveBeenCalledWith(
    expect.objectContaining({ userId: mockUser.id, failClosed: true }),
  );
});

test.each([
  ['get', '/agents/handoff-targets'],
  ['post', '/agents'],
  ['patch', '/agents/agent_parent'],
  ['post', '/agents/agent_parent/duplicate'],
  ['post', '/agents/agent_parent/revert'],
])(
  'blocks %s %s when effective config resolution fails, even with preloaded base config',
  async (method, path) => {
    mockReadConfig.mockRejectedValue(new Error('private override lookup failure'));
    const response = await request(app())[method](path).send({}).expect(503);
    expect(response.body).toEqual({ error: 'configuration_unavailable' });
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockReadConfig).toHaveBeenCalledTimes(1);
    expect(mockReadConfig).toHaveBeenCalledWith(expect.objectContaining({ failClosed: true }));
  },
);

test('reuses strict configuration across both middleware positions on a write route', async () => {
  mockReadConfig.mockResolvedValue({ modelSpecs: { list: [] } });
  await request(app()).patch('/agents/agent_parent').send({}).expect(204);
  expect(mockWrite).toHaveBeenCalledTimes(1);
  expect(mockReadConfig).toHaveBeenCalledTimes(1);
});
