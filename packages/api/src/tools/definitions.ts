import { bindToolApproval, bindToolApprovalIdentity, getToolApprovalIdentity } from './approval';
/**
 * @fileoverview Tool definitions loader for event-driven mode.
 * Loads tool definitions without creating tool instances for efficient initialization.
 *
 * @module packages/api/src/tools/definitions
 */

import { Providers, GitHubCompareToolName } from '@librechat/agents';
import {
  Constants,
  isActionTool,
  splitMCPToolKey,
  normalizeServerName,
  stripServerNamePrefix,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { LCToolRegistry, JsonSchemaType, LCTool, GenericTool } from '@librechat/agents';
import type { AgentToolOptions } from 'librechat-data-provider';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import type { CodeCapabilityConfigLoader } from '~/code/capabilities';
import type { MCPToolAlias, ToolDefinition } from './classification';
import { resolveJsonSchemaRefs, normalizeJsonSchema, sanitizeGeminiSchema } from '~/mcp/zod';
import { DEFAULT_LOOKUP_CONCURRENCY } from '~/utils/concurrency';
import { mapWithConcurrency } from '~/utils/promise';
import { buildToolClassification } from './classification';
import { getToolDefinition } from './registry/definitions';
import { toolkitExpansion } from './toolkits/mapping';
import { isMCPAllPlaceholder } from '~/mcp/utils';

export interface MCPServerTool {
  function?: {
    name?: string;
    description?: string;
    parameters?: JsonSchemaType;
  };
  serverToolName?: string;
}

export type MCPServerTools = Record<string, MCPServerTool>;

export interface LoadToolDefinitionsParams {
  /** User ID for MCP server tool lookup */
  userId: string;
  /** Agent ID for tool classification */
  agentId: string;
  /** Agent's tool list (tool names/identifiers) */
  tools: string[];
  /** Explicit deployment opt-in for read-only GitHub comparisons. */
  githubCompareEnabled?: boolean;
  /** Agent-specific tool options */
  toolOptions?: AgentToolOptions;
  /** Whether deferred tools feature is enabled */
  deferredToolsEnabled?: boolean;
  /** Whether programmatic tool calling is enabled */
  programmaticToolsEnabled?: boolean;
  /** Whether code execution is enabled and requested by this agent */
  codeExecutionEnabled?: boolean;
  codeExecutionContext?: CodeExecutionContext;
  codeEnvironments?: readonly CodeEnvironmentConfig[];
  getAppConfig?: CodeCapabilityConfigLoader;
  /** Agent provider — Gemini/Vertex tool schemas get union-flattened for compatibility */
  provider?: Providers;
  /** Configured server names, used to resolve the tool-key boundary exactly */
  mcpServerNames?: readonly string[];
  /**
   * Configured server names in raw config form. A parsed (normalized) server
   * name resolves back to its raw name for config lookups AND for the
   * `serverName`/`mcpRawServerName` metadata stored on definitions — server
   * instructions and other config-keyed consumers read that field raw.
   */
  rawServerNames?: readonly string[];
  /**
   * Every server the user can reach (operator + user DB), from a COMPLETE
   * collision audit. When a parsed name appears here, it IS a real server —
   * a null tool fetch then means "currently unavailable" (OAuth pending,
   * missing user variables, disconnected) and must NOT fall back to the raw
   * alias, or the aliased server's definitions would be emitted under the
   * unavailable server's names.
   */
  accessibleServerNames?: readonly string[];
  /**
   * Upper bound on MCP server catalog lookups in flight at once: the deployment's
   * `concurrency.mcpCatalogLookups`. A cold lookup can reconnect a server or spawn its process,
   * so one request does not start them all together. `1` looks servers up one after another.
   */
  mcpCatalogLookups?: number;
}

export interface ActionToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonSchemaType;
  /** True when the action authenticates via OAuth — its calls may block on an
   *  interactive login prompt, so it must never be dispatched in the background. */
  oauth?: boolean;
}

export interface LoadToolDefinitionsDeps {
  /** Gets MCP server tools - first checks cache, then initializes server if needed. Called
   *  concurrently for different servers; a server is looked up again only after its refresh. */
  getOrFetchMCPServerTools: (userId: string, serverName: string) => Promise<MCPServerTools | null>;
  /** Bypasses a non-empty stale catalog when it does not contain a selected tool. */
  refreshMCPServerTools?: (userId: string, serverName: string) => Promise<MCPServerTools | null>;
  /** Checks if a tool name is a known built-in tool */
  isBuiltInTool: (toolName: string) => boolean;
  /** Loads action tool definitions (schemas) from OpenAPI specs. Started together with the
   *  MCP server lookups. */
  getActionToolDefinitions?: (
    agentId: string,
    actionToolNames: string[],
  ) => Promise<ActionToolDefinition[]>;
}

