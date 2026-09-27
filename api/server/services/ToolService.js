const { logger, redactMessage, getTenantId } = require('@librechat/data-schemas');
const { tool: toolFn, DynamicStructuredTool } = require('@librechat/agents/langchain/tools');
const {
  sleep,
  createToolSearch,
  createBashExecutionTool,
  Constants: AgentConstants,
} = require('@librechat/agents');
const {
  sendEvent,
  getToolkitKey,
  getUserMCPAuthMap,
  createAuthIdentityContext,
  selectMCPUpstreamTokenProvider,
  loadToolDefinitions,
  GenerationJobManager,
  isActionDomainAllowed,
  buildWebSearchContext,
  buildImageToolContext,
  buildToolClassification,
  supportsProgrammaticCodeExecution,
  getCodeFileLocation,
  getMissingCustomUserVars,
  buildWebSearchDynamicContext,
  getCodeApiAuthHeaders,
  getReplayablePendingMCPOAuthStart,
  getMCPServerNamesFromTools,
  buildMCPAuthToolCall,
  buildMCPAuthStepId,
  buildMCPAuthRunStepEvent,
  buildMCPAuthRunStepDeltaEvent,
  buildMCPAuthRunStepCompletedEvent,
  inspectContentWithTraversal,
  ContentFilterError,
  assertModelBoundContent,
  reportLocatorTraversalFailure,
  extractToolArgumentContent,
  contentFilterModelBoundBlockResponse,
  getSafeErrorMetadata,
  isContentFilterError,
  isFileAuthoringToolDefinition,
  normalizeActionToolName,
  ASK_USER_QUESTION_TOOL_NAME,
  splitMCPToolKey,
  buildServerNameAliases,
  findShadowedServerNames,
  isNormalizationSensitiveName,
  AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE,
  isFatalAgentInitializationError,
  codeExecutionAuthHeaders,
  createAttachedWorkspaceBashTool,
  createRepositoryInstructionSource,
  createRepositoryInstructionLoader,
  resolveAttachedWorkspaceCommandTimeoutMax,
  resolveAttachedWorkspaceQueueWaitMs,
  createContextProgrammaticBashTool,
  resolveCodeExecutionContext,
  resolveCodeExecutionWorkspaceContext,
  resolveRunFileCodeExecutionContext,
  resolveCallerCapabilityProjectionSnapshot,
  CREATE_FILE_TOOL_NAME,
  EDIT_FILE_TOOL_NAME,
  LIST_WORKSPACE_FILES_TOOL_NAME,
  SEARCH_WORKSPACE_TOOL_NAME,
  getTransactionsConfig,
  checkToolRolePermission,
  resolveToolRolePermissions,
} = require('@librechat/api');
const {
  Time,
  Tools,
  Constants,
  CacheKeys,
  ErrorTypes,
  ContentTypes,
  imageGenTools,
  AuthTypeEnum,
  EModelEndpoint,
  EToolResources,
  isActionTool,
  actionDelimiter,
  ImageVisionTool,
  PermissionTypes,
  hasActivePiiFields,
  hasActivePiiPatterns,
  openapiToFunction,
  AgentCapabilities,
  isEphemeralAgentId,
  validateActionDomain,
  actionDomainSeparator,
  defaultAgentCapabilities,
  validateAndParseOpenAPISpec,
} = require('librechat-data-provider');
const {
  createActionTool,
  legacyDomainEncode,
  decryptMetadata,
  loadActionSets,
  domainParser,
} = require('./ActionService');
const {
  getAppConfig,
  getEndpointsConfig,
  getMCPServerTools,
  getCachedTools,
} = require('~/server/services/Config');
const { processFileURL, uploadImageBuffer } = require('~/server/services/Files/process');
const { primeFiles: primeSearchFiles } = require('~/app/clients/tools/util/fileSearch');
const { primeFiles: primeCodeFiles } = require('~/server/services/Files/Code/process');
const { manifestToolMap, toolkits } = require('~/app/clients/tools/manifest');
const repositoryInstructionLoader = createRepositoryInstructionLoader();
const { createOnSearchResults } = require('~/server/services/Tools/search');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const {
  createMCPPermissionContext,
  resolveMcpServerContext,
  getAccessibleMcpServerNames,
  resolveCollisionAuditNames,
} = require('~/server/services/MCP');
const { createOpenIDSessionTokenProvider } = require('~/server/services/OpenIDSessionRefresh');
const { getMCPRequestContext } = require('~/server/services/MCPRequestContext');
const { recordUsage } = require('~/server/services/Threads');
const { loadTools } = require('~/app/clients/tools/util');
const { findPluginAuthsByKeys, getRoleByName } = require('~/models');
const { getFlowStateManager, getMCPServersRegistry } = require('~/config');
const { getLogStores } = require('~/cache');

const domainSeparatorRegex = new RegExp(actionDomainSeparator, 'g');
const encryptedActionMetadataFields = ['api_key', 'oauth_client_id', 'oauth_client_secret'];
const requiredActionContentFields = ['name', 'arguments', 'output'];

const getActiveToolResources = (toolResources, tools) => {
  if (toolResources == null) {
    return null;
  }

  const activeResources = {};
  if (tools.includes(Tools.execute_code) && toolResources[EToolResources.execute_code] != null) {
    activeResources[EToolResources.execute_code] = toolResources[EToolResources.execute_code];
  }
  if (tools.includes(Tools.file_search) && toolResources[EToolResources.file_search] != null) {
    activeResources[EToolResources.file_search] = toolResources[EToolResources.file_search];
  }
  if (
    (tools.includes('image_gen_oai') || tools.includes('gemini_image_gen')) &&
    toolResources[EToolResources.image_edit] != null
  ) {
    activeResources[EToolResources.image_edit] = toolResources[EToolResources.image_edit];
  }

  return Object.keys(activeResources).length > 0 ? activeResources : null;
};

/** Deployment switch guarding each role-gated tool. Spelled out rather than
 *  inferred from the tool name so the two enums can drift apart safely. */
const toolCapabilityGates = {
  [Tools.file_search]: AgentCapabilities.file_search,
  [Tools.execute_code]: AgentCapabilities.execute_code,
  [Tools.web_search]: AgentCapabilities.web_search,
};

/**
 * Resolves the role grants for an agent's gated tools. A tool already switched
 * off by its `AgentCapabilities` entry is skipped, so a disabled deployment
 * costs no role read and logs no denial.
 *
 * @param {ServerRequest} req
 * @param {string[]} [tools] - The agent's configured tool names.
 * @param {Set<string>} enabledCapabilities
 * @returns {Promise<(tool: string) => boolean>} Predicate; `true` for any tool
 * that carries no role permission.
 */
const resolveAgentToolPermissions = (req, tools, enabledCapabilities) =>
  resolveToolRolePermissions({
    req,
    tools,
    getRoleByName,
    isEligible: (tool) => enabledCapabilities.has(toolCapabilityGates[tool]),
  });

const assertToolResourcesAllowed = ({ req, toolResources, tools }) => {
  const filters = req.config?.filters;
  if (filters == null) {
    return;
  }
  const activeResources = getActiveToolResources(toolResources, tools);
  if (activeResources == null) {
    return;
  }
  const files = Object.values(activeResources).flatMap((resource) =>
    Array.isArray(resource?.files) ? resource.files : [],
  );
  assertModelBoundContent({
    onTraversalFailure: reportLocatorTraversalFailure,
    filters,
    agents: [{ tool_resources: activeResources }],
    files,
  });
};

const withoutEncryptedActionSecrets = (action) => {
  const metadata = { ...action.metadata };
  delete metadata.api_key;
  delete metadata.oauth_client_id;
  delete metadata.oauth_client_secret;
  return { ...action, metadata };
};

const prepareStoredActionsForUse = async ({ actions, filters, decrypt }) => {
  if (filters != null) {
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters,
      actions: actions.map(withoutEncryptedActionSecrets),
    });
  }

  const inspectDecryptedMetadata = hasActivePiiFields(
    filters?.actionMetadata?.pii,
    encryptedActionMetadataFields,
  );
  if (!decrypt && !inspectDecryptedMetadata) {
    return actions;
  }

  const decryptedActions = await Promise.all(
    actions.map(async (action) => ({
      ...action,
      metadata: await decryptMetadata(action.metadata),
    })),
  );
  if (filters != null) {
    assertModelBoundContent({
      onTraversalFailure: reportLocatorTraversalFailure,
      filters,
      actions: decryptedActions,
    });
  }
  return decryptedActions;
};

/**
 * Loads and inspects the persisted action snapshot before any unrelated tool
 * initialization can connect to MCP, emit OAuth state, prime provider files,
 * or create generic tool instances. The caller reuses the returned snapshot
 * for the rest of the request, avoiding a second read and TOCTOU drift.
 */
const prepareActionSnapshotForTools = async ({ agentId, toolNames, filters, decrypt }) => {
  if (!toolNames.some((toolName) => isActionTool(toolName))) {
    return null;
  }
  const storedActions = (await loadActionSets({ agentId })) ?? [];
  if (storedActions.length === 0) {
    return { storedActions, actionSets: [] };
  }
  const actionSets = await prepareStoredActionsForUse({
    actions: storedActions,
    filters,
    decrypt,
  });
  return { storedActions, actionSets };
};

/**
 * Populate a `toolToAction` map with one slot per fully-qualified tool
 * name (`<operationId><actionDelimiter><encoded-domain>`). Both the new
 * and the legacy encodings of the domain are registered for every
 * function so agents whose stored tool names predate the current
 * encoding still resolve correctly.
 *
 * Indexing on the full tool name instead of the encoded domain alone is
 * what makes multi-action agents work when two actions share a hostname:
 * the operationId disambiguates them, so neither overwrites the other.
 *
 * Two actions that additionally share the same operationId still
 * collide (nothing in the key distinguishes them). That case is
 * pathological — `sanitizeOperationId` plus OpenAPI's own uniqueness
 * requirement make it very unlikely — but when it does happen we log
 * a warning so the silent-overwrite mode from the original bug cannot
 * reappear under a different disguise.
 */
const registerActionTools = ({
  toolToAction,
  functionSignatures,
  normalizedDomain,
  legacyNormalized,
  makeEntry,
}) => {
  const setKey = (key, entry) => {
    if (toolToAction.has(key)) {
      logger.warn(
        `[Actions] operationId collision: "${key}" already registered; ` +
          `action "${entry.action?.action_id}" overwrites the previous entry. ` +
          `Two actions share both the operationId and the encoded hostname.`,
      );
    }
    toolToAction.set(key, entry);
  };

  for (const sig of functionSignatures) {
    const entry = makeEntry(sig);
    // Use `sig.name` verbatim: `openapiToFunction` keeps hyphens in
    // generated operationIds, so `get_foo---bar` and `get_foo_bar` are
    // distinct operations on the same spec. `normalizeActionToolName`
    // only touches the encoded-domain suffix at lookup time, so map
    // keys and lookups stay consistent without merging distinct
    // operationIds into the same slot.
    setKey(`${sig.name}${actionDelimiter}${normalizedDomain}`, entry);
    if (legacyNormalized !== normalizedDomain) {
      setKey(`${sig.name}${actionDelimiter}${legacyNormalized}`, entry);
    }
  }
};

