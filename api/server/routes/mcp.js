const { Router } = require('express');
const { logger, getTenantId, tenantStorage } = require('@librechat/data-schemas');
const {
  CacheKeys,
  Constants,
  Permissions,
  PermissionBits,
  PermissionTypes,
} = require('librechat-data-provider');
const {
  getBasePath,
  createSafeUser,
  createAuthIdentityContext,
  MCPOAuthHandler,
  MCPTokenStorage,
  getMCPServerGeneration,
  setOAuthSession,
  PENDING_STALE_MS,
  getUserMCPAuthMap,
  validateOAuthCsrf,
  OAUTH_CSRF_COOKIE,
  setOAuthCsrfCookie,
  generateCheckAccess,
  validateOAuthSession,
  OAUTH_SESSION_COOKIE,
  mcpConfig: mcpSettings,
  getServerCustomUserVars,
  hasCustomUserVars,
  requiresEphemeralUserConnection,
  MCPAuthenticationRejectedError,
  MCPAuthenticationRefreshError,
  OpenIDReauthRequiredError,
  readMCPRecoveryGenerationAround,
  prepareMCPAuthorizationMutation,
  persistMCPAuthorizationTransaction,
} = require('@librechat/api');
const {
  createMCPServerController,
  updateMCPServerController,
  deleteMCPServerController,
  getMCPServersList,
  getMCPServerById,
  getMCPTools,
} = require('~/server/controllers/mcp');
const {
  getOAuthReconnectionManager,
  getMCPServersRegistry,
  getFlowStateManager,
  getMCPManager,
} = require('~/config');
const {
  getServerConnectionStatus,
  resolveAllMcpConfigs,
  resolveConfigServers,
  getMCPSetupData,
} = require('~/server/services/MCP');
const {
  requireJwtAuth,
  configMiddleware,
  canAccessMCPServerResource,
} = require('~/server/middleware');
const { getUserPluginAuthValue } = require('~/server/services/PluginService');
const { maybeUninstallOAuthMCP } = require('~/server/services/MCP/oauthCleanup');
const {
  invalidateCachedTools,
  getAppConfig,
  getMCPToolsCacheGeneration,
} = require('~/server/services/Config');
const { updateMCPServerTools } = require('~/server/services/Config/mcp');
const { reinitMCPServer } = require('~/server/services/Tools/mcp');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('~/server/services/MCPAuthorizationFenceRetry');
const { createOpenIDSessionTokenProvider } = require('~/server/services/OpenIDSessionRefresh');
const { getLogStores } = require('~/cache');
const db = require('~/models');

const router = Router();

const OAUTH_CSRF_COOKIE_PATH = '/api/mcp';

const getOAuthFlowId = (userId, serverName) =>
  MCPOAuthHandler.generateFlowId(userId, serverName, getTenantId());

const canAccessOAuthFlow = (flowId, userId) => {
  const parsed = MCPOAuthHandler.parseFlowId(flowId);
  if (!parsed) {
    return false;
  }
  if (parsed.tenantId && parsed.tenantId !== getTenantId()) {
    return false;
  }
  return parsed.userId === userId || parsed.userId === 'system';
};

const checkMCPUsePermissions = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE],
  getRoleByName: db.getRoleByName,
});

const checkMCPCreate = generateCheckAccess({
  permissionType: PermissionTypes.MCP_SERVERS,
  permissions: [Permissions.USE, Permissions.CREATE],
  getRoleByName: db.getRoleByName,
});

/**
 * Get all MCP tools available to the user
 * Returns only MCP tools, completely decoupled from regular LibreChat tools
 */
router.get('/tools', requireJwtAuth, configMiddleware, checkMCPUsePermissions, async (req, res) => {
  return getMCPTools(req, res);
});

/**
 * Initiate OAuth flow
 * This endpoint is called when the user clicks the auth link in the UI
 */
