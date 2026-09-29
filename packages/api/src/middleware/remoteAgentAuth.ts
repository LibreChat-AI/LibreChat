import { SystemRoles } from 'librechat-data-provider';
import { getTenantId, logger, tenantStorage } from '@librechat/data-schemas';
import type { AppConfig, IUser, RoleMethods, UserMethods } from '@librechat/data-schemas';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { JwtPayload } from 'jsonwebtoken';
import type { GetAppConfigOptions } from '../app/service';
import type { ServerRequest } from '~/types/http';
import type { ContextRequest } from './tenant';
import {
  getLibreChatRolesForOpenIdSync,
  getOpenIdRolesForOpenIdSync,
  getOpenIdRoleSyncOptions,
  selectOpenIdRole,
} from '../auth/openidRoleSync';
import { clearOidcAccessTokenCache, extractBearerToken, verifyOidcAccessToken } from '../auth/oidc';
import { findOpenIDUser, getOpenIdEmail, normalizeOpenIdIssuer } from '../auth/openid';
import { tenantContextMiddleware } from './tenant';

export interface RemoteAgentAuthDeps {
  apiKeyMiddleware: RequestHandler;
  findUser: UserMethods['findUser'];
  getRolesByNames: RoleMethods['findRolesByNames'];
  updateUser: UserMethods['updateUser'];
  isPrincipalActive: (userId: string) => Promise<boolean>;
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
}

type OidcConfig = NonNullable<
  NonNullable<NonNullable<TAgentsEndpoint['remoteApi']>['auth']>['oidc']
>;

type AgentAuthConfig = NonNullable<NonNullable<TAgentsEndpoint['remoteApi']>['auth']>;
type EnabledOidcConfig = OidcConfig & { audience: string; issuer: string };
type ScopeClaim = string | string[] | undefined;
type UserResolution =
  | { status: 'resolved'; user: IUser; updateData: Partial<IUser> }
  | { status: 'missing' }
  | { status: 'rejected'; error: string };

export function clearRemoteAgentAuthCache(): void {
  clearOidcAccessTokenCache();
}

function splitScopes(scopes: string): string[] {
  return scopes.trim().split(/\s+/).filter(Boolean);
}

function getTokenScopes(scopeClaim: ScopeClaim): string[] {
  if (Array.isArray(scopeClaim)) return scopeClaim.flatMap(splitScopes);
  return scopeClaim ? splitScopes(scopeClaim) : [];
}

function hasRequiredScopes(requiredScope: string | undefined, payload: JwtPayload): boolean {
  if (!requiredScope) return true;

  const requiredScopes = splitScopes(requiredScope);
  if (requiredScopes.length === 0) return true;

  const rawScope = (payload['scp'] ?? payload['scope']) as ScopeClaim;
  const tokenScopes = getTokenScopes(rawScope);
  return requiredScopes.every((scope) => tokenScopes.includes(scope));
}

function verifyRemoteOidcAccessToken(
  token: string,
  oidcConfig: EnabledOidcConfig,
): Promise<JwtPayload> {
  return verifyOidcAccessToken(token, oidcConfig, { useOpenIdJwksEnv: true });
}

function getConfigOptions(req: Request): GetAppConfigOptions {
  const user = req.user as { tenantId?: string } | undefined;
  const tenantId = user?.tenantId ?? getTenantId();

  if (tenantId) return { tenantId };
  return { baseOnly: true };
}

function getUserConfigOptions(user: IUser): GetAppConfigOptions {
  if (user.tenantId) return { role: user.role, userId: user.id, tenantId: user.tenantId };
  return { baseOnly: true };
}

function isResolvedUserConfigScope(initialOptions: GetAppConfigOptions, user: IUser): boolean {
  const userOptions = getUserConfigOptions(user);
  return (
    initialOptions.tenantId === userOptions.tenantId &&
    initialOptions.userId === userOptions.userId &&
    initialOptions.role === userOptions.role &&
    initialOptions.baseOnly === userOptions.baseOnly
  );
}

function getRemoteAuthConfig(config: AppConfig): AgentAuthConfig | undefined {
  return config.endpoints?.agents?.remoteApi?.auth;
}

