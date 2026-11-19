import { logger, tenantStorage } from '@librechat/data-schemas';
import type { ManagementAdminScopes, TAgentsEndpoint } from 'librechat-data-provider';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { AppConfig, IUser, UserMethods } from '@librechat/data-schemas';
import type { JwtPayload } from 'jsonwebtoken';
import type { GetAppConfigOptions } from '../app/service';
import type { OidcAccessTokenConfig } from '../auth/oidc';
import type { ServerRequest } from '~/types/http';
import type { ContextRequest } from './tenant';
import { extractBearerToken, verifyOidcAccessToken } from '../auth/oidc';
import { tenantContextMiddleware } from './tenant';

export interface AgentManagementAuthDeps {
  findUser: UserMethods['findUser'];
  isPrincipalActive: (userId: string) => Promise<boolean>;
  getAppConfig: (options?: GetAppConfigOptions) => Promise<AppConfig>;
  verifyAccessToken?: (token: string, config: OidcAccessTokenConfig) => Promise<JwtPayload>;
}

type ManagementApi = NonNullable<TAgentsEndpoint['managementApi']>;
type ManagementAuth = NonNullable<ManagementApi['auth']>;
type ManagementOidc = NonNullable<ManagementAuth['oidc']>;
type ManagementClient = ManagementAuth['clients'][number];
type EnabledManagementOidc = ManagementOidc & { issuer: string };

type PrincipalResolution =
  | { status: 'resolved'; user: IUser }
  | { status: 'missing' }
  | { status: 'inactive' };

class AgentManagementAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentManagementAuthError';
  }
}

function sendAuthenticationError(res: Response): void {
  res.status(401).json({ error: 'Unauthorized' });
}

function sendServerError(res: Response): void {
  res.status(500).json({ error: 'Internal server error' });
}

function getEnabledAuth(
  config: AppConfig,
): { auth: ManagementAuth; oidc: EnabledManagementOidc } | undefined {
  const auth = config.endpoints?.agents?.managementApi?.auth;
  const oidc = auth?.oidc;
  const hasAudience = Boolean(oidc?.audience);
  const hasScopedAccessToken = oidc?.tokenUse === 'access' && Boolean(oidc.requiredScopes?.length);
  if (!auth || oidc?.enabled !== true || !oidc.issuer || (!hasAudience && !hasScopedAccessToken)) {
    return;
  }
  return {
    auth,
    oidc: {
      ...oidc,
      issuer: oidc.issuer,
    },
  };
}

function getStringClaim(payload: JwtPayload, key: string): string | undefined {
  const claim = payload[key];
  if (typeof claim !== 'string') return;
  const value = claim.trim();
  return value || undefined;
}

export function getMachineClientId(payload: JwtPayload): string {
  const auth0ClientId = getStringClaim(payload, 'azp');
  const rfcClientId = getStringClaim(payload, 'client_id');

  if (auth0ClientId && rfcClientId && auth0ClientId !== rfcClientId) {
    throw new AgentManagementAuthError('Conflicting OAuth client identifiers');
  }

  const clientId = auth0ClientId ?? rfcClientId;
  if (!clientId) {
    throw new AgentManagementAuthError('Missing OAuth client identifier');
  }

  if (
    typeof payload.exp !== 'number' ||
    !Number.isFinite(payload.exp) ||
    payload.exp <= Date.now() / 1000
  ) {
    throw new AgentManagementAuthError('Token expiration is missing or invalid');
  }

  return clientId;
}

function hasExpectedMachineSubject(payload: JwtPayload, binding: ManagementClient): boolean {
  const subject = getStringClaim(payload, 'sub');
  const expectedSubject = binding.subject;

  if (expectedSubject) return subject === expectedSubject;
  return subject === binding.clientId || subject === `${binding.clientId}@clients`;
}

function findClientBinding(auth: ManagementAuth, clientId: string): ManagementClient | undefined {
  return auth.clients.find((client) => client.enabled !== false && client.clientId === clientId);
}

