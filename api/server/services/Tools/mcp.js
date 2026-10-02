const { logger } = require('@librechat/data-schemas');
const {
  formatMCPServerTools,
  getUserMCPAuthMap,
  getMissingCustomUserVars,
  loadMCPServerCatalogs: loadCatalogs,
  resolveMCPReinitializeConfig,
  requiresEphemeralUserConnection,
  getMissingRuntimeBodyPlaceholderFields,
  isMCPInitializationError,
  prepareMCPAuthorizationMutation,
  resolveMCPClientCapabilityProfile,
  recordScheduledMCPToolAuthFailure,
} = require('@librechat/api');
const { CacheKeys, Constants } = require('librechat-data-provider');
const { getMCPManager, getMCPServersRegistry, getFlowStateManager } = require('~/config');
const {
  findToken,
  createToken,
  updateToken,
  deleteTokens,
  findPluginAuthsByKeys,
} = require('~/models');
const { getGraphApiToken } = require('~/server/services/GraphTokenService');
const { exchangeOboToken } = require('~/server/services/OboTokenService');
const { createOboTrustChecker } = require('~/server/services/OboPolicyService');
const {
  getMCPServerTools,
  cacheMCPServerTools,
  getMCPToolsCacheGeneration,
  updateMCPServerTools,
  invalidateCachedTools,
} = require('~/server/services/Config');
const { getLogStores } = require('~/cache');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('~/server/services/MCPAuthorizationFenceRetry');

const MCP_REINITIALIZE_FAILURE_REASONS = {
  MISSING_CUSTOM_USER_VARS: 'missing_custom_user_vars',
  OAUTH_REQUIRED: 'oauth_required',
  INITIALIZATION_FAILED: 'initialization_failed',
};

/** Wires application dependencies into the passive, request-local catalog recovery service.
 * @param {Object} params
 * @param {IUser} params.user
 * @param {Array<{ serverName: string, serverConfig: object }>} params.servers
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider] - Live upstream-token closure for OBO discovery, built at the request boundary so this layer never receives the raw Express request.
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {import('@librechat/api').AuthIdentityContext} [params.oboIdentityContext] - Non-template-visible OBO identity context built from the real request user.
 * @param {AbortSignal} [params.signal] - Cancels queued and in-flight catalog reads when the request ends.
 * @param {import('@librechat/api').MCPServerCatalogRecoveryPolicy} [params.recoveryPolicy]
 * @param {import('librechat-data-provider').TMCPAppsPolicy} [params.mcpApps]
 */
async function loadMCPServerCatalogs({
  user,
  servers,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  oboIdentityContext,
  signal,
  recoveryPolicy,
  mcpApps,
}) {
  const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
  const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
  const tokenMethods = { findToken, updateToken, createToken, deleteTokens };
  const mcpManager = getMCPManager();
  const onOAuthCredentialsChanging = (scope) =>
    prepareMCPAuthorizationMutation(scope, {
      invalidateRecoveryGeneration: invalidateCachedTools,
      persistPublicationRetry: persistMCPAuthorizationFenceRetry,
      clearPublicationRetry: clearMCPAuthorizationFenceRetry,
      clearLocalRecovery: (userId, serverName, generation) =>
        mcpManager.clearCatalogRecoveryState?.(userId, serverName, generation),
      retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
      attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
    });
  return loadCatalogs(
    {
      user,
      servers: servers.map((server) => ({ ...server, capabilityProfile })),
      signal,
      recoveryPolicy,
    },
    {
      loadUserMCPAuthMap: (userId, serverNames) =>
        getUserMCPAuthMap({
          userId,
          servers: serverNames,
          findPluginAuthsByKeys,
        }),
      discoverServerTools: (options) =>
        mcpManager.discoverServerTools({
          ...options,
          flowManager,
          tokenMethods,
          graphTokenResolver: getGraphApiToken,
          oboTokenResolver: exchangeOboToken,
          oboTrustChecker: createOboTrustChecker(),
          upstreamTokenProvider,
          upstreamTokenProviderResolver,
          oboIdentityContext,
        }),
      onOAuthCredentialsChanging,
      formatServerTools: formatMCPServerTools,
      recoveryTracker: mcpManager.getCatalogRecoveryTracker?.(),
      getRecoveryGeneration: getMCPToolsCacheGeneration,
      getCachedServerTools: getMCPServerTools,
      getServerToolFunctionsSnapshot: (userId, serverName, serverConfig, options) =>
        mcpManager.getServerToolFunctionsSnapshot(userId, serverName, serverConfig, options),
      cacheServerTools: cacheMCPServerTools,
    },
  );
}

