import { logger } from '@librechat/data-schemas';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type * as t from './types';
import {
  applyRequestHeaders,
  canUseAppConnection,
  canBackfillSharedServerInstructions,
  getMissingRuntimeBodyPlaceholderFields,
  hasRuntimeUrlPlaceholders,
  isUserSourced,
  requiresEphemeralUserConnection,
  requiresOAuthMachinery,
} from './utils';
import {
  cancelMCPToolsChanged,
  getMCPAppToolsPublicationGeneration,
  getMCPToolsChangedGeneration,
  notifyMCPToolsChanged,
  renewMCPToolsChangedGeneration,
} from '~/mcp/toolsChanged';
import { resolveDirectOpenIDBearerConfig, usesDirectOpenIDBearerRecovery } from '~/mcp/openid';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { ConnectionsRepository } from '~/mcp/ConnectionsRepository';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { MCPAuthenticationRejectedError } from '~/mcp/errors';
import { processMCPEnv, isPluginSourced } from '~/utils/env';
import { OAuthLifecycleRelay } from '~/mcp/oauth/pending';
import { preProcessGraphTokens } from '~/utils/graph';
import { detectOAuthRequirement } from '~/mcp/oauth';
import { isMCPDomainAllowed } from '~/auth/domain';
import { MCPConnection } from './connection';
import { mcpConfig } from './mcpConfig';
import { isEnabled } from '~/utils';

type PendingConnection = {
  promise: Promise<MCPConnection>;
  oauth: OAuthLifecycleRelay;
  directBearerRecoveryState: t.DirectBearerRecoveryState;
  signal?: AbortSignal;
};

/**
 * Why a connection is being torn down. A `mutation` teardown follows a committed change to the
 * server config or its credentials, so whatever an in-flight creation resolved before it may be
 * stale and that creation cannot be re-established from the same inputs. A `lifecycle` teardown
 * — an idle sweep, a forced replacement, a dead connection cleaned up — leaves those inputs
 * exactly as valid as they were, and only the connection object itself goes away.
 */
type ConnectionTeardownReason = 'mutation' | 'lifecycle';

type ConnectionTeardownOptions = {
  /** The creation that requested the teardown; it is fenced by its own replacement. */
  preservedCreation?: ConnectionCreationGuard;
  reason?: ConnectionTeardownReason;
};

type ConnectionCreationGuard = { cancelledBy: ConnectionTeardownReason | null };

type ConnectionMutationFence = {
  assertCurrent: () => void;
  release: () => void;
};

/** Signals that a teardown fenced an in-flight creation before it could finish. */
class ConnectionCreationCancelledError extends Error {
  constructor(
    message: string,
    public readonly reason: ConnectionTeardownReason,
  ) {
    super(message);
  }
}

/** Bounds re-establishment so back-to-back teardowns cannot spin a caller forever. */
const MAX_TEARDOWN_RESTARTS = 3;

/**
 * Abstract base class for managing user-specific MCP connections with lifecycle management.
 * Only meant to be extended by MCPManager.
 * Much of the logic was move here from the old MCPManager to make it more manageable.
 * User connections will soon be ephemeral and not cached anymore:
 * https://github.com/LibreChat-AI/LibreChat/discussions/8790
 */
export abstract class UserConnectionManager {
  // Connections shared by all users.
  public appConnections: ConnectionsRepository | null = null;
  // Connections per userId -> serverName -> connection
  protected userConnections: Map<string, Map<string, MCPConnection>> = new Map();
  /** Last activity timestamp for users (not per server) */
  protected userLastActivity: Map<string, number> = new Map();
  /** In-flight connection promises keyed by `userId:serverName` — coalesces concurrent attempts */
  protected pendingConnections: Map<string, PendingConnection> = new Map();
  /** Recovery state owned by request-scoped promises, which the public store intentionally keeps opaque. */
  private readonly requestPendingDirectBearerRecoveryStates = new WeakMap<
    Promise<unknown>,
    t.DirectBearerRecoveryState
  >();

  private readonly connectionBorrowers = new WeakMap<MCPConnection, number>();
  private readonly connectionBorrowerDrainWaiters = new WeakMap<MCPConnection, Set<() => void>>();
  private readonly deferredConnectionDisposalHolds = new WeakMap<MCPConnection, number>();
  private readonly deferredConnectionDisposals = new WeakMap<MCPConnection, string>();
  /** All durable creations, including forced replacements, visible to mutation teardown. */
  private readonly activeConnectionCreations: Map<string, Set<ConnectionCreationGuard>> = new Map();
  /** Serializes explicit durable replacements without coalescing their callers. */
  private readonly forceNewConnectionQueues: Map<string, Promise<void>> = new Map();
  /** Fences durable connections whose credentials were invalidated on another replica. */
  protected readonly toolPublicationGenerations: WeakMap<MCPConnection, string> = new WeakMap();
  /** Binds a durable connection to the stored config that created it, independently of Redis. */
  protected readonly toolConfigGenerations: WeakMap<MCPConnection, string> = new WeakMap();
  /** Limits Redis lease refreshes while ensuring active connections cannot outlive their lease. */
  private readonly toolPublicationLeaseRefreshes: WeakMap<MCPConnection, number> = new WeakMap();
  /** Coalesces concurrent activity updates for the same durable connection. */
  private readonly toolPublicationLeaseRenewals: WeakMap<MCPConnection, Promise<void>> =
    new WeakMap();

  /** Records connections whose distributed publication authority was replaced during renewal. */
  private readonly lostToolPublicationLeases: WeakSet<MCPConnection> = new WeakSet();

  /** Returns the cache-publication generation captured for a durable connection. */
  public getToolPublicationGeneration(connection: MCPConnection): string | undefined {
    return this.toolPublicationGenerations.get(connection);
  }

  /** Returns the config identity captured when a durable connection was created. */
  public getToolConfigGeneration(connection: MCPConnection): string | undefined {
    return this.toolConfigGenerations.get(connection);
  }

