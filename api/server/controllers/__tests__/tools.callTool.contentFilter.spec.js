const mockInvoke = jest.fn();
const mockCreateToolCall = jest.fn(() => Promise.resolve());
const mockPrepareCodeOutputForInspection = jest.fn();
const mockProcessCodeOutput = jest.fn();

jest.mock('nanoid', () => ({
  nanoid: () => 'tool-call-id',
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  checkAccess: jest.fn(async () => true),
  loadWebSearchAuth: jest.fn(),
}));

jest.mock('~/models', () => ({
  createToolCall: mockCreateToolCall,
  getRoleByName: jest.fn(),
  getToolCallsByConvo: jest.fn(),
  getMessage: jest.fn(async () => ({ messageId: 'message-id', conversationId: 'conversation-id' })),
}));

jest.mock('~/server/services/Files/process', () => ({
  processFileURL: jest.fn(),
  uploadImageBuffer: jest.fn(),
}));

jest.mock('~/server/services/Files/retention', () => ({
  getRetentionExpiry: jest.fn(async () => ({})),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  processCodeOutput: mockProcessCodeOutput,
  runPreviewFinalize: jest.fn(),
  prepareCodeOutputForInspection: mockPrepareCodeOutputForInspection,
}));

jest.mock('~/server/services/Tools/credentials', () => ({
  loadAuthValues: jest.fn(),
}));

jest.mock('~/app/clients/tools/util', () => ({
  loadTools: jest.fn(async () => ({
    loadedTools: [{ invoke: mockInvoke }],
  })),
}));

const { callTool } = require('../tools');
const { logger: mockLogger } = require('@librechat/data-schemas');

const customPattern = {
  id: 'generated-content',
  label: 'generated content',
  regex: 'BLOCK-[A-Z]+',
};

function createRequest(filters, fileConfig = {}) {
  return {
    params: { toolId: 'execute_code' },
    body: {
      code: 'print("safe")',
      messageId: 'message-id',
      conversationId: 'conversation-id',
      partIndex: 0,
      blockIndex: 0,
    },
    config: {
      filters,
      fileConfig,
      fileStrategy: 'local',
      imageOutputType: 'png',
      webSearch: {},
    },
    user: {
      id: 'user-id',
      tenantId: 'tenant-id',
    },
  };
}

function createResponse() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
}

