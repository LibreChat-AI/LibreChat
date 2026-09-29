const mongoose = require('mongoose');
const {
  ResourceType,
  PermissionBits,
  PrincipalType,
  PrincipalModel,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_SUBAGENT_RUN_CONFIGS,
  Constants,
  ErrorTypes,
} = require('librechat-data-provider');
const { MongoMemoryServer } = require('mongodb-memory-server');

const mockInitializeAgent = jest.fn();
const mockValidateAgentModel = jest.fn();
const mockGetAppConfig = jest.fn();
jest.mock('~/server/services/Config', () => ({
  ...jest.requireActual('~/server/services/Config'),
  getAppConfig: (...args) => mockGetAppConfig(...args),
}));

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createContentAggregator: jest.fn(() => ({
    contentParts: [],
    aggregateContent: jest.fn(),
  })),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
  GenerationJobManager: { setCollectedUsage: jest.fn() },
  getCustomEndpointConfig: jest.fn(),
  createSequentialChainEdges: jest.fn(),
}));

/** Captured by the `getDefaultHandlers` mock so tests can drive the
 *  `ON_TOOL_EXECUTE` pipeline with a real subagent id and observe whether
 *  the tool context (agent, tool_resources, skill ACLs) was preserved. */
let capturedToolExecuteOptions;
let capturedDefaultHandlerOptions;
const mockArtifactToolEndCallback = jest.fn();
jest.mock('~/server/controllers/agents/callbacks', () => ({
  createToolEndCallback: jest.fn(() => mockArtifactToolEndCallback),
  createAttachmentEmitter: jest.fn(() => jest.fn()),
  createPtcProgressEmitter: jest.fn(() => jest.fn()),
  createBackgroundCodeResultHandler: jest.fn(() => jest.fn()),
  getDefaultHandlers: jest.fn((opts) => {
    capturedDefaultHandlerOptions = opts;
    capturedToolExecuteOptions = opts?.toolExecuteOptions;
    return {};
  }),
}));

const mockLoadToolsForExecution = jest.fn();
const mockGetAccessibleMcpServerNames = jest.fn();
jest.mock('~/server/services/ToolService', () => ({
  loadAgentTools: jest.fn(),
  loadToolsForExecution: (...args) => mockLoadToolsForExecution(...args),
  getAccessibleMcpServerNames: (...args) => mockGetAccessibleMcpServerNames(...args),
  isFatalAgentInitializationError:
    jest.requireActual('@librechat/api').isFatalAgentInitializationError,
}));

jest.mock('~/server/controllers/ModelController', () => ({
  getModelsConfig: jest.fn().mockResolvedValue({}),
}));

let agentClientArgs;
jest.mock('~/server/controllers/agents/client', () => {
  return jest.fn().mockImplementation((args) => {
    agentClientArgs = args;
    return {};
  });
});

jest.mock('./addedConvo', () => ({
  processAddedConvo: jest.fn().mockResolvedValue({ userMCPAuthMap: undefined }),
}));

jest.mock('~/cache', () => ({
  logViolation: jest.fn(),
}));

const { createInitializeClient, initializeClient } = require('./initialize');
const { processAddedConvo } = require('./addedConvo');
const { getSkillDbMethods, getSkillToolDeps } = require('./skillDeps');
const { loadAgentTools } = require('~/server/services/ToolService');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { logger } = require('@librechat/data-schemas');
const { User, AclEntry } = require('~/db/models');
const { createAgent, createSkill, updateAgent } = require('~/models');
const db = require('~/models');

jest.spyOn(logger, 'warn').mockImplementation(() => {});

const PRIMARY_ID = 'agent_primary';
const TARGET_ID = 'agent_target';
const AUTHORIZED_ID = 'agent_authorized';

