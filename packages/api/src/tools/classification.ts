/**
 * @fileoverview Utility functions for building tool registries from agent tool_options.
 * Tool classification (deferred_tools, allowed_callers) is configured via the agent UI.
 *
 * @module packages/api/src/tools/classification
 */

import { logger } from '@librechat/data-schemas';
import { Constants, normalizeServerName } from 'librechat-data-provider';
import {
  Providers,
  createToolSearch,
  ToolSearchToolDefinition,
  BashProgrammaticToolCallingDefinition,
} from '@librechat/agents';
import type {
  LCToolRegistry,
  JsonSchemaType,
  AllowedCaller,
  GenericTool,
  LCTool,
} from '@librechat/agents';
import type { AgentGitIdentity, AgentToolOptions } from 'librechat-data-provider';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import type { CodeCapabilityConfigLoader } from '~/code/capabilities';
import { supportsProgrammaticCodeExecution } from '~/code/capabilities';
import { createContextProgrammaticBashTool } from '~/code/command';
import { sanitizeGeminiSchema } from '~/mcp/zod';

export type { LCTool, LCToolRegistry, AllowedCaller, JsonSchemaType };

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: JsonSchemaType;
  /** MCP server name extracted from tool name */
  serverName?: string;
  /** Raw upstream tool name when the model-facing key stripped a redundant server-name prefix */
  serverToolName?: string;
  /** Current catalog tool name when a LEGACY persisted key kept its pre-strip spelling */
  currentToolName?: string;
}

/** An MCP tool name plus its OTHER spelling (legacy for stripped instances, current for legacy-named ones). */
export interface MCPToolAlias {
  name: string;
  aliasName: string;
}

/**
 * Collects both directions of identity aliases from MCP tool definitions, so
 * approval policies and hook matchers written against EITHER spelling keep
 * applying: a stripped instance aliases its pre-strip name, and a
 * legacy-named instance (persisted key retained) aliases its current catalog
 * name. Works in both loading modes because both funnel their definitions
 * through {@link buildToolClassification}.
 */
export function collectMCPToolAliases(mcpToolDefs: ToolDefinition[]): MCPToolAlias[] {
  const aliases: MCPToolAlias[] = [];
  for (const def of mcpToolDefs) {
    if (!def.serverName) {
      continue;
    }
    const keySuffix = `${Constants.mcp_delimiter}${normalizeServerName(def.serverName)}`;
    if (def.serverToolName) {
      const aliasName = `${def.serverToolName}${keySuffix}`;
      if (aliasName !== def.name) {
        aliases.push({ name: def.name, aliasName });
      }
    }
    if (def.currentToolName) {
      const aliasName = `${def.currentToolName}${keySuffix}`;
      if (aliasName !== def.name) {
        aliases.push({ name: def.name, aliasName });
      }
    }
  }
  return aliases;
}

/**
 * Extracts the MCP server name from a tool name.
 * Tool names follow the pattern: toolName_mcp_ServerName
 * @param toolName - The full tool name
 * @returns The server name or undefined if not an MCP tool
 */
export function getServerNameFromTool(toolName: string): string | undefined {
  const parts = toolName.split(Constants.mcp_delimiter);
  if (parts.length >= 2) {
    return parts[parts.length - 1];
  }
  return undefined;
}

/**
 * Aliases persisted `tool_options` keys onto the instance names IN PLACE, so
 * every downstream reader of `agent.tool_options` (the registry build for
 * defer/programmatic, the background and intent passes) sees the healed keys
 * in BOTH loading modes and BOTH spelling directions: options keyed by a
 * pre-strip spelling follow a renamed (wildcard-expanded) instance, and
 * options the editor migrated to the CURRENT catalog spelling still reach a
 * legacy-named instance an unedited `agent.tools` entry retained.
 * Identity-gated through {@link collectMCPToolAliases}, and an explicit
 * entry under the instance's own name always wins.
 */
export function aliasMCPToolOptions(
  aliases: readonly MCPToolAlias[],
  agentToolOptions?: AgentToolOptions,
): void {
  if (!agentToolOptions || Object.keys(agentToolOptions).length === 0) {
    return;
  }
  for (const { name, aliasName } of aliases) {
    if (agentToolOptions[name] == null && agentToolOptions[aliasName] != null) {
      agentToolOptions[name] = agentToolOptions[aliasName];
    }
  }
}

export function schemaSize(parameters: JsonSchemaType | undefined): number {
  if (parameters == null) {
    return 0;
  }
  try {
    return JSON.stringify(parameters).length;
  } catch {
    return 0;
  }
}

/** An explicit per-tool choice always wins, so an operator-wide rule can never
 *  override a tool someone deliberately pinned open or shut. */
