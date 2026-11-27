import type { GraphEdge } from 'librechat-data-provider';
import {
  getEdgeKey,
  getEdgeParticipants,
  collectEdgeAgentIds,
  replaceEdgeSourceId,
  filterOrphanedEdges,
  createEdgeCollector,
} from './edges';

describe('edges utilities', () => {
  describe('replaceEdgeSourceId', () => {
    it('should assign a newly created agent id to placeholder sources', () => {
      const edges: GraphEdge[] = [
        { from: '', to: 'agent_target', edgeType: 'handoff' },
        { from: 'agent_other', to: 'agent_target', edgeType: 'handoff' },
      ];

      expect(replaceEdgeSourceId(edges, '', 'agent_router')).toEqual([
        { from: 'agent_router', to: 'agent_target', edgeType: 'handoff' },
        { from: 'agent_other', to: 'agent_target', edgeType: 'handoff' },
      ]);
    });

    it('should rewrite copied agent ids inside multi-source edges', () => {
      const edges: GraphEdge[] = [
        {
          from: ['agent_original', 'agent_peer'],
          to: 'agent_target',
          edgeType: 'handoff',
        },
      ];

      expect(replaceEdgeSourceId(edges, 'agent_original', 'agent_clone')).toEqual([
        {
          from: ['agent_clone', 'agent_peer'],
          to: 'agent_target',
          edgeType: 'handoff',
        },
      ]);
    });

    it('should preserve untouched edge references', () => {
      const edge: GraphEdge = {
        from: 'agent_other',
        to: 'agent_target',
        edgeType: 'handoff',
      };

      const result = replaceEdgeSourceId([edge], 'agent_original', 'agent_clone');

      expect(result?.[0]).toBe(edge);
    });
  });

  describe('getEdgeKey', () => {
    it('should create key from simple string from/to', () => {
      const edge: GraphEdge = { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' };
      expect(getEdgeKey(edge)).toBe('agent_a=>agent_b::handoff');
    });

    it('should default edgeType to handoff when not provided', () => {
      const edge = { from: 'agent_a', to: 'agent_b' } as GraphEdge;
      expect(getEdgeKey(edge)).toBe('agent_a=>agent_b::handoff');
    });

    it('should handle array from values by sorting', () => {
      const edge: GraphEdge = { from: ['agent_b', 'agent_a'], to: 'agent_c', edgeType: 'handoff' };
      expect(getEdgeKey(edge)).toBe('agent_a|agent_b=>agent_c::handoff');
    });

    it('should handle array to values by sorting', () => {
      const edge: GraphEdge = { from: 'agent_a', to: ['agent_c', 'agent_b'], edgeType: 'handoff' };
      expect(getEdgeKey(edge)).toBe('agent_a=>agent_b|agent_c::handoff');
    });

    it('should handle both from and to as arrays', () => {
      const edge: GraphEdge = {
        from: ['agent_b', 'agent_a'],
        to: ['agent_d', 'agent_c'],
        edgeType: 'direct',
      };
      expect(getEdgeKey(edge)).toBe('agent_a|agent_b=>agent_c|agent_d::direct');
    });

    it('should produce same key regardless of array order', () => {
      const edge1: GraphEdge = { from: ['a', 'b', 'c'], to: 'd', edgeType: 'handoff' };
      const edge2: GraphEdge = { from: ['c', 'a', 'b'], to: 'd', edgeType: 'handoff' };
      expect(getEdgeKey(edge1)).toBe(getEdgeKey(edge2));
    });
  });

  describe('getEdgeParticipants', () => {
    it('should return both from and to as participants', () => {
      const edge: GraphEdge = { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' };
      expect(getEdgeParticipants(edge)).toEqual(['agent_a', 'agent_b']);
    });

    it('should handle array from values', () => {
      const edge: GraphEdge = { from: ['agent_a', 'agent_b'], to: 'agent_c', edgeType: 'handoff' };
      expect(getEdgeParticipants(edge)).toEqual(['agent_a', 'agent_b', 'agent_c']);
    });

    it('should handle array to values', () => {
      const edge: GraphEdge = { from: 'agent_a', to: ['agent_b', 'agent_c'], edgeType: 'handoff' };
      expect(getEdgeParticipants(edge)).toEqual(['agent_a', 'agent_b', 'agent_c']);
    });

    it('should handle both from and to as arrays', () => {
      const edge: GraphEdge = {
        from: ['agent_a', 'agent_b'],
        to: ['agent_c', 'agent_d'],
        edgeType: 'handoff',
      };
      expect(getEdgeParticipants(edge)).toEqual(['agent_a', 'agent_b', 'agent_c', 'agent_d']);
    });

    it('should return empty array for edge with no valid ids', () => {
      const edge = { from: undefined, to: undefined } as unknown as GraphEdge;
      expect(getEdgeParticipants(edge)).toEqual([]);
    });
  });

  describe('collectEdgeAgentIds', () => {
    it('should return empty set for undefined input', () => {
      expect(collectEdgeAgentIds(undefined)).toEqual(new Set());
    });

    it('should return empty set for empty array', () => {
      expect(collectEdgeAgentIds([])).toEqual(new Set());
    });

    it('should collect IDs from simple string from/to', () => {
      const edges: GraphEdge[] = [{ from: 'agent_a', to: 'agent_b', edgeType: 'handoff' }];
      expect(collectEdgeAgentIds(edges)).toEqual(new Set(['agent_a', 'agent_b']));
    });

    it('should collect IDs from array from/to values', () => {
      const edges: GraphEdge[] = [
        { from: ['agent_a', 'agent_b'], to: ['agent_c', 'agent_d'], edgeType: 'handoff' },
      ];
      expect(collectEdgeAgentIds(edges)).toEqual(
        new Set(['agent_a', 'agent_b', 'agent_c', 'agent_d']),
      );
    });

    it('should deduplicate IDs across edges', () => {
      const edges: GraphEdge[] = [
        { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
        { from: 'agent_b', to: 'agent_c', edgeType: 'handoff' },
        { from: 'agent_a', to: 'agent_c', edgeType: 'direct' },
      ];
      expect(collectEdgeAgentIds(edges)).toEqual(new Set(['agent_a', 'agent_b', 'agent_c']));
    });

    it('should handle mixed scalar and array edges', () => {
      const edges: GraphEdge[] = [
        { from: 'agent_a', to: ['agent_b', 'agent_c'], edgeType: 'handoff' },
        { from: ['agent_c', 'agent_d'], to: 'agent_e', edgeType: 'direct' },
      ];
      expect(collectEdgeAgentIds(edges)).toEqual(
        new Set(['agent_a', 'agent_b', 'agent_c', 'agent_d', 'agent_e']),
      );
    });
  });

  describe('filterOrphanedEdges', () => {
    const edges: GraphEdge[] = [
      { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
      { from: 'agent_a', to: 'agent_c', edgeType: 'handoff' },
      { from: 'agent_b', to: 'agent_d', edgeType: 'handoff' },
    ];

    it('should return all edges when no agents are skipped', () => {
      const skipped = new Set<string>();
      expect(filterOrphanedEdges(edges, skipped)).toEqual(edges);
    });

    it('should filter out edges with orphaned to targets and orphaned from sources', () => {
      const skipped = new Set(['agent_b']);
      const result = filterOrphanedEdges(edges, skipped);
      // agent_a -> agent_b (filtered - to=agent_b is skipped)
      // agent_a -> agent_c (kept - neither endpoint skipped)
      // agent_b -> agent_d (filtered - from=agent_b is skipped; a source-side
      // orphan would otherwise leave the graph referencing an absent agent)
      expect(result).toHaveLength(1);
      expect(result[0].to).toBe('agent_c');
    });

    it('should filter out multiple orphaned edges', () => {
      const skipped = new Set(['agent_b', 'agent_c']);
      const result = filterOrphanedEdges(edges, skipped);
      // agent_a -> agent_b (filtered, to)
      // agent_a -> agent_c (filtered, to)
      // agent_b -> agent_d (filtered, from)
      expect(result).toHaveLength(0);
    });

    it('strips skipped co-sources from multi-source edges instead of dropping the whole edge', () => {
      // The SDK adds one `builder.addEdge(source, dest)` per source, so
      // `agent_a -> agent_d` is a valid route even when `agent_b` can't
      // be loaded. Keep the edge with the surviving sources.
      const edgesWithArrayFrom: GraphEdge[] = [
        { from: ['agent_a', 'agent_b'], to: 'agent_d', edgeType: 'handoff' },
        { from: 'agent_a', to: 'agent_d', edgeType: 'handoff' },
      ];
      const skipped = new Set(['agent_b']);
      const result = filterOrphanedEdges(edgesWithArrayFrom, skipped);
      expect(result).toHaveLength(2);
      expect(result[0].from).toEqual(['agent_a']);
      expect(result[0].to).toBe('agent_d');
      expect(result[1].from).toBe('agent_a');
    });

    it('strips skipped co-destinations from multi-destination edges', () => {
      const edgesWithArray: GraphEdge[] = [
        { from: 'agent_a', to: ['agent_b', 'agent_c'], edgeType: 'handoff' },
        { from: 'agent_a', to: ['agent_d'], edgeType: 'handoff' },
      ];
      const skipped = new Set(['agent_b']);
      const result = filterOrphanedEdges(edgesWithArray, skipped);
      // First edge: `['agent_b','agent_c']` → `['agent_c']` — kept.
      // Second edge: unchanged.
      expect(result).toHaveLength(2);
      expect(result[0].to).toEqual(['agent_c']);
      expect(result[1].to).toEqual(['agent_d']);
    });

    it('drops multi-member edges only when every member on a side is skipped', () => {
      const edgesSide: GraphEdge[] = [
        // All sources skipped → drop.
        { from: ['agent_b', 'agent_c'], to: 'agent_a', edgeType: 'handoff' },
        // All destinations skipped → drop.
        { from: 'agent_a', to: ['agent_b', 'agent_c'], edgeType: 'handoff' },
      ];
      const skipped = new Set(['agent_b', 'agent_c']);
      const result = filterOrphanedEdges(edgesSide, skipped);
      expect(result).toHaveLength(0);
    });

    it('should return original edges array when edges is null/undefined', () => {
      const skipped = new Set(['agent_b']);
      expect(filterOrphanedEdges(null as unknown as GraphEdge[], skipped)).toBeNull();
      expect(filterOrphanedEdges(undefined as unknown as GraphEdge[], skipped)).toBeUndefined();
    });

    it('should return original edges when skippedAgentIds is empty', () => {
      const skipped = new Set<string>();
      expect(filterOrphanedEdges(edges, skipped)).toBe(edges);
    });
  });

  describe('createEdgeCollector', () => {
    it('should collect edges and track new agents to process', () => {
      const initializedAgents = new Set(['primary']);
      const checkAgentInit = (id: string) => initializedAgents.has(id);
      const skippedAgentIds = new Set<string>();

      const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
        checkAgentInit,
        skippedAgentIds,
      );

      const edges: GraphEdge[] = [
        { from: 'primary', to: 'agent_a', edgeType: 'handoff' },
        { from: 'primary', to: 'agent_b', edgeType: 'handoff' },
      ];

      collectEdges(edges);

      expect(edgeMap.size).toBe(2);
      expect(agentsToProcess.has('agent_a')).toBe(true);
      expect(agentsToProcess.has('agent_b')).toBe(true);
      expect(agentsToProcess.has('primary')).toBe(false);
    });

    it('should deduplicate edges by key', () => {
      const checkAgentInit = () => false;
      const skippedAgentIds = new Set<string>();

      const { edgeMap, collectEdges } = createEdgeCollector(checkAgentInit, skippedAgentIds);

      const edges: GraphEdge[] = [
        { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
        { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
      ];

      collectEdges(edges);

      expect(edgeMap.size).toBe(1);
    });

    it('should not add skipped agents to process queue', () => {
      const checkAgentInit = () => false;
      const skippedAgentIds = new Set(['agent_b']);

      const { agentsToProcess, collectEdges } = createEdgeCollector(
        checkAgentInit,
        skippedAgentIds,
      );

      const edges: GraphEdge[] = [
        { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
        { from: 'agent_a', to: 'agent_c', edgeType: 'handoff' },
      ];

      collectEdges(edges);

      expect(agentsToProcess.has('agent_a')).toBe(true);
      expect(agentsToProcess.has('agent_b')).toBe(false);
      expect(agentsToProcess.has('agent_c')).toBe(true);
    });

    it('should not add already initialized agents to process queue', () => {
      const initializedAgents = new Set(['agent_a', 'agent_b']);
      const checkAgentInit = (id: string) => initializedAgents.has(id);
      const skippedAgentIds = new Set<string>();

      const { agentsToProcess, collectEdges } = createEdgeCollector(
        checkAgentInit,
        skippedAgentIds,
      );

      const edges: GraphEdge[] = [
        { from: 'agent_a', to: 'agent_b', edgeType: 'handoff' },
        { from: 'agent_a', to: 'agent_c', edgeType: 'handoff' },
      ];

      collectEdges(edges);

      expect(agentsToProcess.has('agent_a')).toBe(false);
      expect(agentsToProcess.has('agent_b')).toBe(false);
      expect(agentsToProcess.has('agent_c')).toBe(true);
    });

    it('should handle undefined/empty edge list', () => {
      const checkAgentInit = () => false;
      const skippedAgentIds = new Set<string>();

      const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
        checkAgentInit,
        skippedAgentIds,
      );

      collectEdges(undefined);
      expect(edgeMap.size).toBe(0);
      expect(agentsToProcess.size).toBe(0);

      collectEdges([]);
      expect(edgeMap.size).toBe(0);
      expect(agentsToProcess.size).toBe(0);
    });

    it('should support multiple collectEdges calls (BFS pattern)', () => {
      const initializedAgents = new Set(['primary']);
      const checkAgentInit = (id: string) => initializedAgents.has(id);
      const skippedAgentIds = new Set<string>();

      const { edgeMap, agentsToProcess, collectEdges } = createEdgeCollector(
        checkAgentInit,
        skippedAgentIds,
      );

      // First call - primary's edges
      collectEdges([{ from: 'primary', to: 'agent_a', edgeType: 'handoff' }]);

      expect(edgeMap.size).toBe(1);
      expect(agentsToProcess.has('agent_a')).toBe(true);

      // Simulate processing agent_a
      initializedAgents.add('agent_a');
      agentsToProcess.delete('agent_a');

      // Second call - agent_a's edges (transitive handoff)
      collectEdges([{ from: 'agent_a', to: 'agent_b', edgeType: 'handoff' }]);

      expect(edgeMap.size).toBe(2);
      expect(agentsToProcess.has('agent_b')).toBe(true);
    });
  });
});
