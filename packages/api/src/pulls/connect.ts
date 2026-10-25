import express from 'express';
import { logger, getTenantId, tenantStorage } from '@librechat/data-schemas';
import type {
  PullRequestProvider,
  TPullRequestConnection,
  TPullRequestConnectStart,
} from 'librechat-data-provider';
import type { Request, Response, Router, RequestHandler } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import type { PullRequestOAuth, PullRequestOAuthStore } from './oauth';
import type { PullRequestOAuthConfig } from './settings';
import type { PullRequestUserToken } from './handler';
import type { PullRequestFetch } from './shared';
import type { ServerRequest } from '~/types';
import {
  PULL_REQUEST_OAUTH_CALLBACK_PATH,
  createPullRequestOAuthFromEnv,
  DEFAULT_PULL_REQUEST_OAUTH_FLOW_MINUTES,
} from './oauth';
import {
  setOAuthSession,
  validateOAuthCsrf,
  setOAuthCsrfCookie,
  validateOAuthSession,
} from '~/oauth/csrf';
import { isPullRequestFeatureActive, resolvePullRequestOAuth } from './settings';
import { readPullRequestSettings } from './handler';
import { getSafeErrorMetadata } from '~/utils';
import { getBasePath } from '~/utils/path';

const PROVIDER_NAMES: Record<PullRequestProvider, string> = {
  github: 'GitHub',
  gitlab: 'GitLab',
  bitbucket: 'Bitbucket',
};

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The routes a user connects and disconnects their own account through. Starting a connection
 * and reading or removing it need the signed-in user; the callback arrives from the provider
 * without one and is trusted only through its signed `state` plus the CSRF or session cookie that
 * binds it to the browser that started the flow. Failures redirect to the shared OAuth error page
 * with one of its known codes, never with provider text; the JSON routes answer with a stable
 * `code` a client can localize.
 */
