import { logger } from '@librechat/data-schemas';
import type { TokenMethods, IUser } from '@librechat/data-schemas';
import type { ParsedServerConfig, UserConnectionContext } from '~/mcp/types';
import type { MCPOAuthTokens } from './types';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { OAuthReconnectionTracker } from './OAuthReconnectionTracker';
import { requiresEphemeralUserConnection } from '~/mcp/utils';
import { FlowStateManager } from '~/flow/manager';
import { MCPManager } from '~/mcp/MCPManager';

const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000; // ms
const RECONNECT_STAGGER_MS = 500; // ms between each server reconnection
type ReconnectOutcome = 'connected' | 'deferred' | 'failed';

export class OAuthReconnectionManager {
  private static instance: OAuthReconnectionManager | null = null;

  protected readonly flowManager: FlowStateManager<MCPOAuthTokens | null>;
  protected readonly tokenMethods: TokenMethods;
  private readonly mcpManager: MCPManager | null;
  private readonly onOAuthCredentialsChanged?: (scope: {
    userId: string;
    serverName: string;
  }) => Promise<void>;

  private readonly onOAuthCredentialsChanging?: UserConnectionContext['onOAuthCredentialsChanging'];

  private readonly reconnectionsTracker: OAuthReconnectionTracker;

  public static getInstance(): OAuthReconnectionManager {
    if (!OAuthReconnectionManager.instance) {
      throw new Error('OAuthReconnectionManager not initialized');
    }
    return OAuthReconnectionManager.instance;
  }

  public static async createInstance(
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
    tokenMethods: TokenMethods,
    reconnections?: OAuthReconnectionTracker,
    onOAuthCredentialsChanged?: (scope: { userId: string; serverName: string }) => Promise<void>,
    onOAuthCredentialsChanging?: UserConnectionContext['onOAuthCredentialsChanging'],
  ): Promise<OAuthReconnectionManager> {
    if (OAuthReconnectionManager.instance != null) {
      throw new Error('OAuthReconnectionManager already initialized');
    }

    const manager = new OAuthReconnectionManager(
      flowManager,
      tokenMethods,
      reconnections,
      onOAuthCredentialsChanged,
      onOAuthCredentialsChanging,
    );
    OAuthReconnectionManager.instance = manager;

    return manager;
  }

  public constructor(
    flowManager: FlowStateManager<MCPOAuthTokens | null>,
    tokenMethods: TokenMethods,
    reconnections?: OAuthReconnectionTracker,
    onOAuthCredentialsChanged?: (scope: { userId: string; serverName: string }) => Promise<void>,
    onOAuthCredentialsChanging?: UserConnectionContext['onOAuthCredentialsChanging'],
  ) {
    this.flowManager = flowManager;
    this.tokenMethods = tokenMethods;
    this.reconnectionsTracker = reconnections ?? new OAuthReconnectionTracker();
    this.onOAuthCredentialsChanged = onOAuthCredentialsChanged;
    this.onOAuthCredentialsChanging = onOAuthCredentialsChanging;

    try {
      this.mcpManager = MCPManager.getInstance();
    } catch {
      this.mcpManager = null;
    }
  }

  public isReconnecting(userId: string, serverName: string): boolean {
    // Clean up if timed out, then return whether still reconnecting
    this.reconnectionsTracker.cleanupIfTimedOut(userId, serverName);
    return this.reconnectionsTracker.isStillReconnecting(userId, serverName);
  }

  /**
   * Reconnects the user's eligible OAuth servers.
   * @param configServers Tenant-scoped Config-tier candidates used to resolve effective overlays.
   */
  public async reconnectServers(
    userId: string,
    configServers?: Record<string, ParsedServerConfig>,
  ): Promise<void> {
    // Check if MCPManager is available
    if (this.mcpManager == null) {
      logger.warn(
        '[OAuthReconnectionManager] MCPManager not available, skipping OAuth MCP server reconnection',
      );
      return;
    }

    // 1. derive the servers to reconnect
    const serversToReconnect = [];
    for (const serverName of await MCPServersRegistry.getInstance().getOAuthServers(userId)) {
      const canReconnect = await this.canReconnect(userId, serverName);
      if (canReconnect) {
        serversToReconnect.push(serverName);
      }
    }

    // 2. mark the servers as reconnecting
    for (const serverName of serversToReconnect) {
      this.reconnectionsTracker.setActive(userId, serverName);
    }

    // 3. attempt to reconnect the servers with staggered delays to avoid connection storms
    for (let i = 0; i < serversToReconnect.length; i++) {
      const serverName = serversToReconnect[i];
      if (i === 0) {
        this.safeTryReconnect(userId, serverName, configServers);
      } else {
        setTimeout(
          () => this.safeTryReconnect(userId, serverName, configServers),
          i * RECONNECT_STAGGER_MS,
        );
      }
    }
  }

  /**
   * Fire-and-forget wrapper around {@link tryReconnect} that guarantees any
   * unexpected rejection is surfaced via the logger instead of propagating as
   * an unhandled promise rejection. Also runs the failed-reconnect cleanup so
   * the tracker does not get stuck in `active` state for the
   * `RECONNECTION_TIMEOUT_MS` window if an error escapes
   * {@link tryReconnect}'s internal try/catch.
   */
  private safeTryReconnect(
    userId: string,
    serverName: string,
    configServers?: Record<string, ParsedServerConfig>,
  ): void {
    this.tryReconnect(userId, serverName, configServers).catch((error) => {
      logger.error(
        `[OAuthReconnectionManager][User: ${userId}][${serverName}] Unexpected reconnect error`,
        error,
      );
      this.cleanupOnFailedReconnect(userId, serverName);
    });
  }

