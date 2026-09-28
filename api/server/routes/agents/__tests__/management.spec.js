const express = require('express');
const request = require('supertest');

const mockMapAgentManagementError = jest.fn(() => ({
  status: 404,
  body: { error: { code: 'not_found', message: 'Agent not found' } },
}));
const mockList = jest.fn((_req, res) => res.status(200).json({ object: 'list', data: [] }));
const mockGet = jest.fn((_req, res) => res.status(200).json({ id: 'agent-one' }));
const mockCreateAgentManagementReadHandlers = jest.fn(() => ({
  list: mockList,
  get: mockGet,
}));
const mockCreate = jest.fn((_req, res) => res.status(201).json({ id: 'agent-created' }));
let mockCreateDeps;
const mockCreateAgentManagementCreateHandler = jest.fn((deps) => {
  mockCreateDeps = deps;
  return mockCreate;
});
const mockUpdate = jest.fn((_req, res) => res.status(200).json({ id: 'agent-updated' }));
let mockUpdateDeps;
const mockCreateAgentManagementUpdateHandler = jest.fn((deps) => {
  mockUpdateDeps = deps;
  return mockUpdate;
});
const mockDelete = jest.fn((_req, res) =>
  res.status(200).json({ id: 'agent-deleted', deleted: true }),
);
let mockDeleteDeps;
const mockCreateAgentManagementDeleteHandler = jest.fn((deps) => {
  mockDeleteDeps = deps;
  return mockDelete;
});
const mockFileList = jest.fn((_req, res) => res.status(200).json({ object: 'list', data: [] }));
const mockFileRemove = jest.fn((_req, res) =>
  res.status(200).json({ id: 'file-one', deleted: true }),
);
const mockFileUpload = jest.fn((_req, res) => res.status(200).json({ id: 'file-uploaded' }));
const mockFileAuthorizeUpload = jest.fn((_req, _res, next) => next());
const mockGetFileUploadConfig = jest.fn(() => ({ endpoint: 'openAI' }));
let mockFileDeps;
const mockCreateAgentManagementFileHandlers = jest.fn((deps) => {
  mockFileDeps = deps;
  return {
    authorizeUpload: mockFileAuthorizeUpload,
    getUploadConfig: mockGetFileUploadConfig,
    upload: mockFileUpload,
    list: mockFileList,
    remove: mockFileRemove,
  };
});
const mockBrowserCreate = jest.fn();
const mockBrowserUpdate = jest.fn();
const mockCheckBan = jest.fn((_req, _res, next) => next());
const mockRequestFileConfig = { endpoints: { Moonshot: { fileLimit: 3 } } };
const mockConfigMiddleware = jest.fn((req, _res, next) => {
  req.config = { fileConfig: mockRequestFileConfig };
  next();
});
const mockUaParser = jest.fn((_req, _res, next) => next());
const mockUploadMiddleware = jest.fn((req, _res, next) => {
  req.file = { path: '/tmp/upload', originalname: 'input.txt' };
  next();
});
const mockCreateMulterInstance = jest.fn().mockResolvedValue({
  single: jest.fn(() => mockUploadMiddleware),
});
const mockGetEndpointsConfig = jest.fn().mockResolvedValue({
  Moonshot: { type: 'custom' },
});
const mockCheckCapability = jest.fn().mockResolvedValue(true);
const mockRunUploadExclusive = jest.fn(async (_key, task) => await task());
const mockCreateAgentUploadLock = jest.fn(() => mockRunUploadExclusive);
let mockRateLimitIp = false;
const mockCreateFileLimiters = jest.fn(({ onLimit } = {}) => ({
  fileUploadIpLimiter: jest.fn((req, res, next) => (mockRateLimitIp ? onLimit(req, res) : next())),
  fileUploadUserLimiter: jest.fn((_req, _res, next) => next()),
}));

