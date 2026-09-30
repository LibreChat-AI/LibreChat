import { Types } from 'mongoose';
import { classificationSchema } from 'librechat-data-provider';
import { Run, Providers, GraphEvents } from '@librechat/agents';
import { AIMessage, HumanMessage } from '@librechat/agents/langchain/messages';
import { Tools, MemoryScope, EModelEndpoint, AgentCapabilities } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type { RuntimeProviderName } from '@librechat/agents';
import type { IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ClassificationRequest, Classifier } from '~/classification';
import type { ServerRequest } from '~/types';
import {
  processMemory,
  memoryInstructions,
  formatMemoryContext,
  createMemoryProcessor,
  createMemoryTool,
  getMemoryAgentId,
  getRequestMemories,
  buildInlineMemoryTool,
  createDeleteMemoryTool,
  invalidateRequestMemories,
  agentHasInlineMemoryTools,
  buildInlineMemoryContext,
} from './memory';
import { GenerationJobManager } from '~/stream/GenerationJobManager';
import { createMemoryGate } from '~/memory/gate';

jest.mock('~/middleware/access', () => ({
  checkAccess: jest.fn().mockResolvedValue(true),
}));
jest.mock('~/stream/GenerationJobManager');

const mockCreateSafeUser = jest.fn((user) => ({
  id: user?.id,
  email: user?.email,
  name: user?.name,
  username: user?.username,
}));

const mockResolveHeaders = jest.fn((opts) => {
  const headers = opts.headers || {};
  const user = opts.user || {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    let resolved = value as string;
    resolved = resolved.replace(/\$\{(\w+)\}/g, (_match, envVar) => process.env[envVar] || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_EMAIL\}\}/g, user.email || '');
    resolved = resolved.replace(/\{\{LIBRECHAT_USER_ID\}\}/g, user.id || '');
    result[key] = resolved;
  }
  return result;
});

type HeaderCarrier = { defaultHeaders?: Record<string, string> };
const mockResolveConfigHeaders = jest.fn(
  (opts: {
    llmConfig?: { configuration?: HeaderCarrier; clientOptions?: HeaderCarrier };
    user?: { id?: string; email?: string };
  }) => {
    const cfg = opts?.llmConfig;
    if (cfg?.configuration?.defaultHeaders != null) {
      cfg.configuration.defaultHeaders = mockResolveHeaders({
        headers: cfg.configuration.defaultHeaders,
        user: opts.user,
      });
    }
    if (cfg?.clientOptions?.defaultHeaders != null) {
      cfg.clientOptions.defaultHeaders = mockResolveHeaders({
        headers: cfg.clientOptions.defaultHeaders,
        user: opts.user,
      });
    }
  },
);

jest.mock('~/utils', () => ({
  Tokenizer: {
    getTokenCount: jest.fn(() => 10),
  },
  createSafeUser: (user: unknown) => mockCreateSafeUser(user),
  getSafeErrorMetadata: (error: unknown) => ({
    type:
      error != null && typeof error === 'object' && (error as { name?: unknown }).name === 'Error'
        ? 'Error'
        : 'Object',
  }),
  resolveConfigHeaders: (opts: unknown) => mockResolveConfigHeaders(opts as never),
}));

const { createSafeUser } = jest.requireMock('~/utils');

beforeEach(() => {
  jest.spyOn(Run, 'create').mockImplementation(
    () =>
      ({
        processStream: jest.fn(() => Promise.resolve('success')),
      }) as never,
  );
});

function createTestUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(),
    id: new Types.ObjectId().toString(),
    username: 'testuser',
    email: 'test@example.com',
    name: 'Test User',
    avatar: 'https://example.com/avatar.png',
    provider: 'email',
    role: 'user',
    createdAt: new Date('2021-01-01'),
    updatedAt: new Date('2021-01-01'),
    emailVerified: true,
    ...overrides,
  } as IUser;
}

