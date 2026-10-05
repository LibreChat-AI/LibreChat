import { GraphEvents } from '@librechat/agents';
import { ErrorTypes, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { FiltersConfig } from 'librechat-data-provider';
import type { ChatCompletionDependencies } from './service';
import type { ChatCompletionChunk } from './types';
import { createAgentChatCompletion } from './service';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

type CreateRunArgs = {
  user?: Record<string, unknown>;
  tenantId?: string;
  appConfig?: Record<string, unknown>;
  requestBody?: Record<string, unknown>;
};
type ProcessStreamConfig = { configurable?: Record<string, unknown>; recursionLimit?: number };

function createMockReq(
  user?: Record<string, unknown>,
  body: Record<string, unknown> = {
    model: 'agent_test',
    messages: [{ role: 'user', content: 'hi' }],
    stream: false,
  },
) {
  return {
    body,
    user,
    on: jest.fn(),
  } as unknown as Parameters<typeof createAgentChatCompletion>[0];
}

function createMockRes() {
  const res: Record<string, unknown> = {
    setHeader: jest.fn(),
    flushHeaders: jest.fn(),
    write: jest.fn(),
    end: jest.fn(),
    headersSent: false,
  };
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res as unknown as Parameters<typeof createAgentChatCompletion>[1];
}

function getResponseMock(
  res: Parameters<typeof createAgentChatCompletion>[1],
  method: 'flushHeaders' | 'json' | 'setHeader' | 'status',
): jest.Mock {
  return res[method] as unknown as jest.Mock;
}

function expectRawFreeFilterError(
  res: Parameters<typeof createAgentChatCompletion>[1],
  rawValue: string,
  code: string | null = 'content_filter_block',
): void {
  expect(getResponseMock(res, 'status')).toHaveBeenCalledWith(400);
  const body = getResponseMock(res, 'json').mock.calls[0][0] as {
    error: { code: string | null; message: string; param: string | null; type: string };
  };
  expect(body.error).toMatchObject({
    code,
    param: null,
    type: 'invalid_request_error',
  });
  expect(body.error.message).not.toContain(rawValue);
  expect(JSON.stringify(body)).not.toContain(rawValue);
}

describe('createAgentChatCompletion - MCP permission user propagation', () => {
  let createRun: jest.Mock;
  let processStream: jest.Mock;
  let deps: ChatCompletionDependencies;

  beforeEach(() => {
    processStream = jest.fn().mockResolvedValue(undefined);
    createRun = jest.fn().mockResolvedValue({ processStream });

    deps = {
      getAgent: jest.fn().mockResolvedValue({
        id: 'agent_test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        tools: [],
      }),
      initializeAgent: jest.fn().mockResolvedValue({
        id: 'agent_test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        tools: [],
        attachments: [],
        toolContextMap: {},
        maxContextTokens: 1000,
        model_parameters: {},
      }),
      createRun: createRun as unknown as ChatCompletionDependencies['createRun'],
    };
  });

  it.each([true, false])(
    'keeps graph and provider-owned calls internal (stream=%s)',
    async (stream) => {
      const req = createMockReq(
        { id: 'user' },
        { model: 'agent_test', messages: [{ role: 'user', content: 'hi' }], stream },
      );
      const res = createMockRes();
      processStream.mockImplementationOnce(async () => {
        const { customHandlers: handlers } = createRun.mock.calls[0][0] as Parameters<
          NonNullable<ChatCompletionDependencies['createRun']>
        >[0];
        await handlers.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'accepted',
          agentId: 'agent_test',
          messageId: 'message',
          toolCalls: [
            { id: 'internal', name: 'get_time', args: { city: 'Madrid' } },
            { id: 'server', name: 'web_search', args: { query: 'weather' } },
          ],
          toolCallDispositions: ['sdk', 'provider'],
          invalidToolCalls: [],
        });
        await handlers.on_message_delta.handle('on_message_delta', {
          delta: { content: [{ type: 'text', text: 'Finished.' }] },
        });
      });

      await createAgentChatCompletion(req, res, deps);

      if (stream) {
        const chunks: ChatCompletionChunk[] = (res.write as jest.Mock).mock.calls
          .map(([frame]: [string]) => frame)
          .filter((frame) => frame !== 'data: [DONE]\n\n')
          .map((frame) => JSON.parse(frame.slice(6)));
        expect(chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])).toEqual([]);
        expect(chunks.some((chunk) => chunk.choices[0].delta.content === 'Finished.')).toBe(true);
        expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
      } else {
        expect(getResponseMock(res, 'json')).toHaveBeenCalledWith(
          expect.objectContaining({
            choices: [
              expect.objectContaining({
                finish_reason: 'stop',
                message: expect.objectContaining({ content: 'Finished.' }),
              }),
            ],
          }),
        );
        const response = getResponseMock(res, 'json').mock.calls[0][0] as ChatCompletionChunk;
        expect(JSON.stringify(response)).not.toContain('tool_calls');
      }
    },
  );

  it.each([true, false])(
    'finishes with tool_calls when an accepted client call follows text (stream=%s)',
    async (stream) => {
      const req = createMockReq(
        { id: 'user' },
        { model: 'agent_test', messages: [{ role: 'user', content: 'hi' }], stream },
      );
      const res = createMockRes();
      processStream.mockImplementationOnce(async () => {
        const { customHandlers: handlers } = createRun.mock.calls[0][0] as Parameters<
          NonNullable<ChatCompletionDependencies['createRun']>
        >[0];
        await handlers.on_message_delta.handle('on_message_delta', {
          delta: { content: [{ type: 'text', text: 'Checking the weather.' }] },
        });
        await handlers.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'accepted-client',
          agentId: 'agent_test',
          toolCalls: [{ id: 'client', name: 'lookup', args: { city: 'Madrid' } }],
          toolCallDispositions: ['client'],
          invalidToolCalls: [],
        });
      });

      await createAgentChatCompletion(req, res, deps);

      if (stream) {
        const chunks: ChatCompletionChunk[] = (res.write as jest.Mock).mock.calls
          .map(([frame]: [string]) => frame)
          .filter((frame) => frame !== 'data: [DONE]\n\n')
          .map((frame) => JSON.parse(frame.slice(6)));
        expect(
          chunks.some((chunk) => chunk.choices[0].delta.content === 'Checking the weather.'),
        ).toBe(true);
        expect(
          chunks
            .flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])
            .some((call) => call.id === 'client'),
        ).toBe(true);
        expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('tool_calls');
      } else {
        const response = getResponseMock(res, 'json').mock.calls[0][0] as {
          choices: [
            { message: { content: string; tool_calls: [{ id: string }] }; finish_reason: string },
          ];
        };
        expect(response.choices[0].message.content).toBe('Checking the weather.');
        expect(response.choices[0].message.tool_calls[0].id).toBe('client');
        expect(response.choices[0].finish_reason).toBe('tool_calls');
      }
    },
  );

  it.each([true, false])(
    'does not publish fallback arguments after provider failure (stream=%s)',
    async (stream) => {
      const req = createMockReq(
        { id: 'user' },
        { model: 'agent_test', messages: [{ role: 'user', content: 'hi' }], stream },
      );
      const res = createMockRes();
      processStream.mockImplementationOnce(async () => {
        const { customHandlers: h } = createRun.mock.calls[0][0] as Parameters<
          NonNullable<ChatCompletionDependencies['createRun']>
        >[0];
        await h.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'accepted-before-failure',
          agentId: 'agent_test',
          toolCalls: [{ id: 'a', name: 'get_time', args: { city: 'DO_NOT_FLUSH' } }],
          toolCallDispositions: ['client'],
          invalidToolCalls: [],
        });
        throw new Error('provider failed');
      });
      await createAgentChatCompletion(req, res, deps);
      expect(JSON.stringify((res.write as jest.Mock).mock.calls)).not.toContain('DO_NOT_FLUSH');
      expect(JSON.stringify(getResponseMock(res, 'json').mock.calls)).not.toContain('DO_NOT_FLUSH');
      const { customHandlers: h } = createRun.mock.calls[0][0] as Parameters<
        NonNullable<ChatCompletionDependencies['createRun']>
      >[0];
      await h.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'late',
        agentId: 'agent_test',
        toolCalls: [{ id: 'late', name: 'get_time', args: { late: true } }],
        toolCallDispositions: ['client'],
        invalidToolCalls: [],
      });
      expect(JSON.stringify((res.write as jest.Mock).mock.calls)).not.toContain('late');
    },
  );

  it('forwards the role-bearing safe user to createRun and configurable.user', async () => {
    const req = createMockReq({
      id: 'user-123',
      role: 'ADMIN',
      email: 'admin@example.com',
      password: 'secret',
    });

    await createAgentChatCompletion(req, createMockRes(), deps);

    expect(createRun).toHaveBeenCalledTimes(1);
    const runArgs = createRun.mock.calls[0][0] as CreateRunArgs;
    expect(runArgs.user).toMatchObject({ id: 'user-123', role: 'ADMIN' });
    // createSafeUser must strip sensitive fields.
    expect(runArgs.user).not.toHaveProperty('password');

    expect(processStream).toHaveBeenCalledTimes(1);
    const streamConfig = processStream.mock.calls[0][1] as ProcessStreamConfig;
    expect(streamConfig.configurable?.user).toMatchObject({ id: 'user-123', role: 'ADMIN' });
    expect(streamConfig.configurable?.user_id).toBe('user-123');
  });

  it('invokes the graph with the same resolved recursion limit the step-budget hook uses', async () => {
    deps.appConfig = { endpoints: { agents: { recursionLimit: 123 } } };

    await createAgentChatCompletion(
      createMockReq({ id: 'user-123', role: 'USER' }),
      createMockRes(),
      deps,
    );

    const streamConfig = processStream.mock.calls[0][1] as ProcessStreamConfig;
    expect(streamConfig.recursionLimit).toBe(123);
  });

  it('falls back to a bare id when no authenticated user is attached', async () => {
    const req = createMockReq(undefined);

    await createAgentChatCompletion(req, createMockRes(), deps);

    expect(createRun).toHaveBeenCalledTimes(1);
    const runArgs = createRun.mock.calls[0][0] as CreateRunArgs;
    expect(runArgs.user).toEqual({ id: 'api-user' });

    const streamConfig = processStream.mock.calls[0][1] as ProcessStreamConfig;
    // No role present → the runtime MCP check fails closed.
    expect(streamConfig.configurable?.user).toEqual({ id: 'api-user' });
    expect(streamConfig.configurable?.user).not.toHaveProperty('role');
  });

  it.each([
    { code_environment_mode: 'without_attached' },
    { code_workspaces: [{ environmentId: 'personal-vm', workspaceId: 'project-a' }] },
  ])('rejects code environment decision extensions it cannot persist: %o', async (extension) => {
    const res = createMockRes();
    const req = createMockReq(
      { id: 'user-123' },
      {
        model: 'agent_test',
        messages: [{ role: 'user', content: 'hi' }],
        conversation_id: 'conversation-123',
        ...extension,
      },
    );

    await createAgentChatCompletion(req, res, deps);

    expect(getResponseMock(res, 'status')).toHaveBeenCalledWith(400);
    expect(getResponseMock(res, 'json')).toHaveBeenCalledWith({
      error: expect.objectContaining({
        message: expect.stringContaining('cannot enforce a persisted conversation decision'),
      }),
    });
    expect(deps.initializeAgent).not.toHaveBeenCalled();
  });

  it('adapts runtime tool loading to the request-backed public dependency', async () => {
    const req = createMockReq({ id: 'user-123', role: 'USER' });
    const res = createMockRes();
    const loadAgentTools = jest.fn().mockResolvedValue({
      tools: [],
      toolContextMap: {},
    });
    deps.loadAgentTools = loadAgentTools;
    (deps.initializeAgent as jest.Mock).mockImplementation(
      async ({
        loadTools,
      }: {
        loadTools?: (params: Record<string, unknown>) => Promise<unknown>;
      }) => {
        await loadTools?.({
          provider: 'openai',
          agentId: 'agent_test',
          tools: ['tool-a'],
          model: 'gpt-4o-mini',
          tool_options: undefined,
          tool_resources: undefined,
          requestBody: { conversationId: 'conversation-123' },
          codeExecutionContext: { endpoint: 'openai' },
        });
        return {
          id: 'agent_test',
          provider: 'openai',
          model: 'gpt-4o-mini',
          tools: [],
          attachments: [],
          toolContextMap: {},
          maxContextTokens: 1000,
          model_parameters: {},
        };
      },
    );

    await createAgentChatCompletion(req, res, deps);

    expect(loadAgentTools).toHaveBeenCalledWith(
      expect.objectContaining({
        req,
        res,
        provider: 'openai',
        agentId: 'agent_test',
        tools: ['tool-a'],
        codeExecutionContext: { endpoint: 'openai' },
      }),
    );
  });

  it('threads the parent message id into the run and execution context', async () => {
    const req = createMockReq({ id: 'user-123', role: 'USER' }) as unknown as {
      body: Record<string, unknown>;
    };
    req.body.parent_message_id = 'parent-123';

    await createAgentChatCompletion(req as never, createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({ parentMessageId: 'parent-123' }),
      }),
    );
    const runArgs = createRun.mock.calls[0][0] as CreateRunArgs;
    expect(runArgs.requestBody).toEqual(expect.objectContaining({ parentMessageId: 'parent-123' }));
    const streamConfig = processStream.mock.calls[0][1] as ProcessStreamConfig;
    expect(streamConfig.configurable?.requestBody).toEqual(runArgs.requestBody);
  });

  it('forwards the normalized MCP body to deferred execution loaders', async () => {
    const req = createMockReq({ id: 'user-123', role: 'USER' }) as unknown as {
      body: Record<string, unknown>;
    };
    req.body.stream = true;
    req.body.parent_message_id = 'parent-123';
    const loadTools = jest.fn().mockResolvedValue({ loadedTools: [] });
    deps.toolExecuteOptions = { loadTools };

    await createAgentChatCompletion(req as never, createMockRes(), deps);

    const runArgs = createRun.mock.calls[0][0] as CreateRunArgs & {
      customHandlers: Record<string, { handle: (event: string, data: unknown) => Promise<void> }>;
    };
    const streamConfig = processStream.mock.calls[0][1] as ProcessStreamConfig;
    const resolve = jest.fn();
    const reject = jest.fn();
    await runArgs.customHandlers[GraphEvents.ON_TOOL_EXECUTE].handle(GraphEvents.ON_TOOL_EXECUTE, {
      toolCalls: [{ id: 'tool-call-1', name: 'deferred_mcp_tool', args: {} }],
      agentId: 'agent_test',
      configurable: streamConfig.configurable,
      metadata: {},
      resolve,
      reject,
    });

    expect(loadTools).toHaveBeenCalledWith(
      ['deferred_mcp_tool'],
      'agent_test',
      expect.objectContaining({ requestBody: runArgs.requestBody }),
      undefined,
      processStream.mock.calls[0][1].signal,
      undefined,
    );
    expect(loadTools.mock.calls[0][4]).toBeInstanceOf(AbortSignal);
    await runArgs.customHandlers[GraphEvents.ON_TOOL_EXECUTE].handle(GraphEvents.ON_TOOL_EXECUTE, {
      toolCalls: [{ id: 'child-call', name: 'deferred_mcp_tool', args: {} }],
      agentId: 'agent_test',
      configurable: streamConfig.configurable,
      metadata: { run_id: 'detached-child' },
      resolve,
      reject,
    });
    expect(loadTools.mock.calls[1][4]).toBeUndefined();
  });

  it('uses the root parent sentinel when chat completions omit a parent id', async () => {
    const req = createMockReq({ id: 'user-123', role: 'USER' });

    await createAgentChatCompletion(req, createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          parentMessageId: '00000000-0000-0000-0000-000000000000',
        }),
      }),
    );
  });

  it('omits an unavailable parent for an existing chat-completions conversation', async () => {
    const req = createMockReq({ id: 'user-123', role: 'USER' }) as unknown as {
      body: Record<string, unknown>;
    };
    req.body.conversation_id = 'conversation-123';

    await createAgentChatCompletion(req as never, createMockRes(), deps);

    const requestBody = (deps.initializeAgent as jest.Mock).mock.calls[0][0].requestBody;
    expect(requestBody).toEqual({
      messageId: expect.any(String),
      conversationId: 'conversation-123',
    });
    expect(requestBody).not.toHaveProperty('parentMessageId');
  });

  it('forwards appConfig and tenantId to createRun', async () => {
    const appConfig = {
      endpoints: {
        agents: { capabilities: ['execute_code'] },
      },
      langfuse: {
        publicKey: 'pk-tenant-1',
        secretKey: 'sk-tenant-1',
      },
      interfaceConfig: {
        modelSelect: true,
      },
      filters: {
        messages: {
          pii: {
            starterPatterns: [],
          },
        },
      },
      messageFilter: {
        pii: {
          starterPatterns: [],
        },
      },
    };
    deps.appConfig = appConfig as never;
    const req = createMockReq({
      id: 'user-123',
      tenantId: 'tenant-1',
      role: 'USER',
    });

    await createAgentChatCompletion(req, createMockRes(), deps);

    expect(createRun).toHaveBeenCalledTimes(1);
    const runArgs = createRun.mock.calls[0][0] as CreateRunArgs;
    expect(runArgs.tenantId).toBe('tenant-1');
    expect(runArgs.appConfig).toEqual({
      endpoints: appConfig.endpoints,
      filters: appConfig.filters,
      langfuse: appConfig.langfuse,
      messageFilter: appConfig.messageFilter,
    });
    expect(runArgs.appConfig).not.toHaveProperty('interfaceConfig');
  });

  it('forwards the stateful environment allowlist from appConfig to agent initialization', async () => {
    deps.appConfig = {
      endpoints: {
        agents: {
          capabilities: ['execute_code', 'stateful_code_sessions'],
          statefulCodeSessions: { allowedEnvironments: ['user', 'agent-user'] },
        },
      },
    } as never;

    await createAgentChatCompletion(createMockReq({ id: 'user-123' }), createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        codeEnvAvailable: true,
        statefulSessionsAvailable: true,
        allowedStatefulCodeEnvironments: ['user', 'agent-user'],
      }),
    );
  });

  it('mirrors the capabilities alone when the embedder wires no role lookup', async () => {
    deps.appConfig = {
      endpoints: { agents: { capabilities: ['file_search'] } },
    } as never;

    await createAgentChatCompletion(createMockReq({ id: 'user-123' }), createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ fileSearchAvailable: true, codeEnvAvailable: false }),
    );
  });

  /** One role read answers both grants, so an embedder that wires
   *  `getRoleByName` pays for the pairing once and gets each flag separately. */
  it('pairs each capability with its own grant from a single role read', async () => {
    deps.appConfig = {
      endpoints: { agents: { capabilities: ['file_search', 'execute_code'] } },
    } as never;
    const getRoleByName = jest.fn().mockResolvedValue({
      name: 'USER',
      permissions: {
        [PermissionTypes.FILE_SEARCH]: { [Permissions.USE]: false },
        [PermissionTypes.RUN_CODE]: { [Permissions.USE]: true },
      },
    });
    deps.getRoleByName = getRoleByName as never;

    await createAgentChatCompletion(
      createMockReq({ id: 'user-123', role: 'USER' }),
      createMockRes(),
      deps,
    );

    expect(getRoleByName).toHaveBeenCalledTimes(1);
    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ fileSearchAvailable: false, codeEnvAvailable: true }),
    );
  });

  /** Provider-native search is a model parameter with no capability of its own,
   *  so an embedder that omits `appConfig` still gets the role gate. */
  it('wires the web search grant from the role lookup without appConfig', async () => {
    const getRoleByName = jest.fn().mockResolvedValue({
      name: 'USER',
      permissions: { [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: false } },
    });
    deps.getRoleByName = getRoleByName as never;

    await createAgentChatCompletion(
      createMockReq({ id: 'user-123', role: 'USER' }),
      createMockRes(),
      deps,
    );

    expect(getRoleByName).not.toHaveBeenCalled();
    const [[{ resolveWebSearchGrant }]] = (deps.initializeAgent as jest.Mock).mock.calls;
    await expect(resolveWebSearchGrant()).resolves.toBe(false);
    expect(getRoleByName).toHaveBeenCalledTimes(1);
  });

  it('wires no web search grant when the embedder supplies no role lookup', async () => {
    await createAgentChatCompletion(createMockReq({ id: 'user-123' }), createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resolveWebSearchGrant: undefined }),
    );
  });

  /** Unlike `resolveWebSearchGrant`, there is no default DB-backed resolution path
   *  for a linked agent — the embedder's resolver (and usage-recording flag) must
   *  reach `initializeAgent` verbatim or a linked agent silently loses its instructions. */
  it('forwards resolveLinkedInstructions and recordLinkedPromptUsage verbatim to initializeAgent', async () => {
    const resolveLinkedInstructions = jest.fn();
    deps.resolveLinkedInstructions = resolveLinkedInstructions as never;
    deps.recordLinkedPromptUsage = false;

    await createAgentChatCompletion(createMockReq({ id: 'user-123' }), createMockRes(), deps);

    expect(deps.initializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ resolveLinkedInstructions, recordLinkedPromptUsage: false }),
    );
  });

  it('preserves stateful scope policy status and code in an initialization error response', async () => {
    const policyError = Object.assign(
      new Error('Stateful code environment is not allowed by this deployment: conversation'),
      {
        code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
        status: 403,
        statusCode: 403,
      },
    );
    (deps.initializeAgent as jest.Mock).mockRejectedValueOnce(policyError);
    const res = createMockRes();

    await createAgentChatCompletion(createMockReq({ id: 'user-123' }), res, deps);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: {
        message: policyError.message,
        type: 'invalid_request_error',
        param: null,
        code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
      },
    });
  });
});