export interface LoadToolDefinitionsResult {
  toolDefinitions: (ToolDefinition | LCTool)[];
  toolRegistry: LCToolRegistry;
  hasDeferredTools: boolean;
  /** Both-direction identity aliases for MCP tools whose key spelling changed */
  mcpToolAliases: MCPToolAlias[];
  mcpResolution: {
    expectedToolCount: number;
    resolvedToolCount: number;
  };
  /** Action tool names backed by OAuth; excluded from background dispatch. */
  oauthActionToolNames: string[];
  /**
   * Every server name that was looked up, in tool order: each parsed key, then its raw alias
   * when that was tried. Lookups settle in any order, so work that follows them and must stay in
   * tool order (the OAuth sign-in prompts) takes its order from this list.
   */
  mcpServerLookupOrder: string[];
}

/**
 * `names` in the order of `lookupOrder`; names it does not list keep their relative order after
 * the listed ones, so without a lookup order the names come back as given.
 */
export function orderMCPServerNames(
  names: Iterable<string>,
  lookupOrder: readonly string[] = [],
): string[] {
  const rank = new Map(lookupOrder.map((name, index) => [name, index]));
  const listed: string[] = [];
  const unlisted: string[] = [];
  for (const name of names) {
    (rank.has(name) ? listed : unlisted).push(name);
  }
  listed.sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0));
  return [...listed, ...unlisted];
}

const mcpToolPattern = /_mcp_/;
const mcpServerPinPrefix = `${Constants.mcp_server}${Constants.mcp_delimiter}`;

interface ServerCatalog {
  serverKey: string;
  /** Server names the lookup asked for: the key, then its alias when that was tried. */
  lookups: string[];
  tools: MCPServerTools;
  /** The RAW server name the key resolved to (direct-first). */
  resolvedName: string;
}

/**
 * Fetches the catalog of every distinct parsed server key, at most `concurrency` keys at a time.
 * Each key resolves DIRECT-FIRST: the parsed name as-is, then, only when it is not a known
 * accessible server, its raw alias. Within one resolution a fetch is shared by server name, so a
 * direct lookup and an alias fallback that land on the same server make one call instead of
 * racing two reconnects.
 *
 * A rejected fetch rejects the whole resolution. The others keep running but stay observed, so
 * a later failure cannot surface as an unhandled rejection.
 */
async function resolveServerCatalogs({
  userId,
  serverKeys,
  concurrency,
  accessibleServerNames,
  serverNameAliases,
  getOrFetchMCPServerTools,
}: {
  userId: string;
  serverKeys: readonly string[];
  concurrency: number;
  accessibleServerNames?: readonly string[];
  serverNameAliases: ReadonlyMap<string, string>;
  getOrFetchMCPServerTools: LoadToolDefinitionsDeps['getOrFetchMCPServerTools'];
}): Promise<ServerCatalog[]> {
  const inFlight = new Map<string, Promise<MCPServerTools | null>>();
  const fetchOnce = (serverName: string): Promise<MCPServerTools | null> => {
    const pending = inFlight.get(serverName) ?? getOrFetchMCPServerTools(userId, serverName);
    inFlight.set(serverName, pending);
    return pending;
  };

  return mapWithConcurrency(serverKeys, concurrency, async (serverKey): Promise<ServerCatalog> => {
    let resolvedName = serverKey;
    const lookups = [serverKey];
    let fetched = await fetchOnce(serverKey);
    if (!fetched) {
      /** Alias fallback is for "server not found" ONLY: when the parsed name is a known
       *  accessible server, a null fetch means it is temporarily unavailable (OAuth pending,
       *  missing user variables, disconnected) and rerouting to the alias would emit the OTHER
       *  server's definitions under this server's names. */
      const parsedIsKnownServer = accessibleServerNames?.includes(serverKey) === true;
      const aliased = serverNameAliases.get(serverKey);
      if (!parsedIsKnownServer && aliased != null && aliased !== serverKey) {
        lookups.push(aliased);
        fetched = await fetchOnce(aliased);
        if (fetched) {
          resolvedName = aliased;
        }
      }
    }
    return { serverKey, lookups, tools: fetched || {}, resolvedName };
  });
}

