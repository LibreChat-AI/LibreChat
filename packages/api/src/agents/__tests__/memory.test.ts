import { Response } from 'express';
import { Providers } from '@librechat/agents';
import { Tools } from 'librechat-data-provider';
import { logger } from '@librechat/data-schemas';
import type { MemoryArtifact } from 'librechat-data-provider';
import { createMemoryTool, processMemory } from '../memory';
import Tokenizer from '~/utils/tokenizer';

// Mock the logger
// `winston.format` must be a callable factory (real winston returns a Format
// constructor) so that `@librechat/data-schemas` dist code can complete its
// module-load — see api/test/__mocks__/logger.js for the canonical shape.
jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  })),
  format: Object.assign(
    jest.fn((fn) => () => ({ transform: fn })),
    {
      combine: jest.fn(),
      colorize: jest.fn(),
      simple: jest.fn(),
      label: jest.fn(),
      timestamp: jest.fn(),
      printf: jest.fn(),
      errors: jest.fn(),
      splat: jest.fn(),
      json: jest.fn(),
    },
  ),
  addColors: jest.fn(),
  transports: {
    Console: jest.fn(),
    DailyRotateFile: jest.fn(),
    File: jest.fn(),
  },
}));

// Mock the Tokenizer
jest.mock('~/utils/tokenizer', () => ({
  __esModule: true,
  default: {
    getTokenCount: jest.fn((text: string) => text.length), // Simple mock: 1 char = 1 token
  },
}));

// Mock the Run module
jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Run: {
    create: jest.fn(),
  },
  Providers: {
    OPENAI: 'openai',
    ANTHROPIC: 'anthropic',
    AZURE: 'azure',
  },
  GraphEvents: {
    TOOL_END: 'tool_end',
  },
}));

