const { nanoid } = require('nanoid');
const { logger } = require('@librechat/data-schemas');
const { Callback, formatAgentMessages } = require('@librechat/agents');
const {
  createOpenAIToolCallStream: createAcceptedToolCallStream,
} = require('@librechat/agents/openai');
const {
  EModelEndpoint,
  ResourceType,
  PermissionBits,
  hasPermissions,
  AgentCapabilities,
} = require('librechat-data-provider');
const {
  writeSSE,
  createRun,
  createChunk,
  applyContextToAgent,
  buildRunToolSet,
  buildInitialToolSessions,
  buildAgentScopedContext,
  buildInlineMemoryContext,
  buildAgentContextAttachmentsByAgentId,
  AgentRunEnvelopeError,
  createAgentRunEnvelope,
  createAgentExecutionContext,
  createMCPRuntimeRequestBody,
  loadSkillStates,
  sendFinalChunk,
  buildCompletionUsage,
  createSafeUser,
  validateRequest,
  initializeAgent,
  getBalanceConfig,
  injectSkillPrimes,
  extractManualSkills,
  createErrorResponse,
  recordCollectedUsage,
  createSubagentUsageSink,
  getTransactionsConfig,
  resolveAgentTokenConfig,
  resolveRecursionLimit,
  inspectContent,
  extractMessageContent,
  extractModelParameterContent,
  extractSkillContent,
  contentFilterBlockResponse,
  contentFilterUninspectableResponse,
  discoverConnectedAgents,
  resolveSubagentGraphs,
  getBlockedOpaqueFileField,
  getContentTraversalFragments,
  isContentTraversalProtected,
  isContentTraversalLimitError,
  assertModelBoundContent,
  reportLocatorTraversalFailure,
  hasModelBoundContentProtection,
  isContentFilterError,
  getSafeErrorMetadata,
  getUserFacingProviderError,
  getAgentErrorMetadata,
  getRemoteAgentPermissions,
  createToolExecuteHandler,
  createOwnedToolEndHandler,
  buildNonStreamingResponse,
  completeOpenAIToolCalls,
  createOpenAIStreamTracker,
  resolveAgentScopedSkillIds,
  createOpenAIContentAggregator,
  isChatCompletionValidationFailure,
  stripActivityLabelParts,
  executeAgentRun,
  waitForAgentExecutionWrites,
  resolveToolRoleGrants,
  resolveApiConversationProject,
  resolveAdmittedCodeEnvironmentDecision,
  createTerminalRunErrorObserver,
} = require('@librechat/api');
const {
  buildSummarizationHandlers,
  contextualizeModelUsage,
  createToolEndCallback,
  agentLogHandlerObj,
} = require('~/server/controllers/agents/callbacks');
const {
  loadAgentTools,
  loadToolsForExecution,
  getAccessibleMcpServerNames,
  isFatalAgentInitializationError,
} = require('~/server/services/ToolService');
const {
  findAccessibleResources,
  getEffectivePermissions,
} = require('~/server/services/PermissionService');
const {
  getSkillToolDeps,
  getSkillDbMethods,
  canAuthorSkillFiles,
  withDeploymentSkillIds,
  buildAgentToolContext,
  resolveMemoryAvailability,
  enrichLoadedToolsWithAgentContext,
} = require('~/server/services/Endpoints/agents/skillDeps');
const { createProvisionFilesCallback } = require('~/server/services/Files/provisionCallback');
const { checkSessionsAlive, loadCodeApiKey } = require('~/server/services/Files/provision');
const { getModelsConfig } = require('~/server/controllers/ModelController');
const { filterFilesByAgentAccess } = require('~/server/services/Files/permissions');
const { resolveConfigServers } = require('~/server/services/MCP');
const { getMCPManager } = require('~/config');
const { logViolation } = require('~/cache');
const db = require('~/models');

const filterFilesByRemoteAgentAccess = (params) =>
  filterFilesByAgentAccess({ ...params, resourceType: ResourceType.REMOTE_AGENT });

/**
 * Creates a tool loader function for the agent.
 * @param {Object} runtime - Request-backed tool adapter state
 * @param {import('express').Request} runtime.req
 * @param {import('express').Response} runtime.res
 * @param {AbortSignal} runtime.signal - The abort signal
 * @param {boolean} [runtime.definitionsOnly=true] - When true, returns only serializable
 *   tool definitions without creating full tool instances (for event-driven mode)
 */
function createToolLoader({ req, res, signal, definitionsOnly = true }) {
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
        requestBody,
        tool_resources,
        codeExecutionContext,
        agentResourceType: ResourceType.REMOTE_AGENT,
        definitionsOnly,
        accessibleMcpServerNames,
        streamId: null, // No resumable stream for OpenAI compat
      });
    } catch (error) {
      if (isFatalAgentInitializationError(error, { signal }) || isContentFilterError(error)) {
        throw error;
      }
      logger.error('Error loading tools for agent ' + agentId, getSafeErrorMetadata(error));
    }
  };
}

/**
 * Convert content part to internal format
 * @param {Object} part - Content part
 * @returns {Object} Converted part
 */
function convertContentPart(part) {
  if (part.type === 'text') {
    return { type: 'text', text: part.text };
  }
  if (part.type === 'image_url') {
    return { type: 'image_url', image_url: part.image_url };
  }
  return part;
}

/**
 * Convert OpenAI messages to internal format
 * @param {Array} messages - OpenAI format messages
 * @returns {Array} Internal format messages
 */
function convertMessages(messages) {
  return messages.map((msg) => {
    let content;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (msg.content) {
      content = msg.content.map(convertContentPart);
    } else {
      content = '';
    }

    return {
      role: msg.role,
      content,
      ...(msg.name && { name: msg.name }),
      ...(msg.tool_calls && { tool_calls: msg.tool_calls }),
      ...(msg.tool_call_id && { tool_call_id: msg.tool_call_id }),
    };
  });
}