router.get('/:serverName/oauth/initiate', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const { userId, flowId } = req.query;
    const user = req.user;

    // Verify the userId matches the authenticated user
    if (typeof userId !== 'string' || userId !== user.id) {
      return res.status(403).json({ error: 'User mismatch' });
    }

    const expectedFlowId = getOAuthFlowId(user.id, serverName);
    if (typeof flowId !== 'string' || flowId !== expectedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID for initiate request', {
        serverName,
        userId,
        flowId,
        expectedFlowId,
      });
      return res.status(403).json({ error: 'Flow mismatch' });
    }

    logger.debug('[MCP OAuth] Initiate request', { serverName, userId, flowId });

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    /** Flow state to retrieve OAuth config */
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found', { flowId });
      return res.status(404).json({ error: 'Flow not found' });
    }

    const {
      authorizationUrl: storedAuthorizationUrl,
      serverName: flowServerName,
      userId: flowUserId,
      serverUrl,
      oauth: oauthConfig,
    } = flowState.metadata || {};

    if (flowUserId && flowUserId !== user.id) {
      logger.error('[MCP OAuth] Flow user mismatch', { flowId, userId, flowUserId });
      return res.status(403).json({ error: 'User mismatch' });
    }

    if (flowServerName && flowServerName !== serverName) {
      logger.error('[MCP OAuth] Flow server mismatch', { flowId, serverName, flowServerName });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const pendingAge = flowState.createdAt ? Date.now() - flowState.createdAt : Infinity;
    const isFreshPendingFlow = flowState.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
    if (!isFreshPendingFlow) {
      logger.error('[MCP OAuth] Flow is not active for initiation', {
        flowId,
        status: flowState.status,
        pendingAge,
      });
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    if (typeof storedAuthorizationUrl === 'string' && storedAuthorizationUrl.length > 0) {
      logger.debug('[MCP OAuth] Reusing stored authorization URL', {
        serverName,
        userId,
        flowId,
      });
      setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      return res.redirect(storedAuthorizationUrl);
    }

    if (!serverUrl || !oauthConfig) {
      logger.error('[MCP OAuth] Missing server URL or OAuth config in flow state');
      return res.status(400).json({ error: 'Invalid flow state' });
    }

    const configServers = await resolveConfigServers(req);
    const oauthHeaders = await getOAuthHeaders(serverName, userId, configServers);
    const registry = getMCPServersRegistry();
    const { allowedDomains, allowedAddresses } = await registry.resolveAllowlists({
      userId,
      role: req.user?.role,
    });
    const {
      authorizationUrl,
      flowId: oauthFlowId,
      flowMetadata,
    } = await MCPOAuthHandler.initiateOAuthFlow(
      serverName,
      serverUrl,
      userId,
      oauthHeaders,
      oauthConfig,
      allowedDomains,
      undefined,
      allowedAddresses,
      getTenantId(),
    );

    logger.debug('[MCP OAuth] OAuth flow initiated', { oauthFlowId, authorizationUrl });

    const oldState = flowState.metadata?.state;
    if (typeof oldState === 'string') {
      await MCPOAuthHandler.deleteStateMapping(oldState, flowManager);
    }
    const effectiveConfig = (await resolveAllMcpConfigs(userId))?.[serverName];
    const metadataWithUrl = {
      ...flowMetadata,
      authorizationUrl,
      tenantId: getTenantId(),
      ...(effectiveConfig && { serverGeneration: getMCPServerGeneration(effectiveConfig) }),
    };
    await flowManager.initFlow(oauthFlowId, 'mcp_oauth', metadataWithUrl);
    await MCPOAuthHandler.storeStateMapping(flowMetadata.state, oauthFlowId, flowManager);
    setOAuthCsrfCookie(res, oauthFlowId, OAUTH_CSRF_COOKIE_PATH);
    res.redirect(authorizationUrl);
  } catch (error) {
    logger.error('[MCP OAuth] Failed to initiate OAuth', error);
    res.status(500).json({ error: 'Failed to initiate OAuth' });
  }
});

/**
 * OAuth callback handler
 * This handles the OAuth callback after the user has authorized the application
 */
