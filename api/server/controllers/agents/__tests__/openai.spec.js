/**
 * Unit tests for OpenAI-compatible API controller
 * Tests that recordCollectedUsage is called correctly for token spending
 */

const { ErrorTypes, ResourceType } = require('librechat-data-provider');

const mockProcessStream = jest.fn().mockResolvedValue(undefined);
const mockSpendTokens = jest.fn().mockResolvedValue({});
const mockSpendStructuredTokens = jest.fn().mockResolvedValue({});
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
const mockGetBalanceConfig = jest.fn().mockReturnValue({ enabled: true });
const mockGetTransactionsConfig = jest.fn().mockReturnValue({ enabled: true });
const mockResolveMemoryAvailability = jest.fn().mockResolvedValue(true);
const mockBuildAgentScopedContext = jest.fn().mockResolvedValue(new Map());
const mockBuildAgentContextAttachmentsByAgentId = jest.fn().mockReturnValue(new Map());
const mockBuildInlineMemoryContext = jest.fn().mockResolvedValue('');
const mockApplyContextToAgent = jest.fn().mockResolvedValue(undefined);
const mockCompletionUsage = {
  prompt_tokens: 125,
  completion_tokens: 50,
  total_tokens: 175,
  primary: { prompt_tokens: 100, completion_tokens: 40, total_tokens: 140 },
  subagent: { prompt_tokens: 25, completion_tokens: 10, total_tokens: 35 },
};
const mockBuildCompletionUsage = jest.fn().mockReturnValue(mockCompletionUsage);
const mockEnrollAgentExecution = jest.fn();
let mockExecution;

function resetMockExecution() {
  const controller = new AbortController();
  mockExecution = {
    signal: controller.signal,
    abort: jest.fn((reason) => controller.abort(reason)),
    track: jest.fn((promise) => promise),
    beginProviderExecution: jest.fn(async () => {
      if (controller.signal.aborted) {
        throw Object.assign(new Error('request disconnected'), {
          code: 'RUN_REPLACED',
          status: 409,
        });
      }
    }),
    settle: jest.fn().mockResolvedValue(undefined),
  };
  mockEnrollAgentExecution.mockResolvedValue(mockExecution);
}
const mockInitialSessions = new Map([['execute_code', { session_id: 'seeded' }]]);
const mockGetSafeErrorMetadata = jest.fn((error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return {
    type: error instanceof Error ? 'Error' : 'UnknownError',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 && { status }),
  };
});
const mockHasActivePiiPatterns = (config) =>
  config != null &&
  (config.starterPatterns == null ||
    config.starterPatterns.length > 0 ||
    (config.customPatterns?.length ?? 0) > 0);
const mockHasModelBoundContentProtection = (filters, legacyPii) => {
  const sourcePolicies = [
    legacyPii,
    filters?.messages?.pii,
    filters?.agentInstructions?.pii,
    filters?.conversationStarters?.pii,
    filters?.skills?.pii,
    filters?.memories?.pii,
    filters?.files?.pii,
    filters?.toolArguments?.pii,
    filters?.modelParameters?.pii,
    filters?.actionMetadata?.pii,
  ];
  if (sourcePolicies.some(mockHasActivePiiPatterns)) {
    return true;
  }
  const filePolicy = filters?.files?.pii;
  return (
    filePolicy?.uninspectable === 'block' &&
    (filePolicy.fields == null ||
      filePolicy.fields.some((field) =>
        ['content', 'extracted_text', 'transcript'].includes(field),
      ))
  );
};
class MockAgentRunEnvelopeError extends TypeError {
  constructor(message) {
    super(message);
    this.name = 'AgentRunEnvelopeError';
  }
}
const mockCreateAgentRunEnvelope = jest.fn(
  ({ protocol, requestId, receivedAt, principal, payload }) => ({
    version: 1,
    protocol,
    requestId,
    receivedAt,
    principal: {
      userId: principal.id,
      ...(principal.role != null && { role: principal.role }),
      ...(principal.tenantId != null && { tenantId: principal.tenantId }),
    },
    payload: JSON.parse(JSON.stringify(payload)),
  }),
);
const mockBuildSkillPrimedIdsByName = jest.fn((manualSkillPrimes, alwaysApplySkillPrimes) => {
  const primed = {};
  for (const skill of alwaysApplySkillPrimes ?? []) {
    primed[skill.name] = skill._id.toString();
  }
  for (const skill of manualSkillPrimes ?? []) {
    primed[skill.name] = skill._id.toString();
  }
  return Object.keys(primed).length > 0 ? primed : undefined;
});
const mockEnrichWithSkillConfigurable = jest.fn((result) => result);
const mockBuildAgentToolContext = jest.fn(({ agent, config }) => ({
  agent,
  endpointTokenConfig: config.endpointTokenConfig,
  toolRegistry: config.toolRegistry,
  userMCPAuthMap: config.userMCPAuthMap,
  tool_resources: config.tool_resources,
  actionsEnabled: config.actionsEnabled,
  accessibleSkillIds: config.accessibleSkillIds,
  activeSkillNames: config.activeSkillNames,
  codeEnvAvailable: config.codeEnvAvailable,
  skillAuthoringAvailable: config.skillAuthoringAvailable,
  fileAuthoringToolNames: config.fileAuthoringToolNames,
  skillPrimedIdsByName:
    mockBuildSkillPrimedIdsByName(config.manualSkillPrimes, config.alwaysApplySkillPrimes) ?? {},
}));
const mockEnrichLoadedToolsWithAgentContext = jest.fn(({ result, req, ctx }) =>
  mockEnrichWithSkillConfigurable({
    result,
    context: {
      req,
      accessibleSkillIds: ctx.accessibleSkillIds,
      codeEnvAvailable: ctx.codeEnvAvailable === true,
      skillPrimedIdsByName: ctx.skillPrimedIdsByName,
      activeSkillNames: ctx.activeSkillNames,
      skillAuthoringAvailable: ctx.skillAuthoringAvailable === true,
      fileAuthoringToolNames: ctx.fileAuthoringToolNames,
    },
  }),
);
const mockCanAuthorSkillFiles = jest.fn(
  ({ scopedEditableSkillIds = [], skillCreateAllowed }) =>
    scopedEditableSkillIds.length > 0 || skillCreateAllowed === true,
);
const mockGetSkillToolDeps = jest.fn(() => ({}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-nanoid-123'),
}));

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
  },
}));

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  Callback: { TOOL_ERROR: 'TOOL_ERROR' },
  ToolEndHandler: jest.fn(),
  formatAgentMessages: jest.fn().mockReturnValue({
    messages: [],
    indexTokenCountMap: {},
  }),
}));

