const mockCreateRun = jest.fn();
const mockCaptureAgentCheckpointGeneration = jest.fn();
const mockDeleteAgentCheckpoint = jest.fn();
const mockIsHITLEnabled = jest.fn().mockReturnValue(false);
const mockRecordCollectedUsage = jest.fn();
const mockDetachedUsageRecorder = jest.fn();
const mockCreateDetachedSubagentUsageRecorder = jest.fn(() => mockDetachedUsageRecorder);
const mockGetAgentCheckpointer = jest.fn();
const mockHasDurableAgentInterruptCheckpoint = jest.fn().mockResolvedValue(true);
const mockBuildAgentScopedContext = jest.fn((...args) =>
  jest.requireActual('@librechat/api').buildAgentScopedContext(...args),
);
const mockFormatAgentMessages = jest.fn(() => ({
  messages: [],
  indexTokenCountMap: {},
  summary: undefined,
  boundaryTokenAdjustment: undefined,
}));
const mockStripActivityLabelParts = jest.fn((payload) =>
  jest.requireActual('@librechat/api').stripActivityLabelParts(payload),
);

const { Providers } = require('@librechat/agents');
const { Constants, ContentTypes, EModelEndpoint, ErrorTypes } = require('librechat-data-provider');
const {
  GenerationJobManager,
  createStreamServices,
  registerToolApprovalHook,
  clearToolApprovalHooks,
  getPluginHookSource,
  setPluginHookSource,
} = require('@librechat/api');
const BaseClient = require('~/app/clients/BaseClient');
const AgentClient = require('./client');
const { resolveConfigServers } = require('~/server/services/MCP');

describe('AgentClient code approval persistence', () => {
  it('persists a validated mode in agent conversation options', () => {
    const client = Object.create(AgentClient.prototype);
    client.agentConfigs = new Map([
      [
        'secondary',
        {
          codeExecutionContext: {
            environmentId: 'team-vm',
            environmentType: 'attached',
            codeWorkspace: {
              environmentId: 'team-vm',
              workspaceId: 'project-b',
              operations: ['read_file'],
            },
          },
        },
      ],
    ]);
    const secondary = client.agentConfigs.get('secondary');
    client.agentConfigs = new Map();
    client.options = {
      endpoint: EModelEndpoint.agents,
      agent: {
        id: 'attached-agent',
        subagentAgentConfigs: [secondary],
        codeExecutionContext: {
          environmentId: 'attached-vm',
          environmentType: 'attached',
          codeWorkspace: {
            environmentId: 'attached-vm',
            workspaceId: 'project-a',
            operations: ['read_file', 'execute_command'],
          },
          codeEnvironmentConfigSchema: {
            permissions: {
              fileWrite: { allowed: ['ask', 'allow'], default: 'ask' },
              commandExecution: { allowed: ['ask'], default: 'ask' },
            },
          },
        },
      },
      req: {
        body: { codeApprovalMode: 'acceptEdits' },
        _codeEnvironmentDecision: {
          mode: 'attached',
          codeWorkspaces: [
            { environmentId: 'attached-vm', workspaceId: 'project-a' },
            { environmentId: 'team-vm', workspaceId: 'project-b' },
          ],
        },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
    };

    expect(client.getSaveOptions()).toMatchObject({
      codeApprovalMode: 'acceptEdits',
      codeEnvironmentMode: 'attached',
      codeWorkspaces: [
        { environmentId: 'attached-vm', workspaceId: 'project-a' },
        { environmentId: 'team-vm', workspaceId: 'project-b' },
      ],
    });
  });

  it('never writes its run-start decision over a stored one a move replaced', () => {
    const client = Object.create(AgentClient.prototype);
    client.agentConfigs = new Map();
    client.conversationId = 'convo-1';
    client.options = {
      endpoint: EModelEndpoint.agents,
      agent: { id: 'attached-agent' },
      req: {
        body: { conversationId: 'convo-1' },
        _codeEnvironmentDecision: {
          mode: 'attached',
          codeWorkspaces: [{ environmentId: 'mac', workspaceId: 'primary' }],
        },
        resolvedConversation: {
          conversationId: 'convo-1',
          codeEnvironmentMode: 'attached',
          codeWorkspaces: [{ environmentId: 'vm', workspaceId: 'projects' }],
        },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
    };

    const saveOptions = client.getSaveOptions();
    expect(saveOptions).not.toHaveProperty('codeEnvironmentMode');
    expect(saveOptions).not.toHaveProperty('codeWorkspaces');
  });

  it('records only the mode a legacy conversation inferred', () => {
    const client = Object.create(AgentClient.prototype);
    client.agentConfigs = new Map();
    client.conversationId = 'convo-1';
    const codeWorkspaces = [{ environmentId: 'mac', workspaceId: 'primary' }];
    client.options = {
      endpoint: EModelEndpoint.agents,
      agent: { id: 'attached-agent' },
      req: {
        body: { conversationId: 'convo-1' },
        _codeEnvironmentDecision: { mode: 'attached', codeWorkspaces },
        resolvedConversation: { conversationId: 'convo-1', codeWorkspaces },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
    };

    const saveOptions = client.getSaveOptions();
    expect(saveOptions.codeEnvironmentMode).toBe('attached');
    expect(saveOptions).not.toHaveProperty('codeWorkspaces');
  });

  it('does not combine a normalized no-attached mode with stale request selections', () => {
    const client = Object.create(AgentClient.prototype);
    client.agentConfigs = new Map();
    client.options = {
      endpoint: EModelEndpoint.agents,
      agent: { id: 'attached-agent' },
      req: {
        body: {
          codeWorkspaces: [{ environmentId: 'attached-vm', workspaceId: 'stale-project' }],
        },
        _codeEnvironmentDecision: { mode: 'without_attached' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
    };

    const saveOptions = client.getSaveOptions();
    expect(saveOptions.codeEnvironmentMode).toBe('without_attached');
    expect(saveOptions).not.toHaveProperty('codeWorkspaces');
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

jest.mock('@librechat/agents', () => ({
  ...jest.requireActual('@librechat/agents'),
  createMetadataAggregator: () => ({
    handleLLMEnd: jest.fn(),
    collected: [],
  }),
  formatAgentMessages: (...args) => mockFormatAgentMessages(...args),
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  buildAgentScopedContext: (...args) => mockBuildAgentScopedContext(...args),
  checkAccess: jest.fn(),
  createRun: (...args) => mockCreateRun(...args),
  countFormattedMessageTokens: jest.fn(() => 42),
  countTokens: jest.fn((text) => Math.ceil(String(text ?? '').length / 4)),
  createCachedTokenCounter: jest.fn(async () => jest.fn(() => 0)),
  createInitializedAgentContextFingerprint: jest.fn(() => ({
    algorithm: 'sha256',
    version: 1,
    digest: 'context',
  })),
  createSkillContentDigest: jest.fn((body) => `digest:${body}`),
  MAX_AGENT_CONTEXT_SKILLS: 64,
  createDetachedSubagentUsageRecorder: (...args) =>
    mockCreateDetachedSubagentUsageRecorder(...args),
  captureAgentCheckpointGeneration: (...args) => mockCaptureAgentCheckpointGeneration(...args),
  deleteAgentCheckpoint: (...args) => mockDeleteAgentCheckpoint(...args),
  decrementPendingRequest: jest.fn(async () => {}),
  initializeAgent: jest.fn(),
  isHITLEnabled: (...args) => mockIsHITLEnabled(...args),
  createMemoryProcessor: jest.fn(),
  isMemoryAgentEnabled: jest.fn((config) => {
    if (!config || config.disabled === true) return false;
    const agent = config.agent;
    if (agent?.enabled !== true) return false;
    return Boolean(agent.id || (agent.provider && agent.model));
  }),
  loadAgent: jest.fn(),
  maybePrewarmCodeSandbox: jest.fn(),
  recordCollectedUsage: (...args) => mockRecordCollectedUsage(...args),
  getAgentCheckpointer: mockGetAgentCheckpointer,
  hasDurableAgentInterruptCheckpoint: (...args) => mockHasDurableAgentInterruptCheckpoint(...args),
  stripActivityLabelParts: (...args) => mockStripActivityLabelParts(...args),
}));

describe('AgentClient - event actor history adapter', () => {
  const fingerprint = { algorithm: 'sha256', version: 1, digest: 'context' };
  const compactionSemanticIndex = {
    version: 1,
    providedEntryCount: 1,
    entries: [
      {
        type: 'activity_phase',
        sourceMessageId: 'assistant-history',
        sourceContentIndex: 1,
        revision: 1,
        status: 'committed',
        text: 'Verified the release state',
      },
    ],
  };

  it('loads no durable history after compatibility selected a warm continuation', async () => {
    const loadHistory = jest.spyOn(BaseClient.prototype, 'loadHistory');
    const client = Object.create(AgentClient.prototype);
    client.eventActorContinuation = 'warm';

    await expect(client.loadHistory('conversation-1', 'message-1')).resolves.toEqual([]);
    expect(loadHistory).not.toHaveBeenCalled();
    loadHistory.mockRestore();
  });

  it('delegates rebuilt continuation to the existing durable history loader', async () => {
    const loadHistory = jest
      .spyOn(BaseClient.prototype, 'loadHistory')
      .mockResolvedValue([{ messageId: 'message-1' }]);
    const client = Object.create(AgentClient.prototype);
    client.eventActorContinuation = 'cold';

    await expect(client.loadHistory('conversation-1', 'message-1')).resolves.toEqual([
      { messageId: 'message-1' },
    ]);
    expect(loadHistory).toHaveBeenCalledWith('conversation-1', 'message-1');
    loadHistory.mockRestore();
  });

  it('resolves and caches the exact durable Skill manifest before warming', async () => {
    const skillManifest = [{ id: 'skill-1', name: 'analysis', version: 3 }];
    const skillPrimeResult = {
      skillManifest,
      skills: new Map([['analysis', 'Analyze carefully.']]),
    };
    const primeInvokedSkills = jest.fn().mockResolvedValue(skillPrimeResult);
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: { config: {} },
      primeInvokedSkills,
    };
    client.getEventActorContext = jest.fn().mockResolvedValue({
      fingerprint,
      skillManifest,
      discoveredToolNames: ['deferred_tool'],
      summary: { text: 'Earlier compacted context.', tokenCount: 12 },
      contextMeta: { calibrationRatio: 1.25, encoding: 'o200k_base' },
      compactionSemanticIndex,
    });

    await expect(
      client.prepareEventActorContext({
        contextFingerprint: fingerprint,
        skillManifest,
        discoveredToolNames: ['deferred_tool'],
        summary: { text: 'Earlier compacted context.', tokenCount: 12, version: 1 },
        contextMeta: { calibrationRatio: 1.25, encoding: 'o200k_base' },
        compactionSemanticIndex,
      }),
    ).resolves.toMatchObject({
      fingerprint,
      skillManifest,
      discoveredToolNames: ['deferred_tool'],
      summary: { text: 'Earlier compacted context.', tokenCount: 12 },
      contextMeta: { calibrationRatio: 1.25, encoding: 'o200k_base' },
      compactionSemanticIndex,
      checkpointMessageOverlay: {
        source: 'skill',
        messages: [
          expect.objectContaining({
            content: 'Analyze carefully.',
            additional_kwargs: expect.objectContaining({
              source: 'skill',
              skillName: 'analysis',
            }),
          }),
        ],
      },
    });
    expect(primeInvokedSkills).toHaveBeenCalledWith([], ['analysis']);
    expect(client.getEventActorContext).toHaveBeenCalledWith(skillManifest, ['deferred_tool']);
    expect(client.eventActorSkillPrimeResult).toEqual(skillPrimeResult);
    expect(client.eventActorDiscoveredToolNames).toEqual(['deferred_tool']);
    expect(client.eventActorSummary).toEqual({
      text: 'Earlier compacted context.',
      tokenCount: 12,
      version: 1,
    });
    expect(client.contextMeta).toEqual({ calibrationRatio: 1.25, encoding: 'o200k_base' });
    expect(client.compactionSemanticIndexSnapshot).toEqual({
      entries: compactionSemanticIndex.entries,
      providedEntryCount: 1,
    });
  });

  it('falls back when a durable Skill resolves to a different revision', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = {
      req: { config: {} },
      primeInvokedSkills: jest.fn().mockResolvedValue({
        skillManifest: [{ id: 'skill-1', name: 'analysis', version: 4 }],
      }),
    };
    client.getEventActorContext = jest.fn();

    await expect(
      client.prepareEventActorContext({
        contextFingerprint: fingerprint,
        skillManifest: [{ id: 'skill-1', name: 'analysis', version: 3 }],
      }),
    ).resolves.toBeUndefined();
    expect(client.getEventActorContext).not.toHaveBeenCalled();
  });

  it('carries a freshly manual-primed Skill into the durable manifest', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: { endpoints: { agents: {} } } } };
    client.eventActorAgentContextSources = [
      {
        id: 'agent-1',
        manualSkillPrimes: [
          { _id: 'skill-1', name: 'analysis', version: 3, body: 'Analyze carefully.' },
        ],
      },
    ];
    client.getEventActorAgents = jest.fn(() => []);
    client.getEventActorMemorySnapshots = jest.fn().mockResolvedValue([]);

    await expect(client.getEventActorContext()).resolves.toMatchObject({
      skillManifest: [
        {
          id: 'skill-1',
          name: 'analysis',
          version: 3,
          contentDigest: 'digest:Analyze carefully.',
        },
      ],
    });
  });

  it('replays only root Skill primes into the global checkpoint overlay', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: {} } };
    client.eventActorAgentContextSources = [
      {
        id: 'root-agent',
        alwaysApplySkillPrimes: [
          { _id: 'root-skill', name: 'root-skill', version: 1, body: 'Root instructions.' },
        ],
      },
      {
        id: 'child-agent',
        alwaysApplySkillPrimes: [
          { _id: 'child-skill', name: 'child-skill', version: 1, body: 'Child instructions.' },
        ],
      },
    ];
    client.getEventActorContext = jest.fn().mockResolvedValue({ fingerprint });

    const context = await client.prepareEventActorContext({ contextFingerprint: fingerprint });

    expect(context.checkpointMessageOverlay.messages).toEqual([
      expect.objectContaining({
        content: 'Root instructions.',
        additional_kwargs: expect.objectContaining({ skillName: 'root-skill' }),
      }),
    ]);
    expect(context.checkpointMessageOverlay.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          additional_kwargs: expect.objectContaining({ skillName: 'child-skill' }),
        }),
      ]),
    );
  });

  it('keeps child manual Skills out of the root durable manifest', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: { endpoints: { agents: {} } } } };
    client.eventActorAgentContextSources = [
      { id: 'root-agent', manualSkillPrimes: [] },
      {
        id: 'child-agent',
        manualSkillPrimes: [
          { _id: 'child-skill', name: 'child-skill', version: 1, body: 'Child instructions.' },
        ],
      },
    ];
    client.getEventActorAgents = jest.fn(() => []);
    client.getEventActorMemorySnapshots = jest.fn().mockResolvedValue([]);

    await expect(client.getEventActorContext()).resolves.toMatchObject({ skillManifest: [] });
  });

  it('captures the latest run summary and pruning calibration in continuation state', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: { endpoints: { agents: {} } } } };
    client.eventActorAgentContextSources = [];
    client.contentParts = [
      {
        type: ContentTypes.SUMMARY,
        content: [{ type: ContentTypes.TEXT, text: 'Fresh compacted context.' }],
        tokenCount: 18,
        boundary: { messageId: 'step_summary', contentIndex: 0 },
      },
    ];
    client.contextMeta = { calibrationRatio: 1.3, encoding: 'o200k_base' };
    client.compactionSemanticIndexSnapshot = {
      entries: compactionSemanticIndex.entries,
      providedEntryCount: 1,
    };
    client.getEventActorAgents = jest.fn(() => []);
    client.getEventActorMemorySnapshots = jest.fn().mockResolvedValue([]);

    await expect(client.getEventActorContext()).resolves.toMatchObject({
      summary: { text: 'Fresh compacted context.', tokenCount: 18 },
      contextMeta: { calibrationRatio: 1.3, encoding: 'o200k_base' },
      compactionSemanticIndex,
    });
  });

  it('fingerprints agents reachable only through nested subagent graphs', () => {
    const graphMember = { id: 'graph-member' };
    const graphMetadata = { id: 'graph-metadata', configId: 'graph-metadata-v2' };
    const lazy = {
      id: 'lazy',
      configId: 'lazy-config-v2',
      subagentGraphMemberMetadata: [graphMetadata],
    };
    const nested = {
      id: 'nested',
      lazySubagentConfigs: [lazy],
      subagentGraphConfigs: [{ memberConfigs: [graphMember] }],
    };
    const client = Object.create(AgentClient.prototype);
    client.options = { agent: { id: 'primary', subagentAgentConfigs: [nested] } };
    client.agentConfigs = new Map([['parallel', { id: 'parallel' }]]);

    expect(client.getEventActorAgents().map((agent) => agent.id)).toEqual([
      'primary',
      'parallel',
      'nested',
      'lazy',
      'graph-member',
      'graph-metadata',
    ]);
  });

  it('snapshots only memory partitions that can reach model context', async () => {
    const getFormattedMemories = require('~/models').getFormattedMemories;
    getFormattedMemories.mockClear();
    getFormattedMemories.mockResolvedValue({ withKeys: 'private memory' });
    const primary = { id: 'primary' };
    const inertChild = {
      id: 'inert-child',
      memory_scope: 'agent',
      memoryToolsRegistered: false,
    };
    const memoryChild = {
      id: 'memory-child',
      memory_scope: 'agent',
      memoryToolsRegistered: true,
    };
    const client = Object.create(AgentClient.prototype);
    client.options = { agent: primary, req: { user: { id: 'user-1' } } };
    client.getSharedMemoryContext = jest.fn().mockResolvedValue({ withoutKeys: 'shared memory' });

    await expect(
      client.getEventActorMemorySnapshots([primary, inertChild, memoryChild]),
    ).resolves.toEqual([
      { scope: 'memory-child', withKeys: 'private memory' },
      { scope: 'shared', withoutKeys: 'shared memory' },
    ]);
    expect(getFormattedMemories).toHaveBeenCalledTimes(1);
    expect(getFormattedMemories).toHaveBeenCalledWith({
      userId: 'user-1',
      agentId: 'memory-child',
    });
  });
});