router.get('/:serverName/oauth/callback', async (req, res) => {
  const basePath = getBasePath();
  try {
    const { serverName } = req.params;
    const { code, state, error: oauthError } = req.query;

    logger.debug('[MCP OAuth] Callback received', {
      serverName,
      code: code ? 'present' : 'missing',
      state,
      error: oauthError,
    });

    if (oauthError) {
      logger.error('[MCP OAuth] OAuth error received', { error: oauthError });
      // Gate failFlow behind callback validation to prevent DoS via leaked state
      if (state && typeof state === 'string') {
        try {
          const flowsCache = getLogStores(CacheKeys.FLOWS);
          const flowManager = getFlowStateManager(flowsCache);
          const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
          if (flowId) {
            const parsed = MCPOAuthHandler.parseFlowId(flowId);
            if (!parsed) {
              logger.warn('[MCP OAuth] Invalid flow ID format for OAuth error callback', {
                flowId,
              });
            } else {
              const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
              const hasSession = !hasCsrf && validateOAuthSession(req, parsed.userId);
              if (hasCsrf || hasSession) {
                /** A stale mapping can resolve a superseded attempt's state to the
                 *  current flow (deterministic flow ids); only fail the flow this
                 *  error callback actually belongs to */
                const currentFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
                const flowMeta = currentFlow?.metadata;
                if (currentFlow && flowMeta?.state === state) {
                  await flowManager.failFlowIfCurrent(
                    flowId,
                    'mcp_oauth',
                    currentFlow.createdAt,
                    state,
                    String(oauthError),
                  );
                  logger.debug('[MCP OAuth] Marked flow as FAILED with OAuth error', {
                    flowId,
                    error: oauthError,
                  });
                } else {
                  logger.warn('[MCP OAuth] Skipping failFlow for superseded OAuth error callback', {
                    flowId,
                  });
                }
              }
            }
          }
        } catch (err) {
          logger.debug('[MCP OAuth] Could not mark flow as failed', err);
        }
      }
      return res.redirect(
        `${basePath}/oauth/error?error=${encodeURIComponent(String(oauthError))}`,
      );
    }

    if (!code || typeof code !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid code');
      return res.redirect(`${basePath}/oauth/error?error=missing_code`);
    }

    if (!state || typeof state !== 'string') {
      logger.error('[MCP OAuth] Missing or invalid state');
      return res.redirect(`${basePath}/oauth/error?error=missing_state`);
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowId = await MCPOAuthHandler.resolveStateToFlowId(state, flowManager);
    if (!flowId) {
      logger.error('[MCP OAuth] Could not resolve state to flow ID', { state });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }
    logger.debug('[MCP OAuth] Resolved flow ID from state', { flowId });

    const parsedFlowId = MCPOAuthHandler.parseFlowId(flowId);
    if (!parsedFlowId) {
      logger.error('[MCP OAuth] Invalid flow ID format', { flowId });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    const hasCsrf = validateOAuthCsrf(req, res, flowId, OAUTH_CSRF_COOKIE_PATH);
    const hasSession = !hasCsrf && validateOAuthSession(req, parsedFlowId.userId);
    let hasActiveFlow = false;
    if (!hasCsrf && !hasSession) {
      const pendingFlow = await flowManager.getFlowState(flowId, 'mcp_oauth');
      const pendingAge = pendingFlow?.createdAt ? Date.now() - pendingFlow.createdAt : Infinity;
      hasActiveFlow = pendingFlow?.status === 'PENDING' && pendingAge < PENDING_STALE_MS;
      if (hasActiveFlow) {
        logger.debug(
          '[MCP OAuth] CSRF/session cookies absent, validating via active PENDING flow',
          {
            flowId,
          },
        );
      }
    }

    if (!hasCsrf && !hasSession && !hasActiveFlow) {
      logger.error(
        '[MCP OAuth] CSRF validation failed: no valid CSRF cookie, session cookie, or active flow',
        {
          flowId,
          hasCsrfCookie: !!req.cookies?.[OAUTH_CSRF_COOKIE],
          hasSessionCookie: !!req.cookies?.[OAUTH_SESSION_COOKIE],
        },
      );
      return res.redirect(`${basePath}/oauth/error?error=csrf_validation_failed`);
    }

    logger.debug('[MCP OAuth] Getting flow state for flowId: ' + flowId);
    const flowState = await MCPOAuthHandler.getFlowState(flowId, flowManager);

    if (!flowState) {
      logger.error('[MCP OAuth] Flow state not found for flowId:', flowId);
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    /**
     * Flow ids are deterministic (userId:serverName), so a stale state mapping
     * can resolve to a newer flow for the same server. The stored state is the
     * only per-attempt nonce; a mismatch means this callback belongs to a
     * superseded authorization attempt and must not consume the current flow.
     */
    if (flowState.state !== state) {
      logger.error('[MCP OAuth] State mismatch for flow', { flowId, serverName });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    logger.debug('[MCP OAuth] Flow state details', {
      serverName: flowState.serverName,
      userId: flowState.userId,
      hasMetadata: !!flowState.metadata,
      hasClientInfo: !!flowState.clientInfo,
      hasCodeVerifier: !!flowState.codeVerifier,
    });

    /** Check if this flow has already been completed (idempotency protection) */
    const currentFlowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!currentFlowState) {
      logger.warn('[MCP OAuth] Flow disappeared before token exchange', { flowId, serverName });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }
    if (currentFlowState.status === 'COMPLETED') {
      logger.warn('[MCP OAuth] Flow already completed, preventing duplicate token exchange', {
        flowId,
        serverName,
      });
      return res.redirect(`${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`);
    }
    const isStalePendingFlow =
      currentFlowState?.status === 'PENDING' &&
      (!currentFlowState.createdAt || Date.now() - currentFlowState.createdAt >= PENDING_STALE_MS);
    if (currentFlowState?.status === 'FAILED' || isStalePendingFlow) {
      logger.warn('[MCP OAuth] Refusing token exchange for terminal flow', {
        flowId,
        serverName,
        status: currentFlowState.status,
      });
      return res.redirect(`${basePath}/oauth/error?error=invalid_state`);
    }

    logger.debug('[MCP OAuth] Completing OAuth flow');
    /**
     * Restore tenant context for the callback body. The callback is a cross-origin
     * redirect from the OAuth provider, so SameSite=Strict cookies (including the
     * JWT) are not sent. The tenantId was stored in the flow metadata at initiation
     * time when the user was authenticated.
     */
    const runWithTenant = async (fn) => {
      const flowTenantId = flowState.tenantId;
      if (flowTenantId && !getTenantId()) {
        return tenantStorage.run({ tenantId: flowTenantId }, fn);
      }
      return fn();
    };

    await runWithTenant(async () => {
      const oauthHeaders =
        flowState.oauthHeaders ?? (await getOAuthHeaders(serverName, flowState.userId));
      let recoveryPolicy;
      const resolveActiveServer = async () => {
        const [configs, appConfig] = await Promise.all([
          resolveAllMcpConfigs(flowState.userId),
          getAppConfig({ userId: flowState.userId, tenantId: getTenantId() }),
        ]);
        recoveryPolicy = appConfig?.mcpSettings?.catalogRecovery;
        const activeConfig =
          configs?.[serverName] ??
          appConfig?.mcpConfig?.[serverName] ??
          (await getMCPServersRegistry().getServerConfig(serverName, flowState.userId));
        if (!activeConfig) {
          return false;
        }
        if (flowState.serverGeneration) {
          return getMCPServerGeneration(activeConfig) === flowState.serverGeneration;
        }
        return activeConfig.url === flowState.serverUrl;
      };
      if (!(await resolveActiveServer())) {
        throw new Error(`MCP server ${serverName} was deleted during OAuth authorization`);
      }
      const rollbackStoredTokens = async (storedTokens) => {
        const storedMetadata = MCPOAuthHandler.buildStoredClientMetadata(
          flowState.metadata,
          flowState.resourceMetadata,
          flowState.serverUrl,
          flowState.clientSource,
        );
        const revocationMetadata = {
          serverUrl: flowState.serverUrl,
          clientId: flowState.clientInfo?.client_id ?? '',
          clientSecret: flowState.clientInfo?.client_secret ?? '',
          revocationEndpoint: storedMetadata?.revocation_endpoint,
          revocationEndpointAuthMethodsSupported:
            storedMetadata?.revocation_endpoint_auth_methods_supported,
        };
        for (const [tokenType, token] of [
          ['access', storedTokens.access_token],
          ['refresh', storedTokens.refresh_token],
        ]) {
          if (!token) {
            continue;
          }
          try {
            await MCPOAuthHandler.revokeOAuthToken(
              serverName,
              token,
              tokenType,
              revocationMetadata,
              oauthHeaders,
              flowState.allowedDomains,
              flowState.allowedAddresses,
            );
          } catch (error) {
            logger.warn(
              `[MCP OAuth] Failed to revoke ${tokenType} token after callback cancellation:`,
              error,
            );
          }
        }
        await MCPTokenStorage.deleteUserTokens({
          userId: flowState.userId,
          serverName,
          deleteToken: async (filter) => {
            await db.deleteTokens({
              ...filter,
              metadataCredentialSetId: storedTokens.credential_set_id,
            });
          },
        });
      };
      const tokens = await MCPOAuthHandler.completeOAuthFlow(
        flowId,
        code,
        flowManager,
        oauthHeaders,
        async (exchangedTokens, completePersistedFlow) => {
          if (!flowState?.userId) {
            return exchangedTokens;
          }

          let storedTokens;
          try {
            const tokenFlowId = MCPOAuthHandler.generateTokenFlowId(
              flowState.userId,
              serverName,
              flowState.tenantId,
            );
            storedTokens = await persistMCPAuthorizationTransaction(
              {
                scope: { userId: flowState.userId, serverName },
                flowIds: [tokenFlowId, flowId],
                tokens: exchangedTokens,
                completeAuthorization: completePersistedFlow,
                persistTokens: async (candidateTokens, onStoreCommitted) =>
                  (await MCPTokenStorage.storeTokens({
                    flowManager,
                    persistenceWaitTimeoutMs: flowState.oauthPersistenceWaitTimeout,
                    userId: flowState.userId,
                    serverName,
                    tokens: candidateTokens,
                    createToken: db.createToken,
                    updateToken: db.updateToken,
                    deleteTokens: db.deleteTokens,
                    findToken: db.findToken,
                    clientInfo: flowState.clientInfo,
                    metadata: MCPOAuthHandler.buildStoredClientMetadata(
                      flowState.metadata,
                      flowState.resourceMetadata,
                      flowState.serverUrl,
                      flowState.clientSource,
                    ),
                    onStoreCommitted,
                  })) ?? candidateTokens,
              },
              {
                ensureServerActive: resolveActiveServer,
                inactiveServerError: () =>
                  new Error(`MCP server ${serverName} was deleted during OAuth authorization`),
                invalidateRecoveryGeneration: invalidateCachedTools,
                clearLocalRecovery: (userId, changedServerName) =>
                  getMCPManager()?.clearCatalogRecoveryState?.(userId, changedServerName),
                persistPublicationRetry: persistMCPAuthorizationFenceRetry,
                clearPublicationRetry: clearMCPAuthorizationFenceRetry,
                retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
                attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
                flowManager,
                onTokenFlowError: (phase, error) =>
                  logger.warn(
                    phase === 'prepare'
                      ? '[MCP OAuth] Failed to clear cached token flow state'
                      : '[MCP OAuth] Failed to wake a pending token flow',
                    error,
                  ),
              },
            );
            logger.debug('[MCP OAuth] Stored OAuth tokens before completing callback flow', {
              serverName,
              userId: flowState.userId,
            });
          } catch (error) {
            logger.error('[MCP OAuth] Failed to store OAuth tokens before flow completion', error);
            throw error;
          }

          return storedTokens;
        },
        rollbackStoredTokens,
        { createdAt: currentFlowState.createdAt, state },
      );
      logger.info('[MCP OAuth] OAuth flow completed, tokens received in callback route');

      try {
        if (flowState.userId !== 'system') {
          const user = { id: flowState.userId };

          /** Merged config (incl. Config-tier overlays) so the reconnection and
           *  the cache gate both see request-scoped servers the base registry
           *  lookup misses */
          let serverConfig;
          try {
            const allConfigs = await resolveAllMcpConfigs(flowState.userId);
            serverConfig = allConfigs?.[serverName];
          } catch (error) {
            logger.warn(
              `[MCP OAuth] Could not resolve server config for ${serverName} before reconnecting:`,
              error,
            );
          }

          const requestScoped = serverConfig
            ? requiresEphemeralUserConnection(serverConfig)
            : false;
          if (requestScoped) {
            logger.info(
              `[MCP OAuth] Deferring post-OAuth connection for request-scoped server ${serverName} until its first chat use`,
            );
            getOAuthReconnectionManager().clearReconnection(flowState.userId, serverName);
          } else {
            const mcpManager = getMCPManager(flowState.userId);
            logger.debug(`[MCP OAuth] Attempting to reconnect ${serverName} with new OAuth tokens`);

            /**
             * Without this, getUserConnection resolves `headers`/`oauth_headers`
             * customUserVars templates (e.g. `{{MY_VAR}}`) with no substitution
             * data, so the literal placeholder is sent on this first post-callback
             * connection attempt even though the user's value is already saved -
             * surfaces upstream as a generic auth rejection from the MCP server.
             * The other reconnect path (oauth/reinitialize route below) already
             * resolves this the same way; this one was missing it.
             */
            let userMCPAuthMap;
            if (serverConfig?.customUserVars && typeof serverConfig.customUserVars === 'object') {
              try {
                userMCPAuthMap = await getUserMCPAuthMap({
                  userId: flowState.userId,
                  servers: [serverName],
                  findPluginAuthsByKeys: db.findPluginAuthsByKeys,
                });
              } catch (error) {
                logger.warn(
                  `[MCP OAuth] Could not resolve customUserVars for ${serverName} before reconnecting:`,
                  error,
                );
              }
            }
            const customUserVars = getServerCustomUserVars(userMCPAuthMap, serverName);

            const { snapshot, publicationGeneration } = await mcpManager.withUserConnectionLease(
              {
                user,
                serverName,
                flowManager,
                serverConfig,
                customUserVars,
                tokenMethods: {
                  findToken: db.findToken,
                  updateToken: db.updateToken,
                  createToken: db.createToken,
                  deleteTokens: db.deleteTokens,
                },
                onOAuthCredentialsChanging: (scope) =>
                  prepareMCPAuthorizationMutation(scope, {
                    invalidateRecoveryGeneration: invalidateCachedTools,
                    persistPublicationRetry: persistMCPAuthorizationFenceRetry,
                    clearPublicationRetry: clearMCPAuthorizationFenceRetry,
                    clearLocalRecovery: (userId, changedServerName) =>
                      getMCPManager()?.clearCatalogRecoveryState?.(userId, changedServerName),
                    retryDelaysMs: recoveryPolicy?.authorizationFenceRetryMs,
                    attemptTimeoutMs: recoveryPolicy?.authorizationFenceTimeoutMs,
                  }),
              },
              async (userConnection) => {
                logger.info(
                  `[MCP OAuth] Successfully reconnected ${serverName} for user ${flowState.userId}`,
                );

                const oauthReconnectionManager = getOAuthReconnectionManager();
                oauthReconnectionManager.clearReconnection(flowState.userId, serverName);

                const snapshot =
                  typeof userConnection.fetchOrderedToolsSnapshot === 'function'
                    ? await userConnection.fetchOrderedToolsSnapshot()
                    : await userConnection.fetchToolsSnapshot();
                return {
                  snapshot,
                  publicationGeneration: mcpManager.getToolPublicationGeneration?.(userConnection),
                };
              },
            );
            if (snapshot.complete) {
              await updateMCPServerTools({
                userId: flowState.userId,
                serverName,
                tools: snapshot.tools,
                serverConfig,
                publicationGeneration,
              });
            } else {
              logger.warn(
                `[MCP OAuth] Preserving cached tools for ${serverName} because tools/list returned an incomplete snapshot`,
              );
            }
          }
        } else {
          logger.debug(`[MCP OAuth] System-level OAuth completed for ${serverName}`);
        }
      } catch (error) {
        logger.warn(
          `[MCP OAuth] Failed to reconnect ${serverName} after OAuth, but tokens are saved:`,
          error,
        );
      }

      /** ID of the flow that the tool/connection is waiting for */
      const toolFlowId = flowState.metadata?.toolFlowId;
      if (toolFlowId) {
        logger.debug('[MCP OAuth] Completing tool flow', { toolFlowId });
        const completed = await flowManager.completeFlow(toolFlowId, 'mcp_oauth', tokens);
        if (!completed) {
          logger.warn(
            '[MCP OAuth] Tool flow state not found during completion — waiter will time out',
            { toolFlowId },
          );
        }
      }
    }); /* end runWithTenant */

    /** Redirect to success page with flowId and serverName */
    const redirectUrl = `${basePath}/oauth/success?serverName=${encodeURIComponent(serverName)}`;
    res.redirect(redirectUrl);
  } catch (error) {
    logger.error('[MCP OAuth] OAuth callback error', error);
    res.redirect(`${basePath}/oauth/error?error=callback_failed`);
  }
});

/**
 * Get OAuth tokens for a completed flow
 * This is primarily for user-level OAuth flows
 */
router.get('/oauth/tokens/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    if (flowState.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Flow not completed' });
    }

    res.json({ tokens: flowState.result });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get tokens', error);
    res.status(500).json({ error: 'Failed to get tokens' });
  }
});

