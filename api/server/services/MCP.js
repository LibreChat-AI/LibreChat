const { tool } = require('@librechat/agents/langchain/tools');
const { logger, getTenantId } = require('@librechat/data-schemas');
const { Providers, Constants: AgentConstants } = require('@librechat/agents');
const {
  sendEvent,
  PENDING_STALE_MS,
  MCPOAuthHandler,
  MCPTokenStorage,
  isMCPDomainAllowed,
  splitMCPToolKey,
  normalizeServerName,
  normalizeMCPToolKey,
  stripServerNamePrefix,
  stripServerNamePrefixes,
  buildServerNameAliases,
  findShadowedServerNames,
  getAssistantToolDefinitions: loadAssistantToolDefinitions,
  toProviderToolDefinition,
  resolveMCPServerContext,
  normalizeJsonSchema,
  GenerationJobManager,
  resolveJsonSchemaRefs,
  sanitizeGeminiSchema,
  buildMCPAuthStepId,
  buildMCPAuthToolCall,
  processMCPEnv,
  preProcessGraphTokens,
  buildMCPAuthRunStepEvent,
  buildMCPAuthRunStepDeltaEvent,
  buildMCPAuthRunStepEndDeltaEvent,
  isUserSourced,
  hasCustomUserVars,
  checkAccessWithRequestCache,
  getMissingCustomUserVars,
  getUserMCPAuthMap,
  getServerCustomUserVars,
  requiresEphemeralUserConnection,
  requiresOAuthMachinery,
  hasRuntimeUrlPlaceholders,
  containsGraphTokenPlaceholder,
  createAuthIdentityContext,
  isOAuthServer,
  isAbortError,
  isDirectOpenIDBearerRecoveryEnabled,
  createMCPStructuredTool,
  buildMCPDomainValidationConfig,
  OpenIDReauthRequiredError,
  MCPAuthenticationRefreshError,
  MCPAuthenticationRejectedError,
  prepareMCPAuthorizationMutation,
  resolveMCPClientCapabilityProfile,
  getMCPConnectionPoolKey,
  getMCPUserConnectionPoolKey,
  bindScheduledMCPInvocation,
  ScheduledMCPPolicyError,
} = require('@librechat/api');
const {
  Time,
  CacheKeys,
  Constants,
  Permissions,
  PermissionTypes,
  resolveMCPAppsPolicy,
} = require('librechat-data-provider');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const db = require('~/models');
const { findToken, createToken, updateToken, deleteTokens, findPluginAuthsByKeys } = db;
const { getGraphApiToken } = require('./GraphTokenService');
const { exchangeOboToken } = require('./OboTokenService');
const { createOboTrustChecker } = require('./OboPolicyService');
const { createOpenIDSessionTokenProvider } = require('./OpenIDSessionRefresh');
const { reinitMCPServer } = require('./Tools/mcp');
const {
  getAppConfig,
  getCachedTools,
  getMCPServerTools,
  cacheMCPServerTools,
  invalidateCachedTools,
} = require('./Config');
const { getLogStores } = require('~/cache');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('./MCPAuthorizationFenceRetry');

const MAX_CACHE_SIZE = 1000;
const lastReconnectAttempts = new Map();
const RECONNECT_THROTTLE_MS = 10_000;

const missingToolCache = new Map();
const MISSING_TOOL_TTL_MS = 10_000;

async function userCanUseMCPServers(user, req) {
  if (!user?.id || !user?.role) {
    return false;
  }

  try {
    return await checkAccessWithRequestCache({
      req,
      user,
      permissionType: PermissionTypes.MCP_SERVERS,
      permissions: [Permissions.USE],
      getRoleByName: db.getRoleByName,
    });
  } catch {
    logger.error(`[MCP][User: ${user.id}] Failed MCP permission check`);
    return false;
  }
}

function createMCPPermissionContext(req) {
  return {
    canUseServers: (user = req?.user) => userCanUseMCPServers(user, req),
  };
}

function evictStale(map, ttl) {
  if (map.size <= MAX_CACHE_SIZE) {
    return;
  }
  const now = Date.now();
  for (const [key, timestamp] of map) {
    if (now - timestamp >= ttl) {
      map.delete(key);
    }
    if (map.size <= MAX_CACHE_SIZE) {
      return;
    }
  }
}

const unavailableMsg =
  "This tool's MCP server is temporarily unavailable. Please try again shortly.";

function getOAuthFlowId(userId, serverName, tenantId = getTenantId()) {
  if (!tenantId) {
    return MCPOAuthHandler.generateFlowId(userId, serverName);
  }
  return MCPOAuthHandler.generateFlowId(userId, serverName, tenantId);
}

async function getAppConfigForRequest(req) {
  const user = req?.user;
  return await getAppConfigForUser(user?.id, user);
}

async function getAppConfigForUser(userId, user) {
  return await getAppConfig({ role: user?.role, tenantId: getTenantId(), userId });
}

/**
 * Resolves config-source MCP servers from admin Config overrides for the current
 * request context. Returns the parsed configs keyed by server name.
 * @param {import('express').Request} req - Express request with user context
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function resolveConfigServers(req) {
  try {
    const registry = getMCPServersRegistry();
    const appConfig = await getAppConfigForRequest(req);
    return await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  } catch {
    logger.warn('[resolveConfigServers] Failed to resolve config servers; degrading to empty');
    return {};
  }
}

/**
 * Resolves operator-managed MCP server names from admin Config overrides for the current request.
 * Returns a request-time snapshot for DB server creation, not a cross-process lock.
 * @throws Propagates app config lookup errors to keep DB server creation fail-closed.
 * @param {import('express').Request} req - Express request with user context
 * @returns {Promise<string[]>}
 */
async function resolveMcpConfigNames(req) {
  const appConfig = await getAppConfigForRequest(req);
  return Object.keys(appConfig?.mcpConfig || {});
}

/**
 * All configured server names in the normalized form tool keys are built with.
 * Unlike `resolveConfigServers`, this keeps unmodified YAML servers, which
 * `ensureConfigServers` skips - those are exactly the ones that must still
 * resolve the tool-key boundary.
 * @param {import('express').Request} req
 * @returns {Promise<string[]>}
 */
async function resolveMcpServerNames(req) {
  try {
    const names = await resolveMcpConfigNames(req);
    return names.map(normalizeServerName);
  } catch (error) {
    logger.warn(
      '[resolveMcpServerNames] Failed to resolve server names, degrading to empty:',
      error,
    );
    return [];
  }
}

/**
 * Config-source servers and all configured names from a single app-config read,
 * so the tool-loading path does not pay two lookups for the same principal.
 * Degrades to empty like `resolveConfigServers` rather than aborting tool loading.
 * @param {import('express').Request} req
 * @returns {Promise<{ configServers: Record<string, import('@librechat/api').ParsedServerConfig>, serverNames: string[] }>}
 */
async function resolveMcpServerContext(req) {
  try {
    const appConfig = await getAppConfigForRequest(req);
    return await resolveMCPServerContext({
      mcpConfig: appConfig?.mcpConfig || {},
      ensureConfigServers: (mcpConfig) => getMCPServersRegistry().ensureConfigServers(mcpConfig),
    });
  } catch (error) {
    logger.warn(
      '[resolveMcpServerContext] Failed to resolve MCP servers, degrading to empty:',
      error,
    );
    return { configServers: {}, serverNames: [], rawServerNames: [] };
  }
}

/**
 * Resolves config-source servers and merges all server configs (YAML + config + user DB)
 * for the given user context. Shared helper for controllers needing the full merged config.
 * @param {string} userId
 * @param {{ id?: string, role?: string }} [user]
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
/**
 * Names of every MCP server the user can reach (operator config + user DB),
 * for legacy-key healing: collision detection in `initializeAgent` (consulted
 * when a configured server name needs normalization) and the assistants heal
 * in `healMcpToolNames` (always, since assistants reference user-owned
 * servers too).
 * @param {string} [userId]
 * @param {string} [role]
 * @returns {Promise<string[]>}
 */