/**
 * Collect file-derived context exactly as it will be exposed to the model.
 * Dynamic tool context uses the same synthesis as packages/api/src/agents/run.ts.
 * @param {Array} agents
 * @returns {Array}
 */
function collectModelBoundAgentFiles(agents) {
  const files = [];
  const seenFiles = new Set();
  for (const agent of agents) {
    for (const attachment of [
      ...(agent?.attachments ?? []),
      ...(agent?.requestAttachments ?? []),
      ...(agent?.agentContextAttachments ?? []),
    ]) {
      if (attachment == null || seenFiles.has(attachment)) {
        continue;
      }
      seenFiles.add(attachment);
      files.push(attachment);
    }

    const dynamicToolInstructions = Object.values(agent?.dynamicToolContextMap ?? {})
      .filter((value) => typeof value === 'string' && value !== '')
      .join('\n')
      .trim();
    if (dynamicToolInstructions !== '') {
      files.push({ content: dynamicToolInstructions });
    }
  }
  return files;
}

/**
 * Send an error response in OpenAI format
 */
function sendErrorResponse(res, statusCode, message, type = 'invalid_request_error', code = null) {
  res.status(statusCode).json(createErrorResponse(message, type, code));
}

function handleExecutionError({ error, res, context, appConfig }) {
  const protectionEnabled = hasModelBoundContentProtection(
    appConfig?.filters,
    appConfig?.messageFilter?.pii,
  );
  const errorMessage = getUserFacingProviderError(error, protectionEnabled);

  if (res.headersSent) {
    const errorChunk = createChunk(context, { content: `\n\nError: ${errorMessage}` }, 'stop');
    writeSSE(res, errorChunk);
    writeSSE(res, '[DONE]');
    res.end();
    return;
  }
  if (isContentFilterError(error)) {
    return sendErrorResponse(
      res,
      error.statusCode,
      error.body.message,
      'invalid_request_error',
      error.body.error,
    );
  }
  const errorMetadata = getAgentErrorMetadata(error);
  const statusCode = errorMetadata?.status ?? 500;
  const errorType =
    statusCode >= 400 && statusCode < 500 ? 'invalid_request_error' : 'server_error';
  const errorCode = !protectionEnabled ? (errorMetadata?.code ?? null) : null;
  sendErrorResponse(res, statusCode, errorMessage, errorType, errorCode);
}

/**
 * Runs a validated chat-completions envelope in the current process.
 * Express remains runtime-only state while the envelope is the portable run input.
 *
 * @param {import('@librechat/api').ChatCompletionRunEnvelope} envelope
 * @param {{req: import('express').Request, res: import('express').Response}} runtime
 */