describe('createAgentChatCompletion - provider error disclosure', () => {
  const rawValue = 'PRIVATE-PROVIDER-ECHO';
  let deps: ChatCompletionDependencies;

  beforeEach(() => {
    const processStream = jest.fn().mockRejectedValue(new Error(`Provider echoed ${rawValue}`));
    deps = {
      getAgent: jest.fn().mockResolvedValue({
        id: 'agent_test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        tools: [],
      }),
      initializeAgent: jest.fn().mockResolvedValue({
        id: 'agent_test',
        provider: 'openai',
        model: 'gpt-4o-mini',
        tools: [],
        attachments: [],
        toolContextMap: {},
        maxContextTokens: 1000,
        model_parameters: {},
      }),
      createRun: jest.fn().mockResolvedValue({
        processStream,
      }) as unknown as ChatCompletionDependencies['createRun'],
      appConfig: {
        filters: {
          messages: {
            pii: {},
          },
        },
      },
    };
  });

  it('returns a generic non-streaming error when a provider echoes submitted content', async () => {
    const res = createMockRes();

    await createAgentChatCompletion(createMockReq(), res, deps);

    expect(getResponseMock(res, 'status')).toHaveBeenCalledWith(500);
    expect(getResponseMock(res, 'json')).toHaveBeenCalledWith({
      error: {
        code: null,
        message: 'An error occurred while processing the request',
        param: null,
        type: 'server_error',
      },
    });
    expect(JSON.stringify(getResponseMock(res, 'json').mock.calls)).not.toContain(rawValue);
  });

  it('returns a generic streaming error when a provider echoes submitted content', async () => {
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const res = createMockRes();
    getResponseMock(res, 'flushHeaders').mockImplementation(() => {
      (res as unknown as { headersSent: boolean }).headersSent = true;
    });

    await createAgentChatCompletion(req, res, deps);

    const writes = (res.write as unknown as jest.Mock).mock.calls;
    expect(JSON.stringify(writes)).toContain('An error occurred while processing the request');
    expect(JSON.stringify(writes)).not.toContain(rawValue);
  });

  it('preserves the legacy non-streaming provider error when protection is inactive', async () => {
    deps.appConfig = undefined;
    const res = createMockRes();

    await createAgentChatCompletion(createMockReq(), res, deps);

    expect(getResponseMock(res, 'json')).toHaveBeenCalledWith({
      error: {
        code: null,
        message: `Provider echoed ${rawValue}`,
        param: null,
        type: 'server_error',
      },
    });
  });

  it.each<{ filters: FiltersConfig; policy: string }>([
    {
      policy: 'a management-only prompt',
      filters: { prompts: { pii: {} } },
    },
    {
      policy: 'an inert message',
      filters: { messages: { pii: { starterPatterns: [] } } },
    },
  ])('preserves the legacy provider error for $policy policy', async ({ filters }) => {
    deps.appConfig = { filters };
    const res = createMockRes();

    await createAgentChatCompletion(createMockReq(), res, deps);

    expect(getResponseMock(res, 'json')).toHaveBeenCalledWith({
      error: {
        code: null,
        message: `Provider echoed ${rawValue}`,
        param: null,
        type: 'server_error',
      },
    });
  });

  it('preserves the legacy streaming provider error when protection is inactive', async () => {
    deps.appConfig = undefined;
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
    });
    const res = createMockRes();
    getResponseMock(res, 'flushHeaders').mockImplementation(() => {
      (res as unknown as { headersSent: boolean }).headersSent = true;
    });

    await createAgentChatCompletion(req, res, deps);

    expect(JSON.stringify((res.write as unknown as jest.Mock).mock.calls)).toContain(
      `Provider echoed ${rawValue}`,
    );
  });
});

