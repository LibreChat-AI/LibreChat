import { createHash } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type * as t from '~/mcp/types';
import { registryStatusCache as statusCache } from './cache/RegistryStatusCache';
import { resolveServerInstructions, sanitizeUrlForLogging } from '~/mcp/utils';
import { MCPServersRegistry } from './MCPServersRegistry';
import { withTimeout } from '~/utils';
import { isLeader } from '~/cluster';

const DEFAULT_MCP_INIT_TIMEOUT_MS = 30_000;
const DEFAULT_FOLLOWER_RETRY_MS = 3000;

/**
 * Bumped whenever the registry's persisted storage semantics change in a way the
 * MCP config fingerprint cannot otherwise capture — e.g. how a server's `source`
 * provenance is tagged. It is folded into the init fingerprint so an upgrade
 * forces exactly one cluster-wide re-initialization even when the MCP config is
 * unchanged.
 *
 * Without it, a rolling restart on a Redis-backed cluster leaves the persisted
 * `INITIALIZED_CONFIG_HASH` matching the unchanged config, so replacement
 * followers short-circuit on the stale status and never re-tag entries written
 * by the previous version. Bumped to 3 so cached entries whose `serverInstructions` still holds
 * inspector-fetched text are rewritten with the declaration preserved and the text moved to
 * `resolvedInstructions`. Bumped to 4 so persisted `toolFunctions` are rebuilt
 * with redundant server-name prefixes stripped and `serverToolName` recorded —
 * otherwise a follower accepts the previous deployment's config hash and
 * republishes pre-strip definitions into the current catalog namespace
 * indefinitely.
 */
const REGISTRY_STORAGE_SCHEMA_VERSION = 4;