export function createPullRequestConnectionHandlers(deps: {
  oauth: PullRequestOAuth;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  /** The user a callback's signed state names, as config resolution needs it; null if gone. */
  getUser: (userId: string) => Promise<AppConfigUserLike | null>;
  env: Env;
}) {
  /**
   * A user's connection settings: the feature as that user's effective config resolves it (role,
   * group and user overrides included), with the app taken from the operator's YAML. Starting a
   * flow and finishing it both ask this, so a flow that may start may also finish.
   */
  async function configFor(
    user: AppConfigUserLike | null | undefined,
  ): Promise<PullRequestOAuthConfig | null> {
    const settings = await readPullRequestSettings(deps.getAppConfig, user);
    if (settings == null || !isPullRequestFeatureActive(settings, deps.env)) return null;
    return resolvePullRequestOAuth(settings, deps.env);
  }

  const redirect = (res: Response, page: string) => res.redirect(`${getBasePath()}${page}`);
  /** Names the flow once it is known to be this browser's, so the page that started it can stop
   *  watching that flow alone; an unbound or unreadable state names none. */
  const flowParam = (flowId?: string) => (flowId ? `&flow=${encodeURIComponent(flowId)}` : '');
  const fail = (res: Response, code: string, flowId?: string) =>
    redirect(res, `/oauth/error?error=${encodeURIComponent(code)}${flowParam(flowId)}`);

  async function finishCallback(
    res: Response,
    claims: NonNullable<ReturnType<PullRequestOAuth['verifyState']>>,
    code: string,
  ): Promise<void> {
    try {
      /** The user must still exist, in the tenant the flow started in. */
      const user = await deps.getUser(claims.userId);
      if (user == null || (user.tenantId ?? null) !== (claims.tenantId ?? null)) {
        fail(res, 'invalid_state', claims.flowId);
        return;
      }
      /** The same check as starting the flow; a changed app voids flows started before. */
      const config = await configFor({ ...user, id: claims.userId });
      if (config == null || config.provider !== claims.provider || config.host !== claims.host) {
        fail(res, 'invalid_state', claims.flowId);
        return;
      }
      await deps.oauth.complete(claims, code, config);
      redirect(
        res,
        `/oauth/success?serverName=${encodeURIComponent(PROVIDER_NAMES[config.provider])}${flowParam(claims.flowId)}`,
      );
    } catch (caught) {
      logger.warn('[PullRequests] Connection callback failed', getSafeErrorMetadata(caught));
      fail(res, 'callback_failed', claims.flowId);
    }
  }

  return {
    async connect(req: ServerRequest, res: Response): Promise<void> {
      const user = req.user;
      if (!user?.id) {
        res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      try {
        const config = await configFor(req.user);
        if (config == null) {
          res
            .status(404)
            .json({ error: 'Connecting an account is not available', code: 'NOT_CONFIGURED' });
          return;
        }
        const tenantId = getTenantId() ?? user.tenantId;
        const { url, flowId } = await deps.oauth.authorizationUrl(
          { id: user.id, ...(tenantId ? { tenantId } : {}) },
          config,
        );
        /** How long the signed state stays valid: the binding cookie lives as long, and the
         *  client watches for exactly that long, so an approval inside the window can finish. */
        const expiresInSeconds =
          (config.flowTimeoutMinutes ?? DEFAULT_PULL_REQUEST_OAUTH_FLOW_MINUTES) * 60;
        setOAuthCsrfCookie(res, flowId, PULL_REQUEST_OAUTH_CALLBACK_PATH, expiresInSeconds * 1000);
        const body: TPullRequestConnectStart = { url, expiresInSeconds, flowId };
        res.status(200).json(body);
      } catch (error) {
        logger.error('[PullRequests] Could not start a connection', getSafeErrorMetadata(error));
        res.status(500).json({ error: 'Failed to start the connection', code: 'CONNECT_FAILED' });
      }
    },

    async callback(req: Request, res: Response): Promise<void> {
      const { code, state, error } = req.query as Record<string, unknown>;
      if (typeof state !== 'string' || state === '') {
        fail(res, 'missing_state');
        return;
      }
      const claims = deps.oauth.verifyState(state);
      if (claims == null) {
        fail(res, 'invalid_state');
        return;
      }
      /** The browser finishing the flow must be the one that started it, for that user. */
      const bound =
        validateOAuthCsrf(req, res, claims.flowId, PULL_REQUEST_OAUTH_CALLBACK_PATH) ||
        validateOAuthSession(req, claims.userId);
      if (!bound) {
        fail(res, 'invalid_state');
        return;
      }
      if (typeof error === 'string' && error !== '') {
        fail(res, 'callback_failed', claims.flowId);
        return;
      }
      if (typeof code !== 'string' || code === '') {
        fail(res, 'missing_code', claims.flowId);
        return;
      }
      /**
       * The provider's redirect carries no session, so the tenant the flow started in is restored
       * from the signed state before anything is read or stored. A request already placed in
       * another tenant (by host, for example) is refused rather than stored there.
       */
      const current = getTenantId();
      if (current != null && current !== claims.tenantId) {
        fail(res, 'invalid_state', claims.flowId);
        return;
      }
      const finish = () => finishCallback(res, claims, code);
      if (claims.tenantId && current == null) {
        await tenantStorage.run({ tenantId: claims.tenantId }, finish);
        return;
      }
      await finish();
    },

    async status(req: ServerRequest, res: Response): Promise<void> {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      try {
        const config = await configFor(req.user);
        /** Without a usable app the grant is read under any app or host, so one made before the
         *  app was turned off still shows, and the user can still remove it. */
        const stored =
          config == null
            ? await deps.oauth.storedStatus(userId)
            : await deps.oauth.status(userId, config);
        const body: TPullRequestConnection = {
          configured: config != null,
          ...(config != null ? { provider: config.provider } : {}),
          connected: stored.connected,
          ...(stored.flowId != null ? { flowId: stored.flowId } : {}),
        };
        res.status(200).json(body);
      } catch (error) {
        logger.error('[PullRequests] Could not read the connection', getSafeErrorMetadata(error));
        res.status(500).json({ error: 'Failed to read the connection', code: 'STATUS_FAILED' });
      }
    },

    async disconnect(req: ServerRequest, res: Response): Promise<void> {
      const userId = req.user?.id;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
        return;
      }
      try {
        /** Not gated on the current configuration: a grant made under an app or host that has
         *  since changed must still go, or restoring that configuration would revive it. */
        await deps.oauth.disconnect(userId);
        res.status(204).end();
      } catch (error) {
        logger.error('[PullRequests] Could not disconnect', getSafeErrorMetadata(error));
        res.status(500).json({ error: 'Failed to disconnect', code: 'DISCONNECT_FAILED' });
      }
    },
  };
}

