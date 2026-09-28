/**
 * Unit tests for Open Responses API controller
 * Tests that recordCollectedUsage is called correctly for token spending
 */

const { ErrorTypes, ResourceType } = require('librechat-data-provider');

const mockSpendTokens = jest.fn().mockResolvedValue({});
const mockSpendStructuredTokens = jest.fn().mockResolvedValue({});
const mockRecordCollectedUsage = jest
  .fn()
  .mockResolvedValue({ input_tokens: 100, output_tokens: 50 });
const mockGetBalanceConfig = jest.fn().mockReturnValue({ enabled: true });
const mockGetTransactionsConfig = jest.fn().mockReturnValue({ enabled: true });
const mockResolveMemoryAvailability = jest.fn().mockResolvedValue(true);
const mockInitialSessions = new Map([['execute_code', { session_id: 'seeded' }]]);
const mockInspectContent = jest.fn().mockReturnValue(null);
const mockResolveConversationTitle = jest.fn(({ filters, candidate, fallback = 'New Chat' }) => {
  const resolveAllowedTitle = (value) => {
    if (typeof value !== 'string' || value.trim() === '') {
      return null;
    }
    const finding = mockInspectContent(
      [{ source: 'conversation_title', field: 'title', text: value }],
      { filters },
    );
    return finding == null ? value : null;
  };

  return (
    resolveAllowedTitle(candidate) ??
    (fallback === candidate ? null : resolveAllowedTitle(fallback))
  );
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
const mockGetSafeErrorMetadata = jest.fn((error) => {
  const status = error?.status ?? error?.statusCode ?? error?.response?.status;
  return {
    type: error instanceof Error ? 'Error' : 'UnknownError',
    ...(Number.isInteger(status) && status >= 100 && status <= 599 && { status }),
  };
});
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
const mockBuildAgentScopedContext = jest.fn().mockResolvedValue(new Map());
const mockBuildAgentContextAttachmentsByAgentId = jest.fn().mockReturnValue(new Map());
const mockBuildInlineMemoryContext = jest.fn().mockResolvedValue('');
const mockApplyContextToAgent = jest.fn().mockResolvedValue(undefined);
const mockResponsesUsage = {
  input_tokens: 125,
  output_tokens: 50,
  total_tokens: 175,
  input_tokens_details: { cached_tokens: 0 },
  output_tokens_details: { reasoning_tokens: 0 },
  primary: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
  subagent: { input_tokens: 25, output_tokens: 10, total_tokens: 35 },
};
const mockBuildResponsesUsage = jest.fn().mockReturnValue(mockResponsesUsage);
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

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'mock-nanoid-123'),
}));

jest.mock('uuid', () => ({
  v4: jest.fn(() => 'mock-uuid-456'),
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
  SAFE_CONVERSATION_TITLE: 'New Chat',
  resolveConversationTitle: (...args) => mockResolveConversationTitle(...args),
  /** Pass-through: the controller strips UI-only activity-label parts
   *  before SDK formatting; the mock must expose it like any other used
   *  export or the call throws before the assertions run. */
  stripActivityLabelParts: jest.fn((payload) => payload),
  /** Pass-through by default; the history-strip test swaps in its own result
   *  to prove the formatter receives what this returns. */
  stripUnusableSummaryParts: jest.fn((payload) => payload),
  createOwnedToolEndHandler: jest.fn(
    (...args) => new (require('@librechat/agents').ToolEndHandler)(...args),
  ),
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
  createRun: jest.fn().mockResolvedValue({
    processStream: jest.fn().mockResolvedValue(undefined),
  }),
  createTerminalRunErrorObserver: (...args) =>
    jest.requireActual('@librechat/api').createTerminalRunErrorObserver(...args),
  buildInitialToolSessions: jest.fn().mockReturnValue(mockInitialSessions),
  applyContextToAgent: (...args) => mockApplyContextToAgent(...args),
  buildRunToolSet: jest.fn().mockReturnValue(new Set()),
  /** No fixture declares a caller-executed tool, so the handoff stays inert. */
  createClientToolHandoff: jest.fn(({ agentDefinitions }) => ({
    toolDefinitions: agentDefinitions,
    appliedTools: [],
    wrapRunStep: (delegate) => delegate,
    wrapToolExecute: (delegate) => delegate,
  })),
  AgentRunEnvelopeError: MockAgentRunEnvelopeError,
  createAgentRunEnvelope: (...args) => mockCreateAgentRunEnvelope(...args),
  resolveAdmittedCodeEnvironmentDecision: (...args) =>
    jest.requireActual('@librechat/api').resolveAdmittedCodeEnvironmentDecision(...args),
  resolvePersistableCodeEnvironmentDecision: (...args) =>
    jest.requireActual('@librechat/api').resolvePersistableCodeEnvironmentDecision(...args),
  getCodeWorkspaceSelections: jest.fn(),
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
  buildAgentScopedContext: (...args) => mockBuildAgentScopedContext(...args),
  buildInlineMemoryContext: (...args) => mockBuildInlineMemoryContext(...args),
  buildAgentContextAttachmentsByAgentId: (...args) =>
    mockBuildAgentContextAttachmentsByAgentId(...args),
  scopeSkillIds: jest.fn().mockImplementation((ids) => ids),
  resolveAgentScopedSkillIds: jest
    .fn()
    .mockImplementation(({ accessibleSkillIds }) => accessibleSkillIds),
  loadSkillStates: jest.fn().mockResolvedValue({ skillStates: {}, defaultActiveOnShare: false }),
  createSafeUser: jest.fn().mockReturnValue({ id: 'user-123' }),
  initializeAgent: jest.fn().mockResolvedValue({
    id: 'agent-123',
    model: 'claude-3',
    model_parameters: {},
    toolRegistry: {},
    edges: [],
    agentContextAttachments: [],
  }),
  discoverConnectedAgents: jest.fn().mockImplementation(async (computedParams, deps) => {
    // Call onAgentInitialized for each agent config if provided by the mock setup
    if (deps?.onAgentInitialized && mockGlobalDiscoveredAgentConfigs) {
      for (const [agentId, config] of mockGlobalDiscoveredAgentConfigs) {
        deps.onAgentInitialized(agentId, config, config);
      }
    }
    return {
      agentConfigs: mockGlobalDiscoveredAgentConfigs ?? new Map(),
      edges: [],
      skippedAgentIds: new Set(),
      userMCPAuthMap: undefined,
    };
  }),
  resolveSubagentGraphs: jest.fn().mockResolvedValue(undefined),
  getBalanceConfig: mockGetBalanceConfig,
  getTransactionsConfig: mockGetTransactionsConfig,
  recordCollectedUsage: mockRecordCollectedUsage,
  createSubagentUsageSink: jest.fn().mockReturnValue(jest.fn()),
  CHILD_THREAD_READ_ONLY_ERROR:
    'This subagent thread is view-only. Continue it from its parent agent or create a separate chat.',
  getLangfuseTraceMessageFields: jest.fn().mockResolvedValue({
    langfuseSampled: true,
    langfuseDestinationIds: ['destination-1'],
  }),
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
  createToolExecuteHandler: jest.fn().mockReturnValue({ handle: jest.fn() }),
  resolveRecursionLimit: jest.fn().mockReturnValue(50),
  // Responses API
  writeDone: jest.fn(),
  buildResponse: jest.fn().mockReturnValue({ id: 'resp_123', output: [] }),
  generateResponseId: jest.fn().mockReturnValue('resp_mock-123'),
  isValidationFailure: jest.fn().mockReturnValue(false),
  inspectContent: mockInspectContent,
  extractConversationTitleContent: jest.fn(({ title }) => [
    { source: 'conversation_title', field: 'title', text: title },
  ]),
  extractAgentContent: jest.fn().mockReturnValue([]),
  extractFileContent: jest.fn().mockReturnValue([]),
  extractMessageContent: jest.fn().mockReturnValue([]),
  extractModelParameterContent: jest.fn().mockReturnValue([]),
  extractSkillContent: jest.fn().mockReturnValue([]),
  extractToolArgumentContent: jest.fn().mockReturnValue([]),
  getBlockedOpaqueFileField: jest.fn().mockReturnValue(null),
  getContentTraversalFragments: jest.fn().mockReturnValue([]),
  isContentTraversalProtected: jest.fn().mockReturnValue(true),
  isContentTraversalLimitError: jest.fn((error) => error?.code === 'content_filter_uninspectable'),
  prependContentTraversalFragments: jest.fn(),
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
  emitResponseCreated: jest.fn(),
  createResponseContext: jest.fn().mockReturnValue({ responseId: 'resp_123' }),
  createResponseTracker: jest.fn().mockReturnValue({
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cachedTokens: 0 },
  }),
  setupStreamingResponse: jest.fn(),
  emitResponseInProgress: jest.fn(),
  convertInputToMessages: jest.fn().mockReturnValue([]),
  validateResponseRequest: jest.fn().mockReturnValue({
    request: { model: 'agent-123', input: 'Hello', stream: false },
  }),
  buildAggregatedResponse: jest.fn().mockReturnValue({
    id: 'resp_123',
    status: 'completed',
    output: [],
    usage: { input_tokens: 100, output_tokens: 50, total_tokens: 150 },
  }),
  buildResponsesUsage: mockBuildResponsesUsage,
  createResponseAggregator: jest.fn().mockReturnValue({
    usage: { inputTokens: 100, outputTokens: 50, reasoningTokens: 0, cachedTokens: 0 },
  }),
  sendResponsesErrorResponse: jest.fn(),
  createResponsesEventHandlers: jest.fn().mockReturnValue({
    handlers: {
      on_message_delta: { handle: jest.fn() },
      on_reasoning_delta: { handle: jest.fn() },
      on_run_step: { handle: jest.fn() },
      on_run_step_delta: { handle: jest.fn() },
      on_chat_model_end: { handle: jest.fn() },
    },
    finalizeStream: jest.fn(),
  }),
  createAggregatorEventHandlers: jest.fn().mockReturnValue({
    on_message_delta: { handle: jest.fn() },
    on_reasoning_delta: { handle: jest.fn() },
    on_run_step: { handle: jest.fn() },
    on_run_step_delta: { handle: jest.fn() },
    on_chat_model_end: { handle: jest.fn() },
  }),
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

jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn().mockResolvedValue([]),
  loadToolsForExecution: jest.fn().mockResolvedValue([]),
  isFatalAgentInitializationError: jest.fn((error) =>
    ['AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 'resource_recovery_required'].includes(error?.code),
  ),
}));