/**
 * Resolves the set of enabled agent capabilities from endpoints config,
 * falling back to app-level or default capabilities for ephemeral agents.
 * @param {ServerRequest} req
 * @param {Object} appConfig
 * @param {string} agentId
 * @returns {Promise<Set<string>>}
 */
async function resolveAgentCapabilities(req, appConfig, agentId) {
  const endpointsConfig = await getEndpointsConfig(req);
  let capabilities = new Set(endpointsConfig?.[EModelEndpoint.agents]?.capabilities ?? []);
  if (capabilities.size === 0 && isEphemeralAgentId(agentId)) {
    capabilities = new Set(
      appConfig.endpoints?.[EModelEndpoint.agents]?.capabilities ?? defaultAgentCapabilities,
    );
  }
  return capabilities;
}

/**
 * Processes the required actions by calling the appropriate tools and returning the outputs.
 * @param {OpenAIClient} client - OpenAI or StreamRunManager Client.
 * @param {RequiredAction} requiredActions - The current required action.
 * @returns {Promise<ToolOutput>} The outputs of the tools.
 */
const processVisionRequest = async (client, currentAction) => {
  if (!client.visionPromise) {
    return {
      tool_call_id: currentAction.toolCallId,
      output: 'No image details found.',
    };
  }

  /** @type {ChatCompletion | undefined} */
  const completion = await client.visionPromise;
  if (completion && completion.usage) {
    recordUsage({
      user: client.req.user.id,
      model: client.req.body.model,
      conversationId: (client.responseMessage ?? client.finalMessage).conversationId,
      ...completion.usage,
      transactions: getTransactionsConfig(client.req.config),
    });
  }
  const output = completion?.choices?.[0]?.message?.content ?? 'No image details found.';
  return {
    tool_call_id: currentAction.toolCallId,
    output,
  };
};

const getRequiredActionContentInspection = (client, input) => {
  const filters = client.req.config?.filters;
  const pii = filters?.toolArguments?.pii;
  if (!hasActivePiiPatterns(pii)) {
    return { finding: null, traversalError: null };
  }
  const candidateFields = requiredActionContentFields.filter((field) =>
    Object.prototype.hasOwnProperty.call(input, field),
  );
  if (!hasActivePiiFields(pii, candidateFields)) {
    return { finding: null, traversalError: null };
  }
  const selectedInput = {};
  for (const field of candidateFields) {
    if (hasActivePiiFields(pii, [field])) {
      selectedInput[field] = input[field];
    }
  }
  return inspectContentWithTraversal(() => extractToolArgumentContent(selectedInput), { filters });
};

const getSafeRequiredActionOutput = (client, currentAction, output) => {
  const { finding, traversalError } = getRequiredActionContentInspection(client, {
    name: currentAction.tool,
    output,
  });
  if (finding == null && traversalError == null) {
    return output;
  }
  const blockResponse =
    finding == null ? traversalError.body : contentFilterModelBoundBlockResponse(finding);
  logger.warn('[required actions] Blocked tool output', {
    toolCallId: currentAction.toolCallId,
    source: blockResponse.source,
    field: blockResponse.field,
  });
  return JSON.stringify(blockResponse);
};

/**
 * Processes return required actions from run.
 * @param {OpenAIClient | StreamRunManager} client - OpenAI (legacy) or StreamRunManager Client.
 * @param {RequiredAction[]} requiredActions - The required actions to submit outputs for.
 * @returns {Promise<ToolOutputs>} The outputs of the tools.
 */
async function processRequiredActions(client, requiredActions) {
  for (const currentAction of requiredActions) {
    const { finding, traversalError } = getRequiredActionContentInspection(client, {
      name: currentAction.tool,
      arguments: currentAction.toolInput,
    });
    if (traversalError != null) {
      throw traversalError;
    }
    if (finding != null) {
      throw new ContentFilterError(finding);
    }
  }

  logger.debug(
    `[required actions] user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id} | count: ${requiredActions.length}`,
  );
  const appConfig = client.req.config;
  const toolDefinitions = (await getCachedTools()) ?? {};
  const seenToolkits = new Set();
  const tools = requiredActions
    .map((action) => {
      const toolName = action.tool;
      const toolDef = toolDefinitions[toolName];
      if (toolDef && !manifestToolMap[toolName]) {
        for (const toolkit of toolkits) {
          if (seenToolkits.has(toolkit.pluginKey)) {
            return;
          } else if (toolName.startsWith(`${toolkit.pluginKey}_`)) {
            seenToolkits.add(toolkit.pluginKey);
            return toolkit.pluginKey;
          }
        }
      }
      return toolName;
    })
    .filter((toolName) => !!toolName);

  const { loadedTools } = await loadTools({
    user: client.req.user.id,
    model: client.req.body.model ?? 'gpt-4o-mini',
    tools,
    functions: true,
    endpoint: client.req.body.endpoint,
    options: {
      processFileURL,
      req: client.req,
      res: client.res,
      uploadImageBuffer,
      openAIApiKey: client.apiKey,
      returnMetadata: true,
    },
    webSearch: appConfig.webSearch,
    fileStrategy: appConfig.fileStrategy,
    imageOutputType: appConfig.imageOutputType,
  });

  const ToolMap = loadedTools.reduce((map, tool) => {
    map[tool.name] = tool;
    return map;
  }, {});

  const promises = [];

  let actionSetsData = null;
  let isActionTool = false;
  const ActionToolMap = {};
  const ActionBuildersMap = {};

  for (let i = 0; i < requiredActions.length; i++) {
    const currentAction = requiredActions[i];
    if (currentAction.tool === ImageVisionTool.function.name) {
      promises.push(
        processVisionRequest(client, currentAction).then((result) => ({
          ...result,
          output: getSafeRequiredActionOutput(client, currentAction, result.output),
        })),
      );
      continue;
    }
    let tool = ToolMap[currentAction.tool] ?? ActionToolMap[currentAction.tool];

    const handleToolOutput = async (rawOutput) => {
      const output = getSafeRequiredActionOutput(client, currentAction, rawOutput);
      requiredActions[i].output = output;

      /** @type {FunctionToolCall & PartMetadata} */
      const toolCall = {
        function: {
          name: currentAction.tool,
          arguments: JSON.stringify(currentAction.toolInput),
          output,
        },
        id: currentAction.toolCallId,
        type: 'function',
        progress: 1,
        action: isActionTool,
      };

      const toolCallIndex = client.mappedOrder.get(toolCall.id);

      if (imageGenTools.has(currentAction.tool)) {
        const imageOutput = output;
        toolCall.function.output = `${currentAction.tool} displayed an image. All generated images are already plainly visible, so don't repeat the descriptions in detail. Do not list download links as they are available in the UI already. The user may download the images by clicking on them, but do not mention anything about downloading to the user.`;

        // Streams the "Finished" state of the tool call in the UI
        client.addContentData({
          [ContentTypes.TOOL_CALL]: toolCall,
          index: toolCallIndex,
          type: ContentTypes.TOOL_CALL,
        });

        await sleep(500);

        /** @type {ImageFile} */
        const imageDetails = {
          ...imageOutput,
          ...currentAction.toolInput,
        };

        const image_file = {
          [ContentTypes.IMAGE_FILE]: imageDetails,
          type: ContentTypes.IMAGE_FILE,
          // Replace the tool call output with Image file
          index: toolCallIndex,
        };

        client.addContentData(image_file);

        // Update the stored tool call
        client.seenToolCalls && client.seenToolCalls.set(toolCall.id, toolCall);

        return {
          tool_call_id: currentAction.toolCallId,
          output: toolCall.function.output,
        };
      }

      client.seenToolCalls && client.seenToolCalls.set(toolCall.id, toolCall);
      client.addContentData({
        [ContentTypes.TOOL_CALL]: toolCall,
        index: toolCallIndex,
        type: ContentTypes.TOOL_CALL,
        // TODO: to append tool properties to stream, pass metadata rest to addContentData
        // result: tool.result,
      });

      return {
        tool_call_id: currentAction.toolCallId,
        output,
      };
    };

    if (!tool) {
      // throw new Error(`Tool ${currentAction.tool} not found.`);

      if (!actionSetsData) {
        /** @type {Action[]} */
        const storedActions =
          (await loadActionSets({
            assistantId: client.req.body.assistant_id,
          })) ?? [];
        const actionSets = await prepareStoredActionsForUse({
          actions: storedActions,
          filters: client.req.config?.filters,
          decrypt: true,
        });

        // See registerActionTools for the key-shape rationale.
        const toolToAction = new Map();

        for (let actionIndex = 0; actionIndex < actionSets.length; actionIndex++) {
          const action = actionSets[actionIndex];
          const storedAction = storedActions[actionIndex];
          const domain = await domainParser(action.metadata.domain, true);
          const normalizedDomain = domain.replace(domainSeparatorRegex, '_');
          const legacyDomain = legacyDomainEncode(action.metadata.domain);
          const legacyNormalized = legacyDomain.replace(domainSeparatorRegex, '_');

          const isDomainAllowed = await isActionDomainAllowed(
            action.metadata.domain,
            appConfig?.actions?.allowedDomains,
            appConfig?.actions?.allowedAddresses,
          );
          if (!isDomainAllowed) {
            continue;
          }

          // Validate and parse OpenAPI spec
          const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
          if (!validationResult.spec || !validationResult.serverUrl) {
            throw new Error(
              `Invalid spec: user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id}`,
            );
          }

          // SECURITY: Validate the domain from the spec matches the stored domain
          // This is defense-in-depth to prevent any stored malicious actions
          const domainValidation = validateActionDomain(
            action.metadata.domain,
            validationResult.serverUrl,
          );
          if (!domainValidation.isValid) {
            logger.error(`Domain mismatch in stored action: ${domainValidation.message}`, {
              userId: client.req.user.id,
              action_id: action.action_id,
            });
            continue; // Skip this action rather than failing the entire request
          }

          // Process the OpenAPI spec
          const { requestBuilders, functionSignatures } = openapiToFunction(validationResult.spec);

          // Store encrypted values for OAuth flow
          const encrypted = {
            oauth_client_id: storedAction.metadata.oauth_client_id,
            oauth_client_secret: storedAction.metadata.oauth_client_secret,
          };

          registerActionTools({
            toolToAction,
            functionSignatures,
            normalizedDomain,
            legacyNormalized,
            makeEntry: (sig) => ({
              action,
              requestBuilder: requestBuilders[sig.name],
              encrypted,
            }),
          });

          // Store builders for reuse
          ActionBuildersMap[action.metadata.domain] = requestBuilders;
        }

        actionSetsData = toolToAction;
      }

      const entry = actionSetsData.get(normalizeActionToolName(currentAction.tool));
      if (!entry) {
        continue;
      }

      const { action, requestBuilder, encrypted } = entry;

      // We've already decrypted the metadata, so we can pass it directly
      const _allowedDomains = appConfig?.actions?.allowedDomains;
      const _allowedAddresses = appConfig?.actions?.allowedAddresses;
      tool = await createActionTool({
        userId: client.req.user.id,
        res: client.res,
        action,
        requestBuilder,
        // Note: intentionally not passing zodSchema, name, and description for assistants API
        encrypted, // Pass the encrypted values for OAuth flow
        useSSRFProtection: !Array.isArray(_allowedDomains) || _allowedDomains.length === 0,
        allowedAddresses: _allowedAddresses,
      });
      if (!tool) {
        logger.warn(
          `Invalid action: user: ${client.req.user.id} | thread_id: ${requiredActions[0].thread_id} | run_id: ${requiredActions[0].run_id} | toolName: ${currentAction.tool}`,
        );
        throw new Error(`{"type":"${ErrorTypes.INVALID_ACTION}"}`);
      }
      isActionTool = !!tool;
      ActionToolMap[currentAction.tool] = tool;
    }

    if (currentAction.tool === 'calculator') {
      currentAction.toolInput = currentAction.toolInput.input;
    }

    const handleToolError = (error) => {
      logger.error('[required actions] Tool execution failed', {
        toolCallId: currentAction.toolCallId,
        errorName: error?.name,
        errorCode: error?.code,
      });
      if (error instanceof ContentFilterError) {
        return {
          tool_call_id: currentAction.toolCallId,
          output: JSON.stringify(contentFilterModelBoundBlockResponse(error.body)),
        };
      }
      const output = getSafeRequiredActionOutput(
        client,
        currentAction,
        `Error processing tool ${currentAction.tool}: ${redactMessage(error.message, 256)}`,
      );
      return {
        tool_call_id: currentAction.toolCallId,
        output,
      };
    };

    try {
      const promise = tool
        ._call(currentAction.toolInput)
        .then(handleToolOutput)
        .catch(handleToolError);
      promises.push(promise);
    } catch (error) {
      const toolOutputError = handleToolError(error);
      promises.push(Promise.resolve(toolOutputError));
    }
  }

  return {
    tool_outputs: await Promise.all(promises),
  };
}

