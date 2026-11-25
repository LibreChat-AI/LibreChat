export interface ReachableAgent<TAgent> {
  readonly subagentAgentConfigs?: readonly (TAgent | null | undefined)[];
  readonly lazySubagentConfigs?: readonly (TAgent | null | undefined)[];
  readonly subagentGraphMemberMetadata?: readonly (TAgent | null | undefined)[];
  readonly subagentGraphConfigs?: readonly {
    readonly memberConfigs?: readonly (TAgent | null | undefined)[];
  }[];
}

/** Visits each object once in breadth-first order, stopping before a match's descendants. */
export function someReachableAgent<T extends ReachableAgent<T>>(
  roots: Iterable<T | null | undefined>,
  predicate: (agent: T) => boolean,
): boolean {
  let visited: Set<T> | undefined;
  let pending: Array<T | null | undefined> | undefined;
  const matches = (agent: T | null | undefined): boolean => {
    if (agent == null || visited?.has(agent)) {
      return false;
    }
    if (predicate(agent)) {
      return true;
    }
    (visited ??= new Set<T>()).add(agent);
    const eager = agent.subagentAgentConfigs;
    const lazy = agent.lazySubagentConfigs;
    const metadata = agent.subagentGraphMemberMetadata;
    if (eager?.length) {
      (pending ??= []).push(...eager);
    }
    if (lazy?.length) {
      (pending ??= []).push(...lazy);
    }
    if (metadata?.length) {
      (pending ??= []).push(...metadata);
    }
    for (const graph of agent.subagentGraphConfigs ?? []) {
      const members = graph.memberConfigs;
      if (members?.length) {
        (pending ??= []).push(...members);
      }
    }
    return false;
  };

  for (const root of roots) {
    if (matches(root)) {
      return true;
    }
  }
  for (let index = 0; pending && index < pending.length; index++) {
    if (matches(pending[index])) {
      return true;
    }
  }
  return false;
}

/** Collects distinct snapshots in breadth-first order, including shared and cyclic graphs. */
export function collectReachableAgents<T extends ReachableAgent<T>>(
  roots: readonly (T | null | undefined)[],
): T[] {
  const agents: T[] = [];
  someReachableAgent(roots, (agent) => {
    agents.push(agent);
    return false;
  });
  return agents;
}