const parseDurationMs = (
  value: string | undefined,
  fallback: number,
  allowZero = false,
): number => {
  if (value == null) {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (allowZero) {
    return parsed >= 0 ? parsed : fallback;
  }
  return parsed > 0 ? parsed : fallback;
};

type InitializeRegistryOptions = {
  skipStatusLeaderCheck?: boolean;
};

/**
 * Handles initialization of MCP servers at application startup with distributed coordination.
 * In cluster environments, ensures only the leader node performs initialization while followers wait.
 * Connects to each configured MCP server, inspects capabilities and tools, then caches the results.
 * Categorizes servers as either shared app servers (auto-started) or shared user servers (OAuth/on-demand).
 * Uses a timeout mechanism to prevent hanging on unresponsive servers during initialization.
 */
export class MCPServersInitializer {
  /**
   * Initializes MCP servers with distributed leader-follower coordination.
   *
   * Design rationale:
   * - Handles leader crash scenarios: If the leader crashes during initialization, all followers
   *   will independently attempt initialization after a 3-second delay. The first to become leader
   *   will complete the initialization.
   * - Only the leader performs the actual initialization work (reset caches, inspect servers).
   *   When complete, the leader signals completion via `statusCache`, allowing followers to proceed.
   * - Followers wait and poll `statusCache` until the leader finishes, ensuring only one node
   *   performs the expensive initialization operations.
   */
  private static hasInitializedThisProcess = false;

  /** Reset the process-level initialization flag. Only used for testing. */
  public static resetProcessFlag(): void {
    MCPServersInitializer.hasInitializedThisProcess = false;
  }

  public static async initialize(rawConfigs: t.MCPServers): Promise<void> {
    const configHash = MCPServersInitializer.configHash(rawConfigs);
    // On first call in this process, always reset and re-initialize
    // This ensures we don't use stale Redis data from previous runs
    let isFirstAttemptThisProcess = !MCPServersInitializer.hasInitializedThisProcess;
    // Set flag immediately so follower retries use Redis cache for coordination
    MCPServersInitializer.hasInitializedThisProcess = true;
    const followerWaitStartedAt = performance.now();

    while (true) {
      if (!isFirstAttemptThisProcess && (await statusCache.isInitializedFor(configHash))) {
        return;
      }

      if (await isLeader()) {
        await MCPServersInitializer.initializeRegistry(rawConfigs, configHash);
        return;
      }

      const followerWaitMs = performance.now() - followerWaitStartedAt;
      const followerMaxWaitMs = MCPServersInitializer.followerMaxWaitMs();
      if (followerWaitMs >= followerMaxWaitMs) {
        logger.warn(
          '[MCP] Timed out waiting for leader to initialize registry for current config fingerprint; initializing on this instance',
        );
        await MCPServersInitializer.initializeRegistry(rawConfigs, configHash, {
          skipStatusLeaderCheck: true,
        });
        return;
      }

      logger.debug(
        '[MCP] Waiting for leader to initialize registry for current config fingerprint',
      );
      isFirstAttemptThisProcess = false;
      await new Promise((resolve) =>
        setTimeout(
          resolve,
          Math.min(MCPServersInitializer.followerRetryMs(), followerMaxWaitMs - followerWaitMs),
        ),
      );
    }
  }

  private static async initializeRegistry(
    rawConfigs: t.MCPServers,
    configHash: string,
    options?: InitializeRegistryOptions,
  ): Promise<void> {
    await statusCache.reset();
    await MCPServersRegistry.getInstance().reset();
    const serverNames = Object.keys(rawConfigs);
    await Promise.allSettled(
      serverNames.map((serverName) =>
        withTimeout(
          MCPServersInitializer.initializeServer(serverName, rawConfigs[serverName]),
          MCPServersInitializer.initTimeoutMs(),
          `${MCPServersInitializer.prefix(serverName)} Server initialization timed out`,
          logger.error,
        ),
      ),
    );
    await statusCache.setInitialized(true, configHash, {
      skipLeaderCheck: options?.skipStatusLeaderCheck,
    });
  }

  /** Initializes a single server with all its metadata and adds it to appropriate collections */
  public static async initializeServer(serverName: string, rawConfig: t.MCPOptions): Promise<void> {
    try {
      const result = await MCPServersRegistry.getInstance().addServer(
        serverName,
        rawConfig,
        'CACHE',
      );
      MCPServersInitializer.logParsedConfig(serverName, result.config);
    } catch (error) {
      logger.error(`${MCPServersInitializer.prefix(serverName)} Failed to initialize:`, error);
      try {
        await MCPServersRegistry.getInstance().addServerStub(serverName, rawConfig, 'CACHE');
        logger.info(
          `${MCPServersInitializer.prefix(serverName)} Stored stub config for recovery via reinitialize`,
        );
      } catch (stubError) {
        logger.error(
          `${MCPServersInitializer.prefix(serverName)} Failed to store stub config:`,
          stubError,
        );
      }
    }
  }

  // Logs server configuration summary after initialization
  private static logParsedConfig(serverName: string, config: t.ParsedServerConfig): void {
    const prefix = MCPServersInitializer.prefix(serverName);
    logger.info(`${prefix} -------------------------------------------------┐`);
    logger.info(`${prefix} URL: ${config.url ? sanitizeUrlForLogging(config.url) : 'N/A'}`);
    logger.info(`${prefix} OAuth Required: ${config.requiresOAuth}`);
    logger.info(`${prefix} Capabilities: ${config.capabilities}`);
    logger.info(`${prefix} Tools: ${config.tools}`);
    logger.info(
      `${prefix} Server Instructions: ${MCPServersInitializer.formatInstructionsForLogging(
        resolveServerInstructions(config),
      )}`,
    );
    logger.info(`${prefix} Initialized in: ${config.initDuration ?? 'N/A'}ms`);
    logger.info(`${prefix} -------------------------------------------------┘`);
  }

  private static formatInstructionsForLogging(instructions?: string): string {
    if (!instructions) {
      return 'N/A';
    }

    return `configured (${instructions.length} chars)`;
  }

  // Returns formatted log prefix for server messages
  private static prefix(serverName: string): string {
    return `[MCP][${serverName}]`;
  }

  private static configHash(rawConfigs: t.MCPServers): string {
    const registry = MCPServersRegistry.getInstance();
    const fingerprint = {
      schemaVersion: REGISTRY_STORAGE_SCHEMA_VERSION,
      rawConfigs,
      allowedDomains: registry.getAllowedDomains() ?? null,
      allowedAddresses: registry.getAllowedAddresses() ?? null,
    };
    return createHash('sha256')
      .update(JSON.stringify(MCPServersInitializer.sortForHash(fingerprint)))
      .digest('hex');
  }

  private static followerRetryMs(): number {
    return parseDurationMs(process.env.MCP_INIT_FOLLOWER_RETRY_MS, DEFAULT_FOLLOWER_RETRY_MS);
  }

  private static followerMaxWaitMs(): number {
    return parseDurationMs(
      process.env.MCP_INIT_FOLLOWER_MAX_WAIT_MS,
      MCPServersInitializer.initTimeoutMs() + MCPServersInitializer.followerRetryMs(),
      true,
    );
  }

  private static initTimeoutMs(): number {
    return parseDurationMs(process.env.MCP_INIT_TIMEOUT_MS, DEFAULT_MCP_INIT_TIMEOUT_MS);
  }

  private static sortForHash(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => MCPServersInitializer.sortForHash(item));
    }
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, MCPServersInitializer.sortForHash(item)]),
      );
    }
    return value;
  }
}
