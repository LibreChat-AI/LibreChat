/**
 * Coverage for the new GET /files/:file_id/preview endpoint.
 *
 * Deferred-preview code-execution flow: the immediate persist step
 * emits a file record at `status: 'pending'`; the background render
 * transitions it to `'ready'` (with text) or `'failed'` (with
 * previewError). The frontend polls this endpoint until status is
 * terminal. This suite asserts the response shape across all four
 * states (pending, ready, failed, legacy/back-compat) and the auth
 * boundary (404 vs 403).
 */

jest.mock('@librechat/data-schemas', () => ({
  logger: { warn: jest.fn(), debug: jest.fn(), error: jest.fn(), info: jest.fn() },
  SystemCapabilities: {},
}));

jest.mock('@librechat/api', () => ({
  refreshS3FileUrls: jest.fn(),
  resolveUploadErrorMessage: jest.fn(),
  verifyAgentUploadPermission: jest.fn(),
}));

const mockFindFileById = jest.fn();
const mockGetFiles = jest.fn();
const mockUpdateFile = jest.fn();
const mockGetAgents = jest.fn().mockResolvedValue([]);
jest.mock('~/models', () => ({
  findFileById: (...args) => mockFindFileById(...args),
  getFiles: (...args) => mockGetFiles(...args),
  updateFile: (...args) => mockUpdateFile(...args),
  getAgents: (...args) => mockGetAgents(...args),
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

jest.mock('~/server/utils/files', () => ({
  cleanFileName: (name) => name,
  getContentDisposition: (name) => `attachment; filename="${name}"`,
}));

jest.mock('~/cache', () => ({
  getLogStores: jest.fn(() => ({ get: jest.fn(), set: jest.fn() })),
}));

const express = require('express');
const request = require('supertest');
const filesRouter = require('./files');

/**
 * Mount the router with a per-request user injector so we can simulate
 * a logged-in user without spinning up the full auth stack.
 */
function buildApp({ user = { id: 'user-123', role: 'user' } } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    req.config = { fileStrategy: 'local' };
    next();
  });
  app.use('/files', filesRouter);
  return app;
}

const OWNER_USER_ID = 'user-123';

describe('GET /files/:file_id/preview', () => {
  beforeEach(() => {
    mockFindFileById.mockReset();
    mockGetFiles.mockReset();
    mockUpdateFile.mockReset();
    mockGetAgents.mockReset();
    mockGetAgents.mockResolvedValue([]);
  });

  it('returns 404 when the file does not exist (auth check fails first via fileAccess)', async () => {
    /* `fileAccess` middleware does its own getFiles lookup and returns
     * 404 before our handler ever runs. This test asserts the boundary
     * lives there, not that the handler duplicates the check. */
    mockGetFiles.mockResolvedValueOnce([]);
    const res = await request(buildApp()).get('/files/missing-id/preview');
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: 'Not Found' });
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('returns 403 when the requester does not own the file and has no agent-based access', async () => {
    /* fileAccess returns 403 — the file exists but belongs to someone
     * else and no agent grants access. The preview handler should
     * never run. */
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'someone-elses', user: 'other-user', filename: 'x.xlsx' },
    ]);
    const res = await request(buildApp()).get('/files/someone-elses/preview');
    expect(res.status).toBe(403);
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('allows preview text through an attached agent file reference', async () => {
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'victim-file', user: 'victim-user', filename: 'secret.xlsx', status: 'ready' },
    ]);
    mockGetAgents.mockResolvedValueOnce([
      {
        id: 'agent-attacker',
        author: 'attacker-user',
        tool_resources: { execute_code: { file_ids: ['victim-file'] } },
      },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'victim-file',
      text: 'shared secret',
      textFormat: 'text',
    });

    const res = await request(buildApp({ user: { id: 'attacker-user', role: 'user' } })).get(
      '/files/victim-file/preview',
    );

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'victim-file',
      status: 'ready',
      text: 'shared secret',
      textFormat: 'text',
    });
  });

  it('returns status:pending without text/textFormat while the deferred render is in flight', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-pending',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'pending',
      },
    ]);
    const res = await request(buildApp()).get('/files/fid-pending/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-pending', status: 'pending' });
    /* Pending must NOT leak `text` and must NOT trigger the text re-fetch. */
    expect(res.body).not.toHaveProperty('text');
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('returns status:ready with text + textFormat when the deferred render succeeded', async () => {
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'fid-ready', user: OWNER_USER_ID, filename: 'data.xlsx', status: 'ready' },
    ]);
    /* Text is fetched only on the terminal ready response. */
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-ready',
      text: '<table><tr><td>1</td></tr></table>',
      textFormat: 'html',
    });
    const res = await request(buildApp()).get('/files/fid-ready/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-ready',
      status: 'ready',
      text: '<table><tr><td>1</td></tr></table>',
      textFormat: 'html',
    });
  });

  it('returns status:failed with previewError when the deferred render errored', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-failed',
        user: OWNER_USER_ID,
        filename: 'data.xlsx',
        status: 'failed',
        previewError: 'parser-error',
      },
    ]);
    const res = await request(buildApp()).get('/files/fid-failed/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-failed',
      status: 'failed',
      previewError: 'parser-error',
    });
    expect(mockFindFileById).not.toHaveBeenCalled();
  });

  it('defaults to status:ready for legacy records with no status field (back-compat)', async () => {
    mockGetFiles.mockResolvedValueOnce([
      {
        file_id: 'fid-legacy',
        user: OWNER_USER_ID,
        filename: 'old.csv',
        // status intentionally absent
      },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-legacy',
      text: 'csv,header\n1,2',
      textFormat: 'text',
    });
    const res = await request(buildApp()).get('/files/fid-legacy/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      file_id: 'fid-legacy',
      status: 'ready',
      text: 'csv,header\n1,2',
      textFormat: 'text',
    });
  });

  it('returns status:ready with no text when the record is ready but text is null (binary/oversized)', async () => {
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'fid-binary', user: OWNER_USER_ID, filename: 'image.bin' },
    ]);
    mockFindFileById.mockResolvedValueOnce({
      file_id: 'fid-binary',
      text: null,
      textFormat: null,
    });
    const res = await request(buildApp()).get('/files/fid-binary/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-binary', status: 'ready' });
  });

  it('returns ready with no text when ready record was deleted between fileAccess and text fetch', async () => {
    /* `fileAccess` saw the record but the concurrent delete removed it
     * before the text fetch. Surface ready-without-text rather than
     * 500 — the client routes to download-only and stops polling. */
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'fid-race', user: OWNER_USER_ID, filename: 'data.xlsx', status: 'ready' },
    ]);
    mockFindFileById.mockResolvedValueOnce(null);
    const res = await request(buildApp()).get('/files/fid-race/preview');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ file_id: 'fid-race', status: 'ready' });
  });

  it('returns 500 with a stable shape if the text fetch throws unexpectedly', async () => {
    mockGetFiles.mockResolvedValueOnce([
      { file_id: 'fid-boom', user: OWNER_USER_ID, filename: 'data.xlsx', status: 'ready' },
    ]);
    mockFindFileById.mockRejectedValueOnce(new Error('mongo down'));
    const res = await request(buildApp()).get('/files/fid-boom/preview');
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ error: 'Internal Server Error' });
  });

  describe('lazy sweep for stale pending records', () => {
    /* The boot-time `sweepOrphanedPreviews` only runs once at startup
     * with a 5-min cutoff. A backend crash + quick restart can leave
     * `pending` records younger than 5 min that never get touched
     * again. This endpoint sweeps them on the spot whenever a polling
     * request lands on one — the user is exactly the consumer who
     * cares, so on-demand sweep is the right shape. (Codex P2 review
     * on PR #12957.) */
    const STALE_MS = 6 * 60 * 1000;
    const FRESH_MS = 30 * 1000;

    it('marks a stale pending record as failed:orphaned and returns the swept state', async () => {
      const updatedAt = new Date(Date.now() - STALE_MS);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-stale',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce({
        file_id: 'fid-stale',
        status: 'failed',
        previewError: 'orphaned',
      });

      const res = await request(buildApp()).get('/files/fid-stale/preview');

      expect(mockUpdateFile).toHaveBeenCalledWith(
        { file_id: 'fid-stale', status: 'failed', previewError: 'orphaned' },
        { status: 'pending', updatedAt },
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        file_id: 'fid-stale',
        status: 'failed',
        previewError: 'orphaned',
      });
    });

    it('does NOT sweep a fresh pending record (within the cutoff window)', async () => {
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-fresh',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt: new Date(Date.now() - FRESH_MS),
        },
      ]);

      const res = await request(buildApp()).get('/files/fid-fresh/preview');

      expect(mockUpdateFile).not.toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ file_id: 'fid-fresh', status: 'pending' });
    });

    it('sweeps a record past the 2min cutoff but below the 5min boot-sweep threshold', async () => {
      /* Pins the cutoff change from 5min to 2min — without this, a
       * future revert wouldn't fail the suite. */
      const updatedAt = new Date(Date.now() - 3 * 60 * 1000);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-mid',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce({
        file_id: 'fid-mid',
        status: 'failed',
        previewError: 'orphaned',
      });

      const res = await request(buildApp()).get('/files/fid-mid/preview');

      expect(mockUpdateFile).toHaveBeenCalled();
      expect(res.body).toEqual({
        file_id: 'fid-mid',
        status: 'failed',
        previewError: 'orphaned',
      });
    });

    it('does NOT sweep a stale ready record (only pending qualifies)', async () => {
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-ready',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'ready',
          updatedAt: new Date(Date.now() - STALE_MS),
        },
      ]);
      mockFindFileById.mockResolvedValueOnce({
        file_id: 'fid-ready',
        text: 'final',
        textFormat: 'html',
      });

      const res = await request(buildApp()).get('/files/fid-ready/preview');

      expect(mockUpdateFile).not.toHaveBeenCalled();
      expect(res.body).toMatchObject({ status: 'ready', text: 'final' });
    });

    it('falls through to the original pending payload if the conditional sweep loses the race', async () => {
      const updatedAt = new Date(Date.now() - STALE_MS);
      mockGetFiles.mockResolvedValueOnce([
        {
          file_id: 'fid-race',
          user: OWNER_USER_ID,
          filename: 'data.xlsx',
          status: 'pending',
          updatedAt,
        },
      ]);
      mockUpdateFile.mockResolvedValueOnce(null);

      const res = await request(buildApp()).get('/files/fid-race/preview');

      expect(mockUpdateFile).toHaveBeenCalled();
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ file_id: 'fid-race', status: 'pending' });
    });
  });
});