describe('AgentClient - final model-bound content protection', () => {
  const filters = {
    messages: {
      pii: {
        fields: ['text'],
        starterPatterns: [],
        customPatterns: [
          {
            id: 'provider-bound-secret',
            label: 'provider-bound secret',
            regex: 'PROVIDER-BOUND-[A-Z]+',
          },
        ],
      },
    },
  };

  const makeClient = () => {
    const client = Object.create(AgentClient.prototype);
    client.options = {
      resendFiles: true,
      req: { config: { filters } },
    };
    client.authorizedHistoricalFiles = new Map();
    client.setModelBoundStoredMessages([
      {
        role: 'user',
        isCreatedByUser: true,
        text: 'Old PROVIDER-BOUND-SECRET',
        messageId: 'pruned-source',
      },
      {
        role: 'user',
        isCreatedByUser: true,
        text: 'Safe retained text',
        messageId: 'retained-source',
      },
    ]);
    return client;
  };

  it('inspects only persisted source rows retained by the provider payload', () => {
    const callback = makeClient().createModelBoundChatModelCallback();

    expect(callback).toEqual(expect.objectContaining({ raiseError: true, awaitHandlers: true }));
    expect(() =>
      callback.handleChatModelStart(undefined, [
        [
          {
            role: 'user',
            content: 'Safe retained text',
            additional_kwargs: { sourceMessageId: 'retained-source' },
          },
        ],
      ]),
    ).not.toThrow();
    expect(() =>
      callback.handleChatModelStart(undefined, [
        [
          {
            role: 'user',
            content: 'Old PROVIDER-BOUND-SECRET',
            additional_kwargs: { sourceMessageId: 'pruned-source' },
          },
        ],
      ]),
    ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
  });

  it('inspects synthetic summarizer and mid-run model input without a source row', () => {
    const callback = makeClient().createModelBoundChatModelCallback();

    expect(() =>
      callback.handleChatModelStart(undefined, [
        [{ role: 'user', content: 'Synthetic PROVIDER-BOUND-SUMMARY input' }],
      ]),
    ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
  });

  it('preflights legacy restored history before user-message persistence', () => {
    const client = makeClient();
    client.options.req.config.messageFilter = {
      pii: {
        starterPatterns: [],
        customPatterns: [
          {
            id: 'legacy-provider-bound-secret',
            label: 'legacy provider-bound secret',
            regex: 'PROVIDER-BOUND-[A-Z]+',
          },
        ],
      },
    };

    expect(() => client.assertStoredModelBoundContent()).toThrow(
      expect.objectContaining({ code: 'content_filter_block' }),
    );
  });

  it('keeps source-aware restored history enforcement at the final provider boundary', () => {
    const client = makeClient();

    expect(() => client.assertStoredModelBoundContent()).not.toThrow();
  });

  it('allows safe restored history under legacy message filtering', () => {
    const client = makeClient();
    client.options.req.config.messageFilter = {
      pii: {
        starterPatterns: [],
        customPatterns: [
          {
            id: 'legacy-provider-bound-secret',
            label: 'legacy provider-bound secret',
            regex: 'PROVIDER-BOUND-[A-Z]+',
          },
        ],
      },
    };
    client.setModelBoundStoredMessages([
      {
        role: 'user',
        isCreatedByUser: true,
        text: 'Safe restored text',
        messageId: 'safe-source',
      },
    ]);

    expect(() => client.assertStoredModelBoundContent()).not.toThrow();
  });

  it('keeps materialized current attachments inspectable when historical replay is disabled', () => {
    const client = makeClient();
    const currentFile = {
      file_id: 'current-file',
      filename: 'safe.png',
      type: 'image/png',
      text: 'Safe current OCR content',
    };
    client.options.resendFiles = false;
    client.options.attachments = [
      { file_id: 'current-file', filename: 'safe.png', type: 'image/png' },
    ];
    client.modelBoundCurrentFiles = [currentFile];
    client.options.req.config.filters = {
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    };
    client.message_file_map = { 'retained-source': [currentFile] };

    expect(() =>
      client.createModelBoundChatModelCallback().handleChatModelStart(undefined, [
        [
          {
            role: 'user',
            content: 'Safe retained text',
            additional_kwargs: { sourceMessageId: 'retained-source' },
          },
        ],
      ]),
    ).not.toThrow();
  });
});

describe('AgentClient - detached subagent usage', () => {
  it('records each detached call from an immutable snapshot after parent disposal', async () => {
    mockRecordCollectedUsage.mockClear();
    mockCreateDetachedSubagentUsageRecorder.mockClear();
    mockDetachedUsageRecorder.mockClear();
    const client = Object.create(AgentClient.prototype);
    const childTokenConfig = { input: 1, output: 2 };
    client.user = 'user-123';
    client.conversationId = 'conversation-123';
    client.responseMessageId = 'response-123';
    client.model = 'primary-model';
    client.options = {
      req: { user: { id: 'request-user' } },
      agent: { model_parameters: { model: 'fallback-model' } },
      endpointTokenConfig: { input: 3, output: 4 },
      endpointTokenConfigByAgentId: new Map([['agent-child', childTokenConfig]]),
    };
    const balance = { enabled: true };
    const transactions = { enabled: true };
    const usage = {
      usage_type: 'subagent',
      input_tokens: 100,
      output_tokens: 20,
      agentId: 'agent-child',
    };

    const recordUsage = client.buildDetachedSubagentUsageRecorder(balance, transactions);
    client.user = null;
    client.conversationId = null;
    client.responseMessageId = null;
    client.model = null;
    client.options = null;

    await recordUsage(usage);

    expect(mockCreateDetachedSubagentUsageRecorder).toHaveBeenCalledTimes(1);
    const [deps, billing] = mockCreateDetachedSubagentUsageRecorder.mock.calls[0];
    expect(deps).toEqual({
      spendTokens: expect.any(Function),
      spendStructuredTokens: expect.any(Function),
      pricing: {
        getMultiplier: expect.any(Function),
        getCacheMultiplier: expect.any(Function),
      },
      bulkWriteOps: {
        insertMany: expect.any(Function),
        updateBalance: expect.any(Function),
      },
      isPrincipalActive: expect.any(Function),
    });
    expect(billing).toEqual({
      user: 'user-123',
      conversationId: 'conversation-123',
      model: 'primary-model',
      messageId: 'response-123',
      balance,
      transactions,
      endpointTokenConfig: { input: 3, output: 4 },
      endpointTokenConfigByAgentId: expect.any(Map),
    });
    expect(billing.endpointTokenConfigByAgentId.get('agent-child')).toBe(childTokenConfig);
    expect(mockDetachedUsageRecorder).toHaveBeenCalledWith(usage);
  });
});

describe('AgentClient - subagent parent persistence', () => {
  it('matches the graph starting wave for parallel roots and cyclic fallback', () => {
    expect(
      AgentClient.getStartingAgentIds([
        { id: 'agent-a', edges: [{ from: 'agent-a', to: 'agent-c' }] },
        { id: 'agent-b' },
        { id: 'agent-c' },
      ]),
    ).toEqual(['agent-a', 'agent-b']);
    expect(
      AgentClient.getStartingAgentIds([
        {
          id: 'agent-a',
          edges: [
            { from: 'agent-a', to: 'agent-b' },
            { from: 'agent-b', to: 'agent-a' },
          ],
        },
        { id: 'agent-b' },
      ]),
    ).toEqual(['agent-a']);
  });

  it('registers the parent user-message write before detached child dispatch can proceed', async () => {
    const userMessagePromise = Promise.resolve({
      message: { messageId: 'parent-user-message', conversationId: 'parent-conversation' },
    });
    const registerParentPersistence = jest.fn();
    const upstreamGetReqData = jest.fn();
    const baseSend = jest
      .spyOn(BaseClient.prototype, 'sendMessage')
      .mockImplementation(async (_message, opts) => {
        opts.getReqData({ userMessagePromise });
        return { ok: true };
      });
    const client = Object.create(AgentClient.prototype);
    client.options = {
      subagentTasks: {
        scopeId: 'trusted-parent-scope',
        store: { registerParentPersistence },
      },
    };

    await client.sendMessage('Start the parent turn.', { getReqData: upstreamGetReqData });

    expect(upstreamGetReqData).toHaveBeenCalledWith({ userMessagePromise });
    expect(registerParentPersistence).toHaveBeenCalledWith(
      'trusted-parent-scope',
      userMessagePromise,
    );
    baseSend.mockRestore();
  });
});

describe('AgentClient - label settlement', () => {
  it('drains a trailing fill enqueued by an in-flight reasoning revision', async () => {
    const client = Object.create(AgentClient.prototype);
    const first = deferred();
    const trailing = deferred();
    const scope = { closed: false, abort: new AbortController(), detach: jest.fn() };
    client.activityLabelScopes = [scope];
    client.pendingActivityLabelFills = [
      first.promise.finally(() => {
        client.pendingActivityLabelFills.push(trailing.promise);
      }),
    ];

    let settled = false;
    const settlement = client.settleActivityLabels(1_000).then(() => {
      settled = true;
    });
    first.resolve();
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    trailing.resolve();
    await settlement;

    expect(scope.closed).toBe(false);
    expect(scope.detach).toHaveBeenCalledTimes(1);
    expect(client.pendingActivityLabelFills).toEqual([]);
  });
});

describe('AgentClient - reasoning label accounting', () => {
  function createReasoningLabelClient(generateReasoningLabel) {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { user: { id: 'user-123' } } };
    client.conversationId = 'conversation-123';
    client.parentMessageId = 'parent-123';
    client.responseMessageId = 'response-123';
    client.run = { generateReasoningLabel };
    client.resolveReasoningLabelLLM = jest.fn(async () => ({
      provider: Providers.OPENAI,
      clientOptions: { model: 'reasoning-label-model' },
      endpointTokenConfig: { input: 1, output: 2 },
      sameEndpoint: false,
    }));
    client.recordActivityLabelUsage = jest.fn(async () => undefined);
    return client;
  }

  it('estimates output tokens from the raw model completion before title normalization', async () => {
    const rawCompletion = 'Inspecting the cache race\nThis extra explanation also consumed tokens.';
    const client = createReasoningLabelClient(
      jest.fn(async ({ chainOptions }) => {
        const callback = chainOptions.callbacks[0];
        callback.handleChatModelStart(undefined, [[{ content: 'captured SDK prompt' }]]);
        callback.handleLLMEnd({
          generations: [
            [
              {
                text: rawCompletion,
                message: { content: [{ type: 'text', text: rawCompletion }] },
              },
            ],
          ],
        });
        return { label: 'Inspecting the cache race' };
      }),
    );

    const generated = await client.generateReasoningLabelViaRun({
      visibleReasoning: 'x'.repeat(500),
      reasoningStepId: 'reasoning-1',
      revision: 1,
      status: 'streaming',
      signal: new AbortController().signal,
    });
    await generated.collectUsage(generated.label);

    const usageCall = client.recordActivityLabelUsage.mock.calls[0];
    expect(usageCall[6]()).toEqual({
      promptText: 'captured SDK prompt',
      completionText: rawCompletion,
    });
    expect(usageCall[7]).toBe('reasoning-label');
  });

  it('falls back to the returned label when no raw completion callback is available', async () => {
    const client = createReasoningLabelClient(
      jest.fn(async () => ({ label: 'Inspecting the cache race' })),
    );

    const generated = await client.generateReasoningLabelViaRun({
      visibleReasoning: 'x'.repeat(500),
      reasoningStepId: 'reasoning-1',
      revision: 1,
      status: 'streaming',
      signal: new AbortController().signal,
    });
    await generated.collectUsage(generated.label);

    expect(client.recordActivityLabelUsage.mock.calls[0][6]()).toMatchObject({
      completionText: 'Inspecting the cache race',
    });
  });
});

describe('AgentClient - interrupt discovery persistence', () => {
  beforeEach(async () => {
    mockHasDurableAgentInterruptCheckpoint.mockClear();
    await GenerationJobManager.destroy();
    GenerationJobManager.configure({ ...createStreamServices(), cleanupOnComplete: false });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('stages an event-actor interrupt until its signed suspension is durable', async () => {
    const streamId = 'conversation-event-actor-staged-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-event-actor-pause';
    client.jobCreatedAt = job.createdAt;
    client.eventActorInvocationId = 'event-pause';

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'interrupt-event-actor',
          threadId: streamId,
          payload: {
            type: 'ask_user_question',
            question: { question: 'Proceed?' },
          },
        }),
        getDiscoveredTools: () => ['save_issue_mcp_linear'],
      },
      streamId,
    );

    await expect(GenerationJobManager.getJobStatus(streamId)).resolves.toBe('running');
    expect(client.pendingApproval).toBeUndefined();
    expect(client.readEventActorSuspension()).toMatchObject({
      actionId: expect.any(String),
      jobCreatedAt: job.createdAt,
      interrupt: {
        id: 'interrupt-event-actor',
        payload: {
          type: 'ask_user_question',
          actionId: expect.any(String),
        },
      },
    });

    await expect(
      client.publishStagedApproval({ version: 1, suspensionId: 'signed-suspension', attempt: 0 }),
    ).resolves.toBe(true);
    await expect(GenerationJobManager.getJobStatus(streamId)).resolves.toBe('requires_action');
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: {
        agentEventSuspension: {
          version: 1,
          suspensionId: 'signed-suspension',
          attempt: 0,
        },
      },
    });
    expect(client.pendingApproval).toMatchObject({ actionId: expect.any(String) });
    expect(client.pendingRequestReleased).toBeFalsy();

    await client.exposePendingApproval();
    expect(client.pendingRequestReleased).toBe(true);
  });

  it('makes the run discovery snapshot durable when the run pauses', async () => {
    const streamId = 'conversation-discovered-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-discovered-pause';
    client.jobCreatedAt = job.createdAt;
    client.compactionSemanticIndexSnapshot = {
      entries: [
        {
          type: 'activity_phase',
          sourceMessageId: 'assistant-before-pause',
          sourceContentIndex: 1,
          revision: 1,
          status: 'committed',
          text: 'Prepared the change',
        },
      ],
      providedEntryCount: 1,
    };

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'ask-interrupt',
          threadId: streamId,
          payload: {
            type: 'ask_user_question',
            question: { question: 'Proceed?' },
          },
        }),
        getDiscoveredTools: () => ['save_issue_mcp_linear'],
        getRunMessages: () => [],
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused?.status).toBe('requires_action');
    expect(paused?.metadata.discoveredTools).toEqual(['save_issue_mcp_linear']);
    expect(paused?.metadata.compactionSemanticIndex).toEqual({
      version: 1,
      entries: client.compactionSemanticIndexSnapshot.entries,
      providedEntryCount: 1,
    });
  });

  it('binds a paused code approval to the resolved stateful target without storing raw routing data', async () => {
    const streamId = 'conversation-code-target-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        toolDefinitions: [{ name: 'bash_tool', toolType: 'builtin' }],
        codeExecutionContext: {
          baseUrl: 'https://private-bridge.example/v1',
          codeSessionKey: 'execute_code:stateful:private-route:private-session',
          executionProfile: 'stateful',
          executionRouteKey: 'stateful:private-route',
          runtimeSessionHint: 'private-session',
          statefulSessions: true,
          environmentId: 'personal-machine',
          environmentType: 'attached',
          bridgeWorkerId: 'private-worker',
        },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-code-target-pause';
    client.jobCreatedAt = job.createdAt;

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'code-interrupt',
          threadId: streamId,
          payload: {
            type: 'tool_approval',
            action_requests: [
              { name: 'bash_tool', arguments: { command: 'git status' }, tool_call_id: 'tc1' },
            ],
            review_configs: [
              {
                action_name: 'bash_tool',
                tool_call_id: 'tc1',
                allowed_decisions: ['approve', 'reject'],
              },
            ],
          },
        }),
        getDiscoveredTools: () => ['bash_tool'],
        getRunMessages: () => [],
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused?.metadata.pendingAction.codeExecutionBinding).toEqual({
      version: 1,
      targets: [
        {
          agentId: 'agent-123',
          targetHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ],
    });
    expect(paused?.metadata.pendingAction.payload.action_requests[0]).toMatchObject({
      name: 'bash_tool',
      source: 'librechat_code',
    });
    const stored = JSON.stringify(paused?.metadata.pendingAction.codeExecutionBinding);
    expect(stored).not.toContain('private-bridge');
    expect(stored).not.toContain('private-worker');
    expect(stored).not.toContain('private-session');
  });

  it('makes the run context meta durable when the run pauses', async () => {
    const streamId = 'conversation-context-meta-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-pause';
    client.jobCreatedAt = job.createdAt;
    const fading = { v: 1, budgetTokens: 50_000, masked: true };

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'ask-interrupt',
          threadId: streamId,
          payload: {
            type: 'ask_user_question',
            question: { question: 'Proceed?' },
          },
        }),
        getDiscoveredTools: () => [],
        getRunMessages: () => [],
        getCalibrationRatio: () => 1.2,
        getFadingTier: () => ({ ...fading, latched: true }),
        getFadingTiers: () => ({
          'agent-123': { ...fading, latched: true },
          'agent-worker': { v: 1, budgetTokens: 8_000, masked: false, latched: true },
        }),
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused?.status).toBe('requires_action');
    /** Only the compact tiers travel: the SDK's provenance flag is stripped. */
    expect(paused?.metadata.contextMeta).toEqual({
      calibrationRatio: 1.2,
      encoding: client.getEncoding(),
      fading,
      fadingTiers: [
        { agentId: 'agent-123', v: 1, budgetTokens: 50_000, masked: true },
        { agentId: 'agent-worker', v: 1, budgetTokens: 8_000, masked: false },
      ],
    });
  });

  it('captures the live graph state at a pause instead of the run seeds', async () => {
    const streamId = 'conversation-context-meta-live-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-live-pause';
    client.jobCreatedAt = job.createdAt;
    const seeded = { v: 1, budgetTokens: 50_000, masked: false };
    const live = { v: 1, budgetTokens: 25_000, masked: true };

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'ask-interrupt',
          threadId: streamId,
          payload: {
            type: 'ask_user_question',
            question: { question: 'Proceed?' },
          },
        }),
        getDiscoveredTools: () => [],
        getRunMessages: () => [],
        getCalibrationRatio: () => 1,
        getFadingTier: () => seeded,
        Graph: {
          getCalibrationRatio: () => 1.4,
          getFadingTier: () => live,
        },
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused?.metadata.contextMeta).toEqual({
      calibrationRatio: 1.4,
      encoding: client.getEncoding(),
      fading: live,
    });
  });

  it('publishes the live context meta onto the job after each context snapshot', async () => {
    const streamId = 'conversation-context-meta-publish';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const contextUsageSink = { latest: null, count: 0 };
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
      contextUsageSink,
    });
    const seed = { calibrationRatio: 1.05, encoding: client.getEncoding() };
    client.contextMeta = seed;
    const updateMetadata = jest.spyOn(GenerationJobManager, 'updateMetadata');

    /** Before the run exists the inherited seed is what a Stop must carry. */
    await client.publishRunContextMeta();
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: { contextMeta: seed },
    });

    const tier = { v: 1, budgetTokens: 25_000, masked: true };
    let ratio = 1.1;
    client.run = {
      Graph: {
        getCalibrationRatio: () => ratio,
        getFadingTier: () => tier,
      },
    };

    expect(typeof contextUsageSink.onSnapshot).toBe('function');
    await contextUsageSink.onSnapshot();
    await contextUsageSink.onSnapshot();
    ratio = 1.3;
    await contextUsageSink.onSnapshot();

    expect(updateMetadata).toHaveBeenCalledTimes(3);
    expect(updateMetadata).toHaveBeenLastCalledWith(
      streamId,
      {
        contextMeta: {
          calibrationRatio: 1.3,
          encoding: client.getEncoding(),
          fading: tier,
        },
      },
      job.createdAt,
    );
    const running = await GenerationJobManager.getJob(streamId);
    expect(running?.metadata.contextMeta).toEqual({
      calibrationRatio: 1.3,
      encoding: client.getEncoding(),
      fading: tier,
    });
    updateMetadata.mockRestore();
  });

  it('publishes a neutral record when live state stops carrying anything', async () => {
    const streamId = 'conversation-context-meta-neutral';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const contextUsageSink = { latest: null, count: 0 };
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
      contextUsageSink,
    });
    let ratio = 1;
    let tier;
    client.run = {
      Graph: {
        getCalibrationRatio: () => ratio,
        getFadingTier: () => tier,
      },
    };
    const updateMetadata = jest.spyOn(GenerationJobManager, 'updateMetadata');

    /** A fresh conversation's first neutral snapshot has nothing to clear. */
    await contextUsageSink.onSnapshot();
    expect(updateMetadata).not.toHaveBeenCalled();
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: expect.not.objectContaining({ contextMeta: expect.anything() }),
    });

    ratio = 1.25;
    await contextUsageSink.onSnapshot();
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: { contextMeta: { calibrationRatio: 1.25, encoding: client.getEncoding() } },
    });

    ratio = 1;
    await contextUsageSink.onSnapshot();
    await contextUsageSink.onSnapshot();
    expect(updateMetadata).toHaveBeenCalledTimes(2);
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: { contextMeta: { calibrationRatio: 1, encoding: client.getEncoding() } },
    });
    updateMetadata.mockRestore();
  });

  it('shares one in-flight write between equal concurrent snapshots', async () => {
    const streamId = 'conversation-context-meta-inflight';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const contextUsageSink = { latest: null, count: 0 };
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
      contextUsageSink,
    });
    const tier = { v: 1, budgetTokens: 25_000, masked: true };
    client.run = {
      Graph: {
        getCalibrationRatio: () => 1.2,
        getFadingTier: () => tier,
      },
    };
    let settled = false;
    let releaseWrite;
    const updateMetadata = jest
      .spyOn(GenerationJobManager, 'updateMetadata')
      .mockImplementationOnce(async () => {
        await new Promise((resolve) => {
          releaseWrite = resolve;
        });
        settled = true;
      });

    const first = contextUsageSink.onSnapshot();
    const second = contextUsageSink.onSnapshot();
    let secondSettled = false;
    void second.then(() => {
      secondSettled = true;
    });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(updateMetadata).toHaveBeenCalledTimes(1);

    releaseWrite();
    await Promise.all([first, second]);
    expect(settled).toBe(true);
    expect(secondSettled).toBe(true);
    updateMetadata.mockRestore();
  });

  it('serializes distinct concurrent snapshots so the newest value wins', async () => {
    const streamId = 'conversation-context-meta-ordered';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const contextUsageSink = { latest: null, count: 0 };
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
      contextUsageSink,
    });
    let tier = { v: 1, budgetTokens: 50_000, masked: false };
    client.run = {
      Graph: {
        getCalibrationRatio: () => 1.2,
        getFadingTier: () => tier,
      },
    };
    let releaseFirstWrite;
    const originalUpdateMetadata = Object.getPrototypeOf(GenerationJobManager).updateMetadata;
    const updateMetadata = jest.spyOn(GenerationJobManager, 'updateMetadata');
    updateMetadata.mockImplementationOnce(async (...args) => {
      await new Promise((resolve) => {
        releaseFirstWrite = resolve;
      });
      return originalUpdateMetadata.apply(GenerationJobManager, args);
    });

    const older = contextUsageSink.onSnapshot();
    tier = { v: 1, budgetTokens: 25_000, masked: true };
    const newer = contextUsageSink.onSnapshot();
    await Promise.resolve();
    /** The newer write waits for the older one instead of racing it. */
    expect(updateMetadata).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await Promise.all([older, newer]);
    expect(updateMetadata).toHaveBeenCalledTimes(2);
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      metadata: {
        contextMeta: {
          calibrationRatio: 1.2,
          encoding: client.getEncoding(),
          fading: { v: 1, budgetTokens: 25_000, masked: true },
        },
      },
    });
    updateMetadata.mockRestore();
  });

  it('publishes the inherited context meta before the resumed run continues', async () => {
    const streamId = 'conversation-context-meta-resume-seed';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123', isTemporary: true },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
    });
    const seed = {
      calibrationRatio: 1.15,
      encoding: client.getEncoding(),
      fading: { v: 1, budgetTokens: 30_000, masked: true },
    };
    client.seedContextMeta(seed);
    let metaWhenResumed;
    let metaWhenCreated;
    const resume = jest.fn(async () => {
      metaWhenResumed = (await GenerationJobManager.getJob(streamId))?.metadata.contextMeta;
    });
    mockCreateRun.mockImplementationOnce(async () => {
      metaWhenCreated = (await GenerationJobManager.getJob(streamId))?.metadata.contextMeta;
      return {
        Graph: null,
        resume,
        processStream: jest.fn().mockResolvedValue(),
        getCalibrationRatio: jest.fn(() => 0),
        getInterrupt: jest.fn(() => undefined),
      };
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-resume-seed';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.resumeCompletion({
      resumeValue: { decisions: [] },
      streamId,
      checkpointNamespace: 'resume-seed',
    });

    expect(resume).toHaveBeenCalledTimes(1);
    expect(metaWhenCreated).toEqual(seed);
    expect(metaWhenResumed).toEqual(seed);
  });

  it('records collected usage as an abort when a resumed run is stopped', async () => {
    jest.clearAllMocks();
    const streamId = 'conversation-resume-stopped';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const abortController = new AbortController();
    mockCreateRun.mockImplementationOnce(async () => ({
      Graph: null,
      resume: jest.fn(async () => {
        abortController.abort();
      }),
      processStream: jest.fn().mockResolvedValue(),
      getCalibrationRatio: jest.fn(() => 0),
      getInterrupt: jest.fn(() => undefined),
    }));
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123', isTemporary: true },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [{ input_tokens: 10, output_tokens: 5 }],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-resume-stopped';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.resumeCompletion({
      resumeValue: { decisions: [] },
      streamId,
      checkpointNamespace: 'resume-stopped',
      abortController,
    });

    expect(client.recordCollectedUsage).toHaveBeenCalledTimes(1);
    expect(client.recordCollectedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'abort' }),
    );
  });

  it('publishes the inherited context meta before a fresh run streams', async () => {
    const streamId = 'conversation-context-meta-stream-seed';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
    });
    const seed = {
      calibrationRatio: 1.15,
      encoding: client.getEncoding(),
      fading: { v: 1, budgetTokens: 30_000, masked: true },
    };
    client.contextMeta = seed;
    let metaWhenStreamed;
    let metaWhenCreated;
    const processStream = jest.fn(async () => {
      metaWhenStreamed = (await GenerationJobManager.getJob(streamId))?.metadata.contextMeta;
    });
    /** Run creation is the first abortable setup stage; the seed must precede it. */
    mockCreateRun.mockImplementationOnce(async () => {
      metaWhenCreated = (await GenerationJobManager.getJob(streamId))?.metadata.contextMeta;
      return {
        Graph: null,
        processStream,
        getCalibrationRatio: jest.fn(() => 0),
        getInterrupt: jest.fn(() => undefined),
      };
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-stream-seed';
    client.parentMessageId = 'parent-context-meta-stream-seed';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(processStream).toHaveBeenCalledTimes(1);
    expect(metaWhenCreated).toEqual(seed);
    expect(metaWhenStreamed).toEqual(seed);
  });

  it('keeps the inherited context meta when a fresh run fails before it exists', async () => {
    const streamId = 'conversation-context-meta-setup-failure';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
    });
    const seed = {
      calibrationRatio: 1.15,
      encoding: client.getEncoding(),
      fading: { v: 1, budgetTokens: 30_000, masked: true },
    };
    client.contextMeta = seed;
    mockCreateRun.mockRejectedValueOnce(new Error('run creation failed'));
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-setup-failure';
    client.parentMessageId = 'parent-context-meta-setup-failure';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] }).catch(() => undefined);

    expect(client.run).toBeUndefined();
    expect(client.contextMeta).toEqual(seed);
  });

  it('keeps the inherited context meta when a resumed run fails to rebuild', async () => {
    const streamId = 'conversation-context-meta-resume-failure';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123', isTemporary: true },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: streamId,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      jobCreatedAt: job.createdAt,
    });
    const seed = {
      calibrationRatio: 1.15,
      encoding: client.getEncoding(),
      fading: { v: 1, budgetTokens: 30_000, masked: true },
    };
    client.seedContextMeta(seed);
    mockCreateRun.mockRejectedValueOnce(new Error('rebuild failed'));
    client.conversationId = streamId;
    client.responseMessageId = 'response-context-meta-resume-failure';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client
      .resumeCompletion({
        resumeValue: { decisions: [] },
        streamId,
        checkpointNamespace: 'resume-failure',
      })
      .catch(() => undefined);

    expect(client.run).toBeUndefined();
    expect(client.contextMeta).toEqual(seed);
  });

  it('caps an event-bound pause at the inherited binding deadline', async () => {
    const now = Date.now();
    const streamId = 'conversation-event-bound-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: { checkpointer: { ttl: 3600 } } } },
        _agentEventBindingRetention: {
          /** RetentionMode.ALL conversations are not temporary but still have a deadline. */
          isTemporary: false,
          expiredAt: new Date(now + 5_000),
        },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-event-bound-pause';
    client.jobCreatedAt = job.createdAt;

    await client.handleRunInterrupt(
      {
        getInterrupt: () => ({
          interruptId: 'ask-interrupt',
          threadId: streamId,
          payload: {
            type: 'ask_user_question',
            question: { question: 'Proceed?' },
          },
        }),
        getDiscoveredTools: () => [],
        getRunMessages: () => [],
      },
      streamId,
    );

    const paused = await GenerationJobManager.getJob(streamId);
    expect(paused?.metadata.pendingAction.expiresAt).toBeGreaterThanOrEqual(now + 4_900);
    expect(paused?.metadata.pendingAction.expiresAt).toBeLessThanOrEqual(now + 5_000);
  });

  it('does not expose an event-bound pause after its inherited deadline', async () => {
    const streamId = 'conversation-expired-event-bound-pause';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: { checkpointer: { ttl: 3600 } } } },
        _agentEventBindingRetention: {
          isTemporary: false,
          expiredAt: new Date(Date.now() - 1),
        },
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'response-expired-event-bound-pause';
    client.jobCreatedAt = job.createdAt;

    await expect(
      client.handleRunInterrupt(
        {
          getInterrupt: () => ({
            interruptId: 'ask-interrupt',
            threadId: streamId,
            payload: {
              type: 'ask_user_question',
              question: { question: 'Proceed?' },
            },
          }),
        },
        streamId,
      ),
    ).rejects.toMatchObject({ code: 'HITL_ACTION_EXPIRED' });
    const liveJob = await GenerationJobManager.getJob(streamId);
    expect(liveJob?.status).toBe('running');
    expect(liveJob?.metadata.pendingAction).toBeUndefined();
  });

  it('does not expose a scheduled pause without its shared action store', async () => {
    const streamId = 'scheduled-missing-shared-store';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _isScheduledFire: true,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'scheduled-missing-shared-store-response';
    client.jobCreatedAt = job.createdAt;
    client.checkpointNamespace = job.metadata.checkpointNamespace;

    await expect(
      client.handleRunInterrupt(
        {
          getInterrupt: () => ({
            interruptId: 'ask-interrupt',
            threadId: streamId,
            payload: {
              type: 'ask_user_question',
              question: { question: 'Proceed?' },
            },
          }),
        },
        streamId,
      ),
    ).rejects.toMatchObject({ code: 'SCHEDULED_HITL_REQUIRES_SHARED_STORE' });
    expect(mockHasDurableAgentInterruptCheckpoint).not.toHaveBeenCalled();
    await expect(GenerationJobManager.getJobStatus(streamId)).resolves.toBe('running');
  });

  it('does not expose a scheduled pause without its durable interrupt checkpoint', async () => {
    const isRedisSpy = jest.spyOn(GenerationJobManager, 'isRedis', 'get').mockReturnValue(true);
    const streamId = 'scheduled-missing-interrupt-checkpoint';
    const job = await GenerationJobManager.createJob(streamId, 'user-123', streamId);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents, agent_id: 'agent-123' },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _isScheduledFire: true,
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = streamId;
    client.responseMessageId = 'scheduled-missing-checkpoint-response';
    client.jobCreatedAt = job.createdAt;
    client.checkpointNamespace = job.metadata.checkpointNamespace;
    mockHasDurableAgentInterruptCheckpoint.mockResolvedValueOnce(false);

    try {
      await expect(
        client.handleRunInterrupt(
          {
            getInterrupt: () => ({
              interruptId: 'ask-interrupt',
              checkpointId: 'checkpoint-current',
              checkpointNs: 'nested-agent',
              threadId: streamId,
              payload: {
                type: 'ask_user_question',
                question: { question: 'Proceed?' },
              },
            }),
          },
          streamId,
        ),
      ).rejects.toMatchObject({ code: 'HITL_CHECKPOINT_UNAVAILABLE' });
      expect(mockHasDurableAgentInterruptCheckpoint).toHaveBeenCalledWith(streamId, undefined, {
        checkpointNamespace: job.metadata.checkpointNamespace,
        checkpointId: 'checkpoint-current',
        checkpointNs: 'nested-agent',
        interruptId: 'ask-interrupt',
      });
      await expect(GenerationJobManager.getJobStatus(streamId)).resolves.toBe('running');
    } finally {
      isRedisSpy.mockRestore();
    }
  });
});

jest.mock('~/server/services/Config', () => ({
  getMCPServerTools: jest.fn(),
}));

jest.mock('~/server/services/MCP', () => ({
  resolveConfigServers: jest.fn().mockResolvedValue({}),
}));

jest.mock('~/models', () => ({
  bulkInsertTransactions: jest.fn(),
  getCacheMultiplier: jest.fn(),
  getAgent: jest.fn(),
  getMultiplier: jest.fn(),
  getFiles: jest.fn(),
  getMessages: jest.fn(),
  getRoleByName: jest.fn(),
  getUserMemories: jest.fn(),
  getFormattedMemories: jest.fn(),
  isAgentTriggerPrincipalActive: jest.fn().mockResolvedValue(true),
  spendStructuredTokens: jest.fn(),
  spendTokens: jest.fn(),
  updateBalance: jest.fn(),
}));

// Mock getMCPManager
const mockFormatInstructions = jest.fn();
jest.mock('~/config', () => ({
  getMCPManager: jest.fn(() => ({
    formatInstructionsForContext: mockFormatInstructions,
  })),
}));

describe('AgentClient - applyHideSequentialOutputsFilter', () => {
  const textPart = (text) => ({ type: ContentTypes.TEXT, text });
  const toolCallPart = (id) => ({ type: ContentTypes.TOOL_CALL, tool_call: { id } });

  it('keeps only the last non-label part + tool_call parts when filtering is on', () => {
    const ctx = {
      options: { agent: { hide_sequential_outputs: true } },
      contentParts: [
        textPart('intermediate'),
        toolCallPart('tc1'),
        textPart('reasoning'),
        textPart('final'),
      ],
    };
    AgentClient.prototype.applyHideSequentialOutputsFilter.call(ctx);
    expect(ctx.contentParts).toEqual([toolCallPart('tc1'), textPart('final')]);
  });

  it('keeps the final text when a parent phase marker is appended after it', () => {
    const tool = toolCallPart('tc1');
    const final = textPart('final');
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Completed the investigation',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
    };
    const ctx = {
      options: { agent: { hide_sequential_outputs: true } },
      contentParts: [textPart('intermediate'), tool, final, phase],
    };
    const previousParts = [...ctx.contentParts];

    AgentClient.prototype.applyHideSequentialOutputsFilter.call(ctx);
    AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts);

    expect(ctx.contentParts).toEqual([tool, final, phase]);
    expect(phase.activity_start_index).toBe(0);
    expect(phase.activity_end_index).toBe(1);
  });

  it('keeps an appended phase before the final text when all phase children are filtered', () => {
    const final = textPart('final');
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Completed both reasoning activities',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
    };
    const ctx = {
      options: { agent: { hide_sequential_outputs: true } },
      contentParts: [
        { type: ContentTypes.THINK, think: 'first' },
        { type: ContentTypes.THINK, think: 'second' },
        final,
        phase,
      ],
    };
    const previousParts = [...ctx.contentParts];

    AgentClient.prototype.applyHideSequentialOutputsFilter.call(ctx);
    AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts);

    expect(ctx.contentParts).toEqual([final, phase]);
    expect(phase.activity_start_index).toBe(0);
    expect(phase.activity_end_index).toBe(0);
  });

  it('is a no-op when hide_sequential_outputs is off', () => {
    const parts = [textPart('a'), textPart('b')];
    const ctx = { options: { agent: { hide_sequential_outputs: false } }, contentParts: parts };
    AgentClient.prototype.applyHideSequentialOutputsFilter.call(ctx);
    expect(ctx.contentParts).toEqual([textPart('a'), textPart('b')]);
  });

  it('rebases phase bounds across skill prepends and sequential filtering', () => {
    const reasoning = { type: ContentTypes.THINK, think: 'checking' };
    const activityTool = toolCallPart('activity-tool');
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Resolved the session issue',
      activity_label_type: 'phase',
      activity_start_index: 0,
      activity_end_index: 2,
    };
    const final = textPart('final');
    const previousParts = [reasoning, activityTool, phase, final];
    const skillCard = toolCallPart('manual-skill');
    const ctx = {
      options: { agent: { hide_sequential_outputs: true } },
      contentParts: [skillCard, ...previousParts],
    };

    AgentClient.prototype.applyHideSequentialOutputsFilter.call(ctx);
    AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts);

    expect(ctx.contentParts).toEqual([skillCard, activityTool, phase, final]);
    expect(phase.activity_start_index).toBe(1);
    expect(phase.activity_end_index).toBe(2);
  });

  it('rebases phase bounds over reshaped sparse content without retaining holes', () => {
    const reasoning = { type: ContentTypes.THINK, think: 'planning' };
    const toolCall = toolCallPart('tc-sparse');
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Searched for tools',
      activity_label_type: 'phase',
      activity_start_index: 1,
    };
    const final = textPart('answer');
    const contentParts = [];
    contentParts[0] = reasoning;
    contentParts[2] = toolCall;
    contentParts[3] = phase;
    contentParts[4] = final;
    const previousParts = [...contentParts];
    const ctx = { options: { agent: {} }, contentParts: [toolCall, phase, final] };

    expect(() =>
      AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts),
    ).not.toThrow();
    expect(phase.activity_start_index).toBe(0);
  });

  it('rebases explicit bounds using only defined sparse slots', () => {
    const toolCall = toolCallPart('tc-large-sparse');
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Searched the sparse transcript',
      activity_label_type: 'phase',
      activity_start_index: 5,
      activity_end_index: 999_999,
    };
    const previousParts = [];
    previousParts[5] = toolCall;
    previousParts[999_999] = phase;
    const ctx = { options: { agent: {} }, contentParts: [toolCall, phase] };

    AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts);

    expect(phase.activity_start_index).toBe(0);
    expect(phase.activity_end_index).toBe(1);
  });

  it('preserves a sparse phase reservation when completion does not reshape content', () => {
    const firstTool = toolCallPart('tool-1');
    const secondTool = toolCallPart('tool-2');
    const firstLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded the first result',
      tool_call_ids: ['tool-1'],
    };
    const secondLabel = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Recorded the second result',
      tool_call_ids: ['tool-2'],
    };
    const phase = {
      type: ContentTypes.ACTIVITY_LABEL,
      activity_label: 'Verified both results',
      activity_label_type: 'phase',
      activity_start_index: 0,
    };
    const final = { type: ContentTypes.TEXT, text: 'Final answer', phase: 'final_answer' };
    const contentParts = [];
    contentParts[1] = { type: ContentTypes.TEXT, text: '', phase: 'final_answer' };
    contentParts[2] = firstLabel;
    contentParts[3] = secondTool;
    contentParts[4] = secondLabel;
    contentParts[5] = phase;
    contentParts[6] = final;
    const previousParts = [...contentParts];
    const ctx = { options: { agent: {} }, contentParts };

    AgentClient.prototype.rebaseActivityPhaseBounds.call(ctx, previousParts);
    expect(phase.activity_start_index).toBe(0);

    contentParts[0] = firstTool;
    const phaseChildren = contentParts.slice(
      phase.activity_start_index,
      contentParts.indexOf(phase),
    );
    expect(phaseChildren.map((part) => part?.tool_call?.id).filter(Boolean)).toEqual([
      'tool-1',
      'tool-2',
    ]);
  });
});

