/**
 * GET /files is intentionally covered as wiring only. The list policy lives in
 * packages/api and has its behavioral coverage in files/list.spec.ts.
 */

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  SystemCapabilities: {},
}));

const mockHandleFileListRequest = jest.fn();
const mockRefreshS3FileUrls = jest.fn();
jest.mock('@librechat/api', () => ({
  handleFileListRequest: (...args) => mockHandleFileListRequest(...args),
  refreshS3FileUrls: (...args) => mockRefreshS3FileUrls(...args),
  resolveUploadErrorMessage: jest.fn(),
  verifyAgentUploadPermission: jest.fn(),
}));

jest.mock('~/models', () => ({
  findFileById: jest.fn(),
  getFiles: jest.fn(),
  updateFile: jest.fn(),
  getAgents: jest.fn().mockResolvedValue([]),
  batchUpdateFiles: jest.fn(),
}));

jest.mock('~/server/services/Files/process', () => ({
  filterFile: jest.fn(),
  processFileUpload: jest.fn(),
  processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
  processAgentFileUpload: jest.fn(),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn(() => ({})),
}));

jest.mock('~/server/controllers/assistants/helpers', () => ({
  getOpenAIClient: jest.fn(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  hasCapability: jest.fn(() => (_req, _res, next) => next()),
}));

jest.mock('~/server/services/PermissionService', () => ({
  checkPermission: jest.fn(() => (_req, _res, next) => next()),
  getEffectivePermissions: jest.fn().mockResolvedValue(0),
}));

jest.mock('~/server/services/Files', () => ({
  hasAccessToFilesViaAgent: jest.fn(),
}));

const mockGetLogStores = jest.fn();
jest.mock('~/cache', () => ({
  getLogStores: (...args) => mockGetLogStores(...args),
}));

const express = require('express');
const request = require('supertest');
const { FileSources } = require('librechat-data-provider');
const filesRouter = require('./files');

function buildApp(config = { fileStrategy: FileSources.local, fileListLimit: 100 }) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-123', role: 'user' };
    req.config = config;
    next();
  });
  app.use('/files', filesRouter);
  return app;
}

describe('GET /files wiring', () => {
  beforeEach(() => {
    mockHandleFileListRequest.mockReset();
    mockGetLogStores.mockReset();
  });

  it('sends the list returned by the shared policy and threads request configuration', async () => {
    const files = [{ file_id: 'f1' }];
    mockHandleFileListRequest.mockResolvedValue(files);
    const config = { fileStrategy: FileSources.s3, fileListLimit: 250 };

    const res = await request(buildApp(config)).get('/files?limit=12');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(files);
    expect(mockHandleFileListRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-123',
        rawLimit: '12',
        fileStrategy: FileSources.s3,
        maxLimit: 250,
      }),
    );
    expect(mockHandleFileListRequest.mock.calls[0][0].dependencies).toEqual(
      expect.objectContaining({
        getFiles: expect.any(Function),
        batchUpdateFiles: expect.any(Function),
        refreshS3FileUrls: expect.any(Function),
        getLogStores: expect.any(Function),
        logger: expect.any(Object),
      }),
    );
  });

  it('keeps the route error response when the shared policy rejects', async () => {
    mockHandleFileListRequest.mockRejectedValue(new Error('database unavailable'));

    const res = await request(buildApp()).get('/files');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      message: 'Error in request',
      error: 'database unavailable',
    });
  });
});
