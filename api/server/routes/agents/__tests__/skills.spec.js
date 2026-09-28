const express = require('express');
const request = require('supertest');

const mockList = jest.fn((_req, res) => res.json({ object: 'list' }));
const mockWrite = jest.fn((_req, res) => res.json({ saved: true }));
const mockSync = jest.fn();
const mockManagementSaveFile = jest.fn();
const mockIp = jest.fn((_req, _res, next) => next());
const mockUser = jest.fn((_req, _res, next) => next());
const mockAuth = jest.fn((_req, _res, next) => next());
let mockDeps;
jest.mock('@librechat/api', () => ({
  createSkillManagementHandlers: (deps) => {
    mockDeps = deps;
    return {
      list: mockList,
      get: mockList,
      update: mockWrite,
      listFiles: mockList,
      getFile: mockList,
      updateFile: mockWrite,
    };
  },
  mapAgentManagementError: () => ({ status: 404, body: { error: { code: 'not_found' } } }),
}));
jest.mock('../middleware', () => ({ requireAgentManagementAuth: (...args) => mockAuth(...args) }));
jest.mock('~/server/middleware', () => ({
  checkBan: (_req, _res, next) => next(),
  configMiddleware: (req, _res, next) => {
    req.config = { tenantConfig: true };
    next();
  },
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({ hasCapability: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({ checkPermission: jest.fn() }));
jest.mock('~/server/services/Skills/handlers', () => ({ getSkillsHandlers: jest.fn() }));
jest.mock('~/server/services/Skills/sync', () => ({
  maybeRunGitHubSkillSyncForRequest: (...args) => mockSync(...args),
}));
jest.mock('~/server/services/Endpoints/agents/skillDeps', () => ({
  getSkillDbMethods: () => ({}),
  getSkillManagementFileSaver: () => mockManagementSaveFile,
}));
jest.mock('~/models', () => ({}));
jest.mock('~/server/middleware/limiters/uploadLimiters', () => ({
  createFileLimiters: () => ({
    fileUploadIpLimiter: (...args) => mockIp(...args),
    fileUploadUserLimiter: (...args) => mockUser(...args),
  }),
}));
const app = express();
app.use(express.json());
app.use('/skills', require('../skills'));

it('wires sync and both upload limiters into the authorized management handlers', async () => {
  await mockDeps.beforeList({ config: { tenantConfig: true } });
  expect(mockSync).toHaveBeenCalledWith({ config: { tenantConfig: true } });
  expect(mockDeps.fileWriteLimiters).toHaveLength(2);
  expect(mockDeps.saveFile).toBe(mockManagementSaveFile);
  const next = jest.fn();
  for (const limiter of mockDeps.fileWriteLimiters) limiter({}, {}, next);
  expect(mockIp).toHaveBeenCalledTimes(1);
  expect(mockUser).toHaveBeenCalledTimes(1);
});
it('keeps authentication ahead of management handlers', async () => {
  mockAuth.mockImplementationOnce((_req, res) => res.sendStatus(401));
  await request(app).get('/skills').expect(401);
  expect(mockList).not.toHaveBeenCalled();
});
