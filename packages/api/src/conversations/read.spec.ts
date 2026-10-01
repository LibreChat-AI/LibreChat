import { logger } from '@librechat/data-schemas';

import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createMarkConvoSeenHandler, createMarkConvoUnreadHandler } from './read';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

interface MockResponse {
  statusCode: number;
  body: unknown;
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
}

function mockRequest(arg?: Record<string, unknown>): ServerRequest {
  return {
    user: { id: 'user-123' },
    body: arg === undefined ? undefined : { arg },
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
    send: jest.fn((body: unknown) => {
      res.body = body;
      return res;
    }),
  };
  return res as Response & MockResponse;
}

describe('createMarkConvoSeenHandler', () => {
  beforeEach(() => {
    (logger.error as jest.Mock).mockClear();
  });

  it('records the catch-up for the authenticated user', async () => {
    const markConvoSeen = jest.fn().mockResolvedValue({ modified: true });
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(
      mockRequest({ conversationId: 'conv-1' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ modified: true });
    expect(markConvoSeen).toHaveBeenCalledWith('user-123', 'conv-1', undefined);
  });

  it('forwards the observed reply so a newer one is not acknowledged with it', async () => {
    const markConvoSeen = jest.fn().mockResolvedValue({ modified: false });
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(
      mockRequest({ conversationId: 'conv-1', lastResponseAt: '2026-08-16T10:00:00.000Z' }),
      res,
    );

    expect(markConvoSeen).toHaveBeenCalledWith(
      'user-123',
      'conv-1',
      new Date('2026-08-16T10:00:00.000Z'),
    );
  });

  it('rejects a missing conversationId without touching the database', async () => {
    const markConvoSeen = jest.fn();
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(mockRequest({}), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'conversationId is required' });
    expect(markConvoSeen).not.toHaveBeenCalled();
  });

  it('rejects an unparseable lastResponseAt without touching the database', async () => {
    const markConvoSeen = jest.fn();
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(
      mockRequest({ conversationId: 'conv-1', lastResponseAt: 'not-a-date' }),
      res,
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'lastResponseAt must be a valid date' });
    expect(markConvoSeen).not.toHaveBeenCalled();
  });

  it('tolerates a request with no arg at all', async () => {
    const markConvoSeen = jest.fn();
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(mockRequest(), res);

    expect(res.statusCode).toBe(400);
    expect(markConvoSeen).not.toHaveBeenCalled();
  });

  it('returns 500 when the database write fails', async () => {
    const markConvoSeen = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const res = mockResponse();

    await createMarkConvoSeenHandler({ markConvoSeen })(
      mockRequest({ conversationId: 'conv-1' }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('Error marking conversation seen');
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('createMarkConvoUnreadHandler', () => {
  beforeEach(() => {
    (logger.error as jest.Mock).mockClear();
  });

  it('flags the conversation and returns the marker the server settled on', async () => {
    const markConvoUnread = jest.fn().mockResolvedValue({
      modified: true,
      lastResponseAt: new Date('2026-08-16T10:00:00.000Z'),
      lastResponseMessageId: 'reply-1',
    });
    const res = mockResponse();

    await createMarkConvoUnreadHandler({ markConvoUnread })(
      mockRequest({ conversationId: 'conv-1' }),
      res,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({
      modified: true,
      lastResponseAt: new Date('2026-08-16T10:00:00.000Z'),
      lastResponseMessageId: 'reply-1',
    });
    expect(markConvoUnread).toHaveBeenCalledWith('user-123', 'conv-1');
  });

  it('rejects a missing conversationId without touching the database', async () => {
    const markConvoUnread = jest.fn();
    const res = mockResponse();

    await createMarkConvoUnreadHandler({ markConvoUnread })(mockRequest({}), res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'conversationId is required' });
    expect(markConvoUnread).not.toHaveBeenCalled();
  });

  it('returns 500 when the database write fails', async () => {
    const markConvoUnread = jest.fn().mockRejectedValue(new Error('db unavailable'));
    const res = mockResponse();

    await createMarkConvoUnreadHandler({ markConvoUnread })(
      mockRequest({ conversationId: 'conv-1' }),
      res,
    );

    expect(res.statusCode).toBe(500);
    expect(res.body).toBe('Error marking conversation unread');
    expect(logger.error).toHaveBeenCalled();
  });
});
