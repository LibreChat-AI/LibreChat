const { logger, getTenantId } = require('@librechat/data-schemas');
const { prepareMCPAuthorizationMutation } = require('@librechat/api');
const { CacheKeys } = require('librechat-data-provider');
const { createOAuthReconnectionManager, getFlowStateManager, getMCPManager } = require('~/config');
const { findToken, updateToken, createToken, deleteTokens } = require('~/models');
const { getLogStores } = require('~/cache');
const { getAppConfig, invalidateCachedTools } = require('~/server/services/Config');
const {
  clearMCPAuthorizationFenceRetry,
  persistMCPAuthorizationFenceRetry,
} = require('~/server/services/MCPAuthorizationFenceRetry');

/**
 * Initialize OAuth reconnect manager
 */
async function initializeOAuthReconnectManager() {
  try {
    const flowManager = getFlowStateManager(getLogStores(CacheKeys.FLOWS));
    const tokenMethods = {
      findToken,
      updateToken,
      createToken,
      deleteTokens,
    };
    await createOAuthReconnectionManager(
      flowManager,
      tokenMethods,
      undefined,
      undefined,
      async (scope) => {
        const appConfig = await getAppConfig({ tenantId: getTenantId(), userId: scope.userId });
        return prepareMCPAuthorizationMutation(scope, {
          invalidateRecoveryGeneration: invalidateCachedTools,
          persistPublicationRetry: persistMCPAuthorizationFenceRetry,
          clearPublicationRetry: clearMCPAuthorizationFenceRetry,
          clearLocalRecovery: (userId, serverName) =>
            getMCPManager()?.clearCatalogRecoveryState?.(userId, serverName),
          retryDelaysMs: appConfig?.mcpSettings?.catalogRecovery?.authorizationFenceRetryMs,
          attemptTimeoutMs: appConfig?.mcpSettings?.catalogRecovery?.authorizationFenceTimeoutMs,
        });
      },
    );
    logger.info(`OAuth reconnect manager initialized successfully.`);
  } catch (error) {
    logger.error('Failed to initialize OAuth reconnect manager:', error);
  }
}

module.exports = initializeOAuthReconnectManager;
