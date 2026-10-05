const { logger } = require('@librechat/data-schemas');
const { createContentAggregator, GraphNodeKeys } = require('@librechat/agents');
const {
  resolveSender,
  copyToolApprovalAdmissionMetadata,
  resolveRunConversation,
  resolveAdmittedCodeEnvironmentDecision,
  createConcurrencyLimiter,
  loadSkillStates,
  resolveInitializationProjectContext,
  initializeAgent,
  primeInvokedSkillsForProfiles,
  validateAgentModel,
  extractManualSkills,
  GenerationJobManager,
  getCustomEndpointConfig,
  getProviderConfig,
  discoverConnectedAgents,
  resolveAgentTokenConfig,
  resolveAgentScopedSkillIds,
  resolveModelSpecSkillIds,
  getAgentStartupTelemetry,
  isContentFilterError,
  buildAgentContextAttachmentsByAgentId,
  collectCodeExecutionProfileRoutes,
  getLazySubagentConfigId,
  createRoutedGraphMemberLoader,
  createViewableSubagentLoader,
  resolveCodeExecutionContext,
  resolveCodeExecutionWorkspaceSelections,
  optsOutOfAttachedCodeEnvironment,
  isImplicitStatefulCodeRouteAvailable,
  resolveCodeExecutionWorkspaceContext,
  resolveSubagentCodeWorkspaceInheritance,
  resolveSubagentCodeAvailability,
  guardRoutableSubagent,
  createStatefulCodeEnvironmentPolicyError,
  buildSubagentThreadTaskConfig,
  backgroundCompletionWakeupsEnabled,
  createLazyAgentHistoryResolver,
  resolveToolRoleGrants,
  createChatRunFileBindings,
  createAxiosInstance,
  getCodeApiAuthHeaders,
  getCodeExecutionBaseUrl,
  getAuthorizedRunFileSnapshot,
  isRunFileSharingRequested,
  encodeAndFormatDocuments,
  encodeAndFormatAudios,
  encodeAndFormatVideos,
  extractFileContext,
  createScheduleUpstreamTokenProviderResolver,
  initializeWithScheduledMCPBearer,
  initializeWithScheduleMCPExecution,
  retainScheduleMCPCompletion,
  getScheduleMCPExecution,
  getMCPRequestContext,
  createSubagentCodeRouting,
} = require('@librechat/api');
const {
  ResourceType,
  EModelEndpoint,
  PermissionBits,
  MAX_SUBAGENT_DEPTH,
  isAgentsEndpoint,
  AgentCapabilities,
  normalizeServerName,
  Tools,
  VisionModes,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_SUBAGENT_RUN_CONFIGS,
  isEphemeralAgentId,
  resolveAllowedStatefulCodeEnvironments,
} = require('librechat-data-provider');
const {
  createToolEndCallback,
  createAttachmentEmitter,
  createPtcProgressEmitter,
  createBackgroundCodeResultHandler,
  getDefaultHandlers,
} = require('~/server/controllers/agents/callbacks');
const {
  loadAgentTools,
  loadToolsForExecution,
  getAccessibleMcpServerNames,
  isFatalAgentInitializationError,
} = require('~/server/services/ToolService');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const {
  getSkillToolDeps,
  getSkillDbMethods,
  canAuthorSkillFiles,
  withDeploymentSkillIds,
  buildAgentToolContext,
  resolveMemoryAvailability,
  enrichLoadedToolsWithAgentContext,
} = require('./skillDeps');
const {
  loadCodeApiKey,
  provisionToCodeEnv,
  provisionToVectorDB,
  checkSessionsAlive,
} = require('~/server/services/Files/provision');
const { createProvisionFilesCallback } = require('~/server/services/Files/provisionCallback');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { checkPermission, findAccessibleResources } = require('~/server/services/PermissionService');
const AgentClient = require('~/server/controllers/agents/client');
const { processAddedConvo } = require('./addedConvo');
const { getLinkedInstructionsResolver } = require('./linkedInstructions');
const subagentThreadTaskStore = require('./subagentThreadStore');
const {
  preregisterBackgroundToolCompletion,
  pendingBackgroundToolCompletions,
  createBackgroundToolResultPersistence,
  claimBackgroundToolResult,
  createDeadBackgroundToolClaimRecovery,
} = require('./backgroundCompletion');
const { logViolation } = require('~/cache');
const db = require('~/models');
const { getAppConfig } = require('~/server/services/Config');
const { getStrategyFunctions } = require('~/server/services/Files/strategies');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { processCodeOutput, runPreviewFinalize } = require('~/server/services/Files/Code/process');
const { determineFileType } = require('~/server/utils');

const SUBAGENT_GRAPH_LOAD_CONCURRENCY = 4;

/**
 * Creates a tool loader function for the agent.
 * @param {ServerRequest} req - Request-backed tool adapter input
 * @param {ServerResponse} res - Response-backed tool adapter input
 * @param {AbortSignal} signal - The abort signal
 * @param {string | null} [streamId] - The stream ID for resumable mode
 * @param {boolean} [definitionsOnly=false] - When true, returns only serializable
 *   tool definitions without creating full tool instances (for event-driven mode)
 * @param {number} [jobCreatedAt] - The generation epoch that owns emitted tool events
 */
function createToolLoader(
  req,
  res,
  signal,
  streamId = null,
  definitionsOnly = false,
  jobCreatedAt,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
) {
  /**
   * @param {object} params
   * @param {string} params.agentId
   * @param {string[]} params.tools
   * @param {string} params.provider
   * @param {string} params.model
   * @param {AgentToolResources} params.tool_resources
   * @returns {Promise<{
   *   tools?: StructuredTool[],
   *   toolContextMap: Record<string, unknown>,
   *   toolDefinitions?: import('@librechat/agents').LCTool[],
   *   userMCPAuthMap?: Record<string, Record<string, string>>,
   *   toolRegistry?: import('@librechat/agents').LCToolRegistry
   * } | undefined>}
   */
  return async function loadTools({
    tools,
    model,
    agentId,
    provider,
    tool_options,
    tool_resources,
    requestBody,
    codeExecutionContext,
    accessibleMcpServerNames,
  }) {
    const agent = { id: agentId, tools, provider, model, tool_options };
    try {
      return await loadAgentTools({
        req,
        res,
        agent,
        signal,
        streamId,
        jobCreatedAt,
        requestBody,
        tool_resources,
        codeExecutionContext,
        definitionsOnly,
        accessibleMcpServerNames,
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
      });
    } catch (error) {
      if (isFatalAgentInitializationError(error, { signal }) || isContentFilterError(error)) {
        throw error;
      }
      logger.error('Error loading tools for agent ' + agentId, error);
    }
  };
}

/**
 * Initializes the AgentClient for a given request/response cycle.
 * @param {Object} params
 * @param {Express.Request} params.req
 * @param {Express.Response} params.res
 * @param {AbortSignal} params.signal
 * @param {Object} params.endpointOption
 * @param {number} [params.jobCreatedAt]
 * @param {string} [params.checkpointNamespace] Immutable saver-level generation scope
 * @param {string} [params.foregroundRunId] Canonical response identity for foreground execution
 * @param {import('@librechat/api').MCPRuntimeRequestBody} [params.requestBody]
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider]
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {boolean} [params.isResume] Whether this initialization is replaying an
 *   already-in-flight turn (a resumed stream), rather than starting a new one.
 *   Resolution of every agent's `instructionsPrompt` link still runs, cache-first,
 *   but usage is not recorded again for the same turn.
 */