jest.mock('@librechat/api', () => ({
  getAgentErrorMetadata: (...args) =>
    jest.requireActual('@librechat/api').getAgentErrorMetadata(...args),
  /* Provisioning moved into this package; the controllers build the callback from it. */
  createProvisionFilesCallback: () => async () => {},
  createAgentExecutionContext: (context) => context,
  /** Grants both by default; the capability set is what these specs vary. */
  resolveToolRoleGrants: jest.fn(async () => ({
    runCode: true,
    fileSearch: true,
    webSearch: true,
  })),
  collectReachableAgents: (roots) => {
    const agents = [];
    const pending = [...roots];
    const visited = new Set();
    for (let index = 0; index < pending.length; index++) {
      const agent = pending[index];
      if (!agent || visited.has(agent)) {
        continue;
      }
      visited.add(agent);
      agents.push(agent);
      pending.push(...(agent.subagentAgentConfigs ?? []));
    }
    return agents;
  },
  /** Pass-through: the controller strips UI-only activity-label parts
   *  before SDK formatting; the mock must expose it like any other used
   *  export or the call throws before the assertions run. */
  stripActivityLabelParts: jest.fn((payload) => payload),
  writeSSE: jest.fn(),
  createOwnedToolEndHandler: jest.fn(
    (...args) => new (require('@librechat/agents').ToolEndHandler)(...args),
  ),
  createRun: jest.fn().mockResolvedValue({
    processStream: mockProcessStream,
  }),
  createTerminalRunErrorObserver: (...args) =>
    jest.requireActual('@librechat/api').createTerminalRunErrorObserver(...args),
  applyContextToAgent: (...args) => mockApplyContextToAgent(...args),
  buildAgentScopedContext: (...args) => mockBuildAgentScopedContext(...args),
  buildInlineMemoryContext: (...args) => mockBuildInlineMemoryContext(...args),
  buildAgentContextAttachmentsByAgentId: (...args) =>
    mockBuildAgentContextAttachmentsByAgentId(...args),
  createChunk: jest.fn().mockReturnValue({}),
  completeOpenAIToolCalls: jest.requireActual('@librechat/api').completeOpenAIToolCalls,
  buildRunToolSet: jest.fn().mockReturnValue(new Set()),
  buildInitialToolSessions: jest.fn().mockReturnValue(mockInitialSessions),
  AgentRunEnvelopeError: MockAgentRunEnvelopeError,
  createAgentRunEnvelope: (...args) => mockCreateAgentRunEnvelope(...args),
  resolveAdmittedCodeEnvironmentDecision: (...args) =>
    jest.requireActual('@librechat/api').resolveAdmittedCodeEnvironmentDecision(...args),
  createMCPRuntimeRequestBody: ({
    messageId,
    conversationId,
    parentMessageId,
    codeEnvironmentMode,
    codeWorkspaces,
  }) => ({
    messageId,
    conversationId,
    ...(codeEnvironmentMode !== undefined && { codeEnvironmentMode }),
    ...(codeWorkspaces !== undefined && { codeWorkspaces }),
    ...(parentMessageId !== undefined && {
      parentMessageId: parentMessageId ?? '00000000-0000-0000-0000-000000000000',
    }),
  }),
  scopeSkillIds: jest.fn().mockImplementation((ids) => ids),
  resolveAgentScopedSkillIds: jest
    .fn()
    .mockImplementation(({ accessibleSkillIds }) => accessibleSkillIds),
  loadSkillStates: jest.fn().mockResolvedValue({ skillStates: {}, defaultActiveOnShare: false }),
  sendFinalChunk: jest.fn(),
  buildCompletionUsage: mockBuildCompletionUsage,
  createSafeUser: jest.fn().mockReturnValue({ id: 'user-123' }),
  validateRequest: jest
    .fn()
    .mockReturnValue({ request: { model: 'agent-123', messages: [], stream: false } }),
  initializeAgent: jest.fn().mockResolvedValue({
    id: 'agent-123',
    model: 'gpt-4',
    model_parameters: {},
    toolRegistry: {},
    edges: [],
  }),
  getBalanceConfig: mockGetBalanceConfig,
  createErrorResponse: jest.fn(),
  getTransactionsConfig: mockGetTransactionsConfig,
  recordCollectedUsage: mockRecordCollectedUsage,
  createSubagentUsageSink: jest.fn().mockReturnValue(jest.fn()),
  resolveAgentTokenConfig: jest.fn(({ agentId, byAgentId, fallback }) =>
    agentId != null && byAgentId?.has(agentId) ? byAgentId.get(agentId) : fallback,
  ),
  extractManualSkills: jest.fn().mockReturnValue(undefined),
  injectSkillPrimes: jest.fn().mockReturnValue({
    initialMessages: [],
    indexTokenCountMap: {},
    inserted: 0,
    insertIdx: -1,
    alwaysApplyDropped: 0,
    alwaysApplyDedupedFromManual: 0,
  }),
  buildNonStreamingResponse: jest.fn().mockReturnValue({ id: 'resp-123' }),
  createOpenAIStreamTracker: jest.fn().mockReturnValue({
    addText: jest.fn(),
    addReasoning: jest.fn(),
    toolCalls: new Map(),
    usage: { promptTokens: 0, completionTokens: 0, reasoningTokens: 0 },
  }),
  createOpenAIContentAggregator: jest.fn().mockReturnValue({
    addText: jest.fn(),
    addReasoning: jest.fn(),
    getText: jest.fn().mockReturnValue(''),
    getReasoning: jest.fn().mockReturnValue(''),
    toolCalls: new Map(),
    usage: { promptTokens: 100, completionTokens: 50, reasoningTokens: 0 },
  }),
  resolveRecursionLimit: jest.fn().mockReturnValue(50),
  createToolExecuteHandler: jest.fn().mockReturnValue({ handle: jest.fn() }),
  isChatCompletionValidationFailure: jest.fn().mockReturnValue(false),
  inspectContent: jest.fn().mockReturnValue(null),
  extractMessageContent: jest.fn().mockReturnValue([]),
  extractModelParameterContent: jest.fn().mockReturnValue([]),
  extractSkillContent: jest.fn().mockReturnValue([]),
  getBlockedOpaqueFileField: jest.fn().mockReturnValue(null),
  getContentTraversalFragments: jest.fn().mockReturnValue([]),
  isContentTraversalProtected: jest.fn().mockReturnValue(true),
  isContentTraversalLimitError: jest.fn((error) => error?.code === 'content_filter_uninspectable'),
  assertModelBoundContent: jest.fn(),
  hasModelBoundContentProtection: mockHasModelBoundContentProtection,
  isContentFilterError: jest.fn((error) => error?.code === 'content_filter_block'),
  getSafeErrorMetadata: mockGetSafeErrorMetadata,
  /** Mirrors the real helper's contract: generic copy under content protection, otherwise the
   *  provider's own message. Stripping of LangChain's docs URL is covered in its own unit test. */
  getUserFacingProviderError: (error, protectionEnabled) => {
    if (protectionEnabled) {
      return 'An error occurred while processing the request';
    }
    return error instanceof Error ? error.message : 'An error occurred';
  },
  contentFilterBlockResponse: jest.fn().mockReturnValue({
    error: 'content_filter_block',
    message: 'Submitted content was blocked.',
  }),
  contentFilterUninspectableResponse: jest.fn().mockReturnValue({
    error: 'content_filter_uninspectable',
    message: 'Submitted file content could not be inspected before processing.',
    source: 'file',
    field: 'content',
  }),
  discoverConnectedAgents: jest.fn().mockResolvedValue({
    agentConfigs: new Map(),
    edges: [],
    skippedAgentIds: new Set(),
    userMCPAuthMap: undefined,
  }),
  resolveSubagentGraphs: jest.fn().mockResolvedValue(undefined),
  executeAgentRun: async ({
    envelope,
    runId,
    conversationId,
    connection,
    isPrincipalActive,
    execute,
    handleExecutionError,
    beforeSettle,
  }) => {
    let execution;
    let executionError;
    let closed = connection?.isClosed() ?? false;
    const removeCloseListener =
      connection?.onClose(() => {
        closed = true;
        execution?.abort();
      }) ?? (() => undefined);
    try {
      execution = await mockEnrollAgentExecution({
        runId,
        userId: envelope.principal.userId,
        conversationId,
        agentId: envelope.payload.model,
        protocol: envelope.protocol,
        isPrincipalActive,
      });
      if (closed || connection?.isClosed() === true) execution.abort();
      await execution.beginProviderExecution();
      return await execute(execution);
    } catch (error) {
      executionError = error;
      if (handleExecutionError) return await handleExecutionError(error, execution?.signal);
      throw error;
    } finally {
      removeCloseListener();
      if (execution) {
        await beforeSettle?.(execution, executionError);
        await execution.settle(executionError);
      }
    }
  },
  waitForAgentExecutionWrites: async (writes) => {
    const results = await Promise.allSettled(writes);
    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  },
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/config', () => ({
  getMCPManager: jest.fn().mockReturnValue({}),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn(),
}));

jest.mock('~/server/services/Endpoints/agents/skillDeps', () => ({
  getSkillToolDeps: mockGetSkillToolDeps,
  getSkillDbMethods: jest.fn(() => ({})),
  canAuthorSkillFiles: mockCanAuthorSkillFiles,
  withDeploymentSkillIds: jest.fn((ids = []) => ids),
  enrichWithSkillConfigurable: mockEnrichWithSkillConfigurable,
  buildSkillPrimedIdsByName: mockBuildSkillPrimedIdsByName,
  buildAgentToolContext: mockBuildAgentToolContext,
  resolveMemoryAvailability: mockResolveMemoryAvailability,
  enrichLoadedToolsWithAgentContext: mockEnrichLoadedToolsWithAgentContext,
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn().mockResolvedValue([]),
  loadToolsForExecution: jest.fn().mockResolvedValue([]),
  isFatalAgentInitializationError: jest.fn((...args) =>
    jest.requireActual('@librechat/api').isFatalAgentInitializationError(...args),
  ),
}));

const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);

jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn().mockReturnValue(jest.fn()),
  buildSummarizationHandlers: jest.fn().mockReturnValue({}),
  contextualizeModelUsage: jest.fn().mockImplementation((usage) => usage),
  agentLogHandlerObj: { handle: jest.fn() },
}));

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  checkPermission: jest.fn().mockResolvedValue(true),
}));

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn().mockReturnValue({}),
}));

jest.mock('~/server/services/Files/Code/crud', () => ({
  batchUploadCodeEnvFiles: jest.fn().mockResolvedValue({ session_id: '', files: [] }),
}));

jest.mock('~/server/services/Files/Code/process', () => ({
  getSessionInfo: jest.fn().mockResolvedValue(null),
  checkIfActive: jest.fn().mockReturnValue(false),
}));

const mockUpdateBalance = jest.fn().mockResolvedValue({});
const mockBulkInsertTransactions = jest.fn().mockResolvedValue(undefined);

jest.mock('~/models', () => ({
  getAgent: jest.fn().mockResolvedValue({ id: 'agent-123', name: 'Test Agent' }),
  getFiles: jest.fn(),
  getUserKey: jest.fn(),
  getMessages: jest.fn(),
  updateFilesUsage: jest.fn(),
  getUserKeyValues: jest.fn(),
  getUserCodeFiles: jest.fn(),
  getToolFilesByIds: jest.fn(),
  getCodeGeneratedFiles: jest.fn(),
  updateBalance: mockUpdateBalance,
  bulkInsertTransactions: mockBulkInsertTransactions,
  spendTokens: mockSpendTokens,
  spendStructuredTokens: mockSpendStructuredTokens,
  getMultiplier: mockGetMultiplier,
  getCacheMultiplier: mockGetCacheMultiplier,
  getConvoFiles: jest.fn().mockResolvedValue([]),
  getFormattedMemories: jest.fn().mockResolvedValue({ withKeys: '', withoutKeys: '' }),
  getConvo: jest.fn().mockResolvedValue(null),
  readAdmittedConvoCodeEnvironmentDecision: jest.fn().mockResolvedValue(null),
  isSubagentOwnerAdmissible: jest.fn().mockResolvedValue(true),
}));

