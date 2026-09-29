const { logger, getTenantId } = require('@librechat/data-schemas');
const { Calculator, createSearchTool, createCodeExecutionTool } = require('@librechat/agents');
const {
  checkAccess,
  toolkitParent,
  toolRolePermissions,
  checkToolRolePermission,
  createSafeUser,
  loadMCPTools,
  createAuthIdentityContext,
  selectMCPUpstreamTokenProvider,
  mcpToolPattern,
  loadWebSearchAuth,
  splitMCPToolKey,
  buildServerNameAliases,
  findShadowedServerNames,
  isNormalizationSensitiveName,
  buildInlineMemoryTool,
  getCodeApiAuthHeaders,
  buildImageToolContext,
  SET_MEMORY_TOOL_NAME,
  buildWebSearchContext,
  DELETE_MEMORY_TOOL_NAME,
  createAskUserQuestionTool,
  ASK_USER_QUESTION_TOOL_NAME,
  resolveWebSearchSSRFAgents,
  buildWebSearchDynamicContext,
  codeExecutionAuthHeaders,
  getCodeFileLocation,
  resolveCodeExecutionContext,
} = require('@librechat/api');
const {
  AuthType,
  Tools,
  Constants,
  Permissions,
  EToolResources,
  PermissionTypes,
  AgentCapabilities,
} = require('librechat-data-provider');
const {
  availableTools,
  manifestToolMap,
  // Basic Tools
  GoogleSearchAPI,
  // Structured Tools
  DALLE3,
  FluxAPI,
  OpenWeather,
  StructuredSD,
  StructuredACS,
  TraversaalSearch,
  StructuredWolfram,
  TavilySearchResults,
  createGeminiImageTool,
  createOpenAIImageTools,
} = require('../');
const {
  createMCPTool,
  createMCPTools,
  createMCPPermissionContext,
  resolveMcpServerContext,
  resolveCollisionAuditNames,
} = require('~/server/services/MCP');
const { getMCPRequestContext } = require('~/server/services/MCPRequestContext');
const { createOpenIDSessionTokenProvider } = require('~/server/services/OpenIDSessionRefresh');
const { createFileSearchTool, primeFiles: primeSearchFiles } = require('./fileSearch');
const { primeFiles: primeCodeFiles } = require('~/server/services/Files/Code/process');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { loadAuthValues } = require('~/server/services/Tools/credentials');
const { getMCPServerTools, checkCapability } = require('~/server/services/Config');
const { getMCPServersRegistry } = require('~/config');
const { getRoleByName, setMemory, deleteMemory, getFormattedMemories } = require('~/models');

/**
 * Validates the availability and authentication of tools for a user based on environment variables or user-specific plugin authentication values.
 * Tools without required authentication or with valid authentication are considered valid.
 *
 * @param {Object} user The user object for whom to validate tool access.
 * @param {Array<string>} tools An array of tool identifiers to validate. Defaults to an empty array.
 * @returns {Promise<Array<string>>} A promise that resolves to an array of valid tool identifiers.
 */
const validateTools = async (user, tools = []) => {
  try {
    const validToolsSet = new Set(tools);
    const availableToolsToValidate = availableTools.filter((tool) =>
      validToolsSet.has(tool.pluginKey),
    );

    /**
     * Validates the credentials for a given auth field or set of alternate auth fields for a tool.
     * If valid admin or user authentication is found, the function returns early. Otherwise, it removes the tool from the set of valid tools.
     *
     * @param {string} authField The authentication field or fields (separated by "||" for alternates) to validate.
     * @param {string} toolName The identifier of the tool being validated.
     */
    const validateCredentials = async (authField, toolName) => {
      const fields = authField.split('||');
      for (const field of fields) {
        const adminAuth = process.env[field];
        if (adminAuth && adminAuth.length > 0) {
          return;
        }

        let userAuth = null;
        try {
          userAuth = await getUserPluginAuthValue(user, field);
        } catch (err) {
          if (field === fields[fields.length - 1] && !userAuth) {
            throw err;
          }
        }
        if (userAuth && userAuth.length > 0) {
          return;
        }
      }

      validToolsSet.delete(toolName);
    };

    for (const tool of availableToolsToValidate) {
      if (!tool.authConfig || tool.authConfig.length === 0) {
        continue;
      }

      for (const auth of tool.authConfig) {
        await validateCredentials(auth.authField, tool.pluginKey);
      }
    }

    return Array.from(validToolsSet.values());
  } catch (err) {
    logger.error('[validateTools] There was a problem validating tools', err);
    throw new Error(err);
  }
};