const initializeClientWithProvider = async ({
  req,
  res,
  signal,
  endpointOption,
  jobCreatedAt,
  checkpointNamespace,
  foregroundRunId,
  requestBody,
  toolTimingReplayEvents,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  isResume,
}) => {
  if (!endpointOption) {
    throw new Error('Endpoint option not provided');
  }
  const appConfig = req.config;
  const completionWakeupsEnabled = backgroundCompletionWakeupsEnabled(
    appConfig?.endpoints?.[EModelEndpoint.agents],
  );
  const ordinaryToolCancellationEnabled =
    appConfig?.endpoints?.[EModelEndpoint.agents]?.backgroundTasks?.ordinaryToolCancellation ===
    true;
  const backgroundCompletionResultMaxChars =
    appConfig?.endpoints?.[EModelEndpoint.agents]?.backgroundTasks?.completionResultMaxChars;
  /** The normal controller resolves this once for timestamp anchoring. Reuse
   * that trusted document for child-thread execution policy; resume and direct
   * callers fall back to the same owner-scoped lookup. */
  let runtimeRequestBody = requestBody ?? req.body;
  const conversationId = runtimeRequestBody?.conversationId;
  const requestConversationPromise = resolveRunConversation({
    request: req,
    conversationId,
    loadConversation: (conversationId) => db.getConvo(req.user.id, conversationId),
  });
  const startupTelemetry = getAgentStartupTelemetry(req);

  /** @type {string | null} */
  const streamId = req._resumableStreamId || null;

  /** @type {Array<UsageMetadata>} */
  const collectedUsage = [];
  /**
   * Vertex Gemini 3 thought signatures captured from `chat_model_end` events,
   * keyed by `tool_call_id`. Persisted on
   * `responseMessage.metadata.thoughtSignatures` so subsequent conversation
   * turns can restore each signature onto the right reconstructed AIMessage's
   * `additional_kwargs.signatures` and avoid 400s when resuming after a tool
   * round-trip without a final text reply. Always allocated; capture path
   * is a no-op for providers that don't emit signatures (OpenAI, Anthropic,
   * Bedrock, etc.).
   * @type {Record<string, string>}
   */
  const collectedThoughtSignatures = {};
  /** @type {ArtifactPromises} */
  const artifactPromises = [];
  /** @type {Map<string, import('@librechat/api').ToolInputValidationError>} */
  const toolInputValidationErrors = new Map();
  const { contentParts, aggregateContent, stepMap } = createContentAggregator();
  const artifactToolEndCallback = createToolEndCallback({
    req,
    res,
    artifactPromises,
    streamId,
    jobCreatedAt,
  });

  /** Query accessible skill IDs once per run (shared across all agents).
   *  Skills activate under strict opt-in semantics — see
   *  `resolveAgentScopedSkillIds` for the per-agent activation predicate:
   *    - Ephemeral agent → model-spec `skills` config first, otherwise the
   *      per-conversation skills badge toggle (full catalog).
   *    - Persisted agent → `agent.skills_enabled === true`. Optional
   *      `agent.skills` allowlist narrows the catalog; empty/undefined
   *      allowlist with the toggle on = full accessible catalog. */
  const enabledCapabilities = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities);
  const skillsCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.skills);
  const codeCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.execute_code);
  const fileSearchCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.file_search);
  /** Started here but joined into the startup `Promise.all` below rather than
   *  awaited inline: neither flag is read until agent construction, so the role
   *  lookup overlaps the memory, skill and conversation queries instead of
   *  delaying them. Skipped entirely when the deployment has both capabilities
   *  off, since both flags are false either way. One lookup answers both. */
  const toolRoleGrantsPromise =
    codeCapabilityEnabled || fileSearchCapabilityEnabled
      ? resolveToolRoleGrants({ req, getRoleByName: db.getRoleByName, context: 'initializeClient' })
      : null;
  const backgroundToolsAvailable = enabledCapabilities.has(AgentCapabilities.run_in_background);
  const toolIntentsAvailable = enabledCapabilities.has(AgentCapabilities.tool_intents);
  /** Resolves any agent's `instructionsPrompt` link this run encounters — primary,
   *  handoff, subagent, or added-conversation agent. A resumed turn records no
   *  usage at all, including for a lazy subagent spawned for the first time
   *  during that resumed turn: only a fresh turn records usage. */
  const resolveLinkedInstructions = getLinkedInstructionsResolver();
  const recordLinkedPromptUsage = !isResume;
  const deferredToolsAvailable = enabledCapabilities.has(AgentCapabilities.deferred_tools);
  const programmaticToolsAvailable = enabledCapabilities.has(AgentCapabilities.programmatic_tools);
  const statefulSessionsAvailable = enabledCapabilities.has(
    AgentCapabilities.stateful_code_sessions,
  );
  const allowedStatefulCodeEnvironments = resolveAllowedStatefulCodeEnvironments(
    appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.allowedEnvironments,
  );
  const ephemeralSkillsToggle = req.body?.ephemeralAgent?.skills === true;
  const skillDbMethods = getSkillDbMethods();

  if (!endpointOption.agent) {
    throw new Error('No agent promise provided');
  }

  /** Run-level gate for inline memory tools: the `memory` capability must be
   *  enabled, memory must be configured, and the user must not have opted out.
   *  Requires the memory WRITE permissions (CREATE + UPDATE) — both inline tools
   *  mutate memory — so the tools aren't registered (and shown to the model) for
   *  read-only-memory roles that the runtime loader would then refuse to build.
   *  Agents (or the ephemeral memory badge) opt in per-agent via the `memory`
   *  marker on `tools`. */
  const memoryAvailablePromise = resolveMemoryAvailability({
    enabledCapabilities,
    memoryConfig: appConfig?.memory,
    user: req.user,
    getRoleByName: db.getRoleByName,
  });

  const accessibleSkillIdsPromise = skillsCapabilityEnabled
    ? findAccessibleResources({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.SKILL,
        requiredPermissions: PermissionBits.VIEW,
      }).then(withDeploymentSkillIds)
    : Promise.resolve([]);
  const editableSkillIdsPromise = skillsCapabilityEnabled
    ? findAccessibleResources({
        userId: req.user.id,
        role: req.user.role,
        resourceType: ResourceType.SKILL,
        requiredPermissions: PermissionBits.EDIT,
      })
    : Promise.resolve([]);
  const skillCreateAllowedPromise = skillsCapabilityEnabled
    ? getSkillToolDeps().canCreateSkill({ req })
    : Promise.resolve(false);
  const skillStatesPromise = accessibleSkillIdsPromise.then((accessibleSkillIds) =>
    loadSkillStates({
      userId: req.user.id,
      appConfig,
      getUserById: db.getUserById,
      accessibleSkillIds,
    }),
  );
  const primaryAgentPromise = endpointOption.agent;
  const modelsConfigPromise = getModelsConfig(req);
  const validatedPrimaryAgentPromise = Promise.all([primaryAgentPromise, modelsConfigPromise]).then(
    async ([primaryAgent, modelsConfig]) => {
      if (!primaryAgent) {
        throw new Error('Agent not found');
      }

      const validationResult = await validateAgentModel({
        req,
        res,
        modelsConfig,
        logViolation,
        agent: primaryAgent,
      });
      if (!validationResult.isValid) {
        throw new Error(validationResult.error?.message);
      }

      return { primaryAgent, modelsConfig };
    },
  );

  /**
   * Agent context store - populated after initialization, accessed by callback via closure.
   * Maps agentId -> { userMCPAuthMap, agent, tool_resources, toolRegistry, openAIApiKey }
   * @type {Map<string, {
   *   userMCPAuthMap?: Record<string, Record<string, string>>,
   *   agent?: object,
   *   tool_resources?: object,
   *   toolRegistry?: import('@librechat/agents').LCToolRegistry,
   *   requestScopedConnections?: import('@librechat/api').RequestScopedMCPConnectionStore,
   *   openAIApiKey?: string
   * }>}
   */
  const agentToolContexts = new Map();
  /** Per-call subagent machine routing; assigned once the request's code inputs are known. */
  let subagentCodeRouting;
  const getRoutedToolContext = (agentId, executionContext) =>
    subagentCodeRouting?.getToolContext(agentId, executionContext);
  let runFileBindings;
  const resolveMcpServerName = (toolName, agentId) => {
    if (typeof toolName !== 'string' || typeof agentId !== 'string') {
      return undefined;
    }
    const context = agentToolContexts.get(agentId);
    const registered = context?.toolRegistry?.get?.(toolName);
    if (typeof registered?.mcpRawServerName === 'string') {
      return normalizeServerName(registered.mcpRawServerName);
    }
    for (const [serverName, tools] of Object.entries(context?.mcpAvailableTools ?? {})) {
      if (tools?.[toolName]?.function) {
        return normalizeServerName(serverName);
      }
    }
    return undefined;
  };
  /** Attach only the host-resolved route for the actually executing agent.
   * Runnable metadata is transport data and may contain caller-controlled
   * keys, so discard any incoming route context before resolving from the
   * server-owned per-agent map. This covers both traditional TOOL_END events
   * and event-driven ON_TOOL_EXECUTE callbacks. */
  const toolEndCallback = async (data, metadata = {}) => {
    /** Event-actor action receipt: recorded in graph context at execution time
     * so fork classification never races the asynchronously populated run-step
     * collection. Observational only — a recorder failure must not disturb the
     * tool result path. */
    if (typeof req._agentEventActionObserver === 'function') {
      try {
        req._agentEventActionObserver(data);
      } catch (observerError) {
        logger.warn('[toolEndCallback] Event actor action observer failed', observerError);
      }
    }
    /** Policy-withheld outputs exist solely as execution evidence for the
     * observer above; nothing may flow to artifact processing. */
    if (data?.outputFiltered === true) {
      return;
    }
    const node = typeof metadata.langgraph_node === 'string' ? metadata.langgraph_node : '';
    const nodeAgentId = node.startsWith(GraphNodeKeys.TOOLS)
      ? node.slice(GraphNodeKeys.TOOLS.length)
      : undefined;
    const executingAgentId =
      metadata.executingAgentId ?? metadata.agentId ?? metadata.agent_id ?? nodeAgentId;
    const soleContext =
      agentToolContexts.size === 1 ? agentToolContexts.values().next().value : null;
    const trustedContext =
      getRoutedToolContext(executingAgentId, metadata.executionContext) ??
      (typeof executingAgentId === 'string' ? agentToolContexts.get(executingAgentId) : null) ??
      soleContext;
    const callbackMetadata = { ...metadata };
    delete callbackMetadata.codeExecutionContext;
    if (trustedContext?.codeExecutionContext) {
      callbackMetadata.codeExecutionContext = trustedContext.codeExecutionContext;
    }
    return runFileBindings.deliverToolEnd(artifactToolEndCallback, data, callbackMetadata);
  };
  /** @type {Map<string, import('@librechat/api').EndpointTokenConfig | undefined>} */
  const endpointTokenConfigByAgentId = new Map();

  const invokedSkillIdentities = new Map();
  const toolExecuteOptions = {
    scheduledMCPExecution: getScheduleMCPExecution(getMCPRequestContext(req, res)),
    // Keep foreground cancellation owned by this request even when the agents
    // SDK rebuilds a graph for approval resume. The SDK event's breaker signal
    // is composed with this authoritative job signal by the handler.
    runSignal: signal,
    foregroundRunId,
    attachedCommandStepIds: new Set(),
    ordinaryToolCancellation: ordinaryToolCancellationEnabled,
    backgroundCompletionResultMaxChars,
    loadTools: async (
      toolNames,
      agentId,
      _configurable,
      callerCapabilityProjection,
      runSignal,
      executionContext,
    ) => {
      const ctx =
        getRoutedToolContext(agentId, executionContext) ??
        runFileBindings.getContext(agentId, executionContext) ??
        {};
      logger.debug(`[ON_TOOL_EXECUTE] ctx found: ${!!ctx.userMCPAuthMap}, agent: ${ctx.agent?.id}`);
      logger.debug(`[ON_TOOL_EXECUTE] toolRegistry size: ${ctx.toolRegistry?.size ?? 'undefined'}`);

      const result = await loadToolsForExecution({
        req,
        res,
        signal: runSignal ?? signal,
        streamId,
        conversationId,
        requestBody: runtimeRequestBody,
        toolNames,
        agent: ctx.agent,
        runFileCodeExecutionContext: runFileBindings.getCodeExecutionContext(
          agentId,
          executionContext,
        ),
        toolRegistry: ctx.toolRegistry,
        callerCapabilityProjection,
        backgroundToolNames: ctx.backgroundToolNames,
        intentToolNames: ctx.intentToolNames,
        mcpAvailableTools: ctx.mcpAvailableTools,
        requestScopedConnections: ctx.requestScopedConnections,
        userMCPAuthMap: ctx.userMCPAuthMap,
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
        tool_resources: ctx.tool_resources,
        actionsEnabled: ctx.actionsEnabled,
        accessibleMcpServerNames: ctx.accessibleMcpServerNames,
        jobCreatedAt,
      });

      logger.debug(`[ON_TOOL_EXECUTE] loaded ${result.loadedTools?.length ?? 0} tools`);
      /** Per-agent narrowed flag (admin capability AND agent.tools
       *  includes execute_code), captured in `agentToolContexts` when
       *  the agent initialized. Falls back to `false` on any stray
       *  ctx miss so a skills-only agent never gains sandbox access
       *  even if capability lookup somehow skips. */
      return enrichLoadedToolsWithAgentContext({
        result,
        req,
        ctx,
      });
    },
    toolEndCallback,
    /** Bound later by request.js once the authenticated Event Actor owner and
     * generation fence are known. Ordinary background calls remain unchanged. */
    eventActorDetachedAction: {
      reserve: (input) =>
        req._agentEventDetachedActionLifecycle?.reserve(input) ??
        Promise.resolve({ status: 'ignored' }),
      markRunning: (input) =>
        req._agentEventDetachedActionLifecycle?.markRunning(input) ?? Promise.resolve(false),
      settle: (input) =>
        req._agentEventDetachedActionLifecycle?.settle(input) ?? Promise.resolve(false),
      wake: (input) => req._agentEventDetachedActionLifecycle?.wake(input) ?? Promise.resolve(),
    },
    persistBackgroundCodeResult: createBackgroundCodeResultHandler({
      req,
      streamId,
      jobCreatedAt,
      updateToolCallResult: db.updateToolCallResult,
    }),
    backgroundToolCompletion: {
      ...(completionWakeupsEnabled ? { preregister: preregisterBackgroundToolCompletion } : {}),
      /** Deliveries admitted before wake-ups were disabled still drain and still count. */
      pending: pendingBackgroundToolCompletions,
      persist: createBackgroundToolResultPersistence({
        req,
        updateToolCallResult: db.updateToolCallResult,
      }),
      claim: (input) => claimBackgroundToolResult(db, input),
      recoverDeadClaim: createDeadBackgroundToolClaimRecovery(
        db.releaseBackgroundToolResultClaims,
        (conversationId) => GenerationJobManager.getJob(conversationId),
        ({ userId, conversationId, claimId }) =>
          GenerationJobManager.fenceGenerationClaimForRecovery(
            userId,
            claimId,
            conversationId,
            conversationId,
          ),
      ),
    },
    emitAttachment: createAttachmentEmitter({ res, streamId, jobCreatedAt }),
    emitPtcProgress: createPtcProgressEmitter({ res, streamId, jobCreatedAt }),
    onSkillResolved: (skill, { agentId }) => {
      if (agentId === primaryConfig.id) {
        invokedSkillIdentities.set(skill.id, skill);
      }
    },
    ...getSkillToolDeps(),
    provisionFiles: createProvisionFilesCallback({
      req,
      agentToolContexts,
      resolvePrimaryAgentId: () => primaryConfig?.id,
      resolveExecutionContext: getRoutedToolContext,
    }),
  };

  const summarizationOptions =
    appConfig?.summarization?.enabled === false ? { enabled: false } : { enabled: true };

  /**
   * Per-request map of per-subagent `createContentAggregator` instances
   * keyed by the parent's `tool_call_id`. The handler in `callbacks.js`
   * lazily creates an aggregator for each distinct `parentToolCallId`
   * and folds every `ON_SUBAGENT_UPDATE` event into it as they stream
   * in. `AgentClient` pulls each aggregator's `contentParts` at message
   * save time and attaches them to the matching `subagent` tool_call so
   * the child's reasoning / tool calls / final text survive a page
   * refresh — the client-side Recoil atom is best-effort live-only.
   */
  const subagentAggregatorsByToolCallId = new Map();

  /** Backend prices each model call authoritatively (premium tiers, cache
   *  rates) and emits the cost on on_token_usage when contextCost is on, so
   *  the gauge sums real costs instead of re-deriving from base rates.
   *  `endpointTokenConfig` is filled in once `primaryConfig` resolves below so
   *  custom-endpoint agents price with their configured rates, not defaults. */
  const usageCost = {
    enabled: appConfig?.interfaceConfig?.contextCost === true,
    pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
  };

  /** Latest visible context snapshot + every emitted usage payload for this
   *  response, captured by the handlers and persisted on the response message's
   *  metadata so the breakdown and branch/total cost survive a reload.
   *  `onSnapshot` is installed by the client to publish run state after each snapshot.
   *  @type {{ latest: import('librechat-data-provider').TContextUsageEvent | null, count: number, onSnapshot?: () => void }} */
  const contextUsageSink = { latest: null, count: 0 };
  /** @type {Array<import('librechat-data-provider').TTokenUsageEvent>} */
  const usageEmitSink = [];

  const chatProjectContextPromise = resolveInitializationProjectContext(
    { req, endpointOption, conversationId, conversationPromise: requestConversationPromise },
    {
      getConvo: db.getConvo,
      getChatProject: db.getChatProject,
      getProjectFiles: db.getProjectFiles,
    },
  );

  const [
    memoryAvailable,
    accessibleSkillIds,
    editableSkillIds,
    skillCreateAllowed,
    { skillStates, defaultActiveOnShare },
    { primaryAgent, modelsConfig },
    requestConversation,
    chatProjectContext,
    toolRoleGrants,
  ] = await Promise.all([
    memoryAvailablePromise,
    accessibleSkillIdsPromise,
    editableSkillIdsPromise,
    skillCreateAllowedPromise,
    skillStatesPromise,
    validatedPrimaryAgentPromise,
    requestConversationPromise,
    chatProjectContextPromise,
    toolRoleGrantsPromise,
  ]);
  /** Preserve the owner-scoped fallback for loaders that share this request. */
  req.resolvedConversation = requestConversation;
  req.chatProjectContext = chatProjectContext;
  req.chatProjectContextEnabled = true;
  const { decision: codeEnvironmentDecision, conversation: admittedConversation } =
    await resolveAdmittedCodeEnvironmentDecision({
      appConfig,
      conversation: requestConversation,
      conversationId,
      requestedMode: runtimeRequestBody?.codeEnvironmentMode,
      requestedSelections: runtimeRequestBody?.codeWorkspaces,
      readDecision: (id) => db.readAdmittedConvoCodeEnvironmentDecision(req.user.id, id),
    });
  req.resolvedConversation = admittedConversation;
  /** Trusted, normalized pair used by every persistence path, including init failures. */
  req._codeEnvironmentDecision = codeEnvironmentDecision;
  runtimeRequestBody = {
    ...runtimeRequestBody,
    codeEnvironmentMode: codeEnvironmentDecision.mode,
    codeWorkspaces: codeEnvironmentDecision.codeWorkspaces,
  };
  req.body.codeEnvironmentMode = codeEnvironmentDecision.mode;
  if (codeEnvironmentDecision.codeWorkspaces == null) {
    delete req.body.codeWorkspaces;
  } else {
    req.body.codeWorkspaces = codeEnvironmentDecision.codeWorkspaces;
  }
  delete endpointOption.agent;

  /** The deployment switch AND the role grant. `initializeAgent` rebuilds
   *  `bash_tool`, `read_file` and the workspace file tools from this flag after
   *  the tool loader has already dropped `execute_code` for a denied role, and
   *  forwards the code-environment context to their handlers — so the grant has
   *  to travel with the flag, not just with the tool list. */
  const codeEnvAvailable = codeCapabilityEnabled && toolRoleGrants?.runCode === true;
  /** The same pairing for the other gated tool. Read only by the resend-file
   *  priming inside `initializeAgent`: `false` skips re-hydrating prior-turn
   *  `file_search` files, whose usage counters would otherwise be bumped and
   *  whose resources primed for a tool the loader is about to drop. */
  const fileSearchAvailable = fileSearchCapabilityEnabled && toolRoleGrants?.fileSearch === true;

  const agentConfigs = new Map();
  const allowedProviders = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders);

  /** Event-driven mode: only load tool definitions, not full instances */
  const loadTools = createToolLoader(
    req,
    res,
    signal,
    streamId,
    true,
    jobCreatedAt,
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
  );
  /** @type {Array<MongoFile>} */
  const requestFiles = req.body.files ?? [];
  /** @type {string | undefined} */
  const parentMessageId = req.body.parentMessageId;
  /**
   * Skill names the user invoked via the `$` popover for this turn. Only flows
   * to the primary agent — handoff agents are follow-up turns that don't see
   * the user's per-submission `$` selections. `extractManualSkills` also
   * drops non-string / empty elements so a crafted payload can't reach the
   * `getSkillByName` DB query with nonsense values.
   * @type {string[] | undefined}
   */
  const manualSkills = extractManualSkills(req.body);

  const selectedModelSpec =
    endpointOption.spec && Array.isArray(appConfig?.modelSpecs?.list)
      ? appConfig.modelSpecs.list.find((modelSpec) => modelSpec.name === endpointOption.spec)
      : null;

  if (
    primaryAgent &&
    isEphemeralAgentId(primaryAgent.id) &&
    selectedModelSpec &&
    Object.hasOwn(selectedModelSpec, 'skills')
  ) {
    if (selectedModelSpec.skills === true) {
      primaryAgent.skills_enabled = true;
      delete primaryAgent.skills;
    } else if (selectedModelSpec.skills === false) {
      primaryAgent.skills_enabled = false;
      primaryAgent.skills = [];
    } else if (Array.isArray(selectedModelSpec.skills)) {
      const resolvedSkillIds = await resolveModelSpecSkillIds({
        names: selectedModelSpec.skills,
        accessibleSkillIds,
        getSkillByName: skillDbMethods.getSkillByName,
      });
      primaryAgent.skills_enabled = true;
      primaryAgent.skills = resolvedSkillIds.map((id) => id.toString());
    }
  }
  const primaryScopedSkillIds = resolveAgentScopedSkillIds({
    agent: primaryAgent,
    accessibleSkillIds,
    skillsCapabilityEnabled,
    ephemeralSkillsToggle,
  });
  const primaryScopedEditableSkillIds = resolveAgentScopedSkillIds({
    agent: primaryAgent,
    accessibleSkillIds: editableSkillIds,
    skillsCapabilityEnabled,
    ephemeralSkillsToggle,
  });
  const primarySkillAuthoringAvailable = canAuthorSkillFiles({
    agent: primaryAgent,
    scopedEditableSkillIds: primaryScopedEditableSkillIds,
    skillCreateAllowed,
    skillsCapabilityEnabled,
    ephemeralSkillsToggle,
  });
  const primaryConfig = await initializeAgent(
    {
      useChatProjectContext: true,
      req,
      res,
      loadTools,
      requestFiles,
      conversationId,
      parentMessageId,
      requestBody: runtimeRequestBody,
      agent: primaryAgent,
      endpointOption,
      allowedProviders,
      isInitialAgent: true,
      accessibleSkillIds: primaryScopedSkillIds,
      skillAuthoringAvailable: primarySkillAuthoringAvailable,
      codeEnvAvailable,
      fileSearchAvailable,
      resolveLinkedInstructions,
      recordLinkedPromptUsage,
      backgroundToolsAvailable,
      toolIntentsAvailable,
      statefulSessionsAvailable,
      allowedStatefulCodeEnvironments,
      memoryAvailable,
      skillStates,
      defaultActiveOnShare,
      manualSkills,
      signal,
    },
    {
      getProjectFiles: db.getProjectFiles,
      getFiles: db.getFiles,
      getUserKey: db.getUserKey,
      getMessages: db.getMessages,
      getConvoFiles: db.getConvoFiles,
      getAccessibleMcpServerNames,
      updateFilesUsage: db.updateFilesUsage,
      getUserKeyValues: db.getUserKeyValues,
      getUserCodeFiles: db.getUserCodeFiles,
      getDeferredProvisionFiles: db.getDeferredProvisionFiles,
      getToolFilesByIds: db.getToolFilesByIds,
      getCodeGeneratedFiles: db.getCodeGeneratedFiles,
      filterFilesByAgentAccess,
      listSkillsByAccess: skillDbMethods.listSkillsByAccess,
      listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
      getSkillByName: skillDbMethods.getSkillByName,
      provisionToCodeEnv,
      provisionToVectorDB,
      checkSessionsAlive,
      loadCodeApiKey,
      updateFile: db.updateFile,
      getRoleByName: db.getRoleByName,
    },
  );

  /** Price emitted usage with the primary agent's resolved endpoint config so
   *  custom-endpoint agents reflect configured rates (mirrors the AgentClient
   *  spending path, which reads the same config). */
  usageCost.endpointTokenConfig = primaryConfig.endpointTokenConfig;

  logger.debug(
    `[initializeClient] Storing tool context for ${primaryConfig.id}: ${primaryConfig.toolDefinitions?.length ?? 0} tools, registry size: ${primaryConfig.toolRegistry?.size ?? '0'}`,
  );
  agentToolContexts.set(
    primaryConfig.id,
    buildAgentToolContext({ agent: primaryAgent, config: primaryConfig }),
  );

  const {
    agentConfigs: discoveredConfigs,
    edges: discoveredEdges,
    userMCPAuthMap: discoveredMCPAuthMap,
    skippedAgentIds: discoveredSkippedIds,
  } = await discoverConnectedAgents(
    {
      req,
      res,
      signal,
      primaryConfig,
      agent_ids: primaryConfig.agent_ids,
      endpointOption,
      allowedProviders,
      modelsConfig,
      loadTools,
      requestFiles,
      conversationId,
      parentMessageId,
      requestBody: runtimeRequestBody,
      computeAccessibleSkillIds: (agent) =>
        resolveAgentScopedSkillIds({
          agent,
          accessibleSkillIds,
          skillsCapabilityEnabled,
          ephemeralSkillsToggle,
        }),
      computeSkillAuthoringAvailable: (agent) =>
        canAuthorSkillFiles({
          agent,
          scopedEditableSkillIds: resolveAgentScopedSkillIds({
            agent,
            accessibleSkillIds: editableSkillIds,
            skillsCapabilityEnabled,
            ephemeralSkillsToggle,
          }),
          skillCreateAllowed,
          skillsCapabilityEnabled,
          ephemeralSkillsToggle,
        }),
      skillStates,
      defaultActiveOnShare,
      codeEnvAvailable,
      fileSearchAvailable,
      resolveLinkedInstructions,
      recordLinkedPromptUsage,
      backgroundToolsAvailable,
      toolIntentsAvailable,
      statefulSessionsAvailable,
      allowedStatefulCodeEnvironments,
      memoryAvailable,
    },
    {
      getAgent: db.getAgent,
      checkPermission,
      logViolation,
      db: {
        getProjectFiles: db.getProjectFiles,
        getFiles: db.getFiles,
        getUserKey: db.getUserKey,
        getMessages: db.getMessages,
        getConvoFiles: db.getConvoFiles,
        getAccessibleMcpServerNames,
        updateFilesUsage: db.updateFilesUsage,
        getUserKeyValues: db.getUserKeyValues,
        getUserCodeFiles: db.getUserCodeFiles,
        getDeferredProvisionFiles: db.getDeferredProvisionFiles,
        getToolFilesByIds: db.getToolFilesByIds,
        getCodeGeneratedFiles: db.getCodeGeneratedFiles,
        filterFilesByAgentAccess,
        listSkillsByAccess: skillDbMethods.listSkillsByAccess,
        listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
        getSkillByName: skillDbMethods.getSkillByName,
        provisionToCodeEnv,
        provisionToVectorDB,
        checkSessionsAlive,
        loadCodeApiKey,
        updateFile: db.updateFile,
        getRoleByName: db.getRoleByName,
      },
      // The callback fires during BFS, before the helper prunes agents
      // whose edges end up filtered. Don't populate `agentConfigs` here —
      // `discoveredConfigs` (returned below) is the authoritative pruned
      // set. The per-agent tool context map is OK to keep populated even
      // for pruned ids: it's only read by closure in ON_TOOL_EXECUTE,
      // stale entries are unreachable at runtime.
      onAgentInitialized: (agentId, agent, config) => {
        agentToolContexts.set(agentId, buildAgentToolContext({ agent, config }));
      },
      // Pass through the `@librechat/api` exports so that tests which
      // `jest.mock('@librechat/api')` can override the initializer/validator.
      initializeAgent,
      validateAgentModel,
    },
  );

  // Copy the pruned discovery result into the outer map. Anything the
  // helper dropped (skipped or unreachable after edge filtering) is
  // intentionally absent. `processAddedConvo` below may still add more
  // entries for parallel multi-convo execution.
  for (const [agentId, config] of discoveredConfigs) {
    agentConfigs.set(agentId, config);
  }

  let userMCPAuthMap = discoveredMCPAuthMap;
  let edges = discoveredEdges;

  /** Multi-Convo: Process addedConvo for parallel agent execution */
  const { userMCPAuthMap: updatedMCPAuthMap } = await processAddedConvo({
    req,
    res,
    loadTools,
    logViolation,
    modelsConfig,
    requestFiles,
    agentConfigs,
    primaryAgent,
    endpointOption,
    userMCPAuthMap,
    conversationId,
    parentMessageId,
    requestBody: runtimeRequestBody,
    allowedProviders,
    primaryAgentId: primaryConfig.id,
    accessibleSkillIds,
    editableSkillIds,
    skillsCapabilityEnabled,
    ephemeralSkillsToggle,
    skillCreateAllowed,
    skillStates,
    defaultActiveOnShare,
    codeEnvAvailable,
    fileSearchAvailable,
    resolveLinkedInstructions,
    recordLinkedPromptUsage,
    backgroundToolsAvailable,
    toolIntentsAvailable,
    statefulSessionsAvailable,
    memoryAvailable,
    signal,
  });

  if (updatedMCPAuthMap) {
    userMCPAuthMap = updatedMCPAuthMap;
  }
  userMCPAuthMap ??= {};
  for (const [agentId, config] of agentConfigs) {
    if (agentToolContexts.has(agentId)) {
      continue;
    }
    agentToolContexts.set(agentId, buildAgentToolContext({ agent: config, config }));
  }

  // `discoverConnectedAgents` always returns a concrete array, so no
  // further normalization is needed before handing this to `createRun`.
  primaryConfig.edges = edges;

  // Subagents run in isolated context windows and are invoked via a dedicated
  // spawn tool, not handoff edges. Explicit children are advertised as inert,
  // VIEW-checked descriptors; model, tool, MCP, file, and skill initialization
  // happens only when the SDK selects one.
  const atSubagentThreadDepthLimit = !subagentThreadTaskStore.canCreateChildThread(
    requestConversation?.subagentThread?.depth ?? 0,
  );
  const subagentsCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.subagents);
  const subagentsAvailableForRun = subagentsCapabilityEnabled && !atSubagentThreadDepthLimit;
  /** Track skipped ids locally so repeated failures short-circuit within
   *  the subagent loading loop. Seeded from the discovery helper's skip
   *  list so agents that already failed handoff loading don't get retried. */
  const skippedAgentIds = new Set(discoveredSkippedIds ?? []);

  const lazyMetadataByAgentId = new Map();
  const lazyMetadataLoadsByAgentId = new Map();
  const resolveLazyMetadata = createConcurrencyLimiter(SUBAGENT_GRAPH_LOAD_CONCURRENCY);
  const subagentGraphIds = new Set();
  const expandedSubagentDescriptorState = { configCount: 0, rootAgentIds: [] };

  const assertSubagentGraphRoom = (agentId) => {
    if (subagentGraphIds.has(agentId)) {
      return;
    }
    if (subagentGraphIds.size >= MAX_SUBAGENT_GRAPH_NODES) {
      logger.warn('[initializeClient] Subagent graph node limit exceeded', {
        agentId,
        primaryAgentId: primaryConfig.id,
        loadedSubagentCount: subagentGraphIds.size,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      });
      throw new Error(
        `Subagent graph exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents.`,
      );
    }
  };

  const countExpandedSubagentDescriptor = (agentId) => {
    expandedSubagentDescriptorState.configCount += 1;
    if (expandedSubagentDescriptorState.configCount <= MAX_SUBAGENT_RUN_CONFIGS) {
      return;
    }
    logger.warn('[initializeClient] Subagent run configuration limit exceeded', {
      agentId,
      expandedConfigCount: expandedSubagentDescriptorState.configCount,
      maxSubagentRunConfigs: MAX_SUBAGENT_RUN_CONFIGS,
      rootAgentIds: expandedSubagentDescriptorState.rootAgentIds,
    });
    throw new Error(
      `Subagent run configuration exceeds the maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries.`,
    );
  };

  const userId = req.user?.id;
  const userRole = req.user?.role;

  const throwIfAborted = (abortSignal) => {
    if (!abortSignal?.aborted) return;
    throw abortSignal.reason instanceof Error
      ? abortSignal.reason
      : new Error('Subagent resolution was aborted.');
  };

  const waitForAbort = (promise, abortSignal) => {
    throwIfAborted(abortSignal);
    if (!abortSignal) return promise;
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        reject(
          abortSignal.reason instanceof Error
            ? abortSignal.reason
            : new Error('Subagent resolution was aborted.'),
        );
      };
      abortSignal.addEventListener('abort', onAbort, { once: true });
      if (abortSignal.aborted) {
        onAbort();
      }
      promise.then(resolve, reject).finally(() => {
        abortSignal.removeEventListener('abort', onAbort);
      });
    });
  };

  const hasSubagentViewAccess = async (agent, agentId, abortSignal) => {
    throwIfAborted(abortSignal);
    if (!userId) return false;
    const hasAccess = await waitForAbort(
      checkPermission({
        userId,
        role: userRole,
        resourceType: ResourceType.AGENT,
        resourceId: agent._id,
        requiredPermission: PermissionBits.VIEW,
      }),
      abortSignal,
    );
    throwIfAborted(abortSignal);
    if (!hasAccess) {
      logger.warn(
        `[processAgent] User ${userId} lacks VIEW access to subagent ${agentId}, skipping`,
      );
    }
    return hasAccess;
  };

  const getIncludeReasoningHistory = (agent) => {
    if (!agent.provider) return undefined;
    try {
      return getProviderConfig({ provider: agent.provider, appConfig }).customEndpointConfig
        ?.customParams?.includeReasoningHistory;
    } catch {
      return undefined;
    }
  };

  const getExplicitSubagentIds = (agent) =>
    Array.from(
      new Set(
        Array.isArray(agent.subagents?.agent_ids)
          ? agent.subagents.agent_ids.filter(
              (id) => typeof id === 'string' && id && id !== agent.id,
            )
          : [],
      ),
    );

  const lazyHistoryResolver = createLazyAgentHistoryResolver({
    accessibleSkillIds,
    editableSkillIds,
    skillsCapabilityEnabled,
    ephemeralSkillsToggle,
    userId,
    userRole,
    skillStates,
    defaultActiveOnShare,
    maxCatalogSkills: appConfig?.endpoints?.[EModelEndpoint.agents]?.skills?.maxCatalogSkills,
    listSkillsByAccess: skillDbMethods.listSkillsByAccess,
    listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
    getAccessibleMcpServerNames,
    configuredMcpServerNames: Object.keys(appConfig?.mcpConfig ?? {}),
    canAuthorSkillFiles: ({ agent, scopedEditableSkillIds }) =>
      canAuthorSkillFiles({
        agent,
        scopedEditableSkillIds,
        skillCreateAllowed,
        skillsCapabilityEnabled,
        ephemeralSkillsToggle,
      }),
    deferredToolsAvailable,
    programmaticToolsAvailable,
    backgroundToolsAvailable,
  });

  subagentCodeRouting = createSubagentCodeRouting({
    allowEnvironmentSelection:
      appConfig.endpoints?.agents?.statefulCodeSessions?.allowEnvironmentSelection,
    persistedSelections: admittedConversation?.codeWorkspaces,
    requestedSelections: runtimeRequestBody?.codeWorkspaces,
    environments: appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments,
    userId,
    conversationId,
    getAppConfig,
    getInheritedEnvironments: () => req.codeWorkspaceInheritance,
    sharedRunFiles: isRunFileSharingRequested({
      policy: appConfig.endpoints?.agents?.fileSharing,
      agent: primaryConfig,
    }),
  });

  /** The code flags a lazy subagent runs with in this request. */
  const getSubagentCodeFlags = (agent) => {
    const configuredCodeEnvironments =
      appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions?.environments;
    const attachedEnvironmentOptOut = optsOutOfAttachedCodeEnvironment(
      agent,
      runtimeRequestBody,
      configuredCodeEnvironments,
      isImplicitStatefulCodeRouteAvailable(
        process.env.CODE_ENVIRONMENT_DECISION_VERSION,
        process.env.LIBRECHAT_CODE_BASEURL_STATEFUL,
      ),
    );
    const lazyCodeEnvAvailable =
      codeEnvAvailable === true &&
      agent.tools?.includes(Tools.execute_code) === true &&
      !attachedEnvironmentOptOut;
    const statefulCodeSessions =
      statefulSessionsAvailable === true &&
      lazyCodeEnvAvailable &&
      agent.stateful_code_sessions === true &&
      agent.tools?.includes(Tools.execute_code) === true;
    const statefulCodeEnvironment = agent.stateful_code_environment ?? 'user';
    if (
      statefulCodeSessions &&
      !allowedStatefulCodeEnvironments.includes(statefulCodeEnvironment)
    ) {
      throw createStatefulCodeEnvironmentPolicyError(statefulCodeEnvironment);
    }
    return {
      configuredCodeEnvironments,
      lazyCodeEnvAvailable,
      statefulCodeSessions,
      statefulCodeEnvironment,
    };
  };

  const toLazySubagentMetadata = async (agent) => {
    const {
      configuredCodeEnvironments,
      lazyCodeEnvAvailable,
      statefulCodeSessions,
      statefulCodeEnvironment,
    } = getSubagentCodeFlags(agent);
    const codeAvailability = await resolveSubagentCodeAvailability({
      agentId: agent.id,
      codeEnvAvailable: lazyCodeEnvAvailable,
      statefulCodeSessions,
      resolveContext: async () => {
        if (!lazyCodeEnvAvailable) return undefined;
        return resolveCodeExecutionWorkspaceContext({
          context: resolveCodeExecutionContext({
            statefulSessions: statefulCodeSessions,
            environment: statefulCodeEnvironment,
            environmentId: agent.code_environment_id,
            environmentIds: agent.code_environment_ids,
            allowEnvironmentSelection:
              appConfig.endpoints?.agents?.statefulCodeSessions?.allowEnvironmentSelection,
            workspaceSelections: resolveCodeExecutionWorkspaceSelections({
              conversation: admittedConversation,
              request: runtimeRequestBody,
            }),
            inheritedEnvironments: req.codeWorkspaceInheritance,
            environments: configuredCodeEnvironments,
            userId,
            agentId: agent.id,
            conversationId,
          }),
          requestedSelections: runtimeRequestBody?.codeWorkspaces,
          persistedSelections: admittedConversation?.codeWorkspaces,
          environments: configuredCodeEnvironments,
          getAppConfig,
        });
      },
    });
    const { codeExecutionContext } = codeAvailability;
    const [
      {
        alwaysApplySkillPrimes,
        historicalToolNames,
        historicalMcpServerNames,
        skillAuthoringAvailable,
      },
      { subagentHostArgs, codeExecutionChoices },
    ] = await Promise.all([
      lazyHistoryResolver.resolve({
        agent,
        codeExecutionAvailable: lazyCodeEnvAvailable,
        memoryAvailable,
      }),
      waitForAbort(
        subagentCodeRouting.describe(
          agent,
          { statefulCodeSessions, statefulCodeEnvironment },
          signal,
        ),
        signal,
      ),
    ]);
    return copyToolApprovalAdmissionMetadata(
      {
        id: agent.id,
        name: agent.name,
        description: agent.description,
        provider: agent.provider,
        model: agent.model,
        model_parameters: { model: agent.model_parameters?.model },
        recursion_limit: agent.recursion_limit,
        memory_scope: agent.memory_scope,
        memoryToolsRegistered:
          memoryAvailable === true && agent.tools?.includes(Tools.memory) === true,
        subagents: agent.subagents,
        configId: getLazySubagentConfigId(agent),
        ...codeAvailability,
        statefulCodeEnvironment,
        codeSessionKey: codeExecutionContext?.codeSessionKey,
        subagentHostArgs,
        codeExecutionChoices,
        subagentCodeFlags: { statefulCodeSessions, statefulCodeEnvironment },
        includeReasoningHistory: getIncludeReasoningHistory(agent),
        alwaysApplySkillPrimes,
        historicalToolNames,
        historicalMcpServerNames,
        skillAuthoringAvailable: skillAuthoringAvailable === true,
      },
      agent,
      {
        skillPrimes: alwaysApplySkillPrimes,
        rawMcpServerNames: historicalMcpServerNames,
        toolsAvailable: enabledCapabilities.has(AgentCapabilities.tools),
      },
    );
  };

  const loadViewableSubagent = createViewableSubagentLoader({
    getAgent: (agentId) => db.getAgentWithVersionCount({ id: agentId }),
    canView: (agent, agentId) => hasSubagentViewAccess(agent, agentId),
  });

  const loadSubagentMetadata = async (agentId) => {
    if (skippedAgentIds.has(agentId)) return null;
    const cached = lazyMetadataByAgentId.get(agentId);
    if (cached) return cached;
    let loading = lazyMetadataLoadsByAgentId.get(agentId);
    if (!loading) {
      loading = resolveLazyMetadata(async () => {
        const agent = await loadViewableSubagent(agentId);
        if (!agent) {
          skippedAgentIds.add(agentId);
          return null;
        }
        const metadata = await toLazySubagentMetadata(agent);
        lazyMetadataByAgentId.set(agentId, metadata);
        return metadata;
      });
      lazyMetadataLoadsByAgentId.set(agentId, loading);
    }
    try {
      return await loading;
    } catch (error) {
      if (isFatalAgentInitializationError(error, { signal })) {
        throw error;
      }
      logger.error(`[initializeClient] Error loading subagent metadata ${agentId}:`, error);
      skippedAgentIds.add(agentId);
      return null;
    } finally {
      if (lazyMetadataLoadsByAgentId.get(agentId) === loading) {
        lazyMetadataLoadsByAgentId.delete(agentId);
      }
    }
  };

  const loadGraphMemberCapabilityMetadata = async (agent) => {
    if (!agent.subagents?.enabled) return [];
    const memberIds = Array.from(
      new Set((agent.subagents.graphs ?? []).flatMap((graph) => graph.agent_ids ?? [])),
    ).filter(
      (memberId) =>
        memberId !== agent.id && memberId !== primaryConfig.id && !agentConfigs.has(memberId),
    );
    const stagedMemberIds = memberIds.filter((memberId) => !subagentGraphIds.has(memberId));
    if (subagentGraphIds.size + stagedMemberIds.length > MAX_SUBAGENT_GRAPH_NODES) {
      logger.warn('[initializeClient] Subagent graph node limit exceeded', {
        agentId: stagedMemberIds[0],
        primaryAgentId: primaryConfig.id,
        loadedSubagentCount: subagentGraphIds.size,
        stagedSubagentCount: stagedMemberIds.length,
        maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
      });
      throw new Error(
        `Subagent graph exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents.`,
      );
    }
    for (const memberId of stagedMemberIds) {
      subagentGraphIds.add(memberId);
    }
    const memberMetadata = await Promise.all(memberIds.map(loadSubagentMetadata));
    return memberMetadata.filter(Boolean);
  };

  /**
   * Resolves the selected descriptor inside the foreground request. The
   * legacy initializer requires request/response objects for tool and MCP
   * setup, so this intentionally remains request-scoped until AI-1597 gives
   * child execution a durable runtime context.
   */
  const initializeLoadedSubagent = async ({
    agent,
    agentId,
    configId,
    context,
    lazyChildren,
    codeFlags,
    codeWorkspaceUnavailable,
    viewAccessChecked = false,
  }) => {
    throwIfAborted(context.signal);
    if (!agent || getLazySubagentConfigId(agent) !== configId) {
      throw new Error(`Subagent ${agentId} changed before it could be initialized.`);
    }
    if (!viewAccessChecked && !(await hasSubagentViewAccess(agent, agentId, context.signal))) {
      throw new Error(`You no longer have access to subagent ${agentId}.`);
    }
    const validation = await waitForAbort(
      validateAgentModel({ req, res, agent, modelsConfig, logViolation }),
      context.signal,
    );
    throwIfAborted(context.signal);
    if (!validation.isValid) {
      throw new Error(validation.error?.message ?? `Subagent ${agentId} failed model validation.`);
    }
    const placement = await waitForAbort(
      subagentCodeRouting.place({
        agent,
        flags: codeFlags ?? {},
        context,
        unavailableReason: codeWorkspaceUnavailable,
      }),
      context.signal,
    );
    throwIfAborted(context.signal);
    const routedAgent = placement.agent;
    const scopedSkillIds = resolveAgentScopedSkillIds({
      agent,
      accessibleSkillIds,
      skillsCapabilityEnabled,
      ephemeralSkillsToggle,
    });
    const scopedEditableSkillIds = resolveAgentScopedSkillIds({
      agent,
      accessibleSkillIds: editableSkillIds,
      skillsCapabilityEnabled,
      ephemeralSkillsToggle,
    });
    const config = await waitForAbort(
      subagentCodeRouting.settle(
        placement,
        initializeAgent(
          {
            req,
            res,
            agent: routedAgent,
            loadTools: createToolLoader(
              req,
              res,
              context.signal,
              streamId,
              true,
              jobCreatedAt,
              upstreamTokenProvider,
              upstreamTokenProviderResolver,
            ),
            requestFiles,
            authorizedRunFiles: getAuthorizedRunFileSnapshot({
              policy: appConfig.endpoints?.agents?.fileSharing,
              agent: primaryConfig,
              files: primaryConfig.currentRequestAttachments,
            }),
            conversationId,
            parentMessageId,
            requestBody: runtimeRequestBody,
            endpointOption: { ...endpointOption, endpoint: EModelEndpoint.agents },
            allowedProviders,
            accessibleSkillIds: scopedSkillIds,
            skillAuthoringAvailable: canAuthorSkillFiles({
              agent,
              scopedEditableSkillIds,
              skillCreateAllowed,
              skillsCapabilityEnabled,
              ephemeralSkillsToggle,
            }),
            codeEnvAvailable,
            fileSearchAvailable,
            resolveLinkedInstructions,
            recordLinkedPromptUsage,
            backgroundToolsAvailable,
            toolIntentsAvailable,
            statefulSessionsAvailable,
            allowedStatefulCodeEnvironments,
            memoryAvailable,
            skillStates,
            defaultActiveOnShare,
            signal: context.signal,
          },
          {
            getProjectFiles: db.getProjectFiles,
            getFiles: db.getFiles,
            getUserKey: db.getUserKey,
            getMessages: db.getMessages,
            getConvoFiles: db.getConvoFiles,
            getAccessibleMcpServerNames,
            updateFilesUsage: db.updateFilesUsage,
            getUserKeyValues: db.getUserKeyValues,
            getUserCodeFiles: db.getUserCodeFiles,
            getDeferredProvisionFiles: db.getDeferredProvisionFiles,
            getToolFilesByIds: db.getToolFilesByIds,
            getCodeGeneratedFiles: db.getCodeGeneratedFiles,
            filterFilesByAgentAccess,
            listSkillsByAccess: skillDbMethods.listSkillsByAccess,
            listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
            getSkillByName: skillDbMethods.getSkillByName,
            provisionToCodeEnv,
            provisionToVectorDB,
            checkSessionsAlive,
            loadCodeApiKey,
            updateFile: db.updateFile,
            getRoleByName: db.getRoleByName,
          },
        ),
      ),
      context.signal,
    );
    throwIfAborted(context.signal);
    config.lazySubagentConfigs = lazyChildren;
    if (config.userMCPAuthMap) {
      Object.assign(userMCPAuthMap, config.userMCPAuthMap);
    }
    subagentCodeRouting.attach(agentToolContexts, {
      agentId,
      context,
      placement,
      codeExecutionContext: config.codeExecutionContext,
      toolContext: buildAgentToolContext({ agent: routedAgent, config }),
    });
    endpointTokenConfigByAgentId.set(agentId, config.endpointTokenConfig);
    return config;
  };
  const initializeLazySubagent = async ({
    agentId,
    configId,
    context,
    lazyChildren,
    codeFlags,
    codeWorkspaceUnavailable,
  }) => {
    throwIfAborted(context.signal);
    const agent = await waitForAbort(db.getAgentWithVersionCount({ id: agentId }), context.signal);
    return initializeLoadedSubagent({
      agent,
      agentId,
      configId,
      context,
      lazyChildren,
      codeFlags,
      codeWorkspaceUnavailable,
    });
  };

  const buildLazySubagentDescriptors = async (agent, depth = 0, ancestors = new Set()) => {
    if (!subagentsAvailableForRun || !agent.subagents?.enabled) {
      return [];
    }
    if (agent.subagents.allowSelf !== false) {
      countExpandedSubagentDescriptor(agent.id);
    }
    const subagentIds = getExplicitSubagentIds(agent);
    if (subagentIds.length > 0 && depth >= MAX_SUBAGENT_DEPTH) {
      logger.warn('[initializeClient] Subagent graph depth limit exceeded', {
        agentId: agent.id,
        primaryAgentId: primaryConfig.id,
        depth,
        maxSubagentDepth: MAX_SUBAGENT_DEPTH,
      });
      throw new Error(
        `Subagent graph exceeds the maximum depth of ${MAX_SUBAGENT_DEPTH} at agent ${agent.id}.`,
      );
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(agent.id);
    const descriptors = await Promise.all(
      subagentIds.map(async (subagentId) => {
        if (skippedAgentIds.has(subagentId) || nextAncestors.has(subagentId)) return null;
        const existing =
          subagentId === primaryConfig.id ? primaryConfig : agentConfigs.get(subagentId);
        if (existing) {
          if (subagentId !== primaryConfig.id) {
            assertSubagentGraphRoom(subagentId);
            subagentGraphIds.add(subagentId);
          }
          countExpandedSubagentDescriptor(subagentId);
          /** Every initialized config is expanded independently in `rootSubagentConfigs`.
           *  Descend here only to enforce path-sensitive depth and size limits; mutating the
           *  shared object from this ancestor-specific walk would race its root expansion. */
          await buildLazySubagentDescriptors(existing, depth + 1, nextAncestors);
          return existing;
        }
        const metadata = await loadSubagentMetadata(subagentId);
        if (!metadata) return null;
        if (subagentId !== primaryConfig.id) {
          assertSubagentGraphRoom(subagentId);
          subagentGraphIds.add(subagentId);
        }
        countExpandedSubagentDescriptor(subagentId);
        const childDescriptors = await buildLazySubagentDescriptors(
          metadata,
          depth + 1,
          nextAncestors,
        );
        const lazyChildren = childDescriptors.filter((child) => child.configId);
        const eagerChildren = childDescriptors.filter((child) => !child.configId);
        const subagentGraphMemberMetadata = await loadGraphMemberCapabilityMetadata(metadata);
        return copyToolApprovalAdmissionMetadata(
          {
            id: metadata.id,
            name: metadata.name,
            description: metadata.description,
            provider: metadata.provider,
            model: metadata.model,
            model_parameters: metadata.model_parameters,
            recursion_limit: metadata.recursion_limit,
            memory_scope: metadata.memory_scope,
            memoryToolsRegistered: metadata.memoryToolsRegistered,
            subagents: metadata.subagents,
            configId: metadata.configId,
            codeEnvAvailable: metadata.codeEnvAvailable,
            statefulCodeSessions: metadata.statefulCodeSessions,
            statefulCodeEnvironment: metadata.statefulCodeEnvironment,
            codeExecutionContext: metadata.codeExecutionContext,
            codeSessionKey: metadata.codeSessionKey,
            subagentHostArgs: metadata.subagentHostArgs,
            codeExecutionChoices: metadata.codeExecutionChoices,
            includeReasoningHistory: metadata.includeReasoningHistory,
            skillAuthoringAvailable: metadata.skillAuthoringAvailable,
            alwaysApplySkillPrimes: metadata.alwaysApplySkillPrimes,
            historicalToolNames: metadata.historicalToolNames,
            historicalMcpServerNames: metadata.historicalMcpServerNames,
            lazySubagentConfigs: lazyChildren,
            subagentAgentConfigs: eagerChildren,
            subagentGraphMemberMetadata,
            settle: (context, resolveInputs) =>
              subagentCodeRouting.settleExecution(context, resolveInputs, {
                onCommit: () => publishSharedConfig(context),
              }),
            ...guardRoutableSubagent({
              description: metadata.description,
              codeWorkspaceUnavailable: metadata.codeWorkspaceUnavailable,
              subagentHostArgs: metadata.subagentHostArgs,
              resolve: async (context) => {
                const config = await initializeLazySubagent({
                  agentId: metadata.id,
                  configId: metadata.configId,
                  context,
                  lazyChildren,
                  codeFlags: metadata.subagentCodeFlags,
                  codeWorkspaceUnavailable: metadata.codeWorkspaceUnavailable,
                });
                config.subagentAgentConfigs = eagerChildren;
                if (!subagentCodeRouting.isRouted(context.executionId)) {
                  sharedConfigByCall.set(context, config);
                }
                await resolveGraphSubagentsFor(
                  config,
                  context.signal,
                  subagentCodeRouting.routesChildren(context.executionId)
                    ? context.executionId
                    : undefined,
                );
                return config;
              },
            }),
          },
          metadata,
        );
      }),
    );
    return descriptors.filter(Boolean);
  };

  const resolveSubagentTrees = async (rootConfigs) => {
    expandedSubagentDescriptorState.rootAgentIds = rootConfigs
      .filter((config) => config?.id)
      .map((config) => config.id);
    await Promise.all(
      rootConfigs.map(async (config) => {
        if (!config?.id) return;
        const descriptors = await buildLazySubagentDescriptors(config);
        config.lazySubagentConfigs = descriptors.filter((child) => child.configId);
        config.subagentAgentConfigs = descriptors.filter((child) => !child.configId);
      }),
    );
  };

  const rootSubagentConfigs = [primaryConfig, ...agentConfigs.values()];
  const statefulCodeSessionsConfig =
    appConfig?.endpoints?.[EModelEndpoint.agents]?.statefulCodeSessions;
  req.codeWorkspaceInheritance = subagentsAvailableForRun
    ? await resolveSubagentCodeWorkspaceInheritance({
        selections: resolveCodeExecutionWorkspaceSelections({
          conversation: admittedConversation,
          request: runtimeRequestBody,
        }),
        roots: rootSubagentConfigs.filter((config) => config?.id),
        loadSubagent: (agentId) => resolveLazyMetadata(() => loadViewableSubagent(agentId)),
        environments: statefulCodeSessionsConfig?.environments,
        allowEnvironmentSelection: statefulCodeSessionsConfig?.allowEnvironmentSelection,
        codeExecutionAvailable: codeEnvAvailable === true && statefulSessionsAvailable === true,
      })
    : undefined;
  await resolveSubagentTrees(rootSubagentConfigs);

  const graphMemberConfigsById = new Map(
    rootSubagentConfigs.filter((config) => config?.id).map((config) => [config.id, config]),
  );
  /** A lazy call's config joins the shared graph cache only once its route commits. */
  const sharedConfigByCall = new WeakMap();
  const publishSharedConfig = (context) => {
    const config = sharedConfigByCall.get(context);
    if (config != null && !graphMemberConfigsById.has(config.id)) {
      graphMemberConfigsById.set(config.id, config);
    }
  };
  const graphMemberLoadsById = new Map();
  const initializeGraphMember = createConcurrencyLimiter(SUBAGENT_GRAPH_LOAD_CONCURRENCY);
  const loadGraphMemberOnce = async (memberId) => {
    throwIfAborted(signal);
    const cached = graphMemberConfigsById.get(memberId);
    if (cached) return cached;
    if (skippedAgentIds.has(memberId)) return null;
    assertSubagentGraphRoom(memberId);
    subagentGraphIds.add(memberId);
    const agent = await waitForAbort(db.getAgentWithVersionCount({ id: memberId }), signal);
    if (!agent || !(await hasSubagentViewAccess(agent, memberId, signal))) {
      skippedAgentIds.add(memberId);
      return null;
    }
    try {
      const config = await initializeLoadedSubagent({
        agent,
        agentId: memberId,
        configId: getLazySubagentConfigId(agent),
        context: { signal },
        lazyChildren: [],
        codeFlags: getSubagentCodeFlags(agent),
        viewAccessChecked: true,
      });
      graphMemberConfigsById.set(memberId, config);
      return config;
    } catch (error) {
      if (isFatalAgentInitializationError(error, { signal })) {
        throw error;
      }
      logger.error(`[initializeClient] Error initializing graph member ${memberId}:`, error);
      skippedAgentIds.add(memberId);
      return null;
    }
  };
  const loadGraphMember = async (memberId, graphSignal = signal) => {
    throwIfAborted(graphSignal);
    const cached = graphMemberConfigsById.get(memberId);
    if (cached) return cached;
    let pending = graphMemberLoadsById.get(memberId);
    if (!pending) {
      pending = loadGraphMemberOnce(memberId);
      graphMemberLoadsById.set(memberId, pending);
      pending.then(
        () => {
          if (graphMemberLoadsById.get(memberId) === pending) {
            graphMemberLoadsById.delete(memberId);
          }
        },
        () => {
          if (graphMemberLoadsById.get(memberId) === pending) {
            graphMemberLoadsById.delete(memberId);
          }
        },
      );
    }
    return waitForAbort(pending, graphSignal);
  };

  const loadRoutedGraphMember = createRoutedGraphMemberLoader({
    getShared: (memberId) => graphMemberConfigsById.get(memberId),
    isSkipped: (memberId) => skippedAgentIds.has(memberId),
    skip: (memberId) => skippedAgentIds.add(memberId),
    getAgent: (memberId, graphSignal) =>
      waitForAbort(db.getAgentWithVersionCount({ id: memberId }), graphSignal),
    canView: (agent, memberId, graphSignal) => hasSubagentViewAccess(agent, memberId, graphSignal),
    initialize: ({ agent, memberId, context }) =>
      initializeLoadedSubagent({
        agent,
        agentId: memberId,
        configId: getLazySubagentConfigId(agent),
        context,
        lazyChildren: [],
        codeFlags: getSubagentCodeFlags(agent),
        viewAccessChecked: true,
      }),
    isFatal: (error, graphSignal) =>
      isFatalAgentInitializationError(error, { signal: graphSignal }),
  });

  async function resolveGraphSubagentsFor(config, graphSignal = signal, routedParentRunId) {
    throwIfAborted(graphSignal);
    const definitions =
      subagentsAvailableForRun && config.subagents?.enabled === true
        ? (config.subagents.graphs ?? [])
        : [];
    const resolvedGraphs = [];
    for (const definition of definitions) {
      const memberIds = [...new Set(definition.agent_ids ?? [])];
      const unloadedMemberIds = memberIds.filter(
        (memberId) => !graphMemberConfigsById.has(memberId) && !subagentGraphIds.has(memberId),
      );
      if (subagentGraphIds.size + unloadedMemberIds.length > MAX_SUBAGENT_GRAPH_NODES) {
        const overflowIndex = MAX_SUBAGENT_GRAPH_NODES - subagentGraphIds.size;
        logger.warn('[initializeClient] Subagent graph node limit exceeded', {
          agentId: unloadedMemberIds[Math.max(overflowIndex, 0)],
          primaryAgentId: primaryConfig.id,
          loadedSubagentCount: subagentGraphIds.size,
          stagedSubagentCount: unloadedMemberIds.length,
          maxSubagentGraphNodes: MAX_SUBAGENT_GRAPH_NODES,
        });
        continue;
      }
      for (const memberId of unloadedMemberIds) {
        subagentGraphIds.add(memberId);
      }
      const memberConfigs = await Promise.all(
        memberIds.map((memberId) =>
          memberId === config.id
            ? config
            : initializeGraphMember(() =>
                routedParentRunId == null
                  ? loadGraphMember(memberId, graphSignal)
                  : loadRoutedGraphMember(memberId, routedParentRunId, graphSignal),
              ),
        ),
      );
      throwIfAborted(graphSignal);
      if (memberConfigs.some((member) => member == null)) {
        logger.warn('[initializeClient] Skipping incomplete graph subagent', {
          parentAgentId: config.id,
          graphType: definition.type,
          expectedMemberCount: memberIds.length,
          resolvedMemberCount: memberConfigs.filter(Boolean).length,
        });
        continue;
      }
      resolvedGraphs.push({ definition, memberConfigs });
    }
    config.subagentGraphConfigs = resolvedGraphs;
  }

  for (const config of rootSubagentConfigs) {
    await resolveGraphSubagentsFor(config);
  }

  /** Build detached execution only for an attributable owner/thread. New
   * tasks still require a spawnable child, while an existing registered live
   * task keeps its poll/control seam after agent configuration changes. The
   * SDK receives only this trusted host scope; models can select a child
   * `threadId`, never the owner or parent-thread namespace. */
  const hasSpawnableSubagent = rootSubagentConfigs.some(
    (config) =>
      config.subagents?.enabled === true &&
      (config.subagents.allowSelf !== false ||
        (config.subagentAgentConfigs?.length ?? 0) > 0 ||
        (config.lazySubagentConfigs?.length ?? 0) > 0 ||
        (config.subagentGraphConfigs?.length ?? 0) > 0),
  );
  const trustedSubagentTasks =
    backgroundToolsAvailable &&
    typeof req.user?.id === 'string' &&
    req.user.id !== '' &&
    typeof conversationId === 'string' &&
    conversationId !== ''
      ? buildSubagentThreadTaskConfig(
          subagentThreadTaskStore,
          {
            userId: req.user.id,
            parentConversationId: conversationId,
            ...(typeof req.user.tenantId === 'string' && req.user.tenantId !== ''
              ? { tenantId: req.user.tenantId }
              : {}),
          },
          {
            completionWakeups: completionWakeupsEnabled,
            scheduleMCPIdentity: getScheduleMCPExecution(getMCPRequestContext(req, res))?.identity,
          },
        )
      : undefined;
  let hasExistingSubagentTask = false;
  if (trustedSubagentTasks != null && !(subagentsAvailableForRun && hasSpawnableSubagent)) {
    try {
      hasExistingSubagentTask = await trustedSubagentTasks.store.hasTasks(
        trustedSubagentTasks.scopeId,
      );
    } catch (error) {
      /** Keep the poll/control tool visible when the owner directory is briefly
       * unavailable. The tool then returns an honest `unavailable` status
       * instead of making a live task look nonexistent. */
      logger.warn('[initializeClient] Failed to inspect routed subagent tasks', error);
      hasExistingSubagentTask = true;
    }
  }
  const subagentTasks =
    trustedSubagentTasks != null &&
    ((subagentsAvailableForRun && hasSpawnableSubagent) || hasExistingSubagentTask)
      ? trustedSubagentTasks
      : undefined;
  if (subagentTasks != null) {
    toolExecuteOptions.subagentTasks = subagentTasks;
  }

  primaryConfig.subagents = subagentsAvailableForRun ? primaryConfig.subagents : undefined;

  /** If the capability is off or this durable child is at the depth limit,
   *  strip `subagents` on every loaded config — not just the primary. `run.ts` calls
   *  `buildSubagentConfigs` for every agent in the array, so a handoff
   *  agent with `subagents.enabled: true` persisted on its document would
   *  otherwise still expose self-spawn at runtime. */
  if (!subagentsAvailableForRun) {
    primaryConfig.lazySubagentConfigs = undefined;
    primaryConfig.subagentGraphConfigs = undefined;
    for (const config of agentConfigs.values()) {
      config.subagents = undefined;
      config.subagentAgentConfigs = undefined;
      config.lazySubagentConfigs = undefined;
      config.subagentGraphConfigs = undefined;
    }
  }

  const agentContextAttachmentsByAgentId = buildAgentContextAttachmentsByAgentId([
    primaryConfig,
    ...agentConfigs.values(),
  ]);

  let endpointConfig = appConfig.endpoints?.[primaryConfig.endpoint];
  if (!isAgentsEndpoint(primaryConfig.endpoint) && !endpointConfig) {
    try {
      endpointConfig = getCustomEndpointConfig({
        endpoint: primaryConfig.endpoint,
        appConfig,
      });
    } catch (err) {
      logger.error(
        '[/api/server/services/Endpoints/agents/initialize.js] Error getting custom endpoint config',
        err,
      );
    }
  }

  const sender = resolveSender({
    agent: primaryConfig,
    specLabel: selectedModelSpec?.label,
    endpointOption: {
      ...endpointOption,
      model: endpointOption.model_parameters.model,
      modelDisplayLabel: endpointConfig?.modelDisplayLabel,
      modelLabel: endpointOption.model_parameters.modelLabel,
    },
  });

  /** History priming uses the user's full ACL-accessible skill set (not
   *  per-agent scoped) because prior turns may reference skills no longer
   *  in any active agent's scope; the ACL check is the security gate. Each
   *  selected Code API deployment receives its own upload, and only session
   *  partitions routed to that deployment receive those storage pointers. */
  const codeExecutionProfiles = collectCodeExecutionProfileRoutes(
    [primaryConfig, ...agentConfigs.values()],
    {
      userId: req.user.id,
      conversationId,
    },
  );
  const handlePrimeInvokedSkills = skillsCapabilityEnabled
    ? (payload, skillNames) =>
        primeInvokedSkillsForProfiles({
          req,
          payload,
          skillNames,
          signal,
          accessibleSkillIds,
          executionProfiles: codeExecutionProfiles,
          ...getSkillToolDeps(),
        })
    : undefined;

  /** Per-agent resolved endpoint token config, keyed by agent id. Built from
   *  `agentToolContexts` (the one map holding every agent, including pure
   *  subagents pruned from `agentConfigs`) so usage billed/emitted for a
   *  connected or subagent on a different custom endpoint is priced with THAT
   *  agent's configured rates instead of the primary's. Every known agent is
   *  recorded — even with an `undefined` config — so the resolver can tell a
   *  known non-custom agent (built-in pricing) from an untagged/unknown one
   *  (primary fallback).
   *  @type {Map<string, import('@librechat/api').EndpointTokenConfig | undefined>} */
  for (const [agentId, ctx] of agentToolContexts) {
    endpointTokenConfigByAgentId.set(agentId, ctx?.endpointTokenConfig);
  }
  /** Price emitted usage per producing agent too, so the streamed/persisted
   *  `metadata.usage.cost` matches the per-agent balance transaction. */
  usageCost.resolveEndpointTokenConfig = (usage) =>
    resolveAgentTokenConfig({
      agentId: usage?.agentId,
      byAgentId: endpointTokenConfigByAgentId,
      fallback: usageCost.endpointTokenConfig,
    });

  const eventTaskId = req._agentEventTaskId;
  const eventChildActivity =
    req._agentEventBindingParentConversationId != null &&
    typeof conversationId === 'string' &&
    conversationId !== '' &&
    typeof eventTaskId === 'string' &&
    eventTaskId !== ''
      ? {
          runId: streamId ?? eventTaskId,
          parentRunId: req._agentEventBindingParentConversationId,
          subagentRunId: eventTaskId,
          subagentType: primaryConfig.id,
          subagentAgentId: primaryConfig.id,
          parentAgentId: req._agentEventBindingParentAgentId,
          publish: (event) =>
            subagentThreadTaskStore.publishTaskActivity(conversationId, eventTaskId, event),
        }
      : null;

  runFileBindings = createChatRunFileBindings({
    req,
    contexts: agentToolContexts,
    createdAt: jobCreatedAt,
    requestFiles,
    audit: (event) => logger.info('[agents:run-files]', event),
    getInputs: () => primaryConfig.currentRequestAttachments,
    loadFiles: (fileIds) => db.getRunFileCandidates(fileIds, req.user.tenantId),
    filterFiles: filterFilesByAgentAccess,
    listPublications: db.listRunArtifacts,
    provisioning: {
      provisionToCodeEnv,
      provisionToVectorDB,
      updateFile: db.updateFile,
      updateCodeEnvRef: db.updateFileCodeEnvRef,
      addEmbeddedEntity: db.addFileEmbeddedEntity,
    },
    fileMethods: {
      claimRunArtifactFile: db.claimRunArtifactFile,
      publishRunArtifactFile: db.publishRunArtifactFile,
      findRunArtifactFile: db.findRunArtifactFile,
    },
    processCodeOutput,
    snapshotAdapter: {
      request: createAxiosInstance(),
      getAuthHeaders: getCodeApiAuthHeaders,
      getBaseURL: getCodeExecutionBaseUrl,
      determineFileType,
    },
    finalize: runPreviewFinalize,
    getStrategyFunctions,
    artifactPromises,
    emitAttachment: createAttachmentEmitter({ res, streamId, jobCreatedAt }),
    encoder: {
      getAgent: (agentId) => agentToolContexts.get(agentId)?.fileEncodingAgent,
      encodeImages: (request, files, params) =>
        encodeAndFormat(request, files, params, VisionModes.agents),
      encodeDocuments: encodeAndFormatDocuments,
      encodeAudios: encodeAndFormatAudios,
      encodeVideos: encodeAndFormatVideos,
      extractText: extractFileContext,
    },
  });
  toolExecuteOptions.runFiles = runFileBindings.session;
  toolExecuteOptions.provisionFiles = runFileBindings.wrapProvision(
    toolExecuteOptions.provisionFiles,
  );

  const eventHandlers = getDefaultHandlers({
    res,
    contentParts,
    stepMap,
    toolInputValidationErrors,
    toolExecuteOptions,
    summarizationOptions,
    aggregateContent,
    toolEndCallback,
    collectedUsage,
    collectedThoughtSignatures,
    streamId,
    jobCreatedAt,
    subagentAggregatorsByToolCallId,
    usageCost,
    contextUsageSink,
    usageEmitSink,
    eventChildActivity,
    resolveMcpServerName,
    toolTimingReplayEvents,
  });

  const client = new AgentClient({
    req,
    res,
    sender,
    contentParts,
    stepMap,
    agentConfigs,
    eventHandlers,
    collectedUsage,
    collectedThoughtSignatures,
    aggregateContent,
    artifactPromises,
    primeInvokedSkills: handlePrimeInvokedSkills,
    invokedSkillIdentities,
    agent: primaryConfig,
    spec: endpointOption.spec,
    traceContext: { modelLabel: endpointOption.model_parameters?.modelLabel },
    iconURL: endpointOption.iconURL,
    chatProjectId: endpointOption.chatProjectId,
    attachments: primaryConfig.requestAttachments ?? primaryConfig.attachments,
    agentContextAttachmentsByAgentId,
    endpointType: endpointOption.endpointType,
    resendFiles: primaryConfig.resendFiles ?? true,
    imageDetail: primaryConfig.imageDetail,
    maxContextTokens: primaryConfig.maxContextTokens,
    endpoint: isEphemeralAgentId(primaryConfig.id) ? primaryConfig.endpoint : EModelEndpoint.agents,
    subagentAggregatorsByToolCallId,
    subagentTasks,
    runFiles: runFileBindings.session,
    /** Resolved endpoint token/pricing config so spending and cost reflect
     *  configured rates for custom-endpoint agents instead of defaults. */
    endpointTokenConfig: primaryConfig.endpointTokenConfig,
    /** Per-agent override of the above for multi-endpoint graphs (connected
     *  agents + subagents); falls back to the primary config when an agent
     *  isn't present or has no configured rates. */
    endpointTokenConfigByAgentId,
    /** Capture sinks the handlers fill during the run; `sendCompletion` reads
     *  them to persist the breakdown + usage rollup on the response message. */
    contextUsageSink,
    usageEmitSink,
    startupTelemetry,
    toolInputValidationErrors,
    jobCreatedAt,
    checkpointNamespace,
    mcpRequestBody: runtimeRequestBody,
  });

  if (streamId) {
    GenerationJobManager.setCollectedUsage(streamId, collectedUsage, jobCreatedAt);
  }

  return { client, userMCPAuthMap };
};