export function resolveDeferLoading(
  explicit: boolean | undefined,
  parameters: JsonSchemaType | undefined,
  deferSchemaChars: number,
): boolean {
  if (explicit != null) {
    return explicit === true;
  }
  if (deferSchemaChars <= 0) {
    return false;
  }
  return schemaSize(parameters) > deferSchemaChars;
}

/**
 * Builds a tool registry from agent-level tool_options.
 *
 * @param tools - Array of tool definitions
 * @param agentToolOptions - Per-tool configuration from the agent
 * @param deferSchemaChars - Size above which a schema defers absent an explicit choice
 * @returns Map of tool name to tool definition with classification
 */
export function buildToolRegistryFromAgentOptions(
  tools: ToolDefinition[],
  agentToolOptions: AgentToolOptions,
  deferSchemaChars = 0,
): LCToolRegistry {
  const registry: LCToolRegistry = new Map();

  for (const tool of tools) {
    const { name, description, parameters } = tool;
    const agentOptions = agentToolOptions[name];

    const allowed_callers: AllowedCaller[] =
      agentOptions?.allowed_callers && agentOptions.allowed_callers.length > 0
        ? agentOptions.allowed_callers
        : ['direct'];

    const defer_loading = resolveDeferLoading(
      agentOptions?.defer_loading,
      parameters,
      deferSchemaChars,
    );

    const toolDef: LCTool = {
      name,
      allowed_callers,
      defer_loading,
      toolType: 'mcp',
    };

    if (description) {
      toolDef.description = description;
    }
    if (parameters) {
      toolDef.parameters = parameters;
    }
    if (tool.serverName) {
      toolDef.serverName = tool.serverName;
    }

    registry.set(name, toolDef);
  }

  return registry;
}

interface MCPToolInstance {
  name: string;
  description?: string;
  mcp?: boolean;
  /** Original JSON schema attached at MCP tool creation time */
  mcpJsonSchema?: JsonSchemaType;
  /** Server this tool came from, carried from resolution instead of re-parsed */
  mcpRawServerName?: string;
  /** Raw upstream tool name when the instance name stripped a redundant server-name prefix */
  mcpServerToolName?: string;
  /** Current catalog tool name when a legacy persisted key kept its pre-strip spelling */
  mcpCurrentToolName?: string;
}

/**
 * Extracts MCP tool definition from a loaded tool instance.
 * MCP tools have the original JSON schema attached as `mcpJsonSchema` property.
 *
 * @param tool - The loaded tool instance
 * @returns Tool definition
 */
export function extractMCPToolDefinition(tool: MCPToolInstance): ToolDefinition {
  const def: ToolDefinition = { name: tool.name };

  if (tool.description) {
    def.description = tool.description;
  }

  if (tool.mcpJsonSchema) {
    def.parameters = tool.mcpJsonSchema;
  }

  const serverName = tool.mcpRawServerName ?? getServerNameFromTool(tool.name);
  if (serverName) {
    def.serverName = serverName;
  }

  if (tool.mcpServerToolName) {
    def.serverToolName = tool.mcpServerToolName;
  }

  if (tool.mcpCurrentToolName) {
    def.currentToolName = tool.mcpCurrentToolName;
  }

  return def;
}

/**
 * Checks if a tool is an MCP tool based on its properties.
 * @param tool - The tool to check (can be any object with potential mcp property)
 * @returns Whether the tool is an MCP tool
 */
export function isMCPTool(tool: unknown): tool is MCPToolInstance {
  return typeof tool === 'object' && tool !== null && (tool as MCPToolInstance).mcp === true;
}

/**
 * Cleans up the temporary mcpJsonSchema property from MCP tools after registry is populated.
 * This property is only needed during registry building and can be safely removed afterward.
 *
 * @param tools - Array of tools to clean up
 */
export function cleanupMCPToolSchemas(tools: MCPToolInstance[]): void {
  for (const tool of tools) {
    if (tool.mcpJsonSchema !== undefined) {
      delete tool.mcpJsonSchema;
    }
  }
}

/** Builds tool registry from MCP tool definitions. */
function buildToolRegistry(
  mcpToolDefs: ToolDefinition[],
  agentToolOptions?: AgentToolOptions,
  deferSchemaChars = 0,
): LCToolRegistry {
  if (agentToolOptions && Object.keys(agentToolOptions).length > 0) {
    return buildToolRegistryFromAgentOptions(mcpToolDefs, agentToolOptions, deferSchemaChars);
  }

  /** No agent options - build basic definitions for event-driven mode */
  const registry: LCToolRegistry = new Map<string, LCTool>();
  for (const toolDef of mcpToolDefs) {
    const entry: LCTool = {
      name: toolDef.name,
      description: toolDef.description,
      parameters: toolDef.parameters,
      serverName: toolDef.serverName,
      toolType: 'mcp',
    };
    /** The size rule is operator-wide, so it reaches agents with no per-tool options too. */
    if (resolveDeferLoading(undefined, toolDef.parameters, deferSchemaChars)) {
      entry.defer_loading = true;
    }
    registry.set(toolDef.name, entry);
  }
  return registry;
}

