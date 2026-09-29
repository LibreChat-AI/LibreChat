import { createHash } from 'crypto';
import { logger, getTenantId, tenantStorage } from '@librechat/data-schemas';
import type { OAuthClientInformation } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { TokenMethods, TenantContext } from '@librechat/data-schemas';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type {
  MCPOAuthTokens,
  OAuthMetadata,
  MCPOAuthFlowMetadata,
  OAuthProtectedResourceMetadata,
  OAuthStoredClientMetadata,
  OAuthClientSource,
} from '~/mcp/oauth';
import type {
  OboTokenResolver,
  OboTrustChecker,
  UpstreamTokenProvider,
  UpstreamTokenProviderResolver,
} from '~/mcp/oauth/obo';
import type { AuthIdentityContext } from '~/utils/identity';
import type { FlowStateManager } from '~/flow/manager';
import type * as t from './types';
import {
  MCPTokenStorage,
  MCPTokenRefreshUnavailableError,
  MCPTokenStorageUnavailableError,
  MCPOAuthHandler,
  getMCPServerGeneration,
  getMCPOAuthLeaseId,
  OboTokenResolutionError,
  ReauthenticationRequiredError,
  resolveOboToken,
} from '~/mcp/oauth';
import {
  isOAuthServer,
  waitUntilDeadline,
  applyRequestHeaders,
  isClientRejectionMessage,
  createDeadlineAbortSignal,
  toCatalogConnectionConfig,
} from './utils';
import {
  isDirectOpenIDBearerRecoveryEnabled,
  resolveDirectOpenIDBearerConfig,
  usesDirectOpenIDBearerRecovery,
} from './openid';
import {
  isOAuthAuthenticationError,
  isMCPTransportAuthenticationError,
  MCPAuthenticationRejectedError,
} from './errors';
import { PENDING_STALE_MS, FlowStateNotFoundError, normalizeExpiresAt } from '~/flow/manager';
import { createLazyOboUpstreamTokenProvider, awaitOboOperation } from '~/mcp/oauth/obo';
import { preProcessGraphTokens } from '~/utils/graph';
import { isAbortError } from '~/utils/errors';
import { MCPConnection } from './connection';
import { processMCPEnv } from '~/utils';
import { mcpConfig } from './mcpConfig';

export interface ToolDiscoveryResult {
  tools: Tool[] | null;
  connection: MCPConnection | null;
  oauthRequired: boolean;
  oauthUrl: string | null;
  authenticationError?: unknown;
}

type OAuthRequiredEvent = {
  serverUrl?: string;
  error?: unknown;
  status?: number;
  statusCode?: number;
  skipSilentRefresh?: boolean;
  rejectedCredentialSetId?: string | null;
};

type OAuthRecoveryPhase = 'silent-refresh' | 'interactive' | 'terminal';

/**
 * Factory for creating MCP connections with optional OAuth authentication.
 * Handles OAuth flows, token management, and connection retry logic.
 * NOTE: Much of the OAuth logic was extracted from the old MCPManager class as is.
 */
export class MCPConnectionFactory {
  protected readonly serverName: string;
  protected readonly serverConfig: t.MCPOptions;
  /** Unresolved definition used for lifecycle fencing across request-specific substitutions. */
  protected readonly serverDefinition: t.MCPOptions;
  protected readonly logPrefix: string;
  protected readonly useOAuth: boolean;
  protected readonly useSSRFProtection: boolean;
  protected readonly allowedDomains?: string[] | null;
  protected readonly allowedAddresses?: string[] | null;
  protected readonly ephemeralConnection: boolean;
  protected readonly directBearerRecoveryEnabled: boolean;

  // OAuth-related properties (only set when useOAuth is true)
  protected readonly userId?: string;
  protected readonly user?: t.OAuthConnectionOptions['user'];
  protected readonly flowManager?: FlowStateManager<MCPOAuthTokens | null>;
  protected readonly tokenMethods?: TokenMethods;
  protected signal?: AbortSignal;
  protected oauthStart?: t.OAuthStartHandler;
  protected oauthEnd?: () => Promise<void>;
  protected returnOnOAuth?: boolean;
  protected readonly connectionTimeout?: number;
  protected readonly deadlineMs?: number;
  protected readonly onOAuthCredentialsChanged?: t.UserConnectionContext['onOAuthCredentialsChanged'];
  protected readonly onOAuthCredentialsChanging?: t.UserConnectionContext['onOAuthCredentialsChanging'];
  protected readonly onDiscoveryDetached?: t.UserConnectionContext['onDiscoveryDetached'];
  protected readonly onOAuthCredentialsAdopted?: t.UserConnectionContext['onOAuthCredentialsAdopted'];
  protected readonly onOAuthCredentialsInvalidated?: t.UserConnectionContext['onOAuthCredentialsInvalidated'];
  protected readonly oboTokenResolver?: OboTokenResolver;
  protected readonly oboTrustChecker?: OboTrustChecker;
  protected upstreamTokenProvider?: UpstreamTokenProvider;
  protected upstreamTokenProviderResolver?: UpstreamTokenProviderResolver;
  protected readonly oboIdentityContext?: AuthIdentityContext;
  /** Why the OBO re-exchange failed, when that is more actionable than the server's 401. */
  private oboRefreshError?: Error;
  private connectionReady = false;
  /**
   * Snapshot of the tenant context at factory construction time. Captured eagerly
   * because the OAuth handler runs later inside an EventEmitter callback,
   * outside the original request's async context - `getTenantId()` called
   * from the listener would return the wrong tenant (or none at all).
   */
  protected readonly tenantId?: string;
  protected readonly tenantContext?: TenantContext;

  /**
   * Process-local in-flight silent refresh promises, keyed by
   * `tenantId:userId:serverName:bindingDigest`. Coalesces concurrent `attemptSilentTokenRefresh`
   * calls within this process so a single refresh-token redemption serves every
   * waiter in the same tenant — important when multiple connections (or repeated
   * 401s) race the same refresh and the OAuth provider rotates refresh tokens.
   * The map only holds in-flight promises (no result caching), so each new 401
   * after the previous attempt resolves triggers a fresh redemption.
   *
   * NOTE: `MCPTokenStorage.forceRefreshTokens` additionally single-flights the
   * refresh-token redemption itself, covering the `mcp_get_tokens` and
   * reconnect paths that bypass this map. Both locks are process-local; the
   * cross-worker race is an inherent limitation and tracked separately.
   */
  private static inflightSilentRefreshes = new Map<string, Promise<MCPOAuthTokens | null>>();

  /**
   * Silent refresh is a best-effort optimization before interactive OAuth.
   * Keep the cap short so a stalled refresh still leaves most of the factory
   * connect budget for OAuth discovery, registration, and `oauthStart`.
   */
  private static readonly SILENT_REFRESH_TIMEOUT_MS = 5_000;
  private static readonly SILENT_REFRESH_ABORT_GRACE_MS = 1_000;

  /** Creates a new MCP connection with optional OAuth support */
  static async create(
    basic: t.BasicConnectionOptions,
    oauth?: t.OAuthConnectionOptions | t.UserConnectionContext,
  ): Promise<MCPConnection> {
    /** Chat-time entry point: the operator's `requestHeaders` join `headers`
     *  here, ahead of direct-bearer detection and Graph preprocessing, so an
     *  `Authorization` or `{{LIBRECHAT_GRAPH_*}}` template declared there gets
     *  exactly the handling it would get in `headers`. */
    const runtime: t.BasicConnectionOptions = {
      ...basic,
      serverConfig: applyRequestHeaders(basic.serverConfig),
      serverDefinition: basic.serverDefinition ?? basic.serverConfig,
    };
    const directBearerRecoveryState = runtime.directBearerRecoveryState ?? { attempted: false };
    const directBearerSourceConfig =
      runtime.directBearerSourceConfig ??
      (isDirectOpenIDBearerRecoveryEnabled(runtime.serverConfig)
        ? (runtime.serverConfig as t.ParsedServerConfig)
        : undefined);
    const create = async (candidate: t.BasicConnectionOptions): Promise<MCPConnection> => {
      const prepared = await this.prepareBasicConnectionOptions(
        { ...candidate, directBearerSourceConfig, directBearerRecoveryState },
        oauth,
      );
      if (directBearerSourceConfig && !directBearerRecoveryState.resolvedConfig) {
        directBearerRecoveryState.resolvedConfig = prepared.serverConfig;
      }
      const factory = new this(prepared, oauth);
      return factory.createConnection();
    };
    if (!directBearerSourceConfig) {
      return create(runtime);
    }

    try {
      return await create(runtime);
    } catch (error) {
      if (!isMCPTransportAuthenticationError(error) || this.isRequestCancelled(oauth)) {
        throw error;
      }
      if (directBearerRecoveryState.attempted) {
        throw new MCPAuthenticationRejectedError(basic.serverName, false, error);
      }
      directBearerRecoveryState.attempted = true;
      const refreshedConfig = await resolveDirectOpenIDBearerConfig({
        config: directBearerSourceConfig,
        upstreamTokenProvider: oauth?.upstreamTokenProvider,
        forceRefresh: true,
        signal: oauth?.signal,
      });
      directBearerRecoveryState.resolvedConfig = refreshedConfig;
      try {
        return await create({ ...runtime, serverConfig: refreshedConfig });
      } catch (refreshedError) {
        if (isMCPTransportAuthenticationError(refreshedError)) {
          throw new MCPAuthenticationRejectedError(basic.serverName, false, refreshedError);
        }
        throw refreshedError;
      }
    }
  }

  static attachRequestOAuthHandler(
    basic: t.BasicConnectionOptions,
    oauth: t.OAuthConnectionOptions,
    connection: MCPConnection,
  ): () => void {
    const factory = new this(basic, oauth);
    return factory.handleOAuthEvents(connection, 'oauthReauthenticationRequired');
  }

  /**
   * Discovers tools from an MCP server, even when OAuth is required.
   * Per MCP spec, tool listing should be possible without authentication.
   * Returns tools if discoverable, plus OAuth status for tool execution.
   */
  static async discoverTools(
    basic: t.BasicConnectionOptions,
    options?: Omit<t.OAuthConnectionOptions, 'returnOnOAuth'> | t.UserConnectionContext,
  ): Promise<ToolDiscoveryResult> {
    /** Checked before credential preparation begins: a spent budget or an already-cancelled
     *  caller must not start Graph preprocessing or token resolution it cannot cancel. */
    if (this.isRequestCancelled(options)) {
      logger.debug('[MCP] [Discovery] Cancelled or out of budget before discovery began');
      return { tools: null, connection: null, oauthRequired: false, oauthUrl: null };
    }
    const directBearerSourceConfig =
      basic.directBearerSourceConfig ??
      (usesDirectOpenIDBearerRecovery(basic.serverConfig)
        ? (basic.serverConfig as t.ParsedServerConfig)
        : undefined);
    const discover = async (candidate: t.BasicConnectionOptions): Promise<ToolDiscoveryResult> => {
      const prepared = await this.prepareBasicConnectionOptions(
        {
          ...candidate,
          /** Applied to every discovery attempt, not just the first: a config
           *  refreshed for direct-bearer recovery comes from the untouched
           *  definition and would otherwise carry the chat-only map back in. */
          serverConfig: toCatalogConnectionConfig(candidate.serverConfig),
          serverDefinition: basic.serverDefinition ?? basic.serverConfig,
          directBearerSourceConfig,
        },
        options,
      );
      if (options != null && 'useOAuth' in options) {
        const factory = new this(prepared, { ...options, returnOnOAuth: true });
        return factory.discoverToolsInternal();
      }
      const factory = new this(prepared, options);
      return factory.discoverToolsInternal();
    };

    const initial = await discover(basic);
    if (!directBearerSourceConfig || !this.hasDiscoveryAuthenticationRejection(initial)) {
      return initial;
    }

    if (initial.connection) {
      await initial.connection.dispose().catch(() => undefined);
    }
    if (this.isRequestCancelled(options)) {
      return { tools: null, connection: null, oauthRequired: false, oauthUrl: null };
    }
    const refreshedConfig = await resolveDirectOpenIDBearerConfig({
      config: directBearerSourceConfig,
      upstreamTokenProvider: options?.upstreamTokenProvider,
      forceRefresh: true,
      signal: options?.signal,
    });
    const refreshed = await discover({ ...basic, serverConfig: refreshedConfig });
    if (this.hasDiscoveryAuthenticationRejection(refreshed)) {
      if (refreshed.connection) {
        await refreshed.connection.dispose().catch(() => undefined);
      }
      throw new MCPAuthenticationRejectedError(
        basic.serverName,
        false,
        refreshed.authenticationError,
      );
    }
    return refreshed;
  }

