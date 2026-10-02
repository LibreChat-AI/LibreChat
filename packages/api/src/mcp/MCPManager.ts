import pick from 'lodash/pick';
import { logger } from '@librechat/data-schemas';
import { CallToolResultSchema, ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Permissions, PermissionTypes, DEFAULT_MCP_APPS_POLICY } from 'librechat-data-provider';
import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { TokenMethods, IUser } from '@librechat/data-schemas';
import type { TMCPAppsPolicy } from 'librechat-data-provider';
import type {
  OboTokenResolver,
  OboTrustChecker,
  UpstreamTokenProvider,
  UpstreamTokenProviderResolver,
} from '~/mcp/oauth/obo';
import type { MCPAppOperationContext, MCPAppValidationContext } from './apps';
import type { MCPClientCapabilityProfile } from './capabilities';
import type { AuthIdentityContext } from '~/utils/identity';
import type { GraphTokenResolver } from '~/utils/graph';
import type { FlowStateManager } from '~/flow/manager';
import type { MCPOAuthTokens } from './oauth';
import type { RequestBody } from '~/types';
import type * as t from './types';
import {
  getMissingRuntimeBodyPlaceholderFields,
  toCatalogConnectionConfig,
  applyRequestHeaders,
  createDeadlineAbortSignal,
  canUseAppConnection,
  isOAuthServer,
  isUserSourced,
  requiresEphemeralUserConnection,
  requiresOAuthMachinery,
  requiresUserScopedConnection,
  resolveServerInstructions,
} from './utils';
import {
  getMCPConnectionPoolKey,
  getMCPUserConnectionPoolKey,
  MCP_APPS_CAPABILITY_PROFILE,
  resolveMCPClientCapabilityProfile,
  STANDARD_MCP_CAPABILITY_PROFILE,
} from './capabilities';
import {
  projectMCPAppRuntimeTarget,
  type MCPAppBindingCodec,
  type MCPAppBindingSubject,
  type MCPAppRuntimeTarget,
} from './apps/binding';
import { getMCPAppToolsPublicationGeneration, getMCPToolsChangedGeneration } from './toolsChanged';
import { mcpOptionsContainGraphTokenPlaceholder, preProcessGraphTokens } from '~/utils/graph';
import { MCPAuthenticationRejectedError, isMCPTransportAuthenticationError } from './errors';
import { resolveDirectOpenIDBearerConfig, usesDirectOpenIDBearerRecovery } from './openid';
import { createLazyOboUpstreamTokenProvider, awaitOboOperation } from '~/mcp/oauth/obo';
import { MCPAppOperationBudget, getMCPAppOperationLimits } from './apps/budget';
import { formatToolContent, selectResolvedAppResource } from './parsers';
import { MCPServersInitializer } from './registry/MCPServersInitializer';
import { OboTokenResolutionError, resolveOboToken } from '~/mcp/oauth';
import { MCPServerCatalogRecoveryTracker } from './catalog/recovery';
import { getToolUiResourceUri, isToolHiddenFromApp } from './apps';
import { MCPServerInspector } from './registry/MCPServerInspector';
import { MCPServersRegistry } from './registry/MCPServersRegistry';
import { UserConnectionManager } from './UserConnectionManager';
import { ConnectionsRepository } from './ConnectionsRepository';
import { MCPConnectionFactory } from './MCPConnectionFactory';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { OAuthLifecycleRelay } from './oauth/pending';
import { isOwnedAbortError } from '~/utils/errors';
import { withMCPRequestSignal } from './signal';
import { MCPConnection } from './connection';
import { mcpConfig } from './mcpConfig';

function createOboToolCallErrorMessage(
  logPrefix: string,
  toolName: string,
  error: OboTokenResolutionError,
): string {
  let failureSuffix = 'Re-authenticate the user and retry.';

  if (error.retryable) {
    failureSuffix = 'Please retry.';
  } else if (error.reason === 'exchange_failed') {
    failureSuffix = 'Re-authenticate the user or verify the configured OBO scopes and retry.';
  } else if (error.reason === 'session_refresh_failed') {
    failureSuffix = 'Please sign in again.';
  } else if (error.reason === 'missing_upstream_provider') {
    failureSuffix = 'Configure a renewable upstream credential provider before retrying.';
  }

  return `${logPrefix} ${error.userMessage} Cannot execute tool ${toolName}. ${failureSuffix}`;
}

class OAuthRecoveryTakeoverRequired extends Error {}

type OAuthReconnectResult =
  | { connected: true }
  | {
      connected: false;
      error: unknown;
      oauthHandled: boolean;
      source?: t.OAuthHandledSource;
    };

const OAUTH_RECOVERY_RECONNECT_ATTEMPTS = 3;
const OAUTH_RECOVERY_RECONNECT_DELAY_MS = 2000;

function getDiscoveryAuthenticationKind(
  serverConfig: t.ParsedServerConfig,
  observedOAuthRequired = false,
): 'oauth' | 'obo' | 'server' {
  if (serverConfig.obo != null) {
    return 'obo';
  }
  return isOAuthServer(serverConfig) ||
    (observedOAuthRequired && serverConfig.requiresOAuth !== false)
    ? 'oauth'
    : 'server';
}

/**
 * Centralized manager for MCP server connections and tool execution.
 * Extends UserConnectionManager to handle both app-level and user-specific connections.
 */
export class MCPManager extends UserConnectionManager {
  private static instance: MCPManager | null;
  private readonly catalogRecoveryTracker: MCPServerCatalogRecoveryTracker;
  private readonly recoveryCancellation = new WeakMap<
    Promise<void>,
    { controller: AbortController; waiters: number; connection: MCPConnection }
  >();

  private readonly oauthRecoveries = new WeakMap<
    MCPConnection,
    {
      promise: Promise<void>;
      callbacks?: OAuthLifecycleRelay;
      allowsTakeover: boolean;
      takeoverClaimed?: boolean;
      directBearerRecoveryConsumed?: boolean;
      directBearerRecoveryState?: t.DirectBearerRecoveryState;
    }
  >();

  constructor(
    catalogRecoveryMaxStateEntries?: number,
    catalogRecoveryMaxDetachedDiscoveries?: number,
    private readonly appBindingCodec: MCPAppBindingCodec | undefined = undefined,
  ) {
    super();
    this.catalogRecoveryTracker = new MCPServerCatalogRecoveryTracker(
      catalogRecoveryMaxStateEntries,
      catalogRecoveryMaxDetachedDiscoveries,
    );
  }

  /** Per-process admission for follow-up requests and optional first document reads. */
  public readonly appOperationBudget: MCPAppOperationBudget = new MCPAppOperationBudget();

  private readonly resourceUriCache = new Map<string, Map<string, { uri: string }>>();

  private readonly appHiddenToolCache = new Map<string, Set<string>>();
  private readonly knownToolNamesCache = new Map<string, Set<string>>();
  /**
   * Stamp of the connection each cache entry was built from, to detect reconnects (createdAt) and
   * live tools/list_changed notifications (toolListVersion) that createdAt alone would miss.
   */
  private readonly toolCacheConnStamp = new Map<string, string>();

  /** Creates and initializes the singleton MCPManager instance */
  public static async createInstance(
    configs: t.MCPServers,
    options?: {
      catalogRecoveryMaxStateEntries?: number;
      catalogRecoveryMaxDetachedDiscoveries?: number;
      appBindingCodec?: MCPAppBindingCodec;
    },
  ): Promise<MCPManager> {
    if (MCPManager.instance) throw new Error('MCPManager has already been initialized.');
    MCPManager.instance = new MCPManager(
      options?.catalogRecoveryMaxStateEntries,
      options?.catalogRecoveryMaxDetachedDiscoveries,
      options?.appBindingCodec,
    );
    await MCPManager.instance.initialize(configs);
    return MCPManager.instance;
  }

  /** Returns the singleton MCPManager instance */
  public static getInstance(): MCPManager {
    if (!MCPManager.instance) throw new Error('MCPManager has not been initialized.');
    return MCPManager.instance;
  }

  /** Initializes the MCPManager by setting up server registry and app connections */
  public async initialize(configs: t.MCPServers): Promise<void> {
    await MCPServersInitializer.initialize(configs);
    this.appConnections = new ConnectionsRepository(undefined);
  }

  public getCatalogRecoveryTracker(): MCPServerCatalogRecoveryTracker {
    return this.catalogRecoveryTracker;
  }

  /** Returns shared operator sessions only for the standard handshake they negotiated. */
  public async getLoadedAppConnections(
    capabilityProfile: MCPClientCapabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
  ): Promise<Map<string, MCPConnection>> {
    if (capabilityProfile !== STANDARD_MCP_CAPABILITY_PROFILE) {
      return new Map();
    }
    return (await this.appConnections?.getLoaded()) ?? new Map();
  }

  public clearCatalogRecoveryState(
    userId: string,
    serverName?: string,
    generation?: string,
    capabilityProfile?: MCPClientCapabilityProfile,
  ): void {
    this.catalogRecoveryTracker.clear(userId, serverName, generation, capabilityProfile);
  }

  public override async disconnectUserConnection(
    userId: string,
    serverName: string,
    options?: Parameters<UserConnectionManager['disconnectUserConnection']>[2],
  ): Promise<void> {
    if ((options?.reason ?? 'mutation') === 'mutation') {
      this.clearCatalogRecoveryState(userId, serverName, undefined, options?.capabilityProfile);
    }
    await super.disconnectUserConnection(userId, serverName, options);
  }