describe('initializeClient — processAgent ACL gate', () => {
  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;
    capturedDefaultHandlerOptions = undefined;

    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  const makeReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_1', files: [] },
    resolvedConversation: null,
    config: { endpoints: {} },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = (edges) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
    codeExecutionContext: {
      baseUrl: 'https://code-default.example.com',
      codeSessionKey: 'execute_code',
      executionProfile: 'default',
      statefulSessions: false,
    },
  });

  it.each([false, true])('defers host credential resolution with restored=%s', async (restored) => {
    const upstreamTokenProvider = jest.fn();
    const resolveUpstreamTokenProvider = jest.fn().mockResolvedValue(upstreamTokenProvider);
    const hostInitializeClient = createInitializeClient({ resolveUpstreamTokenProvider });
    const req = makeReq();
    req._isScheduledFire = true;
    req._isAgentTrigger = !restored;
    req.body.agent_id = PRIMARY_ID;
    req.body.agentTrigger = {
      version: 1,
      event: {
        type: 'schedule.occurrence',
        occurredAt: 0,
        source: { type: 'schedule', id: 'sched-1' },
      },
    };
    const signal = new AbortController().signal;
    mockInitializeAgent.mockImplementationOnce(async ({ loadTools, agent }) => {
      await loadTools({
        tools: ['run_query_mcp_warehouse'],
        model: agent.model,
        agentId: agent.id,
        provider: agent.provider,
      });
      return makePrimaryConfig([]);
    });

    await hostInitializeClient({
      req,
      res: {},
      signal,
      scheduledTokenContext: restored
        ? {
            scheduleId: 'sched-1',
            ownerId: req.user.id,
            agentId: PRIMARY_ID,
            invocationMode: 'delegated',
          }
        : undefined,
      endpointOption: makeEndpointOption(),
    });

    expect(resolveUpstreamTokenProvider).not.toHaveBeenCalled();
    const toolLoadParams = loadAgentTools.mock.calls[0][0];
    expect(toolLoadParams.upstreamTokenProvider).toBeUndefined();
    const resolver = toolLoadParams.upstreamTokenProviderResolver;
    await expect(resolver({ signal })).resolves.toBe(upstreamTokenProvider);
    expect(resolveUpstreamTokenProvider).toHaveBeenCalledWith(req.user, {
      signal,
      context: {
        scheduleId: 'sched-1',
        ownerId: req.user.id,
        agentId: PRIMARY_ID,
        invocationMode: 'delegated',
      },
    });
  });

  it('keeps interactive agent initialization independent of the host resolver', async () => {
    const resolveUpstreamTokenProvider = jest.fn();
    const hostInitializeClient = createInitializeClient({ resolveUpstreamTokenProvider });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));

    await hostInitializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(resolveUpstreamTokenProvider).not.toHaveBeenCalled();
  });

  it('replaces untrusted artifact route metadata with the executing agent context', async () => {
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    const data = { output: { name: 'execute_code', artifact: { files: [] } } };
    await capturedDefaultHandlerOptions.toolEndCallback(data, {
      langgraph_node: `tools=${PRIMARY_ID}`,
      codeExecutionContext: {
        baseUrl: 'https://attacker.invalid',
        executionProfile: 'stateful',
      },
    });

    expect(mockArtifactToolEndCallback).toHaveBeenLastCalledWith(
      data,
      expect.objectContaining({
        codeExecutionContext: expect.objectContaining({
          baseUrl: 'https://code-default.example.com',
          executionProfile: 'default',
        }),
      }),
    );
  });

  it('threads the owning job epoch into resumable event handlers', async () => {
    const {
      createAttachmentEmitter,
      createPtcProgressEmitter,
      createToolEndCallback,
    } = require('~/server/controllers/agents/callbacks');
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req._resumableStreamId = 'conv_1';

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
      jobCreatedAt: 1234,
    });

    expect(capturedDefaultHandlerOptions).toEqual(
      expect.objectContaining({
        streamId: 'conv_1',
        jobCreatedAt: 1234,
      }),
    );
    expect(
      require('~/server/controllers/agents/callbacks').createBackgroundCodeResultHandler,
    ).toHaveBeenCalledWith(expect.objectContaining({ jobCreatedAt: 1234 }));
    expect(createToolEndCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 'conv_1',
        jobCreatedAt: 1234,
      }),
    );
    expect(createAttachmentEmitter).toHaveBeenCalledWith({
      res: {},
      streamId: 'conv_1',
      jobCreatedAt: 1234,
    });
    /** The PTC trace emitter is generation-fenced like every other resumable
     *  emitter; a stale epoch would leak one run's inner calls into the next. */
    expect(createPtcProgressEmitter).toHaveBeenCalledWith({
      res: {},
      streamId: 'conv_1',
      jobCreatedAt: 1234,
    });

    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [], configurable: {} });
    await capturedToolExecuteOptions.loadTools([], PRIMARY_ID);
    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        streamId: 'conv_1',
        jobCreatedAt: 1234,
      }),
    );
  });

  it('publishes event-root activity through the owning child task stream', async () => {
    const subagentThreadTaskStore = require('./subagentThreadStore');
    const publishTaskActivity = jest
      .spyOn(subagentThreadTaskStore, 'publishTaskActivity')
      .mockResolvedValueOnce(undefined);
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req._resumableStreamId = 'child-conversation';
    req.body.conversationId = 'child-conversation';
    req._agentEventTaskId = 'event-task';
    req._agentEventBindingParentConversationId = 'parent-conversation';
    req._agentEventBindingParentAgentId = 'parent-agent';

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedDefaultHandlerOptions.eventChildActivity).toEqual(
      expect.objectContaining({
        runId: 'child-conversation',
        parentRunId: 'parent-conversation',
        subagentRunId: 'event-task',
        subagentType: PRIMARY_ID,
        subagentAgentId: PRIMARY_ID,
        parentAgentId: 'parent-agent',
      }),
    );
    await capturedDefaultHandlerOptions.eventChildActivity.publish({
      phase: 'writing',
      label: 'Drafting response',
    });
    expect(publishTaskActivity).toHaveBeenCalledWith('child-conversation', 'event-task', {
      phase: 'writing',
      label: 'Drafting response',
    });
  });

  it('binds foreground tool execution to the host-owned run signal', async () => {
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const controller = new AbortController();
    const req = makeReq();
    req.body.messageId = 'user-message-1';

    await initializeClient({
      req,
      res: {},
      signal: controller.signal,
      endpointOption: makeEndpointOption(),
      foregroundRunId: 'response-1',
      requestBody: { messageId: 'response-1', conversationId: 'conv_1' },
    });

    expect(capturedToolExecuteOptions.runSignal).toBe(controller.signal);
    expect(capturedToolExecuteOptions.foregroundRunId).toBe('response-1');
  });

  it('threads the deployment ordinary-tool cancellation gate into execution', async () => {
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const disabledReq = makeReq();

    await initializeClient({
      req: disabledReq,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    expect(capturedToolExecuteOptions.ordinaryToolCancellation).toBe(false);
    expect(capturedToolExecuteOptions.backgroundCompletionResultMaxChars).toBeUndefined();

    const enabledReq = makeReq();
    enabledReq.config.endpoints.agents = {
      backgroundTasks: { ordinaryToolCancellation: true, completionResultMaxChars: 4096 },
    };
    await initializeClient({
      req: enabledReq,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    expect(capturedToolExecuteOptions.ordinaryToolCancellation).toBe(true);
    expect(capturedToolExecuteOptions.backgroundCompletionResultMaxChars).toBe(4096);
  });

  it('propagates an expected-MCP-tools failure from the runtime tool loader', async () => {
    const toolError = Object.assign(new Error('Expected MCP tools are unavailable'), {
      code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
      statusCode: 503,
    });
    loadAgentTools.mockRejectedValueOnce(toolError);
    mockInitializeAgent.mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
      await loadTools({
        req,
        res,
        tools: ['run_query_mcp_warehouse'],
        model: agent.model,
        agentId: agent.id,
        provider: agent.provider,
      });
      return makePrimaryConfig([]);
    });

    await expect(
      initializeClient({
        req: makeReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toBe(toolError);
  });

  it.each([
    new (require('@librechat/api').OpenIDReauthRequiredError)('Please sign in again'),
    new (require('@librechat/api').MCPAuthenticationRejectedError)('private-mcp', false),
    new (require('@librechat/api').MCPAuthenticationRefreshError)(new Error('Retry later')),
  ])('preserves credential failure through the runtime agent loader: %s', async (toolError) => {
    loadAgentTools.mockRejectedValueOnce(toolError);
    mockInitializeAgent.mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
      await loadTools({
        req,
        res,
        tools: ['run_query_mcp_warehouse'],
        model: agent.model,
        agentId: agent.id,
        provider: agent.provider,
      });
      return makePrimaryConfig([]);
    });

    await expect(
      initializeClient({
        req: makeReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toBe(toolError);
  });

  it('aborts the run when a handoff target resolves none of its expected MCP tools', async () => {
    const target = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Target Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['run_query_mcp_warehouse'],
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: target._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const toolError = Object.assign(new Error('Target Agent expected MCP tools are unavailable'), {
      code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
      statusCode: 503,
    });
    loadAgentTools.mockRejectedValueOnce(toolError);
    mockInitializeAgent
      .mockResolvedValueOnce(
        makePrimaryConfig([{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }]),
      )
      .mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
        await loadTools({
          req,
          res,
          tools: agent.tools,
          model: agent.model,
          agentId: agent.id,
          provider: agent.provider,
        });
      });

    await expect(
      initializeClient({
        req: makeReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toBe(toolError);
  });

  it('should skip handoff agent and filter its edge when user lacks VIEW access', async () => {
    await createAgent({
      id: TARGET_ID,
      name: 'Target Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    const edges = [{ from: PRIMARY_ID, to: TARGET_ID, edgeType: 'handoff' }];
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig(edges));

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.edges).toEqual([]);
  });

  it('should initialize handoff agent and keep its edge when user has VIEW access', async () => {
    const authorizedAgent = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Authorized Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });

    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: authorizedAgent._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const requestAttachment = { file_id: 'request_file', filename: 'request.txt' };
    const primaryContextAttachment = { file_id: 'primary_context', filename: 'primary.txt' };
    const handoffContextAttachment = { file_id: 'handoff_context', filename: 'handoff.txt' };
    const primaryConfig = {
      ...makePrimaryConfig(edges),
      attachments: [primaryContextAttachment, requestAttachment],
      requestAttachments: [requestAttachment],
      agentContextAttachments: [primaryContextAttachment],
    };
    const handoffConfig = {
      id: AUTHORIZED_ID,
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      agentContextAttachments: [handoffContextAttachment],
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() => {
      callCount++;
      return callCount === 1 ? Promise.resolve(primaryConfig) : Promise.resolve(handoffConfig);
    });

    await initializeClient({
      req: makeReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.edges).toHaveLength(1);
    expect(agentClientArgs.agent.edges[0].to).toBe(AUTHORIZED_ID);
    expect(agentClientArgs.attachments).toEqual([requestAttachment]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(PRIMARY_ID)).toEqual([
      primaryContextAttachment,
    ]);
    expect(agentClientArgs.agentContextAttachmentsByAgentId.get(AUTHORIZED_ID)).toEqual([
      handoffContextAttachment,
    ]);
  });

  it('does not enable skill authoring for VIEW-only shared skills', async () => {
    const { skill } = await createSkill({
      name: 'shared-view-only',
      description: 'Use for read-only sharing.',
      body: '# Shared view-only skill\n',
      author: new mongoose.Types.ObjectId(),
      authorName: 'Skill Owner',
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });

    const endpointOption = makeEndpointOption();
    endpointOption.agent = Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      skills_enabled: true,
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(false);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.accessibleSkillIds.map(String)).toContain(skill._id.toString());
    expect(initializeParams.skillAuthoringAvailable).toBe(false);
  });

  it('enables skill authoring when model specs enable skills for an ephemeral agent', async () => {
    const endpointOption = makeEndpointOption();
    endpointOption.spec = 'spec-skills';
    endpointOption.agent = Promise.resolve({
      id: Constants.EPHEMERAL_AGENT_ID,
      name: 'Ephemeral Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    req.config.modelSpecs = {
      list: [{ name: 'spec-skills', skills: true }],
    };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(true);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.agent.skills_enabled).toBe(true);
    expect(initializeParams.skillAuthoringAvailable).toBe(true);
  });

  it('enables standalone authoring without exposing the persisted agent skill catalog', async () => {
    const endpointOption = makeEndpointOption();
    endpointOption.agent = Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
      skills: [],
      skills_enabled: false,
      skill_authoring_enabled: true,
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(true);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });
    } finally {
      canCreateSkillSpy.mockRestore();
    }

    const initializeParams = mockInitializeAgent.mock.calls[0][0];
    expect(initializeParams.accessibleSkillIds).toEqual([]);
    expect(initializeParams.skillAuthoringAvailable).toBe(true);
  });

  it('loads model validation and skill permissions without serial waits', async () => {
    const models = deferred();
    const createPermission = deferred();
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    getModelsConfig.mockReturnValueOnce(models.promise);
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockReturnValue(createPermission.promise);

    try {
      const initialization = initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });

      expect(getModelsConfig).toHaveBeenCalledWith(req);
      expect(canCreateSkillSpy).toHaveBeenCalledWith({ req });

      models.resolve({});
      await new Promise((resolve) => setImmediate(resolve));
      expect(mockValidateAgentModel).toHaveBeenCalledTimes(1);
      expect(mockInitializeAgent).not.toHaveBeenCalled();

      createPermission.resolve(false);
      await initialization;
      expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    } finally {
      canCreateSkillSpy.mockRestore();
    }
  });

  it('resolves model-spec skill names through deployment-aware skill methods', async () => {
    const deploymentSkillId = new mongoose.Types.ObjectId();
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: new mongoose.Types.ObjectId(),
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
    const endpointOption = makeEndpointOption();
    endpointOption.spec = 'spec-deployment-skill';
    endpointOption.agent = Promise.resolve({
      id: Constants.EPHEMERAL_AGENT_ID,
      name: 'Ephemeral Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig([]));
    const req = makeReq();
    req.config.endpoints.agents = { capabilities: ['skills'] };
    req.config.modelSpecs = {
      list: [{ name: 'spec-deployment-skill', skills: ['deployment-skill'] }],
    };
    const getSkillByNameSpy = jest.spyOn(getSkillDbMethods(), 'getSkillByName').mockResolvedValue({
      _id: deploymentSkillId,
      name: 'deployment-skill',
      source: 'deployment',
    });
    const canCreateSkillSpy = jest
      .spyOn(getSkillToolDeps(), 'canCreateSkill')
      .mockResolvedValue(false);

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption,
      });

      expect(getSkillByNameSpy).toHaveBeenCalledWith(
        'deployment-skill',
        expect.any(Array),
        expect.any(Object),
      );
      const initializeParams = mockInitializeAgent.mock.calls[0][0];
      expect(initializeParams.agent.skills_enabled).toBe(true);
      expect(initializeParams.agent.skills).toEqual([deploymentSkillId.toString()]);
    } finally {
      getSkillByNameSpy.mockRestore();
      canCreateSkillSpy.mockRestore();
    }
  });
});

