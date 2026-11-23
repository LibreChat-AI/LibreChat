import {
  Constants,
  isActionTool,
  ResourceType,
  PermissionBits,
  splitMCPToolKey,
  buildServerNameAliases,
} from 'librechat-data-provider';
import type { ParsedServerConfig } from '~/mcp/types';
import { isUserSourced } from '~/mcp/utils';

type ResourceId = { toString(): string };

/** The registry fields the restore gate reads for an approved MCP tool. */
export type RestoredServerConfig = Pick<ParsedServerConfig, 'consumeOnly' | 'source' | 'dbId'>;

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
   * Final gate for every MCP tool the registry approved. Re-checks tools on DB-backed servers
   * the agent's current index does not cover, live and without the target agent's own grant.
   */
  admitMCPTool: (
    tool: string,
    serverName: string,
    config: RestoredServerConfig | undefined,
  ) => Promise<boolean>;
}

export interface AuthorizeAgentRestoreParams {
  agent: AgentRestoreTarget;
  /** The snapshot's `tools`, unvalidated. */
  versionTools: unknown;
  authorizeTools: (request: RestoredToolsAuthorization) => Promise<string[]>;
  /** Ids of agents whose `mcpServerNames` include the server, read fresh from the database. */
  listAgentIdsForServer: (serverName: string) => Promise<ResourceId[]>;
  /** The requesting user's live effective permission bits per resource id. */
  getPermissions: (
    resourceType: ResourceType,
    resourceIds: ResourceId[],
  ) => Promise<Map<string, number>>;
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

/** Prior raw server names that some MCP tool in `tools` resolves to, via normalized aliases. */
function matchPriorServerNames(
  tools: readonly string[],
  priorNames: readonly string[],
): Set<string> {
  const matched = new Set<string>();
  const aliases = buildServerNameAliases(priorNames);
  const aliasKeys = Array.from(aliases.keys());
  if (aliasKeys.length === 0) {
    return matched;
  }
  for (const tool of tools) {
    if (!isMCPToolKey(tool)) {
      continue;
    }
    const [, serverName] = splitMCPToolKey(tool, aliasKeys);
    const rawName = serverName != null ? aliases.get(serverName) : undefined;
    if (rawName) {
      matched.add(rawName);
    }
  }
  return matched;
}

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
  const existingToolSet = new Set(existingTools);
  const names = new Set(resolvedServerNames);
  for (const name of matchPriorServerNames(
    tools.filter((tool) => existingToolSet.has(tool)),
    priorNames,
  )) {
    names.add(name);
  }
  if (names.size === 0 && tools.some(isMCPToolKey)) {
    return [...priorNames];
  }
  return Array.from(names);
}

const canView = (permissions: Map<string, number>, id: ResourceId): boolean =>
  ((permissions.get(id.toString()) ?? 0) & PermissionBits.VIEW) !== 0;

/**
 * Authorizes a version restore against the agent as it stands, before anything is written.
 *
 * Agent-scoped MCP access is granted from `mcpServerNames`, so the restore must not be
 * judged against the snapshot's index (it would vouch for itself), and a tool whose server
 * the agent's index does not already cover must not be admitted on a cached registry view
 * or on the target agent's own grant. A tool on a DB-backed server is admitted when a current tool on that
 * server is still indexed on the agent, or when the user holds a live grant on the server
 * itself or on another agent that uses it.
 */
export async function authorizeAgentRestore({
  agent,
  versionTools,
  authorizeTools,
  listAgentIdsForServer,
  getPermissions,
}: AuthorizeAgentRestoreParams): Promise<AgentRestorePlan> {
  const plan: AgentRestorePlan = { expectedUpdatedAt: agent.updatedAt };
  const existingTools = agent.tools ?? [];
  const snapshotHasTools = Array.isArray(versionTools);
  const restoredTools = snapshotHasTools
    ? versionTools.filter((tool): tool is string => typeof tool === 'string')
    : existingTools;
  if (restoredTools.length === 0) {
    return snapshotHasTools ? { ...plan, tools: [], mcpServerNames: [] } : plan;
  }

  const agentId = agent._id.toString();
  const priorNames = agent.mcpServerNames ?? [];
  /** Servers the agent demonstrably uses now: a current tool still resolves to the name.
   *  Holding a tool is not enough on its own: an unindexed tool (a legacy agent) would
   *  otherwise skip the live check and have its server added to the index. */
  const activeServerNames = matchPriorServerNames(existingTools, priorNames);

  const hasLiveServerAccess = async (
    serverName: string,
    dbId: string | undefined,
  ): Promise<boolean> => {
    if (activeServerNames.has(serverName)) {
      return true;
    }
    const [direct, viaOtherAgent] = await Promise.all([
      dbId
        ? getPermissions(ResourceType.MCPSERVER, [dbId]).then((map) => canView(map, dbId))
        : Promise.resolve(false),
      listAgentIdsForServer(serverName).then(async (ids) => {
        const otherIds = ids.filter((id) => id.toString() !== agentId);
        if (otherIds.length === 0) {
          return false;
        }
        const permissions = await getPermissions(ResourceType.AGENT, otherIds);
        return otherIds.some((id) => canView(permissions, id));
      }),
    ]);
    return direct || viaOtherAgent;
  };

  const admissions = new Map<string, Promise<boolean>>();
  const admitMCPTool = (
    tool: string,
    serverName: string,
    config: RestoredServerConfig | undefined,
  ): Promise<boolean> => {
    if (!config || !isUserSourced(config)) {
      return Promise.resolve(true);
    }
    let admission = admissions.get(serverName);
    if (!admission) {
      admission = hasLiveServerAccess(serverName, config.dbId);
      admissions.set(serverName, admission);
    }
    return admission;
  };

  const resolvedServerNames = new Set<string>();
  const tools = await authorizeTools({
    tools: restoredTools,
    existingTools,
    resolvedServerNames,
    admitMCPTool,
  });

  return {
    ...plan,
    tools,
    mcpServerNames: resolveRestoredMCPServerNames({
      tools,
      existingTools,
      resolvedServerNames,
      priorNames,
    }),
  };
}