async function getAccessibleMcpServerNames(userId, role) {
  const configs = await resolveAllMcpConfigs(
    userId,
    role != null ? { id: userId, role } : { id: userId },
  );
  return Object.keys(configs ?? {});
}

/**
 * Heals legacy raw-keyed MCP tool names in an assistant payload to the
 * current normalized cache keys. Cached tool definitions are keyed
 * `${toolName}${mcp_delimiter}${normalizeServerName(server)}`, while an
 * assistant saved before that convention resubmits the raw-suffixed string
 * on every edit — the controllers' exact-only lookup would then silently
 * drop the tool from the assistant. SHADOWED raw names (normalized slot
 * claimed by another configured server) stay raw and fail closed, mirroring
 * the runtime heal, with the shadow set built from the FULL accessible
 * audit (cross-tier collisions included) and healing skipped outright when
 * that audit cannot complete. Config names are read only when a
 * delimiter-bearing name actually misses the cache; config-read failures
 * propagate (write path) rather than silently dropping the tool. Healed
 * string entries dedupe order-preserving so a payload carrying both
 * spellings can't submit duplicate function names.
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {Array<string | object>} [params.tools]
 * @param {Record<string, unknown>} params.toolDefinitions
 * @returns {Promise<Array<string | object>>}
 */
async function healMcpToolNames({ req, tools, toolDefinitions, accessibleServerNames }) {
  const list = tools ?? [];
  const needsHeal = list.some(
    (tool) =>
      typeof tool === 'string' &&
      tool.includes(Constants.mcp_delimiter) &&
      toolDefinitions[tool] == null,
  );
  if (!needsHeal) {
    return list;
  }
  /** Cross-tier shadowing (DB `foo` vs operator `foo!`) is invisible to
   *  operator names alone — the shadow set must come from the FULL
   *  accessible audit: assistants reference user-owned servers too (the
   *  definitions loader resolves them), so their pre-strip keys must heal
   *  against the same catalog. Callers holding the loader's snapshot pass
   *  it to avoid repeating the app-config and registry reads on the write
   *  path; without one, the audit is fetched here, and when it cannot
   *  complete healing is skipped entirely (the raw key stays raw and fails
   *  closed). */
  let auditNames = accessibleServerNames;
  if (auditNames == null) {
    const rawServerNames = await resolveMcpConfigNames(req);
    try {
      const accessible = await getAccessibleMcpServerNames(req.user?.id, req.user?.role);
      auditNames = [...new Set([...accessible, ...rawServerNames])];
    } catch (error) {
      logger.warn(
        '[healMcpToolNames] Accessible-server audit unavailable; skipping legacy-key healing:',
        error,
      );
      return list;
    }
  }
  const shadowed = findShadowedServerNames(auditNames);
  /** A pre-strip key persisted AFTER server-name normalization carries the
   *  NORMALIZED suffix, which the raw config names cannot match — the
   *  boundary must resolve against both spellings and map back to the raw
   *  name for the shadow and membership guards. */
  const serverNameAliases = buildServerNameAliases(auditNames);
  const boundaryNames = [...new Set([...auditNames, ...serverNameAliases.keys()])];
  const seen = new Set();
  const healedList = [];
  for (const tool of list) {
    let healedTool = tool;
    if (
      typeof tool === 'string' &&
      tool.includes(Constants.mcp_delimiter) &&
      toolDefinitions[tool] == null
    ) {
      const [, parsedServerName] = splitMCPToolKey(tool, boundaryNames);
      let rawServerName;
      if (parsedServerName != null && auditNames.includes(parsedServerName)) {
        rawServerName = parsedServerName;
      } else if (parsedServerName != null) {
        const aliased = serverNameAliases.get(parsedServerName);
        /** A normalized spelling on a CONTESTED slot is ambiguous between the
         *  tie-break winner and its shadowed rivals — rewriting persisted
         *  data must fail closed here, mirroring the raw-spelling shadow
         *  guard, rather than bind the reference to the winner. */
        const contested =
          aliased != null &&
          auditNames.some(
            (name) => name !== aliased && normalizeServerName(name) === parsedServerName,
          );
        rawServerName = contested ? undefined : aliased;
      }
      if (rawServerName != null && !shadowed.has(rawServerName)) {
        const healed = normalizeMCPToolKey(tool, auditNames);
        if (toolDefinitions[healed] != null) {
          healedTool = healed;
        } else {
          /** Catalog keys built after redundant-prefix stripping no longer
           *  match a pre-strip persisted key — without this second candidate
           *  the exact-lookup below silently drops the tool from the
           *  assistant. The rewrite only lands when the stripped key actually
           *  exists in the loaded definitions, so an unstripped catalog
           *  (collision guard kept the raw name) never heals into a phantom. */
          const keyServerName = normalizeServerName(rawServerName);
          const [healedToolName] = splitMCPToolKey(healed, [keyServerName]);
          const strippedName = stripServerNamePrefix(healedToolName, keyServerName);
          const strippedKey = `${strippedName}${Constants.mcp_delimiter}${keyServerName}`;
          /** Rewrite only when the stripped entry PROVES the same upstream
           *  identity — a stale key for a removed tool must not be healed
           *  onto a different sibling that kept its raw name. */
          if (
            strippedName !== healedToolName &&
            toolDefinitions[strippedKey]?.serverToolName === healedToolName
          ) {
            healedTool = strippedKey;
          }
        }
      }
    }
    /** A payload carrying both spellings collapses to one entry after the
     *  heal — duplicate function names make providers reject the save. */
    if (typeof healedTool === 'string') {
      if (seen.has(healedTool)) {
        continue;
      }
      seen.add(healedTool);
    }
    healedList.push(healedTool);
  }
  return healedList;
}

/**
 * Loads static and MCP function definitions used by assistant create/update writes. MCP catalogs
 * are stored per server and effective config, so assistant writers must resolve the referenced
 * server slices instead of relying on the static aggregate cache.
 * @param {object} params
 * @param {ServerRequest} params.req
 * @param {ServerResponse} [params.res]
 * @param {Array<string | object>} [params.tools]
 * @returns {Promise<object>}
 */
async function getAssistantToolDefinitions({ req, res, tools }) {
  const registry = getMCPServersRegistry();
  const appConfig = await getAppConfigForRequest(req);
  const mcpApps = resolveMCPAppsPolicy(
    appConfig?.mcpSettings?.apps,
    undefined,
    appConfig?.mcpAppSandbox?.maxPersistedAppBytes,
    appConfig?.mcpAppSandbox?.maxAdmissionRequestsPerMinute,
    appConfig?.mcpAppSandbox?.url,
    appConfig?.mcpAppSandbox?.maxActiveViews,
    appConfig?.mcpAppSandbox?.maxActionPreviewChars,
    appConfig?.mcpAppSandbox?.operationLimits,
  );
  const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
  const oboIdentityContext = createAuthIdentityContext({
    user: req.user,
    tenantId: getTenantId(),
  });
  const upstreamTokenProvider = createOpenIDSessionTokenProvider({
    req,
    res: res ?? req.res,
    user: req.user,
    identityContext: oboIdentityContext,
    tokenPreference: 'access_token',
  });
  return await loadAssistantToolDefinitions(
    {
      user: req.user,
      tools,
      staticTools: (await getCachedTools()) ?? {},
      mcpConfig: appConfig?.mcpConfig ?? {},
    },
    {
      ensureConfigServers: (mcpConfig) => registry.ensureConfigServers(mcpConfig),
      getAllServerConfigs: (userId, configServers, role) =>
        registry.getAllServerConfigs(userId, configServers, role),
      getMCPServerTools: (userId, serverName, serverConfig) =>
        getMCPServerTools(userId, serverName, serverConfig, capabilityProfile),
      getServerToolFunctionsSnapshot: async (userId, serverName, serverConfig, options) =>
        (await getMCPManager()?.getServerToolFunctionsSnapshot(userId, serverName, serverConfig, {
          ...options,
          capabilityProfile,
        })) ?? {
          tools: null,
        },
      recoverServerTools: async (serverName, serverConfig) => {
        const userMCPAuthMap = await getUserMCPAuthMap({
          userId: req.user.id,
          servers: [serverName],
          findPluginAuthsByKeys,
        });
        const result = await reinitMCPServer({
          user: req.user,
          serverName,
          serverConfig,
          userMCPAuthMap,
          upstreamTokenProvider,
          oboIdentityContext,
          recoveryPolicy: appConfig?.mcpSettings?.catalogRecovery,
          mcpApps,
        });
        return result?.availableTools ?? null;
      },
      cacheMCPServerTools: (params) => cacheMCPServerTools({ ...params, capabilityProfile }),
    },
  );
}

