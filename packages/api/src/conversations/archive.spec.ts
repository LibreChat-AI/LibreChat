import { logger } from '@librechat/data-schemas';

import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createArchiveAllHandler } from './archive';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

interface MockResponse {
  statusCode: number;
  body: { archivedCount: number } | string | undefined;
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
}

function mockRequest(): ServerRequest {
  return {
    user: { id: 'user-123' },
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
    json: jest.fn((body: MockResponse['body']) => {
      res.body = body;
      return res;
    }),
    send: jest.fn((body: MockResponse['body']) => {
      res.body = body;
      return res;
    }),
  };
  return res as Partial<Response> as Response & MockResponse;
}

describe('createArchiveAllHandler', () => {
  it('archives the authenticated user conversations and returns the result', async () => {
    const archiveAllConvos = jest.fn().mockResolvedValue({ archivedCount: 4 });
    const handler = createArchiveAllHandler({ archiveAllConvos });
    const res = mockResponse();

    await handler(mockRequest(), res);

    expect(archiveAllConvos).toHaveBeenCalledWith('user-123');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ archivedCount: 4 });
  });

  it('logs and returns 500 when archiving fails', async () => {
    const error = new Error('Database error');
    const archiveAllConvos = jest.fn().mockRejectedValue(error);
    const handler = createArchiveAllHandler({ archiveAllConvos });
    const res = mockResponse();

    await handler(mockRequest(), res);

    expect(logger.error).toHaveBeenCalledWith('Error archiving all conversations', error);
    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('Error archiving all conversations');
  });
});