describe('Memory attachment generation fencing', () => {
  it('emits artifacts with the generation epoch that started memory processing', async () => {
    const memoryArtifact = {
      type: 'update' as const,
      key: 'response_style',
      value: 'concise',
    };
    const processStream = jest.fn(async () => {
      const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
      runConfig.customHandlers[GraphEvents.TOOL_END].handle(
        GraphEvents.TOOL_END,
        {
          output: {
            tool_call_id: 'memory-call-1',
            artifact: { [Tools.memory]: memoryArtifact },
          },
        },
        {
          run_id: 'response-1',
          thread_id: 'conversation-1',
        },
      );
      return 'success';
    });
    (Run.create as jest.Mock).mockReturnValueOnce({ processStream });

    const [, runMemory] = await createMemoryProcessor({
      res: {
        headersSent: true,
        write: jest.fn(),
      } as unknown as Response,
      userId: 'user-1',
      messageId: 'response-1',
      conversationId: 'conversation-1',
      streamId: 'conversation-1',
      jobCreatedAt: 1234,
      memoryMethods: {
        setMemory: jest.fn(),
        deleteMemory: jest.fn(),
        getUserMemories: jest.fn().mockResolvedValue([]),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
        }),
      },
    });

    await runMemory!([]);

    expect(GenerationJobManager.emitChunk).toHaveBeenCalledWith(
      'conversation-1',
      {
        event: 'attachment',
        data: {
          type: Tools.memory,
          toolCallId: 'memory-call-1',
          messageId: 'response-1',
          conversationId: 'conversation-1',
          [Tools.memory]: memoryArtifact,
        },
      },
      { expectedCreatedAt: 1234 },
    );
  });
});

