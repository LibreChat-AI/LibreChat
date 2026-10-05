import { logger, tenantStorage } from '@librechat/data-schemas';
import type { RequestHandler, Request, Response, NextFunction } from 'express';
import type { AppConfig, IUser, UserMethods } from '@librechat/data-schemas';
import type { TAgentsEndpoint } from 'librechat-data-provider';
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
  serverRequest.authStrategy = 'agentManagementM2M';
  contextRequest.tenantId = binding.tenantId;
  tenantContextMiddleware(serverRequest, res, next);
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

      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        sendAuthenticationError(res);
        return;
      }

      let payload: JwtPayload;
      try {
        payload = await (deps.verifyAccessToken ?? verifyOidcAccessToken)(token, enabledAuth.oidc);
      } catch {
        logger.warn('[agentManagementAuth] M2M token verification failed');
        sendAuthenticationError(res);
        return;
      }

      let clientId: string;
      try {
        clientId = getMachineClientId(payload);
      } catch {
        logger.warn('[agentManagementAuth] M2M token claims rejected');
        sendAuthenticationError(res);
        return;
      }
      const binding = findClientBinding(enabledAuth.auth, clientId);
      if (!binding) {
        logger.warn('[agentManagementAuth] Verified token has no enabled client binding');
        sendAuthenticationError(res);
        return;
      }
      if (!hasExpectedMachineSubject(payload, binding)) {
        logger.warn('[agentManagementAuth] M2M token subject rejected');
        sendAuthenticationError(res);
        return;
      }

      const principal = await resolvePrincipal(binding, deps);
      if (principal.status === 'missing') {
        logger.warn('[agentManagementAuth] Client binding has no matching tenant user');
        sendAuthenticationError(res);
        return;
      }
      if (principal.status === 'inactive') {
        res.status(409).json({
          error: 'Account deletion is in progress',
          code: 'ACCOUNT_DELETION_IN_PROGRESS',
        });
        return;
      }

      continueWithPrincipal(req, res, next, binding, principal.user);
    } catch (err) {
      logger.error('[agentManagementAuth] Unexpected authentication error', err);
      sendServerError(res);
    }
  };
  return handler as RequestHandler;
}
