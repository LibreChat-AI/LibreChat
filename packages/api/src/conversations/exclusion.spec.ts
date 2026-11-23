import { logger } from '@librechat/data-schemas';
import type { FileExclusionResult } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createFileExclusionHandler, createFileExclusionReadHandler } from './exclusion';

jest.mock('@librechat/data-schemas', () => ({
  MAX_EXCLUDED_FILES: 500,
  logger: {
    error: jest.fn(),
  },
}));

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  json: jest.Mock;
}

function mockRequest(body: unknown, conversationId = 'convo-1'): ServerRequest {
  return {
    user: { id: 'user-123' },
    params: { conversationId },
    body,
  } as Partial<ServerRequest> as ServerRequest;
}

function mockResponse(): Response & MockResponse {
  const res: MockResponse = {
    statusCode: 200,
    body: undefined,
    status: jest.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res as unknown as Response & MockResponse;
}

const answering = (result: FileExclusionResult) => jest.fn().mockResolvedValue(result);

describe('createFileExclusionHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('leaves files out for the caller and answers with the whole list', async () => {
    const setConvoFileExclusion = answering({ ok: true, value: ['file-a', 'file-b'] });
    const res = mockResponse();

    await createFileExclusionHandler({ setConvoFileExclusion })(
      mockRequest({ fileIds: ['file-b', 'file-b'], excluded: true }),
      res,
    );

    expect(setConvoFileExclusion).toHaveBeenCalledWith('user-123', 'convo-1', ['file-b'], true);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ excludedFiles: ['file-a', 'file-b'] });
  });

  it('takes files back in', async () => {
    const setConvoFileExclusion = answering({ ok: true, value: [] });
    const res = mockResponse();

    await createFileExclusionHandler({ setConvoFileExclusion })(
      mockRequest({ fileIds: ['file-a'], excluded: false }),
      res,
    );

    expect(setConvoFileExclusion).toHaveBeenCalledWith('user-123', 'convo-1', ['file-a'], false);
    expect(res.body).toEqual({ excludedFiles: [] });
  });

  it.each([
    ['no body', undefined],
    ['no direction', { fileIds: ['file-a'] }],
    ['a direction that is not a boolean', { fileIds: ['file-a'], excluded: 'yes' }],
    ['no files', { fileIds: [], excluded: true }],
    ['a list that is not an array', { fileIds: 'file-a', excluded: true }],
    ['an id that is not a string', { fileIds: ['file-a', 7], excluded: true }],
    ['an empty id', { fileIds: [''], excluded: true }],
    ['an id longer than any the app issues', { fileIds: ['x'.repeat(257)], excluded: true }],
    [
      'more ids than the list can hold',
      { fileIds: Array.from({ length: 501 }, (_, index) => `file-${index}`), excluded: true },
    ],
  ])('refuses %s without touching the conversation', async (_name, body) => {
    const setConvoFileExclusion = answering({ ok: true, value: [] });
    const res = mockResponse();

    await createFileExclusionHandler({ setConvoFileExclusion })(mockRequest(body), res);

    expect(res.statusCode).toBe(400);
    expect(setConvoFileExclusion).not.toHaveBeenCalled();
  });

  it('answers not found for a conversation that is not the caller’s', async () => {
    const res = mockResponse();

    await createFileExclusionHandler({
      setConvoFileExclusion: answering({ ok: false, error: { code: 'not_found' } }),
    })(mockRequest({ fileIds: ['file-a'], excluded: true }), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Conversation not found', code: 'not_found' });
  });

  it('names a full list by a code the client can explain', async () => {
    const res = mockResponse();

    await createFileExclusionHandler({
      setConvoFileExclusion: answering({ ok: false, error: { code: 'limit_exceeded' } }),
    })(mockRequest({ fileIds: ['file-a'], excluded: true }), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ error: 'Too many files are left out', code: 'limit_exceeded' });
  });

  it('answers a storage failure without its details', async () => {
    const failure = new Error('connection string mongodb://user:secret@host');
    const res = mockResponse();

    await createFileExclusionHandler({
      setConvoFileExclusion: jest.fn().mockRejectedValue(failure),
    })(mockRequest({ fileIds: ['file-a'], excluded: true }), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Error updating excluded files' });
    expect(logger.error).toHaveBeenCalledWith('Error updating excluded files', failure);
  });
});

describe('createFileExclusionReadHandler', () => {
  beforeEach(() => jest.clearAllMocks());

  it('answers with the list of the caller’s conversation', async () => {
    const getConvoExcludedFiles = jest.fn().mockResolvedValue(['file-a']);
    const res = mockResponse();

    await createFileExclusionReadHandler({ getConvoExcludedFiles })(mockRequest(undefined), res);

    expect(getConvoExcludedFiles).toHaveBeenCalledWith('convo-1', 'user-123');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ excludedFiles: ['file-a'] });
  });

  it('answers a storage failure without its details', async () => {
    const failure = new Error('connection string mongodb://user:secret@host');
    const res = mockResponse();

    await createFileExclusionReadHandler({
      getConvoExcludedFiles: jest.fn().mockRejectedValue(failure),
    })(mockRequest(undefined), res);

    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ error: 'Error reading excluded files' });
    expect(logger.error).toHaveBeenCalledWith('Error reading excluded files', failure);
  });
});
