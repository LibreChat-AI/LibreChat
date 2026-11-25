const express = require('express');
const request = require('supertest');

const mockCallTool = jest.fn((_req, res) => res.status(204).end());

jest.mock('~/server/controllers/tools', () => ({
  callTool: mockCallTool,
  verifyToolAuth: jest.fn(),
  getToolCalls: jest.fn(),
}));
jest.mock('~/server/controllers/PluginController', () => ({
  getAvailableTools: jest.fn(),
}));
jest.mock('~/server/middleware', () => ({
  toolCallLimiter: (_req, _res, next) => next(),
}));

const customPattern = {
  id: 'submitted-content',
  label: 'submitted content',
  regex: 'BLOCK-[A-Z]+',
};

function createApp(config) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.config = config;
    next();
  });
  app.use(require('./tools'));
  return app;
}

describe('direct agent tool-call content filters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks submitted tool arguments before the controller executes them', async () => {
    const response = await request(
      createApp({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [customPattern],
            },
          },
        },
      }),
    )
      .post('/execute_code/call')
      .send({
        messageId: 'message-id',
        conversationId: 'conversation-id',
        code: 'console.log("BLOCK-CODE")',
      });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'arguments',
      }),
    );
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('does not inspect request metadata as tool arguments', async () => {
    const response = await request(
      createApp({
        filters: {
          toolArguments: {
            pii: {
              fields: ['arguments'],
              starterPatterns: [],
              customPatterns: [customPattern],
            },
          },
        },
      }),
    )
      .post('/execute_code/call')
      .send({
        messageId: 'BLOCK-MESSAGE',
        conversationId: 'BLOCK-CONVERSATION',
        code: 'console.log("safe")',
      });

    expect(response.status).toBe(204);
    expect(mockCallTool).toHaveBeenCalledTimes(1);
  });

  it('blocks a submitted tool name before the controller executes it', async () => {
    const response = await request(
      createApp({
        filters: {
          toolArguments: {
            pii: {
              fields: ['name'],
              starterPatterns: [],
              customPatterns: [customPattern],
            },
          },
        },
      }),
    )
      .post('/BLOCK-TOOL/call')
      .send({ code: 'safe' });

    expect(response.status).toBe(400);
    expect(response.body).toEqual(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'name',
      }),
    );
    expect(mockCallTool).not.toHaveBeenCalled();
  });
});
