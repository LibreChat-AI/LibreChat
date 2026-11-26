import { Constants } from 'librechat-data-provider';

/** The collaborators that decide which tools a user may attach to an agent. */
export interface AgentToolFilterDeps {
  getCachedTools: () => Promise<Record<string, unknown> | null | undefined>;
  resolveConfigServers: () => Promise<Record<string, unknown> | undefined>;
  /** Returns the subset of `tools` the user may attach and records resolved MCP server names. */
  filterAuthorizedTools: (params: {
    tools: string[];
    availableTools: Record<string, unknown>;
    configServers?: Record<string, unknown>;
    resolvedServerNames: Set<string>;
  }) => Promise<string[]>;
}

/**
 * Returns the subset of `tools` the user may attach, with the create path's rules. MCP server
 * configs are read only when an MCP tool is requested; `resolvedServerNames` collects the
 * servers that authorized tools resolved to.
 */
export async function filterAttachableTools(
  tools: string[],
  deps: AgentToolFilterDeps,
  resolvedServerNames: Set<string> = new Set(),
): Promise<string[]> {
  const hasMCPTools = tools.some((tool) => tool?.includes(Constants.mcp_delimiter));
  const [availableTools, configServers] = await Promise.all([
    deps.getCachedTools().then((cached) => cached ?? {}),
    hasMCPTools ? deps.resolveConfigServers() : Promise.resolve(undefined),
  ]);
  return deps.filterAuthorizedTools({ tools, availableTools, configServers, resolvedServerNames });
}
