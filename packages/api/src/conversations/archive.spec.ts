import express from 'express';
import request from 'supertest';
import { logger } from '@librechat/data-schemas';
import { RetentionMode } from 'librechat-data-provider';

import type { AppConfig, ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { createArchiveAllHandler, createArchiveHandler } from './archive';

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

type ArchiveHandler = ReturnType<typeof createArchiveHandler>;
type ArchiveRequest = Parameters<ArchiveHandler>[0];
type SaveConvo = ConversationMethods['saveConvo'];

const storedRetention = { isTemporary: true, expiredAt: new Date('2030-01-01T00:00:00.000Z') };
const ephemeral: AppConfig['interfaceConfig'] = {
  retentionMode: RetentionMode.EPHEMERAL,
  temporaryChatRetention: 24,
};
const arg = { conversationId: 'chat', isArchived: true };

function setupArchive(
  options: {
    /** What the access check left on the request: a stored row, `null`, or nothing at all. */
    resolved?: ArchiveRequest['resolvedConversation'];
    interfaceConfig?: AppConfig['interfaceConfig'];
    authenticated?: boolean;
  } = {},
) {
  const deps = {
    saveConvo: jest
      .fn<ReturnType<SaveConvo>, Parameters<SaveConvo>>()
      .mockResolvedValue({ conversationId: 'chat', isArchived: true } as Awaited<
        ReturnType<SaveConvo>
      >),
    getConvoRetention: jest.fn().mockResolvedValue(storedRetention),
  };
  const handler = createArchiveHandler(deps);
  const app = express();
  app.use(express.json());
  app.post('/archive', async (req, res) => {
    await handler(
      {
        body: req.body,
        user: options.authenticated === false ? undefined : { id: 'owner' },
        config: { interfaceConfig: options.interfaceConfig } as AppConfig,
        resolvedConversation: options.resolved,
      },
      res,
    );
  });
  return { app, deps };
}

describe('createArchiveHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('saves the flag with the stored retention fields and the config, as a metadata-only write', async () => {
    const { app, deps } = setupArchive({ resolved: storedRetention, interfaceConfig: ephemeral });

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ conversationId: 'chat', isArchived: true });
    expect(deps.saveConvo).toHaveBeenCalledWith(
      { userId: 'owner', ...storedRetention, interfaceConfig: ephemeral },
      { conversationId: 'chat', isArchived: true },
      {
        context: 'POST /api/convos/archive chat',
        preserveUpdatedAt: true,
        noUpsert: true,
        appendMessageIds: [],
      },
    );
  });

  it('unarchives with the same write and leaves archivedAt to the save', async () => {
    const { app, deps } = setupArchive({ resolved: storedRetention });

    const response = await request(app)
      .post('/archive')
      .send({ arg: { conversationId: 'chat', isArchived: false } });

    expect(response.status).toBe(200);
    expect(deps.saveConvo.mock.calls[0][1]).toEqual({ conversationId: 'chat', isArchived: false });
  });

  describe('when the access check read nothing', () => {
    it.each([
      ['ephemeral', ephemeral],
      [
        'all with a general deadline',
        { retentionMode: RetentionMode.ALL, temporaryChatRetention: 1, generalChatRetention: 24 },
      ],
      ['all without one', { retentionMode: RetentionMode.ALL, temporaryChatRetention: 24 }],
    ] as Array<[string, AppConfig['interfaceConfig']]>)(
      'keeps the stored deadline under %s',
      async (_name, interfaceConfig) => {
        const { app, deps } = setupArchive({ interfaceConfig });

        const response = await request(app).post('/archive').send({ arg });

        expect(response.status).toBe(200);
        expect(deps.getConvoRetention).toHaveBeenCalledWith('owner', 'chat');
        expect(deps.saveConvo).toHaveBeenCalledWith(
          { userId: 'owner', ...storedRetention, interfaceConfig },
          expect.anything(),
          expect.anything(),
        );
      },
    );

    it.each([
      ['no retention mode', undefined],
      ['the temporary mode', { retentionMode: RetentionMode.TEMPORARY }],
    ] as Array<[string, AppConfig['interfaceConfig']]>)(
      'reads nothing under %s',
      async (_name, interfaceConfig) => {
        const { app, deps } = setupArchive({ interfaceConfig });

        await request(app).post('/archive').send({ arg });

        expect(deps.getConvoRetention).not.toHaveBeenCalled();
        expect(deps.saveConvo).toHaveBeenCalledWith(
          { userId: 'owner', isTemporary: undefined, expiredAt: undefined, interfaceConfig },
          expect.anything(),
          expect.anything(),
        );
      },
    );

    it('saves without retention fields when the conversation has no stored row', async () => {
      const { app, deps } = setupArchive({ interfaceConfig: ephemeral });
      deps.getConvoRetention.mockResolvedValue(null);
      deps.saveConvo.mockResolvedValue(null);

      const response = await request(app).post('/archive').send({ arg });

      expect(response.status).toBe(404);
      expect(deps.saveConvo).toHaveBeenCalledWith(
        {
          userId: 'owner',
          isTemporary: undefined,
          expiredAt: undefined,
          interfaceConfig: ephemeral,
        },
        expect.anything(),
        expect.anything(),
      );
    });
  });

  it.each([
    ['a stored row', storedRetention],
    ['no row', null],
  ])('does not read again when the access check resolved %s', async (_name, resolved) => {
    const { app, deps } = setupArchive({ resolved, interfaceConfig: ephemeral });

    await request(app).post('/archive').send({ arg });

    expect(deps.getConvoRetention).not.toHaveBeenCalled();
  });

  it('answers 404 when the conversation does not exist', async () => {
    const { app, deps } = setupArchive({ resolved: null });
    deps.saveConvo.mockResolvedValue(null);

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Conversation not found' });
  });

  it.each([
    ['an empty arg', {}, 'conversationId is required'],
    ['no conversationId', { isArchived: true }, 'conversationId is required'],
    [
      'an operator as the id',
      { conversationId: { $ne: '' }, isArchived: true },
      'conversationId is required',
    ],
    [
      'a string flag',
      { conversationId: 'chat', isArchived: 'true' },
      'isArchived must be a boolean',
    ],
    ['no flag', { conversationId: 'chat' }, 'isArchived must be a boolean'],
  ])('answers 400 for %s without saving', async (_name, badArg, error) => {
    const { app, deps } = setupArchive();

    const response = await request(app).post('/archive').send({ arg: badArg });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({ error });
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });

  it('answers 401 without saving when the request has no user', async () => {
    const { app, deps } = setupArchive({ authenticated: false });

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(401);
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });

  it('logs safe metadata and answers 500 without the error text when the save fails', async () => {
    const { app, deps } = setupArchive({ resolved: storedRetention });
    deps.saveConvo.mockRejectedValue(new Error('connection string mongodb://secret'));

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(500);
    expect(response.text).toBe('Error archiving conversation');
    expect(logger.error).toHaveBeenCalledWith('[archive] Conversation archive failed', {
      type: 'Error',
    });
  });

  it('answers 500, not 200, when the save reports a persistence failure', async () => {
    const { app, deps } = setupArchive({ resolved: storedRetention });
    deps.saveConvo.mockResolvedValue({ message: 'Error saving conversation' });

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(500);
    expect(response.text).toBe('Error archiving conversation');
  });

  it('answers 500 without saving when the stored retention fields cannot be read', async () => {
    const { app, deps } = setupArchive({ interfaceConfig: ephemeral });
    deps.getConvoRetention.mockRejectedValue(
      new Error('Error getting conversation retention fields'),
    );

    const response = await request(app).post('/archive').send({ arg });

    expect(response.status).toBe(500);
    expect(deps.saveConvo).not.toHaveBeenCalled();
  });
});