/**
 * Loads tool definitions without creating tool instances.
 * This is the efficient path for event-driven mode where tools are loaded on-demand.
 * MCP servers and action definitions are resolved concurrently.
 */
export async function loadToolDefinitions(
  params: LoadToolDefinitionsParams,
  deps: LoadToolDefinitionsDeps,
): Promise<LoadToolDefinitionsResult> {
  const {
    userId,
    agentId,
    tools,
    toolOptions = {},
    deferredToolsEnabled = false,
    programmaticToolsEnabled = false,
    codeExecutionEnabled = false,
    codeExecutionContext,
    codeEnvironments,
    getAppConfig,
    provider,
    mcpServerNames,
    rawServerNames,
    accessibleServerNames,
    mcpCatalogLookups = DEFAULT_LOOKUP_CONCURRENCY.mcpCatalogLookups,
  } = params;
  const {
    getOrFetchMCPServerTools,
    refreshMCPServerTools,
    isBuiltInTool,
    getActionToolDefinitions,
  } = deps;
  const serverNameAliases = buildServerNameAliases(rawServerNames ?? []);

  const isGoogle = provider === Providers.GOOGLE || provider === Providers.VERTEXAI;

  /** Normalizes MCP tool params, additionally union-flattening for the Gemini/Vertex path. */
  const buildMcpParameters = (mcpParams?: JsonSchemaType): JsonSchemaType | undefined => {
    if (!mcpParams) {
      return undefined;
    }
    const normalized = normalizeJsonSchema(resolveJsonSchemaRefs(mcpParams));
    return isGoogle ? sanitizeGeminiSchema(normalized) : normalized;
  };

  const emptyResult: LoadToolDefinitionsResult = {
    toolDefinitions: [],
    toolRegistry: new Map(),
    hasDeferredTools: false,
    mcpToolAliases: [],
    mcpResolution: { expectedToolCount: 0, resolvedToolCount: 0 },
    oauthActionToolNames: [],
    mcpServerLookupOrder: [],
  };

  if (!tools || tools.length === 0) {
    return emptyResult;
  }

  const mcpServerToolsCache = new Map<string, MCPServerTools>();
  const refreshedServerNames = new Set<string>();
  /** Parsed key segment → the RAW server name it resolved to (direct-first). */
  const resolvedServerNames = new Map<string, string>();
  const mcpToolDefs: ToolDefinition[] = [];
  const builtInToolDefs: ToolDefinition[] = [];
  const actionToolNames: string[] = [];
  /** Tools that get a definition built, in selection order; `serverKey` is set for MCP tools. */
  const selectedTools: { toolName: string; serverKey?: string }[] = [];
  /** Distinct parsed server keys, in first-seen order. */
  const serverKeys = new Set<string>();
  let expectedMCPToolCount = 0;
  let resolvedMCPToolCount = 0;

  for (const toolName of tools) {
    if (toolName === GitHubCompareToolName && params.githubCompareEnabled !== true) {
      continue;
    }
    if (isActionTool(toolName)) {
      actionToolNames.push(toolName);
      continue;
    }

    if (!mcpToolPattern.test(toolName)) {
      selectedTools.push({ toolName });
      continue;
    }

    if (toolName.startsWith(mcpServerPinPrefix)) {
      continue;
    }

    /** Keys carry the normalized server name (raw in pre-normalization data),
     *  so both spellings resolve the boundary. Resolution is DIRECT-FIRST: a
     *  server that resolves under the parsed name as-is wins (a user-DB
     *  server may be named exactly like an operator server's normalized
     *  form), and only when that yields nothing is the parsed name treated
     *  as a normalized spelling of a raw config name. The resolved RAW name
     *  feeds config lookups and definition metadata (`serverName`, then
     *  `mcpRawServerName`); server instructions are keyed by it. */
    const [, parsedServerName] = splitMCPToolKey(toolName, [
      ...(mcpServerNames ?? []),
      ...(rawServerNames ?? []),
    ]);
    const serverKey = parsedServerName ?? toolName;
    serverKeys.add(serverKey);
    selectedTools.push({ toolName, serverKey });
  }

  const loadActionDefinitions = async (): Promise<ActionToolDefinition[]> =>
    actionToolNames.length > 0 && getActionToolDefinitions
      ? getActionToolDefinitions(agentId, actionToolNames)
      : [];

  const resolveKeys = (keys: readonly string[]): Promise<ServerCatalog[]> =>
    resolveServerCatalogs({
      userId,
      serverKeys: keys,
      concurrency: mcpCatalogLookups,
      accessibleServerNames,
      serverNameAliases,
      getOrFetchMCPServerTools,
    });
  /** Server names each key asked for, to find the keys a refreshed server concerns. */
  const lookedUp = new Map<string, readonly string[]>();
  const adopt = (catalogs: ServerCatalog[]): void => {
    for (const catalog of catalogs) {
      mcpServerToolsCache.set(catalog.serverKey, catalog.tools);
      resolvedServerNames.set(catalog.serverKey, catalog.resolvedName);
      lookedUp.set(catalog.serverKey, catalog.lookups);
    }
  };

  const [catalogs, fetchedActionDefs] = await Promise.all([
    resolveKeys(Array.from(serverKeys)),
    loadActionDefinitions(),
  ]);
  adopt(catalogs);
  const mcpServerLookupOrder = Array.from(new Set(catalogs.flatMap((catalog) => catalog.lookups)));
  /** Keys whose first tool has been handled: their catalog is settled for the rest of the load. */
  const builtKeys = new Set<string>();

  for (const { toolName, serverKey: parsed } of selectedTools) {
    if (parsed == null) {
      if (!isBuiltInTool(toolName)) {
        continue;
      }
      const registryDef = getToolDefinition(toolName);
      if (!registryDef) {
        continue;
      }
      builtInToolDefs.push({
        name: toolName,
        description: registryDef.description,
        parameters: registryDef.schema as JsonSchemaType | undefined,
      });

      const extraTools = toolkitExpansion[toolName as keyof typeof toolkitExpansion];
      if (extraTools) {
        for (const extra of extraTools) {
          const extraDef = getToolDefinition(extra);
          if (extraDef) {
            builtInToolDefs.push({
              name: extra,
              description: extraDef.description,
              parameters: extraDef.schema as JsonSchemaType | undefined,
            });
          }
        }
      }
      continue;
    }

    expectedMCPToolCount++;
    builtKeys.add(parsed);

    const serverName = resolvedServerNames.get(parsed) ?? parsed;
    let serverTools = mcpServerToolsCache.get(parsed);
    if (!serverTools) {
      continue;
    }

    /** Catalog keys are built after redundant server-name-prefix stripping —
     *  a pre-strip persisted key (`acme_search_mcp_acme`) must also try its
     *  stripped spelling or the agent fails initialization with its expected
     *  tools "unavailable". The definition keeps the PERSISTED name so it
     *  matches the runtime instance `createMCPTool` builds for the same key,
     *  and the stripped entry is accepted only when its recorded raw name
     *  PROVES the same upstream identity. */
    const findToolMatch = (
      tools: Record<string, MCPServerTool>,
    ): { def: MCPServerTool; currentToolName?: string } | undefined => {
      const direct = tools[toolName];
      if (direct?.function) {
        return { def: direct };
      }
      const keyServerName = normalizeServerName(serverName);
      const [toolPart] = splitMCPToolKey(toolName, [parsed]);
      const strippedPart = stripServerNamePrefix(toolPart, keyServerName);
      if (strippedPart === toolPart) {
        return undefined;
      }
      const entry = tools[`${strippedPart}${Constants.mcp_delimiter}${keyServerName}`];
      /** `currentToolName` records the catalog spelling so approval policies
       *  and hook matchers written against it still reach this legacy-named
       *  definition (see `collectMCPToolAliases`). */
      return entry?.serverToolName === toolPart
        ? { def: entry, currentToolName: strippedPart }
        : undefined;
    };

    const selectedToolMissing = isMCPAllPlaceholder(toolName)
      ? Object.keys(serverTools).length === 0
      : !findToolMatch(serverTools)?.def.function;
    if (selectedToolMissing && refreshMCPServerTools && !refreshedServerNames.has(serverName)) {
      refreshedServerNames.add(serverName);
      const refreshedTools = await refreshMCPServerTools(userId, serverName);
      if (refreshedTools != null) {
        mcpServerToolsCache.set(parsed, refreshedTools);
        serverTools = refreshedTools;
        /** The normalized and raw spellings of one server are separate keys. A key not handled
         *  yet that looked this server up resolves again, now that it is refreshed. */
        const unbuiltKeys = Array.from(serverKeys).filter(
          (key) => !builtKeys.has(key) && lookedUp.get(key)?.includes(serverName),
        );
        if (unbuiltKeys.length > 0) {
          adopt(await resolveKeys(unbuiltKeys));
        }
      }
    }

    if (isMCPAllPlaceholder(toolName)) {
      for (const [actualToolName, toolDef] of Object.entries(serverTools)) {
        if (toolDef?.function) {
          mcpToolDefs.push(
            bindToolApprovalIdentity(
              {
                name: actualToolName,
                description: toolDef.function.description || `${actualToolName} tool`,
                parameters: buildMcpParameters(toolDef.function.parameters),
                serverName,
                serverToolName: toolDef.serverToolName,
              },
              toolDef.serverToolName ??
                actualToolName.slice(
                  0,
                  -`${Constants.mcp_delimiter}${normalizeServerName(serverName)}`.length,
                ),
              normalizeJsonSchema(
                resolveJsonSchemaRefs(
                  toolDef.function.parameters ?? { type: 'object', properties: {} },
                ),
              ),
              toolDef.function.description || undefined,
            ),
          );
          resolvedMCPToolCount++;
        }
      }
      continue;
    }

    const toolMatch = findToolMatch(serverTools);
    if (toolMatch?.def.function) {
      mcpToolDefs.push(
        bindToolApprovalIdentity(
          {
            name: toolName,
            description: toolMatch.def.function.description || `${toolName} tool`,
            parameters: buildMcpParameters(toolMatch.def.function.parameters),
            serverName,
            serverToolName: toolMatch.def.serverToolName,
            currentToolName: toolMatch.currentToolName,
          },
          toolMatch.def.serverToolName ??
            toolName.slice(
              0,
              -`${Constants.mcp_delimiter}${normalizeServerName(serverName)}`.length,
            ),
          normalizeJsonSchema(
            resolveJsonSchemaRefs(
              toolMatch.def.function.parameters ?? { type: 'object', properties: {} },
            ),
          ),
          toolMatch.def.function.description || undefined,
        ),
      );
      resolvedMCPToolCount++;
    }
  }

  const oauthActionToolNames: string[] = [];
  const actionToolDefs: ToolDefinition[] = fetchedActionDefs.map((def) => {
    if (def.oauth === true) {
      oauthActionToolNames.push(def.name);
    }
    return {
      name: def.name,
      description: def.description,
      parameters: def.parameters,
    };
  });

  const loadedTools = mcpToolDefs.map((def) =>
    bindToolApproval(
      {
        name: def.name,
        description: def.description,
        mcp: true as const,
        mcpJsonSchema: def.parameters,
        mcpRawServerName: def.serverName,
        mcpServerToolName: def.serverToolName,
        mcpCurrentToolName: def.currentToolName,
      },
      undefined,
      undefined,
      getToolApprovalIdentity(def),
    ),
  ) as unknown as GenericTool[];

  const classificationResult = await buildToolClassification({
    userId,
    agentId,
    provider,
    loadedTools,
    deferredToolsEnabled,
    programmaticToolsEnabled,
    codeExecutionEnabled,
    codeExecutionContext,
    codeEnvironments,
    getAppConfig,
    definitionsOnly: true,
    agentToolOptions: toolOptions,
  });

  const { toolDefinitions, hasDeferredTools } = classificationResult;
  const toolRegistry: LCToolRegistry = classificationResult.toolRegistry ?? new Map();

  for (const actionDef of actionToolDefs) {
    if (!toolRegistry.has(actionDef.name)) {
      toolRegistry.set(actionDef.name, {
        name: actionDef.name,
        description: actionDef.description,
        parameters: actionDef.parameters,
        allowed_callers: ['direct'],
      });
    }
  }

  for (const builtInDef of builtInToolDefs) {
    if (!toolRegistry.has(builtInDef.name)) {
      toolRegistry.set(builtInDef.name, {
        name: builtInDef.name,
        description: builtInDef.description,
        parameters: builtInDef.parameters,
        allowed_callers: ['direct'],
      });
    }
  }

  const allDefinitions: (ToolDefinition | LCTool)[] = [
    ...toolDefinitions,
    ...actionToolDefs.filter((d) => !toolDefinitions.some((td) => td.name === d.name)),
    ...builtInToolDefs.filter((d) => !toolDefinitions.some((td) => td.name === d.name)),
  ];

  return {
    toolDefinitions: allDefinitions,
    toolRegistry,
    hasDeferredTools,
    mcpToolAliases: classificationResult.mcpToolAliases,
    mcpResolution: {
      expectedToolCount: expectedMCPToolCount,
      resolvedToolCount: resolvedMCPToolCount,
    },
    oauthActionToolNames,
    mcpServerLookupOrder,
  };
}