async function resolvePrincipal(
  binding: ManagementClient,
  deps: Pick<AgentManagementAuthDeps, 'findUser' | 'isPrincipalActive'>,
): Promise<PrincipalResolution> {
  return tenantStorage.run({ tenantId: binding.tenantId }, async () => {
    const user = await deps.findUser({ _id: binding.userId, tenantId: binding.tenantId });
    if (!user) return { status: 'missing' };

    const userId = String(user._id);
    if (userId !== binding.userId.toLowerCase() || user.tenantId !== binding.tenantId) {
      return { status: 'missing' };
    }

    if (!(await deps.isPrincipalActive(userId))) {
      return { status: 'inactive' };
    }

    user.id = userId;
    return { status: 'resolved', user };
  });
}

/** The `authStrategy` a request authenticated by a management client carries. */
export const MANAGEMENT_AUTH_STRATEGY = 'agentManagementM2M';

/** Whether the request's principal is a management client acting as its bound user. */
export function isManagementPrincipal(req: { authStrategy?: string }): boolean {
  return req.authStrategy === MANAGEMENT_AUTH_STRATEGY;
}

function continueWithPrincipal(
  req: Request,
  res: Response,
  next: NextFunction,
  binding: ManagementClient,
  user: IUser,
): void {
  const serverRequest = req as ServerRequest;
  const contextRequest = req as ContextRequest;
  serverRequest.user = user;
  serverRequest.authStrategy = MANAGEMENT_AUTH_STRATEGY;
  serverRequest.managementClientId = binding.clientId;
  contextRequest.tenantId = binding.tenantId;
  tenantContextMiddleware(serverRequest, res, next);
}

/**
 * Outcome of authenticating a request as a management client. `not_management` means the
 * request carries no token of a configured client (no token, a token the management issuer did
 * not sign, or a client without a binding), so another authenticator may still accept it.
 */
type ManagementAuthentication =
  | { status: 'not_management'; reason?: string }
  | { status: 'rejected'; reason: string }
  | { status: 'inactive' }
  | { status: 'resolved'; binding: ManagementClient; user: IUser };

async function authenticateManagementClient(
  req: Request,
  deps: AgentManagementAuthDeps,
  enabledAuth: { auth: ManagementAuth; oidc: EnabledManagementOidc },
): Promise<ManagementAuthentication> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    return { status: 'not_management' };
  }

  let payload: JwtPayload;
  try {
    payload = await (deps.verifyAccessToken ?? verifyOidcAccessToken)(token, enabledAuth.oidc);
  } catch {
    return { status: 'not_management', reason: 'M2M token verification failed' };
  }

  let clientId: string;
  try {
    clientId = getMachineClientId(payload);
  } catch {
    return { status: 'not_management', reason: 'M2M token claims rejected' };
  }
  const binding = findClientBinding(enabledAuth.auth, clientId);
  if (!binding) {
    return { status: 'not_management', reason: 'Verified token has no enabled client binding' };
  }
  if (!hasExpectedMachineSubject(payload, binding)) {
    return { status: 'rejected', reason: 'M2M token subject rejected' };
  }

  const principal = await resolvePrincipal(binding, deps);
  if (principal.status === 'missing') {
    return { status: 'rejected', reason: 'Client binding has no matching tenant user' };
  }
  if (principal.status === 'inactive') {
    return { status: 'inactive' };
  }
  return { status: 'resolved', binding, user: principal.user };
}

function sendInactiveError(res: Response): void {
  res.status(409).json({
    error: 'Account deletion is in progress',
    code: 'ACCOUNT_DELETION_IN_PROGRESS',
  });
}