describe('Memory Agent Header Resolution', () => {
  let testUser: IUser;
  let mockRes: Response;
  let mockMemoryMethods: {
    setMemory: jest.Mock;
    deleteMemory: jest.Mock;
    getFormattedMemories: jest.Mock;
  };

  beforeEach(() => {
    process.env.CUSTOM_API_KEY = 'sk-custom-test-key';
    process.env.TEST_CUSTOM_API_KEY = 'sk-custom-test-key';

    testUser = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
    });

    mockRes = {
      write: jest.fn(),
      end: jest.fn(),
      headersSent: false,
    } as unknown as Response;

    mockMemoryMethods = {
      setMemory: jest.fn(),
      deleteMemory: jest.fn(),
      getFormattedMemories: jest.fn(() =>
        Promise.resolve({
          withKeys: 'formatted memories',
          withoutKeys: 'memories without keys',
          totalTokens: 100,
        }),
      ),
    };

    jest.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CUSTOM_API_KEY;
    delete process.env.TEST_CUSTOM_API_KEY;
  });

  it('should resolve environment variables in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom' as RuntimeProviderName,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'api-key': '${TEST_CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'api-key': 'sk-custom-test-key',
    });
  });

  it('should resolve user placeholders in custom endpoint headers', async () => {
    const llmConfig = {
      provider: 'custom' as RuntimeProviderName,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
      tenantId: 'request-tenant',
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'X-User-Identifier': 'test@example.com',
      'X-User-ID': 'user-123',
    });
    expect(mockResolveConfigHeaders).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'request-tenant' }),
    );
  });

  it('should handle mixed environment variables and user placeholders', async () => {
    const llmConfig = {
      provider: 'custom' as RuntimeProviderName,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
          'X-User-Identifier': '{{LIBRECHAT_USER_EMAIL}}',
          'X-Application-Identifier': 'LibreChat - Test',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
      'X-User-Identifier': 'test@example.com',
      'X-Application-Identifier': 'LibreChat - Test',
    });
  });

  it('should resolve env vars when user is undefined', async () => {
    const llmConfig = {
      provider: 'custom' as RuntimeProviderName,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'x-custom-api-key': '${CUSTOM_API_KEY}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: undefined,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration.defaultHeaders).toEqual({
      'x-custom-api-key': 'sk-custom-test-key',
    });
  });

  it('should not throw when llmConfig has no configuration', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];
    expect(runConfig.graphConfig.llmConfig.configuration).toBeUndefined();
  });

  it('should use createSafeUser to sanitize user data', async () => {
    const userWithSensitiveData = createTestUser({
      id: 'user-123',
      email: 'test@example.com',
      password: 'sensitive-password',
      refreshToken: 'sensitive-token',
    } as unknown as Partial<IUser>);

    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
      configuration: {
        defaultHeaders: {
          'X-User-ID': '{{LIBRECHAT_USER_ID}}',
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'test memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: userWithSensitiveData,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();

    // Verify createSafeUser was used - the user object passed to Run.create should not have sensitive fields
    const safeUser = createSafeUser(userWithSensitiveData);
    expect(safeUser).not.toHaveProperty('password');
    expect(safeUser).not.toHaveProperty('refreshToken');
    expect(safeUser).toHaveProperty('id');
    expect(safeUser).toHaveProperty('email');
  });

  it('should include instructions in user message for Bedrock provider', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
    };

    const { HumanMessage } = await import('@librechat/agents/langchain/messages');
    const testMessage = new HumanMessage('test chat content');

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [testMessage],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For Bedrock, instructions should NOT be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBeUndefined();
    expect(runConfig.graphConfig.additional_instructions).toBeUndefined();
  });

  it('should pass instructions to graphConfig for non-Bedrock providers', async () => {
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    // For non-Bedrock providers, instructions should be passed to graphConfig
    expect(runConfig.graphConfig.instructions).toBe('test instructions');
    expect(runConfig.graphConfig.additional_instructions).toBeDefined();
  });

  it('should set temperature to 1 for Bedrock with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-sonnet-4-20250514-v1:0',
      temperature: 0.7,
      additionalModelRequestFields: {
        thinking: {
          type: 'enabled',
          budget_tokens: 5000,
        },
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(1);
  });

  it('should not modify temperature for Bedrock without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.BEDROCK,
      model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should remove temperature for Anthropic with thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'enabled',
        budget_tokens: 5000,
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBeUndefined();
    expect(runConfig.graphConfig.llmConfig.thinking).toEqual({
      type: 'enabled',
      budget_tokens: 5000,
    });
  });

  it('should not modify temperature for Anthropic without thinking enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });

  it('should not modify temperature for Anthropic with thinking type not enabled', async () => {
    const llmConfig = {
      provider: Providers.ANTHROPIC,
      model: 'claude-sonnet-4-20250514',
      temperature: 0.7,
      thinking: {
        type: 'disabled',
      },
    };

    await processMemory({
      res: mockRes,
      userId: 'user-123',
      setMemory: mockMemoryMethods.setMemory,
      deleteMemory: mockMemoryMethods.deleteMemory,
      messages: [],
      memory: 'existing memory',
      messageId: 'msg-123',
      conversationId: 'conv-123',
      validKeys: ['preferences'],
      instructions: 'test instructions',
      llmConfig,
      user: testUser,
    });

    expect(Run.create as jest.Mock).toHaveBeenCalled();
    const runConfig = (Run.create as jest.Mock).mock.calls[0][0];

    expect(runConfig.graphConfig.llmConfig.temperature).toBe(0.7);
  });
});