describe('AgentClient - activity phase completion', () => {
  it('completes an uninterrupted root run', () => {
    const complete = jest.fn();
    AgentClient.prototype.completeActivityPhase.call(
      {},
      { getInterrupt: () => undefined },
      { complete },
    );
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('retains phase state when the root run pauses for HITL', () => {
    const complete = jest.fn();
    AgentClient.prototype.completeActivityPhase.call(
      {},
      { getInterrupt: () => ({ payload: { type: 'tool_approval' } }) },
      { complete },
    );
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('AgentClient - startup telemetry', () => {
  afterEach(() => {
    clearToolApprovalHooks();
    mockIsHITLEnabled.mockReturnValue(false);
    jest.restoreAllMocks();
  });

  it('refuses scheduled pause-capable runs before provider startup without Redis', async () => {
    mockIsHITLEnabled.mockReturnValue(false);
    const createRunBefore = mockCreateRun.mock.calls.length;
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _isScheduledFire: true,
        _resumableStreamId: 'scheduled-hitl-no-redis',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        tools: [{ name: 'ask_user_question' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'scheduled-hitl-no-redis';
    client.responseMessageId = 'scheduled-hitl-response';
    client.parentMessageId = 'scheduled-hitl-parent';

    await expect(client.chatCompletion({ payload: [] })).rejects.toMatchObject({
      code: 'SCHEDULED_HITL_REQUIRES_SHARED_STORE',
      message: expect.stringContaining('USE_REDIS_STREAMS=true'),
    });
    expect(mockCreateRun).toHaveBeenCalledTimes(createRunBefore);
  });

  it('includes host-generated background tools in scheduled pause admission', async () => {
    const createRunBefore = mockCreateRun.mock.calls.length;
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: {
            [EModelEndpoint.agents]: {
              toolApproval: {
                enabled: true,
                mode: 'bypass',
                ask: ['check_background_task'],
              },
            },
          },
        },
        _isScheduledFire: true,
        _resumableStreamId: 'scheduled-background-tool',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        tools: [{ name: 'read_file' }],
      },
      subagentTasks: {},
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'scheduled-background-tool';
    client.responseMessageId = 'scheduled-background-response';
    client.parentMessageId = 'scheduled-background-parent';

    await expect(client.chatCompletion({ payload: [] })).rejects.toMatchObject({
      code: 'SCHEDULED_HITL_REQUIRES_SHARED_STORE',
    });
    expect(mockCreateRun).toHaveBeenCalledTimes(createRunBefore);
  });

  it.each([
    {
      name: 'a bypass-only approval policy',
      toolApproval: { enabled: true, mode: 'bypass' },
      subagentAgentConfigs: undefined,
    },
    {
      name: 'an approval rule that matches no selected tool',
      toolApproval: { enabled: true, mode: 'bypass', ask: ['approval_probe'] },
      subagentAgentConfigs: undefined,
    },
    {
      name: 'ask_user_question denied by the approval policy',
      toolApproval: { enabled: true, deny: ['ask_*'] },
      primaryTools: [{ name: 'ask_user_question' }],
      subagentAgentConfigs: undefined,
    },
    {
      name: 'ask_user_question on a nested subagent only',
      toolApproval: undefined,
      subagentAgentConfigs: [
        {
          id: 'nested-agent',
          tools: [{ name: 'ask_user_question' }],
        },
      ],
    },
  ])(
    'does not reject scheduled runs for $name',
    async ({ toolApproval, primaryTools, subagentAgentConfigs }) => {
      mockDeleteAgentCheckpoint.mockReset().mockResolvedValue(undefined);
      const processStream = jest.fn().mockResolvedValue();
      mockCreateRun.mockResolvedValueOnce({
        Graph: null,
        processStream,
        getCalibrationRatio: jest.fn(() => 0),
        getInterrupt: jest.fn(() => undefined),
      });
      const createRunBefore = mockCreateRun.mock.calls.length;
      const client = new AgentClient({
        req: {
          user: { id: 'user-123' },
          body: {},
          config: { endpoints: { [EModelEndpoint.agents]: { toolApproval } } },
          _isScheduledFire: true,
          _resumableStreamId: 'scheduled-non-pausing-policy',
        },
        res: {},
        agent: {
          id: 'agent-123',
          endpoint: EModelEndpoint.openAI,
          provider: EModelEndpoint.openAI,
          model_parameters: { model: 'gpt-4' },
          hide_sequential_outputs: false,
          tools: primaryTools ?? [{ name: 'read_file' }],
          subagentAgentConfigs,
        },
        endpointTokenConfig: {},
        eventHandlers: {},
        contentParts: [],
        collectedUsage: [],
        artifactPromises: [],
      });
      client.conversationId = 'scheduled-non-pausing-policy';
      client.checkpointNamespace = 'scheduled-non-pausing-generation';
      client.responseMessageId = 'scheduled-non-pausing-response';
      client.parentMessageId = 'scheduled-non-pausing-parent';
      client.recordCollectedUsage = jest.fn().mockResolvedValue();

      await expect(client.chatCompletion({ payload: [] })).resolves.toBeUndefined();
      expect(mockCreateRun).toHaveBeenCalledTimes(createRunBefore + 1);
      expect(processStream).toHaveBeenCalledTimes(1);
      if (toolApproval?.enabled === true) {
        expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
          'scheduled-non-pausing-policy',
          undefined,
          undefined,
          {
            throwOnError: true,
            checkpointNamespace: 'scheduled-non-pausing-generation',
          },
        );
      } else {
        expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
      }
    },
  );

  it('uses request-scoped hook resolution when deciding whether a scheduled run can pause', async () => {
    mockIsHITLEnabled.mockReturnValue(true);
    registerToolApprovalHook((context) =>
      context.userId === 'different-user' ? async () => ({ decision: 'ask' }) : undefined,
    );
    const processStream = jest.fn().mockResolvedValue();
    mockCreateRun.mockResolvedValueOnce({
      Graph: null,
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
      getInterrupt: jest.fn(() => undefined),
    });
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: {
            [EModelEndpoint.agents]: {
              toolApproval: { enabled: true, mode: 'bypass' },
            },
          },
        },
        _isScheduledFire: true,
        _resumableStreamId: 'scheduled-request-scoped-hook',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
        tools: [{ name: 'read_file' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'scheduled-request-scoped-hook';
    client.checkpointNamespace = 'scheduled-request-scoped-generation';
    client.responseMessageId = 'scheduled-request-scoped-response';
    client.parentMessageId = 'scheduled-request-scoped-parent';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await expect(client.chatCompletion({ payload: [] })).resolves.toBeUndefined();
    expect(mockCreateRun.mock.calls.at(-1)?.[0]?.resolvedToolApprovalHooks).toEqual([]);
  });

  it('admits deployment PreToolUse hooks as pause-capable for scheduled runs', async () => {
    mockIsHITLEnabled.mockReturnValue(true);
    const previousSource = getPluginHookSource();
    setPluginHookSource({
      hasHooks: () => true,
      hasToolApprovalHooks: () => true,
      register: () => 1,
    });
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: {
            [EModelEndpoint.agents]: {
              toolApproval: { enabled: true, mode: 'bypass' },
            },
          },
        },
        _isScheduledFire: true,
        _resumableStreamId: 'scheduled-deployment-hook',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        tools: [{ name: 'write_file' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'scheduled-deployment-hook';
    client.responseMessageId = 'scheduled-deployment-response';
    client.parentMessageId = 'scheduled-deployment-parent';

    try {
      await expect(client.chatCompletion({ payload: [] })).rejects.toMatchObject({
        code: 'SCHEDULED_HITL_REQUIRES_SHARED_STORE',
      });
    } finally {
      setPluginHookSource(previousSource);
    }
  });

  it('overlaps run creation with checkpoint pruning and joins both before stream processing', async () => {
    let releaseCheckpoint;
    let checkpointStarted;
    const runCreation = deferred();
    const checkpointStartedPromise = new Promise((resolve) => {
      checkpointStarted = resolve;
    });
    const checkpointPromise = new Promise((resolve) => {
      releaseCheckpoint = resolve;
    });
    const processStream = jest.fn().mockResolvedValue();
    const run = {
      Graph: null,
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
    };
    const startupTelemetry = {
      mark: jest.fn(),
      setStreamId: jest.fn(),
      recordGenerationEvent: jest.fn(),
      end: jest.fn(),
    };
    mockCreateRun.mockReturnValue(runCreation.promise);
    mockIsHITLEnabled.mockReturnValue(true);
    mockDeleteAgentCheckpoint.mockImplementation(() => {
      checkpointStarted();
      return checkpointPromise;
    });

    const client = new AgentClient({
      req: {
        tenantId: 'request-tenant',
        user: { id: 'user-123', tenantId: 'stale-user-tenant' },
        body: {},
        config: {
          endpoints: { [EModelEndpoint.agents]: { toolApproval: { enabled: true } } },
        },
        _resumableStreamId: 'conversation-123',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
        tools: [{ name: 'write_file' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      startupTelemetry,
      checkpointNamespace: '1000',
    });
    client.conversationId = 'conversation-123';
    client.responseMessageId = 'response-123';
    client.parentMessageId = 'parent-123';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    const completionPromise = client.chatCompletion({ payload: [] });
    await checkpointStartedPromise;

    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockCreateRun.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        tenantId: 'request-tenant',
        modelCallbacks: expect.arrayContaining([
          expect.objectContaining({
            name: 'librechat-model-bound-content-filter',
            raiseError: true,
          }),
          expect.objectContaining({
            name: 'librechat-agent-attachment-memory',
          }),
        ]),
      }),
    );
    expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
      'conversation-123',
      undefined,
      undefined,
      { throwOnError: true, checkpointNamespace: '1000' },
    );
    expect(startupTelemetry.mark.mock.calls.map(([milestone]) => milestone)).toEqual([
      'run_input_prepared',
    ]);
    expect(processStream).not.toHaveBeenCalled();

    runCreation.resolve(run);
    await Promise.resolve();

    expect(startupTelemetry.mark.mock.calls.map(([milestone]) => milestone)).toEqual([
      'run_input_prepared',
      'run_created',
    ]);
    expect(processStream).not.toHaveBeenCalled();

    releaseCheckpoint();
    await completionPromise;

    expect(startupTelemetry.mark.mock.calls.map(([milestone]) => milestone)).toEqual([
      'run_input_prepared',
      'run_created',
      'stream_processing_started',
    ]);
    expect(processStream).toHaveBeenCalledTimes(1);
    expect(processStream.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: 'conversation-123',
          checkpoint_ns: '',
          __librechat_checkpoint_ns: '1000',
        }),
      }),
    );
    expect(processStream.mock.calls[0][1]).not.toHaveProperty('callbacks');
  });

  it('derives and forwards compaction guidance without stripping activity labels', async () => {
    jest.clearAllMocks();
    mockIsHITLEnabled.mockReturnValue(false);
    const compactionSemanticIndex = [
      {
        type: 'activity_phase',
        sourceMessageId: 'assistant-history',
        sourceContentIndex: 1,
        revision: 1,
        status: 'committed',
        text: 'Verified the release state',
      },
    ];
    const payload = [
      {
        messageId: 'assistant-history',
        content: [
          { type: ContentTypes.TEXT, text: 'Details' },
          {
            type: ContentTypes.ACTIVITY_LABEL,
            activity_label: 'Verified the release state',
            activity_label_type: 'phase',
          },
        ],
      },
    ];
    mockFormatAgentMessages.mockReturnValueOnce({
      messages: [],
      indexTokenCountMap: {},
      summary: undefined,
      boundaryTokenAdjustment: undefined,
      compactionSemanticIndexSnapshot: {
        entries: compactionSemanticIndex,
        providedEntryCount: compactionSemanticIndex.length,
      },
    });
    const processStream = jest.fn().mockResolvedValue();
    mockCreateRun.mockResolvedValueOnce({
      Graph: null,
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
      getInterrupt: jest.fn(() => undefined),
    });
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'semantic-index-conversation',
      },
      res: {},
      agent: {
        id: 'agent-primary',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
        semanticIntentToolNames: ['web_search'],
        semanticIntentBlockedToolNames: ['create_record'],
      },
      agentConfigs: new Map([
        [
          'agent-secondary',
          {
            id: 'agent-secondary',
            endpoint: EModelEndpoint.openAI,
            provider: EModelEndpoint.openAI,
            model_parameters: { model: 'gpt-4' },
            semanticIntentToolNames: ['read_file', 'create_record'],
          },
        ],
      ]),
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'semantic-index-conversation';
    client.responseMessageId = 'semantic-index-response';
    client.parentMessageId = 'semantic-index-parent';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload });

    expect(mockFormatAgentMessages).toHaveBeenCalledTimes(1);
    const [formattedPayload, , , , formatOptions] = mockFormatAgentMessages.mock.calls[0];
    expect(formattedPayload).toBe(payload);
    expect(formattedPayload[0].content).toContainEqual(
      expect.objectContaining({ type: ContentTypes.ACTIVITY_LABEL }),
    );
    expect(mockStripActivityLabelParts).not.toHaveBeenCalled();
    expect(formatOptions.compactionSemanticIndex.intentToolNames).toEqual(
      new Set(['web_search', 'read_file']),
    );
    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({ compactionSemanticIndex }),
    );
    expect(processStream).toHaveBeenCalledTimes(1);
  });

  it('preserves provider messages while deriving the full semantic index', () => {
    const { formatAgentMessages } = jest.requireActual('@librechat/agents');
    const { stripActivityLabelParts } = jest.requireActual('@librechat/api');
    const payload = [
      {
        role: 'assistant',
        messageId: 'semantic-history',
        content: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              id: 'search-1',
              name: 'search_docs',
              args: JSON.stringify({ intent: 'Locate the cache implementation', query: 'cache' }),
              output: 'Found the implementation.',
              outcome: 'Located the cache implementation',
            },
          },
          {
            type: ContentTypes.THINK,
            think: 'Private reasoning stays out of compaction guidance.',
            reasoning_label: 'Checking cache ownership',
            reasoning_label_step_id: 'reasoning-1',
            reasoning_label_revision: 2,
            reasoning_label_status: 'complete',
          },
          {
            type: ContentTypes.ACTIVITY_LABEL,
            activity_label: 'Mapped the cache request path',
            activity_label_type: 'phase',
            activity_start_index: 0,
            pending: false,
          },
          { type: ContentTypes.TEXT, text: 'The cache is initialized in the request adapter.' },
        ],
      },
    ];

    const legacyProjection = formatAgentMessages(
      stripActivityLabelParts(payload),
      undefined,
      undefined,
      undefined,
      { preserveReasoningContent: true },
    );
    const baseline = formatAgentMessages(payload, undefined, undefined, undefined, {
      preserveReasoningContent: true,
    });
    const derived = formatAgentMessages(payload, undefined, undefined, undefined, {
      preserveReasoningContent: true,
      compactionSemanticIndex: { intentToolNames: new Set(['search_docs']) },
    });

    expect(derived.messages.map((message) => message.toDict())).toEqual(
      baseline.messages.map((message) => message.toDict()),
    );
    const providerShape = (messages) =>
      messages.map((message) => {
        const serialized = message.toDict();
        const {
          sourceMessageId: _sourceMessageId,
          sourceMessageIds: _sourceMessageIds,
          provenance: _provenance,
          ...additional_kwargs
        } = serialized.data.additional_kwargs;
        const { response_metadata: _responseMetadata, ...data } = serialized.data;
        return { ...serialized, data: { ...data, additional_kwargs } };
      });
    expect(providerShape(derived.messages)).toEqual(providerShape(legacyProjection.messages));
    expect(derived.compactionSemanticIndex).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'tool_intent', text: 'Locate the cache implementation' }),
        expect.objectContaining({
          type: 'tool_outcome',
          text: 'Located the cache implementation',
        }),
        expect.objectContaining({ type: 'reasoning_label', text: 'Checking cache ownership' }),
        expect.objectContaining({ type: 'activity_phase', text: 'Mapped the cache request path' }),
      ]),
    );
  });

  it('evolves a persisted semantic snapshot from only the warm payload', () => {
    const { formatAgentMessages } = jest.requireActual('@librechat/agents');
    const baseEntry = {
      type: 'activity_phase',
      sourceMessageId: 'assistant-history',
      sourceContentIndex: 1,
      revision: 1,
      status: 'committed',
      text: 'Verified the release state',
    };
    const baseSnapshot = { entries: [baseEntry], providedEntryCount: 7 };
    const payload = [
      {
        role: 'assistant',
        messageId: 'assistant-event',
        content: [
          {
            type: ContentTypes.ACTIVITY_LABEL,
            activity_label: 'Applied the warm event',
            activity_label_type: 'phase',
            activity_start_index: 0,
            pending: false,
          },
          { type: ContentTypes.TEXT, text: 'The warm event completed.' },
        ],
      },
    ];

    const baseline = formatAgentMessages(payload);
    const evolved = formatAgentMessages(payload, undefined, undefined, undefined, {
      compactionSemanticIndex: { baseSnapshot },
    });

    expect(evolved.messages.map((message) => message.toDict())).toEqual(
      baseline.messages.map((message) => message.toDict()),
    );
    expect(evolved.compactionSemanticIndexSnapshot).toEqual({
      entries: expect.arrayContaining([
        baseEntry,
        expect.objectContaining({
          type: 'activity_phase',
          sourceMessageId: 'assistant-event',
          text: 'Applied the warm event',
        }),
      ]),
      providedEntryCount: 8,
    });
  });

  it('propagates final model callback policy errors instead of persisting a generic error part', async () => {
    jest.clearAllMocks();
    let policyError;
    try {
      require('@librechat/api').assertModelBoundContent({
        filters: {
          messages: {
            pii: {
              fields: ['text'],
              starterPatterns: [],
              customPatterns: [{ id: 'private', label: 'private value', regex: 'PRIVATE-BLOCK' }],
            },
          },
        },
        storedMessages: [{ role: 'user', isCreatedByUser: true, text: 'PRIVATE-BLOCK' }],
      });
    } catch (error) {
      policyError = error;
    }
    expect(policyError).toEqual(expect.objectContaining({ code: 'content_filter_block' }));

    const processStream = jest.fn().mockRejectedValue(policyError);
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-policy',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-policy';
    client.responseMessageId = 'response-policy';
    client.parentMessageId = 'parent-policy';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await expect(client.chatCompletion({ payload: [] })).rejects.toBe(policyError);
    expect(client.contentParts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: ContentTypes.ERROR })]),
    );
  });

  it('ends a step-limit turn as incomplete rather than as an error part', async () => {
    jest.clearAllMocks();
    const { GraphRecursionError } = require('@langchain/langgraph');
    /** The exact error LangGraph throws once the graph runs out of supersteps. */
    const stepLimitError = new GraphRecursionError(
      'Recursion limit of 50 reached without hitting a stop condition.',
      { lc_error_code: 'GRAPH_RECURSION_LIMIT' },
    );

    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn().mockRejectedValue(stepLimitError),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-step-limit',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      /** Work the turn already produced; it must survive the boundary. */
      contentParts: [{ type: ContentTypes.TEXT, [ContentTypes.TEXT]: 'Partial findings' }],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-step-limit';
    client.responseMessageId = 'response-step-limit';
    client.parentMessageId = 'parent-step-limit';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(client.stepLimitReached).toBe(true);
    expect(client.contentParts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: ContentTypes.ERROR })]),
    );
    expect(client.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ [ContentTypes.TEXT]: 'Partial findings' }),
      ]),
    );
  });

  it('still surfaces an error part for an ordinary run failure', async () => {
    jest.clearAllMocks();
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn().mockRejectedValue(new Error('provider exploded')),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-plain-error',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-plain-error';
    client.responseMessageId = 'response-plain-error';
    client.parentMessageId = 'parent-plain-error';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(client.stepLimitReached).toBe(false);
    expect(client.contentParts).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: ContentTypes.ERROR })]),
    );
  });

  it('records collected usage as an abort when the run is stopped', async () => {
    jest.clearAllMocks();
    const abortController = new AbortController();
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn(async () => {
        abortController.abort();
      }),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-stopped',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [{ input_tokens: 10, output_tokens: 5 }],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-stopped';
    client.responseMessageId = 'response-conversation-stopped';
    client.parentMessageId = 'parent-conversation-stopped';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [], abortController });

    expect(client.recordCollectedUsage).toHaveBeenCalledTimes(1);
    expect(client.recordCollectedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'abort' }),
    );
  });

  it('records collected usage as a message when the run completes', async () => {
    jest.clearAllMocks();
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn().mockResolvedValue(),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-completed',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [{ input_tokens: 10, output_tokens: 5 }],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-completed';
    client.responseMessageId = 'response-conversation-completed';
    client.parentMessageId = 'parent-conversation-completed';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [], abortController: new AbortController() });

    expect(client.recordCollectedUsage).toHaveBeenCalledTimes(1);
    expect(client.recordCollectedUsage).toHaveBeenCalledWith(
      expect.objectContaining({ context: 'message' }),
    );
  });

  it('classifies a terminal chat-model failure without logging provider content', async () => {
    jest.clearAllMocks();
    const { logger } = require('@librechat/data-schemas');
    const { traceIdForMessage } = require('@librechat/api');
    const privateValue = 'PRIVATE-UPSTREAM-PROVIDER-CONTENT';
    const providerError = Object.assign(new Error(), {
      code: 'InternalServerException',
      response: {
        status: 500,
        headers: { authorization: privateValue },
        data: { prompt: privateValue },
      },
    });
    Object.defineProperties(providerError, {
      name: {
        get() {
          throw new Error(`Provider echoed ${privateValue}`);
        },
      },
      message: {
        get() {
          throw new Error(`Provider echoed ${privateValue}`);
        },
      },
    });
    const abortController = new AbortController();
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    mockCreateRun.mockImplementation(async (options) => {
      const tracker = options.modelCallbacks.find(
        (callback) => callback.name === 'librechat-upstream-model-error-tracker',
      );
      return {
        Graph: null,
        processStream: jest.fn(async () => {
          tracker.handleLLMError(providerError, 'model-run');
          abortController.abort();
          throw providerError;
        }),
        getCalibrationRatio: jest.fn(() => 0),
      };
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: { [EModelEndpoint.agents]: {} },
          filters: { messages: { pii: {} } },
        },
        _resumableStreamId: 'conversation-upstream-error',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-upstream-error';
    client.responseMessageId = 'response-upstream-error';
    client.parentMessageId = 'parent-upstream-error';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [], abortController });

    expect(errorSpy).toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #sendCompletion] Upstream model error',
      {
        type: 'Error',
        status: 500,
        errorCode: 'UPSTREAM_MODEL_ERROR',
        errorOrigin: 'model_provider',
        errorType: '500',
        traceId: traceIdForMessage('response-upstream-error'),
      },
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateValue);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('InternalServerException');
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error',
      expect.anything(),
    );
    expect(client.contentParts).toContainEqual({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]:
        'The model provider could not complete this request.\n' +
        JSON.stringify({ type: 'upstream_model_error', status: 500 }),
    });
    errorSpy.mockRestore();
  });

  /** A compaction's only record of having been one is the marker on the part it
   *  produced, and Compact runs on whatever leaf the branch ends with. Without
   *  the marker on the failure, a compaction that failed on a user leaf keeps a
   *  Regenerate that answers that user message instead of redoing the run. */
  it('marks the failure a compaction turn persists instead of a summary', async () => {
    jest.clearAllMocks();
    mockCreateRun.mockImplementation(async () => ({
      Graph: null,
      processStream: jest.fn(async () => {
        throw new Error('summarizer unavailable');
      }),
      getCalibrationRatio: jest.fn(() => 0),
    }));
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { compact: true },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-compaction-failure',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-compaction-failure';
    client.responseMessageId = 'response-compaction-failure';
    client.parentMessageId = 'parent-compaction-failure';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    const { completion } = await client.sendCompletion([]);

    expect(completion).toEqual([
      expect.objectContaining({ type: ContentTypes.ERROR, initiatedBy: 'user' }),
    ]);
  });

  /** A summarizer that returns nothing emits no content at all, so the run has
   *  neither a summary nor an explanation. The turn records the typed failure
   *  itself instead of being saved as a bare error row the client cannot tell
   *  apart from an answer to the message it hangs off. */
  it('records a marked typed failure when a compaction run produces nothing', async () => {
    jest.clearAllMocks();
    mockCreateRun.mockImplementation(async () => ({
      Graph: null,
      processStream: jest.fn(async () => {}),
      getCalibrationRatio: jest.fn(() => 0),
    }));
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { compact: true },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-compaction-empty',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-compaction-empty';
    client.responseMessageId = 'response-compaction-empty';
    client.parentMessageId = 'parent-compaction-empty';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    const { completion } = await client.sendCompletion([]);

    expect(completion).toEqual([
      {
        type: ContentTypes.ERROR,
        error: JSON.stringify({ type: ErrorTypes.COMPACTION_FAILED }),
        initiatedBy: 'user',
      },
    ]);
  });

  it('keeps a later non-provider run failure on the generic error path', async () => {
    jest.clearAllMocks();
    const { logger } = require('@librechat/data-schemas');
    const recoveredProviderError = new Error('recovered provider failure');
    const checkpointError = new Error('checkpoint failed');
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    mockCreateRun.mockImplementation(async (options) => {
      const tracker = options.modelCallbacks.find(
        (callback) => callback.name === 'librechat-upstream-model-error-tracker',
      );
      return {
        Graph: null,
        processStream: jest.fn(async () => {
          tracker.handleLLMError(recoveredProviderError, 'recovered-model-run');
          throw checkpointError;
        }),
        getCalibrationRatio: jest.fn(() => 0),
      };
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-non-provider-error',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-non-provider-error';
    client.responseMessageId = 'response-non-provider-error';
    client.parentMessageId = 'parent-non-provider-error';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(errorSpy).toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error',
      { type: 'Error' },
    );
    expect(errorSpy).not.toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #sendCompletion] Upstream model error',
      expect.anything(),
    );
    errorSpy.mockRestore();
  });

  it('cancels current attachment persistence after combined admission rejects the run', async () => {
    jest.clearAllMocks();
    let attachmentLimitError;
    try {
      require('@librechat/api').assertAgentAttachmentLimits({
        attachments: [{ file_id: 'too-large', bytes: 2_000_000 }],
        fileConfig: { fileContextSizeLimit: 1 },
      });
    } catch (error) {
      attachmentLimitError = error;
    }
    expect(attachmentLimitError).toEqual(
      expect.objectContaining({ code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED' }),
    );
    expect(require('@librechat/api').isAgentAttachmentLimitError(attachmentLimitError)).toBe(true);
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn().mockRejectedValue(attachmentLimitError),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const currentFile = { file_id: 'rejected-current', bytes: 600_000 };
    const cancel = jest.fn();
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { files: [{ file_id: currentFile.file_id }] },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-attachment-limit',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      attachments: [currentFile],
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-attachment-limit';
    client.responseMessageId = 'response-attachment-limit';
    client.parentMessageId = 'parent-attachment-limit';
    client.modelBoundCurrentFiles = [currentFile];
    client.modelBoundUserMessagePersistence = {
      cancel,
      isPending: jest.fn(() => true),
      start: jest.fn(),
    };
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.options.attachments).toEqual([]);
    expect(client.modelBoundCurrentFiles).toEqual([]);
    expect(client.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: expect.stringContaining('total attachment size'),
        }),
      ]),
    );
  });

  it('cancels current attachment persistence when its storage object is unavailable', async () => {
    jest.clearAllMocks();
    const attachmentError = new (require('@librechat/api').AttachmentObjectNotFoundError)(
      'missing-current',
    );
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream: jest.fn().mockRejectedValue(attachmentError),
      getCalibrationRatio: jest.fn(() => 0),
    });
    mockIsHITLEnabled.mockReturnValue(false);
    const currentFile = { file_id: 'missing-current', bytes: 600_000 };
    const cancel = jest.fn();
    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: { files: [{ file_id: currentFile.file_id }] },
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-missing-attachment',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
      },
      attachments: [currentFile],
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-missing-attachment';
    client.responseMessageId = 'response-missing-attachment';
    client.parentMessageId = 'parent-missing-attachment';
    client.modelBoundCurrentFiles = [currentFile];
    client.modelBoundUserMessagePersistence = {
      cancel,
      isPending: jest.fn(() => true),
      start: jest.fn(),
    };
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(client.options.attachments).toEqual([]);
    expect(client.modelBoundCurrentFiles).toEqual([]);
    expect(client.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: expect.stringContaining('no longer available'),
        }),
      ]),
    );
  });

  it('evolves warm compaction guidance while injecting only the new event message', async () => {
    jest.clearAllMocks();
    const history = { _getType: () => 'human', content: 'old turn' };
    const currentEvent = { _getType: () => 'human', content: 'new event' };
    const baseCompactionSemanticIndexSnapshot = {
      entries: [
        {
          type: 'activity_phase',
          sourceMessageId: 'assistant-history',
          sourceContentIndex: 1,
          revision: 1,
          status: 'committed',
          text: 'Verified the release state',
        },
      ],
      providedEntryCount: 1,
    };
    const evolvedCompactionSemanticIndexSnapshot = {
      entries: [
        ...baseCompactionSemanticIndexSnapshot.entries,
        {
          type: 'activity_phase',
          sourceMessageId: 'assistant-event',
          sourceContentIndex: 0,
          revision: 1,
          status: 'committed',
          text: 'Applied the warm event',
        },
      ],
      providedEntryCount: 2,
    };
    mockFormatAgentMessages.mockReturnValueOnce({
      messages: [history, currentEvent],
      indexTokenCountMap: { 0: 11, 1: 22 },
      summary: undefined,
      boundaryTokenAdjustment: undefined,
      compactionSemanticIndexSnapshot: evolvedCompactionSemanticIndexSnapshot,
    });
    let client;
    const processStream = jest.fn(async () => {
      client.contentParts.push(
        {
          type: ContentTypes.SUMMARY,
          content: [{ type: ContentTypes.TEXT, text: 'Fresh compacted context.' }],
          tokenCount: 18,
          boundary: { messageId: 'step_summary', contentIndex: 0 },
        },
        { type: ContentTypes.TEXT, text: 'Done.' },
      );
    });
    mockCreateRun.mockResolvedValue({
      Graph: null,
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
    });
    client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: { endpoints: { [EModelEndpoint.agents]: {} } },
        _resumableStreamId: 'conversation-123',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: true,
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-123';
    client.responseMessageId = 'response-123';
    client.parentMessageId = 'parent-123';
    client.checkpointNamespace = 'event-actor/fork';
    client.eventActorCheckpointId = 'checkpoint-base';
    client.eventActorInvocationId = 'event-2';
    client.eventActorContinuation = 'warm';
    client.eventActorDiscoveredToolNames = ['deferred_tool'];
    client.eventActorSummary = { text: 'summary of earlier turns', tokenCount: 40 };
    client.contextMeta = {
      calibrationRatio: 1.25,
      encoding: client.getEncoding(),
      fading: { v: 2, budgetTokens: 20_000, masked: true },
      fadingTiers: [
        { agentId: 'agent-123', v: 2, budgetTokens: 20_000, masked: true },
        { agentId: 'agent-worker', v: 1, budgetTokens: 8_000, masked: false },
      ],
    };
    client.compactionSemanticIndexSnapshot = baseCompactionSemanticIndexSnapshot;
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(mockCreateRun).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: [history, currentEvent],
        discoveredToolNames: ['deferred_tool'],
        eventActorCheckpointing: true,
        /** The DB-derived token map is positional over full history, which a
         * checkpoint-restored graph state no longer matches. It must be blank
         * so the pruner recounts against the messages actually in state. The
         * cross-run summary stays: it summarizes pre-boundary turns that were
         * excluded from the history the committed checkpoint was built from. */
        indexTokenCountMap: {},
        initialSummary: { text: 'summary of earlier turns', tokenCount: 40 },
        calibrationRatio: 1.25,
        fadingTier: { v: 2, budgetTokens: 20_000, masked: true },
        fadingTiers: {
          'agent-123': { v: 2, budgetTokens: 20_000, masked: true },
        },
        compactionSemanticIndex: evolvedCompactionSemanticIndexSnapshot.entries,
      }),
    );
    /** The seeded map must be prototype-safe: a null-prototype record built from own keys. */
    const seededTiers = mockCreateRun.mock.calls.at(-1)[0].fadingTiers;
    expect(Object.getPrototypeOf(seededTiers)).toBeNull();
    expect(mockFormatAgentMessages.mock.calls[0][4]).toEqual(
      expect.objectContaining({
        compactionSemanticIndex: expect.objectContaining({
          baseSnapshot: baseCompactionSemanticIndexSnapshot,
        }),
      }),
    );
    expect(mockFormatAgentMessages).toHaveBeenCalledTimes(1);
    expect(mockStripActivityLabelParts).not.toHaveBeenCalled();
    expect(client.compactionSemanticIndexSnapshot).toBe(evolvedCompactionSemanticIndexSnapshot);
    expect(processStream).toHaveBeenCalledWith(
      { messages: [currentEvent] },
      expect.objectContaining({
        configurable: expect.objectContaining({
          thread_id: 'conversation-123',
          checkpoint_id: 'checkpoint-base',
          __librechat_checkpoint_ns: 'event-actor/fork',
          __librechat_event_actor_invocation_id: 'event-2',
          event_actor_invocation_id: 'event-2',
          event_actor_depth: 1,
        }),
      }),
      expect.anything(),
    );
    expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    expect(client.eventActorSummary).toEqual({
      text: 'Fresh compacted context.',
      tokenCount: 18,
      version: 1,
    });
    expect(client.contentParts).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: ContentTypes.SUMMARY })]),
    );
  });

  it('does not expose or process a fresh graph when strict checkpoint pruning fails', async () => {
    jest.clearAllMocks();
    const checkpointGeneration = {
      threadId: 'conversation-123',
      checkpointIds: ['legacy-root', 'legacy-child'],
    };
    const processStream = jest.fn().mockResolvedValue();
    const run = {
      Graph: { id: 'must-not-be-exposed' },
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
    };
    mockCreateRun.mockResolvedValue(run);
    mockIsHITLEnabled.mockReturnValue(true);
    mockCaptureAgentCheckpointGeneration.mockResolvedValue(checkpointGeneration);
    mockDeleteAgentCheckpoint.mockRejectedValue(new Error('checkpoint prune failed'));
    jest.spyOn(GenerationJobManager, 'getJobStore').mockReturnValue({
      getJob: jest.fn().mockResolvedValue({ createdAt: 1000, status: 'running' }),
    });

    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: { [EModelEndpoint.agents]: { toolApproval: { enabled: true } } },
        },
        _resumableStreamId: 'conversation-123',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
        tools: [{ name: 'write_file' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
      startupTelemetry: {
        mark: jest.fn(),
        setStreamId: jest.fn(),
        recordGenerationEvent: jest.fn(),
        end: jest.fn(),
      },
    });
    client.conversationId = 'conversation-123';
    client.jobCreatedAt = 1000;
    client.responseMessageId = 'response-123';
    client.parentMessageId = 'parent-123';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
      'conversation-123',
      undefined,
      checkpointGeneration,
      { throwOnError: true },
    );
    expect(processStream).not.toHaveBeenCalled();
    expect(client.run).not.toBe(run);
    expect(client.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          [ContentTypes.ERROR]: expect.stringContaining('checkpoint prune failed'),
        }),
      ]),
    );
  });

  it('does not let a stale v1 fresh prune delete a paused v2 replacement generation', async () => {
    jest.clearAllMocks();
    const checkpointGeneration = {
      threadId: 'conversation-123',
      checkpointIds: ['legacy-root', 'legacy-child'],
    };
    const processStream = jest.fn().mockResolvedValue();
    const run = {
      Graph: { id: 'stale-v1-graph' },
      processStream,
      getCalibrationRatio: jest.fn(() => 0),
    };
    mockCreateRun.mockResolvedValue(run);
    mockIsHITLEnabled.mockReturnValue(true);
    mockCaptureAgentCheckpointGeneration.mockResolvedValue(checkpointGeneration);
    const getJob = jest.fn().mockResolvedValue({
      createdAt: 2000,
      status: 'requires_action',
      checkpointNamespace: '2000',
    });
    jest.spyOn(GenerationJobManager, 'getJobStore').mockReturnValue({ getJob });

    const client = new AgentClient({
      req: {
        user: { id: 'user-123' },
        body: {},
        config: {
          endpoints: { [EModelEndpoint.agents]: { toolApproval: { enabled: true } } },
        },
        _resumableStreamId: 'conversation-123',
      },
      res: {},
      agent: {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
        hide_sequential_outputs: false,
        tools: [{ name: 'write_file' }],
      },
      endpointTokenConfig: {},
      eventHandlers: {},
      contentParts: [],
      collectedUsage: [],
      artifactPromises: [],
    });
    client.conversationId = 'conversation-123';
    client.jobCreatedAt = 1000;
    client.responseMessageId = 'response-123';
    client.parentMessageId = 'parent-123';
    client.recordCollectedUsage = jest.fn().mockResolvedValue();

    await client.chatCompletion({ payload: [] });

    expect(mockCaptureAgentCheckpointGeneration).toHaveBeenCalledWith(
      'conversation-123',
      undefined,
      { throwOnError: true },
    );
    expect(getJob).toHaveBeenCalledTimes(1);
    expect(mockDeleteAgentCheckpoint).not.toHaveBeenCalled();
    expect(processStream).not.toHaveBeenCalled();
    expect(client.run).not.toBe(run);
    expect(client.contentParts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          [ContentTypes.ERROR]: expect.stringContaining(
            'Generation replaced before legacy checkpoint cleanup',
          ),
        }),
      ]),
    );
  });
});

