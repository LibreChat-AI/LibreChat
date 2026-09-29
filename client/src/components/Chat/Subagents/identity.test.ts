import { resolveSubagentAgentId } from './identity';

describe('resolveSubagentAgentId', () => {
  const agent = { subagentKind: 'agent' as const, subagentAgentId: 'agent-1' };
  const graph = { subagentKind: 'graph' as const, subagentAgentId: 'agent-1' };
  it('prefers live identity and falls back to explicit saved identity', () => {
    expect(resolveSubagentAgentId({ ...agent, subagentAgentId: 'agent-2' }, agent)).toBe('agent-2');
    expect(resolveSubagentAgentId(null, agent)).toBe('agent-1');
    expect(resolveSubagentAgentId(null, undefined)).toBeUndefined();
  });
  it('never resolves a graph as a saved agent even when their IDs collide', () => {
    expect(resolveSubagentAgentId(graph, agent)).toBeUndefined();
    expect(resolveSubagentAgentId(null, graph)).toBeUndefined();
  });
});