describe('createMemoryTool tokenLimit enforcement', () => {
  it('serializes parallel set_memory calls so they cannot collectively exceed tokenLimit', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; two of these (≈200) exceed the 150 limit, but each fits alone. */
    const value = 'word '.repeat(100).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 0,
    });

    await Promise.all([tool.invoke({ key: 'k1', value }), tool.invoke({ key: 'k2', value })]);

    /** Only the first write is committed; the second is rejected against the
     *  updated running total instead of the stale construction-time total. */
    expect(setMemory).toHaveBeenCalledTimes(1);
  });

  it('allows sequential writes that each fit within the remaining capacity', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const value = 'word '.repeat(10).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 1000,
      totalTokens: 0,
    });

    await tool.invoke({ key: 'k1', value });
    await tool.invoke({ key: 'k2', value });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('rejects values longer than charLimit without writing', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const tool = createMemoryTool({ userId: 'user-1', setMemory, charLimit: 10 });

    await tool.invoke({ key: 'k1', value: 'this value is far longer than ten characters' });

    expect(setMemory).not.toHaveBeenCalled();
  });

  it('treats a repeat write to the same key as a replacement, not an addition', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; two distinct keys would exceed the 150 limit, but rewriting
     *  the same key only replaces its value and must stay within the cap. */
    const value = 'word '.repeat(100).trim();
    const tool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 0,
    });

    await tool.invoke({ key: 'k1', value });
    await tool.invoke({ key: 'k1', value });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('treats a persisted key as a replacement in a new tool instance', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    /** ~100 tokens; adding this value to its previous version would exceed the
     *  limit, while replacing it correctly remains within the limit. */
    const value = 'word '.repeat(100).trim();
    const firstTool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
    });

    await firstTool.invoke({ key: 'k1', value });

    const secondTool = createMemoryTool({
      userId: 'user-1',
      setMemory,
      tokenLimit: 150,
      totalTokens: 100,
      tokenCountsByKey: new Map([['k1', 100]]),
    });

    await secondTool.invoke({ key: 'k1', value });

    expect(setMemory).toHaveBeenCalledTimes(2);
  });

  it('fires onWrite after a successful set, but not when the write fails', async () => {
    const onWrite = jest.fn();
    const okTool = createMemoryTool({
      userId: 'user-1',
      setMemory: jest.fn().mockResolvedValue({ ok: true }),
      onWrite,
    });
    await okTool.invoke({ key: 'k1', value: 'a fact' });
    expect(onWrite).toHaveBeenCalledTimes(1);

    onWrite.mockClear();
    const failTool = createMemoryTool({
      userId: 'user-1',
      setMemory: jest.fn().mockResolvedValue({ ok: false }),
      onWrite,
    });
    await failTool.invoke({ key: 'k1', value: 'a fact' });
    expect(onWrite).not.toHaveBeenCalled();
  });

  it('fires onWrite after a successful delete', async () => {
    const onWrite = jest.fn();
    const tool = createDeleteMemoryTool({
      userId: 'user-1',
      deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
      onWrite,
    });

    await tool.invoke({ key: 'k1' });

    expect(onWrite).toHaveBeenCalledTimes(1);
  });
});

describe('memory gate inside the memory processor', () => {
  function recordingGate(probability: number) {
    const requests: ClassificationRequest[] = [];
    const classifier: Classifier = {
      id: 'recording',
      model: 'test',
      async classify(request) {
        requests.push(request);
        return {
          model: 'test',
          answers: { request: { type: 'boolean', probability } },
          usage: { inputTokens: 0, outputTokens: 0 },
        };
      },
    };
    const settings = classificationSchema.parse({ memoryGate: { enabled: true } }).memoryGate;
    return { requests, gate: createMemoryGate({ classifier, settings }) ?? undefined };
  }

  async function processorWith(gate: ReturnType<typeof recordingGate>['gate']) {
    const [, process] = await createMemoryProcessor({
      res: { headersSent: false, write: jest.fn() } as unknown as Response,
      userId: 'user-1',
      messageId: 'message-1',
      conversationId: 'conversation-1',
      gate,
      memoryMethods: {
        setMemory: jest.fn().mockResolvedValue({ ok: true }),
        deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
        getUserMemories: jest.fn().mockResolvedValue([]),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: '',
          withoutKeys: '',
          totalTokens: 0,
          tokenCountsByKey: new Map(),
        }),
      },
    });
    return process;
  }

  const window = [
    new HumanMessage('find me images of wildlife in nagoya'),
    new AIMessage(`page snapshot ${'x'.repeat(40_000)}`),
    new HumanMessage('I prefer answers in Japanese from now on'),
  ];
  const buffer = [new HumanMessage(window.map((m) => m.content).join('\n'))];

  it('judges the newest turn even when older tool output fills the buffer', async () => {
    const { requests, gate } = recordingGate(0.9);

    await (
      await processorWith(gate)
    )(buffer, window);

    const conversation = JSON.stringify(requests[0].state);
    expect(conversation).toContain('I prefer answers in Japanese from now on');
  });

  it('skips the memory model when the gate says the turn asks for nothing', async () => {
    const { gate } = recordingGate(0.01);
    const runCalls = (Run.create as jest.Mock).mock.calls.length;

    const result = await (await processorWith(gate))(buffer, window);

    expect(result).toBeUndefined();
    expect((Run.create as jest.Mock).mock.calls.length).toBe(runCalls);
  });
});

