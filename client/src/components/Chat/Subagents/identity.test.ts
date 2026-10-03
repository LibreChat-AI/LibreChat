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
  it('reads an agent-id type only when no identity was recorded at all', () => {
    expect(resolveSubagentAgentId(null, undefined, 'agent_reviewer')).toBe('agent_reviewer');
    expect(resolveSubagentAgentId(null, undefined, 'researcher')).toBeUndefined();
    expect(resolveSubagentAgentId(null, undefined, 'self')).toBeUndefined();
    expect(resolveSubagentAgentId(null, graph, 'agent_reviewer')).toBeUndefined();
    expect(resolveSubagentAgentId({ subagentKind: 'graph' }, undefined, 'agent_x')).toBeUndefined();
    expect(resolveSubagentAgentId(null, agent, 'agent_reviewer')).toBe('agent-1');
  });
});