describe('AgentClient - titleConvo', () => {
  let client;
  let mockRun;
  let mockReq;
  let mockRes;
  let mockAgent;
  let mockOptions;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock run object
    mockRun = {
      generateTitle: jest.fn().mockResolvedValue({
        title: 'Generated Title',
      }),
    };

    // Mock agent - with both endpoint and provider
    mockAgent = {
      id: 'agent-123',
      endpoint: EModelEndpoint.openAI, // Use a valid provider as endpoint for getProviderConfig
      provider: EModelEndpoint.openAI, // Add provider property
      model_parameters: {
        model: 'gpt-4',
      },
    };

    // Mock request and response
    mockReq = {
      user: {
        id: 'user-123',
      },
      body: {
        model: 'gpt-4',
        endpoint: EModelEndpoint.openAI,
        key: null,
      },
      config: {
        endpoints: {
          [EModelEndpoint.openAI]: {
            // Match the agent endpoint
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      },
    };

    mockRes = {};

    // Mock options
    mockOptions = {
      req: mockReq,
      res: mockRes,
      agent: mockAgent,
      endpointTokenConfig: {},
    };

    // Create client instance
    client = new AgentClient(mockOptions);
    client.run = mockRun;
    client.responseMessageId = 'response-123';
    client.conversationId = 'convo-123';
    client.contentParts = [{ type: 'text', text: 'Test content' }];
    client.recordCollectedUsage = jest.fn().mockResolvedValue(); // Mock as async function that resolves
  });

  describe('titleConvo method', () => {
    it('should throw error if run is not initialized', async () => {
      client.run = null;

      await expect(
        client.titleConvo({ text: 'Test', abortController: new AbortController() }),
      ).rejects.toThrow('Run not initialized');
    });

    it('waits for the run in immediate mode instead of throwing', async () => {
      client.run = null;
      const abortController = new AbortController();

      const titlePromise = client.titleConvo({ text: 'Test', abortController, immediate: true });

      // Simulate `chatCompletion` assigning the run (client.js: `this.run = run`).
      client.run = mockRun;
      client._resolveRun(mockRun);

      await titlePromise;
      expect(mockRun.generateTitle).toHaveBeenCalled();
    });

    it('passes empty contentParts in immediate mode (title from the user input only)', async () => {
      client.contentParts = [{ type: 'text', text: 'Streaming response so far' }];
      const abortController = new AbortController();

      await client.titleConvo({ text: 'Hello there', abortController, immediate: true });

      const call = mockRun.generateTitle.mock.calls[0][0];
      expect(call.contentParts).toEqual([]);
      expect(call.inputText).toBe('Hello there');
    });

    it('uses live contentParts in non-immediate (final) mode', async () => {
      client.contentParts = [{ type: 'text', text: 'Full response' }];
      const abortController = new AbortController();

      await client.titleConvo({ text: 'Hello there', abortController });

      const call = mockRun.generateTitle.mock.calls[0][0];
      expect(call.contentParts).toEqual([{ type: 'text', text: 'Full response' }]);
    });

    it('rejects promptly when aborted before the run initializes in immediate mode', async () => {
      client.run = null;
      const abortController = new AbortController();
      abortController.abort();

      await expect(
        client.titleConvo({ text: 'Test', abortController, immediate: true }),
      ).rejects.toThrow('Aborted before run initialization');
      expect(mockRun.generateTitle).not.toHaveBeenCalled();
    });

    it('should use titlePrompt from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePrompt: 'Custom title prompt',
        }),
      );
    });

    it('should use titlePromptTemplate from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePromptTemplate: 'Template: {{content}}',
        }),
      );
    });

    it('should use titleMethod from endpoint config', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: Providers.OPENAI,
          titleMethod: 'structured',
        }),
      );
    });

    it('should use titleModel from endpoint config when provided', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Check that generateTitle was called with correct clientOptions
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-3.5-turbo');
    });

    it('preserves Anthropic custom headers on title requests despite omitTitleOptions', async () => {
      const prevKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
      try {
        const req = {
          user: { id: 'user-123' },
          body: { model: 'claude-sonnet-4-5', endpoint: EModelEndpoint.anthropic, key: null },
          config: {
            endpoints: {
              [EModelEndpoint.anthropic]: {
                headers: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
              },
            },
          },
        };
        const agent = {
          id: 'agent-anthropic',
          endpoint: EModelEndpoint.anthropic,
          provider: EModelEndpoint.anthropic,
          model_parameters: { model: 'claude-sonnet-4-5' },
        };
        const anthropicClient = new AgentClient({ req, res: {}, agent, endpointTokenConfig: {} });
        anthropicClient.run = mockRun;
        anthropicClient.responseMessageId = 'response-123';
        anthropicClient.conversationId = 'convo-123';
        anthropicClient.contentParts = [{ type: 'text', text: 'Test content' }];
        anthropicClient.recordCollectedUsage = jest.fn().mockResolvedValue();

        await anthropicClient.titleConvo({ text: 'Hello', abortController: new AbortController() });

        const defaultHeaders =
          mockRun.generateTitle.mock.calls[0][0].clientOptions?.clientOptions?.defaultHeaders;
        // Custom header survives the `omitTitleOptions` strip and resolves the conversationId
        expect(defaultHeaders?.['X-Conversation-Id']).toBe('convo-123');
        // Provider-managed beta header is preserved alongside it
        expect(defaultHeaders?.['anthropic-beta']).toBeDefined();
      } finally {
        if (prevKey === undefined) {
          delete process.env.ANTHROPIC_API_KEY;
        } else {
          process.env.ANTHROPIC_API_KEY = prevKey;
        }
      }
    });

    it('should handle missing endpoint config gracefully', async () => {
      // Remove endpoint config
      mockReq.config = { endpoints: {} };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titlePrompt: undefined,
          titlePromptTemplate: undefined,
          titleMethod: undefined,
        }),
      );
    });

    it('should use agent model when titleModel is not provided', async () => {
      // Remove titleModel from config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
            // titleModel is omitted
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4'); // Should use agent's model
    });

    it('should not use titleModel when it equals CURRENT_MODEL constant', async () => {
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: Constants.CURRENT_MODEL,
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4'); // Should use agent's model
    });

    it('should pass all required parameters to generateTitle', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(mockRun.generateTitle).toHaveBeenCalledWith({
        provider: expect.any(String),
        inputText: text,
        contentParts: client.contentParts,
        clientOptions: expect.objectContaining({
          model: 'gpt-3.5-turbo',
        }),
        titlePrompt: 'Custom title prompt',
        titlePromptTemplate: 'Template: {{content}}',
        titleMethod: 'structured',
        chainOptions: expect.objectContaining({
          signal: abortController.signal,
        }),
      });
    });

    it('should record collected usage after title generation', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      expect(client.recordCollectedUsage).toHaveBeenCalledWith({
        model: 'gpt-3.5-turbo',
        context: 'title',
        collectedUsage: expect.any(Array),
        balance: {
          enabled: false,
        },
        transactions: {
          enabled: true,
        },
        messageId: 'response-123',
      });
    });

    it('should return the generated title', async () => {
      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      expect(result).toBe('Generated Title');
    });

    it('should sanitize the generated title by removing think blocks', async () => {
      const titleWithThinkBlock = '<think>reasoning about the title</think> User Hi Greeting';
      mockRun.generateTitle.mockResolvedValue({
        title: titleWithThinkBlock,
      });

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should remove the <think> block and return only the clean title
      expect(result).toBe('User Hi Greeting');
      expect(result).not.toContain('<think>');
      expect(result).not.toContain('</think>');
    });

    it('should return fallback title when sanitization results in empty string', async () => {
      const titleOnlyThinkBlock = '<think>only reasoning no actual title</think>';
      mockRun.generateTitle.mockResolvedValue({
        title: titleOnlyThinkBlock,
      });

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return the fallback title since sanitization would result in empty string
      expect(result).toBe('Untitled Conversation');
    });

    it('does not log provider error content when title generation fails', async () => {
      const { logger } = require('@librechat/data-schemas');
      const privateValue = 'PRIVATE-TITLE-PROMPT';
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      mockRun.generateTitle.mockRejectedValue(
        Object.assign(new Error(`Provider echoed ${privateValue}`), {
          code: 'ERR_REMOTE',
          response: { status: 422, data: { prompt: privateValue } },
        }),
      );

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      expect(result).toBeUndefined();
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateValue);
      expect(errorSpy).toHaveBeenCalledWith(
        '[api/server/controllers/agents/client.js #titleConvo] Error',
        expect.objectContaining({ type: 'Error' }),
      );
      errorSpy.mockRestore();
    });

    it('should skip title generation when titleConvo is set to false', async () => {
      // Set titleConvo to false in endpoint config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleConvo: false,
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Custom title prompt',
            titleMethod: 'structured',
            titlePromptTemplate: 'Template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation for temporary chats', async () => {
      // Set isTemporary to true
      mockReq.body.isTemporary = true;

      const text = 'Test temporary chat';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation when titleConvo is false in all config', async () => {
      // Set titleConvo to false in "all" config
      mockReq.config = {
        endpoints: {
          all: {
            titleConvo: false,
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should skip title generation when titleConvo is false for custom endpoint scenario', async () => {
      // This test validates the behavior when customEndpointConfig (retrieved via
      // getProviderConfig for custom endpoints) has titleConvo: false.
      //
      // The code path is:
      // 1. endpoints?.all is checked (undefined in this test)
      // 2. endpoints?.[endpoint] is checked (our test config)
      // 3. Would fall back to titleProviderConfig.customEndpointConfig (for real custom endpoints)
      //
      // We simulate a custom endpoint scenario using a dynamically named endpoint config

      // Create a unique endpoint name that represents a custom endpoint
      const customEndpointName = 'customEndpoint';

      // Configure the endpoint to have titleConvo: false
      // This simulates what would be in customEndpointConfig for a real custom endpoint
      mockReq.config = {
        endpoints: {
          // No 'all' config - so it will check endpoints[endpoint]
          // This config represents what customEndpointConfig would contain
          [customEndpointName]: {
            titleConvo: false,
            titleModel: 'custom-model-v1',
            titlePrompt: 'Custom endpoint title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'Custom template: {{content}}',
            baseURL: 'https://api.custom-llm.com/v1',
            apiKey: 'test-custom-key',
            // Additional custom endpoint properties
            models: {
              default: ['custom-model-v1', 'custom-model-v2'],
            },
          },
        },
      };

      // Set up agent to use our custom endpoint
      // Use openAI as base but override with custom endpoint name for this test
      mockAgent.endpoint = EModelEndpoint.openAI;
      mockAgent.provider = EModelEndpoint.openAI;

      // Override the endpoint in the config to point to our custom config
      mockReq.config.endpoints[EModelEndpoint.openAI] =
        mockReq.config.endpoints[customEndpointName];
      delete mockReq.config.endpoints[customEndpointName];

      const text = 'Test custom endpoint conversation';
      const abortController = new AbortController();

      const result = await client.titleConvo({ text, abortController });

      // Should return undefined without generating title because titleConvo is false
      expect(result).toBeUndefined();

      // generateTitle should NOT have been called
      expect(mockRun.generateTitle).not.toHaveBeenCalled();

      // recordCollectedUsage should NOT have been called
      expect(client.recordCollectedUsage).not.toHaveBeenCalled();
    });

    it('should pass titleEndpoint configuration to generateTitle', async () => {
      // Mock the API key just for this test
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-api-key';

      // Add titleEndpoint to the config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: 'gpt-3.5-turbo',
            titleEndpoint: EModelEndpoint.anthropic,
            titleMethod: 'structured',
            titlePrompt: 'Custom title prompt',
            titlePromptTemplate: 'Custom template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify generateTitle was called with the custom configuration
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'structured',
          provider: Providers.ANTHROPIC,
          titlePrompt: 'Custom title prompt',
          titlePromptTemplate: 'Custom template',
        }),
      );

      // Restore the original API key
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('should use all config when endpoint config is missing', async () => {
      // Set 'all' config without endpoint-specific config
      mockReq.config = {
        endpoints: {
          all: {
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template: {{content}}',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify generateTitle was called with 'all' config values
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'completion',
          titlePrompt: 'All config title prompt',
          titlePromptTemplate: 'All config template: {{content}}',
        }),
      );

      // Check that the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
    });

    it('should prioritize all config over endpoint config for title settings', async () => {
      // Set both endpoint and 'all' config
      mockReq.config = {
        endpoints: {
          [EModelEndpoint.openAI]: {
            titleModel: 'gpt-3.5-turbo',
            titlePrompt: 'Endpoint title prompt',
            titleMethod: 'structured',
            // titlePromptTemplate is omitted to test fallback
          },
          all: {
            titleModel: 'gpt-4o-mini',
            titlePrompt: 'All config title prompt',
            titleMethod: 'completion',
            titlePromptTemplate: 'All config template',
          },
        },
      };

      const text = 'Test conversation text';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify 'all' config takes precedence over endpoint config
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          titleMethod: 'completion',
          titlePrompt: 'All config title prompt',
          titlePromptTemplate: 'All config template',
        }),
      );

      // Check that the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
    });

    it('should use all config with titleEndpoint and verify provider switch', async () => {
      // Mock the API key for the titleEndpoint provider
      const originalApiKey = process.env.ANTHROPIC_API_KEY;
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

      // Set comprehensive 'all' config with all new title options
      mockReq.config = {
        endpoints: {
          all: {
            titleConvo: true,
            titleModel: 'claude-3-haiku-20240307',
            titleMethod: 'completion', // Testing the new default method
            titlePrompt: 'Generate a concise, descriptive title for this conversation',
            titlePromptTemplate: 'Conversation summary: {{content}}',
            titleEndpoint: EModelEndpoint.anthropic, // Should switch provider to Anthropic
          },
        },
      };

      const text = 'Test conversation about AI and machine learning';
      const abortController = new AbortController();

      await client.titleConvo({ text, abortController });

      // Verify all config values were used
      expect(mockRun.generateTitle).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: Providers.ANTHROPIC, // Critical: Verify provider switched to Anthropic
          titleMethod: 'completion',
          titlePrompt: 'Generate a concise, descriptive title for this conversation',
          titlePromptTemplate: 'Conversation summary: {{content}}',
          inputText: text,
          contentParts: client.contentParts,
        }),
      );

      // Verify the model was set from 'all' config
      const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
      expect(generateTitleCall.clientOptions.model).toBe('claude-3-haiku-20240307');

      // Verify other client options are set correctly
      expect(generateTitleCall.clientOptions).toMatchObject({
        model: 'claude-3-haiku-20240307',
        // Note: Anthropic's getOptions may set its own maxTokens value
      });

      // Restore the original API key
      if (originalApiKey) {
        process.env.ANTHROPIC_API_KEY = originalApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    });

    it('should test all titleMethod options from all config', async () => {
      // Test each titleMethod: 'completion', 'functions', 'structured'
      const titleMethods = ['completion', 'functions', 'structured'];

      for (const method of titleMethods) {
        // Clear previous calls
        mockRun.generateTitle.mockClear();

        // Set 'all' config with specific titleMethod
        mockReq.config = {
          endpoints: {
            all: {
              titleModel: 'gpt-4o-mini',
              titleMethod: method,
              titlePrompt: `Testing ${method} method`,
              titlePromptTemplate: `Template for ${method}: {{content}}`,
            },
          },
        };

        const text = `Test conversation for ${method} method`;
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify the correct titleMethod was used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            titleMethod: method,
            titlePrompt: `Testing ${method} method`,
            titlePromptTemplate: `Template for ${method}: {{content}}`,
          }),
        );
      }
    });

    describe('Azure-specific title generation', () => {
      let originalEnv;

      beforeEach(() => {
        // Reset mocks
        jest.clearAllMocks();

        // Save original environment variables
        originalEnv = { ...process.env };

        // Mock Azure API keys
        process.env.AZURE_OPENAI_API_KEY = 'test-azure-key';
        process.env.AZURE_API_KEY = 'test-azure-key';
        process.env.EASTUS_API_KEY = 'test-eastus-key';
        process.env.EASTUS2_API_KEY = 'test-eastus2-key';
      });

      afterEach(() => {
        // Restore environment variables
        process.env = originalEnv;
      });

      it('should use OPENAI provider for Azure serverless endpoints', async () => {
        // Set up Azure endpoint with serverless config
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'grok-3',
              titleMethod: 'completion',
              titlePrompt: 'Azure serverless title prompt',
              streamRate: 35,
              modelGroupMap: {
                'grok-3': {
                  group: 'Azure AI Foundry',
                  deploymentName: 'grok-3',
                },
              },
              groupMap: {
                'Azure AI Foundry': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://test.services.ai.azure.com/models',
                  version: '2024-05-01-preview',
                  serverless: true,
                  models: {
                    'grok-3': {
                      deploymentName: 'grok-3',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'grok-3';

        const text = 'Test Azure serverless conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify provider was switched to OPENAI for serverless
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.OPENAI, // Should be OPENAI for serverless
            titleMethod: 'completion',
            titlePrompt: 'Azure serverless title prompt',
          }),
        );
      });

      it('should use AZURE provider for Azure endpoints with instanceName', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'gpt-4o',
              titleMethod: 'structured',
              titlePrompt: 'Azure instance title prompt',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o': {
                  group: 'eastus',
                  deploymentName: 'gpt-4o',
                },
              },
              groupMap: {
                eastus: {
                  apiKey: '${EASTUS_API_KEY}',
                  instanceName: 'region-instance',
                  version: '2024-02-15-preview',
                  models: {
                    'gpt-4o': {
                      deploymentName: 'gpt-4o',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4o';

        const text = 'Test Azure instance conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify provider remains AZURE with instanceName
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.AZURE,
            titleMethod: 'structured',
            titlePrompt: 'Azure instance title prompt',
          }),
        );
      });

      it('should handle Azure titleModel with CURRENT_MODEL constant', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockAgent.model_parameters.model = 'gpt-4o-latest';
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: Constants.CURRENT_MODEL,
              titleMethod: 'functions',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o-latest': {
                  group: 'region-eastus',
                  deploymentName: 'gpt-4o-mini',
                  version: '2024-02-15-preview',
                },
              },
              groupMap: {
                'region-eastus': {
                  apiKey: '${EASTUS2_API_KEY}',
                  instanceName: 'test-instance',
                  version: '2024-12-01-preview',
                  models: {
                    'gpt-4o-latest': {
                      deploymentName: 'gpt-4o-mini',
                      version: '2024-02-15-preview',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4o-latest';

        const text = 'Test Azure current model';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify it uses the correct model when titleModel is CURRENT_MODEL
        const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
        // When CURRENT_MODEL is used with Azure, the model gets mapped to the deployment name
        // In this case, 'gpt-4o-latest' is mapped to 'gpt-4o-mini' deployment
        expect(generateTitleCall.clientOptions.model).toBe('gpt-4o-mini');
        // Also verify that CURRENT_MODEL constant was not passed as the model
        expect(generateTitleCall.clientOptions.model).not.toBe(Constants.CURRENT_MODEL);
      });

      it('should handle Azure with multiple model groups', async () => {
        // Set up Azure endpoint
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.config = {
          endpoints: {
            [EModelEndpoint.azureOpenAI]: {
              titleConvo: true,
              titleModel: 'o1-mini',
              titleMethod: 'completion',
              streamRate: 35,
              modelGroupMap: {
                'gpt-4o': {
                  group: 'eastus',
                  deploymentName: 'gpt-4o',
                },
                'o1-mini': {
                  group: 'region-eastus',
                  deploymentName: 'o1-mini',
                },
                'codex-mini': {
                  group: 'codex-mini',
                  deploymentName: 'codex-mini',
                },
              },
              groupMap: {
                eastus: {
                  apiKey: '${EASTUS_API_KEY}',
                  instanceName: 'region-eastus',
                  version: '2024-02-15-preview',
                  models: {
                    'gpt-4o': {
                      deploymentName: 'gpt-4o',
                    },
                  },
                },
                'region-eastus': {
                  apiKey: '${EASTUS2_API_KEY}',
                  instanceName: 'region-eastus2',
                  version: '2024-12-01-preview',
                  models: {
                    'o1-mini': {
                      deploymentName: 'o1-mini',
                    },
                  },
                },
                'codex-mini': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://example.cognitiveservices.azure.com/openai/',
                  version: '2025-04-01-preview',
                  serverless: true,
                  models: {
                    'codex-mini': {
                      deploymentName: 'codex-mini',
                    },
                  },
                },
              },
            },
          },
        };
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'o1-mini';

        const text = 'Test Azure multi-group conversation';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify correct model and provider are used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.AZURE,
            titleMethod: 'completion',
          }),
        );

        const generateTitleCall = mockRun.generateTitle.mock.calls[0][0];
        expect(generateTitleCall.clientOptions.model).toBe('o1-mini');
        expect(generateTitleCall.clientOptions.maxTokens).toBeUndefined(); // o1 models shouldn't have maxTokens
      });

      it('should use all config as fallback for Azure endpoints', async () => {
        // Set up Azure endpoint with minimal config
        mockAgent.endpoint = EModelEndpoint.azureOpenAI;
        mockAgent.provider = EModelEndpoint.azureOpenAI;
        mockReq.body.endpoint = EModelEndpoint.azureOpenAI;
        mockReq.body.model = 'gpt-4';

        // Set 'all' config as fallback with a serverless Azure config
        mockReq.config = {
          endpoints: {
            all: {
              titleConvo: true,
              titleModel: 'gpt-4',
              titleMethod: 'structured',
              titlePrompt: 'Fallback title prompt from all config',
              titlePromptTemplate: 'Template: {{content}}',
              modelGroupMap: {
                'gpt-4': {
                  group: 'default-group',
                  deploymentName: 'gpt-4',
                },
              },
              groupMap: {
                'default-group': {
                  apiKey: '${AZURE_API_KEY}',
                  baseURL: 'https://default.openai.azure.com/',
                  version: '2024-02-15-preview',
                  serverless: true,
                  models: {
                    'gpt-4': {
                      deploymentName: 'gpt-4',
                    },
                  },
                },
              },
            },
          },
        };

        const text = 'Test Azure with all config fallback';
        const abortController = new AbortController();

        await client.titleConvo({ text, abortController });

        // Verify all config is used
        expect(mockRun.generateTitle).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: Providers.OPENAI, // Should be OPENAI when no instanceName
            titleMethod: 'structured',
            titlePrompt: 'Fallback title prompt from all config',
            titlePromptTemplate: 'Template: {{content}}',
          }),
        );
      });
    });
  });

  describe('getOptions method - GPT-5+ model handling', () => {
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: {
          model: 'gpt-5',
        },
      };

      mockReq = {
        app: {
          locals: {},
        },
        user: {
          id: 'user-123',
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      client = new AgentClient(mockOptions);
    });

    it('should move maxTokens to modelKwargs.max_completion_tokens for GPT-5 models', () => {
      const clientOptions = {
        model: 'gpt-5',
        maxTokens: 2048,
        temperature: 0.7,
      };

      // Simulate the getOptions logic that handles GPT-5+ models
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toBeDefined();
      expect(clientOptions.modelKwargs.max_completion_tokens).toBe(2048);
      expect(clientOptions.temperature).toBe(0.7); // Other options should remain
    });

    it('should move maxTokens to modelKwargs.max_output_tokens for GPT-5 models with useResponsesApi', () => {
      const clientOptions = {
        model: 'gpt-5',
        maxTokens: 2048,
        temperature: 0.7,
        useResponsesApi: true,
      };

      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        const paramName =
          clientOptions.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
        clientOptions.modelKwargs[paramName] = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toBeDefined();
      expect(clientOptions.modelKwargs.max_output_tokens).toBe(2048);
      expect(clientOptions.temperature).toBe(0.7); // Other options should remain
    });

    it('should handle GPT-5+ models with existing modelKwargs', () => {
      const clientOptions = {
        model: 'gpt-6',
        maxTokens: 1500,
        temperature: 0.8,
        modelKwargs: {
          customParam: 'value',
        },
      };

      // Simulate the getOptions logic
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      expect(clientOptions.maxTokens).toBeUndefined();
      expect(clientOptions.modelKwargs).toEqual({
        customParam: 'value',
        max_completion_tokens: 1500,
      });
    });

    it('should not modify maxTokens for non-GPT-5+ models', () => {
      const clientOptions = {
        model: 'gpt-4',
        maxTokens: 2048,
        temperature: 0.7,
      };

      // Simulate the getOptions logic
      if (/\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) && clientOptions.maxTokens != null) {
        clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
        clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
        delete clientOptions.maxTokens;
      }

      // Should not be modified since it's GPT-4
      expect(clientOptions.maxTokens).toBe(2048);
      expect(clientOptions.modelKwargs).toBeUndefined();
    });

    it('should handle various GPT-5+ model formats', () => {
      const testCases = [
        { model: 'gpt-5.1', shouldTransform: true },
        { model: 'gpt-5.1-chat-latest', shouldTransform: true },
        { model: 'gpt-5.1-codex', shouldTransform: true },
        { model: 'gpt-5', shouldTransform: true },
        { model: 'gpt-5-turbo', shouldTransform: true },
        { model: 'gpt-6', shouldTransform: true },
        { model: 'gpt-7-preview', shouldTransform: true },
        { model: 'gpt-8', shouldTransform: true },
        { model: 'gpt-9-mini', shouldTransform: true },
        { model: 'gpt-4', shouldTransform: false },
        { model: 'gpt-4o', shouldTransform: false },
        { model: 'gpt-3.5-turbo', shouldTransform: false },
        { model: 'claude-3', shouldTransform: false },
      ];

      testCases.forEach(({ model, shouldTransform }) => {
        const clientOptions = {
          model,
          maxTokens: 1000,
        };

        // Simulate the getOptions logic
        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (shouldTransform) {
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_completion_tokens).toBe(1000);
        } else {
          expect(clientOptions.maxTokens).toBe(1000);
          expect(clientOptions.modelKwargs).toBeUndefined();
        }
      });
    });

    it('should not swap max token param for older models when using useResponsesApi', () => {
      const testCases = [
        { model: 'gpt-5.1', shouldTransform: true },
        { model: 'gpt-5.1-chat-latest', shouldTransform: true },
        { model: 'gpt-5.1-codex', shouldTransform: true },
        { model: 'gpt-5', shouldTransform: true },
        { model: 'gpt-5-turbo', shouldTransform: true },
        { model: 'gpt-6', shouldTransform: true },
        { model: 'gpt-7-preview', shouldTransform: true },
        { model: 'gpt-8', shouldTransform: true },
        { model: 'gpt-9-mini', shouldTransform: true },
        { model: 'gpt-4', shouldTransform: false },
        { model: 'gpt-4o', shouldTransform: false },
        { model: 'gpt-3.5-turbo', shouldTransform: false },
        { model: 'claude-3', shouldTransform: false },
      ];

      testCases.forEach(({ model, shouldTransform }) => {
        const clientOptions = {
          model,
          maxTokens: 1000,
          useResponsesApi: true,
        };

        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          const paramName =
            clientOptions.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
          clientOptions.modelKwargs[paramName] = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (shouldTransform) {
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_output_tokens).toBe(1000);
        } else {
          expect(clientOptions.maxTokens).toBe(1000);
          expect(clientOptions.modelKwargs).toBeUndefined();
        }
      });
    });

    it('should not transform if maxTokens is null or undefined', () => {
      const testCases = [
        { model: 'gpt-5', maxTokens: null },
        { model: 'gpt-5', maxTokens: undefined },
        { model: 'gpt-6', maxTokens: 0 }, // Should transform even if 0
      ];

      testCases.forEach(({ model, maxTokens }, index) => {
        const clientOptions = {
          model,
          maxTokens,
          temperature: 0.7,
        };

        // Simulate the getOptions logic
        if (
          /\bgpt-[5-9](?:\.\d+)?\b/i.test(clientOptions.model) &&
          clientOptions.maxTokens != null
        ) {
          clientOptions.modelKwargs = clientOptions.modelKwargs ?? {};
          clientOptions.modelKwargs.max_completion_tokens = clientOptions.maxTokens;
          delete clientOptions.maxTokens;
        }

        if (index < 2) {
          // null or undefined cases
          expect(clientOptions.maxTokens).toBe(maxTokens);
          expect(clientOptions.modelKwargs).toBeUndefined();
        } else {
          // 0 case - should transform
          expect(clientOptions.maxTokens).toBeUndefined();
          expect(clientOptions.modelKwargs?.max_completion_tokens).toBe(0);
        }
      });
    });
  });

  describe('buildMessages with MCP server instructions', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;

    beforeEach(() => {
      jest.clearAllMocks();

      // Reset the mock to default behavior
      mockFormatInstructions.mockResolvedValue(
        '# MCP Server Instructions\n\nTest MCP instructions here',
      );

      const { DynamicStructuredTool } = require('@librechat/agents/langchain/tools');

      // Create mock MCP tools with the delimiter pattern
      const mockMCPTool1 = new DynamicStructuredTool({
        name: `tool1${Constants.mcp_delimiter}server1`,
        description: 'Test MCP tool 1',
        schema: {},
        func: async () => 'result',
      });

      const mockMCPTool2 = new DynamicStructuredTool({
        name: `tool2${Constants.mcp_delimiter}server2`,
        description: 'Test MCP tool 2',
        schema: {},
        func: async () => 'result',
      });

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Base agent instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [mockMCPTool1, mockMCPTool2],
      };

      mockReq = {
        user: {
          id: 'user-123',
        },
        body: {
          endpoint: EModelEndpoint.openAI,
        },
        config: {},
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
        endpoint: EModelEndpoint.agents,
      };

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
    });

    it('loads RAG, memory, attachment, and MCP context without serial waits', async () => {
      const ragContext = deferred();
      const memoryContext = deferred();
      const mcpConfig = deferred();
      client.contextHandlers = {
        createContext: jest.fn(() => ragContext.promise),
      };
      client.useMemory = jest.fn(() => memoryContext.promise);
      resolveConfigServers.mockReturnValueOnce(mcpConfig.promise);

      const buildPromise = client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Load all context.',
            isCreatedByUser: true,
          },
        ],
        null,
        {},
      );

      expect(client.contextHandlers.createContext).toHaveBeenCalledTimes(1);
      expect(client.useMemory).toHaveBeenCalledTimes(1);
      expect(resolveConfigServers).toHaveBeenCalledWith(mockReq);

      ragContext.resolve('Retrieved context');
      memoryContext.resolve(undefined);
      mcpConfig.resolve({});
      await buildPromise;

      expect(client.augmentedPrompt).toBe('Retrieved context');
      expect(client.options.agent.additional_instructions).toContain('Retrieved context');
    });

    it('starts independent context and current-file work at their earliest dependency barriers', async () => {
      const requestAttachments = deferred();
      const memoryContext = deferred();
      const mcpConfig = deferred();
      const agentScopedContext = deferred();
      const fileContext = deferred();
      const providerAttachments = deferred();
      const requestFile = {
        file_id: 'request-file',
        filename: 'request.txt',
        source: 'text',
        text: 'Request file contents',
        type: 'text/plain',
        bytes: 0,
      };

      client.options.attachments = requestAttachments.promise;
      client.useMemory = jest.fn(() => memoryContext.promise);
      resolveConfigServers.mockReturnValueOnce(mcpConfig.promise);
      mockBuildAgentScopedContext.mockReturnValueOnce(agentScopedContext.promise);
      client.addFileContextToMessage = jest.fn(() => fileContext.promise);
      client.processAttachments = jest.fn(() => providerAttachments.promise);

      const buildPromise = client.buildMessages(
        [
          {
            messageId: 'msg-early-context',
            parentMessageId: null,
            sender: 'User',
            text: 'Load the request file.',
            isCreatedByUser: true,
          },
        ],
        'msg-early-context',
        {},
      );

      expect(client.useMemory).toHaveBeenCalledTimes(1);
      expect(resolveConfigServers).toHaveBeenCalledWith(mockReq);
      expect(mockBuildAgentScopedContext).not.toHaveBeenCalled();
      expect(client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(client.processAttachments).not.toHaveBeenCalled();

      requestAttachments.resolve([requestFile]);
      await Promise.resolve();

      expect(mockBuildAgentScopedContext).toHaveBeenCalledTimes(1);
      const scopedContextArgs = mockBuildAgentScopedContext.mock.calls[0][0];
      expect([...scopedContextArgs.sharedRunAttachmentIds]).toEqual(['request-file']);
      expect(client.addFileContextToMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-early-context' }),
        [requestFile],
      );
      expect(client.processAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-early-context' }),
        [requestFile],
      );

      providerAttachments.resolve([requestFile]);
      await Promise.resolve();
      expect(client.options.attachments).toBe(requestAttachments.promise);

      fileContext.resolve();
      memoryContext.resolve(undefined);
      mcpConfig.resolve({});
      agentScopedContext.resolve(new Map());
      await buildPromise;

      expect(client.options.attachments).toEqual([requestFile]);
    });

    it('should await MCP instructions and not include [object Promise] in agent instructions', async () => {
      // Set specific return value for this test
      mockFormatInstructions.mockResolvedValue(
        '# MCP Server Instructions\n\nUse these tools carefully',
      );

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      // Verify formatInstructionsForContext was called with correct server names
      expect(mockFormatInstructions).toHaveBeenCalledWith(['server1', 'server2'], {});

      // Verify the instructions do NOT contain [object Promise]
      expect(client.options.agent.instructions).not.toContain('[object Promise]');

      // Verify the instructions DO contain the MCP instructions
      expect(client.options.agent.instructions).toContain('# MCP Server Instructions');
      expect(client.options.agent.instructions).toContain('Use these tools carefully');

      // Verify the base instructions are also included (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toContain('Base agent instructions');
    });

    it('blocks fetched MCP instructions before they become model-bound', async () => {
      const privateInstruction = 'PRIVATE-MCP-INSTRUCTION';
      mockReq.config.filters = {
        agentInstructions: {
          pii: {
            fields: ['instructions'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-mcp-instruction',
                label: 'private MCP instruction',
                regex: privateInstruction,
              },
            ],
          },
        },
      };
      mockFormatInstructions.mockResolvedValue(privateInstruction);

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Hello',
              isCreatedByUser: true,
            },
          ],
          null,
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'agent_instruction', field: 'instructions' },
      });
    });

    it('should handle MCP instructions with ephemeral agent', async () => {
      // Set specific return value for this test
      mockFormatInstructions.mockResolvedValue(
        '# Ephemeral MCP Instructions\n\nSpecial ephemeral instructions',
      );

      // Set up ephemeral agent with MCP servers
      mockReq.body.ephemeralAgent = {
        mcp: ['ephemeral-server1', 'ephemeral-server2'],
      };

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Test ephemeral',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Ephemeral instructions',
        additional_instructions: null,
      });

      // Verify formatInstructionsForContext was called with ephemeral server names
      expect(mockFormatInstructions).toHaveBeenCalledWith(
        ['ephemeral-server1', 'ephemeral-server2'],
        {},
      );

      // Verify no [object Promise] in instructions
      expect(client.options.agent.instructions).not.toContain('[object Promise]');

      // Verify ephemeral MCP instructions are included
      expect(client.options.agent.instructions).toContain('# Ephemeral MCP Instructions');
      expect(client.options.agent.instructions).toContain('Special ephemeral instructions');
    });

    it('should handle empty MCP instructions gracefully', async () => {
      // Set empty return value for this test
      mockFormatInstructions.mockResolvedValue('');

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions only',
        additional_instructions: null,
      });

      // Verify the instructions still work without MCP content (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toBe('Base agent instructions');
      expect(client.options.agent.instructions).not.toContain('[object Promise]');
    });

    it('should handle MCP instructions error gracefully', async () => {
      // Set error return for this test
      mockFormatInstructions.mockRejectedValue(new Error('MCP error'));

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      // Should not throw
      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      // Should still have base instructions without MCP content (from agent config, not buildOptions)
      expect(client.options.agent.instructions).toContain('Base agent instructions');
      expect(client.options.agent.instructions).not.toContain('[object Promise]');
    });
  });

  describe('buildMessages with request and agent-scoped context attachments', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;

    const makeTextFile = (file_id, filename, text) => ({
      user: 'user-123',
      file_id,
      filename,
      filepath: `/uploads/${filename}`,
      object: 'file',
      type: 'text/plain',
      bytes: text.length,
      embedded: false,
      usage: 0,
      source: 'text',
      text,
    });

    const makeUploadedFile = (file_id, filename, type) => ({
      user: 'user-123',
      file_id,
      filename,
      filepath: `/uploads/${filename}`,
      object: 'file',
      type,
      bytes: 128,
      embedded: false,
      usage: 0,
      source: 'local',
    });

    beforeEach(() => {
      jest.clearAllMocks();
      mockFormatInstructions.mockResolvedValue('');
      require('@librechat/api').countFormattedMessageTokens.mockImplementation(() => 42);
      require('~/models').getFiles.mockReset().mockResolvedValue([]);
      require('~/models').getUserMemories.mockReset().mockResolvedValue([]);

      mockAgent = {
        id: 'primary-agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Primary instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [],
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
        body: {
          endpoint: EModelEndpoint.openAI,
          fileTokenLimit: 1000,
        },
        config: {
          memory: {
            disabled: true,
          },
        },
      };
      mockRes = {};
      mockAgent.deliveryRouting = jest
        .requireActual('@librechat/api')
        .resolveTurnDeliveryRouting({ agent: mockAgent, config: mockReq.config });

      client = new AgentClient({
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
        endpoint: EModelEndpoint.agents,
      });
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
      client.useMemory = jest.fn().mockResolvedValue(undefined);
    });

    it.each(['primary', 'handoff'])(
      'blocks %s agent dynamic tool context before it becomes model-bound',
      async (agentScope) => {
        const privateContext = 'PRIVATE-DYNAMIC-TOOL-CONTEXT';
        mockReq.config.filters = {
          files: {
            pii: {
              fields: ['content'],
              starterPatterns: [],
              customPatterns: [
                {
                  id: 'private-dynamic-context',
                  label: 'private dynamic context',
                  regex: privateContext,
                },
              ],
            },
          },
        };
        const dynamicToolContextMap = {
          empty: '',
          dynamic: privateContext,
          ignored: 123,
        };
        if (agentScope === 'primary') {
          client.options.agent.dynamicToolContextMap = dynamicToolContextMap;
        } else {
          client.agentConfigs = new Map([
            [
              'handoff-agent',
              {
                ...mockAgent,
                id: 'handoff-agent',
                dynamicToolContextMap,
              },
            ],
          ]);
        }

        await expect(
          client.buildMessages(
            [
              {
                messageId: 'msg-1',
                parentMessageId: null,
                sender: 'User',
                text: 'Hello',
                isCreatedByUser: true,
              },
            ],
            'msg-1',
            {},
          ),
        ).rejects.toMatchObject({
          code: 'content_filter_block',
          body: { source: 'file', field: 'content' },
        });
      },
    );

    it('blocks a late-loaded tool definition on a nested pure subagent', async () => {
      const privateDescription = 'PRIVATE-NESTED-TOOL-DEFINITION';
      mockReq.config.filters = {
        agentInstructions: {
          pii: {
            fields: ['description'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-nested-tool-definition',
                label: 'private nested tool definition',
                regex: privateDescription,
              },
            ],
          },
        },
      };
      const nestedPureSubagent = {
        ...mockAgent,
        id: 'nested-pure-subagent',
        toolDefinitions: [
          {
            name: 'nested_lookup',
            description: privateDescription,
            parameters: { type: 'object' },
          },
        ],
      };
      client.options.agent.subagentAgentConfigs = [
        {
          ...mockAgent,
          id: 'pure-subagent',
          subagentAgentConfigs: [nestedPureSubagent],
        },
      ];

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Hello',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'agent_instruction', field: 'description' },
      });
    });

    it('blocks dynamic tool context on a nested pure subagent', async () => {
      const privateContext = 'PRIVATE-NESTED-DYNAMIC-CONTEXT';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['content'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-nested-dynamic-context',
                label: 'private nested dynamic context',
                regex: privateContext,
              },
            ],
          },
        },
      };
      client.options.agent.subagentAgentConfigs = [
        {
          ...mockAgent,
          id: 'pure-subagent',
          subagentAgentConfigs: [
            {
              ...mockAgent,
              id: 'nested-pure-subagent',
              dynamicToolContextMap: { nested_lookup: privateContext },
            },
          ],
        },
      ];

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Hello',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'file', field: 'content' },
      });
    });

    it('blocks hydrated file context on a nested pure subagent', async () => {
      const privateFileText = 'PRIVATE-NESTED-HYDRATED-FILE';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-nested-hydrated-file',
                label: 'private nested hydrated file',
                regex: privateFileText,
              },
            ],
          },
        },
      };
      client.options.agent.subagentAgentConfigs = [
        {
          ...mockAgent,
          id: 'pure-subagent',
          subagentAgentConfigs: [
            {
              ...mockAgent,
              id: 'nested-pure-subagent',
              agentContextAttachments: [makeTextFile('nested-file', 'nested.txt', privateFileText)],
            },
          ],
        },
      ];

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Hello',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'file', field: 'extracted_text' },
      });
    });

    it('blocks loaded memory from a nested pure subagent partition', async () => {
      const privateMemory = 'PRIVATE-NESTED-MEMORY';
      mockReq.config.filters = {
        memories: {
          pii: {
            fields: ['value'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'private-nested-memory',
                label: 'private nested memory',
                regex: privateMemory,
              },
            ],
          },
        },
      };
      client.useMemory.mockResolvedValue({
        withKeys: 'safe shared memory',
        withoutKeys: 'safe shared memory',
      });
      require('~/models').getFormattedMemories.mockImplementation(({ agentId }) =>
        Promise.resolve(
          agentId === 'nested-pure-subagent'
            ? { withKeys: privateMemory, withoutKeys: privateMemory }
            : { withKeys: 'safe memory', withoutKeys: 'safe memory' },
        ),
      );
      require('~/models').getUserMemories.mockImplementation(({ agentId }) =>
        Promise.resolve(
          agentId === 'nested-pure-subagent' ? [{ key: 'private', value: privateMemory }] : [],
        ),
      );
      client.options.agent.subagentAgentConfigs = [
        {
          ...mockAgent,
          id: 'pure-subagent',
          subagentAgentConfigs: [
            {
              ...mockAgent,
              id: 'nested-pure-subagent',
              memory_scope: 'agent',
              memoryToolsRegistered: true,
            },
          ],
        },
      ];

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Hello',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'memory', field: 'value' },
      });
    });

    it('blocks current attachment content before attachment processing', async () => {
      const privateFilename = 'PRIVATE-FILE.txt';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['name'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: privateFilename }],
          },
        },
      };
      client.options.attachments = [
        makeTextFile('current-file', privateFilename, 'otherwise safe content'),
      ];
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn();

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Read this file.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({ code: 'content_filter_block' });

      expect(client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(client.processAttachments).not.toHaveBeenCalled();
    });

    it('accepts an owner-resolved historical file under fail-closed inspection', async () => {
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      };
      const historicalFile = makeTextFile(
        'historical-file',
        'history.txt',
        'Safe canonical content',
      );
      client.authorizedHistoricalFiles = new Map([['historical-file', historicalFile]]);

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Use the historical file.',
              isCreatedByUser: true,
              files: [{ file_id: 'historical-file' }],
            },
          ],
          'msg-1',
          {},
        ),
      ).resolves.toEqual(expect.objectContaining({ prompt: expect.any(Array) }));
    });

    it.each([
      ['seeds the run from a server-authored parent response', undefined, true],
      ['ignores context meta on a client-submitted parent response', true, false],
    ])('%s', async (_label, isUserSubmitted, expectSeed) => {
      const contextMeta = {
        calibrationRatio: 1.2,
        encoding: 'claude',
        fading: { v: 1, budgetTokens: 50_000, masked: true },
      };
      const parentResponse = {
        messageId: 'assistant-seed',
        parentMessageId: null,
        sender: 'Assistant',
        role: 'assistant',
        isCreatedByUser: false,
        ...(isUserSubmitted != null && { isUserSubmitted }),
        text: 'Prior response',
        contextMeta,
      };
      const userMessage = {
        messageId: 'user-next',
        parentMessageId: 'assistant-seed',
        sender: 'User',
        role: 'user',
        isCreatedByUser: true,
        text: 'Next question',
      };
      client.setModelBoundStoredMessages([parentResponse, userMessage]);
      client.contextMeta = undefined;
      client.publishRunContextMeta = jest.fn().mockResolvedValue(undefined);

      await client.buildMessages([parentResponse, userMessage], 'user-next', {}, {});

      expect(client.contextMeta).toEqual(expectSeed ? contextMeta : undefined);
      expect(client.publishRunContextMeta).toHaveBeenCalledTimes(expectSeed ? 1 : 0);
    });

    it('preserves persisted source identity through both agent formatting passes', async () => {
      mockReq.config.filters = {
        messages: {
          pii: {
            fields: ['content_part'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private', label: 'private value', regex: 'PRIVATE-USER-STEER' },
            ],
          },
        },
      };
      const storedMessage = {
        messageId: 'assistant-mixed',
        parentMessageId: null,
        sender: 'Assistant',
        role: 'assistant',
        isCreatedByUser: false,
        content: [
          { type: ContentTypes.TEXT, text: 'Safe model output' },
          { type: ContentTypes.STEER, steer: 'PRIVATE-USER-STEER' },
        ],
        userSubmittedPaths: ['/content/1/steer'],
      };
      client.setModelBoundStoredMessages([storedMessage]);

      const result = await client.buildMessages([storedMessage], 'assistant-mixed', {}, {});
      expect(result.prompt).toEqual([expect.objectContaining({ messageId: 'assistant-mixed' })]);
      expect(
        require('@librechat/api').countFormattedMessageTokens.mock.calls.some(
          ([message]) => message?.messageId === 'assistant-mixed',
        ),
      ).toBe(true);

      const { messages: providerMessages } = jest
        .requireActual('@librechat/agents')
        .formatAgentMessages(result.prompt);
      expect(providerMessages.length).toBeGreaterThanOrEqual(2);
      expect(
        providerMessages.every(
          (message) =>
            message.additional_kwargs?.sourceMessageId === 'assistant-mixed' ||
            message.id === 'assistant-mixed',
        ),
      ).toBe(true);
      expect(() =>
        client
          .createModelBoundChatModelCallback()
          .handleChatModelStart(undefined, [providerMessages]),
      ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
    });

    it('preserves persisted assistant attribution at the final agent provider boundary', async () => {
      const marker = 'E2E-PERSISTED-UNATTRIBUTED-ASSISTANT';
      mockReq.config.filters = {
        messages: {
          pii: {
            fields: ['text'],
            starterPatterns: [],
            customPatterns: [
              {
                id: 'persisted-unattributed-assistant',
                label: 'persisted unattributed assistant content',
                regex: `^${marker}$`,
              },
            ],
          },
          unattributedAssistantContent: 'inspect',
        },
      };
      const storedMessage = {
        messageId: 'legacy-assistant',
        parentMessageId: null,
        sender: 'Assistant',
        text: marker,
        isCreatedByUser: false,
      };
      client.setModelBoundStoredMessages([storedMessage]);

      const result = await client.buildMessages([storedMessage], 'legacy-assistant', {}, {});
      const { messages: providerMessages } = jest
        .requireActual('@librechat/agents')
        .formatAgentMessages(result.prompt);

      expect(() =>
        client
          .createModelBoundChatModelCallback()
          .handleChatModelStart(undefined, [providerMessages]),
      ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));

      client.setModelBoundStoredMessages([{ ...storedMessage, isUserSubmitted: false }]);
      expect(() =>
        client
          .createModelBoundChatModelCallback()
          .handleChatModelStart(undefined, [providerMessages]),
      ).not.toThrow();
    });

    it('ignores historical file refs when this agent does not replay files', async () => {
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            uninspectable: 'block',
          },
        },
      };
      client.options.resendFiles = false;

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Continue without the deleted file.',
              isCreatedByUser: true,
              files: [{ file_id: 'deleted-historical-file' }],
            },
          ],
          'msg-1',
          {},
        ),
      ).resolves.toEqual(expect.objectContaining({ prompt: expect.any(Array) }));
    });

    it('enforces extracted-text limits on retained history when file replay is disabled', async () => {
      client.options.resendFiles = false;
      mockReq.config.fileConfig = { fileContextCharLimit: 10 };

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'historical-context',
              parentMessageId: null,
              sender: 'User',
              text: 'Inspect the retained context.',
              isCreatedByUser: true,
              fileContext: 'this retained context is over the configured limit',
            },
            {
              messageId: 'msg-1',
              parentMessageId: 'historical-context',
              sender: 'User',
              text: 'Continue.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: 'extracted_text',
      });
    });

    it('does not count retained text-only history against endpoint file limits', async () => {
      client.options.resendFiles = false;
      mockReq.config.fileConfig = {
        fileContextCharLimit: 1_000_000,
        endpoints: { agents: { fileLimit: 1 } },
      };

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'historical-context-1',
              parentMessageId: null,
              sender: 'User',
              text: 'First retained context.',
              isCreatedByUser: true,
              fileContext: 'first retained file context',
            },
            {
              messageId: 'historical-context-2',
              parentMessageId: 'historical-context-1',
              sender: 'User',
              text: 'Second retained context.',
              isCreatedByUser: true,
              fileContext: 'second retained file context',
            },
            {
              messageId: 'msg-1',
              parentMessageId: 'historical-context-2',
              sender: 'User',
              text: 'Continue.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).resolves.toEqual(expect.objectContaining({ prompt: expect.any(Array) }));
    });

    it('rejects combined historical and current bytes before either batch is encoded', async () => {
      mockAgent.endpoint = 'Moonshot';
      client.options.endpointType = EModelEndpoint.custom;
      client.options.resendFiles = true;
      mockReq.config.fileConfig = {
        endpoints: { Moonshot: { fileLimit: 10, totalSizeLimit: 1 } },
      };
      const first = {
        ...makeUploadedFile('history-1', 'one.pdf', 'application/pdf'),
        bytes: 600_000,
      };
      const second = {
        ...makeUploadedFile('current-1', 'two.pdf', 'application/pdf'),
        bytes: 600_000,
      };
      client.options.attachments = Promise.resolve([second]);
      require('~/models').getFiles.mockResolvedValue([first]);
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn();

      await expect(
        client.addPreviousAttachments([
          {
            messageId: 'msg-1',
            isCreatedByUser: true,
            files: [{ file_id: first.file_id }],
          },
        ]),
      ).rejects.toMatchObject({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: 'bytes',
      });
      expect(client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(client.processAttachments).not.toHaveBeenCalled();
    });

    it('rejects combined historical and scoped bytes before history is encoded', async () => {
      mockAgent.endpoint = 'Moonshot';
      client.options.endpointType = EModelEndpoint.custom;
      client.options.resendFiles = true;
      mockReq.config.fileConfig = {
        endpoints: {
          Moonshot: {
            fileLimit: 10,
            totalSizeLimit: 1,
            supportedMimeTypes: ['^application/pdf$'],
          },
        },
      };
      const historicalFile = {
        ...makeUploadedFile('history-1', 'history.pdf', 'application/pdf'),
        bytes: 600_000,
      };
      const scopedFile = {
        ...makeUploadedFile('scoped-1', 'scoped.pdf', 'application/pdf'),
        bytes: 600_000,
      };
      client.options.agentContextAttachmentsByAgentId = new Map([['primary-agent', [scopedFile]]]);
      require('~/models').getFiles.mockResolvedValue([historicalFile]);
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn();

      await expect(
        client.addPreviousAttachments([
          {
            messageId: 'msg-1',
            isCreatedByUser: true,
            files: [{ file_id: historicalFile.file_id }],
          },
        ]),
      ).rejects.toMatchObject({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: 'bytes',
      });
      expect(client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(client.processAttachments).not.toHaveBeenCalled();
    });

    it('does not count display-only historical artifacts toward model attachment limits', async () => {
      client.options.resendFiles = true;
      const artifacts = Array.from({ length: 11 }, (_, index) =>
        makeUploadedFile(`artifact-${index}`, `artifact-${index}.png`, 'image/png'),
      );
      require('~/models').getFiles.mockResolvedValue(artifacts);

      await expect(
        client.addPreviousAttachments([
          {
            messageId: 'assistant-artifacts',
            isCreatedByUser: false,
            attachments: artifacts.map(({ file_id }) => ({ file_id })),
          },
        ]),
      ).resolves.toEqual([
        expect.objectContaining({ attachments: expect.arrayContaining(artifacts) }),
      ]);
    });

    it('does not admit endpoint-incompatible historical files to model limits', async () => {
      mockAgent.endpoint = 'Moonshot';
      client.options.endpointType = EModelEndpoint.custom;
      client.options.resendFiles = true;
      mockReq.config.fileConfig = {
        endpoints: {
          Moonshot: { fileLimit: 10, supportedMimeTypes: ['^text/plain$'] },
        },
      };
      const incompatibleFiles = Array.from({ length: 11 }, (_, index) =>
        makeUploadedFile(`history-${index}`, `history-${index}.bin`, 'application/octet-stream'),
      );
      require('~/models').getFiles.mockResolvedValue(incompatibleFiles);
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn();

      await expect(
        client.addPreviousAttachments(
          incompatibleFiles.map((file, index) => ({
            messageId: `msg-${index}`,
            isCreatedByUser: true,
            files: [{ file_id: file.file_id }],
          })),
        ),
      ).resolves.toHaveLength(11);
      expect(Object.values(client.message_file_map).flat()).toEqual([]);
      expect(client.processAttachments).not.toHaveBeenCalled();
    });

    it('does not admit tool-only historical files to model limits', async () => {
      client.options.resendFiles = true;
      const toolFiles = Array.from({ length: 11 }, (_, index) => ({
        ...makeUploadedFile(`tool-history-${index}`, `tool-${index}.txt`, 'text/plain'),
        embedded: true,
      }));
      require('~/models').getFiles.mockResolvedValue(toolFiles);
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn((_message, files) => files);

      await expect(
        client.addPreviousAttachments(
          toolFiles.map((file, index) => ({
            messageId: `tool-msg-${index}`,
            isCreatedByUser: true,
            files: [{ file_id: file.file_id }],
          })),
        ),
      ).resolves.toHaveLength(11);
      expect(Object.values(client.message_file_map).flat()).toEqual([]);
      expect(client.addFileContextToMessage).not.toHaveBeenCalled();
      expect(client.processAttachments).not.toHaveBeenCalled();
    });

    it('does not count current tool-only resources toward model attachment admission', async () => {
      mockReq.config.fileConfig = { endpoints: { openAI: { fileLimit: 1 } } };
      const toolFiles = Array.from({ length: 10 }, (_, index) => ({
        ...makeUploadedFile(`tool-current-${index}`, `tool-${index}.txt`, 'text/plain'),
        embedded: true,
      }));
      const modelFile = makeTextFile('model-current', 'model.txt', 'model context');
      client.options.attachments = [...toolFiles, modelFile];

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Use the available context.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).resolves.toEqual(expect.objectContaining({ prompt: expect.any(Array) }));
      expect(client.modelBoundCurrentFiles).toEqual([modelFile]);
    });

    it('processes only endpoint-admitted current files plus tool-only passthrough files', async () => {
      mockReq.config.fileConfig = {
        endpoints: { openAI: { fileSizeLimit: 1, supportedMimeTypes: ['^text/plain$'] } },
      };
      const oversized = {
        ...makeUploadedFile('oversized', 'oversized.png', 'image/png'),
        bytes: 2 * 1024 * 1024,
      };
      const oversizedText = {
        ...makeTextFile('oversized-text', 'oversized.txt', 'must not reach the prompt'),
        bytes: 2 * 1024 * 1024,
      };
      const toolOnly = {
        ...makeUploadedFile('tool-only', 'tool.txt', 'text/plain'),
        embedded: true,
      };
      const admitted = makeTextFile('admitted', 'admitted.txt', 'model context');
      client.options.attachments = [oversized, oversizedText, toolOnly, admitted];
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn((_message, files) => files);

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Use the available context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      expect(client.addFileContextToMessage).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1' }),
        [admitted],
      );
      expect(client.processAttachments).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: 'msg-1' }),
        [toolOnly, admitted],
      );
      expect(client.options.attachments).toEqual([toolOnly, admitted]);
      expect(client.message_file_map['msg-1']).toEqual([toolOnly, admitted]);
    });

    it('defers current attachment persistence until model admission', () => {
      client.modelBoundCurrentFiles = [makeTextFile('pending', 'pending.txt', 'context')];

      expect(client.shouldDeferUserMessagePersistence()).toBe(true);
    });

    it('still seeds the conversation row when only attachments defer the message', () => {
      client.modelBoundCurrentFiles = [makeTextFile('pending', 'pending.txt', 'context')];

      expect(client.shouldDeferUserMessagePersistence()).toBe(true);
      expect(client.shouldSeedDeferredConversation()).toBe(true);
    });

    it('holds back the conversation row while a content policy defers every write', () => {
      client.modelBoundCurrentFiles = [makeTextFile('pending', 'pending.txt', 'context')];
      mockReq.config.messageFilter = {
        pii: {
          starterPatterns: [],
          customPatterns: [{ id: 'secret', label: 'secret', regex: 'SECRET-[A-Z]+' }],
        },
      };

      expect(client.shouldDeferUserMessagePersistence()).toBe(true);
      expect(client.shouldSeedDeferredConversation()).toBe(false);
    });

    it('keeps repeated lazy scoped-text admission cumulative across resolutions', () => {
      mockReq.config.fileConfig = { fileContextCharLimit: 1_000_000 };
      const repeated = makeTextFile('lazy-context', 'lazy.txt', 'x'.repeat(600_000));
      const cumulativeInjections = [repeated];

      expect(() => client.assertTurnAttachmentLimits([], cumulativeInjections)).not.toThrow();
      cumulativeInjections.push(repeated);
      expect(() => client.assertTurnAttachmentLimits([], cumulativeInjections)).toThrow(
        expect.objectContaining({
          code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
          limitType: 'extracted_text',
        }),
      );
    });

    it('keeps live steer attachments cumulative with the initial turn', () => {
      const initial = {
        ...makeUploadedFile('initial-large', 'initial.pdf', 'application/pdf'),
        bytes: 120 * 1024 * 1024,
      };
      const steer = {
        ...makeUploadedFile('steer-large', 'steer.pdf', 'application/pdf'),
        bytes: 20 * 1024 * 1024,
      };
      client.turnSharedAttachmentFiles = [initial];
      client.turnScopedAttachmentsByAgentId = new Map([['primary-agent', []]]);
      client.turnAttachmentEndpointsByAgentId = new Map([
        ['primary-agent', { endpoint: mockAgent.endpoint }],
      ]);

      expect(() => client.admitSteerAttachments([steer])).toThrow(
        expect.objectContaining({
          code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
          limitType: 'bytes',
        }),
      );
      expect(client.turnSharedAttachmentFiles).toEqual([initial]);
    });

    it('does not charge tool-only steer files to model attachment admission', () => {
      const toolOnly = {
        ...makeUploadedFile('steer-tool-only', 'tool-only.bin', 'application/octet-stream'),
        embedded: true,
        bytes: 200 * 1024 * 1024,
      };
      client.turnSharedAttachmentFiles = [];
      client.turnScopedAttachmentsByAgentId = new Map([['primary-agent', []]]);
      client.turnAttachmentEndpointsByAgentId = new Map([
        ['primary-agent', { endpoint: mockAgent.endpoint }],
      ]);

      expect(() => client.admitSteerAttachments([toolOnly])).not.toThrow();
      expect(client.turnSharedAttachmentFiles).toEqual([]);
    });

    it('excludes tool-only and endpoint-incompatible scoped files from cumulative admission', () => {
      mockAgent.endpoint = 'Moonshot';
      client.options.endpointType = EModelEndpoint.custom;
      mockReq.config.fileConfig = {
        endpoints: {
          Moonshot: { fileLimit: 1, supportedMimeTypes: ['^text/plain$'] },
        },
      };
      const filtered = client.getFilteredScopedAttachmentMap(
        new Set(),
        new Map([
          [
            'primary-agent',
            [
              {
                ...makeUploadedFile('tool-only', 'tool.txt', 'text/plain'),
                embedded: true,
              },
              makeUploadedFile('unsupported', 'unsupported.bin', 'application/octet-stream'),
              makeTextFile('model-bound', 'model.txt', 'model context'),
            ],
          ],
        ]),
        [mockAgent],
      );

      expect([...filtered.values()].flat()).toEqual([
        expect.objectContaining({ file_id: 'model-bound' }),
      ]);
      expect(() =>
        client.assertTurnAttachmentLimits([], [...filtered.values()].flat()),
      ).not.toThrow();
    });

    it('filters historical attachment content only when its source survives pruning', async () => {
      const privateText = 'PRIVATE-HISTORICAL-CONTENT';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: privateText }],
          },
        },
      };
      client.options.resendFiles = true;
      require('~/models').getFiles.mockResolvedValue([
        makeTextFile('historical-file', 'history.txt', privateText),
      ]);
      client.addFileContextToMessage = jest.fn();
      client.processAttachments = jest.fn((_message, files) => files);

      const hydratedMessages = await client.addPreviousAttachments([
        {
          messageId: 'msg-1',
          parentMessageId: null,
          isCreatedByUser: true,
          files: [{ file_id: 'historical-file' }],
        },
      ]);
      client.setModelBoundStoredMessages([
        ...hydratedMessages,
        {
          messageId: 'safe-message',
          role: 'user',
          text: 'Safe retained turn',
          isCreatedByUser: true,
        },
      ]);
      const callback = client.createModelBoundChatModelCallback();

      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Safe retained turn',
              additional_kwargs: { sourceMessageId: 'safe-message' },
            },
          ],
        ]),
      ).not.toThrow();
      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Use the historical file.',
              additional_kwargs: { sourceMessageId: 'msg-1' },
            },
          ],
        ]),
      ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));

      expect(client.addFileContextToMessage).toHaveBeenCalled();
      expect(client.processAttachments).toHaveBeenCalled();
    });

    it('does not run historical file contexts through the pre-pruning build preflight', async () => {
      const privateText = 'PRIVATE-PRUNED-HISTORICAL-FILE';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: privateText }],
          },
        },
      };
      const historicalFile = makeTextFile('historical-file', 'history.txt', privateText);
      const storedMessages = [
        {
          messageId: 'file-message',
          parentMessageId: null,
          sender: 'User',
          role: 'user',
          text: 'Use the historical file.',
          fileContext: privateText,
          files: [{ file_id: 'historical-file' }],
          isCreatedByUser: true,
        },
        {
          messageId: 'safe-message',
          parentMessageId: 'file-message',
          sender: 'User',
          role: 'user',
          text: 'Safe retained turn',
          isCreatedByUser: true,
        },
      ];
      client.authorizedHistoricalFiles = new Map([['historical-file', historicalFile]]);
      client.message_file_map = { 'file-message': [historicalFile] };
      client.setModelBoundStoredMessages(storedMessages);

      await expect(client.buildMessages(storedMessages, 'safe-message', {}, {})).resolves.toEqual(
        expect.objectContaining({ prompt: expect.any(Array) }),
      );

      const callback = client.createModelBoundChatModelCallback();
      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Safe retained turn',
              additional_kwargs: { sourceMessageId: 'safe-message' },
            },
          ],
        ]),
      ).not.toThrow();
      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Use the historical file.',
              additional_kwargs: { sourceMessageId: 'file-message' },
            },
          ],
        ]),
      ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
    });

    it('filters historical steer attachments only when their source survives pruning', async () => {
      const privateText = 'PRIVATE-STEER-FILE-CONTENT';
      mockReq.config.filters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: privateText }],
          },
        },
      };
      client.options.resendFiles = true;
      require('~/models').getFiles.mockResolvedValue([
        makeTextFile('steer-file', 'steer.txt', privateText),
      ]);

      const storedMessages = await client.addPreviousAttachments([
        {
          messageId: 'assistant-msg',
          parentMessageId: null,
          isCreatedByUser: false,
          content: [
            {
              type: ContentTypes.STEER,
              steer: 'Read the attached file.',
              files: [{ file_id: 'steer-file' }],
            },
          ],
        },
      ]);
      client.setModelBoundStoredMessages([
        ...storedMessages,
        {
          messageId: 'safe-message',
          role: 'user',
          text: 'Safe retained turn',
          isCreatedByUser: true,
        },
      ]);
      client.modelBoundSteerFileIdsBySourceMessageId = new Map([
        ['assistant-msg', new Set(['steer-file'])],
      ]);
      const callback = client.createModelBoundChatModelCallback();

      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Safe retained turn',
              additional_kwargs: { sourceMessageId: 'safe-message' },
            },
          ],
        ]),
      ).not.toThrow();
      expect(() =>
        callback.handleChatModelStart(undefined, [
          [
            {
              role: 'human',
              content: 'Read the attached file.',
              additional_kwargs: { sourceMessageId: 'assistant-msg' },
            },
          ],
        ]),
      ).toThrow(expect.objectContaining({ code: 'content_filter_block' }));
    });

    it('fails closed when canonical memory loading fails under active policy', async () => {
      mockReq.config.filters = {
        memories: {
          pii: {
            fields: ['key'],
            starterPatterns: ['sk_prefix'],
          },
        },
      };
      require('~/models').getUserMemories.mockRejectedValue(new Error('memory read failed'));
      client.useMemory.mockResolvedValue({
        withKeys: '["key": "sk-private-memory"]',
        withoutKeys: 'safe value',
      });

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Use my preferences.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toThrow('memory read failed');
    });

    it('inspects formatted memory text when canonical loading returns no rows', async () => {
      const privateMemory = 'PRIVATE-MEMORY';
      mockReq.config.filters = {
        memories: {
          pii: {
            fields: ['value'],
            starterPatterns: [],
            customPatterns: [{ id: 'private', label: 'private value', regex: privateMemory }],
          },
        },
      };
      require('~/models').getUserMemories.mockResolvedValue([]);
      client.useMemory.mockResolvedValue({
        withKeys: privateMemory,
        withoutKeys: privateMemory,
      });

      await expect(
        client.buildMessages(
          [
            {
              messageId: 'msg-1',
              parentMessageId: null,
              sender: 'User',
              text: 'Use my preferences.',
              isCreatedByUser: true,
            },
          ],
          'msg-1',
          {},
        ),
      ).rejects.toMatchObject({
        code: 'content_filter_block',
        body: { source: 'memory', field: 'value' },
      });
    });

    it.each([
      ['CSV', 'csv-file', 'sample.csv', 'text/csv'],
      [
        'XLSX',
        'xlsx-file',
        'sample.xlsx',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ],
    ])(
      'routes default-supported provider uploads like %s as request documents without custom file config',
      async (_label, file_id, filename, type) => {
        const currentFile = makeUploadedFile(file_id, filename, type);
        const message = {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: `Read this ${filename}.`,
          isCreatedByUser: true,
        };

        client.addDocuments = jest.fn(async (targetMessage, attachments) => {
          targetMessage.documents = attachments.map((file) => ({
            type: 'input_file',
            filename: file.filename,
            file_data: `data:${file.type};base64,Y29sMQox`,
          }));
          return attachments;
        });

        const files = await client.processAttachments(message, [currentFile]);

        expect(client.addDocuments).toHaveBeenCalledWith(message, [currentFile]);
        expect(message.documents).toEqual([
          expect.objectContaining({
            type: 'input_file',
            filename,
          }),
        ]);
        expect(files).toEqual([currentFile]);
      },
    );

    it.each(['current', 'history', 'history-disabled'])(
      'resolves %s tool-routed text only for an authorized handoff without a reader',
      async (location) => {
        const file = {
          ...makeUploadedFile('fallback-file', 'sales.csv', 'text/csv'),
          text: 'handoff fallback content',
          llmDeliveryPath: 'none',
          /* The primary agent runs code, and a tool serves a file only once it holds it, so the
           * sandbox reference is what keeps the text out of the primary prompt while the handoff
           * agent, which runs no reader at all, still receives it. */
          metadata: {
            destinationChosen: false,
            codeEnvRef: {
              kind: 'user',
              id: 'user-1',
              storage_session_id: 'session-1',
              file_id: 'sandbox-fallback-file',
            },
          },
        };
        const { resolveTurnDeliveryRouting } = jest.requireActual('@librechat/api');
        client.options.req.config.fileConfig = {
          endpoints: {
            default: {
              defaultLLMDeliveryPath: { overrides: { 'text/csv': 'none' } },
              textFallbackWithoutTools: true,
            },
          },
        };
        mockAgent.deliveryRouting = resolveTurnDeliveryRouting({
          agent: mockAgent,
          config: client.options.req.config,
        });
        mockAgent.fileConsumers = { executeCode: true, fileSearch: false };
        const handoffAgent = {
          id: 'handoff-agent',
          endpoint: EModelEndpoint.openAI,
          provider: EModelEndpoint.openAI,
          instructions: 'Handoff instructions',
          model_parameters: { model: 'gpt-4' },
          tools: [],
          deliveryRouting: mockAgent.deliveryRouting,
          fileConsumers: { executeCode: false, fileSearch: false },
        };
        const isolatedAgent = { ...handoffAgent, id: 'isolated-agent' };
        mockAgent.subagentAgentConfigs = new Map([['isolated-agent', isolatedAgent]]);
        client.agentConfigs = new Map([['handoff-agent', handoffAgent]]);
        client.options.resendFiles = location !== 'history-disabled';
        client.options.attachments = location === 'current' ? [file] : [];
        client.authorizedHistoricalFiles = new Map([[file.file_id, file]]);
        client.message_file_map = {};
        const messages = [
          {
            messageId: 'msg-1',
            sender: 'User',
            text: 'Read it',
            isCreatedByUser: true,
            ...(location !== 'current' ? { files: [{ file_id: file.file_id }] } : {}),
          },
        ];
        const result = await client.buildMessages(messages, 'msg-1', {});
        expect(JSON.stringify(result.prompt)).not.toContain(file.text);
        expect(mockAgent.additional_instructions ?? '').not.toContain(file.text);
        expect(isolatedAgent.additional_instructions ?? '').not.toContain(file.text);
        if (location === 'history-disabled') {
          expect(handoffAgent.additional_instructions ?? '').not.toContain(file.text);
        } else {
          expect(handoffAgent.additional_instructions).toContain(file.text);
          expect(client.turnScopedAttachmentsByAgentId.get('handoff-agent')).toEqual([
            { ...file, llmDeliveryPath: 'text' },
          ]);
        }
        expect(file.llmDeliveryPath).toBe('none');
      },
    );

    it('places request context inline and applies each agent context doc only once', async () => {
      const requestFile = makeTextFile('request-file', 'request.txt', 'Shared request context');
      const primaryContext = makeTextFile(
        'primary-context',
        'primary.txt',
        'Primary private context',
      );
      const handoffContext = makeTextFile(
        'handoff-context',
        'handoff.txt',
        'Handoff private context',
      );
      const handoffAgent = {
        id: 'handoff-agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Handoff instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [],
      };

      client.options.attachments = [requestFile];
      client.options.agentContextAttachmentsByAgentId = new Map([
        ['primary-agent', [primaryContext]],
        ['handoff-agent', [handoffContext]],
      ]);
      client.agentConfigs = new Map([['handoff-agent', handoffAgent]]);

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Use the available context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      expect(result.prompt[0].content).toContain('Shared request context');

      expect(mockAgent.additional_instructions).toContain('Primary private context');
      expect(mockAgent.additional_instructions).not.toContain('Shared request context');
      expect(mockAgent.additional_instructions).not.toContain('Handoff private context');

      expect(handoffAgent.additional_instructions).toContain('Handoff private context');
      expect(handoffAgent.additional_instructions).not.toContain('Shared request context');
      expect(handoffAgent.additional_instructions).not.toContain('Primary private context');
    });

    it('places current request file context on the latest user message', async () => {
      const currentFile = makeTextFile('current-file', 'current.txt', 'Current turn file body');
      const previousFileContext =
        'Attached document(s):\n```md\n# "previous.txt"\nPrevious turn file body\n```';

      client.options.attachments = [currentFile];

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'What is written here?',
            isCreatedByUser: true,
            fileContext: previousFileContext,
          },
          {
            messageId: 'msg-2',
            parentMessageId: 'msg-1',
            sender: 'Assistant',
            text: 'It describes the previous file.',
            isCreatedByUser: false,
          },
          {
            messageId: 'msg-3',
            parentMessageId: 'msg-2',
            sender: 'User',
            text: 'What is written here?',
            isCreatedByUser: true,
          },
        ],
        'msg-3',
        {},
      );

      expect(result.prompt[0].content).toContain('Previous turn file body');
      expect(result.prompt[2].content).toContain('Current turn file body');
      expect(result.prompt[2].content).toContain('What is written here?');
      expect(result.prompt[2].content).not.toContain('Previous turn file body');
      expect(client.memoryPayload[2].content).toContain('What is written here?');
      expect(client.memoryPayload[2].content).not.toContain('Current turn file body');
      expect(mockAgent.additional_instructions ?? '').not.toContain('Current turn file body');
      expect(result.prompt[2].content.indexOf('Current turn file body')).toBeLessThan(
        result.prompt[2].content.indexOf('What is written here?'),
      );
    });

    it('quote-merges historical steer parts into the prompt AND the memory copy', async () => {
      const previousFileContext =
        'Attached document(s):\n```md\n# "previous.txt"\nPrevious turn file body\n```';

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Summarize.',
            isCreatedByUser: true,
            fileContext: previousFileContext,
          },
          {
            messageId: 'msg-2',
            parentMessageId: 'msg-1',
            sender: 'Assistant',
            text: '',
            isCreatedByUser: false,
            content: [
              { type: ContentTypes.TEXT, text: 'working on it' },
              {
                type: ContentTypes.STEER,
                [ContentTypes.STEER]: 'remember this',
                steerId: 's1',
                quotes: ['the important fact'],
              },
            ],
          },
          {
            messageId: 'msg-3',
            parentMessageId: 'msg-2',
            sender: 'User',
            text: 'Continue.',
            isCreatedByUser: true,
          },
        ],
        'msg-3',
        {},
      );

      const merged = '> the important fact\n\nremember this';
      const promptSteer = result.prompt[1].content.find((part) => part.type === ContentTypes.STEER);
      expect(promptSteer.media).toEqual([{ type: ContentTypes.TEXT, text: merged }]);
      // The memory copy replays through the same formatter, which ignores
      // `part.quotes` — it needs its own merged stamp or memory extraction
      // never sees the excerpt.
      const memorySteer = client.memoryPayload[1].content.find(
        (part) => part.type === ContentTypes.STEER,
      );
      expect(memorySteer.media).toEqual([{ type: ContentTypes.TEXT, text: merged }]);
    });

    it('persists canonical token counts while counting request file context for the prompt', async () => {
      const { countFormattedMessageTokens } = require('@librechat/api');
      const currentFile = makeTextFile('current-file', 'current.txt', 'Current turn file body');

      countFormattedMessageTokens.mockImplementation(({ content }) => {
        const text = Array.isArray(content)
          ? content.map((part) => part.text ?? part[ContentTypes.TEXT] ?? '').join('\n')
          : String(content ?? '');
        return text.includes('Current turn file body') ? 200 : 20;
      });

      client.options.attachments = [currentFile];

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'What is written here?',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      expect(result.prompt[0].content).toContain('Current turn file body');
      expect(result.tokenCountMap['msg-1']).toBe(20);
      expect(result.promptTokens).toBe(200);
      expect(client.indexTokenCountMap[0]).toBe(200);
      expect(client.memoryPayload[0].content).toBe('What is written here?');
    });

    it('recounts a quote-bearing history row from quote-merged content and keeps the memory payload unbuilt without file context', async () => {
      const { countFormattedMessageTokens } = require('@librechat/api');
      countFormattedMessageTokens.mockImplementation(({ content }) => {
        const text = Array.isArray(content)
          ? content.map((part) => part.text ?? part[ContentTypes.TEXT] ?? '').join('\n')
          : String(content ?? '');
        return text.includes('quoted excerpt') ? 77 : 11;
      });

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Discuss this.',
            isCreatedByUser: true,
            tokenCount: 5,
            quotes: ['quoted excerpt'],
          },
          {
            messageId: 'msg-2',
            parentMessageId: 'msg-1',
            sender: 'Assistant',
            text: 'Sure.',
            isCreatedByUser: false,
            tokenCount: 3,
          },
        ],
        'msg-2',
        {},
      );

      expect(result.tokenCountMap['msg-1']).toBe(77);
      expect(result.tokenCountMap['msg-2']).toBe(3);
      expect(client.memoryPayload).toBeNull();
    });

    it('does not duplicate a file that is both request context and scoped context', async () => {
      const sharedFile = makeTextFile('shared-file', 'shared.txt', 'Shared duplicate context');

      client.options.attachments = [sharedFile];
      client.options.agentContextAttachmentsByAgentId = new Map([['primary-agent', [sharedFile]]]);
      client.agentConfigs = new Map();

      const result = await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Use the available context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      const inlineOccurrences = (result.prompt[0].content.match(/Shared duplicate context/g) ?? [])
        .length;
      expect(inlineOccurrences).toBe(1);
      expect(mockAgent.additional_instructions ?? '').not.toContain('Shared duplicate context');
    });

    it('keeps direct chats with context-doc agents working without request attachments', async () => {
      const primaryContext = makeTextFile(
        'primary-context',
        'primary.txt',
        'Direct primary context',
      );

      client.options.agentContextAttachmentsByAgentId = new Map([
        ['primary-agent', [primaryContext]],
      ]);
      client.agentConfigs = new Map();

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Answer from your context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      expect(mockAgent.additional_instructions).toContain('Direct primary context');
    });

    it('hydrates a pure lazy subagent with its own File Context when selected', async () => {
      const childContext = makeTextFile('child-context', 'child.txt', 'Pure child private context');
      const resolvedChild = {
        id: 'pure-child-agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Pure child instructions',
        model_parameters: { model: 'gpt-4' },
        tools: [],
        agentContextAttachments: [childContext],
      };
      const descriptor = {
        id: resolvedChild.id,
        resolve: jest.fn().mockResolvedValue(resolvedChild),
      };
      mockAgent.lazySubagentConfigs = [descriptor];
      client.agentConfigs = new Map();

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Answer from the child context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );
      const resolved = await descriptor.resolve({ signal: new AbortController().signal });

      expect(resolved).toBe(resolvedChild);
      expect(resolvedChild.additional_instructions).toContain('Pure child private context');
      expect(mockAgent.additional_instructions ?? '').not.toContain('Pure child private context');
      expect(mockBuildAgentScopedContext).toHaveBeenLastCalledWith(
        expect.objectContaining({
          agentIds: ['pure-child-agent'],
          attachmentsByAgentId: new Map([['pure-child-agent', [childContext]]]),
        }),
      );
    });

    it('keeps historical steer files in cumulative admission for lazy agents', async () => {
      const historicalSteerFile = {
        ...makeUploadedFile('steer-history', 'steer.pdf', 'application/pdf'),
        bytes: 120 * 1024 * 1024,
      };
      const childContext = {
        ...makeUploadedFile('lazy-context', 'lazy.pdf', 'application/pdf'),
        bytes: 20 * 1024 * 1024,
      };
      const resolvedChild = {
        id: 'lazy-child-agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Lazy child instructions',
        model_parameters: { model: 'gpt-4' },
        tools: [],
        agentContextAttachments: [childContext],
      };
      const descriptor = {
        id: resolvedChild.id,
        resolve: jest.fn().mockResolvedValue(resolvedChild),
      };
      client.modelBoundHistoricalSteerFiles = [historicalSteerFile];
      mockAgent.lazySubagentConfigs = [descriptor];
      client.agentConfigs = new Map();

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Answer from the child context.',
            isCreatedByUser: true,
          },
        ],
        'msg-1',
        {},
      );

      await expect(
        descriptor.resolve({ signal: new AbortController().signal }),
      ).rejects.toMatchObject({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: 'bytes',
      });
    });
  });

  describe('provider-native YouTube file preflight', () => {
    const youtubeUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

    const createClient = ({ provider, filters }) => {
      const req = {
        user: { id: 'user-123' },
        body: { endpoint: EModelEndpoint.agents },
        config: {
          memory: { disabled: true },
          ...(filters && { filters }),
        },
      };
      const client = new AgentClient({
        req,
        res: {},
        endpoint: EModelEndpoint.agents,
        agent: {
          id: `${provider}-agent`,
          endpoint: EModelEndpoint.agents,
          provider,
          instructions: 'Summarize the submitted video.',
          model_parameters: { model: 'gemini-2.5-flash' },
          tools: [{ urlContext: {} }],
        },
      });
      const invokeModel = jest.fn().mockResolvedValue({ completion: [], metadata: {} });

      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
      client.useMemory = jest.fn().mockResolvedValue(undefined);
      client.loadHistory = jest.fn().mockResolvedValue([]);
      client.skipSaveUserMessage = true;
      client.saveMessageToDatabase = jest.fn().mockResolvedValue({});
      client.recordTokenUsage = jest.fn().mockResolvedValue(undefined);
      client.getTokenCountForResponse = jest.fn(() => 0);
      client.sendCompletion = invokeModel;

      return { client, invokeModel };
    };

    const sendYouTubeMessage = (client) =>
      client.sendMessage(`Summarize ${youtubeUrl}`, {
        conversationId: 'youtube-conversation',
        parentMessageId: Constants.NO_PARENT,
        user: 'user-123',
      });

    beforeEach(() => {
      jest.clearAllMocks();
      mockFormatInstructions.mockResolvedValue('');
      require('@librechat/api').countFormattedMessageTokens.mockImplementation(() => 42);
      require('~/models').getFiles.mockReset().mockResolvedValue([]);
      require('~/models').getUserMemories.mockReset().mockResolvedValue([]);
    });

    it.each([Providers.GOOGLE, Providers.VERTEXAI])(
      'blocks a late %s fileUri before model invocation under strict content policy',
      async (provider) => {
        const { client, invokeModel } = createClient({
          provider,
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: [],
                uninspectable: 'block',
              },
            },
          },
        });

        await expect(sendYouTubeMessage(client)).rejects.toMatchObject({
          code: 'content_filter_uninspectable',
          body: { source: 'file', field: 'content' },
        });
        expect(invokeModel).not.toHaveBeenCalled();
      },
    );

    it.each([Providers.GOOGLE, Providers.VERTEXAI])(
      'keeps late %s fileUri compatible when file protection is off',
      async (provider) => {
        const { client, invokeModel } = createClient({ provider });

        await expect(sendYouTubeMessage(client)).resolves.toMatchObject({
          isCreatedByUser: false,
        });
        expect(invokeModel).toHaveBeenCalledTimes(1);
        expect(invokeModel.mock.calls[0][0]).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              role: 'user',
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'media', fileUri: youtubeUrl }),
              ]),
            }),
          ]),
        );
      },
    );

    it('allows a known non-audio Vertex fileUri under transcript-only strict policy', async () => {
      const { client, invokeModel } = createClient({
        provider: Providers.VERTEXAI,
        filters: {
          files: {
            pii: {
              fields: ['transcript'],
              starterPatterns: [],
              uninspectable: 'block',
            },
          },
        },
      });

      await expect(sendYouTubeMessage(client)).resolves.toMatchObject({
        isCreatedByUser: false,
      });
      expect(invokeModel).toHaveBeenCalledTimes(1);
      expect(invokeModel.mock.calls[0][0]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'user',
            content: expect.arrayContaining([
              expect.objectContaining({
                type: 'media',
                mimeType: 'video/mp4',
                fileUri: youtubeUrl,
              }),
            ]),
          }),
        ]),
      );
    });
  });

  describe('runMemory method', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;
    let mockProcessMemory;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: {
          model: 'gpt-4',
        },
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
      };

      // Mock getAppConfig for memory tests
      mockReq.config = {
        memory: {
          messageWindowSize: 3,
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      mockProcessMemory = jest.fn().mockResolvedValue([]);

      client = new AgentClient(mockOptions);
      client.processMemory = mockProcessMemory;
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
    });

    it('should filter out image URLs from message content', async () => {
      const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');
      const messages = [
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'What is in this image?',
            },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                detail: 'auto',
              },
            },
          ],
        }),
        new AIMessage('I can see a small red pixel in the image.'),
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'What about this one?',
            },
            {
              type: 'image_url',
              image_url: {
                url: 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/',
                detail: 'high',
              },
            },
          ],
        }),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Verify the buffer message was created
      expect(processedMessage.constructor.name).toBe('HumanMessage');
      expect(processedMessage.content).toContain('# Current Chat:');

      // Verify that image URLs are not in the buffer string
      expect(processedMessage.content).not.toContain('image_url');
      expect(processedMessage.content).not.toContain('data:image');
      expect(processedMessage.content).not.toContain('base64');

      // Verify text content is preserved
      expect(processedMessage.content).toContain('What is in this image?');
      expect(processedMessage.content).toContain('I can see a small red pixel in the image.');
      expect(processedMessage.content).toContain('What about this one?');
    });

    it('should handle messages with only text content', async () => {
      const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');
      const messages = [
        new HumanMessage('Hello, how are you?'),
        new AIMessage('I am doing well, thank you!'),
        new HumanMessage('That is great to hear.'),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      expect(processedMessage.content).toContain('Hello, how are you?');
      expect(processedMessage.content).toContain('I am doing well, thank you!');
      expect(processedMessage.content).toContain('That is great to hear.');
    });

    it('should keep original roles separate for content policy inspection', async () => {
      const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');
      const messages = [new HumanMessage('Safe user input'), new AIMessage('PRIVATE-MODEL-OUTPUT')];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const [flattenedMessages, inspectionMessages] = mockProcessMemory.mock.calls[0];
      expect(flattenedMessages).toHaveLength(1);
      expect(flattenedMessages[0].constructor.name).toBe('HumanMessage');
      expect(flattenedMessages[0].content).toContain('PRIVATE-MODEL-OUTPUT');
      expect(inspectionMessages).toHaveLength(2);
      expect(inspectionMessages[0].constructor.name).toBe('HumanMessage');
      expect(inspectionMessages[0].content).toBe('Safe user input');
      expect(inspectionMessages[1].constructor.name).toBe('AIMessage');
      expect(inspectionMessages[1].content).toBe('PRIVATE-MODEL-OUTPUT');
    });

    it('should handle mixed content types correctly', async () => {
      const { HumanMessage } = require('@librechat/agents/langchain/messages');
      const { ContentTypes } = require('librechat-data-provider');

      const messages = [
        new HumanMessage({
          content: [
            {
              type: 'text',
              text: 'Here is some text',
            },
            {
              type: ContentTypes.IMAGE_URL,
              image_url: {
                url: 'https://example.com/image.png',
              },
            },
            {
              type: 'text',
              text: ' and more text',
            },
          ],
        }),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Should contain text parts but not image URLs
      expect(processedMessage.content).toContain('Here is some text');
      expect(processedMessage.content).toContain('and more text');
      expect(processedMessage.content).not.toContain('example.com/image.png');
      expect(processedMessage.content).not.toContain('IMAGE_URL');
    });

    it('should preserve original messages without mutation', async () => {
      const { HumanMessage } = require('@librechat/agents/langchain/messages');
      const originalContent = [
        {
          type: 'text',
          text: 'Original text',
        },
        {
          type: 'image_url',
          image_url: {
            url: 'data:image/png;base64,ABC123',
          },
        },
      ];

      const messages = [
        new HumanMessage({
          content: [...originalContent],
        }),
      ];

      await client.runMemory(messages);

      // Verify original message wasn't mutated
      expect(messages[0].content).toHaveLength(2);
      expect(messages[0].content[1].type).toBe('image_url');
      expect(messages[0].content[1].image_url.url).toBe('data:image/png;base64,ABC123');
    });

    it('should handle message window size correctly', async () => {
      const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');
      const messages = [
        new HumanMessage('Message 1'),
        new AIMessage('Response 1'),
        new HumanMessage('Message 2'),
        new AIMessage('Response 2'),
        new HumanMessage('Message 3'),
        new AIMessage('Response 3'),
      ];

      // Window size is set to 3 in mockReq
      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      // Should only include last 3 messages due to window size
      expect(processedMessage.content).toContain('Message 3');
      expect(processedMessage.content).toContain('Response 3');
      expect(processedMessage.content).not.toContain('Message 1');
      expect(processedMessage.content).not.toContain('Response 1');
    });

    it('should cap memory input tokens and preserve recent content', async () => {
      const { HumanMessage, AIMessage } = require('@librechat/agents/langchain/messages');
      mockReq.config.memory.maxInputTokens = 12;
      const messages = [
        new HumanMessage(`OLDER_CONTENT ${'a'.repeat(600)}`),
        new AIMessage('Intermediate response'),
        new HumanMessage('Please remember LATEST_MEMORY_MARKER'),
      ];

      await client.runMemory(messages);

      expect(mockProcessMemory).toHaveBeenCalledTimes(1);
      const processedMessage = mockProcessMemory.mock.calls[0][0][0];

      expect(processedMessage.content).toContain('LATEST_MEMORY_MARKER');
      expect(processedMessage.content).not.toContain('OLDER_CONTENT');
      expect(Math.ceil(processedMessage.content.length / 4)).toBeLessThanOrEqual(12);
    });

    it('should return early if processMemory is not set', async () => {
      const { HumanMessage } = require('@librechat/agents/langchain/messages');
      client.processMemory = null;

      const result = await client.runMemory([new HumanMessage('Test')]);

      expect(result).toBeUndefined();
      expect(mockProcessMemory).not.toHaveBeenCalled();
    });

    it('should contain automatic memory rejection and log only bounded metadata', async () => {
      const { HumanMessage } = require('@librechat/agents/langchain/messages');
      const { logger } = require('@librechat/data-schemas');
      const sensitiveValue = 'PRIVATE-MEMORY-REJECTION-CONTENT';
      const contentFilterError = new Error(sensitiveValue);
      contentFilterError.code = 'content_filter_block';
      mockProcessMemory.mockRejectedValueOnce(contentFilterError);
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);

      try {
        await expect(client.runMemory([new HumanMessage('Safe message')])).resolves.toBeUndefined();

        expect(mockProcessMemory).toHaveBeenCalledTimes(1);
        expect(errorSpy).toHaveBeenCalledWith('Memory Agent failed to process memory', {
          type: 'Error',
        });
        expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(sensitiveValue);
      } finally {
        errorSpy.mockRestore();
      }
    });
  });

  describe('getMessagesForConversation - mapMethod and mapCondition', () => {
    const createMessage = (id, parentId, text, extras = {}) => ({
      messageId: id,
      parentMessageId: parentId,
      text,
      isCreatedByUser: false,
      ...extras,
    });

    it('should apply mapMethod to all messages when mapCondition is not provided', () => {
      const messages = [
        createMessage('msg-1', null, 'First message'),
        createMessage('msg-2', 'msg-1', 'Second message'),
        createMessage('msg-3', 'msg-2', 'Third message'),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-3',
        mapMethod,
      });

      expect(result).toHaveLength(3);
      expect(mapMethod).toHaveBeenCalledTimes(3);
      result.forEach((msg) => {
        expect(msg.mapped).toBe(true);
      });
    });

    it('should apply mapMethod only to messages where mapCondition returns true', () => {
      const messages = [
        createMessage('msg-1', null, 'First message', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second message', { addedConvo: true }),
        createMessage('msg-3', 'msg-2', 'Third message', { addedConvo: true }),
        createMessage('msg-4', 'msg-3', 'Fourth message', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(4);
      expect(mapMethod).toHaveBeenCalledTimes(2);

      expect(result[0].mapped).toBeUndefined();
      expect(result[1].mapped).toBe(true);
      expect(result[2].mapped).toBe(true);
      expect(result[3].mapped).toBeUndefined();
    });

    it('should not apply mapMethod when mapCondition returns false for all messages', () => {
      const messages = [
        createMessage('msg-1', null, 'First message', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second message', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(2);
      expect(mapMethod).not.toHaveBeenCalled();
      result.forEach((msg) => {
        expect(msg.mapped).toBeUndefined();
      });
    });

    it('should not call mapMethod when mapMethod is null', () => {
      const messages = [
        createMessage('msg-1', null, 'First message'),
        createMessage('msg-2', 'msg-1', 'Second message'),
      ];

      const mapCondition = jest.fn(() => true);

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod: null,
        mapCondition,
      });

      expect(result).toHaveLength(2);
      expect(mapCondition).not.toHaveBeenCalled();
    });

    it('should handle mapCondition with complex logic', () => {
      const messages = [
        createMessage('msg-1', null, 'User message', { isCreatedByUser: true, addedConvo: true }),
        createMessage('msg-2', 'msg-1', 'Assistant response', { addedConvo: true }),
        createMessage('msg-3', 'msg-2', 'Another user message', { isCreatedByUser: true }),
        createMessage('msg-4', 'msg-3', 'Another response', { addedConvo: true }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, processed: true }));
      const mapCondition = (msg) => msg.addedConvo === true && !msg.isCreatedByUser;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(4);
      expect(mapMethod).toHaveBeenCalledTimes(2);

      expect(result[0].processed).toBeUndefined();
      expect(result[1].processed).toBe(true);
      expect(result[2].processed).toBeUndefined();
      expect(result[3].processed).toBe(true);
    });

    it('should preserve message order after applying mapMethod with mapCondition', () => {
      const messages = [
        createMessage('msg-1', null, 'First', { addedConvo: true }),
        createMessage('msg-2', 'msg-1', 'Second', { addedConvo: false }),
        createMessage('msg-3', 'msg-2', 'Third', { addedConvo: true }),
      ];

      const mapMethod = (msg) => ({ ...msg, text: `[MAPPED] ${msg.text}` });
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-3',
        mapMethod,
        mapCondition,
      });

      expect(result[0].text).toBe('[MAPPED] First');
      expect(result[1].text).toBe('Second');
      expect(result[2].text).toBe('[MAPPED] Third');
    });

    it('should work with summary option alongside mapMethod and mapCondition', () => {
      const messages = [
        createMessage('msg-1', null, 'First', { addedConvo: false }),
        createMessage('msg-2', 'msg-1', 'Second', {
          summary: 'Summary of conversation',
          addedConvo: true,
        }),
        createMessage('msg-3', 'msg-2', 'Third', { addedConvo: true }),
        createMessage('msg-4', 'msg-3', 'Fourth', { addedConvo: false }),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));
      const mapCondition = (msg) => msg.addedConvo === true;

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-4',
        mapMethod,
        mapCondition,
        summary: true,
      });

      /** Traversal stops at msg-2 (has summary), so we get msg-4 -> msg-3 -> msg-2 */
      expect(result).toHaveLength(3);
      expect(result[0].content).toEqual([{ type: 'text', text: 'Summary of conversation' }]);
      expect(result[0].role).toBe('system');
      expect(result[0].mapped).toBe(true);
      expect(result[1].mapped).toBe(true);
      expect(result[2].mapped).toBeUndefined();
    });

    it('should handle empty messages array', () => {
      const mapMethod = jest.fn();
      const mapCondition = jest.fn();

      const result = AgentClient.getMessagesForConversation({
        messages: [],
        parentMessageId: 'msg-1',
        mapMethod,
        mapCondition,
      });

      expect(result).toHaveLength(0);
      expect(mapMethod).not.toHaveBeenCalled();
      expect(mapCondition).not.toHaveBeenCalled();
    });

    it('should handle undefined mapCondition explicitly', () => {
      const messages = [
        createMessage('msg-1', null, 'First'),
        createMessage('msg-2', 'msg-1', 'Second'),
      ];

      const mapMethod = jest.fn((msg) => ({ ...msg, mapped: true }));

      const result = AgentClient.getMessagesForConversation({
        messages,
        parentMessageId: 'msg-2',
        mapMethod,
        mapCondition: undefined,
      });

      expect(result).toHaveLength(2);
      expect(mapMethod).toHaveBeenCalledTimes(2);
      result.forEach((msg) => {
        expect(msg.mapped).toBe(true);
      });
    });
  });

  describe('buildMessages - memory context for parallel agents', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'primary-agent',
        name: 'Primary Agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Primary agent instructions',
        model_parameters: {
          model: 'gpt-4',
        },
        tools: [],
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
        body: {
          endpoint: EModelEndpoint.openAI,
        },
        config: {
          memory: {
            disabled: false,
          },
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
        endpoint: EModelEndpoint.agents,
      };

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';
      client.shouldSummarize = false;
      client.maxContextTokens = 4096;
    });

    it('should only pass memory context to the primary agent by default', async () => {
      const memoryContent = 'User prefers dark mode. User is a software developer.';
      client.useMemory = jest
        .fn()
        .mockResolvedValue({ withKeys: memoryContent, withoutKeys: memoryContent });

      const parallelAgent1 = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Parallel agent 1 instructions',
        provider: EModelEndpoint.openAI,
      };

      const parallelAgent2 = {
        id: 'parallel-agent-2',
        name: 'Parallel Agent 2',
        instructions: 'Parallel agent 2 instructions',
        provider: EModelEndpoint.anthropic,
      };

      client.agentConfigs = new Map([
        ['parallel-agent-1', parallelAgent1],
        ['parallel-agent-2', parallelAgent2],
      ]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(client.useMemory).toHaveBeenCalled();

      expect(client.options.agent.instructions).toContain('Primary agent instructions');
      expect(client.options.agent.instructions).not.toContain(memoryContent);
      expect(client.options.agent.additional_instructions).toContain(memoryContent);

      expect(parallelAgent1.instructions).toContain('Parallel agent 1 instructions');
      expect(parallelAgent1.instructions).not.toContain(memoryContent);
      expect(parallelAgent1.additional_instructions ?? '').not.toContain(memoryContent);

      expect(parallelAgent2.instructions).toContain('Parallel agent 2 instructions');
      expect(parallelAgent2.instructions).not.toContain(memoryContent);
      expect(parallelAgent2.additional_instructions ?? '').not.toContain(memoryContent);
    });

    it('tells the primary read-only agent about persistent memory when the store is empty', async () => {
      const { memoryInstructions } = require('@librechat/api');
      client.useMemory = jest.fn().mockResolvedValue({ withKeys: '', withoutKeys: '' });
      const parallelAgent = {
        id: 'parallel-agent-1',
        instructions: 'Parallel instructions',
        provider: EModelEndpoint.openAI,
      };
      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Remember that I like tea',
            isCreatedByUser: true,
          },
        ],
        null,
        { instructions: 'Base instructions', additional_instructions: null },
      );

      expect(client.options.agent.additional_instructions).toContain(memoryInstructions);
      expect(client.options.agent.additional_instructions).not.toContain('# Existing memory');
      expect(client.options.agent.additional_instructions).not.toContain('set_memory');
      expect(parallelAgent.additional_instructions ?? '').not.toContain(memoryInstructions);
    });

    it('keeps memory guidance out of agents when memory was unavailable', async () => {
      const { memoryInstructions } = require('@librechat/api');
      client.useMemory = jest.fn().mockResolvedValue(undefined);
      client.agentConfigs = new Map();

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Hello',
            isCreatedByUser: true,
          },
        ],
        null,
        { instructions: 'Base instructions', additional_instructions: null },
      );

      expect(client.options.agent.additional_instructions ?? '').not.toContain(memoryInstructions);
    });

    it('provides empty-state memory guidance to parallel agents when automatic extraction is on', async () => {
      const { memoryInstructions } = require('@librechat/api');
      client.useMemory = jest.fn().mockResolvedValue({ withKeys: '', withoutKeys: '' });
      mockReq.config.memory.agent = { enabled: true, id: 'memory-agent' };
      const parallelAgent = {
        id: 'parallel-agent-1',
        instructions: 'Parallel instructions',
        provider: EModelEndpoint.openAI,
      };
      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Remember that I like tea',
            isCreatedByUser: true,
          },
        ],
        null,
        { instructions: 'Base instructions', additional_instructions: null },
      );

      expect(client.options.agent.additional_instructions).toContain(memoryInstructions);
      expect(parallelAgent.additional_instructions).toContain(memoryInstructions);
      expect(parallelAgent.additional_instructions).not.toContain('# Existing memory');
    });

    it('applies scoped context to graph-only members without promoting them', async () => {
      client.useMemory = jest.fn().mockResolvedValue(undefined);
      const graphMember = {
        id: 'graph-member',
        name: 'Graph Member',
        instructions: 'Graph member instructions',
        provider: EModelEndpoint.openAI,
      };
      mockAgent.subagentGraphConfigs = [
        {
          definition: { type: 'review_team' },
          memberConfigs: [mockAgent, graphMember],
        },
      ];
      client.agentConfigs = new Map();
      mockBuildAgentScopedContext.mockResolvedValueOnce(
        new Map([['graph-member', 'Graph member context']]),
      );

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Hello',
            isCreatedByUser: true,
          },
        ],
        null,
        { instructions: 'Base instructions', additional_instructions: null },
      );

      expect(mockBuildAgentScopedContext).toHaveBeenCalledWith(
        expect.objectContaining({ agentIds: ['primary-agent', 'graph-member'] }),
      );
      expect(graphMember.additional_instructions).toContain('Graph member context');
      expect(client.agentConfigs).toEqual(new Map());
    });

    it('applies scoped context to graph members resolved by a lazy child', async () => {
      client.useMemory = jest.fn().mockResolvedValue(undefined);
      const graphMember = {
        id: 'lazy-graph-member',
        name: 'Lazy Graph Member',
        instructions: 'Lazy graph member instructions',
        provider: EModelEndpoint.openAI,
      };
      const resolvedChild = {
        id: 'lazy-child',
        name: 'Lazy Child',
        instructions: 'Lazy child instructions',
        provider: EModelEndpoint.openAI,
        subagentGraphConfigs: [
          {
            definition: { type: 'lazy_team' },
            memberConfigs: [graphMember],
          },
        ],
      };
      const descriptor = {
        id: 'lazy-child',
        resolve: jest.fn().mockResolvedValue(resolvedChild),
      };
      mockAgent.lazySubagentConfigs = [descriptor];
      client.agentConfigs = new Map();
      mockBuildAgentScopedContext.mockResolvedValueOnce(new Map()).mockResolvedValueOnce(
        new Map([
          ['lazy-child', 'Lazy child context'],
          ['lazy-graph-member', 'Lazy graph member context'],
        ]),
      );

      await client.buildMessages(
        [
          {
            messageId: 'msg-1',
            parentMessageId: null,
            sender: 'User',
            text: 'Hello',
            isCreatedByUser: true,
          },
        ],
        null,
        { instructions: 'Base instructions', additional_instructions: null },
      );
      const resolved = await descriptor.resolve({ signal: new AbortController().signal });

      expect(resolved).toBe(resolvedChild);
      expect(resolvedChild.additional_instructions).toContain('Lazy child context');
      expect(graphMember.additional_instructions).toContain('Lazy graph member context');
      expect(mockBuildAgentScopedContext).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentIds: ['lazy-child', 'lazy-graph-member'] }),
      );
    });

    it('should pass memory context to parallel agents when automatic memory updates are enabled', async () => {
      const memoryContent = 'User prefers dark mode. User is a software developer.';
      client.useMemory = jest
        .fn()
        .mockResolvedValue({ withKeys: memoryContent, withoutKeys: memoryContent });
      mockReq.config.memory.agent = {
        enabled: true,
        id: 'memory-agent',
      };

      const parallelAgent = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Parallel agent instructions',
        provider: EModelEndpoint.openAI,
      };

      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(client.options.agent.instructions).toContain('Primary agent instructions');
      expect(client.options.agent.instructions).not.toContain(memoryContent);
      expect(client.options.agent.additional_instructions).toContain(memoryContent);

      expect(parallelAgent.instructions).toContain('Parallel agent instructions');
      expect(parallelAgent.instructions).not.toContain(memoryContent);
      expect(parallelAgent.additional_instructions).toContain(memoryContent);
    });

    it('should not modify parallel agents when no memory context is available', async () => {
      client.useMemory = jest.fn().mockResolvedValue(undefined);

      const parallelAgent = {
        id: 'parallel-agent-1',
        name: 'Parallel Agent 1',
        instructions: 'Original parallel instructions',
        provider: EModelEndpoint.openAI,
      };

      client.agentConfigs = new Map([['parallel-agent-1', parallelAgent]]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: 'Base instructions',
        additional_instructions: null,
      });

      expect(parallelAgent.instructions).toBe('Original parallel instructions');
    });

    it('should handle parallel agents without existing instructions when memory stays primary-only', async () => {
      const memoryContent = 'User is a data scientist.';
      client.useMemory = jest
        .fn()
        .mockResolvedValue({ withKeys: memoryContent, withoutKeys: memoryContent });

      const parallelAgentNoInstructions = {
        id: 'parallel-agent-no-instructions',
        name: 'Parallel Agent No Instructions',
        provider: EModelEndpoint.openAI,
      };

      client.agentConfigs = new Map([
        ['parallel-agent-no-instructions', parallelAgentNoInstructions],
      ]);

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await client.buildMessages(messages, null, {
        instructions: null,
        additional_instructions: null,
      });

      expect(client.options.agent.additional_instructions).toContain(memoryContent);
      expect(parallelAgentNoInstructions.instructions).toBeUndefined();
      expect(parallelAgentNoInstructions.additional_instructions ?? '').not.toContain(
        memoryContent,
      );
    });

    it('should not modify agentConfigs when none exist', async () => {
      const memoryContent = 'User prefers concise responses.';
      client.useMemory = jest
        .fn()
        .mockResolvedValue({ withKeys: memoryContent, withoutKeys: memoryContent });

      client.agentConfigs = null;

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await expect(
        client.buildMessages(messages, null, {
          instructions: 'Base instructions',
          additional_instructions: null,
        }),
      ).resolves.not.toThrow();

      expect(client.options.agent.additional_instructions).toContain(memoryContent);
    });

    it('should handle empty agentConfigs map', async () => {
      const memoryContent = 'User likes detailed explanations.';
      client.useMemory = jest
        .fn()
        .mockResolvedValue({ withKeys: memoryContent, withoutKeys: memoryContent });

      client.agentConfigs = new Map();

      const messages = [
        {
          messageId: 'msg-1',
          parentMessageId: null,
          sender: 'User',
          text: 'Hello',
          isCreatedByUser: true,
        },
      ];

      await expect(
        client.buildMessages(messages, null, {
          instructions: 'Base instructions',
          additional_instructions: null,
        }),
      ).resolves.not.toThrow();

      expect(client.options.agent.additional_instructions).toContain(memoryContent);
    });
  });

  describe('useMemory method - prelimAgent assignment', () => {
    let client;
    let mockReq;
    let mockRes;
    let mockAgent;
    let mockOptions;
    let mockCheckAccess;
    let mockLoadAgent;
    let mockInitializeAgent;
    let mockCreateMemoryProcessor;
    let mockGetFormattedMemories;

    beforeEach(() => {
      jest.clearAllMocks();

      mockAgent = {
        id: 'agent-123',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        instructions: 'Test instructions',
        model: 'gpt-4',
        model_parameters: {
          model: 'gpt-4',
        },
      };

      mockReq = {
        user: {
          id: 'user-123',
          personalization: {
            memories: true,
          },
        },
        config: {
          memory: {
            agent: {
              enabled: true,
              id: 'agent-123',
            },
          },
          endpoints: {
            [EModelEndpoint.agents]: {
              allowedProviders: [EModelEndpoint.openAI],
            },
          },
        },
      };

      mockRes = {};

      mockOptions = {
        req: mockReq,
        res: mockRes,
        agent: mockAgent,
      };

      mockCheckAccess = require('@librechat/api').checkAccess;
      mockLoadAgent = require('@librechat/api').loadAgent;
      mockInitializeAgent = require('@librechat/api').initializeAgent;
      mockCreateMemoryProcessor = require('@librechat/api').createMemoryProcessor;
      mockGetFormattedMemories = require('~/models').getFormattedMemories;
      mockGetFormattedMemories.mockResolvedValue({
        withKeys: '',
        withoutKeys: '',
        totalTokens: 0,
      });
    });

    it('should use current agent when memory config agent.id matches current agent id', async () => {
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        ...mockAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: mockAgent,
        }),
        expect.any(Object),
      );
    });

    it('should bind memory processing to the current generation epoch', async () => {
      mockReq._resumableStreamId = 'convo-123';
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        ...mockAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient({ ...mockOptions, jobCreatedAt: 1234 });
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockCreateMemoryProcessor).toHaveBeenCalledWith(
        expect.objectContaining({
          streamId: 'convo-123',
          jobCreatedAt: 1234,
        }),
      );
    });

    it('should pass only source-aware filters to automatic memory processing', async () => {
      const filters = {
        memories: {
          pii: {
            fields: ['value'],
          },
        },
      };
      const legacyPii = {
        starterPatterns: ['email'],
      };
      mockReq.config.filters = filters;
      mockReq.config.messageFilter = { pii: legacyPii };
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        ...mockAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockCreateMemoryProcessor).toHaveBeenCalledWith(
        expect.objectContaining({
          filters,
        }),
      );
      expect(mockCreateMemoryProcessor.mock.calls[0][0]).not.toHaveProperty('legacyPii');
      expect(mockCreateMemoryProcessor.mock.calls[0][0]).not.toHaveProperty('contentInspection');
    });

    it('should load different agent when memory config agent.id differs from current agent id', async () => {
      const differentAgentId = 'different-agent-456';
      const differentAgent = {
        id: differentAgentId,
        provider: EModelEndpoint.openAI,
        model: 'gpt-4',
        instructions: 'Different agent instructions',
      };

      mockReq.config.memory.agent.id = differentAgentId;

      mockCheckAccess.mockResolvedValue(true);
      mockLoadAgent.mockResolvedValue(differentAgent);
      mockInitializeAgent.mockResolvedValue({
        ...differentAgent,
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent_id: differentAgentId,
        }),
        expect.any(Object),
      );
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: differentAgent,
        }),
        expect.any(Object),
      );
    });

    it('retains automatic memory extraction when the first conversation has no memories', async () => {
      const processMemory = jest.fn();
      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({ ...mockAgent });
      mockCreateMemoryProcessor.mockResolvedValue(['', processMemory]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await expect(client.useMemory()).resolves.toEqual({ withKeys: '', withoutKeys: '' });
      expect(mockCreateMemoryProcessor).toHaveBeenCalledTimes(1);
      expect(client.processMemory).toBe(processMemory);
    });

    it('should return existing memories without auto-processing when memory agent is not enabled', async () => {
      mockReq.config.memory = {
        personalize: true,
      };

      mockCheckAccess.mockResolvedValue(true);
      mockGetFormattedMemories.mockResolvedValue({
        withKeys: 'food: likes pasta',
        withoutKeys: 'likes pasta',
        totalTokens: 3,
      });

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toEqual({ withKeys: 'food: likes pasta', withoutKeys: 'likes pasta' });
      expect(mockGetFormattedMemories).toHaveBeenCalledWith({ userId: 'user-123' });
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
      expect(client.processMemory).toBeUndefined();
    });

    it('should not initialize auto-processing when no memories exist', async () => {
      mockReq.config.memory = {
        personalize: true,
      };

      mockCheckAccess.mockResolvedValue(true);
      mockGetFormattedMemories.mockResolvedValue({
        withKeys: '',
        withoutKeys: '',
        totalTokens: 0,
      });

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toEqual({ withKeys: '', withoutKeys: '' });
      expect(mockGetFormattedMemories).toHaveBeenCalledWith({ userId: 'user-123' });
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
      expect(client.processMemory).toBeUndefined();
    });

    it('does not interpret a failed memory read as an eligible empty store', async () => {
      mockReq.config.memory = { personalize: true };
      mockCheckAccess.mockResolvedValue(true);
      mockGetFormattedMemories.mockResolvedValue({
        readFailed: true,
        withKeys: undefined,
        withoutKeys: undefined,
        totalTokens: 0,
      });

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toEqual({ withKeys: undefined, withoutKeys: undefined });
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
      expect(client.processMemory).toBeUndefined();
      const { formatMemoryContext } = require('@librechat/api');
      expect(formatMemoryContext(result.withoutKeys)).toBeUndefined();
    });

    it('should return existing memories without auto-processing when memory agent config lacks explicit enablement', async () => {
      mockReq.config.memory.agent = {
        id: 'agent-123',
      };

      mockCheckAccess.mockResolvedValue(true);
      mockGetFormattedMemories.mockResolvedValue({
        withKeys: 'tone: concise',
        withoutKeys: 'prefers concise answers',
        totalTokens: 4,
      });

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toEqual({ withKeys: 'tone: concise', withoutKeys: 'prefers concise answers' });
      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
    });

    it('should return undefined when loading memories fails without auto-processing', async () => {
      const { logger } = require('@librechat/data-schemas');
      const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
      mockReq.config.memory = {
        personalize: true,
      };

      mockCheckAccess.mockResolvedValue(true);
      mockGetFormattedMemories.mockRejectedValue(new Error('DB connection failed'));

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      const result = await client.useMemory();

      expect(result).toBeUndefined();
      expect(mockGetFormattedMemories).toHaveBeenCalledWith({ userId: 'user-123' });
      expect(mockInitializeAgent).not.toHaveBeenCalled();
      expect(mockCreateMemoryProcessor).not.toHaveBeenCalled();
      expect(client.processMemory).toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        '[api/server/controllers/agents/client.js #useMemory] Error loading memories',
        { type: 'Error' },
      );
      expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('DB connection failed');
      errorSpy.mockRestore();
    });

    it('should create ephemeral agent when no id but model and provider are specified', async () => {
      mockReq.config.memory = {
        agent: {
          enabled: true,
          model: 'gpt-4',
          provider: EModelEndpoint.openAI,
        },
      };

      mockCheckAccess.mockResolvedValue(true);
      mockInitializeAgent.mockResolvedValue({
        id: Constants.EPHEMERAL_AGENT_ID,
        model: 'gpt-4',
        provider: EModelEndpoint.openAI,
      });
      mockCreateMemoryProcessor.mockResolvedValue([undefined, jest.fn()]);

      client = new AgentClient(mockOptions);
      client.conversationId = 'convo-123';
      client.responseMessageId = 'response-123';

      await client.useMemory();

      expect(mockLoadAgent).not.toHaveBeenCalled();
      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: expect.objectContaining({
            id: Constants.EPHEMERAL_AGENT_ID,
            model: 'gpt-4',
            provider: EModelEndpoint.openAI,
          }),
        }),
        expect.any(Object),
      );
    });
  });
});