const executeOpenAIChatCompletion = async (envelope, { req, res }) => {
  const appConfig = req.config;
  const requestStartTime = envelope.receivedAt;
  const request = envelope.payload;
  const { principal } = envelope;
  // Request-backed tool adapters still observe the validated envelope payload;
  // shared initialization receives the transport-free runtime below.
  req.body = request;
  if (request.conversation_id != null && typeof request.conversation_id !== 'string') {
    return sendErrorResponse(res, 400, 'conversation_id must be a string', 'invalid_request_error');
  }
  const agentId = request.model;
  const manualSkills = extractManualSkills(req.body);

  const uninspectableField = getBlockedOpaqueFileField(appConfig?.filters, request.messages);
  if (uninspectableField != null) {
    const blockResponse = contentFilterUninspectableResponse(uninspectableField);
    return sendErrorResponse(
      res,
      400,
      blockResponse.message,
      'invalid_request_error',
      blockResponse.error,
    );
  }

  const messageFragments = [];
  const traversalErrors = [];
  try {
    for (const fragment of extractMessageContent(request.messages)) {
      messageFragments.push(fragment);
    }
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    messageFragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }
  try {
    messageFragments.push(...extractModelParameterContent(request));
  } catch (error) {
    if (!isContentTraversalLimitError(error)) {
      throw error;
    }
    messageFragments.push(...getContentTraversalFragments(error));
    traversalErrors.push(error);
  }
  const contentFinding = inspectContent(
    [...messageFragments, ...(manualSkills ?? []).flatMap((name) => extractSkillContent({ name }))],
    {
      filters: appConfig?.filters,
      legacyPii: appConfig?.messageFilter?.pii,
    },
  );
  if (contentFinding != null) {
    const isLegacyFilter = contentFinding.detectorId === 'legacy-pattern';
    const blockResponse = contentFilterBlockResponse(contentFinding);
    return sendErrorResponse(
      res,
      400,
      isLegacyFilter
        ? `Message contains a ${contentFinding.label}. Remove it and try again.`
        : blockResponse.message,
      'invalid_request_error',
      isLegacyFilter ? 'message_filter_pii_block' : blockResponse.error,
    );
  }
  const traversalError = traversalErrors.find((error) =>
    isContentTraversalProtected({
      error,
      filters: appConfig?.filters,
      legacyPii: appConfig?.messageFilter?.pii,
      roles: request.messages.map((message) => message?.role),
    }),
  );
  if (traversalError != null) {
    return sendErrorResponse(
      res,
      traversalError.statusCode,
      traversalError.body.message,
      'invalid_request_error',
      traversalError.body.error,
    );
  }

  const responseId = `chatcmpl-${nanoid()}`;
  const terminalRunError = createTerminalRunErrorObserver({
    maxProviderErrorChars: appConfig?.endpoints?.agents?.maxProviderErrorChars,
    logger,
    responseMessageId: responseId,
    source: '[OpenAI API]',
    protectionEnabled: hasModelBoundContentProtection(
      appConfig?.filters,
      appConfig?.messageFilter?.pii,
    ),
  });
  const created = Math.floor(Date.now() / 1000);

  /** @type {import('@librechat/api').OpenAIResponseContext} — key must be `requestId` to match the type used by createChunk/buildNonStreamingResponse */
  const context = {
    created,
    requestId: responseId,
    model: agentId,
  };

  logger.debug(
    `[OpenAI API] Response ${responseId} started for agent ${agentId}, stream: ${request.stream}`,
  );

  const conversationId = request.conversation_id ?? nanoid();
  /** @type {Promise<import('librechat-data-provider').TAttachment | null>[]} */
  const artifactPromises = [];
  let artifactWritesCovered = false;
  return executeAgentRun({
    envelope,
    runId: responseId,
    conversationId,
    connection: {
      isClosed: () => res.destroyed === true && res.writableEnded !== true,
      onClose: (listener) => {
        const abortOnResponseClose = () => {
          if (res.writableEnded !== true) {
            logger.debug('[OpenAI API] Client disconnected, aborting');
            listener();
          }
        };
        res.once('close', abortOnResponseClose);
        return () => res.off('close', abortOnResponseClose);
      },
    },
    /** Conversation delete-all uses the shared owner-admission fence. Remote
     * execution must observe it after durable enrollment and before provider work. */
    isPrincipalActive: db.isSubagentOwnerAdmissible,
    beforeSettle: (execution) => {
      if (!artifactWritesCovered && artifactPromises.length > 0) {
        execution.track(
          waitForAgentExecutionWrites(artifactPromises).catch((artifactError) => {
            logger.warn(
              '[OpenAI API] Error processing artifacts:',
              getSafeErrorMetadata(artifactError),
            );
          }),
        );
      }
    },
    onSettlementError: (error) => {
      logger.error('[OpenAI API] Failed to settle execution:', getSafeErrorMetadata(error));
    },
    handleExecutionError: (error, signal) => {
      terminalRunError.log(error, signal);
      return handleExecutionError({ error, res, context, appConfig });
    },
    execute: async (execution) => {
      const agentPromise = db.getAgent({ id: agentId });
      // Validation may return before this promise is awaited; preserve the original
      // promise for the later await while avoiding an unhandled speculative rejection.
      agentPromise.catch(() => {});
      if (request.conversation_id != null) {
        const project = await resolveApiConversationProject(
          {
            userId: principal.userId,
            tenantId: principal.tenantId,
            conversationId: request.conversation_id,
          },
          {
            getConvo: db.getConvo,
            getChatProject: db.getChatProject,
            getProjectFiles: db.getProjectFiles,
            logger,
            logPrefix: '[OpenAI API]',
          },
        );
        if (!project.ok) {
          return sendErrorResponse(
            res,
            project.status,
            project.message,
            project.reason === 'server_error' ? 'server_error' : 'invalid_request_error',
          );
        }
        req.resolvedConversation = project.conversation;
        req.chatProjectContext = project.context;
      }

      const agent = await agentPromise;
      if (!agent) {
        return sendErrorResponse(
          res,
          404,
          `Agent not found: ${agentId}`,
          'invalid_request_error',
          'model_not_found',
        );
      }

      req.turnStartedAt = envelope.receivedAt;
      const { decision: codeEnvironmentDecision, conversation: admittedConversation } =
        await resolveAdmittedCodeEnvironmentDecision({
          appConfig,
          conversation: req.resolvedConversation,
          conversationId,
          requestedMode: request.code_environment_mode,
          requestedSelections: request.code_workspaces,
          readDecision: (id) => db.readAdmittedConvoCodeEnvironmentDecision(principal.userId, id),
        });
      req.resolvedConversation = admittedConversation;
      const agentRuntime = createAgentExecutionContext({
        user: req.user,
        appConfig,
        requestBody: request,
        turnStartedAt: envelope.receivedAt,
        conversationCreatedAt: req.conversationCreatedAt,
        resolvedConversation: req.resolvedConversation,
        hasResolvedConversation: Object.prototype.hasOwnProperty.call(req, 'resolvedConversation'),
        chatProjectContext: req.chatProjectContext,
      });

      const parentMessageId = request.parent_message_id ?? null;
      let mcpParentMessageId;
      if (
        typeof request.parent_message_id === 'string' &&
        request.parent_message_id.trim() !== ''
      ) {
        mcpParentMessageId = request.parent_message_id;
      } else if (request.conversation_id == null) {
        mcpParentMessageId = null;
      }
      const mcpRequestBody = createMCPRuntimeRequestBody({
        messageId: responseId,
        conversationId,
        codeEnvironmentMode: codeEnvironmentDecision.mode,
        codeWorkspaces: codeEnvironmentDecision.codeWorkspaces,
        parentMessageId: mcpParentMessageId,
      });

      const agentsEConfig = appConfig?.endpoints?.[EModelEndpoint.agents];
      const allowedProviders = new Set(agentsEConfig?.allowedProviders);
      const ordinaryToolCancellationEnabled =
        agentsEConfig?.backgroundTasks?.ordinaryToolCancellation === true;
      const backgroundCompletionResultMaxChars =
        agentsEConfig?.backgroundTasks?.completionResultMaxChars;

      // Create tool loader
      const loadTools = createToolLoader({ req, res, signal: execution.signal });

      // Initialize the agent first to check for disableStreaming
      const endpointOption = {
        endpoint: agent.provider,
        model_parameters: agent.model_parameters ?? {},
      };
      const skillDbMethods = getSkillDbMethods();

      const dbMethods = {
        getProjectFiles: db.getProjectFiles,
        getConvoFiles: db.getConvoFiles,
        getFiles: db.getFiles,
        filterFilesByAgentAccess: filterFilesByRemoteAgentAccess,
        getUserKey: db.getUserKey,
        getMessages: db.getMessages,
        getAccessibleMcpServerNames,
        updateFilesUsage: db.updateFilesUsage,
        getUserKeyValues: db.getUserKeyValues,
        getUserCodeFiles: db.getUserCodeFiles,
        getDeferredProvisionFiles: db.getDeferredProvisionFiles,
        checkSessionsAlive,
        loadCodeApiKey,
        getToolFilesByIds: db.getToolFilesByIds,
        getCodeGeneratedFiles: db.getCodeGeneratedFiles,
        listSkillsByAccess: skillDbMethods.listSkillsByAccess,
        listAlwaysApplySkills: skillDbMethods.listAlwaysApplySkills,
        getSkillByName: skillDbMethods.getSkillByName,
        getRoleByName: db.getRoleByName,
      };

      const enabledCapabilities = new Set(agentsEConfig?.capabilities);
      const codeCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.execute_code);
      const fileSearchCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.file_search);
      /** Started before the memory read rather than awaited on its own line, so
       *  the role lookup overlaps that query instead of preceding it. Skipped
       *  when the deployment has both capabilities off — both flags are false
       *  either way, so the read would be pure load on every request. One
       *  lookup answers both. */
      const toolRoleGrants =
        codeCapabilityEnabled || fileSearchCapabilityEnabled
          ? resolveToolRoleGrants({ req, getRoleByName: db.getRoleByName })
          : null;
      const memoryAvailable = await resolveMemoryAvailability({
        enabledCapabilities,
        memoryConfig: appConfig?.memory,
        user: req.user,
        getRoleByName: db.getRoleByName,
      });
      /** The deployment switch AND the role grant: `initializeAgent` rebuilds
       *  `bash_tool`, `read_file` and the workspace file tools from this flag,
       *  and forwards the code-environment context to their handlers. */
      const codeEnvAvailable = codeCapabilityEnabled && (await toolRoleGrants)?.runCode === true;
      /** The same pairing for the other gated tool, read only by the resend-file
       *  priming: `false` skips re-hydrating prior-turn `file_search` files for
       *  a tool the loader is about to drop. */
      const fileSearchAvailable =
        fileSearchCapabilityEnabled && (await toolRoleGrants)?.fileSearch === true;
      /** Called by `initializeAgent` only when an agent's built provider config
       *  turns native web search on. It reaches the initializer with `runtime`
       *  and no `req`, so this is what lets it join the grants memoized on this
       *  request instead of issuing its own read. */
      const resolveWebSearchGrant = async () =>
        (await resolveToolRoleGrants({ req, getRoleByName: db.getRoleByName })).webSearch;
      const skillsCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.skills);
      const ephemeralSkillsToggle = request.ephemeralAgent?.skills === true;
      const accessibleSkillIds = skillsCapabilityEnabled
        ? withDeploymentSkillIds(
            await findAccessibleResources({
              userId: principal.userId,
              role: principal.role,
              resourceType: ResourceType.SKILL,
              requiredPermissions: PermissionBits.VIEW,
            }),
          )
        : [];
      const editableSkillIds = skillsCapabilityEnabled
        ? await findAccessibleResources({
            userId: principal.userId,
            role: principal.role,
            resourceType: ResourceType.SKILL,
            requiredPermissions: PermissionBits.EDIT,
          })
        : [];
      const skillCreateAllowed = skillsCapabilityEnabled
        ? await getSkillToolDeps().canCreateSkill({ req })
        : false;

      const { skillStates, defaultActiveOnShare } = await loadSkillStates({
        userId: principal.userId,
        appConfig,
        getUserById: db.getUserById,
        accessibleSkillIds,
      });

      const primaryScopedSkillIds = resolveAgentScopedSkillIds({
        agent,
        accessibleSkillIds,
        skillsCapabilityEnabled,
        ephemeralSkillsToggle,
      });
      const primaryScopedEditableSkillIds = resolveAgentScopedSkillIds({
        agent,
        accessibleSkillIds: editableSkillIds,
        skillsCapabilityEnabled,
        ephemeralSkillsToggle,
      });

      const primaryConfig = await initializeAgent(
        {
          runtime: agentRuntime,
          loadTools,
          requestFiles: [],
          conversationId,
          parentMessageId,
          requestBody: mcpRequestBody,
          agent,
          endpointOption,
          allowedProviders,
          isInitialAgent: true,
          useChatProjectContext: true,
          accessibleSkillIds: primaryScopedSkillIds,
          skillAuthoringAvailable: canAuthorSkillFiles({
            agent,
            scopedEditableSkillIds: primaryScopedEditableSkillIds,
            skillCreateAllowed,
            skillsCapabilityEnabled,
            ephemeralSkillsToggle,
          }),
          codeEnvAvailable,
          fileSearchAvailable,
          resolveWebSearchGrant,
          backgroundToolsAvailable: enabledCapabilities.has(AgentCapabilities.run_in_background),
          toolIntentsAvailable: enabledCapabilities.has(AgentCapabilities.tool_intents),
          statefulSessionsAvailable: enabledCapabilities.has(
            AgentCapabilities.stateful_code_sessions,
          ),
          allowedStatefulCodeEnvironments: agentsEConfig?.statefulCodeSessions?.allowedEnvironments,
          memoryAvailable,
          skillStates,
          defaultActiveOnShare,
          manualSkills,
          signal: execution.signal,
        },
        dbMethods,
      );

      /**
       * Per-agent tool-execution context map, keyed by agentId.
       * Needed so the ON_TOOL_EXECUTE callback routes each sub-agent's tool calls
       * to the correct toolRegistry / userMCPAuthMap / tool_resources.
       * @type {Map<string, {
       *   agent: object,
       *   toolRegistry?: import('@librechat/agents').LCToolRegistry,
       *   requestScopedConnections?: import('@librechat/api').RequestScopedMCPConnectionStore,
       *   userMCPAuthMap?: Record<string, Record<string, string>>,
       *   tool_resources?: object,
       *   actionsEnabled?: boolean,
       * }>}
       */
      const agentToolContexts = new Map();
      agentToolContexts.set(
        primaryConfig.id,
        buildAgentToolContext({ agent, config: primaryConfig }),
      );

      let handoffAgentConfigs = new Map();
      let discoveredEdges = [];
      let discoveredMCPAuthMap;
      const subagentsCapabilityEnabled = enabledCapabilities.has(AgentCapabilities.subagents);
      const primaryHasGraphSubagents =
        subagentsCapabilityEnabled &&
        primaryConfig.subagents?.enabled === true &&
        (primaryConfig.subagents.graphs?.length ?? 0) > 0;
      if (primaryConfig.edges?.length || primaryHasGraphSubagents) {
        const modelsConfig = await getModelsConfig(req);
        const discoveryParams = {
          req,
          res,
          signal: execution.signal,
          primaryConfig,
          endpointOption,
          allowedProviders,
          modelsConfig,
          loadTools,
          requestFiles: [],
          conversationId,
          parentMessageId,
          requestBody: mcpRequestBody,
          useChatProjectContext: true,
          resourceType: ResourceType.REMOTE_AGENT,
          computeAccessibleSkillIds: (handoffAgent) =>
            resolveAgentScopedSkillIds({
              agent: handoffAgent,
              accessibleSkillIds,
              skillsCapabilityEnabled,
              ephemeralSkillsToggle,
            }),
          computeSkillAuthoringAvailable: (handoffAgent) =>
            canAuthorSkillFiles({
              agent: handoffAgent,
              scopedEditableSkillIds: resolveAgentScopedSkillIds({
                agent: handoffAgent,
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
          resolveWebSearchGrant,
          backgroundToolsAvailable: enabledCapabilities.has(AgentCapabilities.run_in_background),
          toolIntentsAvailable: enabledCapabilities.has(AgentCapabilities.tool_intents),
          statefulSessionsAvailable: enabledCapabilities.has(
            AgentCapabilities.stateful_code_sessions,
          ),
          allowedStatefulCodeEnvironments: agentsEConfig?.statefulCodeSessions?.allowedEnvironments,
          memoryAvailable,
        };
        const discoveryDeps = {
          getAgent: db.getAgent,
          checkPermission: async ({ userId, role, resourceId, requiredPermission }) => {
            const permissions = await getRemoteAgentPermissions(
              { getEffectivePermissions },
              userId,
              role,
              resourceId,
            );
            return hasPermissions(permissions, requiredPermission);
          },
          logViolation,
          db: dbMethods,
          onAgentInitialized: (loadedAgentId, loadedAgent, config) => {
            agentToolContexts.set(
              loadedAgentId,
              buildAgentToolContext({ agent: loadedAgent, config }),
            );
          },
          initializeAgent,
        };
        if (primaryConfig.edges?.length) {
          ({
            agentConfigs: handoffAgentConfigs,
            edges: discoveredEdges,
            userMCPAuthMap: discoveredMCPAuthMap,
          } = await discoverConnectedAgents(discoveryParams, discoveryDeps));
        }
        if (subagentsCapabilityEnabled) {
          discoveredMCPAuthMap = await resolveSubagentGraphs(
            {
              ...discoveryParams,
              rootConfigs: [primaryConfig, ...handoffAgentConfigs.values()],
            },
            discoveryDeps,
          );
        }
      }

      primaryConfig.edges = discoveredEdges;
      const runAgents = [primaryConfig, ...handoffAgentConfigs.values()];
      const endpointTokenConfigByAgentId = new Map();
      for (const [agentId, context] of agentToolContexts) {
        endpointTokenConfigByAgentId.set(agentId, context.endpointTokenConfig);
      }
      const resolveEndpointTokenConfig = (usage) =>
        resolveAgentTokenConfig({
          agentId: usage?.agentId,
          byAgentId: endpointTokenConfigByAgentId,
          fallback: primaryConfig.endpointTokenConfig,
        });
      const modelBoundAgentsById = new Map();
      const pendingModelBoundAgents = [...runAgents];
      for (let index = 0; index < pendingModelBoundAgents.length; index++) {
        const runAgent = pendingModelBoundAgents[index];
        if (!runAgent?.id || modelBoundAgentsById.has(runAgent.id)) {
          continue;
        }
        modelBoundAgentsById.set(runAgent.id, runAgent);
        for (const subagent of runAgent.subagentAgentConfigs?.values?.() ?? []) {
          pendingModelBoundAgents.push(subagent);
        }
        for (const graph of runAgent.subagentGraphConfigs ?? []) {
          pendingModelBoundAgents.push(...graph.memberConfigs);
        }
      }
      const modelBoundAgents = [...modelBoundAgentsById.values()];
      const manualSkillPrimes = primaryConfig.manualSkillPrimes;
      const alwaysApplySkillPrimes = primaryConfig.alwaysApplySkillPrimes;
      assertModelBoundContent({
        onTraversalFailure: reportLocatorTraversalFailure,
        filters: appConfig?.filters,
        legacyPii: appConfig?.messageFilter?.pii,
        submittedMessages: request.messages,
        agents: modelBoundAgents,
        skills: [...(manualSkillPrimes ?? []), ...(alwaysApplySkillPrimes ?? [])],
        files: collectModelBoundAgentFiles(modelBoundAgents),
      });

      // Determine if streaming is enabled (check both request and agent config)
      const streamingDisabled = !!primaryConfig.model_parameters?.disableStreaming;
      const isStreaming = request.stream === true && !streamingDisabled;

      // Create tracker for streaming or aggregator for non-streaming
      const tracker = isStreaming ? createOpenAIStreamTracker() : null;
      const aggregator = isStreaming ? null : createOpenAIContentAggregator();
      // Set up response for streaming
      if (isStreaming) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();

        // Send initial chunk with role
        const initialChunk = createChunk(context, { role: 'assistant' });
        writeSSE(res, initialChunk);
      }

      // Create handler config for OpenAI streaming (only used when streaming)
      const handlerConfig = isStreaming
        ? {
            writer: res,
            context,
            tracker,
          }
        : null;

      const collectedUsage = [];
      const toolEndCallback = createToolEndCallback({
        req,
        res,
        artifactPromises,
        streamId: null,
      });

      /* Stable for the turn: the primary prime list is fixed once
       `initializeAgent` resolves and is used as the fallback when a
       specific agent context is unavailable. `codeEnvAvailable` is read
       per-agent from the stored tool context (admin cap AND that
       agent's `tools` list includes `execute_code`) — a skills-only
       agent never gains sandbox access even if the admin enabled the
       capability globally. */
      const toolExecuteOptions = {
        runSignal: execution.signal,
        foregroundRunId: responseId,
        ordinaryToolCancellation: ordinaryToolCancellationEnabled,
        backgroundCompletionResultMaxChars,
        provisionFiles: createProvisionFilesCallback({
          req,
          agentToolContexts,
          resolvePrimaryAgentId: () => primaryConfig.id,
        }),
        loadTools: async (
          toolNames,
          agentId,
          _configurable,
          callerCapabilityProjection,
          runSignal,
        ) => {
          const ctx =
            agentToolContexts.get(agentId) ?? agentToolContexts.get(primaryConfig.id) ?? {};
          const result = await loadToolsForExecution({
            req,
            res,
            agentResourceType: ResourceType.REMOTE_AGENT,
            conversationId,
            requestBody: mcpRequestBody,
            toolNames,
            agent: ctx.agent ?? agent,
            signal: runSignal,
            toolRegistry: ctx.toolRegistry,
            callerCapabilityProjection,
            backgroundToolNames: ctx.backgroundToolNames,
            intentToolNames: ctx.intentToolNames,
            mcpAvailableTools: ctx.mcpAvailableTools,
            requestScopedConnections: ctx.requestScopedConnections,
            userMCPAuthMap: ctx.userMCPAuthMap,
            tool_resources: ctx.tool_resources,
            actionsEnabled: ctx.actionsEnabled,
            accessibleMcpServerNames: ctx.accessibleMcpServerNames,
          });
          return enrichLoadedToolsWithAgentContext({
            result,
            req,
            ctx,
          });
        },
        toolEndCallback,
        ...getSkillToolDeps(),
      };

      const summarizationConfig = appConfig?.summarization;

      const openaiMessages = convertMessages(request.messages);

      const toolSet = buildRunToolSet(
        primaryConfig,
        handoffAgentConfigs.values(),
        undefined,
        openaiMessages,
        true,
      );
      const formatted = formatAgentMessages(stripActivityLabelParts(openaiMessages), {}, toolSet);
      const formattedMessages = formatted.messages;
      const initialSummary = formatted.summary;
      let indexTokenCountMap = formatted.indexTokenCountMap;

      /**
       * Inject manual + always-apply skill primes so the model sees SKILL.md
       * bodies for this turn — parity with AgentClient's chat path. OpenAI-
       * compatible streaming uses its own tracker/aggregator shape, so the
       * LibreChat-style card SSE events don't apply here; only the
       * message-context part carries over.
       */
      if (
        (manualSkillPrimes && manualSkillPrimes.length > 0) ||
        (alwaysApplySkillPrimes && alwaysApplySkillPrimes.length > 0)
      ) {
        const primeResult = injectSkillPrimes({
          initialMessages: formattedMessages,
          indexTokenCountMap,
          manualSkillPrimes,
          alwaysApplySkillPrimes,
        });
        indexTokenCountMap = primeResult.indexTokenCountMap;
        /* Surface the cap-driven always-apply truncation at the controller
         layer too — `injectSkillPrimes` already logs internally, but the
         controller-level warn includes endpoint context so operators can
         tell at a glance which path hit the cap. Mirrors AgentClient's
         warn in `client.js`. */
        if (primeResult.alwaysApplyDropped > 0) {
          logger.warn(
            `[OpenAI API] Dropped ${primeResult.alwaysApplyDropped} always-apply prime(s) to stay within MAX_PRIMED_SKILLS_PER_TURN.`,
          );
        }
      }

      /**
       * Create a simple handler that processes data
       */
      const createHandler = (processor) => ({
        handle: (_event, data) => {
          if (processor) {
            processor(data);
          }
        },
      });

      /**
       * Stream text content in OpenAI format
       */
      const streamText = (text) => {
        if (!text) {
          return;
        }
        if (isStreaming) {
          tracker.addText();
          writeSSE(res, createChunk(context, { content: text }));
        } else {
          aggregator.addText(text);
        }
      };

      /**
       * Stream reasoning content in OpenAI format (OpenRouter convention)
       */
      const streamReasoning = (text) => {
        if (!text) {
          return;
        }
        if (isStreaming) {
          tracker.addReasoning();
          writeSSE(res, createChunk(context, { reasoning: text }));
        } else {
          aggregator.addReasoning(text);
        }
      };

      const toolCallStream = createAcceptedToolCallStream({
        signal: execution.signal,
        toolCalls: isStreaming ? tracker.toolCalls : aggregator.toolCalls,
        ...(isStreaming && {
          emit: (delta) => writeSSE(res, createChunk(context, delta)),
        }),
      });

      // Event handlers for OpenAI-compatible streaming
      const handlers = {
        ...toolCallStream.handlers,
        // Text content streaming
        on_message_delta: createHandler((data) => {
          const content = data?.delta?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              if (part.type === 'text' && part.text) {
                streamText(part.text);
              }
            }
          }
        }),

        // Reasoning/thinking content streaming
        on_reasoning_delta: createHandler((data) => {
          const content = data?.delta?.content;
          if (Array.isArray(content)) {
            for (const part of content) {
              const text = part.think || part.text;
              if (text) {
                streamReasoning(text);
              }
            }
          }
        }),

        // Usage tracking
        on_chat_model_end: {
          handle: (_event, data, metadata, graph) => {
            const usage = data?.output?.usage_metadata;
            if (usage) {
              const agentContext = graph?.getAgentContext?.(metadata);
              const taggedUsage = contextualizeModelUsage(usage, metadata, agentContext);
              collectedUsage.push(taggedUsage);
            }
          },
        },
        // Use proper ToolEndHandler for processing artifacts (images, file citations, code output)
        on_tool_end: createOwnedToolEndHandler(toolEndCallback, logger),
        on_chain_stream: createHandler(),
        on_chain_end: createHandler(),
        on_agent_update: createHandler(),
        on_agent_log: agentLogHandlerObj,
        on_custom_event: createHandler(),
        on_tool_execute: createToolExecuteHandler(toolExecuteOptions),
        ...(summarizationConfig?.enabled !== false
          ? buildSummarizationHandlers({ isStreaming, res })
          : {}),
      };

      // Create and run the agent
      const userId = principal.userId;

      // Extract merged userMCPAuthMap (needed for MCP tool connections across
      // the primary and any discovered handoff sub-agents)
      const userMCPAuthMap = discoveredMCPAuthMap ?? primaryConfig.userMCPAuthMap;

      const contextAgentsById = new Map(runAgents.map((runAgent) => [runAgent.id, runAgent]));
      for (const runAgent of runAgents) {
        for (const graph of runAgent.subagentGraphConfigs ?? []) {
          for (const memberConfig of graph.memberConfigs) {
            contextAgentsById.set(memberConfig.id, memberConfig);
          }
        }
      }
      const contextAgents = [...contextAgentsById.values()];
      const agentScopedContext = await buildAgentScopedContext({
        agentIds: contextAgents.map(({ id }) => id),
        attachmentsByAgentId: buildAgentContextAttachmentsByAgentId(contextAgents),
        req,
        endpoint: primaryConfig.endpoint,
        endpointsByAgentId: new Map(
          contextAgents.map((runAgent) => [runAgent.id, { endpoint: runAgent.endpoint }]),
        ),
      });
      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      await Promise.all(
        contextAgents.map(async (runAgent) => {
          const memoryContext = await buildInlineMemoryContext({
            agent: runAgent,
            req,
            userId,
            memoryAvailable,
            getFormattedMemories: db.getFormattedMemories,
          });
          return applyContextToAgent({
            agent: runAgent,
            agentId: runAgent.id,
            logger,
            mcpManager,
            configServers,
            sharedRunContext: [memoryContext, agentScopedContext.get(runAgent.id)]
              .filter(Boolean)
              .join('\n\n'),
          });
        }),
      );
      const initialSessions = buildInitialToolSessions({ agents: runAgents });

      const run = await createRun({
        agents: runAgents,
        messages: formattedMessages,
        indexTokenCountMap,
        initialSessions,
        initialSummary,
        runId: responseId,
        summarizationConfig,
        appConfig,
        signal: execution.signal,
        customHandlers: handlers,
        modelCallbacks: [terminalRunError.modelCallback],
        requestBody: mcpRequestBody,
        user: { ...createSafeUser(req.user), id: userId },
        traceContext: { endpoint: EModelEndpoint.agents },
        tenantId: principal.tenantId,
        /** Bills subagent child-run model calls (reported outside the
         *  streamEvents loop) into the same collectedUsage array. */
        subagentUsageSink: createSubagentUsageSink(collectedUsage),
      });

      if (!run) {
        throw new Error('Failed to create agent run');
      }

      const config = {
        runName: 'AgentRun',
        configurable: {
          thread_id: conversationId,
          user_id: userId,
          user: createSafeUser(req.user),
          requestBody: mcpRequestBody,
          ...(userMCPAuthMap != null && { userMCPAuthMap }),
        },
        recursionLimit: resolveRecursionLimit(agentsEConfig, agent),
        signal: execution.signal,
        streamMode: 'values',
        version: 'v2',
      };

      await completeOpenAIToolCalls(toolCallStream, async () => {
        await run.processStream({ messages: formattedMessages }, config, {
          callbacks: {
            [Callback.TOOL_ERROR]: (graph, error, toolId) => {
              logger.error(`[OpenAI API] Tool Error "${toolId}"`, getSafeErrorMetadata(error));
            },
          },
        });

        // Record token usage against balance
        const balanceConfig = getBalanceConfig(appConfig);
        const transactionsConfig = getTransactionsConfig(appConfig);
        execution.track(
          recordCollectedUsage(
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
            },
            {
              user: userId,
              conversationId,
              collectedUsage,
              context: 'message',
              messageId: responseId,
              balance: balanceConfig,
              transactions: transactionsConfig,
              model: primaryConfig.model || agent.model_parameters?.model,
              endpointTokenConfig: primaryConfig.endpointTokenConfig,
              resolveEndpointTokenConfig,
            },
          ).catch((err) => {
            logger.error('[OpenAI API] Error recording usage:', getSafeErrorMetadata(err));
          }),
        );
      });

      const usage = buildCompletionUsage(collectedUsage);

      // Finalize response
      const duration = Date.now() - requestStartTime;
      if (isStreaming) {
        sendFinalChunk(handlerConfig, 'stop', usage, true);
        res.end();
        logger.debug(`[OpenAI API] Response ${responseId} completed in ${duration}ms (streaming)`);

        // The HTTP response is complete, while destructive cleanup still waits for artifacts.
        if (artifactPromises.length > 0) {
          execution.track(
            waitForAgentExecutionWrites(artifactPromises).catch((artifactError) => {
              logger.warn(
                '[OpenAI API] Error processing artifacts:',
                getSafeErrorMetadata(artifactError),
              );
            }),
          );
          artifactWritesCovered = true;
        }
      } else {
        // For non-streaming, wait for artifacts before sending response
        if (artifactPromises.length > 0) {
          try {
            await waitForAgentExecutionWrites(artifactPromises);
          } catch (artifactError) {
            logger.warn(
              '[OpenAI API] Error processing artifacts:',
              getSafeErrorMetadata(artifactError),
            );
          }
          artifactWritesCovered = true;
        }

        const response = buildNonStreamingResponse(
          context,
          aggregator.getText(),
          aggregator.getReasoning(),
          aggregator.toolCalls,
          usage,
          true,
        );
        res.json(response);
        logger.debug(
          `[OpenAI API] Response ${responseId} completed in ${duration}ms (non-streaming)`,
        );
      }
    },
  });
};

