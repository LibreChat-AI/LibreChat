import type {
  ProviderSessionOperationData,
  ProviderSessionEstablishResult,
  ProviderSessionAuthorizeResult,
  ProviderSessionRevokeResult,
} from '@librechat/data-schemas';
import type { BackchannelLogoutRegistration, ResolvedBackchannelLogoutConfig } from './config';
import type { ProviderSessionAuthorizer } from './authorize';
import type { OpenIdIssuerSource } from '~/auth/openid';
import type { OpenIDLogger } from '../types';
import { resolveBackchannelLogoutConfig, createMemoizedConfigLoader } from './config';
import { createProviderSessionAuthorizer } from './authorize';
import { getOpenIdIssuer } from '~/auth/openid';

export interface ProviderSessionServiceMethods {
  establish: (data: ProviderSessionOperationData) => Promise<ProviderSessionEstablishResult>;
  authorize: (data: ProviderSessionOperationData) => Promise<ProviderSessionAuthorizeResult>;
  revoke: (data: ProviderSessionOperationData) => Promise<ProviderSessionRevokeResult>;
}

export interface CreateProviderSessionServiceOptions {
  methods: ProviderSessionServiceMethods;
  /** Resolves the deployment app config; only `registration` is read. */
  getAppConfig: (options: {
    baseOnly: boolean;
  }) => Promise<{ registration?: BackchannelLogoutRegistration } | null | undefined>;
  /** Returns the configured OpenID client, throwing when OpenID is not set up. */
  getOpenIdClient: () => OpenIdIssuerSource;
  logger: OpenIDLogger;
}

export interface ProviderSessionService {
  getProviderSessionAuthorizer: () => ProviderSessionAuthorizer;
  getBackchannelLogoutConfig: () => Promise<ResolvedBackchannelLogoutConfig>;
  /** Preloads the config at startup so the first request doesn't pay the load latency, swallowing
   *  a failure so the lazy load inside `getProviderSessionAuthorizer()` can retry on demand. */
  preloadBackchannelLogoutConfig: () => Promise<void>;
  /** `{ issuer, clientId }` for the configured OpenID provider, normalized the same way login
   *  does, or `null` when OpenID is not configured. */
  getProviderSessionClient: () => { issuer: string; clientId: string } | null;
  revokeProviderSession: (
    data: ProviderSessionOperationData,
  ) => Promise<ProviderSessionRevokeResult>;
  /** Lazy proxy: each method resolves `getProviderSessionAuthorizer()` per call, so callers can
   *  capture this object once, at construction time. */
  providerSessionAuthorizer: ProviderSessionAuthorizer;
}

/** Wires the provider-session authorizer, its config loader, and the OpenID client lookup from
 *  injected deps. Memoized only on success; a failed config load is never cached. */
export function createProviderSessionService({
  methods,
  getAppConfig,
  getOpenIdClient,
  logger,
}: CreateProviderSessionServiceOptions): ProviderSessionService {
  async function loadBackchannelLogoutConfig(): Promise<ResolvedBackchannelLogoutConfig> {
    const appConfig = await getAppConfig({ baseOnly: true });
    return resolveBackchannelLogoutConfig(appConfig?.registration);
  }

  const getBackchannelLogoutConfig = createMemoizedConfigLoader(loadBackchannelLogoutConfig);

  let authorizer: ProviderSessionAuthorizer | null = null;
  function getProviderSessionAuthorizer(): ProviderSessionAuthorizer {
    if (!authorizer) {
      authorizer = createProviderSessionAuthorizer({
        methods: { establish: methods.establish, authorize: methods.authorize },
        getConfig: getBackchannelLogoutConfig,
        logger,
      });
    }
    return authorizer;
  }

  async function preloadBackchannelLogoutConfig(): Promise<void> {
    try {
      await getBackchannelLogoutConfig();
    } catch (error) {
      logger.error('[ProviderSession] Startup preload of openidBackchannelLogout config failed', {
        error,
      });
    }
  }

  function getProviderSessionClient(): { issuer: string; clientId: string } | null {
    const clientId = process.env.OPENID_CLIENT_ID;
    if (!clientId) {
      return null;
    }

    let openidClient: OpenIdIssuerSource;
    try {
      openidClient = getOpenIdClient();
    } catch {
      return null;
    }

    const issuer = getOpenIdIssuer(openidClient);
    return issuer ? { issuer, clientId } : null;
  }

  function revokeProviderSession(
    data: ProviderSessionOperationData,
  ): Promise<ProviderSessionRevokeResult> {
    return methods.revoke(data);
  }

  const providerSessionAuthorizer: ProviderSessionAuthorizer = {
    establish: (input) => getProviderSessionAuthorizer().establish(input),
    authorize: (input) => getProviderSessionAuthorizer().authorize(input),
    preCheck: (input) => getProviderSessionAuthorizer().preCheck(input),
    getMode: () => getProviderSessionAuthorizer().getMode(),
  };

  return {
    getProviderSessionAuthorizer,
    getBackchannelLogoutConfig,
    preloadBackchannelLogoutConfig,
    getProviderSessionClient,
    revokeProviderSession,
    providerSessionAuthorizer,
  };
}