/** Parameters for building tool classification and creating PTC/tool search tools */
export interface BuildToolClassificationParams {
  /** All loaded tools (will be filtered for MCP tools) */
  loadedTools: GenericTool[];
  /** User ID for auth lookup */
  userId: string;
  /** Agent ID (used for logging and context) */
  agentId?: string;
  /** Per-tool configuration from the agent */
  agentToolOptions?: AgentToolOptions;
  gitIdentity?: AgentGitIdentity | null;
  /** Whether the deferred_tools capability is enabled (from agent config) */
  deferredToolsEnabled?: boolean;
  /** Whether the programmatic_tools capability is enabled (from agent config) */
  programmaticToolsEnabled?: boolean;
  /** Whether code execution is enabled and requested by this agent */
  codeExecutionEnabled?: boolean;
  /** When true, return definitions without executable tools (event-driven mode). */
  definitionsOnly?: boolean;
  /** Agent provider — Gemini/Vertex rejects union types, so injected tool schemas get sanitized */
  provider?: Providers | string;
  /** Optional host-supplied Code API auth headers for remote programmatic execution. */
  authHeaders?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Trusted Code API route selected for the executing agent. */
  codeExecutionContext?: CodeExecutionContext;
  codeEnvironments?: readonly CodeEnvironmentConfig[];
  getAppConfig?: CodeCapabilityConfigLoader;
  /** See `mcpSettings.deferSchemaChars`. `0` leaves every tool as configured. */
  deferSchemaChars?: number;
}

/** Result from building tool classification */
export interface BuildToolClassificationResult {
  /** Tool registry built from MCP tools (undefined if no MCP tools) */
  toolRegistry?: LCToolRegistry;
  /** Tool definitions array for event-driven execution (built simultaneously with registry) */
  toolDefinitions: LCTool[];
  /** Additional tools created (PTC and/or tool search) */
  additionalTools: GenericTool[];
  /** Whether any tools have defer_loading enabled (precomputed for efficiency) */
  hasDeferredTools: boolean;
  /** Both-direction identity aliases for MCP tools whose key spelling changed (see {@link collectMCPToolAliases}) */
  mcpToolAliases: MCPToolAlias[];
}

/**
 * Checks if an agent's tools have any that match PTC patterns (programmatic only or dual context).
 * @param toolRegistry - The tool registry to check
 * @returns Whether any tools are configured for programmatic calling
 */
