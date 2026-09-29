require('events').EventEmitter.defaultMaxListeners = 100;
const { logger, MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH } = require('@librechat/data-schemas');
const { getBufferString, HumanMessage } = require('@librechat/agents/langchain/messages');
const {
  createRun,
  isEnabled,
  checkAccess,
  buildRunToolSet,
  logToolError,
  sanitizeTitle,
  payloadParser,
  createSafeUser,
  initializeAgent,
  resolveConfigHeaders,
  resolveRequestTenantId,
  countTokens,
  getBalanceConfig,
  omitTitleOptions,
  getProviderConfig,
  formatMemoryContext,
  createCachedTokenCounter,
  applyContextToAgent,
  isMemoryAgentEnabled,
  recordCollectedUsage,
  resolveRunUsageContext,
  recordFallbackTokenUsage,
  createDetachedSubagentUsageRecorder,
  sendEvent,
  computeUsageCostUSD,
  aggregateEmittedUsage,
  resolveAgentTokenConfig,
  buildPersistedContextUsage,
  resolveRetainedToolTokens,
  computeSummaryUsedTokens,
  priorRunOutputTokens,
  createSubagentUsageSink,
  anyAgentReplaysReasoningContent,
  GenerationJobManager,
  PENDING_ACTION_EXPIRED_CODE,
  getTransactionsConfig,
  resolveRecursionLimit,
  buildPendingAction,
  toClientPendingAction,
  captureCodeExecutionApprovalBinding,
  computeAgentRequestFingerprint,
  computeLegacyAgentRequestFingerprint,
  getRunDiscoveredTools,
  captureResumeModelParameters,
  pickResumeContext,
  getApprovalTtlMs,
  getAgentCheckpointer,
  hasDurableAgentInterruptCheckpoint,
  isHITLEnabled,
  resolveToolApprovalPolicy,
  buildToolApprovalHooks,
  buildToolApprovalExecutionConfig,
  collectAttachedCodeEnvironmentAgentIds,
  collectAttachedCodeEnvironmentPolicySettings,
  buildAttachedCodeEnvironmentAdmissionHooks,
  resolveAttachedCodeApprovalMode,
  markNativeCodeToolApprovalRequests,
  agentRunUsesCheckpointer,
  canAgentGraphPause,
  getPluginHookSource,
  captureAgentCheckpointGeneration,
  isContentFilterError,
  isStepLimitError,
  deleteAgentCheckpoint,
  LIBRECHAT_CHECKPOINT_NAMESPACE_KEY,
  LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
  checkpointOwnerNamespacePrefix,
  isAskUserQuestionAdminDisabled,
  attachAskUserQuestionArgs,
  prepareRetainedAnswers,
  withRetainedAnswerTokenCounter,
  applyRetainedAnswers,
  prepareRetainedAnswerInvocationMessages,
  resolveRetainedAnswersConfig,
  hydrateResumeRunSteps,
  createContentIndexOffsetHandlers,
  createSteerIndexOffsetHandlers,
  createSteerDrainHook,
  createSteerPreemptBoundaryHook,
  createSteerTerminalContinuationHook,
  createSteerPreemptPoll,
  isSteeringSupported,
  isSteerPreemptSupported,
  isSteerTerminalContinuationSupported,
  buildSteerMedia,
  collectSteerStampTargets,
  stampSteerPartMedia,
  createActivityLabelWiring,
  createActivityPhaseWiring,
  createReasoningLabelHostWiring,
  createMCPRuntimeRequestBody,
  generateReasoningLabelRevision,
  getLabelUsageSequenceSeed,
  createAssistantPhaseStampingHandlers,
  resolveActivityConfig,
  resolveActivityPhaseConfig,
  resolveReasoningLabelConfig,
  getCustomEndpointConfig,
  mapCollectedMetadataToUsage,
  resolveActivityLabelModel,
  resolveActivityPhaseLabelModel,
  resolveReasoningLabelModel,
  traceIdForMessage,
  settlePendingLabelFills,
  stripActivityLabelParts,
  stripUnusableSummaryParts,
  dropUnusableSummaryParts,
  getLatestEventActorSummary,
  createAgentEventActorSummary,
  normalizeAgentEventActorSummary,
  getRequestMemories,
  getMemoryAgentId,
  createMemoryProcessor,
  agentHasInlineMemoryTools,
  loadAgent: loadAgentFn,
  createMultiAgentMapper,
  filterMalformedContentParts,
  countFormattedMessageTokens,
  prependFileContext,
  prependQuotes,
  applyAttachmentOnlyText,
  hydrateMissingIndexTokenCounts,
  injectSkillPrimes,
  buildAgentEventActorSkillMessages,
  collectFreshSkillPrimeNames,
  isSkillPrimeMessage,
  collectFileIds,
  processTextWithTokenLimit,
  logAgentMemorySnapshot,
  createAgentMemoryCallback,
  assertAgentAttachmentLimits,
  assertAgentAttachmentTopology,
  isModelBoundAttachmentFile,
  isAgentAttachmentLimitError,
  isAttachmentObjectNotFoundError,
  buildAgentScopedContext,
  buildAgentScopedAttachmentMap,
  resolveScopedTurnAttachments,
  buildAgentContextAttachmentsByAgentId,
  buildSkillPrimeContentParts,
  buildInitialToolSessions,
  hasUrlContextTool,
  hasYouTubeVideoParts,
  appendYouTubeVideoParts,
  resolveGoogleVideoError,
  resolveLangChainError,
  resolveYouTubeInjectionConfig,
  decrementPendingRequest,
  maybePrewarmCodeSandbox,
  assertModelBoundContent,
  reportLocatorTraversalFailure,
  filterFilesByEndpointRuntimeConfig,
  createModelBoundChatModelCallback: createModelBoundContentCallback,
  createInitialModelBoundAdmissionCallback,
  hasModelBoundContentProtection,
  assertResumeRuntimeContentAllowed,
  collectReachableAgents,
  isStatefulCodeEnvironmentToolName,
  stampMcpServerIdentities,
  getDynamicToolContexts,
  getSafeErrorMetadata,
  createInitializedAgentContextFingerprint,
  createSkillContentDigest,
  normalizeAgentEventActorDiscoveredTools,
  createCompactionSemanticIndexProjection,
  restoreCompactionSemanticIndexSnapshot,
  MAX_AGENT_CONTEXT_SKILLS,
  isAgentFadingTier,
  isCurrentAgentFadingTier,
  isAgentFadingTierEntries,
  resolveRunContextMeta,
  resolveRunFadingTiers,
  createContextMetaPublisher,
  selectRunContextMetaToPublish,
  resolveToolRoleGrants,
  createTerminalRunErrorObserver,
  isAgentRunCancellation,
  markCompactionOutcome,
  resolvePersistableCodeEnvironmentDecision,
} = require('@librechat/api');
const {
  Run,
  Callback,
  Providers,
  TitleMethod,
  formatMessage,
  formatAgentMessages,
  createMetadataAggregator,
} = require('@librechat/agents');
const {
  Constants,
  SteerEvents,
  ActivityLabelEvents,
  UsageEvents,
  Permissions,
  VisionModes,
  ErrorTypes,
  ContentTypes,
  FileSources,
  ApprovalEvents,
  EModelEndpoint,
  PermissionTypes,
  AgentCapabilities,
  hasActivePiiPatterns,
  isAgentsEndpoint,
  isEphemeralAgentId,
  removeNullishValues,
  stripLangChainTroubleshootingUrl,
  DEFAULT_MEMORY_MAX_INPUT_TOKENS,
} = require('librechat-data-provider');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { encodeAndFormat } = require('~/server/services/Files/images/encode');
const { createContextHandlers } = require('~/app/clients/prompts');
const { resolveConfigServers, getAccessibleMcpServerNames } = require('~/server/services/MCP');
const { getMCPServerTools } = require('~/server/services/Config');
const { getAccessibleMCPServers } = require('~/server/services/MCP');
const BaseClient = require('~/app/clients/BaseClient');
const { getMCPManager } = require('~/config');
const db = require('~/models');

const loadAgent = (params) =>
  loadAgentFn(params, {
    getAgent: db.getAgentWithVersionCount,
    getMCPServerTools,
    getAccessibleMCPServers,
  });

const MEMORY_INPUT_CHARS_PER_TOKEN = 8;

function normalizeEventActorContextMeta(contextMeta) {
  if (contextMeta == null) {
    return undefined;
  }
  const { calibrationRatio, encoding, fading, fadingTiers } = contextMeta;
  if (
    !Number.isFinite(calibrationRatio) ||
    calibrationRatio < 0.5 ||
    calibrationRatio > 5 ||
    (encoding != null &&
      (typeof encoding !== 'string' ||
        encoding.length === 0 ||
        encoding.length > MAX_AGENT_EVENT_ACTOR_ENCODING_LENGTH))
  ) {
    throw new RangeError('Event actor context calibration is invalid');
  }
  if (fading != null && !isAgentFadingTier(fading)) {
    throw new RangeError('Event actor context fading tier is invalid');
  }
  if (fadingTiers != null && !isAgentFadingTierEntries(fadingTiers)) {
    throw new RangeError('Event actor context fading tiers are invalid');
  }
  return {
    calibrationRatio,
    ...(encoding == null ? {} : { encoding }),
    ...(fading == null ? {} : { fading }),
    ...(fadingTiers == null ? {} : { fadingTiers }),
  };
}

/**
 * Seeds for a new run from the previous run's contextMeta: the calibration
 * ratio when the tokenizer encoding still matches, and the fading tiers, which
 * are character-based and so seed regardless of encoding. The default agent's
 * tier and the per-agent map are both passed; the SDK restores each agent from
 * its own entry and falls back to the default tier for the first agent.
 */
/**
 * Request values `langfuse.trace.conversationMetadataFields` may export.
 * The model label rides the trace-only `options.traceContext`: the
 * initialized agent's `model_parameters` drop it (`extractLibreChatParams`),
 * and a top-level `modelLabel` option would also rename the assistant in
 * formatted messages. A module function rather than a method so partial
 * client contexts (tests, resume) need no prototype.
 * @param {AgentClient['options'] | undefined} options
 */
function buildTraceContext(options) {
  return {
    endpoint: options?.endpoint,
    endpointType: options?.endpointType,
    modelLabel: options?.traceContext?.modelLabel ?? options?.modelLabel,
    spec: options?.spec,
  };
}

function resolveRunSeeds(client) {
  const prevMeta = client.contextMeta;
  if (prevMeta == null) {
    return {};
  }
  const currentEncoding = client.getEncoding();
  const encodingMatch = prevMeta.encoding === currentEncoding;
  const calibrationRatio =
    encodingMatch && prevMeta.calibrationRatio > 0 ? prevMeta.calibrationRatio : undefined;
  const fadingTier = isCurrentAgentFadingTier(prevMeta.fading) ? prevMeta.fading : undefined;
  const fadingTiers = resolveRunFadingTiers(prevMeta.fadingTiers);
  logger.debug(
    `[AgentClient] contextMeta from parent: ratio=${prevMeta.calibrationRatio}, encoding=${prevMeta.encoding}, current=${currentEncoding}, seeded=${calibrationRatio ?? 'none'}, fading=${fadingTier ? `${fadingTier.budgetTokens}/${fadingTier.masked}` : 'none'}, agents=${fadingTiers ? Object.keys(fadingTiers).length : 0}`,
  );
  return { calibrationRatio, fadingTier, fadingTiers };
}

/**
 * Captures the compact context state of a run for persistence on the response
 * message: calibration plus the latched fading tiers, never message content.
 * Called from `finally`, so values survive an abort. The tier getters are
 * optional so SDK versions without them persist calibration alone, and they
 * already return only tiers that carry information; the encoding is only
 * resolved when there is something to persist.
 */
function captureRunContextMeta(client) {
  const run = client.run;
  /** `Run` refreshes its own getters only after `processStream` settles, so a
   * capture taken mid-run (a HITL pause, a Stop) reads the live graph state. */
  const graph = run?.Graph;
  const source = graph ?? run;
  return resolveRunContextMeta({
    calibrationRatio: source?.getCalibrationRatio?.() ?? 0,
    fadingTier: source?.getFadingTier?.(),
    fadingTiers: source?.getFadingTiers?.(),
    getEncoding: () => client.getEncoding(),
  });
}

/**
 * User-visible text for a failed run. LangChain classifies provider errors by mutating
 * `error.message` with a docs URL, so a classified failure becomes typed copy the client localizes
 * and everything else keeps the provider's own wording with that URL removed. The untouched error
 * still reaches the logs through `getSafeErrorMetadata`.
 */
function getUserFacingRequestError(baseMessage, error, appConfig) {
  /** Carries no model or user content, so it is safe under every filter. */
  if (error?.name === 'ManualSummarizationSkippedError') {
    return JSON.stringify({ type: ErrorTypes.COMPACTION_SKIPPED, reason: error.reason });
  }
  const protectionEnabled = hasModelBoundContentProtection(
    appConfig?.filters,
    appConfig?.messageFilter?.pii,
  );
  if (protectionEnabled || !error?.message) {
    return baseMessage;
  }
  const typedError = resolveLangChainError(error);
  if (typedError != null) {
    return typedError;
  }
  const message = stripLangChainTroubleshootingUrl(error.message);
  if (!message) {
    return baseMessage;
  }
  return `${baseMessage}: ${message}`;
}

class AgentClient extends BaseClient {
  getModelBoundAttachmentsForEndpoint(attachments) {
    return filterFilesByEndpointRuntimeConfig(this.options.req.config, {
      files: (attachments ?? []).filter(isModelBoundAttachmentFile),
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
      endpointType: this.options.endpointType,
      skipTotalSizeLimit: true,
      preserveTextSources: true,
    });
  }

  getProcessableAttachmentsForEndpoint(attachments, modelBoundAttachments) {
    const admittedModelAttachments =
      modelBoundAttachments ?? this.getModelBoundAttachmentsForEndpoint(attachments);
    const admittedObjects = new Set(admittedModelAttachments);
    const admittedFileIds = collectFileIds(admittedModelAttachments);
    return (attachments ?? []).filter(
      (file) =>
        !isModelBoundAttachmentFile(file) ||
        admittedObjects.has(file) ||
        (file?.file_id && admittedFileIds.has(file.file_id)),
    );
  }

  async addDocuments(message, attachments) {
    const memoryContext = {
      req: this.options.req,
      conversationId: this.conversationId,
      messageId: message.messageId,
      attachments,
    };
    logAgentMemorySnapshot('before_encode_documents', memoryContext);
    try {
      return await super.addDocuments(message, attachments);
    } finally {
      logAgentMemorySnapshot('after_encode_documents', memoryContext);
    }
  }

  async processAttachments(message, attachments, fileConsumers) {
    const modelBoundAttachments = this.getModelBoundAttachmentsForEndpoint(attachments);
    const processableAttachments = this.getProcessableAttachmentsForEndpoint(
      attachments,
      modelBoundAttachments,
    );
    assertAgentAttachmentLimits({
      attachments: modelBoundAttachments,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      endpointType: this.options.endpointType,
    });
    const memoryContext = {
      req: this.options.req,
      conversationId: this.conversationId,
      messageId: message.messageId,
      attachments: modelBoundAttachments,
    };
    logAgentMemorySnapshot('before_process_attachments', memoryContext);
    try {
      return await super.processAttachments(message, processableAttachments, fileConsumers);
    } finally {
      logAgentMemorySnapshot('after_process_attachments', memoryContext);
    }
  }

  getFilteredScopedAttachmentMap(
    sharedAttachmentIds,
    attachmentsByAgentId = this.options.agentContextAttachmentsByAgentId,
    agents = collectReachableAgents([this.options.agent, ...(this.agentConfigs?.values() ?? [])]),
  ) {
    const identifiedAgents = agents.filter((agent) => agent?.id);
    const endpointsByAgentId = new Map(
      identifiedAgents.map((agent) => [
        agent.id,
        {
          endpoint: agent.endpoint,
          endpointType: agent === this.options.agent ? this.options.endpointType : undefined,
        },
      ]),
    );
    return buildAgentScopedAttachmentMap({
      agentIds: identifiedAgents.map((agent) => agent.id),
      attachmentsByAgentId,
      sharedRunAttachmentIds: sharedAttachmentIds,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
      endpointType: this.options.endpointType,
      endpointsByAgentId,
    });
  }

  assertTurnAttachmentLimits(sharedAttachments, scopedAttachmentInjections) {
    assertAgentAttachmentLimits({
      attachments: [...sharedAttachments, ...scopedAttachmentInjections],
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      endpointType: this.options.endpointType,
      countRepeatedExtractedText: true,
      enforceAttachmentCount: false,
      useGlobalContextSizeLimit: true,
    });
  }