  private static hasDiscoveryAuthenticationRejection(result: ToolDiscoveryResult): boolean {
    return result.oauthRequired || result.authenticationError != null;
  }

  private static isRequestCancelled(options?: t.UserConnectionContext): boolean {
    return (
      options?.signal?.aborted === true ||
      (options?.deadlineMs != null && Date.now() >= options.deadlineMs)
    );
  }

  /**
   * Together with the constructor's processMCPEnv pass, this mirrors
   * UserConnectionManager.resolveRuntimeConfig — keep them in sync so the
   * config validated there matches the one connected with here.
   */
  private static async prepareBasicConnectionOptions(
    basic: t.BasicConnectionOptions,
    options?: t.OAuthConnectionOptions | t.UserConnectionContext,
  ): Promise<t.BasicConnectionOptions> {
    const bearerConfig = await resolveDirectOpenIDBearerConfig({
      config: basic.serverConfig,
      upstreamTokenProvider: options?.upstreamTokenProvider,
      signal: options?.signal,
    });
    if (basic.directBearerRecoveryState && usesDirectOpenIDBearerRecovery(basic.serverConfig)) {
      basic.directBearerRecoveryState.resolvedConfig = bearerConfig;
    }
    const directBearerSourceConfig =
      basic.directBearerSourceConfig ??
      (usesDirectOpenIDBearerRecovery(basic.serverConfig)
        ? (basic.serverConfig as t.ParsedServerConfig)
        : undefined);
    const preparedBasic =
      bearerConfig === basic.serverConfig &&
      directBearerSourceConfig === basic.directBearerSourceConfig
        ? basic
        : {
            ...basic,
            serverConfig: bearerConfig,
            serverDefinition: basic.serverDefinition ?? basic.serverConfig,
            directBearerSourceConfig,
          };

    if (basic.dbSourced || !options?.graphTokenResolver) {
      return preparedBasic;
    }

    const serverConfig = await preProcessGraphTokens(preparedBasic.serverConfig, {
      user: options.user,
      graphTokenResolver: options.graphTokenResolver,
      scopes: process.env.GRAPH_API_SCOPES,
    });

    return serverConfig === preparedBasic.serverConfig
      ? preparedBasic
      : {
          ...preparedBasic,
          serverConfig,
          serverDefinition: preparedBasic.serverDefinition ?? basic.serverConfig,
        };
  }

  protected async discoverToolsInternal(): Promise<ToolDiscoveryResult> {
    /** Rechecked here because credential preparation in `discoverTools` is uncancellable: a
     *  budget that expired or a caller that cancelled while it ran must not go on to token
     *  resolution or a connect. */
    if (this.isDiscoveryCancelled()) {
      logger.debug(
        `${this.logPrefix} [Discovery] Cancelled or out of budget before discovery began`,
      );
      return { tools: null, connection: null, oauthRequired: false, oauthUrl: null };
    }
    const oauthUrl: string | null = null;
    let oauthRequired = false;
    let shouldAttemptAuthenticatedDiscovery = true;
    const abortSignal = this.createDiscoveryAbortSignal();

    let oauthTokens: MCPOAuthTokens | null = null;
    if (this.usesObo) {
      try {
        oauthTokens = await this.getOboTokens();
      } catch (error) {
        if (!(error instanceof OboTokenResolutionError)) {
          throw error;
        }
        oauthRequired = true;
        shouldAttemptAuthenticatedDiscovery = false;
        logger.debug(
          `${this.logPrefix} [Discovery] OBO token resolution failed, attempting unauthenticated tool listing`,
          error,
        );
      }
    } else if (this.useOAuth) {
      /** The token flow is shared, and a refresh inside it may already be redeemed at the provider
       *  while its rotation persists. Stop waiting when the budget ends rather than cancelling that
       *  work, so the flow still stores the new tokens for the next caller, and hand the caller the
       *  work that keeps running so it can account for it. */
      const tokenLoad = this.getOAuthTokens();
      const loaded = await waitUntilDeadline(tokenLoad, this.deadlineMs, this.signal);
      if (!loaded.settled) {
        this.onDiscoveryDetached?.(tokenLoad);
        logger.debug(
          `${this.logPrefix} [Discovery] Cancelled or out of budget while loading OAuth tokens; leaving the token flow to finish`,
        );
        return { tools: null, connection: null, oauthRequired: false, oauthUrl: null };
      }
      oauthTokens = loaded.value;
      if (!oauthTokens && !this.usesObo && isOAuthServer(this.serverConfig)) {
        oauthRequired = true;
        shouldAttemptAuthenticatedDiscovery = false;
      }
    }

    let connection: MCPConnection | null = null;
    let oauthHandler: (() => void) | null = null;
    if (shouldAttemptAuthenticatedDiscovery) {
      connection = new MCPConnection({
        serverName: this.serverName,
        serverConfig: this.serverConfig,
        userId: this.userId,
        oauthTokens,
        useSSRFProtection: this.useSSRFProtection,
        allowedAddresses: this.allowedAddresses,
        ephemeralConnection: this.ephemeralConnection,
        ...(this.directBearerRecoveryEnabled && { directBearerRecoveryEnabled: true }),
      });

      oauthHandler = () => {
        logger.info(
          `${this.logPrefix} [Discovery] OAuth required; skipping URL generation in discovery mode`,
        );
        oauthRequired = true;
        connection?.emit('oauthFailed', new Error('OAuth required during tool discovery'));
      };

      // Register unconditionally: non-OAuth servers that return 401 also emit 'oauthRequired',
      // and without this listener, connectClient()'s oauthHandledPromise hangs for 30s+.
      connection.once('oauthRequired', oauthHandler);

      try {
        await this.connectWithinBudget(connection, this.resolveConnectTimeout(30000), abortSignal);

        if (await connection.isConnected(abortSignal)) {
          const snapshot = await connection.fetchOrderedToolsSnapshot(this.deadlineMs, abortSignal);
          connection.removeListener('oauthRequired', oauthHandler);
          return {
            tools: snapshot.complete ? snapshot.tools : null,
            connection,
            oauthRequired: false,
            oauthUrl: null,
            ...(snapshot.authenticationError != null && {
              authenticationError: snapshot.authenticationError,
            }),
          };
        }
      } catch {
        MCPConnection.decrementCycleCount(this.serverName);
        logger.debug(
          `${this.logPrefix} [Discovery] Connection failed, attempting unauthenticated tool listing`,
        );
      }

      /** The authenticated attempt is done with, but abandoning `connect()` does not cancel it —
       *  that socket stays open. Dispose before the fallback opens a second one so a single
       *  discovery never holds two concurrent connects to the same server. */
      connection.removeListener('oauthRequired', oauthHandler);
      await this.disposeQuietly(connection);
      connection = null;
      oauthHandler = null;
    }

    if (this.isDiscoveryCancelled()) {
      logger.debug(
        `${this.logPrefix} [Discovery] Cancelled or out of budget; skipping unauthenticated tool listing`,
      );
      return { tools: null, connection: null, oauthRequired, oauthUrl };
    }

    try {
      const tools = await this.attemptUnauthenticatedToolListing(abortSignal);
      if (tools && tools.length > 0) {
        logger.info(
          `${this.logPrefix} [Discovery] Successfully discovered ${tools.length} tools without auth`,
        );
        return { tools, connection: null, oauthRequired, oauthUrl };
      }
      MCPConnection.decrementCycleCount(this.serverName);
    } catch {
      MCPConnection.decrementCycleCount(this.serverName);
      logger.debug(`${this.logPrefix} [Discovery] Unauthenticated tool listing failed`);
    }

    return { tools: null, connection: null, oauthRequired, oauthUrl };
  }

  /** Clamps a single `connect()` to whatever remains of the caller's overall discovery budget. */
  private resolveConnectTimeout(fallback: number): number {
    const configured = this.connectionTimeout ?? this.serverConfig.initTimeout ?? fallback;
    if (this.deadlineMs == null) {
      return configured;
    }
    return Math.max(1, Math.min(configured, this.deadlineMs - Date.now()));
  }

  private isPastDeadline(): boolean {
    return this.deadlineMs != null && Date.now() >= this.deadlineMs;
  }

  /** The ONE cancellation predicate for discovery gates. The budget and the caller's signal are
   *  two representations of the same fact; a gate that consults only one re-opens the class of
   *  bug where cancelled callers keep starting work. */
  private isDiscoveryCancelled(): boolean {
    return this.isPastDeadline() || this.signal?.aborted === true;
  }