/**
 * Resolves the name set MCP collision guards audit against. Prefers the
 * caller-threaded accessible set; self-fetches only when a configured name
 * needs normalization (safe-name deployments never pay the lookup); reports
 * `complete: false` when the full set was needed but unavailable — callers
 * must then fail closed for normalization-sensitive references instead of
 * auditing against operator names alone.
 * @param {object} params
 * @param {readonly string[]} params.rawServerNames
 * @param {readonly string[]} [params.accessibleServerNames]
 * @param {string} [params.userId]
 * @param {string} [params.role]
 * @returns {Promise<{ names: readonly string[], complete: boolean }>}
 */
async function resolveCollisionAuditNames({ rawServerNames, accessibleServerNames, userId, role }) {
  if (accessibleServerNames?.length) {
    return { names: accessibleServerNames, complete: true };
  }
  const needsFullAudit = rawServerNames.some((name) => normalizeServerName(name) !== name);
  if (!needsFullAudit) {
    return { names: rawServerNames, complete: true };
  }
  try {
    const names = await getAccessibleMcpServerNames(userId, role);
    /** `resolveAllMcpConfigs` tolerates `ensureConfigServers` failures, so
     *  the merged read can silently omit config-only servers. The caller's
     *  raw config names come from the app-config snapshot (registry-
     *  independent), so the union keeps `complete: true` honest. */
    return { names: [...new Set([...names, ...rawServerNames])], complete: true };
  } catch (error) {
    logger.warn(
      '[MCP] Collision audit unavailable; normalization-sensitive references fail closed:',
      error,
    );
    return { names: rawServerNames, complete: false };
  }
}

/**
 * The MCP servers a user can reach, keyed by name, with the registry's tier
 * precedence already applied. This is the resolution behind `GET /api/mcp/servers`,
 * so anything derived from it agrees with the catalog the client was given.
 * @param {string} userId
 * @param {string} [role]
 * @returns {Promise<Record<string, import('@librechat/api').ParsedServerConfig>>}
 */
async function getAccessibleMCPServers(userId, role) {
  return await resolveAllMcpConfigs(userId, role != null ? { role } : undefined);
}

async function resolveAllMcpConfigs(userId, user) {
  const registry = getMCPServersRegistry();
  const appConfig = await getAppConfigForUser(userId, user);
  let configServers = {};
  try {
    configServers = await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  } catch {
    logger.warn('[resolveAllMcpConfigs] Config server resolution failed; continuing without');
  }
  if (user?.role) {
    return await registry.getAllServerConfigs(userId, configServers, user.role);
  }

  return await registry.getAllServerConfigs(userId, configServers);
}

/**
 * Best-effort early gate; the authoritative check is
 * `assertResolvedRuntimeConfigAllowed` in `@librechat/api`, whose *URL*
 * resolution this must mirror. It mirrors only that much: credential-bearing
 * fields are dropped here (`buildMCPDomainValidationConfig`) because this gate
 * runs before the connection path resolves them, so requiring them would reject
 * a server the authoritative check goes on to allow. Graph placeholders resolve
 * later (async), so a URL still carrying one defers to the authoritative check
 * instead of rejecting here.
 */
async function isEarlyDomainAllowed({
  serverConfig,
  user,
  requestBody,
  userMCPAuthMap,
  serverName,
  allowedDomains,
  allowedAddresses,
}) {
  const validationConfig = processMCPEnv({
    user,
    body: requestBody,
    dbSourced: isUserSourced(serverConfig),
    /** The decision reads the URL alone, and resolving a credential-bearing field it
     *  never reads would fail the gate on a stale request-time OpenID snapshot —
     *  before the connection path can refresh that bearer. */
    options: buildMCPDomainValidationConfig(serverConfig),
    customUserVars: getServerCustomUserVars(userMCPAuthMap, serverName),
  });
  if (
    typeof validationConfig?.url === 'string' &&
    containsGraphTokenPlaceholder(validationConfig.url)
  ) {
    return true;
  }
  return await isMCPDomainAllowed(validationConfig, allowedDomains, allowedAddresses);
}

/**
 * @param {string} toolName
 * @param {string} serverName
 */
