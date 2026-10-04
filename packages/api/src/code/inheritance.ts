import {
  Tools,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  isCodeWorkspaceSelections,
  resolveCodeWorkspaceInheritance,
} from 'librechat-data-provider';
import type { Agent, CodeWorkspaceRoutingAgent } from 'librechat-data-provider';
import type { CodeEnvironmentConfig, CodeExecutionContext } from '~/agents/execution';
import {
  isExecutableAttachedEnvironment,
  resolveAgentCodeEnvironmentRouting,
} from '~/agents/execution';

type SpawnConfig = Pick<NonNullable<Agent['subagents']>, 'enabled' | 'agent_ids'> & {
  graphs?: ReadonlyArray<
    Pick<NonNullable<NonNullable<Agent['subagents']>['graphs']>[number], 'agent_ids'>
  >;
};

/** The saved fields of a subagent that decide where it runs code. */
export type SubagentCodeRoutingAgent = Pick<
  Agent,
  'id' | 'tools' | 'stateful_code_sessions' | 'code_environment_id' | 'code_environment_ids'
> & { subagents?: SpawnConfig | null };

/** An initialized root of the run, whose machine is already resolved. */
export type CodeWorkspaceInheritanceRoot = Pick<SubagentCodeRoutingAgent, 'id' | 'subagents'> & {
  statefulCodeSessions?: boolean;
  codeExecutionContext?: Pick<CodeExecutionContext, 'environmentId' | 'environmentType'>;
};

/** Saved agents this agent may spawn: explicit subagents and the members of its subagent graphs.
 *  Self-spawns already share their parent's route. */
export function getSpawnableSubagentIds(
  agent: Pick<SubagentCodeRoutingAgent, 'id' | 'subagents'>,
): string[] {
  const subagents = agent.subagents;
  if (subagents?.enabled !== true) {
    return [];
  }
  const ids = [
    ...(Array.isArray(subagents.agent_ids) ? subagents.agent_ids : []),
    ...(subagents.graphs ?? []).flatMap((graph) =>
      Array.isArray(graph?.agent_ids) ? graph.agent_ids : [],
    ),
  ];
  return [
    ...new Set(
      ids.filter((id): id is string => typeof id === 'string' && id.length > 0 && id !== agent.id),
    ),
  ];
}

function toRootRoutingAgent(root: CodeWorkspaceInheritanceRoot): CodeWorkspaceRoutingAgent {
  const context = root.codeExecutionContext;
  return {
    id: root.id,
    routesCode: root.statefulCodeSessions === true,
    allowSelection: false,
    subagentIds: getSpawnableSubagentIds(root),
    resolvedEnvironmentId:
      context?.environmentType === 'attached' ? (context.environmentId ?? null) : null,
  };
}

function toSubagentRoutingAgent(
  agent: SubagentCodeRoutingAgent,
  environments: readonly CodeEnvironmentConfig[] | undefined,
  allowEnvironmentSelection: boolean | undefined,
): CodeWorkspaceRoutingAgent {
  const { defaultEnvironment, allowSelection } = resolveAgentCodeEnvironmentRouting({
    environmentId: agent.code_environment_id,
    environmentIds: agent.code_environment_ids,
    environments,
    allowEnvironmentSelection,
  });
  return {
    id: agent.id,
    routesCode:
      agent.stateful_code_sessions === true && agent.tools?.includes(Tools.execute_code) === true,
    environmentId: agent.code_environment_id ?? defaultEnvironment?.id,
    environmentIds: agent.code_environment_ids,
    allowSelection,
    subagentIds: getSpawnableSubagentIds(agent),
  };
}

/**
 * Derives, once per request, which subagents run on their parent's attached machine. Each
 * routing site passes the result to `resolveCodeExecutionContext`, so lazy descriptors, child
 * initialization and execution-time tool loads agree on one route per subagent.
 *
 * `loadSubagent` must return only agents the principal may view, and should share its results
 * with the run's own subagent loading so the walk adds no reads. It stays within the subagent
 * depth and node limits; graph construction reports a graph that exceeds them.
 */
export async function resolveSubagentCodeWorkspaceInheritance({
  selections,
  roots,
  loadSubagent,
  environments,
  allowEnvironmentSelection,
  codeExecutionAvailable,
}: {
  selections: unknown;
  roots: readonly CodeWorkspaceInheritanceRoot[];
  loadSubagent: (agentId: string) => Promise<SubagentCodeRoutingAgent | null | undefined>;
  environments?: readonly CodeEnvironmentConfig[];
  allowEnvironmentSelection?: boolean;
  /** The run may use stateful code at all: capability, role grant and deployment switches. */
  codeExecutionAvailable: boolean;
}): Promise<Map<string, string>> {
  if (!codeExecutionAvailable || !isCodeWorkspaceSelections(selections) || !selections.length) {
    return new Map();
  }
  const agents = new Map<string, CodeWorkspaceRoutingAgent>();
  for (const root of roots) {
    agents.set(root.id, toRootRoutingAgent(root));
  }
  let frontier = [...agents.values()].flatMap(({ subagentIds }) => subagentIds ?? []);
  let loadedCount = 0;
  for (let depth = 1; depth <= MAX_SUBAGENT_DEPTH && frontier.length > 0; depth++) {
    const ids = [...new Set(frontier)]
      .filter((id) => !agents.has(id))
      .slice(0, Math.max(0, MAX_SUBAGENT_GRAPH_NODES - loadedCount));
    loadedCount += ids.length;
    const loaded = await Promise.all(ids.map((id) => loadSubagent(id).catch(() => null)));
    frontier = [];
    for (let index = 0; index < ids.length; index++) {
      const agent = loaded[index];
      if (agent == null) continue;
      const node = toSubagentRoutingAgent(
        { ...agent, id: ids[index] },
        environments,
        allowEnvironmentSelection,
      );
      agents.set(node.id, node);
      frontier.push(...(node.subagentIds ?? []));
    }
  }
  return resolveCodeWorkspaceInheritance({
    selections,
    rootIds: roots.map(({ id }) => id),
    agents,
    isAttachedEnvironment: (environmentId) =>
      isExecutableAttachedEnvironment(environmentId, environments),
  });
}