/**
 * Set CSRF binding cookie for OAuth flows initiated outside of HTTP request/response
 * (e.g. during chat via SSE). The frontend should call this before opening the OAuth URL
 * so the callback can verify the browser matches the flow initiator.
 */
router.post('/:serverName/oauth/bind', requireJwtAuth, setOAuthSession, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const flowId = getOAuthFlowId(user.id, serverName);
    setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);

    res.json({ success: true });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to set CSRF binding cookie', error);
    res.status(500).json({ error: 'Failed to bind OAuth flow' });
  }
});

/**
 * Check OAuth flow status
 * This endpoint can be used to poll the status of an OAuth flow
 */
router.get('/oauth/status/:flowId', requireJwtAuth, async (req, res) => {
  try {
    const { flowId } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    if (!canAccessOAuthFlow(flowId, user.id)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);

    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');
    if (!flowState) {
      return res.status(404).json({ error: 'Flow not found' });
    }

    res.json({
      status: flowState.status,
      completed: flowState.status === 'COMPLETED',
      failed: flowState.status === 'FAILED',
      error: flowState.error,
    });
  } catch (error) {
    logger.error('[MCP OAuth] Failed to get flow status', error);
    res.status(500).json({ error: 'Failed to get flow status' });
  }
});

/**
 * Cancel OAuth flow
 * This endpoint cancels a pending OAuth flow
 */
