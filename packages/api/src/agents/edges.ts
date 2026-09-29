import type { GraphEdge } from 'librechat-data-provider';

/**
 * Rewrites an agent id wherever it appears as an edge source.
 *
 * Agent creation uses an empty source id until the server assigns the
 * persisted id, while agent duplication needs to move the copied router's
 * outgoing edges to the clone. Keeping both cases here makes the rewrite
 * consistent for scalar and multi-source edges.
 */
export function replaceEdgeSourceId(
  edges: GraphEdge[] | undefined,
  previousSourceId: string,
  nextSourceId: string,
): GraphEdge[] | undefined {
  if (!edges?.length || previousSourceId === nextSourceId) {
    return edges;
  }

  return edges.map((edge) => {
    if (Array.isArray(edge.from)) {
      if (!edge.from.includes(previousSourceId)) {
        return edge;
      }
      return {
        ...edge,
        from: edge.from.map((sourceId) =>
          sourceId === previousSourceId ? nextSourceId : sourceId,
        ),
      };
    }
    return edge.from === previousSourceId ? { ...edge, from: nextSourceId } : edge;
  });
}

/**
 * Creates a stable key for edge deduplication.
 * Handles both single and array-based from/to values.
 */
export function getEdgeKey(edge: GraphEdge): string {
  const from = Array.isArray(edge.from) ? [...edge.from].sort().join('|') : edge.from;
  const to = Array.isArray(edge.to) ? [...edge.to].sort().join('|') : edge.to;
  const type = edge.edgeType ?? 'handoff';
  return `${from}=>${to}::${type}`;
}

/**
 * Extracts all agent IDs referenced in an edge (both from and to).
 */
export function getEdgeParticipants(edge: GraphEdge): string[] {
  const participants: string[] = [];
  if (Array.isArray(edge.from)) {
    participants.push(...edge.from);
  } else if (typeof edge.from === 'string') {
    participants.push(edge.from);
  }
  if (Array.isArray(edge.to)) {
    participants.push(...edge.to);
  } else if (typeof edge.to === 'string') {
    participants.push(edge.to);
  }
  return participants;
}

/**
 * Drops skipped agent ids from an edge endpoint.
 *
 * Scalars: returns the value unchanged, or `null` if the skipped set
 * contains it (the edge has lost its only endpoint on that side and
 * must be dropped by the caller).
 *
 * Arrays: returns a new array with skipped ids removed; if every id was
 * skipped, returns `null`. A single-element result stays an array — the
 * SDK normalizes both shapes internally, so preserving array-ness is
 * simpler than switching representation.
 *
 * Returns the original reference when nothing changed, so callers can
 * cheaply detect and skip a re-spread.
 */
function sanitizeEndpoint(
  value: string | string[],
  skippedAgentIds: Set<string>,
): string | string[] | null {
  if (Array.isArray(value)) {
    const kept: string[] = [];
    let removed = false;
    for (const id of value) {
      if (typeof id === 'string' && skippedAgentIds.has(id)) {
        removed = true;
        continue;
      }
      kept.push(id);
    }
    if (kept.length === 0) {
      return null;
    }
    return removed ? kept : value;
  }
  if (typeof value === 'string' && skippedAgentIds.has(value)) {
    return null;
  }
  return value;
}

/**
 * Drops orphaned agents from edge endpoints, returning only the edges
 * that still have at least one valid source and one valid destination.
 *
 * For multi-source / multi-destination edges, orphaned ids are stripped
 * from the array rather than dropping the whole edge: `{ from: ['A','B'],
 * to: 'C' }` with B skipped becomes `{ from: ['A'], to: 'C' }`. This
 * matches the agents SDK's `MultiAgentGraph.createWorkflow`, which adds
 * one LangGraph edge per source/destination pair (`builder.addEdge(src,
 * dest)`), so losing one co-source (or one co-destination) doesn't
 * invalidate the routes through the remaining members.
 *
 * An edge is dropped only when it has no surviving source OR no
 * surviving destination — the SDK's per-source `addEdge` can't run if
 * either side is empty, and any orphaned id left in place would still
 * trigger `Found edge ending at unknown node` at compile time.
 */