describe('createMemoryTool', () => {
  let mockSetMemory: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMemory = jest.fn().mockResolvedValue({ ok: true });
  });

  // Memory overflow tests
  describe('overflow handling', () => {
    it('should return error artifact when memory is already overflowing', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 150, // Already over limit
      });

      // Call the underlying function directly since invoke() doesn't handle responseFormat in tests
      const result = await tool.func({ key: 'test', value: 'new memory' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory storage exceeded. Cannot save new memories.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(artifacts[Tools.memory].key).toBe('system');

      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual({
        errorType: 'already_exceeded',
        tokenCount: 50,
        totalTokens: 150,
        tokenLimit: 100,
      });

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should return error artifact when new memory would exceed limit', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 80,
      });

      // This would put us at 101 tokens total, exceeding the limit
      const result = await tool.func({ key: 'test', value: 'This is a 20 char str' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory storage would exceed limit. Cannot save this memory.');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('error');
      expect(artifacts[Tools.memory].key).toBe('system');

      const errorData = JSON.parse(artifacts[Tools.memory].value as string);
      expect(errorData).toEqual({
        errorType: 'would_exceed',
        tokenCount: 1, // Math.abs(-1)
        totalTokens: 101,
        tokenLimit: 100,
      });

      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should successfully save memory when below limit', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        tokenLimit: 100,
        totalTokens: 50,
      });

      const result = await tool.func({ key: 'test', value: 'small memory' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Memory set for key "test" (12 tokens)');

      const artifacts = result[1] as Record<Tools.memory, MemoryArtifact>;
      expect(artifacts[Tools.memory]).toBeDefined();
      expect(artifacts[Tools.memory].type).toBe('update');
      expect(artifacts[Tools.memory].key).toBe('test');
      expect(artifacts[Tools.memory].value).toBe('small memory');

      expect(mockSetMemory).toHaveBeenCalledWith({
        userId: 'test-user',
        key: 'test',
        value: 'small memory',
        tokenCount: 12,
      });
    });
  });

  // Basic functionality tests
  describe('basic functionality', () => {
    it('should validate keys when validKeys is provided', async () => {
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        validKeys: ['allowed', 'keys'],
      });

      const result = await tool.func({ key: 'invalid', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Invalid key "invalid". Must be one of: allowed, keys');
      expect(result[1]).toBeUndefined();
      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('filters invalid keys before logging and never logs submitted content', async () => {
      const protectedValue = 'ORG-PRIVATE-KEY';
      const warn = jest.spyOn(logger, 'warn');
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        validKeys: ['allowed'],
        filters: {
          memories: {
            pii: {
              fields: ['key'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'organization-token',
                  label: 'secret token',
                  regex: 'ORG-[A-Z-]+',
                },
              ],
            },
          },
        },
      });

      const result = await tool.func({ key: protectedValue, value: 'some value' });

      expect(result).toEqual([
        JSON.stringify({
          error: 'content_filter_block',
          message: 'Submitted content was blocked by content policy.',
          source: 'memory',
          field: 'key',
        }),
        undefined,
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(protectedValue);
      expect(mockSetMemory).not.toHaveBeenCalled();
    });

    it('should handle setMemory failure', async () => {
      mockSetMemory.mockResolvedValue({ ok: false });
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
      });

      const result = await tool.func({ key: 'test', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Failed to set memory for key "test"');
      expect(result[1]).toBeUndefined();
    });

    it('should handle exceptions', async () => {
      mockSetMemory.mockRejectedValue(new Error('DB error'));
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
      });

      const result = await tool.func({ key: 'test', value: 'some value' });
      expect(result).toHaveLength(2);
      expect(result[0]).toBe('Error setting memory for key "test"');
      expect(result[1]).toBeUndefined();
    });

    it('should block configured memory content before tokenization or persistence', async () => {
      const onWrite = jest.fn();
      const tokenCount = jest.mocked(Tokenizer.getTokenCount);
      const tool = createMemoryTool({
        userId: 'test-user',
        setMemory: mockSetMemory,
        onWrite,
        filters: {
          memories: {
            pii: {
              fields: ['value'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'organization-token',
                  label: 'secret token',
                  regex: 'ORG-[A-Z]+',
                },
              ],
            },
          },
        },
      });

      tokenCount.mockClear();
      const blocked = await tool.func({ key: 'preferences', value: 'Keep ORG-SECRET' });

      expect(blocked).toEqual([
        JSON.stringify({
          error: 'content_filter_block',
          message: 'Submitted content was blocked by content policy.',
          source: 'memory',
          field: 'value',
        }),
        undefined,
      ]);
      expect(tokenCount).not.toHaveBeenCalled();
      expect(mockSetMemory).not.toHaveBeenCalled();
      expect(onWrite).not.toHaveBeenCalled();

      await tool.func({ key: 'ORG-KEY', value: 'Prefers concise answers' });

      expect(mockSetMemory).toHaveBeenCalledTimes(1);
      expect(mockSetMemory).toHaveBeenCalledWith(
        expect.objectContaining({
          key: 'ORG-KEY',
          value: 'Prefers concise answers',
        }),
      );
    });

    it.each([
      ['bearer_header', 'Authorization: Bearer memory-token', 'Bearer token'],
      ['api_key_header', 'api-key: memory-token', 'api-key header'],
    ] as const)(
      'returns a stable %s block result that can be reused safely',
      async (starterPattern, protectedValue, detectorLabel) => {
        const tool = createMemoryTool({
          userId: 'test-user',
          setMemory: mockSetMemory,
          filters: {
            memories: {
              pii: {
                fields: ['value'],
                starterPatterns: [starterPattern],
              },
            },
          },
        });

        const blocked = await tool.func({ key: 'preferences', value: protectedValue });

        expect(JSON.parse(blocked[0])).toEqual({
          error: 'content_filter_block',
          message: 'Submitted content was blocked by content policy.',
          source: 'memory',
          field: 'value',
        });
        expect(blocked[0]).not.toContain(protectedValue);
        expect(blocked[0]).not.toContain(detectorLabel);
        expect(mockSetMemory).not.toHaveBeenCalled();

        await tool.func({ key: 'policy_result', value: blocked[0] });

        expect(mockSetMemory).toHaveBeenCalledTimes(1);
        expect(mockSetMemory).toHaveBeenCalledWith(
          expect.objectContaining({
            key: 'policy_result',
            value: blocked[0],
          }),
        );
      },
    );
  });
});

