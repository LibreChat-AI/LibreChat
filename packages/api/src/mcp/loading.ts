import { logger } from '@librechat/data-schemas';
import { isMCPInitializationError } from './errors';

interface MCPToolRequest<Config> {
  type: 'all' | 'single';
  toolKey: string;
  serverName: string;
  config: Config;
}

interface MCPToolParameters<Config> {
  index: number;
  serverName: string;
  config: Config;
}

interface MCPLoadContext {
  signal?: AbortSignal;
}

interface MCPToolLoadOptions<Tool, Catalog, Config, Context extends MCPLoadContext> {
  userId: string;
  requestedTools: Record<string, MCPToolRequest<Config>[]>;
  context: Context;
  availableTools?: Record<string, Catalog>;
  getAvailableTools: (
    userId: string,
    server: string,
    config: Config,
  ) => Promise<Catalog | undefined>;
  createTools: (params: Context & MCPToolParameters<Config>) => Promise<Tool[] | null | undefined>;
  createTool: (
    params: Context &
      MCPToolParameters<Config> & {
        toolKey: string;
        availableTools?: Catalog;
        onAvailableTools: (tools: Catalog) => void;
      },
  ) => Promise<Tool | Tool[] | null | undefined>;
}

/**
 * Bulk loads overlap while selected tools reuse each server's catalog in order.
 * Settle every started load before cleanup can begin, then prefer request cancellation
 * over any saved credential failure. Ordinary optional-tool failures stay soft.
 */
export async function loadMCPTools<Tool, Catalog, Config, Context extends MCPLoadContext>({
  userId,
  requestedTools,
  context,
  availableTools: catalogs,
  getAvailableTools,
  createTools,
  createTool,
}: MCPToolLoadOptions<Tool, Catalog, Config, Context>): Promise<Tool[]> {
  const { signal } = context;
  const loaded: Tool[] = [];
  const pending: Promise<Tool[] | null | undefined>[] = [];
  const failedServers = new Set<string>();
  let failure: { error: unknown } | undefined;
  const capture = (error: unknown) => {
    if (!failure && isMCPInitializationError(error, signal)) {
      failure = { error };
    }
  };

  let index = -1;
  for (const [serverName, configs] of Object.entries(requestedTools)) {
    index++;
    let availableTools = catalogs?.[serverName];
    for (const config of configs) {
      if (signal?.aborted || failedServers.has(serverName)) {
        break;
      }
      try {
        const params = { ...context, index, serverName: config.serverName, config: config.config };
        if (config.type === 'all' && configs.length === 1) {
          pending.push(
            createTools(params).catch((error: unknown) => {
              capture(error);
              logger.error(`Error loading ${serverName} tools:`, error);
              return null;
            }),
          );
          continue;
        }
        if (!availableTools) {
          try {
            availableTools = await getAvailableTools(userId, serverName, config.config);
          } catch (error) {
            capture(error);
            logger.error(`Error fetching available tools for MCP server ${serverName}:`, error);
          }
        }
        if (signal?.aborted) {
          break;
        }
        const tool =
          config.type === 'all'
            ? await createTools(params)
            : await createTool({
                ...params,
                availableTools,
                toolKey: config.toolKey,
                onAvailableTools: (tools) => {
                  availableTools = tools;
                },
              });
        if (Array.isArray(tool)) {
          loaded.push(...tool);
        } else if (tool) {
          loaded.push(tool);
        } else {
          failedServers.add(serverName);
          logger.warn(
            `MCP tool creation failed for "${config.toolKey}", server may be unavailable or unauthenticated.`,
          );
        }
      } catch (error) {
        capture(error);
        logger.error(`Error loading MCP tool for server ${serverName}:`, error);
      }
    }
  }
  loaded.push(...(await Promise.all(pending)).flatMap((tools) => tools ?? []));
  signal?.throwIfAborted();
  if (failure) {
    throw failure.error;
  }
  return loaded;
}
