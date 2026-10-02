import {
  AgentCapabilities,
  EModelEndpoint,
  MAX_SUBAGENT_DEPTH,
  MAX_SUBAGENT_GRAPH_NODES,
  MAX_SUBAGENT_RUN_CONFIGS,
  isActionTool,
  resolveModelCatalogKey,
} from 'librechat-data-provider';
import type {
  AgentMethods,
  IUser,
  AppConfig,
  AgentGraphNode,
  AgentGraphAccessContext,
} from '@librechat/data-schemas';
import type { TModelsConfig } from 'librechat-data-provider';
import { resolveReachableGraph } from '../agents/edges';

export type ScheduleMCPGraphDeps = Pick<
  AgentMethods,
  'getAgentGraphNodes' | 'resolveAgentGraphAccess'
> & {
  getModelsConfig: (user: IUser) => Promise<TModelsConfig>;
};
export interface ScheduledMCPRequirements {
  tools: Array<{ name: string; agentId: string }>;
  serverHints: Set<string>;
}

/** The runtime's bounded graph expansion, shared by readiness and enrollment metadata. */
export async function resolveScheduledMCPRequirements(
  agentId: string,
  user: IUser,
  deps: ScheduleMCPGraphDeps,
  loadAppConfig: () => Promise<AppConfig | undefined>,
  signal?: AbortSignal,
): Promise<ScheduledMCPRequirements> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw signal.reason ?? new Error('MCP requirements aborted');
  };
  throwIfAborted();
  const tools: Array<{ name: string; agentId: string }> = [];
  const serverHints = new Set<string>();
  const graphEdges: NonNullable<AgentGraphNode['edges']> = [];
  const explicitSeeds = new Set<string>([agentId]);
  const attempted = new Set<string>();
  const expanded = new Set<string>();
  const expandedHandoffs = new Set<string>();
  const expandedHandoffEdges = new Set<string>();
  const viewableById = new Map<string, AgentGraphNode>();
  const accessibleById = new Map<string, AgentGraphNode>();
  const subagentGraphIds = new Set<string>();
  const accessIdentity = {
    userId: user.id,
    role: user.role,
    idOnTheSource: user.idOnTheSource,
  };
  let accessContext: AgentGraphAccessContext | undefined;
  let modelsConfig: TModelsConfig | undefined;

  const loadNodes = async (ids: string[]): Promise<void> => {
    const frontier = [...new Set(ids)].filter(
      (id) => !attempted.has(id) && id !== '__start__' && id !== '__end__' && id.length > 0,
    );
    if (frontier.length === 0) return;
    frontier.forEach((id) => attempted.add(id));
    let loaded: AgentGraphNode[] = [];
    if (frontier.includes(agentId)) {
      const root = await deps.getAgentGraphNodes([agentId]);
      const descendants = frontier.filter((id) => id !== agentId);
      loaded = [
        ...root,
        ...(descendants.length > 0
          ? await deps.getAgentGraphNodes(
              descendants,
              (accessContext ??= await deps.resolveAgentGraphAccess(accessIdentity)),
            )
          : []),
      ];
    } else {
      loaded = await deps.getAgentGraphNodes(
        frontier,
        (accessContext ??= await deps.resolveAgentGraphAccess(accessIdentity)),
      );
    }
    throwIfAborted();
    const descendants = loaded.filter((agent) => agent.id !== agentId);
    if (descendants.length > 0) {
      modelsConfig ??= await deps.getModelsConfig(user);
    }
    for (const agent of loaded) {
      viewableById.set(agent.id, agent);
      const availableModels =
        agent.id === agentId
          ? undefined
          : modelsConfig?.[resolveModelCatalogKey(agent.provider, modelsConfig)];
      if (
        agent.id === agentId ||
        (agent.model.length > 0 && availableModels?.includes(agent.model) === true)
      ) {
        accessibleById.set(agent.id, agent);
      }
    }
  };

  // Match discoverConnectedAgents first: handoff agents are initialized and pruned
  // before any isolated subagent descriptors or graph definitions are considered.
  type HandoffCandidate = { id: string; expandEdges: boolean };
  let handoffFrontier: HandoffCandidate[] = [{ id: agentId, expandEdges: true }];
  while (handoffFrontier.length > 0) {
    const frontier = handoffFrontier;
    handoffFrontier = [];
    await loadNodes(frontier.map(({ id }) => id));
    for (const { id, expandEdges } of frontier) {
      const agent = accessibleById.get(id);
      if (!agent) continue;
      expandedHandoffs.add(id);
      expanded.add(id);
      if (agent.id === agentId) {
        let previousId = agent.id;
        for (const childId of agent.agent_ids ?? []) {
          if (childId === agent.id || childId.length === 0) continue;
          graphEdges.push({ from: previousId, to: childId });
          // discoverConnectedAgents initializes legacy chain members only after
          // recursive handoff discovery and never collects their persisted edges.
          handoffFrontier.push({ id: childId, expandEdges: false });
          previousId = childId;
        }
      }
      if (!expandEdges || expandedHandoffEdges.has(id)) continue;
      expandedHandoffEdges.add(id);
      graphEdges.push(...(agent.edges ?? []));
      for (const edge of agent.edges ?? []) {
        handoffFrontier.push(
          ...[edge.from, edge.to].flat().map((childId) => ({
            id: childId,
            expandEdges: true,
          })),
        );
      }
    }
  }

  const handoffSkippedIds = new Set(
    [...attempted].filter((id) => id !== agentId && !accessibleById.has(id)),
  );
  const { reachable: reachableHandoffIds } = resolveReachableGraph(
    new Set([agentId]),
    expandedHandoffs,
    graphEdges,
    handoffSkippedIds,
  );
  const rootConfigs = [...reachableHandoffIds]
    .map((id) => accessibleById.get(id))
    .filter((agent): agent is AgentGraphNode => agent != null);
  const rootConfigIds = new Set(rootConfigs.map((agent) => agent.id));
  const directValidationContexts: Array<{
    id: string;
    ancestors: Set<string>;
    acceptedGraphCount: number;
  }> = [];
  const acceptedGraphCounts = new Map<string, number>();
  let expandedSubagentConfigs = 0;
  let subagentsAvailable: boolean | undefined;
  const canUseSubagents = async (): Promise<boolean> => {
    if (subagentsAvailable != null) return subagentsAvailable;
    const config = await loadAppConfig();
    subagentsAvailable = (config?.endpoints?.[EModelEndpoint.agents]?.capabilities ?? []).includes(
      AgentCapabilities.subagents,
    );
    return subagentsAvailable;
  };
  const addGraphBudgetMember = (id: string): void => {
    if (id === agentId || subagentGraphIds.has(id)) return;
    if (subagentGraphIds.size >= MAX_SUBAGENT_GRAPH_NODES) {
      throw new Error(
        `Subagent graph exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents.`,
      );
    }
    subagentGraphIds.add(id);
  };
  const countExpandedSubagentConfig = (): void => {
    expandedSubagentConfigs += 1;
    if (expandedSubagentConfigs > MAX_SUBAGENT_RUN_CONFIGS) {
      throw new Error(
        `Subagent run configuration exceeds the maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries.`,
      );
    }
  };
  const includeGraph = async (ids: string[], parentRunnable: boolean): Promise<boolean> => {
    await loadNodes(ids);
    if (!parentRunnable || ids.some((id) => !accessibleById.has(id))) return false;
    for (const id of ids) {
      explicitSeeds.add(id);
      expanded.add(id);
    }
    return true;
  };
  const processDirectGraphs = async (
    agent: AgentGraphNode,
    parentRunnable: boolean,
  ): Promise<number> => {
    if (!agent.subagents?.enabled || !(await canUseSubagents())) return 0;
    const definitions = agent.subagents.graphs ?? [];
    let acceptedGraphCount = 0;
    const memberIds = [...new Set(definitions.flatMap((graph) => graph.agent_ids ?? []))].filter(
      (id) => id !== agent.id && id !== agentId && !rootConfigIds.has(id),
    );
    const staged = memberIds.filter((id) => !subagentGraphIds.has(id));
    if (subagentGraphIds.size + staged.length > MAX_SUBAGENT_GRAPH_NODES) {
      throw new Error(
        `Subagent graph exceeds the maximum of ${MAX_SUBAGENT_GRAPH_NODES} unique agents.`,
      );
    }
    staged.forEach((id) => subagentGraphIds.add(id));
    await loadNodes(memberIds);
    for (const definition of definitions) {
      const ids = [...new Set(definition.agent_ids ?? [])];
      if (await includeGraph(ids, parentRunnable)) {
        acceptedGraphCount += 1;
      }
    }
    return acceptedGraphCount;
  };
  const visitDirectTree = async (
    agent: AgentGraphNode,
    depth: number,
    ancestors: Set<string>,
    parentRunnable: boolean,
  ): Promise<void> => {
    if (!agent.subagents?.enabled || !(await canUseSubagents())) return;
    if (agent.subagents.allowSelf !== false) countExpandedSubagentConfig();
    const directIds = [...new Set(agent.subagents.agent_ids ?? [])].filter(
      (id) => id.length > 0 && id !== agent.id,
    );
    if (directIds.length > 0 && depth >= MAX_SUBAGENT_DEPTH) {
      throw new Error(
        `Subagent graph exceeds the maximum depth of ${MAX_SUBAGENT_DEPTH} at agent ${agent.id}.`,
      );
    }
    await loadNodes(directIds);
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(agent.id);
    for (const childId of directIds) {
      if (nextAncestors.has(childId) || handoffSkippedIds.has(childId)) continue;
      // Lazy runtime initialization loads VIEW-checked metadata before model
      // validation. Even an invalid-model descriptor consumes depth, expanded-
      // config, and graph-node budgets, but its MCP tools can never execute.
      const child = viewableById.get(childId);
      if (!child) continue;
      addGraphBudgetMember(childId);
      countExpandedSubagentConfig();
      const childRunnable = parentRunnable && accessibleById.has(childId);
      const validationContext = childRunnable
        ? { id: childId, ancestors: nextAncestors, acceptedGraphCount: 0 }
        : undefined;
      if (validationContext) {
        directValidationContexts.push(validationContext);
        explicitSeeds.add(childId);
        expanded.add(childId);
      }
      await visitDirectTree(child, depth + 1, nextAncestors, childRunnable);
      // initializeClient preloads a direct child's graph members only after its
      // complete nested direct tree, before root-level graphs are resolved.
      const acceptedGraphCount = await processDirectGraphs(child, childRunnable);
      if (validationContext) validationContext.acceptedGraphCount = acceptedGraphCount;
    }
  };

  for (const root of rootConfigs) {
    await visitDirectTree(root, 0, new Set(), true);
  }
  // Root and handoff graph definitions run after every direct tree. Each definition
  // is skipped atomically when its new members would exceed the shared runtime budget.
  for (const root of rootConfigs) {
    if (!root.subagents?.enabled || !(await canUseSubagents())) continue;
    for (const definition of root.subagents.graphs ?? []) {
      const ids = [...new Set(definition.agent_ids ?? [])];
      const staged = ids.filter(
        (id) => id !== agentId && !rootConfigIds.has(id) && !subagentGraphIds.has(id),
      );
      if (subagentGraphIds.size + staged.length > MAX_SUBAGENT_GRAPH_NODES) continue;
      staged.forEach((id) => subagentGraphIds.add(id));
      if (await includeGraph(ids, true)) {
        acceptedGraphCounts.set(root.id, (acceptedGraphCounts.get(root.id) ?? 0) + 1);
      }
    }
  }
  const validateRunConfigTree = (
    agent: AgentGraphNode,
    state: { count: number },
    ancestors: Set<string>,
    acceptedGraphCount = acceptedGraphCounts.get(agent.id) ?? 0,
  ): void => {
    if (!agent.subagents?.enabled || subagentsAvailable !== true) return;
    const count = (): void => {
      state.count += 1;
      if (state.count > MAX_SUBAGENT_RUN_CONFIGS) {
        throw new Error(
          `Subagent run configuration exceeds the maximum of ${MAX_SUBAGENT_RUN_CONFIGS} expanded entries.`,
        );
      }
    };
    if (agent.subagents.allowSelf !== false) count();
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(agent.id);
    for (const childId of new Set(agent.subagents.agent_ids ?? [])) {
      if (childId === agent.id || nextAncestors.has(childId)) continue;
      const child = viewableById.get(childId);
      if (!child) continue;
      count();
      // Only already initialized handoff configs are eager in the initial run.
      // Other direct children resolve lazily with their own fresh counter below.
      if (rootConfigIds.has(childId)) {
        validateRunConfigTree(child, state, nextAncestors);
      }
    }
    for (let index = 0; index < acceptedGraphCount; index++) count();
  };
  const initialRunState = { count: 0 };
  for (const root of rootConfigs) {
    validateRunConfigTree(root, initialRunState, new Set());
  }
  for (const { id: directId, ancestors, acceptedGraphCount } of directValidationContexts) {
    if (rootConfigIds.has(directId)) continue;
    const direct = accessibleById.get(directId);
    if (!direct) continue;
    // createLazySubagentConfig seeds the selected child's resolution at one.
    validateRunConfigTree(direct, { count: 1 }, ancestors, acceptedGraphCount);
  }
  const skippedAgentIds = new Set(
    [...attempted].filter((id) => id !== agentId && !accessibleById.has(id)),
  );
  const { reachable } = resolveReachableGraph(explicitSeeds, expanded, graphEdges, skippedAgentIds);
  for (const id of reachable) {
    const agent = accessibleById.get(id);
    if (!agent || !expanded.has(id)) continue;
    tools.push(
      ...(agent.tools ?? [])
        .filter((tool) => !isActionTool(tool))
        .map((name) => ({ name, agentId: agent.id })),
    );
    for (const name of agent.mcpServerNames ?? []) serverHints.add(name);
  }
  return { tools, serverHints };
}