  private runWithForceNewConnectionQueue<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.forceNewConnectionQueues.get(key) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.forceNewConnectionQueues.set(key, tail);
    void tail.then(() => {
      if (this.forceNewConnectionQueues.get(key) === tail) {
        this.forceNewConnectionQueues.delete(key);
      }
    });
    return result;
  }

  private registerConnectionCreation(key: string, guard: ConnectionCreationGuard): void {
    const guards = this.activeConnectionCreations.get(key) ?? new Set<ConnectionCreationGuard>();
    guards.add(guard);
    this.activeConnectionCreations.set(key, guards);
  }

  private unregisterConnectionCreation(key: string, guard: ConnectionCreationGuard): void {
    const guards = this.activeConnectionCreations.get(key);
    guards?.delete(guard);
    if (guards?.size === 0) {
      this.activeConnectionCreations.delete(key);
    }
  }

  private assertCreationNotCancelled(
    guard: ConnectionCreationGuard | undefined,
    userId: string,
    serverName: string,
  ): void {
    if (!guard?.cancelledBy) {
      return;
    }
    throw new ConnectionCreationCancelledError(
      `[MCP][User: ${userId}][${serverName}] Connection creation was cancelled during teardown`,
      guard.cancelledBy,
    );
  }

  /** Registers work that resolves a replacement before the ordinary creation queue begins. */
  protected createConnectionMutationFence(
    userId: string,
    serverName: string,
  ): ConnectionMutationFence {
    const key = `${userId}:${serverName}`;
    const guard: ConnectionCreationGuard = { cancelledBy: null };
    this.registerConnectionCreation(key, guard);
    return {
      assertCurrent: () => {
        /** Lifecycle churn does not invalidate the captured config; a committed mutation does. */
        if (guard.cancelledBy === 'lifecycle') {
          guard.cancelledBy = null;
        }
        this.assertCreationNotCancelled(guard, userId, serverName);
      },
      release: () => this.unregisterConnectionCreation(key, guard),
    };
  }

  /** A mutation fence outranks a lifecycle one: the stale inputs stay stale either way. */
  private cancelConnectionCreations(
    key: string,
    reason: ConnectionTeardownReason,
    preserved?: ConnectionCreationGuard,
  ): void {
    for (const guard of this.activeConnectionCreations.get(key) ?? []) {
      if (guard !== preserved && guard.cancelledBy !== 'mutation') {
        guard.cancelledBy = reason;
      }
    }
  }

  private async renewUserToolPublicationLeases(userId: string, now: number): Promise<void> {
    const userConnections = this.userConnections.get(userId);
    if (!userConnections) {
      return;
    }
    const configuredIdleTimeout = Number(mcpConfig.USER_CONNECTION_IDLE_TIMEOUT);
    const refreshInterval =
      Number.isFinite(configuredIdleTimeout) && configuredIdleTimeout > 0
        ? Math.max(1_000, configuredIdleTimeout / 2)
        : 15 * 60 * 1000;
    const renewals: Promise<void>[] = [];
    for (const [serverName, connection] of userConnections) {
      const publicationGeneration = this.toolPublicationGenerations.get(connection);
      if (!publicationGeneration) {
        continue;
      }
      const lastRefresh = this.toolPublicationLeaseRefreshes.get(connection) ?? 0;
      if (now - lastRefresh < refreshInterval) {
        continue;
      }
      const pendingRenewal = this.toolPublicationLeaseRenewals.get(connection);
      if (pendingRenewal) {
        renewals.push(pendingRenewal);
        continue;
      }
      const renewal = renewMCPToolsChangedGeneration({
        userId,
        serverName,
        publicationGeneration,
      })
        .then((renewed) => {
          if (renewed === true) {
            this.toolPublicationLeaseRefreshes.set(connection, now);
          } else if (renewed === false) {
            this.lostToolPublicationLeases.add(connection);
            logger.info(
              `[MCP][User: ${userId}][${serverName}] Publication lease is no longer current`,
            );
          }
        })
        .catch((error) => {
          logger.warn(
            `[MCP][User: ${userId}][${serverName}] Failed to renew tool publication lease`,
            error,
          );
        });
      this.toolPublicationLeaseRenewals.set(connection, renewal);
      void renewal.finally(() => {
        if (this.toolPublicationLeaseRenewals.get(connection) === renewal) {
          this.toolPublicationLeaseRenewals.delete(connection);
        }
      });
      renewals.push(renewal);
    }
    await Promise.all(renewals);
  }

  /** Updates activity and keeps every durable connection retained by that user leased. */
  protected async updateUserLastActivity(userId: string): Promise<void> {
    const now = Date.now();
    this.userLastActivity.set(userId, now);
    logger.debug(
      `[MCP][User: ${userId}] Updated last activity timestamp: ${new Date(now).toISOString()}`,
    );
    await this.renewUserToolPublicationLeases(userId, now);
  }

  private async assertToolPublicationLeaseCurrent(
    connection: MCPConnection,
    userId: string,
    serverName: string,
    creationGuard?: ConnectionCreationGuard,
  ): Promise<void> {
    if (!this.lostToolPublicationLeases.has(connection)) {
      return;
    }
    await this.disconnectUserConnection(userId, serverName, { preservedCreation: creationGuard });
    throw new Error(`[MCP][User: ${userId}][${serverName}] Publication lease is no longer current`);
  }

  /**
   * A teardown fences every creation in flight for the same user and server, since one of them
   * may install the connection it is removing, or hand back the one it just disposed. What the
   * fenced attempt deserves depends on why the teardown ran. After a `lifecycle` teardown it is
   * next in line rather than stale — nothing its caller resolved changed — so the attempt is
   * discarded and re-established. After a `mutation` teardown the config and credentials that
   * caller resolved may be the ones that were just replaced, and only the caller can resolve
   * them again, so the fence stays fatal. A caller that has since aborted gets neither: there
   * is nobody left to hand the connection to.
   *
   * Re-establishment happens inside the queue slot the attempt already holds, so a replacement
   * queued behind another one keeps its position instead of moving to the tail and overwriting
   * a newer connection later.
   */
  private async createUserConnectionWithLifecycleRestarts(
    options: t.UserMCPConnectionOptions,
    userId: string,
    clearCooldown: boolean,
    creationGuard: ConnectionCreationGuard,
  ): Promise<MCPConnection> {
    for (let attempt = 0; ; attempt++) {
      /** A lifecycle fence raised while this attempt waited its turn has nothing left to fence;
       *  a mutation fence is kept, so the attempt below fails on it immediately. */
      if (creationGuard.cancelledBy === 'lifecycle') {
        creationGuard.cancelledBy = null;
      }
      try {
        return await this.createUserConnectionInternal(
          options,
          userId,
          clearCooldown,
          creationGuard,
        );
      } catch (error) {
        if (
          !(error instanceof ConnectionCreationCancelledError) ||
          error.reason !== 'lifecycle' ||
          attempt >= MAX_TEARDOWN_RESTARTS ||
          options.signal?.aborted === true
        ) {
          throw error;
        }
        logger.info(
          `[MCP][User: ${userId}][${options.serverName}] Connection creation raced a teardown; re-establishing`,
        );
      }
    }
  }

  /** Gets or creates a connection for a specific user, coalescing concurrent attempts */
  public async getUserConnection(opts: t.UserMCPConnectionOptions): Promise<MCPConnection> {
    const { serverName, forceNew, user } = opts;
    const directBearerRecoveryState = opts.directBearerRecoveryState ?? { attempted: false };
    const userId = user?.id;
    if (!userId) {
      throw new McpError(ErrorCode.InvalidRequest, `[MCP] User object missing id property`);
    }

    const config =
      opts.serverConfig ??
      (await MCPServersRegistry.getInstance().getServerConfig(serverName, userId));
    const missingBodyFields = config
      ? getMissingRuntimeBodyPlaceholderFields(config, opts.requestBody)
      : [];
    if (missingBodyFields.length > 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `[MCP][User: ${userId}][${serverName}] Request body field(s) required to resolve runtime MCP placeholders: ${missingBodyFields.join(', ')}.`,
      );
    }
    const ephemeralConnection =
      opts.ephemeralConnection === true ||
      (config ? requiresEphemeralUserConnection(config) : false);
    const requestScopedConnections = ephemeralConnection
      ? opts.requestScopedConnections
      : undefined;
    if (requestScopedConnections) {
      if (requestScopedConnections.cleanupStarted) {
        throw new Error(`[MCP][User: ${userId}] Request-scoped connection context is closed`);
      }
      this.bindRequestScopedConnectionStore(requestScopedConnections);
      const requestConnectionKey = `${userId}:${serverName}`;
      const existing = requestScopedConnections.connections.get(requestConnectionKey) as
        | MCPConnection
        | undefined;
      if (existing) {
        if (!config || (config.updatedAt && existing.isStale(config.updatedAt))) {
          requestScopedConnections.connections.delete(requestConnectionKey);
          await this.disposeEvictedConnection(existing, `[MCP][User: ${userId}]`);
        } else {
          const activeRecovery = this.getActiveConnectionRecovery(existing);
          this.propagateDirectBearerRecoveryState(existing, opts.directBearerRecoveryState);
          let awaitedRecovery = activeRecovery;
          if (activeRecovery) {
            await this.waitForConnectionRecovery(activeRecovery, opts.signal);
          }
          let connected = await existing.isConnected();
          let recovery = this.getActiveConnectionRecovery(existing);
          this.propagateDirectBearerRecoveryState(existing, opts.directBearerRecoveryState);
          while (recovery && recovery !== awaitedRecovery) {
            awaitedRecovery = recovery;
            await this.waitForConnectionRecovery(recovery, opts.signal);
            connected = await existing.isConnected();
            recovery = this.getActiveConnectionRecovery(existing);
            this.propagateDirectBearerRecoveryState(existing, opts.directBearerRecoveryState);
          }
          if (requestScopedConnections.connections.get(requestConnectionKey) !== existing) {
            return this.getUserConnection({ ...opts, directBearerRecoveryState });
          }
          if (connected) {
            logger.debug(`[MCP][User: ${userId}] Reusing request-scoped connection`);
            return existing;
          }
          requestScopedConnections.connections.delete(requestConnectionKey);
          await this.disposeEvictedConnection(existing, `[MCP][User: ${userId}]`);
        }
      }

      const pending = requestScopedConnections.pending.get(requestConnectionKey) as
        | Promise<MCPConnection>
        | undefined;
      if (pending) {
        logger.debug(`[MCP][User: ${userId}] Joining in-flight request-scoped connection attempt`);
        const connection = await pending;
        if (this.requestPendingDirectBearerRecoveryStates.get(pending)?.attempted) {
          directBearerRecoveryState.attempted = true;
        }
        directBearerRecoveryState.resolvedConfig =
          this.requestPendingDirectBearerRecoveryStates.get(pending)?.resolvedConfig;
        return connection;
      }

      const pendingOAuth = new OAuthLifecycleRelay({
        oauthStart: opts.oauthStart,
        oauthEnd: opts.oauthEnd,
        logPrefix: `[MCP][User: ${userId}][${serverName}]`,
      });
      const creationGuard: ConnectionCreationGuard = { cancelledBy: null };
      this.registerConnectionCreation(requestConnectionKey, creationGuard);
      const connectionPromise = this.createUserConnectionWithLifecycleRestarts(
        {
          ...opts,
          forceNew: true,
          ephemeralConnection: true,
          serverConfig: config,
          directBearerRecoveryState,
          oauthStart: pendingOAuth.start,
          oauthEnd: pendingOAuth.end,
        },
        userId,
        forceNew === true,
        creationGuard,
      ).then(async (connection) => {
        try {
          opts.signal?.throwIfAborted();
          this.assertCreationNotCancelled(creationGuard, userId, serverName);
          if (requestScopedConnections.cleanupStarted) {
            throw new Error(`[MCP][User: ${userId}] Request-scoped connection context is closed`);
          }
        } catch (error) {
          await this.disposeEvictedConnection(
            connection,
            `[MCP][Request-scoped: ${requestConnectionKey}] Invalidated during connection creation`,
          );
          throw error;
        }
        requestScopedConnections.connections.set(requestConnectionKey, connection);
        return connection;
      });

      requestScopedConnections.pending.set(
        requestConnectionKey,
        connectionPromise as Promise<unknown>,
      );
      this.requestPendingDirectBearerRecoveryStates.set(
        connectionPromise,
        directBearerRecoveryState,
      );

      try {
        return await connectionPromise;
      } finally {
        this.unregisterConnectionCreation(requestConnectionKey, creationGuard);
        if (requestScopedConnections.pending.get(requestConnectionKey) === connectionPromise) {
          requestScopedConnections.pending.delete(requestConnectionKey);
        }
      }
    }

    const forceNewConnection = forceNew || ephemeralConnection;
    const clearCooldown = forceNew === true;

    const lockKey = `${userId}:${serverName}`;

    if (!forceNewConnection) {
      const pending = this.pendingConnections.get(lockKey);
      if (pending) {
        logger.debug(`[MCP][User: ${userId}] Joining in-flight connection attempt`);
        const mutationFence = this.createConnectionMutationFence(userId, serverName);
        try {
          await pending.oauth.add({
            oauthStart: opts.oauthStart,
            oauthEnd: opts.oauthEnd,
            flowManager: opts.flowManager,
            userId,
            serverName,
          });
          opts.signal?.throwIfAborted();
          await this.waitForConnectionRecovery(
            pending.promise.then(() => undefined),
            opts.signal,
          );
          const connection = await pending.promise;
          opts.signal?.throwIfAborted();
          mutationFence?.assertCurrent();
          if (pending.directBearerRecoveryState.attempted) {
            directBearerRecoveryState.attempted = true;
          }
          directBearerRecoveryState.resolvedConfig =
            pending.directBearerRecoveryState.resolvedConfig;
          return connection;
        } catch (error) {
          opts.signal?.throwIfAborted();
          mutationFence?.assertCurrent();
          if (!mutationFence || !pending.signal?.aborted || error !== pending.signal.reason) {
            throw error;
          }
          /** The stopped leader owns its aborted attempt, not this still-active request.
           * Continue with an independently owned creation, preserving any spent auth budget. */
          directBearerRecoveryState.attempted ||= pending.directBearerRecoveryState.attempted;
          if (this.pendingConnections.get(lockKey) === pending) {
            this.pendingConnections.delete(lockKey);
          }
        } finally {
          mutationFence?.release();
        }
      }
    }

    const pendingOAuth = new OAuthLifecycleRelay({
      oauthStart: opts.oauthStart,
      oauthEnd: opts.oauthEnd,
      logPrefix: `[MCP][User: ${userId}][${serverName}]`,
    });
    const creationGuard: ConnectionCreationGuard = { cancelledBy: null };
    this.registerConnectionCreation(lockKey, creationGuard);
    const createConnection = () =>
      this.createUserConnectionWithLifecycleRestarts(
        {
          ...opts,
          forceNew: forceNewConnection,
          ephemeralConnection,
          serverConfig: config,
          directBearerRecoveryState,
          oauthStart: pendingOAuth.start,
          oauthEnd: pendingOAuth.end,
        },
        userId,
        clearCooldown,
        creationGuard,
      );
    const connectionPromise = !ephemeralConnection
      ? this.runWithForceNewConnectionQueue(lockKey, createConnection)
      : createConnection();

    if (!forceNewConnection) {
      this.pendingConnections.set(lockKey, {
        promise: connectionPromise,
        oauth: pendingOAuth,
        directBearerRecoveryState,
        signal: opts.signal,
      });
    }

    try {
      return await connectionPromise;
    } finally {
      this.unregisterConnectionCreation(lockKey, creationGuard);
      if (
        !forceNewConnection &&
        this.pendingConnections.get(lockKey)?.promise === connectionPromise
      ) {
        this.pendingConnections.delete(lockKey);
      }
    }
  }

  private async createUserConnectionInternal(
    {
      serverName,
      forceNew,
      user,
      flowManager,
      customUserVars,
      requestBody,
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
      signal,
      returnOnOAuth = false,
      connectionTimeout,
      graphTokenResolver,
      ephemeralConnection = false,
      serverConfig: providedConfig,
      directBearerRecoveryState = { attempted: false },
      directBearerResolvedConfig,
    }: t.UserMCPConnectionOptions,
    userId: string,
    clearCooldown: boolean,
    creationGuard?: ConnectionCreationGuard,
  ): Promise<MCPConnection> {
    signal?.throwIfAborted();
    this.assertCreationNotCancelled(creationGuard, userId, serverName);
    const declaredConfig =
      providedConfig ??
      (await MCPServersRegistry.getInstance().getServerConfig(serverName, userId));
    if (
      (!declaredConfig || canUseAppConnection(declaredConfig)) &&
      (await this.appConnections!.has(serverName))
    ) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `[MCP][User: ${userId}] Trying to create user-specific connection for app-level server "${serverName}"`,
      );
    }

    /** Resolution uses effective headers; identity and persistence keep the declaration. */
    const config = declaredConfig && applyRequestHeaders(declaredConfig);

    /** Capture before resolving credentials/creating the connection. If another replica rotates
     *  the generation while creation is in flight, this connection's publications are fenced. */
    const publicationGeneration = ephemeralConnection
      ? undefined
      : await getMCPToolsChangedGeneration({ userId, serverName });

    const userServerMap = this.userConnections.get(userId);
    let connection = userServerMap?.get(serverName);
    if (forceNew && connection && !ephemeralConnection) {
      logger.info(
        `[MCP][User: ${userId}][${serverName}] Disposing existing connection before forced replacement`,
      );
      await this.disconnectUserConnection(userId, serverName, {
        preservedCreation: creationGuard,
        reason: 'lifecycle',
      });
      connection = undefined;
    } else if (forceNew) {
      connection = undefined;
    }
    if (clearCooldown) {
      MCPConnection.clearCooldown(serverName);
    }
    const now = Date.now();

    const existingPublicationGeneration = connection
      ? this.toolPublicationGenerations.get(connection)
      : undefined;
    const configGeneration = declaredConfig
      ? getMCPAppToolsPublicationGeneration(declaredConfig)
      : undefined;
    const existingConfigGeneration = connection
      ? this.toolConfigGenerations.get(connection)
      : undefined;
    if (
      connection &&
      configGeneration &&
      existingConfigGeneration &&
      configGeneration !== existingConfigGeneration
    ) {
      logger.info(
        `[MCP][User: ${userId}][${serverName}] Config identity changed, disconnecting stale connection`,
      );
      await this.disconnectUserConnection(userId, serverName, {
        preservedCreation: creationGuard,
      });
      connection = undefined;
    }
    if (
      connection &&
      publicationGeneration &&
      existingPublicationGeneration &&
      publicationGeneration !== existingPublicationGeneration
    ) {
      logger.info(
        `[MCP][User: ${userId}][${serverName}] Cache generation changed, disconnecting stale connection`,
      );
      await this.disconnectUserConnection(userId, serverName, {
        preservedCreation: creationGuard,
      });
      connection = undefined;
    }

    // Check if user is idle
    const lastActivity = this.userLastActivity.get(userId);
    if (lastActivity && now - lastActivity > mcpConfig.USER_CONNECTION_IDLE_TIMEOUT) {
      logger.info(`[MCP][User: ${userId}] User idle for too long. Disconnecting all connections.`);
      // Disconnect all user connections
      try {
        await this.disconnectUserConnections(userId, {
          preservedCreation: creationGuard,
          reason: 'lifecycle',
        });
      } catch {
        logger.error(`[MCP][User: ${userId}] Error disconnecting idle connections`);
      }
      connection = undefined; // Force creation of a new connection
    } else if (connection) {
      if (!config || (config.updatedAt && connection.isStale(config.updatedAt))) {
        if (config) {
          logger.info(
            `[MCP][User: ${userId}] Server configuration updated; disconnecting stale connection`,
          );
        }
        await this.disconnectUserConnection(userId, serverName, {
          preservedCreation: creationGuard,
        });
        connection = undefined;
      } else {
        const activeRecovery = this.getActiveConnectionRecovery(connection);
        this.propagateDirectBearerRecoveryState(connection, directBearerRecoveryState);
        let awaitedRecovery = activeRecovery;
        if (activeRecovery) {
          await this.waitForConnectionRecovery(activeRecovery, signal);
        }
        let connected = await connection.isConnected();
        let recovery = this.getActiveConnectionRecovery(connection);
        this.propagateDirectBearerRecoveryState(connection, directBearerRecoveryState);
        while (recovery && recovery !== awaitedRecovery) {
          awaitedRecovery = recovery;
          await this.waitForConnectionRecovery(recovery, signal);
          connected = await connection.isConnected();
          recovery = this.getActiveConnectionRecovery(connection);
          this.propagateDirectBearerRecoveryState(connection, directBearerRecoveryState);
        }
        this.assertCreationNotCancelled(creationGuard, userId, serverName);
        if (connected) {
          logger.debug(`[MCP][User: ${userId}] Reusing active connection`);
          await this.updateUserLastActivity(userId);
          await this.assertToolPublicationLeaseCurrent(
            connection,
            userId,
            serverName,
            creationGuard,
          );
          this.assertCreationNotCancelled(creationGuard, userId, serverName);
          return connection;
        }
        logger.warn(`[MCP][User: ${userId}] Found disconnected connection object; cleaning up`);
        await this.disconnectUserConnection(userId, serverName, {
          preservedCreation: creationGuard,
          reason: 'lifecycle',
        });
        connection = undefined;
      }
    }

    // Now check if config exists for new connection creation
    if (!config || !declaredConfig) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `[MCP][User: ${userId}] Configuration for server "${serverName}" not found.`,
      );
    }

    // If no valid connection exists, create a new one
    logger.info(`[MCP][User: ${userId}] Establishing new connection`);

    try {
      signal?.throwIfAborted();
      const bearerConfig =
        directBearerResolvedConfig ??
        (await resolveDirectOpenIDBearerConfig({
          config,
          upstreamTokenProvider,
          signal,
        }));
      signal?.throwIfAborted();
      if (usesDirectOpenIDBearerRecovery(config)) {
        directBearerRecoveryState.resolvedConfig = bearerConfig;
      }
      const runtimeConfig = await this.applyRuntimeOAuthDetection({
        config: bearerConfig,
        user,
        customUserVars,
        requestBody,
        graphTokenResolver,
      });
      const registry = MCPServersRegistry.getInstance();
      const { allowedDomains, allowedAddresses, useSSRFProtection } =
        await registry.resolveAllowlists({ userId: user?.id, role: user?.role });
      await this.assertResolvedRuntimeConfigAllowed({
        config: runtimeConfig,
        user,
        customUserVars,
        requestBody,
        graphTokenResolver,
        allowedDomains,
        allowedAddresses,
        logPrefix: `[MCP][User: ${userId}]`,
      });
      const basic: t.BasicConnectionOptions = {
        serverConfig: runtimeConfig,
        /** Runtime OAuth detection enriches the connection config. Keep the durable definition
         * separate so callback liveness compares against the config that actually owns it. */
        serverDefinition: declaredConfig,
        ...(usesDirectOpenIDBearerRecovery(config) && { directBearerSourceConfig: config }),
        directBearerRecoveryState,
        serverName: serverName,
        dbSourced: isUserSourced(runtimeConfig),
        useSSRFProtection,
        allowedDomains,
        allowedAddresses,
        ephemeralConnection,
      };

      /**
       * Credentials resolved after the capture above were published under a generation that
       * capture predates, so the build would otherwise fence itself: a refresh it performs, an
       * authorization it waits on, or a re-read after a change invalidated its token cache each
       * hand it the newest credentials, which it would then publish under a retired generation.
       * Recording the generation those credentials carry, while it is still the stored one, keeps
       * the fence pointing at rotations that follow them; a carried generation the store has
       * already retired proves nothing about the current one, so the capture stands for it.
       */
      let credentialGeneration: string | undefined;
      const trackPublishedGeneration: t.UserConnectionContext['onOAuthCredentialsChanging'] =
        onOAuthCredentialsChanging == null
          ? undefined
          : async (scope) => {
              const publish = await onOAuthCredentialsChanging(scope);
              return async () => {
                const published = await publish();
                if (published) {
                  credentialGeneration = published;
                }
                return published;
              };
            };
      const adoptCredentialGeneration: t.UserConnectionContext['onOAuthCredentialsAdopted'] =
        ephemeralConnection
          ? undefined
          : async (published) => {
              if ((await getMCPToolsChangedGeneration({ userId, serverName })) === published) {
                credentialGeneration = published;
              }
            };
      const recaptureCredentialGeneration: t.UserConnectionContext['onOAuthCredentialsInvalidated'] =
        async () => {
          credentialGeneration = await getMCPToolsChangedGeneration({ userId, serverName });
          return credentialGeneration;
        };

      const useOAuth = usesDirectOpenIDBearerRecovery(config)
        ? false
        : requiresOAuthMachinery(runtimeConfig);
      let connectionOptions: t.OAuthConnectionOptions | t.UserConnectionContext;
      if (useOAuth) {
        if (!flowManager) {
          throw new McpError(
            ErrorCode.InvalidRequest,
            `[MCP][User: ${userId}] OAuth server "${serverName}" requires a flowManager`,
          );
        }

        connectionOptions = {
          useOAuth: true,
          user: user,
          customUserVars: customUserVars,
          flowManager: flowManager,
          tokenMethods: tokenMethods,
          signal: signal,
          oauthStart: oauthStart,
          oauthEnd: oauthEnd,
          oboTokenResolver: oboTokenResolver,
          oboTrustChecker: oboTrustChecker,
          upstreamTokenProvider: upstreamTokenProvider,
          upstreamTokenProviderResolver,
          oboIdentityContext,
          graphTokenResolver,
          returnOnOAuth: returnOnOAuth,
          requestBody: requestBody,
          connectionTimeout: connectionTimeout,
          onOAuthCredentialsChanged,
          onOAuthCredentialsChanging: trackPublishedGeneration,
          onOAuthCredentialsAdopted: adoptCredentialGeneration,
          onOAuthCredentialsInvalidated: recaptureCredentialGeneration,
        };
      } else {
        connectionOptions = {
          user,
          customUserVars,
          requestBody,
          graphTokenResolver,
          upstreamTokenProvider,
          upstreamTokenProviderResolver,
          connectionTimeout,
          signal,
        };
      }

      connection = await MCPConnectionFactory.create(basic, connectionOptions);

      this.assertCreationNotCancelled(creationGuard, userId, serverName);

      const effectiveGeneration = ephemeralConnection
        ? undefined
        : (credentialGeneration ?? publicationGeneration);

      if (effectiveGeneration) {
        this.toolPublicationGenerations.set(connection, effectiveGeneration);
      }
      if (configGeneration) {
        this.toolConfigGenerations.set(connection, configGeneration);
      }

      connection.on('toolsChanged', (tools: t.MCPTool[], publicationRevision?: string) => {
        void notifyMCPToolsChanged({
          tools,
          userId,
          serverName,
          serverConfig: declaredConfig,
          ...(effectiveGeneration && { publicationGeneration: effectiveGeneration }),
          ...(publicationRevision && { publicationRevision }),
        });
      });

      if (!(await connection?.isConnected())) {
        throw new Error('Failed to establish connection after initialization attempt.');
      }

      const directBearerRecovery = usesDirectOpenIDBearerRecovery(config);
      if (!ephemeralConnection || directBearerRecovery) {
        const toolListSnapshot = await connection.refreshToolList(signal);
        signal?.throwIfAborted();
        const toolListAuthenticationError = toolListSnapshot?.authenticationError;
        if (toolListAuthenticationError && directBearerRecovery && user) {
          if (directBearerRecoveryState.attempted) {
            throw new MCPAuthenticationRejectedError(
              serverName,
              false,
              toolListAuthenticationError,
            );
          }
          directBearerRecoveryState.attempted = true;
          signal?.throwIfAborted();
          const refreshedConfig = await resolveDirectOpenIDBearerConfig({
            config,
            upstreamTokenProvider,
            forceRefresh: true,
            signal,
          });
          signal?.throwIfAborted();
          connection.removeAllListeners('toolsChanged');
          await connection.dispose();
          return this.createUserConnectionInternal(
            {
              serverName,
              forceNew: true,
              user,
              flowManager,
              customUserVars,
              requestBody,
              tokenMethods,
              oauthStart,
              oauthEnd,
              oboTokenResolver,
              oboTrustChecker,
              upstreamTokenProvider,
              upstreamTokenProviderResolver,
              oboIdentityContext,
              signal,
              returnOnOAuth,
              connectionTimeout,
              graphTokenResolver,
              ephemeralConnection,
              serverConfig: declaredConfig,
              directBearerRecoveryState,
              directBearerResolvedConfig: refreshedConfig,
            },
            userId,
            clearCooldown,
            creationGuard,
          );
        }
      }
      if (!ephemeralConnection) {
        signal?.throwIfAborted();
        this.assertCreationNotCancelled(creationGuard, userId, serverName);
        if (!this.userConnections.has(userId)) {
          this.userConnections.set(userId, new Map());
        }
        this.userConnections.get(userId)?.set(serverName, connection);
      }

      logger.info(`[MCP][User: ${userId}][${serverName}] Connection successfully established`);
      await this.backfillResolvedInstructions(serverName, declaredConfig, connection, userId);
      signal?.throwIfAborted();
      if (!ephemeralConnection) {
        await this.updateUserLastActivity(userId);
        await this.assertToolPublicationLeaseCurrent(connection, userId, serverName, creationGuard);
      }
      this.assertCreationNotCancelled(creationGuard, userId, serverName);
      signal?.throwIfAborted();
      return connection;
    } catch (error) {
      logger.error(`[MCP][User: ${userId}] Failed to establish connection`);
      // Ensure partial connection state is cleaned up if initialization fails
      connection?.removeAllListeners?.('toolsChanged');
      await connection?.dispose().catch(() => {
        logger.error(`[MCP][User: ${userId}] Error during cleanup after failed connection`);
      });
      // Ensure cleanup even if connection attempt fails
      if (connection && this.userConnections.get(userId)?.get(serverName) === connection) {
        this.removeUserConnection(userId, serverName);
      }
      throw error; // Re-throw the error to the caller
    }
  }

  /**
   * An explicitly startup-deferred, context-independent YAML server has no
   * fetched text until its first live connection. Persist that static text so
   * subsequent context builds include it. OAuth/OBO, user credentials, custom
   * variables, and runtime placeholders stay connection-scoped: their
   * instructions can vary by identity or request and must never enter the
   * shared registry. Best-effort: a failure here must never break connection
   * creation.
   */
  protected async backfillResolvedInstructions(
    serverName: string,
    config: t.ParsedServerConfig | undefined,
    connection: MCPConnection,
    userId: string,
  ): Promise<void> {
    try {
      if (!config || !isEnabled(config.serverInstructions)) {
        return;
      }
      /** Only the YAML tier is writable here, and a config-overlay, user, or plugin
       *  server would otherwise spend a cache round-trip per connection to rediscover
       *  that. An unset source is left to proceed: it predates per-tier stamping and
       *  the registry still resolves it by name. A config-tier override shadowing a
       *  YAML base keeps the base's 'yaml' tag (`overlaySource`), so `config` is also
       *  passed through for the registry's field-level identity check. */
      if (
        isUserSourced(config) ||
        isPluginSourced(config) ||
        config.source === 'config' ||
        !canBackfillSharedServerInstructions(config)
      ) {
        return;
      }
      const instructions = connection.client.getInstructions();
      if (!instructions) {
        return;
      }
      if (config.resolvedInstructions != null) {
        return;
      }
      const updated = await MCPServersRegistry.getInstance().setResolvedInstructions(
        serverName,
        instructions,
        userId,
        config,
      );
      if (updated) {
        logger.info(
          `[MCP][User: ${userId}][${serverName}] Stored server instructions from live connection`,
        );
      }
    } catch (error) {
      logger.warn(
        `[MCP][User: ${userId}][${serverName}] Failed to store server instructions from live connection`,
        error,
      );
    }
  }

  /**
   * Mirrors the resolution MCPConnectionFactory performs internally
   * (preProcessGraphTokens + processMCPEnv). Both must stay in sync so the
   * config validated here matches the one the factory actually connects with.
   */
  protected async resolveRuntimeConfig({
    config,
    user,
    customUserVars,
    requestBody,
    graphTokenResolver,
  }: {
    config: t.ParsedServerConfig;
    user?: t.UserMCPConnectionOptions['user'];
    customUserVars?: Record<string, string>;
    requestBody?: t.UserMCPConnectionOptions['requestBody'];
    graphTokenResolver?: t.UserMCPConnectionOptions['graphTokenResolver'];
  }): Promise<t.ParsedServerConfig> {
    /** Mirrors the factory's entry-point normalization; without it this
     *  validation pass would inspect a different header map than the one the
     *  connection ends up sending. */
    const runtimeConfig = applyRequestHeaders(config);
    const dbSourced = isUserSourced(runtimeConfig);
    /** Plugin-authored placeholders must never resolve against the user's Graph token. */
    const graphProcessedConfig =
      dbSourced || isPluginSourced(runtimeConfig)
        ? runtimeConfig
        : await preProcessGraphTokens(runtimeConfig, {
            user,
            graphTokenResolver,
            scopes: process.env.GRAPH_API_SCOPES,
          });

    return processMCPEnv({
      user,
      body: requestBody,
      dbSourced,
      options: graphProcessedConfig,
      customUserVars,
    }) as t.ParsedServerConfig;
  }

  protected async assertResolvedRuntimeConfigAllowed({
    config,
    user,
    customUserVars,
    requestBody,
    graphTokenResolver,
    allowedDomains,
    allowedAddresses,
    logPrefix,
  }: {
    config: t.ParsedServerConfig;
    user?: t.UserMCPConnectionOptions['user'];
    customUserVars?: Record<string, string>;
    requestBody?: t.UserMCPConnectionOptions['requestBody'];
    graphTokenResolver?: t.UserMCPConnectionOptions['graphTokenResolver'];
    allowedDomains?: string[] | null;
    allowedAddresses?: string[] | null;
    logPrefix: string;
  }): Promise<t.ParsedServerConfig> {
    const resolvedConfig = await this.resolveRuntimeConfig({
      config,
      user,
      customUserVars,
      requestBody,
      graphTokenResolver,
    });

    if (!resolvedConfig.url) {
      return resolvedConfig;
    }

    if (hasRuntimeUrlPlaceholders(resolvedConfig)) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${logPrefix} Runtime URL still contains unresolved MCP placeholders after resolution.`,
      );
    }

    const allowed = await isMCPDomainAllowed(resolvedConfig, allowedDomains, allowedAddresses);
    if (!allowed) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `${logPrefix} Resolved MCP server URL is not allowed by the configured domain policy.`,
      );
    }

    return resolvedConfig;
  }

  private async applyRuntimeOAuthDetection({
    config,
    user,
    customUserVars,
    requestBody,
    graphTokenResolver,
  }: {
    config: t.ParsedServerConfig;
    user?: t.UserMCPConnectionOptions['user'];
    customUserVars?: Record<string, string>;
    requestBody?: t.UserMCPConnectionOptions['requestBody'];
    graphTokenResolver?: t.UserMCPConnectionOptions['graphTokenResolver'];
  }): Promise<t.ParsedServerConfig> {
    if (
      config.requiresOAuth != null ||
      (config.apiKey != null && config.oauth == null) ||
      !hasRuntimeUrlPlaceholders(config)
    ) {
      return config;
    }

    const resolvedConfig = await this.resolveRuntimeConfig({
      config,
      user,
      customUserVars,
      requestBody,
      graphTokenResolver,
    });

    if (!resolvedConfig.url || hasRuntimeUrlPlaceholders(resolvedConfig)) {
      logger.warn(
        `[MCP][User: ${user?.id}] Runtime URL still contains placeholders after resolution; skipping OAuth detection`,
      );
      return config;
    }

    const registry = MCPServersRegistry.getInstance();
    const { allowedDomains, allowedAddresses } = await registry.resolveAllowlists({
      userId: user?.id,
      role: user?.role,
    });
    const allowed = await isMCPDomainAllowed(resolvedConfig, allowedDomains, allowedAddresses);
    if (!allowed) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `[MCP][User: ${user?.id}][${config.url}] Resolved MCP server URL is not allowed by the configured domain policy.`,
      );
    }

    const result = await detectOAuthRequirement(
      resolvedConfig.url,
      allowedDomains,
      allowedAddresses,
    );

    return {
      ...config,
      requiresOAuth: result.requiresOAuth,
      oauthMetadata: result.metadata,
    };
  }

  /** Returns all connections for a specific user */
  public getUserConnections(userId: string): Map<string, MCPConnection> | undefined {
    return this.userConnections.get(userId);
  }

  /** Removes a specific user connection entry */
  protected removeUserConnection(userId: string, serverName: string): void {
    const userMap = this.userConnections.get(userId);
    if (userMap) {
      userMap.delete(serverName);
      if (userMap.size === 0) {
        this.userConnections.delete(userId);
        // Only remove user activity timestamp if all connections are gone
        this.userLastActivity.delete(userId);
      }
    }

    logger.debug(`[MCP][User: ${userId}] Removed connection entry`);
  }

  protected retainConnection(connection: MCPConnection): void {
    const borrowers = this.connectionBorrowers.get(connection) ?? 0;
    this.connectionBorrowers.set(connection, borrowers + 1);
  }

  protected getActiveConnectionRecovery(_connection: MCPConnection): Promise<void> | undefined {
    return undefined;
  }

  protected propagateDirectBearerRecoveryState(
    _connection: MCPConnection,
    _state?: t.DirectBearerRecoveryState,
  ): void {}

  protected waitForConnectionRecovery(
    recovery: Promise<void>,
    _signal?: AbortSignal,
  ): Promise<void> {
    return recovery;
  }

  protected holdDeferredConnectionDisposal(connection: MCPConnection): void {
    const holds = this.deferredConnectionDisposalHolds.get(connection) ?? 0;
    this.deferredConnectionDisposalHolds.set(connection, holds + 1);
  }

  protected async releaseDeferredConnectionDisposal(connection: MCPConnection): Promise<void> {
    const holds = this.deferredConnectionDisposalHolds.get(connection) ?? 0;
    if (holds > 1) {
      this.deferredConnectionDisposalHolds.set(connection, holds - 1);
      return;
    }
    this.deferredConnectionDisposalHolds.delete(connection);
    await this.finalizeDeferredConnectionDisposal(connection);
  }

  protected async releaseConnection(connection: MCPConnection): Promise<void> {
    const borrowers = this.connectionBorrowers.get(connection) ?? 0;
    if (borrowers > 1) {
      this.connectionBorrowers.set(connection, borrowers - 1);
      return;
    }

    this.connectionBorrowers.delete(connection);
    await this.finalizeDeferredConnectionDisposal(connection);

    const drainWaiters = this.connectionBorrowerDrainWaiters.get(connection);
    if (drainWaiters) {
      this.connectionBorrowerDrainWaiters.delete(connection);
      for (const resolve of drainWaiters) {
        resolve();
      }
    }
  }

  protected hasConnectionBorrowers(connection: MCPConnection): boolean {
    return (this.connectionBorrowers.get(connection) ?? 0) > 0;
  }

  protected waitForConnectionBorrowersToDrain(connection: MCPConnection): Promise<void> {
    if (!this.hasConnectionBorrowers(connection)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      const drainWaiters = this.connectionBorrowerDrainWaiters.get(connection) ?? new Set();
      drainWaiters.add(resolve);
      this.connectionBorrowerDrainWaiters.set(connection, drainWaiters);
    });
  }

  protected bindRequestScopedConnectionStore(
    requestScopedConnections?: t.RequestScopedMCPConnectionStore,
  ): void {
    if (!requestScopedConnections || requestScopedConnections.disposeConnection) {
      return;
    }

    requestScopedConnections.disposeConnection = async (connectionKey, connection) => {
      await this.disposeEvictedConnection(
        connection as MCPConnection,
        `[MCP][Request-scoped: ${connectionKey}]`,
      );
    };
  }

  protected async disposeEvictedConnection(
    connection: MCPConnection,
    logPrefix: string,
  ): Promise<void> {
    this.deferredConnectionDisposals.set(connection, logPrefix);
    await this.finalizeDeferredConnectionDisposal(connection);
  }

  private async finalizeDeferredConnectionDisposal(connection: MCPConnection): Promise<void> {
    if (
      (this.connectionBorrowers.get(connection) ?? 0) > 0 ||
      (this.deferredConnectionDisposalHolds.get(connection) ?? 0) > 0
    ) {
      return;
    }

    const logPrefix = this.deferredConnectionDisposals.get(connection);
    if (!logPrefix) {
      return;
    }
    this.deferredConnectionDisposals.delete(connection);
    await this.disposeConnection(connection, logPrefix);
  }

  private async disposeConnection(connection: MCPConnection, logPrefix: string): Promise<void> {
    try {
      await connection.dispose();
    } catch (error) {
      logger.warn(`${logPrefix} Failed to dispose evicted connection`, error);
    }
  }

  /**
   * Disconnects and removes a specific user connection. Teardowns default to `mutation`, the
   * conservative reading for external callers, which all tear down after committing a change.
   */
  public async disconnectUserConnection(
    userId: string,
    serverName: string,
    { preservedCreation, reason = 'mutation' }: ConnectionTeardownOptions = {},
  ): Promise<void> {
    const pendingKey = `${userId}:${serverName}`;
    const pending = this.pendingConnections.get(pendingKey);
    this.cancelConnectionCreations(pendingKey, reason, preservedCreation);
    if (pending && preservedCreation == null) {
      this.pendingConnections.delete(pendingKey);
    }
    const userMap = this.userConnections.get(userId);
    const connection = userMap?.get(serverName);
    const logPrefix = `[MCP][User: ${userId}]`;
    if (connection) {
      logger.info(`${logPrefix} Disconnecting server connection`);
      connection.removeAllListeners?.('toolsChanged');
      this.removeUserConnection(userId, serverName);
    }
    /**
     * Started in the same synchronous stretch as the fence: `cancelMCPToolsChanged` drops the
     * pending publication before it awaits, so a creation re-established while this teardown
     * is still disposing cannot have its own publication and retry timer cancelled by it.
     */
    const publicationCancelled = cancelMCPToolsChanged({ userId, serverName });
    /** Observed here so a rejection cannot surface as unhandled while disposal is awaited. */
    publicationCancelled.catch(() => undefined);
    try {
      if (connection) {
        await this.disposeEvictedConnection(connection, logPrefix);
      }
    } finally {
      await publicationCancelled;
    }
  }

  /** Disconnects and removes all connections for a specific user */
  public async disconnectUserConnections(
    userId: string,
    { preservedCreation, reason = 'mutation' }: ConnectionTeardownOptions = {},
  ): Promise<void> {
    for (const key of this.activeConnectionCreations.keys()) {
      if (key.startsWith(`${userId}:`)) {
        this.cancelConnectionCreations(key, reason, preservedCreation);
      }
    }
    if (preservedCreation == null) {
      for (const key of this.pendingConnections.keys()) {
        if (key.startsWith(`${userId}:`)) {
          this.pendingConnections.delete(key);
        }
      }
    }
    const userMap = this.userConnections.get(userId);
    const disconnectPromises: Promise<void>[] = [];
    if (userMap) {
      logger.info(`[MCP][User: ${userId}] Disconnecting all servers...`);
      const userServers = Array.from(userMap.keys());
      for (const serverName of userServers) {
        disconnectPromises.push(
          this.disconnectUserConnection(userId, serverName, { preservedCreation, reason }).catch(
            () => {
              logger.error(`[MCP][User: ${userId}] Error during server disconnection`);
            },
          ),
        );
      }
      await Promise.allSettled(disconnectPromises);
      logger.info(`[MCP][User: ${userId}] All connections processed for disconnection.`);
    }
    /**
     * Clear the activity timestamp whenever nothing is left to track, including when userMap
     * was missing. `updateUserLastActivity` can be called before a connection is established
     * (e.g. in MCPManager.callTool prior to getConnection); if that connection attempt fails,
     * the activity entry would otherwise leak and trigger the idle check repeatedly for the
     * same userId. A connection installed while this teardown was disposing keeps its own
     * timestamp: `checkIdleConnections` walks activity rather than connections, so clearing it
     * would hide that connection from every later idle sweep.
     */
    if ((this.userConnections.get(userId)?.size ?? 0) === 0) {
      this.userLastActivity.delete(userId);
    }
  }

  /** Check for and disconnect idle connections */
  protected checkIdleConnections(currentUserId?: string): void {
    const now = Date.now();

    // Iterate through all users to check for idle ones
    for (const [userId, lastActivity] of this.userLastActivity.entries()) {
      if (currentUserId && currentUserId === userId) {
        continue;
      }
      if (now - lastActivity > mcpConfig.USER_CONNECTION_IDLE_TIMEOUT) {
        logger.info(
          `[MCP][User: ${userId}] User idle for too long. Disconnecting all connections...`,
        );
        // Disconnect all user connections asynchronously (fire and forget)
        this.disconnectUserConnections(userId, { reason: 'lifecycle' }).catch(() =>
          logger.error(`[MCP][User: ${userId}] Error disconnecting idle connections`),
        );
      }
    }
  }

  /** Returns counts of tracked users and connections for diagnostics */
  public getConnectionStats(): {
    trackedUsers: number;
    totalConnections: number;
    activityEntries: number;
    appConnectionCount: number;
  } {
    let totalConnections = 0;
    for (const serverMap of this.userConnections.values()) {
      totalConnections += serverMap.size;
    }
    return {
      trackedUsers: this.userConnections.size,
      totalConnections,
      activityEntries: this.userLastActivity.size,
      appConnectionCount: this.appConnections?.getConnectionCount() ?? 0,
    };
  }
}
