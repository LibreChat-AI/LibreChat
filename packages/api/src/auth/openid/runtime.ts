import {
  createOpenIDAuthorizationMethods,
  createResourceLockMethods,
  createResourceLockModel,
  detectMongoEngine,
  resolveAuthorizationQueryOptions,
} from '@librechat/data-schemas';
import type { MongoEngineOverride, OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Connection, ConnectOptions } from 'mongoose';

type ResourceLockMethods = ReturnType<typeof createResourceLockMethods>;
import { DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS } from 'librechat-data-provider';
import { createOpenIDSessionAuthorization } from './sessions';
import type {
  OpenIDLoginDeps,
  OpenIDSessionAuthorization,
  OpenIDSessionAuthorizationDeps,
  RevokeCurrentOpenIDSessionDeps,
} from './sessions';
import { optionalEnabled } from '~/utils/common';
import type { OpenIDLogger } from './types';

const DEFAULT_MONGO_AUTH_MAX_POOL_SIZE = 10;
const DEFAULT_MONGO_AUTH_SERVER_SELECTION_TIMEOUT_MS = 5000;
const DEFAULT_MONGO_AUTH_SOCKET_TIMEOUT_MS = 5000;
const CONNECT_RETRY_DELAY_MS = 10_000;

export interface OpenIDSessionsAppConfig {
  registration?: {
    openidSessionEnforcement?: boolean;
    openidAuthorizationTimeoutMs?: number;
    openidAuthorizationEngine?: MongoEngineOverride;
  };
}

export interface OpenIDSessionsRuntimeDeps {
  mongoose: typeof import('mongoose');
  logger: OpenIDLogger;
  isOpenIdConfigured: () => boolean;
}

export interface OpenIDSessionsRuntime {
  isOpenIdConfigured: () => boolean;
  connectOpenIDAuthorization: (
    appConfig?: OpenIDSessionsAppConfig,
  ) => Promise<OpenIDSessionAuthorization | undefined>;
  getAuthorizationMethods: () => OpenIDAuthorizationMethods | undefined;
  getAuthorizationDeps: () => OpenIDSessionAuthorizationDeps | undefined;
  getLoginDeps: () => OpenIDLoginDeps | undefined;
  getRevokeDeps: () => RevokeCurrentOpenIDSessionDeps | undefined;
  getLeaseMethods: () => ResourceLockMethods | undefined;
  getOpenIdClientId: () => string | undefined;
  /** Stable object identity `session.ts`/`recovery.ts` destructure at require time; fields are
   *  filled in later via `Object.assign` rather than replacing the object. */
  sessionAuthorizationRef: Partial<OpenIDSessionAuthorizationDeps>;
}

function buildConnectionOptions(): ConnectOptions {
  const maxPoolSize =
    parseInt(process.env.MONGO_AUTH_MAX_POOL_SIZE ?? '') || DEFAULT_MONGO_AUTH_MAX_POOL_SIZE;
  const minPoolSize = parseInt(process.env.MONGO_MIN_POOL_SIZE ?? '') || undefined;
  const maxConnecting = parseInt(process.env.MONGO_MAX_CONNECTING ?? '') || undefined;
  const maxIdleTimeMS = parseInt(process.env.MONGO_MAX_IDLE_TIME_MS ?? '') || undefined;
  const waitQueueTimeoutMS = parseInt(process.env.MONGO_WAIT_QUEUE_TIMEOUT_MS ?? '') || undefined;
  const serverSelectionTimeoutMS =
    parseInt(process.env.MONGO_AUTH_SERVER_SELECTION_TIMEOUT_MS ?? '') ||
    DEFAULT_MONGO_AUTH_SERVER_SELECTION_TIMEOUT_MS;
  const socketTimeoutMS =
    parseInt(process.env.MONGO_AUTH_SOCKET_TIMEOUT_MS ?? '') ||
    DEFAULT_MONGO_AUTH_SOCKET_TIMEOUT_MS;
  const autoIndex = optionalEnabled(process.env.MONGO_AUTO_INDEX);
  const autoCreate = optionalEnabled(process.env.MONGO_AUTO_CREATE);
  return {
    bufferCommands: false,
    maxPoolSize,
    serverSelectionTimeoutMS,
    socketTimeoutMS,
    ...(minPoolSize ? { minPoolSize } : {}),
    ...(maxConnecting ? { maxConnecting } : {}),
    ...(maxIdleTimeMS ? { maxIdleTimeMS } : {}),
    ...(waitQueueTimeoutMS ? { waitQueueTimeoutMS } : {}),
    ...(autoIndex != undefined ? { autoIndex } : {}),
    ...(autoCreate != undefined ? { autoCreate } : {}),
  };
}

/** A proxy that rejects every call; stands in for `methods` while the connection is down so
 *  authorization checks resolve to `unavailable` instead of hanging or throwing a TypeError. */
function createPendingAuthorizationMethods(): OpenIDAuthorizationMethods {
  return new Proxy(
    {},
    {
      get: (_target, prop) => {
        /** Not a thenable; `await`-ing this proxy must resolve to itself, not hang or throw. */
        if (prop === 'then' || typeof prop === 'symbol') {
          return undefined;
        }
        return () => Promise.reject(new Error('OpenID authorization connection is not ready'));
      },
    },
  ) as unknown as OpenIDAuthorizationMethods;
}