  private cleanupOnFailedReconnect(userId: string, serverName: string): void {
    this.reconnectionsTracker.setFailed(userId, serverName);
    this.reconnectionsTracker.removeActive(userId, serverName);
    this.mcpManager?.disconnectUserConnection(userId, serverName, { reason: 'lifecycle' });
  }

  /**
   * Attempts to reconnect a single OAuth MCP server.
   * @param configServers Tenant-scoped Config-tier candidates used to resolve the effective config.
   * @returns true if reconnection succeeded, false otherwise.
   */
  public async reconnectServer(
    userId: string,
    serverName: string,
    configServers?: Record<string, ParsedServerConfig>,
  ): Promise<boolean> {
    if (this.mcpManager == null) {
      return false;
    }

    this.reconnectionsTracker.setActive(userId, serverName);
    try {
      return (await this.tryReconnect(userId, serverName, configServers)) === 'connected';
    } catch {
      return false;
    }
  }

  public clearReconnection(userId: string, serverName: string): void {
    this.reconnectionsTracker.removeFailed(userId, serverName);
    this.reconnectionsTracker.removeActive(userId, serverName);
  }

  private async tryReconnect(
    userId: string,
    serverName: string,
    configServers?: Record<string, ParsedServerConfig>,
  ): Promise<ReconnectOutcome> {
    if (this.mcpManager == null) {
      return 'failed';
    }

    const logPrefix = `[tryReconnectOAuthMCPServer][User: ${userId}][${serverName}]`;

    logger.info(`${logPrefix} Attempting reconnection`);

    try {
      const config = await MCPServersRegistry.getInstance().getServerConfig(
        serverName,
        userId,
        configServers,
      );
      if (config && requiresEphemeralUserConnection(config)) {
        logger.info(`${logPrefix} Deferring request-scoped connection until chat use`);
        this.clearReconnection(userId, serverName);
        return 'deferred';
      }

      // attempt to get connection (this will use existing tokens and refresh if needed)
      const connection = await this.mcpManager.getUserConnection({
        serverName,
        user: { id: userId } as IUser,
        serverConfig: config,
        flowManager: this.flowManager,
        tokenMethods: this.tokenMethods,
        ...(this.onOAuthCredentialsChanged && {
          onOAuthCredentialsChanged: this.onOAuthCredentialsChanged,
        }),
        ...(this.onOAuthCredentialsChanging && {
          onOAuthCredentialsChanging: this.onOAuthCredentialsChanging,
        }),
        // don't force new connection, let it reuse existing or create new as needed
        forceNew: false,
        // set a reasonable timeout for reconnection attempts
        connectionTimeout: config?.initTimeout ?? DEFAULT_CONNECTION_TIMEOUT_MS,
        // don't trigger OAuth flow during reconnection
        returnOnOAuth: true,
      });

      if (connection && (await connection.isConnected())) {
        logger.info(`${logPrefix} Successfully reconnected`);
        this.clearReconnection(userId, serverName);
        return 'connected';
      } else {
        logger.warn(`${logPrefix} Failed to reconnect`);
        await connection?.disconnect();
        this.cleanupOnFailedReconnect(userId, serverName);
        return 'failed';
      }
    } catch (error) {
      logger.warn(`${logPrefix} Failed to reconnect: ${error}`);
      this.cleanupOnFailedReconnect(userId, serverName);
      return 'failed';
    }
  }

  public getTrackerStats(): {
    usersWithFailedServers: number;
    usersWithActiveReconnections: number;
    activeTimestamps: number;
  } {
    return this.reconnectionsTracker.getStats();
  }

  private async canReconnect(userId: string, serverName: string) {
    if (this.mcpManager == null) {
      return false;
    }

    // if the server has failed reconnection, don't attempt to reconnect
    if (this.reconnectionsTracker.isFailed(userId, serverName)) {
      return false;
    }

    if (this.reconnectionsTracker.isActive(userId, serverName)) {
      return false;
    }

    // if the server is already connected, don't attempt to reconnect
    const existingConnections = this.mcpManager.getUserConnections(userId);
    if (existingConnections?.has(serverName)) {
      const isConnected = await existingConnections.get(serverName)?.isConnected();
      if (isConnected) {
        return false;
      }
    }

    // if the server has a valid (non-expired) access token, allow reconnect
    const accessToken = await this.tokenMethods.findToken({
      userId,
      type: 'mcp_oauth',
      identifier: `mcp:${serverName}`,
    });

    if (accessToken != null) {
      const now = new Date();
      if (!accessToken.expiresAt || accessToken.expiresAt >= now) {
        return true;
      }
    }

    // if the access token is expired or TTL-deleted, fall back to refresh token
    const refreshToken = await this.tokenMethods.findToken({
      userId,
      type: 'mcp_oauth',
      identifier: `mcp:${serverName}:refresh`,
    });

    if (refreshToken == null) {
      return false;
    }

    return true;
  }
}
