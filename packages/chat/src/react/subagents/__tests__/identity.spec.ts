import { resolveSubagentAgentId, resolvePendingSubagentAgentId } from '../identity';

describe('resolvePendingSubagentAgentId', () => {
  const agents = { 'agent-1': { id: 'agent-1' } };
  it('names the saved agent a requested type is the id of', () => {
    expect(resolvePendingSubagentAgentId('agent-1', agents)).toBe('agent-1');
  });
  it('names nothing for a self-spawn, an alias, a missing type or a missing map', () => {
    expect(resolvePendingSubagentAgentId('self', agents)).toBeUndefined();
    expect(resolvePendingSubagentAgentId('researcher', agents)).toBeUndefined();
    expect(resolvePendingSubagentAgentId(undefined, agents)).toBeUndefined();
    expect(resolvePendingSubagentAgentId('agent-1', undefined)).toBeUndefined();
  });
});

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
  it('does not infer a saved agent when identity is absent', () => {
    expect(resolveSubagentAgentId(null, undefined)).toBeUndefined();
    expect(resolveSubagentAgentId({ subagentKind: 'graph' }, undefined)).toBeUndefined();
  });
});