router.post('/oauth/cancel/:serverName', requireJwtAuth, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    logger.info(`[MCP OAuth Cancel] Cancelling OAuth flow for ${serverName} by user ${user.id}`);

    const flowsCache = getLogStores(CacheKeys.FLOWS);
    const flowManager = getFlowStateManager(flowsCache);
    const flowId = getOAuthFlowId(user.id, serverName);
    const flowState = await flowManager.getFlowState(flowId, 'mcp_oauth');

    if (!flowState) {
      logger.debug(`[MCP OAuth Cancel] No active flow found for ${serverName}`);
      return res.json({
        success: true,
        message: 'No active OAuth flow to cancel',
      });
    }

    await MCPOAuthHandler.failFlowAndDeleteStateMapping(
      flowId,
      flowState,
      flowManager,
      'User cancelled OAuth flow',
    );

    logger.info(`[MCP OAuth Cancel] Successfully cancelled OAuth flow for ${serverName}`);

    res.json({
      success: true,
      message: `OAuth flow for ${serverName} cancelled successfully`,
    });
  } catch (error) {
    logger.error('[MCP OAuth Cancel] Failed to cancel OAuth flow', error);
    res.status(500).json({ error: 'Failed to cancel OAuth flow' });
  }
});

function createMCPStatusRuntimeContext(user, mcpConfig, serverNames) {
  const customUserVarServers = serverNames.filter((serverName) => {
    const customUserVars = mcpConfig[serverName]?.customUserVars;
    return (
      customUserVars && typeof customUserVars === 'object' && Object.keys(customUserVars).length > 0
    );
  });
  let userMCPAuthMapPromise;
  let mcpAllowlistsPromise;
  const loadUserMCPAuthMap = () => {
    if (!customUserVarServers.length) {
      return Promise.resolve(undefined);
    }
    userMCPAuthMapPromise ??= getUserMCPAuthMap({
      userId: user.id,
      servers: customUserVarServers,
      findPluginAuthsByKeys: db.findPluginAuthsByKeys,
    });
    return userMCPAuthMapPromise;
  };
  const loadMCPAllowlists = () => {
    mcpAllowlistsPromise ??= getMCPServersRegistry().resolveAllowlists({
      userId: user.id,
      role: user.role,
    });
    return mcpAllowlistsPromise;
  };
  return { user: createSafeUser(user), loadUserMCPAuthMap, loadMCPAllowlists };
}