/**
 * Processes the runtime tool calls and returns the tool classes.
 * @param {Object} params - Run params containing user and request information.
 * @param {ServerRequest} params.req - The request object.
 * @param {ServerResponse} params.res - The request object.
 * @param {AbortSignal} params.signal
 * @param {Pick<Agent, 'id' | 'provider' | 'model' | 'tools'} params.agent - The agent to load tools for.
 * @param {string | undefined} [params.openAIApiKey] - The OpenAI API key.
 * @returns {Promise<{
 *   tools?: StructuredTool[];
 *   toolContextMap?: Record<string, unknown>;
 *   dynamicToolContextMap?: Record<string, unknown>;
 *   userMCPAuthMap?: Record<string, Record<string, string>>;
 *   toolRegistry?: Map<string, import('~/utils/toolClassification').LCTool>;
 *   hasDeferredTools?: boolean;
 * }>} The agent tools and registry.
 */
/** Native LibreChat tools that are not in the manifest */
const nativeTools = new Set([
  Tools.execute_code,
  Tools.file_search,
  Tools.web_search,
  Tools.memory,
]);

const mcpServerPinPrefix = `${Constants.mcp_server}${Constants.mcp_delimiter}`;
const isExpectedMCPTool = (toolName) =>
  toolName?.includes(Constants.mcp_delimiter) &&
  !toolName.startsWith(mcpServerPinPrefix) &&
  !isActionTool(toolName);
const isExpectedMCPToolsUnavailableError = (error) =>
  error?.code === AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE;
const createExpectedMCPToolsUnavailableError = (agentName, cause) => {
  const subject = agentName ? `Agent "${agentName}"` : 'The agent';
  const error = new Error(
    `${subject} is configured to use MCP tools, but none are available. Verify that the MCP server is connected and this agent can access its selected tools, then try again.`,
  );
  error.name = 'AgentToolInitializationError';
  error.code = AGENT_EXPECTED_MCP_TOOLS_UNAVAILABLE;
  error.status = 503;
  error.statusCode = 503;
  if (cause != null) {
    error.cause = cause;
  }
  return error;
};

/** Checks if a tool name is a known built-in tool */
const isBuiltInTool = (toolName) =>
  Boolean(
    manifestToolMap[toolName] ||
      toolkits.some((t) => t.pluginKey === toolName) ||
      nativeTools.has(toolName),
  );

/**
 * Loads only tool definitions without creating tool instances.
 * This is the efficient path for event-driven mode where tools are loaded on-demand.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req - The request object
 * @param {ServerResponse} [params.res] - The response object for SSE events
 * @param {Object} params.agent - The agent configuration
 * @param {import('@librechat/api').RequestBody} [params.requestBody] - Normalized MCP body
 * @param {string} [params.agentResourceType] - Permission resource type for the authorized agent route
 * @param {string|null} [params.streamId] - Stream ID for resumable mode
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted tool events
 * @param {AbortSignal} [params.signal] - Effective run cancellation signal
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider]
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @returns {Promise<{
 *   toolDefinitions?: import('@librechat/api').LCTool[];
 *   toolRegistry?: Map<string, import('@librechat/api').LCTool>;
 *   mcpAvailableTools?: Record<string, import('@librechat/api').LCAvailableTools>;
 *   userMCPAuthMap?: Record<string, Record<string, string>>;
 *   hasDeferredTools?: boolean;
 * }>}
 */