/**
 * Creates an agent initializer whose host may resolve renewable credentials at
 * the execution boundary. The resolver returns a provider closure rather than
 * token material so refresh remains owned by the host integration.
 *
 * @param {object} [dependencies]
 * @param {import('@librechat/api').HostUpstreamTokenProviderResolver} [dependencies.resolveUpstreamTokenProvider]
 * @param {import('@librechat/api').ScheduledMCPBearerHost} [dependencies.scheduledBearerHost]
 */
function createInitializeClient(dependencies = {}) {
  return async (params) => {
    const upstreamTokenProviderResolver = createScheduleUpstreamTokenProviderResolver(
      params.req,
      dependencies.resolveUpstreamTokenProvider,
      params.signal,
      params.scheduledTokenContext,
    );
    return initializeWithScheduleMCPExecution(
      {
        req: params.req,
        signal: params.signal,
        context: require('~/server/services/MCPRequestContext').getMCPRequestContext(
          params.req,
          params.res,
        ),
        restoredContext: params.scheduledTokenContext,
        restoredJob: params.scheduleJobIdentity,
      },
      () => require('~/server/services/Schedules/consent'),
      () =>
        initializeWithScheduledMCPBearer(
          {
            req: params.req,
            context: getMCPRequestContext(params.req),
            restoredContext: params.scheduledTokenContext,
            host: dependencies.scheduledBearerHost,
            signal: params.signal,
            streamId: params.req._resumableStreamId,
            jobCreatedAt: params.jobCreatedAt,
            recordFailure: (input) =>
              require('~/server/services/Schedules').recordMCPToolAuthFailure(input),
            registerSettlement: (input) =>
              require('~/server/services/Schedules').registerMCPSettlement(input),
          },
          () => initializeClientWithProvider({ ...params, upstreamTokenProviderResolver }),
        ),
      (identity) =>
        retainScheduleMCPCompletion(
          identity,
          {
            streamId: params.req._resumableStreamId,
            createdAt: params.jobCreatedAt,
          },
          GenerationJobManager.getJobStore(),
        ),
    );
  };
}

const initializeClient = createInitializeClient();

module.exports = { createInitializeClient, initializeClient };
