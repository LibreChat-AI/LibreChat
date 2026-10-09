const express = require('express');
const request = require('supertest');

const mockRequireJwtAuth = jest.fn((req, res, next) => {
  req.user = { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' };
  next();
});
const mockCapabilityMiddleware = jest.fn((req, res, next) => next());
const mockRequireCapability = jest.fn(() => mockCapabilityMiddleware);
const mockHasCapability = jest.fn().mockResolvedValue(true);
const mockConfigMiddleware = jest.fn((req, res, next) => {
  req.config = { skillSync: { github: { enabled: false, sources: [] } } };
  next();
});
const mockGetAppConfig = jest.fn();
const mockGetGitHubSkillSyncRunnerForRequest = jest.fn();
const mockHandlers = {
  getSyncStatus: jest.fn((req, res) => res.status(200).json({ ok: true })),
  runSync: jest.fn((req, res) => res.status(200).json({ ok: true })),
  setCredential: jest.fn((req, res) => res.status(200).json({ ok: true })),
  deleteCredential: jest.fn((req, res) => res.status(200).json({ ok: true })),
};
const mockSyncAccess = {
  attachBaseSkillSyncConfig: jest.fn((req, res, next) => next()),
  requireReadSkills: jest.fn((req, res, next) => next()),
  attachCredentialReadAccess: jest.fn((req, res, next) => next()),
  requireSyncRunCapability: jest.fn((req, res, next) => next()),
  requirePlatformManageSkills: jest.fn((req, res, next) => next()),
};

jest.mock('@librechat/data-schemas', () => ({
  SystemCapabilities: {
    ACCESS_ADMIN: 'access:admin',
  },
}));

jest.mock('@librechat/api', () => ({
  createAdminSkillsSyncAccess: jest.fn(() => mockSyncAccess),
  createAdminSkillsSyncHandlers: jest.fn(() => mockHandlers),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: mockHasCapability,
  requireCapability: mockRequireCapability,
}));

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: mockRequireJwtAuth,
}));

jest.mock('~/server/middleware/config/app', () => mockConfigMiddleware);

jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

jest.mock('~/models', () => ({
  upsertSkillSyncCredential: jest.fn(),
  deleteSkillSyncCredential: jest.fn(),
}));

jest.mock('~/server/services/Skills/sync', () => ({
  getGitHubSkillSyncRunnerForRequest: mockGetGitHubSkillSyncRunnerForRequest,
}));

describe('admin skills sync routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function createApp() {
    delete require.cache[require.resolve('./skills')];
    const router = require('./skills');
    const app = express();
    app.use(express.json());
    app.use('/api/admin/skills', router);
    return app;
  }

  it('delegates skill sync access policy to the API package', async () => {
    const app = createApp();

    await request(app).get('/api/admin/skills/sync/status').expect(200);

    const {
      createAdminSkillsSyncAccess,
      createAdminSkillsSyncHandlers,
    } = require('@librechat/api');
    expect(mockRequireCapability).toHaveBeenCalledWith('access:admin');
    expect(createAdminSkillsSyncAccess).toHaveBeenCalledWith({
      getAppConfig: mockGetAppConfig,
      hasCapability: mockHasCapability,
    });
    expect(createAdminSkillsSyncHandlers).toHaveBeenCalledWith(
      expect.objectContaining({ getRunner: mockGetGitHubSkillSyncRunnerForRequest }),
    );
    expect(mockRequireJwtAuth).toHaveBeenCalled();
    expect(mockCapabilityMiddleware).toHaveBeenCalled();
    expect(mockConfigMiddleware).toHaveBeenCalled();
    expect(mockSyncAccess.attachBaseSkillSyncConfig).toHaveBeenCalled();
    expect(mockSyncAccess.requireReadSkills).toHaveBeenCalled();
    expect(mockSyncAccess.attachCredentialReadAccess).toHaveBeenCalled();
    expect(mockHandlers.getSyncStatus).toHaveBeenCalled();
  });

  it('mounts package access middlewares before each sync endpoint handler', async () => {
    const app = createApp();

    await request(app).post('/api/admin/skills/sync/run').expect(200);
    await request(app).put('/api/admin/skills/sync/credentials/default').send({}).expect(200);
    await request(app).delete('/api/admin/skills/sync/credentials/default').expect(200);

    expect(mockSyncAccess.requireSyncRunCapability).toHaveBeenCalled();
    expect(mockHandlers.runSync).toHaveBeenCalled();
    expect(mockSyncAccess.requirePlatformManageSkills).toHaveBeenCalledTimes(2);
    expect(mockHandlers.setCredential).toHaveBeenCalled();
    expect(mockHandlers.deleteCredential).toHaveBeenCalled();
  });
});
