import { logger } from '@librechat/data-schemas';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type * as t from './types';
import {
  cancelMCPToolsChanged,
  getMCPAppToolsPublicationGeneration,
  getMCPToolCatalogGeneration,
  notifyMCPToolsChanged,
} from './toolsChanged';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { STANDARD_MCP_CAPABILITY_PROFILE } from './capabilities';
import { canUseAppConnection, isUserSourced } from './utils';
import { MCPConnection } from './connection';

const CONNECT_CONCURRENCY = 3;

interface ConnectionLoadOptions {
  continueOnError?: boolean;
  expectedConfig?: t.ParsedServerConfig;
  refreshTools?: boolean;
}

/**
 * Manages MCP connections with lazy loading and reconnection.
 * Maintains a pool of connections and handles connection lifecycle management.
 * Queries server configurations dynamically from the MCPServersRegistry (single source of truth).
 *
 * Scope-aware: Each repository is tied to a specific owner scope:
 * - ownerId = undefined → manages app-level servers only
 * - ownerId = userId → manages user-level and private servers for that user
 */
export class ConnectionsRepository {
  protected connections: Map<string, MCPConnection> = new Map();
  private readonly connectionConfigGenerations = new Map<string, string>();
  protected oauthOpts: t.OAuthConnectionOptions | undefined;
  private readonly ownerId: string | undefined;
  private readonly connectionOperations = new Map<string, Promise<void>>();
  private shuttingDown = false;

  constructor(ownerId?: string, oauthOpts?: t.OAuthConnectionOptions) {
    this.ownerId = ownerId;
    this.oauthOpts = oauthOpts;
  }

  /** Returns the number of active connections in this repository */
  public getConnectionCount(): number {
    return this.connections.size;
  }

  /** Serializes connection lifecycle transitions for one server without blocking other servers. */
  private runConnectionOperation<T>(serverName: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.connectionOperations.get(serverName) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.connectionOperations.set(serverName, tail);
    void tail.then(() => {
      if (this.connectionOperations.get(serverName) === tail) {
        this.connectionOperations.delete(serverName);
      }
    });
    return result;
  }

  private async isExpectedConfigCurrent(
    serverName: string,
    expectedGeneration: string,
  ): Promise<boolean> {
    const currentConfig = await MCPServersRegistry.getInstance().getServerConfig(
      serverName,
      this.ownerId,
    );
    return (
      currentConfig != null &&
      getMCPAppToolsPublicationGeneration(currentConfig) === expectedGeneration
    );
  }

  private configChangedError(serverName: string): McpError {
    return new McpError(
      ErrorCode.InvalidRequest,
      `[MCP] Configuration for server "${serverName}" changed during connection checkout.`,
    );
  }

  private async returnExpectedConnection(
    serverName: string,
    connection: MCPConnection,
    expectedGeneration?: string,
  ): Promise<MCPConnection> {
    if (
      !expectedGeneration ||
      (await this.isExpectedConfigCurrent(serverName, expectedGeneration))
    ) {
      return connection;
    }
    await this.disconnectConnection(serverName);
    throw this.configChangedError(serverName);
  }

  /** Checks whether this repository can connect to a specific server */
  async has(serverName: string): Promise<boolean> {
    const config = await MCPServersRegistry.getInstance().getServerConfig(serverName, this.ownerId);
    const canConnect = !!config && this.isAllowedToConnectToServer(config);
    if (!canConnect) {
      //if connection is no longer possible we attempt to disconnect any leftover connections
      await this.disconnect(serverName);
    }
    return canConnect;
  }

  /** The connection currently pooled for a server, without loading, validating or creating one. */
  public getPooledConnection(serverName: string): MCPConnection | undefined {
    return this.connections.get(serverName);
  }

  /** Gets or creates a connection for the specified server with lazy loading */
  async get(
    serverName: string,
    options: ConnectionLoadOptions = {},
  ): Promise<MCPConnection | null> {
    if (this.shuttingDown) {
      return null;
    }
    return this.runConnectionOperation(serverName, () => this.loadConnection(serverName, options));
  }