  /**
   * Races `connect()` against the discovery signal as well as the timeout. `connect()` cannot
   * carry the signal itself, so an abort rejects this wait and the caller's normal cleanup
   * disposes the attempt — the connection's mid-connect disposal guard then discards whatever
   * the abandoned connect still constructs, instead of the socket living to the full timeout.
   */
  private async connectWithinBudget(
    connection: MCPConnection,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted === true) {
      throw new Error('Discovery cancelled before connect');
    }
    const connect = connection.connect();
    /** The abandoned attempt still settles eventually; swallow its rejection so losing the race
     *  never surfaces as an unhandled rejection. */
    connect.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Connection timeout after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref?.();
      if (signal != null) {
        onAbort = () => reject(new Error('Discovery cancelled during connect'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([connect, interrupted]);
    } finally {
      clearTimeout(timer);
      if (onAbort != null) {
        signal?.removeEventListener('abort', onAbort);
      }
    }
  }

  /**
   * One abort signal for this discovery operation: the remaining budget and the caller's own
   * cancellation, whichever fires first. It reaches only work the SDK can genuinely cancel —
   * the health probe and `tools/list` requests. Teardown is deliberately exempt: `dispose()`
   * must finish, so cancelling it would trade a bounded overrun for a leaked session.
   */
  private createDiscoveryAbortSignal(): AbortSignal | undefined {
    return createDeadlineAbortSignal(this.deadlineMs, this.signal);
  }

  private async disposeQuietly(connection: MCPConnection): Promise<void> {
    try {
      await connection.dispose();
    } catch {
      // Ignore cleanup errors
    }
  }

  protected async attemptUnauthenticatedToolListing(signal?: AbortSignal): Promise<Tool[] | null> {
    const unauthConnection = new MCPConnection({
      serverName: this.serverName,
      serverConfig: this.serverConfig,
      userId: this.userId,
      oauthTokens: null,
      useSSRFProtection: this.useSSRFProtection,
      allowedAddresses: this.allowedAddresses,
      ephemeralConnection: this.ephemeralConnection,
    });

    unauthConnection.on('oauthRequired', () => {
      logger.debug(
        `${this.logPrefix} [Discovery] Unauthenticated connection requires OAuth, failing fast`,
      );
      unauthConnection.emit(
        'oauthFailed',
        new Error('OAuth not supported in unauthenticated discovery'),
      );
    });

    try {
      await this.connectWithinBudget(unauthConnection, this.resolveConnectTimeout(15000), signal);

      if (await unauthConnection.isConnected(signal)) {
        const snapshot = await unauthConnection.fetchOrderedToolsSnapshot(this.deadlineMs, signal);
        await this.disposeQuietly(unauthConnection);
        return snapshot.complete ? snapshot.tools : null;
      }
    } catch {
      logger.debug(`${this.logPrefix} [Discovery] Unauthenticated connection attempt failed`);
    }

    await this.disposeQuietly(unauthConnection);

    return null;
  }

  protected constructor(
    basic: t.BasicConnectionOptions,
    options?: t.OAuthConnectionOptions | t.UserConnectionContext,
  ) {
    this.serverDefinition = basic.serverDefinition ?? basic.serverConfig;
    this.serverConfig = basic.skipEnvProcessing
      ? basic.serverConfig
      : processMCPEnv({
          user: options?.user,
          body: options?.requestBody,
          dbSourced: basic.dbSourced,
          options: basic.serverConfig,
          customUserVars: options?.customUserVars,
        });
    this.serverName = basic.serverName;
    this.useSSRFProtection = basic.useSSRFProtection === true;
    this.allowedDomains = basic.allowedDomains;
    this.allowedAddresses = basic.allowedAddresses;
    this.ephemeralConnection = basic.ephemeralConnection === true;
    this.directBearerRecoveryEnabled = isDirectOpenIDBearerRecoveryEnabled(
      basic.directBearerSourceConfig ?? basic.serverConfig,
    );
    this.connectionTimeout = options?.connectionTimeout;
    this.deadlineMs = options?.deadlineMs;
    this.onOAuthCredentialsChanged = options?.onOAuthCredentialsChanged;
    this.onOAuthCredentialsChanging = options?.onOAuthCredentialsChanging;
    this.onDiscoveryDetached = options?.onDiscoveryDetached;
    this.onOAuthCredentialsAdopted = options?.onOAuthCredentialsAdopted;
    this.onOAuthCredentialsInvalidated = options?.onOAuthCredentialsInvalidated;
    this.signal = options?.signal;
    this.tenantContext = tenantStorage?.getStore?.();
    this.tenantId = this.tenantContext?.tenantId ?? getTenantId();
    this.logPrefix = options?.user ? `[MCP][User: ${options.user.id}]` : '[MCP]';

    this.user = options?.user;
    this.upstreamTokenProvider = options?.upstreamTokenProvider;
    this.upstreamTokenProviderResolver = options?.upstreamTokenProviderResolver;

    if (options != null && 'useOAuth' in options) {
      this.useOAuth = true;
      this.userId = options.user?.id;
      this.flowManager = options.flowManager;
      this.tokenMethods = options.tokenMethods;
      this.oauthStart = options.oauthStart;
      this.oauthEnd = options.oauthEnd;
      this.returnOnOAuth = options.returnOnOAuth;
      this.oboTokenResolver = options.oboTokenResolver;
      this.oboTrustChecker = options.oboTrustChecker;
      this.oboIdentityContext = options.oboIdentityContext;
    } else {
      this.useOAuth = false;
    }
  }

  /**
   * Resolves OBO tokens when the server config specifies obo, returns null otherwise.
   *
   * @param forceRefresh Bypasses the OBO token cache; used when the downstream server
   * has rejected the credential we currently hold.
   */
  protected async getOboTokens(forceRefresh = false): Promise<MCPOAuthTokens | null> {
    const oboConfig = this.serverConfig.obo;
    if (!oboConfig || !this.oboTokenResolver || !this.user) {
      return null;
    }

    if (!this.upstreamTokenProvider && this.upstreamTokenProviderResolver) {
      this.upstreamTokenProvider = createLazyOboUpstreamTokenProvider(
        this.upstreamTokenProviderResolver,
        this.signal,
        { mcpServer: this.serverName, scopes: oboConfig.scopes },
      );
    }
    if (!this.upstreamTokenProvider) {
      throw new OboTokenResolutionError(
        'missing_upstream_provider',
        'No upstream credential provider is configured for this OBO MCP connection.',
      );
    }

    if (this.oboTrustChecker) {
      const config = this.serverConfig as t.ParsedServerConfig;
      const trusted = await awaitOboOperation(
        this.oboTrustChecker({
          source: config.source,
          author: config.author,
          dbId: config.dbId,
        }),
        this.signal,
      );
      if (!trusted) {
        logger.warn(
          `${this.logPrefix} OBO config not trusted (author lacks CONFIGURE_OBO permission); skipping OBO token exchange`,
        );
        return null;
      }
    }

    logger.info(`${this.logPrefix} Resolving OBO token for scopes: ${oboConfig.scopes}`);
    return awaitOboOperation(
      resolveOboToken(
        this.user,
        oboConfig,
        this.oboTokenResolver,
        this.upstreamTokenProvider,
        this.oboIdentityContext,
        forceRefresh,
      ),
      this.signal,
    );
  }

  /** Returns true if this server uses OBO instead of standard OAuth */
  protected get usesObo(): boolean {
    return !!this.serverConfig.obo && !!this.oboTokenResolver && !!this.user;
  }

  protected createOboConnectionError(error: OboTokenResolutionError): OboTokenResolutionError {
    let recoveryHint = 'Re-authenticate the user and retry.';

    if (error.retryable) {
      recoveryHint = 'Please retry.';
    } else if (error.reason === 'exchange_failed') {
      recoveryHint = 'Re-authenticate the user or verify the configured OBO scopes and retry.';
    } else if (error.reason === 'missing_upstream_provider') {
      recoveryHint = 'Configure a renewable upstream credential provider before retrying.';
    }

    return new OboTokenResolutionError(
      error.reason,
      `${error.userMessage} Unable to connect to OBO server "${this.serverName}". ${recoveryHint}`,
      error.retryable,
      error,
    );
  }

  /** Creates the base MCP connection with OAuth tokens */
  protected async createConnection(): Promise<MCPConnection> {
    let oauthTokens: MCPOAuthTokens | null = null;

    if (this.usesObo) {
      try {
        oauthTokens = await this.getOboTokens();
      } catch (error) {
        if (error instanceof OboTokenResolutionError) {
          throw this.createOboConnectionError(error);
        }
        throw error;
      }
      if (!oauthTokens) {
        throw new Error(`OBO token exchange failed for "${this.serverName}".`);
      }
    } else if (this.useOAuth) {
      oauthTokens = await this.getOAuthTokens();
    }

    const connection = new MCPConnection({
      serverName: this.serverName,
      serverConfig: this.serverConfig,
      userId: this.userId,
      oauthTokens,
      useSSRFProtection: this.useSSRFProtection,
      allowedAddresses: this.allowedAddresses,
      ephemeralConnection: this.ephemeralConnection,
      ...(this.directBearerRecoveryEnabled && {
        directBearerRecoveryEnabled: true,
      }),
    });

    let cleanupOAuthHandlers: (() => void) | null = null;
    if (this.useOAuth && !this.usesObo) {
      cleanupOAuthHandlers = this.handleOAuthEvents(connection);
    } else if (this.usesObo) {
      cleanupOAuthHandlers = this.handleOboEvents(connection);
    } else {
      const nonOAuthHandler = () => {
        logger.info(
          `${this.logPrefix} Server does not use OAuth; treating 401/403 as auth failure`,
        );
        connection.emit('oauthFailed', new Error('Server does not use OAuth'));
      };
      connection.on('oauthRequired', nonOAuthHandler);
      cleanupOAuthHandlers = () => {
        connection.removeListener('oauthRequired', nonOAuthHandler);
      };
    }

    try {
      if (this.shouldInitiateOAuthBeforeConnect(oauthTokens)) {
        await this.initiateOAuthBeforeConnect(connection);
      }
      await this.attemptToConnect(connection);
      this.connectionReady = true;
      // Keep the `oauthRequired` listener for cached-connection 401 recovery,
      // but drop request-bound callbacks and credentials from the completed request.
      this.releaseRequestScopedOAuthState();
      return connection;
    } catch (error) {
      if (cleanupOAuthHandlers) {
        cleanupOAuthHandlers();
      }
      try {
        await connection.dispose();
      } catch {
        logger.warn(`${this.logPrefix} Failed to clean up rejected MCP connection`);
      }
      if (this.oboRefreshError) {
        throw this.oboRefreshError;
      }
      throw error;
    }
  }

  private shouldInitiateOAuthBeforeConnect(oauthTokens: MCPOAuthTokens | null): boolean {
    if (!this.useOAuth || oauthTokens) {
      return false;
    }
    return isOAuthServer(this.serverConfig);
  }

  protected releaseRequestScopedOAuthState(): void {
    this.signal = undefined;
    this.oauthStart = undefined;
    this.oauthEnd = undefined;
    this.returnOnOAuth = false;
    this.upstreamTokenProvider = undefined;
    this.upstreamTokenProviderResolver = undefined;
  }

  private getServerUrl(): string | undefined {
    return 'url' in this.serverConfig ? this.serverConfig.url : undefined;
  }

  private async initiateOAuthBeforeConnect(connection: MCPConnection): Promise<void> {
    const serverUrl = this.getServerUrl();
    if (!serverUrl) {
      throw new Error(`${this.logPrefix} OAuth required but server URL is missing from config`);
    }

    const oauthTimeout = mcpConfig.OAUTH_HANDLING_TIMEOUT;
    logger.info(
      `${this.logPrefix} No stored tokens, proactively triggering OAuth flow before connecting (timeout: ${oauthTimeout}ms)`,
    );

    await new Promise<void>((resolve, reject) => {
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      let oauthHandledListener: (() => void) | null = null;
      let oauthFailedListener: ((error: Error) => void) | null = null;

      const cleanup = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
        if (oauthHandledListener) {
          connection.off('oauthHandled', oauthHandledListener);
        }
        if (oauthFailedListener) {
          connection.off('oauthFailed', oauthFailedListener);
        }
      };

      oauthHandledListener = () => {
        cleanup();
        resolve();
      };

      oauthFailedListener = (error: Error) => {
        cleanup();
        reject(error);
      };

      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Proactive OAuth flow timeout after ${oauthTimeout}ms`));
      }, oauthTimeout);

      connection.once('oauthHandled', oauthHandledListener);
      connection.once('oauthFailed', oauthFailedListener);

      const emitted = connection.emit('oauthRequired', {
        serverName: this.serverName,
        error: new Error('OAuth tokens missing before connection'),
        serverUrl,
        userId: this.userId,
        /** `getOAuthTokens` just exhausted the stored-token/refresh path; go straight to interactive OAuth */
        skipSilentRefresh: true,
      });

      if (!emitted) {
        cleanup();
        reject(new Error('OAuth required but no handler is registered'));
      }
    });
  }

  private async runWithCapturedTenant<T>(fn: () => Promise<T>): Promise<T> {
    const context = this.tenantContext ?? (this.tenantId ? { tenantId: this.tenantId } : undefined);
    if (!context || !tenantStorage?.run) {
      return fn();
    }
    return tenantStorage.run(context, fn);
  }

  private getConnectionOAuthTimeoutMs(): number {
    const factoryConnectTimeout = this.connectionTimeout ?? this.serverConfig.initTimeout ?? 30000;
    const connectionOAuthTimeout = this.serverConfig.initTimeout ?? 60000 * 2;
    return Math.min(factoryConnectTimeout, connectionOAuthTimeout);
  }

  private getSilentRefreshTimeoutMs(): number {
    const oauthTimeout = this.getConnectionOAuthTimeoutMs();
    const silentRefreshBudgetMs = Math.floor(oauthTimeout * 0.4);
    return Math.max(
      1,
      Math.min(MCPConnectionFactory.SILENT_REFRESH_TIMEOUT_MS, silentRefreshBudgetMs),
    );
  }

  private getBaseFlowId(): string {
    return MCPOAuthHandler.generateFlowId(this.userId!, this.serverName, this.tenantId);
  }

  private getTokenFlowId(): string {
    // Before activation, keep joining legacy readers: splitting their flow would permit duplicate
    // redemption while some replicas still cannot take the coordination lease.
    if (this.serverConfig.oauthRefreshCoordination !== true) return this.getBaseFlowId();
    return MCPOAuthHandler.generateTokenFlowId(this.userId!, this.serverName, this.tenantId);
  }

  private getOAuthBindingDigest(): string {
    const oauth = this.serverConfig.oauth;
    return createHash('sha256')
      .update(
        JSON.stringify([
          (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url,
          oauth?.client_id,
          oauth?.client_secret,
          oauth?.authorization_url,
          oauth?.token_url,
          oauth?.token_exchange_method,
          oauth?.token_endpoint_auth_methods_supported,
        ]),
      )
      .digest('base64url');
  }

  /**
   * Reads tokens through the shared `mcp_get_tokens` flow. A flow that disappears while this call
   * waits on it was invalidated by a credential change, so the read runs once more against the
   * changed storage instead of reporting the tokens missing and prompting for authorization again.
   */
  private async loadOAuthTokens(): Promise<MCPOAuthTokens | null> {
    const flowId = this.getTokenFlowId();
    const readTokens = () =>
      this.flowManager!.createFlowWithHandler(
        flowId,
        'mcp_get_tokens',
        async () => {
          return await this.runWithCapturedTenant(async () =>
            MCPTokenStorage.getTokens({
              userId: this.userId!,
              serverName: this.serverName,
              findToken: this.tokenMethods!.findToken!,
              createToken: this.tokenMethods!.createToken,
              updateToken: this.tokenMethods!.updateToken,
              deleteTokens: this.tokenMethods!.deleteTokens,
              refreshTokens: this.createRefreshTokensFunction(),
              singleFlightScope: this.getOAuthBindingDigest(),
              refreshWaitTimeoutMs: this.serverConfig.oauthRefreshWaitTimeout,
              coordinateRefresh: this.serverConfig.oauthRefreshCoordination,
              persistenceWaitTimeoutMs: this.serverConfig.oauthPersistenceWaitTimeout,
              flowManager: this.flowManager,
              onRefreshSuccess: (refreshed) => this.handleOAuthRefreshSuccess(refreshed),
              onRefreshPreparing: () => this.prepareOAuthRefreshSuccess(),
              onTokensAdopted: (adopted) => this.handleAdoptedCredentials(adopted),
            }),
          );
        },
        this.signal,
      );

    try {
      return await readTokens();
    } catch (error) {
      if (!(error instanceof FlowStateNotFoundError)) {
        if (
          MCPConnectionFactory.isRefreshUnavailable(error) ||
          MCPConnectionFactory.isReauthenticationRequired(error)
        ) {
          throw error;
        }
        // Legacy flow records and cache failures carry no typed outcome. Retry storage first.
        throw new MCPTokenStorageUnavailableError(this.serverName, error);
      }
      logger.info(
        `${this.logPrefix} Token flow was invalidated while waiting on it; re-reading stored tokens`,
      );
      await this.onOAuthCredentialsInvalidated?.();
      try {
        return await readTokens();
      } catch (retryError) {
        if (
          MCPConnectionFactory.isRefreshUnavailable(retryError) ||
          MCPConnectionFactory.isReauthenticationRequired(retryError)
        ) {
          throw retryError;
        }
        throw new MCPTokenStorageUnavailableError(this.serverName, retryError);
      }
    }
  }

  /** Tokens released by another party's authorization or refresh carry the generation it published. */
  private async adoptPublishedCredentials(tokens: MCPOAuthTokens): Promise<void> {
    if (!tokens.publication_generation) {
      return;
    }
    await this.onOAuthCredentialsAdopted?.(tokens.publication_generation);
  }

  /**
   * Callback completion means credentials were persisted, not that their access token is still
   * usable. Both OAuth waiters and token-flow waiters can receive that exact completed result.
   * Re-read storage once instead of installing it or misclassifying expiry as a binding failure.
   */
  private async renewExpiredFlowResult(
    tokens: MCPOAuthTokens | null,
  ): Promise<MCPOAuthTokens | null> {
    const expiry = tokens?.expires_at;
    // Match storeTokens' whole-second persistence precision, including a rounded-to-zero TTL.
    if (
      expiry == null ||
      !Number.isFinite(expiry) ||
      Math.floor((expiry - Date.now()) / 1000) > 0
    ) {
      return tokens;
    }

    this.signal?.throwIfAborted();
    const leaseId = getMCPOAuthLeaseId(this.userId!, this.serverName, this.tenantId);
    try {
      const generation = await this.flowManager!.getLeaseGeneration(leaseId);
      const lease =
        generation == null
          ? null
          : await this.flowManager!.acquireLease(leaseId, {
              expectedGeneration: generation,
              waitMs: Math.min(
                this.serverConfig.oauthPersistenceWaitTimeout ?? Infinity,
                this.getSilentRefreshTimeoutMs(),
              ),
            });
      if (!lease) {
        throw new Error('OAuth publication is not settled');
      }
      // A callback settles waiters while its rollback journal is still live. Cross its persistence
      // fence before redeeming, then RELEASE it: refresh persistence acquires this same fence.
      await lease.release();
    } catch (error) {
      throw new MCPTokenStorageUnavailableError(this.serverName, error);
    }
    this.signal?.throwIfAborted();
    await this.invalidateGetTokensFlow();
    const renewed = await this.loadOAuthTokens();
    if (renewed?.expires_at != null && Math.floor((renewed.expires_at - Date.now()) / 1000) <= 0) {
      throw new MCPTokenRefreshUnavailableError(
        this.serverName,
        new Error('Refreshed access token has no usable lifetime'),
      );
    }
    return renewed;
  }

  /** Retrieves existing OAuth tokens from storage or returns null */
  protected async getOAuthTokens(): Promise<MCPOAuthTokens | null> {
    if (!this.tokenMethods?.findToken) return null;

    try {
      const tokens = await this.renewExpiredFlowResult(await this.loadOAuthTokens());

      if (tokens) {
        const [isCurrentAccessToken, storedClient] = await this.runWithCapturedTenant(() =>
          Promise.all([
            MCPTokenStorage.isCurrentAccessToken({
              userId: this.userId!,
              serverName: this.serverName,
              accessToken: tokens.access_token,
              credentialSetId: tokens.credential_set_id,
              findToken: this.tokenMethods!.findToken!,
            }),
            MCPTokenStorage.getClientInfoAndMetadata({
              userId: this.userId!,
              serverName: this.serverName,
              findToken: this.tokenMethods!.findToken!,
            }),
          ]).catch((error: unknown) => {
            throw new MCPTokenStorageUnavailableError(this.serverName, error);
          }),
        );
        if (!isCurrentAccessToken) {
          await this.invalidateGetTokensFlow();
          throw new MCPTokenStorageUnavailableError(
            this.serverName,
            new Error('Cached OAuth access token is stale'),
          );
        }
        MCPTokenStorage.assertCredentialSetBinding(
          this.serverName,
          tokens.credential_set_id,
          storedClient?.clientMetadata,
        );
        MCPOAuthHandler.assertStoredClientBinding(
          this.serverName,
          (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url,
          storedClient?.clientInfo,
          storedClient?.clientMetadata as Partial<OAuthStoredClientMetadata> | undefined,
          this.serverConfig.oauth,
        );
        await this.adoptPublishedCredentials(tokens);
        logger.info(`${this.logPrefix} Loaded OAuth tokens`);
      }
      return tokens;
    } catch (error) {
      if (this.signal?.aborted) {
        throw error;
      }
      if (MCPConnectionFactory.isReauthenticationRequired(error)) {
        logger.info(`${this.logPrefix} Reauthentication required; triggering OAuth flow`);
        return null;
      }
      if (
        error instanceof MCPTokenStorageUnavailableError ||
        error instanceof MCPTokenRefreshUnavailableError ||
        (error instanceof Error &&
          (error.name === 'MCPTokenStorageUnavailableError' ||
            error.name === 'MCPTokenRefreshUnavailableError'))
      ) {
        logger.warn(`${this.logPrefix} OAuth token loading failed; deferring connection recovery`);
        throw error;
      }
      logger.debug(`${this.logPrefix} No existing tokens found or token loading failed`);
      return null;
    }
  }

  /** Creates a function to refresh OAuth tokens when they expire */
  protected createRefreshTokensFunction(): (
    refreshToken: string,
    metadata: {
      userId: string;
      serverName: string;
      identifier: string;
      clientInfo?: OAuthClientInformation;
      storedTokenEndpoint?: string;
      storedAuthMethods?: string[];
      storedServerUrl?: string;
      clientSource?: OAuthClientSource;
      resource?: string;
    },
    signal?: AbortSignal,
  ) => Promise<MCPOAuthTokens> {
    return async (refreshToken, metadata, signal) => {
      return await MCPOAuthHandler.refreshOAuthTokens(
        refreshToken,
        {
          serverUrl: (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url,
          serverName: metadata.serverName,
          clientInfo: metadata.clientInfo,
          storedTokenEndpoint: metadata.storedTokenEndpoint,
          storedAuthMethods: metadata.storedAuthMethods,
          storedServerUrl: metadata.storedServerUrl,
          clientSource: metadata.clientSource,
          resource: metadata.resource,
        },
        this.serverConfig.oauth_headers ?? {},
        this.serverConfig.oauth,
        this.allowedDomains,
        this.allowedAddresses,
        signal,
      );
    };
  }

  /**
   * Attempts to silently refresh OAuth tokens using the stored refresh token,
   * bypassing the local `expires_at` check. Use this when the server has
   * signaled token invalidity (a 401 emitted as `oauthRequired`) to avoid
   * forcing the user through an interactive OAuth flow when the refresh token
   * is still valid.
   *
   * Coalesces via `inflightSilentRefreshes` rather than `FlowStateManager` —
   * the latter caches the completed result for the new token's TTL, which
   * would hand back stale tokens on a subsequent 401 (e.g. when the freshly
   * minted token is revoked before its local expiry). Caching only the
   * in-flight promise means every fresh 401 after settlement triggers a
   * fresh redemption.
   */
  protected async attemptSilentTokenRefresh(
    rejectedCredentialSetId?: string | null,
  ): Promise<MCPOAuthTokens | null> {
    if (!this.tokenMethods?.findToken || !this.tokenMethods?.createToken) {
      return null;
    }

    // Scope the lock by tenant and OAuth binding so neither another tenant nor a
    // same-name server whose URL/client configuration changed can join the refresh.
    const bindingDigest = this.getOAuthBindingDigest();
    const lockKey = JSON.stringify([
      this.tenantId ?? '',
      this.userId ?? '',
      this.serverName,
      bindingDigest,
      ...(this.serverConfig.oauthRefreshCoordination === true
        ? [rejectedCredentialSetId === undefined ? ['unknown'] : ['known', rejectedCredentialSetId]]
        : []),
    ]);
    const inflight = MCPConnectionFactory.inflightSilentRefreshes.get(lockKey);
    if (inflight) {
      logger.debug(`${this.logPrefix} Joining in-flight silent refresh attempt`);
      return inflight;
    }

    const timeoutMs = this.getSilentRefreshTimeoutMs();
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let abortGraceTimeoutId: ReturnType<typeof setTimeout> | null = null;
    const refreshPromise = this.runSilentRefresh(
      abortController.signal,
      bindingDigest,
      rejectedCredentialSetId,
    );
    const promise = new Promise<MCPOAuthTokens | null>((resolve, reject) => {
      timeoutId = setTimeout(() => {
        abortController.abort();
        abortGraceTimeoutId = setTimeout(
          releaseLock,
          MCPConnectionFactory.SILENT_REFRESH_ABORT_GRACE_MS,
        );
        logger.info(
          `${this.logPrefix} Silent token refresh timed out after ${timeoutMs}ms; deferring recovery`,
        );
        reject(
          new MCPTokenRefreshUnavailableError(
            this.serverName,
            new Error('Silent refresh timed out'),
          ),
        );
      }, timeoutMs);

      refreshPromise.then(resolve, (error: unknown) => {
        /** Every joiner waits on this same contended credential, so they share the retry. */
        if (MCPConnectionFactory.isRefreshUnavailable(error)) {
          reject(error);
          return;
        }
        logger.info(
          `${this.logPrefix} Silent token refresh failed, falling back to interactive OAuth`,
        );
        resolve(null);
      });
    }).finally(() => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    });
    function releaseLock() {
      if (abortGraceTimeoutId) {
        clearTimeout(abortGraceTimeoutId);
        abortGraceTimeoutId = null;
      }
      if (MCPConnectionFactory.inflightSilentRefreshes.get(lockKey) === promise) {
        MCPConnectionFactory.inflightSilentRefreshes.delete(lockKey);
      }
    }
    MCPConnectionFactory.inflightSilentRefreshes.set(lockKey, promise);
    void refreshPromise.then(releaseLock, releaseLock);
    return await promise;
  }

  /**
   * Executes a single force-refresh attempt against the OAuth provider and
   * persists the new tokens. Called by `attemptSilentTokenRefresh` under the
   * `inflightSilentRefreshes` coalescing lock.
   */
  private async runSilentRefresh(
    signal: AbortSignal,
    singleFlightScope: string,
    rejectedCredentialSetId?: string | null,
  ): Promise<MCPOAuthTokens | null> {
    try {
      const tokens = await this.runWithCapturedTenant(async () =>
        MCPTokenStorage.forceRefreshTokens({
          userId: this.userId!,
          serverName: this.serverName,
          findToken: this.tokenMethods!.findToken!,
          createToken: this.tokenMethods!.createToken,
          updateToken: this.tokenMethods!.updateToken,
          deleteTokens: this.tokenMethods!.deleteTokens,
          refreshTokens: this.createRefreshTokensFunction(),
          singleFlightScope,
          rejectedCredentialSetId,
          refreshWaitTimeoutMs: this.serverConfig.oauthRefreshWaitTimeout,
          coordinateRefresh: this.serverConfig.oauthRefreshCoordination,
          persistenceWaitTimeoutMs: this.serverConfig.oauthPersistenceWaitTimeout,
          signal,
          /**
           * Drop any previously cached `mcp_get_tokens` result so the next
           * `getOAuthTokens` reads the freshly persisted tokens rather than the
           * now-stale flow-cached value. Attached to the shared redemption
           * (not this waiter) so a refresh that completes after this caller's
           * timeout still invalidates the cache.
           */
          onRefreshSuccess: (refreshed) => this.handleOAuthRefreshSuccess(refreshed),
          onRefreshPreparing: () => this.prepareOAuthRefreshSuccess(),
          onTokensAdopted: (adopted) => this.handleAdoptedCredentials(adopted),
          flowManager: this.flowManager,
        }),
      );

      if (tokens) {
        logger.info(`${this.logPrefix} Silent token refresh succeeded`);
      } else {
        logger.info(`${this.logPrefix} Silent token refresh returned no tokens`);
      }
      return tokens;
    } catch (error) {
      /**
       * Contention with another replica's redemption is retryable and must not read as a failed
       * refresh. Collapsing it to null sends this path to interactive OAuth, so a peer that merely
       * held the credential slightly too long would prompt the user to authorize the server again,
       * which is the outcome the cross-replica flight exists to prevent. The next request retries
       * once the peer releases, by which time its rotated credential is there to be adopted.
       */
      if (MCPConnectionFactory.isRefreshUnavailable(error)) {
        throw error;
      }
      if (error instanceof ReauthenticationRequiredError) {
        logger.info(
          `${this.logPrefix} Reauthentication required; falling back to interactive OAuth`,
        );
      } else {
        logger.info(
          `${this.logPrefix} Silent token refresh failed, falling back to interactive OAuth`,
        );
      }
      return null;
    }
  }

  /** Flow serialization preserves domain names, not class identity. */
  private static isReauthenticationRequired(error: unknown): boolean {
    return (
      error instanceof ReauthenticationRequiredError ||
      (error instanceof Error && error.name === 'ReauthenticationRequiredError')
    );
  }

  private static isRefreshUnavailable(error: unknown): boolean {
    return (
      error instanceof MCPTokenRefreshUnavailableError ||
      error instanceof MCPTokenStorageUnavailableError ||
      (error instanceof Error &&
        (error.name === 'MCPTokenRefreshUnavailableError' ||
          error.name === 'MCPTokenStorageUnavailableError'))
    );
  }

  /** Carries the peer's publication generation to every waiter without publishing it again. */
  private async handleAdoptedCredentials(adoptedTokens: MCPOAuthTokens): Promise<void> {
    const generation = await this.onOAuthCredentialsInvalidated?.();
    if (generation) {
      adoptedTokens.publication_generation = generation;
    }
    await this.invalidateGetTokensFlow(adoptedTokens, generation || undefined);
  }

  private async handleOAuthRefreshSuccess(freshTokens: MCPOAuthTokens): Promise<void> {
    if (this.userId != null) {
      await this.onOAuthCredentialsChanged?.({
        userId: this.userId,
        serverName: this.serverName,
      });
    }
    await this.invalidateGetTokensFlow(freshTokens);
  }

  private async prepareOAuthRefreshSuccess(): Promise<
    (freshTokens?: MCPOAuthTokens) => Promise<void>
  > {
    const publishPreparedMutation =
      this.userId == null
        ? undefined
        : await this.onOAuthCredentialsChanging?.({
            userId: this.userId,
            serverName: this.serverName,
          });
    return async (freshTokens) => {
      if (publishPreparedMutation != null) {
        const publicationGeneration = await publishPreparedMutation();
        await this.invalidateGetTokensFlow(freshTokens, publicationGeneration);
        return;
      }
      if (freshTokens != null) {
        await this.handleOAuthRefreshSuccess(freshTokens);
      } else {
        if (this.userId != null) {
          await this.onOAuthCredentialsChanged?.({
            userId: this.userId,
            serverName: this.serverName,
          });
        }
        await this.invalidateGetTokensFlow();
      }
    };
  }

  protected async invalidateGetTokensFlow(
    freshTokens?: MCPOAuthTokens,
    publicationGeneration?: string,
  ): Promise<void> {
    if (!this.flowManager || !this.userId) {
      return;
    }
    const flowManager = this.flowManager;
    // Both protocols remain valid cache readers across an enable/rollback transition.
    const flowIds = new Set([
      this.getBaseFlowId(),
      MCPOAuthHandler.generateTokenFlowId(this.userId, this.serverName, this.tenantId),
    ]);
    await Promise.all(
      [...flowIds].map(async (flowId) => {
        try {
          const state = await flowManager.getFlowState(flowId, 'mcp_get_tokens');
          if (!state) {
            return;
          }
          if (state.status === 'PENDING' && freshTokens) {
            await flowManager.completeFlow(
              flowId,
              'mcp_get_tokens',
              publicationGeneration
                ? { ...freshTokens, publication_generation: publicationGeneration }
                : freshTokens,
            );
            return;
          }
          if (state.status !== 'COMPLETED') {
            return;
          }
          await flowManager.deleteFlow(flowId, 'mcp_get_tokens');
        } catch {
          logger.debug(`${this.logPrefix} Failed to invalidate mcp_get_tokens cache`);
        }
      }),
    );
  }

  /**
   * Drops any cached COMPLETED `mcp_oauth` flow state so that
   * `handleOAuthRequired`'s recent-completion fast path can't re-serve the
   * tokens that the resource server just rejected.
   */
  protected async invalidateCompletedOAuthFlow(): Promise<void> {
    if (!this.flowManager || !this.userId) {
      return;
    }
    const flowId = this.getBaseFlowId();
    try {
      const existing = await this.flowManager.getFlowState(flowId, 'mcp_oauth');
      if (!existing || existing.status !== 'COMPLETED') {
        return;
      }
      const meta = existing.metadata as MCPOAuthFlowMetadata | undefined;
      if (!this.isCurrentTenantOAuthFlow(meta)) {
        logger.debug(
          `${this.logPrefix} Skipping completed mcp_oauth invalidation for a different tenant`,
        );
        return;
      }
      const oldState = meta?.state;
      await this.flowManager.deleteFlow(flowId, 'mcp_oauth');
      if (oldState) {
        await MCPOAuthHandler.deleteStateMapping(oldState, this.flowManager);
      }
    } catch {
      logger.debug(`${this.logPrefix} Failed to invalidate completed mcp_oauth cache`);
    }
  }

  private isCurrentTenantOAuthFlow(meta: MCPOAuthFlowMetadata | undefined): boolean {
    const flowTenantId = meta?.tenantId;
    if (!this.tenantId) {
      return !flowTenantId;
    }
    return flowTenantId === this.tenantId;
  }

  /**
   * A pending flow's authorization URL was already built with or without RFC 8707
   * `resource`, so replaying it after the operator changed `send_resource_parameter`
   * reissues the request they reconfigured away from.
   *
   * Deliberately separate from {@link isCurrentServerOAuthFlow}: that check also gates reuse
   * of a recent COMPLETED flow's tokens, and this setting must never invalidate tokens that
   * were already issued.
   */
  private isReplayablePendingOAuthFlow(meta: MCPOAuthFlowMetadata | undefined): boolean {
    if (!MCPOAuthHandler.matchesResourceParameterDecision(meta, this.serverConfig.oauth)) {
      logger.info(
        `${this.logPrefix} Pending OAuth flow predates a send_resource_parameter change; starting a new flow`,
      );
      return false;
    }
    return this.isCurrentServerOAuthFlow(meta);
  }

  /** Prevents server-name keyed OAuth flow cache entries from crossing config bindings. */
  private isCurrentServerOAuthFlow(meta: MCPOAuthFlowMetadata | undefined): boolean {
    const currentServerUrl = (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url;
    try {
      MCPOAuthHandler.assertStoredClientBinding(
        this.serverName,
        currentServerUrl,
        meta?.clientInfo,
        MCPOAuthHandler.buildStoredClientMetadata(
          meta?.metadata,
          meta?.resourceMetadata,
          meta?.serverUrl,
          meta?.clientSource,
        ),
        this.serverConfig.oauth,
      );
      return true;
    } catch (error) {
      logger.info(
        `${this.logPrefix} Cached OAuth flow binding is stale; starting a new flow`,
        error,
      );
      return false;
    }
  }

  private getOAuthRequiredStatusCode(data: OAuthRequiredEvent): number | undefined {
    if (typeof data.status === 'number') {
      return data.status;
    }
    if (typeof data.statusCode === 'number') {
      return data.statusCode;
    }

    const error = data.error;
    if (!error || typeof error !== 'object') {
      return undefined;
    }

    const errorLike = error as {
      code?: unknown;
      status?: unknown;
      statusCode?: unknown;
      message?: unknown;
    };
    for (const value of [errorLike.code, errorLike.status, errorLike.statusCode]) {
      if (typeof value === 'number' && Number.isInteger(value)) {
        return value;
      }
    }

    if (typeof errorLike.message === 'string') {
      const statusMatch = errorLike.message.match(/\b(4\d{2}|5\d{2})\b/);
      if (statusMatch) {
        return Number.parseInt(statusMatch[1], 10);
      }
    }

    return undefined;
  }

  private shouldAttemptSilentTokenRefresh(data: OAuthRequiredEvent): boolean {
    const statusCode = this.getOAuthRequiredStatusCode(data);
    if (statusCode === 403) {
      logger.info(
        `${this.logPrefix} OAuth server returned 403; skipping silent refresh and starting interactive OAuth`,
      );
      return false;
    }

    const error = data.error;
    if (error && typeof error === 'object' && 'message' in error) {
      const message = (error as { message?: unknown }).message;
      if (typeof message === 'string') {
        const normalized = message.toLowerCase();
        if (
          normalized.includes('insufficient_scope') ||
          normalized.includes('insufficient scope')
        ) {
          logger.info(
            `${this.logPrefix} OAuth server reported insufficient scope; skipping silent refresh`,
          );
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Whether the server rejected the tokens a silent refresh issued during this connection attempt,
   * and they are still the stored credential. A provider can keep refreshing a grant its resource
   * server no longer accepts, so refreshing again would repeat the rejection on every connect
   * attempt and never ask the user to authorize. Tokens another request stored since then are not
   * a rejected renewal; the refresh path adopts them.
   */
  private async isRejectedRenewal(
    renewed: MCPOAuthTokens,
    rejectedCredentialSetId: string | null,
  ): Promise<boolean> {
    if (!this.tokenMethods?.findToken) {
      return false;
    }
    if ((renewed.credential_set_id ?? null) !== rejectedCredentialSetId) {
      return false;
    }
    return this.runWithCapturedTenant(() =>
      MCPTokenStorage.isCurrentAccessToken({
        userId: this.userId!,
        serverName: this.serverName,
        accessToken: renewed.access_token,
        credentialSetId: renewed.credential_set_id,
        findToken: this.tokenMethods!.findToken!,
      }),
    );
  }

  private getOAuthReplayExpiresAt(createdAt?: number): number | undefined {
    if (!createdAt) {
      return undefined;
    }

    const expiresAt = createdAt + PENDING_STALE_MS;
    return expiresAt > Date.now() ? expiresAt : undefined;
  }

  /**
   * Sets up the authentication handler for an OBO connection.
   *
   * An OBO server rejecting our bearer is recoverable in a way the non-OAuth
   * fallback cannot express: the downstream credential is minted from the user's
   * live upstream session, so a fresh exchange produces a working token without
   * any interactive step. What it needs is that live session, which only exists
   * while the request that created this connection is still running. Past that
   * point `upstreamTokenProvider` closes over a finished request, so a cached
   * connection stops reconnecting instead and its next borrower rebuilds it
   * against a live provider.
   */
  protected handleOboEvents(connection: MCPConnection): () => void {
    let refreshAttempted = false;

    const oboHandler = async (): Promise<void> => {
      if (this.connectionReady) {
        logger.info(
          `${this.logPrefix} Cached OBO connection was rejected; deferring to a live request for re-exchange`,
        );
        this.abandonOboConnection(connection, new Error('OBO re-exchange requires a live request'));
        return;
      }

      if (refreshAttempted) {
        logger.warn(`${this.logPrefix} Refreshed OBO token was rejected as well`);
        this.abandonOboConnection(connection, new Error('Refreshed OBO token was rejected'));
        return;
      }
      refreshAttempted = true;

      logger.info(`${this.logPrefix} OBO token rejected by server; re-running token exchange`);
      try {
        const tokens = await this.getOboTokens(true);
        if (!tokens?.access_token) {
          throw new Error(`OBO token exchange returned no token for "${this.serverName}".`);
        }
        connection.setOAuthTokens(tokens);
        connection.setAuthorizationHeader(tokens.access_token);
        logger.info(`${this.logPrefix} OBO token re-exchanged; retrying connection`);
        connection.emit('oauthHandled');
      } catch (error) {
        if (isAbortError(error)) {
          logger.debug(`${this.logPrefix} OBO token re-exchange cancelled`);
        } else {
          logger.error(`${this.logPrefix} OBO token re-exchange failed`, error);
        }
        /**
         * `connectClient` rejects its handling promise with this error and then
         * rethrows the server's original 401, so a diagnosis like an unrefreshable
         * sign-in session would be lost. `createConnection` reads it back and
         * surfaces it in place of the generic 401 — the same substitution the
         * initial OBO resolution already makes.
         */
        this.oboRefreshError = this.toOboRefreshError(error);
        this.abandonOboConnection(connection, this.oboRefreshError);
      }
    };

    connection.on('oauthRequired', oboHandler);

    return () => {
      connection.removeListener('oauthRequired', oboHandler);
    };
  }

  private toOboRefreshError(error: unknown): Error {
    if (error instanceof OboTokenResolutionError) {
      return this.createOboConnectionError(error);
    }
    if (error instanceof Error) {
      return error;
    }
    if (isAbortError(error)) {
      return Object.assign(new Error('The operation was aborted.', { cause: error }), {
        name: 'AbortError',
      });
    }
    return new Error(`OBO token re-exchange failed for "${this.serverName}".`);
  }

  /**
   * Ends recovery for an OBO connection holding a credential nothing can replace.
   * Reconnect attempts would replay the rejected bearer through every backoff step
   * and spend the circuit breaker's cycle budget, so the connection is retired and
   * left for its next borrower to dispose and rebuild.
   */
  private abandonOboConnection(connection: MCPConnection, error: Error): void {
    connection.stopReconnecting();
    connection.emit('oauthFailed', error);
  }

  /** Sets up OAuth event handlers for the connection */
  protected handleOAuthEvents(
    connection: MCPConnection,
    eventName: 'oauthRequired' | 'oauthReauthenticationRequired' = 'oauthRequired',
  ): () => void {
    const isRequestRecovery = eventName === 'oauthReauthenticationRequired';
    let recoveryPhase: OAuthRecoveryPhase = 'silent-refresh';
    let eventHandling: Promise<void> | null = null;
    /** Tokens a silent refresh issued while this connection was being established. */
    let renewedTokens: MCPOAuthTokens | null = null;

    const handleOAuthEvent = async (data: OAuthRequiredEvent) => {
      logger.info(`${this.logPrefix} oauthRequired event received`);

      if (this.connectionReady) {
        const emitted = connection.emit('oauthReauthenticationRequired', {
          ...data,
          skipSilentRefresh: data.skipSilentRefresh,
        });
        if (emitted) {
          return;
        }
        logger.info(`${this.logPrefix} Cached connection requires a live OAuth request handler`);
        connection.emit('oauthFailed', new Error('OAuth reauthentication required'));
        return;
      }

      const rejectedCredentialSetId =
        data.rejectedCredentialSetId !== undefined
          ? data.rejectedCredentialSetId
          : connection.getOAuthCredentialSetId();
      const oauthLeaseId = getMCPOAuthLeaseId(this.userId!, this.serverName, this.tenantId);
      let oauthLeaseGeneration: number | null;
      try {
        oauthLeaseGeneration = await this.flowManager!.getLeaseGeneration(oauthLeaseId);
      } catch {
        connection.emit('oauthFailed', new Error('OAuth teardown fence unavailable'));
        return;
      }
      if (oauthLeaseGeneration === null) {
        connection.emit('oauthFailed', new Error('OAuth teardown in progress'));
        return;
      }

      if (isRequestRecovery && recoveryPhase === 'terminal') {
        logger.warn(`${this.logPrefix} OAuth recovery phase budget exhausted`);
        connection.emit('oauthFailed', new Error('OAuth recovery phase budget exhausted'));
        return;
      }

      if (!isRequestRecovery || recoveryPhase === 'silent-refresh') {
        recoveryPhase = 'interactive';
        if (
          !isRequestRecovery &&
          renewedTokens != null &&
          (await this.isRejectedRenewal(renewedTokens, rejectedCredentialSetId))
        ) {
          logger.info(
            `${this.logPrefix} Server rejected the tokens a silent refresh just issued; starting interactive OAuth`,
          );
        } else if (!data.skipSilentRefresh && this.shouldAttemptSilentTokenRefresh(data)) {
          let refreshedTokens: MCPOAuthTokens | null;
          try {
            refreshedTokens = await this.attemptSilentTokenRefresh(rejectedCredentialSetId);
          } catch (error) {
            if (!MCPConnectionFactory.isRefreshUnavailable(error)) {
              throw error;
            }
            /**
             * Another replica is redeeming this credential. Falling through would start a
             * replacement authorization while that redemption is still live, asking the user to
             * approve a server whose credential is about to be valid. Failing the connection
             * defers to the next request instead, matching how the stored-token path reports the
             * same error, and mirroring the teardown gate below in choosing not to prompt.
             */
            logger.info(
              `${this.logPrefix} Another replica is rotating this credential; deferring recovery`,
            );
            recoveryPhase = 'silent-refresh';
            connection.emit('oauthFailed', error);
            return;
          }
          if (refreshedTokens) {
            if (!isRequestRecovery) {
              renewedTokens = refreshedTokens;
            }
            connection.setOAuthTokens(refreshedTokens);
            connection.emit('oauthHandled', 'silent-refresh' satisfies t.OAuthHandledSource);
            return;
          }
        }
      }

      if (isRequestRecovery) {
        recoveryPhase = 'terminal';
      }

      /** Teardown holds this gate until its credential and flow cleanup finishes. A refresh
       * suppressed by that gate must not fall through and create a replacement OAuth flow. */
      if (
        this.userId &&
        MCPTokenStorage.isRefreshTeardownActive(this.userId, this.serverName, this.tenantId)
      ) {
        connection.emit('oauthFailed', new Error('OAuth teardown in progress'));
        return;
      }

      // Silent refresh failed and we're about to fall through to interactive
      // OAuth. Invalidate any COMPLETED `mcp_oauth` flow first so
      // `handleOAuthRequired`'s recent-completion fast path can't re-serve the
      // tokens the resource server just rejected (see the `PENDING_STALE_MS`
      // window in `handleOAuthRequired`).
      await this.invalidateCompletedOAuthFlow();

      if (this.returnOnOAuth) {
        try {
          const config = this.serverConfig;
          const flowId = this.getBaseFlowId();
          const existingFlow = await this.flowManager!.getFlowState(flowId, 'mcp_oauth');

          if (existingFlow?.status === 'PENDING') {
            const pendingAge = existingFlow.createdAt
              ? Date.now() - existingFlow.createdAt
              : Infinity;
            const flowMeta = existingFlow.metadata as MCPOAuthFlowMetadata | undefined;

            if (pendingAge < PENDING_STALE_MS && this.isReplayablePendingOAuthFlow(flowMeta)) {
              logger.debug(
                `${this.logPrefix} Recent PENDING OAuth flow exists (${Math.round(pendingAge / 1000)}s old), skipping new initiation`,
              );
              const storedAuthUrl = flowMeta?.authorizationUrl;
              if (storedAuthUrl && typeof this.oauthStart === 'function') {
                const expiresAt = this.getOAuthReplayExpiresAt(existingFlow.createdAt);
                if (!expiresAt) {
                  logger.debug(`${this.logPrefix} PENDING OAuth flow expired before replay`);
                  connection.emit(
                    'oauthFailed',
                    new Error('Pending OAuth flow expired before replay'),
                  );
                  return;
                }
                logger.info(
                  `${this.logPrefix} Re-issuing stored authorization URL while reusing PENDING flow`,
                );
                const replayLease = await this.flowManager!.acquireLease(oauthLeaseId, {
                  expectedGeneration: oauthLeaseGeneration,
                });
                if (!replayLease) {
                  connection.emit('oauthFailed', new Error('OAuth replay superseded by teardown'));
                  return;
                }
                try {
                  await this.oauthStart(storedAuthUrl, { expiresAt });
                } finally {
                  await replayLease.release();
                }
              }
              connection.emit('oauthFailed', new Error('Pending OAuth flow reused - return early'));
              return;
            }

            logger.debug(
              `${this.logPrefix} Found stale PENDING OAuth flow (${Math.round(pendingAge / 1000)}s old), will replace`,
            );
          }

          const {
            authorizationUrl,
            flowId: newFlowId,
            flowMetadata,
          } = await this.runWithCapturedTenant(() =>
            MCPOAuthHandler.initiateOAuthFlow(
              this.serverName,
              data.serverUrl || '',
              this.userId!,
              config?.oauth_headers ?? {},
              config?.oauth,
              this.allowedDomains,
              // Only reuse stored client when deleteTokens is available for stale-client cleanup
              this.tokenMethods?.deleteTokens ? this.tokenMethods.findToken : undefined,
              this.allowedAddresses,
              this.tenantId,
            ),
          );

          if (existingFlow) {
            const oldMeta = existingFlow.metadata as MCPOAuthFlowMetadata | undefined;
            const oldState = oldMeta?.state;
            await this.flowManager!.deleteFlow(flowId, 'mcp_oauth');
            if (oldState) {
              await MCPOAuthHandler.deleteStateMapping(oldState, this.flowManager!);
            }
          }

          // Store flow state BEFORE redirecting so the callback can find it
          const metadataWithUrl = {
            ...flowMetadata,
            authorizationUrl,
            tenantId: this.tenantId,
            serverGeneration: getMCPServerGeneration(this.serverDefinition as t.ParsedServerConfig),
            oauthPersistenceWaitTimeout: this.serverConfig.oauthPersistenceWaitTimeout,
          };
          const publicationLease = await this.flowManager!.acquireLease(oauthLeaseId, {
            expectedGeneration: oauthLeaseGeneration,
          });
          if (!publicationLease) {
            connection.emit('oauthFailed', new Error('OAuth initiation superseded by teardown'));
            return;
          }
          try {
            await this.flowManager!.initFlow(newFlowId, 'mcp_oauth', metadataWithUrl);
            await MCPOAuthHandler.storeStateMapping(
              flowMetadata.state,
              newFlowId,
              this.flowManager!,
            );
          } finally {
            await publicationLease.release();
          }

          // Start monitoring in background — createFlow will find the existing PENDING state
          // written by initFlow above, so metadata arg is unused (pass {} to make that explicit)
          this.waitForSharedOAuthFlow(newFlowId).catch(async (error) => {
            logger.debug(`${this.logPrefix} OAuth flow monitor ended`);
            await this.clearStaleClientIfRejected(flowMetadata.reusedClientCredentialSetId, error);
          });

          if (this.oauthStart) {
            logger.info(`${this.logPrefix} OAuth flow started, issuing authorization URL`);
            await this.oauthStart(authorizationUrl);
          }

          connection.emit('oauthFailed', new Error('OAuth flow initiated - return early'));
          return;
        } catch {
          logger.error(`${this.logPrefix} Failed to initiate OAuth flow`);
          connection.emit('oauthFailed', new Error('OAuth initiation failed'));
          return;
        }
      }

      // Normal OAuth handling - wait for completion
      const result = await this.handleOAuthRequired(oauthLeaseGeneration);

      if (result?.tokens) {
        try {
          if (
            !this.tokenMethods?.findToken ||
            typeof result.tokens.credential_set_id !== 'string' ||
            !result.tokens.credential_set_id
          ) {
            throw new ReauthenticationRequiredError(this.serverName, 'binding');
          }
          const tokens = await this.renewExpiredFlowResult(result.tokens);
          if (!tokens) {
            throw new ReauthenticationRequiredError(this.serverName, 'expired');
          }
          if (
            !this.tokenMethods?.findToken ||
            typeof tokens.credential_set_id !== 'string' ||
            tokens.credential_set_id.length === 0
          ) {
            throw new ReauthenticationRequiredError(this.serverName, 'binding');
          }

          const [isCurrentAccessToken, storedClient] = await this.runWithCapturedTenant(() =>
            Promise.all([
              MCPTokenStorage.isCurrentAccessToken({
                userId: this.userId!,
                serverName: this.serverName,
                accessToken: tokens.access_token,
                credentialSetId: tokens.credential_set_id,
                findToken: this.tokenMethods!.findToken!,
              }),
              MCPTokenStorage.getClientInfoAndMetadata({
                userId: this.userId!,
                serverName: this.serverName,
                findToken: this.tokenMethods!.findToken!,
              }),
            ]),
          );
          if (!isCurrentAccessToken || !storedClient) {
            throw new ReauthenticationRequiredError(this.serverName, 'binding');
          }
          MCPTokenStorage.assertCredentialSetBinding(
            this.serverName,
            tokens.credential_set_id,
            storedClient.clientMetadata,
          );
          MCPOAuthHandler.assertStoredClientBinding(
            this.serverName,
            (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url,
            storedClient.clientInfo,
            storedClient.clientMetadata as Partial<OAuthStoredClientMetadata> | undefined,
            this.serverConfig.oauth,
          );

          connection.setOAuthTokens(tokens);
          await this.adoptPublishedCredentials(tokens);
          // Same rationale as the silent-refresh success path: invalidate the
          // `mcp_get_tokens` cache so the next `getOAuthTokens` reads the
          // freshly stored tokens rather than the just-rejected ones the
          // interactive flow replaced.
          await this.invalidateGetTokensFlow(tokens);
          logger.info(`${this.logPrefix} Verified OAuth callback tokens in storage`);
        } catch (error) {
          logger.error(`${this.logPrefix} Failed to verify OAuth callback tokens`);
          connection.emit(
            'oauthFailed',
            error instanceof Error ? error : new Error('OAuth token verification failed'),
          );
          return;
        }
      }

      // Only emit oauthHandled if we actually got tokens (OAuth succeeded)
      if (result?.tokens) {
        connection.emit('oauthHandled', 'interactive' satisfies t.OAuthHandledSource);
      } else {
        await this.clearStaleClientIfRejected(result?.reusedClientCredentialSetId, result?.error);
        logger.warn(`${this.logPrefix} OAuth failed, emitting oauthFailed event`);
        connection.emit('oauthFailed', new Error('OAuth authentication failed'));
      }
    };

    const oauthHandler = (data: OAuthRequiredEvent): Promise<void> => {
      if (!isRequestRecovery) {
        return handleOAuthEvent(data);
      }
      if (eventHandling) {
        return eventHandling;
      }

      const handling = handleOAuthEvent(data).finally(() => {
        if (eventHandling === handling) {
          eventHandling = null;
        }
      });
      eventHandling = handling;
      return handling;
    };

    connection.on(eventName, oauthHandler);

    return () => {
      connection.removeListener(eventName, oauthHandler);
    };
  }

  /** Attempts to establish connection with timeout handling */
  protected async attemptToConnect(connection: MCPConnection): Promise<void> {
    this.signal?.throwIfAborted();
    const baseTimeout = this.connectionTimeout ?? this.serverConfig.initTimeout ?? 30000;
    // OAuth servers may pause mid-connect to wait for the user to authorize in the browser.
    // The transport connect itself is still bounded by initTimeout inside connection.connect(),
    // so this floor only extends the window for an active OAuth wait, not ordinary failures.
    // The grace covers the reconnect after `oauthHandled` (retry backoff + transport connect),
    // which happens *after* the handling wait, so a user who authorizes near the deadline still
    // gets a connection instead of a timeout.
    const oauthHandlingTimeout = Number.isFinite(mcpConfig.OAUTH_HANDLING_TIMEOUT)
      ? mcpConfig.OAUTH_HANDLING_TIMEOUT
      : 10 * 60 * 1000;
    const connectTimeout = this.useOAuth
      ? Math.max(baseTimeout, oauthHandlingTimeout + 60000)
      : baseTimeout;
    const retryController = new AbortController();
    const callerSignal = this.signal;
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
      if (callerSignal) {
        onAbort = () => {
          retryController.abort(callerSignal.reason);
          reject(callerSignal.reason);
        };
        callerSignal.addEventListener('abort', onAbort, { once: true });
      }
    });
    let timeoutId: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        retryController.abort();
        reject(new Error(`Connection timeout after ${connectTimeout}ms`));
      }, connectTimeout);
    });

    try {
      await Promise.race([this.connectTo(connection, retryController.signal), timeout, cancelled]);
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      retryController.abort();
      if (onAbort) {
        callerSignal?.removeEventListener('abort', onAbort);
      }
    }

    callerSignal?.throwIfAborted();
    const connected = await connection.isConnected(callerSignal);
    callerSignal?.throwIfAborted();
    if (connected) return;
    logger.error(`${this.logPrefix} Failed to establish connection.`);
  }

  private waitForRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('Connection retry cancelled'));
        return;
      }

      const onAbort = () => {
        clearTimeout(timeoutId);
        reject(new Error('Connection retry cancelled'));
      };
      const timeoutId = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, delayMs);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async connectTo(connection: MCPConnection, signal: AbortSignal): Promise<void> {
    const maxAttempts = 3;
    let attempts = 0;

    while (attempts < maxAttempts) {
      if (signal.aborted) {
        throw new Error('Connection retry cancelled');
      }
      try {
        await connection.connect();
        if (await connection.isConnected()) {
          return;
        }
        throw new Error('Connection attempt succeeded but status is not connected');
      } catch (error) {
        attempts++;

        if (signal.aborted) {
          throw error;
        }

        if (
          (this.useOAuth || this.directBearerRecoveryEnabled) &&
          isOAuthAuthenticationError(error)
        ) {
          logger.info(`${this.logPrefix} OAuth required, stopping connection attempts`);
          throw error;
        }

        if (attempts === maxAttempts) {
          logger.error(`${this.logPrefix} Failed to connect after ${maxAttempts} attempts`);
          throw error;
        }
        await this.waitForRetry(2000 * attempts, signal);
      }
    }
  }

  /** Clears stored client registration if the error indicates client rejection */
  private async clearStaleClientIfRejected(
    reusedClientCredentialSetId: string | undefined,
    error: unknown,
  ): Promise<void> {
    if (!reusedClientCredentialSetId || !this.tokenMethods?.deleteTokens) {
      return;
    }
    if (!MCPConnectionFactory.isClientRejection(error)) {
      return;
    }
    await this.runWithCapturedTenant(() =>
      MCPTokenStorage.deleteClientRegistration({
        userId: this.userId!,
        serverName: this.serverName,
        deleteTokens: this.tokenMethods!.deleteTokens,
        credentialSetId: reusedClientCredentialSetId,
      }),
    ).catch(() => {
      logger.warn(`${this.logPrefix} Failed to clear stale client registration`);
    });
  }

  /**
   * Checks whether an error indicates the OAuth client registration was rejected.
   * Includes RFC 6749 §5.2 standard codes (`invalid_client`, `unauthorized_client`)
   * and known vendor-specific patterns (Okta: `client_id mismatch`, Auth0: `client not found`,
   * generic: `unknown client`).
   */
  static isClientRejection(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
      return false;
    }
    if ('message' in error && typeof error.message === 'string') {
      return isClientRejectionMessage(error.message);
    }
    return false;
  }

  /** Manages OAuth flow initiation and completion */
  protected async handleOAuthRequired(expectedLeaseGeneration?: number): Promise<{
    tokens: MCPOAuthTokens | null;
    clientInfo?: OAuthClientInformation;
    metadata?: OAuthMetadata;
    resourceMetadata?: OAuthProtectedResourceMetadata;
    clientSource?: OAuthClientSource;
    reusedStoredClient?: boolean;
    reusedClientCredentialSetId?: string;
    error?: unknown;
  } | null> {
    const serverUrl = (this.serverConfig as t.SSEOptions | t.StreamableHTTPOptions).url;
    logger.debug(`${this.logPrefix} \`handleOAuthRequired\` called`, {
      hasServerUrl: Boolean(serverUrl),
    });

    if (!this.flowManager || !serverUrl) {
      logger.error(
        `${this.logPrefix} OAuth required but flow manager or server URL is unavailable`,
      );
      logger.warn(`${this.logPrefix} OAuth credentials must be configured`);
      return null;
    }

    const oauthLeaseId = getMCPOAuthLeaseId(this.userId!, this.serverName, this.tenantId);
    const oauthLeaseGeneration =
      expectedLeaseGeneration ?? (await this.flowManager.getLeaseGeneration(oauthLeaseId));
    if (oauthLeaseGeneration === null) {
      throw new Error('OAuth teardown in progress');
    }

    let reusedStoredClient = false;
    let reusedClientCredentialSetId: string | undefined;

    try {
      logger.debug(`${this.logPrefix} Checking for existing OAuth flow`);

      /** Flow ID to check if a flow already exists */
      const flowId = this.getBaseFlowId();

      /** Check if there's already an ongoing OAuth flow for this flowId */
      const existingFlow = await this.flowManager.getFlowState(flowId, 'mcp_oauth');

      if (existingFlow) {
        const flowMeta = existingFlow.metadata as MCPOAuthFlowMetadata | undefined;

        if (existingFlow.status === 'PENDING') {
          const pendingAge = existingFlow.createdAt
            ? Date.now() - existingFlow.createdAt
            : Infinity;

          if (pendingAge < PENDING_STALE_MS && this.isReplayablePendingOAuthFlow(flowMeta)) {
            logger.debug(
              `${this.logPrefix} Found recent PENDING OAuth flow (${Math.round(pendingAge / 1000)}s old), joining instead of creating new one`,
            );

            const storedAuthUrl = flowMeta?.authorizationUrl;
            if (storedAuthUrl && typeof this.oauthStart === 'function') {
              const expiresAt = this.getOAuthReplayExpiresAt(existingFlow.createdAt);
              if (!expiresAt) {
                throw new Error('Pending OAuth flow expired before replay');
              }
              logger.info(
                `${this.logPrefix} Re-issuing stored authorization URL to caller while joining PENDING flow`,
              );
              const replayLease = await this.flowManager.acquireLease(oauthLeaseId, {
                expectedGeneration: oauthLeaseGeneration,
              });
              if (!replayLease) {
                throw new Error('OAuth replay superseded by teardown');
              }
              try {
                await this.oauthStart(storedAuthUrl, { expiresAt });
              } finally {
                await replayLease.release();
              }
            }

            reusedStoredClient = flowMeta?.reusedStoredClient === true;
            reusedClientCredentialSetId = flowMeta?.reusedClientCredentialSetId;
            const tokens = await this.waitForSharedOAuthFlow(flowId);
            if (typeof this.oauthEnd === 'function') {
              await this.oauthEnd();
            }
            logger.info(`${this.logPrefix} Joined existing OAuth flow completed`);
            return {
              tokens,
              clientInfo: flowMeta?.clientInfo,
              metadata: flowMeta?.metadata,
              resourceMetadata: flowMeta?.resourceMetadata,
              clientSource: flowMeta?.clientSource,
              reusedStoredClient,
              reusedClientCredentialSetId,
            };
          }

          logger.debug(
            `${this.logPrefix} Found stale PENDING OAuth flow (${Math.round(pendingAge / 1000)}s old), will delete and start fresh`,
          );
        }

        if (existingFlow.status === 'COMPLETED') {
          const completedAge = existingFlow.completedAt
            ? Date.now() - existingFlow.completedAt
            : Infinity;
          const cachedTokens = existingFlow.result as MCPOAuthTokens | null | undefined;
          const isTokenExpired =
            cachedTokens?.expires_at != null &&
            normalizeExpiresAt(cachedTokens.expires_at) < Date.now();

          if (
            completedAge <= PENDING_STALE_MS &&
            cachedTokens !== undefined &&
            !isTokenExpired &&
            this.isCurrentServerOAuthFlow(flowMeta)
          ) {
            const reuseLease = await this.flowManager.acquireLease(oauthLeaseId, {
              expectedGeneration: oauthLeaseGeneration,
            });
            if (!reuseLease) {
              throw new Error('Cached OAuth result superseded by teardown');
            }
            logger.debug(
              `${this.logPrefix} Found non-stale COMPLETED OAuth flow, reusing cached tokens`,
            );
            try {
              return {
                tokens: cachedTokens,
                clientInfo: flowMeta?.clientInfo,
                metadata: flowMeta?.metadata,
                resourceMetadata: flowMeta?.resourceMetadata,
                clientSource: flowMeta?.clientSource,
                reusedStoredClient: flowMeta?.reusedStoredClient,
                reusedClientCredentialSetId: flowMeta?.reusedClientCredentialSetId,
              };
            } finally {
              await reuseLease.release();
            }
          }
        }

        logger.debug(
          `${this.logPrefix} Found existing OAuth flow (status: ${existingFlow.status}), cleaning up to start fresh`,
        );
        try {
          const oldState = flowMeta?.state;
          await this.flowManager.deleteFlow(flowId, 'mcp_oauth');
          if (oldState) {
            await MCPOAuthHandler.deleteStateMapping(oldState, this.flowManager);
          }
        } catch {
          logger.warn(`${this.logPrefix} Failed to clean up existing OAuth flow`);
        }
      }

      logger.debug(`${this.logPrefix} Initiating new OAuth flow`);
      const {
        authorizationUrl,
        flowId: newFlowId,
        flowMetadata,
      } = await this.runWithCapturedTenant(() =>
        MCPOAuthHandler.initiateOAuthFlow(
          this.serverName,
          serverUrl,
          this.userId!,
          this.serverConfig.oauth_headers ?? {},
          this.serverConfig.oauth,
          this.allowedDomains,
          this.tokenMethods?.deleteTokens ? this.tokenMethods.findToken : undefined,
          this.allowedAddresses,
          this.tenantId,
        ),
      );

      reusedStoredClient = flowMetadata.reusedStoredClient === true;
      reusedClientCredentialSetId = flowMetadata.reusedClientCredentialSetId;

      // Store flow state BEFORE redirecting so the callback can find it
      const metadataWithUrl = {
        ...flowMetadata,
        authorizationUrl,
        tenantId: this.tenantId,
        serverGeneration: getMCPServerGeneration(this.serverDefinition as t.ParsedServerConfig),
        oauthPersistenceWaitTimeout: this.serverConfig.oauthPersistenceWaitTimeout,
      };
      const publicationLease = await this.flowManager.acquireLease(oauthLeaseId, {
        expectedGeneration: oauthLeaseGeneration,
      });
      if (!publicationLease) {
        throw new Error('OAuth initiation superseded by teardown');
      }
      try {
        await this.flowManager.initFlow(newFlowId, 'mcp_oauth', metadataWithUrl);
        await MCPOAuthHandler.storeStateMapping(flowMetadata.state, newFlowId, this.flowManager);
      } finally {
        await publicationLease.release();
      }

      if (typeof this.oauthStart === 'function') {
        logger.info(`${this.logPrefix} OAuth flow started, issued authorization URL to user`);
        await this.oauthStart(authorizationUrl);
      } else {
        logger.info(
          `${this.logPrefix} OAuth flow started, no \`oauthStart\` handler defined, relying on callback endpoint`,
        );
      }

      // createFlow will find the existing PENDING state written by initFlow above,
      // so metadata arg is unused (pass {} to make that explicit)
      const tokens = await this.waitForSharedOAuthFlow(newFlowId);
      if (typeof this.oauthEnd === 'function') {
        await this.oauthEnd();
      }
      logger.info(`${this.logPrefix} OAuth flow completed; tokens received`);

      return {
        tokens,
        clientInfo: flowMetadata.clientInfo,
        metadata: flowMetadata.metadata,
        resourceMetadata: flowMetadata.resourceMetadata,
        clientSource: flowMetadata.clientSource,
        reusedStoredClient,
        reusedClientCredentialSetId,
      };
    } catch (error) {
      logger.error(`${this.logPrefix} Failed to complete OAuth flow`);
      return { tokens: null, reusedStoredClient, reusedClientCredentialSetId, error };
    }
  }

  private waitForSharedOAuthFlow(flowId: string): Promise<MCPOAuthTokens | null> {
    const flow = this.flowManager!.createFlow(flowId, 'mcp_oauth', {}, undefined, false);
    const signal = this.signal;
    if (!signal) {
      return flow;
    }

    return new Promise<MCPOAuthTokens | null>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener('abort', onAbort);
      const onAbort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error ? signal.reason : new Error('MCP OAuth flow wait aborted'),
        );
      };

      flow.then(
        (tokens) => {
          cleanup();
          resolve(tokens);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );

      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}