const mockGetMultiplier = jest.fn().mockReturnValue(1);
const mockGetCacheMultiplier = jest.fn().mockReturnValue(null);

jest.mock('~/server/controllers/agents/callbacks', () => {
  const noop = { handle: jest.fn() };
  return {
    createToolEndCallback: jest.fn().mockReturnValue(jest.fn()),
    createResponsesToolEndCallback: jest.fn().mockReturnValue(jest.fn()),
    contextualizeModelUsage: jest.fn().mockImplementation((usage) => usage),
    agentLogHandlerObj: noop,
    buildSummarizationHandlers: jest.fn().mockReturnValue({
      on_summarize_start: noop,
      on_summarize_delta: noop,
      on_summarize_complete: noop,
    }),
  };
});

jest.mock('~/server/services/PermissionService', () => ({
  findAccessibleResources: jest.fn().mockResolvedValue([]),
  checkPermission: jest.fn().mockResolvedValue(true),
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
  getMessages: jest.fn().mockResolvedValue([]),
  saveMessage: jest.fn().mockResolvedValue({}),
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
  saveConvo: jest.fn().mockResolvedValue({}),
  getConvo: jest.fn().mockResolvedValue(null),
  readAdmittedConvoCodeEnvironmentDecision: jest.fn().mockResolvedValue(null),
  isSubagentOwnerAdmissible: jest.fn().mockResolvedValue(true),
}));

let mockGlobalDiscoveredAgentConfigs = null;