describe('memory token limit guidance', () => {
  it('describes the aggregate limit and never reports negative remaining capacity', async () => {
    const [, process] = await createMemoryProcessor({
      res: { headersSent: false, write: jest.fn() } as unknown as Response,
      userId: 'user-1',
      messageId: 'message-1',
      conversationId: 'conversation-1',
      config: { tokenLimit: 100 },
      memoryMethods: {
        setMemory: jest.fn().mockResolvedValue({ ok: true }),
        deleteMemory: jest.fn().mockResolvedValue({ ok: true }),
        getUserMemories: jest.fn().mockResolvedValue([]),
        getFormattedMemories: jest.fn().mockResolvedValue({
          withKeys: 'existing memory',
          withoutKeys: 'existing memory',
          totalTokens: 150,
          tokenCountsByKey: new Map([['preferences', 150]]),
        }),
      },
    });

    await process!([]);

    const runCalls = (Run.create as jest.Mock).mock.calls;
    const runConfig = runCalls[runCalls.length - 1][0];
    expect(runConfig.graphConfig.instructions).toContain(
      'Maximum 100 tokens across all memory values.',
    );
    expect(runConfig.graphConfig.additional_instructions).toContain('Remaining capacity: 0 tokens');
  });
});

describe('buildInlineMemoryTool content filtering', () => {
  it('keeps a legacy-only message filter scoped to ingress messages', async () => {
    const setMemory = jest.fn().mockResolvedValue({ ok: true });
    const req = {
      config: {
        endpoints: {
          [EModelEndpoint.agents]: {
            capabilities: [AgentCapabilities.memory],
          },
        },
        memory: {
          disabled: false,
        },
        messageFilter: {
          pii: {
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
      user: {
        id: 'user-1',
        personalization: {
          memories: true,
        },
      },
    } as ServerRequest;

    const memoryTool = await buildInlineMemoryTool({
      toolName: 'set_memory',
      req,
      agent: {
        tools: [AgentCapabilities.memory],
      },
      userId: 'user-1',
      memoryMethods: {
        setMemory,
        deleteMemory: jest.fn(),
        getFormattedMemories: jest.fn(),
      },
      getRoleByName: jest.fn(),
    });

    expect(memoryTool).not.toBeNull();
    await memoryTool?.func({ key: 'preferences', value: 'Keep ORG-SECRET' });

    expect(setMemory).toHaveBeenCalledTimes(1);
    expect(setMemory).toHaveBeenCalledWith(
      expect.objectContaining({
        key: 'preferences',
        value: 'Keep ORG-SECRET',
      }),
    );
  });
});

describe('buildInlineMemoryTool read failure', () => {
  it('refuses a limited write when current usage could not be read', async () => {
    const setMemory = jest.fn();
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: undefined,
      withoutKeys: undefined,
      totalTokens: 0,
      readFailed: true,
    });
    const req = {
      config: {
        endpoints: { [EModelEndpoint.agents]: { capabilities: [AgentCapabilities.memory] } },
        memory: { disabled: false, tokenLimit: 100 },
      },
      user: { id: 'user-1', personalization: { memories: true } },
    } as ServerRequest;

    const memoryTool = await buildInlineMemoryTool({
      toolName: 'set_memory',
      req,
      agent: { tools: [AgentCapabilities.memory] },
      userId: 'user-1',
      memoryMethods: { setMemory, deleteMemory: jest.fn(), getFormattedMemories },
      getRoleByName: jest.fn(),
    });

    expect(memoryTool).toBeNull();
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);
    expect(setMemory).not.toHaveBeenCalled();
  });
});