describe('initializeClient — subagent loading', () => {
  const SUBAGENT_ID = 'agent_subagent_1';
  const DUPLICATE_SUBAGENT_ID = 'agent_subagent_dup';
  const HANDOFF_AND_SUB_ID = 'agent_handoff_and_sub';

  let mongoServer;
  let testUser;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    jest.clearAllMocks();
    agentClientArgs = undefined;
    capturedToolExecuteOptions = undefined;
    mockLoadToolsForExecution.mockReset();
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [], configurable: {} });
    mockGetAccessibleMcpServerNames.mockReset();
    mockGetAccessibleMcpServerNames.mockResolvedValue([]);

    testUser = await User.create({
      email: 'subagent@example.com',
      name: 'Subagent User',
      username: 'subuser',
      role: 'USER',
    });

    mockValidateAgentModel.mockResolvedValue({ isValid: true });
  });

  /** Grant the test user VIEW on an agent so processAgent loads it. */
  const grantView = async (agentDoc) => {
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.AGENT,
      resourceId: agentDoc._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
  };

  /** Build a request with the `subagents` capability enabled. */
  const makeSubagentReq = () => ({
    user: { id: testUser._id.toString(), role: 'USER' },
    body: { conversationId: 'conv_sub', files: [] },
    resolvedConversation: null,
    config: {
      endpoints: {
        agents: {
          capabilities: ['subagents'],
        },
      },
    },
    _resumableStreamId: null,
  });

  const makeEndpointOption = () => ({
    agent: Promise.resolve({
      id: PRIMARY_ID,
      name: 'Primary',
      provider: 'openai',
      model: 'gpt-4',
      tools: [],
    }),
    model_parameters: { model: 'gpt-4' },
    endpoint: 'agents',
  });

  const makePrimaryConfig = ({ edges = [], subagents, agent_ids }) => ({
    id: PRIMARY_ID,
    endpoint: 'agents',
    edges,
    toolDefinitions: [],
    toolRegistry: new Map(),
    userMCPAuthMap: null,
    tool_resources: {},
    resendFiles: true,
    maxContextTokens: 4096,
    subagents,
    agent_ids,
  });

  const makeSubagentConfig = (id) => ({
    id,
    endpoint: 'agents',
    edges: [],
    toolDefinitions: [{ name: 'web', description: 'web', parameters: {} }],
    toolRegistry: new Map([['web', { name: 'web' }]]),
    userMCPAuthMap: null,
    tool_resources: { file_search: { file_ids: ['file_1'] } },
    accessibleSkillIds: ['skill_1'],
    actionsEnabled: true,
    resendFiles: false,
    maxContextTokens: 4096,
  });

  const makeNestedSubagentConfig = (id, childIds = []) => ({
    ...makeSubagentConfig(id),
    subagents: { enabled: true, allowSelf: false, agent_ids: childIds },
  });

  const createViewableAgent = async (id, subagents) => {
    const agent = await createAgent({
      id,
      name: id,
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
      subagents,
    });
    await grantView(agent);
    return agent;
  };

  it('creates one trusted durable thread scope for detached subagents', async () => {
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: true, agent_ids: [] },
      }),
    );
    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('run_in_background');

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.subagentTasks).toBe(capturedToolExecuteOptions.subagentTasks);
    expect(agentClientArgs.subagentTasks.store.supportsThreadContinuation).toBe(true);
    expect(JSON.parse(agentClientArgs.subagentTasks.scopeId)).toEqual({
      version: 1,
      userId: testUser._id.toString(),
      parentConversationId: 'conv_sub',
    });
  });

  it('uses one normalized MCP body for discovery, deferred execution, and AgentClient', async () => {
    const requestBody = Object.freeze({
      messageId: 'response-message',
      conversationId: 'conv_sub',
      parentMessageId: 'user-message',
    });
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig({}));
    mockLoadToolsForExecution.mockResolvedValue({ loadedTools: [], configurable: {} });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
      requestBody,
    });

    const normalizedRequestBody = mockInitializeAgent.mock.calls[0][0].requestBody;
    expect(normalizedRequestBody).toEqual({
      ...requestBody,
      codeEnvironmentMode: 'without_attached',
      codeWorkspaces: undefined,
    });
    expect(agentClientArgs.mcpRequestBody).toBe(normalizedRequestBody);

    await capturedToolExecuteOptions.loadTools([], PRIMARY_ID);
    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ requestBody: normalizedRequestBody }),
    );
  });

  it('retains only root-attributed model-invoked Skills for durable replay', async () => {
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig({}));
    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const rootSkill = {
      id: 'root-skill',
      name: 'root-skill',
      version: 1,
      contentDigest: 'root-digest',
    };
    const childSkill = {
      id: 'child-skill',
      name: 'child-skill',
      version: 1,
      contentDigest: 'child-digest',
    };

    capturedToolExecuteOptions.onSkillResolved(childSkill, { agentId: SUBAGENT_ID });
    capturedToolExecuteOptions.onSkillResolved(rootSkill, { agentId: PRIMARY_ID });

    expect([...agentClientArgs.invokedSkillIdentities.values()]).toEqual([rootSkill]);
  });

  it('keeps an existing detached task controllable after subagent config is disabled', async () => {
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: true, agent_ids: [] },
      }),
    );
    const initialReq = makeSubagentReq();
    initialReq.config.endpoints.agents.capabilities.push('run_in_background');
    await initializeClient({
      req: initialReq,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const existingConfig = agentClientArgs.subagentTasks;
    const hasTasksSpy = jest.spyOn(existingConfig.store, 'hasTasks').mockResolvedValueOnce(true);
    mockInitializeAgent.mockResolvedValue(makePrimaryConfig({}));
    const changedReq = makeSubagentReq();
    changedReq.config.endpoints.agents.capabilities.push('run_in_background');

    await initializeClient({
      req: changedReq,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.subagentTasks).toEqual(existingConfig);
    expect(capturedToolExecuteOptions.subagentTasks).toEqual(existingConfig);
    expect(agentClientArgs.agent.subagents).toBeUndefined();
    hasTasksSpy.mockRestore();
  });

  it('disables every nested subagent path at the durable child-thread depth limit', async () => {
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);
    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('run_in_background');
    req.resolvedConversation = {
      conversationId: 'conv_sub',
      subagentThread: { depth: 1 },
    };

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.subagentTasks).toBeUndefined();
    expect(capturedToolExecuteOptions.subagentTasks).toBeUndefined();
    expect(agentClientArgs.agent.subagents).toBeUndefined();
  });

  it('keeps detached subagents disabled without the admin background capability', async () => {
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: true, agent_ids: [] },
      }),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.subagentTasks).toBeUndefined();
    expect(capturedToolExecuteOptions.subagentTasks).toBeUndefined();
  });

  it('defers pure-subagent MCP initialization until the descriptor is selected', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Data Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [`${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`],
    });
    await grantView(subAgent);

    const toolError = Object.assign(new Error('Subagent expected MCP tools are unavailable'), {
      code: 'AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE',
      statusCode: 503,
    });
    loadAgentTools.mockRejectedValueOnce(toolError);
    mockGetAccessibleMcpServerNames.mockResolvedValueOnce(['warehouse']);
    mockInitializeAgent
      .mockResolvedValueOnce(
        makePrimaryConfig({
          subagents: { enabled: true, allowSelf: true, agent_ids: [SUBAGENT_ID] },
        }),
      )
      .mockImplementationOnce(async ({ req, res, loadTools, agent }) => {
        await loadTools({
          req,
          res,
          tools: agent.tools,
          model: agent.model,
          agentId: agent.id,
          provider: agent.provider,
        });
      });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(mockGetAccessibleMcpServerNames).toHaveBeenCalledWith(testUser._id.toString(), 'USER');
    expect(agentClientArgs.agent.lazySubagentConfigs[0].historicalToolNames).toEqual([
      `${Constants.mcp_all}${Constants.mcp_delimiter}warehouse`,
    ]);
    expect(agentClientArgs.agent.lazySubagentConfigs[0].historicalMcpServerNames).toEqual([
      'warehouse',
    ]);
    await expect(
      agentClientArgs.agent.lazySubagentConfigs[0].resolve({
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(toolError);
  });

  it('defers pure-subagent resource recovery until the descriptor is selected', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Code Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['execute_code'],
    });
    await grantView(subAgent);

    const resourceRecoveryError = Object.assign(new Error('resource recovery required'), {
      code: ErrorTypes.RESOURCE_RECOVERY_REQUIRED,
      status: 409,
      statusCode: 409,
    });
    mockInitializeAgent
      .mockResolvedValueOnce(
        makePrimaryConfig({
          subagents: { enabled: true, allowSelf: true, agent_ids: [SUBAGENT_ID] },
        }),
      )
      .mockRejectedValueOnce(resourceRecoveryError);

    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('execute_code');
    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.lazySubagentConfigs[0].historicalToolNames).toEqual([
      'execute_code',
      'bash_tool',
      'read_file',
      'create_file',
      'edit_file',
      'search_workspace',
      'list_workspace_files',
    ]);

    await expect(
      agentClientArgs.agent.lazySubagentConfigs[0].resolve({
        signal: new AbortController().signal,
      }),
    ).rejects.toBe(resourceRecoveryError);
  });

  it('advertises a configured subagent without initializing it, then initializes it on selection', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
      stateful_code_environment: 'agent-user',
      memory_scope: 'agent',
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    let subagentConvoFileIds;
    mockInitializeAgent.mockImplementation(async (params, dbDeps) => {
      call += 1;
      if (call === 1) {
        return primaryConfig;
      }
      subagentConvoFileIds = await dbDeps.getConvoFiles(params.conversationId);
      return subagentConfig;
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.lazySubagentConfigs).toHaveLength(1);
    expect(agentClientArgs.agent.lazySubagentConfigs[0]).toEqual(
      expect.objectContaining({
        id: SUBAGENT_ID,
        configId: expect.any(String),
        statefulCodeEnvironment: 'agent-user',
        memory_scope: 'agent',
        memoryToolsRegistered: false,
        skillAuthoringAvailable: false,
        historicalToolNames: ['web'],
      }),
    );
    expect(agentClientArgs.agent.lazySubagentConfigs[0]).not.toHaveProperty('tools');
    expect(agentClientArgs.agent.lazySubagentConfigs[0]).not.toHaveProperty('tool_resources');
    expect(agentClientArgs.agent.lazySubagentConfigs[0]).not.toHaveProperty('_id');

    await agentClientArgs.agent.lazySubagentConfigs[0].resolve({
      signal: new AbortController().signal,
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    const subagentDbDeps = mockInitializeAgent.mock.calls[1][1];
    expect(subagentDbDeps.getConvoFiles).toBeInstanceOf(Function);
    expect(subagentDbDeps.db).toBeUndefined();
    expect(subagentConvoFileIds).toEqual([]);

    /** Subagent-only agents must NOT appear in `agentConfigs` — otherwise the
     *  graph would treat them as a parallel/handoff node. */
    expect(agentClientArgs.agentConfigs).toBeDefined();
    expect(agentClientArgs.agentConfigs.has(SUBAGENT_ID)).toBe(false);
  });

  it('includes current always-apply Skill revisions in lazy descriptor metadata', async () => {
    const secondSubagentId = 'agent_subagent_skill_2';
    const { skill } = await createSkill({
      name: 'lazy-specialist',
      description: 'Prime a lazy specialist.',
      body: '# Lazy specialist v1\n',
      alwaysApply: true,
      author: testUser._id,
      authorName: testUser.name,
    });
    await AclEntry.create({
      principalType: PrincipalType.USER,
      principalId: testUser._id,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.SKILL,
      resourceId: skill._id,
      permBits: PermissionBits.VIEW,
      grantedBy: testUser._id,
    });
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Skill Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: testUser._id,
      tools: [],
      skills_enabled: true,
      skills: [skill._id.toString()],
    });
    await grantView(subAgent);
    const secondSubAgent = await createAgent({
      id: secondSubagentId,
      name: 'Second Skill Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: testUser._id,
      tools: [],
      skills_enabled: true,
      skills: [skill._id.toString()],
    });
    await grantView(secondSubAgent);
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: {
          enabled: true,
          allowSelf: true,
          agent_ids: [SUBAGENT_ID, secondSubagentId],
        },
      }),
    );
    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('skills');
    const listAlwaysApplySkillsSpy = jest.spyOn(getSkillDbMethods(), 'listAlwaysApplySkills');

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });

      expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
      expect(listAlwaysApplySkillsSpy).toHaveBeenCalledTimes(1);
      for (const descriptor of agentClientArgs.agent.lazySubagentConfigs) {
        expect(descriptor.alwaysApplySkillPrimes).toEqual([
          expect.objectContaining({
            _id: skill._id,
            name: 'lazy-specialist',
            version: 1,
            body: '# Lazy specialist v1\n',
          }),
        ]);
        expect(descriptor.historicalToolNames).toEqual(
          expect.arrayContaining(['skill', 'read_file']),
        );
      }

      const eventReq = makeSubagentReq();
      eventReq.config.endpoints.agents.capabilities.push('skills');
      eventReq._isAgentTrigger = true;
      eventReq._agentEventBindingParentConversationId = 'parent-conversation';
      await initializeClient({
        req: eventReq,
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });

      expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
      expect(listAlwaysApplySkillsSpy).toHaveBeenCalledTimes(2);
      expect(agentClientArgs.agent.lazySubagentConfigs).toHaveLength(2);
      for (const descriptor of agentClientArgs.agent.lazySubagentConfigs) {
        expect(descriptor.alwaysApplySkillPrimes).toEqual([
          expect.objectContaining({
            _id: skill._id,
            name: 'lazy-specialist',
            version: 1,
            body: '# Lazy specialist v1\n',
          }),
        ]);
        expect(descriptor.historicalToolNames).toEqual(
          expect.arrayContaining(['skill', 'read_file']),
        );
      }
    } finally {
      listAlwaysApplySkillsSpy.mockRestore();
    }
  });

  it('loads independent lazy Skill scopes concurrently', async () => {
    const secondSubagentId = 'agent_subagent_parallel_skill_2';
    const skills = [];
    for (const name of ['parallel-skill-one', 'parallel-skill-two']) {
      const { skill } = await createSkill({
        name,
        description: `${name} description`,
        body: `# ${name}\n`,
        alwaysApply: true,
        author: testUser._id,
        authorName: testUser.name,
      });
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.SKILL,
        resourceId: skill._id,
        permBits: PermissionBits.VIEW,
        grantedBy: testUser._id,
      });
      skills.push(skill);
    }
    for (const [id, skill] of [
      [SUBAGENT_ID, skills[0]],
      [secondSubagentId, skills[1]],
    ]) {
      const agent = await createAgent({
        id,
        name: id,
        provider: 'openai',
        model: 'gpt-4',
        author: testUser._id,
        tools: [],
        skills_enabled: true,
        skills: [skill._id.toString()],
      });
      await grantView(agent);
    }
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: {
          enabled: true,
          allowSelf: false,
          agent_ids: [SUBAGENT_ID, secondSubagentId],
        },
      }),
    );
    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('skills');
    const skillDbMethods = getSkillDbMethods();
    const listAlwaysApplySkills = skillDbMethods.listAlwaysApplySkills.bind(skillDbMethods);
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const bothQueriesStarted = deferred();
    const waitForBothQueries = async () => {
      let timer;
      await Promise.race([
        bothQueriesStarted.promise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, 1000);
        }),
      ]);
      clearTimeout(timer);
    };
    const listAlwaysApplySkillsSpy = jest
      .spyOn(skillDbMethods, 'listAlwaysApplySkills')
      .mockImplementation(async (...args) => {
        activeQueries += 1;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        if (activeQueries === 2) {
          bothQueriesStarted.resolve();
        }
        await waitForBothQueries();
        try {
          return await listAlwaysApplySkills(...args);
        } finally {
          activeQueries -= 1;
        }
      });

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });

      expect(listAlwaysApplySkillsSpy).toHaveBeenCalledTimes(2);
      expect(maxActiveQueries).toBe(2);
      expect(agentClientArgs.agent.lazySubagentConfigs).toHaveLength(2);
    } finally {
      listAlwaysApplySkillsSpy.mockRestore();
    }
  });

  it('bounds concurrent lazy metadata reads', async () => {
    const subagentIds = Array.from({ length: 6 }, (_, index) => `agent_bounded_lazy_${index}`);
    for (const id of subagentIds) {
      await createViewableAgent(id);
    }
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: false, agent_ids: subagentIds },
      }),
    );
    const originalGetAgent = db.getAgentWithVersionCount.bind(db);
    const fourReadsStarted = deferred();
    let activeReads = 0;
    let maxActiveReads = 0;
    const getAgentSpy = jest
      .spyOn(db, 'getAgentWithVersionCount')
      .mockImplementation(async (...args) => {
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        if (activeReads === 4) {
          fourReadsStarted.resolve();
        }
        let timer;
        await Promise.race([
          fourReadsStarted.promise,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1000);
          }),
        ]);
        clearTimeout(timer);
        try {
          return await originalGetAgent(...args);
        } finally {
          activeReads -= 1;
        }
      });

    try {
      await initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });
      expect(agentClientArgs.agent.lazySubagentConfigs).toHaveLength(subagentIds.length);
      expect(maxActiveReads).toBe(4);
    } finally {
      getAgentSpy.mockRestore();
    }
  });

  it('rejects a disallowed lazy subagent scope before exposing it for prewarm', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Disallowed Stateful Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['execute_code'],
      stateful_code_sessions: true,
      stateful_code_environment: 'conversation',
    });
    await grantView(subAgent);
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
      }),
    );
    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('execute_code', 'stateful_code_sessions');
    req.config.endpoints.agents.statefulCodeSessions = { allowedEnvironments: ['user'] };
    process.env.CODE_ENVIRONMENT_DECISION_VERSION = '1';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful-code.example.com/v1/';

    try {
      await expect(
        initializeClient({
          req,
          res: {},
          signal: new AbortController().signal,
          endpointOption: makeEndpointOption(),
        }),
      ).rejects.toMatchObject({
        code: ErrorTypes.STATEFUL_CODE_ENVIRONMENT_NOT_ALLOWED,
      });

      expect(agentClientArgs).toBeUndefined();
      expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
  });

  it('binds a versioned implicit stateful route into lazy subagent metadata', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Implicit Stateful Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['execute_code'],
      stateful_code_sessions: true,
      stateful_code_environment: 'user',
    });
    await grantView(subAgent);
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
      }),
    );
    const req = makeSubagentReq();
    req.body.codeEnvironmentMode = 'without_attached';
    req.config.endpoints.agents.capabilities.push('execute_code', 'stateful_code_sessions');
    req.config.endpoints.agents.statefulCodeSessions = { allowedEnvironments: ['user'] };
    process.env.CODE_ENVIRONMENT_DECISION_VERSION = '1';
    process.env.LIBRECHAT_CODE_BASEURL_STATEFUL = 'https://stateful-code.example.com/v1/';

    try {
      await initializeClient({
        req,
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      });

      expect(agentClientArgs.agent.lazySubagentConfigs[0]).toEqual(
        expect.objectContaining({
          codeExecutionContext: expect.objectContaining({
            baseUrl: 'https://stateful-code.example.com/v1',
            executionProfile: 'stateful',
            statefulSessions: true,
          }),
        }),
      );
    } finally {
      delete process.env.CODE_ENVIRONMENT_DECISION_VERSION;
      delete process.env.LIBRECHAT_CODE_BASEURL_STATEFUL;
    }
  });

  it.each([
    [true, 'request', false],
    [false, 'request', false],
    [true, 'fallback', false],
    [true, 'override', false],
    [true, 'override-resolved', false],
    [true, 'resolved', false],
    [true, 'moved', true],
    [false, 'resolved-null', false],
    [true, 'resolved-null', true],
    [false, 'other-owner', false],
  ])(
    'validates the lazy subagent workspace before exposure: registered=%s source=%s moves=%s',
    async (registered, source, movesEnabled) => {
      const subAgent = await createAgent({
        id: SUBAGENT_ID,
        name: 'Attached Stateful Subagent',
        provider: 'openai',
        model: 'gpt-4',
        author: new mongoose.Types.ObjectId(),
        tools: ['execute_code'],
        stateful_code_sessions: true,
        stateful_code_environment: 'agent-user',
        code_environment_id: 'attached-vm',
      });
      await grantView(subAgent);
      mockInitializeAgent.mockResolvedValue(
        makePrimaryConfig({
          subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
        }),
      );
      const req = makeSubagentReq();
      req.config.endpoints.agents.capabilities.push('execute_code', 'stateful_code_sessions');
      req.config.endpoints.agents.statefulCodeSessions = {
        allowedEnvironments: ['agent-user'],
        conversationMoves: { enabled: movesEnabled },
        environments: [
          {
            id: 'attached-vm',
            name: 'Attached VM',
            type: 'attached',
            owner: 'deployment',
            pairing: { workerId: 'lazy-worker', tokenEnv: 'TEST_LAZY_WORKSPACE_TOKEN' },
            baseURL: 'https://bridge.example.com/v1/',
            default: true,
          },
        ],
      };
      req.body.codeWorkspaces = [{ environmentId: 'attached-vm', workspaceId: 'project-b' }];
      if (source === 'request' && !registered) {
        req.body.codeWorkspaces[0].workspaceId = 'removed-project';
      }
      let requestBody;
      if (source !== 'request') {
        const conversation = await mongoose.model('Conversation').create({
          conversationId: req.body.conversationId,
          endpoint: 'agents',
          user: source === 'other-owner' ? new mongoose.Types.ObjectId().toString() : req.user.id,
          codeWorkspaces: req.body.codeWorkspaces,
        });
        delete req.body.codeWorkspaces;
        if (source === 'moved') {
          req.resolvedConversation = {
            ...conversation.toObject(),
            codeWorkspaces: [{ environmentId: 'old-machine', workspaceId: 'old-project' }],
          };
        } else if (source === 'resolved') req.resolvedConversation = conversation.toObject();
        else if (source !== 'resolved-null') delete req.resolvedConversation;
        if (source.startsWith('override')) {
          conversation.codeWorkspaces = [
            { environmentId: 'attached-vm', workspaceId: 'wrong-source' },
          ];
          await conversation.save();
          if (source === 'override-resolved') req.resolvedConversation = conversation.toObject();
          requestBody = { ...req.body, conversationId: 'effective-target' };
          await mongoose.model('Conversation').create({
            conversationId: requestBody.conversationId,
            endpoint: 'agents',
            user: req.user.id,
            codeWorkspaces: [{ environmentId: 'attached-vm', workspaceId: 'project-b' }],
          });
        }
      }
      mockGetAppConfig.mockResolvedValue(req.config);
      process.env.TEST_LAZY_WORKSPACE_TOKEN = 'test-token';
      const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            workerId: 'lazy-worker',
            online: true,
            ready: true,
            leaseExpiresInMs: 45000,
            capabilities: {
              statefulWorkspace: true,
              sandboxProfile: 'native-srt',
              runtimes: ['bash'],
              workspaceTools: {
                protocolVersion: 1,
                operations: ['read_file'],
                workspaces: [{ id: 'project-b' }],
              },
            },
          }),
        ),
      );
      const readSpy = jest.spyOn(db, 'readAdmittedConvoCodeEnvironmentDecision');
      try {
        const initialization = initializeClient({
          req,
          requestBody,
          res: {},
          signal: new AbortController().signal,
          endpointOption: makeEndpointOption(),
        });
        const defaultsWithoutAttached =
          source === 'other-owner' || (source === 'resolved-null' && !movesEnabled);
        if (!registered && !defaultsWithoutAttached) {
          await expect(initialization).rejects.toMatchObject({
            code: ErrorTypes.CODE_WORKSPACE_UNAVAILABLE,
          });
          expect(agentClientArgs).toBeUndefined();
          return;
        }
        await initialization;
        if (movesEnabled)
          expect(readSpy).toHaveBeenCalledWith(
            req.user.id,
            requestBody?.conversationId ?? req.body.conversationId,
          );
        else expect(readSpy).not.toHaveBeenCalled();
        if (defaultsWithoutAttached) {
          expect(fetchSpy).not.toHaveBeenCalled();
          expect(agentClientArgs.mcpRequestBody).toEqual(
            expect.objectContaining({ codeEnvironmentMode: 'without_attached' }),
          );
          return;
        }
        if (source === 'fallback' || source.startsWith('override')) {
          mockInitializeAgent.mockImplementationOnce(async (params) => {
            expect(params.req.resolvedConversation.codeWorkspaces).toEqual([
              { environmentId: 'attached-vm', workspaceId: 'project-b' },
            ]);
            await params.loadTools({ ...subAgent, agentId: SUBAGENT_ID });
            return makeSubagentConfig(SUBAGENT_ID);
          });
          await agentClientArgs.agent.lazySubagentConfigs[0].resolve({
            signal: new AbortController().signal,
          });
          expect(loadAgentTools).toHaveBeenLastCalledWith(
            expect.objectContaining({
              req: expect.objectContaining({
                resolvedConversation: expect.objectContaining({
                  codeWorkspaces: [{ environmentId: 'attached-vm', workspaceId: 'project-b' }],
                }),
              }),
            }),
          );
        }
      } finally {
        fetchSpy.mockRestore();
        readSpy.mockRestore();
        delete process.env.TEST_LAZY_WORKSPACE_TOKEN;
      }

      expect(agentClientArgs.agent.lazySubagentConfigs[0]).toEqual(
        expect.objectContaining({
          codeSessionKey: expect.stringMatching(/^execute_code:stateful:[a-f0-9]{32}:v3:/),
          codeExecutionContext: expect.objectContaining({
            baseUrl: 'https://bridge.example.com/v1',
            environmentId: 'attached-vm',
            environmentType: 'attached',
            codeWorkspace: {
              environmentId: 'attached-vm',
              workspaceId: 'project-b',
              operations: ['read_file'],
            },
            executionProfile: 'stateful',
            executionRouteKey: expect.stringMatching(/^stateful:[a-f0-9]{32}$/),
          }),
        }),
      );
    },
  );

  it('omits a descriptor when its metadata lookup fails without aborting the primary run', async () => {
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);
    jest.spyOn(db, 'getAgentWithVersionCount').mockRejectedValueOnce(new Error('transient read'));

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.lazySubagentConfigs).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(`Error loading subagent metadata ${SUBAGENT_ID}`),
      expect.any(Error),
    );
  });

  it('uses exact custom-endpoint identity for descriptor reasoning history', async () => {
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Custom Subagent',
      provider: 'caseprovider',
      model: 'custom-model',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(subAgent);
    mockInitializeAgent.mockResolvedValue(
      makePrimaryConfig({
        subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
      }),
    );
    const req = makeSubagentReq();
    req.config.endpoints.custom = [
      { name: 'CaseProvider', customParams: { includeReasoningHistory: true } },
      { name: 'caseprovider', customParams: { includeReasoningHistory: false } },
    ];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.lazySubagentConfigs[0].includeReasoningHistory).toBe(false);
  });

  it('fails closed when a selected subagent configuration changes after advertisement', async () => {
    await createViewableAgent(SUBAGENT_ID);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    await updateAgent({ id: SUBAGENT_ID }, { instructions: 'Changed after descriptor creation.' });

    await expect(
      agentClientArgs.agent.lazySubagentConfigs[0].resolve({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`Subagent ${SUBAGENT_ID} changed`);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
  });

  it('rechecks VIEW permission when a descriptor is selected', async () => {
    const subAgent = await createViewableAgent(SUBAGENT_ID);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    await AclEntry.deleteMany({ resourceId: subAgent._id });

    await expect(
      agentClientArgs.agent.lazySubagentConfigs[0].resolve({
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(`no longer have access to subagent ${SUBAGENT_ID}`);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
  });

  it('preserves subagent tool context for ON_TOOL_EXECUTE (Codex P1 regression guard)', async () => {
    /** Verifies the Codex P1 fix: `agentToolContexts.delete(subagentId)` is
     *  NOT called for subagent-only agents, so when the child dispatches
     *  `ON_TOOL_EXECUTE` the parent can still resolve its tool context
     *  (agent, tool_resources, skill ACLs, actionsEnabled) to run tools
     *  with the right scope. We drive the real `loadTools` closure that
     *  `initializeClient` wires into `toolExecuteOptions`. */
    const subAgent = await createAgent({
      id: SUBAGENT_ID,
      name: 'Explicit Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['web'],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    const subagentConfig = makeSubagentConfig(SUBAGENT_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : subagentConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    await agentClientArgs.agent.lazySubagentConfigs[0].resolve({
      signal: new AbortController().signal,
    });
    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);

    /** Invoke the real closure with the subagent's id. If `agentToolContexts`
     *  had been deleted (as in the pre-fix code), this would call
     *  `loadToolsForExecution` with `agent: undefined` — actions/resource-
     *  scoped tools would silently drop. */
    await capturedToolExecuteOptions.loadTools(['web'], SUBAGENT_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    const arg = mockLoadToolsForExecution.mock.calls[0][0];
    expect(arg.agent).toBeDefined();
    expect(arg.agent.id).toBe(SUBAGENT_ID);
    expect(arg.toolRegistry).toBeInstanceOf(Map);
    expect(arg.tool_resources).toEqual({ file_search: { file_ids: ['file_1'] } });
    expect(arg.actionsEnabled).toBe(true);
  });

  it('threads run-scoped MCP tool definitions into ON_TOOL_EXECUTE loading', async () => {
    /** Regression guard for the request-scoped MCP/PTC handoff: the
     *  `mcpAvailableTools` discovered at run start must survive
     *  `buildAgentToolContext` and reach `loadToolsForExecution`, otherwise
     *  request-scoped servers reinitialize on every programmatic tool call
     *  and can trip the MCP circuit breaker under parallel calls. */
    const mcpTool = 'list_tables_mcp_ClickHouse';
    const mcpAvailableTools = {
      ClickHouse: {
        [mcpTool]: {
          type: 'function',
          function: {
            name: mcpTool,
            description: 'List tables',
            parameters: { type: 'object', properties: {} },
          },
        },
      },
    };
    const primaryConfig = {
      ...makePrimaryConfig({}),
      toolRegistry: new Map([[mcpTool, { name: mcpTool }]]),
      mcpAvailableTools,
    };
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(capturedToolExecuteOptions?.loadTools).toBeInstanceOf(Function);
    await capturedToolExecuteOptions.loadTools([mcpTool], PRIMARY_ID);

    expect(mockLoadToolsForExecution).toHaveBeenCalledTimes(1);
    expect(mockLoadToolsForExecution).toHaveBeenCalledWith(
      expect.objectContaining({ mcpAvailableTools }),
    );
  });

  it('deduplicates repeated ids in subagents.agent_ids', async () => {
    const subAgent = await createAgent({
      id: DUPLICATE_SUBAGENT_ID,
      name: 'Dup Subagent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(subAgent);

    const primaryConfig = makePrimaryConfig({
      subagents: {
        enabled: true,
        allowSelf: false,
        /** Same id three times — the backend must not load the agent
         *  repeatedly and must not emit three SubagentConfig entries. */
        agent_ids: [DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID, DUPLICATE_SUBAGENT_ID],
      },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Repeated ids produce one lightweight descriptor and no eager child initialization. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.lazySubagentConfigs).toHaveLength(1);
  });

  it('does not initialize a descriptor after its SDK cancellation signal aborts', async () => {
    await createViewableAgent(SUBAGENT_ID);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));

    await expect(
      agentClientArgs.agent.lazySubagentConfigs[0].resolve({ signal: controller.signal }),
    ).rejects.toThrow('cancelled');
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
  });

  it('rejects promptly when cancellation occurs during lazy initialization', async () => {
    await createViewableAgent(SUBAGENT_ID);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [SUBAGENT_ID] },
    });
    const initialization = deferred();
    const initializationStarted = deferred();
    mockInitializeAgent.mockResolvedValueOnce(primaryConfig).mockImplementationOnce((params) => {
      initializationStarted.resolve(params);
      return initialization.promise;
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const controller = new AbortController();
    const resolution = agentClientArgs.agent.lazySubagentConfigs[0].resolve({
      signal: controller.signal,
    });
    const selectedInitParams = await initializationStarted.promise;
    controller.abort(new Error('cancelled in flight'));

    await expect(resolution).rejects.toThrow('cancelled in flight');
    expect(selectedInitParams.loadTools).not.toBe(mockInitializeAgent.mock.calls[0][0].loadTools);
    initialization.resolve(makeSubagentConfig(SUBAGENT_ID));
  });

  it('resolves a graph subagent as an isolated all-member team', async () => {
    const memberIds = ['agent_graph_researcher', 'agent_graph_writer'];
    for (const memberId of memberIds) {
      await createViewableAgent(memberId);
    }
    const definition = {
      type: 'research_team',
      name: 'Research team',
      description: 'Researches and writes a final answer',
      agent_ids: memberIds,
      edges: [{ from: memberIds[0], to: memberIds[1], edgeType: 'direct' }],
      entry_agent_id: memberIds[0],
      result_agent_id: memberIds[1],
    };
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
    });
    const memberConfigs = new Map(
      memberIds.map((id, index) => [
        id,
        {
          ...makeSubagentConfig(id),
          userMCPAuthMap: { [`server_${index}`]: { token: `token_${index}` } },
        },
      ]),
    );
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : memberConfigs.get(agent.id)),
    );

    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push('run_in_background');
    const { userMCPAuthMap } = await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagentGraphConfigs).toEqual([
      {
        definition,
        memberConfigs: memberIds.map((id) => memberConfigs.get(id)),
      },
    ]);
    expect(memberIds.every((id) => !agentClientArgs.agentConfigs.has(id))).toBe(true);
    expect(agentClientArgs.subagentTasks).toBe(capturedToolExecuteOptions.subagentTasks);
    expect(userMCPAuthMap).toEqual({
      server_0: { token: 'token_0' },
      server_1: { token: 'token_1' },
    });
  });

  it('resolves graph teams only after their lazy parent is selected', async () => {
    const childId = 'agent_lazy_graph_parent';
    const memberId = 'agent_lazy_graph_member';
    const definition = {
      type: 'lazy_team',
      name: 'Lazy team',
      description: 'Loads with its selected parent',
      agent_ids: [childId, memberId],
      edges: [{ from: childId, to: memberId, edgeType: 'direct' }],
      entry_agent_id: childId,
      result_agent_id: memberId,
    };
    await createViewableAgent(childId, {
      enabled: true,
      allowSelf: false,
      graphs: [definition],
    });
    const memberAgent = await createAgent({
      id: memberId,
      name: memberId,
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: ['execute_code'],
      stateful_code_sessions: true,
    });
    await grantView(memberAgent);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [childId] },
    });
    const memberMCPAuthMap = { late_server: { token: 'late_token' } };
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(
        agent.id === PRIMARY_ID
          ? primaryConfig
          : {
              ...makeSubagentConfig(agent.id),
              subagents: agent.subagents,
              ...(agent.id === memberId ? { userMCPAuthMap: memberMCPAuthMap } : {}),
            },
      ),
    );

    const req = makeSubagentReq();
    req.config.endpoints.agents.capabilities.push(
      'execute_code',
      'run_in_background',
      'tool_intents',
      'stateful_code_sessions',
    );
    req.config.endpoints.agents.statefulCodeSessions = {
      allowedEnvironments: ['user'],
      environments: [
        {
          id: 'managed-code',
          name: 'Managed code',
          type: 'managed',
          baseURL: 'https://stateful-code.example.com/v1',
          default: true,
        },
      ],
    };
    mockGetAppConfig.mockResolvedValue(req.config);
    const { userMCPAuthMap } = await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    const descriptor = agentClientArgs.agent.lazySubagentConfigs[0];
    expect(descriptor.subagentGraphMemberMetadata).toEqual([
      expect.objectContaining({
        id: memberId,
        codeEnvAvailable: true,
        statefulCodeSessions: true,
      }),
    ]);
    expect(userMCPAuthMap).toEqual({});
    const resolvedChild = await descriptor.resolve({
      signal: new AbortController().signal,
    });
    expect(mockInitializeAgent).toHaveBeenCalledTimes(3);
    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({ id: memberId }),
        backgroundToolsAvailable: true,
        toolIntentsAvailable: true,
      }),
      expect.anything(),
    );
    expect(resolvedChild.subagentGraphConfigs).toEqual([
      {
        definition,
        memberConfigs: [resolvedChild, expect.objectContaining({ id: memberId })],
      },
    ]);
    expect(userMCPAuthMap).toEqual(memberMCPAuthMap);
  });

  it('aborts lazy graph member initialization with the descriptor signal', async () => {
    const childId = 'agent_lazy_cancel_parent';
    const memberId = 'agent_lazy_cancel_member';
    const definition = {
      type: 'lazy_cancel_team',
      name: 'Lazy cancel team',
      description: 'Stops member initialization with its selected parent',
      agent_ids: [memberId],
      edges: [],
      entry_agent_id: memberId,
      result_agent_id: memberId,
    };
    await createViewableAgent(childId, {
      enabled: true,
      allowSelf: false,
      graphs: [definition],
    });
    await createViewableAgent(memberId);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [childId] },
    });
    const memberInitialization = deferred();
    const memberStarted = deferred();
    mockInitializeAgent.mockImplementation(({ agent }) => {
      if (agent.id === PRIMARY_ID) return Promise.resolve(primaryConfig);
      if (agent.id === childId) {
        return Promise.resolve({ ...makeSubagentConfig(childId), subagents: agent.subagents });
      }
      memberStarted.resolve();
      return memberInitialization.promise;
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const controller = new AbortController();
    const resolution = agentClientArgs.agent.lazySubagentConfigs[0].resolve({
      signal: controller.signal,
    });
    await memberStarted.promise;
    controller.abort(new Error('cancelled graph resolution'));

    await expect(resolution).rejects.toThrow('cancelled graph resolution');
    memberInitialization.resolve(makeSubagentConfig(memberId));
  });

  it('coalesces shared graph member initialization across parallel lazy resolutions', async () => {
    const childIds = ['agent_lazy_shared_parent_a', 'agent_lazy_shared_parent_b'];
    const memberId = 'agent_lazy_shared_member';
    for (const childId of childIds) {
      await createViewableAgent(childId, {
        enabled: true,
        allowSelf: false,
        graphs: [
          {
            type: `shared_team_${childId}`,
            name: `Shared team ${childId}`,
            description: 'Loads one shared member',
            agent_ids: [memberId],
            edges: [],
            entry_agent_id: memberId,
            result_agent_id: memberId,
          },
        ],
      });
    }
    await createViewableAgent(memberId);
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: childIds },
    });
    const memberStarted = deferred();
    const memberRelease = deferred();
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      if (agent.id === PRIMARY_ID) return primaryConfig;
      if (childIds.includes(agent.id)) {
        return { ...makeSubagentConfig(agent.id), subagents: agent.subagents };
      }
      memberStarted.resolve();
      await memberRelease.promise;
      return makeSubagentConfig(memberId);
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });
    const resolutions = agentClientArgs.agent.lazySubagentConfigs.map((descriptor) =>
      descriptor.resolve({ signal: new AbortController().signal }),
    );
    await memberStarted.promise;
    memberRelease.resolve();
    const resolvedChildren = await Promise.all(resolutions);

    expect(
      mockInitializeAgent.mock.calls.filter(([{ agent }]) => agent.id === memberId),
    ).toHaveLength(1);
    expect(resolvedChildren).toHaveLength(2);
    expect(
      resolvedChildren.every(
        (child) => child.subagentGraphConfigs[0].memberConfigs[0].id === memberId,
      ),
    ).toBe(true);
  });

  it('loads independent graph members concurrently', async () => {
    const memberIds = ['agent_graph_parallel_a', 'agent_graph_parallel_b'];
    for (const memberId of memberIds) {
      await createViewableAgent(memberId);
    }
    const definition = {
      type: 'parallel_team',
      name: 'Parallel team',
      description: 'Loads independent members concurrently',
      agent_ids: memberIds,
      edges: [{ from: memberIds[0], to: memberIds[1], edgeType: 'direct' }],
      entry_agent_id: memberIds[0],
      result_agent_id: memberIds[1],
    };
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
    });
    const memberStarts = new Map(memberIds.map((id) => [id, deferred()]));
    const memberReleases = new Map(memberIds.map((id) => [id, deferred()]));
    mockInitializeAgent.mockImplementation(async ({ agent }) => {
      if (agent.id === PRIMARY_ID) {
        return primaryConfig;
      }
      memberStarts.get(agent.id)?.resolve();
      await memberReleases.get(agent.id)?.promise;
      return makeSubagentConfig(agent.id);
    });
    const getAgentWithVersionCount = jest.spyOn(db, 'getAgentWithVersionCount');

    const initialization = initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    await Promise.all(memberIds.map((id) => memberStarts.get(id)?.promise));
    for (const release of memberReleases.values()) {
      release.resolve();
    }
    await initialization;

    expect(agentClientArgs.agent.subagentGraphConfigs[0].memberConfigs).toHaveLength(2);
    for (const memberId of memberIds) {
      expect(
        getAgentWithVersionCount.mock.calls.filter(([query]) => query.id === memberId),
      ).toHaveLength(1);
    }
  });

  it('reuses the primary config when the parent is a graph member', async () => {
    const memberId = 'agent_graph_self_worker';
    await createViewableAgent(memberId);
    const definition = {
      type: 'self_team',
      name: 'Self team',
      description: 'Uses the parent as the entry member',
      agent_ids: [PRIMARY_ID, memberId],
      edges: [{ from: PRIMARY_ID, to: memberId, edgeType: 'direct' }],
      entry_agent_id: PRIMARY_ID,
      result_agent_id: memberId,
    };
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
    });
    const memberConfig = makeSubagentConfig(memberId);
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : memberConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(2);
    expect(agentClientArgs.agent.subagentGraphConfigs).toEqual([
      { definition, memberConfigs: [primaryConfig, memberConfig] },
    ]);
    expect(agentClientArgs.agentConfigs.has(PRIMARY_ID)).toBe(false);
  });

  it('keeps an added-conversation agent that is also a graph member', async () => {
    const addedAgentId = 'agent_added_graph_member';
    const definition = {
      type: 'added_member_team',
      name: 'Added member team',
      description: 'Runs the selected parallel agent as a graph member',
      agent_ids: [addedAgentId],
      edges: [],
      entry_agent_id: addedAgentId,
      result_agent_id: addedAgentId,
    };
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
    });
    const addedConfig = makeSubagentConfig(addedAgentId);
    mockInitializeAgent.mockResolvedValue(primaryConfig);
    processAddedConvo.mockImplementationOnce(async ({ agentConfigs }) => {
      agentConfigs.set(addedAgentId, addedConfig);
      return { userMCPAuthMap: undefined };
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agentConfigs.get(addedAgentId)).toBe(addedConfig);
    expect(agentClientArgs.agent.subagentGraphConfigs).toEqual([
      { definition, memberConfigs: [addedConfig] },
    ]);
  });

  it('skips the whole graph subagent when one persisted member is missing', async () => {
    const existingId = 'agent_graph_existing';
    const missingId = 'agent_graph_missing';
    await createViewableAgent(existingId);
    const definition = {
      type: 'incomplete_team',
      name: 'Incomplete team',
      description: 'Legacy graph with a deleted member',
      agent_ids: [existingId, missingId],
      edges: [{ from: existingId, to: missingId, edgeType: 'direct' }],
      entry_agent_id: existingId,
      result_agent_id: missingId,
    };
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: [definition] },
    });
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : makeSubagentConfig(agent.id)),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagentGraphConfigs).toEqual([]);
    expect(agentClientArgs.agentConfigs.has(existingId)).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Skipping incomplete graph subagent',
      expect.objectContaining({ graphType: 'incomplete_team', resolvedMemberCount: 1 }),
    );
  });

  it('counts initialized members from incomplete graph teams against the global node limit', async () => {
    const retainedMemberIds = Array.from(
      { length: 31 },
      (_, index) => `agent_incomplete_retained_${index}`,
    );
    const overflowMemberIds = Array.from(
      { length: 20 },
      (_, index) => `agent_incomplete_overflow_${index}`,
    );
    await Promise.all(
      [...retainedMemberIds, ...overflowMemberIds].map((id) => createViewableAgent(id)),
    );
    const definitions = [
      {
        type: 'incomplete_retained_team',
        name: 'Incomplete retained team',
        description: 'Loads members before discovering a missing result',
        agent_ids: [...retainedMemberIds, 'agent_incomplete_missing_result'],
        edges: [],
        entry_agent_id: retainedMemberIds[0],
        result_agent_id: 'agent_incomplete_missing_result',
      },
      {
        type: 'incomplete_overflow_team',
        name: 'Incomplete overflow team',
        description: 'Must be rejected before loading any more members',
        agent_ids: [...overflowMemberIds, 'agent_incomplete_missing_overflow'],
        edges: [],
        entry_agent_id: overflowMemberIds[0],
        result_agent_id: 'agent_incomplete_missing_overflow',
      },
    ];
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, graphs: definitions },
    });
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : makeSubagentConfig(agent.id)),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(mockInitializeAgent).toHaveBeenCalledTimes(1 + retainedMemberIds.length);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph node limit exceeded',
      expect.objectContaining({
        loadedSubagentCount: retainedMemberIds.length + 1,
        stagedSubagentCount: overflowMemberIds.length + 1,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      }),
    );
  });

  it('rejects nested subagent chains deeper than MAX_SUBAGENT_DEPTH', async () => {
    const ids = Array.from(
      { length: MAX_SUBAGENT_DEPTH + 1 },
      (_, index) => `agent_depth_${index}`,
    );
    for (const [index, id] of ids.entries()) {
      await createViewableAgent(id, {
        enabled: true,
        allowSelf: false,
        agent_ids: index < ids.length - 1 ? [ids[index + 1]] : [],
      });
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [ids[0]] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph depth limit exceeded',
      expect.objectContaining({
        agentId: ids[MAX_SUBAGENT_DEPTH - 1],
        primaryAgentId: PRIMARY_ID,
        depth: MAX_SUBAGENT_DEPTH,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('preserves deeper path depth when a handoff root is also a nested subagent', async () => {
    const chainIds = Array.from(
      { length: MAX_SUBAGENT_DEPTH },
      (_, index) => `agent_overlap_depth_${index}`,
    );
    await createViewableAgent(HANDOFF_AND_SUB_ID, {
      enabled: true,
      allowSelf: false,
      agent_ids: [chainIds[0]],
    });
    for (const [index, id] of chainIds.entries()) {
      await createViewableAgent(id, {
        enabled: true,
        allowSelf: false,
        agent_ids: index < chainIds.length - 1 ? [chainIds[index + 1]] : [],
      });
    }

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: false, agent_ids: [HANDOFF_AND_SUB_ID] },
    });
    const sharedConfig = makeNestedSubagentConfig(HANDOFF_AND_SUB_ID, [chainIds[0]]);
    mockInitializeAgent.mockImplementation(({ agent }) =>
      Promise.resolve(agent.id === PRIMARY_ID ? primaryConfig : sharedConfig),
    );

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum depth of ${MAX_SUBAGENT_DEPTH}`);
    expect(agentClientArgs).toBeUndefined();
  });

  it('rejects subagent graphs that exceed MAX_SUBAGENT_GRAPH_NODES unique agents', async () => {
    const firstLevelIds = Array.from({ length: 10 }, (_, index) => `agent_graph_${index}`);
    const secondLevelIdsByParent = new Map(
      firstLevelIds.map((id) => [
        id,
        Array.from({ length: 5 }, (_, index) => `${id}_child_${index}`),
      ]),
    );
    for (const id of firstLevelIds) {
      await createViewableAgent(id, {
        enabled: true,
        allowSelf: false,
        agent_ids: secondLevelIdsByParent.get(id),
      });
    }
    for (const id of Array.from(secondLevelIdsByParent.values()).flat()) {
      await createViewableAgent(id, { enabled: true, allowSelf: false, agent_ids: [] });
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: firstLevelIds },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent graph node limit exceeded',
      expect.objectContaining({
        primaryAgentId: PRIMARY_ID,
        loadedSubagentCount: MAX_SUBAGENT_GRAPH_NODES,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('bounds capability metadata reads across lazy graph teams', async () => {
    const firstChildId = 'agent_lazy_graph_cap_first';
    const secondChildId = 'agent_lazy_graph_cap_second';
    const firstMemberIds = Array.from({ length: 32 }, (_, index) => `agent_cap_first_${index}`);
    const secondMemberIds = Array.from({ length: 17 }, (_, index) => `agent_cap_second_${index}`);
    const makeGraph = (type, memberIds) => ({
      type,
      name: type,
      description: type,
      agent_ids: memberIds,
      edges: memberIds.slice(0, -1).map((memberId, index) => ({
        from: memberId,
        to: memberIds[index + 1],
        edgeType: 'direct',
      })),
      entry_agent_id: memberIds[0],
      result_agent_id: memberIds.at(-1),
    });
    await createViewableAgent(firstChildId, {
      enabled: true,
      allowSelf: false,
      graphs: [makeGraph('first_capability_team', firstMemberIds)],
    });
    await createViewableAgent(secondChildId, {
      enabled: true,
      allowSelf: false,
      graphs: [makeGraph('second_capability_team', secondMemberIds)],
    });
    await Promise.all(
      [...firstMemberIds, ...secondMemberIds].map((memberId) => createViewableAgent(memberId)),
    );
    const primaryConfig = makePrimaryConfig({
      subagents: {
        enabled: true,
        allowSelf: false,
        agent_ids: [firstChildId, secondChildId],
      },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents`);
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    const stagedLimitWarning = logger.warn.mock.calls.find(
      ([message, metadata]) =>
        message === '[initializeClient] Subagent graph node limit exceeded' &&
        Number.isInteger(metadata?.stagedSubagentCount),
    );
    expect(stagedLimitWarning).toBeDefined();
    expect(stagedLimitWarning[1]).toEqual(
      expect.objectContaining({ maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES }),
    );
    expect(
      stagedLimitWarning[1].loadedSubagentCount + stagedLimitWarning[1].stagedSubagentCount,
    ).toBeGreaterThan(MAX_SUBAGENT_GRAPH_NODES);
  });

  it('rejects a branching DAG that exceeds expanded descriptor capacity', async () => {
    const width = 3;
    const layers = Array.from({ length: MAX_SUBAGENT_DEPTH }, (_, level) =>
      Array.from({ length: width }, (_, index) => `agent_descriptor_${level}_${index}`),
    );
    for (let level = 0; level < layers.length; level++) {
      const childIds = level < layers.length - 1 ? layers[level + 1] : [];
      for (const id of layers[level]) {
        await createViewableAgent(id, { enabled: true, allowSelf: false, agent_ids: childIds });
      }
    }

    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: layers[0] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await expect(
      initializeClient({
        req: makeSubagentReq(),
        res: {},
        signal: new AbortController().signal,
        endpointOption: makeEndpointOption(),
      }),
    ).rejects.toThrow(`maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries`);
    expect(logger.warn).toHaveBeenCalledWith(
      '[initializeClient] Subagent run configuration limit exceeded',
      expect.objectContaining({
        expandedConfigCount: MAX_SUBAGENT_RUN_CONFIGS + 1,
        maxSubagentRunConfigs: MAX_SUBAGENT_RUN_CONFIGS,
        rootAgentIds: [PRIMARY_ID],
      }),
    );
    expect(agentClientArgs).toBeUndefined();
  });

  it('keeps an agent in `agentConfigs` when it is BOTH a handoff target and a subagent', async () => {
    /** Overlap case: the same child is used both via handoff edges (needs to
     *  be in agentConfigs) and as a subagent (needs to be in
     *  subagentAgentConfigs, and its tool context preserved). The pipeline
     *  shouldn't silently drop it from the handoff map. */
    const shared = await createAgent({
      id: HANDOFF_AND_SUB_ID,
      name: 'Shared Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(shared);

    const edges = [{ from: PRIMARY_ID, to: HANDOFF_AND_SUB_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: {
        enabled: true,
        allowSelf: false,
        agent_ids: [HANDOFF_AND_SUB_ID],
      },
    });
    const sharedConfig = makeSubagentConfig(HANDOFF_AND_SUB_ID);

    let call = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++call === 1 ? primaryConfig : sharedConfig),
    );

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagentAgentConfigs).toHaveLength(1);
    /** Shared agent must stay in agentConfigs — it's still the handoff target. */
    expect(agentClientArgs.agentConfigs.has(HANDOFF_AND_SUB_ID)).toBe(true);
  });

  it('preserves shared initialized agent children across parallel walkers', async () => {
    const leftId = 'agent_parallel_left';
    const rightId = 'agent_parallel_right';
    const sharedId = 'agent_parallel_shared';
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: false, agent_ids: [leftId, rightId] },
    });
    const leftConfig = makeNestedSubagentConfig(leftId, [sharedId]);
    const rightConfig = makeNestedSubagentConfig(rightId, [sharedId]);
    const sharedConfig = makeNestedSubagentConfig(sharedId, [leftId]);
    mockInitializeAgent.mockResolvedValue(primaryConfig);
    processAddedConvo.mockImplementationOnce(async ({ agentConfigs }) => {
      agentConfigs.set(leftId, leftConfig);
      agentConfigs.set(rightId, rightConfig);
      agentConfigs.set(sharedId, sharedConfig);
      return { userMCPAuthMap: undefined };
    });

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    const subagentsById = new Map(
      agentClientArgs.agent.subagentAgentConfigs.map((config) => [config.id, config]),
    );
    const left = subagentsById.get(leftId);
    const right = subagentsById.get(rightId);
    const leftShared = left.subagentAgentConfigs[0];
    const rightShared = right.subagentAgentConfigs[0];
    expect(leftShared).toBe(sharedConfig);
    expect(rightShared).toBe(sharedConfig);
    expect(leftShared.subagentAgentConfigs.map((child) => child.id)).toEqual([leftId]);
    expect(rightShared.subagentAgentConfigs.map((child) => child.id)).toEqual([leftId]);
    expect(agentClientArgs.agentConfigs.get(sharedId)).toBe(sharedConfig);
  });

  it('clears subagents config on primary when the capability is disabled', async () => {
    /** Admin can turn subagents off at the endpoint level even if an agent was
     *  configured for them. The primary's `subagents` field should be
     *  suppressed so run.ts never builds a SubagentConfig. */
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    const req = makeSubagentReq();
    /** Remove the capability from the admin config. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    expect(agentClientArgs.agent.subagents).toBeUndefined();
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });

  it('clears subagents on handoff agents too when capability is disabled (Codex P2 regression)', async () => {
    /** Codex P2: the capability gate must suppress `subagents` on EVERY
     *  loaded config, not just the primary. `run.ts` iterates all agents
     *  and calls `buildSubagentConfigs` per agent, so a handoff target
     *  with `subagents.enabled: true` persisted on its document would
     *  otherwise still expose self-spawn even when the admin has disabled
     *  the capability globally. */
    const authorized = await createAgent({
      id: AUTHORIZED_ID,
      name: 'Handoff Agent',
      provider: 'openai',
      model: 'gpt-4',
      author: new mongoose.Types.ObjectId(),
      tools: [],
    });
    await grantView(authorized);

    const edges = [{ from: PRIMARY_ID, to: AUTHORIZED_ID, edgeType: 'handoff' }];
    const primaryConfig = makePrimaryConfig({
      edges,
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    });
    const handoffConfig = {
      id: AUTHORIZED_ID,
      endpoint: 'agents',
      edges: [],
      toolDefinitions: [],
      toolRegistry: new Map(),
      userMCPAuthMap: null,
      tool_resources: {},
      /** Handoff agent document has subagents enabled of its own accord. */
      subagents: { enabled: true, allowSelf: true, agent_ids: [] },
    };

    let callCount = 0;
    mockInitializeAgent.mockImplementation(() =>
      Promise.resolve(++callCount === 1 ? primaryConfig : handoffConfig),
    );

    const req = makeSubagentReq();
    /** Capability OFF at endpoint level. */
    req.config.endpoints.agents.capabilities = [];

    await initializeClient({
      req,
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Primary cleared. */
    expect(agentClientArgs.agent.subagents).toBeUndefined();
    /** Handoff target must ALSO be cleared — otherwise its self-spawn
     *  would still fire when run.ts iterates agentConfigs. */
    const handoffLoaded = agentClientArgs.agentConfigs.get(AUTHORIZED_ID);
    expect(handoffLoaded).toBeDefined();
    expect(handoffLoaded.subagents).toBeUndefined();
    expect(handoffLoaded.subagentAgentConfigs).toBeUndefined();
  });

  it('skips subagent loading entirely when the feature is disabled on the agent', async () => {
    const primaryConfig = makePrimaryConfig({
      subagents: { enabled: false, allowSelf: true, agent_ids: [SUBAGENT_ID] },
    });
    mockInitializeAgent.mockResolvedValue(primaryConfig);

    await initializeClient({
      req: makeSubagentReq(),
      res: {},
      signal: new AbortController().signal,
      endpointOption: makeEndpointOption(),
    });

    /** Only one initializeAgent call — for the primary. No subagent loaded. */
    expect(mockInitializeAgent).toHaveBeenCalledTimes(1);
    expect(agentClientArgs.agent.subagentAgentConfigs).toEqual([]);
  });
});
