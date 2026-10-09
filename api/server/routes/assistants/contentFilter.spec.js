const express = require('express');
const request = require('supertest');

const mockChatV1 = jest.fn((_req, res) => res.status(204).end());
const mockChatV2 = jest.fn((_req, res) => res.status(204).end());
const mockCreateAssistantV1 = jest.fn((_req, res) => res.status(201).json({ version: 1 }));
const mockPatchAssistantV1 = jest.fn((_req, res) => res.status(200).json({ version: 1 }));
const mockCreateAssistantV2 = jest.fn((_req, res) => res.status(201).json({ version: 2 }));
const mockPatchAssistantV2 = jest.fn((_req, res) => res.status(200).json({ version: 2 }));

jest.mock('~/server/controllers/assistants/chatV1', () => mockChatV1);
jest.mock('~/server/controllers/assistants/chatV2', () => mockChatV2);
jest.mock('~/server/controllers/assistants/v1', () => ({
  createAssistant: mockCreateAssistantV1,
  patchAssistant: mockPatchAssistantV1,
  retrieveAssistant: jest.fn(),
  deleteAssistant: jest.fn(),
  listAssistants: jest.fn(),
  uploadAssistantAvatar: jest.fn(),
}));
jest.mock('~/server/controllers/assistants/v2', () => ({
  createAssistant: mockCreateAssistantV2,
  patchAssistant: mockPatchAssistantV2,
}));
jest.mock('~/server/middleware', () => ({
  setHeaders: (_req, _res, next) => next(),
  handleAbort: () => (_req, _res, next) => next(),
  validateModel: (_req, _res, next) => next(),
  buildEndpointOption: (_req, _res, next) => next(),
  configMiddleware: (_req, _res, next) => next(),
}));
jest.mock('~/server/middleware/validate/convoAccess', () => (_req, _res, next) => next());
jest.mock('~/server/middleware/assistants/validate', () => (_req, _res, next) => next());
jest.mock('./actions', () => require('express').Router());
jest.mock('./documents', () => require('express').Router());
jest.mock('./tools', () => require('express').Router());

const customPattern = {
  id: 'submitted-content',
  label: 'submitted content',
  regex: 'BLOCK-[A-Z]+',
};

function createApp(router, config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.config = config;
    next();
  });
  app.use(router);
  return app;
}

describe('assistant route content filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['V1', './chatV1', mockChatV1],
    ['V2', './chatV2', mockChatV2],
  ])('blocks generic message content on assistant chat %s', async (_version, route, controller) => {
    const app = createApp(require(route), {
      filters: {
        messages: {
          pii: {
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      },
    });

    const response = await request(app).post('/').send({ text: 'BLOCK-CHAT' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'message',
        field: 'text',
      }),
    );
    expect(controller).not.toHaveBeenCalled();
  });

  it('preserves the legacy assistant chat response', async () => {
    const app = createApp(require('./chatV1'), {
      messageFilter: {
        pii: {
          starterPatterns: [],
          customPatterns: [customPattern],
        },
      },
    });

    const response = await request(app).post('/').send({ text: 'BLOCK-LEGACY' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error: 'message_filter_pii_block',
      message: 'Message contains a submitted content. Remove it and try again.',
    });
    expect(mockChatV1).not.toHaveBeenCalled();
  });

  it('blocks assistant metadata on V1 create before the controller', async () => {
    const app = createApp(require('./v1').v1, {
      filters: {
        agentInstructions: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      },
    });

    const response = await request(app).post('/').send({ name: 'BLOCK-ASSISTANT' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'agent_instruction',
        field: 'name',
      }),
    );
    expect(mockCreateAssistantV1).not.toHaveBeenCalled();
  });

  it.each([
    ['V1', './v1', mockPatchAssistantV1],
    ['V2', './v2', mockPatchAssistantV2],
  ])(
    'allows a safe partial assistant patch on %s while instruction filtering is active',
    async (_version, route, controller) => {
      const module = require(route);
      const app = createApp(module.v1 ?? module, {
        filters: {
          agentInstructions: {
            pii: {
              fields: ['instructions'],
              starterPatterns: [],
              customPatterns: [customPattern],
            },
          },
        },
      });

      const response = await request(app)
        .patch('/assistant-id')
        .send({ description: 'Safe remediation metadata edit.' });

      expect(response.status).toBe(200);
      expect(controller).toHaveBeenCalledTimes(1);
    },
  );

  it('blocks function parameter schemas on V2 patch before the controller', async () => {
    const app = createApp(require('./v2'), {
      filters: {
        toolArguments: {
          pii: {
            fields: ['arguments'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      },
    });

    const response = await request(app)
      .patch('/assistant-id')
      .send({
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Lookup',
              parameters: {
                type: 'object',
                properties: { secret: { description: 'BLOCK-SCHEMA' } },
              },
            },
          },
        ],
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'arguments',
      }),
    );
    expect(mockPatchAssistantV2).not.toHaveBeenCalled();
  });

  it.each([
    ['V1 create', './v1', 'post', '/', mockCreateAssistantV1],
    ['V2 patch', './v2', 'patch', '/assistant-id', mockPatchAssistantV2],
  ])(
    'blocks opaque tool-resource references on %s before the controller',
    async (_label, route, method, path, controller) => {
      const app = createApp(require(route).v1 ?? require(route), {
        filters: {
          files: {
            pii: {
              fields: ['extracted_text'],
              uninspectable: 'block',
            },
          },
        },
      });

      const response = await request(app)
        [method](path)
        .send({ tool_resources: { file_search: { vector_store_ids: ['vs_existing'] } } });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
      });
      expect(controller).not.toHaveBeenCalled();
    },
  );
});