/** @typedef {typeof import('@librechat/agents/langchain/tools').Tool} ToolConstructor */
/** @typedef {import('@librechat/agents/langchain/tools').Tool} Tool */

/**
 * Initializes a tool with authentication values for the given user, supporting alternate authentication fields.
 * Authentication fields can have alternates separated by "||", and the first defined variable will be used.
 *
 * @param {string} userId The user ID for which the tool is being loaded.
 * @param {Array<string>} authFields Array of strings representing the authentication fields. Supports alternate fields delimited by "||".
 * @param {ToolConstructor} ToolConstructor The constructor function for the tool to be initialized.
 * @param {Object} options Optional parameters to be passed to the tool constructor alongside authentication values.
 * @returns {() => Promise<Tool>} An Async function that, when called, asynchronously initializes and returns an instance of the tool with authentication.
 */
const loadToolWithAuth = (userId, authFields, ToolConstructor, options = {}) => {
  return async function () {
    const authValues = await loadAuthValues({ userId, authFields });
    const userProvidedAuthFields = new Set(
      authFields
        .flatMap((authField) => authField.split('||'))
        .filter((authField) => {
          const value = process.env[authField];
          return !value || value.trim() === '' || value === AuthType.USER_PROVIDED;
        }),
    );
    return new ToolConstructor({
      ...options,
      ...authValues,
      userId,
      userProvidedAuthFields,
    });
  };
};

/**
 * @param {string} toolKey
 * @returns {Array<string>}
 */
const getAuthFields = (toolKey) => {
  return manifestToolMap[toolKey]?.authConfig.map((auth) => auth.authField) ?? [];
};

/**
 *
 * @param {object} params
 * @param {string} params.user
 * @param {Record<string, Record<string, string>>} [object.userMCPAuthMap]
 * @param {AbortSignal} [object.signal]
 * @param {Pick<Agent, 'id' | 'provider' | 'model'>} [params.agent]
 * @param {string} [params.model]
 * @param {EModelEndpoint} [params.endpoint]
 * @param {LoadToolOptions} [params.options]
 * @param {boolean} [params.useSpecs]
 * @param {Array<string>} params.tools
 * @param {boolean} [params.functions]
 * @param {boolean} [params.returnMap]
 * @param {AppConfig['webSearch']} [params.webSearch]
 * @param {AppConfig['fileStrategy']} [params.fileStrategy]
 * @param {AppConfig['imageOutputType']} [params.imageOutputType]
 * @returns {Promise<{ loadedTools: Tool[], toolContextMap: Object<string, any>, dynamicToolContextMap?: Object<string, any> } | Record<string,Tool>>}
 */