async function loadToolDefinitionsWrapper({
  req,
  res,
  agent,
  requestBody,
  agentResourceType,
  streamId = null,
  jobCreatedAt,
  tool_resources,
  codeExecutionContext,
  accessibleMcpServerNames,
  signal,
  upstreamTokenProvider: suppliedUpstreamTokenProvider,
  upstreamTokenProviderResolver,
}) {
  if (!agent.tools || agent.tools.length === 0) {
    return { toolDefinitions: [] };
  }

  if (
    agent.tools.length === 1 &&
    (agent.tools[0] === AgentCapabilities.context || agent.tools[0] === AgentCapabilities.ocr)
  ) {
    return { toolDefinitions: [] };
  }

  const appConfig = req.config;
  const runtimeRequestBody = requestBody ?? req.body;
  const hasExpectedMCPTools = agent.tools.some(isExpectedMCPTool);
  const enabledCapabilities = await resolveAgentCapabilities(req, appConfig, agent.id);

  const checkCapability = (capability) => enabledCapabilities.has(capability);
  const areToolsEnabled = checkCapability(AgentCapabilities.tools);
  const actionsEnabled = checkCapability(AgentCapabilities.actions);
  const deferredToolsEnabled = checkCapability(AgentCapabilities.deferred_tools);
  const programmaticToolsEnabled = enabledCapabilities.has(AgentCapabilities.programmatic_tools);
  const canUseTool = await resolveAgentToolPermissions(req, agent.tools, enabledCapabilities);
  /** Gates the sandbox everywhere it is reachable, not just the `execute_code`
   *  entry in `filteredTools`: this flag also drives tool classification and the
   *  programmatic bash tool, which would otherwise run code for a denied role. */
  const codeExecutionEnabled =
    agent.tools?.includes(Tools.execute_code) === true &&
    enabledCapabilities.has(AgentCapabilities.execute_code) &&
    canUseTool(Tools.execute_code);
  const baseCodeExecutionContext =
    codeExecutionContext ??
    resolveCodeExecutionContext({
      statefulSessions:
        codeExecutionEnabled &&
        enabledCapabilities.has(AgentCapabilities.stateful_code_sessions) &&
        agent.stateful_code_sessions === true,
      environment: agent.stateful_code_environment,
      environmentId: agent.code_environment_id,
      environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
      userId: req.user.id,
      agentId: agent.id,
      conversationId: runtimeRequestBody?.conversationId,
    });
  const resolvedCodeExecutionContext = await resolveCodeExecutionWorkspaceContext({
    context: baseCodeExecutionContext,
    requestedSelections: runtimeRequestBody?.codeWorkspaces,
    persistedSelections: req.resolvedConversation?.codeWorkspaces,
    environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
    getAppConfig,
  });
  const hasMCPTools = agent.tools?.some((tool) => tool?.includes(Constants.mcp_delimiter));
  const mcpPermissionContext = createMCPPermissionContext(req);
  const canUseMCP = hasMCPTools ? await mcpPermissionContext.canUseServers(req.user) : true;

  const filteredTools = agent.tools?.filter((tool) => {
    if (tool === Tools.file_search) {
      return checkCapability(AgentCapabilities.file_search) && canUseTool(tool);
    }
    if (tool === Tools.execute_code) {
      return checkCapability(AgentCapabilities.execute_code) && canUseTool(tool);
    }
    if (tool === Tools.web_search) {
      return checkCapability(AgentCapabilities.web_search) && canUseTool(tool);
    }
    if (tool === Tools.memory) {
      return checkCapability(AgentCapabilities.memory);
    }
    if (tool === ASK_USER_QUESTION_TOOL_NAME) {
      return checkCapability(AgentCapabilities.ask_user_question);
    }
    if (isActionTool(tool)) {
      return actionsEnabled;
    }
    if (tool?.includes(Constants.mcp_delimiter)) {
      return areToolsEnabled && canUseMCP;
    }
    if (!areToolsEnabled) {
      return false;
    }
    return true;
  });

  if (!filteredTools || filteredTools.length === 0) {
    if (hasExpectedMCPTools) {
      throw createExpectedMCPToolsUnavailableError(agent.name);
    }
    return { toolDefinitions: [] };
  }

  assertToolResourcesAllowed({
    req,
    toolResources: tool_resources,
    tools: filteredTools,
  });
  const preparedActionSnapshot = await prepareActionSnapshotForTools({
    agentId: agent.id,
    toolNames: filteredTools,
    filters: req.config?.filters,
    decrypt: false,
  });

  /** Only MCP tool keys need the server context; a purely non-MCP agent should not
   *  pay an app-config lookup on startup. */
  const hasFilteredMCPTools = filteredTools.some((t) => t.includes(Constants.mcp_delimiter));
  const {
    configServers,
    serverNames: mcpServerNames,
    rawServerNames: mcpRawServerNames = [],
  } = hasFilteredMCPTools
    ? await resolveMcpServerContext(req)
    : { configServers: {}, serverNames: [], rawServerNames: [] };

  /**
   * Shadowed servers must not emit definitions: their normalized function
   * names equal the winning server's, and the default execution path later
   * resolves those names directly — selecting a shadowed server's definition
   * could execute another server's action. Audited against the full
   * accessible set (threaded from the caller's heal, or fetched only when a
   * configured name needs normalization); normalization-sensitive references
   * fail closed when the audit is incomplete.
   */
  let defsFilteredTools = filteredTools;
  /** Complete audit names, forwarded to the definitions loader so its alias
   *  fallback can tell "server not found" from "server found but currently
   *  unavailable" — only the former may fall back to the raw alias. */
  let defsAccessibleServerNames;
  if (hasFilteredMCPTools) {
    const collisionAudit = await resolveCollisionAuditNames({
      rawServerNames: mcpRawServerNames,
      accessibleServerNames: accessibleMcpServerNames,
      userId: req.user.id,
      role: req.user?.role,
    });
    if (collisionAudit.complete) {
      defsAccessibleServerNames = collisionAudit.names;
    }
    const defsShadowedServers = findShadowedServerNames(collisionAudit.names);
    if (defsShadowedServers.size > 0 || !collisionAudit.complete) {
      const defsAliases = buildServerNameAliases(collisionAudit.names);
      const boundaryCandidates = [...collisionAudit.names, ...defsAliases.keys()];
      defsFilteredTools = filteredTools.filter((tool) => {
        if (!tool.includes(Constants.mcp_delimiter)) {
          return true;
        }
        const [, parsed] = splitMCPToolKey(tool, boundaryCandidates);
        const serverName = parsed != null ? (defsAliases.get(parsed) ?? parsed) : parsed;
        if (serverName == null) {
          return true;
        }
        if (
          defsShadowedServers.has(serverName) ||
          (!collisionAudit.complete && isNormalizationSensitiveName(serverName, mcpRawServerNames))
        ) {
          logger.warn(
            `[Tool Definitions] Skipping MCP tool "${tool}": server "${serverName}" is shadowed by a name collision (or the collision audit is unavailable); rename one server or retry.`,
          );
          return false;
        }
        return true;
      });
    }
  }

  /** @type {Record<string, Record<string, string>>} */
  let userMCPAuthMap;
  if (hasFilteredMCPTools) {
    userMCPAuthMap = await getUserMCPAuthMap({
      tools: filteredTools,
      userId: req.user.id,
      serverNames: mcpRawServerNames,
      findPluginAuthsByKeys,
    });
  }

  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getFlowStateManager(flowsCache);
  const pendingOAuthServers = new Set();
  const pendingOAuthStarts = new Map();
  const emittedOAuthStarts = new Map();
  const oauthToolCallIds = new Map();
  const oauthStepIndexes = new Map();
  /** @type {Record<string, import('@librechat/api').LCAvailableTools>} */
  const mcpAvailableTools = {};
  const requestScopedConnections = getMCPRequestContext(req, res);
  const oboIdentityContext = createAuthIdentityContext({
    user: req.user,
    tenantId: getTenantId(),
  });
  const upstreamTokenProvider = selectMCPUpstreamTokenProvider({
    upstreamTokenProvider: suppliedUpstreamTokenProvider,
    upstreamTokenProviderResolver,
    createSessionProvider: () =>
      createOpenIDSessionTokenProvider({
        req,
        res,
        user: req.user,
        identityContext: oboIdentityContext,
        tokenPreference: 'access_token',
      }),
  });
  const rememberMCPAvailableTools = (serverName, availableTools) => {
    if (!availableTools || Object.keys(availableTools).length === 0) {
      return;
    }
    mcpAvailableTools[serverName] = availableTools;
  };

  const createOAuthEmitter = (serverName, index) => {
    return async (authURL, options) => {
      if (emittedOAuthStarts.get(serverName) === authURL) {
        return;
      }
      emittedOAuthStarts.set(serverName, authURL);

      const flowId =
        oauthToolCallIds.get(serverName) ?? `${req.user.id}:${serverName}:${Date.now()}`;
      const stepId = buildMCPAuthStepId(serverName);
      oauthToolCallIds.set(serverName, flowId);
      oauthStepIndexes.set(serverName, index);
      const toolCall = buildMCPAuthToolCall({
        id: flowId,
        serverName,
      });

      const runStepEvent = buildMCPAuthRunStepEvent({ stepId, toolCall, index });
      const runStepDeltaEvent = buildMCPAuthRunStepDeltaEvent({
        authURL,
        stepId,
        toolCall,
        options,
      });

      if (streamId) {
        await GenerationJobManager.emitChunk(streamId, runStepEvent, {
          expectedCreatedAt: jobCreatedAt,
        });
        await GenerationJobManager.emitChunk(streamId, runStepDeltaEvent, {
          expectedCreatedAt: jobCreatedAt,
        });
      } else if (res && !res.writableEnded) {
        sendEvent(res, runStepEvent);
        sendEvent(res, runStepDeltaEvent);
      } else {
        logger.warn('[Tool Definitions] Cannot emit MCP OAuth event', {
          hasStreamId: Boolean(streamId),
          hasResponse: Boolean(res),
          responseEnded: Boolean(res?.writableEnded),
        });
      }
    };
  };

  const createOAuthEndEmitter = (serverName) => {
    return async () => {
      const stepId = buildMCPAuthStepId(serverName);
      const toolCall = buildMCPAuthToolCall({
        id: oauthToolCallIds.get(serverName),
        args: '',
        output: 'OAuth authentication completed',
        serverName,
        type: 'tool_call',
      });
      const runStepCompletedEvent = buildMCPAuthRunStepCompletedEvent({
        stepId,
        toolCall,
        index: oauthStepIndexes.get(serverName) ?? 0,
      });

      if (streamId) {
        await GenerationJobManager.emitChunk(streamId, runStepCompletedEvent, {
          expectedCreatedAt: jobCreatedAt,
        });
      } else if (res && !res.writableEnded) {
        sendEvent(res, runStepCompletedEvent);
      } else {
        logger.warn('[Tool Definitions] Cannot emit MCP OAuth completion', {
          hasStreamId: Boolean(streamId),
          hasResponse: Boolean(res),
          responseEnded: Boolean(res?.writableEnded),
        });
      }
    };
  };

  const getPendingOAuthStartForEmit = async (serverName) => {
    const cachedOAuthStart = pendingOAuthStarts.get(serverName);
    if (cachedOAuthStart?.options?.expiresAt != null) {
      return cachedOAuthStart;
    }

    const pendingOAuthStart = await getReplayablePendingMCPOAuthStart({
      flowManager,
      userId: req.user.id,
      serverName,
    });
    if (!pendingOAuthStart) {
      return cachedOAuthStart;
    }

    if (!cachedOAuthStart || pendingOAuthStart.authURL === cachedOAuthStart.authURL) {
      pendingOAuthStarts.set(serverName, pendingOAuthStart);
      return pendingOAuthStart;
    }

    return cachedOAuthStart;
  };

  /** Name-preserving: the definitions loader resolves normalized-vs-raw
   *  spellings itself (direct identity first, alias fallback), so this
   *  closure must look up EXACTLY the name it is given. */
  const getOrFetchMCPServerTools = async (userId, serverName) => {
    const addPendingOAuthServer = async () => {
      const pendingOAuthStart = await getReplayablePendingMCPOAuthStart({
        flowManager,
        userId,
        serverName,
      });
      if (!pendingOAuthStart) {
        return false;
      }

      pendingOAuthServers.add(serverName);
      pendingOAuthStarts.set(serverName, pendingOAuthStart);
      return true;
    };

    let serverConfig;
    try {
      serverConfig =
        configServers?.[serverName] ??
        (await getMCPServersRegistry().getServerConfig(serverName, userId, configServers));
    } catch {
      logger.warn(
        '[Tool Definitions] MCP registry unavailable; skipping tool exposure for one server',
      );
      return null;
    }

    if (!serverConfig) {
      logger.warn(
        '[Tool Definitions] Skipping one MCP server because its configuration is unavailable',
      );
      return null;
    }

    const customUserVars = userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];
    const missingUserVars = getMissingCustomUserVars(serverConfig, customUserVars);
    if (missingUserVars.length > 0) {
      logger.warn('[Tool Definitions] Skipping one MCP server with missing user configuration', {
        missingVariableCount: missingUserVars.length,
      });
      return null;
    }

    if (mcpAvailableTools[serverName]) {
      return mcpAvailableTools[serverName];
    }

    const cached = await getMCPServerTools(userId, serverName, serverConfig);
    if (cached) {
      rememberMCPAvailableTools(serverName, cached);
      await addPendingOAuthServer();
      return cached;
    }

    if (await addPendingOAuthServer()) {
      return null;
    }

    const oauthStart = async (authURL, options) => {
      pendingOAuthServers.add(serverName);
      if (typeof authURL === 'string' && authURL.length > 0) {
        pendingOAuthStarts.set(serverName, { authURL, options });
      }
    };

    const result = await reinitMCPServer({
      signal,
      user: req.user,
      oauthStart,
      flowManager,
      serverName,
      configServers,
      userMCPAuthMap,
      requestBody: runtimeRequestBody,
      requestScopedConnections,
      upstreamTokenProvider,
      upstreamTokenProviderResolver,
      oboIdentityContext,
      recoveryPolicy: appConfig?.mcpSettings?.catalogRecovery,
    });

    rememberMCPAvailableTools(serverName, result?.availableTools);
    return result?.availableTools || null;
  };

  const refreshMCPServerTools = async (_userId, serverName) => {
    if (pendingOAuthServers.has(serverName)) {
      return null;
    }

    const oauthStart = async (authURL, options) => {
      pendingOAuthServers.add(serverName);
      if (typeof authURL === 'string' && authURL.length > 0) {
        pendingOAuthStarts.set(serverName, { authURL, options });
      }
    };
    const result = await reinitMCPServer({
      signal,
      user: req.user,
      forceNew: true,
      oauthStart,
      flowManager,
      serverName,
      configServers,
      userMCPAuthMap,
      requestBody: runtimeRequestBody,
      requestScopedConnections,
      upstreamTokenProvider,
      upstreamTokenProviderResolver,
      oboIdentityContext,
      recoveryPolicy: appConfig?.mcpSettings?.catalogRecovery,
    });

    rememberMCPAvailableTools(serverName, result?.availableTools);
    return result?.availableTools || null;
  };

  const getActionToolDefinitions = async (agentId, actionToolNames) => {
    if (agentId !== agent.id || preparedActionSnapshot == null) {
      return [];
    }
    const { actionSets } = preparedActionSnapshot;
    if (actionSets.length === 0) {
      return [];
    }

    const definitions = [];
    const allowedDomains = appConfig?.actions?.allowedDomains;
    const allowedAddresses = appConfig?.actions?.allowedAddresses;
    const normalizedToolNames = new Set(
      actionToolNames.map((n) => n.replace(domainSeparatorRegex, '_')),
    );

    for (const action of actionSets) {
      const domain = await domainParser(action.metadata.domain, true);
      const normalizedDomain = domain.replace(domainSeparatorRegex, '_');

      const legacyDomain = legacyDomainEncode(action.metadata.domain);
      const legacyNormalized = legacyDomain.replace(domainSeparatorRegex, '_');

      const isDomainAllowed = await isActionDomainAllowed(
        action.metadata.domain,
        allowedDomains,
        allowedAddresses,
      );
      if (!isDomainAllowed) {
        logger.warn(
          `[Actions] Domain "${action.metadata.domain}" not in allowedDomains. ` +
            `Add it to librechat.yaml actions.allowedDomains to enable this action.`,
        );
        continue;
      }

      const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
      if (!validationResult.spec || !validationResult.serverUrl) {
        logger.warn(`[Actions] Invalid OpenAPI spec for domain: ${domain}`);
        continue;
      }

      const { functionSignatures } = openapiToFunction(validationResult.spec, true);

      for (const sig of functionSignatures) {
        const toolName = `${sig.name}${actionDelimiter}${normalizedDomain}`;
        const legacyToolName = `${sig.name}${actionDelimiter}${legacyNormalized}`;
        const matchesCurrentName = normalizedToolNames.has(toolName);
        const matchesLegacyName = normalizedToolNames.has(legacyToolName);
        if (!matchesCurrentName && !matchesLegacyName) {
          continue;
        }

        definitions.push({
          /** Keep the selected legacy spelling when that is the only match so
           * persisted tool_options resolve against the emitted definition. */
          name: matchesCurrentName ? toolName : legacyToolName,
          description: sig.description,
          parameters: sig.parameters,
          oauth: action.metadata.auth?.type === AuthTypeEnum.OAuth,
        });
      }
    }

    return definitions;
  };

  let {
    toolDefinitions,
    toolRegistry,
    hasDeferredTools,
    mcpToolAliases,
    mcpResolution,
    oauthActionToolNames,
  } = await loadToolDefinitions(
    {
      userId: req.user.id,
      agentId: agent.id,
      tools: defsFilteredTools,
      toolOptions: agent.tool_options,
      deferredToolsEnabled,
      programmaticToolsEnabled,
      codeExecutionEnabled,
      codeExecutionContext: resolvedCodeExecutionContext,
      codeEnvironments: appConfig?.endpoints?.agents?.statefulCodeSessions?.environments,
      getAppConfig,
      provider: agent.provider,
      mcpServerNames,
      rawServerNames: mcpRawServerNames,
      accessibleServerNames: defsAccessibleServerNames,
    },
    {
      isBuiltInTool,
      getOrFetchMCPServerTools,
      refreshMCPServerTools,
      getActionToolDefinitions,
    },
  );

  /** OAuth discovery must not reconnect (or prompt for) a server whose
   *  definitions the collision filter deliberately rejected. */
  for (const serverName of getMCPServerNamesFromTools(defsFilteredTools, mcpServerNames)) {
    if (pendingOAuthServers.has(serverName)) {
      continue;
    }

    const pendingOAuthStart = await getReplayablePendingMCPOAuthStart({
      flowManager,
      userId: req.user.id,
      serverName,
    });
    if (pendingOAuthStart) {
      pendingOAuthServers.add(serverName);
      pendingOAuthStarts.set(serverName, pendingOAuthStart);
    }
  }

  if (pendingOAuthServers.size > 0 && (res || streamId)) {
    const serverNames = Array.from(pendingOAuthServers);
    logger.info(
      `[Tool Definitions] MCP OAuth required for ${serverNames.length} server(s); emitting events and waiting`,
    );

    const oauthWaitPromises = serverNames.map(async (serverName, index) => {
      try {
        const pendingOAuthStart = await getPendingOAuthStartForEmit(serverName);
        const oauthStart = createOAuthEmitter(serverName, index);
        if (pendingOAuthStart) {
          await oauthStart(pendingOAuthStart.authURL, pendingOAuthStart.options);
        }

        const result = await reinitMCPServer({
          signal,
          user: req.user,
          serverName,
          configServers,
          userMCPAuthMap,
          flowManager,
          requestBody: runtimeRequestBody,
          returnOnOAuth: false,
          oauthStart,
          oauthEnd: createOAuthEndEmitter(serverName),
          connectionTimeout: Time.TWO_MINUTES,
          upstreamTokenProvider,
          upstreamTokenProviderResolver,
          oboIdentityContext,
          recoveryPolicy: appConfig?.mcpSettings?.catalogRecovery,
        });

        if (result?.availableTools && Object.keys(result.availableTools).length > 0) {
          rememberMCPAvailableTools(serverName, result.availableTools);
          logger.info('[Tool Definitions] MCP OAuth completed; tools available');
          return { serverName, success: true };
        }
        return { serverName, success: false };
      } catch (error) {
        if (isFatalAgentInitializationError(error, { signal })) {
          throw error;
        }
        logger.debug('[Tool Definitions] MCP OAuth wait failed for one server');
        return { serverName, success: false };
      }
    });

    const results = await Promise.all(oauthWaitPromises);
    const successfulServers = results
      .filter((result) => result.success)
      .map((result) => result.serverName);

    if (successfulServers.length > 0) {
      logger.info(
        `[Tool Definitions] Reloading tools after OAuth for ${successfulServers.length} server(s)`,
      );
      const reloadResult = await loadToolDefinitions(
        {
          userId: req.user.id,
          agentId: agent.id,
          tools: defsFilteredTools,
          toolOptions: agent.tool_options,
          deferredToolsEnabled,
          programmaticToolsEnabled,
          codeExecutionEnabled,
          codeExecutionContext: resolvedCodeExecutionContext,
          codeEnvironments: appConfig?.endpoints?.agents?.statefulCodeSessions?.environments,
          getAppConfig,
          provider: agent.provider,
          mcpServerNames,
          rawServerNames: mcpRawServerNames,
          accessibleServerNames: defsAccessibleServerNames,
        },
        {
          isBuiltInTool,
          getOrFetchMCPServerTools,
          refreshMCPServerTools,
          getActionToolDefinitions,
        },
      );
      toolDefinitions = reloadResult.toolDefinitions;
      toolRegistry = reloadResult.toolRegistry;
      hasDeferredTools = reloadResult.hasDeferredTools;
      mcpToolAliases = reloadResult.mcpToolAliases;
      mcpResolution = reloadResult.mcpResolution;
      oauthActionToolNames = reloadResult.oauthActionToolNames;
    }
  }

  if (hasExpectedMCPTools && mcpResolution?.resolvedToolCount === 0) {
    throw createExpectedMCPToolsUnavailableError(agent.name);
  }

  /** @type {Record<string, string>} */
  const toolContextMap = {};
  /** @type {Record<string, string>} */
  const dynamicToolContextMap = {};
  const hasWebSearch = filteredTools.includes(Tools.web_search);
  const hasFileSearch = filteredTools.includes(Tools.file_search);
  const hasExecuteCode = filteredTools.includes(Tools.execute_code);

  if (hasWebSearch) {
    toolContextMap[Tools.web_search] = buildWebSearchContext();
    dynamicToolContextMap[Tools.web_search] = buildWebSearchDynamicContext(req.turnStartedAt);
  }

  /**
   * `files` carry the upload session_ids; we surface them so client.js can
   * seed `Graph.sessions[EXECUTE_CODE]` before run start. Without that seed,
   * the agents-side `ToolNode.getCodeSessionContext` returns undefined on
   * call #1, `_injected_files` is never set on the tool call, and the
   * sandbox can't see the prior turn's generated artifacts on first read.
   */
  let primedCodeFiles;
  if (hasExecuteCode && tool_resources) {
    try {
      const { toolContext, files } = await primeCodeFiles({
        req,
        tool_resources,
        agentId: agent.id,
        agentResourceType,
        signal,
        codeApiBaseUrl: resolvedCodeExecutionContext.baseUrl,
        executionProfile: resolvedCodeExecutionContext.executionProfile,
        executionRouteKey: resolvedCodeExecutionContext.executionRouteKey,
        codeFileLocation: getCodeFileLocation(resolvedCodeExecutionContext),
        ...(resolvedCodeExecutionContext.bridgeWorkerId
          ? { bridgeWorkerId: resolvedCodeExecutionContext.bridgeWorkerId }
          : {}),
      });
      if (toolContext) {
        dynamicToolContextMap[Tools.execute_code] = toolContext;
      }
      if (files?.length) {
        primedCodeFiles = files;
      }
    } catch (error) {
      if (isFatalAgentInitializationError(error, { signal })) {
        throw error;
      }
      logger.error(
        '[loadToolDefinitionsWrapper] Error priming code files:',
        getSafeErrorMetadata(error),
      );
    }
  }

  if (hasFileSearch && tool_resources) {
    try {
      const { toolContext } = await primeSearchFiles({
        req,
        tool_resources,
        agentId: agent.id,
        agentResourceType,
      });
      if (toolContext) {
        dynamicToolContextMap[Tools.file_search] = toolContext;
      }
    } catch (error) {
      logger.error(
        '[loadToolDefinitionsWrapper] Error priming search files:',
        getSafeErrorMetadata(error),
      );
    }
  }

  const imageFiles = tool_resources?.[EToolResources.image_edit]?.files ?? [];
  if (imageFiles.length > 0) {
    const hasOaiImageGen = filteredTools.includes('image_gen_oai');
    const hasGeminiImageGen = filteredTools.includes('gemini_image_gen');

    if (hasOaiImageGen) {
      const toolContext = buildImageToolContext({
        imageFiles,
        toolName: `${EToolResources.image_edit}_oai`,
        contextDescription: 'image editing',
      });
      if (toolContext) {
        dynamicToolContextMap.image_edit_oai = toolContext;
      }
    }

    if (hasGeminiImageGen) {
      const toolContext = buildImageToolContext({
        imageFiles,
        toolName: 'gemini_image_gen',
        contextDescription: 'image context',
      });
      if (toolContext) {
        dynamicToolContextMap.gemini_image_gen = toolContext;
      }
    }
  }

  return {
    toolRegistry,
    mcpAvailableTools,
    requestScopedConnections,
    userMCPAuthMap,
    toolContextMap,
    dynamicToolContextMap,
    toolDefinitions,
    hasDeferredTools,
    mcpToolAliases,
    actionsEnabled,
    primedCodeFiles,
    oauthActionToolNames,
    codeExecutionContext: resolvedCodeExecutionContext,
    repositoryInstructionSource: createRepositoryInstructionSource({
      load: repositoryInstructionLoader,
      enabled: codeExecutionEnabled,
      context: resolvedCodeExecutionContext,
      principalId: JSON.stringify([getTenantId(), req.user.id]),
      getAuthHeaders: (workerId) => getCodeApiAuthHeaders(req, workerId),
    }),
  };
}

