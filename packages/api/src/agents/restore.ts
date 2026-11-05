import {
  Constants,
  isActionTool,
  PermissionBits,
  splitMCPToolKey,
  buildServerNameAliases,
} from 'librechat-data-provider';

/** The agent a version is restored onto, as read before the restore. */
export interface AgentRestoreTarget {
  _id: { toString(): string };
  tools?: string[] | null;
  mcpServerNames?: string[] | null;
  updatedAt?: Date;
}

/** What the caller's tool authorizer receives for a restore. */
export interface RestoredToolsAuthorization {
  tools: string[];
  /** The agent's current tools; only these may survive a registry outage. */
  existingTools: string[];
  /** Filled with the raw server name of every approved MCP tool. */
  resolvedServerNames: Set<string>;
  /**
   * Gate for an approved MCP tool whose server the user reaches only through agents
   * (`consumeOnly`). Resolves `false` when the target agent is the only such agent.
   */
  admitAgentScopedTool: (tool: string, serverName: string) => Promise<boolean>;
}

export interface AuthorizeAgentRestoreParams {
  agent: AgentRestoreTarget;
  /** The snapshot's `tools`, unvalidated. */
  versionTools: unknown;
  authorizeTools: (request: RestoredToolsAuthorization) => Promise<string[]>;
  /** Ids of agents whose `mcpServerNames` include the server, read fresh from the database. */
  listAgentIdsForServer: (serverName: string) => Promise<Array<{ toString(): string }>>;
  /** The requesting user's effective permission bits per agent id. */
  getAgentPermissions: (agentIds: Array<{ toString(): string }>) => Promise<Map<string, number>>;
}

/** Options for `revertAgentVersion` that pin the restore to what was authorized. */
export interface AgentRestorePlan {
  tools?: string[];
  mcpServerNames?: string[];
  expectedUpdatedAt?: Date;
}

export interface RestoredMCPServerNamesParams {
  /** Tools the restore will persist, already authorized for the requesting user. */
  tools: readonly string[];
  /** The agent's tools before the restore. */
  existingTools: readonly string[];
  /** Server names resolved while authorizing the restored tools. */
  resolvedServerNames: Iterable<string>;
  /** The agent's index before the restore; never the snapshot's, which is unverified. */
  priorNames: readonly string[];
}

const isMCPToolKey = (tool: unknown): tool is string =>
  typeof tool === 'string' && tool.includes(Constants.mcp_delimiter) && !isActionTool(tool);

/**
 * Builds the `mcpServerNames` index for a version restore from authorized sources only:
 * names resolved while authorizing the restored tools, plus the agent's pre-restore names
 * that a tool it already had still resolves to. Tool keys embed normalized server names,
 * so prior raw names are matched through their normalized aliases.
 *
 * When MCP tools survive but none resolves (only possible while the registry is
 * unavailable, which admits nothing beyond the agent's current tools), the pre-restore
 * index is kept: it grants nothing the agent did not already grant, whereas deriving
 * names from tool keys could name an unrelated server.
 */
export function resolveRestoredMCPServerNames({
  tools,
  existingTools,
  resolvedServerNames,
  priorNames,
}: RestoredMCPServerNamesParams): string[] {
  const names = new Set(resolvedServerNames);
  const existingToolSet = new Set(existingTools);
  const aliases = buildServerNameAliases(priorNames);
  const aliasKeys = Array.from(aliases.keys());
  let retainsMCPTools = false;

  for (const tool of tools) {
    if (!isMCPToolKey(tool)) {
      continue;
    }
    retainsMCPTools = true;
    if (aliasKeys.length === 0 || !existingToolSet.has(tool)) {
      continue;
    }
    const [, serverName] = splitMCPToolKey(tool, aliasKeys);
    const rawName = serverName != null ? aliases.get(serverName) : undefined;
    if (rawName) {
      names.add(rawName);
    }
  }

  if (names.size === 0 && retainsMCPTools) {
    return [...priorNames];
  }
  return Array.from(names);
}

/**
 * Authorizes a version restore against the agent as it stands, before anything is written.
 *
 * Agent-scoped MCP access is granted from `mcpServerNames`, so the restore must not be
 * judged against the snapshot's index (it would vouch for itself) nor against the target
 * agent's current or cached index for tools the agent does not already have: a newly
 * restored tool needs access the user holds independently of this agent.
 */
export async function authorizeAgentRestore({
  agent,
  versionTools,
  authorizeTools,
  listAgentIdsForServer,
  getAgentPermissions,
}: AuthorizeAgentRestoreParams): Promise<AgentRestorePlan> {
  const plan: AgentRestorePlan = { expectedUpdatedAt: agent.updatedAt };
  const existingTools = agent.tools ?? [];
  const restoredTools = Array.isArray(versionTools)
    ? versionTools.filter((tool): tool is string => typeof tool === 'string')
    : existingTools;
  if (restoredTools.length === 0) {
    return plan;
  }

  const agentId = agent._id.toString();
  const existingToolSet = new Set(existingTools);
  const admitAgentScopedTool = async (tool: string, serverName: string): Promise<boolean> => {
    if (existingToolSet.has(tool)) {
      return true;
    }
    const otherAgentIds = (await listAgentIdsForServer(serverName)).filter(
      (id) => id.toString() !== agentId,
    );
    if (otherAgentIds.length === 0) {
      return false;
    }
    const permissions = await getAgentPermissions(otherAgentIds);
    return otherAgentIds.some(
      (id) => ((permissions.get(id.toString()) ?? 0) & PermissionBits.VIEW) !== 0,
    );
  };

  const resolvedServerNames = new Set<string>();
  const tools = await authorizeTools({
    tools: restoredTools,
    existingTools,
    resolvedServerNames,
    admitAgentScopedTool,
  });

  return {
    ...plan,
    tools,
    mcpServerNames: resolveRestoredMCPServerNames({
      tools,
      existingTools,
      resolvedServerNames,
      priorNames: agent.mcpServerNames ?? [],
    }),
  };
}