const loadTools = async ({
  user,
  agent,
  model,
  signal,
  endpoint,
  userMCPAuthMap,
  tools = [],
  options = {},
  functions = true,
  returnMap = false,
  webSearch,
  fileStrategy,
  imageOutputType,
}) => {
  const toolConstructors = {
    flux: FluxAPI,
    calculator: Calculator,
    google: GoogleSearchAPI,
    open_weather: OpenWeather,
    wolfram: StructuredWolfram,
    'stable-diffusion': StructuredSD,
    'azure-ai-search': StructuredACS,
    traversaal_search: TraversaalSearch,
    tavily_search_results_json: TavilySearchResults,
  };

  const customConstructors = {
    image_gen_oai: async (_toolContextMap, dynamicToolContextMap) => {
      const authFields = getAuthFields('image_gen_oai');
      const authValues = await loadAuthValues({ userId: user, authFields });
      const imageFiles = options.tool_resources?.[EToolResources.image_edit]?.files ?? [];
      const toolContext = buildImageToolContext({
        imageFiles,
        toolName: `${EToolResources.image_edit}_oai`,
        contextDescription: 'image editing',
      });
      if (toolContext) {
        dynamicToolContextMap.image_edit_oai = toolContext;
      }
      return createOpenAIImageTools({
        ...authValues,
        isAgent: !!agent,
        req: options.req,
        imageOutputType,
        fileStrategy,
        imageFiles,
      });
    },
    gemini_image_gen: async (_toolContextMap, dynamicToolContextMap) => {
      const authFields = getAuthFields('gemini_image_gen');
      const authValues = await loadAuthValues({ userId: user, authFields, throwError: false });
      const imageFiles = options.tool_resources?.[EToolResources.image_edit]?.files ?? [];
      const toolContext = buildImageToolContext({
        imageFiles,
        toolName: 'gemini_image_gen',
        contextDescription: 'image context',
      });
      if (toolContext) {
        dynamicToolContextMap.gemini_image_gen = toolContext;
      }
      return createGeminiImageTool({
        ...authValues,
        isAgent: !!agent,
        req: options.req,
        imageFiles,
        userId: user,
        fileStrategy,
      });
    },
  };

  const requestedTools = {};
  const hasMCPTools = tools.some((toolName) => toolName && mcpToolPattern.test(toolName));
  const mcpPermissionContext =
    options.mcpPermissionContext ?? createMCPPermissionContext(options.req);
  const canUseMCP = hasMCPTools
    ? await mcpPermissionContext.canUseServers(options.req?.user)
    : true;
  let loggedMCPDenied = false;

  if (functions === true) {
    toolConstructors.dalle = DALLE3;
  }

  /** @type {ImageGenOptions} */
  const imageGenOptions = {
    isAgent: !!agent,
    req: options.req,
    fileStrategy,
    processFileURL: options.processFileURL,
    returnMetadata: options.returnMetadata,
    uploadImageBuffer: options.uploadImageBuffer,
  };

  const toolOptions = {
    flux: imageGenOptions,
    dalle: imageGenOptions,
    'stable-diffusion': imageGenOptions,
    gemini_image_gen: imageGenOptions,
  };

  /** @type {Record<string, string>} */
  const toolContextMap = {};
  /** @type {Record<string, string>} */
  const dynamicToolContextMap = {};
  /**
   * @type {import('@librechat/agents').CodeEnvFile[] | undefined}
   * Captured by the `execute_code` factory when files are primed. Surfaced
   * out of `loadTools` so client.js can seed `Graph.sessions[EXECUTE_CODE]`
   * before run start — without that seed, the first `execute_code` /
   * `bash_tool` call lands with empty `_injected_files` and the sandbox
   * can't see the prior turn's generated artifacts.
   */
  let primedCodeFiles;
  const requestedMCPTools = {};

  /** Resolve config-source servers for the current user/tenant context */
  let configServers;
  /** All configured names, in the normalized form tool keys carry */
  let mcpServerNames = [];
  /** All configured names in raw config form, for normalized→raw resolution */
  let mcpRawServerNames = [];
  if (hasMCPTools && canUseMCP) {
    /** Reuse the caller's context when it already resolved one, so the chat
     *  startup path reads the request app config once. */
    ({
      configServers,
      serverNames: mcpServerNames,
      rawServerNames: mcpRawServerNames = [],
    } = options.mcpServerContext ?? (await resolveMcpServerContext(options.req)));
  }
  /**
   * Collision guards need the FULL accessible set (operator + user DB): a
   * cross-tier collision (DB `foo` vs operator `foo!`) is invisible to the
   * operator-config names alone. The caller's heal may have already fetched
   * it (threaded via `mcpServerContext.accessibleServerNames`); otherwise it
   * is fetched ONLY when a configured name actually needs normalizing. When
   * the full set was needed but unavailable, normalization-sensitive
   * references FAIL CLOSED below rather than auditing operator names alone.
   */
  const collisionAudit = hasMCPTools
    ? await resolveCollisionAuditNames({
        rawServerNames: mcpRawServerNames,
        /** Load-time callers thread the audit inside `mcpServerContext`;
         *  deferred execution threads initialization's snapshot as a bare
         *  `accessibleMcpServerNames` (it resolves no server context). */
        accessibleServerNames:
          options.mcpServerContext?.accessibleServerNames ?? options.accessibleMcpServerNames,
        userId: user,
        role: options.req?.user?.role,
      })
    : { names: [], complete: true };
  const serverNameAliases = buildServerNameAliases(collisionAudit.names);
  const shadowedServers = findShadowedServerNames(collisionAudit.names);

  for (const tool of tools) {
    /** `loadTools` is the shared boundary for every runtime that equips these
     *  tools — agents, and the Assistants required-action flow via
     *  `processRequiredActions`, which never passes through the agent capability
     *  filter. Gate here so a denied role cannot reach the sandbox or the search
     *  index down any of them. The check is request-cached, so the agent path
     *  that already resolved this grant pays nothing for the second look. */
    const rolePermission = toolRolePermissions[tool];
    if (rolePermission != null && options.req?.user != null) {
      const allowed = await checkToolRolePermission({
        req: options.req,
        user: options.req.user,
        permissionType: rolePermission,
        getRoleByName,
        context: 'handleTools',
      });
      if (!allowed) {
        continue;
      }
    }

    if (tool === Tools.execute_code) {
      requestedTools[tool] = async () => {
        const statefulSessions =
          agent?.stateful_code_sessions === true &&
          (await checkCapability(options.req, AgentCapabilities.stateful_code_sessions));
        const codeExecutionContext =
          options.codeExecutionContext ??
          resolveCodeExecutionContext({
            statefulSessions,
            environment: agent?.stateful_code_environment,
            environmentId: agent?.code_environment_id,
            environments:
              options.req?.config?.endpoints?.agents?.statefulCodeSessions?.environments,
            userId: user,
            agentId: agent?.id,
            conversationId: options.req?.body?.conversationId,
          });
        const { files, toolContext } = await primeCodeFiles({
          ...options,
          signal,
          agentId: agent?.id,
          codeApiBaseUrl: codeExecutionContext.baseUrl,
          executionProfile: codeExecutionContext.executionProfile,
          executionRouteKey: codeExecutionContext.executionRouteKey,
          bridgeWorkerId: codeExecutionContext.bridgeWorkerId,
          codeFileLocation: getCodeFileLocation(codeExecutionContext),
        });
        if (toolContext) {
          dynamicToolContextMap[tool] = toolContext;
        }
        if (files?.length) {
          primedCodeFiles = files;
        }
        return createCodeExecutionTool({
          user_id: user,
          files,
          authHeaders: () =>
            codeExecutionAuthHeaders(
              (bridgeWorkerId) => getCodeApiAuthHeaders(options.req, bridgeWorkerId),
              codeExecutionContext,
            ),
          ...codeExecutionContext,
        });
      };
      continue;
    } else if (tool === Tools.file_search) {
      requestedTools[tool] = async () => {
        const { files, toolContext } = await primeSearchFiles({
          ...options,
          agentId: agent?.id,
        });
        if (toolContext) {
          dynamicToolContextMap[tool] = toolContext;
        }

        /** @type {boolean | undefined} Check if user has FILE_CITATIONS permission */
        let fileCitations;
        if (fileCitations == null && options.req?.user != null) {
          try {
            fileCitations = await checkAccess({
              user: options.req.user,
              permissionType: PermissionTypes.FILE_CITATIONS,
              permissions: [Permissions.USE],
              getRoleByName,
            });
          } catch (error) {
            logger.error('[handleTools] FILE_CITATIONS permission check failed:', error);
            fileCitations = false;
          }
        }

        return createFileSearchTool({
          appConfig: options.req.config,
          userId: user,
          files,
          entity_id: agent?.id,
          fileCitations,
        });
      };
      continue;
    } else if (tool === Tools.web_search) {
      const result = await loadWebSearchAuth({
        userId: user,
        loadAuthValues,
        webSearchConfig: webSearch,
      });
      if (!result.authenticated) {
        logger.warn('[handleTools] Skipping web search because authentication is incomplete.');
        continue;
      }
      const { onSearchResults, onGetHighlights } = options?.[Tools.web_search] ?? {};
      const { httpAgent, httpsAgent } = resolveWebSearchSSRFAgents(
        result.authResult,
        webSearch?.allowedAddresses,
      );
      requestedTools[tool] = async () => {
        toolContextMap[tool] = buildWebSearchContext();
        dynamicToolContextMap[tool] = buildWebSearchDynamicContext(options.req?.turnStartedAt);
        return createSearchTool({
          ...result.authResult,
          httpAgent,
          httpsAgent,
          onSearchResults,
          onGetHighlights,
          logger,
        });
      };
      continue;
    } else if (tool === ASK_USER_QUESTION_TOOL_NAME) {
      requestedTools[tool] = async () => createAskUserQuestionTool();
      continue;
    } else if (tool === SET_MEMORY_TOOL_NAME || tool === DELETE_MEMORY_TOOL_NAME) {
      requestedTools[tool] = () =>
        buildInlineMemoryTool({
          toolName: tool,
          req: options.req,
          agent,
          userId: user,
          memoryMethods: { setMemory, deleteMemory, getFormattedMemories },
          getRoleByName,
        });
      continue;
    } else if (tool && mcpToolPattern.test(tool)) {
      if (!canUseMCP) {
        if (!loggedMCPDenied) {
          logger.warn(
            `[handleTools] User ${options.req?.user?.id} lacks MCP server use permission`,
          );
          loggedMCPDenied = true;
        }
        continue;
      }

      /** Keys carry the normalized server name (raw in pre-normalization data),
       *  so both spellings resolve the boundary; everything downstream — the
       *  registry, config maps, cache, and auth rows — is keyed by the RAW name. */
      const [toolName, parsedServerName] = splitMCPToolKey(tool, [
        ...mcpServerNames,
        ...serverNameAliases.values(),
      ]);
      if (toolName === Constants.mcp_server) {
        /** Placeholder used for UI purposes */
        continue;
      }
      /** DIRECT-FIRST: a server resolving under the parsed name as-is wins
       *  (a user-DB server may be named exactly like an operator server's
       *  normalized form); only when nothing resolves is the parsed name
       *  treated as a normalized spelling of a raw config name. */
      let serverName = parsedServerName;
      let serverConfig = serverName
        ? await getMCPServersRegistry().getServerConfig(serverName, user, configServers)
        : null;
      if (!serverConfig && serverName != null) {
        const aliasedName = serverNameAliases.get(serverName);
        if (aliasedName != null && aliasedName !== serverName) {
          serverConfig = await getMCPServersRegistry().getServerConfig(
            aliasedName,
            user,
            configServers,
          );
          if (serverConfig) {
            serverName = aliasedName;
          }
        }
      }
      /** A shadowed server's instances (wildcard-expanded or single) get the
       *  SAME normalized names as the winning server's — in-run dispatch
       *  could execute either. Fail closed at execution too, since legacy
       *  raw keys and `mcp_all` tokens bypass catalog filtering. Under an
       *  incomplete audit, any normalization-sensitive reference is
       *  potentially shadowed and fails closed the same way. */
      if (
        serverName != null &&
        (shadowedServers.has(serverName) ||
          (!collisionAudit.complete && isNormalizationSensitiveName(serverName, mcpRawServerNames)))
      ) {
        logger.warn(
          `[handleTools] Skipping MCP tool "${tool}": server "${serverName}" is shadowed by a name collision (or the collision audit is unavailable); rename one server or retry.`,
        );
        continue;
      }
      if (!serverConfig) {
        logger.warn(
          `MCP server "${serverName}" for "${toolName}" tool is not configured${agent?.id != null && agent.id ? ` but attached to "${agent.id}"` : ''}`,
        );
        continue;
      }
      if (toolName === Constants.mcp_all) {
        requestedMCPTools[serverName] = [
          {
            type: 'all',
            serverName,
            config: serverConfig,
          },
        ];
        continue;
      }

      requestedMCPTools[serverName] = requestedMCPTools[serverName] || [];
      requestedMCPTools[serverName].push({
        type: 'single',
        toolKey: tool,
        serverName,
        config: serverConfig,
      });
      continue;
    }

    const toolKey = customConstructors[tool] ? tool : toolkitParent[tool];
    if (toolKey && customConstructors[toolKey]) {
      if (!requestedTools[toolKey]) {
        let cached;
        requestedTools[toolKey] = async () => {
          cached ??= customConstructors[toolKey](toolContextMap, dynamicToolContextMap);
          return cached;
        };
      }
      requestedTools[tool] = requestedTools[toolKey];
      continue;
    }

    if (toolConstructors[tool]) {
      const options = toolOptions[tool] || {};
      const toolInstance = loadToolWithAuth(
        user,
        getAuthFields(tool),
        toolConstructors[tool],
        options,
      );
      requestedTools[tool] = toolInstance;
      continue;
    }
  }

  if (returnMap) {
    return requestedTools;
  }

  const toolPromises = [];
  for (const tool of tools) {
    const validTool = requestedTools[tool];
    if (validTool) {
      toolPromises.push(
        validTool().catch((error) => {
          logger.error(`Error loading tool ${tool}:`, error);
          return null;
        }),
      );
    }
  }

  const loadedTools = (await Promise.all(toolPromises)).flatMap((plugin) => plugin || []);
  const safeUser = createSafeUser(options.req?.user);
  const requestScopedConnections =
    options.requestScopedConnections ?? getMCPRequestContext(options.req, options.res);
  /**
   * Build the OBO upstream-token closure once at the request boundary (where
   * `req`/`res` are in scope) and thread the function into MCP handling, so the
   * MCP layer never receives the raw Express request. The closure reads/refreshes
   * the live `req.session.openidTokens` at tool-call time and mirrors rotations
   * to the `refreshToken` cookie when the response is still writable.
   */
  const oboIdentityContext = createAuthIdentityContext({
    user: options.req?.user,
    tenantId: getTenantId(),
  });
  const upstreamTokenProviderResolver = options.upstreamTokenProviderResolver;
  const upstreamTokenProvider = selectMCPUpstreamTokenProvider({
    upstreamTokenProvider: options.upstreamTokenProvider,
    upstreamTokenProviderResolver,
    createSessionProvider: () =>
      createOpenIDSessionTokenProvider({
        req: options.req,
        res: options.res,
        user: options.req?.user,
        identityContext: oboIdentityContext,
        tokenPreference: 'access_token',
      }),
  });

  loadedTools.push(
    ...(await loadMCPTools({
      userId: user,
      requestedTools: requestedMCPTools,
      availableTools: options.mcpAvailableTools,
      createTools: createMCPTools,
      createTool: createMCPTool,
      getAvailableTools: getMCPServerTools,
      context: {
        mcpPermissionContext,
        signal,
        user: safeUser,
        userMCPAuthMap,
        configServers,
        requestBody: options.requestBody ?? options.req?.body,
        requestScopedConnections,
        res: options.res,
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
        oboIdentityContext,
        streamId: options.req?._resumableStreamId || null,
        jobCreatedAt: options.jobCreatedAt,
        model: agent?.model ?? model,
        provider: agent?.provider ?? endpoint,
      },
    })),
  );
  return { loadedTools, toolContextMap, dynamicToolContextMap, primedCodeFiles };
};

module.exports = {
  loadToolWithAuth,
  validateTools,
  loadTools,
};