/**
 * Loads agent tools for initialization or execution.
 * @param {Object} params
 * @param {ServerRequest} params.req - The request object
 * @param {ServerResponse} params.res - The response object
 * @param {Object} params.agent - The agent configuration
 * @param {import('@librechat/api').RequestBody} [params.requestBody] - Normalized MCP body
 * @param {string} [params.agentResourceType] - Permission resource type for the authorized agent route
 * @param {AbortSignal} [params.signal] - Abort signal
 * @param {Object} [params.tool_resources] - Tool resources
 * @param {string} [params.openAIApiKey] - OpenAI API key
 * @param {string|null} [params.streamId] - Stream ID for resumable mode
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted tool events
 * @param {boolean} [params.definitionsOnly=true] - When true, returns only serializable
 *   tool definitions without creating full tool instances. Use for event-driven mode
 *   where tools are loaded on-demand during execution.
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider]
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 */
async function loadAgentTools({
  req,
  res,
  agent,
  requestBody,
  agentResourceType,
  signal,
  tool_resources,
  openAIApiKey,
  streamId = null,
  jobCreatedAt,
  definitionsOnly = true,
  codeExecutionContext: providedCodeExecutionContext,
  accessibleMcpServerNames,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
}) {
  if (definitionsOnly) {
    try {
      return await loadToolDefinitionsWrapper({
        req,
        res,
        agent,
        requestBody,
        agentResourceType,
        streamId,
        jobCreatedAt,
        tool_resources,
        codeExecutionContext: providedCodeExecutionContext,
        accessibleMcpServerNames,
        signal,
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
      });
    } catch (error) {
      if (
        isFatalAgentInitializationError(error, { signal }) ||
        isContentFilterError(error) ||
        !agent.tools?.some(isExpectedMCPTool)
      ) {
        throw error;
      }
      throw createExpectedMCPToolsUnavailableError(agent.name, error);
    }
  }

  if (!agent.tools || agent.tools.length === 0) {
    return { toolDefinitions: [] };
  } else if (
    agent.tools &&
    agent.tools.length === 1 &&
    /** Legacy handling for `ocr` as may still exist in existing Agents */
    (agent.tools[0] === AgentCapabilities.context || agent.tools[0] === AgentCapabilities.ocr)
  ) {
    return { toolDefinitions: [] };
  }

  const appConfig = req.config;
  const enabledCapabilities = await resolveAgentCapabilities(req, appConfig, agent.id);
  const checkCapability = (capability) => {
    const enabled = enabledCapabilities.has(capability);
    if (!enabled) {
      const isToolCapability = [
        AgentCapabilities.file_search,
        AgentCapabilities.execute_code,
        AgentCapabilities.web_search,
      ].includes(capability);
      const suffix = isToolCapability ? ' despite configured tool.' : '.';
      logger.warn(
        `Capability "${capability}" disabled${suffix} User: ${req.user.id} | Agent: ${agent.id}`,
      );
    }
    return enabled;
  };
  const areToolsEnabled = checkCapability(AgentCapabilities.tools);
  const actionsEnabled = checkCapability(AgentCapabilities.actions);
  const hasMCPTools = agent.tools?.some((tool) => tool?.includes(Constants.mcp_delimiter));
  const mcpPermissionContext = createMCPPermissionContext(req);
  const canUseMCP = hasMCPTools ? await mcpPermissionContext.canUseServers(req.user) : true;
  const canUseTool = await resolveAgentToolPermissions(req, agent.tools, enabledCapabilities);

  let includesWebSearch = false;
  const _agentTools = agent.tools?.filter((tool) => {
    if (tool === Tools.file_search) {
      return checkCapability(AgentCapabilities.file_search) && canUseTool(tool);
    } else if (tool === Tools.execute_code) {
      return checkCapability(AgentCapabilities.execute_code) && canUseTool(tool);
    } else if (tool === Tools.web_search) {
      includesWebSearch = checkCapability(AgentCapabilities.web_search) && canUseTool(tool);
      return includesWebSearch;
    } else if (tool === Tools.memory) {
      return checkCapability(AgentCapabilities.memory);
    } else if (tool === ASK_USER_QUESTION_TOOL_NAME) {
      return checkCapability(AgentCapabilities.ask_user_question);
    } else if (isActionTool(tool)) {
      return actionsEnabled;
    } else if (tool?.includes(Constants.mcp_delimiter)) {
      return areToolsEnabled && canUseMCP;
    } else if (!areToolsEnabled) {
      return false;
    }
    return true;
  });

  if (!_agentTools || _agentTools.length === 0) {
    return {};
  }
  assertToolResourcesAllowed({
    req,
    toolResources: tool_resources,
    tools: _agentTools,
  });
  const preparedActionSnapshot = await prepareActionSnapshotForTools({
    agentId: agent.id,
    toolNames: _agentTools,
    filters: req.config?.filters,
    decrypt: true,
  });
  /** @type {ReturnType<typeof createOnSearchResults>} */
  let webSearchCallbacks;
  if (includesWebSearch) {
    webSearchCallbacks = createOnSearchResults(res, streamId, jobCreatedAt);
  }

  /** Resolved once and threaded into `loadTools` so the request app config is
   *  read once. The accessible set (operator + user DB), when the caller's
   *  heal already fetched it, rides along so execution-side collision guards
   *  see cross-tier shadowing without another registry round-trip. */
  let mcpServerContext = _agentTools?.some((t) => t.includes(Constants.mcp_delimiter))
    ? await resolveMcpServerContext(req)
    : undefined;
  if (mcpServerContext && accessibleMcpServerNames?.length) {
    mcpServerContext = { ...mcpServerContext, accessibleServerNames: accessibleMcpServerNames };
  }

  /** @type {Record<string, Record<string, string>>} */
  let userMCPAuthMap;
  if (mcpServerContext) {
    userMCPAuthMap = await getUserMCPAuthMap({
      tools: _agentTools,
      userId: req.user.id,
      serverNames: mcpServerContext.rawServerNames ?? mcpServerContext.serverNames,
      findPluginAuthsByKeys,
    });
  }

  const codeExecutionEnabled =
    agent.tools?.includes(Tools.execute_code) === true &&
    enabledCapabilities.has(AgentCapabilities.execute_code) &&
    canUseTool(Tools.execute_code);
  const runtimeRequestBody = requestBody ?? req.body;
  const statefulCodeSessions =
    codeExecutionEnabled &&
    enabledCapabilities.has(AgentCapabilities.stateful_code_sessions) &&
    agent.stateful_code_sessions === true;
  const baseCodeExecutionContext =
    providedCodeExecutionContext ??
    resolveCodeExecutionContext({
      statefulSessions: statefulCodeSessions,
      environment: agent.stateful_code_environment,
      environmentId: agent.code_environment_id,
      environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
      userId: req.user.id,
      agentId: agent.id,
      conversationId: runtimeRequestBody?.conversationId,
    });
  const codeExecutionContext = await resolveCodeExecutionWorkspaceContext({
    context: baseCodeExecutionContext,
    requestedSelections: runtimeRequestBody?.codeWorkspaces,
    persistedSelections: req.resolvedConversation?.codeWorkspaces,
    environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
    getAppConfig,
  });

  const repositoryInstructionSource = createRepositoryInstructionSource({
    load: repositoryInstructionLoader,
    enabled: codeExecutionEnabled,
    context: codeExecutionContext,
    principalId: JSON.stringify([getTenantId(), req.user.id]),
    getAuthHeaders: (workerId) => getCodeApiAuthHeaders(req, workerId),
  });
  const { loadedTools, toolContextMap, dynamicToolContextMap, primedCodeFiles } = await loadTools({
    agent,
    signal,
    userMCPAuthMap,
    functions: true,
    user: req.user.id,
    tools: _agentTools,
    options: {
      req,
      res,
      requestBody,
      agentResourceType,
      mcpServerContext,
      jobCreatedAt,
      openAIApiKey,
      tool_resources,
      processFileURL,
      uploadImageBuffer,
      returnMetadata: true,
      mcpPermissionContext,
      requestScopedConnections: getMCPRequestContext(req, res),
      upstreamTokenProvider,
      upstreamTokenProviderResolver,
      codeExecutionContext,
      [Tools.web_search]: webSearchCallbacks,
    },
    webSearch: appConfig.webSearch,
    fileStrategy: appConfig.fileStrategy,
    imageOutputType: appConfig.imageOutputType,
  });

  /** Build tool registry from MCP tools and create PTC/tool search tools if configured */
  const deferredToolsEnabled = checkCapability(AgentCapabilities.deferred_tools);
  const programmaticToolsEnabled = enabledCapabilities.has(AgentCapabilities.programmatic_tools);
  const { toolRegistry, toolDefinitions, additionalTools, hasDeferredTools, mcpToolAliases } =
    await buildToolClassification({
      loadedTools,
      userId: req.user.id,
      agentId: agent.id,
      provider: agent.provider,
      agentToolOptions: agent.tool_options,
      gitIdentity: agent.git_identity,
      deferredToolsEnabled,
      programmaticToolsEnabled,
      codeExecutionEnabled,
      codeEnvironments: appConfig?.endpoints?.agents?.statefulCodeSessions?.environments,
      getAppConfig,
      authHeaders: () =>
        codeExecutionAuthHeaders(
          (bridgeWorkerId) => getCodeApiAuthHeaders(req, bridgeWorkerId),
          codeExecutionContext,
        ),
      codeExecutionContext,
    });

  const agentTools = [];
  for (let i = 0; i < loadedTools.length; i++) {
    const tool = loadedTools[i];
    if (tool.name && (tool.name === Tools.execute_code || tool.name === Tools.file_search)) {
      agentTools.push(tool);
      continue;
    }

    if (!areToolsEnabled) {
      continue;
    }

    if (tool.mcp === true) {
      agentTools.push(tool);
      continue;
    }

    if (tool instanceof DynamicStructuredTool) {
      agentTools.push(tool);
      continue;
    }

    const toolDefinition = {
      name: tool.name,
      schema: tool.schema,
      description: tool.description,
    };

    if (imageGenTools.has(tool.name)) {
      toolDefinition.responseFormat = 'content_and_artifact';
    }

    const toolInstance = toolFn(async (...args) => {
      return tool['_call'](...args);
    }, toolDefinition);

    agentTools.push(toolInstance);
  }

  const ToolMap = loadedTools.reduce((map, tool) => {
    map[tool.name] = tool;
    return map;
  }, {});

  agentTools.push(...additionalTools);

  if (preparedActionSnapshot == null) {
    return {
      repositoryInstructionSource,
      toolRegistry,
      requestScopedConnections: getMCPRequestContext(req, res),
      userMCPAuthMap,
      toolContextMap,
      dynamicToolContextMap,
      toolDefinitions,
      hasDeferredTools,
      mcpToolAliases,
      actionsEnabled,
      tools: agentTools,
      primedCodeFiles,
      codeExecutionContext,
    };
  }

  const { storedActions, actionSets } = preparedActionSnapshot;
  if (storedActions.length === 0) {
    if (_agentTools.length > 0 && agentTools.length === 0) {
      logger.warn(`No tools found for ${_agentTools.length} specified tool call(s)`);
    }
    return {
      repositoryInstructionSource,
      toolRegistry,
      requestScopedConnections: getMCPRequestContext(req, res),
      userMCPAuthMap,
      toolContextMap,
      dynamicToolContextMap,
      toolDefinitions,
      hasDeferredTools,
      mcpToolAliases,
      actionsEnabled,
      tools: agentTools,
      primedCodeFiles,
      codeExecutionContext,
    };
  }
  // See registerActionTools for the key-shape rationale.
  const toolToAction = new Map();

  for (let index = 0; index < actionSets.length; index++) {
    const action = actionSets[index];
    const storedAction = storedActions[index];
    const domain = await domainParser(action.metadata.domain, true);
    const normalizedDomain = domain.replace(domainSeparatorRegex, '_');
    const legacyDomain = legacyDomainEncode(action.metadata.domain);
    const legacyNormalized = legacyDomain.replace(domainSeparatorRegex, '_');

    const isDomainAllowed = await isActionDomainAllowed(
      action.metadata.domain,
      appConfig?.actions?.allowedDomains,
      appConfig?.actions?.allowedAddresses,
    );
    if (!isDomainAllowed) {
      continue;
    }

    // Validate and parse OpenAPI spec once per action set
    const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
    if (!validationResult.spec || !validationResult.serverUrl) {
      continue;
    }

    // SECURITY: Validate the domain from the spec matches the stored domain
    // This is defense-in-depth to prevent any stored malicious actions
    const domainValidation = validateActionDomain(
      action.metadata.domain,
      validationResult.serverUrl,
    );
    if (!domainValidation.isValid) {
      logger.error(`Domain mismatch in stored action: ${domainValidation.message}`, {
        userId: req.user.id,
        agent_id: agent.id,
        action_id: action.action_id,
      });
      continue; // Skip this action rather than failing the entire request
    }

    const encrypted = {
      oauth_client_id: storedAction.metadata.oauth_client_id,
      oauth_client_secret: storedAction.metadata.oauth_client_secret,
    };

    // Process the OpenAPI spec once per action set
    const { requestBuilders, functionSignatures, zodSchemas } = openapiToFunction(
      validationResult.spec,
      true,
    );

    registerActionTools({
      toolToAction,
      functionSignatures,
      normalizedDomain,
      legacyNormalized,
      makeEntry: (sig) => ({
        action,
        requestBuilder: requestBuilders[sig.name],
        zodSchema: zodSchemas[sig.name],
        functionSignature: sig,
        encrypted,
      }),
    });
  }

  // Now map tools to the processed action sets
  const ActionToolMap = {};

  for (const toolName of _agentTools) {
    if (ToolMap[toolName]) {
      continue;
    }

    const entry = toolToAction.get(normalizeActionToolName(toolName));
    if (!entry) {
      continue;
    }

    const { action, encrypted, zodSchema, requestBuilder, functionSignature } = entry;
    const _allowedDomains = appConfig?.actions?.allowedDomains;
    const _allowedAddresses = appConfig?.actions?.allowedAddresses;
    const tool = await createActionTool({
      userId: req.user.id,
      res,
      action,
      requestBuilder,
      zodSchema,
      encrypted,
      name: toolName,
      description: functionSignature.description,
      streamId,
      jobCreatedAt,
      useSSRFProtection: !Array.isArray(_allowedDomains) || _allowedDomains.length === 0,
      allowedAddresses: _allowedAddresses,
    });

    if (!tool) {
      logger.warn(
        `Invalid action: user: ${req.user.id} | agent_id: ${agent.id} | toolName: ${toolName}`,
      );
      throw new Error(`{"type":"${ErrorTypes.INVALID_ACTION}"}`);
    }

    agentTools.push(tool);
    ActionToolMap[toolName] = tool;
  }

  if (_agentTools.length > 0 && agentTools.length === 0) {
    logger.warn(`No tools found for ${_agentTools.length} specified tool call(s)`);
    return {};
  }

  return {
    toolRegistry,
    requestScopedConnections: getMCPRequestContext(req, res),
    toolContextMap,
    repositoryInstructionSource,
    dynamicToolContextMap,
    userMCPAuthMap,
    toolDefinitions,
    hasDeferredTools,
    mcpToolAliases,
    actionsEnabled,
    tools: agentTools,
    primedCodeFiles,
    codeExecutionContext,
  };
}