/**
 * Reinitializes an MCP server connection and discovers available tools.
 * When OAuth is required, uses discovery mode to list tools without full authentication
 * (per MCP spec, tool listing should be possible without auth).
 * @param {Object} params
 * @param {IUser} params.user - The user from the request object.
 * @param {import('@librechat/api').UpstreamTokenProvider} [params.upstreamTokenProvider] - Live upstream-token closure for OBO connection establishment, built at the request boundary so this layer never receives the raw Express request.
 * @param {import('@librechat/api').UpstreamTokenProviderResolver} [params.upstreamTokenProviderResolver]
 * @param {import('@librechat/api').AuthIdentityContext} [params.oboIdentityContext] - Non-template-visible OBO identity context built from the real request user.
 * @param {string} params.serverName - The name of the MCP server
 * @param {boolean} params.returnOnOAuth - Whether to initiate OAuth and return, or wait for OAuth flow to finish
 * @param {AbortSignal} [params.signal] - The abort signal to handle cancellation.
 * @param {boolean} [params.forceNew]
 * @param {number} [params.connectionTimeout]
 * @param {FlowStateManager<any>} [params.flowManager]
 * @param {(authURL: string, options?: { expiresAt?: number }) => Promise<void>} [params.oauthStart]
 * @param {() => Promise<void>} [params.oauthEnd]
 * @param {import('@librechat/api').RequestBody} [params.requestBody]
 * @param {import('@librechat/api').RequestScopedMCPConnectionStore} [params.requestScopedConnections]
 * @param {Record<string, Record<string, string>>} [params.userMCPAuthMap]
 * @param {import('@librechat/api').MCPServerCatalogRecoveryPolicy} [params.recoveryPolicy]
 * @param {string | null} [params.streamId] - Owning generation's stream ID, if resumable.
 * @param {number} [params.jobCreatedAt] - Owning generation epoch.
 */