  admitSteerAttachments(files, steerId) {
    const modelBoundFiles = files.filter(isModelBoundAttachmentFile);
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters: this.options.req?.config?.filters,
      files: modelBoundFiles,
    });
    const sharedAttachments = [...(this.turnSharedAttachmentFiles ?? []), ...modelBoundFiles];
    const scopedAttachmentsByAgentId = this.turnScopedAttachmentsByAgentId ?? new Map();
    assertAgentAttachmentTopology({
      sharedAttachments,
      scopedAttachmentsByAgentId,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      endpointType: this.options.endpointType,
      endpointsByAgentId: this.turnAttachmentEndpointsByAgentId,
    });
    this.assertTurnAttachmentLimits(
      [...sharedAttachments, ...(this.turnAggregateOnlyAttachmentFiles ?? [])],
      [...scopedAttachmentsByAgentId.values()].flat(),
    );
    this.turnSharedAttachmentFiles = sharedAttachments;
    this.attachmentMemoryContext?.attachments?.push(...modelBoundFiles);
    if (steerId && modelBoundFiles.length > 0) {
      this.admittedSteerAttachments.set(steerId, modelBoundFiles);
    }
  }

  async assertHistoricalAttachmentLimits(historicalAttachments) {
    const currentAttachments = this.options.attachments ? await this.options.attachments : [];
    const compatibleHistoricalAttachments =
      this.getModelBoundAttachmentsForEndpoint(historicalAttachments);
    const compatibleCurrentAttachments =
      this.getModelBoundAttachmentsForEndpoint(currentAttachments);
    const sharedAttachments = [...compatibleHistoricalAttachments, ...compatibleCurrentAttachments];
    const sharedAttachmentIds = collectFileIds(sharedAttachments);
    const agents = collectReachableAgents([
      this.options.agent,
      ...(this.agentConfigs?.values() ?? []),
    ]);
    const scopedAttachmentMap = this.getFilteredScopedAttachmentMap(
      sharedAttachmentIds,
      this.options.agentContextAttachmentsByAgentId,
      agents,
    );
    const endpointsByAgentId = new Map(
      agents
        .filter((agent) => agent?.id)
        .map((agent) => [
          agent.id,
          {
            endpoint: agent.endpoint,
            endpointType: agent === this.options.agent ? this.options.endpointType : undefined,
          },
        ]),
    );
    assertAgentAttachmentTopology({
      sharedAttachments,
      scopedAttachmentsByAgentId: scopedAttachmentMap,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      endpointType: this.options.endpointType,
      endpointsByAgentId,
    });
    this.assertTurnAttachmentLimits(sharedAttachments, [...scopedAttachmentMap.values()].flat());
    return compatibleHistoricalAttachments;
  }

  /** Mirrors the SDK's `MultiAgentGraph.analyzeGraph`: every loaded agent
   * without an incoming edge starts in the first graph wave, falling back to
   * the first agent for a cycle. */
  static getStartingAgentIds(agents) {
    const agentIds = [
      ...new Set(
        (agents ?? [])
          .map((agent) => agent?.id)
          .filter((agentId) => typeof agentId === 'string' && agentId.length > 0),
      ),
    ];
    const incomingAgentIds = new Set();
    for (const edge of agents?.[0]?.edges ?? []) {
      const destinations = Array.isArray(edge?.to) ? edge.to : [edge?.to];
      for (const destination of destinations) {
        if (typeof destination === 'string' && destination.length > 0) {
          incomingAgentIds.add(destination);
        }
      }
    }
    const startingAgentIds = agentIds.filter((agentId) => !incomingAgentIds.has(agentId));
    return startingAgentIds.length > 0 ? startingAgentIds : agentIds.slice(0, 1);
  }

  constructor(options = {}) {
    super(null, options);
    /** The current client class
     * @type {string} */
    this.clientName = EModelEndpoint.agents;

    /** @deprecated @type {true} - Is a Chat Completion Request */
    this.isChatCompletion = true;
    /** @type {number | undefined} */
    this.jobCreatedAt = options.jobCreatedAt;
    /** Generation-scoped LangGraph checkpoint namespace. Legacy paused jobs
     * intentionally use the historical empty namespace. @type {string} */
    this.checkpointNamespace = options.checkpointNamespace ?? '';
    /** Bound-event invocation state is assigned immediately before sendMessage,
     * after the SDK has prepared its isolated fork. */
    this.eventActorCheckpointId = undefined;
    this.eventActorInvocationId = undefined;
    this.eventActorContinuation = undefined;
    this.eventActorSkillPrimeResult = undefined;
    this.eventActorDiscoveredToolNames = undefined;
    this.eventActorSummary = undefined;
    /** Advisory compaction guidance retained and evolved across graph reconstruction.
     * @type {import('@librechat/agents').CompactionSemanticIndexSnapshot | undefined} */
    this.compactionSemanticIndexSnapshot = undefined;

    /** @type {AgentRun} */
    this.run;

    /** Resolves with the agent run once `chatCompletion` initializes it (or
     *  `null` if initialization fails), letting immediate-mode title generation
     *  await the run instead of throwing when fired before the run exists.
     *  @type {Promise<AgentRun | null> | null} */
    this._runReady = null;
    /** @type {((run: AgentRun | null) => void) | null} */
    this._resolveRun = null;

    const {
      agentConfigs,
      contentParts,
      stepMap,
      collectedUsage,
      collectedThoughtSignatures,
      artifactPromises,
      maxContextTokens,
      subagentAggregatorsByToolCallId,
      contextUsageSink,
      usageEmitSink,
      toolInputValidationErrors,
      ...clientOptions
    } = options;

    this.agentConfigs = agentConfigs;
    this.maxContextTokens = maxContextTokens;
    /** Latest visible context snapshot for this response, captured live by the
     *  ON_CONTEXT_USAGE handler; persisted on `metadata.contextUsage`.
     *  @type {{ latest: import('librechat-data-provider').TContextUsageEvent | null } | undefined} */
    this.contextUsageSink = contextUsageSink;
    if (this.contextUsageSink != null) {
      this.contextUsageSink.onSnapshot = () => this.publishRunContextMeta({ live: true });
    }
    /** Every emitted `on_token_usage` payload for this response (primary,
     *  summarization, sequential, and subagent); aggregated into the rollup
     *  persisted on `metadata.usage`.
     *  @type {Array<import('librechat-data-provider').TTokenUsageEvent> | undefined} */
    this.usageEmitSink = usageEmitSink;
    /** Schema-validation exceptions keyed by tool-call ID. The completion
     *  handler consumes these to distinguish execution failures from tool
     *  output that merely contains similar text.
     *  @type {Map<string, import('@librechat/api').ToolInputValidationError> | undefined} */
    this.toolInputValidationErrors = toolInputValidationErrors;
    /** @type {MessageContentComplex[]} */
    this.contentParts = contentParts;
    /** Original run-step identity used by the content aggregator to attach
     *  completion events to their rendered content indices.
     *  @type {Map<string, import('@librechat/agents').RunStep | undefined> | undefined} */
    this.stepMap = stepMap;
    /** @type {Array<UsageMetadata>} */
    this.collectedUsage = collectedUsage;
    /** Vertex Gemini 3 thought signatures captured during the run, keyed by
     *  `tool_call_id`. Persisted on `responseMessage.metadata.thoughtSignatures`
     *  and restored as `additional_kwargs.signatures` on subsequent turns to
     *  keep tool round-trips valid across DB reconstruction.
     *  @type {Record<string, string> | undefined} */
    this.collectedThoughtSignatures = collectedThoughtSignatures;
    /** @type {ArtifactPromises} */
    this.artifactPromises = artifactPromises;
    /** Per-request map of `createContentAggregator` instances keyed by
     *  the parent's `tool_call_id`. `ON_SUBAGENT_UPDATE` events stream
     *  into each aggregator as they arrive; `finalizeSubagentContent`
     *  harvests `contentParts` onto the matching `subagent` tool_call
     *  so the child's full activity survives a page refresh. */
    this.subagentAggregatorsByToolCallId = subagentAggregatorsByToolCallId ?? new Map();
    /** In-flight `on_token_usage` emits from subagent child runs. The sink
     *  fires the emitter without awaiting, so chatCompletion's finally flushes
     *  these before returning — otherwise job cleanup can race the persist.
     *  @type {Promise<void>[]} */
    this.pendingSubagentEmits = [];
    /** Set when the graph exhausted its per-turn step budget (`recursionLimit`).
     *  Read by `request.js`/`resume.js` to persist the row as `unfinished` with
     *  `Constants.TOOL_CALL_LIMIT_FINISH_REASON` instead of publishing an error.
     *  @type {boolean} */
    this.stepLimitReached = false;
    /** Stable per-generation sequence for subagent usage events. Detached
     * usage is billed outside `collectedUsage`, so array length is no longer
     * a valid sequence source. @type {number} */
    this.subagentUsageSeq =
      usageEmitSink?.filter((event) => event?.usage_type === 'subagent').length ?? 0;
    /** @type {AgentClientOptions} */
    this.options = Object.assign({ endpoint: options.endpoint }, clientOptions);
    if (
      this.options.req?._isAgentTrigger === true &&
      this.options.req?._agentEventBindingParentConversationId != null
    ) {
      /** Preserve initialization-time semantic inputs before buildMessages
       * decorates live agent instructions with request memory/MCP context. */
      this.eventActorAgentContextSources = this.getEventActorAgents().map((agent) => ({
        id: agent.id,
        version: agent.version,
        provider: agent.provider,
        model: agent.model ?? agent.model_parameters?.model,
        instructions: agent.instructions,
        additional_instructions: agent.additional_instructions,
        model_parameters: JSON.parse(JSON.stringify(agent.model_parameters ?? {})),
        toolDefinitions: JSON.parse(JSON.stringify(agent.toolDefinitions ?? [])),
        toolRegistryDefinitions: JSON.parse(
          JSON.stringify(
            [...(agent.toolRegistry?.values() ?? [])].sort((left, right) =>
              left.name.localeCompare(right.name),
            ),
          ),
        ),
        tool_options: JSON.parse(JSON.stringify(agent.tool_options ?? {})),
        execution: JSON.parse(
          JSON.stringify({
            endpoint: agent.endpoint,
            configId: agent.configId,
            tool_kwargs: agent.tool_kwargs,
            edges: agent.edges,
            end_after_tools: agent.end_after_tools,
            hide_sequential_outputs: agent.hide_sequential_outputs,
            stateful_code_sessions: agent.stateful_code_sessions,
            stateful_code_environment: agent.stateful_code_environment,
            execution_route_key:
              agent.codeExecutionContext?.executionRouteKey ??
              agent.codeExecutionContext?.executionProfile,
            artifacts: agent.artifacts,
            recursion_limit: agent.recursion_limit,
            subagents: agent.subagents,
            memory_scope: agent.memory_scope,
            skills_enabled: agent.skills_enabled,
            skill_authoring_enabled: agent.skill_authoring_enabled,
            skills_scope: agent.skills_scope,
            skills: agent.skills,
            backgroundToolNames: agent.backgroundToolNames,
            intentToolNames: agent.intentToolNames,
          }),
        ),
        manualSkillPrimes: agent.manualSkillPrimes,
        alwaysApplySkillPrimes: agent.alwaysApplySkillPrimes,
      }));
    }
    /** @type {string} */
    this.model = this.options.agent.model_parameters.model;
    /** The key for the usage object's input tokens
     * @type {string} */
    this.inputTokensKey = 'input_tokens';
    /** The key for the usage object's output tokens
     * @type {string} */
    this.outputTokensKey = 'output_tokens';
    /** @type {UsageMetadata} */
    this.usage;
    /** @type {Record<string, number>} */
    this.indexTokenCountMap = {};
    /** @type {Array<Record<string, unknown>> | null} */
    this.memoryPayload = null;
    /** Mutable content-index shift shared with the steer offset handlers.
     *  Incremented each time a steer part is spliced into `contentParts`, so
     *  SDK-emitted indices that arrive after an injection land past it.
     *  @type {import('@librechat/api').SteerOffsetState} */
    this.steerOffsetState = { offset: 0 };
    this.appliedSteerParts = new Map();
    this.admittedSteerAttachments = new Map();
    /** @type {(messages: BaseMessage[], inspectionMessages?: BaseMessage[]) => Promise<void>} */
    this.processMemory;
  }

  /**
   * Returns the aggregated content parts for the current run.
   * @returns {MessageContentComplex[]} */
  getContentParts() {
    return this.contentParts;
  }

  /**
   * Harvest the `contentParts` from each per-subagent `createContentAggregator`
   * instance and attach them onto the matching parent `subagent` tool_call
   * as `subagent_content`. Runs once per message save (from
   * `sendCompletion`'s `finally`) so the child's full reasoning / tool
   * calls / final text survive a page refresh — the client-side Recoil
   * atom is session-only. Aggregators keyed by a tool_call_id that never
   * appeared in `contentParts` are discarded (no home to attach to).
   */
  finalizeSubagentContent() {
    const buffer = this.subagentAggregatorsByToolCallId;
    if (!buffer || buffer.size === 0 || !Array.isArray(this.contentParts)) {
      return;
    }
    for (const part of this.contentParts) {
      if (part?.type !== ContentTypes.TOOL_CALL) continue;
      const toolCall = part[ContentTypes.TOOL_CALL];
      if (!toolCall || toolCall.name !== Constants.SUBAGENT || !toolCall.id) continue;
      const aggregator = buffer.get(toolCall.id);
      if (!aggregator) continue;
      try {
        if (aggregator.subagentIdentity != null) {
          toolCall.subagentIdentity = aggregator.subagentIdentity;
        }
        /** `createContentAggregator` returns a sparse array (undefined
         *  slots for indices that never received content). Strip those
         *  so the persisted shape is a clean `TMessageContentParts[]`. */
        const parts = Array.isArray(aggregator.contentParts)
          ? aggregator.contentParts.filter((p) => p != null)
          : [];
        if (parts.length > 0) {
          toolCall.subagent_content = parts;
        }
      } catch (err) {
        logger.warn(
          `[AgentClient] Failed to attach subagent content for tool_call ${toolCall.id}`,
          getSafeErrorMetadata(err),
        );
      }
    }
    buffer.clear();
  }

  /** Stamps host-resolved MCP identities onto persisted calls so future replay
   * can distinguish delimiter-bearing tool names from longer server names. */
  stampMcpServerIdentities() {
    stampMcpServerIdentities({
      contentParts: this.contentParts,
      roots: [this.options.agent, ...(this.agentConfigs?.values() ?? [])],
    });
  }

  /**
   * Apply one drained steer to host state: append the steer content part at
   * the live content index, bump the shared index offset so subsequent SDK
   * step indices land past it, and emit `on_steer_applied` so the live client
   * replaces its pending chip with the inline part (the emitted chunk also
   * reaches the Redis chunk log for reconnect reconstruction).
   *
   * Runs BEFORE the drain hook's media encode so an abort during the encode
   * cannot lose the steer. File refs persist from the queue item (sanitized at
   * enqueue); replay/token accounting re-fetch owner-scoped and re-encode per
   * turn (stampSteerPartMedia), so unauthorized ids drop out there.
   *
   * @param {string} streamId
   * @param {import('@librechat/api').SteerQueueItem} item
   */
  async applySteerPart(streamId, item) {
    const index = this.contentParts.length;
    const part = {
      type: ContentTypes.STEER,
      [ContentTypes.STEER]: item.text,
      steerId: item.steerId,
      ...(item.clientSteerId && { clientSteerId: item.clientSteerId }),
      createdAt: item.createdAt,
      ...(item.files?.length && { files: item.files }),
      // Persisted separately from the text (mirroring `message.quotes`) so the
      // UI renders reference blocks and replay re-merges them per turn.
      ...(item.quotes?.length && { quotes: item.quotes }),
    };
    this.contentParts.push(part);
    this.steerOffsetState.offset += 1;
    // durable: the chunk-log XADD is this event's recovery record — it must
    // commit before the publish or a cross-replica reconnect that missed the
    // pub/sub delivery reconstructs content without the steer part.
    try {
      await GenerationJobManager.emitChunk(
        streamId,
        {
          event: SteerEvents.ON_STEER_APPLIED,
          data: {
            steerId: item.steerId,
            ...(item.clientSteerId && { clientSteerId: item.clientSteerId }),
            index,
            part,
            responseMessageId: this.responseMessageId,
            conversationId: this.conversationId,
          },
        },
        {
          durable: true,
          expectedCreatedAt: this.jobCreatedAt,
          deliveredSteer: item,
        },
      );
      this.appliedSteerParts.set(item.steerId, { index, part });
      /** Only a COMMITTED steer is a hard semantic boundary. If its durable
       *  append failed, the drain restores the queue item and the current
       *  phase evidence must remain intact for the eventual retry. */
      this.activityPhaseWiring?.drop?.();
    } catch (error) {
      /** The part and its receipt commit as one durable unit. Roll the local
       * projection back when that commit fails so the drain can restore the
       * claimed item instead of injecting an instruction absent from replay. */
      if (this.contentParts[index] === part) {
        this.contentParts.splice(index, 1);
        this.steerOffsetState.offset -= 1;
      }
      this.appliedSteerParts.delete(item.steerId);
      throw error;
    }
  }

  async stripSteerAttachmentRefs(streamId, item) {
    this.rollbackSteerAttachmentAdmission(item.steerId);
    const applied = this.appliedSteerParts.get(item.steerId);
    if (!applied?.part?.files?.length) {
      return;
    }
    const part = { ...applied.part };
    delete part.files;
    this.contentParts[applied.index] = part;
    this.appliedSteerParts.set(item.steerId, { index: applied.index, part });
    await GenerationJobManager.emitChunk(
      streamId,
      {
        event: SteerEvents.ON_STEER_APPLIED,
        data: {
          steerId: item.steerId,
          ...(item.clientSteerId && { clientSteerId: item.clientSteerId }),
          index: applied.index,
          part,
          responseMessageId: this.responseMessageId,
          conversationId: this.conversationId,
        },
      },
      {
        durable: true,
        expectedCreatedAt: this.jobCreatedAt,
      },
    );
  }

  rollbackSteerAttachmentAdmission(steerId) {
    const admitted = this.admittedSteerAttachments.get(steerId);
    this.admittedSteerAttachments.delete(steerId);
    if (!admitted?.length) {
      return;
    }
    const removeOccurrences = (files) => {
      if (!Array.isArray(files)) {
        return;
      }
      for (let index = admitted.length - 1; index >= 0; index--) {
        const occurrence = files.lastIndexOf(admitted[index]);
        if (occurrence >= 0) {
          files.splice(occurrence, 1);
        }
      }
    };
    removeOccurrences(this.turnSharedAttachmentFiles);
    removeOccurrences(this.attachmentMemoryContext?.attachments);
  }

  /**
   * The `steering` fragment for `createRun`: the run-scoped PostToolBatch
   * drain hook — plus the capability-gated PreemptBoundary and terminal Stop
   * twins built from the SAME drain closures, so every boundary injects
   * byte-identical shapes. `undefined` when there is no
   * resumable job surface or the installed SDK cannot inject hook messages
   * (draining would drop them).
   *
   * @param {string | undefined} streamId
   */
  buildSteerWiring(streamId) {
    if (!streamId || !isSteeringSupported()) {
      return undefined;
    }
    const drainOptions = {
      streamId,
      jobCreatedAt: this.jobCreatedAt,
      applySteer: (item) => this.applySteerPart(streamId, item),
      onMediaError: (item) => this.stripSteerAttachmentRefs(streamId, item),
      buildMedia: async (item) => {
        const media = await buildSteerMedia({
          client: this,
          user: this.options.req?.user,
          item,
          getFiles: db.getFiles,
          assertFilesAllowed: (files) => this.admitSteerAttachments(files, item.steerId),
        });
        this.admittedSteerAttachments.delete(item.steerId);
        return media;
      },
    };
    return {
      hook: createSteerDrainHook(drainOptions),
      ...(isSteerPreemptSupported() && {
        preemptHook: createSteerPreemptBoundaryHook(drainOptions),
        preemption: createSteerPreemptPoll(streamId, this.jobCreatedAt),
      }),
      ...(isSteerTerminalContinuationSupported() && {
        terminalHook: createSteerTerminalContinuationHook(drainOptions),
      }),
    };
  }

  /**
   * Registers the parent conversation write as a child-dispatch prerequisite.
   * The store retains only the persistence promise, never this request-scoped client.
   * @param {string} message
   * @param {Record<string, unknown>} [opts]
   */
  async sendMessage(message, opts = {}) {
    const subagentTasks = this.options?.subagentTasks;
    const store = subagentTasks?.store;
    if (typeof store?.registerParentPersistence !== 'function') {
      return super.sendMessage(message, opts);
    }
    const getReqData = opts.getReqData;
    return super.sendMessage(message, {
      ...opts,
      getReqData: (data = {}) => {
        getReqData?.(data);
        if (data.userMessagePromise instanceof Promise) {
          store.registerParentPersistence(subagentTasks.scopeId, data.userMessagePromise);
        }
      },
    });
  }

  setOptions(_options) {}

  /**
   * Resolve provider + client options for the
   * tool-batch summary model. Same resolution path as titleConvo minus the
   * title-specific branches. Model precedence: the endpoint's
   * `activityModel` > its `titleModel` > the agent's own model, on the
   * endpoint named by `activityEndpoint` (default: the agent's).
   */
  async resolveActivityLabelLLM() {
    /** Memoized per response: resolution reads provider config and can hit the
     *  database for user keys, and nothing it depends on changes between
     *  batches of the same run — so re-resolving on every batch (twice, with
     *  usage accounting) is repeated credential work for an identical result.
     *  The promise is cached rather than the value so concurrent batches share
     *  one in-flight resolution. */
    this.activityLabelLLMPromise =
      this.activityLabelLLMPromise ??
      resolveActivityLabelModel({
        req: this.options.req,
        agent: this.options.agent,
        /** Same public-endpoint-first field resolution as the wiring gate. */
        publicEndpoint: this.options.endpoint,
        ids: {
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          parentMessageId: this.parentMessageId,
        },
        db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
      }).catch((error) => {
        /** Never cache a rejection: a transient credential read failure would
         *  otherwise disable labels for the rest of the response. */
        this.activityLabelLLMPromise = null;
        throw error;
      });
    return this.activityLabelLLMPromise;
  }

  /** Phase resolution is independently configurable and memoized per response. */
  async resolveActivityPhaseLabelLLM() {
    this.activityPhaseLabelLLMPromise =
      this.activityPhaseLabelLLMPromise ??
      resolveActivityPhaseLabelModel({
        req: this.options.req,
        agent: this.options.agent,
        publicEndpoint: this.options.endpoint,
        ids: {
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          parentMessageId: this.parentMessageId,
        },
        db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
      }).catch((error) => {
        this.activityPhaseLabelLLMPromise = null;
        throw error;
      });
    return this.activityPhaseLabelLLMPromise;
  }

  /** Reasoning-label resolution is independently configurable and memoized per response. */
  async resolveReasoningLabelLLM() {
    this.reasoningLabelLLMPromise =
      this.reasoningLabelLLMPromise ??
      resolveReasoningLabelModel({
        req: this.options.req,
        agent: this.options.agent,
        publicEndpoint: this.options.endpoint,
        ids: {
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          parentMessageId: this.parentMessageId,
        },
        db: { getUserKey: db.getUserKey, getUserKeyValues: db.getUserKeyValues },
      }).catch((error) => {
        this.reasoningLabelLLMPromise = null;
        throw error;
      });
    return this.reasoningLabelLLMPromise;
  }

  /** Seeds the shared negative usage sequence from durable label-call state. */
  seedActivityLabelUsageSequence() {
    this.activityLabelUsageSeq = getLabelUsageSequenceSeed(
      this.contentParts ?? [],
      this.activityLabelUsageSeq,
    );
  }

  /**
   * Bills the label call and folds its usage into the response rollup with
   * an `activity-label` tag (subagent precedent) so `metadata.usage` and the
   * live cost gauge reflect it. Tagged, so it is not a PRIMARY usage event
   * and cannot disturb the context-snapshot pairing in buildResponseMetadata.
   */
  async recordActivityLabelUsage(
    collectedMetadata,
    model,
    endpointTokenConfig,
    sameEndpoint,
    /** Optional suppression gate, defaulting open. The hook-driven paths
     *  deliberately pass nothing: they invoke accounting ONLY for a
     *  COMMITTED fill, and a committed (visible) label must bill even when
     *  its scope closed during the durable emit — the commit flag, not the
     *  scope, is the billing authority. */
    scopeOpen = () => true,
    /** The LABEL endpoint's provider — cost math needs it to know whether
     *  cache tokens are folded into `input_tokens` (additive providers like
     *  Bedrock keep them separate). */
    provider = undefined,
    /** Lazy `() => ({ promptText, completionText })` fallback. When the
     *  provider omits usage metadata entirely, labels bill by ESTIMATE —
     *  the title convention — from locally counted text rather than going
     *  unbilled. Invoked only when no entry carries a real token count. */
    estimate = undefined,
    /** Separate telemetry bucket for parent phase summaries. */
    usageType = 'activity-label',
  ) {
    const appConfig = this.options.req?.config;
    /** Provider ON EVERY ENTRY, not just the streamed event: `splitUsage`
     *  keys additive-vs-subset cache math on `usage.provider`, and an
     *  unknown provider takes the additive branch — for Anthropic/OpenAI
     *  (cache already inside `input_tokens`) that re-adds cache_read and
     *  cache_creation on top, double-charging the balance while the
     *  streamed cost (which carries the provider) disagrees. */
    let collectedUsage = mapCollectedMetadataToUsage(collectedMetadata).map((usage) =>
      provider != null ? { ...usage, provider } : usage,
    );
    const hasRealUsage = collectedUsage.some(
      (usage) => usage.input_tokens != null || usage.output_tokens != null,
    );
    if (!hasRealUsage && typeof estimate === 'function') {
      try {
        const { promptText = '', completionText = '' } = estimate() ?? {};
        const [input_tokens, output_tokens] = await Promise.all([
          countTokens(promptText),
          countTokens(completionText),
        ]);
        collectedUsage = [
          provider != null
            ? { input_tokens, output_tokens, provider }
            : { input_tokens, output_tokens },
        ];
      } catch (err) {
        logger.warn(
          `[AgentClient] Failed to estimate activity-label usage: ${err?.message ?? err}`,
        );
      }
    }
    if (
      collectedUsage.length === 0 ||
      !collectedUsage.some((usage) => usage.input_tokens != null || usage.output_tokens != null)
    ) {
      return;
    }
    if (!scopeOpen()) {
      return;
    }
    const streamId = this.options.req?._resumableStreamId || null;
    const includeCost = this.options.req?.config?.interfaceConfig?.contextCost === true;
    /** Cross-endpoint labels (`activityEndpoint`) price with THEIR endpoint's
     *  rates. `undefined` is a MEANINGFUL result for a built-in label endpoint
     *  (built-ins price from the shared table, not a per-endpoint map), so it
     *  must not fall through to the agent's custom rates — a custom primary
     *  pointing `activityEndpoint` at a built-in would bill the label at its
     *  own rates. Only inherit when the label actually runs on the agent's
     *  endpoint. */
    const labelTokenConfig = sameEndpoint
      ? (endpointTokenConfig ?? this.options.endpointTokenConfig)
      : endpointTokenConfig;
    for (const usage of collectedUsage) {
      /** `seq` is normally a position in `collectedUsage` (each emitter
       *  pushes, then emits with the new length). Label usage is billed
       *  separately and never appended there, so it has no position: any
       *  positive value eventually collides with a real one, and the client
       *  dedupes on `runId:seq`. Labels therefore occupy a NEGATIVE seq
       *  namespace that positional sequences can never reach. The key is
       *  only used for Set membership, so the sign is inert. */
      this.activityLabelUsageSeq = (this.activityLabelUsageSeq ?? 0) + 1;
      const data = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        /** Cache tokens ride along (subagent-event shape) so display and
         *  aggregation price cached label calls at cache rates. */
        ...(usage.input_token_details != null && {
          input_token_details: usage.input_token_details,
        }),
        ...(provider != null && { provider }),
        model,
        usage_type: usageType,
        /**
         * Scoped to the GENERATION, not just the response. Editing one
         * assistant response reuses its `responseMessageId` while each fresh
         * server generation restarts `activityLabelUsageSeq`, so a second
         * edit re-emitted `<responseId>:-1` and the client — which dedupes on
         * exactly `runId:seq` — discarded the newer usage even though its
         * balance transaction was still written. `jobCreatedAt` is the run's
         * own epoch: stable across reconnects and HITL resumes of one
         * generation, distinct between generations.
         */
        runId:
          this.jobCreatedAt != null
            ? `${this.responseMessageId}:${this.jobCreatedAt}`
            : this.responseMessageId,
        seq: -this.activityLabelUsageSeq,
        /** Cost coverage is all-or-nothing in `aggregateEmittedUsage`: an
         *  event without `cost` suppresses the whole response's cost when
         *  `interface.contextCost` is on. */
        cost: includeCost
          ? computeUsageCostUSD(
              { ...usage, model, provider },
              { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
              labelTokenConfig,
            )
          : undefined,
      };
      /** Fold into the response rollup synchronously, then stream it like
       *  primary/subagent usage so the live session gauge stays honest.
       *  Retained and flushed with the subagent emits so job cleanup cannot
       *  race the persist. */
      this.usageEmitSink?.push(data);
      if (streamId) {
        const emit = GenerationJobManager.emitChunk(
          streamId,
          {
            event: UsageEvents.ON_TOKEN_USAGE,
            data,
          },
          /** Same epoch scoping as the label event: this usage is recorded
           *  from a detached generation and must not bill against whichever
           *  generation replaced it. */
          { expectedCreatedAt: this.jobCreatedAt },
        ).catch((err) => {
          logger.warn(`[AgentClient] Failed to emit ${usageType} usage: ${err?.message ?? err}`);
        });
        this.pendingSubagentEmits.push(emit);
      }
    }
    await this.recordCollectedUsage({
      collectedUsage,
      context: usageType,
      model,
      endpointTokenConfig: labelTokenConfig,
      /** The label ran elsewhere, so its config governs even when undefined. */
      crossEndpoint: sameEndpoint === false,
      balance: getBalanceConfig(appConfig),
      transactions: getTransactionsConfig(appConfig),
      messageId: this.responseMessageId,
      /** Billed, but NOT the response's stream usage — see the parameter. */
      updateStreamUsage: false,
    }).catch((err) => {
      logger.error(
        '[api/server/controllers/agents/client.js #recordActivityLabelUsage] Error recording usage',
        err,
      );
    });
  }

  /**
   * Bridges label generation to the SDK's `run.generateActivityLabel()` so
   * the fast-model call is Langfuse-traced under the conversation's session
   * (thread_id) with its own tags — never as an orphan trace. Returns null
   * when the label could not be generated.
   */
  async generateActivityLabelViaRun({
    entries,
    context,
    previousLabels,
    traceSeed,
    signal,
    charLimit,
    prompt,
    executingAgentId,
    deferUsage,
  }) {
    /** Version gating happens at wiring time via the `sdkCapable` prototype
     *  probe, so this only catches a run that is missing or not yet built.
     *  Resolve `undefined` (not `null`) so the hook reads it as "this path
     *  cannot serve the request" and falls back to the direct model call;
     *  `null` would mean "ran, produced no label" and would leave the slot
     *  permanently empty. */
    if (typeof this.run?.generateActivityLabel !== 'function') {
      return undefined;
    }
    const { provider, clientOptions, endpointTokenConfig, sameEndpoint } =
      await this.resolveActivityLabelLLM();
    const { handleLLMEnd, collected: collectedMetadata } = createMetadataAggregator();
    /**
     * NO scope gate here: the hook invokes this ONLY for a COMMITTED fill,
     * and the commit flag is the single billing authority. A scope that
     * closes while the fill's durable emit is in flight does not un-commit
     * the label — it is persisted and visible — so gating on the scope here
     * turned that race into a completed provider call escaping both the
     * label charge and the primary abort accounting. The reverse direction
     * (billed but never shown) is enforced by the commit gate itself: a
     * dropped fill never reaches this callback.
     */
    /**
     * The PROMPT THE SDK ACTUALLY SENT, captured at chain start. The hook's
     * estimate thunk carries this module's locally built prompt — same
     * entries and instruction but different framing — so estimated billing
     * on this path would count a prompt that was never sent. When capture
     * succeeded, it replaces the thunk's promptText.
     */
    let sdkPromptText;
    const capturePrompt = {
      handleLLMStart: (_llm, prompts) => {
        sdkPromptText = Array.isArray(prompts) ? prompts.join('\n') : undefined;
      },
      handleChatModelStart: (_llm, messages) => {
        try {
          sdkPromptText = (messages ?? [])
            .flat()
            .map((message) =>
              typeof message?.content === 'string'
                ? message.content
                : JSON.stringify(message?.content ?? ''),
            )
            .join('\n');
        } catch {
          /** Estimation falls back to the local approximation. */
        }
      },
    };
    const recordUsage = async (estimate) => {
      const refined =
        typeof estimate === 'function'
          ? () => {
              const base = estimate() ?? {};
              return sdkPromptText != null && sdkPromptText.length > 0
                ? { ...base, promptText: sdkPromptText }
                : base;
            }
          : estimate;
      await this.recordActivityLabelUsage(
        collectedMetadata,
        clientOptions.model,
        endpointTokenConfig,
        sameEndpoint,
        undefined,
        provider,
        refined,
      );
    };
    /**
     * Accounting is DEFERRED to the hook, which runs it only after the slot
     * commit settles. Awaiting it here (pre-fill) let the settlement window
     * expire during the balance write: the charge landed, then the fill was
     * dropped as out-of-scope — billed, never shown. Registered before the
     * call so a mid-call throw still bills whatever metadata the provider
     * returned, exactly like the old `finally` did.
     */
    let usageDeferred = false;
    if (typeof deferUsage === 'function') {
      usageDeferred = true;
      deferUsage(recordUsage);
    }
    try {
      const { label } = await this.run.generateActivityLabel({
        provider,
        clientOptions,
        entries: entries.map(({ toolName, toolInput, toolOutput, error, status }) => ({
          toolName,
          toolInput,
          toolOutput,
          error,
          status,
        })),
        thinkingExcerpts: context.thinkingExcerpts,
        lastAssistantText: context.lastAssistantText,
        lastAssistantPhase: context.lastAssistantPhase,
        ...(previousLabels != null && { previousLabels }),
        traceSeed,
        charLimit,
        /** Selects the EXECUTING agent's Langfuse metadata and, more
         *  importantly, its tool-output redaction policy. Omitting it lets a
         *  handoff's activity be traced and redacted under the default
         *  agent's configuration, bypassing a stricter per-agent policy. */
        ...(executingAgentId != null && { agentId: executingAgentId }),
        /** The wiring always supplies one (the yaml `activityPrompt` when
         *  set, else this repo's instruction). Falling through to the SDK's
         *  built-in prompt would silently use a different register. */
        ...((prompt ?? this.activityLabelPrompt) != null && {
          prompt: prompt ?? this.activityLabelPrompt,
        }),
        chainOptions: {
          signal,
          callbacks: [{ handleLLMEnd, ...capturePrompt }],
          configurable: {
            thread_id: this.conversationId,
            user_id: this.user ?? this.options.req?.user?.id,
          },
        },
      });
      return label ?? null;
    } finally {
      /** Safety net for a caller that did not defer (none in-tree): the old
       *  inline accounting, still scope-gated. */
      if (!usageDeferred) {
        await recordUsage();
      }
    }
  }

  /**
   * SDK bridge for parent phase summaries. Usage is returned as a deferred
   * collector so the runtime can commit the durable label first and bill
   * only summaries that actually became visible.
   */
  async generateActivityPhaseViaRun({
    activities,
    assistantContext,
    closingTextPhase,
    phaseIndex,
    totalActivityCount,
    status,
    agentIds,
    charLimit,
    prompt,
    signal,
  }) {
    if (typeof this.run?.generateActivityPhaseLabel !== 'function') {
      return {};
    }
    const { provider, clientOptions, endpointTokenConfig, sameEndpoint } =
      await this.resolveActivityPhaseLabelLLM();
    const { handleLLMEnd, collected } = createMetadataAggregator();
    let sdkPromptText;
    const capturePrompt = {
      handleLLMStart: (_llm, prompts) => {
        sdkPromptText = Array.isArray(prompts) ? prompts.join('\n') : undefined;
      },
      handleChatModelStart: (_llm, messages) => {
        try {
          sdkPromptText = (messages ?? [])
            .flat()
            .map((message) =>
              typeof message?.content === 'string'
                ? message.content
                : JSON.stringify(message?.content ?? ''),
            )
            .join('\n');
        } catch {
          // Providers with usage metadata do not need the estimate fallback.
        }
      },
    };
    let label;
    try {
      ({ label } = await this.run.generateActivityPhaseLabel({
        provider,
        clientOptions,
        activities,
        assistantContext,
        closingTextPhase,
        phaseIndex,
        totalActivityCount,
        status,
        agentIds,
        charLimit,
        prompt,
        sourceRunId: this.responseMessageId,
        sourceTraceId: traceIdForMessage(this.responseMessageId),
        responseId: this.responseMessageId,
        traceSeed: `${this.responseMessageId}-activity-phase-${phaseIndex}`,
        chainOptions: {
          signal,
          callbacks: [{ handleLLMEnd, ...capturePrompt }],
          configurable: {
            thread_id: this.conversationId,
            user_id: this.user ?? this.options.req?.user?.id,
            requestBody: { parentMessageId: this.parentMessageId },
          },
        },
      }));
    } catch (error) {
      if (!signal?.aborted) {
        logger.warn('[AgentClient] Activity phase generation failed', error);
      }
    }
    return {
      label,
      collectUsage: async (completionText) =>
        this.recordActivityLabelUsage(
          collected,
          clientOptions.model,
          endpointTokenConfig,
          sameEndpoint,
          undefined,
          provider,
          () => ({ promptText: sdkPromptText ?? '', completionText: completionText ?? '' }),
          'activity-phase',
        ),
    };
  }

  /** SDK bridge for one revision of a live reasoning-step title. */
  async generateReasoningLabelViaRun({
    visibleReasoning,
    reasoningStepId,
    revision,
    status,
    previousLabel,
    agentId,
    charLimit,
    prompt,
    signal,
  }) {
    return generateReasoningLabelRevision({
      payload: {
        visibleReasoning,
        reasoningStepId,
        revision,
        status,
        ...(previousLabel != null && { previousLabel }),
        ...(agentId != null && { agentId }),
        charLimit,
        ...(prompt != null && { prompt }),
        signal,
      },
      run: this.run,
      resolveModel: () => this.resolveReasoningLabelLLM(),
      sourceRunId: this.responseMessageId,
      sourceTraceId: traceIdForMessage(this.responseMessageId),
      responseId: this.responseMessageId,
      sessionId: this.conversationId,
      userId: this.user ?? this.options.req?.user?.id,
      parentMessageId: this.parentMessageId,
      recordUsage: ({
        collectedMetadata,
        model,
        endpointTokenConfig,
        sameEndpoint,
        provider,
        promptText,
        completionText,
      }) =>
        this.recordActivityLabelUsage(
          collectedMetadata,
          model,
          endpointTokenConfig,
          sameEndpoint,
          undefined,
          provider,
          () => ({ promptText, completionText }),
          'reasoning-label',
        ),
      onError: (error) => logger.warn('[AgentClient] Reasoning label generation failed', error),
    });
  }

  /** Bounded settle for in-flight label fills before finalization. On
   *  timeout the label scope is closed and its abort controller fired, so a
   *  straggler cannot mutate the saved response or emit into a dead job. */
  async settleActivityLabels(timeoutMs = 3000) {
    /** Detached even when nothing settled: the wiring attaches its abort
     *  listener at BUILD time, and a segment can end without a single claim
     *  (text-only, or handoff batches, which skip labels) — the early
     *  return below would otherwise leave that listener accumulating across
     *  HITL approval cycles on the shared job signal. Idempotent. */
    const detachScopeListeners = () => {
      for (const scope of this.activityLabelScopes ?? []) {
        scope.detach?.();
      }
    };
    const closeScopes = () => {
      /** Close EVERY generation's scope: a pre-pause wiring's straggler must
       *  stay closed even though a resume built a newer one. */
      for (const scope of this.activityLabelScopes ?? []) {
        scope.closed = true;
        scope.abort.abort();
      }
    };
    const deadline = Date.now() + timeoutMs;
    while ((this.pendingActivityLabelFills?.length ?? 0) > 0) {
      const pending = this.pendingActivityLabelFills;
      this.pendingActivityLabelFills = [];
      const remainingMs = Math.max(0, deadline - Date.now());
      let timedOut = remainingMs === 0;
      if (!timedOut) {
        await settlePendingLabelFills(pending, remainingMs, () => {
          timedOut = true;
          closeScopes();
        });
      }
      if (timedOut) {
        closeScopes();
        break;
      }
      /** A reasoning revision can synchronously enqueue its trailing final
       *  revision from the settled task's `finally`; drain it under the same
       *  deadline before any content reshaping can invalidate its index. */
    }
    detachScopeListeners();
  }

  /**
   * Activity-label wiring. At each batch boundary the hook synchronously
   * claims a live content slot (steering's index-offset pattern: push
   * placeholder with deterministic counts, bump the shared offset so
   * subsequent SDK indices land past it) and fills it when the fast-model
   * label resolves. Both states reach the live client via the dedicated
   * `on_activity_label` event; failures leave the counts-only part.
   * @param {string | undefined} streamId
   */
  buildActivityLabelWiring(streamId, abortSignal) {
    if (!streamId) {
      return undefined;
    }
    /** Per-endpoint opt-in via `activityLabel: true` in librechat.yaml,
     *  resolved the same way the title options are (endpoints.all > named
     *  endpoint > custom endpoint config). Custom endpoints live in the
     *  `endpoints.custom` ARRAY, so their settings are only visible through
     *  the matched entry — without it every custom endpoint reads as
     *  disabled. */
    const agentEndpoint = this.options.agent?.endpoint ?? '';
    const appConfigForActivity = this.options.req?.config;
    let customEndpointConfig;
    try {
      customEndpointConfig = getCustomEndpointConfig({
        endpoint: agentEndpoint,
        appConfig: appConfigForActivity,
      });
    } catch {
      customEndpointConfig = undefined;
    }
    const activityConfig = resolveActivityConfig(
      appConfigForActivity,
      agentEndpoint,
      customEndpointConfig,
      /** The PUBLIC endpoint (`agents`): `initializeAgent` rewrites
       *  `agent.endpoint` to the backing provider, so without this an
       *  admin's `endpoints.agents.activityLabel: true` reads the
       *  provider's block instead and the feature stays off. */
      this.options.endpoint,
    );
    if (!activityConfig.enabled) {
      return undefined;
    }
    this.activityLabelPrompt = activityConfig.prompt;
    /**
     * Mark the job so a resume can reconcile label gaps without probing
     * content. Retried rather than fire-and-forget: this flag GATES that
     * reconciliation, and it is a separate write from the durable label
     * append — so a single lost write silently drops a label that the label
     * content itself recorded perfectly well. One retry costs nothing at run
     * setup and removes the only realistic way the gate goes stale.
     */
    /** Retained (not fire-and-forget): the RUN START awaits this persist
     *  (chatCompletion/resumeCompletion, before processStream/resume), so
     *  the flag is durable before any batch can claim a label — closing the
     *  immediate-reconnect race WITHOUT delaying the claim-time reservation
     *  emit, whose ordering against shifted SDK indices is load-bearing.
     *  The chain settles on failure (warned retry), so a lost write can
     *  never wedge run startup. */
    this.activityLabelsMarkedPromise =
      this.activityLabelsMarkedPromise ??
      GenerationJobManager.markActivityLabels(streamId, this.jobCreatedAt).catch(() =>
        GenerationJobManager.markActivityLabels(streamId, this.jobCreatedAt).catch(() => {
          logger.warn(
            `[AgentClient] Could not flag activity labels for ${streamId}; a label resolving during a resume gap may not be reconciled.`,
          );
        }),
      );
    /** SDK support probe (steering-style): the Run method and the formatter
     *  replay skip ship together, so method presence is the capability. */
    const sdkCapable = typeof Run?.prototype?.generateActivityLabel === 'function';
    /** Label-scoped abort: fired when settle times out so a straggling
     *  generation stops burning provider time for a finalized response.
     *  Chained to the run signal so a user abort still cancels labels. */
    /** Close state is PER WIRING, not per client: a HITL resume rebuilds the
     *  wiring, and resetting a shared instance flag would re-open closures
     *  from the pre-pause segment whose provider call ignored the abort.
     *  Scopes are retained so settle closes every generation, past included. */
    const labelScope = { closed: false, abort: new AbortController() };
    this.activityLabelScopes = this.activityLabelScopes ?? [];
    this.activityLabelScopes.push(labelScope);
    /** Seed the usage sequence past the labels already on this response.
     *  `runId` is the response message id, so a HITL resume — which builds a
     *  NEW client for the SAME response — would otherwise restart at -1 and
     *  the client's `runId:seq` deduper would discard the post-approval
     *  label's usage as already counted. Each label generation is a single
     *  non-streaming invoke, so one existing label part == one consumed seq. */
    this.seedActivityLabelUsageSequence();
    this.activityLabelAbort = labelScope.abort;
    /** An abort CLOSES the scope, not just cancels the call. The rejected
     *  generation still runs its catch and calls `fill(null)`; with the scope
     *  merely aborted that fill would emit — and by then the next generation
     *  may already own the stream, so the event would land an index from the
     *  abandoned response onto the new one. */
    const closeOnAbort = () => {
      labelScope.closed = true;
      labelScope.abort.abort();
    };
    if (abortSignal != null) {
      if (abortSignal.aborted) {
        closeOnAbort();
      } else {
        abortSignal.addEventListener('abort', closeOnAbort, { once: true });
        /** Detached once this segment settles: HITL runs rebuild a wiring
         *  per approval cycle on the SAME job signal, and `once` only
         *  removes the listener if an abort actually fires — long
         *  multi-approval runs would otherwise accumulate obsolete
         *  closures toward the listener-limit warning. */
        labelScope.detach = () => abortSignal.removeEventListener('abort', closeOnAbort);
      }
    }
    /** Thin wrapper: slot claiming, lane stamping, emit ordering, and settle
     *  tracking live in `createActivityLabelWiring` (packages/api, TS). */
    return createActivityLabelWiring({
      maxPerRun: activityConfig.maxPerRun,
      charLimit: activityConfig.charLimit,
      prompt: activityConfig.prompt,
      abortSignal: labelScope.abort.signal,
      isClosed: () => labelScope.closed,
      getContentParts: () => this.contentParts,
      bumpIndexOffset: () => {
        this.steerOffsetState.offset += 1;
      },
      /** Emits IMMEDIATELY — never sequenced behind the flag persist. The
       *  claim has already bumped the shared index offset, so delaying the
       *  reservation while shifted SDK chunks persist would let a
       *  cross-instance reconnect reconstruct a hole, compact it, and have
       *  the late label event overwrite the part that moved into its index.
       *  Flag ordering is guaranteed upstream instead: run start awaits the
       *  persist, so the flag is durable before any batch can claim. */
      emitLabelEvent: (index, part) =>
        GenerationJobManager.emitChunk(
          streamId,
          {
            event: ActivityLabelEvents.ON_ACTIVITY_LABEL,
            data: {
              index,
              part,
              responseMessageId: this.responseMessageId,
              conversationId: this.conversationId,
            },
          },
          /** Label generation is detached and can outlive its generation, so
           *  the emit is scoped to the epoch that claimed the index. Without
           *  it a straggler from a replaced generation lands its old index on
           *  the new response — invisibly, since an empty label renders
           *  nothing — overwriting whatever occupies that slot. */
          { durable: true, expectedCreatedAt: this.jobCreatedAt },
        ),
      trackPendingFill: (fillDone) => {
        this.pendingActivityLabelFills = this.pendingActivityLabelFills ?? [];
        this.pendingActivityLabelFills.push(fillDone);
      },
      resolveLLM: () => this.resolveActivityLabelLLM(),
      /** Per-generation usage accounting for the direct fallback path;
       *  the SDK bridge records its own via chainOptions callbacks. */
      getInvokeCallbacks: () => {
        const { handleLLMEnd, collected } = createMetadataAggregator();
        return {
          callbacks: [{ handleLLMEnd }],
          collect: async (estimate) => {
            const { provider, clientOptions, endpointTokenConfig, sameEndpoint } =
              await this.resolveActivityLabelLLM();
            await this.recordActivityLabelUsage(
              collected,
              clientOptions.model,
              endpointTokenConfig,
              sameEndpoint,
              /** No scope gate — the hook invokes collect ONLY for a
               *  COMMITTED fill (the billing authority), and a scope that
               *  closes during the fill's durable emit must not let a
               *  visible label escape its charge. Dropped fills never
               *  reach this callback. */
              undefined,
              provider,
              estimate,
            );
          },
        };
      },
      ...(sdkCapable && {
        generateLabel: (payload) => this.generateActivityLabelViaRun(payload),
      }),
    });
  }

  /** Builds the independently opt-in parent activity-phase collector. */
  buildActivityPhaseWiring(streamId, abortSignal, initialSnapshot) {
    if (!streamId || typeof Run?.prototype?.generateActivityPhaseLabel !== 'function') {
      return undefined;
    }
    const agentEndpoint = this.options.agent?.endpoint ?? '';
    const appConfig = this.options.req?.config;
    let customEndpointConfig;
    try {
      customEndpointConfig = getCustomEndpointConfig({ endpoint: agentEndpoint, appConfig });
    } catch {
      customEndpointConfig = undefined;
    }
    const phaseConfig = resolveActivityPhaseConfig(
      appConfig,
      agentEndpoint,
      customEndpointConfig,
      this.options.endpoint,
    );
    if (!phaseConfig.enabled) {
      return undefined;
    }

    this.activityLabelsMarkedPromise =
      this.activityLabelsMarkedPromise ??
      GenerationJobManager.markActivityLabels(streamId, this.jobCreatedAt).catch(() =>
        GenerationJobManager.markActivityLabels(streamId, this.jobCreatedAt).catch(() => {
          logger.warn(
            `[AgentClient] Could not flag activity phases for ${streamId}; a phase resolving during a resume gap may not be reconciled.`,
          );
        }),
      );

    const scope = { closed: false, abort: new AbortController() };
    this.activityLabelScopes = this.activityLabelScopes ?? [];
    this.activityLabelScopes.push(scope);
    const closeOnAbort = () => {
      scope.closed = true;
      scope.abort.abort();
    };
    if (abortSignal != null) {
      if (abortSignal.aborted) {
        closeOnAbort();
      } else {
        abortSignal.addEventListener('abort', closeOnAbort, { once: true });
        scope.detach = () => abortSignal.removeEventListener('abort', closeOnAbort);
      }
    }
    this.seedActivityLabelUsageSequence();

    const wiring = createActivityPhaseWiring({
      maxPerRun: phaseConfig.maxPerRun,
      charLimit: phaseConfig.charLimit,
      prompt: phaseConfig.prompt,
      initialSnapshot,
      abortSignal: scope.abort.signal,
      isClosed: () => scope.closed,
      getContentParts: () => this.contentParts,
      getStepIndex: (stepId) => this.stepMap?.get(stepId)?.index,
      bumpIndexOffset: () => {
        this.steerOffsetState.offset += 1;
      },
      emitLabelEvent: (index, part) =>
        GenerationJobManager.emitChunk(
          streamId,
          {
            event: ActivityLabelEvents.ON_ACTIVITY_LABEL,
            data: {
              index,
              part,
              responseMessageId: this.responseMessageId,
              conversationId: this.conversationId,
            },
          },
          { durable: true, expectedCreatedAt: this.jobCreatedAt },
        ),
      trackPendingFill: (fillDone) => {
        this.pendingActivityLabelFills = this.pendingActivityLabelFills ?? [];
        this.pendingActivityLabelFills.push(fillDone);
      },
      generatePhase: (payload) => this.generateActivityPhaseViaRun(payload),
    });
    this.activityPhaseWiring = wiring;
    return wiring;
  }

  /** Builds the independently opt-in live reasoning-label controller. */
  buildReasoningLabelWiring(streamId, abortSignal, seedFromContent = false) {
    if (!streamId || typeof Run?.prototype?.generateReasoningLabel !== 'function') {
      return undefined;
    }
    const agentEndpoint = this.options.agent?.endpoint ?? '';
    const appConfig = this.options.req?.config;
    let customEndpointConfig;
    try {
      customEndpointConfig = getCustomEndpointConfig({ endpoint: agentEndpoint, appConfig });
    } catch {
      customEndpointConfig = undefined;
    }
    const config = resolveReasoningLabelConfig(
      appConfig,
      agentEndpoint,
      customEndpointConfig,
      this.options.endpoint,
    );
    if (!config.enabled) {
      return undefined;
    }

    const shouldMarkResumable = this.activityLabelsMarkedPromise == null;
    const { wiring, scope, markedPromise } = createReasoningLabelHostWiring({
      config,
      seedFromContent,
      abortSignal,
      ...(shouldMarkResumable && {
        markResumable: () => GenerationJobManager.markActivityLabels(streamId, this.jobCreatedAt),
        onMarkFailure: () =>
          logger.warn(
            `[AgentClient] Could not flag reasoning labels for ${streamId}; an update resolving during a resume gap may not be reconciled.`,
          ),
      }),
      getContentParts: () => this.contentParts,
      getStepIndex: (stepId) => this.stepMap?.get(stepId)?.index,
      emitEvent: (event, data) =>
        GenerationJobManager.emitChunk(
          streamId,
          {
            event,
            data: {
              ...data,
              responseMessageId: this.responseMessageId,
              conversationId: this.conversationId,
            },
          },
          { durable: true, expectedCreatedAt: this.jobCreatedAt },
        ),
      trackPendingFill: (fillDone) => {
        this.pendingActivityLabelFills = this.pendingActivityLabelFills ?? [];
        this.pendingActivityLabelFills.push(fillDone);
      },
      generateLabel: (payload) => this.generateReasoningLabelViaRun(payload),
    });
    if (markedPromise != null) {
      this.activityLabelsMarkedPromise = markedPromise;
    }
    this.activityLabelScopes = this.activityLabelScopes ?? [];
    this.activityLabelScopes.push(scope);
    this.seedActivityLabelUsageSequence();
    this.reasoningLabelWiring = wiring;
    return wiring;
  }

  /**
   * `AgentClient` is not opinionated about vision requests, so we don't do anything here
   * @param {MongoFile[]} attachments
   */
  checkVisionRequest() {}

  getSaveOptions() {
    let runOptions = {};
    try {
      runOptions = payloadParser(this.options) ?? {};
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #getSaveOptions] Error parsing options',
        getSafeErrorMetadata(error),
      );
    }

    const agentsEConfig = this.options.req.config?.endpoints?.[EModelEndpoint.agents];
    const topLevelAgents = [this.options.agent, ...(this.agentConfigs?.values() ?? [])];
    const codeApprovalMode = resolveAttachedCodeApprovalMode(
      this.options.req.body.codeApprovalMode,
      collectAttachedCodeEnvironmentPolicySettings(topLevelAgents),
      agentsEConfig?.toolApproval?.enabled !== false,
    );
    const persistedCodeEnvironmentDecision = resolvePersistableCodeEnvironmentDecision({
      conversationId: this.options.req.body.conversationId,
      decision: this.options.req._codeEnvironmentDecision,
      conversation: this.options.req.resolvedConversation,
      requested: this.options.req.body,
    });

    return removeNullishValues(
      Object.assign(
        {
          spec: this.options.spec,
          iconURL: this.options.iconURL,
          chatProjectId: this.options.chatProjectId,
          endpoint: this.options.endpoint,
          agent_id: this.options.agent.id,
          modelLabel: this.options.modelLabel,
          resendFiles: this.options.resendFiles,
          imageDetail: this.options.imageDetail,
          maxContextTokens: this.maxContextTokens,
          codeApprovalMode,
          ...persistedCodeEnvironmentDecision,
        },
        // TODO: PARSE OPTIONS BY PROVIDER, MAY CONTAIN SENSITIVE DATA
        runOptions,
      ),
    );
  }

  /**
   * Returns build message options. For AgentClient, agent-specific instructions
   * are retrieved directly from agent objects in buildMessages, so this returns empty.
   * @returns {Object} Empty options object
   */
  getBuildMessagesOptions() {
    return {};
  }

  shouldDeferUserMessagePersistence() {
    return (
      (Array.isArray(this.modelBoundCurrentFiles) && this.modelBoundCurrentFiles.length > 0) ||
      hasModelBoundContentProtection(
        this.options.req?.config?.filters,
        this.options.req?.config?.messageFilter?.pii,
      )
    );
  }

  /** Attachments alone defer only the message, so a new conversation still gets its row when
   * the run starts, as it did before that deferral. A content policy holds back every write. */
  shouldSeedDeferredConversation() {
    return !hasModelBoundContentProtection(
      this.options.req?.config?.filters,
      this.options.req?.config?.messageFilter?.pii,
    );
  }

  /** Legacy `messageFilter.pii` historically covered the restored branch
   * before model-input construction and persistence. Retain that contract
   * without scanning new source-aware filters before SDK pruning. */
  assertStoredModelBoundContent() {
    const legacyPii = this.options.req?.config?.messageFilter?.pii;
    if (!hasModelBoundContentProtection(undefined, legacyPii)) {
      return;
    }
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      legacyPii,
      storedMessages: this.modelBoundStoredMessages,
    });
  }

  /** Agent pruning and summarization happen inside the SDK after
   * `buildMessages`, so BaseClient's post-build payload is not yet the final
   * model selection. The fail-closed callback below enforces the exact payload
   * at every chat-model call instead. */
  assertBuiltModelBoundContent() {}

  createModelBoundChatModelCallback() {
    const fileProjection = BaseClient.prototype.getModelBoundFileProjection.call(this);
    const persistence = BaseClient.prototype.getModelBoundUserMessagePersistence.call(this);
    return createModelBoundContentCallback(
      {
        onTraversalFailure: reportLocatorTraversalFailure,
        filters: this.options.req?.config?.filters,
        legacyPii: this.options.req?.config?.messageFilter?.pii,
        storedMessages: this.modelBoundStoredMessages,
        fileIdsBySourceMessageId: fileProjection.fileIdsBySourceMessageId,
        resolvedFiles: fileProjection.resolvedFiles,
        sourceFileProjectionOverflowed: fileProjection.overflowed,
      },
      {
        onContentRejected: persistence?.cancel,
      },
    );
  }

  createInitialModelBoundAdmissionCallback(startingAgentIds) {
    const persistence = BaseClient.prototype.getModelBoundUserMessagePersistence.call(this);
    if (persistence == null || !persistence.isPending() || startingAgentIds.length === 0) {
      return undefined;
    }
    return createInitialModelBoundAdmissionCallback({
      agentIds: startingAgentIds,
      isActive: persistence.isPending,
      onAllowed: persistence.start,
    });
  }

  /**
   *
   * @param {TMessage} message
   * @param {Array<MongoFile>} attachments
   * @returns {Promise<Array<Partial<MongoFile>>>}
   */
  async addImageURLs(message, attachments) {
    const { files, image_urls } = await encodeAndFormat(
      this.options.req,
      attachments,
      {
        provider: this.options.agent.provider,
        endpoint: this.options.endpoint,
        imageDetail: this.options.imageDetail,
      },
      VisionModes.agents,
    );
    message.image_urls = image_urls.length ? image_urls : undefined;
    return files;
  }

  getEventActorAgents() {
    return collectReachableAgents([this.options.agent, ...(this.agentConfigs?.values() ?? [])]);
  }

  /**
   * Resolves the committed Skill manifest and request-cached memory before the
   * actor chooses warm versus rebuilt continuation. No message history is read.
   *
   * @param {import('@librechat/data-schemas').IAgentEventActorState | null} state
   */
  async prepareEventActorContext(state) {
    if (state?.contextFingerprint == null) {
      return undefined;
    }
    if (isMemoryAgentEnabled(this.options.req.config?.memory)) {
      return undefined;
    }
    const storedManifest = Array.isArray(state.skillManifest) ? state.skillManifest : [];
    if (storedManifest.length > MAX_AGENT_CONTEXT_SKILLS) {
      return undefined;
    }
    let discoveredToolNames;
    let summary;
    let contextMeta;
    let compactionSemanticIndex;
    try {
      discoveredToolNames = normalizeAgentEventActorDiscoveredTools(state.discoveredToolNames);
      summary = normalizeAgentEventActorSummary(state.summary);
      contextMeta = normalizeEventActorContextMeta(state.contextMeta);
      compactionSemanticIndex = restoreCompactionSemanticIndexSnapshot(
        state.compactionSemanticIndex,
      );
    } catch {
      return undefined;
    }

    let skillPrimeResult = {};
    if (storedManifest.length > 0) {
      if (typeof this.options.primeInvokedSkills !== 'function') {
        return undefined;
      }
      skillPrimeResult = await this.options.primeInvokedSkills(
        [],
        storedManifest.map((skill) => skill.name),
      );
      const resolvedManifest = [...(skillPrimeResult?.skillManifest ?? [])].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      const expectedManifest = [...storedManifest].sort((left, right) =>
        left.id.localeCompare(right.id),
      );
      if (JSON.stringify(resolvedManifest) !== JSON.stringify(expectedManifest)) {
        return undefined;
      }
    }
    this.eventActorSkillPrimeResult = skillPrimeResult;
    this.eventActorDiscoveredToolNames = discoveredToolNames;
    this.eventActorSummary = summary;
    this.contextMeta = contextMeta;
    this.compactionSemanticIndexSnapshot = compactionSemanticIndex;
    const context = await this.getEventActorContext(storedManifest, discoveredToolNames);
    const skillBodies = new Map(skillPrimeResult?.skills ?? []);
    const rootAgentContext = this.eventActorAgentContextSources?.[0];
    for (const skill of [
      ...(rootAgentContext?.manualSkillPrimes ?? []),
      ...(rootAgentContext?.alwaysApplySkillPrimes ?? []),
    ]) {
      if (typeof skill.name === 'string' && typeof skill.body === 'string') {
        skillBodies.set(skill.name, skill.body);
      }
    }
    return {
      ...context,
      checkpointMessageOverlay: {
        source: 'skill',
        messages: buildAgentEventActorSkillMessages(skillBodies),
      },
    };
  }

  /**
   * @param {Array<{id: string, name: string, version: number}>} [baseManifest]
   */
  async getEventActorContext(baseManifest = [], baseDiscoveredToolNames) {
    const manifest = new Map(baseManifest.map((skill) => [skill.id, skill]));
    for (const skill of this.eventActorAgentContextSources?.[0]?.manualSkillPrimes ?? []) {
      if (!Number.isInteger(skill.version) || skill.version < 1 || typeof skill.body !== 'string') {
        throw new Error('Manual Skill is missing semantic identity');
      }
      manifest.set(skill._id.toString(), {
        id: skill._id.toString(),
        name: skill.name,
        version: skill.version,
        contentDigest: createSkillContentDigest(skill.body),
      });
    }
    for (const skill of this.eventActorSkillPrimeResult?.skillManifest ?? []) {
      manifest.set(skill.id, skill);
    }
    for (const skill of this.options.invokedSkillIdentities?.values?.() ?? []) {
      manifest.set(skill.id, skill);
    }
    if (manifest.size > MAX_AGENT_CONTEXT_SKILLS) {
      throw new RangeError(`Event actor exceeds ${MAX_AGENT_CONTEXT_SKILLS} durable Skills`);
    }
    const skillManifest = [...manifest.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    const agents = this.getEventActorAgents();
    const memory = await this.getEventActorMemorySnapshots(agents);
    const agentsConfig = this.options.req.config?.endpoints?.[EModelEndpoint.agents];
    const discoveredToolNames = normalizeAgentEventActorDiscoveredTools([
      ...(baseDiscoveredToolNames ??
        (this.eventActorContinuation === 'warm' ? (this.eventActorDiscoveredToolNames ?? []) : [])),
      ...(this.run == null ? [] : getRunDiscoveredTools(this.run)),
    ]);
    /** Stamped where state is assembled, not where each source is read: a
     *  summary inherited from the formatter arrives in the SDK's
     *  `{ text, tokenCount }` shape, and persisting it unstamped would have the
     *  next event refuse its own state and reload the whole history. */
    const summary = createAgentEventActorSummary(
      getLatestEventActorSummary(this.contentParts) ?? this.eventActorSummary,
    );
    this.eventActorSummary = summary;
    const compactionSemanticIndex = createCompactionSemanticIndexProjection(
      this.compactionSemanticIndexSnapshot,
    );
    return {
      fingerprint: createInitializedAgentContextFingerprint({
        agents: this.eventActorAgentContextSources ?? agents,
        invokedSkills: skillManifest,
        approvalPolicy: agentsConfig?.toolApproval,
        retainedAnswers: resolveRetainedAnswersConfig(agentsConfig?.askUserQuestion),
        memory,
        discoveredToolNames,
        checkpointerType: agentsConfig?.checkpointer?.type,
      }),
      skillManifest,
      discoveredToolNames,
      ...(summary == null ? {} : { summary }),
      ...(this.contextMeta == null ? {} : { contextMeta: this.contextMeta }),
      ...(compactionSemanticIndex == null ? {} : { compactionSemanticIndex }),
    };
  }

  /**
   * Seeds context meta captured at a pause (or from a parent response) into a
   * rebuilt client. Malformed values are dropped rather than trusted.
   * @param {unknown} contextMeta
   */
  /**
   * Publishes the run's compact context state onto the job: the inherited seed
   * before the run starts, then the live state after each pre-invoke context
   * snapshot. A Stop or disconnect persists the response from job data alone, on
   * whichever replica handles it, so callers await the publish ahead of the
   * model call it describes. Ordering, deduplication, retries and failure
   * handling live in the `packages/api` publisher; this is only the wiring.
   * @param {{ live?: boolean }} [options] `live` marks a snapshot from the running
   *   graph; the pre-run call publishes the inherited seed instead.
   * @returns {Promise<void>}
   */
  publishRunContextMeta({ live = false } = {}) {
    const streamId = this.options?.req?._resumableStreamId;
    if (!streamId) {
      return Promise.resolve();
    }
    this.contextMetaPublisher ??= createContextMetaPublisher({
      write: (contextMeta) =>
        GenerationJobManager.updateMetadata(streamId, { contextMeta }, this.jobCreatedAt),
      onFailure: (err) =>
        logger.warn(
          `[AgentClient] Failed to publish context meta for ${streamId}`,
          getSafeErrorMetadata(err),
        ),
    });
    const contextMeta = selectRunContextMetaToPublish({
      live,
      captured: captureRunContextMeta(this),
      inherited: this.contextMeta,
      hasPublished: this.contextMetaPublisher.hasPublished,
      getEncoding: () => this.getEncoding(),
    });
    return contextMeta == null ? Promise.resolve() : this.contextMetaPublisher.publish(contextMeta);
  }

  seedContextMeta(contextMeta) {
    try {
      this.contextMeta = normalizeEventActorContextMeta(contextMeta);
    } catch (err) {
      logger.warn('[AgentClient] Ignoring malformed context meta', getSafeErrorMetadata(err));
      this.contextMeta = undefined;
    }
    void this.publishRunContextMeta?.();
  }

  /** Every row `loadHistory` read this turn, held only until the retained
   *  answers are built: the walk it returns stops at a checkpoint summary. */
  onHistoryLoaded(rows) {
    this.loadedHistoryRows = rows;
  }

  async loadHistory(conversationId, parentMessageId = null) {
    if (this.eventActorContinuation === 'warm') {
      logger.debug('[AgentClient] Skipping durable history for compatible event actor', {
        conversationId,
      });
      return [];
    }
    return super.loadHistory(conversationId, parentMessageId);
  }

  async buildMessages(messages, parentMessageId, _buildOptions, opts) {
    if (this.eventActorContinuation === 'cold') {
      /** Compatibility was rejected after warm state preparation. Rebuild all
       * non-checkpointed state from durable history, never from that stale head. */
      this.eventActorSummary = undefined;
      this.contextMeta = undefined;
      this.compactionSemanticIndexSnapshot = undefined;
    }
    /** Always pass mapMethod; getMessagesForConversation applies it only to messages with addedConvo flag */
    const orderedMessages = this.constructor.getMessagesForConversation({
      messages,
      parentMessageId,
      summary: this.shouldSummarize,
      mapMethod: createMultiAgentMapper(this.options.agent, this.agentConfigs),
      mapCondition: (message) => message.addedConvo === true,
    });
    /**
     * Answers the user gave to earlier `ask_user_question` calls. Read from the
     * rows before `messages` is narrowed to `orderedMessages`; when those rows
     * stop short of the branch root (the history read stopped at a checkpoint
     * summary, or a warm event-actor turn holds only its new event message) the
     * module completes the branch from the rows that read already fetched, or
     * through the stored-row query when there was no read. Rendered here,
     * applied after SDK summary slicing in chatCompletion.
     */
    const retainedAnswersPromise = prepareRetainedAnswers({
      messages,
      parentMessageId,
      storedRows: this.loadedHistoryRows,
      getMessages: db.getMessages,
      conversationId: this.conversationId,
      userId: this.user ?? this.options.req.user?.id,
      config: this.options.req.config?.endpoints?.[EModelEndpoint.agents]?.askUserQuestion,
      encoding: this.getEncoding(),
    });
    this.loadedHistoryRows = undefined;

    let payload;
    /** @type {number | undefined} */
    let promptTokens;
    const modelBoundMemoryContexts = new Set();
    const modelBoundFileContexts = new Set();

    /** Normalize instruction fields before applying per-run context. */
    const normalizeInstructions = (agent) => {
      agent.instructions = agent.instructions?.trim() || undefined;
      agent.additional_instructions = agent.additional_instructions?.trim() || undefined;
      return agent;
    };

    /** Collect all runtime agents without promoting isolated subagents into the top-level graph. */
    const agentsById = new Map();
    const pendingAgents = [this.options.agent, ...(this.agentConfigs?.values() ?? [])];
    for (let i = 0; i < pendingAgents.length; i++) {
      const agent = pendingAgents[i];
      if (!agent?.id || agentsById.has(agent.id)) {
        continue;
      }
      agentsById.set(agent.id, normalizeInstructions(agent));
      for (const subagent of agent.subagentAgentConfigs?.values() ?? []) {
        pendingAgents.push(subagent);
      }
      for (const graph of agent.subagentGraphConfigs ?? []) {
        pendingAgents.push(...graph.memberConfigs);
      }
    }
    const allAgents = [...agentsById].map(([agentId, agent]) => ({ agent, agentId }));
    const endpointsByAgentId = new Map(
      allAgents.map(({ agent, agentId }) => [
        agentId,
        {
          endpoint: agent.endpoint,
          endpointType: agent === this.options.agent ? this.options.endpointType : undefined,
        },
      ]),
    );
    const dynamicToolContexts = getDynamicToolContexts(allAgents.map(({ agent }) => agent));
    for (const context of dynamicToolContexts) {
      modelBoundFileContexts.add(context);
    }
    for (const { agent } of allAgents) {
      for (const attachment of [
        ...(agent.attachments ?? []),
        ...(agent.requestAttachments ?? []),
        ...(agent.agentContextAttachments ?? []),
      ]) {
        if (attachment) {
          modelBoundFileContexts.add(attachment);
        }
      }
    }
    /**
     * Memory authorization/loading and MCP config resolution do not depend on
     * attachment hydration or prompt formatting. Start them before that work,
     * but keep the existing context-application barrier below.
     *
     * Attach a rejection observer immediately because these operations may
     * settle while request attachments are still being prepared. Awaiting the
     * original promise later still propagates either error.
     */
    const earlySharedContextPromise = Promise.all([
      this.getSharedMemoryContext(),
      resolveConfigServers(this.options.req),
    ]);
    void earlySharedContextPromise.catch(() => {});
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters: this.options.req.config?.filters,
      legacyPii: this.options.req.config?.messageFilter?.pii,
      agents: allAgents.map(({ agent }) => agent),
      files: [...modelBoundFileContexts],
    });
    const requestAttachmentsSource = this.options.attachments;
    const requestAttachments = requestAttachmentsSource ? await requestAttachmentsSource : [];
    const modelBoundRequestAttachments =
      this.getModelBoundAttachmentsForEndpoint(requestAttachments);
    const retainedHistoricalFileContexts =
      this.options.resendFiles === false
        ? orderedMessages
            .filter((message) => typeof message?.fileContext === 'string' && message.fileContext)
            .map((message, index) => ({
              file_id: `retained-file-context:${message.messageId ?? message.id ?? index}`,
              source: FileSources.text,
              type: 'text/plain',
              text: message.fileContext,
              bytes: Buffer.byteLength(message.fileContext, 'utf8'),
            }))
        : [];
    const sharedAttachmentFiles = [
      ...Object.values(this.message_file_map ?? {}).flat(),
      ...(this.modelBoundHistoricalSteerFiles ?? []),
      ...modelBoundRequestAttachments,
    ];
    const sharedRunAttachmentIds = collectFileIds(sharedAttachmentFiles);
    this.options.agentContextAttachmentsByAgentId = resolveScopedTurnAttachments({
      agents: allAgents,
      sharedConversationAgentIds: [this.options.agent.id, ...(this.agentConfigs?.keys() ?? [])],
      resendFiles: this.options.resendFiles,
      messages: orderedMessages,
      historicalFiles: this.authorizedHistoricalFiles,
      requestAttachments,
      sharedRunAttachmentIds,
      attachmentsByAgentId: this.options.agentContextAttachmentsByAgentId,
    });
    const scopedAttachmentMap = buildAgentScopedAttachmentMap({
      agentIds: allAgents.map(({ agentId }) => agentId),
      attachmentsByAgentId: this.options.agentContextAttachmentsByAgentId,
      sharedRunAttachmentIds,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
      endpointType: this.options.endpointType,
      endpointsByAgentId,
    });
    this.turnSharedAttachmentFiles = sharedAttachmentFiles;
    this.turnAggregateOnlyAttachmentFiles = retainedHistoricalFileContexts;
    this.turnScopedAttachmentsByAgentId = scopedAttachmentMap;
    this.turnAttachmentEndpointsByAgentId = endpointsByAgentId;
    assertAgentAttachmentTopology({
      sharedAttachments: sharedAttachmentFiles,
      scopedAttachmentsByAgentId: scopedAttachmentMap,
      req: this.options.req,
      endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
      endpointType: this.options.endpointType,
      endpointsByAgentId,
    });
    const attachmentContextInjections = [...scopedAttachmentMap.values()].flat();
    this.assertTurnAttachmentLimits(
      [...sharedAttachmentFiles, ...retainedHistoricalFileContexts],
      attachmentContextInjections,
    );
    /** @type {ReturnType<typeof buildAgentScopedContext>} */
    let agentScopedContextPromise;
    const startAgentScopedContext = () => {
      const contextPromise = buildAgentScopedContext({
        agentIds: allAgents.map(({ agentId }) => agentId),
        attachmentsByAgentId: this.options.agentContextAttachmentsByAgentId,
        sharedRunAttachmentIds,
        sharedAttachments: sharedAttachmentFiles,
        req: this.options.req,
        endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
        endpointType: this.options.endpointType,
        endpointsByAgentId,
        tokenCountFn: (text) => countTokens(text),
      });
      void contextPromise.catch(() => {});
      return contextPromise;
    };

    if (requestAttachmentsSource) {
      const attachments = this.getProcessableAttachmentsForEndpoint(
        requestAttachments,
        modelBoundRequestAttachments,
      );
      const latestMessage = orderedMessages[orderedMessages.length - 1];
      this.modelBoundCurrentFiles = [...modelBoundRequestAttachments];

      assertModelBoundContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters: this.options.req.config?.filters,
        files: modelBoundRequestAttachments,
      });
      for (const attachment of modelBoundRequestAttachments) {
        if (attachment) {
          modelBoundFileContexts.add(attachment);
        }
      }
      /** Agent-scoped extraction only depends on the shared attachment IDs. */
      agentScopedContextPromise = startAgentScopedContext();

      if (this.message_file_map) {
        this.message_file_map[latestMessage.messageId] = attachments;
      } else {
        this.message_file_map = {
          [latestMessage.messageId]: attachments,
        };
      }

      const [, files] = await Promise.all([
        this.addFileContextToMessage(latestMessage, modelBoundRequestAttachments),
        this.processAttachments(latestMessage, attachments),
      ]);

      this.options.attachments = files;
    } else {
      agentScopedContextPromise = startAgentScopedContext();
    }

    const attachmentTelemetryFiles = [
      ...sharedAttachmentFiles,
      ...retainedHistoricalFileContexts,
      ...attachmentContextInjections,
    ];
    this.attachmentMemoryContext = {
      req: this.options.req,
      conversationId: this.conversationId,
      messageId: orderedMessages[orderedMessages.length - 1]?.messageId,
      attachments: attachmentTelemetryFiles,
      countRepeatedExtractedText: true,
    };
    logAgentMemorySnapshot('before_context_assembly', this.attachmentMemoryContext);

    /** Note: Bedrock uses legacy RAG API handling */
    if (this.message_file_map && !isAgentsEndpoint(this.options.endpoint)) {
      this.contextHandlers = createContextHandlers(
        this.options.req,
        orderedMessages[orderedMessages.length - 1].text,
      );
    }

    /** @type {Record<number, number>} */
    const indexTokenCountMap = {};
    /** @type {Record<string, number>} */
    const tokenCountMap = {};
    const memoryPayload = [];
    let hasFileContext = false;
    let promptTokenTotal = 0;
    const encoding = this.getEncoding();
    /**
     * Rebuilds the memory-side copy of one source row: the same formatting and
     * per-message merges as the prompt copy, minus the fileContext prepend.
     * Only materialized when something actually consumes it — the canonical
     * recount of a fileContext row, or the memory payload once any row proves
     * to carry fileContext — instead of unconditionally formatting every row
     * twice per turn.
     */
    const buildMemoryFormattedMessage = (message) => {
      const memoryFormattedMessage = formatMessage({
        message,
        userName: this.options?.name,
        assistantName: this.options?.modelLabel,
      });
      const sourceMessageId = message.messageId ?? message.id;
      if (typeof sourceMessageId === 'string' && sourceMessageId.length > 0) {
        memoryFormattedMessage.messageId = sourceMessageId;
      }
      if (Array.isArray(message.quotes) && message.quotes.length > 0) {
        prependQuotes(memoryFormattedMessage, message.quotes);
      }
      const turnFiles = this.message_file_map?.[message.messageId] ?? message.files;
      applyAttachmentOnlyText(memoryFormattedMessage, turnFiles);
      return memoryFormattedMessage;
    };
    /** Memory copies built for canonical recounts, reused by the memory payload pass. */
    const memoryFormattedMessages = [];

    const formattedMessages = orderedMessages.map((message, i) => {
      const formattedMessage = formatMessage({
        message,
        userName: this.options?.name,
        assistantName: this.options?.modelLabel,
      });
      const sourceMessageId = message.messageId ?? message.id;
      if (typeof sourceMessageId === 'string' && sourceMessageId.length > 0) {
        formattedMessage.messageId = sourceMessageId;
      }

      /**
       * Bind file context to the message it belongs to. Historical attachments
       * are resent inline, so the current turn's text attachment must be inline
       * too instead of living only in the dynamic system tail.
       */
      if (message.fileContext) {
        /** Historical file context is deliberately not added to the run-wide
         * preflight set. The provider callback selects its owner-resolved file
         * only when this source row survives SDK pruning. Current-turn files
         * were already added and inspected from `this.options.attachments`. */
        hasFileContext = true;
        prependFileContext(formattedMessage, message.fileContext);
      }

      /**
       * Durably re-merge quoted excerpts into every user turn that carries them
       * (current and historical) so the model receives the referenced context on
       * every prompt and the token count matches what was persisted. Applied to
       * the memory copy too so the canonical per-message count includes them.
       */
      if (Array.isArray(message.quotes) && message.quotes.length > 0) {
        prependQuotes(formattedMessage, message.quotes);
      }

      /**
       * An attachment-only turn whose files reach the model out-of-band (file
       * search, code environment) leaves nothing in the content itself, and
       * providers such as Anthropic reject an empty user message outright.
       * Applied after the context and quote merges so a turn that already
       * gained inline content keeps it. The current turn is not carrying
       * `files` yet (BaseClient assigns them after this returns), so the
       * resolved attachments come from `message_file_map`.
       */
      const turnFiles = this.message_file_map?.[message.messageId] ?? message.files;
      applyAttachmentOnlyText(formattedMessage, turnFiles);

      /**
       * A summarize round that errored or was cut off never reaches the model:
       * the formatter would take its partial text as the history boundary and
       * drop everything older. Dropped from the prompt copy here, ahead of the
       * counts, so the per-index count, the prompt total admission checks, and
       * the steer-media adjustments below all describe what is actually sent.
       * The stored message keeps the part — the renderer labels it — so a
       * canonical recount reads an unstripped surface instead.
       */
      const droppedPromptSummary = dropUnusableSummaryParts(formattedMessage);

      const dbTokenCount = Number(orderedMessages[i].tokenCount);
      const hasDbTokenCount = Number.isFinite(dbTokenCount) && dbTokenCount > 0;
      /**
       * Force a recount when the message carries quotes: a plain text-only
       * "Save" edit recomputes `tokenCount` from `text` alone while leaving
       * `message.quotes` persisted, so the stored count would undercount the
       * quote block this turn prepends. Recounting from the quote-merged memory
       * copy keeps context accounting accurate (and self-heals stale counts).
       */
      const needsCanonicalTokenCount =
        !hasDbTokenCount ||
        (this.isVisionModel && (message.image_urls || message.files)) ||
        (Array.isArray(message.quotes) && message.quotes.length > 0);

      let canonicalTokenCount = hasDbTokenCount ? dbTokenCount : 0;
      if (needsCanonicalTokenCount) {
        /** Without fileContext the memory copy is content-identical to the
         *  prompt copy, so the prompt copy is the counting surface; with it (or
         *  with a dropped summary), the canonical count must be taken from the
         *  message as stored. */
        let countSurface = formattedMessage;
        if (message.fileContext || droppedPromptSummary) {
          memoryFormattedMessages[i] = buildMemoryFormattedMessage(message);
          countSurface = memoryFormattedMessages[i];
        }
        canonicalTokenCount = countFormattedMessageTokens(countSurface, encoding);
      }

      const promptMessageTokenCount =
        message.fileContext || droppedPromptSummary
          ? countFormattedMessageTokens(formattedMessage, encoding)
          : canonicalTokenCount;

      /* If message has files, calculate image token cost */
      if (this.message_file_map && this.message_file_map[message.messageId]) {
        const attachments = this.message_file_map[message.messageId];
        for (const file of attachments) {
          /** See the source-selected historical-file enforcement above. */
          if (file.embedded) {
            this.contextHandlers?.processFile(file);
            continue;
          }
          if (file.metadata?.codeEnvRef || file.metadata?.codeEnvRefs) {
            continue;
          }
        }
      }

      const normalizedCanonicalTokenCount =
        Number.isFinite(canonicalTokenCount) && canonicalTokenCount > 0 ? canonicalTokenCount : 0;
      const normalizedPromptTokenCount =
        Number.isFinite(promptMessageTokenCount) && promptMessageTokenCount > 0
          ? promptMessageTokenCount
          : 0;

      orderedMessages[i].tokenCount = normalizedCanonicalTokenCount;
      indexTokenCountMap[i] = normalizedPromptTokenCount;
      promptTokenTotal += normalizedPromptTokenCount;

      if (message.messageId) {
        tokenCountMap[message.messageId] = normalizedCanonicalTokenCount;
      }

      if (isEnabled(process.env.AGENT_DEBUG_LOGGING)) {
        const role = message.isCreatedByUser ? 'user' : 'assistant';
        const hasSummary =
          Array.isArray(message.content) && message.content.some((p) => p && p.type === 'summary');
        const suffix = hasSummary ? '[S]' : '';
        const id = (message.messageId ?? message.id ?? '').slice(-8);
        const recalced = needsCanonicalTokenCount ? normalizedCanonicalTokenCount : null;
        const promptRecalced = message.fileContext ? normalizedPromptTokenCount : null;
        logger.debug(
          `[AgentClient] msg[${i}] ${role}${suffix} id=…${id} db=${dbTokenCount} needsRecount=${needsCanonicalTokenCount} recalced=${recalced} promptRecalced=${promptRecalced} tokens=${normalizedPromptTokenCount}`,
        );
      }

      return formattedMessage;
    });

    /**
     * Native YouTube -> video understanding: when Google `url_context` is enabled
     * (resolved to the native `urlContext` provider tool), inject any YouTube URLs
     * from the latest user turn as Gemini `fileData` video parts. The URL Context
     * tool cannot read YouTube, so this routes those links through the video path
     * while other URLs still flow through `urlContext`. Done after token counting
     * (video tokens are reported by the provider) and only on the LLM payload, so
     * the memory copy and persisted message are untouched.
     */
    const latestOrdered = orderedMessages[orderedMessages.length - 1];
    const provider = this.options.agent?.provider;
    if (
      latestOrdered?.isCreatedByUser === true &&
      (provider === Providers.GOOGLE || provider === Providers.VERTEXAI) &&
      hasUrlContextTool(this.options.agent?.tools)
    ) {
      const latestFormatted = formattedMessages[formattedMessages.length - 1];
      /** Use the resolved run model (model_parameters override) rather than the saved base model. */
      const resolvedModel =
        this.options.agent?.model_parameters?.model ?? this.options.agent?.model;
      const { max, mimeType } = resolveYouTubeInjectionConfig({
        provider,
        model: resolvedModel,
      });
      latestFormatted.content = appendYouTubeVideoParts({
        enabled: true,
        text: latestOrdered.text,
        content: latestFormatted.content,
        max,
        mimeType,
      });
      /** The provider-native `fileData.fileUri` parts are injected after the
       * earlier canonical-message preflight. Reinspect the exact transformed
       * user payload so strict file policy cannot be skipped by a late media
       * adapter. */
      assertModelBoundContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters: this.options.req.config?.filters,
        legacyPii: this.options.req.config?.messageFilter?.pii,
        submittedMessages: [{ role: 'user', content: latestFormatted.content }],
      });
      /** Google rejects an unusable video with a generic `INVALID_ARGUMENT` that names no cause,
       *  so `#sendCompletion` can only attribute one by knowing this turn carried a video. */
      this.injectedYouTubeVideo = hasYouTubeVideoParts(latestFormatted.content);
    }

    payload = formattedMessages;
    this.modelBoundSteerFileIdsBySourceMessageId = new Map();
    /** Persisted steer parts of past turns replay with their attachments and
     *  quotes: one batched owner-scoped fetch, re-encoded per turn and
     *  stamped as a transient `media` array (same resend semantics as
     *  message files). Runs regardless of `resendFiles` because quote-bearing
     *  parts must re-merge their excerpts every turn (mirroring
     *  `prependQuotes` above); file encoding stays gated on the setting via
     *  the flag. The stamp lands after the loop above finalized its counts,
     *  so the re-encoded media (minus the text part the steer part already
     *  counted) is folded into the budget here — large steered attachments
     *  and quote blocks must shrink the window like any other resent media.
     *  The synchronous collection keeps steer-free histories on the
     *  zero-await path to the parallel context kickoff below, and the
     *  collected targets feed the stamp directly so the history is scanned
     *  once. */
    const resendSteerFiles = this.options.resendFiles === true;
    const steerStampTargets = collectSteerStampTargets(payload, resendSteerFiles);
    if (steerStampTargets.length > 0) {
      const stamped = await stampSteerPartMedia({
        client: this,
        user: this.options.req?.user,
        payload,
        targets: steerStampTargets,
        // addPreviousAttachments already fetched steer-part refs in its single
        // per-turn historical-files query — no second round trip.
        docsById: this.authorizedHistoricalReplayFiles ?? this.authorizedHistoricalFiles,
        getFiles: db.getFiles,
        resendFiles: resendSteerFiles,
      });
      for (const { sourceMessageId, fileIds } of stamped) {
        if (typeof sourceMessageId !== 'string' || sourceMessageId.length === 0) {
          continue;
        }
        const boundFileIds =
          this.modelBoundSteerFileIdsBySourceMessageId.get(sourceMessageId) ?? new Set();
        for (const fileId of fileIds ?? []) {
          if (typeof fileId === 'string' && fileId.length > 0) {
            boundFileIds.add(fileId);
          }
        }
        if (boundFileIds.size > 0) {
          this.modelBoundSteerFileIdsBySourceMessageId.set(sourceMessageId, boundFileIds);
        }
      }
      for (const { index, media, steerText } of stamped) {
        /** Count the FULL stamped content and subtract only the steer body
         *  (already counted inside the assistant message): extracted file
         *  context and merged quote blocks prepended into the text part must
         *  hit the budget too, or large steered documents bypass pruning. */
        const fullTokens = countFormattedMessageTokens({ role: 'user', content: media }, encoding);
        const bodyTokens = steerText
          ? countFormattedMessageTokens(
              { role: 'user', content: [{ type: ContentTypes.TEXT, text: steerText }] },
              encoding,
            )
          : 0;
        const mediaTokens = Math.max(0, (fullTokens ?? 0) - (bodyTokens ?? 0));
        if (Number.isFinite(mediaTokens) && mediaTokens > 0) {
          indexTokenCountMap[index] = (indexTokenCountMap[index] ?? 0) + mediaTokens;
          promptTokenTotal += mediaTokens;
        }
      }
    }
    if (hasFileContext) {
      for (let i = 0; i < orderedMessages.length; i++) {
        memoryPayload.push(
          memoryFormattedMessages[i] ?? buildMemoryFormattedMessage(orderedMessages[i]),
        );
      }
      /** The memory copy feeds `processMemory` through the same
       *  `formatAgentMessages` replay, which reads `part.media`/`part.steer`
       *  and ignores `part.quotes` — so a steer whose substance lives in its
       *  quote must be quote-merged here too or memory extraction never sees
       *  it. Quote merge only (`resendFiles: false`): file media is exactly
       *  what the memory copy exists to exclude, and text-only stamps touch
       *  no file fetch or encode. Runs after the fill above so late-built
       *  copies are stamped too. */
      const memorySteerTargets = collectSteerStampTargets(memoryPayload, false);
      if (memorySteerTargets.length > 0) {
        await stampSteerPartMedia({
          client: this,
          user: this.options.req?.user,
          payload: memoryPayload,
          targets: memorySteerTargets,
          getFiles: db.getFiles,
          resendFiles: false,
        });
      }
    }
    this.memoryPayload = hasFileContext ? memoryPayload : null;
    messages = orderedMessages;
    promptTokens = promptTokenTotal;

    /**
     * Build shared run context - applies to ALL agents in the run.
     * Request attachment file context is already bound inline to the latest
     * user message above; only side-channel context belongs here.
     * Memory context is handled separately and applied per-agent based on config.
     */
    const sharedRunContextParts = [];
    const [augmentedPrompt, [memories, configServers], agentScopedContext] = await Promise.all([
      this.contextHandlers?.createContext(),
      earlySharedContextPromise,
      agentScopedContextPromise,
    ]);

    this.retainedAnswers = await retainedAnswersPromise;
    promptTokens += this.retainedAnswers.tokenCount;

    /** Augmented prompt from RAG/context handlers */
    this.augmentedPrompt = augmentedPrompt;
    if (this.augmentedPrompt) {
      modelBoundFileContexts.add(this.augmentedPrompt);
      sharedRunContextParts.push(this.augmentedPrompt);
    }

    /** Memory context (user preferences/memories). Keyed context (with memory
     *  keys + token metadata) is reserved for agents that can call
     *  `delete_memory`; everyone else gets the unkeyed values only. */
    /** Partition the loaded memories belong to (the primary agent's). */
    const loadedMemoryAgentId = getMemoryAgentId(this.options.agent);
    /** Resolves formatted memories for an agent's own partition. A defined
     *  `memories` means the run-level gates (permission, opt-out, config)
     *  passed; agents on other partitions fetch through the request-scoped
     *  cache so repeated partitions share one query. */
    const getAgentPartitionMemories = async (agent) => {
      if (!memories) {
        return undefined;
      }
      const agentPartition = getMemoryAgentId(agent);
      if (agentPartition === loadedMemoryAgentId) {
        return memories;
      }
      try {
        return await getRequestMemories({
          req: this.options.req,
          userId: this.options.req.user.id + '',
          agentId: agentPartition,
          getFormattedMemories: db.getFormattedMemories,
        });
      } catch (error) {
        logger.error('[AgentClient] Error loading partition memories', getSafeErrorMetadata(error));
        return undefined;
      }
    };
    const canonicalMemoryCache = new Map();
    const getCanonicalAgentMemories = async (agent) => {
      if (!hasActivePiiPatterns(this.options.req.config?.filters?.memories?.pii)) {
        return undefined;
      }
      if (typeof db.getUserMemories !== 'function') {
        throw new Error('Canonical memory inspection is unavailable');
      }
      const agentId = getMemoryAgentId(agent);
      const cacheKey = agentId ?? '__shared__';
      if (!canonicalMemoryCache.has(cacheKey)) {
        canonicalMemoryCache.set(
          cacheKey,
          db.getUserMemories({
            userId: this.options.req.user.id + '',
            agentId,
          }),
        );
      }
      return canonicalMemoryCache.get(cacheKey);
    };

    const sharedRunContext = sharedRunContextParts.join('\n\n');
    const memoryAgentEnabled = isMemoryAgentEnabled(this.options.req.config?.memory);

    const configuredContextAttachments = this.options.agentContextAttachmentsByAgentId;
    const contextAttachments =
      configuredContextAttachments instanceof Map
        ? new Map(configuredContextAttachments)
        : new Map(Object.entries(configuredContextAttachments ?? {}));
    for (const { agent, agentId } of allAgents) {
      if (
        !contextAttachments.has(agentId) &&
        Array.isArray(agent.agentContextAttachments) &&
        agent.agentContextAttachments.length > 0
      ) {
        contextAttachments.set(agentId, agent.agentContextAttachments);
      }
    }
    const attachmentLists =
      contextAttachments instanceof Map ? [...contextAttachments.values()] : [];
    for (const attachments of attachmentLists) {
      for (const attachment of attachments ?? []) {
        if (attachment) {
          modelBoundFileContexts.add(attachment);
        }
      }
    }
    /** Preserve prompt token counts for graph formatting and pruning. */
    this.indexTokenCountMap = indexTokenCountMap;

    /** Extract contextMeta from the parent response (second-to-last in ordered chain;
     *  last is the current user message). Seeds the pruner's calibration EMA for this run. */
    const parentResponse =
      orderedMessages.length >= 2 ? orderedMessages[orderedMessages.length - 2] : undefined;
    /** Only a server-authored response may seed the run: a client-submitted
     * row carries no trusted calibration or fading state. */
    if (
      parentResponse?.contextMeta &&
      !parentResponse.isCreatedByUser &&
      parentResponse.isUserSubmitted !== true
    ) {
      this.contextMeta = parentResponse.contextMeta;
      /** Start the seed publish as soon as the parent's state is known: a Stop
       * during the rest of setup must already find it on the job. */
      void this.publishRunContextMeta?.();
    }

    const result = {
      prompt: payload,
      tokenCountMap,
      promptTokens,
      messages,
    };

    if (promptTokens >= 0 && typeof opts?.getReqData === 'function') {
      opts.getReqData({ promptTokens });
    }

    /**
     * Apply context to all agents.
     * Stable agent/MCP instructions stay on `instructions`; shared runtime context
     * is appended to `additional_instructions` as the dynamic system tail.
     *
     * NOTE: This intentionally mutates agent objects in place. The agentConfigs Map
     * holds references to config objects that will be passed to the graph runtime.
     */
    const ephemeralAgent = this.options.req.body.ephemeralAgent;
    const mcpManager = getMCPManager();

    const prepareRuntimeAgent = async (
      { agent, agentId },
      scopedContext,
      assertLateBoundContent = false,
    ) => {
      normalizeInstructions(agent);
      const agentRunContextParts = [sharedRunContext];
      const agentMemoryContexts = [];
      const agentHasMemory = agentHasInlineMemoryTools(agent);
      if (agentId === this.options.agent.id || memoryAgentEnabled || agentHasMemory) {
        const partitionMemories = await getAgentPartitionMemories(agent);
        const canonicalMemories =
          partitionMemories != null ? await getCanonicalAgentMemories(agent) : undefined;
        if (canonicalMemories != null) {
          for (const memory of canonicalMemories) {
            modelBoundMemoryContexts.add(memory);
            agentMemoryContexts.push(memory);
          }
        }
        if (partitionMemories?.withoutKeys) {
          /** Inspect the exact formatted value text that will be model-bound as
           *  well as canonical rows. This also covers custom embedders, read
           *  failures, and an unexpectedly empty canonical result. */
          modelBoundMemoryContexts.add(partitionMemories.withoutKeys);
          agentMemoryContexts.push(partitionMemories.withoutKeys);
        }
        const agentMemoryContext = formatMemoryContext(
          agentHasMemory ? partitionMemories?.withKeys : partitionMemories?.withoutKeys,
        );
        if (agentMemoryContext) {
          agentRunContextParts.push(agentMemoryContext);
        }
      }
      if (scopedContext) {
        modelBoundFileContexts.add(scopedContext);
        agentRunContextParts.push(scopedContext);
      }

      await applyContextToAgent({
        agent,
        agentId,
        logger,
        mcpManager,
        configServers,
        sharedRunContext: agentRunContextParts.filter(Boolean).join('\n\n'),
        ephemeralAgent: agentId === this.options.agent.id ? ephemeralAgent : undefined,
      });
      if (assertLateBoundContent) {
        assertModelBoundContent({
          onTraversalFailure: reportLocatorTraversalFailure,
          filters: this.options.req.config?.filters,
          legacyPii: this.options.req.config?.messageFilter?.pii,
          agents: [agent],
          memories: agentMemoryContexts,
          files: scopedContext ? [scopedContext] : [],
        });
      }
      return agent;
    };

    const runtimeAgentPreparations = new WeakMap();
    const prepareRuntimeAgentOnce = (agent, scopedContext) => {
      const existing = runtimeAgentPreparations.get(agent);
      if (existing) {
        return existing;
      }
      const pending = prepareRuntimeAgent({ agent, agentId: agent.id }, scopedContext);
      runtimeAgentPreparations.set(agent, pending);
      return pending;
    };
    await Promise.all(
      allAgents.map(({ agent, agentId }) =>
        prepareRuntimeAgentOnce(agent, agentScopedContext.get(agentId)),
      ),
    );
    this.modelBoundMemoryContexts = [...modelBoundMemoryContexts];
    this.modelBoundFileContexts = [...modelBoundFileContexts];
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters: this.options.req.config?.filters,
      legacyPii: this.options.req.config?.messageFilter?.pii,
      agents: allAgents.map(({ agent }) => agent),
      memories: this.modelBoundMemoryContexts,
      files: this.modelBoundFileContexts,
    });

    const wrappedLazyDescriptors = new WeakSet();
    const wrapLazyResolvers = (configs) => {
      const pending = [...configs];
      const visitedConfigs = new WeakSet();
      for (let index = 0; index < pending.length; index++) {
        const config = pending[index];
        if (!config || visitedConfigs.has(config)) {
          continue;
        }
        visitedConfigs.add(config);
        pending.push(...(config.subagentAgentConfigs ?? []));
        for (const graph of config.subagentGraphConfigs ?? []) {
          pending.push(...graph.memberConfigs);
        }
        for (const descriptor of config.lazySubagentConfigs ?? []) {
          pending.push(descriptor);
          if (wrappedLazyDescriptors.has(descriptor)) {
            continue;
          }
          wrappedLazyDescriptors.add(descriptor);
          const resolve = descriptor.resolve;
          descriptor.resolve = async (context) => {
            const resolved = await resolve(context);
            const resolvedAgents = [];
            const resolvedPending = [resolved];
            const resolvedIds = new Set();
            for (let resolvedIndex = 0; resolvedIndex < resolvedPending.length; resolvedIndex++) {
              const resolvedAgent = resolvedPending[resolvedIndex];
              if (!resolvedAgent?.id || resolvedIds.has(resolvedAgent.id)) {
                continue;
              }
              resolvedIds.add(resolvedAgent.id);
              resolvedAgents.push(resolvedAgent);
              resolvedPending.push(...(resolvedAgent.subagentAgentConfigs ?? []));
              for (const graph of resolvedAgent.subagentGraphConfigs ?? []) {
                resolvedPending.push(...graph.memberConfigs);
              }
            }
            const unpreparedAgents = resolvedAgents.filter(
              (agent) => !runtimeAgentPreparations.has(agent),
            );
            if (unpreparedAgents.length > 0) {
              const liveSharedAttachmentFiles =
                this.turnSharedAttachmentFiles ?? sharedAttachmentFiles;
              const liveSharedAttachmentIds = collectFileIds(liveSharedAttachmentFiles);
              const lateAttachmentsByAgentId =
                buildAgentContextAttachmentsByAgentId(unpreparedAgents);
              const lateScopedAttachmentMap = this.getFilteredScopedAttachmentMap(
                liveSharedAttachmentIds,
                lateAttachmentsByAgentId,
                unpreparedAgents,
              );
              const lateAttachmentInjections = [...lateScopedAttachmentMap.values()].flat();
              attachmentContextInjections.push(...lateAttachmentInjections);
              attachmentTelemetryFiles.push(...lateAttachmentInjections);
              this.assertTurnAttachmentLimits(
                [...liveSharedAttachmentFiles, ...(this.turnAggregateOnlyAttachmentFiles ?? [])],
                attachmentContextInjections,
              );
              const lateEndpointsByAgentId = new Map(
                unpreparedAgents.map((agent) => [agent.id, { endpoint: agent.endpoint }]),
              );
              for (const [agentId, attachments] of lateScopedAttachmentMap) {
                this.turnScopedAttachmentsByAgentId.set(agentId, attachments);
              }
              for (const [agentId, agentEndpoint] of lateEndpointsByAgentId) {
                this.turnAttachmentEndpointsByAgentId.set(agentId, agentEndpoint);
              }
              const pending = buildAgentScopedContext({
                agentIds: unpreparedAgents.map((agent) => agent.id),
                attachmentsByAgentId: lateAttachmentsByAgentId,
                sharedRunAttachmentIds: liveSharedAttachmentIds,
                sharedAttachments: liveSharedAttachmentFiles,
                req: this.options.req,
                endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
                endpointType: this.options.endpointType,
                endpointsByAgentId: lateEndpointsByAgentId,
                tokenCountFn: (text) => countTokens(text),
              }).then((lateScopedContext) =>
                Promise.all(
                  unpreparedAgents.map((agent) =>
                    prepareRuntimeAgent(
                      { agent, agentId: agent.id },
                      lateScopedContext.get(agent.id),
                      true,
                    ),
                  ),
                ),
              );
              for (const agent of unpreparedAgents) {
                runtimeAgentPreparations.set(agent, pending);
              }
            }
            await Promise.all(resolvedAgents.map((agent) => runtimeAgentPreparations.get(agent)));
            wrapLazyResolvers(resolvedAgents);
            return resolved;
          };
        }
      }
    };
    wrapLazyResolvers([this.options.agent, ...(this.agentConfigs?.values() ?? [])]);

    logAgentMemorySnapshot('after_context_assembly', this.attachmentMemoryContext);
    return result;
  }

  /**
   * Creates a promise that resolves with the memory promise result or undefined after a timeout
   * @param {Promise<(TAttachment | null)[] | undefined>} memoryPromise - The memory promise to await
   * @param {number} timeoutMs - Timeout in milliseconds (default: 3000)
   * @returns {Promise<(TAttachment | null)[] | undefined>}
   */
  async awaitMemoryWithTimeout(memoryPromise, timeoutMs = 3000) {
    if (!memoryPromise) {
      return;
    }

    try {
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Memory processing timeout')), timeoutMs),
      );

      const attachments = await Promise.race([memoryPromise, timeoutPromise]);
      return attachments;
    } catch (error) {
      if (error.message === 'Memory processing timeout') {
        logger.warn('[AgentClient] Memory processing timed out after 3 seconds');
      } else {
        logger.error('[AgentClient] Error processing memory:', getSafeErrorMetadata(error));
      }
      return;
    }
  }

  /**
   * @returns {Promise<{ withKeys?: string; withoutKeys?: string } | undefined>}
   */
  async useMemory() {
    const user = this.options.req.user;
    if (user.personalization?.memories === false) {
      return;
    }
    const hasAccess = await checkAccess({
      user,
      permissionType: PermissionTypes.MEMORIES,
      permissions: [Permissions.USE],
      getRoleByName: db.getRoleByName,
    });

    if (!hasAccess) {
      logger.debug(
        `[api/server/controllers/agents/client.js #useMemory] User ${user.id} does not have USE permission for memories`,
      );
      return;
    }
    const appConfig = this.options.req.config;
    const memoryConfig = appConfig.memory;
    if (!memoryConfig || memoryConfig.disabled === true) {
      return;
    }

    const userId = this.options.req.user.id + '';
    /** Memory partition of the primary agent; undefined = shared personal pool */
    const memoryAgentId = getMemoryAgentId(this.options.agent);
    this.processMemory = undefined;

    if (!isMemoryAgentEnabled(memoryConfig)) {
      try {
        const { withKeys, withoutKeys } = await getRequestMemories({
          req: this.options.req,
          userId,
          agentId: memoryAgentId,
          getFormattedMemories: db.getFormattedMemories,
        });
        return { withKeys, withoutKeys };
      } catch (error) {
        logger.error(
          '[api/server/controllers/agents/client.js #useMemory] Error loading memories',
          getSafeErrorMetadata(error),
        );
        return;
      }
    }

    /** @type {Agent} */
    let prelimAgent;
    const allowedProviders = new Set(
      appConfig?.endpoints?.[EModelEndpoint.agents]?.allowedProviders,
    );
    try {
      if (memoryConfig.agent?.id != null && memoryConfig.agent.id !== this.options.agent.id) {
        prelimAgent = await loadAgent({
          req: this.options.req,
          agent_id: memoryConfig.agent.id,
          endpoint: EModelEndpoint.agents,
        });
      } else if (memoryConfig.agent?.id != null) {
        prelimAgent = this.options.agent;
      } else if (
        memoryConfig.agent?.id == null &&
        memoryConfig.agent?.model != null &&
        memoryConfig.agent?.provider != null
      ) {
        prelimAgent = { id: Constants.EPHEMERAL_AGENT_ID, ...memoryConfig.agent };
      }
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error loading agent for memory',
        getSafeErrorMetadata(error),
      );
    }

    if (!prelimAgent) {
      return;
    }

    /** Forward the same `execute_code` capability gate the chat flow uses —
     *  memory agents are unlikely to list `execute_code`, but if one does,
     *  Phase 8 relies on this flag to expand the string into
     *  `bash_tool` + `read_file` (pre-Phase 8 the legacy `execute_code`
     *  tool registered unconditionally; without this passthrough the
     *  memory path would silently lose code-execution tooling). */
    const memoryCapabilities = new Set(appConfig?.endpoints?.[EModelEndpoint.agents]?.capabilities);
    const memoryCodeEnabled = memoryCapabilities.has(AgentCapabilities.execute_code);
    /** Same pairing as the chat initializers: the capability is the deployment
     *  switch, the grant is the role's. Skipped when the capability is off, so a
     *  deployment without code execution adds no role read to the shared memory
     *  context. Request-memoized otherwise, so it joins the lookup the tool
     *  loader already made. */
    const memoryToolGrants = memoryCodeEnabled
      ? await resolveToolRoleGrants({
          req: this.options.req,
          getRoleByName: db.getRoleByName,
          context: 'memoryAgent',
        })
      : null;
    const agent = await initializeAgent(
      {
        req: this.options.req,
        res: this.options.res,
        agent: prelimAgent,
        allowedProviders,
        endpointOption: {
          endpoint: !isEphemeralAgentId(prelimAgent.id)
            ? EModelEndpoint.agents
            : memoryConfig.agent?.provider,
        },
        codeEnvAvailable: memoryCodeEnabled && memoryToolGrants?.runCode === true,
        statefulSessionsAvailable: memoryCapabilities.has(AgentCapabilities.stateful_code_sessions),
      },
      {
        getFiles: db.getFiles,
        getUserKey: db.getUserKey,
        getConvoFiles: db.getConvoFiles,
        getAccessibleMcpServerNames,
        updateFilesUsage: db.updateFilesUsage,
        getUserKeyValues: db.getUserKeyValues,
        getToolFilesByIds: db.getToolFilesByIds,
        getCodeGeneratedFiles: db.getCodeGeneratedFiles,
        filterFilesByAgentAccess,
        getRoleByName: db.getRoleByName,
      },
    );

    if (!agent) {
      logger.warn(
        '[api/server/controllers/agents/client.js #useMemory] No agent found for memory',
        memoryConfig,
      );
      return;
    }

    const llmConfig = Object.assign(
      {
        provider: agent.provider,
        model: agent.model,
      },
      agent.model_parameters,
    );

    /** @type {import('@librechat/api').MemoryConfig} */
    const config = {
      validKeys: memoryConfig.validKeys,
      instructions: agent.instructions,
      llmConfig,
      tokenLimit: memoryConfig.tokenLimit,
    };

    const messageId = this.responseMessageId + '';
    const conversationId = this.conversationId + '';
    const streamId = this.options.req?._resumableStreamId || null;
    const [withoutKeys, processMemory] = await createMemoryProcessor({
      userId,
      agentId: memoryAgentId,
      config,
      filters: this.options.req.config?.filters,
      messageId,
      streamId,
      jobCreatedAt: this.jobCreatedAt,
      conversationId,
      memoryMethods: {
        setMemory: db.setMemory,
        deleteMemory: db.deleteMemory,
        getUserMemories: db.getUserMemories,
        getFormattedMemories: db.getFormattedMemories,
      },
      req: this.options.req,
      res: this.options.res,
      user: createSafeUser(this.options.req.user),
      tenantId: resolveRequestTenantId(this.options.req),
    });

    this.processMemory = processMemory;
    let withKeys = withoutKeys;
    try {
      ({ withKeys } = await getRequestMemories({
        req: this.options.req,
        userId,
        agentId: memoryAgentId,
        getFormattedMemories: db.getFormattedMemories,
      }));
    } catch (error) {
      logger.error(
        '[api/server/controllers/agents/client.js #useMemory] Error loading keyed memories',
        getSafeErrorMetadata(error),
      );
    }
    return { withKeys, withoutKeys };
  }

  /** Reuses the exact memory authorization/load promise for planning and prompt construction. */
  getSharedMemoryContext() {
    this.memoryContextPromise ??= this.useMemory();
    return this.memoryContextPromise;
  }

  /**
   * Returns the model-bound memory snapshots needed for event-actor compatibility.
   * The request-scoped memory cache makes this the same read used by buildMessages.
   *
   * @param {Array<import('@librechat/api').InitializedAgent>} agents
   * @returns {Promise<Array<{scope: string, withKeys?: string, withoutKeys?: string}>>}
   */
  async getEventActorMemorySnapshots(agents) {
    const primary = await this.getSharedMemoryContext();
    if (!primary) {
      return [];
    }
    const userId = this.options.req.user.id + '';
    const primaryScope = getMemoryAgentId(this.options.agent);
    const scopes = new Map([[primaryScope ?? '', primary]]);
    await Promise.all(
      agents.map(async (agent) => {
        if (agent !== this.options.agent && !agentHasInlineMemoryTools(agent)) {
          return;
        }
        const agentId = getMemoryAgentId(agent);
        const scope = agentId ?? '';
        if (scopes.has(scope)) {
          return;
        }
        const snapshot = await getRequestMemories({
          req: this.options.req,
          userId,
          agentId,
          getFormattedMemories: db.getFormattedMemories,
        });
        scopes.set(scope, snapshot);
      }),
    );
    return [...scopes]
      .map(([scope, snapshot]) => ({
        scope: scope || 'shared',
        ...(snapshot.withKeys ? { withKeys: snapshot.withKeys } : {}),
        ...(snapshot.withoutKeys ? { withoutKeys: snapshot.withoutKeys } : {}),
      }))
      .sort((left, right) => left.scope.localeCompare(right.scope));
  }

  /**
   * Filters out image URLs from message content
   * @param {BaseMessage} message - The message to filter
   * @returns {BaseMessage} - A new message with image URLs removed
   */
  filterImageUrls(message) {
    if (!message.content || typeof message.content === 'string') {
      return message;
    }

    if (Array.isArray(message.content)) {
      const filteredContent = message.content.filter(
        (part) => part.type !== ContentTypes.IMAGE_URL,
      );

      if (filteredContent.length === 1 && filteredContent[0].type === ContentTypes.TEXT) {
        const MessageClass = message.constructor;
        return new MessageClass({
          content: filteredContent[0].text,
          additional_kwargs: message.additional_kwargs,
        });
      }

      const MessageClass = message.constructor;
      return new MessageClass({
        content: filteredContent,
        additional_kwargs: message.additional_kwargs,
      });
    }

    return message;
  }

  /**
   * @param {BaseMessage[]} messages
   * @returns {Promise<void | (TAttachment | null)[]>}
   */
  async runMemory(messages) {
    try {
      if (this.processMemory == null) {
        return;
      }
      const appConfig = this.options.req.config;
      const memoryConfig = appConfig.memory;
      const messageWindowSize = memoryConfig?.messageWindowSize ?? 5;

      /**
       * Strip skill-primed meta messages before memory extraction. The primes
       * sit next to the latest user message and carry large SKILL.md bodies,
       * so letting them into the window would crowd out real chat turns and
       * pollute extracted memories with synthetic instruction content the
       * user never typed.
       */
      const chatMessages = messages.filter((m) => !isSkillPrimeMessage(m));

      let messagesToProcess = [...chatMessages];
      if (chatMessages.length > messageWindowSize) {
        for (let i = chatMessages.length - messageWindowSize; i >= 0; i--) {
          const potentialWindow = chatMessages.slice(i, i + messageWindowSize);
          if (potentialWindow[0]?.role === 'user') {
            messagesToProcess = [...potentialWindow];
            break;
          }
        }

        if (messagesToProcess.length === chatMessages.length) {
          messagesToProcess = [...chatMessages.slice(-messageWindowSize)];
        }
      }

      const filteredMessages = messagesToProcess.map((msg) => this.filterImageUrls(msg));
      const bufferString = getBufferString(filteredMessages);
      const configuredMaxInputTokens = Number.isFinite(memoryConfig?.maxInputTokens)
        ? Math.floor(memoryConfig.maxInputTokens)
        : undefined;
      const maxInputTokens =
        configuredMaxInputTokens != null && configuredMaxInputTokens > 0
          ? configuredMaxInputTokens
          : DEFAULT_MEMORY_MAX_INPUT_TOKENS;
      const maxInputChars = maxInputTokens * MEMORY_INPUT_CHARS_PER_TOKEN;
      const isCharTruncated = bufferString.length > maxInputChars;
      const memoryInput = `# Current Chat:\n\n${
        isCharTruncated
          ? `[Earlier chat content omitted due to memory input limit]\n\n${bufferString.slice(
              -maxInputChars,
            )}`
          : bufferString
      }`;
      const {
        text: limitedMemoryInput,
        tokenCount,
        wasTruncated,
      } = await processTextWithTokenLimit({
        text: memoryInput,
        tokenLimit: maxInputTokens,
        tokenCountFn: (text) => countTokens(text),
        preserve: 'end',
      });
      if (isCharTruncated || wasTruncated) {
        logger.warn('[MemoryAgent] Memory input truncated before processing', {
          tokenCount,
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          maxInputTokens,
          wasTruncated,
          maxInputChars,
          originalLength: bufferString.length,
        });
      }
      const bufferMessage = new HumanMessage(limitedMemoryInput);
      return await this.processMemory([bufferMessage], filteredMessages);
    } catch (error) {
      logger.error('Memory Agent failed to process memory', getSafeErrorMetadata(error));
    }
  }

  /** @type {sendCompletion} */
  async sendCompletion(payload, opts = {}) {
    await this.chatCompletion({
      payload,
      onProgress: opts.onProgress,
      userMCPAuthMap: opts.userMCPAuthMap,
      abortController: opts.abortController,
    });

    const completion = filterMalformedContentParts(this.contentParts);
    if (this.isCompactionTurn()) {
      markCompactionOutcome(completion, {
        aborted: this.abortController?.signal?.aborted === true,
      });
    }
    const metadata = this.buildResponseMetadata();
    return metadata ? { completion, metadata } : { completion };
  }

  /** A manual compaction runs the graph summarize-only: the summary is the response. */
  isCompactionTurn() {
    return this.options?.req?.body?.compact === true;
  }

  /**
   * Assembles the response message `metadata`: Vertex thought signatures plus
   * the persisted context breakdown (Part A) and the usage/cost rollup (Part B),
   * which rebuild the gauge breakdown and branch/total cost across reloads.
   * Returns undefined when nothing was captured.
   * @returns {{
   *   thoughtSignatures?: Record<string, string>,
   *   contextUsage?: import('librechat-data-provider').TContextUsageEvent,
   *   usage?: import('librechat-data-provider').TResponseUsage,
   * } | undefined}
   */
  buildResponseMetadata() {
    /** @type {{
     *   thoughtSignatures?: Record<string, string>,
     *   contextUsage?: import('librechat-data-provider').TContextUsageEvent,
     *   usage?: import('librechat-data-provider').TResponseUsage,
     * }} */
    const metadata = {};
    const signatures = this.collectedThoughtSignatures;
    if (signatures && Object.keys(signatures).length > 0) {
      metadata.thoughtSignatures = signatures;
    }
    const usageEvents = this.usageEmitSink ?? [];
    /** Persist the breakdown only when the latest snapshot's OWN run completed —
     *  i.e. a PRIMARY usage event (usage_type == null) from that run's id arrived
     *  AFTER the snapshot. Matching by run id keeps `completedOutputTokens` a real
     *  post-snapshot delta even when parallel/direct runs interleave (A snapshot →
     *  B snapshot → A usage must NOT persist B's snapshot with A's output); an
     *  interrupted final call that emits no usage falls back to the per-message
     *  estimate. It still keeps the post-summary snapshot: the summarization detour
     *  emits an extra snapshot whose following primary usage shares that run's id,
     *  which the old snapshot-count guard miscounted and wrongly dropped. Events
     *  without a run id (older lib / resume) match any snapshot for back-compat. */
    const latestSnapshot = this.contextUsageSink?.latest;
    const latestSnapshotUsageIndex = this.contextUsageSink?.latestUsageIndex ?? 0;
    const latestSnapshotRunId = latestSnapshot?.runId;
    const hasPrimaryAfterSnapshot = usageEvents
      .slice(latestSnapshotUsageIndex)
      .some(
        (event) =>
          event.usage_type == null &&
          (latestSnapshotRunId == null ||
            event.runId == null ||
            event.runId === latestSnapshotRunId),
      );
    if (latestSnapshot && hasPrimaryAfterSnapshot) {
      /** The counted tool results this turn keeps past that snapshot — only a
       *  tool-call-limit stop has any; see `resolveRetainedToolTokens`. */
      metadata.contextUsage = buildPersistedContextUsage(latestSnapshot, usageEvents, {
        retainedToolTokens: resolveRetainedToolTokens({
          stoppedAtToolLimit: this.stepLimitReached === true,
          contentParts: this.contentParts,
          priorToolCallIds: this.contextUsageSink?.latestToolCallIds,
          encoding: this.getEncoding(),
          maxCountChars:
            this.options?.req?.config?.endpoints?.[EModelEndpoint.agents]
              ?.maxRetainedToolCountChars,
        }),
      });
    }
    /** Lightweight summarization marker — persisted whenever this turn compacted
     *  the context, INDEPENDENT of the snapshot guard above. When the client has
     *  no usable snapshot on the branch and falls back to the per-message
     *  estimate, it caps the discarded pre-summary history at this baseline
     *  instead of re-summing it (the gauge otherwise reads 100% forever). Shared
     *  with the abort save path via `computeSummaryUsedTokens`. Subtract the
     *  response's earlier tool-loop outputs (the primaries that preceded the
     *  latest snapshot, same run): those tokens are inside the snapshot baseline
     *  AND in the response `tokenCount` the client estimate adds on top, so
     *  leaving them in the marker double-counts them on a multi-call turn. */
    const priorOutputTokens = priorRunOutputTokens(
      usageEvents,
      latestSnapshotUsageIndex,
      latestSnapshotRunId,
    );
    const summaryUsedTokens = computeSummaryUsedTokens(latestSnapshot, priorOutputTokens);
    if (summaryUsedTokens != null) {
      metadata.summaryUsedTokens = summaryUsedTokens;
    }
    const usage = aggregateEmittedUsage(usageEvents);
    if (usage) {
      metadata.usage = usage;
    }
    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  /**
   * Resolves the endpoint token config for a usage item by its producing agent
   * (multi-endpoint graphs: connected agents + subagents). A known agent's
   * config is authoritative — including `undefined`, which prices with built-in
   * rates (e.g. a non-custom agent in a custom-primary graph). Only an
   * untagged/unknown agent falls back to the primary config, so single-endpoint
   * graphs are unchanged.
   * @param {UsageMetadata} usage
   * @returns {import('@librechat/api').EndpointTokenConfig | undefined}
   */
  resolveAgentEndpointTokenConfig(usage) {
    return resolveAgentTokenConfig({
      agentId: usage?.agentId,
      byAgentId: this.options.endpointTokenConfigByAgentId,
      fallback: this.options.endpointTokenConfig,
    });
  }

  /**
   * @param {Object} params
   * @param {string} [params.model]
   * @param {string} [params.context='message']
   * @param {AppConfig['balance']} [params.balance]
   * @param {AppConfig['transactions']} [params.transactions]
   * @param {UsageMetadata[]} [params.collectedUsage=this.collectedUsage]
   */
  async recordCollectedUsage({
    model,
    balance,
    transactions,
    context = 'message',
    collectedUsage = this.collectedUsage,
    /**
     * Rates for usage that did NOT run on the agent's endpoint — currently
     * activity labels pointed at a different `activityEndpoint`. Without it
     * the caller's config was dropped here and the balance transaction was
     * written at the primary agent's rates while the UI cost was computed at
     * the label's, so the two disagreed. `undefined` keeps the agent default.
     */
    endpointTokenConfig,
    /**
     * True when this usage ran on a DIFFERENT endpoint than the agent, making
     * `endpointTokenConfig` authoritative even when it is `undefined` (a
     * built-in endpoint prices from the shared table). Presence of the value
     * cannot express that, which is why the caller states it outright.
     */
    crossEndpoint = false,
    /**
     * Whether this recording owns `getStreamUsage()`. Only the PRIMARY
     * generation does. Secondary usage (activity labels) must still be
     * billed, but writing it here would hand `BaseClient` the label's token
     * counts as the assistant response's authoritative total — and because
     * the primary call returns early when it collected nothing, the wrong
     * value would never be replaced, suppressing the text-based token
     * fallback and leaving the real generation unbilled.
     */
    updateStreamUsage = true,
  }) {
    /** Per-agent resolution keys off the AGENT's config map, which cannot
     *  describe a label running on a different endpoint — so an explicit
     *  config wins outright rather than being second-guessed per usage row.
     *
     *  Keyed on the caller's discriminator, NOT on `endpointTokenConfig !==
     *  undefined`: a built-in label endpoint prices from the shared table, so
     *  `undefined` is its meaningful value. Reading that as "no override" is
     *  what silently restored the primary's custom rates. */
    const overrideTokenConfig = crossEndpoint === true;
    const result = await recordCollectedUsage(
      {
        spendTokens: db.spendTokens,
        spendStructuredTokens: db.spendStructuredTokens,
        pricing: { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
        bulkWriteOps: { insertMany: db.bulkInsertTransactions, updateBalance: db.updateBalance },
      },
      {
        user: this.user ?? this.options.req.user?.id,
        conversationId: this.conversationId,
        collectedUsage,
        model: model ?? this.model ?? this.options.agent.model_parameters.model,
        context,
        messageId: this.responseMessageId,
        balance,
        transactions,
        endpointTokenConfig: overrideTokenConfig
          ? endpointTokenConfig
          : this.options.endpointTokenConfig,
        ...(overrideTokenConfig
          ? {}
          : { resolveEndpointTokenConfig: (usage) => this.resolveAgentEndpointTokenConfig(usage) }),
      },
    );

    if (result && updateStreamUsage) {
      this.usage = result;
    }
  }

  /**
   * Get stream usage as returned by this client's API response.
   * @returns {UsageMetadata} The stream usage object.
   */
  getStreamUsage() {
    return this.usage;
  }

  /**
   * Builds the subagent usage emitter for {@link createSubagentUsageSink}.
   * Streams each billed child-run usage to the client as an `on_token_usage`
   * event tagged `subagent` (folds into session cost/totals, not the live
   * gauge), with the authoritative cost when `interface.contextCost` is on.
   * Returns undefined when there's no stream to write to.
   * @param {AppConfig} [appConfig]
   * @returns {((usage: UsageMetadata) => void) | undefined}
   */
  buildSubagentUsageEmitter(appConfig) {
    /** Detached children can report usage after `disposeClient` has cleared the
     * parent client. Snapshot every value the emitter needs now; the returned
     * callback must not dereference mutable client state. */
    const options = this.options;
    const res = options.res;
    const streamId = options.req?._resumableStreamId || null;
    if (!res && !streamId) {
      return undefined;
    }
    const includeCost = appConfig?.interfaceConfig?.contextCost === true;
    const responseMessageId = this.responseMessageId;
    const jobCreatedAt = this.jobCreatedAt;
    const usageEmitSink = this.usageEmitSink;
    const pendingSubagentEmits = this.pendingSubagentEmits;
    const endpointTokenConfig = options.endpointTokenConfig;
    const endpointTokenConfigByAgentId =
      options.endpointTokenConfigByAgentId instanceof Map
        ? new Map(options.endpointTokenConfigByAgentId)
        : options.endpointTokenConfigByAgentId;
    let subagentUsageSeq = this.subagentUsageSeq;
    return (usage) => {
      subagentUsageSeq += 1;
      const cache_creation =
        usage.input_token_details?.cache_creation ?? usage.cache_creation_input_tokens;
      const cache_read = usage.input_token_details?.cache_read ?? usage.cache_read_input_tokens;
      const data = {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        total_tokens: usage.total_tokens,
        input_token_details:
          cache_creation == null && cache_read == null ? undefined : { cache_creation, cache_read },
        model: usage.model,
        provider: usage.provider,
        usage_type: 'subagent',
        runId: jobCreatedAt != null ? `${responseMessageId}:${jobCreatedAt}` : responseMessageId,
        /** Unique per child call for reconnect/resume dedupe. */
        seq: subagentUsageSeq,
        /** Price with the SUBAGENT's own endpoint token config (its endpoint may
         *  differ from the parent's); `usage.agentId` is tagged by the sink. */
        cost: includeCost
          ? computeUsageCostUSD(
              usage,
              { getMultiplier: db.getMultiplier, getCacheMultiplier: db.getCacheMultiplier },
              resolveAgentTokenConfig({
                agentId: usage?.agentId,
                byAgentId: endpointTokenConfigByAgentId,
                fallback: endpointTokenConfig,
              }),
            )
          : undefined,
      };
      if (data.cost != null) {
        /** The detached task collector persists this same usage object on the
         * child message after the emitter has attached authoritative cost. */
        usage.cost = data.cost;
      }
      /** Fold into the response's usage rollup (synchronously, regardless of
       *  emit success) so the persisted total matches the live session, which
       *  also folds subagent usage into its cost/totals. */
      if (usageEmitSink) {
        usageEmitSink.push(data);
      }
      /** The sink fires this without awaiting, so retain the promise and flush
       *  it in chatCompletion's finally — emitChunk persists (HSET) before
       *  publishing, and job cleanup must not race that persist or resumed
       *  clients miss billed subagent usage. */
      const emit = (async () => {
        try {
          if (streamId) {
            await GenerationJobManager.emitChunk(
              streamId,
              {
                event: UsageEvents.ON_TOKEN_USAGE,
                data,
              },
              { expectedCreatedAt: jobCreatedAt },
            );
          } else {
            sendEvent(res, { event: UsageEvents.ON_TOKEN_USAGE, data });
          }
        } catch (err) {
          logger.warn('[AgentClient] Failed to emit subagent usage', getSafeErrorMetadata(err));
        }
      })();
      pendingSubagentEmits.push(emit);
      return emit;
    };
  }

  /**
   * Detached children may outlive the parent turn's one-time billing flush.
   * Bill each detached model call on the SDK's awaited usage path; foreground
   * children continue to batch with the parent turn.
   * @param {AppConfig['balance']} balance
   * @param {AppConfig['transactions']} transactions
   * @returns {(usage: UsageMetadata) => Promise<void>}
   */
  buildDetachedSubagentUsageRecorder(balance, transactions) {
    const options = this.options;
    const billing = {
      user: this.user ?? options?.req?.user?.id,
      conversationId: this.conversationId,
      messageId: this.responseMessageId,
      model: this.model ?? options?.agent?.model_parameters?.model,
      endpointTokenConfig: options?.endpointTokenConfig,
      endpointTokenConfigByAgentId: options?.endpointTokenConfigByAgentId,
    };
    return createDetachedSubagentUsageRecorder(
      {
        spendTokens: db.spendTokens,
        spendStructuredTokens: db.spendStructuredTokens,
        pricing: {
          getMultiplier: db.getMultiplier,
          getCacheMultiplier: db.getCacheMultiplier,
        },
        bulkWriteOps: {
          insertMany: db.bulkInsertTransactions,
          updateBalance: db.updateBalance,
        },
        isPrincipalActive: db.isAgentTriggerPrincipalActive,
      },
      { ...billing, balance, transactions },
    );
  }

  /**
   * @param {TMessage} responseMessage
   * @returns {number}
   */
  getTokenCountForResponse({ content }) {
    return countFormattedMessageTokens({ role: 'assistant', content }, this.getEncoding());
  }

  /**
   * @param {object} params
   * @param {string | ChatCompletionMessageParam[]} params.payload
   * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
   * @param {AbortController} [params.abortController]
   */
  /**
   * @deprecated Agent Chain — strip hidden intermediate sequential-agent content
   * before persistence, keeping only the last non-label part + tool_call parts.
   * Parent activity markers can be appended after the final answer, so physical
   * array order alone cannot identify the response output that must survive.
   */
  applyHideSequentialOutputsFilter() {
    if (!this.options.agent?.hide_sequential_outputs || !Array.isArray(this.contentParts)) {
      return;
    }
    let lastOutputIndex = -1;
    for (let index = this.contentParts.length - 1; index >= 0; index -= 1) {
      const part = this.contentParts[index];
      if (part != null && part.type !== ContentTypes.ACTIVITY_LABEL) {
        lastOutputIndex = index;
        break;
      }
    }
    this.contentParts = this.contentParts.filter(
      (part, index) =>
        index === lastOutputIndex ||
        part.type === ContentTypes.TOOL_CALL ||
        // Steer parts are user speech, not intermediate agent output — dropping
        // one would erase the user's words from the persisted turn.
        part.type === ContentTypes.STEER ||
        // Activity labels summarize the hidden intermediate outputs — exactly
        // the affordance hide_sequential_outputs wants to keep visible.
        part.type === ContentTypes.ACTIVITY_LABEL ||
        part.tool_call_ids,
    );
  }

  /**
   * Rebase parent activity bounds after completion-time content reshaping.
   * Object identity links retained parts back to their pre-reshape positions,
   * so prepended skill cards cannot enter a phase and a filtered-away leading
   * reasoning part advances the bound to the first retained child.
   *
   * Both arrays may be sparse: the aggregator writes parts at provider-source
   * indexes, which can skip slots. Holes must not enter the identity map — a
   * hole reads as `undefined`, and one `undefined` key would falsely match
   * every hole in `previousParts` as a retained part.
   *
   * @param {Array<import('librechat-data-provider').ContentPart | null | undefined>} previousParts
   */
  rebaseActivityPhaseBounds(previousParts) {
    if (!Array.isArray(previousParts) || !Array.isArray(this.contentParts)) {
      return;
    }
    /** Preserve sparse coordinates when completion did not actually reshape
     *  the content. A phase can reserve a leading hole for a tool part whose
     *  SDK event lands after the phase closes; scanning retained identities
     *  in an unchanged array would skip that hole and move the bound past the
     *  delayed tool before it arrives. */
    const previousDefinedIndexes = Object.keys(previousParts)
      .map(Number)
      .filter((index) => previousParts[index] != null);
    const currentDefinedIndexes = Object.keys(this.contentParts)
      .map(Number)
      .filter((index) => this.contentParts[index] != null);
    if (previousParts.length === this.contentParts.length) {
      const unchanged =
        previousDefinedIndexes.length === currentDefinedIndexes.length &&
        previousDefinedIndexes.every(
          (index, position) =>
            index === currentDefinedIndexes[position] &&
            previousParts[index] === this.contentParts[index],
        );
      if (unchanged) {
        return;
      }
    }
    const retainedIndexes = new Map();
    for (const index of currentDefinedIndexes) {
      const part = this.contentParts[index];
      if (part != null) {
        retainedIndexes.set(part, index);
      }
    }
    const previousIndexesByPart = new Map();
    for (const index of previousDefinedIndexes) {
      const part = previousParts[index];
      if (part != null) {
        previousIndexesByPart.set(part, index);
      }
    }
    for (const markerIndex of currentDefinedIndexes) {
      const marker = this.contentParts[markerIndex];
      if (
        marker?.type !== ContentTypes.ACTIVITY_LABEL ||
        marker.activity_label_type !== 'phase' ||
        typeof marker.activity_start_index !== 'number'
      ) {
        continue;
      }
      const previousMarkerIndex = previousIndexesByPart.get(marker);
      if (previousMarkerIndex == null) {
        continue;
      }
      const previousStartIndex = Math.min(
        previousMarkerIndex,
        Math.max(0, marker.activity_start_index),
      );
      const hasExplicitEnd = typeof marker.activity_end_index === 'number';
      const previousEndIndex = hasExplicitEnd
        ? Math.max(previousStartIndex, Math.min(previousMarkerIndex, marker.activity_end_index))
        : previousMarkerIndex;
      let nextStartIndex = markerIndex;
      let nextEndIndex = markerIndex;
      let foundRetainedPart = false;
      for (const index of previousDefinedIndexes) {
        if (index < previousStartIndex || index >= previousEndIndex) {
          continue;
        }
        const retainedIndex = retainedIndexes.get(previousParts[index]);
        if (retainedIndex != null && retainedIndex < markerIndex) {
          if (!foundRetainedPart) {
            nextStartIndex = retainedIndex;
            nextEndIndex = retainedIndex + 1;
            foundRetainedPart = true;
          } else {
            nextStartIndex = Math.min(nextStartIndex, retainedIndex);
            nextEndIndex = Math.min(markerIndex, Math.max(nextEndIndex, retainedIndex + 1));
          }
        }
      }
      if (!foundRetainedPart && hasExplicitEnd) {
        for (const index of previousDefinedIndexes) {
          if (index < previousEndIndex || index >= previousMarkerIndex) {
            continue;
          }
          const retainedIndex = retainedIndexes.get(previousParts[index]);
          if (retainedIndex != null && retainedIndex < markerIndex) {
            nextStartIndex = retainedIndex;
            nextEndIndex = retainedIndex;
            break;
          }
        }
      }
      marker.activity_start_index = nextStartIndex;
      if (hasExplicitEnd) {
        marker.activity_end_index = Math.max(nextStartIndex, nextEndIndex);
      }
    }
  }

  /** Finalize only a completed root run; HITL interruptions retain their snapshot for resume. */
  completeActivityPhase(run, activityPhase) {
    if (typeof run?.getInterrupt === 'function' && run.getInterrupt()?.payload) {
      return;
    }
    activityPhase?.complete?.();
  }

  /** Returns the exact staged approval envelope the SDK signs into a suspension. */
  readEventActorSuspension() {
    const staged = this.stagedApproval;
    if (staged == null || this.eventActorInvocationId == null) {
      return undefined;
    }
    return {
      actionId: staged.pendingAction.actionId,
      jobCreatedAt: this.jobCreatedAt,
      interrupt: {
        id: staged.interruptId,
        payload: { ...staged.pendingAction, type: staged.interruptType },
      },
    };
  }

  /** Projects an already-staged pause into the shared job store. Event Actors
   * call this only after their signed Conversation suspension is durable. */
  async publishStagedApproval(eventActorSuspension) {
    const staged = this.stagedApproval;
    if (staged == null) {
      return false;
    }
    if (this.pendingApproval?.actionId === staged.pendingAction.actionId) {
      return true;
    }
    const pauseProjection = {
      expectedCreatedAt: this.jobCreatedAt,
      ...(staged.discoveredTools.length > 0 ? { discoveredTools: staged.discoveredTools } : {}),
      ...(staged.activityPhaseSnapshot == null
        ? {}
        : { activityPhaseSnapshot: staged.activityPhaseSnapshot }),
      ...(staged.compactionSemanticIndex == null
        ? {}
        : { compactionSemanticIndex: staged.compactionSemanticIndex }),
      ...(staged.contextMeta == null ? {} : { contextMeta: staged.contextMeta }),
      persistencePending: true,
      ...(eventActorSuspension == null
        ? {}
        : {
            agentEventSuspension: {
              version: eventActorSuspension.version,
              suspensionId: eventActorSuspension.suspensionId,
              attempt: eventActorSuspension.attempt,
            },
          }),
    };
    let paused;
    try {
      paused = await GenerationJobManager.approvals.pause(
        staged.streamId,
        staged.pendingAction,
        pauseProjection,
      );
    } catch (error) {
      /** Redis may commit running -> requires_action and lose only its reply.
       * The Conversation suspension is already canonical at this point, so
       * confirm this exact generation/action/projection before declaring the
       * publication failed and driving terminal compensation. */
      const currentJob = await GenerationJobManager.getJob(staged.streamId).catch(() => null);
      const projected = currentJob?.metadata?.agentEventSuspension;
      const expectedProjection = pauseProjection.agentEventSuspension;
      if (
        currentJob?.createdAt === this.jobCreatedAt &&
        currentJob.status === 'requires_action' &&
        currentJob.metadata?.pendingAction?.actionId === staged.pendingAction.actionId &&
        expectedProjection != null &&
        projected?.version === expectedProjection.version &&
        projected.suspensionId === expectedProjection.suspensionId &&
        projected.attempt === expectedProjection.attempt
      ) {
        paused = true;
      } else {
        throw error;
      }
    }
    if (!paused) {
      logger.debug(
        `[AgentClient] Interrupt fired but job ${staged.streamId} was not running; not pausing`,
      );
      return false;
    }
    this.pendingApproval = staged.pendingAction;
    return true;
  }

  /** Exposes a durable pause after its controller-owned history barrier clears. */
  async exposePendingApproval() {
    const staged = this.stagedApproval;
    if (
      staged == null ||
      this.pendingApproval?.actionId !== staged.pendingAction.actionId ||
      this.exposedApprovalActionId === staged.pendingAction.actionId
    ) {
      return false;
    }
    if (!this.pendingRequestReleased) {
      try {
        if (this.options.req?._scheduleConcurrencyExempt !== true) {
          await decrementPendingRequest(this.options.req?.user?.id);
        }
        this.pendingRequestReleased = true;
      } catch (err) {
        logger.error(
          `[AgentClient] Failed to release request slot on pause ${staged.streamId}`,
          getSafeErrorMetadata(err),
        );
      }
    }
    // Steers accepted before the pause remain in the shared store throughout
    // review. The resumed run rehydrates them; exposing the action never moves
    // their only copy into this replica's ephemeral client state.
    await GenerationJobManager.emitChunk(
      staged.streamId,
      {
        event: ApprovalEvents.ON_PENDING_ACTION,
        data: toClientPendingAction(staged.pendingAction),
      },
      { expectedCreatedAt: this.jobCreatedAt },
    );
    this.exposedApprovalActionId = staged.pendingAction.actionId;
    logger.debug(
      `[AgentClient] Paused ${staged.streamId} for ${staged.interruptType} (action ${staged.pendingAction.actionId})`,
    );
    return true;
  }

  /**
   * Surface any human-in-the-loop interrupt the SDK captured during the most
   * recent `processStream` / `resume`. When the run paused for tool approval (or
   * an ask-user question), stage its exact envelope. Ordinary turns immediately
   * publish and expose it; Event Actors let the SDK persist signed suspension
   * evidence first, then publish under the same history barrier.
   *
   * No-op when the run completed without an interrupt, or when the job was aborted
   * between the interrupt firing and this mark (a late interrupt must not pause a
   * dead job — the atomic `pause` transition returns false and we drop it).
   *
   * @param {AgentRun} run
   * @param {string} [streamId]
   */
  async handleRunInterrupt(run, streamId) {
    if (!streamId || typeof run?.getInterrupt !== 'function') {
      return;
    }
    const interrupt = run.getInterrupt();
    if (!interrupt?.payload) {
      return;
    }

    const appConfig = this.options.req?.config;
    const checkpointerCfg = appConfig?.endpoints?.[EModelEndpoint.agents]?.checkpointer;
    if (this.options.req?._isScheduledFire === true) {
      if (!GenerationJobManager.isRedis) {
        const error = new Error(
          'The agent paused, but its shared action state is unavailable. Please retry the run.',
        );
        error.code = 'SCHEDULED_HITL_REQUIRES_SHARED_STORE';
        throw error;
      }
      let hasDurableInterrupt = false;
      try {
        hasDurableInterrupt = await hasDurableAgentInterruptCheckpoint(
          this.conversationId,
          checkpointerCfg,
          {
            checkpointNamespace: this.checkpointNamespace,
            checkpointId: interrupt.checkpointId,
            checkpointNs: interrupt.checkpointNs,
            interruptId: interrupt.interruptId,
          },
        );
      } catch (checkpointError) {
        logger.error(
          `[AgentClient] Failed to verify scheduled HITL checkpoint for ${this.conversationId} (${this.checkpointNamespace || 'legacy namespace'})`,
          checkpointError,
        );
      }
      if (!hasDurableInterrupt) {
        logger.error(
          `[AgentClient] Refusing unresumable scheduled HITL pause for ${this.conversationId} (${this.checkpointNamespace || 'legacy namespace'})`,
        );
        const error = new Error(
          'The agent paused, but its durable continuation checkpoint is unavailable. Please retry the run.',
        );
        error.code = 'HITL_CHECKPOINT_UNAVAILABLE';
        throw error;
      }
    }
    // Persist the generation params (temperature, max tokens, custom endpoint params, …)
    // so an ephemeral-agent resume continues with the SAME settings the run paused on.
    // The resume payload omits them and they aren't part of the fingerprint, so without
    // this the rebuilt ephemeral run falls back to defaults. The paused request body is
    // the primary source (UI-form, round-trips the compact-convo schema by construction);
    // the resolved llmConfig fills gaps and is sanitized — it carries provider secrets
    // (apiKey, credentials) and gateway config — resume re-resolves those server-side.
    // (Saved agents source params from the DB record, so this is belt-and-suspenders.)
    const resumeContext = pickResumeContext(this.options.req?.body);
    const resumeModelParameters = captureResumeModelParameters(
      this.options.req?.body,
      this.options.agent?.model_parameters,
    );
    if (resumeModelParameters) {
      resumeContext.model_parameters = resumeModelParameters;
    }
    // Persist the question onto the paused ask tool_call's args NOW: an
    // abandoned/expired/stopped pause never reaches the answer-resume stamp,
    // and the streamed args were dropped (name-less chunks) — without this the
    // unfinished turn saves an empty ask part the record card can't render.
    if (interrupt.payload?.type === 'ask_user_question' && Array.isArray(this.contentParts)) {
      const stamped = attachAskUserQuestionArgs(
        this.contentParts,
        Array.isArray(interrupt.payload.questions)
          ? { questions: interrupt.payload.questions }
          : interrupt.payload.question,
        interrupt.payload.tool_call_id,
      );
      if (stamped !== this.contentParts) {
        this.contentParts.length = 0;
        this.contentParts.push(...stamped);
      }
    }
    const reachableAgents = collectReachableAgents([
      this.options.agent,
      ...(this.agentConfigs?.values() ?? []),
    ]);
    const interruptPayload =
      interrupt.payload?.type === 'tool_approval'
        ? markNativeCodeToolApprovalRequests(interrupt.payload, reachableAgents)
        : interrupt.payload;
    const codeExecutionBinding =
      interrupt.payload?.type === 'tool_approval' &&
      interrupt.payload.action_requests.some(
        (action) =>
          typeof action?.name === 'string' && isStatefulCodeEnvironmentToolName(action.name),
      )
        ? captureCodeExecutionApprovalBinding(reachableAgents)
        : undefined;
    const pendingAction = buildPendingAction(interruptPayload, {
      streamId,
      conversationId: this.conversationId,
      // runId mirrors the LangGraph checkpoint namespace when the SDK provides it
      // (its documented meaning), falling back to the response message id.
      runId: interrupt.checkpointNs ?? this.responseMessageId,
      responseMessageId: this.responseMessageId,
      interruptId: interrupt.interruptId,
      // thread_id was bound to conversationId at run config (config.configurable);
      // fall back to it when the SDK doesn't echo threadId on the interrupt.
      threadId: interrupt.threadId ?? this.conversationId,
      ttlMs: getApprovalTtlMs(checkpointerCfg),
      expiresAt: this.options.req?._agentEventBindingRetention?.expiredAt,
      // Pin the graph-determining request fields so resume can't rebuild this paused
      // run on a different agent/tool set (esp. ephemeral agents, whose agent_id is
      // undefined so the id guard can't tell two configs apart).
      // Keep the legacy digest in its established field so an old replica can
      // resume pauses written during a rolling deploy; current replicas also
      // enforce the stricter code-environment-aware digest below.
      requestFingerprint: computeLegacyAgentRequestFingerprint(this.options.req?.body ?? {}),
      requestFingerprintV2: computeAgentRequestFingerprint(this.options.req?.body ?? {}),
      // Persist those same fields verbatim so the resume route can REPLAY them — a
      // reload/cross-replica resume can't reconstruct the ephemeral config client-side,
      // so the server restores it and rebuilds the same graph (and the fingerprint matches).
      resumeContext,
      codeExecutionBinding,
    });

    // Job-replacement guard: streamId == conversationId is reused per conversation, so a
    // newer request can replace this run's job. If this (older) run hits an interrupt
    // after a replacement, pausing would flip the NEWER job to requires_action with this
    // stale run's pending action, blocking fresh work behind the wrong approval. Only
    // pause when the live job is still the one THIS run created (mirrors request.js).
    if (this.jobCreatedAt != null) {
      const liveJob = await GenerationJobManager.getJobStore().getJob(streamId);
      if (!liveJob || liveJob.createdAt !== this.jobCreatedAt) {
        logger.debug(`[AgentClient] Interrupt fired but job ${streamId} was replaced; not pausing`);
        return;
      }
    }

    // Snapshot deferred-tool discovery before exposing the pause. Tool-search results
    // may live only in the interrupted SDK graph, so they must be committed atomically
    // with requires_action for an immediate/cross-replica resume to retain the schemas.
    let discoveredTools = [];
    try {
      discoveredTools = getRunDiscoveredTools(run);
    } catch (err) {
      logger.warn(
        `[AgentClient] Failed to capture discovered tools for resume on ${streamId}`,
        getSafeErrorMetadata(err),
      );
    }

    this.stagedApproval = {
      streamId,
      pendingAction,
      interruptId: interrupt.interruptId,
      interruptType: interrupt.payload.type,
      discoveredTools,
      activityPhaseSnapshot: this.activityPhaseWiring?.snapshot?.(),
      compactionSemanticIndex: createCompactionSemanticIndexProjection(
        this.compactionSemanticIndexSnapshot,
      ),
      // Calibration and fading state at the pause, so the resumed segment seeds
      // its rebuilt pruner from the same tiers and its provider projection of
      // history keeps the same bytes.
      contextMeta: captureRunContextMeta({ run, getEncoding: () => this.getEncoding() }),
    };
    if (this.eventActorInvocationId != null) {
      return;
    }
    if (await this.publishStagedApproval()) {
      await this.exposePendingApproval();
    }
  }

  async chatCompletion({ payload, userMCPAuthMap, abortController = null }) {
    /** The inherited state is on the job before any abortable setup begins; a
     * publish already started while loading history is simply awaited. */
    await this.publishRunContextMeta?.();
    /** @type {Partial<GraphRunnableConfig>} */
    let config;
    /** @type {ReturnType<createRun>} */
    let run;
    /** @type {Promise<(TAttachment | null)[] | undefined>} */
    let memoryPromise;
    const appConfig = this.options.req.config;
    const terminalRunError = createTerminalRunErrorObserver({
      maxProviderErrorChars: appConfig?.endpoints?.agents?.maxProviderErrorChars,
      logger,
      responseMessageId: this.responseMessageId,
      source: '[api/server/controllers/agents/client.js #sendCompletion]',
      genericMessage: '[api/server/controllers/agents/client.js #sendCompletion] Unhandled error',
      protectionEnabled: hasModelBoundContentProtection(
        appConfig?.filters,
        appConfig?.messageFilter?.pii,
      ),
    });
    const balanceConfig = getBalanceConfig(appConfig);
    const transactionsConfig = getTransactionsConfig(appConfig);
    try {
      if (!abortController) {
        abortController = new AbortController();
      }

      /** Scheduled approvals are unattended by definition. Their pending action,
       * replay context, and resolution fence must be shared across workers; their
       * LangGraph continuation must also use a durable shared checkpointer. Redis
       * provides the first half, while handleRunInterrupt verifies the exact durable
       * checkpoint before exposing the pause. Refuse unsupported topologies before
       * spending on provider work. */
      /** @type {AppConfig['endpoints']['agents']} */
      const agentsEConfig = appConfig.endpoints?.[EModelEndpoint.agents];
      const topLevelAgents = [this.options.agent, ...(this.agentConfigs?.values() ?? [])];
      const attachedCodeEnvironmentAgentIds =
        collectAttachedCodeEnvironmentAgentIds(topLevelAgents);
      const attachedCodeEnvironmentSettings =
        collectAttachedCodeEnvironmentPolicySettings(topLevelAgents);
      const codeApprovalMode = resolveAttachedCodeApprovalMode(
        this.options.req.body.codeApprovalMode,
        attachedCodeEnvironmentSettings,
        agentsEConfig?.toolApproval?.enabled !== false,
      );
      const effectiveToolApprovalPolicy = resolveToolApprovalPolicy({
        endpoint: agentsEConfig?.toolApproval,
        attachedCodeEnvironment: attachedCodeEnvironmentAgentIds.size > 0,
      });
      const resolvedToolApprovalHooks = isHITLEnabled(effectiveToolApprovalPolicy)
        ? buildToolApprovalHooks({
            userId: this.options.req?.user?.id,
            conversationId: this.conversationId,
            tenantId: resolveRequestTenantId(this.options.req ?? {}),
            appConfig,
          })
        : undefined;
      const admissionToolApprovalHooks = [
        ...(resolvedToolApprovalHooks ?? []),
        ...buildAttachedCodeEnvironmentAdmissionHooks(
          attachedCodeEnvironmentAgentIds,
          attachedCodeEnvironmentSettings,
          codeApprovalMode,
        ),
      ];
      const askUserQuestionAdminDisabled = isAskUserQuestionAdminDisabled(appConfig);
      const runCanPause = canAgentGraphPause({
        policy: effectiveToolApprovalPolicy,
        agents: topLevelAgents,
        hostGeneratedToolNames:
          this.options.subagentTasks == null ? undefined : [Constants.CHECK_BACKGROUND_TASK],
        resolvedProgrammaticHooks: admissionToolApprovalHooks,
        pluginHookSource: getPluginHookSource(),
        askUserQuestionAdminDisabled,
      });
      const runUsesCheckpointer = agentRunUsesCheckpointer({
        policy: effectiveToolApprovalPolicy,
        agents: topLevelAgents,
        askUserQuestionAdminDisabled,
      });
      if (this.options.req?._isScheduledFire === true && runCanPause) {
        if (!GenerationJobManager.isRedis) {
          const error = new Error(
            'Scheduled agent runs that can pause require a shared generation store. ' +
              'Enable Redis streams with USE_REDIS_STREAMS=true.',
          );
          error.code = 'SCHEDULED_HITL_REQUIRES_SHARED_STORE';
          throw error;
        }
        if (!(await getAgentCheckpointer(agentsEConfig?.checkpointer))) {
          const error = new Error(
            'Scheduled agent runs that can pause require a durable shared checkpointer. ' +
              'Use the default MongoDB checkpointer.',
          );
          error.code = 'SCHEDULED_HITL_REQUIRES_DURABLE_CHECKPOINT';
          throw error;
        }
      }

      /** Fire-and-forget: boot each selected stateful environment in
       *  parallel with generation so the first execute_code/bash call lands
       *  on a warm VM. No-op unless a reachable agent resolved
       *  `statefulCodeSessions`. */
      maybePrewarmCodeSandbox({
        req: this.options.req,
        conversationId: this.conversationId,
        agents: [this.options.agent, ...(this.agentConfigs?.values() ?? [])],
      });

      config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: this.conversationId,
          ...buildToolApprovalExecutionConfig(this.responseMessageId, this.jobCreatedAt),
          // LangGraph owns `checkpoint_ns` and resets it to '' at every root
          // invocation. The saver maps this private immutable generation key
          // into its physical namespace while tools keep the conversation id.
          checkpoint_ns: '',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: this.checkpointNamespace,
          [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]:
            (this.user ?? this.options.req.user?.id)
              ? checkpointOwnerNamespacePrefix(
                  this.user ?? this.options.req.user?.id,
                  resolveRequestTenantId(this.options.req),
                )
              : undefined,
          ...(this.eventActorCheckpointId == null
            ? {}
            : { checkpoint_id: this.eventActorCheckpointId }),
          ...(this.eventActorInvocationId == null
            ? {}
            : {
                [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: this.eventActorInvocationId,
                [LIBRECHAT_CHECKPOINT_OWNER_KEY]: checkpointOwnerNamespacePrefix(
                  this.options.req.user.id,
                  this.options.req._agentEventBindingTenantId,
                ),
                ...(this.eventActorCheckpointId == null
                  ? {}
                  : { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: this.eventActorCheckpointId }),
                event_actor_invocation_id: this.eventActorInvocationId,
                event_actor_depth: 1,
              }),
          last_agent_index: this.agentConfigs?.size ?? 0,
          user_id: this.user ?? this.options.req.user?.id,
          hide_sequential_outputs: this.options.agent.hide_sequential_outputs,
          requestBody:
            this.options.mcpRequestBody ??
            createMCPRuntimeRequestBody({
              messageId: this.responseMessageId,
              conversationId: this.conversationId,
              parentMessageId: this.parentMessageId,
              codeEnvironmentMode:
                this.options.req.body.codeEnvironmentMode ??
                this.options.req.resolvedConversation?.codeEnvironmentMode,
              codeWorkspaces:
                this.options.req.body.codeWorkspaces ??
                this.options.req.resolvedConversation?.codeWorkspaces,
            }),
          user: createSafeUser(this.options.req.user),
        },
        recursionLimit: resolveRecursionLimit(agentsEConfig, this.options.agent),
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      const toolSet = buildRunToolSet(
        this.options.agent,
        this.agentConfigs?.values(),
        this.options.subagentTasks == null ? undefined : [Constants.CHECK_BACKGROUND_TASK],
        payload,
      );
      const tokenCounter = withRetainedAnswerTokenCounter(
        await createCachedTokenCounter(this.getEncoding()),
        this.getEncoding(),
      );

      /** Pre-resolve invoked skill bodies + re-prime files before formatting messages */
      if (this.eventActorContinuation === 'cold') {
        this.eventActorSkillPrimeResult = undefined;
        this.eventActorDiscoveredToolNames = undefined;
      }
      let skillPrimeResult = this.eventActorSkillPrimeResult;
      if (skillPrimeResult == null) {
        skillPrimeResult = this.options.primeInvokedSkills
          ? await this.options.primeInvokedSkills(payload)
          : undefined;
      }
      this.eventActorSkillPrimeResult = skillPrimeResult;

      /** Seed each reachable agent's trusted code-session partition. */
      const initialSessions = buildInitialToolSessions({
        skillSessions: skillPrimeResult?.initialSessions,
        agents: [this.options.agent, ...(this.agentConfigs ? this.agentConfigs.values() : [])],
      });

      /**
       * Reconstruct `reasoning_content` on prior tool-call turns: DeepSeek
       * thinking-mode (#13366) or custom endpoints opting in via
       * `customParams.includeReasoningHistory` (e.g. Xiaomi MiMo, Kimi).
       * Walks subagents too — the opted-in endpoint may appear only as a
       * nested subagent, not the primary or a top-level handoff agent.
       */
      const needsReasoningContentFormat = anyAgentReplaysReasoningContent([
        this.options.agent,
        ...(this.agentConfigs ? Array.from(this.agentConfigs.values()) : []),
      ]);
      /**
       * Skills primed fresh this turn — manual ($ popover) and always-apply
       * (frontmatter). `injectSkillPrimes` (below) splices their SKILL.md
       * bodies in, so `formatAgentMessages` must NOT also reconstruct the
       * same names from a historical `skill` tool_call — otherwise the body
       * lands twice and a prompt-cache marker can pin to the duplicated
       * synthetic prefix. Names NOT primed this turn still reconstruct from
       * history, preserving sticky manual re-priming across turns.
       */
      /** A compaction summarizes what was already said. No user turn was
       *  submitted, so it primes no skills into the transcript it is about
       *  to summarize and runs no memory pass over it. */
      const isCompactionTurn = this.isCompactionTurn();
      const manualSkillPrimes = isCompactionTurn
        ? undefined
        : this.options.agent?.manualSkillPrimes;
      const alwaysApplySkillPrimes = isCompactionTurn
        ? undefined
        : this.options.agent?.alwaysApplySkillPrimes;
      const freshSkillPrimeNames = collectFreshSkillPrimeNames({
        manualSkillPrimes,
        alwaysApplySkillPrimes,
      });
      const useLegacyContent = this.options.agent?.useLegacyContent === true;
      const reachableAgents = collectReachableAgents([
        this.options.agent,
        ...(this.agentConfigs?.values() ?? []),
      ]);
      const messageFormatOptions = {
        ...(needsReasoningContentFormat ? { preserveReasoningContent: true } : {}),
        ...(freshSkillPrimeNames.size > 0 ? { skipSkillBodyNames: freshSkillPrimeNames } : {}),
        ...(useLegacyContent ? { legacyContent: true } : {}),
      };
      const semanticIntentToolNames = new Set();
      const semanticIntentBlockedToolNames = new Set();
      for (const agent of reachableAgents) {
        for (const toolName of agent.semanticIntentToolNames ?? []) {
          semanticIntentToolNames.add(toolName);
        }
        for (const toolName of agent.semanticIntentBlockedToolNames ?? []) {
          semanticIntentBlockedToolNames.add(toolName);
        }
      }
      for (const toolName of semanticIntentBlockedToolNames) {
        semanticIntentToolNames.delete(toolName);
      }
      const hasMessageFormatOptions =
        needsReasoningContentFormat || freshSkillPrimeNames.size > 0 || useLegacyContent;
      const formatOptions = {
        ...messageFormatOptions,
        compactionSemanticIndex: {
          ...(this.eventActorContinuation === 'warm' && this.compactionSemanticIndexSnapshot != null
            ? { baseSnapshot: this.compactionSemanticIndexSnapshot }
            : {}),
          intentToolNames: semanticIntentToolNames,
        },
      };
      /** The payload reached here already free of unusable summary parts:
       *  `buildMessages` drops them from each prompt copy before counting it,
       *  so the formatter's summary scan cannot take a failed round's prefix as
       *  the history boundary and every count describes what is sent. */
      let {
        messages: initialMessages,
        indexTokenCountMap,
        summary: initialSummary,
        boundaryTokenAdjustment,
        compactionSemanticIndexSnapshot,
      } = formatAgentMessages(
        payload,
        this.indexTokenCountMap,
        toolSet,
        skillPrimeResult?.skills,
        formatOptions,
      );
      if (this.eventActorContinuation !== 'warm') {
        this.eventActorSummary = initialSummary;
      }
      this.compactionSemanticIndexSnapshot =
        compactionSemanticIndexSnapshot ??
        (this.eventActorContinuation === 'warm' ? this.compactionSemanticIndexSnapshot : undefined);
      const continuationSummary =
        this.eventActorContinuation === 'warm' ? this.eventActorSummary : initialSummary;
      const continuationCompactionSemanticIndex = this.compactionSemanticIndexSnapshot?.entries;
      if (boundaryTokenAdjustment) {
        logger.debug(
          `[AgentClient] Boundary token adjustment: ${boundaryTokenAdjustment.original} → ${boundaryTokenAdjustment.adjusted} (${boundaryTokenAdjustment.remainingChars}/${boundaryTokenAdjustment.totalChars} chars)`,
        );
      }

      /**
       * Skill priming — both manual ($ popover) and always-apply (frontmatter).
       *
       * Splice + index-shift logic lives in `injectSkillPrimes`
       * (packages/api/src/agents/skills.ts) so the delicate position math
       * can be unit-tested in TS without standing up AgentClient. The
       * resolver enforces a combined ceiling (manual-first, always-apply
       * truncated first when over cap) before reaching here; the splice
       * re-applies the cap as defense-in-depth. Runs for both single-
       * agent and multi-agent runs; how primes interact with handoff /
       * added-convo agents' per-agent state is an agents-SDK concern,
       * not this layer's to gate.
       *
       * `manualSkillPrimes` / `alwaysApplySkillPrimes` are resolved above
       * (used to build `freshSkillPrimeNames` for dedupe against historical
       * skill reconstruction).
       */
      if (
        (manualSkillPrimes && manualSkillPrimes.length > 0) ||
        (alwaysApplySkillPrimes && alwaysApplySkillPrimes.length > 0)
      ) {
        const primeResult = injectSkillPrimes({
          initialMessages,
          indexTokenCountMap,
          manualSkillPrimes,
          alwaysApplySkillPrimes,
        });
        indexTokenCountMap = primeResult.indexTokenCountMap;
        if (primeResult.inserted > 0) {
          logger.debug(
            `[AgentClient] Primed ${primeResult.inserted} skill(s) at message index ${primeResult.insertIdx} ` +
              `(${manualSkillPrimes?.length ?? 0} manual, ${alwaysApplySkillPrimes?.length ?? 0} always-apply)`,
          );
        }
        if (primeResult.alwaysApplyDropped > 0) {
          logger.warn(
            `[AgentClient] Dropped ${primeResult.alwaysApplyDropped} always-apply prime(s) to stay within MAX_PRIMED_SKILLS_PER_TURN.`,
          );
        }
      }

      assertModelBoundContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters: appConfig?.filters,
        legacyPii: appConfig?.messageFilter?.pii,
        agents: reachableAgents,
        skills: [...(manualSkillPrimes ?? []), ...(alwaysApplySkillPrimes ?? [])],
        memories: this.modelBoundMemoryContexts,
        files: this.modelBoundFileContexts,
      });

      if (indexTokenCountMap && isEnabled(process.env.AGENT_DEBUG_LOGGING)) {
        const entries = Object.entries(indexTokenCountMap);
        const perMsg = entries.map(([idx, count]) => {
          const msg = initialMessages[Number(idx)];
          const type = msg ? msg._getType() : '?';
          return `${idx}:${type}=${count}`;
        });
        logger.debug(
          `[AgentClient] Token map after format: [${perMsg.join(', ')}] (payload=${payload.length}, formatted=${initialMessages.length})`,
        );
      }
      indexTokenCountMap = hydrateMissingIndexTokenCounts({
        messages: initialMessages,
        indexTokenCountMap,
        tokenCounter,
      });

      const memorySourceMessages = initialMessages;
      ({ messages: initialMessages, indexTokenCountMap } = applyRetainedAnswers({
        block: this.retainedAnswers?.block,
        messages: initialMessages,
        indexTokenCountMap,
        tokenCounter,
      }));

      const memoryMessages =
        this.processMemory && this.memoryPayload && !isCompactionTurn
          ? formatAgentMessages(
              stripUnusableSummaryParts(stripActivityLabelParts(this.memoryPayload)),
              undefined,
              toolSet,
              skillPrimeResult?.skills,
              hasMessageFormatOptions ? messageFormatOptions : undefined,
            ).messages
          : memorySourceMessages;

      /**
       * @param {BaseMessage[]} messages
       */
      const runAgents = async (messages) => {
        const agents = [this.options.agent];
        // Include additional agents when:
        // - agentConfigs has agents (from addedConvo parallel execution or agent handoffs)
        // - Agents without incoming edges become start nodes and run in parallel automatically
        if (this.agentConfigs && this.agentConfigs.size > 0) {
          agents.push(...this.agentConfigs.values());
        }
        const modelBoundCallback =
          AgentClient.prototype.createModelBoundChatModelCallback.call(this);
        const initialModelBoundAdmission =
          AgentClient.prototype.createInitialModelBoundAdmissionCallback.call(
            this,
            AgentClient.getStartingAgentIds(agents),
          );
        if (initialModelBoundAdmission != null) {
          config.callbacks = [initialModelBoundAdmission];
        }

        // TODO: needs to be added as part of AgentContext initialization
        // const noSystemModelRegex = [/\b(o1-preview|o1-mini|amazon\.titan-text)\b/gi];
        // const noSystemMessages = noSystemModelRegex.some((regex) =>
        //   agent.model_parameters.model.match(regex),
        // );
        // if (noSystemMessages === true && systemContent?.length) {
        //   const latestMessageContent = _messages.pop().content;
        //   if (typeof latestMessageContent !== 'string') {
        //     latestMessageContent[0].text = [systemContent, latestMessageContent[0].text].join('\n');
        //     _messages.push(new HumanMessage({ content: latestMessageContent }));
        //   } else {
        //     const text = [systemContent, latestMessageContent].join('\n');
        //     _messages.push(new HumanMessage(text));
        //   }
        // }
        // let messages = _messages;
        // if (agent.useLegacyContent === true) {
        //   messages = formatContentStrings(messages);
        // }
        // if (
        //   agent.model_parameters?.clientOptions?.defaultHeaders?.['anthropic-beta']?.includes(
        //     'prompt-caching',
        //   )
        // ) {
        //   messages = addCacheControl(messages);
        // }

        if (this.processMemory && !isCompactionTurn) {
          memoryPromise = this.runMemory(memoryMessages);
        }

        const { calibrationRatio, fadingTier, fadingTiers } = resolveRunSeeds(this);

        const streamId = this.options.req?._resumableStreamId;
        // HITL: establish an empty checkpoint barrier for THIS immutable generation
        // before exposing its graph. A retried/recovered initialization may have left
        // partial state in the same saver scope; a predecessor uses a different scope,
        // so even a late remote write cannot be rehydrated or deleted here. No-op when
        // HITL is off or the generation has no remnants. Deliberately unconditional
        // per HITL turn: any cheaper Redis flag can go stale across replicas/restarts,
        // while these are two indexed, usually-empty deleteMany operations.
        // Mirror createRun's checkpointer attachment gate. This is deliberately
        // broader than pause admission: retries must prune remnants even when a
        // policy or request hook changed from pausing to non-pausing.
        //
        // Start the prune alongside graph construction. The all-settled barrier
        // below still guarantees it completes before the graph is exposed or run.
        const shouldPruneCheckpoint =
          streamId && this.eventActorInvocationId == null && runUsesCheckpointer;
        let checkpointPrunePromise = Promise.resolve();
        if (shouldPruneCheckpoint && this.checkpointNamespace !== '') {
          checkpointPrunePromise = deleteAgentCheckpoint(
            this.conversationId,
            agentsEConfig?.checkpointer,
            undefined,
            {
              throwOnError: true,
              checkpointNamespace: this.checkpointNamespace,
            },
          );
        } else if (shouldPruneCheckpoint) {
          checkpointPrunePromise = captureAgentCheckpointGeneration(
            this.conversationId,
            agentsEConfig?.checkpointer,
            { throwOnError: true },
          ).then(async (checkpointGeneration) => {
            /** Legacy jobs share LangGraph's root/nested namespaces. Capture
             * their immutable ids first, then prove this client still owns
             * the exact job epoch before deleting that set. If a replacement
             * arrived before/during capture the check fails; if it arrives
             * after the check, its newly-written checkpoint ids are outside
             * the snapshot and therefore cannot be deleted. */
            const liveJob = await GenerationJobManager.getJobStore().getJob(streamId);
            if (
              !liveJob ||
              liveJob.createdAt !== this.jobCreatedAt ||
              liveJob.status !== 'running'
            ) {
              throw new Error('Generation replaced before legacy checkpoint cleanup');
            }
            await deleteAgentCheckpoint(
              this.conversationId,
              agentsEConfig?.checkpointer,
              checkpointGeneration,
              { throwOnError: true },
            );
          });
        }

        const activityLabel = this.buildActivityLabelWiring(streamId, abortController.signal);
        const activityPhase = this.buildActivityPhaseWiring(streamId, abortController.signal);
        const reasoningLabel = this.buildReasoningLabelWiring(streamId, abortController.signal);
        const offsetHandlers = createSteerIndexOffsetHandlers(
          this.options.eventHandlers,
          this.steerOffsetState,
        );
        const activityHandlers =
          activityPhase?.handlers(offsetHandlers) ??
          (activityLabel ? createAssistantPhaseStampingHandlers(offsetHandlers) : offsetHandlers);
        const createRunPromise = createRun({
          agents,
          // Conversation-stable identity for the e2e run hook; a resumed run
          // carries no messages, so history cannot identify the conversation.
          conversationId: this.conversationId,
          messages,
          discoveredToolNames:
            this.eventActorContinuation === 'warm' ? this.eventActorDiscoveredToolNames : undefined,
          modelCallbacks: [
            modelBoundCallback,
            createAgentMemoryCallback(this.attachmentMemoryContext ?? {}),
            terminalRunError.modelCallback,
          ],
          // This controller implements the full HITL pause/resume lifecycle (handleRunInterrupt
          // persists the pending action; the /resume route rebuilds + continues the run), so it
          // opts into the tool-approval wiring. Non-resumable callers (OpenAI-compat, Responses)
          // leave this off so an approval-gated tool can't pause where there's no resume path.
          hitlCapable: true,
          resolvedToolApprovalHooks,
          toolInputValidationErrors: this.toolInputValidationErrors,
          // Mid-run steering: drain queued user messages at each tool-batch
          // boundary and inject them into graph state. The offset wrapper
          // shifts SDK content indices past any spliced steer parts.
          steering: this.buildSteerWiring(streamId),
          activityLabel,
          activityPhase,
          eventActorCheckpointing: this.eventActorInvocationId != null,
          // The token map is positional over the DB-derived history. A warm
          // continuation runs on checkpoint-restored state (restored messages
          // plus the one new event), so those indices address different
          // messages and the pruner would never recount them. Hand it an empty
          // map so every count is derived from the messages actually in state.
          // The active summary lives in AgentContext rather than checkpointed
          // graph messages, so warm turns restore the actor-head copy while
          // rebuilt turns use the summary reconstructed from durable history.
          indexTokenCountMap: this.eventActorContinuation === 'warm' ? {} : indexTokenCountMap,
          initialSummary: continuationSummary,
          ...(continuationCompactionSemanticIndex == null
            ? {}
            : { compactionSemanticIndex: continuationCompactionSemanticIndex }),
          initialSessions,
          calibrationRatio,
          fadingTier,
          fadingTiers,
          runId: this.responseMessageId,
          signal: abortController.signal,
          /** The phase wrapper stays outermost: it claims and offsets the
           *  parent slot before the text step reaches the normal handlers. */
          customHandlers: reasoningLabel?.handlers(activityHandlers) ?? activityHandlers,
          requestBody: config.configurable.requestBody,
          codeApprovalMode,
          user: createSafeUser(this.options.req?.user),
          traceContext: buildTraceContext(this.options),
          tenantId: resolveRequestTenantId(this.options.req ?? {}),
          summarizationConfig: appConfig?.summarization,
          summarizeOnly: this.isCompactionTurn(),
          appConfig,
          tokenCounter,
          /** Bills subagent child-run model calls — foreground usage joins
           *  the parent batch, while detached usage is recorded per call and
           *  persisted with its child result because it may outlive this turn.
           *  The sink also streams each as an `on_token_usage` event so the
           *  gauge's session cost/totals include billed subagent usage (the
           *  `subagent` tag keeps it out of the live context meter). */
          subagentUsageSink: createSubagentUsageSink(
            this.collectedUsage,
            this.buildSubagentUsageEmitter(appConfig),
            this.buildDetachedSubagentUsageRecorder(balanceConfig, transactionsConfig),
          ),
          subagentTasks: this.options.subagentTasks,
          runFiles: this.options.runFiles,
        }).then((createdRun) => {
          if (!createdRun) {
            throw new Error('Failed to create run');
          }
          this.options.startupTelemetry?.mark('run_created');
          return createdRun;
        });

        const [createRunResult, checkpointPruneResult] = await Promise.allSettled([
          createRunPromise,
          checkpointPrunePromise,
        ]);
        if (createRunResult.status === 'rejected') {
          throw createRunResult.reason;
        }
        if (checkpointPruneResult.status === 'rejected') {
          throw checkpointPruneResult.reason;
        }
        run = createRunResult.value;

        this.run = run;
        if (this._resolveRun) {
          this._resolveRun(run);
          this._resolveRun = null;
        }

        if (streamId && run.Graph) {
          GenerationJobManager.setGraph(streamId, run.Graph, this.jobCreatedAt);
        }

        if (userMCPAuthMap != null) {
          config.configurable.userMCPAuthMap = userMCPAuthMap;
        }

        /** @deprecated Agent Chain */
        config.configurable.last_agent_id = agents[agents.length - 1].id;

        this.options.startupTelemetry?.mark('stream_processing_started');
        /** Flag durable BEFORE the run can claim a label: gap reconciliation
         *  is gated on it, and ordering it here (one settled-on-failure
         *  await) keeps the claim-time reservation emit immediate — see
         *  `emitLabelEvent` in buildActivityLabelWiring. */
        if (this.activityLabelsMarkedPromise != null) {
          await this.activityLabelsMarkedPromise;
        }
        /** The inherited tier must be on the job before any Stop can read it. */
        await this.publishRunContextMeta?.();
        try {
          const invocationMessages = await prepareRetainedAnswerInvocationMessages(
            messages,
            this.eventActorContinuation === 'warm',
            () => run.graphRunnable.getState(config),
          );
          await run.processStream({ messages: invocationMessages }, config, {
            callbacks: {
              [Callback.TOOL_ERROR]: logToolError,
            },
          });
        } finally {
          reasoningLabel?.complete();
        }
        this.completeActivityPhase(run, activityPhase);

        // HITL: if the run paused for tool approval, mark the job
        // `requires_action` + emit the prompt and leave the turn unfinalized
        // (the resume route continues it). No-op when the run completed.
        await this.handleRunInterrupt(run, streamId);

        config.signal = null;
      };

      this.options.startupTelemetry?.mark('run_input_prepared');
      await runAgents(initialMessages);

      /**
       * Surface a completed `skill` tool_call content part per *manually*-
       * primed skill so the existing `SkillCall` frontend renderer shows
       * a "Skill X loaded" card on the assistant response. Applied after
       * the graph finishes to avoid clashing with the aggregator's own
       * per-step content indexing. Prepended (not appended) so cards sit
       * above the model's output — priming ran before the turn, the
       * reply follows.
       *
       * Always-apply primes intentionally do NOT emit assistant-side
       * cards. `extractInvokedSkillsFromPayload` scans history for
       * `skill` tool_calls and feeds `primeInvokedSkills`, which is
       * Phase 3's sticky-re-prime path — that's the right behavior for
       * manual (user picked `$skill` once; re-prime on every subsequent
       * turn from history). For always-apply, `resolveAlwaysApplySkills`
       * already re-primes every turn from fresh DB state, so persisting
       * the card would cause the skill body to get primed twice per
       * turn starting on turn 2. The user-facing acknowledgement for
       * always-apply lives on the user bubble as the pinned
       * `SkillPills` row (`message.alwaysAppliedSkills`), which
       * is the durable signal the user wants: "this skill auto-primes".
       *
       * Live streaming display of manual user-bubble pills is handled
       * by `SkillPills` reading `message.manualSkills`. No
       * separate SSE emit is needed here; trying to stream a mid-run
       * tool_call at index 0 collided with the LLM's first text
       * content, while emitting at a sparse offset pushed the card
       * below the reply on finalize. Post-run unshift keeps the final
       * responseMessage.content in the right order.
       */
      /**
       * Settle in-flight label fills BEFORE the content is reshaped below.
       * A fill emits its claim-time index; the skill-card unshift and the
       * hide-sequential filter both shift positions, so a fill landing after
       * either would emit a stale index — and a client that already synced
       * the reshaped array applies it onto the wrong part. A paused turn
       * never gets a final event to repair that. Costs nothing extra: these
       * are the same promises the finalization settle would wait on, and
       * that later call then sees an empty pending list.
       */
      await this.settleActivityLabels();

      const contentBeforeReshape = [...this.contentParts];
      const manualPrimed = this.options.agent?.manualSkillPrimes ?? [];
      if (manualPrimed.length > 0) {
        const runId = this.responseMessageId ?? 'skill-prime';
        const manualParts = buildSkillPrimeContentParts(manualPrimed, { runId });
        this.contentParts.unshift(...manualParts);
      }

      /** Summaries are run state, even when sequential-output reshaping hides
       * their display block from the persisted response content. */
      this.eventActorSummary =
        getLatestEventActorSummary(this.contentParts) ?? this.eventActorSummary;
      this.applyHideSequentialOutputsFilter();
      this.rebaseActivityPhaseBounds(contentBeforeReshape);
    } catch (err) {
      if (
        err?.code === 'SCHEDULED_HITL_REQUIRES_SHARED_STORE' ||
        err?.code === 'SCHEDULED_HITL_REQUIRES_DURABLE_CHECKPOINT' ||
        err?.code === 'HITL_CHECKPOINT_UNAVAILABLE' ||
        err?.code === PENDING_ACTION_EXPIRED_CODE
      ) {
        logger.warn(`[api/server/controllers/agents/client.js #sendCompletion] ${err.message}`);
        throw err;
      }
      if (isContentFilterError(err)) {
        logger.warn(
          '[api/server/controllers/agents/client.js #sendCompletion] Blocked by content policy',
          {
            source: err?.body?.source,
            field: err?.body?.field,
            code: err?.code,
          },
        );
        throw err;
      }
      if (isAgentAttachmentLimitError(err) || isAttachmentObjectNotFoundError(err)) {
        logger.warn(
          '[api/server/controllers/agents/client.js #sendCompletion] Attachment rejected',
          {
            conversationId: this.conversationId,
            ...getSafeErrorMetadata(err),
          },
        );
        BaseClient.prototype.getModelBoundUserMessagePersistence.call(this)?.cancel();
        this.options.attachments = [];
        this.modelBoundCurrentFiles = [];
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: err.message,
        });
      } else if (isAgentRunCancellation(err, abortController.signal)) {
        logger.debug(
          '[api/server/controllers/agents/client.js #sendCompletion] Operation aborted by user',
          { conversationId: this.conversationId, ...getSafeErrorMetadata(err) },
        );
      } else if (isStepLimitError(err)) {
        /**
         * The graph ran out of supersteps. Everything already streamed is real work,
         * so this terminates the turn as incomplete rather than failed: no ERROR part,
         * and `request.js` persists the row `unfinished` with the tool-call-limit
         * finish reason so the UI can offer to continue. Mirrors the abort contract:
         * a turn that stopped early is not a turn that broke.
         */
        this.stepLimitReached = true;
        logger.warn(
          '[api/server/controllers/agents/client.js #sendCompletion] Tool call limit reached; ending the turn as incomplete',
          {
            conversationId: this.conversationId,
            recursionLimit: resolveRecursionLimit(
              this.options.req.config?.endpoints?.[EModelEndpoint.agents],
              this.options.agent,
            ),
          },
        );
      } else {
        terminalRunError.log(err, abortController.signal);
        const videoError = resolveGoogleVideoError({
          error: err,
          provider: this.options.agent?.provider,
          hasYouTubeVideo: this.injectedYouTubeVideo,
        });
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]:
            videoError ??
            terminalRunError.getUserFacingError(err, () =>
              getUserFacingRequestError(
                'An error occurred while processing the request',
                err,
                this.options.req.config,
              ),
            ),
        });
      }
    } finally {
      /** An aborted/erroring run can still have completed compaction before
       * the failure; retain that model-visible state for actor reconciliation. */
      await this.options.runFiles?.close();
      this.eventActorSummary =
        getLatestEventActorSummary(this.contentParts) ?? this.eventActorSummary;
      /** A run that never came to exist has no state of its own: keep the
       * inherited meta so the persisted error response still seeds the next
       * turn. A created run's neutral state may still clear it. */
      this.contextMeta = this.run == null ? this.contextMeta : captureRunContextMeta(this);

      this.finalizeSubagentContent();
      this.stampMcpServerIdentities();
      await this.settleActivityLabels();

      /** Flush subagent usage emits the sink fired without awaiting, so their
       *  persist/publish completes before we return and the job is cleaned up
       *  (resumed clients read this persisted usage). */
      if (this.pendingSubagentEmits.length > 0) {
        await Promise.allSettled(this.pendingSubagentEmits);
        this.pendingSubagentEmits = [];
      }

      try {
        const attachments = await this.awaitMemoryWithTimeout(memoryPromise);
        if (attachments && attachments.length > 0) {
          this.artifactPromises.push(...attachments);
        }

        /** The run owns its usage even when stopped: `/api/agents/chat/abort`
         *  only signals the abort, so nothing else records what was consumed.
         *  A stopped turn is labelled as such on its transactions. */
        await this.recordCollectedUsage({
          context: resolveRunUsageContext(abortController?.signal?.aborted === true),
          balance: balanceConfig,
          transactions: transactionsConfig,
        });
      } catch (err) {
        logger.error(
          '[api/server/controllers/agents/client.js #chatCompletion] Error in cleanup phase',
          getSafeErrorMetadata(err),
        );
      }
      if (this._resolveRun) {
        this._resolveRun(this.run ?? null);
        this._resolveRun = null;
      }

      // HITL: a non-paused turn deliberately prunes nothing here. The lazy checkpointer
      // (LazyMongoSaver) never persists a clean-exit checkpoint, so there is
      // nothing this turn left to delete. Terminal HITL owners eagerly delete their exact
      // saver scope, with the Mongo TTL as the backstop for a crashed owner. Dropping a
      // generic post-completion prune also removes its
      // job-replacement race: an older run's late finally can no longer delete a newer
      // paused run's checkpoint, because there is no longer a clean-path prune to race.

      run = null;
      config = null;
      memoryPromise = null;
    }
  }

  /**
   * Resume a run that paused for human-in-the-loop review.
   *
   * The original run lives in a detached background task that exits when the run
   * pauses, so resume REBUILDS the run on a fresh graph bound to the same
   * `thread_id` (= conversationId), immutable saver scope, and durable checkpointer.
   * LangGraph rehydrates the paused graph state from that scoped checkpoint;
   * `run.resume(value)` re-enters the interrupted node with the user's decision.
   * State comes from the checkpoint, so no message history is rebuilt here —
   * `createRun` only needs the agent(s) to reconstruct the graph structure.
   *
   * `seedContent` is the content streamed before the pause (the assistant message +
   * its tool call). In Redis mode the job store's append log already spans the pause,
   * so the finalized message is complete regardless; seeding keeps the in-memory store
   * complete too. The run drives events through the same `streamId`, so the client's
   * open SSE receives the continuation live.
   *
   * Unlike `chatCompletion`, this does NOT prune the checkpoint in its `finally` — the
   * resume controller owns checkpoint lifecycle (it must also clean up on failures that
   * happen before this method runs, and keep the checkpoint on a re-pause).
   *
   * @param {object} params
   * @param {Agents.ToolApprovalDecisionMap | { answer: string }} params.resumeValue
   * @param {Array} [params.seedContent] - content aggregated before the pause
   * @param {Array<import('@librechat/agents').RunStep>} [params.runSteps] - run steps emitted before the pause
   * @param {import('@librechat/api').ActivityPhaseSnapshot} [params.activityPhaseSnapshot]
   * @param {import('@librechat/data-schemas').ICompactionSemanticIndexProjection} [params.compactionSemanticIndex]
   * @param {Array} [params.storedMessages] - persisted user messages restored for the resume
   * @param {AbortController} [params.abortController]
   * @param {Pick<import('@langchain/langgraph').Command, 'update' | 'goto'>} [params.commandOptions]
   */
  async resumeCompletion({
    resumeValue,
    seedContent = [],
    runSteps = [],
    storedMessages = [],
    abortController = null,
    commandOptions,
    userMCPAuthMap,
    discoveredToolNames,
    activityPhaseSnapshot,
    compactionSemanticIndex,
  }) {
    /** The seeded state is on the job before the run is rebuilt, so a Stop
     * during rebuild still persists it onto the stopped response. */
    await this.publishRunContextMeta?.();
    /** @type {Partial<GraphRunnableConfig>} */
    let config;
    /** @type {ReturnType<createRun>} */
    let run;
    const appConfig = this.options.req.config;
    const terminalRunError = createTerminalRunErrorObserver({
      maxProviderErrorChars: appConfig?.endpoints?.agents?.maxProviderErrorChars,
      logger,
      responseMessageId: this.responseMessageId,
      source: '[api/server/controllers/agents/client.js #resumeCompletion]',
      genericMessage: '[api/server/controllers/agents/client.js #resumeCompletion] Unhandled error',
      protectionEnabled: hasModelBoundContentProtection(
        appConfig?.filters,
        appConfig?.messageFilter?.pii,
      ),
    });
    const balanceConfig = getBalanceConfig(appConfig);
    const transactionsConfig = getTransactionsConfig(appConfig);
    try {
      if (!abortController) {
        abortController = new AbortController();
      }

      /** @type {AppConfig['endpoints']['agents']} */
      const agentsEConfig = appConfig.endpoints?.[EModelEndpoint.agents];
      const resolvedToolApprovalHooks = isHITLEnabled(agentsEConfig?.toolApproval)
        ? buildToolApprovalHooks({
            userId: this.options.req?.user?.id,
            conversationId: this.conversationId,
            tenantId: resolveRequestTenantId(this.options.req ?? {}),
            appConfig,
          })
        : undefined;

      BaseClient.prototype.setModelBoundStoredMessages.call(
        this,
        BaseClient.prototype.getModelBoundStoredMessages.call(this, storedMessages),
      );

      config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: this.conversationId,
          ...buildToolApprovalExecutionConfig(this.responseMessageId, this.jobCreatedAt),
          checkpoint_ns: '',
          [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: this.checkpointNamespace,
          [LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY]:
            (this.user ?? this.options.req.user?.id)
              ? checkpointOwnerNamespacePrefix(
                  this.user ?? this.options.req.user?.id,
                  resolveRequestTenantId(this.options.req),
                )
              : undefined,
          last_agent_index: this.agentConfigs?.size ?? 0,
          user_id: this.user ?? this.options.req.user?.id,
          hide_sequential_outputs: this.options.agent.hide_sequential_outputs,
          requestBody:
            this.options.mcpRequestBody ??
            createMCPRuntimeRequestBody({
              messageId: this.responseMessageId,
              conversationId: this.conversationId,
              parentMessageId: this.parentMessageId,
              codeEnvironmentMode:
                this.options.req.body.codeEnvironmentMode ??
                this.options.req.resolvedConversation?.codeEnvironmentMode,
              codeWorkspaces:
                this.options.req.body.codeWorkspaces ??
                this.options.req.resolvedConversation?.codeWorkspaces,
            }),
          user: createSafeUser(this.options.req.user),
        },
        recursionLimit: resolveRecursionLimit(agentsEConfig, this.options.agent),
        signal: abortController.signal,
        streamMode: 'values',
        version: 'v2',
      };

      // Seed pre-pause content so the in-memory job store reports the complete turn
      // (Redis aggregates across the pause via its append log; this covers in-memory).
      if (Array.isArray(seedContent) && seedContent.length > 0) {
        this.contentParts.push(...seedContent);
      }

      const tokenCounter = withRetainedAnswerTokenCounter(
        await createCachedTokenCounter(this.getEncoding()),
        this.getEncoding(),
      );
      this.compactionSemanticIndexSnapshot =
        restoreCompactionSemanticIndexSnapshot(compactionSemanticIndex);
      const agents = collectReachableAgents([
        this.options.agent,
        ...(this.agentConfigs?.size > 0 ? this.agentConfigs.values() : []),
      ]);
      const dynamicToolContexts = getDynamicToolContexts(agents);
      const liveFiles = Array.isArray(this.options.attachments)
        ? [...this.options.attachments]
        : [];
      const requestFiles = [...liveFiles];
      const modelBoundAgentFiles = [];
      const contextAttachmentLists =
        this.options.agentContextAttachmentsByAgentId instanceof Map
          ? this.options.agentContextAttachmentsByAgentId.values()
          : Object.values(this.options.agentContextAttachmentsByAgentId ?? {});
      for (const attachments of contextAttachmentLists) {
        if (Array.isArray(attachments)) {
          liveFiles.push(...attachments);
          modelBoundAgentFiles.push(...attachments);
        }
      }
      for (const agent of agents) {
        if (Array.isArray(agent?.attachments)) {
          liveFiles.push(...agent.attachments);
          modelBoundAgentFiles.push(...agent.attachments);
        }
        if (Array.isArray(agent?.requestAttachments)) {
          liveFiles.push(...agent.requestAttachments);
          modelBoundAgentFiles.push(...agent.requestAttachments);
        }
        if (Array.isArray(agent?.agentContextAttachments)) {
          liveFiles.push(...agent.agentContextAttachments);
          modelBoundAgentFiles.push(...agent.agentContextAttachments);
        }
      }
      const resumeContentProjection = await assertResumeRuntimeContentAllowed(
        {
          appConfig,
          conversationId: this.conversationId,
          targetMessageId: this.parentMessageId,
          user: this.options.req.user,
          storedMessages,
          seedContent,
          resumeValue,
          liveFiles,
          isTemporary: this.options.req.body?.isTemporary === true,
          checkpointNamespace: this.checkpointNamespace,
          agents,
          files: [...modelBoundAgentFiles, ...dynamicToolContexts],
        },
        {
          getAgentCheckpointer,
          onTraversalFailure: reportLocatorTraversalFailure,
          getMessages: db.getMessages,
          getFiles: db.getFiles,
        },
      );
      this.modelBoundCurrentFiles = [
        ...(Array.isArray(this.modelBoundCurrentFiles) ? this.modelBoundCurrentFiles : []),
        ...resumeContentProjection.resolvedFiles,
      ];
      const checkpointFileIds = collectFileIds(resumeContentProjection.checkpointFiles);
      const resumeSharedFiles = [
        ...resumeContentProjection.checkpointFiles.filter(isModelBoundAttachmentFile),
        ...AgentClient.prototype.getModelBoundAttachmentsForEndpoint
          .call(this, requestFiles)
          .filter((file) => !file?.file_id || !checkpointFileIds.has(file.file_id)),
      ];
      const resumeSharedFileIds = collectFileIds(resumeSharedFiles);
      const resumeEndpointsByAgentId = new Map(
        agents
          .filter((agent) => agent?.id)
          .map((agent) => [
            agent.id,
            {
              endpoint: agent.endpoint,
              endpointType: agent === this.options.agent ? this.options.endpointType : undefined,
            },
          ]),
      );
      const resumeMcpManager = getMCPManager();
      const [resumeScopedContext, resumeConfigServers] = await Promise.all([
        buildAgentScopedContext({
          agentIds: agents.map((agent) => agent?.id).filter(Boolean),
          attachmentsByAgentId: this.options.agentContextAttachmentsByAgentId,
          sharedRunAttachmentIds: resumeSharedFileIds,
          sharedAttachments: resumeSharedFiles,
          req: this.options.req,
          endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
          endpointType: this.options.endpointType,
          endpointsByAgentId: resumeEndpointsByAgentId,
          tokenCountFn: (text) => countTokens(text),
        }),
        resolveConfigServers(this.options.req),
      ]);
      const resumeScopedAttachmentMap = buildAgentScopedAttachmentMap({
        agentIds: agents.map((agent) => agent?.id).filter(Boolean),
        attachmentsByAgentId: this.options.agentContextAttachmentsByAgentId,
        sharedRunAttachmentIds: resumeSharedFileIds,
        req: this.options.req,
        endpoint: this.options.agent?.endpoint ?? this.options.endpoint ?? EModelEndpoint.agents,
        endpointType: this.options.endpointType,
        endpointsByAgentId: resumeEndpointsByAgentId,
      });
      this.turnSharedAttachmentFiles = resumeSharedFiles;
      this.turnAggregateOnlyAttachmentFiles = [];
      this.turnScopedAttachmentsByAgentId = resumeScopedAttachmentMap;
      this.turnAttachmentEndpointsByAgentId = resumeEndpointsByAgentId;
      const resumeScopedAttachments = [...resumeScopedAttachmentMap.values()].flat();
      AgentClient.prototype.assertTurnAttachmentLimits.call(
        this,
        resumeSharedFiles,
        resumeScopedAttachments,
      );
      const resumeAttachmentTelemetryFiles = [...resumeSharedFiles, ...resumeScopedAttachments];
      this.attachmentMemoryContext = {
        req: this.options.req,
        conversationId: this.conversationId,
        messageId: this.responseMessageId,
        attachments: resumeAttachmentTelemetryFiles,
        countRepeatedExtractedText: true,
      };
      await Promise.all(
        agents
          .filter((agent) => agent?.id)
          .map(async (agent) => {
            agent.instructions = agent.instructions?.trim() || undefined;
            agent.additional_instructions = agent.additional_instructions?.trim() || undefined;
            const scopedContext = resumeScopedContext.get(agent.id);
            await applyContextToAgent({
              agent,
              agentId: agent.id,
              logger,
              mcpManager: resumeMcpManager,
              configServers: resumeConfigServers,
              sharedRunContext: scopedContext ?? '',
              ephemeralAgent:
                agent === this.options.agent ? this.options.req.body.ephemeralAgent : undefined,
            });
            assertModelBoundContent({
              onTraversalFailure: reportLocatorTraversalFailure,
              filters: this.options.req.config?.filters,
              legacyPii: this.options.req.config?.messageFilter?.pii,
              agents: [agent],
              files: scopedContext ? [scopedContext] : [],
            });
          }),
      );
      const wrappedResumeLazyDescriptors = new WeakSet();
      const validatedResumeAgents = new WeakSet(agents.filter((agent) => agent != null));
      const wrapResumeLazyAttachmentValidation = (configs) => {
        const pending = [...configs];
        const visitedConfigs = new WeakSet();
        for (let index = 0; index < pending.length; index++) {
          const config = pending[index];
          if (!config || visitedConfigs.has(config)) {
            continue;
          }
          visitedConfigs.add(config);
          pending.push(...(config.subagentAgentConfigs ?? []));
          for (const graph of config.subagentGraphConfigs ?? []) {
            pending.push(...graph.memberConfigs);
          }
          for (const descriptor of config.lazySubagentConfigs ?? []) {
            pending.push(descriptor);
            if (
              wrappedResumeLazyDescriptors.has(descriptor) ||
              typeof descriptor?.resolve !== 'function'
            ) {
              continue;
            }
            wrappedResumeLazyDescriptors.add(descriptor);
            const resolve = descriptor.resolve;
            descriptor.resolve = async (context) => {
              const resolved = await resolve(context);
              const resolvedAgents = collectReachableAgents([resolved]);
              const unvalidatedAgents = resolvedAgents.filter(
                (agent) => agent != null && !validatedResumeAgents.has(agent),
              );
              if (unvalidatedAgents.length === 0) {
                wrapResumeLazyAttachmentValidation(resolvedAgents);
                return resolved;
              }
              const liveResumeSharedFiles = this.turnSharedAttachmentFiles ?? resumeSharedFiles;
              const liveResumeSharedFileIds = collectFileIds(liveResumeSharedFiles);
              const lateAttachmentsByAgentId =
                buildAgentContextAttachmentsByAgentId(unvalidatedAgents);
              const lateEndpointsByAgentId = new Map(
                unvalidatedAgents
                  .filter((agent) => agent?.id)
                  .map((agent) => [agent.id, { endpoint: agent.endpoint }]),
              );
              const lateScopedAttachmentMap = buildAgentScopedAttachmentMap({
                agentIds: unvalidatedAgents.map((agent) => agent?.id).filter(Boolean),
                attachmentsByAgentId: lateAttachmentsByAgentId,
                sharedRunAttachmentIds: liveResumeSharedFileIds,
                req: this.options.req,
                endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
                endpointType: this.options.endpointType,
                endpointsByAgentId: lateEndpointsByAgentId,
              });
              for (const [agentId, attachments] of lateScopedAttachmentMap) {
                this.turnScopedAttachmentsByAgentId.set(agentId, attachments);
              }
              for (const [agentId, agentEndpoint] of lateEndpointsByAgentId) {
                this.turnAttachmentEndpointsByAgentId.set(agentId, agentEndpoint);
              }
              const lateScopedContext = await buildAgentScopedContext({
                agentIds: unvalidatedAgents.map((agent) => agent?.id).filter(Boolean),
                attachmentsByAgentId: lateAttachmentsByAgentId,
                sharedRunAttachmentIds: liveResumeSharedFileIds,
                sharedAttachments: liveResumeSharedFiles,
                req: this.options.req,
                endpoint: this.options.agent?.endpoint ?? this.options.endpoint,
                endpointType: this.options.endpointType,
                endpointsByAgentId: lateEndpointsByAgentId,
                tokenCountFn: (text) => countTokens(text),
              });
              const lateScopedAttachments = [...lateScopedAttachmentMap.values()].flat();
              resumeScopedAttachments.push(...lateScopedAttachments);
              resumeAttachmentTelemetryFiles.push(...lateScopedAttachments);
              AgentClient.prototype.assertTurnAttachmentLimits.call(
                this,
                liveResumeSharedFiles,
                resumeScopedAttachments,
              );
              for (const agent of unvalidatedAgents) {
                agent.instructions = agent.instructions?.trim() || undefined;
                agent.additional_instructions = agent.additional_instructions?.trim() || undefined;
                const scopedContext = lateScopedContext.get(agent.id);
                await applyContextToAgent({
                  agent,
                  agentId: agent.id,
                  logger,
                  mcpManager: resumeMcpManager,
                  configServers: resumeConfigServers,
                  sharedRunContext: scopedContext ?? '',
                });
                assertModelBoundContent({
                  onTraversalFailure: reportLocatorTraversalFailure,
                  filters: this.options.req.config?.filters,
                  legacyPii: this.options.req.config?.messageFilter?.pii,
                  agents: [agent],
                  files: scopedContext ? [scopedContext] : [],
                });
                validatedResumeAgents.add(agent);
              }
              wrapResumeLazyAttachmentValidation(resolvedAgents);
              return resolved;
            };
          }
        }
      };
      wrapResumeLazyAttachmentValidation(agents);
      const modelBoundCallback = AgentClient.prototype.createModelBoundChatModelCallback.call(this);
      const attachmentMemoryCallback = createAgentMemoryCallback(this.attachmentMemoryContext);

      // Re-prime skill files invoked in the pre-pause segment (mirrors the normal path's
      // `primeInvokedSkills(payload)`), so an approved code/file-backed tool keeps the
      // injected skill-file session refs instead of running without them. The pre-pause
      // content carries the `skill` tool_calls, so it stands in for the message payload.
      let skillSessions;
      if (
        typeof this.options.primeInvokedSkills === 'function' &&
        Array.isArray(seedContent) &&
        seedContent.length > 0
      ) {
        try {
          const primed = await this.options.primeInvokedSkills([
            { role: 'assistant', content: seedContent },
          ]);
          skillSessions = primed?.initialSessions;
        } catch (err) {
          if (isContentFilterError(err)) {
            throw err;
          }
          logger.warn(
            '[api/server/controllers/agents/client.js #resumeCompletion] Failed to re-prime skill sessions',
            getSafeErrorMetadata(err),
          );
        }
      }

      // Seed code-env / skill tool sessions so an approved code/file/skill-backed tool
      // runs with the same uploaded-file context the pre-pause run had — the rebuilt
      // graph otherwise has no `Graph.sessions` entries (especially cross-replica).
      const initialSessions = buildInitialToolSessions({ skillSessions, agents });

      const streamId = this.options.req?._resumableStreamId;
      const activityLabel = this.buildActivityLabelWiring(streamId, abortController.signal);
      const activityPhase = this.buildActivityPhaseWiring(
        streamId,
        abortController.signal,
        activityPhaseSnapshot,
      );
      const reasoningLabel = this.buildReasoningLabelWiring(streamId, abortController.signal, true);
      const offsetHandlers = createSteerIndexOffsetHandlers(
        createContentIndexOffsetHandlers(
          this.options.eventHandlers,
          Array.isArray(seedContent) ? seedContent : [],
        ),
        this.steerOffsetState,
      );
      const activityHandlers =
        activityPhase?.handlers(offsetHandlers) ??
        (activityLabel ? createAssistantPhaseStampingHandlers(offsetHandlers) : offsetHandlers);
      run = await createRun({
        agents,
        conversationId: this.conversationId,
        modelCallbacks: [
          modelBoundCallback,
          attachmentMemoryCallback,
          terminalRunError.modelCallback,
        ],
        // State (messages, tool calls) is rehydrated from the checkpoint by
        // run.resume; createRun only needs the agents to rebuild the graph.
        messages: [],
        // The resumed run can pause AGAIN (another tool, a follow-up question), and this
        // controller owns that lifecycle, so it must keep the HITL wiring on the rebuilt run.
        hitlCapable: true,
        resolvedToolApprovalHooks,
        // Plugin SessionStart hooks match on the lifecycle source; a rebuilt run is a
        // resume, not a fresh startup.
        sessionStartSource: 'resume',
        toolInputValidationErrors: this.toolInputValidationErrors,
        // Steering stays live across a pause/resume cycle: steers queued while
        // the resumed segment runs drain at its tool-batch boundaries.
        steering: this.buildSteerWiring(streamId),
        // Activity labels likewise survive pause/resume: post-resume tool
        // batches keep claiming slots and generating group headers.
        activityLabel,
        activityPhase,
        ...(this.compactionSemanticIndexSnapshot == null
          ? {}
          : { compactionSemanticIndex: this.compactionSemanticIndexSnapshot.entries }),
        // Replay deferred tools discovered before the pause. With `messages: []` the
        // discovery scan finds nothing, so these names restore the schemas to the
        // rebuilt model binding. Undefined/empty for non-deferred turns is a no-op.
        discoveredToolNames,
        initialSessions,
        ...resolveRunSeeds(this),
        runId: this.responseMessageId,
        signal: abortController.signal,
        // The rebuilt graph numbers content indices from 0, but the aggregator was
        // just seeded with the pre-pause parts at those same indices — shift every
        // resumed step index past the seed, or the new output merges into (or, on a
        // type mismatch, is silently dropped against) the pre-pause content. The
        // steer wrapper composes on top: resumed indices shift by seed + any
        // steer parts spliced in while the resumed segment streams.
        customHandlers: reasoningLabel?.handlers(activityHandlers) ?? activityHandlers,
        requestBody: config.configurable.requestBody,
        codeApprovalMode: this.options.req.body.codeApprovalMode,
        user: createSafeUser(this.options.req?.user),
        traceContext: buildTraceContext(this.options),
        tenantId: resolveRequestTenantId(this.options.req ?? {}),
        summarizationConfig: appConfig?.summarization,
        appConfig,
        tokenCounter,
        subagentUsageSink: createSubagentUsageSink(
          this.collectedUsage,
          this.buildSubagentUsageEmitter(appConfig),
          this.buildDetachedSubagentUsageRecorder(balanceConfig, transactionsConfig),
        ),
        subagentTasks: this.options.subagentTasks,
        runFiles: this.options.runFiles,
      });

      if (!run) {
        throw new Error('Failed to create run for resume');
      }

      hydrateResumeRunSteps(runSteps, this.stepMap, run.Graph, seedContent);

      this.run = run;
      if (this._resolveRun) {
        this._resolveRun(run);
        this._resolveRun = null;
      }

      // Do NOT cache the rebuilt graph on resume: it was created with `messages: []`, so
      // RedisJobStore.getContentParts() (which prefers a cached graph over reconstructing
      // from the chunk log) would return only the resumed segment and drop the pre-pause
      // assistant/tool-call content on a same-replica reload/status poll. Skipping it makes
      // introspection fall back to the durable chunk reconstruction, which is complete.
      // `setContentParts` still points the in-memory store at the seeded client content.
      if (streamId && this.contentParts) {
        GenerationJobManager.setContentParts(streamId, this.contentParts, this.jobCreatedAt);
      }

      // Carry the user's MCP auth into the rebuilt run so an approved MCP tool executes
      // with the same OAuth/user credentials it had before the pause.
      if (userMCPAuthMap != null) {
        config.configurable.userMCPAuthMap = userMCPAuthMap;
      }

      /** @deprecated Agent Chain */
      config.configurable.last_agent_id = agents[agents.length - 1].id;

      /** Same flag-before-run ordering as chatCompletion's processStream. */
      if (this.activityLabelsMarkedPromise != null) {
        await this.activityLabelsMarkedPromise;
      }
      await this.publishRunContextMeta?.();
      try {
        await run.resume(
          resumeValue,
          config,
          { callbacks: { [Callback.TOOL_ERROR]: logToolError } },
          commandOptions,
        );
      } finally {
        reasoningLabel?.complete();
      }
      this.completeActivityPhase(run, activityPhase);

      config.signal = null;

      // The model may pause AGAIN (another tool needs approval, or a follow-up
      // question). Re-arm the same interrupt gate so the cycle can repeat.
      await this.handleRunInterrupt(run, streamId);

      // Mirror chatCompletion: settle label fills before the filter below can
      // shift part positions out from under an in-flight fill's claimed index.
      await this.settleActivityLabels();

      // Strip hidden intermediate sequential-agent content
      // before resume finalize/re-pause persistence reads `this.contentParts`, so a
      // resumed sequential chain doesn't persist/emit outputs hide_sequential_outputs
      // is meant to hide.
      this.eventActorSummary =
        getLatestEventActorSummary(this.contentParts) ?? this.eventActorSummary;
      const contentBeforeReshape = [...this.contentParts];
      this.applyHideSequentialOutputsFilter();
      this.rebaseActivityPhaseBounds(contentBeforeReshape);
    } catch (err) {
      if (isAgentAttachmentLimitError(err) || isAttachmentObjectNotFoundError(err)) {
        logger.warn(
          '[api/server/controllers/agents/client.js #resumeCompletion] Attachment rejected',
          {
            conversationId: this.conversationId,
            ...getSafeErrorMetadata(err),
          },
        );
        throw err;
      }
      if (isContentFilterError(err)) {
        logger.warn(
          '[api/server/controllers/agents/client.js #resumeCompletion] Blocked by content policy',
          {
            source: err?.body?.source,
            field: err?.body?.field,
            code: err?.code,
          },
        );
        throw err;
      }
      if (isAgentRunCancellation(err, abortController.signal)) {
        logger.debug(
          '[api/server/controllers/agents/client.js #resumeCompletion] Aborted by user',
          {
            conversationId: this.conversationId,
            ...getSafeErrorMetadata(err),
          },
        );
      } else if (isStepLimitError(err)) {
        /** Same contract as the initial turn: incomplete, not failed. A resumed run
         *  inherits the budget of a turn that already spent steps before pausing, so
         *  this boundary is if anything more likely to be reached here. */
        this.stepLimitReached = true;
        logger.warn(
          '[api/server/controllers/agents/client.js #resumeCompletion] Tool call limit reached; ending the resumed turn as incomplete',
          { conversationId: this.conversationId },
        );
      } else {
        terminalRunError.log(err, abortController.signal);
        this.contentParts.push({
          type: ContentTypes.ERROR,
          [ContentTypes.ERROR]: terminalRunError.getUserFacingError(err, () =>
            getUserFacingRequestError(
              'An error occurred while resuming the request',
              err,
              appConfig,
            ),
          ),
        });
      }
    } finally {
      await this.options.runFiles?.close();
      this.eventActorSummary =
        getLatestEventActorSummary(this.contentParts) ?? this.eventActorSummary;
      /** A run that never came to exist has no state of its own: keep the
       * inherited meta so the persisted error response still seeds the next
       * turn. A created run's neutral state may still clear it. */
      this.contextMeta = this.run == null ? this.contextMeta : captureRunContextMeta(this);

      this.finalizeSubagentContent();
      this.stampMcpServerIdentities();
      await this.settleActivityLabels();

      if (this.pendingSubagentEmits.length > 0) {
        await Promise.allSettled(this.pendingSubagentEmits);
        this.pendingSubagentEmits = [];
      }

      try {
        await this.recordCollectedUsage({
          context: resolveRunUsageContext(abortController?.signal?.aborted === true),
          balance: balanceConfig,
          transactions: transactionsConfig,
        });
      } catch (err) {
        logger.error(
          '[api/server/controllers/agents/client.js #resumeCompletion] Error in cleanup phase',
          getSafeErrorMetadata(err),
        );
      }
      if (this._resolveRun) {
        this._resolveRun(this.run ?? null);
        this._resolveRun = null;
      }
      run = null;
      config = null;
    }
  }

  /**
   * Resolves with the agent run once it is initialized, or `null` if
   * initialization fails. Lets immediate-mode title generation await the run
   * instead of throwing when fired before `chatCompletion` assigns `this.run`.
   * Rejects promptly if the provided signal aborts before the run is ready.
   * @param {AbortSignal} [signal]
   * @returns {Promise<AgentRun | null>}
   */
  _waitForRun(signal) {
    if (this.run) {
      return Promise.resolve(this.run);
    }
    if (!this._runReady) {
      this._runReady = new Promise((resolve) => {
        this._resolveRun = resolve;
      });
    }
    if (!signal) {
      return this._runReady;
    }
    if (signal.aborted) {
      return Promise.reject(new Error('Aborted before run initialization'));
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error('Aborted before run initialization'));
      signal.addEventListener('abort', onAbort, { once: true });
      this._runReady.then((run) => {
        signal.removeEventListener('abort', onAbort);
        resolve(run);
      });
    });
  }

  /**
   * @param {Object} params
   * @param {string} params.text
   * @param {AbortController} params.abortController
   * @param {boolean} [params.immediate] When true, the title is generated as soon
   *   as the request is made — the run is awaited (instead of throwing) and the
   *   title derives from the user's input only (`contentParts` is empty).
   */
  async titleConvo({ text, abortController, immediate = false }) {
    if (!this.run) {
      if (!immediate) {
        throw new Error('Run not initialized');
      }
      await this._waitForRun(abortController?.signal);
      if (!this.run) {
        logger.debug(
          '[api/server/controllers/agents/client.js #titleConvo] Run unavailable for immediate title generation',
        );
        return;
      }
    }
    const { handleLLMEnd, collected: collectedMetadata } = createMetadataAggregator();
    const { req, agent } = this.options;

    if (req?.body?.isTemporary) {
      logger.debug(
        `[api/server/controllers/agents/client.js #titleConvo] Skipping title generation for temporary conversation`,
      );
      return;
    }

    const appConfig = req.config;
    let endpoint = agent.endpoint;

    /** @type {import('@librechat/agents').ClientOptions} */
    let clientOptions = {
      model: agent.model || agent.model_parameters.model,
    };

    let titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });

    /** @type {TEndpoint | undefined} */
    const endpointConfig =
      appConfig.endpoints?.all ??
      appConfig.endpoints?.[endpoint] ??
      titleProviderConfig.customEndpointConfig;
    if (!endpointConfig) {
      logger.debug(
        `[api/server/controllers/agents/client.js #titleConvo] No endpoint config for "${endpoint}"`,
      );
    }

    if (endpointConfig?.titleConvo === false) {
      logger.debug(
        `[api/server/controllers/agents/client.js #titleConvo] Title generation disabled for endpoint "${endpoint}"`,
      );
      return;
    }

    if (endpointConfig?.titleEndpoint && endpointConfig.titleEndpoint !== endpoint) {
      try {
        titleProviderConfig = getProviderConfig({
          provider: endpointConfig.titleEndpoint,
          appConfig,
        });
        endpoint = endpointConfig.titleEndpoint;
      } catch (error) {
        logger.warn(
          `[api/server/controllers/agents/client.js #titleConvo] Error getting title endpoint config for "${endpointConfig.titleEndpoint}", falling back to default`,
          getSafeErrorMetadata(error),
        );
        // Fall back to original provider config
        endpoint = agent.endpoint;
        titleProviderConfig = getProviderConfig({ provider: endpoint, appConfig });
      }
    }

    if (
      endpointConfig &&
      endpointConfig.titleModel &&
      endpointConfig.titleModel !== Constants.CURRENT_MODEL
    ) {
      clientOptions.model = endpointConfig.titleModel;
    }

    const options = await titleProviderConfig.getOptions({
      req,
      endpoint,
      model_parameters: clientOptions,
      db: {
        getUserKey: db.getUserKey,
        getUserKeyValues: db.getUserKeyValues,
      },
    });

    let provider = options.provider ?? titleProviderConfig.overrideProvider ?? agent.provider;
    if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName == null
    ) {
      provider = Providers.OPENAI;
    } else if (
      endpoint === EModelEndpoint.azureOpenAI &&
      options.llmConfig?.azureOpenAIApiInstanceName != null &&
      provider !== Providers.AZURE
    ) {
      provider = Providers.AZURE;
    }

    /** @type {import('@librechat/agents').ClientOptions} */
    clientOptions = { ...options.llmConfig };
    if (options.configOptions) {
      clientOptions.configuration = options.configOptions;
    }

    if (clientOptions.maxTokens != null) {
      delete clientOptions.maxTokens;
    }
    if (clientOptions?.modelKwargs?.max_completion_tokens != null) {
      delete clientOptions.modelKwargs.max_completion_tokens;
    }
    if (clientOptions?.modelKwargs?.max_output_tokens != null) {
      delete clientOptions.modelKwargs.max_output_tokens;
    }

    /** `omitTitleOptions` drops the Anthropic `clientOptions` carrier (thinking,
     *  streaming, etc.), which would also drop its `defaultHeaders` — preserve the
     *  original `clientOptions` object so gateway/reverse-proxy metadata still
     *  reaches title requests (the proxy may require it for auth/routing). Restore
     *  the SAME object reference, not a copy: the Vertex `createClient` closure from
     *  `getLLMConfig` closes over this object, so `resolveConfigHeaders` must mutate
     *  the very object the client is built from. */
    const anthropicClientOptions = clientOptions?.clientOptions;

    clientOptions = Object.assign(
      Object.fromEntries(
        Object.entries(clientOptions).filter(([key]) => !omitTitleOptions.has(key)),
      ),
    );

    if (anthropicClientOptions?.defaultHeaders != null && clientOptions.clientOptions == null) {
      clientOptions.clientOptions = anthropicClientOptions;
    }

    if (
      provider === Providers.GOOGLE &&
      (endpointConfig?.titleMethod === TitleMethod.FUNCTIONS ||
        endpointConfig?.titleMethod === TitleMethod.STRUCTURED)
    ) {
      clientOptions.json = true;
    }

    /** Resolve request-based headers across provider-specific header locations:
     *  OpenAI `configuration.defaultHeaders`, Anthropic `clientOptions.defaultHeaders`
     *  (preserved above), and Google `customHeaders`. Uses the `req` captured at
     *  entry — `disposeClient` nulls `this.options.req` and can race this async
     *  title flow, which would blank the user context mid-generation.
     */
    resolveConfigHeaders({
      llmConfig: clientOptions,
      user: createSafeUser(req?.user),
      tenantId: resolveRequestTenantId(req ?? {}),
      body: {
        messageId: this.responseMessageId,
        conversationId: this.conversationId,
        parentMessageId: this.parentMessageId,
      },
    });

    try {
      const titleResult = await this.run.generateTitle({
        provider,
        clientOptions,
        inputText: text,
        contentParts: immediate ? [] : this.contentParts,
        titleMethod: endpointConfig?.titleMethod,
        titlePrompt: endpointConfig?.titlePrompt,
        titlePromptTemplate: endpointConfig?.titlePromptTemplate,
        chainOptions: {
          runName: 'TitleRun',
          signal: abortController.signal,
          callbacks: [
            {
              handleLLMEnd,
            },
          ],
          configurable: {
            thread_id: this.conversationId,
            user_id: this.user ?? this.options.req.user?.id,
          },
        },
      });

      const collectedUsage = collectedMetadata.map((item) => {
        let input_tokens, output_tokens;

        if (item.usage) {
          input_tokens =
            item.usage.prompt_tokens || item.usage.input_tokens || item.usage.inputTokens;
          output_tokens =
            item.usage.completion_tokens || item.usage.output_tokens || item.usage.outputTokens;
        } else if (item.tokenUsage) {
          input_tokens = item.tokenUsage.promptTokens;
          output_tokens = item.tokenUsage.completionTokens;
        } else if (item.usage_metadata) {
          input_tokens = item.usage_metadata.input_tokens;
          output_tokens = item.usage_metadata.output_tokens;
        }

        return {
          input_tokens: input_tokens,
          output_tokens: output_tokens,
        };
      });

      const balanceConfig = getBalanceConfig(appConfig);
      const transactionsConfig = getTransactionsConfig(appConfig);
      await this.recordCollectedUsage({
        collectedUsage,
        context: 'title',
        model: clientOptions.model,
        balance: balanceConfig,
        transactions: transactionsConfig,
        messageId: this.responseMessageId,
      }).catch((err) => {
        logger.error(
          '[api/server/controllers/agents/client.js #titleConvo] Error recording collected usage',
          getSafeErrorMetadata(err),
        );
      });

      return sanitizeTitle(titleResult.title);
    } catch (err) {
      logger.error(
        '[api/server/controllers/agents/client.js #titleConvo] Error',
        getSafeErrorMetadata(err),
      );
      return;
    }
  }

  /**
   * @param {object} params
   * @param {number} params.promptTokens
   * @param {number} params.completionTokens
   * @param {string} [params.model]
   * @param {OpenAIUsageMetadata} [params.usage]
   * @param {AppConfig['balance']} [params.balance]
   * @param {AppConfig['transactions']} [params.transactions]
   * @param {string} [params.context='message']
   * @returns {Promise<void>}
   */
  async recordTokenUsage({
    model,
    usage,
    balance,
    transactions,
    promptTokens,
    completionTokens,
    context,
  }) {
    await recordFallbackTokenUsage(
      { spendTokens: db.spendTokens },
      {
        usage,
        context,
        collectedUsage: this.collectedUsage,
        aborted: this.abortController?.signal?.aborted === true,
        promptTokens,
        completionTokens,
        txMetadata: {
          model,
          balance,
          transactions,
          messageId: this.responseMessageId,
          conversationId: this.conversationId,
          user: this.user ?? this.options.req.user?.id,
          endpointTokenConfig: this.options.endpointTokenConfig,
        },
      },
    );
  }

  /** Anthropic Claude models use a distinct BPE tokenizer; all others default to o200k_base. */
  getEncoding() {
    if (this.model && this.model.toLowerCase().includes('claude')) {
      return 'claude';
    }
    return 'o200k_base';
  }
}

AgentClient.buildTraceContext = buildTraceContext;

module.exports = AgentClient;