describe('AgentClient - finalizeSubagentContent', () => {
  /** Verifies the backend persistence path: per-subagent
   *  `createContentAggregator` instances (populated by the callbacks
   *  ON_SUBAGENT_UPDATE handler) have their `contentParts` harvested
   *  onto the matching parent `subagent` tool_call at message-save time
   *  so a page refresh shows the same activity the user saw live. */
  const { GraphEvents } = jest.requireActual('@librechat/agents');
  const { getDefaultHandlers } = require('./callbacks');

  const makeClient = (subagentAggregatorsByToolCallId) => {
    const client = new AgentClient({
      req: { user: { id: 'u' }, body: {}, config: { endpoints: {} } },
      res: {},
      agent: {
        id: 'agent',
        endpoint: EModelEndpoint.openAI,
        provider: EModelEndpoint.openAI,
        model_parameters: { model: 'gpt-4' },
      },
      contentParts: [],
      subagentAggregatorsByToolCallId,
    });
    return client;
  };

  const event = (phase, data, parentToolCallId = 'call_sub') => ({
    runId: 'parent-run',
    subagentRunId: 'child-run',
    subagentType: 'self',
    subagentAgentId: 'child',
    parentToolCallId,
    phase,
    data,
    timestamp: '2026-04-17T00:00:00Z',
  });

  /** Feeds a SubagentUpdateEvent sequence through the real
   *  `ON_SUBAGENT_UPDATE` handler so we exercise the same get-or-create
   *  aggregator logic the live request uses, rather than constructing
   *  aggregators directly in the test. */
  const runSubagentEvents = async (events, resolveMcpServerName) => {
    const map = new Map();
    const handlers = getDefaultHandlers({
      res: { write: jest.fn(), writableEnded: false },
      aggregateContent: jest.fn(),
      toolEndCallback: jest.fn(),
      collectedUsage: [],
      subagentAggregatorsByToolCallId: map,
      resolveMcpServerName,
    });
    const handler = handlers[GraphEvents.ON_SUBAGENT_UPDATE];
    for (const e of events) {
      await handler.handle(GraphEvents.ON_SUBAGENT_UPDATE, e);
    }
    return map;
  };

  it.each(['agent', 'graph'])(
    'persists %s identity even when the child has no content',
    async (subagentKind) => {
      const identity = {
        subagentKind,
        subagentAgentId: subagentKind === 'graph' ? 'graph:agent-1' : 'agent-1',
      };
      const buffer = await runSubagentEvents([
        { ...event('start', undefined), ...identity, subagentType: 'agent-1' },
        { ...event('error', undefined), ...identity, subagentType: 'agent-1' },
      ]);
      const client = makeClient(buffer);
      client.contentParts = [
        { type: 'tool_call', tool_call: { id: 'unrelated', name: Constants.SUBAGENT } },
        { type: 'tool_call', tool_call: { id: 'call_sub', name: Constants.SUBAGENT } },
      ];
      client.finalizeSubagentContent();
      expect(client.contentParts[0].tool_call.subagentIdentity).toBeUndefined();
      expect(client.contentParts[1].tool_call.subagentIdentity).toEqual(identity);
      expect(buffer.size).toBe(0);
    },
  );

  it('attaches aggregated subagent_content to the matching subagent tool_call part', async () => {
    const buffer = await runSubagentEvents([
      event('run_step', {
        id: 'step_msg',
        index: 0,
        stepDetails: { type: 'message_creation' },
      }),
      event('message_delta', {
        id: 'step_msg',
        delta: { content: [{ type: 'text', text: 'Hello ' }] },
      }),
      event('message_delta', {
        id: 'step_msg',
        delta: { content: [{ type: 'text', text: 'world!' }] },
      }),
      event('run_step', {
        id: 'step_tool',
        index: 1,
        stepDetails: {
          type: 'tool_calls',
          tool_calls: [{ id: 'inner_1', name: 'calculator', args: '{}' }],
        },
      }),
      event('run_step_completed', {
        id: 'step_tool',
        index: 1,
        result: {
          id: 'step_tool',
          type: 'tool_call',
          tool_call: {
            id: 'inner_1',
            name: 'calculator',
            output: '4',
            progress: 1,
          },
        },
      }),
    ]);

    const client = makeClient(buffer);
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: {
          id: 'call_sub',
          name: Constants.SUBAGENT,
          args: '{}',
          output: 'final text',
          progress: 1,
        },
      },
    ];

    client.finalizeSubagentContent();

    const attached = client.contentParts[0].tool_call.subagent_content;
    expect(Array.isArray(attached)).toBe(true);
    expect(attached).toHaveLength(2);
    expect(attached[0].type).toBe('text');
    expect(attached[0].text).toBe('Hello world!');
    expect(attached[1].type).toBe('tool_call');
    expect(attached[1].tool_call.name).toBe('calculator');
    expect(attached[1].tool_call.output).toBe('4');
    /** Buffer drained so a second call (e.g. resumable retry) doesn't
     *  double-append. */
    expect(buffer.size).toBe(0);
  });

  it('stamps durable MCP server identity onto nested persisted tool calls', () => {
    const client = makeClient(new Map());
    client.options.agent.accessibleMcpServerNames = ['bar', 'foo_mcp_bar'];
    client.options.agent.toolDefinitions = [
      {
        name: 'gitlab-get_mcp_server_version_mcp_bar',
        serverName: 'bar',
      },
    ];
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: {
          name: Constants.SUBAGENT,
          subagent_content: [
            {
              type: 'tool_call',
              tool_call: { name: 'gitlab-get_mcp_server_version_mcp_bar' },
            },
          ],
        },
      },
    ];

    client.stampMcpServerIdentities();

    expect(client.contentParts[0].tool_call.subagent_content[0].tool_call.mcpServerName).toBe(
      'bar',
    );
  });

  it('retains the resolved lazy-agent MCP identity for an ambiguous nested key', async () => {
    const resolveMcpServerName = jest.fn(() => 'bar');
    const buffer = await runSubagentEvents(
      [
        {
          ...event('run_step', {
            id: 'step_tool',
            index: 0,
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [
                {
                  id: 'inner_1',
                  function: { name: 'lookup_mcp_foo_mcp_bar', arguments: '{}' },
                },
              ],
            },
          }),
          memberAgentId: 'member',
        },
      ],
      resolveMcpServerName,
    );
    const client = makeClient(buffer);
    client.options.agent.accessibleMcpServerNames = ['bar', 'foo_mcp_bar'];
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: { id: 'call_sub', name: Constants.SUBAGENT, args: '{}' },
      },
    ];

    client.finalizeSubagentContent();
    const inner = client.contentParts[0].tool_call.subagent_content[0].tool_call;
    expect(resolveMcpServerName).toHaveBeenCalledWith('lookup_mcp_foo_mcp_bar', 'member');
    expect(inner.mcpServerName).toBe('bar');

    const emptyMemberResolver = jest.fn(() => 'bar');
    await runSubagentEvents(
      [
        {
          ...event('run_step', {
            id: 'step_tool_2',
            index: 0,
            stepDetails: {
              type: 'tool_calls',
              tool_calls: [{ id: 'inner_2', name: 'lookup_mcp_foo_mcp_bar', args: '{}' }],
            },
          }),
          memberAgentId: '',
        },
      ],
      emptyMemberResolver,
    );
    expect(emptyMemberResolver).toHaveBeenCalledWith('lookup_mcp_foo_mcp_bar', 'child');
  });

  it('ignores tool_call parts whose name is not SUBAGENT', async () => {
    const buffer = await runSubagentEvents([
      event(
        'run_step',
        {
          id: 'step_msg',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
        'call_regular',
      ),
      event(
        'message_delta',
        {
          id: 'step_msg',
          delta: { content: [{ type: 'text', text: 'x' }] },
        },
        'call_regular',
      ),
    ]);
    const client = makeClient(buffer);
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: { id: 'call_regular', name: 'calculator', args: '{}' },
      },
    ];
    client.finalizeSubagentContent();
    expect(client.contentParts[0].tool_call.subagent_content).toBeUndefined();
  });

  it('is a safe no-op when the aggregator map is empty or missing', () => {
    const client = makeClient(undefined);
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: { id: 'call_sub', name: Constants.SUBAGENT, args: '{}' },
      },
    ];
    expect(() => client.finalizeSubagentContent()).not.toThrow();
    expect(client.contentParts[0].tool_call.subagent_content).toBeUndefined();
  });

  it('discards aggregators keyed by a tool_call_id not present in contentParts', async () => {
    const buffer = await runSubagentEvents([
      event(
        'run_step',
        {
          id: 'step_msg',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
        'call_missing',
      ),
      event(
        'message_delta',
        {
          id: 'step_msg',
          delta: { content: [{ type: 'text', text: 'x' }] },
        },
        'call_missing',
      ),
    ]);
    const client = makeClient(buffer);
    client.contentParts = [
      {
        type: 'tool_call',
        tool_call: { id: 'call_other', name: Constants.SUBAGENT, args: '{}' },
      },
    ];
    client.finalizeSubagentContent();
    expect(client.contentParts[0].tool_call.subagent_content).toBeUndefined();
  });

  it('keeps per-parent tool_call aggregators isolated for parallel subagents', async () => {
    const buffer = await runSubagentEvents([
      event(
        'run_step',
        {
          id: 'step_a',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
        'call_a',
      ),
      event(
        'message_delta',
        { id: 'step_a', delta: { content: [{ type: 'text', text: 'A' }] } },
        'call_a',
      ),
      event(
        'run_step',
        {
          id: 'step_b',
          index: 0,
          stepDetails: { type: 'message_creation' },
        },
        'call_b',
      ),
      event(
        'message_delta',
        { id: 'step_b', delta: { content: [{ type: 'text', text: 'B' }] } },
        'call_b',
      ),
    ]);
    const client = makeClient(buffer);
    client.contentParts = [
      { type: 'tool_call', tool_call: { id: 'call_a', name: Constants.SUBAGENT, args: '{}' } },
      { type: 'tool_call', tool_call: { id: 'call_b', name: Constants.SUBAGENT, args: '{}' } },
    ];
    client.finalizeSubagentContent();
    expect(client.contentParts[0].tool_call.subagent_content).toEqual([
      expect.objectContaining({ type: 'text', text: 'A' }),
    ]);
    expect(client.contentParts[1].tool_call.subagent_content).toEqual([
      expect.objectContaining({ type: 'text', text: 'B' }),
    ]);
  });
});