function getMCPReinitializeOAuthTimeout(oauthExpiresAt) {
  if (typeof oauthExpiresAt !== 'number' || !Number.isFinite(oauthExpiresAt)) {
    return mcpSettings.OAUTH_HANDLING_TIMEOUT;
  }
  return Math.max(0, oauthExpiresAt - Date.now());
}

/**
 * Reinitialize MCP server
 * This endpoint allows reinitializing a specific MCP server
 */
router.post(
  '/:serverName/reinitialize',
  requireJwtAuth,
  configMiddleware,
  checkMCPUsePermissions,
  setOAuthSession,
  async (req, res, next) => {
    try {
      const { serverName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      const serverConfig = await getMCPServersRegistry().getServerConfig(
        serverName,
        user.id,
        configServers,
      );
      if (!serverConfig) {
        return res.status(404).json({
          error: `MCP server '${serverName}' not found in configuration`,
        });
      }

      try {
        await invalidateCachedTools({ userId: user.id, serverName });
      } finally {
        await mcpManager.disconnectUserConnection(user.id, serverName);
      }
      logger.info(
        `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
      );

      /** @type {Record<string, Record<string, string>> | undefined} */
      let userMCPAuthMap;
      if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
        userMCPAuthMap = await getUserMCPAuthMap({
          userId: user.id,
          servers: [serverName],
          findPluginAuthsByKeys: db.findPluginAuthsByKeys,
        });
      }
      const oboIdentityContext = createAuthIdentityContext({
        user: req.user,
        tenantId: getTenantId(),
      });

      const result = await reinitMCPServer({
        user,
        serverName,
        serverConfig,
        configServers,
        userMCPAuthMap,
        upstreamTokenProvider: createOpenIDSessionTokenProvider({
          req,
          res,
          user: req.user,
          identityContext: oboIdentityContext,
          tokenPreference: 'access_token',
        }),
        oboIdentityContext,
        recoveryPolicy: req.config?.mcpSettings?.catalogRecovery,
      });

      if (!result) {
        return res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
      }

      const {
        success,
        message,
        oauthRequired,
        oauthUrl,
        oauthExpiresAt,
        failureReason,
        missingUserVars,
        connectionDeferred,
      } = result;

      let flowId;
      if (oauthRequired) {
        flowId = getOAuthFlowId(user.id, serverName);
        setOAuthCsrfCookie(res, flowId, OAUTH_CSRF_COOKIE_PATH);
      }

      res.json({
        success,
        message,
        oauthUrl,
        flowId,
        oauthTimeout: oauthRequired ? getMCPReinitializeOAuthTimeout(oauthExpiresAt) : undefined,
        serverName,
        oauthRequired,
        failureReason,
        missingUserVars,
        connectionDeferred,
      });
    } catch (error) {
      if (
        error instanceof MCPAuthenticationRejectedError ||
        error instanceof MCPAuthenticationRefreshError ||
        error instanceof OpenIDReauthRequiredError
      ) {
        return next(error);
      }
      logger.error('[MCP Reinitialize] Unexpected error', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  },
);

/**
 * Get connection status for all MCP servers
 * This endpoint returns all app level and user-scoped connection statuses from MCPManager without disconnecting idle connections
 */
router.get('/connection/status', requireJwtAuth, configMiddleware, async (req, res) => {
  try {
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId(), appConfig: req.config },
    );
    const runtimeContext = createMCPStatusRuntimeContext(user, mcpConfig, Object.keys(mcpConfig));
    const connectionStatus = Object.fromEntries(
      await Promise.all(
        Object.entries(mcpConfig).map(async ([serverName, config]) => {
          try {
            const { value: status, generation: authorizationGeneration } =
              await readMCPRecoveryGenerationAround(
                { userId: user.id, serverName },
                getMCPToolsCacheGeneration,
                () =>
                  getServerConnectionStatus(
                    user.id,
                    serverName,
                    config,
                    appConnections,
                    userConnections,
                    oauthServers,
                    runtimeContext,
                  ),
                {
                  timeoutMs: req.config?.mcpSettings?.catalogRecovery?.generationReadTimeoutMs,
                },
              );
            return [serverName, { ...status, authorizationGeneration }];
          } catch (error) {
            const message = `Failed to get status for server "${serverName}"`;
            logger.error(`[MCP Connection Status] ${message},`, error);
            return [
              serverName,
              {
                connectionState: 'error',
                requiresOAuth: oauthServers.has(serverName),
                ...(requiresEphemeralUserConnection(config) && { requestScoped: true }),
                ...(requiresEphemeralUserConnection(config) &&
                  hasCustomUserVars(config) && { configurationState: 'needs_configuration' }),
                authorizationState: oauthServers.has(serverName) ? 'error' : 'not_required',
                error: message,
              },
            ];
          }
        }),
      ),
    );

    res.json({
      success: true,
      connectionStatus,
      oauthTimeout: mcpSettings.OAUTH_HANDLING_TIMEOUT,
    });
  } catch (error) {
    logger.error('[MCP Connection Status] Failed to get connection status', error);
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Get connection status for a single MCP server
 * This endpoint returns the connection status for a specific server for a given user
 */
router.get('/connection/status/:serverName', requireJwtAuth, configMiddleware, async (req, res) => {
  try {
    const user = req.user;
    const { serverName } = req.params;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const { mcpConfig, appConnections, userConnections, oauthServers } = await getMCPSetupData(
      user.id,
      { role: user.role, tenantId: getTenantId(), appConfig: req.config },
    );

    if (!mcpConfig[serverName]) {
      return res
        .status(404)
        .json({ error: `MCP server '${serverName}' not found in configuration` });
    }

    const runtimeContext = createMCPStatusRuntimeContext(user, mcpConfig, [serverName]);

    const { value: serverStatus, generation: authorizationGeneration } =
      await readMCPRecoveryGenerationAround(
        { userId: user.id, serverName },
        getMCPToolsCacheGeneration,
        () =>
          getServerConnectionStatus(
            user.id,
            serverName,
            mcpConfig[serverName],
            appConnections,
            userConnections,
            oauthServers,
            runtimeContext,
          ),
        {
          timeoutMs: req.config?.mcpSettings?.catalogRecovery?.generationReadTimeoutMs,
        },
      );

    res.json({
      success: true,
      serverName,
      connectionStatus: serverStatus.connectionState,
      requiresOAuth: serverStatus.requiresOAuth,
      requestScoped: serverStatus.requestScoped,
      configurationState: serverStatus.configurationState,
      authorizationState: serverStatus.authorizationState,
      authorizationGeneration,
    });
  } catch (error) {
    logger.error(
      `[MCP Per-Server Status] Failed to get connection status for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to get connection status' });
  }
});

/**
 * Check which authentication values exist for a specific MCP server
 * This endpoint returns only boolean flags indicating if values are set, not the actual values
 */
router.get('/:serverName/auth-values', requireJwtAuth, checkMCPUsePermissions, async (req, res) => {
  try {
    const { serverName } = req.params;
    const user = req.user;

    if (!user?.id) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const configServers = await resolveConfigServers(req);
    const serverConfig = await getMCPServersRegistry().getServerConfig(
      serverName,
      user.id,
      configServers,
    );
    if (!serverConfig) {
      return res.status(404).json({
        error: `MCP server '${serverName}' not found in configuration`,
      });
    }

    const pluginKey = `${Constants.mcp_prefix}${serverName}`;
    const authValueFlags = {};

    if (serverConfig.customUserVars && typeof serverConfig.customUserVars === 'object') {
      for (const varName of Object.keys(serverConfig.customUserVars)) {
        try {
          const value = await getUserPluginAuthValue(user.id, varName, false, pluginKey);
          authValueFlags[varName] = !!(value && value.length > 0);
        } catch (err) {
          logger.error(
            `[MCP Auth Value Flags] Error checking ${varName} for user ${user.id}:`,
            err,
          );
          authValueFlags[varName] = false;
        }
      }
    }

    res.json({
      success: true,
      serverName,
      authValueFlags,
    });
  } catch (error) {
    logger.error(
      `[MCP Auth Value Flags] Failed to check auth value flags for ${req.params.serverName}`,
      error,
    );
    res.status(500).json({ error: 'Failed to check auth value flags' });
  }
});

async function getOAuthHeaders(serverName, userId, configServers) {
  const serverConfig = await getMCPServersRegistry().getServerConfig(
    serverName,
    userId,
    configServers,
  );
  return serverConfig?.oauth_headers ?? {};
}

/**
MCP Server CRUD Routes (User-Managed MCP Servers)
*/

/**
 * Get list of accessible MCP servers
 * @route GET /api/mcp/servers
 * @param {Object} req.query - Query parameters for pagination and search
 * @param {number} [req.query.limit] - Number of results per page
 * @param {string} [req.query.after] - Pagination cursor
 * @param {string} [req.query.search] - Search query for title/description
 * @returns {MCPServerListResponse} 200 - Success response - application/json
 */
router.get('/servers', requireJwtAuth, checkMCPUsePermissions, getMCPServersList);

/**
 * Create a new MCP server
 * @route POST /api/mcp/servers
 * @param {MCPServerCreateParams} req.body - The MCP server creation parameters.
 * @returns {MCPServer} 201 - Success response - application/json
 */
router.post('/servers', requireJwtAuth, checkMCPCreate, createMCPServerController);

/**
 * Get single MCP server by ID
 * @route GET /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.get(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPUsePermissions,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.VIEW,
    resourceIdParam: 'serverName',
  }),
  getMCPServerById,
);

/**
 * Update MCP server
 * @route PATCH /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @param {MCPServerUpdateParams} req.body - The MCP server update parameters.
 * @returns {MCPServer} 200 - Success response - application/json
 */
router.patch(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.EDIT,
    resourceIdParam: 'serverName',
  }),
  updateMCPServerController,
);

/**
 * Delete MCP server
 * @route DELETE /api/mcp/servers/:serverName
 * @param {string} req.params.serverName - MCP server identifier.
 * @returns {Object} 200 - Success response - application/json
 */
router.delete(
  '/servers/:serverName',
  requireJwtAuth,
  checkMCPCreate,
  canAccessMCPServerResource({
    requiredPermission: PermissionBits.DELETE,
    resourceIdParam: 'serverName',
  }),
  (req, res) => deleteMCPServerController(req, res, maybeUninstallOAuthMCP),
);

module.exports = router;