describe('processMemory - GPT-5+ handling', () => {
  let mockSetMemory: jest.Mock;
  let mockDeleteMemory: jest.Mock;
  let mockRes: Partial<Response>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockSetMemory = jest.fn().mockResolvedValue({ ok: true });
    mockDeleteMemory = jest.fn().mockResolvedValue({ ok: true });
    mockRes = {
      headersSent: false,
      write: jest.fn(),
    };

    // Setup the Run.create mock
    const { Run } = jest.requireMock('@librechat/agents');
    (Run.create as jest.Mock).mockResolvedValue({
      processStream: jest.fn().mockResolvedValue('Memory processed'),
    });
  });

  it('should enforce memory filters in the automatic processor without changing deletes', async () => {
    const tokenCount = jest.mocked(Tokenizer.getTokenCount);
    tokenCount.mockClear();

    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      filters: {
        memories: {
          pii: {
            fields: ['value'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'organization-token',
                label: 'secret token',
                regex: 'ORG-[A-Z]+',
              },
            ],
          },
        },
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    const [setMemoryTool, deleteMemoryTool] = runConfig.graphConfig.tools;

    const blocked = await setMemoryTool.func({
      key: 'preferences',
      value: 'Keep ORG-SECRET',
    });
    expect(blocked).toEqual([
      JSON.stringify({
        error: 'content_filter_block',
        message: 'Submitted content was blocked by content policy.',
        source: 'memory',
        field: 'value',
      }),
      undefined,
    ]);
    expect(tokenCount).not.toHaveBeenCalled();
    expect(mockSetMemory).not.toHaveBeenCalled();

    await deleteMemoryTool.func({ key: 'preferences' });
    expect(mockDeleteMemory).toHaveBeenCalledWith({
      userId: 'test-user',
      key: 'preferences',
      agentId: undefined,
    });
  });

  it('should remove temperature for GPT-5 models', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        temperature: 0.7, // This should be removed
        maxTokens: 1000, // This should be moved to modelKwargs
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_completion_tokens: 1000,
            },
          }),
        }),
      }),
    );

    // Verify temperature was removed
    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(callArgs.graphConfig.llmConfig.maxTokens).toBeUndefined();
  });

  it('should handle GPT-5+ models with existing modelKwargs', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-6',
        temperature: 0.8,
        maxTokens: 2000,
        modelKwargs: {
          customParam: 'value',
        },
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-6',
            modelKwargs: {
              customParam: 'value',
              max_completion_tokens: 2000,
            },
          }),
        }),
      }),
    );

    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(callArgs.graphConfig.llmConfig.maxTokens).toBeUndefined();
  });

  it('should not modify non-GPT-5+ models', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-4',
        temperature: 0.7,
        maxTokens: 1000,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-4',
            temperature: 0.7,
            maxTokens: 1000,
          }),
        }),
      }),
    );

    // Verify nothing was moved to modelKwargs for GPT-4
    const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
    expect(callArgs.graphConfig.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should handle various GPT-5+ model formats', async () => {
    const testCases = [
      { model: 'gpt-5', shouldTransform: true },
      { model: 'gpt-5-turbo', shouldTransform: true },
      { model: 'gpt-7-preview', shouldTransform: true },
      { model: 'gpt-9', shouldTransform: true },
      { model: 'gpt-4o', shouldTransform: false },
      { model: 'gpt-3.5-turbo', shouldTransform: false },
    ];

    for (const { model, shouldTransform } of testCases) {
      jest.clearAllMocks();
      const { Run } = jest.requireMock('@librechat/agents');
      (Run.create as jest.Mock).mockResolvedValue({
        processStream: jest.fn().mockResolvedValue('Memory processed'),
      });

      await processMemory({
        res: mockRes as Response,
        userId: 'test-user',
        setMemory: mockSetMemory,
        deleteMemory: mockDeleteMemory,
        messages: [],
        memory: 'Test memory',
        messageId: 'msg-123',
        conversationId: 'conv-123',
        instructions: 'Test instructions',
        llmConfig: {
          provider: Providers.OPENAI,
          model,
          temperature: 0.5,
          maxTokens: 1500,
        },
      });

      const callArgs = (Run.create as jest.Mock).mock.calls[0][0];
      const llmConfig = callArgs.graphConfig.llmConfig;

      if (shouldTransform) {
        expect(llmConfig.temperature).toBeUndefined();
        expect(llmConfig.maxTokens).toBeUndefined();
        expect(llmConfig.modelKwargs?.max_completion_tokens).toBe(1500);
      } else {
        expect(llmConfig.temperature).toBe(0.5);
        expect(llmConfig.maxTokens).toBe(1500);
        expect(llmConfig.modelKwargs).toBeUndefined();
      }
    }
  });

  it('should use default model (gpt-4.1-mini) without temperature removal when no llmConfig provided', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      // No llmConfig provided
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-4.1-mini',
            temperature: 0.4, // Default temperature should remain
            maxRetries: 0,
          }),
        }),
      }),
    );
  });

  it('should use max_output_tokens when useResponsesApi is true', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        maxTokens: 1000,
        useResponsesApi: true,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_output_tokens: 1000,
            },
          }),
        }),
      }),
    );
  });

  it('should use max_completion_tokens when useResponsesApi is false or undefined', async () => {
    await processMemory({
      res: mockRes as Response,
      userId: 'test-user',
      setMemory: mockSetMemory,
      deleteMemory: mockDeleteMemory,
      messages: [],
      memory: 'Test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      instructions: 'Test instructions',
      llmConfig: {
        provider: Providers.OPENAI,
        model: 'gpt-5',
        maxTokens: 1000,
        useResponsesApi: false,
      },
    });

    const { Run } = jest.requireMock('@librechat/agents');
    expect(Run.create).toHaveBeenCalledWith(
      expect.objectContaining({
        graphConfig: expect.objectContaining({
          llmConfig: expect.objectContaining({
            model: 'gpt-5',
            modelKwargs: {
              max_completion_tokens: 1000,
            },
          }),
        }),
      }),
    );
  });
});
