import { logger } from '@librechat/data-schemas';
import { resolveMCPAppsPolicy } from 'librechat-data-provider';
import type { MCPReinitializeResponse, TMCPAppsPolicy } from 'librechat-data-provider';
import type { AppConfig, PluginAuthMethods } from '@librechat/data-schemas';
import type { Request, RequestHandler, Response } from 'express';
import type { MCPServerCatalogRecoveryPolicy } from './catalog/recovery';
import type { MCPServersRegistry } from './registry/MCPServersRegistry';
import type { AuthIdentityContext } from '~/utils/identity';
import type { UpstreamTokenProvider } from './oauth/obo';
import type { ParsedServerConfig } from './types';
import { MCPAuthenticationRejectedError, MCPAuthenticationRefreshError } from './errors';
import { resolveMCPReinitializeConfig } from './reinitialize';
import { createAuthIdentityContext } from '~/utils/identity';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { getSafeErrorMetadata } from '~/utils/errors';
import { setOAuthCsrfCookie } from '~/oauth/csrf';
import { createSafeUser } from '~/utils/env';
import { getUserMCPAuthMap } from './auth';

type Principal = NonNullable<Parameters<typeof createSafeUser>[0]> & { idOnTheSource?: string };
type ReinitializeRequest = Request<{ serverName: string }> & {
  user: Principal;
  config?: AppConfig;
};

export interface MCPReinitializeDependencies {
  oauthHandlingTimeout: number;
  getOAuthFlowId: (userId: string, serverName: string) => string;
  getMCPManager: () => {
    disconnectUserConnection: (userId: string, serverName: string) => Promise<void>;
  };
  getMCPServersRegistry: () => Pick<MCPServersRegistry, 'getServerConfig' | 'recoverServerConfig'>;
  resolveConfigServers: (
    req: ReinitializeRequest,
  ) => Promise<Record<string, ParsedServerConfig> | undefined>;
  invalidateCachedTools: (scope: {
    userId: string;
    serverName: string;
  }) => Promise<string | undefined>;
  db: Pick<PluginAuthMethods, 'findPluginAuthsByKeys'>;
  getTenantId: () => string | undefined;
  createOpenIDSessionTokenProvider: (params: {
    req: ReinitializeRequest;
    res: Response;
    user: Principal;
    identityContext: AuthIdentityContext;
    tokenPreference: 'access_token';
  }) => UpstreamTokenProvider;
  reinitMCPServer: (params: {
    user: ReturnType<typeof createSafeUser>;
    serverName: string;
    signal: AbortSignal;
    forceNew: true;
    serverConfig: ParsedServerConfig;
    configServers?: Record<string, ParsedServerConfig>;
    userMCPAuthMap?: Record<string, Record<string, string>>;
    upstreamTokenProvider: UpstreamTokenProvider;
    oboIdentityContext: AuthIdentityContext;
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>;
    mcpApps: TMCPAppsPolicy;
  }) => Promise<(MCPReinitializeResponse & { oauthExpiresAt?: number }) | undefined>;
}

function getMCPReinitializeOAuthTimeout(defaultTimeout: number, oauthExpiresAt?: number) {
  if (typeof oauthExpiresAt !== 'number' || !Number.isFinite(oauthExpiresAt)) {
    return defaultTimeout;
  }
  return Math.max(0, oauthExpiresAt - Date.now());
}

/** Keep the request's result independent of other replicas' local transport maps. */
export function createMCPReinitializeHandler(deps: MCPReinitializeDependencies): RequestHandler {
  const {
    oauthHandlingTimeout,
    getOAuthFlowId,
    getMCPManager,
    getMCPServersRegistry,
    resolveConfigServers,
    invalidateCachedTools,
    db,
    getTenantId,
    createOpenIDSessionTokenProvider,
    reinitMCPServer,
  } = deps;
  const OAUTH_CSRF_COOKIE_PATH = '/api/mcp';
  return async (request, res, next) => {
    const req = request as ReinitializeRequest;
    try {
      const { serverName } = req.params;
      const user = createSafeUser(req.user);

      if (!user.id) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      logger.info(`[MCP Reinitialize] Reinitializing server: ${serverName}`);

      const mcpManager = getMCPManager();
      const configServers = await resolveConfigServers(req);
      const registry = getMCPServersRegistry();
      let serverConfig = await registry.getServerConfig(
        serverName,
        user.id,
        configServers,
        req.user.role,
        { idOnTheSource: req.user.idOnTheSource },
      );
      if (!serverConfig) {
        res.status(404).json({
          error: `MCP server '${serverName}' not found in configuration`,
        });
        return;
      }

      let authorizationGeneration: string | undefined;
      try {
        authorizationGeneration = await invalidateCachedTools({ userId: user.id, serverName });
      } finally {
        await mcpManager.disconnectUserConnection(user.id, serverName);
      }
      logger.info(
        `[MCP Reinitialize] Disconnected existing user connection for server: ${serverName}`,
      );

      const resolution = await resolveMCPReinitializeConfig(
        registry,
        serverName,
        serverConfig,
        user.id,
      );
      serverConfig = resolution.serverConfig ?? serverConfig;

      /** @type {Record<string, Record<string, string>> | undefined} */
      let userMCPAuthMap: Record<string, Record<string, string>> | undefined;
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

      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once('close', abort);
      let result: Awaited<ReturnType<MCPReinitializeDependencies['reinitMCPServer']>> =
        resolution.result;
      try {
        if (!result) {
          result = await reinitMCPServer({
            signal: controller.signal,
            forceNew: true,
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
            mcpApps: resolveMCPAppsPolicy(
              req.config?.mcpSettings?.apps,
              undefined,
              req.config?.mcpAppSandbox?.maxPersistedAppBytes,
              req.config?.mcpAppSandbox?.maxAdmissionRequestsPerMinute,
              req.config?.mcpAppSandbox?.url,
              req.config?.mcpAppSandbox?.maxActiveViews,
              req.config?.mcpAppSandbox?.maxActionPreviewChars,
              req.config?.mcpAppSandbox?.operationLimits,
            ),
          });
        }
      } finally {
        res.off('close', abort);
      }

      if (res.destroyed) return;
      if (!result) {
        res.status(500).json({ error: 'Failed to reinitialize MCP server for user' });
        return;
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
        authorizationGeneration,
        configurationUpdatedAt: serverConfig.updatedAt,
        success,
        message,
        oauthUrl,
        flowId,
        oauthTimeout: oauthRequired
          ? getMCPReinitializeOAuthTimeout(oauthHandlingTimeout, oauthExpiresAt)
          : undefined,
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
      logger.error('[MCP Reinitialize] Unexpected error', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Internal server error' });
    }
  };
}