describe('AgentClient - resumeCompletion content protection', () => {
  const makeContext = (filters) => ({
    options: {
      req: {
        tenantId: 'request-tenant',
        user: { id: 'user-123' },
        body: { files: [] },
        config: {
          endpoints: { [EModelEndpoint.agents]: { checkpointer: {} } },
          filters,
        },
      },
      agent: {
        id: 'agent-123',
        hide_sequential_outputs: false,
        model_parameters: { model: 'gpt-4' },
        tools: [],
      },
    },
    user: 'user-123',
    conversationId: 'conversation-123',
    responseMessageId: 'response-123',
    parentMessageId: 'parent-123',
    agentConfigs: new Map(),
    contentParts: [],
    collectedUsage: [],
    pendingSubagentEmits: [],
    getEncoding: jest.fn(() => 'o200k_base'),
    buildSteerWiring: jest.fn(),
    buildActivityLabelWiring: jest.fn(() => null),
    buildActivityPhaseWiring: jest.fn(() => null),
    buildReasoningLabelWiring: jest.fn(() => null),
    buildSubagentUsageEmitter: jest.fn(),
    buildDetachedSubagentUsageRecorder: jest.fn(),
    handleRunInterrupt: jest.fn().mockResolvedValue(undefined),
    completeActivityPhase: jest.fn(),
    applyHideSequentialOutputsFilter: jest.fn(),
    rebaseActivityPhaseBounds: jest.fn(),
    finalizeSubagentContent: jest.fn(),
    stampMcpServerIdentities: jest.fn(),
    settleActivityLabels: jest.fn().mockResolvedValue(undefined),
    recordCollectedUsage: jest.fn().mockResolvedValue(undefined),
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockCreateRun.mockReset();
    mockGetAgentCheckpointer.mockReset();
    require('~/models')
      .getMessages.mockReset()
      .mockResolvedValue([
        {
          messageId: 'parent-123',
          parentMessageId: Constants.NO_PARENT,
          isCreatedByUser: true,
          role: 'user',
          text: 'safe',
        },
      ]);
    require('~/models').getFiles.mockReset().mockResolvedValue([]);
  });

  it('blocks checkpoint user content before rebuilding the run', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ _getType: () => 'human', content: 'PRIVATE-RESUME-CONTENT' }],
          },
        },
      }),
    });
    const context = makeContext({
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-resume',
              label: 'private resume content',
              regex: 'PRIVATE-RESUME-CONTENT',
            },
          ],
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'text' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('blocks a path-marked assistant fragment restored from the exact persisted branch', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'root',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        role: 'user',
        text: 'safe',
      },
      {
        messageId: 'assistant-1',
        parentMessageId: 'root',
        isCreatedByUser: false,
        role: 'assistant',
        content: [
          { type: ContentTypes.TEXT, text: 'ordinary model prose' },
          { type: ContentTypes.TEXT, text: 'PRIVATE-RESUME-EDIT' },
        ],
        userSubmittedPaths: ['/content/1/text'],
      },
      {
        messageId: 'parent-123',
        parentMessageId: 'assistant-1',
        isCreatedByUser: true,
        role: 'user',
        text: 'continue',
      },
    ]);
    const context = makeContext({
      messages: {
        pii: {
          fields: ['content_part'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-resume-edit',
              label: 'private resume edit',
              regex: 'PRIVATE-RESUME-EDIT',
            },
          ],
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'message', field: 'content_part' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted resume branch has a missing ancestor', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'parent-123',
        parentMessageId: 'missing-ancestor',
        isCreatedByUser: true,
        role: 'user',
        text: 'continue',
      },
    ]);
    const context = makeContext({
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: ['email'],
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'message', field: 'content_part' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('allows unmarked model prose and ignores a marked sibling branch on resume', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'root',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        role: 'user',
        text: 'safe',
      },
      {
        messageId: 'target-assistant',
        parentMessageId: 'root',
        isCreatedByUser: false,
        role: 'assistant',
        text: 'PRIVATE-MODEL-PROSE',
      },
      {
        messageId: 'parent-123',
        parentMessageId: 'target-assistant',
        isCreatedByUser: true,
        role: 'user',
        text: 'continue target branch',
      },
      {
        messageId: 'sibling-assistant',
        parentMessageId: 'root',
        isCreatedByUser: false,
        role: 'assistant',
        content: [{ type: ContentTypes.TEXT, text: 'PRIVATE-MODEL-PROSE' }],
        userSubmittedPaths: ['/content/0/text'],
      },
      {
        messageId: 'sibling-user',
        parentMessageId: 'sibling-assistant',
        isCreatedByUser: true,
        role: 'user',
        text: 'continue sibling branch',
      },
    ]);
    const resume = jest.fn().mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({
      resume,
      getCalibrationRatio: jest.fn(() => 0),
    });
    const context = makeContext({
      messages: {
        pii: {
          fields: ['text', 'content_part'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-model-prose',
              label: 'private model prose',
              regex: 'PRIVATE-MODEL-PROSE',
            },
          ],
        },
      },
    });

    const compactionSemanticIndex = {
      version: 1,
      entries: [
        {
          type: 'activity_phase',
          sourceMessageId: 'assistant-history',
          sourceContentIndex: 1,
          revision: 1,
          status: 'committed',
          text: 'Verified the release state',
        },
      ],
    };
    await AgentClient.prototype.resumeCompletion.call(context, {
      resumeValue: {},
      compactionSemanticIndex,
    });

    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(mockCreateRun.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        tenantId: 'request-tenant',
        modelCallbacks: expect.arrayContaining([
          expect.objectContaining({ name: 'librechat-model-bound-content-filter' }),
          expect.objectContaining({ name: 'librechat-agent-attachment-memory' }),
        ]),
        compactionSemanticIndex: compactionSemanticIndex.entries,
      }),
    );
    expect(resume).toHaveBeenCalledTimes(1);
    expect(resume.mock.calls[0][1]).not.toHaveProperty('callbacks');
  });

  it('blocks handoff dynamic tool context before rebuilding a resumed run', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const context = makeContext({
      files: {
        pii: {
          fields: ['content'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-resume-dynamic-context',
              label: 'private resume dynamic context',
              regex: 'PRIVATE-RESUME-DYNAMIC-CONTEXT',
            },
          ],
        },
      },
    });
    context.agentConfigs = new Map([
      [
        'handoff-agent',
        {
          id: 'handoff-agent',
          model_parameters: { model: 'gpt-4' },
          dynamicToolContextMap: {
            ignored: 42,
            web_search: 'PRIVATE-RESUME-DYNAMIC-CONTEXT',
          },
        },
      ],
    ]);

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'content' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('blocks a nested pure subagent tool definition before rebuilding a resumed run', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const context = makeContext({
      agentInstructions: {
        pii: {
          fields: ['description'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-resume-subagent-tool',
              label: 'private resume subagent tool',
              regex: 'PRIVATE-RESUME-SUBAGENT-TOOL',
            },
          ],
        },
      },
    });
    context.options.agent.subagentAgentConfigs = [
      {
        id: 'pure-subagent',
        model_parameters: { model: 'gpt-4' },
        subagentAgentConfigs: [
          {
            id: 'nested-pure-subagent',
            model_parameters: { model: 'gpt-4' },
            toolDefinitions: [
              {
                name: 'resume_lookup',
                description: 'PRIVATE-RESUME-SUBAGENT-TOOL',
                parameters: { type: 'object' },
              },
            ],
          },
        ],
      },
    ];

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'agent_instruction', field: 'description' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('re-inspects current extracted file text when policy tightens while paused', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'parent-123',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        role: 'user',
        text: 'inspect the attached file',
        files: [{ file_id: 'file-paused', filename: 'report.txt' }],
      },
    ]);
    require('~/models').getFiles.mockResolvedValue([
      {
        file_id: 'file-paused',
        filename: 'report.txt',
        text: 'PRIVATE-EXTRACTED-TEXT',
      },
    ]);
    const context = makeContext({
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-extracted-text',
              label: 'private extracted text',
              regex: 'PRIVATE-EXTRACTED-TEXT',
            },
          ],
          uninspectable: 'block',
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(require('~/models').getFiles).toHaveBeenCalledWith(
      {
        file_id: { $in: ['file-paused'] },
        user: 'user-123',
      },
      {},
      {},
    );
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('freezes owner-hydrated resume files into the final model callback', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', files: [{ file_id: 'file-paused' }] }],
          },
        },
      }),
    });
    const storedMessage = {
      messageId: 'parent-123',
      parentMessageId: Constants.NO_PARENT,
      isCreatedByUser: true,
      role: 'user',
      text: 'inspect the attached file',
      files: [{ file_id: 'file-paused', filename: 'report.txt' }],
    };
    require('~/models').getMessages.mockResolvedValue([storedMessage]);
    require('~/models').getFiles.mockResolvedValue([
      {
        file_id: 'file-paused',
        filename: 'report.txt',
        source: 'text',
        type: 'text/plain',
        bytes: 10,
        text: 'Safe extracted text',
      },
    ]);
    const resume = jest.fn().mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ resume, getCalibrationRatio: jest.fn(() => 0) });
    const context = makeContext({
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    });

    await AgentClient.prototype.resumeCompletion.call(context, {
      resumeValue: {},
      storedMessages: [storedMessage],
    });

    const [modelBoundCallback, attachmentMemoryCallback] =
      mockCreateRun.mock.calls[0][0].modelCallbacks;
    expect(attachmentMemoryCallback).toEqual(
      expect.objectContaining({ name: 'librechat-agent-attachment-memory' }),
    );
    expect(context.attachmentMemoryContext).toEqual(
      expect.objectContaining({
        conversationId: 'conversation-123',
        messageId: 'response-123',
        attachments: [expect.objectContaining({ file_id: 'file-paused' })],
        countRepeatedExtractedText: true,
      }),
    );
    expect(() =>
      modelBoundCallback.handleChatModelStart(undefined, [
        [
          {
            role: 'human',
            content: [{ type: 'input_file', file_id: 'file-paused' }],
            additional_kwargs: { sourceMessageId: 'parent-123' },
          },
        ],
      ]),
    ).not.toThrow();
  });

  it('reapplies aggregate attachment limits to persistent history on resume', async () => {
    const historicalFiles = Array.from({ length: 11 }, (_, index) => ({
      file_id: `resume-history-${index}`,
      filename: `history-${index}.txt`,
      source: 'text',
      type: 'text/plain',
      text: 'context',
      bytes: 10,
    }));
    require('~/models').getMessages.mockResolvedValue(
      historicalFiles.map((file, index) => ({
        messageId: index === historicalFiles.length - 1 ? 'parent-123' : `history-${index}`,
        parentMessageId: index === 0 ? Constants.NO_PARENT : `history-${index - 1}`,
        isCreatedByUser: true,
        role: 'user',
        text: 'inspect file',
        files: [{ file_id: file.file_id }],
      })),
    );
    require('~/models').getFiles.mockResolvedValue(historicalFiles);
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: historicalFiles.map((file) => ({
              role: 'human',
              files: [{ file_id: file.file_id }],
            })),
          },
        },
      }),
    });
    const context = makeContext(undefined);
    context.options.req.body.isTemporary = false;
    context.options.req.config.fileConfig = {
      endpoints: { agents: { fileLimit: 10 } },
    };

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'count',
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('counts a restored request file only once when it is already in the checkpoint', async () => {
    const retainedFile = {
      file_id: 'retained-request',
      filename: 'retained.txt',
      source: 'text',
      type: 'text/plain',
      text: 'x'.repeat(600_000),
      bytes: 600_000,
    };
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', files: [{ file_id: retainedFile.file_id }] }],
          },
        },
      }),
    });
    require('~/models').getFiles.mockResolvedValue([retainedFile]);
    const resume = jest.fn().mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ resume, getCalibrationRatio: jest.fn(() => 0) });
    const context = makeContext(undefined);
    context.options.attachments = [retainedFile];
    context.options.req.config.fileConfig = { fileContextCharLimit: 1_000_000 };

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).resolves.toBeUndefined();

    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(context.attachmentMemoryContext.attachments).toEqual([retainedFile]);
  });

  it('limits resume history to files retained by the checkpoint', async () => {
    const historicalFiles = Array.from({ length: 11 }, (_, index) => ({
      file_id: `old-history-${index}`,
      filename: `old-${index}.txt`,
      source: 'text',
      type: 'text/plain',
      text: 'context',
      bytes: 10,
    }));
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [{ role: 'human', files: [{ file_id: 'old-history-10' }] }],
          },
        },
      }),
    });
    require('~/models').getFiles.mockResolvedValue(historicalFiles);
    const resume = jest.fn().mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ resume, getCalibrationRatio: jest.fn(() => 0) });
    const context = makeContext(undefined);
    context.options.req.config.fileConfig = {
      endpoints: { agents: { fileLimit: 10 } },
    };

    await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

    expect(mockCreateRun).toHaveBeenCalledTimes(1);
    expect(context.attachmentMemoryContext.attachments).toEqual([
      expect.objectContaining({ file_id: 'old-history-10' }),
    ]);
  });

  it('counts checkpoint files retained in model state after endpoint policy tightens', async () => {
    const checkpointFiles = [
      {
        file_id: 'retained-1',
        filename: 'retained-1.pdf',
        source: 'local',
        type: 'application/pdf',
        bytes: 10,
      },
      {
        file_id: 'retained-2',
        filename: 'retained-2.pdf',
        source: 'local',
        type: 'application/pdf',
        bytes: 10,
      },
    ];
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: {
          channel_values: {
            messages: [
              {
                role: 'human',
                files: checkpointFiles.map(({ file_id }) => ({ file_id })),
              },
            ],
          },
        },
      }),
    });
    require('~/models').getFiles.mockResolvedValue(checkpointFiles);
    const context = makeContext(undefined);
    context.options.req.config.fileConfig = {
      endpoints: {
        agents: { fileLimit: 1 },
      },
    };

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'count',
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('reapplies each secondary agent endpoint limit on resume', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const context = makeContext(undefined);
    context.options.agent.endpoint = 'openAI';
    context.options.req.config.fileConfig = {
      endpoints: {
        openAI: { fileLimit: 10 },
        Moonshot: { fileLimit: 1, supportedMimeTypes: ['^text/plain$'] },
      },
    };
    context.agentConfigs = new Map([
      [
        'secondary',
        {
          id: 'secondary',
          endpoint: 'Moonshot',
          model_parameters: { model: 'moonshot-v1' },
          tools: [],
        },
      ],
    ]);
    context.options.agentContextAttachmentsByAgentId = new Map([
      [
        'secondary',
        [
          { file_id: 'secondary-1', source: 'text', type: 'text/plain', text: 'one', bytes: 1 },
          { file_id: 'secondary-2', source: 'text', type: 'text/plain', text: 'two', bytes: 1 },
        ],
      ],
    ]);

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'count',
      observed: 2,
      limit: 1,
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('restores agent-scoped file context before rebuilding a resumed run', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const resume = jest.fn().mockResolvedValue(undefined);
    mockCreateRun.mockResolvedValue({ resume, getCalibrationRatio: jest.fn(() => 0) });
    const context = makeContext(undefined);
    context.options.agentContextAttachmentsByAgentId = new Map([
      [
        'agent-123',
        [
          {
            file_id: 'resume-private-context',
            filename: 'private.txt',
            source: 'text',
            type: 'text/plain',
            text: 'Resume-only private context',
            bytes: 27,
          },
        ],
      ],
    ]);

    await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

    expect(context.options.agent.additional_instructions).toContain('Resume-only private context');
    expect(mockCreateRun).toHaveBeenCalledTimes(1);
  });

  it('reapplies shared attachment limits after a lazy resume agent resolves', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const resolvedChild = {
      id: 'lazy-secondary',
      endpoint: 'Moonshot',
      model_parameters: { model: 'moonshot-v1' },
      tools: [],
    };
    const resolveLazy = jest.fn().mockResolvedValue(resolvedChild);
    const descriptor = {
      id: 'lazy-secondary',
      resolve: resolveLazy,
    };
    const sharedFile = {
      file_id: 'shared-large',
      filename: 'shared.txt',
      source: 'text',
      type: 'text/plain',
      text: 'shared context',
      bytes: 2 * 1024 * 1024,
    };
    const context = makeContext(undefined);
    context.options.agent.endpoint = 'openAI';
    context.options.agent.lazySubagentConfigs = [descriptor];
    context.options.attachments = [sharedFile];
    context.options.req.config.fileConfig = {
      endpoints: {
        openAI: { totalSizeLimit: 128 },
        Moonshot: { totalSizeLimit: 1 },
      },
    };
    mockCreateRun.mockImplementation(async () => ({
      resume: jest.fn(async () => descriptor.resolve({ signal: new AbortController().signal })),
      getCalibrationRatio: jest.fn(() => 0),
    }));

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'bytes',
      observed: 2 * 1024 * 1024,
      limit: 1024 * 1024,
    });
    expect(resolveLazy).toHaveBeenCalledTimes(1);
  });

  it('includes admitted steer files when a lazy resume agent resolves', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const resolvedChild = {
      id: 'lazy-secondary',
      endpoint: 'Moonshot',
      model_parameters: { model: 'moonshot-v1' },
      tools: [],
    };
    const descriptor = {
      id: 'lazy-secondary',
      resolve: jest.fn().mockResolvedValue(resolvedChild),
    };
    const steerFile = {
      file_id: 'steer-large',
      filename: 'steer.txt',
      source: 'text',
      type: 'text/plain',
      text: 'steered context',
      bytes: 2 * 1024 * 1024,
    };
    const context = makeContext(undefined);
    context.options.agent.endpoint = 'openAI';
    context.options.agent.lazySubagentConfigs = [descriptor];
    context.options.req.config.fileConfig = {
      endpoints: {
        openAI: { totalSizeLimit: 128 },
        Moonshot: { totalSizeLimit: 1 },
      },
    };
    mockCreateRun.mockImplementation(async () => ({
      resume: jest.fn(async () => {
        context.turnSharedAttachmentFiles.push(steerFile);
        return descriptor.resolve({ signal: new AbortController().signal });
      }),
      getCalibrationRatio: jest.fn(() => 0),
    }));

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
      limitType: 'bytes',
      observed: 2 * 1024 * 1024,
      limit: 1024 * 1024,
    });
  });

  it('reserves a lazy resume endpoint before awaiting its scoped context', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const resolvedChild = {
      id: 'lazy-secondary',
      endpoint: 'Moonshot',
      model_parameters: { model: 'moonshot-v1' },
      tools: [],
    };
    const descriptor = {
      id: 'lazy-secondary',
      resolve: jest.fn().mockResolvedValue(resolvedChild),
    };
    const lateScopedContext = deferred();
    mockBuildAgentScopedContext.mockImplementationOnce((...args) =>
      jest.requireActual('@librechat/api').buildAgentScopedContext(...args),
    );
    mockBuildAgentScopedContext.mockImplementationOnce(() => lateScopedContext.promise);
    const context = makeContext(undefined);
    context.options.agent.endpoint = 'openAI';
    context.options.agent.lazySubagentConfigs = [descriptor];
    context.options.req.config.fileConfig = {
      endpoints: {
        openAI: { totalSizeLimit: 128 },
        Moonshot: { totalSizeLimit: 1 },
      },
    };
    mockCreateRun.mockImplementation(async () => ({
      resume: jest.fn(async () => descriptor.resolve({ signal: new AbortController().signal })),
      getCalibrationRatio: jest.fn(() => 0),
    }));

    const resumePromise = AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });
    for (
      let attempt = 0;
      attempt < 20 && mockBuildAgentScopedContext.mock.calls.length < 2;
      attempt++
    ) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    expect(mockBuildAgentScopedContext).toHaveBeenCalledTimes(2);
    expect(() =>
      AgentClient.prototype.admitSteerAttachments.call(context, [
        {
          file_id: 'racing-steer',
          filename: 'racing.txt',
          source: 'text',
          type: 'text/plain',
          text: 'steered context',
          bytes: 2 * 1024 * 1024,
        },
      ]),
    ).toThrow(
      expect.objectContaining({
        code: 'AGENT_ATTACHMENT_LIMIT_EXCEEDED',
        limitType: 'bytes',
      }),
    );

    lateScopedContext.resolve(new Map([['lazy-secondary', '']]));
    await expect(resumePromise).resolves.toBeUndefined();
  });

  it('restores scoped file context after a lazy resume agent resolves', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const resolvedChild = {
      id: 'lazy-secondary',
      endpoint: 'Moonshot',
      model_parameters: { model: 'moonshot-v1' },
      tools: [],
      agentContextAttachments: [
        {
          file_id: 'lazy-private-context',
          filename: 'lazy-private.txt',
          source: 'text',
          type: 'text/plain',
          text: 'Lazy resume private context',
          bytes: 27,
        },
      ],
    };
    const resolveLazy = jest.fn().mockResolvedValue(resolvedChild);
    const descriptor = {
      id: 'lazy-secondary',
      resolve: resolveLazy,
    };
    const context = makeContext(undefined);
    context.options.agent.lazySubagentConfigs = [descriptor];
    mockCreateRun.mockImplementation(async () => ({
      resume: jest.fn(async () => descriptor.resolve({ signal: new AbortController().signal })),
      getCalibrationRatio: jest.fn(() => 0),
    }));

    await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

    expect(resolvedChild.additional_instructions).toContain('Lazy resume private context');
    expect(resolveLazy).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a paused file reference cannot be rehydrated', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'parent-123',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        role: 'user',
        text: 'inspect the attached file',
        files: [{ file_id: 'missing-paused-file' }],
      },
    ]);
    const context = makeContext({
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('fails closed when resume file-reference traversal exceeds its depth bound', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    let nested = { file_id: 'deep-paused-file' };
    for (let depth = 0; depth < 30; depth++) {
      nested = { nested };
    }
    require('~/models').getMessages.mockResolvedValue([
      {
        messageId: 'parent-123',
        parentMessageId: Constants.NO_PARENT,
        isCreatedByUser: true,
        role: 'user',
        text: 'inspect the nested file',
        content: [{ type: ContentTypes.TEXT, nested }],
      },
    ]);
    const context = makeContext({
      files: {
        pii: {
          fields: ['extracted_text'],
          starterPatterns: [],
          uninspectable: 'block',
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(require('~/models').getFiles).not.toHaveBeenCalled();
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('blocks seeded tool arguments before rebuilding the run', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const context = makeContext({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: [],
          customPatterns: [
            {
              id: 'private-tool-input',
              label: 'private tool input',
              regex: 'PRIVATE-TOOL-INPUT',
            },
          ],
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, {
        resumeValue: {},
        seedContent: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              name: 'example_tool',
              arguments: { value: 'PRIVATE-TOOL-INPUT' },
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'tool_argument', field: 'arguments' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('fails closed when selected seeded tool arguments cannot be fully traversed', async () => {
    mockGetAgentCheckpointer.mockResolvedValue({
      getTuple: jest.fn().mockResolvedValue({
        checkpoint: { channel_values: { messages: [] } },
      }),
    });
    const deepArguments = {};
    let current = deepArguments;
    for (let depth = 0; depth < 30; depth++) {
      current.nested = {};
      current = current.nested;
    }
    Object.defineProperty(deepArguments, 'toJSON', {
      value: () => {
        throw new Error('cannot serialize');
      },
    });
    const context = makeContext({
      toolArguments: {
        pii: {
          fields: ['arguments'],
          starterPatterns: ['sk_prefix'],
        },
      },
    });

    await expect(
      AgentClient.prototype.resumeCompletion.call(context, {
        resumeValue: {},
        seedContent: [
          {
            type: ContentTypes.TOOL_CALL,
            tool_call: {
              name: 'example_tool',
              arguments: deepArguments,
            },
          },
        ],
      }),
    ).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'tool_argument', field: 'arguments' },
    });
    expect(mockCreateRun).not.toHaveBeenCalled();
  });

  it('does not log or persist provider error content while resuming', async () => {
    const { logger } = require('@librechat/data-schemas');
    const privateValue = 'PRIVATE-RESUME-PROVIDER-CONTENT';
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    mockCreateRun.mockRejectedValue(
      Object.assign(new Error(`Provider echoed ${privateValue}`), {
        code: 'ERR_REMOTE',
        response: { status: 422, data: { prompt: privateValue } },
      }),
    );
    const context = makeContext({
      messages: {
        pii: {
          fields: ['text'],
          starterPatterns: ['email'],
        },
      },
    });

    await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

    expect(context.contentParts).toContainEqual({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]: 'An error occurred while resuming the request',
    });
    expect(JSON.stringify(context.contentParts)).not.toContain(privateValue);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateValue);
    expect(errorSpy).toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #resumeCompletion] Unhandled error',
      expect.objectContaining({ type: 'Error' }),
    );
    errorSpy.mockRestore();
  });

  it('classifies a terminal resumed model failure and preserves redaction', async () => {
    const { logger } = require('@librechat/data-schemas');
    const { traceIdForMessage } = require('@librechat/api');
    const privateValue = 'PRIVATE-RESUMED-UPSTREAM-CONTENT';
    const providerError = Object.assign(new Error(), {
      code: 'PROVIDER_INTERNAL',
      status: 503,
    });
    Object.defineProperties(providerError, {
      name: {
        get() {
          throw new Error(`Provider echoed ${privateValue}`);
        },
      },
      message: {
        get() {
          throw new Error(`Provider echoed ${privateValue}`);
        },
      },
    });
    const abortController = new AbortController();
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation(() => logger);
    mockCreateRun.mockImplementation(async (options) => {
      const tracker = options.modelCallbacks.find(
        (callback) => callback.name === 'librechat-upstream-model-error-tracker',
      );
      return {
        resume: jest.fn(async () => {
          tracker.handleLLMError(providerError, 'resumed-model-run');
          abortController.abort();
          throw providerError;
        }),
        getCalibrationRatio: jest.fn(() => 0),
      };
    });
    const context = makeContext(undefined);

    await AgentClient.prototype.resumeCompletion.call(context, {
      resumeValue: {},
      abortController,
    });

    expect(errorSpy).toHaveBeenCalledWith(
      '[api/server/controllers/agents/client.js #resumeCompletion] Upstream model error',
      {
        type: 'Error',
        status: 503,
        errorCode: 'UPSTREAM_MODEL_ERROR',
        errorOrigin: 'model_provider',
        errorType: '503',
        traceId: traceIdForMessage('response-123'),
      },
    );
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(privateValue);
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('PROVIDER_INTERNAL');
    expect(context.contentParts).toContainEqual({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]:
        'The model provider could not complete this request.\n' +
        JSON.stringify({ type: 'upstream_model_error', status: 503 }),
    });
    errorSpy.mockRestore();
  });

  /** A gateway or privacy proxy states its rejection in its own message and nowhere else, so an
   *  unclassified upstream failure carries it exactly as every other failure text does. */
  it.each([undefined, 24, 3000])(
    'keeps the provider explanation with limit %s on a terminal resumed model failure',
    async (maxProviderErrorChars) => {
      const explanation = '400 Request rejected: this prompt cannot be masked safely';
      const trackTerminalProviderError = (providerError) => {
        mockCreateRun.mockImplementation(async (options) => {
          const tracker = options.modelCallbacks.find(
            (callback) => callback.name === 'librechat-upstream-model-error-tracker',
          );
          return {
            resume: jest.fn(async () => {
              tracker.handleLLMError(providerError, 'resumed-model-run');
              throw providerError;
            }),
            getCalibrationRatio: jest.fn(() => 0),
          };
        });
      };

      trackTerminalProviderError(Object.assign(new Error(explanation), { status: 400 }));
      const context = makeContext(undefined);
      context.options.req.config.endpoints = { agents: { maxProviderErrorChars } };

      await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

      expect(context.contentParts).toContainEqual({
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'The model provider could not complete this request.\n' +
          JSON.stringify({
            type: 'upstream_model_error',
            status: 400,
            message: explanation.slice(0, maxProviderErrorChars),
          }),
      });

      /** With a policy inspecting the traffic, the body may echo submitted content: status only. */
      trackTerminalProviderError(Object.assign(new Error(explanation), { status: 400 }));
      const protectedContext = makeContext({
        messages: { pii: { fields: ['text'], starterPatterns: ['email'] } },
      });

      await AgentClient.prototype.resumeCompletion.call(protectedContext, { resumeValue: {} });

      expect(protectedContext.contentParts).toContainEqual({
        type: ContentTypes.ERROR,
        [ContentTypes.ERROR]:
          'The model provider could not complete this request.\n' +
          JSON.stringify({ type: 'upstream_model_error', status: 400 }),
      });
    },
  );

  it('preserves provider error detail when content protection is disabled', async () => {
    const providerMessage = 'Legacy provider detail';
    mockCreateRun.mockRejectedValue(new Error(providerMessage));
    const context = makeContext(undefined);

    await AgentClient.prototype.resumeCompletion.call(context, { resumeValue: {} });

    expect(context.contentParts).toContainEqual({
      type: ContentTypes.ERROR,
      [ContentTypes.ERROR]: `An error occurred while resuming the request: ${providerMessage}`,
    });
  });
});

describe('fading tier context meta', () => {
  const fading = { v: 1, budgetTokens: 20_000, masked: true };
  const fadingTiers = [
    { agentId: 'agent-123', v: 1, budgetTokens: 20_000, masked: true },
    { agentId: 'agent-worker', v: 1, budgetTokens: 8_000, masked: false },
  ];

  it('carries valid fading tiers through event actor context', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: {} } };
    const contextMeta = { calibrationRatio: 1.25, encoding: 'o200k_base', fading, fadingTiers };
    client.getEventActorContext = jest.fn().mockResolvedValue({
      fingerprint: 'fingerprint-1',
      skillManifest: [],
      discoveredToolNames: [],
      contextMeta,
    });

    await expect(
      client.prepareEventActorContext({
        contextFingerprint: 'fingerprint-1',
        skillManifest: [],
        discoveredToolNames: [],
        contextMeta,
      }),
    ).resolves.toMatchObject({ contextMeta });
    expect(client.contextMeta).toEqual(contextMeta);
  });

  it('rejects event actor context carrying a malformed fading tier', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: {} } };
    client.getEventActorContext = jest.fn();

    await expect(
      client.prepareEventActorContext({
        contextFingerprint: 'fingerprint-1',
        skillManifest: [],
        discoveredToolNames: [],
        contextMeta: { calibrationRatio: 1.25, fading: { v: 1, budgetTokens: -5, masked: true } },
      }),
    ).resolves.toBeUndefined();
    expect(client.getEventActorContext).not.toHaveBeenCalled();
  });

  it('rejects event actor context carrying malformed per-agent tiers', async () => {
    const client = Object.create(AgentClient.prototype);
    client.options = { req: { config: {} } };
    client.getEventActorContext = jest.fn();

    await expect(
      client.prepareEventActorContext({
        contextFingerprint: 'fingerprint-1',
        skillManifest: [],
        discoveredToolNames: [],
        contextMeta: {
          calibrationRatio: 1.25,
          fadingTiers: [{ agentId: '', v: 1, budgetTokens: 20_000, masked: true }],
        },
      }),
    ).resolves.toBeUndefined();
    expect(client.getEventActorContext).not.toHaveBeenCalled();
  });
});

describe('seedContextMeta', () => {
  it('seeds valid context meta and drops a malformed fading tier', () => {
    const client = Object.create(AgentClient.prototype);
    const contextMeta = {
      calibrationRatio: 1.25,
      encoding: 'claude',
      fading: { v: 1, budgetTokens: 20_000, masked: true },
    };

    client.seedContextMeta(contextMeta);
    expect(client.contextMeta).toEqual(contextMeta);

    client.seedContextMeta({ calibrationRatio: 1.25, fading: { v: 1, budgetTokens: 0 } });
    expect(client.contextMeta).toBeUndefined();

    client.seedContextMeta(undefined);
    expect(client.contextMeta).toBeUndefined();
  });
});