async function reinitMCPServer({
  user,
  signal,
  forceNew,
  serverName,
  configServers,
  userMCPAuthMap,
  connectionTimeout,
  returnOnOAuth = true,
  oauthStart: _oauthStart,
  flowManager: _flowManager,
  serverConfig: providedConfig,
  requestBody,
  requestScopedConnections,
  upstreamTokenProvider,
  upstreamTokenProviderResolver,
  oboIdentityContext,
  oauthEnd,
  recoveryPolicy,
  mcpApps,
  streamId,
  jobCreatedAt,
}) {
  const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
  /** @type {MCPConnection | null} */
  let connection = null;
  let serverConfig = providedConfig;
  /** @type {LCAvailableTools | null} */
  let availableTools = null;
  /** @type {ReturnType<MCPConnection['fetchTools']> | null} */
  let tools = null;
  let oauthRequired = false;
  let oauthUrl = null;
  let oauthExpiresAt;
  let ephemeralServer = false;
  let publicationGeneration;
  let publicationRevision;

  try {
    const registry = getMCPServersRegistry();
    const resolution = await resolveMCPReinitializeConfig(
      registry,
      serverName,
      serverConfig ?? (await registry.getServerConfig(serverName, user?.id, configServers)),
      user?.id,
    );
    if (resolution.result) {
      return resolution.result;
    }
    serverConfig = resolution.serverConfig;
    ephemeralServer = serverConfig ? requiresEphemeralUserConnection(serverConfig) : false;

    const customUserVars = userMCPAuthMap?.[`${Constants.mcp_prefix}${serverName}`];

    const missingUserVars = getMissingCustomUserVars(serverConfig ?? {}, customUserVars);
    if (missingUserVars.length > 0) {
      logger.warn('[MCP Reinitialize] Skipping server with missing user configuration', {
        missingVariableCount: missingUserVars.length,
      });
      return {
        availableTools: null,
        success: false,
        message: `MCP server '${serverName}' requires user-provided variable(s) [${missingUserVars.join(
          ', ',
        )}] which are not set`,
        failureReason: MCP_REINITIALIZE_FAILURE_REASONS.MISSING_CUSTOM_USER_VARS,
        missingUserVars,
        oauthRequired: false,
        serverName,
        oauthUrl: null,
        tools: null,
      };
    }

    /** `{{LIBRECHAT_BODY_*}}` placeholders only resolve during a chat turn; connecting
     *  without them would fail, so defer the connection instead of reporting a failure. */
    const missingBodyFields = serverConfig
      ? getMissingRuntimeBodyPlaceholderFields(serverConfig, requestBody)
      : [];
    if (missingBodyFields.length > 0) {
      logger.info(
        '[MCP Reinitialize] Runtime placeholders unresolved; connection deferred to first use',
        { missingBodyFieldCount: missingBodyFields.length },
      );
      return {
        availableTools: null,
        success: true,
        /** Lets clients distinguish "connection deferred to a chat turn" from a
         *  plain success with no tools, e.g. to attach the server at the server
         *  level instead of waiting for a tool list that never arrives. */
        connectionDeferred: true,
        message: `MCP server '${serverName}' uses request-scoped placeholders; connection will be established on first use in a chat turn`,
        oauthRequired: false,
        serverName,
        oauthUrl: null,
        tools: null,
      };
    }

    const flowManager = _flowManager ?? getFlowStateManager(getLogStores(CacheKeys.FLOWS));
    const mcpManager = getMCPManager();
    const onOAuthCredentialsChanging = (scope) =>
      prepareMCPAuthorizationMutation(scope, {
        invalidateRecoveryGeneration: invalidateCachedTools,
        persistPublicationRetry: persistMCPAuthorizationFenceRetry,
        clearPublicationRetry: clearMCPAuthorizationFenceRetry,
        clearLocalRecovery: (userId, changedServerName) =>
          mcpManager.clearCatalogRecoveryState?.(userId, changedServerName),
        retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
        attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
      });
    const tokenMethods = { findToken, updateToken, createToken, deleteTokens };

    if (!ephemeralServer) {
      publicationGeneration = await getMCPToolsCacheGeneration({
        userId: user.id,
        serverName,
      });
    }

    const oauthStart =
      _oauthStart ??
      (async (authURL, options) => {
        logger.info('[MCP Reinitialize] OAuth URL received');
        if (authURL !== oauthUrl) {
          oauthExpiresAt = undefined;
        }
        oauthUrl = authURL;
        if (typeof options?.expiresAt === 'number' && Number.isFinite(options.expiresAt)) {
          oauthExpiresAt = options.expiresAt;
        }
        oauthRequired = true;
      });

    try {
      connection = await mcpManager.getConnection({
        user,
        signal,
        forceNew,
        oauthStart,
        serverName,
        flowManager,
        tokenMethods,
        onOAuthCredentialsChanging,
        returnOnOAuth,
        oauthEnd,
        customUserVars,
        requestBody,
        requestScopedConnections,
        connectionTimeout,
        serverConfig,
        graphTokenResolver: getGraphApiToken,
        oboTokenResolver: exchangeOboToken,
        oboTrustChecker: createOboTrustChecker(),
        upstreamTokenProvider,
        upstreamTokenProviderResolver,
        oboIdentityContext,
        capabilityProfile,
      });

      logger.info('[MCP Reinitialize] Successfully established connection');
    } catch (err) {
      if (isMCPInitializationError(err, signal)) {
        throw err;
      }
      logger.info('[MCP Reinitialize] Connection attempt failed');
      logger.info(
        `[MCP Reinitialize] OAuth state - oauthRequired: ${oauthRequired}, oauthUrl: ${oauthUrl ? 'present' : 'null'}`,
      );

      const isOAuthError =
        err.message?.includes('OAuth') ||
        err.message?.includes('authentication') ||
        err.message?.includes('401');

      const isOAuthFlowInitiated = err.message === 'OAuth flow initiated - return early';

      if (isOAuthError || oauthRequired || isOAuthFlowInitiated) {
        logger.info('[MCP Reinitialize] OAuth required; attempting tool discovery without auth');
        oauthRequired = true;

        try {
          const discoveryResult = await mcpManager.discoverServerTools({
            user,
            signal,
            serverName,
            flowManager,
            tokenMethods,
            onOAuthCredentialsChanging,
            oauthStart,
            customUserVars,
            requestBody,
            connectionTimeout,
            configServers,
            graphTokenResolver: getGraphApiToken,
            oboTokenResolver: exchangeOboToken,
            oboTrustChecker: createOboTrustChecker(),
            upstreamTokenProvider,
            upstreamTokenProviderResolver,
            oboIdentityContext,
            capabilityProfile,
          });

          if (discoveryResult.tools && discoveryResult.tools.length > 0) {
            tools = discoveryResult.tools;
            logger.info(
              `[MCP Reinitialize] Discovered ${tools.length} tools without full authentication`,
            );
          }
        } catch (error) {
          if (isMCPInitializationError(error, signal)) {
            throw error;
          }
          logger.debug('[MCP Reinitialize] Tool discovery failed');
        }
      } else {
        logger.error('[MCP Reinitialize] Error initializing MCP server');
      }
    }

    if (connection && !oauthRequired) {
      publicationGeneration =
        mcpManager.getToolPublicationGeneration(connection) ?? publicationGeneration;
      let snapshot;
      if (typeof connection.fetchOrderedToolsSnapshot === 'function') {
        snapshot = await connection.fetchOrderedToolsSnapshot(undefined, signal);
      } else if (typeof connection.fetchToolsSnapshot === 'function') {
        snapshot = await connection.fetchToolsSnapshot(undefined, signal);
      } else {
        snapshot = { tools: await connection.fetchTools(), complete: true };
      }
      if (snapshot.complete) {
        tools = snapshot.tools;
        /** Reserved before this snapshot's tools/list; an app-level catalog cannot publish
         * without it, and allocating a later one here would outrank fresher tools. */
        publicationRevision = snapshot.publicationRevision;
        if (snapshot.orderingUnavailable && typeof connection.refreshToolList === 'function') {
          /** These tools still serve this request; the connection republishes the shared
           * catalog under backoff rather than leaving it cold until the next reinitialize. */
          connection
            .refreshToolList()
            .catch((err) =>
              logger.debug(
                `[MCP Reinitialize] Could not schedule a catalog republish for ${serverName}: ${err?.message ?? String(err)}`,
              ),
            );
        }
      } else {
        logger.warn(
          `[MCP Reinitialize] Preserving cached tools for ${serverName} because tools/list returned an incomplete snapshot`,
        );
      }
    }

    if (tools && !ephemeralServer && publicationGeneration) {
      const currentGeneration = await getMCPToolsCacheGeneration({
        userId: user.id,
        serverName,
      });
      if (currentGeneration !== publicationGeneration) {
        logger.warn(
          `[MCP Reinitialize] Discarding stale tools for ${serverName} because its publication generation changed during discovery`,
        );
        tools = null;
      }
    }

    if (tools) {
      availableTools = await updateMCPServerTools({
        userId: user.id,
        serverName,
        tools,
        serverConfig,
        ...(publicationGeneration && { publicationGeneration }),
        ...(publicationRevision && { publicationRevision }),
        capabilityProfile,
      });
      if (availableTools == null) {
        tools = null;
      }
    }

    logger.debug('[MCP Reinitialize] Sending response', {
      oauthRequired,
      hasOauthUrl: Boolean(oauthUrl),
    });

    const getResponseMessage = () => {
      if (oauthRequired && tools && tools.length > 0) {
        return `MCP server '${serverName}' tools discovered, OAuth required for execution`;
      }
      if (oauthRequired) {
        return `MCP server '${serverName}' ready for OAuth authentication`;
      }
      if (connection) {
        return `MCP server '${serverName}' reinitialized successfully`;
      }
      return `Failed to reinitialize MCP server '${serverName}'`;
    };

    const success = Boolean(
      (connection && !oauthRequired) || (oauthRequired && oauthUrl) || (tools && tools.length > 0),
    );
    let failureReason;
    if (!success) {
      failureReason = oauthRequired
        ? MCP_REINITIALIZE_FAILURE_REASONS.OAUTH_REQUIRED
        : MCP_REINITIALIZE_FAILURE_REASONS.INITIALIZATION_FAILED;
    }
    const result = {
      availableTools,
      success,
      message: getResponseMessage(),
      failureReason,
      oauthRequired,
      serverName,
      oauthUrl,
      oauthExpiresAt,
      tools,
    };

    logger.debug('[MCP Reinitialize] Response ready', {
      success: result.success,
      oauthRequired: result.oauthRequired,
      hasOauthUrl: Boolean(result.oauthUrl),
      toolsCount: tools?.length ?? 0,
    });

    return result;
  } catch (error) {
    if (isMCPInitializationError(error, signal)) {
      await recordScheduledMCPToolAuthFailure(
        { error, streamId, jobCreatedAt, userId: user?.id, serverName },
        () => require('~/server/services/Schedules').recordMCPToolAuthFailure,
      );
      throw error;
    }
    logger.error('[MCP Reinitialize] Error loading MCP tools; servers may still be initializing');
  } finally {
    if (connection && ephemeralServer && !requestScopedConnections) {
      try {
        await connection.dispose();
      } catch {
        logger.warn('[MCP Reinitialize] Failed to dispose ephemeral server');
      }
    }
  }
}

module.exports = {
  reinitMCPServer,
  loadMCPServerCatalogs,
};