export function createAgentManagementAuth(deps: AgentManagementAuthDeps): RequestHandler {
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const config = await deps.getAppConfig({ baseOnly: true });
      const enabledAuth = getEnabledAuth(config);
      if (!enabledAuth) {
        sendAuthenticationError(res);
        return;
      }

      const result = await authenticateManagementClient(req, deps, enabledAuth);
      if (result.status === 'resolved') {
        continueWithPrincipal(req, res, next, result.binding, result.user);
        return;
      }
      if (result.status === 'inactive') {
        sendInactiveError(res);
        return;
      }
      if (result.reason) {
        logger.warn(`[agentManagementAuth] ${result.reason}`);
      }
      sendAuthenticationError(res);
    } catch (err) {
      logger.error('[agentManagementAuth] Unexpected authentication error', err);
      sendServerError(res);
    }
  };
  return handler as RequestHandler;
}

export interface ManagementAdminAuthDeps extends AgentManagementAuthDeps {
  /** The admin route family the route serves. */
  scope: ManagementAdminScopes;
  /** The route's session authenticator, used for every request that is not a management client's. */
  fallback: RequestHandler;
  /** Runs after a management client is authenticated (e.g. the terms gate `fallback` applies to sessions). */
  afterManagementAuth?: RequestHandler;
}

/**
 * Authenticates an admin route either as a management client or through the route's own
 * session authenticator. A request is taken as a management client's only when management auth
 * is enabled, some enabled client lists `scope` in `adminScopes`, and the bearer token verifies
 * as a bound client's; every other request goes to `fallback` unchanged. A bound client without
 * `scope` gets 403. The route's capability and permission checks then run against the bound user.
 */
export function createManagementAdminAuth(deps: ManagementAdminAuthDeps): RequestHandler {
  const { scope, fallback, afterManagementAuth } = deps;
  const handler = async (req: Request, res: Response, next: NextFunction) => {
    let result: ManagementAuthentication;
    try {
      const config = await deps.getAppConfig({ baseOnly: true });
      const enabledAuth = getEnabledAuth(config);
      const scopeConfigured = enabledAuth?.auth.clients.some(
        (client) => client.enabled !== false && client.adminScopes?.includes(scope),
      );
      if (!enabledAuth || !scopeConfigured) {
        fallback(req, res, next);
        return;
      }
      result = await authenticateManagementClient(req, deps, enabledAuth);
    } catch (err) {
      logger.error('[managementAdminAuth] Unexpected authentication error', err);
      sendServerError(res);
      return;
    }

    if (result.status === 'not_management') {
      fallback(req, res, next);
      return;
    }
    if (result.status === 'inactive') {
      sendInactiveError(res);
      return;
    }
    if (result.status === 'rejected') {
      logger.warn(`[managementAdminAuth] ${result.reason}`);
      sendAuthenticationError(res);
      return;
    }
    if (!result.binding.adminScopes?.includes(scope)) {
      logger.warn(
        `[managementAdminAuth] Client ${result.binding.clientId} lacks admin scope ${scope}`,
      );
      res.status(403).json({ error: 'Forbidden', message: `Client lacks the ${scope} scope` });
      return;
    }
    continueWithPrincipal(
      req,
      res,
      afterManagementAuth
        ? (err?: unknown) => {
            if (err) {
              next(err);
              return;
            }
            afterManagementAuth(req, res, next);
          }
        : next,
      result.binding,
      result.user,
    );
  };
  return handler as RequestHandler;
}

/** Runs `middleware` for every request except a management client's (e.g. a browser-only check). */
export function unlessManagementPrincipal(middleware: RequestHandler): RequestHandler {
  return (req, res, next) => {
    if (isManagementPrincipal(req as ServerRequest)) {
      next();
      return;
    }
    middleware(req, res, next);
  };
}

/** Refuses a management client on a route its admin scopes do not cover. */
export const rejectManagementPrincipal: RequestHandler = (req, res, next) => {
  if (isManagementPrincipal(req as ServerRequest)) {
    res.status(403).json({ error: 'Forbidden', message: 'Not available to management clients' });
    return;
  }
  next();
};