/**
 * Loads tools for event-driven execution (ON_TOOL_EXECUTE handler).
 * This function encapsulates all dependencies needed for tool loading,
 * so callers don't need to import processFileURL, uploadImageBuffer, etc.
 *
 * Handles both regular tools (MCP, built-in) and action tools.
 *
 * @param {Object} params
 * @param {ServerRequest} params.req - The request object
 * @param {ServerResponse} params.res - The response object
 * @param {AbortSignal} [params.signal] - Abort signal
 * @param {Object} params.agent - The agent object
 * @param {import('@librechat/api').RequestBody} [params.requestBody] - Normalized MCP body
 * @param {string} [params.agentResourceType] - Permission resource type for the authorized agent route
 * @param {string[]} params.toolNames - Names of tools to load
 * @param {Map} [params.toolRegistry] - Tool registry
 * @param {unknown} [params.callerCapabilityProjection] - SDK-owned live caller projection
 * @param {Record<string, import('@librechat/api').LCAvailableTools>} [params.mcpAvailableTools] - Run-scoped MCP tool definitions
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections] - Run-scoped MCP connections
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap] - User MCP auth map
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider]
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {Object} [params.tool_resources] - Tool resources
 * @param {string|null} [params.streamId] - Stream ID for web search callbacks
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted tool events
 * @param {string} [params.conversationId] - Resolved conversation identity for this request
 * @param {boolean} [params.actionsEnabled] - Whether the actions capability is enabled
 * @param {readonly string[]} [params.accessibleMcpServerNames] - COMPLETE accessible-server audit resolved at initialization
 * @returns {Promise<{ loadedTools: Array, configurable: Object }>}
 */