  public override getUserConnection(opts: t.UserMCPConnectionOptions): Promise<MCPConnection> {
    const connectionTarget = this.getSuppliedConnectionTarget(opts);
    if (connectionTarget) {
      return this.getManagedUserConnection(opts, connectionTarget);
    }
    return this.resolveConnectionTarget(opts).then((resolvedTarget) => {
      opts.signal?.throwIfAborted();
      if (!resolvedTarget) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `[MCP] Configuration for server "${opts.serverName}" not found.`,
        );
      }
      return this.getManagedUserConnection(opts, resolvedTarget);
    });
  }

  private async getManagedUserConnection(
    opts: t.UserMCPConnectionOptions,
    connectionTarget: t.MCPConnectionTarget,
  ): Promise<MCPConnection> {
    const resolvedOpts = {
      ...opts,
      serverConfig: undefined,
      connectionTarget,
    } as t.UserMCPConnectionOptions;
    const userId = opts.user?.id;
    if (opts.forceNew || opts.ephemeralConnection || !userId) {
      return super.getUserConnection(resolvedOpts);
    }

    const capabilityProfile = opts.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
    const connectionKey = getMCPUserConnectionPoolKey(userId, opts.serverName, capabilityProfile);
    const requestConnection = opts.requestScopedConnections?.connections.get(connectionKey) as
      | MCPConnection
      | undefined;
    const connection =
      requestConnection ??
      this.userConnections
        .get(userId)
        ?.get(getMCPConnectionPoolKey(opts.serverName, capabilityProfile));
    const recovery = connection ? this.oauthRecoveries.get(connection) : undefined;
    const requestedConfigGeneration = getMCPAppToolsPublicationGeneration(
      connectionTarget.serverConfig,
    );
    const connectionMatchesTarget =
      connection == null || this.getToolConfigGeneration(connection) === requestedConfigGeneration;
    if (recovery && connectionMatchesTarget) {
      if (recovery.directBearerRecoveryConsumed && opts.directBearerRecoveryState) {
        opts.directBearerRecoveryState.attempted = true;
        opts.directBearerRecoveryState.resolvedConfig =
          recovery.directBearerRecoveryState?.resolvedConfig;
      }
      if (recovery.callbacks) {
        await recovery.callbacks.add({
          oauthStart: opts.oauthStart,
          oauthEnd: opts.oauthEnd,
          flowManager: opts.flowManager,
          userId,
          serverName: opts.serverName,
        });
      }
      await this.waitForActiveRecovery(recovery.promise, opts.signal);
      if (opts.directBearerRecoveryState && recovery.directBearerRecoveryState) {
        Object.assign(opts.directBearerRecoveryState, recovery.directBearerRecoveryState);
      }
    }

    return super.getUserConnection(resolvedOpts);
  }

  /** Runs work against a user connection while preventing recovery from replacing its SDK client. */
  public async withUserConnectionLease<TResult>(
    opts: t.UserMCPConnectionOptions,
    operation: (connection: MCPConnection) => Promise<TResult>,
  ): Promise<TResult> {
    while (true) {
      const connection = await this.getUserConnection(opts);
      this.retainConnection(connection);
      const recovery = this.oauthRecoveries.get(connection)?.promise;
      if (recovery) {
        await this.releaseConnection(connection);
        await this.waitForActiveRecovery(recovery, opts.signal);
        continue;
      }

      try {
        return await operation(connection);
      } finally {
        await this.releaseConnection(connection);
      }
    }
  }

  private waitForActiveRecovery(recovery: Promise<void>, signal?: AbortSignal): Promise<void> {
    const shared = this.recoveryCancellation.get(recovery);
    if (shared) {
      shared.waiters++;
    }
    let released = false;
    const release = (aborted: boolean) => {
      if (released || !shared) {
        return;
      }
      released = true;
      shared.waiters--;
      if (aborted && shared.waiters === 0) {
        const abortIfUnowned = () => {
          if (shared.waiters === 0 && !this.hasConnectionBorrowers(shared.connection)) {
            shared.controller.abort(signal?.reason);
          }
        };
        if (this.hasConnectionBorrowers(shared.connection)) {
          /** A leased call registers recovery before releasing its lease after a rejection. */
          void this.waitForConnectionBorrowersToDrain(shared.connection).then(abortIfUnowned);
        } else {
          abortIfUnowned();
        }
      }
    };
    if (!signal) {
      return recovery.finally(() => release(false));
    }

    return new Promise<void>((resolve, reject) => {
      const onRecoveryResolved = () => {
        release(false);
        signal.removeEventListener('abort', onAbort);
        resolve();
      };
      const onRecoveryRejected = (error: unknown) => {
        release(false);
        signal.removeEventListener('abort', onAbort);
        reject(error);
      };
      const onAbort = () => {
        release(true);
        signal.removeEventListener('abort', onAbort);
        const reason = signal.reason;
        reject(reason instanceof Error ? reason : new Error('OAuth recovery wait aborted'));
      };

      recovery.then(onRecoveryResolved, onRecoveryRejected);
      if (signal.aborted) {
        onAbort();
        return;
      }

      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  protected override getActiveConnectionRecovery(
    connection: MCPConnection,
  ): Promise<void> | undefined {
    return this.oauthRecoveries.get(connection)?.promise;
  }

  protected override propagateDirectBearerRecoveryState(
    connection: MCPConnection,
    state?: t.DirectBearerRecoveryState,
  ): void {
    const recovery = this.oauthRecoveries.get(connection);
    if (state && recovery?.directBearerRecoveryConsumed) {
      state.attempted = true;
      const sharedState = recovery.directBearerRecoveryState;
      if (sharedState) {
        state.resolvedConfig = sharedState.resolvedConfig;
        void recovery.promise.then(
          () => {
            state.resolvedConfig = sharedState.resolvedConfig;
          },
          () => undefined,
        );
      }
    }
  }

  protected override waitForConnectionRecovery(
    recovery: Promise<void>,
    signal?: AbortSignal,
  ): Promise<void> {
    return this.waitForActiveRecovery(recovery, signal);
  }

  private claimRecoveryTakeover(recovery: {
    allowsTakeover: boolean;
    takeoverClaimed?: boolean;
  }): boolean {
    if (!recovery.allowsTakeover || recovery.takeoverClaimed) {
      return false;
    }
    recovery.takeoverClaimed = true;
    return true;
  }

  private async resolveCheckoutTarget(args: {
    serverName: string;
    user?: IUser;
    connectionTarget?: t.MCPConnectionTarget;
    serverConfig?: t.ParsedServerConfig;
  }): Promise<t.MCPConnectionTarget | undefined> {
    if (args.connectionTarget) {
      return args.connectionTarget;
    }
    const registry = MCPServersRegistry.getInstance();
    const resolvedConfig =
      args.serverConfig ?? (await registry.getServerConfig(args.serverName, args.user?.id));
    if (!resolvedConfig) {
      return undefined;
    }
    return {
      serverConfig: resolvedConfig,
      connectionOwner: (await registry.isAppServerConfig(args.serverName, resolvedConfig))
        ? 'operator'
        : 'principal',
    };
  }

  /** Retrieves an app-level or user-specific connection based on provided arguments. */
  public async getConnection(
    args: {
      serverName: string;
      user?: IUser;
      forceNew?: boolean;
      ephemeralConnection?: boolean;
      flowManager?: FlowStateManager<MCPOAuthTokens | null>;
      /** Pre-resolved connection target for callers that already completed policy selection. */
      connectionTarget?: t.MCPConnectionTarget;
      /** Pre-resolved config retained for ordinary callers. */
      serverConfig?: t.ParsedServerConfig;
      /** One-shot direct-bearer recovery budget shared with the invoking tool call. */
      directBearerRecoveryState?: t.DirectBearerRecoveryState;
    } & Omit<t.OAuthConnectionOptions, 'useOAuth' | 'user' | 'flowManager'>,
  ): Promise<MCPConnection> {
    const userId = args.user?.id;
    const capabilityProfile = args.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
    const connectionTarget = await this.resolveCheckoutTarget(args);
    if (
      connectionTarget &&
      userId &&
      (connectionTarget.connectionOwner === 'principal' ||
        requiresUserScopedConnection(connectionTarget.serverConfig) ||
        capabilityProfile === MCP_APPS_CAPABILITY_PROFILE)
    ) {
      return this.getUserConnection({
        ...args,
        capabilityProfile,
        serverConfig: undefined,
        connectionTarget,
      } as Parameters<typeof this.getUserConnection>[0]);
    }

    if (
      connectionTarget?.connectionOwner === 'operator' &&
      capabilityProfile === STANDARD_MCP_CAPABILITY_PROFILE &&
      canUseAppConnection(connectionTarget.serverConfig)
    ) {
      const appConnection = await this.appConnections!.get(args.serverName, {
        expectedConfig: connectionTarget.serverConfig,
      });
      if (appConnection) {
        return appConnection;
      }
    } else if (connectionTarget && userId) {
      return this.getUserConnection({
        ...args,
        serverConfig: undefined,
        connectionTarget,
      } as Parameters<MCPManager['getUserConnection']>[0]);
    }
    throw new McpError(
      ErrorCode.InvalidRequest,
      `No connection found for server ${args.serverName}`,
    );
  }

  /** Checks out a connection together with the exact target used to create or reuse it. */
  private async checkoutConnection(
    args: Parameters<MCPManager['getConnection']>[0],
  ): Promise<{ connection: MCPConnection; connectionTarget: t.MCPConnectionTarget }> {
    const connectionTarget = await this.resolveCheckoutTarget(args);
    if (!connectionTarget) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `No connection found for server ${args.serverName}`,
      );
    }
    const connection = await this.getConnection({
      ...args,
      serverConfig: undefined,
      connectionTarget,
    });
    return { connection, connectionTarget };
  }

  /**
   * Discovers tools from an MCP server, even when OAuth is required.
   * Per MCP spec, tool listing should be possible without authentication.
   * Use this for agent initialization to get tool schemas before OAuth flow.
   */
  public async discoverServerTools(args: t.ToolDiscoveryOptions): Promise<t.ToolDiscoveryResult> {
    const { serverName, user } = args;
    const capabilityProfile = args.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
    const registry = MCPServersRegistry.getInstance();
    const serverConfig = await registry.getServerConfig(serverName, user?.id, args.configServers);

    if (!serverConfig) {
      logger.warn('[MCP][Discovery] Server configuration not found');
      return { tools: null, oauthRequired: false, oauthUrl: null };
    }

    try {
      const useAppConnection =
        capabilityProfile === STANDARD_MCP_CAPABILITY_PROFILE &&
        canUseAppConnection(serverConfig) &&
        (await registry.isAppServerConfig(serverName, serverConfig));
      const existingAppConnection = useAppConnection
        ? await this.appConnections?.get(serverName)
        : null;
      /** Cancels the shared connection's health probe and `tools/list` for THIS caller only —
       *  an aborted probe reports false without touching the shared connection's state. Combines
       *  the budget with the caller's own signal so cancelling the request also stops the work. */
      const budgetSignal =
        existingAppConnection != null
          ? createDeadlineAbortSignal(args.deadlineMs, args.signal)
          : undefined;
      if (existingAppConnection && (await existingAppConnection.isConnected(budgetSignal))) {
        const snapshot = await existingAppConnection.fetchOrderedToolsSnapshot(
          args.deadlineMs,
          budgetSignal,
        );
        return {
          tools: snapshot.complete ? snapshot.tools : null,
          oauthRequired: false,
          oauthUrl: null,
        };
      }
    } catch {
      logger.debug('[MCP][Discovery] App connection unavailable; trying discovery mode');
    }

    /** A probe aborted by the caller is not a dead server: falling through here would open a
     *  fresh connection on behalf of a request that no longer exists (or a budget already
     *  spent), and the fallback keeps running after the caller has gone. */
    if (
      args.signal?.aborted === true ||
      (args.deadlineMs != null && Date.now() >= args.deadlineMs)
    ) {
      logger.debug(
        '[MCP][Discovery] Caller cancelled or budget spent; skipping discovery fallback',
      );
      return { tools: null, oauthRequired: false, oauthUrl: null };
    }

    /** Discovery sends no `requestHeaders`, so only the body values the catalog
     *  connection itself needs can block it. A server whose body placeholders
     *  live solely in `requestHeaders` still lists its tools. */
    const catalogConfig = toCatalogConnectionConfig(serverConfig);
    const missingBodyFields = getMissingRuntimeBodyPlaceholderFields(
      catalogConfig,
      args.requestBody,
    );
    if (missingBodyFields.length > 0) {
      logger.warn('[MCP][Discovery] Runtime request fields are missing', {
        missingBodyFieldCount: missingBodyFields.length,
      });
      return { tools: null, oauthRequired: false, oauthUrl: null };
    }

    const { allowedDomains, allowedAddresses, useSSRFProtection, mcpApps } =
      await registry.resolveAllowlists({ userId: user?.id, role: user?.role });
    await this.assertResolvedRuntimeConfigAllowed({
      config: catalogConfig,
      user,
      customUserVars: args.customUserVars,
      requestBody: args.requestBody,
      graphTokenResolver: args.graphTokenResolver,
      allowedDomains,
      allowedAddresses,
      logPrefix: '[MCP][Discovery]',
    });

    const useOAuth = requiresOAuthMachinery(serverConfig);
    const dbSourced = isUserSourced(serverConfig);
    const basic: t.BasicConnectionOptions = {
      dbSourced,
      serverName,
      serverConfig: catalogConfig,
      serverDefinition: serverConfig,
      useSSRFProtection,
      allowedDomains,
      allowedAddresses,
      capabilityProfile,
      ...(capabilityProfile === MCP_APPS_CAPABILITY_PROFILE && {
        operationLimits: mcpApps.operationLimits,
      }),
    };

    const finalizeDiscoveryResult = async (
      result: Awaited<ReturnType<typeof MCPConnectionFactory.discoverTools>>,
    ): Promise<t.ToolDiscoveryResult> => {
      if (result.connection) {
        try {
          await result.connection.dispose();
        } catch {
          logger.warn('[MCP][Discovery] Failed to dispose discovery connection');
        }
      }
      return {
        tools: result.tools,
        oauthRequired: result.oauthRequired,
        oauthUrl: result.oauthUrl,
        ...(result.oauthRequired && {
          authenticationKind: getDiscoveryAuthenticationKind(serverConfig, true),
        }),
      };
    };

    if (!useOAuth) {
      const result = await MCPConnectionFactory.discoverTools(basic, {
        user: args.user,
        customUserVars: args.customUserVars,
        requestBody: args.requestBody,
        graphTokenResolver: args.graphTokenResolver,
        upstreamTokenProvider: args.upstreamTokenProvider,
        upstreamTokenProviderResolver: args.upstreamTokenProviderResolver,
        connectionTimeout: args.connectionTimeout,
        deadlineMs: args.deadlineMs,
        signal: args.signal,
      });
      return finalizeDiscoveryResult(result);
    }

    if (!user || !args.flowManager) {
      logger.warn('[MCP][Discovery] OAuth server requires a user and flow manager');
      return {
        tools: null,
        oauthRequired: true,
        oauthUrl: null,
        authenticationKind: getDiscoveryAuthenticationKind(serverConfig),
      };
    }

    const result = await MCPConnectionFactory.discoverTools(basic, {
      user,
      useOAuth: true,
      flowManager: args.flowManager,
      tokenMethods: args.tokenMethods,
      signal: args.signal,
      oauthStart: args.oauthStart,
      customUserVars: args.customUserVars,
      requestBody: args.requestBody,
      graphTokenResolver: args.graphTokenResolver,
      connectionTimeout: args.connectionTimeout,
      deadlineMs: args.deadlineMs,
      onOAuthCredentialsChanged: args.onOAuthCredentialsChanged,
      onOAuthCredentialsAdopted: args.onOAuthCredentialsAdopted,
      onOAuthCredentialsChanging: args.onOAuthCredentialsChanging,
      onOAuthCredentialsInvalidated: () =>
        getMCPToolsChangedGeneration({ userId: user.id, serverName }),
      onDiscoveryDetached: args.onDiscoveryDetached,
      oboTokenResolver: args.oboTokenResolver,
      oboTrustChecker: args.oboTrustChecker,
      upstreamTokenProvider: args.upstreamTokenProvider,
      upstreamTokenProviderResolver: args.upstreamTokenProviderResolver,
      oboIdentityContext: args.oboIdentityContext,
    });

    return finalizeDiscoveryResult(result);
  }

  /** Returns all available tool functions from app-level connections */
  public async getAppToolFunctions(): Promise<t.LCAvailableTools> {
    const toolFunctions: t.LCAvailableTools = {};
    const configs = await MCPServersRegistry.getInstance().getAllServerConfigs();
    for (const config of Object.values(configs)) {
      if (canUseAppConnection(config) && config.toolFunctions != null) {
        Object.assign(toolFunctions, config.toolFunctions);
      }
    }
    return toolFunctions;
  }

  /** Opens eligible app-shared sessions after the inspected startup catalog has been cached. */
  public async connectAppServers(): Promise<void> {
    try {
      const configs = await MCPServersRegistry.getInstance().getAllServerConfigs();
      const serverNames = Object.entries(configs)
        .filter(([, config]) => canUseAppConnection(config))
        .map(([serverName]) => serverName);
      const connections = await this.appConnections?.getMany(serverNames, {
        continueOnError: true,
        refreshTools: false,
      });
      if (!connections) {
        return;
      }
      await Promise.all(
        Array.from(connections.values(), (connection) => connection.refreshToolList()),
      );
    } catch (error) {
      logger.warn('[MCP] Failed to establish one or more app connections after inspection', error);
    }
  }

  /** Closes app-shared MCP sessions during graceful process shutdown. */
  public async disconnectAppServers(): Promise<void> {
    await Promise.all(this.appConnections?.disconnectAll() ?? []);
  }

  /** Returns tool functions with the generation bound to their originating user connection. */
  public async getServerToolFunctionsSnapshot(
    userId: string,
    serverName: string,
    serverConfig?: t.ParsedServerConfig,
    options?: {
      deadlineMs?: number;
      signal?: AbortSignal;
      capabilityProfile?: MCPClientCapabilityProfile;
    },
  ): Promise<{
    tools: t.LCAvailableTools | null;
    publicationGeneration?: string;
    publicationRevision?: string;
  }> {
    try {
      const signal = createDeadlineAbortSignal(options?.deadlineMs, options?.signal);
      const capabilityProfile = options?.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
      const readToolCatalog = (connection: MCPConnection) =>
        options == null
          ? MCPServerInspector.getToolCatalog(serverName, connection)
          : MCPServerInspector.getToolCatalog(serverName, connection, options.deadlineMs, signal);
      const registry = MCPServersRegistry.getInstance();
      const effectiveConfig = serverConfig ?? (await registry.getServerConfig(serverName, userId));
      const useAppConnection =
        capabilityProfile === STANDARD_MCP_CAPABILITY_PROFILE &&
        effectiveConfig != null &&
        canUseAppConnection(effectiveConfig) &&
        (await registry.isAppServerConfig(serverName, effectiveConfig));
      const existingAppConnection = useAppConnection
        ? await this.appConnections?.get(serverName)
        : null;
      if (existingAppConnection != null) {
        return readToolCatalog(existingAppConnection);
      }

      let awaitedRecovery: Promise<void> | undefined;
      while (true) {
        const userConnections = this.userConnections.get(userId);
        const connection = userConnections?.get(
          getMCPConnectionPoolKey(serverName, capabilityProfile),
        );
        if (!connection) {
          return { tools: null };
        }

        if (effectiveConfig == null) {
          await this.disconnectUserConnection(userId, serverName, { capabilityProfile });
          return { tools: null };
        }
        const connectionConfigGeneration = this.getToolConfigGeneration(connection);
        const effectiveConfigGeneration = getMCPAppToolsPublicationGeneration(effectiveConfig);
        if (
          connectionConfigGeneration != null &&
          effectiveConfigGeneration != null &&
          connectionConfigGeneration !== effectiveConfigGeneration
        ) {
          await this.disconnectUserConnection(userId, serverName, { capabilityProfile });
          return { tools: null };
        }
        const publicationGeneration = this.getToolPublicationGeneration(connection);
        const currentGeneration = await getMCPToolsChangedGeneration({ userId, serverName });
        if (
          publicationGeneration != null &&
          currentGeneration != null &&
          publicationGeneration !== currentGeneration
        ) {
          await this.disconnectUserConnection(userId, serverName, { capabilityProfile });
          return { tools: null };
        }

        this.retainConnection(connection);
        const recovery = this.oauthRecoveries.get(connection)?.promise;
        if (recovery && recovery !== awaitedRecovery) {
          awaitedRecovery = recovery;
          await this.releaseConnection(connection);
          await this.waitForConnectionRecovery(recovery, signal);
          continue;
        }

        try {
          const { tools } = await readToolCatalog(connection);
          const generationAfterFetch = await getMCPToolsChangedGeneration({ userId, serverName });
          if (
            publicationGeneration != null &&
            generationAfterFetch != null &&
            publicationGeneration !== generationAfterFetch
          ) {
            await this.disconnectUserConnection(userId, serverName, { capabilityProfile });
            return { tools: null };
          }
          return { tools, publicationGeneration };
        } finally {
          await this.releaseConnection(connection);
        }
      }
    } catch (error) {
      logger.warn(
        `[getServerToolFunctions] Error getting tool functions for server ${serverName}`,
        error,
      );
      return { tools: null };
    }
  }

  /** Returns all available tool functions from all connections available to user. */
  public async getServerToolFunctions(
    userId: string,
    serverName: string,
  ): Promise<t.LCAvailableTools | null> {
    return (await this.getServerToolFunctionsSnapshot(userId, serverName)).tools;
  }

  /**
   * Get instructions for MCP servers
   * @param serverNames Optional array of server names. If not provided or empty, returns all servers.
   * @returns Object mapping server names to their instructions
   */
  private async getInstructions(
    serverNames?: string[],
    configServers?: Record<string, t.ParsedServerConfig>,
  ): Promise<Record<string, string>> {
    const instructions: Record<string, string> = {};
    const configs = await MCPServersRegistry.getInstance().getAllServerConfigs(
      undefined,
      configServers,
    );
    for (const [serverName, config] of Object.entries(configs)) {
      const resolved = resolveServerInstructions(config);
      if (resolved != null) {
        instructions[serverName] = resolved;
      }
    }
    if (!serverNames) return instructions;
    return pick(instructions, serverNames);
  }

  /**
   * Format MCP server instructions for injection into context
   * @param serverNames Optional array of server names to include. If not provided, includes all servers.
   * @returns Formatted instructions string ready for context injection
   */
  public async formatInstructionsForContext(
    serverNames?: string[],
    configServers?: Record<string, t.ParsedServerConfig>,
  ): Promise<string> {
    const instructionsToInclude = await this.getInstructions(serverNames, configServers);

    if (Object.keys(instructionsToInclude).length === 0) {
      return '';
    }

    // Format instructions for context injection
    const formattedInstructions = Object.entries(instructionsToInclude)
      .map(([serverName, instructions]) => {
        return `## ${serverName} MCP Server Instructions

${instructions}`;
      })
      .join('\n\n');

    return `# MCP Server Instructions

The following MCP servers are available with their specific instructions:

${formattedInstructions}

Please follow these instructions when using tools from the respective MCP servers.`;
  }

  private async recoverOAuthConnection(
    connection: MCPConnection,
    error: unknown,
    serverName: string,
    userId: string,
    attachSharedOAuthHandler: (relay: OAuthLifecycleRelay) => () => void,
    oauthStart: t.OAuthStartHandler | undefined,
    oauthEnd: (() => Promise<void>) | undefined,
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
    signal?: AbortSignal,
    allowsTakeover = true,
    rejectedCredentialSetId?: string | null,
  ): Promise<void> {
    const existingRecovery = this.oauthRecoveries.get(connection);
    if (existingRecovery) {
      if (existingRecovery.callbacks) {
        await existingRecovery.callbacks.add({
          oauthStart,
          oauthEnd,
          flowManager,
          userId,
          serverName,
        });
      }
      try {
        return await this.waitForActiveRecovery(existingRecovery.promise, signal);
      } catch (recoveryError) {
        if (signal?.aborted) {
          throw recoveryError;
        }
        if (!allowsTakeover || !this.claimRecoveryTakeover(existingRecovery)) {
          throw recoveryError;
        }
        if (this.oauthRecoveries.get(connection) === existingRecovery) {
          this.oauthRecoveries.delete(connection);
        }
        throw new OAuthRecoveryTakeoverRequired();
      }
    }

    const callbacks = new OAuthLifecycleRelay({
      oauthStart,
      oauthEnd,
      logPrefix: `[MCP][User: ${userId}][${serverName}]`,
    });
    const recovery = Promise.resolve().then(async () => {
      const cleanupRequestOAuthHandler = attachSharedOAuthHandler(callbacks);
      try {
        await this.waitForOAuthRecovery(connection, () =>
          connection.emit('oauthReauthenticationRequired', {
            serverName,
            error,
            rejectedCredentialSetId,
            serverUrl: connection.url,
            userId,
          }),
        );
        await this.connectAfterOAuthRecovery(connection, async (connectError) => {
          await this.waitForOAuthRecovery(connection, () =>
            connection.emit('oauthReauthenticationRequired', {
              serverName,
              error: connectError,
              serverUrl: connection.url,
              userId,
              skipSilentRefresh: true,
            }),
          );
        });
      } finally {
        cleanupRequestOAuthHandler();
      }
    });

    const recoveryEntry = { promise: recovery, callbacks, allowsTakeover, takeoverClaimed: false };
    this.oauthRecoveries.set(connection, recoveryEntry);
    this.holdDeferredConnectionDisposal(connection);
    const clearRecovery = () => {
      if (this.oauthRecoveries.get(connection) === recoveryEntry) {
        this.oauthRecoveries.delete(connection);
      }
    };
    const releaseRecoveryDisposal = () => this.releaseDeferredConnectionDisposal(connection);
    void recovery.then(clearRecovery, clearRecovery);
    void recovery.then(releaseRecoveryDisposal, releaseRecoveryDisposal);
    await this.waitForActiveRecovery(recovery, signal);
  }

  private recoverDirectOpenIDBearerConnection({
    connection,
    serverName,
    serverConfig,
    user,
    flowManager,
    tokenMethods,
    oauthStart,
    oauthEnd,
    customUserVars,
    requestBody,
    requestScopedConnections,
    graphTokenResolver,
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    oboIdentityContext,
    onOAuthCredentialsChanged,
    onOAuthCredentialsChanging,
    signal,
    directBearerRecoveryState = { attempted: true },
  }: {
    connection: MCPConnection;
    serverName: string;
    serverConfig: t.ParsedServerConfig;
    user: IUser;
    flowManager: FlowStateManager<MCPOAuthTokens | null>;
    tokenMethods?: TokenMethods;
    oauthStart?: t.OAuthStartHandler;
    oauthEnd?: () => Promise<void>;
    customUserVars?: Record<string, string>;
    requestBody?: RequestBody;
    requestScopedConnections?: t.RequestScopedMCPConnectionStore;
    graphTokenResolver?: GraphTokenResolver;
    upstreamTokenProvider?: UpstreamTokenProvider;
    upstreamTokenProviderResolver?: UpstreamTokenProviderResolver;
    oboIdentityContext?: AuthIdentityContext;
    onOAuthCredentialsChanged?: t.UserConnectionContext['onOAuthCredentialsChanged'];
    onOAuthCredentialsChanging?: t.UserConnectionContext['onOAuthCredentialsChanging'];
    signal?: AbortSignal;
    directBearerRecoveryState?: t.DirectBearerRecoveryState;
  }): Promise<void> {
    const existing = this.oauthRecoveries.get(connection);
    if (existing) {
      return this.waitForActiveRecovery(existing.promise, signal).then(() => {
        if (existing.directBearerRecoveryState) {
          Object.assign(directBearerRecoveryState, existing.directBearerRecoveryState);
        }
      });
    }

    const capabilityProfile = connection.capabilityProfile;
    const mutationFence = this.createConnectionMutationFence(
      user.id,
      serverName,
      capabilityProfile,
    );
    const recoveryController = new AbortController();
    const recoverySignal = recoveryController.signal;
    const recovery = Promise.resolve().then(async () => {
      let replacementPromise: Promise<MCPConnection>;
      try {
        recoverySignal.throwIfAborted();
        const refreshedConfig = await resolveDirectOpenIDBearerConfig({
          config: applyRequestHeaders(serverConfig),
          upstreamTokenProvider,
          forceRefresh: true,
          signal: recoverySignal,
        });
        directBearerRecoveryState.resolvedConfig = refreshedConfig;
        recoverySignal.throwIfAborted();
        connection.stopReconnecting();
        await this.waitForConnectionBorrowersToDrain(connection);
        recoverySignal.throwIfAborted();
        const requestConnectionKey = getMCPUserConnectionPoolKey(
          user.id,
          serverName,
          capabilityProfile,
        );
        if (requestScopedConnections?.connections.get(requestConnectionKey) === connection) {
          requestScopedConnections.connections.delete(requestConnectionKey);
          await this.disposeEvictedConnection(
            connection,
            `[MCP][Request-scoped: ${requestConnectionKey}]`,
          );
        }
        mutationFence.assertCurrent();
        recoverySignal.throwIfAborted();
        /** Invocation is synchronous through the replacement's own guard registration, closing
         * the mutation window before this outer reservation is released. */
        replacementPromise = this.getUserConnection({
          serverName,
          serverConfig,
          user,
          forceNew: true,
          flowManager,
          tokenMethods,
          oauthStart,
          oauthEnd,
          customUserVars,
          requestBody,
          requestScopedConnections,
          graphTokenResolver,
          upstreamTokenProvider,
          upstreamTokenProviderResolver,
          oboIdentityContext,
          onOAuthCredentialsChanged,
          onOAuthCredentialsChanging,
          directBearerRecoveryState,
          directBearerResolvedConfig: refreshedConfig,
          signal: recoverySignal,
          capabilityProfile,
        });
      } finally {
        mutationFence.release();
      }
      const replacement = await replacementPromise;
      if (requiresEphemeralUserConnection(serverConfig) && !requestScopedConnections) {
        await this.disposeEvictedConnection(
          replacement,
          `[MCP][User: ${user.id}][${serverName}] Unowned recovery replacement`,
        );
      }
    });
    const recoveryEntry = {
      promise: recovery,
      allowsTakeover: false,
      directBearerRecoveryConsumed: true,
      directBearerRecoveryState,
    };
    this.recoveryCancellation.set(recovery, {
      controller: recoveryController,
      waiters: 0,
      connection,
    });
    this.oauthRecoveries.set(connection, recoveryEntry);
    const clearRecovery = () => {
      if (this.oauthRecoveries.get(connection) === recoveryEntry) {
        this.oauthRecoveries.delete(connection);
      }
    };
    void recovery.then(clearRecovery, clearRecovery);
    return this.waitForActiveRecovery(recovery, signal);
  }

  private async connectAfterOAuthRecovery(
    connection: MCPConnection,
    requestInteractiveRecovery: (error: unknown) => Promise<void>,
  ): Promise<void> {
    await this.waitForConnectionBorrowersToDrain(connection);
    const firstAttempt = await this.connectWithTransientRetries(connection);
    if (firstAttempt.connected) {
      return;
    }
    if (!firstAttempt.oauthHandled) {
      throw firstAttempt.error;
    }
    if (firstAttempt.source === 'silent-refresh') {
      await requestInteractiveRecovery(firstAttempt.error);
    }

    const secondAttempt = await this.connectWithTransientRetries(connection);
    if (!secondAttempt.connected) {
      throw secondAttempt.error;
    }
  }

  private async connectWithTransientRetries(
    connection: MCPConnection,
  ): Promise<OAuthReconnectResult> {
    let result: OAuthReconnectResult | undefined;
    for (let attempt = 1; attempt <= OAUTH_RECOVERY_RECONNECT_ATTEMPTS; attempt++) {
      result = await this.connectOnceAfterOAuth(connection);
      if (
        result.connected ||
        result.oauthHandled ||
        connection.isOAuthAuthenticationError(result.error) ||
        attempt === OAUTH_RECOVERY_RECONNECT_ATTEMPTS
      ) {
        return result;
      }
      await this.waitForOAuthReconnectRetry(attempt);
    }
    return result!;
  }

  private waitForOAuthReconnectRetry(attempt: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, OAUTH_RECOVERY_RECONNECT_DELAY_MS * attempt);
    });
  }

  private async connectOnceAfterOAuth(connection: MCPConnection): Promise<OAuthReconnectResult> {
    let oauthHandled = false;
    let source: t.OAuthHandledSource | undefined;
    const handleOAuth = (handledSource?: t.OAuthHandledSource) => {
      oauthHandled = true;
      source = handledSource;
    };
    connection.on('oauthHandled', handleOAuth);
    try {
      await connection.connect();
      return { connected: true };
    } catch (error) {
      return { connected: false, error, oauthHandled, source };
    } finally {
      connection.off('oauthHandled', handleOAuth);
    }
  }

  private waitForOAuthRecovery(
    connection: MCPConnection,
    requestRecovery: () => boolean,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        connection.off('oauthHandled', handleSuccess);
        connection.off('oauthFailed', handleFailure);
      };
      const handleSuccess = () => {
        cleanup();
        resolve();
      };
      const handleFailure = (oauthError: Error) => {
        cleanup();
        reject(oauthError);
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`OAuth recovery timeout after ${mcpConfig.OAUTH_HANDLING_TIMEOUT}ms`));
      }, mcpConfig.OAUTH_HANDLING_TIMEOUT);

      connection.once('oauthHandled', handleSuccess);
      connection.once('oauthFailed', handleFailure);

      let recoveryRequested: boolean;
      try {
        recoveryRequested = requestRecovery();
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (recoveryRequested) {
        return;
      }
      cleanup();
      reject(new Error('OAuth recovery requested without an active request handler'));
    });
  }

  public clearResourceUriCache(serverName?: string, userId?: string): void {
    if (serverName) {
      for (const key of this.resourceUriCache.keys()) {
        const [keyServerName, keyUserId] = JSON.parse(key) as [string, string | null, string];
        if (keyServerName === serverName && (userId == null || keyUserId === userId)) {
          this.resourceUriCache.delete(key);
          this.appHiddenToolCache.delete(key);
          this.knownToolNamesCache.delete(key);
          this.toolCacheConnStamp.delete(key);
        }
      }
    } else {
      this.resourceUriCache.clear();
      this.appHiddenToolCache.clear();
      this.knownToolNamesCache.clear();
      this.toolCacheConnStamp.clear();
    }
  }

  /**
   * App-level connections can be recreated when a server config changes, so cached tool metadata
   * is only valid while it was built from the current connection instance.
   */
  private connStamp(connection: MCPConnection): string {
    return `${connection.createdAt}:${connection.toolListVersion}`;
  }

  /**
   * Scope for the tool-metadata caches. An app-level connection is shared
   * by every user, and nothing clears its entries (`removeUserConnection` only runs for user-scoped
   * connections), so keying it per user would retain one entry set per user for the process lifetime.
   * User-scoped connections (OAuth/OBO/customUserVars/runtime placeholders) are distinct connections
   * that can expose different tools and different visibility per user, so those keep their per-user
   * key. Decided by connection identity rather than by re-deriving the config's connection scope.
   */
  private cacheScope(serverName: string, connection: MCPConnection, userId?: string): string {
    if (this.appConnections?.getPooledConnection(serverName) === connection) {
      return JSON.stringify([serverName, null, STANDARD_MCP_CAPABILITY_PROFILE]);
    }
    return JSON.stringify([serverName, userId ?? null, connection.capabilityProfile]);
  }

  private isToolCacheFresh(cacheKey: string, connection: MCPConnection): boolean {
    return (
      this.knownToolNamesCache.has(cacheKey) &&
      this.toolCacheConnStamp.get(cacheKey) === this.connStamp(connection)
    );
  }

  protected override removeUserConnection(
    userId: string,
    serverName: string,
    capabilityProfile: MCPClientCapabilityProfile,
  ): void {
    this.clearResourceUriCache(serverName, userId);
    super.removeUserConnection(userId, serverName, capabilityProfile);
  }

  private async buildToolCaches(
    connection: MCPConnection,
    signal?: AbortSignal,
  ): Promise<{
    serverMap: Map<string, { uri: string }>;
    appHidden: Set<string>;
    knownNames: Set<string>;
    complete: boolean;
    connectionStamp: string;
  }> {
    const { tools, complete } = await connection.fetchOrderedToolsSnapshot(undefined, signal);
    const connectionStamp = this.connStamp(connection);
    const serverMap = new Map<string, { uri: string }>();
    const appHidden = new Set<string>();
    const knownNames = new Set<string>();
    for (const tool of tools) {
      knownNames.add(tool.name);
      if (isToolHiddenFromApp(tool)) {
        appHidden.add(tool.name);
      }
      // A malformed `_meta.ui.resourceUri` on one tool only disables that tool's UI metadata,
      // never aborting discovery for the whole server.
      try {
        const uri = getToolUiResourceUri(tool);
        if (uri) {
          serverMap.set(tool.name, { uri });
        }
      } catch (error) {
        logger.warn(`[MCP] Ignoring invalid UI resource metadata on tool "${tool.name}":`, error);
      }
    }
    return { serverMap, appHidden, knownNames, complete, connectionStamp };
  }

  private async populateToolCaches(
    connection: MCPConnection,
    cacheKey: string,
    signal?: AbortSignal,
  ): Promise<void> {
    const { serverMap, appHidden, knownNames, complete, connectionStamp } =
      await this.buildToolCaches(connection, signal);
    // These caches validate app tool calls and associate tools with their declared UI resource, so
    // a page missing from a partial `tools/list` is a false denial rather than a missing feature. An incomplete
    // snapshot (and an empty one, which a transient failure and a genuinely tool-less server both
    // produce) is left unpublished so the next call re-fetches instead of denying until reconnect.
    // A snapshot truncated by a tools/list budget cap reports complete and is cached, for the same
    // reason the advertisement snapshot caches its cap-truncated form: it is reproducible, so
    // re-fetching it on every call pays the full listing cost without widening the result.
    if (!complete || knownNames.size === 0 || connectionStamp !== this.connStamp(connection)) {
      return;
    }
    this.resourceUriCache.set(cacheKey, serverMap);
    this.appHiddenToolCache.set(cacheKey, appHidden);
    this.knownToolNamesCache.set(cacheKey, knownNames);
    this.toolCacheConnStamp.set(cacheKey, connectionStamp);
  }

  private async getResourceMeta(
    connection: MCPConnection,
    serverName: string,
    toolName: string,
    userId?: string,
    requestScoped = false,
    signal?: AbortSignal,
  ): Promise<{ uri: string } | undefined> {
    // Request-scoped servers may expose different tool metadata per request, so their
    // resourceUri/visibility must not be reused from the serverName:userId cache.
    if (requestScoped) {
      const { serverMap, complete, connectionStamp } = await this.buildToolCaches(
        connection,
        signal,
      );
      if (!complete || connectionStamp !== this.connStamp(connection)) {
        return undefined;
      }
      return serverMap.get(toolName);
    }
    const cacheKey = this.cacheScope(serverName, connection, userId);
    if (!this.isToolCacheFresh(cacheKey, connection)) {
      await this.populateToolCaches(connection, cacheKey, signal);
    }
    if (!this.isToolCacheFresh(cacheKey, connection)) {
      return undefined;
    }
    return this.resourceUriCache.get(cacheKey)?.get(toolName);
  }

  /**
   * Calls a tool on an MCP server, using either a user-specific connection
   * (if userId is provided) or an app-level connection. Updates the last activity timestamp
   * for user-specific connections upon successful call initiation.
   *
   * @param graphTokenResolver - Optional function to resolve Graph API tokens via OBO flow.
   *   When provided and the server config contains `{{LIBRECHAT_GRAPH_ACCESS_TOKEN}}` placeholders,
   *   they will be resolved to actual Graph API tokens before the tool call.
   */
  async callTool({
    user,
    serverName,
    serverConfig: providedConfig,
    toolName,
    provider,
    toolArguments,
    options,
    tokenMethods,
    requestBody,
    requestScopedConnections,
    flowManager,
    oauthStart,
    oauthEnd,
    customUserVars,
    graphTokenResolver,
    oboTokenResolver,
    oboTrustChecker,
    upstreamTokenProvider,
    upstreamTokenProviderResolver,
    oboIdentityContext,
    onOAuthCredentialsChanged,
    onOAuthCredentialsChanging,
    mcpApps,
  }: {
    user?: IUser;
    serverName: string;
    /** Pre-resolved config from tool creation context — avoids readThrough TTL and cross-tenant issues */
    serverConfig?: t.ParsedServerConfig;
    toolName: string;
    provider: t.Provider;
    toolArguments?: Record<string, unknown>;
    options?: RequestOptions;
    requestBody?: RequestBody;
    requestScopedConnections?: t.RequestScopedMCPConnectionStore;
    tokenMethods?: TokenMethods;
    customUserVars?: Record<string, string>;
    flowManager: FlowStateManager<MCPOAuthTokens | null>;
    oauthStart?: t.OAuthStartHandler;
    oauthEnd?: () => Promise<void>;
    graphTokenResolver?: GraphTokenResolver;
    oboTokenResolver?: OboTokenResolver;
    oboTrustChecker?: OboTrustChecker;
    upstreamTokenProvider?: UpstreamTokenProvider;
    upstreamTokenProviderResolver?: UpstreamTokenProviderResolver;
    oboIdentityContext?: AuthIdentityContext;
    onOAuthCredentialsChanged?: t.UserConnectionContext['onOAuthCredentialsChanged'];
    onOAuthCredentialsChanging?: t.UserConnectionContext['onOAuthCredentialsChanging'];
    mcpApps?: TMCPAppsPolicy;
  }): Promise<t.FormattedToolResponse> {
    const userId = user?.id;
    const capabilityProfile = resolveMCPClientCapabilityProfile(mcpApps);
    const logPrefix = userId ? `[MCP][User: ${userId}][${serverName}]` : `[MCP][${serverName}]`;
    this.bindRequestScopedConnectionStore(requestScopedConnections);
    let recoveryTakeoverConsumed = false;
    const directBearerRecoveryState: t.DirectBearerRecoveryState = { attempted: false };
    while (true) {
      /** User-specific connection */
      let connection: MCPConnection | undefined;
      let checkedOutTarget: t.MCPConnectionTarget | undefined;
      let connectionRetained = false;
      let deferredDisposalHeld = false;
      let attachSharedOAuthHandler: ((relay: OAuthLifecycleRelay) => () => void) | undefined;
      let disposeAfterCall = false;
      const retainConnectionLease = () => {
        if (!connection || connectionRetained) {
          return;
        }
        this.retainConnection(connection);
        connectionRetained = true;
      };
      const releaseConnectionLease = async (preserveDisposalHold = false) => {
        if (!connection || !connectionRetained) {
          return;
        }
        if (deferredDisposalHeld && !preserveDisposalHold) {
          await this.releaseDeferredConnectionDisposal(connection);
          deferredDisposalHeld = false;
        }
        connectionRetained = false;
        await this.releaseConnection(connection);
      };
      const waitForRecoveryWithoutLease = async (startRecovery: () => Promise<void>) => {
        const recovery = startRecovery();
        // Keep an eviction marker across the temporary lease gap and transfer that
        // responsibility back to this caller after recovery. An unrelated final
        // borrower may disconnect the old client, but cannot consume the marker.
        if (!deferredDisposalHeld) {
          this.holdDeferredConnectionDisposal(connection!);
          deferredDisposalHeld = true;
        }
        await releaseConnectionLease(true);
        try {
          await recovery;
        } finally {
          retainConnectionLease();
        }
      };

      try {
        let awaitedCheckoutRecovery: Promise<void> | undefined;
        while (true) {
          ({ connection, connectionTarget: checkedOutTarget } = await this.checkoutConnection({
            serverName,
            user,
            flowManager,
            tokenMethods,
            oauthStart,
            oauthEnd,
            oboTokenResolver,
            oboTrustChecker,
            upstreamTokenProvider,
            upstreamTokenProviderResolver,
            oboIdentityContext,
            onOAuthCredentialsChanged,
            onOAuthCredentialsChanging,
            graphTokenResolver,
            signal: options?.signal,
            customUserVars,
            requestBody,
            requestScopedConnections,
            serverConfig: providedConfig,
            directBearerRecoveryState,
            capabilityProfile,
          }));
          retainConnectionLease();
          const checkoutRecovery = this.oauthRecoveries.get(connection);
          if (!checkoutRecovery || checkoutRecovery.promise === awaitedCheckoutRecovery) {
            break;
          }
          if (checkoutRecovery.directBearerRecoveryConsumed) {
            directBearerRecoveryState.attempted = true;
          }
          if (checkoutRecovery.callbacks) {
            await checkoutRecovery.callbacks.add({
              oauthStart,
              oauthEnd,
              flowManager,
              userId: userId!,
              serverName,
            });
          }
          awaitedCheckoutRecovery = checkoutRecovery.promise;
          await releaseConnectionLease();
          try {
            await this.waitForConnectionRecovery(checkoutRecovery.promise, options?.signal);
            if (checkoutRecovery.directBearerRecoveryState) {
              Object.assign(directBearerRecoveryState, checkoutRecovery.directBearerRecoveryState);
            }
          } catch (recoveryError) {
            if (
              options?.signal?.aborted ||
              recoveryTakeoverConsumed ||
              !this.claimRecoveryTakeover(checkoutRecovery)
            ) {
              throw recoveryError;
            }
            recoveryTakeoverConsumed = true;
            if (this.oauthRecoveries.get(connection) === checkoutRecovery) {
              this.oauthRecoveries.delete(connection);
            }
            continue;
          }
        }

        const registry = MCPServersRegistry.getInstance();
        const declaredConfig =
          providedConfig ?? (await registry.getServerConfig(serverName, userId));
        /** Folded in before scope detection, Graph preprocessing and
         *  direct-bearer resolution, so this pipeline sees the same single
         *  header map the factory does. */
        const rawConfig = declaredConfig && applyRequestHeaders(declaredConfig);
        if (!rawConfig || !declaredConfig) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `${logPrefix} Configuration for server "${serverName}" not found.`,
          );
        }
        const isDbSourced = isUserSourced(rawConfig);
        const ephemeralConnection = !!userId && requiresEphemeralUserConnection(rawConfig);
        disposeAfterCall = ephemeralConnection && !requestScopedConnections;

        /** Plugin-authored placeholders must not resolve against the user's Graph token. */
        const graphProcessedConfig =
          isDbSourced || isPluginSourced(rawConfig)
            ? (rawConfig as t.MCPOptions)
            : await preProcessGraphTokens(rawConfig as t.MCPOptions, {
                user,
                graphTokenResolver,
                scopes: process.env.GRAPH_API_SCOPES,
              });
        const directBearerRecovery = usesDirectOpenIDBearerRecovery(rawConfig);
        const bearerConfig = await resolveDirectOpenIDBearerConfig({
          config: graphProcessedConfig,
          upstreamTokenProvider,
          resolvedConfig: directBearerRecoveryState.resolvedConfig,
          signal: options?.signal,
        });
        const currentOptions = processMCPEnv({
          user,
          body: requestBody,
          dbSourced: isDbSourced,
          options: bearerConfig,
          customUserVars,
        });

        const resolvedHeaders: Record<string, string> =
          'headers' in currentOptions ? { ...(currentOptions.headers || {}) } : {};

        const oboConfig = rawConfig.obo;
        const usesObo = Boolean(oboConfig && oboTokenResolver && user);
        let oboUpstreamTokenProvider = upstreamTokenProvider;

        /**
         * Resolves the downstream token for this call and installs it as the request
         * bearer. `forceRefresh` bypasses the resolver's cache, which is what a
         * rejected credential needs: a revoked or scope-invalidated token is still
         * inside its cached lifetime, so a cached read returns the same dead bearer.
         */
        const applyOboAuthorization = async (forceRefresh: boolean): Promise<void> => {
          if (!oboConfig || !oboTokenResolver || !user) {
            return;
          }
          if (!oboUpstreamTokenProvider && upstreamTokenProviderResolver) {
            oboUpstreamTokenProvider = createLazyOboUpstreamTokenProvider(
              upstreamTokenProviderResolver,
              options?.signal,
              { mcpServer: serverName, scopes: oboConfig.scopes },
            );
          }
          if (!oboUpstreamTokenProvider) {
            const missing = new OboTokenResolutionError(
              'missing_upstream_provider',
              'No upstream credential provider is configured for this OBO MCP tool.',
            );
            throw Object.assign(
              new McpError(
                ErrorCode.InternalError,
                createOboToolCallErrorMessage(logPrefix, toolName, missing),
              ),
              { cause: missing },
            );
          }
          const oboTrusted = oboTrustChecker
            ? await oboTrustChecker({
                source: rawConfig.source,
                author: rawConfig.author,
                dbId: rawConfig.dbId,
              })
            : true;
          if (!oboTrusted) {
            logger.warn(
              `${logPrefix} OBO config not trusted (author lacks ${PermissionTypes.MCP_SERVERS}.${Permissions.CONFIGURE_OBO}); refusing to mint a downstream token`,
            );
            throw new McpError(
              ErrorCode.InternalError,
              `${logPrefix} OBO is not permitted for server "${serverName}". The user who configured it no longer has permission to use OBO.`,
            );
          }
          let oboTokens: MCPOAuthTokens;
          try {
            oboTokens = await awaitOboOperation(
              resolveOboToken(
                user,
                oboConfig,
                oboTokenResolver,
                oboUpstreamTokenProvider,
                oboIdentityContext,
                forceRefresh,
              ),
              options?.signal,
            );
          } catch (error) {
            if (error instanceof OboTokenResolutionError) {
              const failure = new McpError(
                ErrorCode.InternalError,
                createOboToolCallErrorMessage(logPrefix, toolName, error),
              );
              if (error.reason === 'missing_upstream_provider') {
                throw Object.assign(failure, { cause: error });
              }
              throw failure;
            }
            throw error;
          }

          if (!oboTokens.access_token) {
            throw new McpError(
              ErrorCode.InternalError,
              `${logPrefix} OBO token refresh failed. Cannot execute tool ${toolName}. Re-authenticate the user and retry.`,
            );
          }
          resolvedHeaders['Authorization'] = `Bearer ${oboTokens.access_token}`;
          /**
           * Runtime request headers do not reach a legacy SSE connection's event
           * stream — `eventSourceInit.fetch` bypasses `createFetchFunction` and sends
           * the headers `constructTransport` captured from `oauthTokens`. Without
           * this the next transport rebuild re-bakes the rejected bearer, 401s, and
           * retires a connection that had already recovered.
           */
          connection!.setOAuthTokens(oboTokens);
        };

        /** Resolve the current OBO token for this tool call; the resolver may serve cached tokens. */
        await applyOboAuthorization(false);
        if (
          userId &&
          user &&
          oauthStart &&
          flowManager &&
          (isOAuthServer(currentOptions) || connection.usesOAuth())
        ) {
          const { allowedDomains, allowedAddresses, useSSRFProtection } =
            await registry.resolveAllowlists({ userId, role: user?.role });
          attachSharedOAuthHandler = (relay) =>
            MCPConnectionFactory.attachRequestOAuthHandler(
              {
                serverName,
                serverConfig: currentOptions,
                serverDefinition: declaredConfig,
                dbSourced: isDbSourced,
                skipEnvProcessing: true,
                useSSRFProtection,
                allowedDomains,
                allowedAddresses,
                capabilityProfile,
              },
              {
                useOAuth: true,
                user,
                flowManager,
                tokenMethods,
                oauthStart: relay.start,
                oauthEnd: relay.end,
                customUserVars,
                requestBody,
                onOAuthCredentialsChanged,
                onOAuthCredentialsChanging,
                onOAuthCredentialsInvalidated: () =>
                  getMCPToolsChangedGeneration({ userId, serverName }),
              },
              connection!,
            );
        }

        connection.setRequestHeaders(resolvedHeaders);

        const checkedCredentialSetId = connection.getOAuthCredentialSetId?.();
        const connectionIsActive = await connection.isConnected(options?.signal);
        const recordedCredentialSetId = connection.getLastConnectionCheckCredentialSetId?.();
        const connectionCheckError = connectionIsActive
          ? undefined
          : connection.getLastConnectionCheckError();

        if (
          !connectionIsActive &&
          (!userId || !connection.isOAuthAuthenticationError(connectionCheckError))
        ) {
          /** May happen if getUserConnection failed silently or app connection dropped */
          throw new McpError(
            ErrorCode.InternalError,
            `${logPrefix} Connection is not active. Cannot execute tool ${toolName}.`,
          );
        }

        if (
          !connectionIsActive &&
          directBearerRecovery &&
          userId &&
          user &&
          isMCPTransportAuthenticationError(connectionCheckError)
        ) {
          if (directBearerRecoveryState.attempted) {
            throw new MCPAuthenticationRejectedError(serverName, false, connectionCheckError);
          }
          directBearerRecoveryState.attempted = true;
          const recovery = this.recoverDirectOpenIDBearerConnection({
            connection,
            serverName,
            serverConfig: declaredConfig,
            user,
            flowManager,
            tokenMethods,
            oauthStart,
            oauthEnd,
            customUserVars,
            requestBody,
            requestScopedConnections,
            graphTokenResolver,
            upstreamTokenProvider,
            upstreamTokenProviderResolver,
            oboIdentityContext,
            onOAuthCredentialsChanged,
            onOAuthCredentialsChanging,
            signal: options?.signal,
            directBearerRecoveryState,
          });
          await releaseConnectionLease();
          await recovery;
          continue;
        }

        if (!connectionIsActive) {
          const requestOAuthHandler = attachSharedOAuthHandler;
          if (!requestOAuthHandler || !userId) {
            throw new McpError(
              ErrorCode.InternalError,
              `${logPrefix} Connection is not active. Cannot execute tool ${toolName}.`,
            );
          }

          try {
            await waitForRecoveryWithoutLease(() =>
              this.recoverOAuthConnection(
                connection!,
                connectionCheckError,
                serverName,
                userId,
                requestOAuthHandler,
                oauthStart,
                oauthEnd,
                flowManager,
                options?.signal,
                !recoveryTakeoverConsumed,
                recordedCredentialSetId !== undefined
                  ? recordedCredentialSetId
                  : checkedCredentialSetId,
              ),
            );
          } catch (recoveryError) {
            if (recoveryError instanceof OAuthRecoveryTakeoverRequired) {
              throw recoveryError;
            }
            if (options?.signal?.aborted) {
              throw recoveryError;
            }
            logger.warn(
              `${logPrefix}[${toolName}] Connection-check OAuth recovery failed`,
              recoveryError,
            );
            throw connectionCheckError;
          }
        }

        const requestTool = () =>
          withMCPRequestSignal(options?.signal, (signal) =>
            connection!.client.request(
              {
                method: 'tools/call',
                params: {
                  name: toolName,
                  arguments: toolArguments,
                },
              },
              CallToolResultSchema,
              {
                timeout: connection!.timeout,
                resetTimeoutOnProgress: true,
                ...options,
                signal,
              },
            ),
          );

        // Deliberately use `request`: the typed wrapper also enforces the tool's output schema and
        // rejects task-required tools, which would turn a server response into a host-side failure.
        const requestedCredentialSetId = connection.getOAuthCredentialSetId?.();
        let result: Awaited<ReturnType<typeof requestTool>>;
        try {
          result = await requestTool();
        } catch (error) {
          if (directBearerRecovery && user && isMCPTransportAuthenticationError(error)) {
            if (directBearerRecoveryState.attempted) {
              throw new MCPAuthenticationRejectedError(serverName, false, error);
            }
            directBearerRecoveryState.attempted = true;
            const recovery = this.recoverDirectOpenIDBearerConnection({
              connection,
              serverName,
              serverConfig: declaredConfig,
              user,
              flowManager,
              tokenMethods,
              oauthStart,
              oauthEnd,
              customUserVars,
              requestBody,
              requestScopedConnections,
              graphTokenResolver,
              upstreamTokenProvider,
              upstreamTokenProviderResolver,
              oboIdentityContext,
              onOAuthCredentialsChanged,
              onOAuthCredentialsChanging,
              signal: options?.signal,
              directBearerRecoveryState,
            });
            await releaseConnectionLease();
            await recovery;
            throw new MCPAuthenticationRejectedError(serverName, true, error);
          }
          /**
           * An OBO server rejecting the bearer mid-session is recoverable here and
           * nowhere else: the downstream token is minted from the upstream session
           * this request still holds, and `attachSharedOAuthHandler` is never set for
           * an OBO-only config, so the OAuth recovery below would rethrow untouched.
           * Without this the rejected token is re-served from cache on every later
           * call until it expires.
           */
          if (usesObo && connection.isOAuthAuthenticationError(error)) {
            logger.info(
              `${logPrefix}[${toolName}] OBO token rejected by server; re-exchanging and retrying once`,
            );
            await applyOboAuthorization(true);
            connection.setRequestHeaders(resolvedHeaders);
            result = await requestTool();
          } else {
            const requestOAuthHandler = attachSharedOAuthHandler;
            if (!requestOAuthHandler || !userId) {
              throw error;
            }

            if (!connection.isOAuthAuthenticationError(error)) {
              throw error;
            }

            try {
              await waitForRecoveryWithoutLease(() =>
                this.recoverOAuthConnection(
                  connection!,
                  error,
                  serverName,
                  userId,
                  requestOAuthHandler,
                  oauthStart,
                  oauthEnd,
                  flowManager,
                  options?.signal,
                  !recoveryTakeoverConsumed,
                  requestedCredentialSetId,
                ),
              );
            } catch (recoveryError) {
              if (recoveryError instanceof OAuthRecoveryTakeoverRequired) {
                throw recoveryError;
              }
              if (options?.signal?.aborted) {
                throw recoveryError;
              }
              logger.warn(`${logPrefix}[${toolName}] Runtime OAuth recovery failed`, recoveryError);
              throw error;
            }
            result = await requestTool();
          }
        }
        const hasPersistentUserConnections =
          !!userId && (this.userConnections.get(userId)?.size ?? 0) > 0;
        if (!ephemeralConnection && hasPersistentUserConnections) {
          await this.updateUserLastActivity(userId);
        }
        this.checkIdleConnections();
        const toolResult = result as t.MCPToolCallResponse;
        const admittedMCPApps = mcpApps ?? DEFAULT_MCP_APPS_POLICY;

        // The app routes reject OBO, Graph-token, and runtime body-placeholder configs, so do not
        // advertise an app bridge for a tool whose follow-up requests cannot be served.
        const appCompatible =
          !rawConfig ||
          (!rawConfig.obo &&
            !(!isDbSourced && mcpOptionsContainGraphTokenPlaceholder(rawConfig as t.MCPOptions)) &&
            getMissingRuntimeBodyPlaceholderFields(rawConfig).length === 0);

        let resourceMeta: { uri: string } | undefined;
        if (admittedMCPApps.enabled && appCompatible && !options?.signal?.aborted) {
          try {
            resourceMeta = await this.getResourceMeta(
              connection,
              serverName,
              toolName,
              userId,
              requiresEphemeralUserConnection(rawConfig),
              options?.signal,
            );
          } catch {
            /* empty */
          }
        }
        if (options?.signal?.aborted) {
          resourceMeta = undefined;
        } else if (resourceMeta) {
          logger.debug(`[MCP][${serverName}][${toolName}] Found resourceUri: ${resourceMeta.uri}`);
        }

        let resolvedAppResource: t.ResourceContents | undefined;
        const appConnection = connection;
        if (resourceMeta && appConnection && !options?.signal?.aborted) {
          const resourceUri = resourceMeta.uri;
          try {
            const limits = getMCPAppOperationLimits(mcpApps?.operationLimits);
            const readResult = await this.appOperationBudget.run(
              options?.signal ?? new AbortController().signal,
              (signal) =>
                appConnection.client.readResource(
                  { uri: resourceUri },
                  {
                    timeout: Math.min(appConnection.timeout ?? limits.timeoutMs, limits.timeoutMs),
                    maxTotalTimeout: limits.timeoutMs,
                    signal,
                  },
                ),
              limits,
            );
            if (!options?.signal?.aborted) {
              resolvedAppResource = selectResolvedAppResource(readResult.contents, resourceUri);
            }
            if (!resolvedAppResource) {
              logger.warn(
                `[MCP][${serverName}][${toolName}] App resource "${resourceUri}" did not return usable App content; retaining bound URI for a later read`,
              );
            }
          } catch (error) {
            if (!options?.signal?.aborted) {
              logger.warn(
                `[MCP][${serverName}][${toolName}] Could not resolve App resource "${resourceUri}"; retaining bound URI for a later read`,
                error,
              );
            }
            if (options?.signal?.aborted) {
              resourceMeta = undefined;
            }
          }
        }

        if (options?.signal?.aborted) {
          resourceMeta = undefined;
          resolvedAppResource = undefined;
        }

        const serverBinding =
          resourceMeta && connection && checkedOutTarget && userId && this.appBindingCodec
            ? this.appBindingCodec.create(
                this.getAppBindingSubject(
                  serverName,
                  userId,
                  user?.tenantId,
                  checkedOutTarget,
                  connection,
                ),
              )
            : undefined;
        if (resourceMeta && !serverBinding) {
          resourceMeta = undefined;
          resolvedAppResource = undefined;
        }

        return formatToolContent(
          toolResult,
          provider,
          appCompatible
            ? {
                serverName,
                toolName,
                resourceUri: resourceMeta?.uri,
                resolvedAppResource,
                serverBinding,
                toolArgs: toolArguments,
                mcpApps: admittedMCPApps,
              }
            : { mcpApps: admittedMCPApps },
        );
      } catch (error) {
        if (error instanceof OAuthRecoveryTakeoverRequired) {
          recoveryTakeoverConsumed = true;
          continue;
        }
        /** A user Stop aborts the in-flight request; that rejection is the
         *  cancellation working, not a fault, so it stays out of the error log.
         *  The error must look like an abort too — a real failure can reject in
         *  the same tick as the Stop and has to stay visible. */
        if (isOwnedAbortError(error, options?.signal)) {
          logger.debug(`${logPrefix}[${toolName}] Tool call cancelled by user abort`);
          throw error;
        }
        // Log with context and re-throw or handle as needed
        logger.error(`${logPrefix}[${toolName}] Tool call failed`, error);
        // Rethrowing allows the caller (createMCPTool) to handle the final user message
        throw error;
      } finally {
        await releaseConnectionLease();
        // Ephemeral connections are never stored in userConnections, so disposing
        // is the only cleanup needed; removing the map entry here could orphan a
        // still-connected cached connection from before a config change.
        if (disposeAfterCall && connection) {
          await this.disposeEvictedConnection(
            connection,
            `${logPrefix}[${toolName}] Ephemeral connection`,
          );
        }
      }
    }
  }

  private getAppServerConfig(context: MCPAppValidationContext): t.ParsedServerConfig {
    const { serverName, user, connectionTarget } = context;
    const { serverConfig: config } = connectionTarget;
    const logPrefix = `[MCP][User: ${user.id}][${serverName}]`;
    if (config.obo) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${logPrefix} Server "${serverName}" requires per-call OBO token resolution which is not supported for app requests.`,
      );
    }
    if (!isUserSourced(config) && mcpOptionsContainGraphTokenPlaceholder(config as t.MCPOptions)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${logPrefix} Server "${serverName}" requires Graph API token resolution which is not supported for app requests.`,
      );
    }
    const missingBodyFields = getMissingRuntimeBodyPlaceholderFields(config);
    if (missingBodyFields.length > 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${logPrefix} Server "${serverName}" requires request body field(s) (${missingBodyFields.join(', ')}) that are not available for app requests.`,
      );
    }
    return config;
  }

  /** Runs every View callback through the existing connection lease and direct-bearer recovery owner. */
  private async runAppOperation<TResult>(
    context: MCPAppOperationContext,
    operation: (connection: MCPConnection, options: RequestOptions) => Promise<TResult>,
  ): Promise<TResult> {
    const {
      serverName,
      user,
      connectionTarget,
      customUserVars,
      flowManager,
      tokenMethods,
      upstreamTokenProvider,
      onOAuthCredentialsChanging,
      allowlists,
    } = context;
    const { signal } = context;
    const logPrefix = `[MCP][User: ${user.id}][${serverName}]`;
    const config = this.getAppServerConfig(context);
    const directBearerRecovery = usesDirectOpenIDBearerRecovery(config);
    const directBearerRecoveryState: t.DirectBearerRecoveryState = { attempted: false };
    let oauthRecoveryAttempted = false;
    let recoveryTakeoverConsumed = false;

    while (true) {
      signal?.throwIfAborted();
      let connection: MCPConnection | undefined;
      let retained = false;
      let deferredDisposalHeld = false;
      const release = async (preserveDisposalHold = false) => {
        if (!connection || !retained) {
          return;
        }
        if (deferredDisposalHeld && !preserveDisposalHold) {
          await this.releaseDeferredConnectionDisposal(connection);
          deferredDisposalHeld = false;
        }
        retained = false;
        await this.releaseConnection(connection);
      };
      const retain = () => {
        if (!connection || retained) {
          return;
        }
        this.retainConnection(connection);
        retained = true;
      };
      const waitForRecoveryWithoutLease = async (startRecovery: () => Promise<void>) => {
        const recovery = startRecovery();
        if (!deferredDisposalHeld) {
          this.holdDeferredConnectionDisposal(connection!);
          deferredDisposalHeld = true;
        }
        await release(true);
        try {
          await recovery;
        } finally {
          retain();
        }
      };

      try {
        ({ connection } = await this.checkoutConnection({
          serverName,
          user,
          connectionTarget,
          customUserVars,
          flowManager,
          tokenMethods,
          upstreamTokenProvider,
          onOAuthCredentialsChanging,
          directBearerRecoveryState,
          signal,
          capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
        }));
        retain();

        const activeRecovery = this.oauthRecoveries.get(connection);
        if (activeRecovery) {
          if (activeRecovery.directBearerRecoveryConsumed) {
            directBearerRecoveryState.attempted = true;
          }
          await release();
          await this.waitForConnectionRecovery(activeRecovery.promise, signal);
          if (activeRecovery.directBearerRecoveryState) {
            Object.assign(directBearerRecoveryState, activeRecovery.directBearerRecoveryState);
          }
          continue;
        }

        const bearerConfig = await resolveDirectOpenIDBearerConfig({
          config: config as t.MCPOptions,
          upstreamTokenProvider,
          resolvedConfig: directBearerRecoveryState.resolvedConfig,
          signal,
        });
        const currentOptions = processMCPEnv({
          user,
          dbSourced: isUserSourced(config),
          options: bearerConfig,
          customUserVars,
        });
        const headers: Record<string, string> =
          'headers' in currentOptions ? { ...(currentOptions.headers || {}) } : {};
        connection.setRequestHeaders(headers);
        this.assertAppServerBinding(
          context,
          connection,
          projectMCPAppRuntimeTarget(currentOptions),
        );
        const standardOAuth = isOAuthServer(currentOptions) || connection.usesOAuth();
        const attachSharedOAuthHandler = standardOAuth
          ? (relay: OAuthLifecycleRelay) =>
              MCPConnectionFactory.attachRequestOAuthHandler(
                {
                  serverName,
                  serverConfig: currentOptions,
                  dbSourced: isUserSourced(config),
                  skipEnvProcessing: true,
                  capabilityProfile: MCP_APPS_CAPABILITY_PROFILE,
                  ...allowlists,
                },
                {
                  useOAuth: true,
                  user,
                  flowManager,
                  tokenMethods,
                  oauthStart: relay.start,
                  oauthEnd: relay.end,
                  customUserVars,
                  onOAuthCredentialsChanging,
                },
                connection!,
              )
          : undefined;

        const recover = async (error: unknown): Promise<void> => {
          if (directBearerRecoveryState.attempted) {
            throw new MCPAuthenticationRejectedError(serverName, false, error);
          }
          directBearerRecoveryState.attempted = true;
          const recovery = this.recoverDirectOpenIDBearerConnection({
            connection: connection!,
            serverName,
            serverConfig: config,
            user,
            flowManager,
            tokenMethods,
            customUserVars,
            upstreamTokenProvider,
            onOAuthCredentialsChanging,
            signal,
            directBearerRecoveryState,
          });
          await release();
          await recovery;
        };
        const recoverOAuth = async (error: unknown): Promise<void> => {
          if (!attachSharedOAuthHandler) {
            throw new MCPAuthenticationRejectedError(serverName, false, error);
          }
          if (oauthRecoveryAttempted) {
            throw new MCPAuthenticationRejectedError(serverName, true, error);
          }
          oauthRecoveryAttempted = true;
          try {
            await waitForRecoveryWithoutLease(() =>
              this.recoverOAuthConnection(
                connection!,
                error,
                serverName,
                user.id,
                attachSharedOAuthHandler,
                undefined,
                undefined,
                flowManager,
                signal,
                !recoveryTakeoverConsumed,
              ),
            );
          } catch (recoveryError) {
            if (recoveryError instanceof OAuthRecoveryTakeoverRequired) {
              oauthRecoveryAttempted = false;
              throw recoveryError;
            }
            if (signal?.aborted) {
              throw recoveryError;
            }
            logger.warn(`${logPrefix} OAuth recovery failed`, recoveryError);
            throw new MCPAuthenticationRejectedError(serverName, false, error);
          }
        };

        const connected = await connection.isConnected(signal);
        if (!connected) {
          const connectionError = connection.getLastConnectionCheckError();
          if (directBearerRecovery && isMCPTransportAuthenticationError(connectionError)) {
            await recover(connectionError);
            continue;
          }
          if (standardOAuth && connection.isOAuthAuthenticationError(connectionError)) {
            await recoverOAuth(connectionError);
            continue;
          }
          throw new McpError(ErrorCode.InternalError, `${logPrefix} Connection is not active.`);
        }

        let result: TResult;
        try {
          const operationTimeout = getMCPAppOperationLimits(context.operationLimits).timeoutMs;
          result = await operation(connection, {
            timeout: Math.min(connection.timeout ?? operationTimeout, operationTimeout),
            maxTotalTimeout: operationTimeout,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          if (directBearerRecovery && isMCPTransportAuthenticationError(error)) {
            await recover(error);
            continue;
          }
          if (standardOAuth && connection.isOAuthAuthenticationError(error)) {
            await recoverOAuth(error);
            continue;
          }
          throw error;
        }

        if ((this.userConnections.get(user.id)?.size ?? 0) > 0) {
          await this.updateUserLastActivity(user.id);
        }
        this.checkIdleConnections();
        return result;
      } catch (error) {
        if (error instanceof OAuthRecoveryTakeoverRequired) {
          recoveryTakeoverConsumed = true;
          continue;
        }
        throw error;
      } finally {
        await release();
      }
    }
  }

  private getAppBindingSubject(
    serverName: string,
    userId: string,
    tenantId: unknown,
    connectionTarget: t.MCPConnectionTarget,
    connection: MCPConnection,
  ): MCPAppBindingSubject {
    return {
      serverName,
      userId,
      tenantId: typeof tenantId === 'string' ? tenantId : null,
      connectionTarget,
      runtimeTarget: connection.getMCPAppRuntimeTarget(),
    };
  }

  private assertAppServerBinding(
    context: MCPAppOperationContext,
    connection: MCPConnection,
    currentRuntimeTarget: MCPAppRuntimeTarget,
  ): void {
    const currentSubject = this.getAppBindingSubject(
      context.serverName,
      context.user.id,
      context.user.tenantId,
      context.connectionTarget,
      connection,
    );
    const currentTargetMatches = this.appBindingCodec?.verify(context.serverBinding, {
      ...currentSubject,
      runtimeTarget: currentRuntimeTarget,
    });
    const connectionMatches = this.appBindingCodec?.verify(context.serverBinding, currentSubject);
    if (!currentTargetMatches || !connectionMatches) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `MCP App binding for server "${context.serverName}" is no longer valid.`,
      );
    }
  }

  async validateAppBinding(context: MCPAppValidationContext): Promise<{ valid: true }> {
    context.signal?.throwIfAborted();
    const config = this.getAppServerConfig(context);
    const currentOptions = processMCPEnv({
      user: context.user,
      dbSourced: isUserSourced(config),
      options: config,
      customUserVars: context.customUserVars,
    });
    const valid = this.appBindingCodec?.verify(context.serverBinding, {
      serverName: context.serverName,
      userId: context.user.id,
      tenantId: typeof context.user.tenantId === 'string' ? context.user.tenantId : null,
      connectionTarget: context.connectionTarget,
      runtimeTarget: projectMCPAppRuntimeTarget(currentOptions),
    });
    if (!valid) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `MCP App binding for server "${context.serverName}" is no longer valid.`,
      );
    }
    context.signal?.throwIfAborted();
    return { valid: true };
  }

  async readResource({
    uri,
    ...context
  }: MCPAppOperationContext & {
    uri: string;
  }): Promise<unknown> {
    // The authenticated server remains the authority for its opaque resource URI. LibreChat does
    // not try to invert URI templates or infer a broader client-side authorization namespace.
    return this.runAppOperation(context, (connection, options) =>
      connection.client.readResource({ uri }, options),
    );
  }

  async listResources({
    cursor,
    ...context
  }: MCPAppOperationContext & {
    cursor?: string;
  }): Promise<unknown> {
    return this.runAppOperation(context, (connection, options) =>
      connection.client.listResources(cursor != null ? { cursor } : {}, options),
    );
  }

  async listResourceTemplates({
    cursor,
    ...context
  }: MCPAppOperationContext & {
    cursor?: string;
  }): Promise<unknown> {
    return this.runAppOperation(context, (connection, options) =>
      connection.client.listResourceTemplates(cursor != null ? { cursor } : {}, options),
    );
  }

  /**
   * Proxies a tool call from an MCP App iframe to the MCP server.
   * Unlike callTool, this is a lightweight proxy without provider formatting.
   */
  async appToolCall({
    serverName,
    toolName,
    toolArguments,
    ...context
  }: MCPAppOperationContext & {
    toolName: string;
    toolArguments: Record<string, unknown>;
  }): Promise<unknown> {
    const userId = context.user.id;
    const logPrefix = `[MCP][User: ${userId}][${serverName}]`;
    return this.runAppOperation({ serverName, ...context }, async (connection, options) => {
      const cacheKey = this.cacheScope(serverName, connection, userId);
      if (!this.isToolCacheFresh(cacheKey, connection)) {
        await this.populateToolCaches(connection, cacheKey, options.signal);
      }
      if (!this.isToolCacheFresh(cacheKey, connection)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${logPrefix} Tool catalog for server "${serverName}" is not currently available.`,
        );
      }
      if (!this.knownToolNamesCache.get(cacheKey)?.has(toolName)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${logPrefix} Tool "${toolName}" is not available on server "${serverName}".`,
        );
      }
      if (this.appHiddenToolCache.get(cacheKey)?.has(toolName)) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          `${logPrefix} Tool "${toolName}" is not available to apps (visibility excludes "app").`,
        );
      }
      return connection.client.request(
        {
          method: 'tools/call',
          params: { name: toolName, arguments: toolArguments },
        },
        CallToolResultSchema,
        { ...options, resetTimeoutOnProgress: true },
      );
    });
  }
}