export function createOpenIDSessionsRuntime(
  deps: OpenIDSessionsRuntimeDeps,
): OpenIDSessionsRuntime {
  const { mongoose, logger, isOpenIdConfigured } = deps;

  let connection: Connection | undefined;
  let methods: OpenIDAuthorizationMethods | undefined;
  let authorization: OpenIDSessionAuthorization | undefined;
  let connecting: Promise<OpenIDSessionAuthorization | undefined> | undefined;
  let leaseMethods: ResourceLockMethods | undefined;
  let unconfiguredEnforcementHandled = false;

  const sessionAuthorizationRef: Partial<OpenIDSessionAuthorizationDeps> = {};

  function attachPending(registration: OpenIDSessionsAppConfig['registration'], timeoutMs: number) {
    const pending = createOpenIDSessionAuthorization({
      authorization: createPendingAuthorizationMethods(),
      enforcement: registration?.openidSessionEnforcement === true,
      timeoutMs,
      logger,
    });
    Object.assign(sessionAuthorizationRef, pending.authorizationDeps);
  }

  function scheduleConnectRetry(appConfig?: OpenIDSessionsAppConfig) {
    const timer = setTimeout(() => {
      connectOpenIDAuthorization(appConfig).catch(() => {});
    }, CONNECT_RETRY_DELAY_MS);
    timer.unref?.();
  }

  /** Isolated so concurrent callers can share one promise that never rejects: a failure logs,
   *  attaches a pending stub, and schedules a retry instead of throwing. */
  async function attemptConnect(
    appConfig?: OpenIDSessionsAppConfig,
  ): Promise<OpenIDSessionAuthorization | undefined> {
    const registration = appConfig?.registration ?? {};
    const timeoutMs =
      registration.openidAuthorizationTimeoutMs ?? DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS;
    let nextConnection: Connection | undefined;
    try {
      const uri = process.env.MONGO_AUTH_URI || process.env.MONGO_URI;
      if (!uri) {
        throw new Error('Please define the MONGO_URI or MONGO_AUTH_URI environment variable');
      }
      nextConnection = await mongoose.createConnection(uri, buildConnectionOptions()).asPromise();
      const engine = await detectMongoEngine(
        nextConnection,
        registration.openidAuthorizationEngine,
      );
      const queryOptions = resolveAuthorizationQueryOptions(engine, { maxTimeMS: timeoutMs });
      connection = nextConnection;
      methods = createOpenIDAuthorizationMethods(connection, queryOptions);
      /** The lease must live on the primary, not a possibly read-only secondary; `Connection`
       *  exposes the same `.models`/`.model()` surface these helpers use. */
      const authConnection = connection as unknown as typeof import('mongoose');
      createResourceLockModel(authConnection);
      leaseMethods = createResourceLockMethods(authConnection);
      authorization = createOpenIDSessionAuthorization({
        authorization: methods,
        enforcement: registration.openidSessionEnforcement === true,
        timeoutMs,
        logger,
      });
      Object.assign(sessionAuthorizationRef, authorization.authorizationDeps);
      logger.info(`[OpenIDSessions] Authorization connection ready (engine: ${engine})`);
      return authorization;
    } catch (error) {
      connection = undefined;
      methods = undefined;
      leaseMethods = undefined;
      if (nextConnection) {
        await nextConnection.close().catch(() => {});
      }
      logger.error(
        '[OpenIDSessions] Authorization connection failed; retrying in the background',
        error as Error,
      );
      attachPending(registration, timeoutMs);
      scheduleConnectRetry(appConfig);
      return undefined;
    }
  }

  /** Connects the dedicated authorization connection; a no-op when OpenID isn't configured. A
   *  failed attempt never throws here — see `attemptConnect`. */
  async function connectOpenIDAuthorization(
    appConfig?: OpenIDSessionsAppConfig,
  ): Promise<OpenIDSessionAuthorization | undefined> {
    if (connection) {
      return authorization;
    }
    if (!isOpenIdConfigured()) {
      const registration = appConfig?.registration;
      if (registration?.openidSessionEnforcement === true && !unconfiguredEnforcementHandled) {
        unconfiguredEnforcementHandled = true;
        const timeoutMs =
          registration.openidAuthorizationTimeoutMs ?? DEFAULT_OPENID_AUTHORIZATION_TIMEOUT_MS;
        logger.error(
          '[OpenIDSessions] openidSessionEnforcement is enabled but OpenID is not configured; authorization fails closed',
        );
        attachPending(registration, timeoutMs);
      }
      return undefined;
    }
    if (!connecting) {
      connecting = attemptConnect(appConfig).finally(() => {
        connecting = undefined;
      });
    }
    return connecting;
  }

  return {
    isOpenIdConfigured,
    connectOpenIDAuthorization,
    getAuthorizationMethods: () => methods,
    getAuthorizationDeps: () => authorization?.authorizationDeps,
    getLoginDeps: () => authorization?.loginDeps,
    getRevokeDeps: () => authorization?.revokeDeps,
    getLeaseMethods: () => leaseMethods,
    /** LibreChat client ID bound to the OpenID credentials this deployment registered. */
    getOpenIdClientId: () => process.env.OPENID_CLIENT_ID,
    sessionAuthorizationRef,
  };
}