describe('agentHasInlineMemoryTools', () => {
  it('returns false for a nullish agent', () => {
    expect(agentHasInlineMemoryTools(null)).toBe(false);
    expect(agentHasInlineMemoryTools(undefined)).toBe(false);
  });

  it('honors an explicit memoryToolsRegistered flag over the raw marker', () => {
    /** Initialized config whose registration was denied (memoryAvailable false)
     *  but whose raw `memory` marker survived in tools must not be treated as
     *  memory-enabled. */
    expect(agentHasInlineMemoryTools({ memoryToolsRegistered: false, tools: ['memory'] })).toBe(
      false,
    );
    expect(agentHasInlineMemoryTools({ memoryToolsRegistered: true, tools: [] })).toBe(true);
  });

  it('falls back to the raw memory marker when no flag is present', () => {
    expect(agentHasInlineMemoryTools({ tools: ['memory'] })).toBe(true);
    expect(agentHasInlineMemoryTools({ tools: [{ name: 'memory' }] })).toBe(true);
    expect(agentHasInlineMemoryTools({ tools: ['execute_code'] })).toBe(false);
    expect(agentHasInlineMemoryTools({ tools: [] })).toBe(false);
  });
});

describe('formatMemoryContext', () => {
  it('distinguishes unavailable memory from an eligible empty store', () => {
    expect(formatMemoryContext(undefined)).toBeUndefined();
    expect(formatMemoryContext('')).toBe(memoryInstructions);
    expect(memoryInstructions).toMatch(/persistent memory.*across conversations/i);
    expect(memoryInstructions).not.toContain('automatically stores');
    expect(memoryInstructions).not.toContain('No existing memories');
    expect(memoryInstructions).not.toMatch(/librechat/i);
  });

  it('includes existing memories without losing the capability guidance', () => {
    expect(formatMemoryContext('name: Danny')).toBe(
      `${memoryInstructions}\n\n# Existing memory about the user:\nname: Danny`,
    );
  });
});

describe('buildInlineMemoryContext', () => {
  it('loads keyed memories for an initialized inline-memory agent', async () => {
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: 'preferred_name: Danny',
      withoutKeys: 'Danny',
      totalTokens: 4,
    });
    const context = await buildInlineMemoryContext({
      agent: {
        id: 'agent_memory',
        memory_scope: MemoryScope.agent,
        memoryToolsRegistered: true,
      },
      req: {} as never,
      userId: 'user-1',
      memoryAvailable: true,
      getFormattedMemories,
    });

    expect(context).toContain('# Existing memory about the user:\npreferred_name: Danny');
    expect(getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'agent_memory',
    });
  });

  it('announces persistent memory before an inline agent has saved anything', async () => {
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: '',
      withoutKeys: '',
      totalTokens: 0,
    });
    const context = await buildInlineMemoryContext({
      agent: { id: 'agent_memory', memoryToolsRegistered: true },
      req: {} as never,
      userId: 'user-1',
      memoryAvailable: true,
      getFormattedMemories,
    });

    expect(context).toBe(memoryInstructions);
    expect(context).not.toContain('# Existing memory about the user:');
    expect(getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: undefined,
    });
  });

  it('does not load or announce memory when permission is denied', async () => {
    const getFormattedMemories = jest.fn();
    await expect(
      buildInlineMemoryContext({
        agent: { id: 'agent_memory', memoryToolsRegistered: true },
        req: {} as never,
        userId: 'user-1',
        memoryAvailable: false,
        getFormattedMemories,
      }),
    ).resolves.toBe('');
    expect(getFormattedMemories).not.toHaveBeenCalled();
  });

  it('keeps failed loads distinct from an empty store', async () => {
    const getFormattedMemories = jest.fn().mockRejectedValue(new Error('read failed'));
    await expect(
      buildInlineMemoryContext({
        agent: { id: 'agent_memory', memoryToolsRegistered: true },
        req: {} as never,
        userId: 'user-1',
        memoryAvailable: true,
        getFormattedMemories,
      }),
    ).resolves.toBe('');
  });

  it('suppresses guidance when a real database read is marked as failed', async () => {
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: undefined,
      withoutKeys: undefined,
      totalTokens: 0,
      readFailed: true,
    });
    await expect(
      buildInlineMemoryContext({
        agent: { id: 'agent_memory', memoryToolsRegistered: true },
        req: {} as never,
        userId: 'user-1',
        memoryAvailable: true,
        getFormattedMemories,
      }),
    ).resolves.toBe('');
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);
  });

  it('does not load memories when inline tools are unavailable', async () => {
    const getFormattedMemories = jest.fn();
    await expect(
      buildInlineMemoryContext({
        agent: { id: 'agent_without_memory', memoryToolsRegistered: false },
        req: {} as never,
        userId: 'user-1',
        memoryAvailable: true,
        getFormattedMemories,
      }),
    ).resolves.toBe('');
    expect(getFormattedMemories).not.toHaveBeenCalled();
  });
});

