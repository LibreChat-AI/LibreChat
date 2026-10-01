import { randomBytes } from 'crypto';
import { logger } from '@librechat/data-schemas';
import { OAuthMetadataSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import { TokenExchangeMethodEnum, type MCPOptions } from 'librechat-data-provider';
import {
  checkResourceAllowed,
  resourceUrlFromServerUrl,
} from '@modelcontextprotocol/sdk/shared/auth-utils.js';
import {
  registerClient,
  startAuthorization,
  exchangeAuthorization,
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport';
import type { TokenMethods } from '@librechat/data-schemas';
import type {
  OAuthClientInformation,
  OAuthProtectedResourceMetadata,
  OAuthStoredClientMetadata,
  OAuthClientSource,
  MCPOAuthFlowMetadata,
  MCPOAuthTokens,
  OAuthMetadata,
} from './types';
import type { FlowStateManager } from '~/flow/manager';
import type { FlowState } from '~/flow/types';
import {
  resolveTokenEndpointAuthMethod,
  getForcedTokenEndpointAuthMethod,
  selectRegistrationAuthMethod,
  inferClientAuthMethod,
} from './methods';
import { isSSRFTarget, resolveHostnameSSRF, isOAuthUrlAllowed } from '~/auth';
import { MCPTokenStorage, MCPTokenRefreshUnavailableError } from './tokens';
import { probeResourceMetadataHint } from './resourceHint';
import { createHardenedOAuthFetch } from './hardenedFetch';
import { sanitizeUrlForLogging } from '~/mcp/utils';
import { getOAuthUrlPort } from './url';

/** Type for the OAuth metadata from the SDK */
type SDKOAuthMetadata = Parameters<typeof registerClient>[1]['metadata'];

type OAuthDiscoveryResult = {
  metadata: OAuthMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
  authServerUrl: URL;
};

type OAuthResourceDiscoveryResult = {
  resourceMetadata?: OAuthProtectedResourceMetadata;
  authServerUrl?: URL;
};

type PreconfiguredOAuthDiscoveryResult = {
  metadata?: OAuthMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
};

const PRECONFIGURED_DISCOVERY_TIMEOUT_MS = 5_000;
const OAUTH_REVOCATION_TIMEOUT_MS = 5_000;

export class MCPOAuthHandler {
  private static readonly FLOW_TYPE = 'mcp_oauth';

  /**
   * Creates a fetch function with custom headers injected
   */
  private static createOAuthFetch(
    headers: Record<string, string>,
    clientInfo?: OAuthClientInformation,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
    signal?: AbortSignal,
  ): FetchLike {
    const hardenedFetch = createHardenedOAuthFetch({ allowedDomains, allowedAddresses });

    return async (url: string | URL, init?: RequestInit): Promise<Response> => {
      const newHeaders = new Headers(init?.headers ?? {});
      for (const [key, value] of Object.entries(headers)) {
        newHeaders.set(key, value);
      }

      const method = (init?.method ?? 'GET').toUpperCase();
      const initBody = init?.body;
      let params: URLSearchParams | undefined;

      if (initBody instanceof URLSearchParams) {
        params = initBody;
      } else if (typeof initBody === 'string') {
        const parsed = new URLSearchParams(initBody);
        if (parsed.has('grant_type')) {
          params = parsed;
        }
      }

      /**
       * FastMCP 2.14+/MCP SDK 1.24+ token endpoints can be strict about:
       * - Content-Type (must be application/x-www-form-urlencoded)
       * - where client_id/client_secret are supplied (default_post vs basic header)
       */
      if (method === 'POST' && params?.has('grant_type')) {
        newHeaders.set('Content-Type', 'application/x-www-form-urlencoded');

        if (clientInfo?.client_id) {
          const authMethod =
            clientInfo.token_endpoint_auth_method ??
            inferClientAuthMethod(
              newHeaders.has('Authorization'),
              params.has('client_id'),
              params.has('client_secret'),
              !!clientInfo.client_secret,
            );

          if (!clientInfo.client_secret || authMethod === 'none') {
            newHeaders.delete('Authorization');
            if (!params.has('client_id')) {
              params.set('client_id', clientInfo.client_id);
            }
          } else if (authMethod === 'client_secret_post') {
            newHeaders.delete('Authorization');
            if (!params.has('client_id')) {
              params.set('client_id', clientInfo.client_id);
            }
            if (!params.has('client_secret')) {
              params.set('client_secret', clientInfo.client_secret);
            }
          } else if (authMethod === 'client_secret_basic') {
            /** RFC 6749 §2.3.1: credentials MUST NOT appear in both the header and the body. The SDK defaults to body params, so remove them before setting the Basic header. */
            params.delete('client_id');
            params.delete('client_secret');
            if (!newHeaders.has('Authorization')) {
              const clientAuth = Buffer.from(
                `${clientInfo.client_id}:${clientInfo.client_secret}`,
              ).toString('base64');
              newHeaders.set('Authorization', `Basic ${clientAuth}`);
            }
          }
        }

        return hardenedFetch(url, {
          ...init,
          body: params.toString(),
          headers: newHeaders,
          signal: init?.signal ?? signal,
        });
      }
      return hardenedFetch(url, {
        ...init,
        headers: newHeaders,
        signal: init?.signal ?? signal,
      });
    };
  }

  /**
   * Discovers OAuth metadata from the server
   */
  private static async discoverMetadata(
    serverUrl: string,
    oauthHeaders: Record<string, string>,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
    signal?: AbortSignal,
  ): Promise<OAuthDiscoveryResult> {
    logger.debug(
      `[MCPOAuth] discoverMetadata called with serverUrl: ${sanitizeUrlForLogging(serverUrl)}`,
    );

    const fetchFn = this.createOAuthFetch(
      oauthHeaders,
      undefined,
      allowedDomains,
      allowedAddresses,
      signal,
    );

    const resourceDiscovery = await this.discoverResourceMetadata(
      serverUrl,
      fetchFn,
      allowedDomains,
      allowedAddresses,
    );
    const resourceMetadata = resourceDiscovery.resourceMetadata;
    const authServerUrl = resourceDiscovery.authServerUrl ?? new URL(serverUrl);
    const metadata = await this.discoverAuthorizationMetadata(
      authServerUrl,
      fetchFn,
      allowedDomains,
      allowedAddresses,
    );

    if (metadata) {
      return { metadata, resourceMetadata, authServerUrl };
    }

    /**
     * No metadata discovered - create fallback metadata using default OAuth endpoint paths.
     * This mirrors the MCP SDK's behavior where it falls back to /authorize, /token, /register
     * when metadata discovery fails (e.g., servers without .well-known endpoints).
     * See: https://github.com/modelcontextprotocol/sdk/blob/main/src/client/auth.ts
     */
    logger.warn(
      `[MCPOAuth] No OAuth metadata discovered from ${sanitizeUrlForLogging(authServerUrl)}, using legacy fallback endpoints`,
    );

    const fallbackMetadata: OAuthMetadata = {
      issuer: authServerUrl.toString(),
      authorization_endpoint: new URL('/authorize', authServerUrl).toString(),
      token_endpoint: new URL('/token', authServerUrl).toString(),
      registration_endpoint: new URL('/register', authServerUrl).toString(),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256', 'plain'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    };

    logger.debug(`[MCPOAuth] Using fallback metadata:`, fallbackMetadata);
    return {
      metadata: fallbackMetadata,
      resourceMetadata,
      authServerUrl,
    };
  }

  private static async discoverResourceMetadata(
    serverUrl: string,
    fetchFn: FetchLike,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<OAuthResourceDiscoveryResult> {
    let resourceMetadata: OAuthProtectedResourceMetadata | undefined;

    /**
     * RFC 9728 §5.1: when the server's 401 `WWW-Authenticate` header advertises a
     * `resource_metadata` URL, use that URL as the authoritative source. Path-aware
     * `.well-known` discovery is a fallback for when the hint is absent — not the
     * other way round — or a split deployment can serve stale/wrong metadata at the
     * path-aware endpoint and strand the flow at a defunct authorization server.
     *
     * Reuse the caller's `fetchFn` so discovery shares its hardened transport and timeout.
     * Auto-discovery callers may attach gateway headers, while pre-configured discovery
     * deliberately uses a headerless fetch because these URLs are not trusted yet.
     */
    const hint = await probeResourceMetadataHint(serverUrl, fetchFn);
    /**
     * The hint URL is attacker-controlled (it comes from the MCP server's own 401
     * challenge). Validate it through the same SSRF/allowedDomains gate used for the
     * authorization server — otherwise a malicious server could redirect discovery at
     * a private IP, the metadata service, or a host the admin never intended to reach.
     * On validation failure, discard the hint and fall back to path-aware discovery.
     */
    let hintUrl: URL | undefined;
    if (hint?.resourceMetadataUrl) {
      try {
        await this.validateOAuthUrl(
          hint.resourceMetadataUrl.toString(),
          'resource_metadata',
          allowedDomains,
          allowedAddresses,
        );
        hintUrl = hint.resourceMetadataUrl;
        logger.debug(
          `[MCPOAuth] Using resource_metadata URL from WWW-Authenticate: ${sanitizeUrlForLogging(hintUrl.toString())}`,
        );
      } catch (error) {
        logger.warn(
          `[MCPOAuth] Rejecting untrusted resource_metadata hint from ${sanitizeUrlForLogging(serverUrl)}; falling back to path-aware discovery`,
          { error },
        );
      }
    }

    try {
      logger.debug(
        `[MCPOAuth] Attempting to discover protected resource metadata from ${sanitizeUrlForLogging(serverUrl)}`,
      );
      resourceMetadata = await discoverOAuthProtectedResourceMetadata(
        serverUrl,
        { resourceMetadataUrl: hintUrl },
        fetchFn,
      );
    } catch (error) {
      logger.debug('[MCPOAuth] Resource metadata discovery failed, continuing with server URL', {
        error,
      });
    }

    if (resourceMetadata) {
      /**
       * RFC 9728 §3.3 / §7.3: the `resource` identifier in a Protected Resource Metadata
       * document MUST match the URL the client used to fetch it. Without this check a
       * malicious MCP server can impersonate a legitimate one by advertising the real
       * server's resource URL plus the real server's authorization server, causing tokens
       * minted for the real server to be sent to the attacker (GHSA-gvpj-vm2f-2m23).
       * On mismatch, discard the entire document: `authorization_servers` and any other
       * field on it are equally untrustworthy.
       */
      this.assertResourceBoundToServer(serverUrl, resourceMetadata);

      if (resourceMetadata.authorization_servers?.length) {
        const discoveredAuthServer = resourceMetadata.authorization_servers[0];
        await this.validateOAuthUrl(
          discoveredAuthServer,
          'authorization_server',
          allowedDomains,
          allowedAddresses,
        );
        const authServerUrl = new URL(discoveredAuthServer);
        logger.debug(
          `[MCPOAuth] Found authorization server from resource metadata: ${authServerUrl}`,
        );
        return { resourceMetadata, authServerUrl };
      } else {
        logger.debug(`[MCPOAuth] No authorization servers found in resource metadata`);
      }
    }

    return { resourceMetadata };
  }

  private static async discoverAuthorizationMetadata(
    authServerUrl: URL,
    fetchFn: FetchLike,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<OAuthMetadata | undefined> {
    logger.debug(
      `[MCPOAuth] Discovering OAuth metadata from ${sanitizeUrlForLogging(authServerUrl)}`,
    );
    const rawMetadata = await this.discoverWithOriginFallback(authServerUrl, fetchFn);

    if (!rawMetadata) {
      return undefined;
    }

    logger.debug(`[MCPOAuth] OAuth metadata discovered successfully`);
    const metadata = await OAuthMetadataSchema.parseAsync(rawMetadata);

    const endpointChecks: Promise<void>[] = [];
    if (metadata.registration_endpoint) {
      endpointChecks.push(
        this.validateOAuthUrl(
          metadata.registration_endpoint,
          'registration_endpoint',
          allowedDomains,
          allowedAddresses,
        ),
      );
    }
    if (metadata.token_endpoint) {
      endpointChecks.push(
        this.validateOAuthUrl(
          metadata.token_endpoint,
          'token_endpoint',
          allowedDomains,
          allowedAddresses,
        ),
      );
    }
    if (endpointChecks.length > 0) {
      await Promise.all(endpointChecks);
    }

    logger.debug(`[MCPOAuth] OAuth metadata parsed successfully`);
    return metadata as unknown as OAuthMetadata;
  }

  private static discoverPreconfiguredMetadataWithTimeout(
    serverUrl: string,
    authorizationUrl: string,
    discoverCapabilities: boolean,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<PreconfiguredOAuthDiscoveryResult> {
    const controller = new AbortController();
    let partialResult: PreconfiguredOAuthDiscoveryResult = {};

    return new Promise<PreconfiguredOAuthDiscoveryResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        controller.abort();
        logger.warn(
          `[MCPOAuth] Pre-configured OAuth metadata discovery timed out after ${PRECONFIGURED_DISCOVERY_TIMEOUT_MS}ms; using available metadata and configured defaults.`,
        );
        resolve(partialResult);
      }, PRECONFIGURED_DISCOVERY_TIMEOUT_MS);

      const fetchFn = this.createOAuthFetch(
        {},
        undefined,
        allowedDomains,
        allowedAddresses,
        controller.signal,
      );

      void this.discoverResourceMetadata(serverUrl, fetchFn, allowedDomains, allowedAddresses)
        .then(async (resourceDiscovery) => {
          partialResult = { resourceMetadata: resourceDiscovery.resourceMetadata };
          if (!discoverCapabilities) {
            return partialResult;
          }

          const authServerUrl =
            resourceDiscovery.authServerUrl ?? new URL(new URL(authorizationUrl).origin);
          try {
            const metadata = await this.discoverAuthorizationMetadata(
              authServerUrl,
              fetchFn,
              allowedDomains,
              allowedAddresses,
            );
            return { ...partialResult, metadata };
          } catch (error) {
            logger.warn(
              `[MCPOAuth] Authorization server metadata discovery failed for pre-configured client; using configured endpoints and defaults`,
              { error },
            );
            return partialResult;
          }
        })
        .then(
          (result) => {
            clearTimeout(timeout);
            resolve(result);
          },
          (error) => {
            clearTimeout(timeout);
            reject(error);
          },
        );
    });
  }

  /**
   * Discovers OAuth authorization server metadata, retrying with just the origin
   * when discovery fails for a path-based URL. Shared implementation used by
   * `discoverMetadata` and both `refreshOAuthTokens` branches.
   */
  private static async discoverWithOriginFallback(
    serverUrl: URL,
    fetchFn: FetchLike,
  ): ReturnType<typeof discoverAuthorizationServerMetadata> {
    let metadata: Awaited<ReturnType<typeof discoverAuthorizationServerMetadata>>;
    try {
      metadata = await discoverAuthorizationServerMetadata(serverUrl, { fetchFn });
    } catch (err) {
      if (serverUrl.pathname === '/') {
        throw err;
      }
      const baseUrl = new URL(serverUrl.origin);
      logger.debug(
        `[MCPOAuth] Discovery threw for path URL, trying base URL: ${sanitizeUrlForLogging(baseUrl)}`,
        { error: err },
      );
      return discoverAuthorizationServerMetadata(baseUrl, { fetchFn });
    }
    if (!metadata && serverUrl.pathname !== '/') {
      const baseUrl = new URL(serverUrl.origin);
      logger.debug(
        `[MCPOAuth] Discovery failed with path, trying base URL: ${sanitizeUrlForLogging(baseUrl)}`,
      );
      return discoverAuthorizationServerMetadata(baseUrl, { fetchFn });
    }
    return metadata;
  }

  private static hasUnpinnedClientSecret(config?: MCPOptions['oauth']): boolean {
    return !!(
      config?.client_id &&
      config.client_secret &&
      (!config.authorization_url || !config.token_url)
    );
  }

  private static oauthUrlsMatch(left: string, right: string): boolean {
    try {
      return new URL(left).href === new URL(right).href;
    } catch {
      return false;
    }
  }

  public static buildStoredClientMetadata(
    metadata?: OAuthMetadata,
    resourceMetadata?: OAuthProtectedResourceMetadata,
    serverUrl?: string,
    clientSource?: OAuthClientSource,
  ): OAuthStoredClientMetadata | undefined {
    if (!metadata || !serverUrl || !clientSource) {
      return undefined;
    }
    const storedMetadata: OAuthStoredClientMetadata = {
      ...metadata,
      server_url: new URL(serverUrl).href,
      client_source: clientSource,
    };
    if (resourceMetadata?.resource) {
      storedMetadata.resource = new URL(resourceMetadata.resource).href;
    }
    return storedMetadata;
  }

  /**
   * Ensures stored tokens and client credentials are only reused with the MCP resource and
   * configured-client provenance captured by the authorization flow that created them.
   */
  public static assertStoredClientBinding(
    serverName: string,
    serverUrl: string | undefined,
    clientInfo: OAuthClientInformation | undefined,
    storedMetadata: Partial<OAuthStoredClientMetadata> | undefined,
    config?: MCPOptions['oauth'],
  ): void {
    const reauthenticate = (reason: string): never => {
      throw new Error(
        `[MCPOAuth] Stored OAuth binding for ${serverName} ${reason}; re-authentication is required.`,
      );
    };

    if (!serverUrl || !clientInfo?.client_id || !storedMetadata) {
      reauthenticate('is incomplete');
    }
    const currentServerUrl = serverUrl!;
    const stored = storedMetadata!;
    const client = clientInfo!;
    if (
      !stored.server_url ||
      !stored.token_endpoint ||
      (stored.client_source !== 'configured' && stored.client_source !== 'dynamic')
    ) {
      reauthenticate('is missing its server URL, token endpoint, or client provenance');
    }
    if (!this.oauthUrlsMatch(stored.server_url!, currentServerUrl)) {
      reauthenticate('no longer matches the current MCP server URL');
    }

    if (stored.resource) {
      this.assertResourceBoundToServer(stored.server_url!, {
        resource: stored.resource,
      });
    }

    if (stored.client_source === 'dynamic') {
      if (config?.client_id) {
        reauthenticate('was dynamically registered but the server now uses a configured client');
      }
      return;
    }

    if (
      !config?.client_id ||
      config.client_id !== client.client_id ||
      config.client_secret !== client.client_secret
    ) {
      reauthenticate('no longer matches the current configured client');
    }
    const configured = config!;
    if (
      configured.token_url &&
      !this.oauthUrlsMatch(stored.token_endpoint!, configured.token_url)
    ) {
      reauthenticate('no longer matches the current configured token endpoint');
    }

    const storedAuthMethod = client.client_secret
      ? (resolveTokenEndpointAuthMethod({
          tokenAuthMethods: stored.token_endpoint_auth_methods_supported ?? ['client_secret_basic'],
          preferredMethod: client.token_endpoint_auth_method,
        }) ?? 'client_secret_basic')
      : 'none';
    const hasConfiguredAuthPolicy =
      configured.token_exchange_method !== undefined ||
      configured.token_endpoint_auth_methods_supported !== undefined;
    let configuredAuthMethod: ReturnType<typeof inferClientAuthMethod> = client.client_secret
      ? storedAuthMethod
      : 'none';
    if (client.client_secret && hasConfiguredAuthPolicy) {
      configuredAuthMethod =
        resolveTokenEndpointAuthMethod({
          tokenExchangeMethod: configured.token_exchange_method,
          tokenAuthMethods: configured.token_endpoint_auth_methods_supported ?? [
            'client_secret_basic',
          ],
        }) ?? 'client_secret_basic';
    }
    if (storedAuthMethod !== configuredAuthMethod) {
      reauthenticate('no longer matches the current configured token authentication method');
    }
  }

  /**
   * RFC 8707 makes `resource` OPTIONAL, and authorization servers that reject it cannot
   * complete a flow that sends it — Entra ID v2.0 answers `AADSTS9010010` when `resource`
   * accompanies `scope`. Opting out suppresses the parameter without weakening the
   * RFC 9728 §3.3 binding, which {@link discoverResourceMetadata} asserts at discovery and
   * {@link completeOAuthFlow} re-asserts at token exchange regardless of this setting.
   * See `OAuthOptionsSchema.send_resource_parameter`.
   */
  private static shouldSendResourceParameter(config?: MCPOptions['oauth']): boolean {
    return config?.send_resource_parameter !== false;
  }

  /**
   * Removes a `resource` parameter that came from the authorization endpoint itself.
   * {@link startAuthorization} copies the endpoint's query string verbatim, so a `resource`
   * an admin left in `authorization_url` — or one present on a discovered endpoint —
   * survives into the generated request. Opting out has to delete it rather than merely
   * decline to add one, or the parameter still reaches the provider that rejects it and
   * the flow this option exists to repair keeps failing.
   */
  /**
   * Returns `endpoint` without its `resource` query parameter.
   *
   * The MCP SDK uses `token_endpoint` verbatim and the refresh paths post to the resolved
   * token URL as-is, so a `resource` an admin left in `token_url` — or one present on a
   * discovered token endpoint — still reaches the provider even though every place
   * LibreChat *adds* the parameter is gated. Only the outbound URL is rewritten: stored
   * metadata keeps its configured form, so {@link assertStoredClientBinding} still matches
   * and changing the option does not force re-authentication.
   */
  private static withoutResourceParameter(
    endpoint: string | URL,
    shouldSend: boolean,
    serverName: string,
  ): string | URL {
    if (shouldSend) {
      return endpoint;
    }
    try {
      const url = new URL(typeof endpoint === 'string' ? endpoint : endpoint.href);
      if (!url.searchParams.has('resource')) {
        return endpoint;
      }
      url.searchParams.delete('resource');
      logger.debug(
        `[MCPOAuth] Removed inherited resource parameter from the token endpoint for ${serverName}; disabled by send_resource_parameter`,
      );
      return typeof endpoint === 'string' ? url.href : url;
    } catch {
      /** Endpoints are validated absolute URLs; never fail a refresh over sanitization. */
      return endpoint;
    }
  }

  private static stripInheritedResourceParameter(authorizationUrl: URL, serverName: string): void {
    if (!authorizationUrl.searchParams.has('resource')) {
      return;
    }
    authorizationUrl.searchParams.delete('resource');
    logger.debug(
      `[MCPOAuth] Removed inherited resource parameter from the authorization URL for ${serverName}; disabled by send_resource_parameter`,
    );
  }

  /**
   * Whether a pending flow's captured RFC 8707 decision still matches the live config.
   *
   * {@link assertStoredClientBinding} deliberately ignores this setting so that flipping it
   * does not invalidate stored tokens. A pending flow cannot be treated the same way: its
   * authorization URL was already built with or without `resource`, so replaying it would
   * reissue exactly the request the operator just reconfigured away from. A flow initiated
   * before this field existed carries no flag and reads as "sending", which is what it did.
   */
  public static matchesResourceParameterDecision(
    flowMetadata: Pick<MCPOAuthFlowMetadata, 'sendResourceParameter'> | undefined,
    config?: MCPOptions['oauth'],
  ): boolean {
    return (
      (flowMetadata?.sendResourceParameter !== false) === this.shouldSendResourceParameter(config)
    );
  }

  private static appendResourceParameter(
    body: URLSearchParams,
    resource?: string,
    config?: MCPOptions['oauth'],
  ): void {
    if (!resource || !this.shouldSendResourceParameter(config)) {
      return;
    }
    body.set('resource', resource);
  }

  private static assertNoUnpinnedClientSecret(config?: MCPOptions['oauth']): void {
    if (config?.client_secret && !config.client_id) {
      throw new Error('[MCPOAuth] OAuth client_secret requires oauth.client_id.');
    }

    if (!this.hasUnpinnedClientSecret(config)) {
      return;
    }
    throw new Error(
      '[MCPOAuth] OAuth client_secret requires both oauth.authorization_url and oauth.token_url; refusing to use it with auto-discovered OAuth endpoints.',
    );
  }

  /**
   * Registers an OAuth client dynamically
   */
  private static async registerOAuthClient(
    serverUrl: string,
    metadata: OAuthMetadata,
    oauthHeaders: Record<string, string>,
    resourceMetadata?: OAuthProtectedResourceMetadata,
    redirectUri?: string,
    tokenExchangeMethod?: TokenExchangeMethodEnum,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<OAuthClientInformation> {
    logger.debug(
      `[MCPOAuth] Starting client registration for ${sanitizeUrlForLogging(serverUrl)}, server metadata:`,
      {
        grant_types_supported: metadata.grant_types_supported,
        response_types_supported: metadata.response_types_supported,
        token_endpoint_auth_methods_supported: metadata.token_endpoint_auth_methods_supported,
        scopes_supported: metadata.scopes_supported,
      },
    );

    /** Client metadata based on what the server supports */
    const clientMetadata = {
      client_name: 'LibreChat MCP Client',
      redirect_uris: [redirectUri || this.getDefaultRedirectUri()],
      grant_types: ['authorization_code'] as string[],
      response_types: ['code'] as string[],
      token_endpoint_auth_method: 'client_secret_basic',
      scope: undefined as string | undefined,
      logo_uri: undefined as string | undefined,
      tos_uri: undefined as string | undefined,
    };

    const supportedGrantTypes = metadata.grant_types_supported || ['authorization_code'];
    const requestedGrantTypes = ['authorization_code'];

    if (supportedGrantTypes.includes('refresh_token')) {
      requestedGrantTypes.push('refresh_token');
      logger.debug(
        `[MCPOAuth] Server ${serverUrl} supports \`refresh_token\` grant type, adding to request`,
      );
    } else {
      logger.debug(
        `[MCPOAuth] Server ${sanitizeUrlForLogging(serverUrl)} does not support \`refresh_token\` grant type`,
      );
    }
    clientMetadata.grant_types = requestedGrantTypes;

    clientMetadata.response_types = metadata.response_types_supported || ['code'];

    const selectedAuthMethod = selectRegistrationAuthMethod(
      metadata.token_endpoint_auth_methods_supported,
      tokenExchangeMethod,
    );
    if (selectedAuthMethod) {
      clientMetadata.token_endpoint_auth_method = selectedAuthMethod;
    }

    const availableScopes = resourceMetadata?.scopes_supported || metadata.scopes_supported;
    if (availableScopes) {
      clientMetadata.scope = availableScopes.join(' ');
    }

    logger.debug(
      `[MCPOAuth] Registering client for ${sanitizeUrlForLogging(serverUrl)} with metadata:`,
      clientMetadata,
    );

    const clientInfo = await registerClient(serverUrl, {
      metadata: metadata as unknown as SDKOAuthMetadata,
      clientMetadata,
      fetchFn: this.createOAuthFetch(oauthHeaders, undefined, allowedDomains, allowedAddresses),
    });

    const forcedAuthMethod = getForcedTokenEndpointAuthMethod(tokenExchangeMethod);
    if (forcedAuthMethod) {
      clientInfo.token_endpoint_auth_method = forcedAuthMethod;
    } else if (!clientInfo.token_endpoint_auth_method) {
      clientInfo.token_endpoint_auth_method = clientMetadata.token_endpoint_auth_method;
    }

    logger.debug(
      `[MCPOAuth] Client registered successfully for ${sanitizeUrlForLogging(serverUrl)}:`,
      {
        client_id: clientInfo.client_id,
        has_client_secret: !!clientInfo.client_secret,
        grant_types: clientInfo.grant_types,
        scope: clientInfo.scope,
      },
    );

    return clientInfo;
  }

  /**
   * Initiates the OAuth flow for an MCP server
   */
  static async initiateOAuthFlow(
    serverName: string,
    serverUrl: string,
    userId: string,
    oauthHeaders: Record<string, string>,
    config?: MCPOptions['oauth'],
    allowedDomains?: string[] | null,
    findToken?: TokenMethods['findToken'],
    allowedAddresses?: string[] | null,
    tenantId?: string,
  ): Promise<{ authorizationUrl: string; flowId: string; flowMetadata: MCPOAuthFlowMetadata }> {
    logger.debug(
      `[MCPOAuth] initiateOAuthFlow called for ${serverName} with URL: ${sanitizeUrlForLogging(serverUrl)}`,
    );

    const flowId = this.generateFlowId(userId, serverName, tenantId);
    const state = this.generateState();

    logger.debug(`[MCPOAuth] Generated flowId: ${flowId}, state: ${state}`);

    try {
      this.assertNoUnpinnedClientSecret(config);
      const sendResourceParameter = this.shouldSendResourceParameter(config);

      if (config?.authorization_url && config?.token_url && config?.client_id) {
        logger.debug(`[MCPOAuth] Using pre-configured OAuth settings for ${serverName}`);

        await Promise.all([
          this.validateOAuthUrl(
            config.authorization_url,
            'authorization_url',
            allowedDomains,
            allowedAddresses,
          ),
          this.validateOAuthUrl(config.token_url, 'token_url', allowedDomains, allowedAddresses),
        ]);

        let discoveredMetadata: OAuthMetadata | undefined;
        let resourceMetadata: OAuthProtectedResourceMetadata | undefined;
        const shouldDiscoverCapabilities =
          !!config.client_secret &&
          config.token_exchange_method === undefined &&
          config.token_endpoint_auth_methods_supported === undefined;

        try {
          const discovery = await this.discoverPreconfiguredMetadataWithTimeout(
            serverUrl,
            config.authorization_url,
            shouldDiscoverCapabilities,
            allowedDomains,
            allowedAddresses,
          );
          resourceMetadata = discovery.resourceMetadata;

          if (shouldDiscoverCapabilities && discovery.metadata) {
            const discoveredTokenEndpoint = discovery.metadata.token_endpoint;
            const configuredTokenEndpoint = new URL(config.token_url).href;

            /**
             * Pre-registered credentials are bound to the configured token endpoint. Metadata
             * discovery may supply capabilities for that endpoint, but must never redirect the
             * client secret to a different endpoint.
             */
            if (
              discoveredTokenEndpoint &&
              new URL(discoveredTokenEndpoint).href === configuredTokenEndpoint
            ) {
              discoveredMetadata = discovery.metadata;
              logger.debug(
                `[MCPOAuth] Using discovered OAuth capabilities with pre-configured endpoints for ${serverName}`,
              );
            } else {
              logger.warn(
                `[MCPOAuth] Ignoring discovered OAuth capabilities for ${serverName} because the token endpoint does not match the configured endpoint`,
                {
                  configuredTokenEndpoint: sanitizeUrlForLogging(configuredTokenEndpoint),
                  discoveredTokenEndpoint: discoveredTokenEndpoint
                    ? sanitizeUrlForLogging(discoveredTokenEndpoint)
                    : undefined,
                },
              );
            }
          }
        } catch (error) {
          /** Preserve compatibility with OAuth providers that do not publish metadata. */
          logger.warn(
            `[MCPOAuth] OAuth metadata discovery failed for pre-configured client ${serverName}; using configured endpoints and defaults`,
            { error },
          );
        }

        const skipCodeChallengeCheck =
          config?.skip_code_challenge_check === true ||
          process.env.MCP_SKIP_CODE_CHALLENGE_CHECK === 'true';
        let codeChallengeMethodsSupported: string[];

        if (config?.code_challenge_methods_supported !== undefined) {
          codeChallengeMethodsSupported = config.code_challenge_methods_supported;
        } else if (skipCodeChallengeCheck) {
          codeChallengeMethodsSupported = ['S256', 'plain'];
          logger.debug(
            `[MCPOAuth] Code challenge check skip enabled, forcing S256 support for ${serverName}`,
          );
        } else {
          codeChallengeMethodsSupported = discoveredMetadata?.code_challenge_methods_supported ?? [
            'S256',
            'plain',
          ];
        }

        /** Metadata based on pre-configured settings */
        let tokenEndpointAuthMethod: string;
        if (!config.client_secret) {
          tokenEndpointAuthMethod = 'none';
        } else {
          tokenEndpointAuthMethod =
            resolveTokenEndpointAuthMethod({
              tokenExchangeMethod: config.token_exchange_method,
              tokenAuthMethods:
                config.token_endpoint_auth_methods_supported ??
                discoveredMetadata?.token_endpoint_auth_methods_supported ??
                [],
            }) ?? 'client_secret_basic';
        }

        let defaultTokenAuthMethods: string[];
        if (tokenEndpointAuthMethod === 'none') {
          defaultTokenAuthMethods = ['none'];
        } else if (tokenEndpointAuthMethod === 'client_secret_post') {
          defaultTokenAuthMethods = ['client_secret_post', 'client_secret_basic'];
        } else {
          defaultTokenAuthMethods = ['client_secret_basic', 'client_secret_post'];
        }

        const metadata: OAuthMetadata = {
          authorization_endpoint: config.authorization_url,
          token_endpoint: config.token_url,
          issuer: discoveredMetadata?.issuer ?? serverUrl,
          scopes_supported: config.scope?.split(' ') ?? discoveredMetadata?.scopes_supported ?? [],
          grant_types_supported: config?.grant_types_supported ??
            discoveredMetadata?.grant_types_supported ?? ['authorization_code', 'refresh_token'],
          token_endpoint_auth_methods_supported:
            config?.token_endpoint_auth_methods_supported ??
            discoveredMetadata?.token_endpoint_auth_methods_supported ??
            defaultTokenAuthMethods,
          response_types_supported: config?.response_types_supported ??
            discoveredMetadata?.response_types_supported ?? ['code'],
          code_challenge_methods_supported: codeChallengeMethodsSupported,
          revocation_endpoint:
            config.revocation_endpoint ?? discoveredMetadata?.revocation_endpoint,
          revocation_endpoint_auth_methods_supported:
            config.revocation_endpoint_auth_methods_supported ??
            discoveredMetadata?.revocation_endpoint_auth_methods_supported,
        };
        logger.debug(`[MCPOAuth] metadata for "${serverName}": ${JSON.stringify(metadata)}`);
        const redirectUri = this.getDefaultRedirectUri(serverName);
        const clientInfo: OAuthClientInformation = {
          client_id: config.client_id,
          client_secret: config.client_secret,
          redirect_uris: [redirectUri],
          scope: config.scope,
          token_endpoint_auth_method: tokenEndpointAuthMethod,
        };

        logger.debug(`[MCPOAuth] Starting authorization with pre-configured settings`);
        const { authorizationUrl, codeVerifier } = await startAuthorization(serverUrl, {
          metadata: metadata as unknown as SDKOAuthMetadata,
          clientInformation: clientInfo,
          redirectUrl: redirectUri,
          scope: config.scope,
        });

        /** Add cryptographic state parameter to the authorization URL */
        authorizationUrl.searchParams.set('state', state);
        logger.debug(`[MCPOAuth] Added state parameter to authorization URL`);

        if (!sendResourceParameter) {
          this.stripInheritedResourceParameter(authorizationUrl, serverName);
          logger.debug(
            `[MCPOAuth] Omitting resource parameter from pre-configured authorization URL for ${serverName}; disabled by send_resource_parameter`,
          );
        } else if (resourceMetadata?.resource) {
          const canonicalResource = new URL(resourceMetadata.resource).href;
          authorizationUrl.searchParams.set('resource', canonicalResource);
          logger.debug(
            `[MCPOAuth] Added resource parameter to pre-configured authorization URL: ${canonicalResource}`,
          );
        }

        /**
         * Auth0/Cognito-style `audience` parameter. Forwarded as-is; the provider
         * decides whether it accepts RFC 8707 `resource`, the legacy `audience`,
         * or both. See `OAuthOptionsSchema.audience`.
         */
        if (config?.audience) {
          authorizationUrl.searchParams.set('audience', config.audience);
          logger.debug(`[MCPOAuth] Added audience parameter (pre-configured): ${config.audience}`);
        }

        const flowMetadata: MCPOAuthFlowMetadata = {
          serverName,
          userId,
          serverUrl,
          state,
          codeVerifier,
          clientInfo,
          clientSource: 'configured',
          metadata,
          resourceMetadata,
          ...(!sendResourceParameter && { sendResourceParameter: false }),
          ...(allowedDomains !== undefined && { allowedDomains }),
          ...(allowedAddresses !== undefined && { allowedAddresses }),
          ...(Object.keys(oauthHeaders).length > 0 && { oauthHeaders }),
          ...(tenantId && { tenantId }),
        };

        logger.debug(
          `[MCPOAuth] Authorization URL generated: ${sanitizeUrlForLogging(authorizationUrl.toString())}`,
        );
        return {
          authorizationUrl: authorizationUrl.toString(),
          flowId,
          flowMetadata,
        };
      }

      logger.debug(
        `[MCPOAuth] Starting auto-discovery of OAuth metadata from ${sanitizeUrlForLogging(serverUrl)}`,
      );
      const { metadata, resourceMetadata, authServerUrl } = await this.discoverMetadata(
        serverUrl,
        oauthHeaders,
        allowedDomains,
        allowedAddresses,
      );

      logger.debug(
        `[MCPOAuth] OAuth metadata discovered, auth server URL: ${sanitizeUrlForLogging(authServerUrl)}`,
      );

      const redirectUri = this.getDefaultRedirectUri(serverName);
      logger.debug(`[MCPOAuth] Resolving OAuth client with redirect URI: ${redirectUri}`);

      let clientInfo: OAuthClientInformation | undefined;
      let reusedStoredClient = false;
      let reusedClientCredentialSetId: string | undefined;
      let clientSource: OAuthClientSource = config?.client_id ? 'configured' : 'dynamic';

      if (config?.client_id) {
        logger.debug(`[MCPOAuth] Using predefined public client_id for ${serverName}`);
        clientInfo = {
          client_id: config.client_id,
          redirect_uris: [redirectUri],
          scope: config.scope,
          token_endpoint_auth_method: 'none',
        };
        logger.debug(`[MCPOAuth] Using predefined client with ID: ${clientInfo.client_id}`);
      } else if (findToken) {
        try {
          const existing = await MCPTokenStorage.getClientInfoAndMetadata({
            userId,
            serverName,
            findToken,
          });
          if (existing?.clientInfo?.client_id) {
            const storedRedirectUri = (existing.clientInfo as OAuthClientInformation)
              .redirect_uris?.[0];
            const storedIssuer =
              typeof existing.clientMetadata?.issuer === 'string'
                ? existing.clientMetadata.issuer.replace(/\/+$/, '')
                : null;
            const currentIssuer = (metadata.issuer ?? authServerUrl.toString()).replace(/\/+$/, '');
            const storedServerUrl = existing.clientMetadata?.server_url;
            const storedTokenEndpoint = existing.clientMetadata?.token_endpoint;
            const storedResource = existing.clientMetadata?.resource;
            const storedCredentialSetId = existing.clientMetadata?.credential_set_id;
            const currentResource = resourceMetadata?.resource
              ? new URL(resourceMetadata.resource).href
              : undefined;

            if (!storedRedirectUri || storedRedirectUri !== redirectUri) {
              logger.debug(
                `[MCPOAuth] Stored redirect_uri "${storedRedirectUri}" differs from current "${redirectUri}", will re-register`,
              );
            } else if (!storedIssuer || storedIssuer !== currentIssuer) {
              logger.debug(
                `[MCPOAuth] Issuer mismatch (stored: ${storedIssuer ?? 'none'}, current: ${currentIssuer}), will re-register`,
              );
            } else if (
              existing.clientMetadata?.client_source !== 'dynamic' ||
              typeof storedCredentialSetId !== 'string' ||
              storedCredentialSetId.length === 0 ||
              typeof storedServerUrl !== 'string' ||
              !this.oauthUrlsMatch(storedServerUrl, serverUrl) ||
              typeof storedTokenEndpoint !== 'string' ||
              !this.oauthUrlsMatch(storedTokenEndpoint, metadata.token_endpoint) ||
              storedResource !== currentResource
            ) {
              logger.debug(
                `[MCPOAuth] Stored client registration binding does not match the current MCP resource, will re-register`,
              );
            } else {
              logger.debug(
                `[MCPOAuth] Reusing existing client registration: ${existing.clientInfo.client_id}`,
              );
              clientInfo = existing.clientInfo;
              reusedStoredClient = true;
              reusedClientCredentialSetId = storedCredentialSetId;
              clientSource = 'dynamic';
            }
          }
        } catch (error) {
          logger.warn(
            `[MCPOAuth] Failed to look up existing client registration, falling back to new registration`,
            { error, serverName, userId },
          );
        }
      }

      if (!clientInfo) {
        logger.debug(`[MCPOAuth] Registering OAuth client with redirect URI: ${redirectUri}`);
        clientInfo = await this.registerOAuthClient(
          authServerUrl.toString(),
          metadata,
          oauthHeaders,
          resourceMetadata,
          redirectUri,
          config?.token_exchange_method,
          allowedDomains,
          allowedAddresses,
        );
        logger.debug(`[MCPOAuth] Client registered with ID: ${clientInfo.client_id}`);
      }

      /** Authorization Scope */
      const scope =
        config?.scope ||
        resourceMetadata?.scopes_supported?.join(' ') ||
        metadata.scopes_supported?.join(' ');

      logger.debug(`[MCPOAuth] Starting authorization with scope: ${scope}`);

      let authorizationUrl: URL;
      let codeVerifier: string;

      try {
        logger.debug(`[MCPOAuth] Calling startAuthorization...`);
        const authResult = await startAuthorization(serverUrl, {
          metadata: metadata as unknown as SDKOAuthMetadata,
          clientInformation: clientInfo,
          redirectUrl: redirectUri,
          scope,
        });

        authorizationUrl = authResult.authorizationUrl;
        codeVerifier = authResult.codeVerifier;

        logger.debug(`[MCPOAuth] startAuthorization completed successfully`);
        logger.debug(
          `[MCPOAuth] Authorization URL: ${sanitizeUrlForLogging(authorizationUrl.toString())}`,
        );

        /** Add cryptographic state parameter to the authorization URL */
        authorizationUrl.searchParams.set('state', state);
        logger.debug(`[MCPOAuth] Added state parameter to authorization URL`);

        if (!sendResourceParameter) {
          this.stripInheritedResourceParameter(authorizationUrl, serverName);
          logger.debug(
            `[MCPOAuth] Omitting resource parameter from authorization URL for ${serverName}; disabled by send_resource_parameter`,
          );
        } else if (resourceMetadata?.resource) {
          /**
           * `resource` was already canonicalized and bound to `serverUrl` inside
           * {@link discoverMetadata} via {@link assertResourceBoundToServer}, so `new URL`
           * here cannot throw and the value is safe to echo back to the authorization server.
           */
          const canonicalResource = new URL(resourceMetadata.resource).href;
          authorizationUrl.searchParams.set('resource', canonicalResource);
          logger.debug(
            `[MCPOAuth] Added resource parameter to authorization URL: ${canonicalResource}`,
          );
        } else {
          // resource omitted on purpose — see comment below in the `else` branch.
          /**
           * Reachable only when `discoverOAuthProtectedResourceMetadata` did not return a
           * document (404 / network error / server does not implement RFC 9728). If a PRM
           * document exists but is missing `resource`, {@link assertResourceBoundToServer}
           * rejects it before this code runs, so this branch does not warn about a
           * malformed document — it warns about the absence of one.
           */
          logger.warn(
            `[MCPOAuth] No protected resource metadata available for ${serverName}. ` +
              'This can cause issues with some Authorization Servers that expect a "resource" parameter.',
          );
        }

        /**
         * Auth0/Cognito-style `audience` parameter. Independent of `resource` (RFC 8707):
         * some authorization servers ignore `resource` and only mint API-scoped tokens
         * when `audience` is supplied. See `OAuthOptionsSchema.audience`.
         */
        if (config?.audience) {
          authorizationUrl.searchParams.set('audience', config.audience);
          logger.debug(`[MCPOAuth] Added audience parameter (discovered flow): ${config.audience}`);
        }
      } catch (error) {
        logger.error(`[MCPOAuth] startAuthorization failed:`, error);
        throw error;
      }

      const flowMetadata: MCPOAuthFlowMetadata = {
        serverName,
        userId,
        serverUrl,
        state,
        codeVerifier,
        clientInfo,
        clientSource,
        metadata,
        resourceMetadata,
        ...(!sendResourceParameter && { sendResourceParameter: false }),
        ...(allowedDomains !== undefined && { allowedDomains }),
        ...(allowedAddresses !== undefined && { allowedAddresses }),
        ...(Object.keys(oauthHeaders).length > 0 && { oauthHeaders }),
        ...(reusedStoredClient && { reusedStoredClient }),
        ...(reusedClientCredentialSetId && { reusedClientCredentialSetId }),
        ...(tenantId && { tenantId }),
      };

      logger.debug(
        `[MCPOAuth] Authorization URL generated for ${serverName}: ${authorizationUrl.toString()}`,
      );

      const result = {
        authorizationUrl: authorizationUrl.toString(),
        flowId,
        flowMetadata,
      };

      logger.debug(
        `[MCPOAuth] Returning from initiateOAuthFlow with result ${flowId} for ${serverName}`,
        result,
      );
      return result;
    } catch (error) {
      logger.error('[MCPOAuth] Failed to initiate OAuth flow', { error, serverName, userId });
      throw error;
    }
  }

  /**
   * Completes the OAuth flow by exchanging the authorization code for tokens.
   *
   * The token exchange reuses the SSRF policy captured during
   * {@link initiateOAuthFlow} and enforces it again at connect time. This closes
   * DNS rebinding gaps between the preflight validation and the callback request.
   */
  static async completeOAuthFlow(
    flowId: string,
    authorizationCode: string,
    flowManager: FlowStateManager<MCPOAuthTokens>,
    oauthHeaders: Record<string, string>,
    persistBeforeComplete?: (
      tokens: MCPOAuthTokens,
      completePersistedFlow: (tokens: MCPOAuthTokens) => Promise<void>,
    ) => Promise<MCPOAuthTokens>,
    rollbackPersistedTokens?: (tokens: MCPOAuthTokens) => Promise<void>,
    expectedAttempt?: { createdAt: number; state: string },
  ): Promise<MCPOAuthTokens> {
    let observedFlowState: FlowState<MCPOAuthTokens> | null = null;
    try {
      /** Flow state which contains our metadata */
      const flowState = await flowManager.getFlowState(flowId, this.FLOW_TYPE);
      if (!flowState) {
        throw new Error('OAuth flow not found');
      }
      const currentState =
        typeof flowState.metadata?.state === 'string' ? flowState.metadata.state : '';
      if (
        expectedAttempt &&
        (flowState.createdAt !== expectedAttempt.createdAt ||
          currentState !== expectedAttempt.state)
      ) {
        throw new Error('OAuth flow attempt was replaced before token exchange');
      }
      observedFlowState = flowState;

      const flowMetadata = flowState.metadata as MCPOAuthFlowMetadata;
      if (!flowMetadata) {
        throw new Error('OAuth flow metadata not found');
      }

      const metadata = flowMetadata;
      if (!metadata.metadata || !metadata.clientInfo || !metadata.codeVerifier) {
        throw new Error('Invalid flow metadata');
      }

      let resource: URL | undefined;
      const sendResourceParameter = metadata.sendResourceParameter !== false;
      if (metadata.resourceMetadata) {
        /**
         * Defense-in-depth: re-assert the RFC 9728 §3.3 binding against the flow's stored
         * server URL. Flow state has a bounded TTL, so a flow initiated under older
         * (pre-fix) code could still be in-flight at upgrade time carrying unvalidated
         * resource metadata. Re-validating here closes that window without requiring ops
         * teams to flush flow state on deploy (GHSA-gvpj-vm2f-2m23).
         */
        this.assertResourceBoundToServer(metadata.serverUrl, metadata.resourceMetadata);
        if (!sendResourceParameter) {
          logger.debug(
            `[MCPOAuth] Omitting resource parameter from token exchange for flow ${flowId}; disabled by send_resource_parameter`,
          );
        } else if (metadata.resourceMetadata.resource) {
          resource = new URL(metadata.resourceMetadata.resource);
          logger.debug(`[MCPOAuth] Resource URL for flow ${flowId}: ${resource.toString()}`);
        }
      }

      const exchangeMetadata =
        sendResourceParameter || typeof metadata.metadata.token_endpoint !== 'string'
          ? metadata.metadata
          : {
              ...metadata.metadata,
              token_endpoint: this.withoutResourceParameter(
                metadata.metadata.token_endpoint,
                false,
                metadata.serverName,
              ) as string,
            };

      const tokens = await exchangeAuthorization(metadata.serverUrl, {
        redirectUri: metadata.clientInfo.redirect_uris?.[0] || this.getDefaultRedirectUri(),
        metadata: exchangeMetadata as unknown as SDKOAuthMetadata,
        clientInformation: metadata.clientInfo,
        codeVerifier: metadata.codeVerifier,
        authorizationCode,
        resource,
        fetchFn: this.createOAuthFetch(
          oauthHeaders,
          metadata.clientInfo,
          metadata.allowedDomains,
          metadata.allowedAddresses,
        ),
      });

      logger.debug('[MCPOAuth] Token exchange successful', {
        flowId,
        has_access_token: !!tokens.access_token,
        has_refresh_token: !!tokens.refresh_token,
        expires_in: tokens.expires_in,
        token_type: tokens.token_type,
        scope: tokens.scope,
      });

      let mcpTokens: MCPOAuthTokens = {
        ...tokens,
        credential_set_id: randomBytes(16).toString('hex'),
        obtained_at: Date.now(),
        expires_at:
          typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
            ? Date.now() + tokens.expires_in * 1000
            : undefined,
      };

      /**
       * Persist before completing the flow so waiting connection factories cannot race the
       * callback route to write the same credential generation.
       */
      const observedState = typeof metadata.state === 'string' ? metadata.state : '';
      let flowCompleted = false;
      let completionPromise: Promise<void> | undefined;
      const completePersistedFlow = async (persistedTokens: MCPOAuthTokens): Promise<void> => {
        completionPromise ??= (async () => {
          const completionResult = await flowManager.completeFlowIfCurrent(
            flowId,
            this.FLOW_TYPE,
            flowState.createdAt,
            observedState,
            persistedTokens,
          );
          if (completionResult !== 'updated') {
            throw new Error('OAuth flow was cancelled before completion');
          }
          flowCompleted = true;
        })();
        await completionPromise;
      };

      if (persistBeforeComplete) {
        mcpTokens = await persistBeforeComplete(mcpTokens, completePersistedFlow);
      }

      /** Legacy persistence callbacks complete here. Transaction-aware callbacks can settle
       *  inside their own rollback boundary by invoking `completePersistedFlow` themselves. */
      if (!flowCompleted) {
        try {
          await completePersistedFlow(mcpTokens);
        } catch (error) {
          await rollbackPersistedTokens?.(mcpTokens);
          throw error;
        }
      }

      return mcpTokens;
    } catch (error) {
      logger.error('[MCPOAuth] Failed to complete OAuth flow', { error, flowId });
      if (observedFlowState) {
        const observedMetadata = observedFlowState.metadata as MCPOAuthFlowMetadata | undefined;
        await flowManager.failFlowIfCurrent(
          flowId,
          this.FLOW_TYPE,
          observedFlowState.createdAt,
          typeof observedMetadata?.state === 'string' ? observedMetadata.state : '',
          error as Error,
        );
      }
      throw error;
    }
  }

  /**
   * Gets the OAuth flow metadata
   */
  static async getFlowState(
    flowId: string,
    flowManager: FlowStateManager<MCPOAuthTokens>,
  ): Promise<MCPOAuthFlowMetadata | null> {
    const flowState = await flowManager.getFlowState(flowId, this.FLOW_TYPE);
    if (!flowState) {
      return null;
    }
    return flowState.metadata as MCPOAuthFlowMetadata;
  }

  /**
   * Generates a flow ID for the OAuth flow
   * @returns Consistent ID so concurrent requests share the same flow
   */
  public static generateFlowId(userId: string, serverName: string, tenantId?: string): string {
    const flowId = `${userId}:${serverName}`;
    if (!tenantId) {
      return flowId;
    }
    return `tenant:${encodeURIComponent(tenantId)}:${flowId}`;
  }

  public static parseFlowId(
    flowId: string,
  ): { userId: string; serverName: string; tenantId?: string } | null {
    const parts = flowId.split(':');
    if (parts[0] === 'tenant') {
      if (parts.length < 4 || !parts[1] || !parts[2]) {
        return null;
      }
      let tenantId: string;
      try {
        tenantId = decodeURIComponent(parts[1]);
      } catch {
        return null;
      }
      const serverName = parts.slice(3).join(':');
      if (!serverName) {
        return null;
      }
      return {
        tenantId,
        userId: parts[2],
        serverName,
      };
    }

    if (parts.length < 2 || !parts[0]) {
      return null;
    }
    const serverName = parts.slice(1).join(':');
    if (!serverName) {
      return null;
    }
    return {
      userId: parts[0],
      serverName,
    };
  }

  /**
   * Token readers using typed retryable outcomes cannot share pending work with legacy readers,
   * which reconstruct every serialized failure as an untyped Error and initiate consent. Keep
   * OAuth callback IDs stable, but isolate this version of the token-read protocol in its own key.
   */
  public static generateTokenFlowId(userId: string, serverName: string, tenantId?: string): string {
    return `tokens-v2:${this.generateFlowId(userId, serverName, tenantId)}`;
  }

  /**
   * Generates a secure state parameter
   */
  private static generateState(): string {
    return randomBytes(32).toString('base64url');
  }

  /**
   * Enforces RFC 9728 §3.3 / §7.3: the `resource` identifier advertised by an OAuth
   * Protected Resource Metadata document MUST match the URL the client used to fetch
   * the document. A mismatch means the metadata is attacker-controlled (or the server
   * is badly misconfigured); per the RFC the whole document MUST be discarded, and in
   * practice we must fail the OAuth flow because `authorization_servers` on the same
   * document is also untrustworthy and was the primary theft vector in
   * GHSA-gvpj-vm2f-2m23.
   *
   * Uses the MCP SDK's own {@link checkResourceAllowed} so the semantics (same origin
   * plus configured-path-prefix) match what the SDK enforces internally via
   * {@link selectResourceURL}, a code path LibreChat does not go through.
   */
  private static assertResourceBoundToServer(
    serverUrl: string,
    resourceMetadata: OAuthProtectedResourceMetadata,
  ): void {
    if (!resourceMetadata.resource) {
      throw new Error(
        `[MCPOAuth] Protected Resource Metadata from ${sanitizeUrlForLogging(serverUrl)} is missing the required 'resource' identifier (RFC 9728 §2). Refusing OAuth flow.`,
      );
    }

    let allowed = false;
    try {
      allowed = checkResourceAllowed({
        requestedResource: resourceUrlFromServerUrl(serverUrl),
        configuredResource: resourceMetadata.resource,
      });
    } catch (error) {
      throw new Error(
        `[MCPOAuth] Unable to validate Protected Resource Metadata 'resource' for ${sanitizeUrlForLogging(serverUrl)}: ${error instanceof Error ? error.message : String(error)}.`,
      );
    }

    if (!allowed) {
      throw new Error(
        `[MCPOAuth] Protected Resource Metadata 'resource' (${sanitizeUrlForLogging(resourceMetadata.resource)}) does not match server URL (${sanitizeUrlForLogging(serverUrl)}). Refusing OAuth flow (RFC 9728 §3.3).`,
      );
    }
  }

  /**
   * Validates an OAuth URL is not targeting a private/internal address.
   * Skipped when the full URL (hostname + protocol + port) matches an admin-trusted
   * allowedDomains entry, honoring protocol/port constraints when the admin specifies them.
   *
   * SECURITY: when `allowedDomains` is configured and the URL did NOT match it
   * (i.e., we are in the SSRF fallback path because the admin's strict bound
   * rejected this URL), the address exemption must NOT broaden that bound — a
   * malicious MCP server could otherwise advertise OAuth metadata at any
   * private address the admin permitted for an unrelated purpose (e.g. a
   * self-hosted LLM). When `allowedDomains` is empty, `allowedAddresses` is
   * the only opt-in mechanism for permitting private OAuth endpoints, so it
   * is consulted normally.
   */
  private static async validateOAuthUrl(
    url: string,
    fieldName: string,
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<void> {
    if (isOAuthUrlAllowed(url, allowedDomains, allowedAddresses)) {
      return;
    }

    let hostname: string;
    let port: string;
    try {
      const parsedUrl = new URL(url);
      hostname = parsedUrl.hostname;
      port = getOAuthUrlPort(parsedUrl);
    } catch {
      throw new Error(`Invalid OAuth ${fieldName}: ${sanitizeUrlForLogging(url)}`);
    }

    const allowedDomainsActive = Array.isArray(allowedDomains) && allowedDomains.length > 0;
    const effectiveAddresses = allowedDomainsActive ? null : allowedAddresses;

    if (isSSRFTarget(hostname, effectiveAddresses, port)) {
      throw new Error(`OAuth ${fieldName} targets a blocked address`);
    }

    if (await resolveHostnameSSRF(hostname, effectiveAddresses, port)) {
      throw new Error(`OAuth ${fieldName} resolves to a private IP address`);
    }
  }

  private static readonly STATE_MAP_TYPE = 'mcp_oauth_state';

  /**
   * Stores a mapping from the opaque OAuth state parameter to the flowId.
   * This allows the callback to resolve the flowId from an unguessable state
   * value, preventing attackers from forging callback requests.
   */
  static async storeStateMapping(
    state: string,
    flowId: string,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
  ): Promise<void> {
    await flowManager.initFlow(state, this.STATE_MAP_TYPE, { flowId });
  }

  /**
   * Resolves an opaque OAuth state parameter back to the original flowId.
   * Returns null if the state is not found (expired or never stored).
   */
  static async resolveStateToFlowId(
    state: string,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
  ): Promise<string | null> {
    const mapping = await flowManager.getFlowState(state, this.STATE_MAP_TYPE);
    return (mapping?.metadata?.flowId as string) ?? null;
  }

  /**
   * Deletes an orphaned state mapping when a flow is replaced.
   * Prevents old authorization URLs from resolving after a flow restart.
   * Returns `false` when the underlying store rejected the delete.
   */
  static async deleteStateMapping(
    state: string,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
  ): Promise<boolean> {
    return flowManager.deleteFlow(state, this.STATE_MAP_TYPE);
  }

  /** Fails one observed OAuth attempt and makes its callback state unusable. */
  static async failFlowAndDeleteStateMapping(
    flowId: string,
    flowState: FlowState<MCPOAuthTokens | null>,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
    error: Error | string,
  ): Promise<void> {
    const metadata = flowState.metadata as MCPOAuthFlowMetadata;
    const state = typeof metadata.state === 'string' ? metadata.state : '';
    await flowManager.failFlowIfCurrent(flowId, this.FLOW_TYPE, flowState.createdAt, state, error);
    if (state) {
      const mappingDeleted = await this.deleteStateMapping(state, flowManager);
      if (!mappingDeleted) {
        const mapping = await flowManager.getFlowState(state, this.STATE_MAP_TYPE);
        if (mapping) {
          throw new Error(`Failed to delete OAuth state mapping for ${flowId}`);
        }
      }
    }
  }

  /**
   * Deletes an OAuth flow together with its state mapping, for teardown paths
   * that don't already hold the flow (e.g. server uninstall). The flow is
   * guarded by the observed attempt identity so stale teardown cannot remove
   * a concurrently created replacement. The old opaque mapping remains safe
   * to delete because every attempt receives a distinct state value.
   */
  static async deleteFlowAndStateMapping(
    flowId: string,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
  ): Promise<void> {
    const flowState = await flowManager.getFlowState(flowId, this.FLOW_TYPE);
    if (!flowState) {
      return;
    }
    const metadata = flowState.metadata as MCPOAuthFlowMetadata | undefined;
    const state = typeof metadata?.state === 'string' ? metadata.state : '';
    const flowResult = await flowManager.deleteFlowIfCurrent(
      flowId,
      this.FLOW_TYPE,
      flowState.createdAt,
      state,
    );
    const mappingDeleted = state ? await this.deleteStateMapping(state, flowManager) : true;

    if (flowResult === 'missing' || !mappingDeleted) {
      throw new Error(
        `Failed to fully delete OAuth flow ${flowId} (flow result: ${flowResult}, state mapping deleted: ${mappingDeleted})`,
      );
    }
  }

  /**
   * Gets the default redirect URI for a server
   */
  private static getDefaultRedirectUri(serverName?: string): string {
    const baseUrl = process.env.DOMAIN_SERVER || 'http://localhost:3080';
    return serverName
      ? `${baseUrl}/api/mcp/${serverName}/oauth/callback`
      : `${baseUrl}/api/mcp/oauth/callback`;
  }

  /**
   * Processes and logs a token refresh response from an OAuth server.
   * Normalizes the response to MCPOAuthTokens format and logs debug info about refresh token rotation.
   */
  private static processRefreshResponse(
    tokens: Record<string, unknown>,
    serverName: string,
    source: string,
  ): MCPOAuthTokens {
    const hasNewRefreshToken = !!tokens.refresh_token;

    logger.debug(`[MCPOAuth] Token refresh response (${source})`, {
      serverName,
      has_new_access_token: !!tokens.access_token,
      has_new_refresh_token: hasNewRefreshToken,
      refresh_token_rotated: hasNewRefreshToken,
      expires_in: tokens.expires_in,
    });

    if (!hasNewRefreshToken) {
      logger.debug(
        `[MCPOAuth] OAuth server did not return new refresh_token for ${serverName} - existing refresh token remains valid (normal for non-rotating providers)`,
      );
    }

    return {
      ...tokens,
      obtained_at: Date.now(),
      expires_at:
        typeof tokens.expires_in === 'number' && Number.isFinite(tokens.expires_in)
          ? Date.now() + tokens.expires_in * 1000
          : undefined,
    } as MCPOAuthTokens;
  }

  /** HTTP outage/rate-limit status is authoritative, even if a proxy body names a bad grant. */
  private static async assertRefreshEndpointAvailable(
    response: Response,
    serverName: string,
  ): Promise<void> {
    if (!(response.status === 408 || response.status === 429 || response.status >= 500)) {
      return;
    }
    // Do not feed an outage body into the legacy invalid_client/invalid_grant message classifiers,
    // or log provider-controlled text that may contain credentials. No automatic redemption retry.
    await response.body?.cancel().catch(() => undefined);
    throw new MCPTokenRefreshUnavailableError(
      serverName,
      new Error(`Token refresh temporarily unavailable (HTTP ${response.status})`),
    );
  }

  /**
   * Posts a `refresh_token` grant, transparently retrying without the `scope`
   * parameter when — and only when — the authorization server rejects the request
   * because of that parameter.
   *
   * RFC 6749 §6 makes `scope` optional on refresh (the server reuses the originally
   * granted scope when it is omitted). LibreChat sends it by default because some
   * servers expect it, but others — notably Salesforce — reject any `scope` on the
   * refresh grant with HTTP 400 "scope parameter not supported". A failed refresh
   * forces a full re-authentication, which on multi-replica deployments amplifies the
   * PKCE retry storm, so we recover automatically instead of surfacing the failure.
   */
  private static async postRefreshRequest(
    oauthFetch: ReturnType<typeof createHardenedOAuthFetch>,
    tokenUrl: string | URL,
    headers: HeadersInit,
    body: URLSearchParams,
    serverName: string,
    signal?: AbortSignal,
    config?: MCPOptions['oauth'],
  ): Promise<Response> {
    tokenUrl = this.withoutResourceParameter(
      tokenUrl,
      this.shouldSendResourceParameter(config),
      serverName,
    );
    const response = await oauthFetch(tokenUrl, { method: 'POST', headers, body, signal });
    await this.assertRefreshEndpointAvailable(response, serverName);
    if (response.ok || !body.has('scope')) {
      return response;
    }

    /** Body is consumed here, so this branch must either retry or throw — never fall through. */
    const errorText = await response.text();
    if (!this.isScopeParameterRejection(response.status, errorText)) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
      );
    }

    logger.warn(
      `[MCPOAuth] ${serverName} rejected the scope parameter on token refresh (HTTP ${response.status}); retrying without scope per RFC 6749 §6`,
    );
    body.delete('scope');
    const retried = await oauthFetch(tokenUrl, { method: 'POST', headers, body, signal });
    await this.assertRefreshEndpointAvailable(retried, serverName);
    return retried;
  }

  /**
   * Narrowly detects "this server does not accept a `scope` parameter on the refresh
   * grant" so the retry-without-scope fallback can never mask unrelated refresh
   * failures (e.g. `invalid_grant` for an expired/revoked refresh token). Matches the
   * RFC 6749 `invalid_scope` error and Salesforce's "scope parameter not supported".
   */
  private static isScopeParameterRejection(status: number, body: string): boolean {
    if (status < 400 || status >= 500) {
      return false;
    }
    const lower = body.toLowerCase();
    if (!lower.includes('scope')) {
      return false;
    }
    return (
      lower.includes('invalid_scope') ||
      lower.includes('not supported') ||
      lower.includes('unsupported') ||
      lower.includes('not allowed')
    );
  }

  /**
   * Refreshes OAuth tokens using a refresh token
   */
  static async refreshOAuthTokens(
    refreshToken: string,
    metadata: {
      serverName: string;
      serverUrl?: string;
      clientInfo?: OAuthClientInformation;
      storedTokenEndpoint?: string;
      storedAuthMethods?: string[];
      storedServerUrl?: string;
      clientSource?: OAuthClientSource;
      resource?: string;
    },
    oauthHeaders: Record<string, string>,
    config?: MCPOptions['oauth'],
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
    signal?: AbortSignal,
  ): Promise<MCPOAuthTokens> {
    logger.debug(`[MCPOAuth] Refreshing tokens for ${metadata.serverName}`);

    try {
      /** If we have stored client information from the original flow, use that first */
      if (metadata.clientInfo?.client_id) {
        logger.debug(
          `[MCPOAuth] Using stored client information for token refresh for ${metadata.serverName}`,
        );
        logger.debug(
          `[MCPOAuth] Client ID: ${metadata.clientInfo.client_id} for ${metadata.serverName}`,
        );
        logger.debug(
          `[MCPOAuth] Has client secret: ${!!metadata.clientInfo.client_secret} for ${metadata.serverName}`,
        );
        logger.debug(`[MCPOAuth] Stored client info for ${metadata.serverName}:`, {
          client_id: metadata.clientInfo.client_id,
          has_client_secret: !!metadata.clientInfo.client_secret,
          grant_types: metadata.clientInfo.grant_types,
          scope: metadata.clientInfo.scope,
        });

        let tokenUrl: string;
        let authMethods: string[] | undefined;
        const hasStoredClientSecret = !!metadata.clientInfo.client_secret;
        const hasStoredBinding =
          metadata.storedServerUrl !== undefined || metadata.clientSource !== undefined;
        if (hasStoredBinding) {
          this.assertStoredClientBinding(
            metadata.serverName,
            metadata.serverUrl,
            metadata.clientInfo,
            {
              token_endpoint: metadata.storedTokenEndpoint ?? '',
              token_endpoint_auth_methods_supported: metadata.storedAuthMethods,
              server_url: metadata.storedServerUrl ?? '',
              client_source: metadata.clientSource,
              resource: metadata.resource,
            },
            config,
          );
          await this.validateOAuthUrl(
            metadata.storedTokenEndpoint!,
            'token_url',
            allowedDomains,
            allowedAddresses,
          );
          tokenUrl = metadata.storedTokenEndpoint!;
          authMethods = metadata.storedAuthMethods;
        } else if (metadata.storedTokenEndpoint) {
          /**
           * Keep direct, non-storage callers compatible while still pinning every supplied
           * token endpoint. MCPTokenStorage requires the full binding before invoking this path.
           */
          if (
            hasStoredClientSecret &&
            config?.client_id &&
            (metadata.clientInfo.client_id !== config.client_id ||
              metadata.clientInfo.client_secret !== config.client_secret ||
              (config.token_url &&
                !this.oauthUrlsMatch(metadata.storedTokenEndpoint, config.token_url)))
          ) {
            throw new Error(
              '[MCPOAuth] Stored OAuth client binding no longer matches current OAuth client configuration; re-authentication is required.',
            );
          }
          await this.validateOAuthUrl(
            metadata.storedTokenEndpoint,
            'token_url',
            allowedDomains,
            allowedAddresses,
          );
          tokenUrl = metadata.storedTokenEndpoint;
          authMethods = metadata.storedAuthMethods;
        } else if (hasStoredClientSecret) {
          throw new Error(
            '[MCPOAuth] Stored OAuth client_secret is missing its bound token endpoint; re-authentication is required.',
          );
        } else if (config?.token_url) {
          await this.validateOAuthUrl(
            config.token_url,
            'token_url',
            allowedDomains,
            allowedAddresses,
          );
          tokenUrl = config.token_url;
          authMethods = config.token_endpoint_auth_methods_supported;
        } else if (!metadata.serverUrl) {
          throw new Error('No token URL available for refresh');
        } else {
          if (
            this.hasUnpinnedClientSecret(config) &&
            metadata.clientInfo.client_id === config?.client_id &&
            metadata.clientInfo.client_secret === config.client_secret
          ) {
            throw new Error(
              '[MCPOAuth] Stored OAuth client_secret from unpinned configuration cannot be used with auto-discovered token endpoints. Configure oauth.token_url or re-authenticate without oauth.client_secret.',
            );
          }

          /** Auto-discover OAuth configuration for refresh */
          const serverUrl = new URL(metadata.serverUrl);
          const fetchFn = this.createOAuthFetch(
            oauthHeaders,
            undefined,
            allowedDomains,
            allowedAddresses,
            signal,
          );
          const oauthMetadata = await this.discoverWithOriginFallback(serverUrl, fetchFn);

          if (!oauthMetadata) {
            if (metadata.storedTokenEndpoint) {
              tokenUrl = metadata.storedTokenEndpoint;
              authMethods = metadata.storedAuthMethods;
            } else {
              /**
               * Do NOT fall back to `new URL('/token', metadata.serverUrl)`.
               * metadata.serverUrl is the MCP resource server, which may differ from the
               * authorization server. Sending refresh tokens there leaks them to the
               * resource server operator when .well-known discovery is absent.
               */
              throw new Error('No OAuth metadata discovered for token refresh');
            }
          } else if (!oauthMetadata.token_endpoint) {
            throw new Error('No token endpoint found in OAuth metadata');
          } else {
            tokenUrl = oauthMetadata.token_endpoint;
            authMethods = oauthMetadata.token_endpoint_auth_methods_supported;
          }
          await this.validateOAuthUrl(tokenUrl, 'token_url', allowedDomains, allowedAddresses);
        }

        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });

        /** Add scope if available */
        if (metadata.clientInfo.scope) {
          body.append('scope', metadata.clientInfo.scope);
        }
        this.appendResourceParameter(body, metadata.resource, config);

        /**
         * Forward Auth0-style `audience` on refresh by default — Auth0 strips the
         * API audience from refreshed access tokens unless it is re-supplied on
         * every refresh, otherwise the next MCP call 401s once the initial token
         * expires.
         *
         * Operators with strict OAuth 2.0 token endpoints (Cognito and similar)
         * that documents refresh requests as `grant_type` + `client_id` +
         * `refresh_token` only, and that maintain the original `aud` claim on
         * refresh, can opt out by setting `forward_audience_on_refresh: false`.
         * See `OAuthOptionsSchema.forward_audience_on_refresh`.
         */
        if (config?.audience && config?.forward_audience_on_refresh !== false) {
          body.append('audience', config.audience);
          logger.debug(
            `[MCPOAuth] Added audience parameter to refresh request: ${config.audience}`,
          );
        }

        const headers: HeadersInit = {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...oauthHeaders,
        };

        /** Handle authentication based on server's advertised methods */
        if (metadata.clientInfo.client_secret) {
          /** Default to client_secret_basic if no methods specified (per RFC 8414) */
          const tokenAuthMethods = authMethods ?? ['client_secret_basic'];
          const authMethod = resolveTokenEndpointAuthMethod({
            tokenExchangeMethod: hasStoredClientSecret ? undefined : config?.token_exchange_method,
            tokenAuthMethods,
            preferredMethod: metadata.clientInfo.token_endpoint_auth_method,
          });

          if (authMethod === 'client_secret_basic') {
            logger.debug('[MCPOAuth] Using client_secret_basic authentication method');
            const clientAuth = Buffer.from(
              `${metadata.clientInfo.client_id}:${metadata.clientInfo.client_secret}`,
            ).toString('base64');
            headers['Authorization'] = `Basic ${clientAuth}`;
          } else if (authMethod === 'client_secret_post') {
            logger.debug('[MCPOAuth] Using client_secret_post authentication method');
            body.append('client_id', metadata.clientInfo.client_id);
            body.append('client_secret', metadata.clientInfo.client_secret);
          } else {
            logger.debug('[MCPOAuth] No recognized auth method, defaulting to client_secret_basic');
            const clientAuth = Buffer.from(
              `${metadata.clientInfo.client_id}:${metadata.clientInfo.client_secret}`,
            ).toString('base64');
            headers['Authorization'] = `Basic ${clientAuth}`;
          }
        } else {
          /** For public clients, client_id must be in the body */
          logger.debug('[MCPOAuth] Using public client authentication (no secret)');
          body.append('client_id', metadata.clientInfo.client_id);
        }

        logger.debug(`[MCPOAuth] Refresh request to: ${sanitizeUrlForLogging(tokenUrl)}`, {
          grant_type: 'refresh_token',
          has_auth_header: !!headers['Authorization'],
        });

        const oauthFetch = createHardenedOAuthFetch({ allowedDomains, allowedAddresses });
        const response = await this.postRefreshRequest(
          oauthFetch,
          tokenUrl,
          headers,
          body,
          metadata.serverName,
          signal,
          config,
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
          );
        }

        const tokens = await response.json();
        return this.processRefreshResponse(tokens, metadata.serverName, 'stored client info');
      }

      if (config?.token_url && config?.client_id) {
        logger.debug(`[MCPOAuth] Using pre-configured OAuth settings for token refresh`);

        await this.validateOAuthUrl(
          config.token_url,
          'token_url',
          allowedDomains,
          allowedAddresses,
        );
        const tokenUrl = new URL(config.token_url);

        const body = new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        });

        if (config.scope) {
          body.append('scope', config.scope);
        }
        this.appendResourceParameter(body, metadata.resource, config);

        const headers: HeadersInit = {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          ...oauthHeaders,
        };

        /** Handle authentication based on configured methods */
        if (config.client_secret) {
          /** Default to client_secret_basic if no methods specified (per RFC 8414) */
          const tokenAuthMethods = config.token_endpoint_auth_methods_supported ?? [
            'client_secret_basic',
          ];
          const authMethod = resolveTokenEndpointAuthMethod({
            tokenExchangeMethod: config.token_exchange_method,
            tokenAuthMethods,
          });

          if (authMethod === 'client_secret_basic') {
            logger.debug(
              '[MCPOAuth] Using client_secret_basic authentication method (pre-configured)',
            );
            const clientAuth = Buffer.from(`${config.client_id}:${config.client_secret}`).toString(
              'base64',
            );
            headers['Authorization'] = `Basic ${clientAuth}`;
          } else if (authMethod === 'client_secret_post') {
            logger.debug(
              '[MCPOAuth] Using client_secret_post authentication method (pre-configured)',
            );
            body.append('client_id', config.client_id);
            body.append('client_secret', config.client_secret);
          } else {
            logger.debug(
              '[MCPOAuth] No recognized auth method, defaulting to client_secret_basic (pre-configured)',
            );
            const clientAuth = Buffer.from(`${config.client_id}:${config.client_secret}`).toString(
              'base64',
            );
            headers['Authorization'] = `Basic ${clientAuth}`;
          }
        } else {
          /** For public clients, client_id must be in the body */
          logger.debug('[MCPOAuth] Using public client authentication (no secret, pre-configured)');
          body.append('client_id', config.client_id);
        }

        const oauthFetch = createHardenedOAuthFetch({ allowedDomains, allowedAddresses });
        const response = await this.postRefreshRequest(
          oauthFetch,
          tokenUrl,
          headers,
          body,
          metadata.serverName,
          signal,
          config,
        );

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(
            `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
          );
        }

        const tokens = await response.json();
        return this.processRefreshResponse(tokens, metadata.serverName, 'pre-configured OAuth');
      }

      /** For auto-discovered OAuth, we need the server URL */
      if (!metadata.serverUrl) {
        throw new Error('Server URL required for auto-discovered OAuth token refresh');
      }

      /** Auto-discover OAuth configuration for refresh */
      const serverUrl = new URL(metadata.serverUrl);
      const fetchFn = this.createOAuthFetch(
        oauthHeaders,
        undefined,
        allowedDomains,
        allowedAddresses,
        signal,
      );
      const oauthMetadata = await this.discoverWithOriginFallback(serverUrl, fetchFn);

      let tokenUrl: URL;
      if (!oauthMetadata) {
        if (metadata.storedTokenEndpoint) {
          tokenUrl = new URL(metadata.storedTokenEndpoint);
        } else {
          // Same rationale as the stored-clientInfo branch above: never fall back
          // to metadata.serverUrl which is the MCP resource server, not the auth server.
          throw new Error('No OAuth metadata discovered for token refresh');
        }
      } else if (!oauthMetadata.token_endpoint) {
        throw new Error('No token endpoint found in OAuth metadata');
      } else {
        tokenUrl = new URL(oauthMetadata.token_endpoint);
      }
      await this.validateOAuthUrl(tokenUrl.href, 'token_url', allowedDomains, allowedAddresses);

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });
      this.appendResourceParameter(body, metadata.resource, config);

      const headers: HeadersInit = {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        ...oauthHeaders,
      };

      const oauthFetch = createHardenedOAuthFetch({ allowedDomains, allowedAddresses });
      const response = await oauthFetch(
        this.withoutResourceParameter(
          tokenUrl,
          this.shouldSendResourceParameter(config),
          metadata.serverName,
        ),
        {
          method: 'POST',
          headers,
          body,
          signal,
        },
      );

      await this.assertRefreshEndpointAvailable(response, metadata.serverName);
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(
          `Token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
        );
      }

      const tokens = await response.json();
      return this.processRefreshResponse(tokens, metadata.serverName, 'auto-discovered OAuth');
    } catch (error) {
      logger.error(`[MCPOAuth] Failed to refresh tokens for ${metadata.serverName}`, error);
      throw error;
    }
  }

  /**
   * Revokes OAuth tokens at the authorization server (RFC 7009)
   */
  public static async revokeOAuthToken(
    serverName: string,
    token: string,
    tokenType: 'refresh' | 'access',
    metadata: {
      serverUrl: string;
      clientId: string;
      clientSecret: string;
      revocationEndpoint?: string;
      revocationEndpointAuthMethodsSupported?: string[];
    },
    oauthHeaders: Record<string, string> = {},
    allowedDomains?: string[] | null,
    allowedAddresses?: string[] | null,
  ): Promise<void> {
    const revokeUrl: URL =
      metadata.revocationEndpoint != null
        ? new URL(metadata.revocationEndpoint)
        : new URL('/revoke', metadata.serverUrl);
    await this.validateOAuthUrl(
      revokeUrl.href,
      'revocation_endpoint',
      allowedDomains,
      allowedAddresses,
    );

    const authMethods = metadata.revocationEndpointAuthMethodsSupported ?? ['client_secret_basic'];
    const authMethod = resolveTokenEndpointAuthMethod({ tokenAuthMethods: authMethods });

    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      ...oauthHeaders,
    };

    const body = new URLSearchParams({ token });
    body.set('token_type_hint', tokenType === 'refresh' ? 'refresh_token' : 'access_token');

    if (authMethod === 'client_secret_basic') {
      const credentials = Buffer.from(`${metadata.clientId}:${metadata.clientSecret}`).toString(
        'base64',
      );
      headers['Authorization'] = `Basic ${credentials}`;
    } else if (authMethod === 'client_secret_post') {
      body.set('client_secret', metadata.clientSecret);
      body.set('client_id', metadata.clientId);
    }

    // perform the revoke request
    logger.info(
      `[MCPOAuth] Revoking tokens for ${serverName} via ${sanitizeUrlForLogging(revokeUrl.toString())}`,
    );
    const oauthFetch = createHardenedOAuthFetch({ allowedDomains, allowedAddresses });
    const response = await oauthFetch(revokeUrl, {
      method: 'POST',
      body: body.toString(),
      headers,
      signal: AbortSignal.timeout(OAUTH_REVOCATION_TIMEOUT_MS),
    });

    if (!response.ok) {
      logger.error(`[MCPOAuth] Token revocation failed for ${serverName}: HTTP ${response.status}`);
      throw new Error(`Token revocation failed: HTTP ${response.status}`);
    }
  }
}
