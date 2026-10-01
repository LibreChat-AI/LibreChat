import { logger } from '@librechat/data-schemas';
import { DynamicStructuredTool } from '@librechat/agents/langchain/tools';
import { patchConfig, pickRunnableConfigKeys } from '@langchain/core/runnables';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import {
  Constants,
  buildServerNameAliases,
  normalizeServerName,
  stripServerNamePrefixes,
} from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { JsonSchemaType } from '@librechat/agents';
import type { LCAvailableTools, LCFunctionTool, ParsedServerConfig } from './types';
import type { MCPClientCapabilityProfile } from './capabilities';
import { canUseAppConnection, requiresEphemeralUserConnection } from './utils';
import { normalizeJsonSchema, resolveJsonSchemaRefs } from './zod';
import { STANDARD_MCP_CAPABILITY_PROFILE } from './capabilities';
import { getMCPToolCatalogGeneration } from './toolsChanged';
import { isToolHiddenFromModel } from './apps';

type DynamicStructuredToolFields = ConstructorParameters<typeof DynamicStructuredTool>[0];
type DynamicStructuredToolFunction = DynamicStructuredToolFields['func'];

export function createMCPStructuredTool(
  func: (
    input: Parameters<DynamicStructuredToolFunction>[0],
    config?: Parameters<DynamicStructuredToolFunction>[2],
  ) => ReturnType<DynamicStructuredToolFunction>,
  fields: Omit<DynamicStructuredToolFields, 'func'>,
): DynamicStructuredTool<unknown> {
  return new DynamicStructuredTool({
    ...fields,
    func: (input, runManager, config) => {
      const childConfig = patchConfig(config, { callbacks: runManager?.getChild() });
      return AsyncLocalStorageProviderSingleton.runWithConfig(
        pickRunnableConfigKeys(childConfig),
        () => func(input, childConfig),
      );
    },
  });
}

/** `_meta` carries the MCP Apps `ui.visibility` used to hide app-only tools from the model. */
export type MCPToolInput = Pick<Tool, 'name' | 'description'> &
  Partial<Pick<Tool, 'inputSchema' | '_meta'>>;

export interface MCPToolCacheDeps {
  getCachedTools: (options?: {
    userId?: string;
    serverName?: string;
    configGeneration?: string;
    allowLegacyMigration?: boolean;
  }) => Promise<LCAvailableTools | null>;
  updateCachedGlobalTools?: (
    update: (tools: LCAvailableTools) => LCAvailableTools,
  ) => Promise<void>;
  setCachedTools: (
    tools: LCAvailableTools,
    options?: { userId?: string; serverName?: string; configGeneration?: string },
  ) => Promise<boolean>;
  setCachedToolsIfCurrent?: (
    tools: LCAvailableTools,
    options: {
      userId: string;
      serverName: string;
      configGeneration: string;
      publicationGeneration: string;
    },
  ) => Promise<boolean>;
  getCachedAppServerTools: (
    serverName: string,
    configGeneration: string,
  ) => Promise<LCAvailableTools | null>;
  setCachedAppServerTools: (
    serverName: string,
    configGeneration: string,
    tools: LCAvailableTools,
    publicationRevision?: string,
  ) => Promise<boolean>;
  getServerConfig: (serverName: string, userId?: string) => Promise<ParsedServerConfig | undefined>;
  getAllServerConfigs?: () => Promise<Record<string, ParsedServerConfig>>;
  isAppServerConfig?: (serverName: string, effectiveConfig: ParsedServerConfig) => Promise<boolean>;
}

export interface MCPToolCacheService {
  updateMCPServerTools: (params: {
    userId?: string;
    serverName: string;
    tools: MCPToolInput[] | null;
    serverConfig?: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
    capabilityProfile?: MCPClientCapabilityProfile;
  }) => Promise<LCAvailableTools | null>;
  syncStaticTools: (staticTools: LCAvailableTools) => Promise<void>;
  mergeAppTools: (appTools: LCAvailableTools, staticTools: LCAvailableTools) => Promise<void>;
  replaceAppServerTools: (params: {
    serverName: string;
    serverTools: LCAvailableTools;
    publicationGeneration?: string;
    publicationRevision?: string;
  }) => Promise<boolean>;
  cacheMCPServerTools: (params: {
    userId: string;
    serverName: string;
    serverTools: LCAvailableTools;
    serverConfig?: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
    capabilityProfile?: MCPClientCapabilityProfile;
  }) => Promise<void>;
  getMCPServerTools: (
    userId: string,
    serverName: string,
    serverConfig?: ParsedServerConfig,
    capabilityProfile?: MCPClientCapabilityProfile,
  ) => Promise<LCAvailableTools | null>;
}