function getEnabledOidcConfig(
  authConfig: AgentAuthConfig | undefined,
): EnabledOidcConfig | undefined {
  if (authConfig?.oidc?.enabled !== true) return undefined;
  if (!authConfig.oidc.issuer) throw new Error('OIDC issuer is required when OIDC auth is enabled');
  if (!authConfig.oidc.audience) {
    throw new Error('OIDC audience is required when OIDC auth is enabled');
  }
  return {
    ...authConfig.oidc,
    audience: authConfig.oidc.audience,
    issuer: authConfig.oidc.issuer,
  };
}

function isApiKeyEnabled(config: AppConfig): boolean {
  return getRemoteAuthConfig(config)?.apiKey?.enabled !== false;
}

function rejectTenantContextConflict(
  requestTenantId: string | undefined,
  userTenantId: string | undefined,
  res: Response,
): boolean {
  if (!requestTenantId || !userTenantId || requestTenantId === userTenantId) {
    return false;
  }

  logger.warn('[remoteAgentAuth] Authenticated user tenant conflicts with request tenant context');
  res.status(401).json({ error: 'Unauthorized' });
  return true;
}

function continueWithAuthenticatedTenantContext(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestTenantId = getTenantId();
  const userTenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;

  if (rejectTenantContextConflict(requestTenantId, userTenantId, res)) {
    return;
  }

  const contextRequest = req as ContextRequest;
  if (requestTenantId) {
    contextRequest.tenantId = requestTenantId;
  }
  tenantContextMiddleware(req as ServerRequest, res, next);
}