/**
 * OpenAI-compatible chat completions ingress adapter for agents.
 * Authentication and remote-agent authorization have already run in route middleware.
 *
 * POST /v1/chat/completions
 */
const OpenAIChatCompletionController = async (req, res) => {
  const receivedAt = Date.now();
  const validation = validateRequest(req.body);
  if (isChatCompletionValidationFailure(validation)) {
    return sendErrorResponse(res, 400, validation.error);
  }

  let envelope;
  try {
    envelope = createAgentRunEnvelope({
      protocol: 'chat.completions',
      requestId: req.requestId ?? req.id ?? `agent-run-${nanoid()}`,
      receivedAt,
      principal: req.tenantId == null ? req.user : { ...req.user, tenantId: req.tenantId },
      payload: validation.request,
    });
  } catch (error) {
    if (error instanceof AgentRunEnvelopeError) {
      return sendErrorResponse(res, 400, error.message, 'invalid_request_error');
    }
    throw error;
  }

  return executeOpenAIChatCompletion(envelope, { req, res });
};

/**
 * List available agents as models (filtered by remote access permissions)
 *
 * GET /v1/models
 */
const ListModelsController = async (req, res) => {
  try {
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) {
      return sendErrorResponse(res, 401, 'Authentication required', 'auth_error');
    }

    // Find agents the user has remote access to (VIEW permission on REMOTE_AGENT)
    const accessibleAgentIds = await findAccessibleResources({
      userId,
      role: userRole,
      resourceType: ResourceType.REMOTE_AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });

    // Get the accessible agents
    let agents = [];
    if (accessibleAgentIds.length > 0) {
      agents = await db.getAgents({ _id: { $in: accessibleAgentIds } });
    }

    const models = agents.map((agent) => ({
      id: agent.id,
      object: 'model',
      created: Math.floor(new Date(agent.createdAt || Date.now()).getTime() / 1000),
      owned_by: 'librechat',
      permission: [],
      root: agent.id,
      parent: null,
      // LibreChat extensions
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
    }));

    res.json({
      object: 'list',
      data: models,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to list models';
    logger.error('[OpenAI API] Error listing models:', getSafeErrorMetadata(error));
    sendErrorResponse(res, 500, errorMessage, 'server_error');
  }
};

/**
 * Get a specific model/agent (with remote access permission check)
 *
 * GET /v1/models/:model
 */
const GetModelController = async (req, res) => {
  try {
    const { model } = req.params;
    const userId = req.user?.id;
    const userRole = req.user?.role;

    if (!userId) {
      return sendErrorResponse(res, 401, 'Authentication required', 'auth_error');
    }

    const agent = await db.getAgent({ id: model });

    if (!agent) {
      return sendErrorResponse(
        res,
        404,
        `Model not found: ${model}`,
        'invalid_request_error',
        'model_not_found',
      );
    }

    // Check if user has remote access to this agent
    const accessibleAgentIds = await findAccessibleResources({
      userId,
      role: userRole,
      resourceType: ResourceType.REMOTE_AGENT,
      requiredPermissions: PermissionBits.VIEW,
    });

    const hasAccess = accessibleAgentIds.some((id) => id.toString() === agent._id.toString());

    if (!hasAccess) {
      return sendErrorResponse(
        res,
        403,
        `No remote access to model: ${model}`,
        'permission_error',
        'access_denied',
      );
    }

    res.json({
      id: agent.id,
      object: 'model',
      created: Math.floor(new Date(agent.createdAt || Date.now()).getTime() / 1000),
      owned_by: 'librechat',
      permission: [],
      root: agent.id,
      parent: null,
      // LibreChat extensions
      name: agent.name,
      description: agent.description,
      provider: agent.provider,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Failed to get model';
    logger.error('[OpenAI API] Error getting model:', getSafeErrorMetadata(error));
    sendErrorResponse(res, 500, errorMessage, 'server_error');
  }
};

module.exports = {
  OpenAIChatCompletionController,
  ListModelsController,
  GetModelController,
};