const mockRequireAgentManagementAuth = jest.fn((req, res, next) => {
  if (req.headers.authorization !== 'Bearer valid-token') {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  req.user = { id: 'integration-user', tenantId: 'tenant-a', role: 'USER' };
  next();
});

jest.mock('../skills', () => require('express').Router());

jest.mock('../middleware', () => ({
  requireAgentManagementAuth: mockRequireAgentManagementAuth,
}));
jest.mock('@librechat/api', () => ({
  ioredisClient: {},
  mapAgentManagementError: mockMapAgentManagementError,
  restoreTenantContextFromReq: jest.fn((_req, _res, next) => next()),
  createAgentUploadLock: mockCreateAgentUploadLock,
  createAgentManagementCreateHandler: mockCreateAgentManagementCreateHandler,
  createAgentManagementDeleteHandler: mockCreateAgentManagementDeleteHandler,
  createAgentManagementFileHandlers: mockCreateAgentManagementFileHandlers,
  createAgentManagementReadHandlers: mockCreateAgentManagementReadHandlers,
  createAgentManagementUpdateHandler: mockCreateAgentManagementUpdateHandler,
}));
jest.mock('~/server/middleware', () => ({
  checkBan: mockCheckBan,
  configMiddleware: mockConfigMiddleware,
  createFileLimiters: mockCreateFileLimiters,
  uaParser: mockUaParser,
}));
jest.mock('~/server/routes/files/multer', () => ({
  createMulterInstance: mockCreateMulterInstance,
}));
jest.mock('~/server/routes/files/files', () => ({ handleFileUpload: jest.fn() }));
jest.mock('~/server/services/Config', () => ({
  checkCapability: mockCheckCapability,
  getEndpointsConfig: mockGetEndpointsConfig,
}));
jest.mock('~/server/controllers/agents/v1', () => ({
  createAgent: mockBrowserCreate,
  updateAgent: mockBrowserUpdate,
}));
jest.mock('~/server/middleware/roles/capabilities', () => ({ hasCapability: jest.fn() }));
jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(),
  findAccessibleResources: jest.fn(),
}));
jest.mock('~/models', () => ({
  getRoleByName: jest.fn(),
  getAgentWithVersionCount: jest.fn(),
  getAgentManagementListByAccess: jest.fn(),
  getFiles: jest.fn(),
  removeAgentResourceFiles: jest.fn(),
  deleteAgent: jest.fn(),
}));

const router = require('../management');