export function filterOrphanedEdges(edges: GraphEdge[], skippedAgentIds: Set<string>): GraphEdge[] {
  if (!edges || skippedAgentIds.size === 0) {
    return edges;
  }
  const result: GraphEdge[] = [];
  for (const edge of edges) {
    const from = sanitizeEndpoint(edge.from, skippedAgentIds);
    const to = sanitizeEndpoint(edge.to, skippedAgentIds);
    if (from === null || to === null) {
      continue;
    }
    if (from === edge.from && to === edge.to) {
      result.push(edge);
    } else {
      result.push({ ...edge, from, to });
    }
  }
  return result;
}

/** Applies the runtime graph's post-filter reachability rules to loaded agents and edges. */
export function resolveReachableGraph(
  explicitSeeds: Iterable<string>,
  agentIds: Iterable<string>,
  preFilterEdges: GraphEdge[],
  skippedAgentIds: Set<string>,
): { reachable: Set<string>; edges: GraphEdge[] } {
  const filteredEdges = filterOrphanedEdges(preFilterEdges, skippedAgentIds);
  const anyReachable = (value: string | string[], reachableSet: Set<string>): boolean =>
    (Array.isArray(value) ? value : [value]).some(
      (id) => typeof id === 'string' && reachableSet.has(id),
    );
  const allReachable = (value: string | string[], reachableSet: Set<string>): boolean =>
    (Array.isArray(value) ? value : [value]).every(
      (id) => typeof id !== 'string' || reachableSet.has(id),
    );

  const hadIncomingEdgePreFilter = new Set<string>();
  for (const edge of preFilterEdges) {
    for (const dest of Array.isArray(edge.to) ? edge.to : [edge.to]) {
      if (typeof dest === 'string') hadIncomingEdgePreFilter.add(dest);
    }
  }

  const seeds = new Set(explicitSeeds);
  for (const agentId of agentIds) {
    if (!hadIncomingEdgePreFilter.has(agentId)) seeds.add(agentId);
  }

  const reachable = new Set(seeds);
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of filteredEdges) {
      if (!anyReachable(edge.from, reachable)) continue;
      for (const dest of Array.isArray(edge.to) ? edge.to : [edge.to]) {
        if (typeof dest === 'string' && !reachable.has(dest)) {
          reachable.add(dest);
          changed = true;
        }
      }
    }
  }

  const edges: GraphEdge[] = [];
  for (const edge of filteredEdges) {
    if (!anyReachable(edge.from, reachable) || !allReachable(edge.to, reachable)) continue;
    if (!Array.isArray(edge.from)) {
      edges.push(edge);
      continue;
    }
    const reachableSources = edge.from.filter(
      (source) => typeof source !== 'string' || reachable.has(source),
    );
    edges.push(
      reachableSources.length === edge.from.length ? edge : { ...edge, from: reachableSources },
    );
  }
  return { reachable, edges };
}

/** Collects all unique agent IDs referenced across an array of edges. */
export function collectEdgeAgentIds(edges: GraphEdge[] | undefined): Set<string> {
  const ids = new Set<string>();
  if (!edges || edges.length === 0) {
    return ids;
  }
  for (const edge of edges) {
    for (const id of getEdgeParticipants(edge)) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Result of discovering and aggregating edges from connected agents.
 */
export interface EdgeDiscoveryResult {
  /** Deduplicated edges from all discovered agents */
  edges: GraphEdge[];
  /** Agent IDs that were not found (orphaned references) */
  skippedAgentIds: Set<string>;
}

/**
 * Collects and deduplicates edges, tracking new agents to process.
 * Used for BFS discovery of connected agents.
 */
export function createEdgeCollector(
  checkAgentInit: (agentId: string) => boolean,
  skippedAgentIds: Set<string>,
): {
  edgeMap: Map<string, GraphEdge>;
  agentsToProcess: Set<string>;
  collectEdges: (edgeList: GraphEdge[] | undefined) => void;
} {
  const edgeMap = new Map<string, GraphEdge>();
  const agentsToProcess = new Set<string>();

  const collectEdges = (edgeList: GraphEdge[] | undefined): void => {
    if (!edgeList || edgeList.length === 0) {
      return;
    }
    for (const edge of edgeList) {
      const key = getEdgeKey(edge);
      if (!edgeMap.has(key)) {
        edgeMap.set(key, edge);
      }
      const participants = getEdgeParticipants(edge);
      for (const id of participants) {
        if (!checkAgentInit(id) && !skippedAgentIds.has(id)) {
          agentsToProcess.add(id);
        }
      }
    }
  };

  return { edgeMap, agentsToProcess, collectEdges };
}