describe('createResponse controller', () => {
  let createResponse;
  let req, res;

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockExecution();
    mockGlobalDiscoveredAgentConfigs = null;
    require('@librechat/api').inspectContent.mockReset().mockReturnValue(null);

    const controller = require('../responses');
    createResponse = controller.createResponse;

    req = {
      body: {
        model: 'agent-123',
        input: 'Hello',
        stream: false,
      },
      user: { id: 'user-123' },
      config: {
        endpoints: {
          agents: { allowedProviders: ['anthropic'] },
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

  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'passes explicit or owner-loaded workspace selections to runtime: continuation=%s moves=%s',
    async (continuation, movesEnabled) => {
      const api = require('@librechat/api');
      const selections = [{ environmentId: 'machine', workspaceId: 'project' }];
      req.config.endpoints.agents.statefulCodeSessions = {
        conversationMoves: { enabled: movesEnabled },
      };
      const request = {
        model: 'agent-123',
        input: 'Hello',
        stream: false,
        ...(continuation ? { previous_response_id: 'previous' } : { code_workspaces: selections }),
      };
      api.validateResponseRequest.mockReturnValueOnce({ request });
      if (continuation)
        require('~/models').getConvo.mockResolvedValueOnce({
          conversationId: 'previous',
          codeWorkspaces: selections,
        });
      if (continuation && movesEnabled)
        require('~/models').readAdmittedConvoCodeEnvironmentDecision.mockResolvedValueOnce({
          conversationId: 'previous',
          codeWorkspaces: selections,
        });
      await createResponse(req, res);
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
        expect(require('~/models').getConvo).toHaveBeenCalledWith('user-123', 'previous');
    },
  );

  /** The SDK formatter takes the last summary part carrying text as the history
   *  boundary, so a stored summary whose round failed would replace the turns it
   *  never finished summarizing. The formatter must see the stripped history. */
  it('formats continued history only after unusable summaries are stripped', async () => {
    const api = require('@librechat/api');
    const db = require('~/models');
    const { formatAgentMessages } = require('@librechat/agents');
    const storedContent = [
      { type: 'text', text: 'Earlier answer' },
      { type: 'summary', content: [{ type: 'text', text: 'Partial summ' }], failed: true },
    ];
    const stripped = [{ role: 'assistant', content: [{ type: 'text', text: 'Earlier answer' }] }];
    api.validateResponseRequest.mockReturnValueOnce({
      request: {
        model: 'agent-123',
        input: 'Hello',
        stream: false,
        previous_response_id: 'previous',
      },
    });
    db.getConvo.mockResolvedValueOnce({ conversationId: 'previous', user: 'user-123' });
    db.getMessages.mockResolvedValueOnce([
      { messageId: 'stored-assistant', isCreatedByUser: false, content: storedContent },
    ]);
    api.stripUnusableSummaryParts.mockReturnValueOnce(stripped);

    await createResponse(req, res);

    expect(api.stripUnusableSummaryParts).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'stored-assistant', content: storedContent }),
      ]),
    );
    expect(formatAgentMessages).toHaveBeenCalledWith(stripped, {}, expect.anything());
  });

  it.each([false, true])(
    'persists the normalized no-attached decision atomically: stream=%s',
    async (stream) => {
      const api = require('@librechat/api');
      const db = require('~/models');
      api.getCodeWorkspaceSelections.mockReturnValueOnce([
        { environmentId: 'machine', workspaceId: 'stale-project' },
      ]);
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream,
          store: true,
          code_environment_mode: 'without_attached',
        },
      });

      await createResponse(req, res);

      expect(db.saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          codeEnvironmentMode: 'without_attached',
        }),
        expect.anything(),
      );
      expect(db.saveConvo.mock.calls.at(-1)[1]).not.toHaveProperty('codeWorkspaces');
      expect(api.getCodeWorkspaceSelections).not.toHaveBeenCalled();
    },
  );

  it('keeps the stored decision when a continued conversation is saved', async () => {
    const api = require('@librechat/api');
    const db = require('~/models');
    api.validateResponseRequest.mockReturnValueOnce({
      request: {
        model: 'agent-123',
        input: 'Hello',
        stream: false,
        store: true,
        previous_response_id: 'previous',
      },
    });
    db.getConvo.mockResolvedValueOnce({
      conversationId: 'previous',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [{ environmentId: 'vm', workspaceId: 'projects' }],
    });

    await createResponse(req, res);

    const saved = db.saveConvo.mock.calls.at(-1)[1];
    expect(saved).toEqual(expect.objectContaining({ conversationId: 'previous' }));
    expect(saved).not.toHaveProperty('codeEnvironmentMode');
    expect(saved).not.toHaveProperty('codeWorkspaces');
  });

  it('enrolls, starts, and settles the remote execution lifecycle', async () => {
    await createResponse(req, res);

    expect(mockEnrollAgentExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: 'resp_mock-123',
        userId: 'user-123',
        agentId: 'agent-123',
        protocol: 'responses',
      }),
    );
    const { createRun } = require('@librechat/api');
    const processStream = await createRun.mock.results.at(-1).value;
    expect(mockExecution.beginProviderExecution).toHaveBeenCalledTimes(1);
    expect(mockExecution.beginProviderExecution.mock.invocationCallOrder[0]).toBeLessThan(
      require('@librechat/api').initializeAgent.mock.invocationCallOrder[0],
    );
    expect(mockExecution.beginProviderExecution.mock.invocationCallOrder[0]).toBeLessThan(
      processStream.processStream.mock.invocationCallOrder[0],
    );
    expect(mockExecution.settle).toHaveBeenCalledWith(undefined);
    expect(res.once).toHaveBeenCalledWith('close', expect.any(Function));
    expect(res.off).toHaveBeenCalledWith('close', expect.any(Function));
  });

  it('covers artifact writes when provider execution fails', async () => {
    const providerError = new Error('provider aborted');
    const artifactWrite = Promise.resolve(null);
    const processStream = jest.fn().mockRejectedValue(providerError);
    const { createRun } = require('@librechat/api');
    const { createToolEndCallback } = require('~/server/controllers/agents/callbacks');
    createRun.mockResolvedValueOnce({ processStream });
    createToolEndCallback.mockImplementationOnce(({ artifactPromises }) => {
      artifactPromises.push(artifactWrite);
      return jest.fn();
    });

    await createResponse(req, res);

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

    const request = createResponse(req, res);
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

    await createResponse(req, res);

    expect(mockExecution.abort).not.toHaveBeenCalled();
    expect(mockExecution.beginProviderExecution).toHaveBeenCalledTimes(1);
  });

  it('includes persistent-memory guidance in an inline agent with no saved memories', async () => {
    const api = require('@librechat/api');
    const { memoryInstructions, buildInlineMemoryContext } = jest.requireActual('@librechat/api');
    const agent = {
      id: 'agent-123',
      model: 'claude-3',
      model_parameters: {},
      toolRegistry: {},
      edges: [],
      memoryToolsRegistered: true,
    };
    api.initializeAgent.mockResolvedValueOnce(agent);
    mockBuildInlineMemoryContext.mockImplementationOnce(buildInlineMemoryContext);

    await createResponse(req, res);

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

  it('resolves saved graph subagents for remote Responses API runs', async () => {
    const { initializeAgent, resolveSubagentGraphs } = require('@librechat/api');
    const primaryConfig = {
      id: 'agent-123',
      model: 'claude-3',
      endpointTokenConfig: { 'claude-3': { prompt: 1 } },
      model_parameters: {},
      toolRegistry: {},
      edges: [],
      agentContextAttachments: [],
      subagents: {
        enabled: true,
        graphs: [{ type: 'team', agent_ids: ['agent-123'], edges: [] }],
      },
    };
    initializeAgent.mockResolvedValueOnce(primaryConfig);
    const memberConfig = {
      id: 'agent-graph-member',
      endpointTokenConfig: { 'custom-model': { prompt: 7 } },
      agentContextAttachments: [{ file_id: 'member-file' }],
    };
    resolveSubagentGraphs.mockImplementationOnce(async ({ rootConfigs }, deps) => {
      rootConfigs[0].subagentGraphConfigs = [
        { definition: { type: 'team' }, memberConfigs: [memberConfig] },
      ];
      deps.onAgentInitialized(memberConfig.id, memberConfig, memberConfig);
    });
    req.config.endpoints.agents.capabilities = ['subagents'];

    await createResponse(req, res);

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
    const usageParams = mockRecordCollectedUsage.mock.calls[0][1];
    expect(usageParams.endpointTokenConfig).toBe(primaryConfig.endpointTokenConfig);
    expect(usageParams.resolveEndpointTokenConfig({ agentId: memberConfig.id })).toBe(
      memberConfig.endpointTokenConfig,
    );
    expect(mockResolveMemoryAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ enabledCapabilities: expect.any(Set), user: req.user }),
    );
    const { createRun } = require('@librechat/api');
    expect(createRun).toHaveBeenCalledWith(
      expect.objectContaining({
        initialSessions: mockInitialSessions,
        user: expect.objectContaining({ id: 'user-123' }),
        traceContext: { endpoint: 'agents' },
      }),
    );
  });

  it.each([false, true])(
    'excludes caller-executed tools from eager execution: stream=%s',
    async (stream) => {
      const api = require('@librechat/api');
      const clientToolNames = new Set(['submit_sql']);
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input: 'Hello', stream },
      });
      api.createClientToolHandoff.mockImplementationOnce(({ agentDefinitions }) => ({
        toolDefinitions: agentDefinitions,
        appliedTools: [],
        clientToolNames,
        wrapRunStep: (delegate) => delegate,
        wrapToolExecute: (delegate) => delegate,
      }));

      await createResponse(req, res);

      expect(api.createRun).toHaveBeenCalledWith(expect.objectContaining({ clientToolNames }));
    },
  );

  it('invokes the graph with the resolved recursion limit rather than the SDK default', async () => {
    const api = require('@librechat/api');
    const processStream = jest.fn().mockResolvedValue(undefined);
    api.createRun.mockResolvedValueOnce({ processStream });
    api.resolveRecursionLimit.mockReturnValueOnce(123);

    await createResponse(req, res);

    expect(processStream).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ recursionLimit: 123 }),
      expect.anything(),
    );
  });

  it('returns 503 when an agent expects MCP tools but resolves none', async () => {
    const { initializeAgent, sendResponsesErrorResponse } = require('@librechat/api');
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

    await createResponse(req, res);

    expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
      res,
      503,
      'Expected MCP tools are unavailable',
      'server_error',
      'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
    );
    expect(
      require('~/server/services/ToolService').isFatalAgentInitializationError,
    ).toHaveBeenCalledWith(toolError, { signal: loadAgentTools.mock.calls.at(-1)[0].signal });
  });

  it('returns the resource recovery status and code before model invocation', async () => {
    const { initializeAgent, sendResponsesErrorResponse } = require('@librechat/api');
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

    await createResponse(req, res);

    expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
      res,
      409,
      'resource recovery required',
      'invalid_request',
      ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
    );
  });

  it('stores Langfuse trace markers with a persisted response', async () => {
    const api = require('@librechat/api');
    const { saveMessage } = require('~/models');
    api.validateResponseRequest.mockReturnValueOnce({
      request: { ...req.body, store: true },
    });

    await createResponse(req, res);

    expect(api.getLangfuseTraceMessageFields).toHaveBeenCalledWith(req.config, 'resp_mock-123');
    expect(saveMessage).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        messageId: 'resp_mock-123',
        isCreatedByUser: false,
        langfuseSampled: true,
        langfuseDestinationIds: ['destination-1'],
        tokenCount: 50,
      }),
      { context: 'Responses API - save assistant response' },
    );
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
        isTemporary: true,
      };
      req.body = requestBody;
      const { validateResponseRequest, initializeAgent } = require('@librechat/api');
      validateResponseRequest.mockReturnValueOnce({ request: requestBody });

      await createResponse(req, res);

      expect(mockCreateAgentRunEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          protocol: 'responses',
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
          requestBody: {
            messageId: 'resp_mock-123',
            conversationId: expect.any(String),
            codeEnvironmentMode: 'without_attached',
          },
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
      const message = 'payload.max_output_tokens must contain only finite numbers';
      const { sendResponsesErrorResponse, initializeAgent } = require('@librechat/api');
      mockCreateAgentRunEnvelope.mockImplementationOnce(() => {
        throw new MockAgentRunEnvelopeError(message);
      });

      await createResponse(req, res);

      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(res, 400, message, 'invalid_request');
      expect(initializeAgent).not.toHaveBeenCalled();
    });
  });

  describe('content filtering', () => {
    it('replaces a blocked agent-derived conversation title before persistence', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          store: true,
        },
      });
      api.inspectContent.mockImplementation((fragments) =>
        fragments[0]?.source === 'conversation_title' && fragments[0]?.text === 'BLOCKED-AGENT'
          ? { detectorId: 'pii-pattern' }
          : null,
      );
      db.getAgent.mockResolvedValueOnce({
        id: 'agent-123',
        name: 'BLOCKED-AGENT',
        model: 'claude-3',
        provider: 'anthropic',
      });
      req.config.filters = {
        conversationTitles: {
          pii: {
            starterPatterns: [],
            customPatterns: [{ id: 'blocked', label: 'blocked', regex: 'BLOCKED' }],
          },
        },
      };

      await createResponse(req, res);

      expect(db.saveConvo).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          title: 'New Chat',
        }),
        expect.anything(),
      );
    });

    it('blocks opaque response input before conversion or agent loading', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const input = [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_file', file_data: 'do-not-echo' }],
        },
      ];
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input, stream: false },
      });
      api.getBlockedOpaqueFileField.mockReturnValueOnce('extracted_text');
      api.contentFilterUninspectableResponse.mockReturnValueOnce({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'extracted_text',
      });

      await createResponse(req, res);

      expect(api.getBlockedOpaqueFileField).toHaveBeenCalledWith(req.config.filters, input);
      expect(api.convertInputToMessages).not.toHaveBeenCalled();
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'Submitted file content could not be inspected before processing.',
        'invalid_request',
        'content_filter_uninspectable',
      );
      expect(JSON.stringify(api.sendResponsesErrorResponse.mock.calls)).not.toContain(
        'do-not-echo',
      );
    });

    it('returns a raw-free error when nested response input exhausts its budget', async () => {
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

      await createResponse(req, res);

      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'Submitted content could not be completely inspected before processing.',
        'invalid_request',
        'content_filter_uninspectable',
      );
    });

    it('continues when exhausted response parameters are outside the active policy', async () => {
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

      await createResponse(req, res);

      expect(db.getAgent).toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).not.toHaveBeenCalledWith(
        res,
        400,
        expect.anything(),
        'invalid_request',
        'content_filter_uninspectable',
      );
    });

    it('retains earlier request fragments when a function schema exhausts traversal', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const instructionFragment = {
        id: 'agent.instructions',
        path: '/instructions',
        text: 'PRIVATE-INSTRUCTION',
        source: 'agent_instruction',
        field: 'instructions',
      };
      const partialToolFragment = {
        id: 'tool.arguments.partial',
        path: '/arguments/safe',
        text: 'safe',
        source: 'tool_argument',
        field: 'arguments',
      };
      const traversalError = Object.assign(new Error('Traversal limit exceeded'), {
        code: 'content_filter_uninspectable',
        statusCode: 400,
        body: {
          error: 'content_filter_uninspectable',
          message: 'Submitted content could not be completely inspected before processing.',
          source: 'tool_argument',
          field: 'arguments',
        },
      });
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          instructions: 'PRIVATE-INSTRUCTION',
          tools: [{ type: 'function', name: 'lookup', parameters: { safe: true } }],
          stream: false,
        },
      });
      api.extractAgentContent.mockReturnValueOnce([instructionFragment]);
      api.extractToolArgumentContent.mockImplementationOnce(() => {
        throw traversalError;
      });
      api.getContentTraversalFragments.mockReturnValueOnce([
        instructionFragment,
        partialToolFragment,
      ]);
      api.inspectContent.mockReturnValueOnce({
        detectorId: 'pii-pattern',
        ruleId: 'private',
        label: 'private value',
        source: 'agent_instruction',
        field: 'instructions',
      });
      req.config.filters = {
        agentInstructions: {
          pii: {
            fields: ['instructions'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE' }],
          },
        },
      };

      await createResponse(req, res);

      expect(api.prependContentTraversalFragments).toHaveBeenCalledWith(
        traversalError,
        expect.arrayContaining([instructionFragment]),
      );
      expect(api.inspectContent).toHaveBeenCalledWith(
        expect.arrayContaining([instructionFragment, partialToolFragment]),
        expect.anything(),
      );
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'Submitted content was blocked.',
        'invalid_request',
        'content_filter_block',
      );
    });

    it('blocks instructions and input before loading the agent', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          metadata: { label: 'submitted metadata' },
          text: {
            format: {
              type: 'json_schema',
              json_schema: { description: 'submitted response schema' },
            },
          },
        },
      });
      api.inspectContent.mockReturnValueOnce({
        detectorId: 'pii-pattern',
        ruleId: 'sk_prefix',
        label: 'sk- prefix token',
        source: 'agent_instruction',
        field: 'instructions',
      });

      await createResponse(req, res);

      expect(api.extractAgentContent).toHaveBeenCalled();
      expect(api.extractMessageContent).toHaveBeenCalled();
      expect(api.extractModelParameterContent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { label: 'submitted metadata' },
          response_format: {
            type: 'json_schema',
            json_schema: { description: 'submitted response schema' },
          },
        }),
      );
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'Submitted content was blocked.',
        'invalid_request',
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

      await createResponse(req, res);

      expect(api.extractSkillContent).toHaveBeenCalledWith({ name: 'PRIVATE-SKILL' });
      expect(db.getAgent).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'Submitted content was blocked.',
        'invalid_request',
        'content_filter_block',
      );
    });

    it('blocks previously stored model-bound content before provider invocation', async () => {
      const api = require('@librechat/api');
      const blockedError = Object.assign(
        new Error('Submitted content contains a private value. Remove it and try again.'),
        {
          code: 'content_filter_block',
          statusCode: 400,
          body: {
            error: 'content_filter_block',
            message: 'Submitted content contains a private value. Remove it and try again.',
            source: 'message',
            field: 'text',
          },
        },
      );
      api.assertModelBoundContent.mockImplementationOnce(() => {
        throw blockedError;
      });

      await createResponse(req, res);

      expect(api.assertModelBoundContent).toHaveBeenCalled();
      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });

    it('preserves imported whole-assistant provenance and blocks its stored text', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const storedMessage = {
        messageId: 'imported-assistant',
        isCreatedByUser: false,
        isUserSubmitted: true,
        text: 'sk-imported-secret',
      };
      const blockedError = Object.assign(new Error('Submitted content was blocked.'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content was blocked.',
          source: 'message',
          field: 'text',
        },
      });
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_imported',
        },
      });
      db.getConvo.mockResolvedValueOnce({ conversationId: 'resp_imported', user: 'user-123' });
      db.getMessages.mockResolvedValueOnce([storedMessage]);
      api.assertModelBoundContent.mockImplementationOnce(({ storedMessages }) => {
        expect(storedMessages).toEqual([
          expect.objectContaining({
            messageId: 'imported-assistant',
            isCreatedByUser: false,
            isUserSubmitted: true,
            text: 'sk-imported-secret',
            content: 'sk-imported-secret',
          }),
        ]);
        throw blockedError;
      });

      await createResponse(req, res);

      expect(api.initializeAgent).not.toHaveBeenCalled();
      expect(api.discoverConnectedAgents).not.toHaveBeenCalled();
      expect(mockBuildAgentScopedContext).not.toHaveBeenCalled();
      expect(mockApplyContextToAgent).not.toHaveBeenCalled();
      expect(db.updateFilesUsage).not.toHaveBeenCalled();
      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });

    it('preserves path-marked assistant content and blocks only the submitted block', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const content = [
        { type: 'text', text: 'neighboring model prose' },
        { type: 'text', text: 'sk-path-secret' },
      ];
      const blockedError = Object.assign(new Error('Submitted content was blocked.'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content was blocked.',
          source: 'message',
          field: 'content_part',
        },
      });
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_path_marked',
        },
      });
      db.getConvo.mockResolvedValueOnce({
        conversationId: 'resp_path_marked',
        user: 'user-123',
      });
      db.getMessages.mockResolvedValueOnce([
        {
          messageId: 'mixed-assistant',
          isCreatedByUser: false,
          text: 'assistant summary text',
          content,
          userSubmittedPaths: ['/content/1/text'],
          userSubmittedMessageFieldPaths: [{ path: '/content/1/text', field: 'decision_response' }],
        },
      ]);
      api.assertModelBoundContent.mockImplementationOnce(({ storedMessages }) => {
        expect(storedMessages).toEqual([
          expect.objectContaining({
            text: 'assistant summary text',
            content,
            userSubmittedPaths: ['/content/1/text'],
            userSubmittedMessageFieldPaths: [
              { path: '/content/1/text', field: 'decision_response' },
            ],
          }),
        ]);
        throw blockedError;
      });

      await createResponse(req, res);

      expect(api.initializeAgent).not.toHaveBeenCalled();
      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });

    it('allows neighboring unmarked assistant prose when marked content is safe', async () => {
      const api = require('@librechat/api');
      const db = require('~/models');
      const content = [
        { type: 'text', text: 'sk-model-generated-prose' },
        { type: 'text', text: 'safe submitted correction' },
      ];
      api.validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_neighboring_model_output',
        },
      });
      db.getConvo.mockResolvedValueOnce({
        conversationId: 'resp_neighboring_model_output',
        user: 'user-123',
      });
      db.getMessages.mockResolvedValueOnce([
        {
          messageId: 'mixed-assistant',
          isCreatedByUser: false,
          content,
          userSubmittedPaths: ['/content/1/text'],
        },
      ]);
      api.assertModelBoundContent.mockImplementationOnce(({ storedMessages }) => {
        const [message] = storedMessages;
        expect(message.content).toEqual(content);
        expect(message.userSubmittedPaths).toEqual(['/content/1/text']);
        expect(message.content[1].text).toBe('safe submitted correction');
      });

      await createResponse(req, res);

      expect(api.createRun).toHaveBeenCalledTimes(1);
      expect(api.sendResponsesErrorResponse).not.toHaveBeenCalledWith(
        res,
        400,
        expect.anything(),
        'invalid_request',
        'content_filter_block',
      );
    });

    it('preflights request and context attachments from every run agent under a files-only policy', async () => {
      const api = require('@librechat/api');
      const primaryRequestFile = { filename: 'primary-request.txt', content: 'primary request' };
      const primaryContextFile = { filename: 'primary-context.txt', content: 'primary context' };
      const handoffRequestFile = { filename: 'handoff-request.txt', content: 'handoff request' };
      const handoffContextFile = {
        filename: 'handoff-context.txt',
        content: 'sk-handoff-context',
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
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input: 'Hello', stream: true },
      });
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'claude-3',
        model_parameters: {},
        toolRegistry: {},
        edges: [{ source: 'agent-123', target: 'agent-handoff' }],
        requestAttachments: [primaryRequestFile],
        agentContextAttachments: [primaryContextFile],
      });
      mockGlobalDiscoveredAgentConfigs = new Map([
        [
          'agent-handoff',
          {
            id: 'agent-handoff',
            model: 'claude-3',
            model_parameters: {},
            requestAttachments: [handoffRequestFile],
            agentContextAttachments: [handoffContextFile],
          },
        ],
      ]);
      api.assertModelBoundContent
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(({ filters, files }) => {
          expect(filters).toEqual(req.config.filters);
          expect(files).toEqual([
            primaryRequestFile,
            primaryContextFile,
            handoffRequestFile,
            handoffContextFile,
          ]);
          throw blockedError;
        });

      await createResponse(req, res);

      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.setupStreamingResponse).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });

    it('preflights each exact synthesized dynamic tool context as file content', async () => {
      const api = require('@librechat/api');
      const nestedPureSubagent = {
        id: 'agent-nested-pure',
        model: 'claude-3',
        model_parameters: {},
        toolDefinitions: [
          {
            name: 'nested_lookup',
            description: 'late-loaded nested tool definition',
            parameters: { type: 'object' },
          },
        ],
        dynamicToolContextMap: {
          nested_lookup: 'sk-nested-dynamic-context',
        },
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
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input: 'Hello', stream: true },
      });
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'claude-3',
        model_parameters: {},
        toolRegistry: {},
        edges: [{ source: 'agent-123', target: 'agent-handoff' }],
        dynamicToolContextMap: {
          execute_code: '  primary safe context',
          ignored_empty: '',
          file_search: 'primary context  ',
          ignored_non_string: 42,
        },
        subagentAgentConfigs: [
          {
            id: 'agent-pure',
            model: 'claude-3',
            model_parameters: {},
            subagentAgentConfigs: [nestedPureSubagent],
          },
        ],
      });
      mockGlobalDiscoveredAgentConfigs = new Map([
        [
          'agent-handoff',
          {
            id: 'agent-handoff',
            model: 'claude-3',
            model_parameters: {},
            dynamicToolContextMap: {
              execute_code: 'handoff safe context',
              file_search: 'sk-handoff-dynamic-context',
            },
          },
        ],
      ]);
      api.assertModelBoundContent
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(({ filters, agents, files }) => {
          expect(filters).toEqual(req.config.filters);
          expect(agents.map(({ id }) => id)).toEqual([
            'agent-123',
            'agent-handoff',
            'agent-pure',
            'agent-nested-pure',
          ]);
          expect(files).toEqual([
            { content: 'primary safe context\nprimary context' },
            { content: 'handoff safe context\nsk-handoff-dynamic-context' },
            { content: 'sk-nested-dynamic-context' },
          ]);
          throw blockedError;
        });

      await createResponse(req, res);

      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.setupStreamingResponse).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });

    it('re-inspects agents after dynamic context is applied', async () => {
      const api = require('@librechat/api');
      const blockedError = Object.assign(new Error('Submitted content was blocked.'), {
        code: 'content_filter_block',
        statusCode: 400,
        body: {
          error: 'content_filter_block',
          message: 'Submitted content was blocked.',
          source: 'agent_instruction',
          field: 'instructions',
        },
      });
      mockApplyContextToAgent.mockImplementationOnce(async ({ agent }) => {
        agent.instructions = 'PRIVATE-DYNAMIC-INSTRUCTION';
      });
      api.assertModelBoundContent
        .mockImplementationOnce(() => undefined)
        .mockImplementationOnce(({ agents }) => {
          if (agents?.some((agent) => agent.instructions === 'PRIVATE-DYNAMIC-INSTRUCTION')) {
            throw blockedError;
          }
        });

      await createResponse(req, res);

      expect(api.assertModelBoundContent).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agents: [expect.objectContaining({ instructions: 'PRIVATE-DYNAMIC-INSTRUCTION' })],
        }),
      );
      expect(api.createRun).not.toHaveBeenCalled();
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        blockedError.body.message,
        'invalid_request',
        'content_filter_block',
      );
    });
  });

  describe('safe error logging', () => {
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
      'preserves remote Responses credential metadata: %s',
      async (error, status, code) => {
        const api = require('@librechat/api');
        api.initializeAgent.mockRejectedValueOnce(error);
        await createResponse(req, res);
        expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
          res,
          status,
          error.message,
          status < 500 ? 'invalid_request' : 'server_error',
          ...(code ? [code] : []),
        );
      },
    );

    it('does not classify a client disconnect as an upstream model error', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const abortError = Object.assign(new Error('request aborted'), { name: 'AbortError' });
      api.createRun.mockImplementationOnce(async (options) => ({
        processStream: jest.fn(async () => {
          options.modelCallbacks
            .find(({ name }) => name === 'librechat-upstream-model-error-tracker')
            .handleLLMError(abortError);
          res.once.mock.calls.find(([event]) => event === 'close')[1]();
          throw abortError;
        }),
      }));

      await createResponse(req, res);

      expect(mockExecution.signal.aborted).toBe(true);
      expect(logger.error).not.toHaveBeenCalledWith(
        '[Responses API] Upstream model error',
        expect.anything(),
      );
    });

    it('logs bounded metadata and returns a raw-free provider error', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-RESPONSES-PROVIDER-PAYLOAD';
      const providerError = Object.assign(new Error(`Provider echoed ${rawValue}`), {
        code: 'ERR_REMOTE',
        response: {
          status: 502,
          headers: { authorization: rawValue },
          data: { prompt: rawValue },
        },
      });
      req.config.filters = { messages: { pii: {} } };
      api.createRun.mockRejectedValueOnce(providerError);

      await createResponse(req, res);

      const errorLog = logger.error.mock.calls.find(
        ([message]) => message === '[Responses API] Error:',
      );
      expect(errorLog).toEqual(['[Responses API] Error:', { type: 'Error', status: 502 }]);
      expect(JSON.stringify(errorLog)).not.toContain(rawValue);
      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        500,
        'An error occurred while processing the request',
        'server_error',
      );
      expect(JSON.stringify(api.sendResponsesErrorResponse.mock.calls)).not.toContain(rawValue);
    });

    it.each([false, true])(
      'classifies a terminal model callback failure and correlates its trace: stream=%s',
      async (stream) => {
        const api = require('@librechat/api');
        const { logger } = require('@librechat/data-schemas');
        const rawValue = 'PRIVATE-RESPONSES-UPSTREAM-PAYLOAD';
        const providerError = Object.assign(new Error(`Provider echoed ${rawValue}`), {
          code: 'ERR_REMOTE',
          response: { status: 503, data: { prompt: rawValue } },
        });
        req.config.filters = { messages: { pii: {} } };
        api.validateResponseRequest.mockReturnValueOnce({
          request: { model: 'agent-123', input: 'Hello', stream },
        });
        api.createRun.mockImplementationOnce(async (options) => ({
          processStream: jest.fn(async () => {
            options.modelCallbacks
              .find(({ name }) => name === 'librechat-upstream-model-error-tracker')
              .handleLLMError(providerError);
            throw new Error('graph failed', { cause: providerError });
          }),
        }));

        await createResponse(req, res);

        const errorLog = logger.error.mock.calls.find(
          ([message]) => message === '[Responses API] Upstream model error',
        );
        expect(errorLog).toEqual([
          '[Responses API] Upstream model error',
          {
            type: 'Error',
            status: 503,
            errorCode: 'UPSTREAM_MODEL_ERROR',
            errorOrigin: 'model_provider',
            errorType: '503',
            traceId: 'da34f2d846b1b1b770afe89e670770d5',
          },
        ]);
        expect(JSON.stringify(errorLog)).not.toContain(rawValue);
        expect(JSON.stringify(errorLog)).not.toContain('ERR_REMOTE');
      },
    );

    it('preserves the legacy provider error when protection is inactive', async () => {
      const api = require('@librechat/api');
      const rawValue = 'LEGACY-RESPONSES-PROVIDER-ERROR';
      api.createRun.mockRejectedValueOnce(
        Object.assign(new Error(rawValue), { code: 'ERR_LEGACY_REMOTE' }),
      );

      await createResponse(req, res);

      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        500,
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
      const rawValue = 'LEGACY-RESPONSES-CONFIGURED-PROVIDER-ERROR';
      req.config.filters = filters;
      api.createRun.mockRejectedValueOnce(new Error(rawValue));

      await createResponse(req, res);

      expect(api.sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        500,
        rawValue,
        'server_error',
      );
    });

    it('logs bounded metadata for tool callback failures', async () => {
      const api = require('@librechat/api');
      const { logger } = require('@librechat/data-schemas');
      const rawValue = 'PRIVATE-RESPONSES-TOOL-PAYLOAD';
      const toolError = Object.assign(new Error(`Tool echoed ${rawValue}`), {
        code: 'ERR_TOOL',
        response: { status: 422, data: { output: rawValue } },
      });
      api.createRun.mockResolvedValueOnce({
        processStream: jest.fn().mockImplementation(async (_input, _config, options) => {
          options.callbacks.TOOL_ERROR({}, toolError, 'file_search');
        }),
      });

      await createResponse(req, res);

      expect(mockGetSafeErrorMetadata).toHaveBeenCalledWith(toolError);
      const errorLog = logger.error.mock.calls.find(([message]) =>
        message.includes('Tool Error "file_search"'),
      );
      expect(errorLog).toEqual([
        '[Responses API] Tool Error "file_search"',
        { type: 'Error', status: 422 },
      ]);
      expect(JSON.stringify(errorLog)).not.toContain(rawValue);
    });
  });

  describe('conversation ownership validation', () => {
    it('should skip ownership check when previous_response_id is not provided', async () => {
      const { getConvo } = require('~/models');
      await createResponse(req, res);
      expect(getConvo).not.toHaveBeenCalled();
    });

    it('should return 400 when previous_response_id is not a string', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: { $gt: '' },
        },
      });

      await createResponse(req, res);
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        400,
        'previous_response_id must be a string',
        'invalid_request',
      );
    });

    it('should return 404 when conversation is not owned by user', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getConvo.mockResolvedValueOnce(null);

      await createResponse(req, res);
      expect(getConvo).toHaveBeenCalledWith('user-123', 'resp_abc');
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        404,
        'Conversation not found',
        'not_found',
      );
    });

    it('should proceed when conversation is owned by user', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getConvo.mockResolvedValueOnce({ conversationId: 'resp_abc', user: 'user-123' });

      await createResponse(req, res);
      expect(getConvo).toHaveBeenCalledWith('user-123', 'resp_abc');
      expect(sendResponsesErrorResponse).not.toHaveBeenCalledWith(
        res,
        404,
        expect.any(String),
        expect.any(String),
      );
    });

    it('rejects a remote response continuation of a view-only subagent thread', async () => {
      const {
        validateResponseRequest,
        sendResponsesErrorResponse,
        CHILD_THREAD_READ_ONLY_ERROR,
      } = require('@librechat/api');
      const { getConvo, saveConvo, saveMessage } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Mutate the child.',
          stream: false,
          store: true,
          previous_response_id: 'child-thread',
        },
      });
      getConvo.mockResolvedValueOnce({
        conversationId: 'child-thread',
        user: 'user-123',
        subagentThread: { parentConversationId: 'parent-thread' },
      });

      await createResponse(req, res);

      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        409,
        CHILD_THREAD_READ_ONLY_ERROR,
        'invalid_request',
        'conversation_read_only',
      );
      expect(saveConvo).not.toHaveBeenCalled();
      expect(saveMessage).not.toHaveBeenCalled();
    });

    it('should return 500 when getConvo throws a DB error', async () => {
      const { validateResponseRequest, sendResponsesErrorResponse } = require('@librechat/api');
      const { getConvo } = require('~/models');
      validateResponseRequest.mockReturnValueOnce({
        request: {
          model: 'agent-123',
          input: 'Hello',
          stream: false,
          previous_response_id: 'resp_abc',
        },
      });
      getConvo.mockRejectedValueOnce(new Error('DB connection failed'));

      await createResponse(req, res);
      expect(sendResponsesErrorResponse).toHaveBeenCalledWith(
        res,
        500,
        expect.any(String),
        expect.any(String),
      );
    });
  });

  describe('remote-agent file authorization', () => {
    it.each([false, true])(
      'threads the remote-agent permission boundary through initialization and tool loading (stream=%s)',
      async (stream) => {
        const { initializeAgent, createToolExecuteHandler } = require('@librechat/api');
        const { loadAgentTools, loadToolsForExecution } = require('~/server/services/ToolService');
        const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');

        req.config.endpoints.agents.backgroundTasks = {
          ordinaryToolCancellation: true,
          completionResultMaxChars: 4096,
        };
        req.body.stream = stream;
        await createResponse(req, res);

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
          provider: 'anthropic',
          model: 'claude-3',
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
      },
    );
  });

  describe('token usage recording - non-streaming', () => {
    it('should call recordCollectedUsage after successful non-streaming completion', async () => {
      await createResponse(req, res);

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
        }),
      );
    });

    it('should pass balance and transactions config to recordCollectedUsage', async () => {
      mockGetBalanceConfig.mockReturnValue({ enabled: true, startBalance: 2000 });
      mockGetTransactionsConfig.mockReturnValue({ enabled: true });

      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          balance: { enabled: true, startBalance: 2000 },
          transactions: { enabled: true },
        }),
      );
    });

    it('should pass spendTokens, spendStructuredTokens, pricing, and bulkWriteOps as dependencies', async () => {
      await createResponse(req, res);

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
      await createResponse(req, res);

      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          model: 'claude-3',
        }),
      );
    });
  });

  describe('agent context parity with UI path', () => {
    it('applies agent-scoped attachment context before createRun', async () => {
      const api = require('@librechat/api');
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'claude-3',
        model_parameters: {},
        toolRegistry: {},
        edges: [],
        agentContextAttachments: [{ file_id: 'file-1', filename: 'ocr_file.pdf' }],
      });
      mockBuildAgentContextAttachmentsByAgentId.mockReturnValueOnce(
        new Map([['agent-123', [{ file_id: 'file-1', filename: 'ocr_file.pdf' }]]]),
      );
      mockBuildAgentScopedContext.mockResolvedValueOnce(
        new Map([['agent-123', 'PDF context: ocr_file.pdf']]),
      );

      await createResponse(req, res);

      expect(mockBuildAgentContextAttachmentsByAgentId).toHaveBeenCalledWith([
        expect.objectContaining({ id: 'agent-123' }),
      ]);
      expect(mockBuildAgentScopedContext).toHaveBeenCalledWith(
        expect.objectContaining({
          agentIds: ['agent-123'],
          attachmentsByAgentId: expect.any(Map),
          req,
        }),
      );
      expect(mockApplyContextToAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({ id: 'agent-123' }),
          agentId: 'agent-123',
          sharedRunContext: 'PDF context: ocr_file.pdf',
        }),
      );
    });

    it('applies context to primary and discovered handoff agents', async () => {
      const api = require('@librechat/api');
      const handoffConfig = {
        id: 'agent-handoff',
        model: 'claude-3',
        model_parameters: {},
        toolRegistry: {},
        edges: [],
        agentContextAttachments: [{ file_id: 'file-2', filename: 'handoff_context.pdf' }],
      };

      // Set primary agent to have edges pointing to handoff agent
      api.initializeAgent.mockResolvedValueOnce({
        id: 'agent-123',
        model: 'claude-3',
        model_parameters: {},
        toolRegistry: {},
        edges: [{ source: 'agent-123', target: 'agent-handoff' }],
        agentContextAttachments: [{ file_id: 'file-1', filename: 'primary_context.pdf' }],
      });

      // Set global config so discoverConnectedAgents mock can invoke onAgentInitialized
      mockGlobalDiscoveredAgentConfigs = new Map([['agent-handoff', handoffConfig]]);

      mockBuildAgentScopedContext.mockResolvedValueOnce(
        new Map([
          ['agent-123', 'Primary context'],
          ['agent-handoff', 'Handoff context'],
        ]),
      );

      await createResponse(req, res);

      const appliedAgentIds = mockApplyContextToAgent.mock.calls.map((call) => call[0].agentId);
      expect(appliedAgentIds).toEqual(expect.arrayContaining(['agent-123', 'agent-handoff']));
      expect(mockApplyContextToAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: 'agent-handoff',
          sharedRunContext: 'Handoff context',
        }),
      );
    });
  });

  describe('token usage recording - streaming', () => {
    beforeEach(() => {
      req.body.stream = true;

      const api = require('@librechat/api');
      api.validateResponseRequest.mockReturnValue({
        request: { model: 'agent-123', input: 'Hello', stream: true },
      });
    });

    it('should call recordCollectedUsage after successful streaming completion', async () => {
      await createResponse(req, res);

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
          context: 'message',
        }),
      );
    });
  });

  describe('collectedUsage population', () => {
    it('should collect usage from on_chat_model_end events', async () => {
      const api = require('@librechat/api');

      api.createRun.mockImplementation(async ({ customHandlers }) => {
        return {
          processStream: jest.fn().mockImplementation(async () => {
            customHandlers.on_chat_model_end.handle('on_chat_model_end', {
              output: {
                usage_metadata: {
                  input_tokens: 150,
                  output_tokens: 75,
                  model: 'claude-3',
                },
              },
            });
          }),
        };
      });

      await createResponse(req, res);
      expect(mockRecordCollectedUsage).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({
          collectedUsage: expect.arrayContaining([
            expect.objectContaining({
              input_tokens: 150,
              output_tokens: 75,
            }),
          ]),
        }),
      );
    });

    it('uses collected usage for the non-streaming response', async () => {
      const api = require('@librechat/api');
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input: 'Hello', stream: false },
      });

      await createResponse(req, res);

      const collectedUsage = mockRecordCollectedUsage.mock.calls.at(-1)[1].collectedUsage;
      expect(mockBuildResponsesUsage).toHaveBeenCalledWith(collectedUsage);
      expect(api.buildAggregatedResponse).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        mockResponsesUsage,
      );
    });

    it('uses collected usage for the completed streaming event', async () => {
      const api = require('@librechat/api');
      api.validateResponseRequest.mockReturnValueOnce({
        request: { model: 'agent-123', input: 'Hello', stream: true },
      });

      await createResponse(req, res);

      const finalizeStream =
        api.createResponsesEventHandlers.mock.results.at(-1).value.finalizeStream;
      expect(finalizeStream).toHaveBeenCalledWith(mockResponsesUsage);
    });
  });

  describe('sub-agent skill priming', () => {
    it('passes the sub-agent primed skill IDs into non-streaming tool execution', async () => {
      const {
        initializeAgent,
        discoverConnectedAgents,
        createToolExecuteHandler,
      } = require('@librechat/api');
      const { loadToolsForExecution } = require('~/server/services/ToolService');
      const subAgent = { id: 'agent-sub', name: 'Sub Agent' };
      const subConfig = {
        id: 'agent-sub',
        model: 'claude-3',
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
        model: 'claude-3',
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

      await createResponse(req, res);

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

      await createResponse(req, res);

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

      await createResponse(req, res);

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

      await createResponse(req, res);

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

      await createResponse(req, res);

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

      await createResponse(req, res);

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

      await createResponse(req, res);

      await expect(passedResolver()()).resolves.toBe(false);
      expect(resolveToolRoleGrants).toHaveBeenCalledWith(expect.objectContaining({ req }));
    });
  });
});
