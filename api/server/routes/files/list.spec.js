/**
 * Coverage for GET /files, the list endpoint the composer palette's recent
 * files ride on.
 *
 * Two behaviours are load bearing and were previously untested: the `?limit=`
 * cap that keeps a palette request from pulling unbounded history, and the S3
 * signed-URL refresh. `refreshS3FileUrls` copies its input rather than mutating
 * it, so the response has to carry the value it returns; sending the original
 * array ships URLs that have already expired even though the database was
 * updated with fresh ones.
 */

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  SystemCapabilities: {},
}));

const mockRefreshS3FileUrls = jest.fn();
jest.mock('@librechat/api', () => ({
  refreshS3FileUrls: (...args) => mockRefreshS3FileUrls(...args),
  resolveUploadErrorMessage: jest.fn(),
  verifyAgentUploadPermission: jest.fn(),
}));

const mockGetFiles = jest.fn();
const mockBatchUpdateFiles = jest.fn();
jest.mock('~/models', () => ({
  findFileById: jest.fn(),
  getFiles: (...args) => mockGetFiles(...args),
  updateFile: jest.fn(),
  getAgents: jest.fn().mockResolvedValue([]),
  batchUpdateFiles: (...args) => mockBatchUpdateFiles(...args),
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

const mockCacheGet = jest.fn();
const mockCacheSet = jest.fn();
jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({
    get: (...args) => mockCacheGet(...args),
    set: (...args) => mockCacheSet(...args),
  })),
}));

const express = require('express');
const request = require('supertest');
const { FileSources } = require('librechat-data-provider');
const filesRouter = require('./files');

function buildApp(fileStrategy = 'local') {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'user-123', role: 'user' };
    req.config = { fileStrategy };
    next();
  });
  app.use('/files', filesRouter);
  return app;
}

const staleFile = {
  file_id: 'f1',
  user: 'user-123',
  source: FileSources.s3,
  filepath: 'https://bucket.s3.amazonaws.com/key?X-Amz-Expires=1',
};
const freshFile = { ...staleFile, filepath: 'https://bucket.s3.amazonaws.com/key?X-Amz-Expires=2' };

describe('GET /files', () => {
  beforeEach(() => {
    mockGetFiles.mockReset();
    mockRefreshS3FileUrls.mockReset();
    mockBatchUpdateFiles.mockReset();
    mockCacheGet.mockReset();
    mockCacheSet.mockReset();
    mockGetFiles.mockResolvedValue([]);
  });

  describe('limit handling', () => {
    it('passes a positive limit through to the query', async () => {
      await request(buildApp()).get('/files?limit=5');
      expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, 5);
    });

    it('caps the limit so a palette request cannot pull unbounded history', async () => {
      await request(buildApp()).get('/files?limit=100000');
      expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, 100);
    });

    it('leaves the limit undefined for the full list', async () => {
      await request(buildApp()).get('/files');
      expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, undefined);
    });

    it('ignores a non-numeric or non-positive limit', async () => {
      await request(buildApp()).get('/files?limit=abc');
      expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, undefined);

      mockGetFiles.mockClear();
      await request(buildApp()).get('/files?limit=0');
      expect(mockGetFiles).toHaveBeenCalledWith({ user: 'user-123' }, null, null, undefined);
    });
  });

  describe('S3 signed URL refresh', () => {
    it('sends the refreshed rows rather than the stale ones it was given', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);
      mockCacheGet.mockResolvedValue(null);
      /* Mirrors the real implementation: a copy, never a mutation of the
         caller's array. */
      mockRefreshS3FileUrls.mockResolvedValue([freshFile]);

      const res = await request(buildApp(FileSources.s3)).get('/files?limit=5');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([freshFile]);
    });

    it('does the same for the unlimited list', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);
      mockCacheGet.mockResolvedValue(null);
      mockRefreshS3FileUrls.mockResolvedValue([freshFile]);

      const res = await request(buildApp(FileSources.s3)).get('/files');

      expect(res.body).toEqual([freshFile]);
    });

    it('marks the user-wide interval only after a full list', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);
      mockCacheGet.mockResolvedValue(null);
      mockRefreshS3FileUrls.mockResolvedValue([freshFile]);

      await request(buildApp(FileSources.s3)).get('/files?limit=5');
      expect(mockCacheSet).not.toHaveBeenCalled();

      await request(buildApp(FileSources.s3)).get('/files');
      expect(mockCacheSet).toHaveBeenCalledWith('user-123', true, expect.any(Number));
    });

    it('keeps the original rows when the refresh throws', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);
      mockCacheGet.mockResolvedValue(null);
      mockRefreshS3FileUrls.mockRejectedValue(new Error('s3 down'));

      const res = await request(buildApp(FileSources.s3)).get('/files');

      expect(res.status).toBe(200);
      expect(res.body).toEqual([staleFile]);
    });

    it('skips the refresh entirely when the interval was already marked', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);
      mockCacheGet.mockResolvedValue(true);

      const res = await request(buildApp(FileSources.s3)).get('/files');

      expect(mockRefreshS3FileUrls).not.toHaveBeenCalled();
      expect(res.body).toEqual([staleFile]);
    });

    it('does not touch S3 on a local deployment', async () => {
      mockGetFiles.mockResolvedValue([staleFile]);

      await request(buildApp()).get('/files');

      expect(mockRefreshS3FileUrls).not.toHaveBeenCalled();
    });
  });
});