type ConnectionSettings = Parameters<typeof resolvePullRequestOAuth>[0];

/** A `PullRequestUserToken` that reads only the connection settings it needs. */
type ConnectionToken = ((
  userId: string,
  settings: ConnectionSettings,
) => Promise<string | null>) & {
  reject: (userId: string, settings: ConnectionSettings, token: string) => Promise<void>;
};

/** The lookups' view of a connection: the user's token, or none, and its invalidation. */
export function createPullRequestUserToken(oauth: PullRequestOAuth, env: Env): ConnectionToken {
  const read = async (userId: string, settings: ConnectionSettings) => {
    const config = resolvePullRequestOAuth(settings, env);
    return config == null ? null : oauth.token(userId, config);
  };
  return Object.assign(read, {
    reject: async (userId: string, settings: ConnectionSettings, token: string) => {
      const config = resolvePullRequestOAuth(settings, env);
      if (config != null) await oauth.reject(userId, config, token);
    },
  });
}

type ConnectionDeps = {
  store: PullRequestOAuthStore;
  fetchFn: PullRequestFetch;
  env: Env;
};

/** The lookups' user tokens for this deployment, or none when users cannot connect at all. */
export function createPullRequestUserTokenFromEnv(
  deps: ConnectionDeps,
): PullRequestUserToken | undefined {
  const oauth = createPullRequestOAuthFromEnv(deps);
  return oauth && createPullRequestUserToken(oauth, deps.env);
}

/**
 * The connection routes, mounted under `/api/pull-requests`. Without a signing secret no route is
 * registered. The callback is unauthenticated by design (see the handlers); the others need the
 * caller's `requireJwtAuth`.
 */
export function createPullRequestConnectionRouter(
  deps: ConnectionDeps & {
    getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
    getUserById: (
      userId: string,
      fieldsToSelect: string,
    ) => Promise<{ role?: string; tenantId?: string; idOnTheSource?: string | null } | null>;
    requireJwtAuth: RequestHandler;
    /** Marks the callback as a browser navigation, so a limiter or ban answers it with the
     *  localized OAuth failure page instead of JSON. Runs before the limiter. */
    markNavigation: RequestHandler;
    /** The app's limiter for unauthenticated OAuth callbacks: each one costs a token exchange. */
    callbackLimiter: RequestHandler;
  },
): Router {
  const router = express.Router();
  const oauth = createPullRequestOAuthFromEnv(deps);
  if (oauth == null) return router;
  const handlers = createPullRequestConnectionHandlers({
    oauth,
    getAppConfig: deps.getAppConfig,
    getUser: async (userId) => {
      const user = await deps.getUserById(userId, 'role tenantId idOnTheSource');
      if (user == null) return null;
      return {
        id: userId,
        ...(user.role != null ? { role: user.role } : {}),
        ...(user.tenantId != null ? { tenantId: user.tenantId } : {}),
        ...(user.idOnTheSource !== undefined ? { idOnTheSource: user.idOnTheSource } : {}),
      };
    },
    env: deps.env,
  });
  /** Behind `requireJwtAuth`, which puts the signed-in user on the request. */
  const authed = (handler: (req: ServerRequest, res: Response) => Promise<void>) =>
    handler as unknown as RequestHandler;
  router.get('/oauth/callback', deps.markNavigation, deps.callbackLimiter, handlers.callback);
  router.get('/oauth/connect', deps.requireJwtAuth, setOAuthSession, authed(handlers.connect));
  router.get('/oauth/status', deps.requireJwtAuth, authed(handlers.status));
  router.delete('/oauth', deps.requireJwtAuth, authed(handlers.disconnect));
  return router;
}