/** Converts an MCP tools/list response into LibreChat's server-qualified catalog format. */
export function formatMCPServerTools(serverName: string, tools: MCPToolInput[]): LCAvailableTools {
  const serverTools: LCAvailableTools = {};
  const keyServerName = normalizeServerName(serverName);
  const keyToolNames = stripServerNamePrefixes(
    tools.map((tool) => tool.name),
    keyServerName,
  );
  for (const tool of tools) {
    if (isToolHiddenFromModel(tool)) {
      continue;
    }
    const keyToolName = keyToolNames.get(tool.name) ?? tool.name;
    const name = `${keyToolName}${Constants.mcp_delimiter}${keyServerName}`;
    const entry: LCFunctionTool = {
      type: 'function',
      ['function']: {
        name,
        description: tool.description ?? '',
        parameters: tool.inputSchema
          ? (normalizeJsonSchema(resolveJsonSchemaRefs(tool.inputSchema)) as JsonSchemaType)
          : ({ type: 'object', properties: {} } as JsonSchemaType),
      },
    };
    if (keyToolName !== tool.name) {
      entry.serverToolName = tool.name;
    }
    serverTools[name] = entry;
  }
  return serverTools;
}

interface AppServerBoundary {
  serverName: string;
  suffix: string;
}

export function createMCPToolCacheService(deps: MCPToolCacheDeps): MCPToolCacheService {
  const {
    getCachedTools,
    updateCachedGlobalTools,
    setCachedTools,
    setCachedToolsIfCurrent,
    getCachedAppServerTools,
    setCachedAppServerTools,
    getServerConfig,
    getAllServerConfigs,
    isAppServerConfig,
  } = deps;

  async function writeCachedTools(
    tools: LCAvailableTools,
    options?: { userId?: string; serverName?: string; configGeneration?: string },
  ): Promise<void> {
    const success = options ? await setCachedTools(tools, options) : await setCachedTools(tools);
    if (success === false) {
      throw new Error('Tool cache rejected the write');
    }
  }

  async function isAppSharedConfig(
    serverName: string,
    config: ParsedServerConfig | undefined,
  ): Promise<boolean> {
    if (!config || !canUseAppConnection(config)) {
      return false;
    }
    if (isAppServerConfig) {
      return isAppServerConfig(serverName, config);
    }
    if (!getAllServerConfigs) {
      return true;
    }
    try {
      const appConfigs = await getAllServerConfigs();
      return appConfigs[serverName] != null;
    } catch {
      logger.debug('[MCP Cache] Could not verify app ownership; using user scope');
      return false;
    }
  }

  async function resolveCacheConfig(
    userId: string | undefined,
    serverName: string,
    serverConfig?: ParsedServerConfig,
  ): Promise<ParsedServerConfig | undefined> {
    if (serverConfig) {
      return serverConfig;
    }
    try {
      return await getServerConfig(serverName, userId);
    } catch (error) {
      logger.debug(
        `[MCP Cache] Could not resolve config for ${serverName} (user: ${userId}), preserving legacy cache scope:`,
        error,
      );
      return undefined;
    }
  }

  function buildAppServerBoundaries(serverNames: readonly string[]): AppServerBoundary[] {
    const names = Array.from(new Set(serverNames));
    const boundaryOwners = new Map<string, string>();
    for (const rawName of names) {
      if (normalizeServerName(rawName) !== rawName) {
        boundaryOwners.set(`${Constants.mcp_delimiter}${rawName}`, rawName);
      }
    }
    for (const [normalizedName, rawName] of buildServerNameAliases(names)) {
      boundaryOwners.set(`${Constants.mcp_delimiter}${normalizedName}`, rawName);
    }

    return Array.from(boundaryOwners, ([suffix, rawName]) => ({
      serverName: rawName,
      suffix,
    })).sort((left, right) => right.suffix.length - left.suffix.length);
  }

  async function getAppServerNames(): Promise<string[]> {
    if (!getAllServerConfigs) {
      return [];
    }
    return Object.entries(await getAllServerConfigs())
      .filter(([, config]) => canUseAppConnection(config))
      .map(([name]) => name);
  }

  async function getAppServerBoundaries(serverName: string): Promise<AppServerBoundary[]> {
    const names = await getAppServerNames();
    if (!names.includes(serverName)) {
      names.push(serverName);
    }
    return buildAppServerBoundaries(names);
  }

  function resolveToolServerName(
    toolName: string,
    boundaries: readonly AppServerBoundary[],
  ): string | null {
    for (const boundary of boundaries) {
      if (toolName.endsWith(boundary.suffix)) {
        return boundary.serverName;
      }
    }
    return null;
  }

  function getAppServerSlice(
    tools: LCAvailableTools,
    serverName: string,
    boundaries: readonly AppServerBoundary[],
  ): LCAvailableTools {
    return Object.fromEntries(
      Object.entries(tools).filter(
        ([name]) => resolveToolServerName(name, boundaries) === serverName,
      ),
    );
  }

  async function updateMCPServerTools(params: {
    userId?: string;
    serverName: string;
    tools: MCPToolInput[] | null;
    serverConfig?: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
    capabilityProfile?: MCPClientCapabilityProfile;
  }): Promise<LCAvailableTools | null> {
    const { userId, serverName, tools, serverConfig, publicationGeneration, publicationRevision } =
      params;
    const capabilityProfile = params.capabilityProfile ?? STANDARD_MCP_CAPABILITY_PROFILE;
    try {
      if (tools == null) {
        logger.debug('[MCP Cache] No tools to update');
        return {};
      }
      /** Cache keys are model-facing and must match runtime tool instance names. */
      const serverTools = formatMCPServerTools(serverName, tools);

      const resolvedConfig = await resolveCacheConfig(userId, serverName, serverConfig);
      const configGeneration = resolvedConfig
        ? getMCPToolCatalogGeneration(resolvedConfig, capabilityProfile)
        : undefined;
      if (resolvedConfig && requiresEphemeralUserConnection(resolvedConfig)) {
        logger.debug(`[MCP Cache] Built ${tools.length} request-scoped tool(s) without caching`);
        return serverTools;
      }

      if (
        userId &&
        (capabilityProfile !== STANDARD_MCP_CAPABILITY_PROFILE ||
          !(await isAppSharedConfig(serverName, resolvedConfig)))
      ) {
        if (setCachedToolsIfCurrent) {
          if (!publicationGeneration || !configGeneration) {
            logger.debug('[MCP Cache] Skipped unfenced or unaddressed tool publication');
            return null;
          }
          const current = await setCachedToolsIfCurrent(serverTools, {
            userId,
            serverName,
            configGeneration,
            publicationGeneration,
          });
          if (!current) {
            logger.debug('[MCP Cache] Ignored stale tool publication');
            return null;
          }
        } else {
          await writeCachedTools(serverTools, { userId, serverName, configGeneration });
        }
      } else {
        const appConfigGeneration =
          userId == null
            ? (publicationGeneration ?? configGeneration)
            : (configGeneration ?? publicationGeneration);
        /** Only the shared catalog write needs ordering. These tools were just read from the
         * server, so the caller should still serve them; discarding a correct tool list because
         * its write could not be ordered is what makes a cache failure look to the user like a
         * server with no tools at all (#14857). A superseded write is different — another
         * replica holds something newer — and still discards below. */
        if (!publicationRevision) {
          logger.warn(
            `[MCP Cache] Serving ${tools.length} unpublished tools for ${serverName}: this snapshot reserved no revision, so every request re-fetches them`,
          );
          return serverTools;
        }
        const replaced = await replaceAppServerTools({
          serverName,
          serverTools,
          publicationGeneration: appConfigGeneration,
          publicationRevision,
        });
        if (!replaced) {
          return null;
        }
      }
      logger.debug(`[MCP Cache] Updated ${tools.length} server tool(s)`);
      return serverTools;
    } catch (error) {
      logger.error('[MCP Cache] Failed to update server tools');
      throw error;
    }
  }

  async function mergeAppTools(
    appTools: LCAvailableTools,
    staticTools: LCAvailableTools,
  ): Promise<void> {
    try {
      const count = Object.keys(appTools).length;
      const appConfigs = getAllServerConfigs
        ? Object.entries(await getAllServerConfigs()).filter(([, config]) =>
            canUseAppConnection(config),
          )
        : [];
      const boundaries = buildAppServerBoundaries(appConfigs.map(([serverName]) => serverName));
      await syncStaticTools(staticTools);
      await Promise.all(
        appConfigs
          .filter(([, config]) => config.toolFunctions != null)
          .map(async ([serverName, config]) => {
            const serverTools = getAppServerSlice(appTools, serverName, boundaries);
            const configGeneration = getMCPToolCatalogGeneration(
              config,
              STANDARD_MCP_CAPABILITY_PROFILE,
            );
            await setCachedAppServerTools(serverName, configGeneration, serverTools);
          }),
      );
      logger.debug(`Synchronized ${count} app-level MCP tools`);
    } catch (error) {
      logger.error('Failed to merge app-level tools:', error);
      throw error;
    }
  }

  async function syncStaticTools(staticTools: LCAvailableTools): Promise<void> {
    await updateCachedGlobalTools?.(() => staticTools);
  }

  /**
   * Replaces one server's configuration-addressed app-level snapshot. Old and new replicas may
   * publish concurrently without overwriting each other; readers select the current config key.
   */
  async function replaceAppServerTools(params: {
    serverName: string;
    serverTools: LCAvailableTools;
    publicationGeneration?: string;
    publicationRevision?: string;
  }): Promise<boolean> {
    const { serverName, serverTools, publicationGeneration, publicationRevision } = params;
    try {
      const boundaries = await getAppServerBoundaries(serverName);
      for (const name of Object.keys(serverTools)) {
        const owner = resolveToolServerName(name, boundaries);
        if (owner && owner !== serverName) {
          throw new Error(`Tool ${name} belongs to app server ${owner}, not ${serverName}`);
        }
      }
      let configGeneration = publicationGeneration;
      if (!configGeneration) {
        const config = await resolveCacheConfig(undefined, serverName);
        configGeneration = config
          ? getMCPToolCatalogGeneration(config, STANDARD_MCP_CAPABILITY_PROFILE)
          : undefined;
      }
      /** Discarding a publication is warned, not debugged: #14857 was invisible for a release
       * because the only trace of a dropped app catalog was a debug line no deployment runs.
       * A drop here means this server's tools are missing for every agent that needs them. */
      if (!configGeneration) {
        logger.warn(
          `[MCP Cache] Skipped unaddressed app-level publication for ${serverName}; its tools stay unavailable to agents`,
        );
        return false;
      }
      /** Ordering is reserved before the `tools/list` that produced these tools and travels with
       * the snapshot, so a publisher that lost it fetched at an unknown time and cannot be
       * ordered against concurrent replicas. Allocating one here instead would let a slow fetch
       * of an old catalog outrank a newer one that reserved after it started. */
      if (!publicationRevision) {
        logger.warn(
          `[MCP Cache] Skipped unordered app-level publication for ${serverName}: its snapshot carried no reserved revision, so its tools stay unavailable to agents`,
        );
        return false;
      }
      const replaced = await setCachedAppServerTools(
        serverName,
        configGeneration,
        serverTools,
        publicationRevision,
      );
      /** Expected whenever replicas publish concurrently: the winner already holds newer tools. */
      if (replaced === false) {
        logger.debug(
          `[MCP Cache] Ignored superseded app-level tools for ${serverName} at revision ${publicationRevision}`,
        );
        return false;
      }
      logger.debug(
        `[MCP Cache] Replaced app-level tools for ${serverName} with ${Object.keys(serverTools).length} tool(s)`,
      );
      return true;
    } catch (error) {
      logger.error(`[MCP Cache] Failed to replace app-level tools for ${serverName}:`, error);
      throw error;
    }
  }

  async function cacheMCPServerTools(params: {
    userId: string;
    serverName: string;
    serverTools: LCAvailableTools;
    serverConfig?: ParsedServerConfig;
    publicationGeneration?: string;
    publicationRevision?: string;
    capabilityProfile?: MCPClientCapabilityProfile;
  }): Promise<void> {
    const {
      userId,
      serverName,
      serverTools,
      serverConfig,
      publicationGeneration,
      publicationRevision,
      capabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
    } = params;
    try {
      const count = Object.keys(serverTools).length;
      const resolvedConfig = await resolveCacheConfig(userId, serverName, serverConfig);
      const configGeneration = resolvedConfig
        ? getMCPToolCatalogGeneration(resolvedConfig, capabilityProfile)
        : undefined;
      if (resolvedConfig && requiresEphemeralUserConnection(resolvedConfig)) {
        logger.debug(`[MCP Cache] Skipped caching ${count} request-scoped tool(s)`);
        return;
      }
      if (
        capabilityProfile === STANDARD_MCP_CAPABILITY_PROFILE &&
        (await isAppSharedConfig(serverName, resolvedConfig))
      ) {
        const appConfigGeneration =
          userId == null
            ? (publicationGeneration ?? configGeneration)
            : (configGeneration ?? publicationGeneration);
        const replaced = await replaceAppServerTools({
          serverName,
          serverTools,
          publicationGeneration: appConfigGeneration,
          publicationRevision,
        });
        if (!replaced) {
          return;
        }
        logger.debug('[MCP Cache] Refreshed app-level server tools');
        return;
      }
      if (setCachedToolsIfCurrent) {
        if (!publicationGeneration || !configGeneration) {
          logger.debug('[MCP Cache] Skipped unfenced or unaddressed discovered tools');
          return;
        }
        const current = await setCachedToolsIfCurrent(serverTools, {
          userId,
          serverName,
          configGeneration,
          publicationGeneration,
        });
        if (!current) {
          logger.debug('[MCP Cache] Ignored stale discovered tools');
          return;
        }
      } else {
        await writeCachedTools(serverTools, { userId, serverName, configGeneration });
      }
      logger.debug(`[MCP Cache] Cached ${count} server tool(s)`);
    } catch (error) {
      logger.error('[MCP Cache] Failed to cache server tools');
      throw error;
    }
  }

  /**
   * Heals cache entries written before keys embedded the normalized server
   * name. The definitions-only loader treats the returned map as
   * authoritative — a per-key miss does NOT trigger a reconnect the way the
   * instance path does — so a stale raw-keyed entry would make the server's
   * tools vanish for up to the cache TTL after rollout. Rewriting at read
   * time covers every consumer without a coordinated invalidation; safe
   * server names (the common case) return the map untouched.
   */
  function normalizeCachedToolKeys(
    tools: LCAvailableTools | null,
    serverName: string,
  ): LCAvailableTools | null {
    if (!tools) {
      return tools;
    }
    const normalized = normalizeServerName(serverName);
    if (normalized === serverName) {
      return tools;
    }
    const legacySuffix = `${Constants.mcp_delimiter}${serverName}`;
    let changed = false;
    const next: LCAvailableTools = {};
    for (const [key, entry] of Object.entries(tools)) {
      if (!key.endsWith(legacySuffix)) {
        next[key] = entry;
        continue;
      }
      const rebuiltKey = `${key.slice(0, key.length - serverName.length)}${normalized}`;
      next[rebuiltKey] = {
        ...entry,
        ['function']: { ...entry['function'], name: rebuiltKey },
      };
      changed = true;
    }
    return changed ? next : tools;
  }

  async function getMCPServerTools(
    userId: string,
    serverName: string,
    serverConfig?: ParsedServerConfig,
    capabilityProfile: MCPClientCapabilityProfile = STANDARD_MCP_CAPABILITY_PROFILE,
  ): Promise<LCAvailableTools | null> {
    const resolvedConfig = await resolveCacheConfig(userId, serverName, serverConfig);
    if (resolvedConfig && requiresEphemeralUserConnection(resolvedConfig)) {
      return null;
    }
    try {
      if (
        capabilityProfile === STANDARD_MCP_CAPABILITY_PROFILE &&
        (await isAppSharedConfig(serverName, resolvedConfig))
      ) {
        if (!resolvedConfig) {
          return null;
        }
        const configGeneration = getMCPToolCatalogGeneration(resolvedConfig, capabilityProfile);
        const serverTools = await getCachedAppServerTools(serverName, configGeneration);
        if (serverTools == null) {
          return null;
        }
        return normalizeCachedToolKeys(serverTools, serverName);
      }
      const configGeneration = resolvedConfig
        ? getMCPToolCatalogGeneration(resolvedConfig, capabilityProfile)
        : undefined;
      const cached =
        (await getCachedTools({
          userId,
          serverName,
          configGeneration,
          allowLegacyMigration: false,
        })) ?? null;
      if (!cached) {
        return null;
      }
      return normalizeCachedToolKeys(cached, serverName);
    } catch {
      logger.error('[MCP Cache] Error fetching cached server tools');
      return null;
    }
  }

  return {
    updateMCPServerTools,
    syncStaticTools,
    mergeAppTools,
    replaceAppServerTools,
    cacheMCPServerTools,
    getMCPServerTools,
  };
}
