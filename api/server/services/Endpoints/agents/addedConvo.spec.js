const mockInitializeAgent = jest.fn();
const mockValidateAgentModel = jest.fn();
const mockLoadAddedAgent = jest.fn();
const mockResolveAgentScopedSkillIds = jest.fn();
const mockResolveModelSpecSkillIds = jest.fn();
const mockCanAuthorSkillFiles = jest.fn();
const mockGetSkillDbMethods = jest.fn();
const mockGetAgent = jest.fn();
const mockGetMCPServerTools = jest.fn();
const mockRegistryGetSkillByName = jest.fn();
const mockRegistryListSkillsByAccess = jest.fn();
const mockRegistryListAlwaysApplySkills = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ADDED_AGENT_ID: '__added_agent__',
  initializeAgent: (...args) => mockInitializeAgent(...args),
  validateAgentModel: (...args) => mockValidateAgentModel(...args),
  loadAddedAgent: (params) => mockLoadAddedAgent(params),
  resolveAgentScopedSkillIds: (...args) => mockResolveAgentScopedSkillIds(...args),
  resolveModelSpecSkillIds: (...args) => mockResolveModelSpecSkillIds(...args),
}));

jest.mock('~/server/services/Files/permissions', () => ({
  filterFilesByAgentAccess: jest.fn(),
}));

jest.mock('~/server/services/Config', () => ({
  getMCPServerTools: (...args) => mockGetMCPServerTools(...args),
}));

jest.mock('~/server/services/MCP', () => ({
  getAccessibleMcpServerNames: jest.fn(async () => []),
}));