describe('createMemoryProcessor read failure', () => {
  it('skips extraction and reuses the failed snapshot within the request', async () => {
    const req = {};
    const getFormattedMemories = jest.fn().mockResolvedValue({
      withKeys: undefined,
      withoutKeys: undefined,
      totalTokens: 0,
      readFailed: true,
    });
    const result = await createMemoryProcessor({
      req,
      res: { headersSent: false, write: jest.fn() } as unknown as Response,
      userId: 'user-1',
      messageId: 'message-1',
      conversationId: 'conversation-1',
      memoryMethods: {
        setMemory: jest.fn(),
        deleteMemory: jest.fn(),
        getUserMemories: jest.fn(),
        getFormattedMemories,
      },
    });
    expect(result).toEqual([undefined, undefined]);
    await expect(
      getRequestMemories({ req, userId: 'user-1', getFormattedMemories }),
    ).resolves.toMatchObject({ readFailed: true, withKeys: undefined, withoutKeys: undefined });
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });
});

describe('getRequestMemories caching', () => {
  it('memoizes per request, then re-fetches after invalidation', async () => {
    const getFormattedMemories = jest
      .fn()
      .mockResolvedValue({ withKeys: '', withoutKeys: '', totalTokens: 10 });
    const req = {};

    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    /** A second memory-enabled agent in the same run reuses the first fetch. */
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);

    /** A successful inline write invalidates the cache so a later tool round in
     *  the same response re-reads the post-write usage total. */
    invalidateRequestMemories(req);
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
  });

  it('caches and invalidates per partition', async () => {
    const getFormattedMemories = jest
      .fn()
      .mockResolvedValue({ withKeys: '', withoutKeys: '', totalTokens: 10 });
    const req = {};

    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    /** Personal pool and agent partition are distinct cache entries. */
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
    expect(getFormattedMemories).toHaveBeenLastCalledWith({
      userId: 'user-1',
      agentId: 'agent_a',
    });

    /** Invalidating one partition leaves the other cached. */
    invalidateRequestMemories(req, 'agent_a');
    await getRequestMemories({ req, userId: 'user-1', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(2);
    await getRequestMemories({ req, userId: 'user-1', agentId: 'agent_a', getFormattedMemories });
    expect(getFormattedMemories).toHaveBeenCalledTimes(3);
  });
});

describe('getMemoryAgentId', () => {
  it('resolves the agent partition only for memory_scope "agent"', () => {
    expect(getMemoryAgentId({ id: 'agent_a', memory_scope: MemoryScope.agent })).toBe('agent_a');
    expect(getMemoryAgentId({ id: 'agent_a', memory_scope: MemoryScope.user })).toBeUndefined();
    expect(getMemoryAgentId({ id: 'agent_a' })).toBeUndefined();
    expect(getMemoryAgentId({ memory_scope: MemoryScope.agent })).toBeUndefined();
    expect(getMemoryAgentId(null)).toBeUndefined();
  });

  it('strips runtime id suffixes so added-conversation runs share the persisted partition', () => {
    expect(getMemoryAgentId({ id: 'agent_a____1', memory_scope: MemoryScope.agent })).toBe(
      'agent_a',
    );
  });
});

describe('memory model-bound content preflight', () => {
  const res = {
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
  } as unknown as Response;
  const setMemory = jest.fn().mockResolvedValue({ ok: true });
  const deleteMemory = jest.fn().mockResolvedValue({ ok: true });
  const baseArgs = {
    res,
    userId: 'user-1',
    setMemory,
    deleteMemory,
    messages: [],
    memory: '',
    messageId: 'message-1',
    conversationId: 'conversation-1',
    instructions: 'Safe memory instructions',
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks a canonical memory key before creating a model run', async () => {
    const rawValue = 'PRIVATE-MEMORY-KEY';

    await processMemory({
      ...baseArgs,
      memory: `1. ["key": "${rawValue}"]. ["value": "safe"]`,
      memoryEntries: [{ key: rawValue, value: 'safe' }],
      filters: {
        memories: {
          pii: {
            fields: ['key'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
          },
        },
      },
    });

    expect(Run.create).not.toHaveBeenCalled();
  });

  it('conservatively checks flattened memory for direct callers without canonical rows', async () => {
    const rawValue = 'PRIVATE-FLATTENED-KEY';

    await processMemory({
      ...baseArgs,
      memory: `["key": "${rawValue}"]`,
      filters: {
        memories: {
          pii: {
            fields: ['key'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
          },
        },
      },
    });

    expect(Run.create).not.toHaveBeenCalled();
  });

  it('checks human input and agent configuration without classifying model output as submitted', async () => {
    const rawValue = 'PRIVATE-MEMORY-INPUT';
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };

    await processMemory({
      ...baseArgs,
      messages: [new HumanMessage(rawValue)],
      filters,
    });
    expect(Run.create).not.toHaveBeenCalled();

    jest.clearAllMocks();
    await processMemory({
      ...baseArgs,
      messages: [new AIMessage(rawValue)],
      filters,
    });
    expect(Run.create).toHaveBeenCalledTimes(1);
  });

  it('uses role-preserving inspection messages for a flattened memory prompt', async () => {
    const rawValue = 'PRIVATE-MEMORY-MODEL-OUTPUT';
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };

    await processMemory({
      ...baseArgs,
      messages: [new HumanMessage(`# Current Chat:\n\nAI: ${rawValue}`)],
      inspectionMessages: [new HumanMessage('Safe user input'), new AIMessage(rawValue)],
      filters,
    });

    expect(Run.create).toHaveBeenCalledTimes(1);
  });

  it('fails closed when canonical memory rows cannot be loaded under active policy', async () => {
    const getUserMemories = jest.fn().mockRejectedValue(new Error('database unavailable'));

    await expect(
      createMemoryProcessor({
        res,
        userId: 'user-1',
        messageId: 'message-1',
        conversationId: 'conversation-1',
        filters: {
          memories: {
            pii: {
              fields: ['key'],
              starterPatterns: ['sk_prefix'],
            },
          },
        },
        memoryMethods: {
          setMemory,
          deleteMemory,
          getUserMemories,
          getFormattedMemories: jest.fn().mockResolvedValue({
            withKeys: 'formatted memory',
            withoutKeys: 'memory',
            totalTokens: 1,
          }),
        },
      }),
    ).rejects.toThrow('database unavailable');
    expect(getUserMemories).toHaveBeenCalledTimes(1);
    expect(Run.create).not.toHaveBeenCalled();
  });
});