export function agentHasProgrammaticTools(toolRegistry: LCToolRegistry): boolean {
  for (const toolDef of toolRegistry.values()) {
    if (toolDef.allowed_callers?.includes('code_execution')) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if an agent's tools have any that are deferred.
 * @param toolRegistry - The tool registry to check
 * @returns Whether any tools are configured as deferred
 */
export function agentHasDeferredTools(toolRegistry: LCToolRegistry): boolean {
  for (const toolDef of toolRegistry.values()) {
    if (toolDef.defer_loading === true) {
      return true;
    }
  }
  return false;
}

/**
 * Builds the tool registry from MCP tools and conditionally creates PTC and tool search tools.
 *
 * This function:
 * 1. Filters loaded tools for MCP tools
 * 2. Extracts tool definitions and builds the registry from agent's tool_options
 * 3. Cleans up temporary mcpJsonSchema properties
 * 4. Creates PTC tool only if capabilities allow the agent's programmatic tools
 * 5. Creates tool search tool only if agent has deferred tools
 *
 * @param params - Parameters including loaded tools, userId, agentId, agentToolOptions, and dependencies
 * @returns Tool registry and any additional tools created
 */
export async function buildToolClassification(
  params: BuildToolClassificationParams,
): Promise<BuildToolClassificationResult> {
  const {
    agentId,
    provider,
    loadedTools,
    agentToolOptions,
    definitionsOnly = false,
    deferredToolsEnabled = true,
    programmaticToolsEnabled = false,
    codeExecutionEnabled = false,
    authHeaders,
    codeExecutionContext,
    codeEnvironments,
    getAppConfig,
    deferSchemaChars = 0,
  } = params;
  const isGoogle = provider === Providers.GOOGLE || provider === Providers.VERTEXAI;
  const additionalTools: GenericTool[] = [];

  const mcpTools = loadedTools.filter(isMCPTool);
  if (mcpTools.length === 0) {
    return {
      additionalTools,
      toolDefinitions: [],
      toolRegistry: undefined,
      hasDeferredTools: false,
      mcpToolAliases: [],
    };
  }

  const mcpToolDefs = mcpTools.map(extractMCPToolDefinition);
  const mcpToolAliases = collectMCPToolAliases(mcpToolDefs);
  aliasMCPToolOptions(mcpToolAliases, agentToolOptions);
  const toolRegistry: LCToolRegistry = buildToolRegistry(
    mcpToolDefs,
    agentToolOptions,
    deferSchemaChars,
  );

  /** Clean up temporary mcpJsonSchema property from tools now that registry is populated */
  cleanupMCPToolSchemas(mcpTools);

  /**
   * Check if this agent actually has tools configured for these features.
   * Only enable PTC if code/programmatic capabilities allow the agent's programmatic tools.
   * Only enable tool search if the agent has deferred tools AND the capability is enabled.
   */
  const hasProgrammaticTools =
    programmaticToolsEnabled &&
    codeExecutionEnabled &&
    agentHasProgrammaticTools(toolRegistry) &&
    (codeExecutionContext?.environmentType !== 'attached' ||
      codeExecutionContext.codeWorkspace != null) &&
    (await supportsProgrammaticCodeExecution(codeExecutionContext, codeEnvironments, getAppConfig));
  const hasDeferredTools = deferredToolsEnabled && agentHasDeferredTools(toolRegistry);

  /** Clear defer_loading if capability disabled */
  if (!deferredToolsEnabled) {
    for (const toolDef of toolRegistry.values()) {
      if (toolDef.defer_loading !== true) {
        continue;
      }
      toolDef.defer_loading = false;
    }
  }

  /** Build toolDefinitions array from registry (single pass, reused) */
  const toolDefinitions: LCTool[] = Array.from(toolRegistry.values());

  /** No programmatic or deferred tools - skip PTC/ToolSearch */
  if (!hasProgrammaticTools && !hasDeferredTools) {
    logger.debug(
      `[buildToolClassification] Agent ${agentId} has no programmatic or deferred tools, skipping PTC/ToolSearch`,
    );
    return {
      toolRegistry,
      toolDefinitions,
      additionalTools,
      hasDeferredTools: false,
      mcpToolAliases,
    };
  }

  /** Tool search uses local mode (no API key needed) */
  if (hasDeferredTools) {
    /**
     * The ToolSearch schema declares `mcp_server` as a string/array union, which
     * `zod_to_gemini_parameters` rejects — collapse it for Gemini/Vertex agents.
     */
    const toolSearchParameters = (isGoogle
      ? sanitizeGeminiSchema(ToolSearchToolDefinition.schema as Record<string, unknown>)
      : ToolSearchToolDefinition.schema) as unknown as LCTool['parameters'];

    if (!definitionsOnly) {
      const toolSearchTool = createToolSearch({
        mode: 'local',
        toolRegistry,
      });
      if (isGoogle) {
        toolSearchTool.schema = toolSearchParameters as typeof toolSearchTool.schema;
      }
      additionalTools.push(toolSearchTool);
    }

    /** Add ToolSearch definition for event-driven mode */
    toolDefinitions.push({
      name: ToolSearchToolDefinition.name,
      description: ToolSearchToolDefinition.description,
      parameters: toolSearchParameters,
    });
    toolRegistry.set(ToolSearchToolDefinition.name, {
      name: ToolSearchToolDefinition.name,
      allowed_callers: ['direct'],
    });

    logger.debug(`[buildToolClassification] Tool Search enabled for agent ${agentId}`);
  }

  if (!hasProgrammaticTools) {
    return { toolRegistry, toolDefinitions, additionalTools, hasDeferredTools, mcpToolAliases };
  }

  try {
    const ptcTool = createContextProgrammaticBashTool(
      authHeaders,
      codeExecutionContext,
      params.gitIdentity,
    );
    if (!definitionsOnly) additionalTools.push(ptcTool);

    /** Add PTC definition for event-driven mode */
    toolDefinitions.push({
      name: BashProgrammaticToolCallingDefinition.name,
      description: ptcTool.description,
      parameters: ptcTool.schema as LCTool['parameters'],
    });
    toolRegistry.set(BashProgrammaticToolCallingDefinition.name, {
      name: BashProgrammaticToolCallingDefinition.name,
      allowed_callers: ['direct'],
    });

    logger.debug(`[buildToolClassification] PTC tool enabled for agent ${agentId}`);
  } catch (error) {
    logger.error('[buildToolClassification] Error creating PTC tool:', error);
  }

  return { toolRegistry, toolDefinitions, additionalTools, hasDeferredTools, mcpToolAliases };
}