describe('OpenAIChatCompletionController', () => {
  let OpenAIChatCompletionController;
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockExecution();

    const controller = require('../openai');
    OpenAIChatCompletionController = controller.OpenAIChatCompletionController;

    req = {
      body: {
        model: 'agent-123',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      },
      user: { id: 'user-123' },
      config: {
        endpoints: {
          agents: { allowedProviders: ['openAI'] },
        },
      },
      once: jest.fn(),
      off: jest.fn(),
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      setHeader: jest.fn(),
      flushHeaders: jest.fn(),
      end: jest.fn(),
      write: jest.fn(),
      once: jest.fn(),
      off: jest.fn(),
    };
  });

  it.each([true, false])(
    'keeps SDK- and provider-executed calls out of the mounted endpoint (stream=%s)',
    async (streaming) => {
      const api = require('@librechat/api');
      const actual = jest.requireActual('@librechat/api');
      const names = [
        'createChunk',
        'writeSSE',
        'sendFinalChunk',
        'buildNonStreamingResponse',
        'createOpenAIStreamTracker',
        'createOpenAIContentAggregator',
      ];
      const originals = names.map((name) => [name, api[name].getMockImplementation()]);
      for (const name of names) api[name].mockImplementation(actual[name]);
      req.body.stream = streaming;
      api.validateRequest.mockReturnValueOnce({ request: req.body });
      mockProcessStream.mockImplementationOnce(async () => {
        const { customHandlers: handlers } = api.createRun.mock.calls.at(-1)[0];
        expect(handlers.on_run_step).toBeUndefined();
        expect(handlers.on_run_step_delta).toBeUndefined();
        expect(handlers.on_run_step_completed).toBeUndefined();
        await handlers.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'accepted-internal',
          agentId: 'agent-123',
          toolCalls: [
            { id: 'internal', name: 'get_time', args: { city: 'Madrid' } },
            { id: 'provider', name: 'web_search', args: { query: 'weather' } },
          ],
          toolCallDispositions: ['sdk', 'provider'],
          invalidToolCalls: [],
        });
        await handlers.on_message_delta.handle('on_message_delta', {
          delta: { content: [{ type: 'text', text: 'Both tools completed.' }] },
        });
      });
      try {
        await OpenAIChatCompletionController(req, res);
        if (streaming) {
          const frames = res.write.mock.calls
            .map(([frame]) => frame)
            .filter((frame) => frame !== 'data: [DONE]\n\n')
            .map((frame) => JSON.parse(frame.slice(6)));
          expect(frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? [])).toEqual([]);
          expect(
            frames.some((frame) => frame.choices[0].delta.content === 'Both tools completed.'),
          ).toBe(true);
          expect(frames.at(-1).choices[0].finish_reason).toBe('stop');
        } else {
          const choice = res.json.mock.calls[0][0].choices[0];
          expect(choice.message.content).toBe('Both tools completed.');
          expect(choice.message.tool_calls).toBeUndefined();
          expect(choice.finish_reason).toBe('stop');
        }
      } finally {
        for (const [name, implementation] of originals)
          api[name].mockImplementation(implementation);
      }
    },
  );

  it.each([true, false])(
    'publishes only the accepted client call after a model claim (stream=%s)',
    async (streaming) => {
      const api = require('@librechat/api');
      const actual = jest.requireActual('@librechat/api');
      const names = [
        'createChunk',
        'writeSSE',
        'sendFinalChunk',
        'buildNonStreamingResponse',
        'createOpenAIStreamTracker',
        'createOpenAIContentAggregator',
      ];
      const originals = names.map((name) => [name, api[name].getMockImplementation()]);
      for (const name of names) api[name].mockImplementation(actual[name]);
      req.body.stream = streaming;
      api.validateRequest.mockReturnValueOnce({ request: req.body });
      mockProcessStream.mockImplementationOnce(async () => {
        const { customHandlers: handlers } = api.createRun.mock.calls.at(-1)[0];
        await handlers.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'discarded',
          agentId: 'agent-123',
          messageId: 'claimed-message',
          toolCalls: [{ id: 'stale', name: 'stale_tool', args: { secret: 'DO_NOT_SEND' } }],
          toolCallDispositions: ['client'],
          invalidToolCalls: [],
        });
        await handlers.on_model_tools_claimed.handle('on_model_tools_claimed', {
          type: 'model_tools_claimed',
          agentId: 'agent-123',
          messageId: 'claimed-message',
        });
        await handlers.on_model_response.handle('on_model_response', {
          type: 'model_response',
          id: 'accepted-client',
          agentId: 'agent-123',
          toolCalls: [
            { id: 'a', name: 'get_time', args: { city: 'Madrid' } },
            { id: 'a', name: 'get_time', args: { city: 'Paris' } },
          ],
          toolCallDispositions: ['client', 'client'],
          invalidToolCalls: [],
        });
      });
      try {
        await OpenAIChatCompletionController(req, res);
        if (streaming) {
          const frames = res.write.mock.calls
            .map(([frame]) => frame)
            .filter((frame) => frame !== 'data: [DONE]\n\n')
            .map((frame) => JSON.parse(frame.slice(6)));
          const calls = frames.flatMap((frame) => frame.choices[0].delta.tool_calls ?? []);
          expect(calls).toEqual([
            { index: 0, id: 'a', type: 'function', function: { name: 'get_time', arguments: '' } },
            { index: 0, function: { arguments: '{"city":"Madrid"}' } },
            {
              index: 1,
              id: 'call_0',
              type: 'function',
              function: { name: 'get_time', arguments: '' },
            },
            { index: 1, function: { arguments: '{"city":"Paris"}' } },
          ]);
          expect(frames.at(-1).choices[0].finish_reason).toBe('tool_calls');
        } else {
          const choice = res.json.mock.calls[0][0].choices[0];
          expect(choice.message.tool_calls).toEqual([
            {
              id: 'a',
              type: 'function',
              function: { name: 'get_time', arguments: '{"city":"Madrid"}' },
            },
            {
              id: 'call_0',
              type: 'function',
              function: { name: 'get_time', arguments: '{"city":"Paris"}' },
            },
          ]);
          expect(choice.finish_reason).toBe('tool_calls');
        }
        expect(JSON.stringify(res.write.mock.calls)).not.toContain('DO_NOT_SEND');
        expect(JSON.stringify(res.json.mock.calls)).not.toContain('DO_NOT_SEND');
      } finally {
        for (const [name, implementation] of originals)
          api[name].mockImplementation(implementation);
      }
    },
  );

  it('discards client delegation on failure and ignores late accepted responses', async () => {
    const api = require('@librechat/api');
    api.validateRequest.mockReturnValueOnce({ request: req.body });
    mockProcessStream.mockImplementationOnce(async () => {
      const { customHandlers: handlers } = api.createRun.mock.calls.at(-1)[0];
      await handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'before-failure',
        agentId: 'agent-123',
        toolCalls: [{ id: 'a', name: 'get_time', args: { secret: 'DO_NOT_SEND' } }],
        toolCallDispositions: ['client'],
        invalidToolCalls: [],
      });
      throw new Error('provider failed');
    });
    await OpenAIChatCompletionController(req, res);
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('DO_NOT_SEND');
    expect(api.buildNonStreamingResponse).not.toHaveBeenCalled();
    const { customHandlers: handlers } = api.createRun.mock.calls.at(-1)[0];
    await handlers.on_model_response.handle('on_model_response', {
      type: 'model_response',
      id: 'too-late',
      agentId: 'agent-123',
      toolCalls: [{ id: 'late', name: 'get_time', args: { city: 'Late' } }],
      toolCallDispositions: ['client'],
      invalidToolCalls: [],
    });
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('Late');
  });

  it('fails closed on an invalid accepted client call without returning its arguments', async () => {
    const api = require('@librechat/api');
    api.validateRequest.mockReturnValueOnce({ request: req.body });
    mockProcessStream.mockImplementationOnce(async () => {
      const { customHandlers: handlers } = api.createRun.mock.calls.at(-1)[0];
      await handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'invalid-client',
        agentId: 'agent-123',
        toolCalls: [{ id: 'a', name: '', args: { secret: 'PRIVATE_ARGUMENTS' } }],
        toolCallDispositions: ['client'],
        invalidToolCalls: [],
      });
    });
    await OpenAIChatCompletionController(req, res);
    expect(mockExecution.settle).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Accepted tool call is missing its name' }),
    );
    expect(api.buildNonStreamingResponse).not.toHaveBeenCalled();
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('PRIVATE_ARGUMENTS');
  });

  it('enrolls, starts, and settles the remote execution lifecycle', async () => {
    await OpenAIChatCompletionController(req, res);

    expect(mockEnrollAgentExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'chatcmpl-mock-nanoid-123',
        userId: 'user-123',
        agentId: 'agent-123',
        protocol: 'chat.completions',
      }),
    );
    expect(mockExecution.beginProviderExecution).toHaveBeenCalledTimes(1);
    expect(mockExecution.beginProviderExecution.mock.invocationCallOrder[0]).toBeLessThan(
      require('@librechat/api').initializeAgent.mock.invocationCallOrder[0],
    );
    expect(mockExecution.beginProviderExecution.mock.invocationCallOrder[0]).toBeLessThan(
      mockProcessStream.mock.invocationCallOrder[0],
    );
    expect(mockExecution.settle).toHaveBeenCalledWith(undefined);
    expect(res.once).toHaveBeenCalledWith('close', expect.any(Function));
    expect(res.off).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('covers artifact writes when provider execution fails', async () => {
    const providerError = new Error('provider aborted');
    const artifactWrite = Promise.resolve(null);
    const { createToolEndCallback } = require('~/server/controllers/agents/callbacks');
    createToolEndCallback.mockImplementationOnce(({ artifactPromises }) => {
      artifactPromises.push(artifactWrite);
      return jest.fn();
    });
    mockProcessStream.mockRejectedValueOnce(providerError);

    await OpenAIChatCompletionController(req, res);

    expect(mockExecution.track).toHaveBeenCalledWith(expect.any(Promise));
    expect(mockExecution.track.mock.invocationCallOrder[0]).toBeLessThan(
      mockExecution.settle.mock.invocationCallOrder[0],
    );
    expect(mockExecution.settle).toHaveBeenCalledWith(providerError);
  });

  it('does not initialize a provider after disconnecting during enrollment', async () => {
    let finishEnrollment;
    mockEnrollAgentExecution.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishEnrollment = resolve;
        }),
    );

    const request = OpenAIChatCompletionController(req, res);
    await Promise.resolve();
    res.once.mock.calls[0][1]();
    finishEnrollment(mockExecution);
    await request;

    expect(mockExecution.abort).toHaveBeenCalledTimes(1);
    expect(mockExecution.beginProviderExecution).toHaveBeenCalledTimes(1);
    expect(require('@librechat/api').initializeAgent).not.toHaveBeenCalled();
    expect(mockExecution.settle).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RUN_REPLACED' }),
    );
  });

  it('does not treat a consumed request stream as a response disconnect', async () => {
    req.destroyed = true;

    await OpenAIChatCompletionController(req, res);

    expect(mockExecution.abort).not.toHaveBeenCalled();
    expect(mockExecution.beginProviderExecution).toHaveBeenCalledTimes(1);
  });

  it('includes persistent-memory guidance in an inline agent with no saved memories', async () => {
    const api = require('@librechat/api');
    const { memoryInstructions, buildInlineMemoryContext } = jest.requireActual('@librechat/api');
    const agent = {
      id: 'agent-123',
      model: 'gpt-4',
      model_parameters: {},
      toolRegistry: {},
      edges: [],
      memoryToolsRegistered: true,
    };
    api.initializeAgent.mockResolvedValueOnce(agent);
    mockBuildInlineMemoryContext.mockImplementationOnce(buildInlineMemoryContext);

    await OpenAIChatCompletionController(req, res);

    expect(mockApplyContextToAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent,
        sharedRunContext: expect.stringContaining(memoryInstructions),
      }),
    );
    expect(require('~/models').getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-123',
      agentId: undefined,
    });
  });

  it('resolves saved graph subagents for remote chat-completion runs', async () => {
    const {
      initializeAgent,
      resolveSubagentGraphs,
      createSubagentUsageSink,
    } = require('@librechat/api');
    const primaryConfig = {
      id: 'agent-123',
      model: 'gpt-4',
      endpointTokenConfig: { 'gpt-4': { prompt: 1 } },
      model_parameters: {},
      toolRegistry: {},
      edges: [],
      subagents: {
        enabled: true,
        graphs: [{ type: 'team', agent_ids: ['agent-123'], edges: [] }],
      },
    };
    initializeAgent.mockResolvedValueOnce(primaryConfig);
    const memberTokenConfig = { 'custom-model': { prompt: 7 } };
    const memberConfig = {
      id: 'agent-graph-member',
      endpointTokenConfig: memberTokenConfig,
      agentContextAttachments: [{ file_id: 'member-file' }],
    };
    resolveSubagentGraphs.mockImplementationOnce(async ({ rootConfigs }, deps) => {
      rootConfigs[0].subagentGraphConfigs = [
        { definition: { type: 'team' }, memberConfigs: [memberConfig] },
      ];
      deps.onAgentInitialized('agent-graph-member', { id: 'agent-graph-member' }, memberConfig);
    });
    req.config.endpoints.agents.capabilities = ['subagents'];

    await OpenAIChatCompletionController(req, res);

    expect(resolveSubagentGraphs).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryConfig,
        rootConfigs: [primaryConfig],
        signal: mockExecution.signal,
        resourceType: ResourceType.REMOTE_AGENT,
        memoryAvailable: true,
      }),
      expect.objectContaining({ getAgent: expect.any(Function) }),
    );
    const usageParams = mockRecordCollectedUsage.mock.calls[0][1];
    expect(usageParams.endpointTokenConfig).toBe(primaryConfig.endpointTokenConfig);
    expect(usageParams.resolveEndpointTokenConfig({ agentId: 'agent-graph-member' })).toBe(
      memberTokenConfig,
    );
    expect(mockResolveMemoryAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ enabledCapabilities: expect.any(Set), user: req.user }),
    );
    expect(mockBuildAgentContextAttachmentsByAgentId).toHaveBeenCalledWith([
      primaryConfig,
      memberConfig,
    ]);
    expect(mockBuildAgentScopedContext).toHaveBeenCalledWith(
      expect.objectContaining({ agentIds: ['agent-123', 'agent-graph-member'] }),
    );
    expect(mockApplyContextToAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agent: memberConfig, agentId: 'agent-graph-member' }),
    );
    expect(mockBuildInlineMemoryContext).toHaveBeenCalledWith(
      expect.objectContaining({ agent: memberConfig, memoryAvailable: true }),
    );
    const { createRun } = require('@librechat/api');
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: mockInitialSessions,
        user: expect.objectContaining({ id: 'user-123' }),
        traceContext: { endpoint: 'agents' },
      }),
    );
    expect(createSubagentUsageSink).toHaveBeenCalledWith(expect.any(Array));
  });

  it('uses collected usage for the non-streaming response', async () => {
    const { buildNonStreamingResponse } = require('@librechat/api');

    await OpenAIChatCompletionController(req, res);

    const collectedUsage = mockRecordCollectedUsage.mock.calls.at(-1)[1].collectedUsage;
    expect(mockBuildCompletionUsage).toHaveBeenCalledWith(collectedUsage);
    expect(buildNonStreamingResponse).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      mockCompletionUsage,
    );
  });

  it('uses collected usage in the final streaming chunk', async () => {
    const { validateRequest, sendFinalChunk } = require('@librechat/api');
    validateRequest.mockReturnValueOnce({
      request: { model: 'agent-123', messages: [], stream: true },
    });

    await OpenAIChatCompletionController(req, res);

    expect(sendFinalChunk).toHaveBeenCalledWith(expect.anything(), 'stop', mockCompletionUsage);
  });

  describe('content filtering', () => {
    it('blocks opaque inline media before text inspection or agent loading', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,do-not-echo' },
            },
          ],
        },
      ];
      api.validateRequest.mockReturnValueOnce({
        request: { model: 'agent-123', messages, stream: false },
      });
      api.getBlockedOpaqueFileField.mockReturnValueOnce('content');

      await OpenAIChatCompletionController(req, res);

      expect(api.getBlockedOpaqueFileField).toHaveBeenCalledWith(req.config.filters, messages);
      expect(api.extractMessageContent).not.toHaveBeenCalled();
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'Submitted file content could not be inspected before processing.',
        'invalid_request_error',
        'content_filter_uninspectable',
      );
      expect(JSON.stringify(api.createErrorResponse.mock.calls)).not.toContain('do-not-echo');
    });

    it('returns a raw-free error when nested message inspection exhausts its budget', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      req.config.filters = { messages: { pii: { starterPatterns: [] } } };
      api.extractMessageContent.mockImplementationOnce(() => {
        throw {
          code: 'content_filter_uninspectable',
          statusCode: 400,
          body: {
            error: 'content_filter_uninspectable',
            message: 'Submitted content could not be completely inspected before processing.',
            source: 'message',
            field: 'content_part',
          },
        };
      });

      await OpenAIChatCompletionController(req, res);

      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'Submitted content could not be completely inspected before processing.',
        'invalid_request_error',
        'content_filter_uninspectable',
      );
    });

    it('preserves field granularity when the exhausted nested field is not selected', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      req.config.filters = {
        messages: { pii: { fields: ['text'], starterPatterns: [] } },
      };
      api.extractMessageContent.mockImplementationOnce(() => {
        throw {
          code: 'content_filter_uninspectable',
          statusCode: 400,
          body: {
            error: 'content_filter_uninspectable',
            message: 'Submitted content could not be completely inspected before processing.',
            source: 'message',
            field: 'content_part',
          },
        };
      });
      api.isContentTraversalProtected.mockReturnValueOnce(false);

      await OpenAIChatCompletionController(req, res);

      expect(db.getAgent).toHaveBeenCalled();
      expect(api.createErrorResponse).not.toHaveBeenCalledWith(
        expect.anything(),
        'invalid_request_error',
        'content_filter_uninspectable',
      );
    });

    it('continues when exhausted model parameters are outside the active policy', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      api.extractModelParameterContent.mockImplementationOnce(() => {
        throw {
          code: 'content_filter_uninspectable',
          statusCode: 400,
          body: {
            error: 'content_filter_uninspectable',
            message: 'Submitted content could not be completely inspected before processing.',
            source: 'model_parameter',
            field: 'request_fields',
          },
        };
      });
      api.isContentTraversalProtected.mockReturnValueOnce(false);

      await OpenAIChatCompletionController(req, res);

      expect(db.getAgent).toHaveBeenCalled();
      expect(api.createErrorResponse).not.toHaveBeenCalledWith(
        expect.anything(),
        'invalid_request_error',
        'content_filter_uninspectable',
      );
    });

    it('blocks submitted messages and model parameters before loading the agent', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      api.validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          stop: ['submitted stop sequence'],
        },
      });
      api.inspectContent.mockReturnValueOnce({
        detectorId: 'pii-pattern',
        ruleId: 'sk_prefix',
        label: 'sk- prefix token',
        source: 'model_parameter',
        field: 'stop',
      });

      await OpenAIChatCompletionController(req, res);

      expect(api.extractMessageContent).toHaveBeenCalled();
      expect(api.extractModelParameterContent).toHaveBeenCalledWith(
        expect.objectContaining({ stop: ['submitted stop sequence'] }),
      );
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'Submitted content was blocked.',
        'invalid_request_error',
        'content_filter_block',
      );
    });

    it('blocks manually selected skill names before resolving the skill', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      req.body.manualSkills = ['PRIVATE-SKILL'];
      api.extractManualSkills.mockReturnValueOnce(['PRIVATE-SKILL']);
      api.inspectContent.mockReturnValueOnce({
        detectorId: 'pii-pattern',
        ruleId: 'private',
        label: 'private value',
        source: 'skill',
        field: 'name',
      });

      await OpenAIChatCompletionController(req, res);

      expect(api.extractSkillContent).toHaveBeenCalledWith({ name: 'PRIVATE-SKILL' });
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'Submitted content was blocked.',
        'invalid_request_error',
        'content_filter_block',
      );
    });

    it('rejects filtered model-bound context before starting a streaming response', async () => {
      const api = require('@librechat/api');
      api.validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: true,
        },
      });
      api.assertModelBoundContent.mockImplementationOnce(() => {
        throw Object.assign(new Error('Submitted content contains a private value.'), {
          code: 'content_filter_block',
          statusCode: 400,
          body: {
            error: 'content_filter_block',
            message: 'Submitted content contains a private value. Remove it and try again.',
            source: 'agent_instruction',
            field: 'instructions',
          },
        });
      });

      await OpenAIChatCompletionController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'Submitted content contains a private value. Remove it and try again.',
        'invalid_request_error',
        'content_filter_block',
      );
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(api.writeSSE).not.toHaveBeenCalled();
      expect(api.createRun).not.toHaveBeenCalled();
    });

    it('preflights file-derived content from every reachable agent under a files-only policy', async () => {
      const api = require('@librechat/api');
      const primaryRequestFile = { filename: 'primary-request.txt', content: 'primary request' };
      const primaryContextFile = { filename: 'primary-context.txt', content: 'primary context' };
      const handoffRequestFile = { filename: 'handoff-request.txt', content: 'handoff request' };
      const handoffContextFile = {
        filename: 'handoff-context.txt',
        content: 'sk-handoff-context',
      };
      const nestedRequestFile = { filename: 'nested-request.txt', content: 'nested request' };
      const nestedPureSubagent = {
        id: 'agent-nested-pure',
        model: 'gpt-4',
        model_parameters: {},
        requestAttachments: [nestedRequestFile],
        dynamicToolContextMap: { nested_lookup: 'nested dynamic context' },
      };
      const pureSubagent = {
        id: 'agent-pure',
        model: 'gpt-4',
        model_parameters: {},
        subagentAgentConfigs: [nestedPureSubagent],
      };
      const blockedError = Object.assign(new Error('Submitted file content was blocked.'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted file content was blocked.',
          source: 'file',
          field: 'content',
        },
      });
      req.config.filters = {
        files: { pii: { fields: ['content'], starterPatterns: ['sk-'] } },
      };
      api.validateRequest.mockReturnValueOnce({
        request: { model: 'agent-123', messages: [], stream: true },
      });
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'gpt-4',
        model_parameters: {},
        toolRegistry: {},
        edges: [{ source: 'agent-123', target: 'agent-handoff' }],
        requestAttachments: [primaryRequestFile],
        agentContextAttachments: [primaryContextFile],
        dynamicToolContextMap: { execute_code: 'primary dynamic context' },
        subagentAgentConfigs: [pureSubagent],
      });
      api.discoverConnectedAgents.mockResolvedValueOnce({
        agentConfigs: new Map([
          [
            'agent-handoff',
            {
              id: 'agent-handoff',
              model: 'gpt-4',
              model_parameters: {},
              requestAttachments: [handoffRequestFile],
              agentContextAttachments: [handoffContextFile],
              dynamicToolContextMap: { file_search: 'handoff dynamic context' },
            },
          ],
        ]),
        edges: [],
        skippedAgentIds: new Set(),
        userMCPAuthMap: undefined,
      });
      api.assertModelBoundContent.mockImplementationOnce(({ filters, agents, files }) => {
        expect(filters).toEqual(req.config.filters);
        expect(agents.map(({ id }) => id)).toEqual([
          'agent-123',
          'agent-handoff',
          'agent-pure',
          'agent-nested-pure',
        ]);
        expect(files).toEqual([
          primaryRequestFile,
          primaryContextFile,
          { content: 'primary dynamic context' },
          handoffRequestFile,
          handoffContextFile,
          { content: 'handoff dynamic context' },
          nestedRequestFile,
          { content: 'nested dynamic context' },
        ]);
        throw blockedError;
      });

      await OpenAIChatCompletionController(req, res);

      expect(api.createRun).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        blockedError.body.message,
        'invalid_request_error',
        'content_filter_block',
      );
    });

    it('preflights the exact synthesized dynamic tool context as file content', async () => {
      const api = require('@librechat/api');
      const blockedError = Object.assign(new Error('Submitted file content was blocked.'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted file content was blocked.',
          source: 'file',
          field: 'content',
        },
      });
      req.config.filters = {
        files: { pii: { fields: ['content'], starterPatterns: ['sk-'] } },
      };
      api.validateRequest.mockReturnValueOnce({
        request: { model: 'agent-123', messages: [], stream: true },
      });
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'gpt-4',
        model_parameters: {},
        toolRegistry: {},
        edges: [],
        dynamicToolContextMap: {
          execute_code: '  safe context',
          ignored_empty: '',
          file_search: 'sk-dynamic-file-context  ',
          ignored_non_string: 42,
        },
      });
      api.assertModelBoundContent.mockImplementationOnce(({ filters, files }) => {
        expect(filters).toEqual(req.config.filters);
        expect(files).toEqual([{ content: 'safe context\nsk-dynamic-file-context' }]);
        throw blockedError;
      });

      await OpenAIChatCompletionController(req, res);

      expect(api.createRun).not.toHaveBeenCalled();
      expect(res.setHeader).not.toHaveBeenCalled();
      expect(res.flushHeaders).not.toHaveBeenCalled();
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        blockedError.body.message,
        'invalid_request_error',
        'content_filter_block',
      );
    });
  });

  describe('safe error logging', () => {
    it('does not classify a client disconnect as an upstream model error', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const abortError = Object.assign(new Error('request aborted'), { name: 'AbortError' });
      mockProcessStream.mockImplementationOnce(async () => {
        const modelCallback = api.createRun.mock.calls
          .at(-1)[0]
          .modelCallbacks.find(({ name }) => name === 'librechat-upstream-model-error-tracker');
        modelCallback.handleLLMError(abortError);
        res.once.mock.calls.find(([event]) => event === 'close')[1]();
        throw abortError;
      });

      await OpenAIChatCompletionController(req, res);

      expect(mockExecution.signal.aborted).toBe(true);
      expect(logger.error).not.toHaveBeenCalledWith(
        '[OpenAI API] Upstream model error',
        expect.anything(),
      );
    });

    it('logs bounded metadata and returns a raw-free provider error', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-OPENAI-PROVIDER-PAYLOAD';
      const providerError = Object.assign(new Error(`Provider echoed ${rawValue}`), {
        code: 'ERR_REMOTE',
        response: {
          status: 502,
          headers: { authorization: rawValue },
          data: { prompt: rawValue },
        },
      });
      req.config.filters = { messages: { pii: {} } };
      mockProcessStream.mockImplementationOnce(async () => {
        const modelCallback = api.createRun.mock.calls
          .at(-1)[0]
          .modelCallbacks.find(({ name }) => name === 'librechat-upstream-model-error-tracker');
        modelCallback.handleLLMError(providerError);
        throw new Error('graph failed', { cause: providerError });
      });

      await OpenAIChatCompletionController(req, res);

      const errorLog = logger.error.mock.calls.find(
        ([message]) => message === '[OpenAI API] Upstream model error',
      );
      expect(errorLog).toEqual([
        '[OpenAI API] Upstream model error',
        {
          type: 'Error',
          status: 502,
          errorCode: 'UPSTREAM_MODEL_ERROR',
          errorOrigin: 'model_provider',
          errorType: '502',
          traceId: 'a64360db27015f7d7eadebf78a806ac1',
        },
      ]);
      expect(JSON.stringify(errorLog)).not.toContain(rawValue);
      expect(api.createErrorResponse).toHaveBeenCalledWith(
        'An error occurred while processing the request',
        'server_error',
        null,
      );
      expect(JSON.stringify(api.createErrorResponse.mock.calls)).not.toContain(rawValue);
      expect(res.status).toHaveBeenCalledWith(500);
    });

    it('streams a raw-free provider error after headers are sent', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-OPENAI-STREAM-PAYLOAD';
      const providerError = new Error(`Provider echoed ${rawValue}`);
      api.validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
      });
      req.config.filters = { messages: { pii: {} } };
      res.flushHeaders.mockImplementationOnce(() => {
        res.headersSent = true;
      });
      mockProcessStream.mockImplementationOnce(async () => {
        api.createRun.mock.calls
          .at(-1)[0]
          .modelCallbacks.find(({ name }) => name === 'librechat-upstream-model-error-tracker')
          .handleLLMError(providerError);
        throw providerError;
      });

      await OpenAIChatCompletionController(req, res);

      expect(api.createChunk).toHaveBeenCalledWith(
        expect.any(Object),
        { content: '\n\nError: An error occurred while processing the request' },
        'stop',
      );
      expect(JSON.stringify(api.createChunk.mock.calls)).not.toContain(rawValue);
      expect(JSON.stringify(api.writeSSE.mock.calls)).not.toContain(rawValue);
      expect(logger.error).toHaveBeenCalledWith(
        '[OpenAI API] Upstream model error',
        expect.objectContaining({
          errorCode: 'UPSTREAM_MODEL_ERROR',
          traceId: 'a64360db27015f7d7eadebf78a806ac1',
        }),
      );
    });

    it('preserves the legacy provider error when protection is inactive', async () => {
      const api = require('@librechat/api');
      const rawValue = 'LEGACY-OPENAI-PROVIDER-ERROR';
      mockProcessStream.mockRejectedValueOnce(
        Object.assign(new Error(rawValue), { code: 'ERR_LEGACY_REMOTE' }),
      );

      await OpenAIChatCompletionController(req, res);

      expect(api.createErrorResponse).toHaveBeenCalledWith(
        rawValue,
        'server_error',
        'ERR_LEGACY_REMOTE',
      );
    });

    it.each([
      ['a management-only prompt', { prompts: { pii: {} } }],
      ['an inert message', { messages: { pii: { starterPatterns: [] } } }],
    ])('preserves the legacy provider error for %s policy', async (_policy, filters) => {
      const api = require('@librechat/api');
      const rawValue = 'LEGACY-OPENAI-CONFIGURED-PROVIDER-ERROR';
      req.config.filters = filters;
      mockProcessStream.mockRejectedValueOnce(new Error(rawValue));

      await OpenAIChatCompletionController(req, res);

      expect(api.createErrorResponse).toHaveBeenCalledWith(rawValue, 'server_error', null);
    });

    it('preserves the legacy streamed provider error when protection is inactive', async () => {
      const api = require('@librechat/api');
      const rawValue = 'LEGACY-OPENAI-STREAM-ERROR';
      api.validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [{ role: 'user', content: 'Hello' }],
          stream: true,
        },
      });
      res.flushHeaders.mockImplementationOnce(() => {
        res.headersSent = true;
      });
      mockProcessStream.mockRejectedValueOnce(new Error(rawValue));

      await OpenAIChatCompletionController(req, res);

      expect(api.createChunk).toHaveBeenCalledWith(
        expect.any(Object),
        { content: `\n\nError: ${rawValue}` },
        'stop',
      );
    });

    it('logs bounded metadata for tool callback failures', async () => {
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-OPENAI-TOOL-PAYLOAD';
      const toolError = Object.assign(new Error(`Tool echoed ${rawValue}`), {
        code: 'ERR_TOOL',
        response: { status: 422, data: { output: rawValue } },
      });
      mockProcessStream.mockImplementationOnce(async (_input, _config, options) => {
        options.callbacks.TOOL_ERROR({}, toolError, 'execute_code');
      });

      await OpenAIChatCompletionController(req, res);

      expect(mockGetSafeErrorMetadata).toHaveBeenCalledWith(toolError);
      const errorLog = logger.error.mock.calls.find(([message]) =>
        message.includes('Tool Error "execute_code"'),
      );
      expect(errorLog).toEqual([
        '[OpenAI API] Tool Error "execute_code"',
        { type: 'Error', status: 422 },
      ]);
      expect(JSON.stringify(errorLog)).not.toContain(rawValue);
    });
  });

  describe('conversation ownership validation', () => {
    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      'propagates explicit or owned persisted workspaces: continuation=%s moves=%s',
      async (continuation, movesEnabled) => {
        const api = require('@librechat/api');
        const selections = [{ environmentId: 'machine', workspaceId: 'project' }];
        req.config.endpoints.agents.statefulCodeSessions = {
          conversationMoves: { enabled: movesEnabled },
        };
        api.validateRequest.mockReturnValueOnce({
          request: {
            model: 'agent-123',
            messages: [],
            stream: false,
            ...(continuation ? { conversation_id: 'convo-abc' } : { code_workspaces: selections }),
          },
        });
        if (continuation)
          require('~/models').getConvo.mockResolvedValueOnce({
            conversationId: 'convo-abc',
            codeWorkspaces: selections,
          });
        if (continuation && movesEnabled)
          require('~/models').readAdmittedConvoCodeEnvironmentDecision.mockResolvedValueOnce({
            conversationId: 'convo-abc',
            codeWorkspaces: selections,
          });
        await OpenAIChatCompletionController(req, res);
        const fencedRead = require('~/models').readAdmittedConvoCodeEnvironmentDecision;
        if (movesEnabled) expect(fencedRead).toHaveBeenCalledTimes(1);
        else expect(fencedRead).not.toHaveBeenCalled();
        expect(api.initializeAgent).toHaveBeenCalledWith(
          expect.objectContaining({
            requestBody: expect.objectContaining({ codeWorkspaces: selections }),
          }),
          expect.anything(),
        );
        if (continuation)
          expect(require('~/models').getConvo).toHaveBeenCalledWith('user-123', 'convo-abc');
      },
    );
    it('should skip ownership check when conversation_id is not provided', async () => {
      const { getConvo } = require('~/models');
      await OpenAIChatCompletionController(req, res);
      expect(getConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when conversation_id is not a string', async () => {
      const { validateRequest } = require('@librechat/api');
      validateRequest.mockReturnValueOnce({
        request: { model: 'agent-123', messages: [], stream: false, conversation_id: { $gt: '' } },
      });

      await OpenAIChatCompletionController(req, res);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should return 404 when conversation is not owned by user', async () => {
      const { validateRequest } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          conversation_id: 'convo-abc',
        },
      });
      getConvo.mockResolvedValueOnce(null);

      await OpenAIChatCompletionController(req, res);
      expect(getConvo).toHaveBeenCalledWith('user-123', 'convo-abc');
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('should proceed when conversation is owned by user', async () => {
      const { validateRequest } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          conversation_id: 'convo-abc',
        },
      });
      getConvo.mockResolvedValueOnce({ conversationId: 'convo-abc', user: 'user-123' });

      await OpenAIChatCompletionController(req, res);
      expect(getConvo).toHaveBeenCalledWith('user-123', 'convo-abc');
      expect(res.status).not.toHaveBeenCalledWith(404);
    });

    it('should return 500 when getConvo throws a DB error', async () => {
      const { validateRequest } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          conversation_id: 'convo-abc',
        },
      });
      getConvo.mockRejectedValueOnce(new Error('DB connection failed'));

      await OpenAIChatCompletionController(req, res);
      expect(res.status).toHaveBeenCalledWith(500);
    });
  });

  describe('remote-agent file authorization', () => {
    it('threads the remote-agent permission boundary through initialization and tool loading', async () => {
      const { initializeAgent, createToolExecuteHandler } = require('@librechat/api');
      const { loadAgentTools, loadToolsForExecution } = require('~/server/services/ToolService');
      const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');

      req.config.endpoints.agents.backgroundTasks = {
        ordinaryToolCancellation: true,
        completionResultMaxChars: 4096,
      };
      await OpenAIChatCompletionController(req, res);

      const [initializeParams, dbMethods] = initializeAgent.mock.calls.at(-1);
      const filterParams = {
        files: [{ file_id: 'owner-file', user: 'agent-owner' }],
        userId: 'user-123',
        role: 'USER',
        agentId: 'agent-123',
      };
      await dbMethods.filterFilesByAgentAccess(filterParams);
      expect(filterFilesByAgentAccess).toHaveBeenLastCalledWith({
        ...filterParams,
        resourceType: ResourceType.REMOTE_AGENT,
      });

      await initializeParams.loadTools({
        agentId: 'agent-123',
        tools: ['file_search'],
        provider: 'openAI',
        model: 'gpt-4',
        tool_resources: { file_search: { file_ids: ['owner-file'] } },
      });
      expect(loadAgentTools).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentResourceType: ResourceType.REMOTE_AGENT }),
      );

      const toolExecuteOptions = createToolExecuteHandler.mock.calls.at(-1)[0];
      expect(toolExecuteOptions.ordinaryToolCancellation).toBe(true);
      expect(toolExecuteOptions.backgroundCompletionResultMaxChars).toBe(4096);
      expect(toolExecuteOptions.runSignal).toBe(mockExecution.signal);
      expect(toolExecuteOptions.foregroundRunId).toBe(initializeParams.requestBody.messageId);
      const effectiveSignal = new AbortController().signal;
      await toolExecuteOptions.loadTools(
        ['file_search'],
        'agent-123',
        undefined,
        undefined,
        effectiveSignal,
      );
      expect(loadToolsForExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentResourceType: ResourceType.REMOTE_AGENT,
          requestBody: initializeParams.requestBody,
          signal: effectiveSignal,
        }),
      );
      mockExecution.abort();
      await toolExecuteOptions.loadTools(
        ['file_search'],
        'agent-123',
        undefined,
        undefined,
        undefined,
      );
      expect(loadToolsForExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({ signal: undefined }),
      );
    });

    const credentialCases = () => {
      const {
        OpenIDReauthRequiredError,
        MCPAuthenticationRejectedError,
        MCPAuthenticationRefreshError,
        OboTokenResolutionError,
      } = jest.requireActual('@librechat/api');
      return [
        [new OpenIDReauthRequiredError('Please sign in again'), 401, undefined],
        [
          new MCPAuthenticationRejectedError('private-mcp', false),
          403,
          'MCP_AUTHENTICATION_REJECTED',
        ],
        [
          new MCPAuthenticationRefreshError(new Error('temporary failure')),
          503,
          'MCP_AUTHENTICATION_REFRESH_FAILED',
        ],
        [
          new OboTokenResolutionError('session_refresh_failed', 'Please sign in again', false),
          403,
          'MCP_AUTHENTICATION_REJECTED',
        ],
        [
          new OboTokenResolutionError('exchange_failed', 'Temporary exchange failure', true),
          503,
          'MCP_AUTHENTICATION_REFRESH_FAILED',
        ],
      ];
    };
    it.each(credentialCases())(
      'preserves remote chat credential response metadata: %s',
      async (error, status, code) => {
        const { initializeAgent, createErrorResponse } = require('@librechat/api');
        const { loadAgentTools } = require('~/server/services/ToolService');
        loadAgentTools.mockRejectedValueOnce(error);
        initializeAgent.mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
          await loadTools({
            req,
            res,
            tools: ['search_mcp_private'],
            model: agent.model,
            agentId: agent.id,
            provider: agent.provider,
          });
        });
        await OpenAIChatCompletionController(req, res);
        expect(res.status).toHaveBeenCalledWith(status);
        expect(createErrorResponse).toHaveBeenCalledWith(
          error.message,
          status < 500 ? 'invalid_request_error' : 'server_error',
          code ?? null,
        );
      },
    );

    it('returns 503 when an agent expects MCP tools but resolves none', async () => {
      const { initializeAgent } = require('@librechat/api');
      const { loadAgentTools } = require('~/server/services/ToolService');
      const toolError = Object.assign(new Error('Expected MCP tools are unavailable'), {
        code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
        status: 503,
        statusCode: 503,
      });
      loadAgentTools.mockRejectedValueOnce(toolError);
      initializeAgent.mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
        await loadTools({
          req,
          res,
          tools: ['run_query_mcp_warehouse'],
          model: agent.model,
          agentId: agent.id,
          provider: agent.provider,
        });
      });

      await OpenAIChatCompletionController(req, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(
        require('~/server/services/ToolService').isFatalAgentInitializationError,
      ).toHaveBeenCalledWith(toolError, { signal: loadAgentTools.mock.calls.at(-1)[0].signal });
    });

    it('returns the resource recovery status and code before model invocation', async () => {
      const { createErrorResponse, initializeAgent } = require('@librechat/api');
      const { loadAgentTools } = require('~/server/services/ToolService');
      const toolError = Object.assign(new Error('resource recovery required'), {
        code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
        status: 409,
        statusCode: 409,
      });
      loadAgentTools.mockRejectedValueOnce(toolError);
      initializeAgent.mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
        await loadTools({
          req,
          res,
          tools: ['execute_code'],
          model: agent.model,
          agentId: agent.id,
          provider: agent.provider,
        });
      });

      await OpenAIChatCompletionController(req, res);

      expect(res.status).toHaveBeenCalledWith(409);
      expect(createErrorResponse).toHaveBeenCalledWith(
        'resource recovery required',
        'invalid_request_error',
        ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      );
    });
  });

  describe('execution envelope', () => {
    it('creates the portable run input before agent initialization', async () => {
      req.user = {
        id: 'user-123',
        role: 'USER',
        tenantId: 'stale-user-tenant',
        federatedTokens: { access_token: 'secret' },
      };
      req.tenantId = 'request-tenant';
      const requestBody = {
        ...req.body,
        ephemeralAgent: { skills: true },
        manualSkills: ['review-code'],
        timezone: 'America/New_York',
      };
      req.body = requestBody;
      const { validateRequest, initializeAgent } = require('@librechat/api');
      validateRequest.mockReturnValueOnce({ request: requestBody });

      await OpenAIChatCompletionController(req, res);

      expect(mockCreateAgentRunEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: 'chat.completions',
          principal: {
            ...req.user,
            tenantId: 'request-tenant',
          },
          payload: requestBody,
          requestId: expect.any(String),
          receivedAt: expect.any(Number),
        }),
      );
      expect(mockCreateAgentRunEnvelope.mock.invocationCallOrder[0]).toBeLessThan(
        initializeAgent.mock.invocationCallOrder[0],
      );
      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime: expect.objectContaining({
            turnStartedAt: mockCreateAgentRunEnvelope.mock.results[0].value.receivedAt,
          }),
        }),
        expect.anything(),
      );
      expect(req.turnStartedAt).toBe(mockCreateAgentRunEnvelope.mock.results[0].value.receivedAt);
      expect(req.body).not.toBe(requestBody);
      expect(req.body).toEqual(requestBody);
      expect(JSON.stringify(mockCreateAgentRunEnvelope.mock.results[0].value)).not.toContain(
        'secret',
      );
    });

    it('returns a protocol 400 when the envelope rejects a non-JSON payload', async () => {
      const message = 'payload.max_tokens must contain only finite numbers';
      const { createErrorResponse, initializeAgent } = require('@librechat/api');
      mockCreateAgentRunEnvelope.mockImplementationOnce(() => {
        throw new MockAgentRunEnvelopeError(message);
      });

      await OpenAIChatCompletionController(req, res);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(createErrorResponse).toHaveBeenCalledWith(message, 'invalid_request_error', null);
      expect(initializeAgent).not.toHaveBeenCalled();
    });
  });

  describe('token usage recording', () => {
    it('should call recordCollectedUsage after successful non-streaming completion', async () => {
      await OpenAIChatCompletionController(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledTimes(1);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        {
          spendTokens: mockSpendTokens,
          spendStructuredTokens: mockSpendStructuredTokens,
          pricing: { getMultiplier: mockGetMultiplier, getCacheMultiplier: mockGetCacheMultiplier },
          bulkWriteOps: {
            insertMany: mockBulkInsertTransactions,
            updateBalance: mockUpdateBalance,
          },
        },
        expect.objectContaining({
          user: 'user-123',
          conversationId: expect.any(String),
          collectedUsage: expect.any(Array),
          context: 'message',
          balance: { enabled: true },
          transactions: { enabled: true },
        }),
      );
    });

    it('should pass balance and transactions config to recordCollectedUsage', async () => {
      mockGetBalanceConfig.mockReturnValue({ enabled: true, startBalance: 1000 });
      mockGetTransactionsConfig.mockReturnValue({ enabled: true, rateLimit: 100 });

      await OpenAIChatCompletionController(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          balance: { enabled: true, startBalance: 1000 },
          transactions: { enabled: true, rateLimit: 100 },
        }),
      );
    });

    it('should pass spendTokens, spendStructuredTokens, pricing, and bulkWriteOps as dependencies', async () => {
      await OpenAIChatCompletionController(req, res);

      const [deps] = mockRecordCollectedUsage.mock.calls[0];
      expect(deps).toHaveProperty('spendTokens', mockSpendTokens);
      expect(deps).toHaveProperty('spendStructuredTokens', mockSpendStructuredTokens);
      expect(deps).toHaveProperty('pricing');
      expect(deps.pricing).toHaveProperty('getMultiplier', mockGetMultiplier);
      expect(deps.pricing).toHaveProperty('getCacheMultiplier', mockGetCacheMultiplier);
      expect(deps).toHaveProperty('bulkWriteOps');
      expect(deps.bulkWriteOps).toHaveProperty('insertMany', mockBulkInsertTransactions);
      expect(deps.bulkWriteOps).toHaveProperty('updateBalance', mockUpdateBalance);
    });

    it('should include model from primaryConfig in recordCollectedUsage params', async () => {
      await OpenAIChatCompletionController(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          model: 'gpt-4',
        }),
      );
    });
  });

  describe('recursionLimit resolution', () => {
    it('threads the OpenAI parent message id through both MCP execution bodies', async () => {
      const { validateRequest, createRun, initializeAgent } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          conversation_id: 'conversation-123',
          parent_message_id: 'parent-123',
        },
      });
      getConvo.mockResolvedValueOnce({ conversationId: 'conversation-123', user: 'user-123' });

      await OpenAIChatCompletionController(req, res);

      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            messageId: 'chatcmpl-mock-nanoid-123',
            conversationId: 'conversation-123',
            parentMessageId: 'parent-123',
            codeEnvironmentMode: 'without_attached',
          },
        }),
        expect.anything(),
      );
      expect(createRun).toHaveBeenCalledWith(
        expect.objectContaining({
          requestBody: {
            messageId: 'chatcmpl-mock-nanoid-123',
            conversationId: 'conversation-123',
            parentMessageId: 'parent-123',
            codeEnvironmentMode: 'without_attached',
          },
        }),
      );
      expect(mockProcessStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          configurable: expect.objectContaining({
            requestBody: {
              messageId: 'chatcmpl-mock-nanoid-123',
              conversationId: 'conversation-123',
              parentMessageId: 'parent-123',
              codeEnvironmentMode: 'without_attached',
            },
          }),
        }),
        expect.anything(),
      );
    });

    it('does not synthesize an MCP parent for a continuation that omits it', async () => {
      const { validateRequest, initializeAgent } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          messages: [],
          stream: false,
          conversation_id: 'conversation-123',
        },
      });
      getConvo.mockResolvedValueOnce({ conversationId: 'conversation-123', user: 'user-123' });

      await OpenAIChatCompletionController(req, res);

      const requestBody = initializeAgent.mock.calls.at(-1)[0].requestBody;
      expect(requestBody).toEqual({
        messageId: 'chatcmpl-mock-nanoid-123',
        conversationId: 'conversation-123',
        codeEnvironmentMode: 'without_attached',
      });
      expect(requestBody).not.toHaveProperty('parentMessageId');
    });

    it('should pass resolveRecursionLimit result to processStream config', async () => {
      const { resolveRecursionLimit } = require('@librechat/api');
      resolveRecursionLimit.mockReturnValueOnce(75);

      await OpenAIChatCompletionController(req, res);

      expect(mockProcessStream).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ recursionLimit: 75 }),
        expect.anything(),
      );
    });

    it('should call resolveRecursionLimit with agentsEConfig and agent', async () => {
      const { resolveRecursionLimit } = require('@librechat/api');
      const { getAgent } = require('~/models');
      const mockAgent = { id: 'agent-123', name: 'Test', recursion_limit: 200 };
      getAgent.mockResolvedValueOnce(mockAgent);

      req.config = {
        endpoints: {
          agents: { recursionLimit: 100, maxRecursionLimit: 150, allowedProviders: [] },
        },
      };

      await OpenAIChatCompletionController(req, res);

      expect(resolveRecursionLimit).toHaveBeenCalledWith(req.config.endpoints.agents, mockAgent);
    });
  });

  describe('sub-agent skill priming', () => {
    it('passes the sub-agent primed skill IDs into tool execution', async () => {
      const {
        initializeAgent,
        discoverConnectedAgents,
        createToolExecuteHandler,
      } = require('@librechat/api');
      const { loadToolsForExecution } = require('~/server/services/ToolService');
      const subAgent = { id: 'agent-sub', name: 'Sub Agent' };
      const subConfig = {
        id: 'agent-sub',
        model: 'gpt-4',
        model_parameters: {},
        toolRegistry: new Map(),
        userMCPAuthMap: { sub: { token: 'sub-token' } },
        tool_resources: { code_interpreter: { file_ids: ['sub-file'] } },
        actionsEnabled: true,
        accessibleSkillIds: ['sub-skill-id'],
        activeSkillNames: ['sub-hidden-skill'],
        codeEnvAvailable: true,
        skillAuthoringAvailable: true,
        fileAuthoringToolNames: ['create_file', 'edit_file'],
        manualSkillPrimes: [{ name: 'sub-hidden-skill', _id: { toString: () => 'sub-manual-id' } }],
        alwaysApplySkillPrimes: [
          { name: 'sub-always-skill', _id: { toString: () => 'sub-always-id' } },
        ],
      };

      initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'gpt-4',
        model_parameters: {},
        toolRegistry: new Map(),
        edges: [{ source: 'agent-123', target: 'agent-sub' }],
        accessibleSkillIds: ['primary-skill-id'],
        activeSkillNames: ['primary-skill'],
        codeEnvAvailable: false,
        skillAuthoringAvailable: false,
        fileAuthoringToolNames: [],
        manualSkillPrimes: [{ name: 'primary-skill', _id: { toString: () => 'primary-skill-id' } }],
      });
      discoverConnectedAgents.mockImplementationOnce(async (_params, deps) => {
        deps.onAgentInitialized('agent-sub', subAgent, subConfig);
        return {
          agentConfigs: new Map([['agent-sub', subConfig]]),
          edges: [],
          skippedAgentIds: new Set(),
          userMCPAuthMap: undefined,
        };
      });

      await OpenAIChatCompletionController(req, res);

      const toolExecuteOptions = createToolExecuteHandler.mock.calls.at(-1)[0];
      await toolExecuteOptions.loadTools(['read_file'], 'agent-sub');

      expect(loadToolsForExecution).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agent: subAgent,
          toolRegistry: subConfig.toolRegistry,
          userMCPAuthMap: subConfig.userMCPAuthMap,
          tool_resources: subConfig.tool_resources,
          actionsEnabled: true,
        }),
      );
      expect(mockEnrichWithSkillConfigurable).toHaveBeenLastCalledWith({
        result: expect.anything(),
        context: {
          req,
          accessibleSkillIds: ['sub-skill-id'],
          codeEnvAvailable: true,
          skillPrimedIdsByName: {
            'sub-always-skill': 'sub-always-id',
            'sub-hidden-skill': 'sub-manual-id',
          },
          activeSkillNames: ['sub-hidden-skill'],
          skillAuthoringAvailable: true,
          fileAuthoringToolNames: ['create_file', 'edit_file'],
        },
      });
    });
  });

  describe('file search role gating', () => {
    const setCapabilities = (capabilities) => {
      req.config.endpoints.agents.capabilities = capabilities;
    };

    it('reports file search available when the capability and the grant agree', async () => {
      const { initializeAgent } = require('@librechat/api');
      setCapabilities(['file_search']);

      await OpenAIChatCompletionController(req, res);

      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable: true }),
        expect.anything(),
      );
    });

    /** `initializeAgent` re-hydrates prior-turn `file_search` files from this
     *  flag, so a denied role must reach it — dropping the tool downstream still
     *  leaves the files read, their usage bumped and their resources primed. */
    it('withholds it when the role is denied FILE_SEARCH', async () => {
      const { initializeAgent, resolveToolRoleGrants } = require('@librechat/api');
      resolveToolRoleGrants.mockResolvedValueOnce({ runCode: true, fileSearch: false });
      setCapabilities(['file_search']);

      await OpenAIChatCompletionController(req, res);

      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable: false }),
        expect.anything(),
      );
    });

    /** Both flags are false without their capability, so the role read would be
     *  pure load on every request. */
    it('reads no role at all when neither capability is enabled', async () => {
      const { initializeAgent, resolveToolRoleGrants } = require('@librechat/api');
      setCapabilities([]);

      await OpenAIChatCompletionController(req, res);

      expect(resolveToolRoleGrants).not.toHaveBeenCalled();
      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable: false, codeEnvAvailable: false }),
        expect.anything(),
      );
    });

    /** One lookup answers both grants, so enabling either capability pays for
     *  the other's pairing too. */
    it('pairs both flags from a single role read', async () => {
      const { initializeAgent, resolveToolRoleGrants } = require('@librechat/api');
      setCapabilities(['file_search', 'execute_code']);

      await OpenAIChatCompletionController(req, res);

      expect(resolveToolRoleGrants).toHaveBeenCalledTimes(1);
      expect(initializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable: true, codeEnvAvailable: true }),
        expect.anything(),
      );
    });
  });

  describe('web search role gating', () => {
    const setCapabilities = (capabilities) => {
      req.config.endpoints.agents.capabilities = capabilities;
    };

    const passedResolver = () => {
      const { initializeAgent } = require('@librechat/api');
      return initializeAgent.mock.calls[0][0].resolveWebSearchGrant;
    };

    /** Provider-native search is a model parameter with no capability of its own,
     *  so the resolver is handed over whatever the capabilities — but it reads
     *  nothing until the initializer finds native search in the built config. */
    it('hands initializeAgent a grant resolver without reading the role', async () => {
      const { resolveToolRoleGrants } = require('@librechat/api');
      setCapabilities([]);

      await OpenAIChatCompletionController(req, res);

      expect(passedResolver()).toEqual(expect.any(Function));
      expect(resolveToolRoleGrants).not.toHaveBeenCalled();
    });

    it('resolves the WEB_SEARCH grant against this request when called', async () => {
      const { resolveToolRoleGrants } = require('@librechat/api');
      resolveToolRoleGrants.mockResolvedValueOnce({
        runCode: true,
        fileSearch: true,
        webSearch: false,
      });
      setCapabilities([]);

      await OpenAIChatCompletionController(req, res);

      await expect(passedResolver()()).resolves.toBe(false);
      expect(resolveToolRoleGrants).toHaveBeenCalledWith(expect.objectContaining({ req }));
    });
  });
});