describe('callTool generated-content protection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrepareCodeOutputForInspection.mockImplementation(async ({ name }) => ({
      buffer: Buffer.from(`safe ${name}`),
      extractedTextComplete: true,
      file: {
        name,
        filename: name,
        type: 'text/plain',
        content: `safe ${name}`,
        extractedText: `safe ${name}`,
      },
    }));
    mockProcessCodeOutput.mockResolvedValue({
      file: { file_id: 'persisted-file', filename: 'safe.txt' },
    });
  });

  it('starts retention before tool invocation using the authenticated message conversation', async () => {
    const { getRetentionExpiry } = require('~/server/services/Files/retention');
    const { getMessage } = require('~/models');
    let resolveRetention;
    const expiredAt = new Date('2030-01-01T00:00:00.000Z');
    getMessage.mockResolvedValueOnce({
      messageId: 'message-id',
      conversationId: 'conversation-id',
      isTemporary: true,
      expiredAt,
    });
    getRetentionExpiry.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetention = resolve;
        }),
    );
    mockInvoke.mockImplementationOnce(async () => {
      expect(getRetentionExpiry).toHaveBeenCalledTimes(1);
      resolveRetention({ expiredAt });
      return { content: 'safe output' };
    });
    const req = createRequest(undefined);
    req.body.conversationId = 'forged-conversation';
    const res = createResponse();
    await callTool(req, res);
    expect(req.body.conversationId).toBe('conversation-id');
    expect(req.fileRetentionSource).toEqual({ isTemporary: true, expiredAt });
    expect(mockCreateToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-id',
        expiredAt,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('rejects an expired source message before loading or invoking a tool', async () => {
    const { getMessage } = require('~/models');
    const { loadTools } = require('~/app/clients/tools/util');
    const { getRetentionExpiry } = require('~/server/services/Files/retention');
    getMessage.mockResolvedValueOnce({
      messageId: 'message-id',
      conversationId: 'conversation-id',
      isTemporary: true,
      expiredAt: new Date(Date.now() - 1000),
    });
    const req = createRequest(undefined);
    req.body.isTemporary = false;
    const res = createResponse();
    await callTool(req, res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(loadTools).not.toHaveBeenCalled();
    expect(mockInvoke).not.toHaveBeenCalled();
    expect(getRetentionExpiry).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
  });

  it('blocks a configured tool output before tool-call persistence', async () => {
    mockInvoke.mockResolvedValue({ content: 'BLOCK-OUTPUT' });
    const res = createResponse();

    await callTool(
      createRequest({
        toolArguments: {
          pii: {
            fields: ['output'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'output',
      }),
    );
    expect(mockPrepareCodeOutputForInspection).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('does not traverse direct tool output when output filtering is inactive', async () => {
    const ownKeys = jest.fn(() => {
      throw new Error('output must not be traversed');
    });
    const output = new Proxy({}, { ownKeys });
    mockInvoke.mockResolvedValue({ content: output });
    const res = createResponse();

    await callTool(createRequest(undefined), res);

    expect(ownKeys).not.toHaveBeenCalled();
    expect(mockCreateToolCall).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('inspects partial direct-output fragments before reporting a traversal limit', async () => {
    const output = { value: 'BLOCK-OUTPUT' };
    let cursor = output;
    for (let index = 0; index < 30; index++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.loop = output;
    mockInvoke.mockResolvedValue({ content: output });
    const res = createResponse();

    await callTool(
      createRequest({
        toolArguments: {
          pii: {
            fields: ['output'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'tool_argument',
        field: 'output',
      }),
    );
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('reports direct-output traversal failures with the output field scope', async () => {
    const output = { value: 'safe' };
    let cursor = output;
    for (let index = 0; index < 30; index++) {
      cursor.next = {};
      cursor = cursor.next;
    }
    cursor.loop = output;
    mockInvoke.mockResolvedValue({ content: output });
    const res = createResponse();

    await callTool(
      createRequest({
        toolArguments: {
          pii: {
            fields: ['output'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      message: 'Submitted content could not be completely inspected before processing.',
      source: 'tool_argument',
      field: 'output',
    });
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('blocks generated file metadata before downloading or persisting it', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'file-id', name: 'BLOCK-FILE.txt' }],
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'file',
        field: 'name',
      }),
    );
    expect(mockPrepareCodeOutputForInspection).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('preflights every artifact and persists none when one file content is blocked', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'safe-file', name: 'safe.txt' },
          { id: 'blocked-file', name: 'blocked.txt' },
        ],
      },
    });
    mockPrepareCodeOutputForInspection
      .mockResolvedValueOnce({
        buffer: Buffer.from('safe'),
        file: {
          filename: 'safe.txt',
          type: 'text/plain',
          content: 'safe',
          extractedText: 'safe',
        },
      })
      .mockResolvedValueOnce({
        buffer: Buffer.from('BLOCK-CONTENT'),
        file: {
          filename: 'blocked.txt',
          type: 'text/plain',
          content: 'BLOCK-CONTENT',
          extractedText: 'BLOCK-CONTENT',
        },
      });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'file',
        field: 'content',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('blocks a late extracted-text match beyond the persisted preview cache', async () => {
    const extractedText = `${'a'.repeat(512 * 1024 + 1024)}BLOCK-LATE`;
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'large-text', name: 'large.txt' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from(extractedText),
      extractedTextComplete: true,
      file: {
        filename: 'large.txt',
        type: 'text/plain',
        extractedText,
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [customPattern],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'file',
        field: 'extracted_text',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('blocks text bytes reported from an artifact with a spoofed image filename', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'spoofed-image', name: 'secret.png' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from('BLOCK-CONTENT'),
      extractedTextComplete: true,
      file: {
        filename: 'secret.png',
        type: 'text/plain',
        content: 'BLOCK-CONTENT',
        extractedText: 'BLOCK-CONTENT',
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_block',
        source: 'file',
        field: 'content',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('fails closed on a partial office or document extraction before persistence', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'office-file', name: 'report.docx' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from('PK'),
      extractedTextComplete: false,
      file: {
        filename: 'report.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: '<html><body>safe partial preview</body></html>',
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [customPattern],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'extracted_text',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('allows a safe partial extraction when uninspectable compatibility mode is selected', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'office-file', name: 'report.docx' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from('PK'),
      extractedTextComplete: false,
      file: {
        filename: 'report.docx',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        extractedText: '<html><body>safe partial preview</body></html>',
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [customPattern],
            uninspectable: 'allow',
          },
        },
      }),
      res,
    );

    expect(mockProcessCodeOutput).toHaveBeenCalledTimes(1);
    expect(mockCreateToolCall).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('keeps compatibility-mode preflight diagnostics free of submitted values', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'file-id', name: 'PRIVATE-FILENAME.txt' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockRejectedValue(new Error('PRIVATE-DOWNLOAD-ERROR'));
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [customPattern],
            uninspectable: 'allow',
          },
        },
      }),
      res,
    );

    expect(mockProcessCodeOutput).toHaveBeenCalledTimes(1);
    expect(mockProcessCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ downloadFallback: true, preparedBuffer: undefined }),
    );
    /* The cause rides the warning so the failure is diagnosable at all, but
     * only through `getSafeErrorMetadata` — the upstream message here is
     * `PRIVATE-DOWNLOAD-ERROR`, and that is precisely what must not appear. */
    expect(mockLogger.warn).toHaveBeenCalledWith(
      '[preflightCodeOutputBatch] Generated artifact 1 could not be inspected',
      { type: 'Error' },
    );
    expect(JSON.stringify(mockLogger.warn.mock.calls)).not.toContain('PRIVATE-');
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails closed before persistence when generated file text is unavailable', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'binary-file', name: 'binary.dat' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from([0, 1, 2]),
      file: {
        filename: 'binary.dat',
        type: 'application/octet-stream',
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: 'content_filter_uninspectable',
      message: 'Submitted file content could not be inspected before processing.',
      source: 'file',
      field: 'extracted_text',
    });
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('fails closed before download or persistence when the configured artifact count is exceeded', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt' },
          { id: 'file-two', name: 'two.txt' },
          { id: 'file-three', name: 'three.txt' },
        ],
      },
    });
    const res = createResponse();

    await callTool(
      createRequest(
        {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [customPattern],
              uninspectable: 'block',
            },
          },
        },
        { endpoints: { agents: { fileLimit: 2 } } },
      ),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'content',
      }),
    );
    expect(mockPrepareCodeOutputForInspection).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('rejects active-policy count overflow even in uninspectable compatibility mode', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt' },
          { id: 'file-two', name: 'two.txt' },
          { id: 'file-three', name: 'three.txt' },
        ],
      },
    });
    const res = createResponse();

    await callTool(
      createRequest(
        {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [customPattern],
              uninspectable: 'allow',
            },
          },
        },
        { endpoints: { agents: { fileLimit: 2 } } },
      ),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'content',
      }),
    );
  });

  it('uses bounded URL fallbacks when default-off artifact count exceeds the limit', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt' },
          { id: 'file-two', name: 'two.txt' },
          { id: 'file-three', name: 'three.txt' },
        ],
      },
    });
    const res = createResponse();

    await callTool(
      createRequest(undefined, { endpoints: { agents: { fileLimit: 1, totalSizeLimit: 0 } } }),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).not.toHaveBeenCalled();
    expect(mockProcessCodeOutput).toHaveBeenCalledTimes(1);
    for (const [params] of mockProcessCodeOutput.mock.calls) {
      expect(params).toEqual(
        expect.objectContaining({
          preparedBuffer: undefined,
          downloadFallback: true,
        }),
      );
    }
    expect(mockCreateToolCall).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('fails closed with zero persistence when prepared buffers exceed the aggregate byte cap', async () => {
    const firstBuffer = Buffer.alloc(600 * 1024, 1);
    const secondBuffer = Buffer.alloc(600 * 1024, 2);
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt' },
          { id: 'file-two', name: 'two.txt' },
        ],
      },
    });
    mockPrepareCodeOutputForInspection
      .mockResolvedValueOnce({
        buffer: firstBuffer,
        extractedTextComplete: true,
        file: {
          filename: 'one.txt',
          type: 'text/plain',
          content: 'safe one',
          extractedText: 'safe one',
        },
      })
      .mockResolvedValueOnce({
        buffer: secondBuffer,
        extractedTextComplete: true,
        file: {
          filename: 'two.txt',
          type: 'text/plain',
          content: 'safe two',
          extractedText: 'safe two',
        },
      });
    const res = createResponse();

    await callTool(
      createRequest(
        {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [customPattern],
              uninspectable: 'block',
            },
          },
        },
        { endpoints: { agents: { totalSizeLimit: 1 } } },
      ),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledTimes(2);
    expect(mockPrepareCodeOutputForInspection).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        id: 'file-two',
        maxBytes: 424 * 1024,
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'content',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('rejects active-policy aggregate overflow before any persistence', async () => {
    const firstBuffer = Buffer.alloc(600 * 1024, 1);
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt' },
          { id: 'file-two', name: 'two.txt' },
        ],
      },
    });
    mockPrepareCodeOutputForInspection
      .mockResolvedValueOnce({
        buffer: firstBuffer,
        extractedTextComplete: true,
        file: {
          filename: 'one.txt',
          type: 'text/plain',
          content: 'safe one',
          extractedText: 'safe one',
        },
      })
      .mockResolvedValueOnce({
        buffer: Buffer.alloc(600 * 1024, 2),
        extractedTextComplete: true,
        file: {
          filename: 'two.txt',
          type: 'text/plain',
          content: 'safe two',
          extractedText: 'safe two',
        },
      });
    const res = createResponse();

    await callTool(
      createRequest(
        {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [customPattern],
              uninspectable: 'allow',
            },
          },
        },
        { endpoints: { agents: { totalSizeLimit: 1 } } },
      ),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledTimes(2);
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'content',
      }),
    );
  });

  it('sniffs a known non-audio artifact before treating transcript policy as inapplicable', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'text-file', name: 'notes.txt' }],
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['transcript'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'text-file',
        inspectContent: true,
      }),
    );
    expect(mockProcessCodeOutput).toHaveBeenCalledTimes(1);
    expect(mockProcessCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({ preparedBuffer: Buffer.from('safe notes.txt') }),
    );
    expect(mockCreateToolCall).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('still fails closed when an audio transcript cannot be prepared', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'audio-file', name: 'recording.wav' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockRejectedValue(new Error('download failed'));
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['transcript'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'transcript',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('fails closed when a text-named artifact sniffs as audio without a transcript', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe',
      artifact: {
        session_id: 'session-id',
        files: [{ id: 'spoofed-audio', name: 'recording.txt' }],
      },
    });
    mockPrepareCodeOutputForInspection.mockResolvedValue({
      buffer: Buffer.from('RIFF'),
      file: {
        filename: 'recording.txt',
        type: 'audio/wav',
      },
    });
    const res = createResponse();

    await callTool(
      createRequest({
        files: {
          pii: {
            fields: ['transcript'],
            starterPatterns: [],
            customPatterns: [],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'content_filter_uninspectable',
        source: 'file',
        field: 'transcript',
      }),
    );
    expect(mockProcessCodeOutput).not.toHaveBeenCalled();
    expect(mockCreateToolCall).not.toHaveBeenCalled();
  });

  it('persists safe files only after the full artifact preflight completes', async () => {
    mockInvoke.mockResolvedValue({
      content: 'safe output',
      artifact: {
        session_id: 'session-id',
        files: [
          { id: 'file-one', name: 'one.txt', storage_session_id: 'file-session-id' },
          { id: 'file-two', name: 'two.txt' },
        ],
      },
    });
    let activePreflights = 0;
    let maxActivePreflights = 0;
    let activePersistence = 0;
    let maxActivePersistence = 0;
    mockPrepareCodeOutputForInspection.mockImplementation(async ({ name }) => {
      activePreflights++;
      maxActivePreflights = Math.max(maxActivePreflights, activePreflights);
      await Promise.resolve();
      activePreflights--;
      return {
        buffer: Buffer.from(`safe ${name}`),
        extractedTextComplete: true,
        file: {
          filename: name,
          type: 'text/plain',
          content: `safe ${name}`,
          extractedText: `safe ${name}`,
        },
      };
    });
    mockProcessCodeOutput.mockImplementation(async ({ name }) => {
      activePersistence++;
      maxActivePersistence = Math.max(maxActivePersistence, activePersistence);
      await Promise.resolve();
      activePersistence--;
      return {
        file: { file_id: `persisted-${name}`, filename: name },
      };
    });
    const res = createResponse();

    await callTool(
      createRequest({
        toolArguments: {
          pii: {
            fields: ['output'],
            starterPatterns: [],
            customPatterns: [customPattern],
          },
        },
        files: {
          pii: {
            fields: ['name', 'content', 'extracted_text'],
            starterPatterns: [],
            customPatterns: [customPattern],
            uninspectable: 'block',
          },
        },
      }),
      res,
    );

    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledTimes(2);
    expect(maxActivePreflights).toBe(1);
    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-one',
        session_id: 'file-session-id',
      }),
    );
    expect(mockProcessCodeOutput).toHaveBeenCalledTimes(2);
    expect(maxActivePersistence).toBe(1);
    const lastPreflightOrder = Math.max(
      ...mockPrepareCodeOutputForInspection.mock.invocationCallOrder,
    );
    const firstPersistenceOrder = Math.min(...mockProcessCodeOutput.mock.invocationCallOrder);
    expect(lastPreflightOrder).toBeLessThan(firstPersistenceOrder);
    expect(mockProcessCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-one',
        name: 'one.txt',
        session_id: 'file-session-id',
        preparedBuffer: Buffer.from('safe one.txt'),
      }),
    );
    expect(mockPrepareCodeOutputForInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-two',
        session_id: 'session-id',
      }),
    );
    expect(mockProcessCodeOutput).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'file-two',
        session_id: 'session-id',
        preparedBuffer: Buffer.from('safe two.txt'),
      }),
    );
    expect(mockCreateToolCall).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      result: 'safe output',
      attachments: [
        { file_id: 'persisted-one.txt', filename: 'one.txt' },
        { file_id: 'persisted-two.txt', filename: 'two.txt' },
      ],
    });
  });
});