function createUnavailableToolStub(toolName, serverName) {
  const normalizedToolKey = `${toolName}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;
  const _call = async () => [unavailableMsg, null];
  const toolInstance = tool(_call, {
    schema: {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input for the tool' },
      },
      required: [],
    },
    name: normalizedToolKey,
    description: unavailableMsg,
    responseFormat: AgentConstants.CONTENT_AND_ARTIFACT,
  });
  toolInstance.mcp = true;
  toolInstance.mcpRawServerName = serverName;
  return toolInstance;
}

function isEmptyObjectSchema(jsonSchema) {
  return (
    jsonSchema != null &&
    typeof jsonSchema === 'object' &&
    jsonSchema.type === 'object' &&
    (jsonSchema.properties == null || Object.keys(jsonSchema.properties).length === 0) &&
    !jsonSchema.additionalProperties
  );
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 */
function createRunStepDeltaEmitter({ res, stepId, toolCall, streamId = null, jobCreatedAt }) {
  /**
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @param {{ expiresAt?: number }} [options]
   * @returns {Promise<void>}
   */
  return async function (authURL, options) {
    const eventData = buildMCPAuthRunStepDeltaEvent({ authURL, stepId, toolCall, options });
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData, {
        expectedCreatedAt: jobCreatedAt,
      });
    } else {
      sendEvent(res, eventData);
    }
  };
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.runId - The Run ID, i.e. message ID
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {number} [params.index]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 * @returns {() => Promise<void>}
 */
function createRunStepEmitter({
  res,
  runId,
  stepId,
  toolCall,
  index,
  streamId = null,
  jobCreatedAt,
}) {
  return async function () {
    const eventData = buildMCPAuthRunStepEvent({ runId, stepId, toolCall, index });
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData, {
        expectedCreatedAt: jobCreatedAt,
      });
    } else {
      sendEvent(res, eventData);
    }
  };
}

/**
 * Creates a function used to ensure the flow handler is only invoked once
 * @param {object} params
 * @param {string} params.flowId - The ID of the login flow.
 * @param {FlowStateManager<any>} params.flowManager - The flow manager instance.
 * @param {(authURL: string, options?: { expiresAt?: number }) => void | Promise<void>} [params.callback]
 */
function createOAuthStart({ flowId, flowManager, callback }) {
  /**
   * Creates a function to handle OAuth login requests.
   * @param {string} authURL - The URL to redirect the user for OAuth authentication.
   * @param {{ expiresAt?: number }} [options]
   * @returns {Promise<boolean>} Returns true to indicate the event was sent successfully.
   */
  return async function (authURL, options) {
    let emitted = false;
    const emitOAuthStart = async (message) => {
      if (options) {
        await callback?.(authURL, options);
      } else {
        await callback?.(authURL);
      }
      emitted = true;
      logger.debug(message);
    };

    const existingFlow = await flowManager.getFlowState(flowId, 'oauth_login');
    if (existingFlow) {
      await emitOAuthStart('Re-sent OAuth login request to client');
      return true;
    }

    await flowManager.createFlowWithHandler(flowId, 'oauth_login', async () => {
      await emitOAuthStart('Sent OAuth login request to client');
      return true;
    });

    if (!emitted) {
      await emitOAuthStart('Re-sent OAuth login request to client');
    }

    return true;
  };
}

/**
 * @param {object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {string} params.stepId - The ID of the step in the flow.
 * @param {ToolCallChunk} params.toolCall - The tool call object containing tool information.
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 */
function createOAuthEnd({ res, stepId, toolCall, streamId = null, jobCreatedAt }) {
  return async function () {
    const eventData = buildMCPAuthRunStepEndDeltaEvent({ stepId, toolCall });
    if (streamId) {
      await GenerationJobManager.emitChunk(streamId, eventData, {
        expectedCreatedAt: jobCreatedAt,
      });
    } else {
      sendEvent(res, eventData);
    }
    logger.debug('Sent OAuth login success to client');
  };
}

/**
 * @param {Object} params
 * @param {() => Promise<void>} params.runStepEmitter
 * @param {(authURL: string, options?: { expiresAt?: number }) => Promise<void>} params.runStepDeltaEmitter
 * @returns {(authURL: string, options?: { expiresAt?: number }) => Promise<void>}
 */
function createOAuthCallback({ runStepEmitter, runStepDeltaEmitter }) {
  return async function (authURL, options) {
    await runStepEmitter();
    await runStepDeltaEmitter(authURL, options);
  };
}

function resolveToolCallUserId({ effectiveUser, capturedUser, invocationUserId, serverConfig }) {
  const identityBoundCredential =
    serverConfig?.obo != null || isDirectOpenIDBearerRecoveryEnabled(serverConfig ?? {});
  if (!identityBoundCredential) {
    return effectiveUser?.id || invocationUserId || capturedUser?.id;
  }

  const effectiveUserId = effectiveUser?.id;
  const capturedUserId = capturedUser?.id;
  const credentialLabel = serverConfig?.obo != null ? 'OBO' : 'Direct OpenID bearer';
  if (!effectiveUserId || !capturedUserId) {
    throw new Error(
      `${credentialLabel} tool calls require matching captured and effective user ids`,
    );
  }

  if (effectiveUserId !== capturedUserId) {
    throw new Error(`${credentialLabel} tool call user mismatch`);
  }

  return effectiveUserId;
}

/**
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider] - Live upstream-token closure for OBO, built at the request boundary so this layer never receives the raw Express request.
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {import('@librechat/api').AuthIdentityContext} [params.oboIdentityContext] - Non-template-visible OBO identity context built from the real request user.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName
 * @param {AbortSignal} params.signal
 * @param {string} params.model
 * @param {number} [params.index]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {import('@librechat/api').ParsedServerConfig} [params.serverConfig] - Used to bypass reconnect throttling for request-scoped servers.
 * @param {import('librechat-data-provider').TMCPAppsPolicy} [params.mcpApps]
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function reconnectServer({
  res,
  user,
  index,
  signal,
  serverName,
  serverConfig,
  configServers,
  userMCPAuthMap,
  requestBody,
  requestScopedConnections,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  oboIdentityContext,
  streamId = null,
  jobCreatedAt,
  recoveryPolicy,
  mcpApps,
}) {
  const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
  logger.debug('[MCP][reconnectServer] Starting reconnect', {
    userId: user?.id,
    hasUserMCPAuthMap: Boolean(userMCPAuthMap),
  });

  // Request-scoped servers reconnect on every message by design; throttling them
  // would stub out healthy tools for messages sent within the throttle window.
  const requestScoped = serverConfig ? requiresEphemeralUserConnection(serverConfig) : false;
  if (!requestScoped) {
    const throttleKey = getMCPUserConnectionPoolKey(user.id, serverName, capabilityProfile);
    const now = Date.now();
    const lastAttempt = lastReconnectAttempts.get(throttleKey) ?? 0;
    if (now - lastAttempt < RECONNECT_THROTTLE_MS) {
      logger.debug('[MCP][reconnectServer] Throttled reconnect');
      return null;
    }
    lastReconnectAttempts.set(throttleKey, now);
    evictStale(lastReconnectAttempts, RECONNECT_THROTTLE_MS);
  }

  const runId = Constants.USE_PRELIM_RESPONSE_MESSAGE_ID;
  const flowId = `${user.id}:${serverName}:${Date.now()}`;
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const stepId = buildMCPAuthStepId(serverName);
  const toolCall = buildMCPAuthToolCall({
    id: flowId,
    serverName,
  });

  const runStepEmitter = createRunStepEmitter({
    res,
    index,
    runId,
    stepId,
    toolCall,
    streamId,
    jobCreatedAt,
  });
  const runStepDeltaEmitter = createRunStepDeltaEmitter({
    res,
    stepId,
    toolCall,
    streamId,
    jobCreatedAt,
  });
  const callback = createOAuthCallback({ runStepEmitter, runStepDeltaEmitter });
  const oauthStart = createOAuthStart({
    res,
    flowId,
    callback,
    flowManager,
  });
  return await reinitMCPServer({
    user,
    signal,
    serverName,
    configServers,
    oauthStart,
    flowManager,
    userMCPAuthMap,
    requestBody,
    requestScopedConnections,
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    recoveryPolicy,
    mcpApps,
    oboIdentityContext,
    streamId,
    jobCreatedAt,
    forceNew: true,
    returnOnOAuth: false,
    connectionTimeout: Time.THIRTY_SECONDS,
  });
}

/**
 * Creates all tools from the specified MCP Server via `toolKey`.
 *
 * This function assumes tools could not be aggregated from the cache of tool definitions,
 * i.e. `availableTools`, and will reinitialize the MCP server to ensure all tools are generated.
 *
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {{ canUseServers: (user?: IUser) => Promise<boolean> }} [params.mcpPermissionContext] - Request-scoped MCP permission context.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.serverName
 * @param {string} params.model
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @param {import('@librechat/api').RequestBody} [params.requestBody]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider] - Live upstream-token closure for OBO, built at the request boundary.
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {import('@librechat/api').AuthIdentityContext} [params.oboIdentityContext] - Non-template-visible OBO identity context built from the real request user.
 * @param {import('librechat-data-provider').TMCPAppsPolicy} [params.mcpApps] - Request-admitted MCP Apps policy.
 * @returns { Promise<Array<typeof tool | { _call: (toolInput: Object | string) => unknown}>> } An object with `_call` method to execute the tool input.
 */
async function createMCPTools({
  agentId,
  res,
  mcpPermissionContext,
  user,
  index,
  signal,
  config,
  provider,
  serverName,
  configServers,
  userMCPAuthMap,
  requestBody,
  requestScopedConnections,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  oboIdentityContext,
  mcpApps,
  streamId = null,
  jobCreatedAt,
}) {
  let recoveryPolicy;
  const serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));

  if (serverConfig?.url) {
    const appConfig = await getAppConfig({
      role: user?.role,
      tenantId: user?.tenantId,
      userId: user?.id,
    });
    recoveryPolicy = appConfig?.mcpSettings?.catalogRecovery;
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isEarlyDomainAllowed({
      serverConfig,
      user,
      requestBody,
      userMCPAuthMap,
      serverName,
      allowedDomains,
      allowedAddresses,
    });
    if (!isDomainAllowed) {
      logger.warn('[MCP] Domain not allowed; skipping all server tools');
      return [];
    }
  }

  const result = await reconnectServer({
    res,
    user,
    index,
    signal,
    serverName,
    serverConfig,
    configServers,
    userMCPAuthMap,
    requestBody,
    requestScopedConnections,
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    oboIdentityContext,
    streamId,
    jobCreatedAt,
    recoveryPolicy,
    mcpApps,
  });
  if (result === null) {
    logger.debug('[MCP] Reconnect throttled; skipping tool creation');
    return [];
  }
  if (!result || !result.tools) {
    logger.warn('[MCP] Failed to reinitialize server');
    return [];
  }

  const serverTools = [];
  const keyServerName = normalizeServerName(serverName);
  const keyToolNames = stripServerNamePrefixes(
    result.tools.map((tool) => tool.name),
    keyServerName,
  );
  for (const tool of result.tools) {
    const toolInstance = await createMCPTool({
      agentId,
      res,
      mcpPermissionContext,
      user,
      provider,
      userMCPAuthMap,
      configServers,
      streamId,
      jobCreatedAt,
      recoveryPolicy,
      availableTools: result.availableTools,
      serverName,
      /** Model-facing key: matches the normalized `availableTools` keys and
       *  the instance name `createToolInstance` will assign. */
      toolKey: `${keyToolNames.get(tool.name) ?? tool.name}${Constants.mcp_delimiter}${keyServerName}`,
      requestBody,
      requestScopedConnections,
      upstreamTokenProvider,
      upstreamTokenProviderResolver,
      oboIdentityContext,
      mcpApps,
      config: serverConfig,
    });
    if (toolInstance) {
      serverTools.push(toolInstance);
    }
  }

  return serverTools;
}

/**
 * Creates a single tool from the specified MCP Server via `toolKey`.
 * @param {Object} params
 * @param {ServerResponse} params.res - The Express response object for sending events.
 * @param {{ canUseServers: (user?: IUser) => Promise<boolean> }} [params.mcpPermissionContext] - Request-scoped MCP permission context.
 * @param {IUser} params.user - The user from the request object.
 * @param {string} params.toolKey - The toolKey for the tool.
 * @param {string} params.model - The model for the tool.
 * @param {number} [params.index]
 * @param {AbortSignal} [params.signal]
 * @param {string | null} [params.streamId] - The stream ID for resumable mode.
 * @param {Providers | EModelEndpoint} params.provider - The provider for the tool.
 * @param {LCAvailableTools} [params.availableTools]
 * @param {import('@librechat/api').RequestBody} [params.requestBody]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').ParsedServerConfig} [params.config]
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider] - Live upstream-token closure for OBO, built at the request boundary.
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {import('@librechat/api').AuthIdentityContext} [params.oboIdentityContext] - Non-template-visible OBO identity context built from the real request user.
 * @param {import('librechat-data-provider').TMCPAppsPolicy} [params.mcpApps] - Request-admitted MCP Apps policy.
 * @param {string} [params.serverName] - Resolved raw MCP server name from tool loading.
 * @param {(availableTools: LCAvailableTools) => void} [params.onAvailableTools]
 * @param {number} [params.jobCreatedAt] - The generation epoch that owns emitted events.
 * @returns { Promise<typeof tool | { _call: (toolInput: Object | string) => unknown}> } An object with `_call` method to execute the tool input.
 */
async function createMCPTool({
  agentId,
  res,
  mcpPermissionContext,
  user,
  index,
  signal,
  toolKey,
  provider,
  userMCPAuthMap,
  availableTools,
  requestBody,
  requestScopedConnections,
  config,
  configServers,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  oboIdentityContext,
  mcpApps,
  serverName: resolvedServerName,
  onAvailableTools,
  streamId = null,
  jobCreatedAt,
  recoveryPolicy,
}) {
  const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
  /** `loadTools` already resolved the server for this key; parsing is the fallback. */
  const [parsedToolName, parsedServerName] = splitMCPToolKey(
    toolKey,
    /** Current keys embed the NORMALIZED server name, legacy persisted keys
     *  the RAW one — the candidate list needs both spellings or a raw name
     *  that contains the delimiter mis-splits under the generic fallback. */
    resolvedServerName
      ? [resolvedServerName, normalizeServerName(resolvedServerName)]
      : Object.keys(configServers ?? {}).flatMap((name) => [name, normalizeServerName(name)]),
  );
  let serverName = resolvedServerName ?? parsedServerName;
  const toolName = parsedToolName;

  let serverConfig =
    config ?? (await getMCPServersRegistry().getServerConfig(serverName, user?.id, configServers));
  /** DIRECT-FIRST alias fallback: only when the parsed name resolves to no
   *  server is it treated as the normalized spelling of a raw config name —
   *  a user-DB server named like an operator server's normalized form must
   *  keep its own identity. */
  if (!serverConfig && resolvedServerName == null && parsedServerName != null) {
    const aliasedName = buildServerNameAliases(Object.keys(configServers ?? {})).get(
      parsedServerName,
    );
    if (aliasedName != null && aliasedName !== parsedServerName) {
      serverConfig = await getMCPServersRegistry().getServerConfig(
        aliasedName,
        user?.id,
        configServers,
      );
      if (serverConfig) {
        serverName = aliasedName;
      }
    }
  }
  const requestScopedTools = serverConfig ? requiresEphemeralUserConnection(serverConfig) : false;
  const useMissingToolCache = !requestScopedTools;
  const missingToolCacheKey = getMCPConnectionPoolKey(toolKey, capabilityProfile);

  if (serverConfig?.url) {
    const appConfig = await getAppConfig({
      role: user?.role,
      tenantId: user?.tenantId,
      userId: user?.id,
    });
    recoveryPolicy ??= appConfig?.mcpSettings?.catalogRecovery;
    const allowedDomains = appConfig?.mcpSettings?.allowedDomains;
    const allowedAddresses = appConfig?.mcpSettings?.allowedAddresses;
    const isDomainAllowed = await isEarlyDomainAllowed({
      serverConfig,
      user,
      requestBody,
      userMCPAuthMap,
      serverName,
      allowedDomains,
      allowedAddresses,
    });
    if (!isDomainAllowed) {
      logger.warn('[MCP] Domain no longer allowed; skipping tool creation');
      return undefined;
    }
  }

  /** Legacy keys persisted pre-normalization (assistants, direct tool
   *  calls) carry the RAW server name, while `availableTools` is keyed by
   *  the canonical normalized key — look up both spellings. Keys are also
   *  built after redundant server-name-prefix stripping now, so a persisted
   *  pre-strip key (`acme_foo_mcp_acme`) must additionally try
   *  its stripped spelling or the tool degrades to an unavailable stub. */
  const keyServerName = serverName != null ? normalizeServerName(serverName) : undefined;
  const canonicalToolKey =
    keyServerName != null ? `${toolName}${Constants.mcp_delimiter}${keyServerName}` : toolKey;
  const strippedToolName =
    keyServerName != null ? stripServerNamePrefix(toolName, keyServerName) : toolName;
  const strippedToolKey =
    strippedToolName !== toolName
      ? `${strippedToolName}${Constants.mcp_delimiter}${keyServerName}`
      : null;
  const candidateToolKeys = [toolKey];
  if (canonicalToolKey !== toolKey) {
    candidateToolKeys.push(canonicalToolKey);
  }
  if (strippedToolKey != null && !candidateToolKeys.includes(strippedToolKey)) {
    candidateToolKeys.push(strippedToolKey);
  }
  let matchedToolKey = toolKey;
  const findToolEntry = (tools) => {
    for (const key of candidateToolKeys) {
      const entry = tools?.[key];
      if (!entry?.function) {
        continue;
      }
      /** The stripped-spelling candidate is only a legacy match when the
       *  entry PROVES the same upstream identity — without this, a stale
       *  reference to a removed tool could strip onto a DIFFERENT sibling
       *  that kept its raw name and silently call the wrong tool. */
      if (key === strippedToolKey && entry.serverToolName !== toolName) {
        continue;
      }
      matchedToolKey = key;
      return entry;
    }
    return undefined;
  };

  /** @type {LCFunctionTool | undefined} */
  let toolEntry = findToolEntry(availableTools);
  if (!toolEntry) {
    const cachedAt = useMissingToolCache ? missingToolCache.get(missingToolCacheKey) : undefined;
    if (cachedAt && Date.now() - cachedAt < MISSING_TOOL_TTL_MS) {
      logger.debug('[MCP] Tool is in negative cache; returning unavailable stub');
      return createUnavailableToolStub(toolName, serverName);
    }

    logger.warn('[MCP] Requested tool not found in available tools; reinitializing server');
    const result = await reconnectServer({
      res,
      user,
      index,
      signal,
      serverName,
      serverConfig,
      configServers,
      userMCPAuthMap,
      requestBody,
      requestScopedConnections,
      upstreamTokenProvider,
      upstreamTokenProviderResolver,
      oboIdentityContext,
      streamId,
      jobCreatedAt,
      ...(recoveryPolicy && { recoveryPolicy }),
      mcpApps,
    });
    if (result?.availableTools) {
      onAvailableTools?.(result.availableTools);
    }
    toolEntry = findToolEntry(result?.availableTools);

    if (!toolEntry && useMissingToolCache) {
      missingToolCache.set(missingToolCacheKey, Date.now());
      evictStale(missingToolCache, MISSING_TOOL_TTL_MS);
    }
  }

  if (!toolEntry) {
    logger.warn(
      `[MCP][${serverName}][${toolName}] Tool definition not found, returning unavailable stub.`,
    );
    return createUnavailableToolStub(toolName, serverName);
  }

  return createToolInstance({
    scheduledMCPInvocation: bindScheduledMCPInvocation(requestScopedConnections, agentId, toolName),
    res,
    mcpPermissionContext,
    user,
    requestBody,
    requestScopedConnections,
    provider,
    /** A legacy pre-strip key that resolves to the stripped entry KEEPS its
     *  persisted spelling as the instance name: `agent.tools` entries and
     *  `tool_options` keys reference that spelling, and renaming the instance
     *  would silently detach those per-tool settings. The upstream call name
     *  still comes from the MATCHED entry — its recorded raw name, or the
     *  matched key's own tool half when the entry was never stripped. */
    toolName,
    serverToolName:
      toolEntry.serverToolName ??
      (matchedToolKey === strippedToolKey ? strippedToolName : toolName),
    currentToolName: matchedToolKey === strippedToolKey ? strippedToolName : undefined,
    serverName,
    serverConfig,
    toolDefinition: toolEntry['function'],
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    oboIdentityContext,
    mcpApps,
    streamId,
    jobCreatedAt,
    recoveryPolicy,
  });
}

function createToolInstance({
  scheduledMCPInvocation,
  res,
  mcpPermissionContext,
  user: capturedUser = null,
  requestBody: capturedRequestBody,
  requestScopedConnections: capturedRequestScopedConnections,
  toolName,
  serverToolName = toolName,
  currentToolName,
  serverName,
  serverConfig: capturedServerConfig,
  toolDefinition,
  provider: capturedProvider,
  upstreamTokenProvider: capturedUpstreamTokenProvider = null,
  upstreamTokenProviderResolver: capturedUpstreamTokenProviderResolver = null,
  oboIdentityContext: capturedOboIdentityContext = null,
  mcpApps: capturedMCPApps,
  streamId = null,
  jobCreatedAt,
  recoveryPolicy,
}) {
  /** @type {LCTool} */
  const { description, parameters } = toolDefinition;
  const isGoogle = capturedProvider === Providers.VERTEXAI || capturedProvider === Providers.GOOGLE;

  let schema = parameters ? normalizeJsonSchema(resolveJsonSchemaRefs(parameters)) : null;

  if (schema && isGoogle) {
    // Gemini/Vertex AI accept only a subset of JSON Schema; sanitize so MCP tools with
    // unions, non-string enums, etc. don't 400 (they work as-is on OpenAI/Claude).
    schema = sanitizeGeminiSchema(schema);
  }

  if (!schema || (isGoogle && isEmptyObjectSchema(schema))) {
    schema = {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input for the tool' },
      },
      required: [],
    };
  }

  const normalizedToolKey = `${toolName}${Constants.mcp_delimiter}${normalizeServerName(serverName)}`;

  /** @type {(toolArguments: Object | string, config?: GraphRunnableConfig) => Promise<unknown>} */
  const _call = async (toolArguments, config) => {
    const effectiveUser = config?.configurable?.user ?? capturedUser;
    const permissionUser = effectiveUser;
    /** @type {string | undefined} */
    let userId;

    try {
      userId = resolveToolCallUserId({
        effectiveUser,
        capturedUser,
        invocationUserId: config?.configurable?.user_id,
        serverConfig: capturedServerConfig,
      });
      const provider = (config?.metadata?.provider || capturedProvider)?.toLowerCase();
      const canUseMCP = mcpPermissionContext
        ? await mcpPermissionContext.canUseServers(permissionUser)
        : await userCanUseMCPServers(permissionUser);
      if (!canUseMCP) {
        throw new Error('Forbidden: Insufficient MCP server permissions');
      }
      const flowsCache = getLogStores(CacheKeys.FLOWS);
      const flowManager = getFlowStateManager(flowsCache);
      const derivedSignal = config?.signal ? AbortSignal.any([config.signal]) : undefined;
      const mcpManager = getMCPManager(userId);

      const { args: _args, stepId, ...toolCall } = config.toolCall ?? {};
      const flowId = `${serverName}:oauth_login:${config.metadata.thread_id}:${config.metadata.run_id}`;
      const runStepDeltaEmitter = createRunStepDeltaEmitter({
        res,
        stepId,
        toolCall,
        streamId,
        jobCreatedAt,
      });
      const oauthStart = createOAuthStart({
        flowId,
        flowManager,
        callback: runStepDeltaEmitter,
      });
      const oauthEnd = createOAuthEnd({
        res,
        stepId,
        toolCall,
        streamId,
        jobCreatedAt,
      });

      const customUserVars =
        config?.configurable?.userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];

      /**
       * The upstream-token closure is built at the request boundary (where
       * `req`/`res` are in scope) and captured here, so this layer never holds
       * the raw Express request. The closure reads/refreshes the LIVE
       * `req.session.openidTokens` at call time and persists rotations; it is a
       * no-op when reuse is off or the user is non-OpenID. A browser request whose session loses
       * openidTokens rejects instead of falling back to a stale strategy snapshot.
       * `tokenPreference: 'access_token'` (set at construction)
       * is required for OBO since the grant sends the access token to the IdP
       * as the jwt-bearer assertion.
       */
      const result = await mcpManager.callTool({
        scheduledMCPInvocation,
        serverName,
        serverConfig: capturedServerConfig,
        /** The upstream server never sees stripped names — a key that dropped
         *  a redundant server-name prefix calls the ORIGINAL tool. */
        toolName: serverToolName,
        provider,
        toolArguments,
        options: {
          signal: derivedSignal,
        },
        user: effectiveUser,
        requestBody: config?.configurable?.requestBody ?? capturedRequestBody,
        requestScopedConnections:
          config?.configurable?.requestScopedConnections ?? capturedRequestScopedConnections,
        customUserVars,
        flowManager,
        tokenMethods: {
          findToken,
          createToken,
          updateToken,
          deleteTokens,
        },
        onOAuthCredentialsChanging: (scope) =>
          prepareMCPAuthorizationMutation(scope, {
            invalidateRecoveryGeneration: invalidateCachedTools,
            persistPublicationRetry: persistMCPAuthorizationFenceRetry,
            clearPublicationRetry: clearMCPAuthorizationFenceRetry,
            clearLocalRecovery: (userId, changedServerName) =>
              mcpManager.clearCatalogRecoveryState?.(userId, changedServerName),
            retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
            attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
          }),
        oauthStart,
        oauthEnd,
        graphTokenResolver: getGraphApiToken,
        oboTokenResolver: exchangeOboToken,
        oboTrustChecker: createOboTrustChecker(),
        upstreamTokenProvider: capturedUpstreamTokenProvider,
        upstreamTokenProviderResolver: capturedUpstreamTokenProviderResolver,
        oboIdentityContext: capturedOboIdentityContext,
        mcpApps: capturedMCPApps,
      });
      return result;
    } catch (error) {
      /** A user Stop aborts every in-flight call at once, and that rejection is
       *  the cancellation working, so it must not reach error-level operational
       *  alerts; the wrapping below still reports it to the turn. The error has
       *  to look like an abort as well: a permission, OAuth, or upstream failure
       *  can reject in the same tick as the Stop and must stay visible. */
      if (
        config?.signal?.aborted === true &&
        (isAbortError(error) || error === config.signal.reason)
      ) {
        logger.debug(
          `[MCP][${serverName}][${toolName}][User: ${userId}] Tool call cancelled by user abort`,
        );
        throw error;
      } else {
        logger.error(
          `[MCP][${serverName}][${toolName}][User: ${userId}] Error calling MCP tool:`,
          error,
        );
      }

      // The schedule service checks the typed cause and verified job identity before
      // recording a durable tool failure; other tool errors are a cheap no-op.
      await require('~/server/services/Schedules').recordMCPToolAuthFailure({
        error,
        identity: scheduledMCPInvocation?.identity,
        streamId,
        jobCreatedAt,
        userId,
        serverName,
      });

      /** Carries the actionable re-auth message; the substring heuristic below would misreport it as an OAuth configuration problem */
      if (
        error instanceof ScheduledMCPPolicyError ||
        error instanceof OpenIDReauthRequiredError ||
        error instanceof MCPAuthenticationRefreshError ||
        error instanceof MCPAuthenticationRejectedError
      ) {
        throw error;
      }

      /** OAuth error, provide a helpful message */
      const isOAuthError =
        error.message?.includes('401') ||
        error.message?.includes('OAuth') ||
        error.message?.includes('authentication') ||
        error.message?.includes('Non-200 status code (401)');
      const isOAuthFlowSignal =
        error.message === 'OAuth flow initiated - return early' ||
        error.message === 'Pending OAuth flow reused - return early';

      if (isOAuthError) {
        if (
          capturedServerConfig &&
          !requiresOAuthMachinery(capturedServerConfig) &&
          !isOAuthFlowSignal
        ) {
          throw new Error(
            `[MCP][${serverName}][${toolName}] upstream authentication failed; MCP OAuth is not configured for this server.`,
          );
        }
        throw new Error(
          `[MCP][${serverName}][${toolName}] OAuth authentication required. Please check the server logs for the authentication URL.`,
        );
      }

      throw new Error(
        `[MCP][${serverName}][${toolName}] tool call failed${error?.message ? `: ${error?.message}` : '.'}`,
      );
    }
  };

  const toolInstance = createMCPStructuredTool(_call, {
    schema,
    name: normalizedToolKey,
    description: description || '',
    responseFormat: AgentConstants.CONTENT_AND_ARTIFACT,
  });
  toolInstance.mcp = true;
  toolInstance.mcpRawServerName = serverName;
  if (serverToolName !== toolName) {
    /** Upstream identity for stripped keys — lets the options aliasing in
     *  `buildToolClassification` heal legacy `tool_options` spellings. */
    toolInstance.mcpServerToolName = serverToolName;
  }
  if (currentToolName != null && currentToolName !== toolName) {
    /** Current catalog spelling for a LEGACY-named instance, so approval
     *  policies and hook matchers written against the current name still
     *  reach it (see `collectMCPToolAliases`). */
    toolInstance.mcpCurrentToolName = currentToolName;
  }
  // Ephemeral request-scoped servers (runtime body placeholders) tear their
  // connection down at request end, so they must never be backgrounded. A
  // missing/stale config means the server's lifetime is unknowable, so fail
  // closed (foreground) rather than risk a detached call against a torn-down
  // connection.
  toolInstance.mcpRequiresEphemeralConnection = capturedServerConfig
    ? requiresEphemeralUserConnection(capturedServerConfig)
    : true;
  // On Google/Vertex, propagate the union-flattened schema so definitions extracted
  // from this instance don't reach the Gemini converter with unsupported unions.
  toolInstance.mcpJsonSchema = isGoogle ? schema : parameters;
  return toolInstance;
}

/**
 * Get MCP setup data including config, connections, and OAuth servers.
 * Resolves config-source servers from admin Config overrides when tenant context is available.
 * @param {string} userId - The user ID
 * @param {{ role?: string, tenantId?: string, appConfig?: object }} [options] - Optional request context
 * @returns {Object} Object containing mcpConfig, appConnections, userConnections, and oauthServers
 */
async function getMCPSetupData(userId, options = {}) {
  const registry = getMCPServersRegistry();
  const { role, tenantId } = options;

  const appConfig = options.appConfig ?? (await getAppConfig({ role, tenantId, userId }));
  const capabilityProfile = resolveMCPClientCapabilityProfile(
    resolveMCPAppsPolicy(
      appConfig?.mcpSettings?.apps,
      undefined,
      appConfig?.mcpAppSandbox?.maxPersistedAppBytes,
      appConfig?.mcpAppSandbox?.maxAdmissionRequestsPerMinute,
      appConfig?.mcpAppSandbox?.url,
      appConfig?.mcpAppSandbox?.maxActiveViews,
      appConfig?.mcpAppSandbox?.maxActionPreviewChars,
      appConfig?.mcpAppSandbox?.operationLimits,
    ),
  );
  const configServers = await registry.ensureConfigServers(appConfig?.mcpConfig || {});
  const mcpConfig = role
    ? await registry.getAllServerConfigs(userId, configServers, role)
    : await registry.getAllServerConfigs(userId, configServers);
  const mcpManager = getMCPManager(userId);
  /** @type {Map<string, import('@librechat/api').MCPConnection>} */
  let appConnections = new Map();
  try {
    // Use getLoaded() instead of getAll() to avoid forcing connection creation.
    // getAll() creates connections for all servers, which is problematic for servers
    // that require user context (e.g., those with {{LIBRECHAT_USER_ID}} placeholders).
    appConnections = await mcpManager.getLoadedAppConnections(capabilityProfile);
  } catch (error) {
    logger.error(`[MCP][User: ${userId}] Error getting app connections:`, error);
  }
  const userConnections = mcpManager.getUserConnections(userId, capabilityProfile) || new Map();
  const oauthServers = new Set(
    Object.entries(mcpConfig)
      .filter(([, config]) => isOAuthServer(config))
      .map(([name]) => name),
  );

  return {
    mcpConfig,
    oauthServers,
    appConnections,
    userConnections,
  };
}

/**
 * Check OAuth flow status for a user and server
 * @param {string} userId - The user ID
 * @param {string} serverName - The server name
 * @param {string} [tenantId] - The tenant ID for the current request.
 * @returns {Object} Object containing active and failed flow flags
 */
async function checkOAuthFlowStatus(userId, serverName, tenantId = getTenantId()) {
  const flowsCache = getLogStores(CacheKeys.FLOWS);
  const flowManager = getFlowStateManager(flowsCache);
  const flowId = getOAuthFlowId(userId, serverName, tenantId);

  try {
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return { hasActiveFlow: false, hasFailedFlow: false };
    }

    const flowAge = Date.now() - flowState.createdAt;
    // Report active only while the flow is still usable (the handling/reuse window),
    // not for the full Keyv retention TTL — otherwise the UI shows "connecting" for a
    // flow the initiate/callback paths already reject, hiding the connect button.
    const flowTTL = flowState.ttl || PENDING_STALE_MS;

    if (flowState.status === 'FAILED' || (flowState.status === 'PENDING' && flowAge > flowTTL)) {
      const wasCancelled = /abort|cancel/i.test(flowState.error ?? '');

      if (wasCancelled) {
        logger.debug(`[MCP Connection Status] Found cancelled OAuth flow for ${serverName}`, {
          flowId,
          status: flowState.status,
          error: flowState.error,
        });
        return { hasActiveFlow: false, hasFailedFlow: false };
      } else {
        logger.debug(`[MCP Connection Status] Found failed OAuth flow for ${serverName}`, {
          flowId,
          status: flowState.status,
          flowAge,
          flowTTL,
          timedOut: flowAge > flowTTL,
          error: flowState.error,
        });
        return { hasActiveFlow: false, hasFailedFlow: true };
      }
    }

    if (flowState.status === 'PENDING') {
      logger.debug(`[MCP Connection Status] Found active OAuth flow for ${serverName}`, {
        flowId,
        flowAge,
        flowTTL,
      });
      return { hasActiveFlow: true, hasFailedFlow: false };
    }

    return { hasActiveFlow: false, hasFailedFlow: false };
  } catch (error) {
    logger.error(`[MCP Connection Status] Error checking OAuth flows for ${serverName}:`, error);
    return { hasActiveFlow: false, hasFailedFlow: false };
  }
}

async function hasDurableMCPAuthorization(userId, serverName, config, runtimeContext = {}) {
  const userMCPAuthMap =
    runtimeContext.userMCPAuthMap ?? (await runtimeContext.loadUserMCPAuthMap?.());
  const customUserVars = getServerCustomUserVars(userMCPAuthMap, serverName);
  if (getMissingCustomUserVars(config, customUserVars).length > 0) {
    return false;
  }

  const dbSourced = isUserSourced(config);
  const bindingConfig = {
    ...config,
    args: undefined,
    env: undefined,
    headers: undefined,
    oauth_headers: undefined,
  };
  const graphProcessedConfig = dbSourced
    ? bindingConfig
    : await preProcessGraphTokens(bindingConfig, {
        user: runtimeContext.user,
        graphTokenResolver: getGraphApiToken,
        scopes: process.env.GRAPH_API_SCOPES,
      });
  const runtimeConfig = processMCPEnv({
    user: runtimeContext.user,
    options: graphProcessedConfig,
    dbSourced,
    customUserVars,
  });
  const allowlists = await (runtimeContext.loadMCPAllowlists?.() ??
    getMCPServersRegistry().resolveAllowlists({
      userId,
      role: runtimeContext.user?.role,
    }));
  if (
    runtimeConfig.url &&
    !(await isMCPDomainAllowed(
      runtimeConfig,
      allowlists.allowedDomains,
      allowlists.allowedAddresses,
    ))
  ) {
    return false;
  }
  return MCPTokenStorage.hasStoredAuthorization({
    userId,
    serverName,
    findToken,
    validateClientBinding: (clientInfo, storedMetadata) =>
      MCPOAuthHandler.assertStoredClientBinding(
        serverName,
        runtimeConfig.url,
        clientInfo,
        storedMetadata,
        runtimeConfig.oauth,
      ),
  });
}

async function getMCPUserConfigurationState(serverName, config, runtimeContext = {}) {
  if (!hasCustomUserVars(config)) {
    return undefined;
  }

  const userMCPAuthMap =
    runtimeContext.userMCPAuthMap ?? (await runtimeContext.loadUserMCPAuthMap?.());
  const customUserVars = getServerCustomUserVars(userMCPAuthMap, serverName);
  return getMissingCustomUserVars(config, customUserVars).length > 0
    ? 'needs_configuration'
    : 'configured';
}

function canDetectMCPRuntimeOAuth(config) {
  return config.requiresOAuth == null && config.apiKey == null && hasRuntimeUrlPlaceholders(config);
}

/**
 * Get connection status for a specific MCP server
 * @param {string} userId - The user ID
 * @param {string} serverName - The server name
 * @param {import('@librechat/api').ParsedServerConfig} config - The server configuration
 * @param {Map<string, import('@librechat/api').MCPConnection>} appConnections - App-level connections
 * @param {Map<string, import('@librechat/api').MCPConnection>} userConnections - User-level connections
 * @param {Set} oauthServers - Set of OAuth servers
 * @param {{ user?: Partial<IUser>, userMCPAuthMap?: Record<string, Record<string, string>>, loadUserMCPAuthMap?: () => Promise<Record<string, Record<string, string>> | undefined>, loadMCPAllowlists?: () => Promise<{ allowedDomains?: string[] | null, allowedAddresses?: string[] | null }> }} [runtimeContext]
 * @returns {Object} Object containing requiresOAuth, requestScoped, connectionState, and authorizationState
 */
async function getServerConnectionStatus(
  userId,
  serverName,
  config,
  appConnections,
  userConnections,
  oauthServers,
  runtimeContext = {},
) {
  const connection = appConnections.get(serverName) || userConnections.get(serverName);
  const isStaleOrDoNotExist = connection ? connection?.isStale(config.updatedAt) : true;
  const configuredOAuth = oauthServers.has(serverName);
  const liveConnectionOAuth = connection?.usesOAuth?.() === true;
  const runtimeOAuthCandidate = canDetectMCPRuntimeOAuth(config);
  const effectiveOAuth = configuredOAuth || liveConnectionOAuth;
  const requestScoped = requiresEphemeralUserConnection(config);
  const configurationState = requestScoped
    ? await getMCPUserConfigurationState(serverName, config, runtimeContext)
    : undefined;

  const baseConnectionState = isStaleOrDoNotExist
    ? 'disconnected'
    : connection?.connectionState || 'disconnected';
  let finalConnectionState = baseConnectionState;
  let requiresOAuth = effectiveOAuth;
  let authorizationState = effectiveOAuth ? 'needs_authorization' : 'not_required';

  // connection state overrides specific to OAuth servers
  if (effectiveOAuth && baseConnectionState === 'connected') {
    authorizationState = 'authorized';
  } else if (effectiveOAuth && baseConnectionState === 'connecting') {
    authorizationState = 'authorizing';
  } else if (effectiveOAuth && baseConnectionState === 'error') {
    authorizationState = 'error';
  } else if (baseConnectionState === 'disconnected' && (effectiveOAuth || runtimeOAuthCandidate)) {
    // check if server is actively being reconnected
    const oauthReconnectionManager = getOAuthReconnectionManager();
    if (oauthReconnectionManager.isReconnecting(userId, serverName)) {
      requiresOAuth = true;
      finalConnectionState = 'connecting';
      authorizationState = 'authorizing';
    } else {
      const { hasActiveFlow, hasFailedFlow } = await checkOAuthFlowStatus(userId, serverName);

      if (hasFailedFlow) {
        requiresOAuth = true;
        finalConnectionState = 'error';
        authorizationState = 'error';
      } else if (hasActiveFlow) {
        requiresOAuth = true;
        finalConnectionState = 'connecting';
        authorizationState = 'authorizing';
      } else if (await hasDurableMCPAuthorization(userId, serverName, config, runtimeContext)) {
        /** OAuth readiness is durable even when this pod has no live connection. */
        requiresOAuth = true;
        finalConnectionState = 'connected';
        authorizationState = 'authorized';
      }
    }
  }

  return {
    requiresOAuth,
    ...(requestScoped && { requestScoped: true }),
    ...(configurationState && { configurationState }),
    connectionState: finalConnectionState,
    authorizationState,
  };
}

module.exports = {
  createMCPTool,
  createMCPTools,
  toProviderToolDefinition,
  createMCPPermissionContext,
  userCanUseMCPServers,
  getMCPSetupData,
  resolveConfigServers,
  resolveMcpServerNames,
  resolveMcpServerContext,
  getAccessibleMcpServerNames,
  healMcpToolNames,
  getAssistantToolDefinitions,
  resolveCollisionAuditNames,
  resolveMcpConfigNames,
  resolveAllMcpConfigs,
  getAccessibleMCPServers,
  createOAuthStart,
  checkOAuthFlowStatus,
  getServerConnectionStatus,
  createUnavailableToolStub,
};