async function loadToolsForExecution({
  req,
  res,
  signal,
  agent,
  requestBody,
  agentResourceType,
  toolNames,
  toolRegistry,
  callerCapabilityProjection,
  backgroundToolNames,
  intentToolNames,
  mcpAvailableTools,
  requestScopedConnections,
  userMCPAuthMap,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  tool_resources,
  streamId = null,
  jobCreatedAt,
  conversationId,
  actionsEnabled,
  accessibleMcpServerNames,
  runFileCodeExecutionContext,
}) {
  const appConfig = req.config;
  const allLoadedTools = [];
  const runtimeRequestBody = requestBody ?? req.body;
  const mcpRequestScopedConnections = requestScopedConnections ?? getMCPRequestContext(req, res);
  const configurable = {
    userMCPAuthMap,
    requestBody: runtimeRequestBody,
    requestScopedConnections: mcpRequestScopedConnections,
  };
  const activeCallerCapabilities = resolveCallerCapabilityProjectionSnapshot(
    callerCapabilityProjection,
  );
  const activeCodeExecutionToolNames = activeCallerCapabilities
    ? new Set(activeCallerCapabilities.codeExecutionToolNames)
    : undefined;
  /** Per-agent set of tools that received the injected `run_in_background`
   *  param; the event-driven executor gates background dispatch and the
   *  `check_background_task` poll tool on this reliable per-agent channel. */
  if (backgroundToolNames?.length) {
    configurable.backgroundToolNames = backgroundToolNames;
  }
  /** Per-agent set of tools that received the host-injected `intent` label
   *  param; the executor strips the arg before invocation and removes the
   *  param from schemas the PTC sandbox sees. */
  if (intentToolNames?.length) {
    configurable.intentToolNames = intentToolNames;
  }

  const isToolSearch = toolNames.includes(AgentConstants.TOOL_SEARCH);
  const ptcToolNames = [
    AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING,
    AgentConstants.PROGRAMMATIC_TOOL_CALLING,
  ].filter((name) => toolNames.includes(name));
  const isPTCRequested = ptcToolNames.length > 0;
  const isBashToolRequested = toolNames.includes(AgentConstants.BASH_TOOL);
  const isLegacyExecuteCodeRequested = toolNames.includes(Tools.execute_code);
  const isWorkspaceSearchRequested = toolNames.includes(SEARCH_WORKSPACE_TOOL_NAME);
  const isWorkspaceListRequested = toolNames.includes(LIST_WORKSPACE_FILES_TOOL_NAME);
  const isCodeExecutionToolRequested =
    isBashToolRequested ||
    isLegacyExecuteCodeRequested ||
    isWorkspaceSearchRequested ||
    isWorkspaceListRequested;
  const isSkillToolRequested = toolNames.includes(AgentConstants.SKILL_TOOL);
  const isSandboxFileToolRequested = toolNames.some((name) =>
    [AgentConstants.READ_FILE, CREATE_FILE_TOOL_NAME, EDIT_FILE_TOOL_NAME].includes(name),
  );

  let enabledCapabilities;
  if (
    actionsEnabled === undefined ||
    isPTCRequested ||
    isCodeExecutionToolRequested ||
    isSkillToolRequested ||
    isSandboxFileToolRequested
  ) {
    enabledCapabilities = await resolveAgentCapabilities(req, appConfig, agent?.id);
  }
  if (actionsEnabled === undefined) {
    actionsEnabled = enabledCapabilities.has(AgentCapabilities.actions);
  }
  /** Short-circuits before the role read, so an agent without `execute_code` or a
   *  deployment with the capability off pays nothing for the check. */
  const codeExecutionEnabled =
    enabledCapabilities?.has(AgentCapabilities.execute_code) === true &&
    agent?.tools?.includes(Tools.execute_code) === true &&
    (await checkToolRolePermission({
      req,
      user: req?.user,
      permissionType: PermissionTypes.RUN_CODE,
      getRoleByName,
      context: 'loadToolsForExecution',
    }));

  /** Resolve the trusted endpoint/profile from the actually executing agent.
   * This stays per-agent across handoffs and subagents; no graph-global stateful
   * flag or model-supplied value is consulted. */
  const statefulCodeSessions =
    codeExecutionEnabled &&
    enabledCapabilities?.has(AgentCapabilities.stateful_code_sessions) === true &&
    agent?.stateful_code_sessions === true;
  const baseCodeExecutionContext = resolveCodeExecutionContext({
    statefulSessions: statefulCodeSessions,
    environment: agent?.stateful_code_environment,
    environmentId: agent?.code_environment_id,
    environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
    userId: req.user.id,
    agentId: agent?.id,
    conversationId: conversationId ?? runtimeRequestBody?.conversationId,
  });
  const codeExecutionContext = await resolveCodeExecutionWorkspaceContext({
    context: baseCodeExecutionContext,
    requestedSelections: runtimeRequestBody?.codeWorkspaces,
    persistedSelections: req.resolvedConversation?.codeWorkspaces,
    environments: req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
    getAppConfig,
  });
  Object.assign(
    codeExecutionContext,
    resolveRunFileCodeExecutionContext(codeExecutionContext, runFileCodeExecutionContext),
  );
  configurable.codeExecutionContext = codeExecutionContext;

  const isPTC =
    isPTCRequested &&
    enabledCapabilities.has(AgentCapabilities.programmatic_tools) &&
    codeExecutionEnabled;
  const requestedActionToolNames = toolNames.filter((name) => isActionTool(name));
  const orchestratedActionToolNames =
    isPTC && toolRegistry
      ? Array.from(toolRegistry.keys()).filter((name) => isActionTool(name))
      : [];
  const preflightActionToolNames = [
    ...new Set([...requestedActionToolNames, ...orchestratedActionToolNames]),
  ];
  const preparedActionSnapshot =
    agent && actionsEnabled
      ? await prepareActionSnapshotForTools({
          agentId: agent.id,
          toolNames: preflightActionToolNames,
          filters: req.config?.filters,
          decrypt: true,
        })
      : null;

  logger.debug(
    `[loadToolsForExecution] isToolSearch: ${isToolSearch}, toolRegistry: ${toolRegistry?.size ?? 'undefined'}`,
  );

  if (isToolSearch && toolRegistry) {
    const toolSearchTool = createToolSearch({
      mode: 'local',
      toolRegistry,
    });
    allLoadedTools.push(toolSearchTool);
    configurable.toolRegistry = toolRegistry;
  }

  const canLoadPTC =
    isPTC &&
    toolRegistry != null &&
    (await supportsProgrammaticCodeExecution(
      codeExecutionContext,
      req.config?.endpoints?.agents?.statefulCodeSessions?.environments,
      getAppConfig,
    ));
  if (canLoadPTC) {
    configurable.toolRegistry = toolRegistry;
    try {
      /**
       * LibreChat threads per-request Code API auth through the agents
       * library so PTC calls share the same managed auth context.
       */
      for (const name of ptcToolNames) {
        const ptcTool = createContextProgrammaticBashTool(
          () =>
            codeExecutionAuthHeaders(
              (bridgeWorkerId) => getCodeApiAuthHeaders(req, bridgeWorkerId),
              codeExecutionContext,
            ),
          codeExecutionContext,
          agent?.git_identity,
        );
        ptcTool.name = name;
        allLoadedTools.push(ptcTool);
      }
    } catch (error) {
      logger.error('[loadToolsForExecution] Error creating PTC tool:', getSafeErrorMetadata(error));
    }
  }

  const isBashTool =
    isBashToolRequested &&
    codeExecutionEnabled &&
    toolRegistry?.has(AgentConstants.BASH_TOOL) === true &&
    (codeExecutionContext.environmentType !== 'attached' ||
      codeExecutionContext.codeWorkspace?.operations.includes('execute_command') === true);
  if (isBashToolRequested && !isBashTool) {
    logger.warn(
      `[loadToolsForExecution] Skipping unregistered or unauthorized ${AgentConstants.BASH_TOOL}. ` +
        `User: ${req.user.id} | Agent: ${agent?.id ?? 'unknown'}`,
    );
  }
  if (isBashTool) {
    try {
      const authHeaders = () =>
        codeExecutionAuthHeaders(
          (bridgeWorkerId) => getCodeApiAuthHeaders(req, bridgeWorkerId),
          codeExecutionContext,
        );
      const bashTool =
        codeExecutionContext.environmentType === 'attached'
          ? createAttachedWorkspaceBashTool({
              authHeaders,
              baseUrl: codeExecutionContext.baseUrl,
              workspaceId: codeExecutionContext.codeWorkspace.workspaceId,
              workspaceInstanceId: codeExecutionContext.codeWorkspace.workspaceInstanceId,
              environment: codeExecutionContext.codeWorkspace.environment,
              gitIdentity: agent?.git_identity,
              maxTimeoutMs: resolveAttachedWorkspaceCommandTimeoutMax(
                codeExecutionContext.codeEnvironmentConfigSchema,
                codeExecutionContext.codeWorkspace?.maxCommandTimeoutMs,
              ),
              maxQueueWaitMs: resolveAttachedWorkspaceQueueWaitMs(
                codeExecutionContext.codeEnvironmentConfigSchema,
              ),
            })
          : createBashExecutionTool({
              authHeaders,
              ...codeExecutionContext,
            });
      allLoadedTools.push(bashTool);
    } catch (error) {
      logger.error(
        '[loadToolsForExecution] Failed to create bash_tool',
        getSafeErrorMetadata(error),
      );
    }
  }

  const fileAuthoringToolNames = new Set(
    toolRegistry
      ? Array.from(toolRegistry.values())
          .filter((definition) => isFileAuthoringToolDefinition(definition))
          .map((definition) => definition.name)
      : [],
  );
  const specialToolNames = new Set([
    AgentConstants.TOOL_SEARCH,
    AgentConstants.PROGRAMMATIC_TOOL_CALLING,
    AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING,
    AgentConstants.BASH_TOOL,
    AgentConstants.SKILL_TOOL,
    AgentConstants.READ_FILE,
    ...fileAuthoringToolNames,
  ]);

  let ptcOrchestratedToolNames = [];
  if (canLoadPTC) {
    ptcOrchestratedToolNames = Array.from(toolRegistry.values())
      .filter(
        (toolDef) =>
          !specialToolNames.has(toolDef.name) &&
          (toolDef.allowed_callers ?? ['direct']).includes('code_execution') &&
          (activeCodeExecutionToolNames == null || activeCodeExecutionToolNames.has(toolDef.name)),
      )
      .map((toolDef) => toolDef.name);
  }

  const requestedNonSpecialToolNames = toolNames.filter((name) => !specialToolNames.has(name));
  const allowedNonSpecialToolNames = requestedNonSpecialToolNames.filter((name) => {
    if (name !== Tools.execute_code) {
      return true;
    }
    const allowed = codeExecutionEnabled && toolRegistry?.has(Tools.execute_code) === true;
    if (!allowed) {
      logger.warn(
        `[loadToolsForExecution] Skipping unregistered or unauthorized ${Tools.execute_code}. ` +
          `User: ${req.user.id} | Agent: ${agent?.id ?? 'unknown'}`,
      );
    }
    return allowed;
  });
  const allToolNamesToLoad = isPTC
    ? [...new Set([...allowedNonSpecialToolNames, ...ptcOrchestratedToolNames])]
    : allowedNonSpecialToolNames;

  const actionToolNames = [];
  const regularToolNames = [];
  for (const name of allToolNamesToLoad) {
    (isActionTool(name) ? actionToolNames : regularToolNames).push(name);
  }

  if (regularToolNames.length > 0) {
    const includesWebSearch = regularToolNames.includes(Tools.web_search);
    const webSearchCallbacks = includesWebSearch
      ? createOnSearchResults(res, streamId, jobCreatedAt)
      : undefined;

    const { loadedTools } = await loadTools({
      agent,
      signal,
      userMCPAuthMap,
      functions: true,
      tools: regularToolNames,
      user: req.user.id,
      options: {
        req,
        res,
        requestBody: runtimeRequestBody,
        agentResourceType,
        jobCreatedAt,
        tool_resources,
        processFileURL,
        uploadImageBuffer,
        returnMetadata: true,
        mcpAvailableTools,
        /** Initialization's COMPLETE audit snapshot — reused so a transient
         *  registry failure at execution can't fail-closed a tool the same
         *  turn already advertised. */
        accessibleMcpServerNames,
        requestScopedConnections: mcpRequestScopedConnections,
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
        [Tools.web_search]: webSearchCallbacks,
      },
      webSearch: appConfig?.webSearch,
      fileStrategy: appConfig?.fileStrategy,
      imageOutputType: appConfig?.imageOutputType,
    });

    if (loadedTools) {
      allLoadedTools.push(...loadedTools);
    }
  }

  if (actionToolNames.length > 0 && agent && actionsEnabled) {
    const actionTools = await loadActionToolsForExecution({
      req,
      res,
      agent,
      appConfig,
      streamId,
      jobCreatedAt,
      actionToolNames,
      preparedActionSnapshot,
    });
    allLoadedTools.push(...actionTools);
  } else if (actionToolNames.length > 0 && agent && !actionsEnabled) {
    logger.warn(
      `[loadToolsForExecution] Capability "${AgentCapabilities.actions}" disabled. ` +
        `Skipping action tool execution. User: ${req.user.id} | Agent: ${agent.id} | Tools: ${actionToolNames.join(', ')}`,
    );
  }

  if (isPTC && allLoadedTools.length > 0) {
    const ptcToolMap = new Map();
    for (const tool of allLoadedTools) {
      if (
        tool.name &&
        tool.name !== AgentConstants.PROGRAMMATIC_TOOL_CALLING &&
        tool.name !== AgentConstants.BASH_PROGRAMMATIC_TOOL_CALLING &&
        (toolRegistry.get(tool.name)?.allowed_callers ?? ['direct']).includes('code_execution') &&
        (activeCodeExecutionToolNames == null || activeCodeExecutionToolNames.has(tool.name))
      ) {
        ptcToolMap.set(tool.name, tool);
      }
    }
    configurable.ptcToolMap = ptcToolMap;
  }

  return {
    configurable,
    loadedTools: allLoadedTools,
  };
}