async function enforceApiKeyTenantPolicy(
  req: Request,
  res: Response,
  next: NextFunction,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<void> {
  const userTenantId = (req.user as { tenantId?: string } | undefined)?.tenantId;
  if (rejectTenantContextConflict(getTenantId(), userTenantId, res)) {
    return;
  }

  const config = await getAppConfig(getConfigOptions(req));

  if (!isApiKeyEnabled(config)) {
    logger.warn('[remoteAgentAuth] API key rejected by resolved tenant auth policy');
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  continueWithAuthenticatedTenantContext(req, res, next);
}

async function runApiKeyAuth(
  req: Request,
  res: Response,
  next: NextFunction,
  apiKeyMiddleware: RequestHandler,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<void> {
  let postAuth: Promise<void> | undefined;

  const wrappedNext: NextFunction = (err?: unknown) => {
    if (err != null) {
      next(err);
      return;
    }

    postAuth = enforceApiKeyTenantPolicy(req, res, next, getAppConfig);
  };

  await Promise.resolve(apiKeyMiddleware(req, res, wrappedNext));
  if (postAuth) await postAuth;
}

async function enforceOidcTenantPolicy(
  token: string,
  user: IUser,
  initialOptions: GetAppConfigOptions,
  getAppConfig: RemoteAgentAuthDeps['getAppConfig'],
): Promise<boolean> {
  if (isResolvedUserConfigScope(initialOptions, user)) return true;

  const config = await getAppConfig(getUserConfigOptions(user));
  const oidcConfig = getEnabledOidcConfig(getRemoteAuthConfig(config));
  if (!oidcConfig) {
    logger.warn('[remoteAgentAuth] OIDC rejected by resolved tenant auth policy');
    return false;
  }

  try {
    const payload = await verifyRemoteOidcAccessToken(token, oidcConfig);
    if (hasRequiredScopes(oidcConfig.scope, payload)) return true;
    logger.warn(
      `[remoteAgentAuth] Token missing resolved tenant required scope: ${oidcConfig.scope}`,
    );
  } catch (err) {
    logger.warn('[remoteAgentAuth] OIDC token rejected by resolved tenant auth policy:', err);
  }

  return false;
}

async function resolveUser(
  token: string,
  payload: JwtPayload,
  oidcConfig: EnabledOidcConfig,
  findUser: UserMethods['findUser'],
): Promise<UserResolution> {
  if (typeof payload.sub !== 'string' || payload.sub.trim() === '') {
    return { status: 'rejected', error: 'missing_sub_claim' };
  }

  const { user, error, migration } = await findOpenIDUser({
    findUser,
    email: getOpenIdEmail(payload, 'remoteAgentAuth'),
    openidId: payload.sub,
    openidIssuer: oidcConfig.issuer,
    idOnTheSource: payload['oid'] as string | undefined,
    strategyName: 'remoteAgentAuth',
  });

  if (error != null) return { status: 'rejected', error };
  if (user == null) return { status: 'missing' };

  user.id = String(user._id);

  const updateData: Partial<IUser> = {};

  if (migration) {
    updateData.provider = 'openid';
    updateData.openidId = payload.sub;
    updateData.openidIssuer = normalizeOpenIdIssuer(oidcConfig.issuer);
  }

  if (!user.role) {
    user.role = SystemRoles.USER;
    updateData.role = SystemRoles.USER;
  }

  user.federatedTokens = {
    access_token: token,
    ...(payload.exp != null ? { expires_at: payload.exp } : {}),
  };
  return { status: 'resolved', user, updateData };
}

async function selectOpenIdRoleForOpenIdSync(
  payload: JwtPayload,
  user: IUser,
  getRolesByNames: RemoteAgentAuthDeps['getRolesByNames'],
): Promise<string | undefined> {
  const options = getOpenIdRoleSyncOptions();
  if (!options.enabled || !options.apiEnabled) {
    return;
  }

  if (user.role === SystemRoles.ADMIN) {
    logger.info(
      `[remoteAgentAuth] OpenID role sync skipped for ${user.id}; existing ADMIN role is not managed by generic role sync`,
    );
    return;
  }

  if (options.claimSource !== 'access') {
    logger.warn(
      `[remoteAgentAuth] OpenID role sync skipped; source '${options.claimSource}' is not available for API auth`,
    );
    return;
  }

  const openIdRoleValues = await getOpenIdRolesForOpenIdSync({
    options,
    accessClaims: payload,
    decodeToken: () => payload,
    resolveGroupOverage: async () => [],
  });
  if (openIdRoleValues === undefined) {
    logger.warn(
      `[remoteAgentAuth] OpenID role sync skipped; claim '${options.claim}' was not found or invalid`,
    );
    return;
  }

  const loadLibreChatRoles = async () =>
    getLibreChatRolesForOpenIdSync({
      getRolesByNames,
      rolePriority: options.rolePriority,
      fallbackRole: options.fallbackRole,
      logPrefix: '[remoteAgentAuth]',
    });
  const { rolePriority, fallbackRole } =
    user.tenantId && getTenantId() !== user.tenantId
      ? await tenantStorage.run({ tenantId: user.tenantId }, loadLibreChatRoles)
      : await loadLibreChatRoles();
  const result = selectOpenIdRole({
    currentRole: user.role,
    openIdRoleValues,
    rolePriority,
    fallbackRole,
  });

  if (!result.selectedRole || result.selectedRole === user.role) {
    return;
  }

  logger.info(
    `[remoteAgentAuth] OpenID role sync selected role for ${user.id}: ${user.role || 'unset'} -> ${result.selectedRole}`,
  );
  return result.selectedRole;
}

async function updateResolvedUser(
  userResolution: Extract<UserResolution, { status: 'resolved' }>,
  updateUser: RemoteAgentAuthDeps['updateUser'],
): Promise<void> {
  if (Object.keys(userResolution.updateData).length === 0) {
    return;
  }

  const update = async () => updateUser(userResolution.user.id, userResolution.updateData);
  if (userResolution.user.tenantId && getTenantId() !== userResolution.user.tenantId) {
    await tenantStorage.run({ tenantId: userResolution.user.tenantId }, update);
    return;
  }

  await update();
}

/**
 * Factory for Remote Agent API auth middleware.
 *
 * Validates Bearer tokens against configured OIDC issuer via JWKS,
 * falling back to API key auth when enabled. Stateless — no session dependency.
 *
 * ```yaml
 * endpoints:
 *   agents:
 *     remoteApi:
 *       auth:
 *         apiKey:
 *           enabled: false
 *         oidc:
 *           enabled: true
 *           issuer: <issuer>
 *           jwksUri: <jwksUri>
 *           audience: <audience>
 *           scope: <scope>
 * ```
 */
export function createRemoteAgentAuth({
  apiKeyMiddleware,
  findUser,
  getRolesByNames,
  updateUser,
  isPrincipalActive,
  getAppConfig,
}: RemoteAgentAuthDeps): RequestHandler {
  /**
   * Annotated as `express.Request` (and helpers below take the same type)
   * so the local `Request.user` augmentation in `src/types/express.d.ts`
   * applies inside the closure. The closure is then cast to
   * `RequestHandler` at the return — `RequestHandler`'s internal
   * `Request` resolves through `express-serve-static-core` and lacks the
   * augmentation, so a direct return would mismatch on `user`.
   */
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const initialConfigOptions = getConfigOptions(req);
      const config = await getAppConfig(initialConfigOptions);
      const authConfig = getRemoteAuthConfig(config);
      const apiKeyEnabled = isApiKeyEnabled(config);

      if (authConfig?.oidc?.enabled !== true) {
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Authentication required' });
        return;
      }

      if (!authConfig.oidc.issuer) {
        logger.error('[remoteAgentAuth] OIDC issuer is required when OIDC auth is enabled');
        res.status(500).json({ error: 'Internal server error' });
        return;
      }
      if (!authConfig.oidc.audience) {
        logger.error('[remoteAgentAuth] OIDC audience is required when OIDC auth is enabled');
        res.status(500).json({ error: 'Internal server error' });
        return;
      }

      const oidcConfig = getEnabledOidcConfig(authConfig);
      if (!oidcConfig) throw new Error('OIDC configuration is required when OIDC auth is enabled');

      const token = extractBearerToken(req.headers.authorization);
      if (token == null) {
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Bearer token required' });
        return;
      }

      let payload: JwtPayload;

      try {
        payload = await verifyRemoteOidcAccessToken(token, oidcConfig);
        if (!hasRequiredScopes(oidcConfig.scope, payload)) {
          logger.warn(`[remoteAgentAuth] Token missing required scope: ${oidcConfig.scope}`);
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
      } catch (oidcErr) {
        if (apiKeyEnabled) {
          logger.debug('[remoteAgentAuth] OIDC verification failed; trying API key auth:', oidcErr);
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        logger.error('[remoteAgentAuth] OIDC verification failed:', oidcErr);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const userResolution = await resolveUser(token, payload, oidcConfig, findUser);

      if (userResolution.status === 'rejected') {
        logger.warn(`[remoteAgentAuth] OpenID user rejected: ${userResolution.error}`);
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (userResolution.status === 'missing') {
        logger.warn('[remoteAgentAuth] OIDC token valid but no matching LibreChat user');
        if (apiKeyEnabled) {
          await runApiKeyAuth(req, res, next, apiKeyMiddleware, getAppConfig);
          return;
        }
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (rejectTenantContextConflict(getTenantId(), userResolution.user.tenantId, res)) {
        return;
      }

      if (
        !(await enforceOidcTenantPolicy(
          token,
          userResolution.user,
          initialConfigOptions,
          getAppConfig,
        ))
      ) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const selectedRole = await selectOpenIdRoleForOpenIdSync(
        payload,
        userResolution.user,
        getRolesByNames,
      );
      const roleChanged = Boolean(selectedRole);
      if (selectedRole) {
        userResolution.user.role = selectedRole;
        userResolution.updateData.role = selectedRole;
      }

      if (
        roleChanged &&
        !(await enforceOidcTenantPolicy(
          token,
          userResolution.user,
          initialConfigOptions,
          getAppConfig,
        ))
      ) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      if (!(await isPrincipalActive(userResolution.user.id))) {
        res.status(409).json({
          error: 'Account deletion is in progress',
          code: 'ACCOUNT_DELETION_IN_PROGRESS',
        });
        return;
      }

      await updateResolvedUser(userResolution, updateUser);

      req.user = userResolution.user;
      return continueWithAuthenticatedTenantContext(req, res, next);
    } catch (err) {
      logger.error('[remoteAgentAuth] Unexpected error', err);
      res.status(500).json({ error: 'Internal server error' });
      return;
    }
  };
  return handler as RequestHandler;
}