describe('createAgentChatCompletion - source-aware content protection', () => {
  let createRun: jest.Mock;
  let initializeAgent: jest.Mock;
  let getAgent: jest.Mock;
  let deps: ChatCompletionDependencies;

  beforeEach(() => {
    createRun = jest.fn().mockResolvedValue({
      processStream: jest.fn().mockResolvedValue(undefined),
    });
    initializeAgent = jest.fn().mockResolvedValue({
      id: 'agent_test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
      attachments: [],
      toolContextMap: {},
      maxContextTokens: 1000,
      model_parameters: {},
    });
    getAgent = jest.fn().mockResolvedValue({
      id: 'agent_test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
    });
    deps = {
      getAgent,
      initializeAgent,
      createRun: createRun as unknown as ChatCompletionDependencies['createRun'],
    };
  });

  it('blocks submitted message content before agent lookup without echoing the value', async () => {
    const rawValue = 'PRIVATE-MESSAGE';
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: rawValue }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue);
    expect(getAgent).not.toHaveBeenCalled();
    expect(initializeAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('blocks submitted tool arguments before agent lookup', async () => {
    const rawValue = 'PRIVATE-TOOL-ARG';
    const filters: FiltersConfig = {
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'lookup',
                arguments: JSON.stringify({ token: rawValue }),
              },
            },
          ],
        },
      ],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue);
    expect(getAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('rejects structured tool arguments before lookup without echoing their content', async () => {
    const rawValue = 'PRIVATE-STRUCTURED-TOOL-ARG';
    const filters: FiltersConfig = {
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: {
                name: 'lookup',
                arguments: { token: rawValue },
              },
            },
          ],
        },
      ],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue, null);
    expect(getAgent).not.toHaveBeenCalled();
    expect(initializeAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('blocks registered submitted model parameters before agent lookup', async () => {
    const rawValue = 'PRIVATE-MODEL-PARAMETER';
    const filters: FiltersConfig = {
      modelParameters: {
        pii: {
          fields: ['metadata'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'safe' }],
      metadata: { trace: rawValue },
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue);
    expect(getAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('re-inspects initialized agent instructions before headers or run creation', async () => {
    const rawValue = 'PRIVATE-INITIALIZED-INSTRUCTION';
    const filters: FiltersConfig = {
      agentInstructions: {
        pii: {
          fields: ['instructions'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    initializeAgent.mockResolvedValue({
      id: 'agent_test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
      instructions: `Persisted ${rawValue}`,
      attachments: [],
      toolContextMap: {},
      maxContextTokens: 1000,
      model_parameters: {},
    });
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'safe' }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(initializeAgent).toHaveBeenCalledTimes(1);
    expectRawFreeFilterError(res, rawValue);
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'flushHeaders')).not.toHaveBeenCalled();
  });

  it('re-inspects late-loaded tool definitions on nested pure subagents', async () => {
    const rawValue = 'PRIVATE-NESTED-TOOL-DEFINITION';
    const filters: FiltersConfig = {
      agentInstructions: {
        pii: {
          fields: ['description'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    const initializedAgentBase = {
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
      attachments: [],
      requestAttachments: [],
      agentContextAttachments: [],
      toolContextMap: {},
      maxContextTokens: 1000,
      model_parameters: {},
    };
    initializeAgent.mockResolvedValue({
      ...initializedAgentBase,
      id: 'agent_test',
      subagentAgentConfigs: [
        {
          ...initializedAgentBase,
          id: 'agent_pure',
          subagentAgentConfigs: [
            {
              ...initializedAgentBase,
              id: 'agent_nested_pure',
              toolDefinitions: [
                {
                  name: 'nested_lookup',
                  description: rawValue,
                  parameters: { type: 'object' },
                },
              ],
            },
          ],
        },
      ],
    });
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'safe' }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue);
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'flushHeaders')).not.toHaveBeenCalled();
  });

  it('re-inspects initialized agent-context attachments before headers or run creation', async () => {
    const rawValue = 'PRIVATE-INITIALIZED-FILE';
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    initializeAgent.mockResolvedValue({
      id: 'agent_test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
      attachments: [],
      requestAttachments: [],
      agentContextAttachments: [
        {
          filename: 'context.txt',
          filepath: '/context.txt',
          text: `Persisted ${rawValue}`,
        },
      ],
      toolContextMap: {},
      maxContextTokens: 1000,
      model_parameters: {},
    });
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'safe' }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(initializeAgent).toHaveBeenCalledTimes(1);
    expectRawFreeFilterError(res, rawValue);
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'flushHeaders')).not.toHaveBeenCalled();
  });

  it('re-inspects the exact initialized dynamic tool context before headers or run creation', async () => {
    const rawValue = 'PRIVATE-DYNAMIC-TOOL-CONTEXT';
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [{ id: 'private', label: 'private value', regex: rawValue }],
        },
      },
    };
    deps.appConfig = { filters };
    initializeAgent.mockResolvedValue({
      id: 'agent_test',
      provider: 'openai',
      model: 'gpt-4o-mini',
      tools: [],
      attachments: [],
      requestAttachments: [],
      agentContextAttachments: [],
      dynamicToolContextMap: {
        ignored: 42,
        empty: '',
        files: `  Persisted ${rawValue}  `,
      },
      toolContextMap: {},
      maxContextTokens: 1000,
      model_parameters: {},
    });
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: 'safe' }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue);
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'flushHeaders')).not.toHaveBeenCalled();
  });

  it('fails closed on opaque file input before agent lookup', async () => {
    const filters: FiltersConfig = {
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [
        {
          role: 'user',
          content: [{ type: 'input_file', file_id: 'file-private-reference' }],
        },
      ],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, 'file-private-reference', 'content_filter_uninspectable');
    expect(getAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('fails closed when protected nested message content exceeds traversal limits', async () => {
    let nested: Record<string, unknown> = { value: 'safe' };
    for (let depth = 0; depth < 30; depth++) {
      nested = { nested };
    }
    const filters: FiltersConfig = {
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: ['sk_prefix'],
        },
      },
    };
    deps.appConfig = { filters };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'safe', payload: nested }],
        },
      ],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, 'safe', 'content_filter_uninspectable');
    expect(getAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
    expect(getResponseMock(res, 'setHeader')).not.toHaveBeenCalled();
  });

  it('keeps filtering disabled when both policies are omitted', async () => {
    const rawValue = 'PRIVATE-UNFILTERED';
    deps.appConfig = {
      endpoints: {
        agents: { capabilities: [] },
      },
    };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: rawValue }],
      metadata: { trace: rawValue },
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expect(getAgent).toHaveBeenCalledTimes(1);
    expect(initializeAgent).toHaveBeenCalledTimes(1);
    expect(createRun).toHaveBeenCalledTimes(1);
    expect(getResponseMock(res, 'setHeader')).toHaveBeenCalled();
    expect(getResponseMock(res, 'status')).not.toHaveBeenCalledWith(400);
  });

  it('applies the legacy message filter with an OpenAI-format raw-free error', async () => {
    const rawValue = 'sk-private-legacy-token';
    deps.appConfig = {
      messageFilter: {
        pii: {
          starterPatterns: ['sk_prefix'],
        },
      },
    };
    const req = createMockReq(undefined, {
      model: 'agent_test',
      messages: [{ role: 'user', content: rawValue }],
      stream: true,
    });
    const res = createMockRes();

    await createAgentChatCompletion(req, res, deps);

    expectRawFreeFilterError(res, rawValue, 'message_filter_pii_block');
    expect(getAgent).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });
});
