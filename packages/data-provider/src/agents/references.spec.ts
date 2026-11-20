import type { AgentSubagentGraph, AgentSubagentsConfig } from '../types/agents';
import { hasSubagentReference, pruneSubagentReferences } from './references';

const team: AgentSubagentGraph = {
  type: 'team',
  name: 'Team',
  description: 'Team',
  agent_ids: ['entry', 'middle', 'result'],
  edges: [
    { from: 'entry', to: 'middle', edgeType: 'direct' },
    { from: 'middle', to: 'result', edgeType: 'direct' },
  ],
  entry_agent_id: 'entry',
  result_agent_id: 'result',
};

describe('subagent reference cleanup', () => {
  it('preserves flags, surviving targets, and its input', () => {
    const config: AgentSubagentsConfig = {
      enabled: false,
      allowSelf: false,
      shareFiles: true,
      agent_ids: ['deleted', 'kept', 'deleted'],
    };
    expect(pruneSubagentReferences(config, new Set(['deleted']))).toEqual({
      ...config,
      agent_ids: ['kept'],
    });
    expect(config.agent_ids).toEqual(['deleted', 'kept', 'deleted']);
  });

  it.each(['entry', 'middle', 'result'])('removes a team after deleting its %s member', (id) => {
    const unaffected = {
      ...team,
      type: 'other',
      agent_ids: ['other'],
      edges: [],
      entry_agent_id: 'other',
      result_agent_id: 'other',
    };
    const config = { graphs: [team, unaffected] };
    expect(pruneSubagentReferences(config, new Set([id]))).toEqual({ graphs: [unaffected] });
    expect(config.graphs).toEqual([team, unaffected]);
  });

  it.each([
    { ...team, agent_ids: [], entry_agent_id: 'deleted' },
    { ...team, agent_ids: [], result_agent_id: 'deleted' },
    {
      ...team,
      agent_ids: [],
      edges: [{ from: ['deleted', 'entry'], to: 'result', edgeType: 'direct' as const }],
    },
    {
      ...team,
      agent_ids: [],
      edges: [{ from: 'entry', to: ['deleted', 'result'], edgeType: 'direct' as const }],
    },
  ])('also detects dangling endpoint references in legacy teams', (graph) => {
    expect(pruneSubagentReferences({ graphs: [graph] }, new Set(['deleted']))).toEqual({
      graphs: [],
    });
  });

  it('leaves unrelated and absent configuration alone', () => {
    const config = { graphs: [team] };
    const removed = new Set(['missing']);
    expect(hasSubagentReference(undefined, removed)).toBe(false);
    expect(pruneSubagentReferences(config, removed)).toBe(config);
    expect(pruneSubagentReferences({}, removed)).toEqual({});
  });
});