/**
 * Loads action tools for event-driven execution.
 * @param {Object} params
 * @param {ServerRequest} params.req - The request object
 * @param {ServerResponse} params.res - The response object
 * @param {Object} params.agent - The agent object
 * @param {Object} params.appConfig - App configuration
 * @param {string|null} params.streamId - Stream ID
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted tool events
 * @param {string[]} params.actionToolNames - Action tool names to load
 * @param {{storedActions: Array, actionSets: Array}} params.preparedActionSnapshot - Pre-inspected action snapshot
 * @returns {Promise<Array>} Loaded action tools
 */
async function loadActionToolsForExecution({
  req,
  res,
  agent,
  appConfig,
  streamId,
  jobCreatedAt,
  actionToolNames,
  preparedActionSnapshot,
}) {
  const loadedActionTools = [];

  const { storedActions, actionSets } = preparedActionSnapshot ?? {
    storedActions: [],
    actionSets: [],
  };
  if (storedActions.length === 0) {
    return loadedActionTools;
  }

  // See registerActionTools for the key-shape rationale.
  const toolToAction = new Map();
  const allowedDomains = appConfig?.actions?.allowedDomains;
  const allowedAddresses = appConfig?.actions?.allowedAddresses;

  for (let index = 0; index < actionSets.length; index++) {
    const action = actionSets[index];
    const storedAction = storedActions[index];
    const domain = await domainParser(action.metadata.domain, true);
    const normalizedDomain = domain.replace(domainSeparatorRegex, '_');
    const legacyDomain = legacyDomainEncode(action.metadata.domain);
    const legacyNormalized = legacyDomain.replace(domainSeparatorRegex, '_');

    const isDomainAllowed = await isActionDomainAllowed(
      action.metadata.domain,
      allowedDomains,
      allowedAddresses,
    );
    if (!isDomainAllowed) {
      logger.warn(
        `[Actions] Domain "${action.metadata.domain}" not in allowedDomains. ` +
          `Add it to librechat.yaml actions.allowedDomains to enable this action.`,
      );
      continue;
    }

    const validationResult = validateAndParseOpenAPISpec(action.metadata.raw_spec);
    if (!validationResult.spec || !validationResult.serverUrl) {
      logger.warn(`[Actions] Invalid OpenAPI spec for domain: ${domain}`);
      continue;
    }

    const domainValidation = validateActionDomain(
      action.metadata.domain,
      validationResult.serverUrl,
    );
    if (!domainValidation.isValid) {
      logger.error(`Domain mismatch in stored action: ${domainValidation.message}`, {
        userId: req.user.id,
        agent_id: agent.id,
        action_id: action.action_id,
      });
      continue;
    }

    const encrypted = {
      oauth_client_id: storedAction.metadata.oauth_client_id,
      oauth_client_secret: storedAction.metadata.oauth_client_secret,
    };

    const { requestBuilders, functionSignatures, zodSchemas } = openapiToFunction(
      validationResult.spec,
      true,
    );

    registerActionTools({
      toolToAction,
      functionSignatures,
      normalizedDomain,
      legacyNormalized,
      makeEntry: (sig) => ({
        action,
        requestBuilder: requestBuilders[sig.name],
        zodSchema: zodSchemas[sig.name],
        functionSignature: sig,
        encrypted,
      }),
    });
  }

  for (const toolName of actionToolNames) {
    const entry = toolToAction.get(normalizeActionToolName(toolName));
    if (!entry) {
      continue;
    }

    const { action, encrypted, zodSchema, requestBuilder, functionSignature } = entry;
    const tool = await createActionTool({
      userId: req.user.id,
      res,
      action,
      streamId,
      jobCreatedAt,
      zodSchema,
      encrypted,
      requestBuilder,
      name: toolName,
      description: functionSignature.description,
      useSSRFProtection: !Array.isArray(allowedDomains) || allowedDomains.length === 0,
      allowedAddresses,
    });

    if (!tool) {
      logger.warn(`[Actions] Failed to create action tool: ${toolName}`);
      continue;
    }

    loadedActionTools.push(tool);
  }

  return loadedActionTools;
}

module.exports = {
  loadTools,
  isBuiltInTool,
  getToolkitKey,
  loadAgentTools,
  loadToolsForExecution,
  processRequiredActions,
  resolveAgentCapabilities,
  isFatalAgentInitializationError,
  isExpectedMCPToolsUnavailableError,
  /** Re-exported for controllers that already depend on (and mock) this
   *  module, avoiding a fresh heavy `services/MCP` require chain there. */
  getAccessibleMcpServerNames,
};