jest.mock('~/server/services/ToolService', () => ({
  isFatalAgentInitializationError: (error, { signal } = {}) =>
    (signal?.aborted === true && (error === signal.reason || error?.name === 'AbortError')) ||
    ['AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 'resource_recovery_required'].includes(error?.code),
}));

jest.mock('./skillDeps', () => ({
  canAuthorSkillFiles: (...args) => mockCanAuthorSkillFiles(...args),
  getSkillDbMethods: () => mockGetSkillDbMethods(),
}));

jest.mock('~/models', () => ({
  getAgent: (...args) => mockGetAgent(...args),
  getSkillByName: jest.fn(),
  listSkillsByAccess: jest.fn(),
  listAlwaysApplySkills: jest.fn(),
}));

const { processAddedConvo } = require('./addedConvo');
const { Constants, ErrorTypes } = require('librechat-data-provider');

const makeReq = () => ({ user: { id: 'u1', role: 'USER' } });

/**
 * Phase 8 pins `processAddedConvo` forwarding the run's `codeEnvAvailable` to
 * the added-convo `initializeAgent` call. Without this, parallel multi-convo
 * agents with `tools: ['execute_code']` silently drop `bash_tool` + `read_file`
 * even though the primary had them — pre-Phase-8 the legacy
 * `CodeExecutionToolDefinition` landed in their `toolDefinitions` via the
 * registry regardless of any explicit flag.
 */
describe('processAddedConvo', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockValidateAgentModel.mockResolvedValue({ isValid: true });
    mockInitializeAgent.mockResolvedValue({
      id: 'added-agent',
      userMCPAuthMap: undefined,
    });
    mockLoadAddedAgent.mockResolvedValue({ id: 'added-agent', provider: 'openai' });
    mockResolveAgentScopedSkillIds.mockImplementation(
      ({ accessibleSkillIds }) => accessibleSkillIds,
    );
    mockResolveModelSpecSkillIds.mockResolvedValue([]);
    mockCanAuthorSkillFiles.mockReturnValue(false);
    mockGetSkillDbMethods.mockReturnValue({
      getSkillByName: mockRegistryGetSkillByName,
      listSkillsByAccess: mockRegistryListSkillsByAccess,
      listAlwaysApplySkills: mockRegistryListAlwaysApplySkills,
    });
  });

  const baseParams = (overrides = {}) => ({
    req: makeReq(),
    res: {},
    endpointOption: { addedConvo: { model: 'gpt-4o', agent_id: 'added-agent' } },
    modelsConfig: { openai: ['gpt-4o'] },
    logViolation: jest.fn(),
    loadTools: jest.fn(),
    requestFiles: [],
    conversationId: 'conv-1',
    parentMessageId: null,
    allowedProviders: new Set(['openai']),
    agentConfigs: new Map(),
    primaryAgentId: 'primary-id',
    primaryAgent: { id: 'primary-id' },
    userMCPAuthMap: undefined,
    ...overrides,
  });

  it('forwards codeEnvAvailable=true to the added-convo initializeAgent call', async () => {
    await processAddedConvo(baseParams({ codeEnvAvailable: true }));

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ codeEnvAvailable: true }),
      expect.anything(),
    );
  });

  /** The added convo re-hydrates the same conversation's prior-turn files, so a
   *  denied `FILE_SEARCH` grant has to travel with it — otherwise the parallel
   *  agent primes the search files the primary just skipped. `undefined` stays
   *  `undefined`, which leaves priming unconditional for callers that never
   *  resolved the grant. */
  it.each([true, false, undefined])(
    'forwards fileSearchAvailable=%s verbatim to the added-convo initializeAgent call',
    async (fileSearchAvailable) => {
      await processAddedConvo(baseParams({ fileSearchAvailable }));

      expect(mockInitializeAgent).toHaveBeenCalledWith(
        expect.objectContaining({ fileSearchAvailable }),
        expect.anything(),
      );
    },
  );

  it('forwards codeEnvAvailable=false verbatim (not coerced to undefined)', async () => {
    /* Symmetric coverage: if the runtime gate is off for the primary, the
       parallel agent must not accidentally re-enable code execution via a
       defaulting bug in the destructuring. */
    await processAddedConvo(baseParams({ codeEnvAvailable: false }));

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ codeEnvAvailable: false }),
      expect.anything(),
    );
  });

  it('forwards codeEnvAvailable=undefined when caller omits it (no silent default)', async () => {
    /* Backstop for the "caller didn't update after Phase 8" case — the
       added-convo path must not invent a truthy value out of thin air.
       Matches `initializeAgent`'s own "explicit opt-in" semantics. */
    await processAddedConvo(baseParams());

    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ codeEnvAvailable: undefined }),
      expect.anything(),
    );
  });

  it.each([
    ['AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE', 503],
    [ErrorTypes.RESOURCE_RECOVERY_REQUIRED, 409],
  ])('propagates fatal %s failures from an added parallel agent', async (code, statusCode) => {
    const toolError = Object.assign(new Error(`Added agent failed with ${code}`), {
      code,
      statusCode,
    });
    mockInitializeAgent.mockRejectedValueOnce(toolError);

    await expect(processAddedConvo(baseParams())).rejects.toBe(toolError);
  });

  it('forwards and propagates owning-run cancellation from added-agent initialization', async () => {
    const controller = new AbortController();
    const reason = new Error('parallel agent stopped');
    controller.abort(reason);
    mockInitializeAgent.mockRejectedValueOnce(reason);

    await expect(processAddedConvo(baseParams({ signal: controller.signal }))).rejects.toBe(reason);
    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({ signal: controller.signal }),
      expect.anything(),
    );
  });

  it('keeps deployment-aware skill metadata on a persisted added-agent config', async () => {
    const deploymentSkillId = { toString: () => 'deployment-skill' };
    const agentConfigs = new Map();
    const initializedConfig = {
      id: 'persisted-added-agent',
      additional_instructions: '<skill_catalog>deployment-skill</skill_catalog>',
      manualSkillPrimes: [],
      alwaysApplySkillPrimes: [
        {
          _id: 'deployment-skill',
          name: 'deployment-skill',
          body: 'deployment skill body',
        },
      ],
      toolDefinitions: [{ name: 'skill' }],
      userMCPAuthMap: undefined,
    };

    mockLoadAddedAgent.mockResolvedValue({
      id: 'persisted-added-agent',
      provider: 'openai',
      skills_enabled: true,
      skills: ['deployment-skill'],
    });
    mockResolveAgentScopedSkillIds.mockReturnValue([deploymentSkillId]);
    mockInitializeAgent.mockResolvedValue(initializedConfig);

    await processAddedConvo(
      baseParams({
        accessibleSkillIds: [deploymentSkillId],
        editableSkillIds: [deploymentSkillId],
        skillsCapabilityEnabled: true,
        agentConfigs,
      }),
    );

    expect(mockResolveModelSpecSkillIds).not.toHaveBeenCalled();
    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: expect.objectContaining({
          id: 'persisted-added-agent',
          skills_enabled: true,
          skills: ['deployment-skill'],
        }),
        accessibleSkillIds: [deploymentSkillId],
      }),
      expect.objectContaining({
        listSkillsByAccess: mockRegistryListSkillsByAccess,
        listAlwaysApplySkills: mockRegistryListAlwaysApplySkills,
        getSkillByName: mockRegistryGetSkillByName,
      }),
    );
    expect(agentConfigs.get('persisted-added-agent')).toBe(initializedConfig);
    expect(agentConfigs.get('persisted-added-agent')).toEqual(
      expect.objectContaining({
        additional_instructions: '<skill_catalog>deployment-skill</skill_catalog>',
        manualSkillPrimes: [],
        alwaysApplySkillPrimes: [
          expect.objectContaining({
            name: 'deployment-skill',
            body: 'deployment skill body',
          }),
        ],
        toolDefinitions: [expect.objectContaining({ name: 'skill' })],
      }),
    );
    expect(mockGetSkillDbMethods).toHaveBeenCalledTimes(1);
  });

  it('resolves and forwards model-spec skill scope for added ephemeral agents', async () => {
    const accessibleSkillId = { toString: () => 'accessible-skill' };
    const editableSkillId = { toString: () => 'editable-skill' };
    const resolvedSkillId = { toString: () => 'resolved-skill' };
    const scopedSkillId = { toString: () => 'scoped-skill' };
    const scopedEditableSkillId = { toString: () => 'scoped-editable-skill' };
    const skillStates = { 'scoped-skill': true };

    mockLoadAddedAgent.mockResolvedValue({
      id: Constants.EPHEMERAL_AGENT_ID,
      provider: 'openai',
      skills_enabled: true,
      skills: [],
    });
    mockResolveModelSpecSkillIds.mockResolvedValue([resolvedSkillId]);
    mockResolveAgentScopedSkillIds
      .mockReturnValueOnce([scopedSkillId])
      .mockReturnValueOnce([scopedEditableSkillId]);
    mockCanAuthorSkillFiles.mockReturnValue(true);

    await processAddedConvo(
      baseParams({
        req: {
          user: { id: 'u1', role: 'USER' },
          config: {
            modelSpecs: {
              list: [
                {
                  name: 'added-spec',
                  skills: ['finance-analyst'],
                },
              ],
            },
          },
        },
        endpointOption: {
          spec: 'primary-spec',
          addedConvo: {
            endpoint: 'openai',
            model: 'gpt-4o',
            spec: 'added-spec',
          },
        },
        accessibleSkillIds: [accessibleSkillId],
        editableSkillIds: [editableSkillId],
        skillsCapabilityEnabled: true,
        ephemeralSkillsToggle: false,
        skillCreateAllowed: true,
        skillStates,
        defaultActiveOnShare: true,
      }),
    );

    expect(mockResolveModelSpecSkillIds).toHaveBeenCalledWith({
      names: ['finance-analyst'],
      accessibleSkillIds: [accessibleSkillId],
      getSkillByName: mockRegistryGetSkillByName,
    });
    expect(mockResolveAgentScopedSkillIds).toHaveBeenNthCalledWith(1, {
      agent: expect.objectContaining({
        id: Constants.EPHEMERAL_AGENT_ID,
        skills_enabled: true,
        skills: ['resolved-skill'],
      }),
      accessibleSkillIds: [accessibleSkillId],
      skillsCapabilityEnabled: true,
      ephemeralSkillsToggle: false,
    });
    expect(mockResolveAgentScopedSkillIds).toHaveBeenNthCalledWith(2, {
      agent: expect.objectContaining({
        id: Constants.EPHEMERAL_AGENT_ID,
        skills_enabled: true,
        skills: ['resolved-skill'],
      }),
      accessibleSkillIds: [editableSkillId],
      skillsCapabilityEnabled: true,
      ephemeralSkillsToggle: false,
    });
    expect(mockCanAuthorSkillFiles).toHaveBeenCalledWith({
      agent: expect.objectContaining({
        id: Constants.EPHEMERAL_AGENT_ID,
        skills_enabled: true,
        skills: ['resolved-skill'],
      }),
      scopedEditableSkillIds: [scopedEditableSkillId],
      skillCreateAllowed: true,
      skillsCapabilityEnabled: true,
      ephemeralSkillsToggle: false,
    });
    expect(mockInitializeAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        accessibleSkillIds: [scopedSkillId],
        skillAuthoringAvailable: true,
        skillStates,
        defaultActiveOnShare: true,
      }),
      expect.objectContaining({
        listSkillsByAccess: mockRegistryListSkillsByAccess,
        listAlwaysApplySkills: mockRegistryListAlwaysApplySkills,
        getSkillByName: mockRegistryGetSkillByName,
      }),
    );
    expect(mockGetSkillDbMethods).toHaveBeenCalledTimes(1);
  });
});