describe('Agent Management route boundary', () => {
  const app = express();
  app.use('/api/agents/v1/agents', router);

  beforeEach(() => {
    mockRequireAgentManagementAuth.mockClear();
    mockCheckBan.mockClear();
    mockConfigMiddleware.mockClear();
    mockUaParser.mockClear();
    mockMapAgentManagementError.mockClear();
    mockFileAuthorizeUpload.mockClear();
    mockFileUpload.mockClear();
    mockUploadMiddleware.mockClear();
    mockRunUploadExclusive.mockClear();
    mockRateLimitIp = false;
  });

  it('rejects a request before reaching management routes without machine authentication', async () => {
    const response = await request(app)
      .post('/api/agents/v1/agents')
      .send({ name: 'Managed Agent', provider: 'openAI', model: 'gpt-5' });

    expect(response.status).toBe(401);
    expect(mockRequireAgentManagementAuth).toHaveBeenCalledTimes(1);
    expect(mockCheckBan).not.toHaveBeenCalled();
    expect(mockUaParser).not.toHaveBeenCalled();
  });

  it('allows an authenticated non-browser client into the management router', async () => {
    const response = await request(app)
      .post('/api/agents/v1/agents/not-a-management-operation')
      .set('Authorization', 'Bearer valid-token')
      .set('User-Agent', 'curl/8.0.0');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: { code: 'not_found', message: 'Agent not found' } });
    expect(mockCheckBan).toHaveBeenCalledTimes(1);
    expect(mockUaParser).not.toHaveBeenCalled();
    expect(mockMapAgentManagementError).toHaveBeenCalledWith('not_found');
    expect(mockRequireAgentManagementAuth).toHaveBeenCalledTimes(1);
  });

  it('dispatches authenticated list and retrieve requests to the management read handlers', async () => {
    const listResponse = await request(app)
      .get('/api/agents/v1/agents')
      .set('Authorization', 'Bearer valid-token');
    const getResponse = await request(app)
      .get('/api/agents/v1/agents/agent-one')
      .set('Authorization', 'Bearer valid-token');

    expect(listResponse.status).toBe(200);
    expect(getResponse.status).toBe(200);
    expect(mockList).toHaveBeenCalledTimes(1);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('loads Agent configuration and dispatches authenticated creation requests', async () => {
    const response = await request(app)
      .post('/api/agents/v1/agents')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Managed Agent', provider: 'openAI', model: 'gpt-5' });

    expect(response.status).toBe(201);
    expect(response.body).toEqual({ id: 'agent-created' });
    expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreateDeps.getRoleByName).toEqual(expect.any(Function));
    expect(mockCreateDeps.createAgent).toBe(mockBrowserCreate);
  });

  it('loads Agent configuration and dispatches authenticated update requests', async () => {
    const response = await request(app)
      .patch('/api/agents/v1/agents/agent-one')
      .set('Authorization', 'Bearer valid-token')
      .send({ name: 'Updated Agent' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'agent-updated' });
    expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdateDeps.getRoleByName).toEqual(expect.any(Function));
    expect(mockUpdateDeps.getAgentWithVersionCount).toEqual(expect.any(Function));
    expect(mockUpdateDeps.checkPermission).toEqual(expect.any(Function));
    expect(mockUpdateDeps.hasCapability).toEqual(expect.any(Function));
    expect(mockUpdateDeps.updateAgent).toBe(mockBrowserUpdate);
  });

  it('dispatches authenticated deletion requests with the shared Agent dependencies', async () => {
    const response = await request(app)
      .delete('/api/agents/v1/agents/agent-deleted')
      .set('Authorization', 'Bearer valid-token');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ id: 'agent-deleted', deleted: true });
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(mockDeleteDeps.getRoleByName).toEqual(expect.any(Function));
    expect(mockDeleteDeps.getAgentWithVersionCount).toEqual(expect.any(Function));
    expect(mockDeleteDeps.checkPermission).toEqual(expect.any(Function));
    expect(mockDeleteDeps.hasCapability).toEqual(expect.any(Function));
    expect(mockDeleteDeps.deleteAgent).toEqual(expect.any(Function));
  });

  it('dispatches authenticated Agent file list and unlink requests', async () => {
    const listResponse = await request(app)
      .get('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token');
    const deleteResponse = await request(app)
      .delete('/api/agents/v1/agents/agent-one/files/file-one')
      .set('Authorization', 'Bearer valid-token');

    expect(listResponse.status).toBe(200);
    expect(deleteResponse.status).toBe(200);
    expect(mockFileList).toHaveBeenCalledTimes(1);
    expect(mockFileRemove).toHaveBeenCalledTimes(1);
    expect(mockFileDeps.getAgentWithVersionCount).toEqual(expect.any(Function));
    expect(mockFileDeps.getFiles).toEqual(expect.any(Function));
    expect(mockFileDeps.removeAgentResourceFiles).toEqual(expect.any(Function));
  });

  it('retries multipart initialization after a transient failure', async () => {
    mockCreateMulterInstance.mockRejectedValueOnce(new Error('temporary config failure'));
    mockMapAgentManagementError.mockReturnValueOnce({
      status: 500,
      body: { error: { code: 'internal_error', message: 'Internal server error' } },
    });

    const failed = await request(app)
      .post('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token')
      .send({ purpose: 'context' });
    const retried = await request(app)
      .post('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token')
      .send({ purpose: 'context' });

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(mockCreateMulterInstance).toHaveBeenCalledTimes(2);
    expect(mockCreateMulterInstance).toHaveBeenLastCalledWith({
      fileConfig: mockRequestFileConfig,
      resolveEndpoint: mockGetFileUploadConfig,
      uniqueTempPath: true,
    });
    expect(mockFileUpload).toHaveBeenCalledTimes(1);
  });

  it('loads file configuration and dispatches authenticated multipart uploads', async () => {
    const response = await request(app)
      .post('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token')
      .send({ purpose: 'context' });

    expect(response.status).toBe(200);
    expect(mockConfigMiddleware).toHaveBeenCalledTimes(1);
    expect(mockFileAuthorizeUpload).toHaveBeenCalledTimes(1);
    expect(mockFileUpload).toHaveBeenCalledTimes(1);
    expect(mockFileAuthorizeUpload.mock.invocationCallOrder[0]).toBeLessThan(
      mockUploadMiddleware.mock.invocationCallOrder[0],
    );
    expect(mockFileDeps.processUpload).toEqual(expect.any(Function));
    expect(mockFileDeps.deleteTempFile).toEqual(expect.any(Function));
    expect(mockFileDeps.getUploadConfig).toEqual(expect.any(Function));
    expect(mockFileDeps.isUploadPurposeEnabled).toEqual(expect.any(Function));
  });

  it('resolves upload limits from the target Agent provider', async () => {
    const config = await mockFileDeps.getUploadConfig(
      {
        config: {
          fileConfig: {
            endpoints: {
              Moonshot: { fileLimit: 3, totalSizeLimit: 20 },
            },
          },
        },
      },
      { provider: 'Moonshot' },
    );

    expect(config).toMatchObject({
      endpoint: 'Moonshot',
      endpointType: 'custom',
      fileLimit: 3,
      totalSizeLimit: 20 * 1024 * 1024,
    });
  });

  it('maps upload quota failures into the management error contract', async () => {
    mockRateLimitIp = true;

    const response = await request(app)
      .post('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token')
      .send({ purpose: 'context' });

    expect(response.status).toBe(429);
    expect(response.body).toEqual({
      error: {
        code: 'invalid_request',
        message: 'Too many file upload requests. Try again later',
      },
    });
    expect(mockFileAuthorizeUpload).not.toHaveBeenCalled();
    expect(mockFileUpload).not.toHaveBeenCalled();
  });

  it('maps multipart failures into the management error contract', async () => {
    mockMapAgentManagementError.mockReturnValueOnce({
      status: 400,
      body: { error: { code: 'invalid_request', message: 'Invalid request' } },
    });
    mockUploadMiddleware.mockImplementationOnce((_req, _res, next) => {
      next(Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' }));
    });

    const response = await request(app)
      .post('/api/agents/v1/agents/agent-one/files')
      .set('Authorization', 'Bearer valid-token')
      .send({ purpose: 'context' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: { code: 'invalid_request', message: 'Invalid request' },
    });
    expect(mockFileUpload).not.toHaveBeenCalled();
    expect(mockMapAgentManagementError).toHaveBeenCalledWith('invalid_request');
  });
});