  private async loadConnection(
    serverName: string,
    options: ConnectionLoadOptions,
  ): Promise<MCPConnection | null> {
    if (this.shuttingDown) {
      return null;
    }
    const registry = MCPServersRegistry.getInstance();
    const currentConfig = await registry.getServerConfig(serverName, this.ownerId);
    const expectedGeneration = options.expectedConfig
      ? getMCPAppToolsPublicationGeneration(options.expectedConfig)
      : undefined;
    const currentGeneration = currentConfig
      ? getMCPAppToolsPublicationGeneration(currentConfig)
      : undefined;
    if (expectedGeneration && expectedGeneration !== currentGeneration) {
      throw this.configChangedError(serverName);
    }
    const serverConfig = options.expectedConfig ?? currentConfig;

    const existingConnection = this.connections.get(serverName);
    if (!serverConfig || !this.isAllowedToConnectToServer(serverConfig)) {
      await this.disconnectConnection(serverName);
      return null;
    }
    if (existingConnection) {
      if (
        expectedGeneration &&
        this.connectionConfigGenerations.get(serverName) !== expectedGeneration
      ) {
        await this.disconnectConnection(serverName);
      } else if (serverConfig.updatedAt && existingConnection.isStale(serverConfig.updatedAt)) {
        logger.info(`${this.prefix()} Existing connection is outdated; recreating`, {
          connectionCreated: new Date(existingConnection.createdAt).toISOString(),
          configCachedAt: new Date(serverConfig.updatedAt).toISOString(),
        });
        await this.disconnectConnection(serverName);
      } else if (await existingConnection.isConnected()) {
        return this.returnExpectedConnection(serverName, existingConnection, expectedGeneration);
      } else {
        await this.disconnectConnection(serverName);
      }
    }
    const { allowedDomains, allowedAddresses, useSSRFProtection } =
      await registry.resolveAllowlists({ userId: this.ownerId });
    const publicationGeneration =
      this.ownerId === undefined
        ? getMCPToolCatalogGeneration(serverConfig, STANDARD_MCP_CAPABILITY_PROFILE)
        : undefined;
    const connection = await MCPConnectionFactory.create(
      {
        serverName,
        serverConfig,
        dbSourced: isUserSourced(serverConfig as t.ParsedServerConfig),
        useSSRFProtection,
        allowedDomains,
        allowedAddresses,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      },
      this.oauthOpts,
    );

    if (this.shuttingDown) {
      await connection.dispose();
      await cancelMCPToolsChanged({
        userId: this.ownerId,
        serverName,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
      return null;
    }

    if (expectedGeneration) {
      if (!(await this.isExpectedConfigCurrent(serverName, expectedGeneration))) {
        await connection.dispose();
        throw this.configChangedError(serverName);
      }
    }

    let toolsChangedGeneration = 0;
    let latestToolsChangedPublication = Promise.resolve();

    /* Both scopes get the same treatment: this repository is per-owner, so ownerId already says
     * whose tool cache a change belongs to (undefined = the app-level, shared one). */
    connection.on('toolsChanged', (tools: t.MCPTool[], publicationRevision?: string) => {
      toolsChangedGeneration++;
      latestToolsChangedPublication = notifyMCPToolsChanged({
        tools,
        serverName,
        serverConfig,
        userId: this.ownerId,
        publicationGeneration,
        publicationRevision,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
      void latestToolsChangedPublication;
    });

    this.connections.set(serverName, connection);
    this.connectionConfigGenerations.set(
      serverName,
      getMCPAppToolsPublicationGeneration(serverConfig),
    );
    if (this.ownerId === undefined && options.refreshTools !== false) {
      /** The snapshot carries ordering reserved before its own `tools/list`, so this
       * first-connect publication is ordered against concurrent replicas exactly as a
       * list_changed refresh is. An app-level write that cannot be ordered is dropped, which
       * left agents with a permanently empty catalog when this path populated it (#14857). */
      if (connection.client.getServerCapabilities()?.tools == null) {
        const ordering = await connection.reserveToolsPublicationRevision();
        /** The refresh path reserves again under backoff. Publishing unordered instead would be
         * dropped in silence, leaving whatever this server last advertised in place. */
        if (ordering.orderingUnavailable) {
          await connection.refreshToolList();
          return this.returnExpectedConnection(serverName, connection, expectedGeneration);
        }
        await notifyMCPToolsChanged({
          tools: [],
          serverName,
          serverConfig,
          publicationGeneration,
          publicationRevision: ordering.publicationRevision,
          capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
        });
        return this.returnExpectedConnection(serverName, connection, expectedGeneration);
      }
      const initialGeneration = toolsChangedGeneration;
      const snapshot = await connection.fetchToolsSnapshot();
      if (snapshot.complete && !snapshot.orderingUnavailable) {
        if (toolsChangedGeneration !== initialGeneration) {
          await latestToolsChangedPublication;
        } else {
          await notifyMCPToolsChanged({
            tools: snapshot.tools,
            serverName,
            serverConfig,
            publicationGeneration,
            publicationRevision: snapshot.publicationRevision,
            capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
          });
        }
      } else {
        await connection.refreshToolList();
      }
    }
    return this.returnExpectedConnection(serverName, connection, expectedGeneration);
  }

  /** Gets or creates connections for multiple servers concurrently */
  async getMany(
    serverNames: string[],
    options: ConnectionLoadOptions = {},
  ): Promise<Map<string, MCPConnection>> {
    const results: [string, MCPConnection | null][] = [];
    for (let i = 0; i < serverNames.length; i += CONNECT_CONCURRENCY) {
      const batch = serverNames.slice(i, i + CONNECT_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (name): Promise<[string, MCPConnection | null]> => {
          try {
            return [name, await this.get(name, options)];
          } catch (error) {
            if (!options.continueOnError) {
              throw error;
            }
            logger.warn(`${this.prefix()} Failed to establish connection`);
            return [name, null];
          }
        }),
      );
      results.push(...batchResults);
    }
    return new Map(results.filter((v): v is [string, MCPConnection] => v[1] != null));
  }

  /** Returns all currently loaded connections without creating new ones */
  async getLoaded(): Promise<Map<string, MCPConnection>> {
    return this.getMany(Array.from(this.connections.keys()));
  }

  /** Gets or creates connections for all configured servers in this repository's scope */
  async getAll(options: ConnectionLoadOptions = {}): Promise<Map<string, MCPConnection>> {
    //TODO in the future we should use a scoped config getter (APPLevel, UserLevel, Private)
    //for now the absent config will not throw error
    const allConfigs = await MCPServersRegistry.getInstance().getAllServerConfigs(this.ownerId);
    return this.getMany(Object.keys(allConfigs), options);
  }

  /** Disconnects and removes a specific server connection from the pool */
  async disconnect(serverName: string): Promise<void> {
    return this.runConnectionOperation(serverName, () => this.disconnectConnection(serverName));
  }

  private async disconnectConnection(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName);
    if (!connection) {
      await cancelMCPToolsChanged({
        userId: this.ownerId,
        serverName,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
      return;
    }
    this.connections.delete(serverName);
    this.connectionConfigGenerations.delete(serverName);
    try {
      connection.removeAllListeners?.('toolsChanged');
      await connection.dispose();
    } catch {
      logger.error(`${this.prefix()} Error disposing`);
    } finally {
      await cancelMCPToolsChanged({
        userId: this.ownerId,
        serverName,
        capabilityProfile: STANDARD_MCP_CAPABILITY_PROFILE,
      });
    }
  }

  /** Disconnects all active connections and returns array of disconnect promises */
  disconnectAll(): Promise<void>[] {
    this.shuttingDown = true;
    return [this.drainAndDisconnectAll()];
  }

  private async drainAndDisconnectAll(): Promise<void> {
    await Promise.allSettled(Array.from(this.connectionOperations.values()));
    const serverNames = Array.from(this.connections.keys());
    await Promise.all(serverNames.map((serverName) => this.disconnect(serverName)));
  }

  // Returns formatted log prefix for server messages
  protected prefix(): string {
    return this.ownerId ? `[MCP][User: ${this.ownerId}]` : '[MCP]';
  }

  /**
   * App-level (shared) connections cannot serve servers that need per-user context:
   * env/header placeholders like `{{MY_KEY}}` are only resolved by `processMCPEnv()`
   * when real `customUserVars` values exist — which requires a user-level connection.
   * OBO servers also require a user-level connection because each tool call
   * uses the current user's bearer token.
   */
  private isAllowedToConnectToServer(config: t.ParsedServerConfig) {
    if (config.inspectionFailed) {
      return false;
    }
    if (this.ownerId === undefined && !canUseAppConnection(config)) {
      return false;
    }
    return true;
  }
}
