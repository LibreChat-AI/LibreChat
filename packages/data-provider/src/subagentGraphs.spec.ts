import type { AgentSubagentGraph, AgentSubagentsConfig } from './types/agents';
import { graphSubagentSchema, isSubagentGraphsEnabled, resolveSubagents } from './subagentGraphs';
import { AgentCapabilities } from './config';

const graph: AgentSubagentGraph = {
  type: 'review',
  name: 'Review team',
  description: 'Review work',
  agent_ids: ['entry', 'left', 'right', 'result'],
  entry_agent_id: 'entry',
  result_agent_id: 'result',
  edges: [
    { from: 'entry', to: ['left', 'right'], edgeType: 'direct' },
    { from: ['left', 'right'], to: 'result', edgeType: 'direct' },
  ],
};

test('accepts bounded parallel teams and rejects cycles and split fan-in', () => {
  expect(graphSubagentSchema.safeParse(graph).success).toBe(true);
  expect(
    graphSubagentSchema.safeParse({
      ...graph,
      edges: [...graph.edges, { from: 'result', to: 'entry', edgeType: 'direct' }],
    }).success,
  ).toBe(false);
  expect(
    graphSubagentSchema.safeParse({
      ...graph,
      edges: [
        graph.edges[0],
        { from: 'left', to: 'result', edgeType: 'direct' },
        { from: 'right', to: 'result', edgeType: 'direct' },
      ],
    }).success,
  ).toBe(false);
});

test('graph capability can run a team without self-spawn or single-agent targets', () => {
  const config: AgentSubagentsConfig = {
    enabled: false,
    graphsEnabled: true,
    allowSelf: true,
    agent_ids: ['child'],
    graphs: [graph],
  };
  const resolved = resolveSubagents(config, [AgentCapabilities.subagent_graphs]);
  expect(resolved).toMatchObject({
    enabled: true,
    allowSelf: false,
    agent_ids: [],
    graphsEnabled: true,
    graphs: [graph],
  });
  expect(config.enabled).toBe(false);
});

test('the graph capability cannot enable ordinary subagents or bypass a disabled graph gate', () => {
  expect(
    resolveSubagents(
      { enabled: true, graphsEnabled: true, graphs: [graph], agent_ids: ['child'] },
      [AgentCapabilities.subagents],
    ),
  ).toMatchObject({ enabled: true, agent_ids: ['child'], graphsEnabled: false, graphs: [] });
  expect(
    resolveSubagents({ enabled: false, graphsEnabled: true, graphs: [graph] }, []),
  ).toMatchObject({ enabled: false, graphsEnabled: false, graphs: [] });
});

test('legacy stored teams keep their old subagents capability until an explicit graph choice', () => {
  const config = { enabled: true, graphs: [graph] };
  expect(isSubagentGraphsEnabled(config)).toBe(true);
  expect(resolveSubagents(config, [AgentCapabilities.subagents])?.graphs).toEqual([graph]);
  expect(
    resolveSubagents(resolveSubagents(config, [AgentCapabilities.subagents]), [
      AgentCapabilities.subagents,
    ])?.graphs,
  ).toEqual([graph]);
  expect(
    resolveSubagents({ ...config, graphsEnabled: false }, [AgentCapabilities.subagents])?.graphs,
  ).toEqual([]);
  expect(
    resolveSubagents({ ...config, graphsEnabled: true }, [AgentCapabilities.subagents])?.graphs,
  ).toEqual([]);
});

const capabilityChoices = [
  { name: 'ordinary', value: [AgentCapabilities.subagents] },
  { name: 'graphs', value: [AgentCapabilities.subagent_graphs] },
  { name: 'both', value: [AgentCapabilities.subagents, AgentCapabilities.subagent_graphs] },
  { name: 'neither', value: [] },
  { name: 'unresolved', value: undefined },
];
const matrix = capabilityChoices.flatMap(({ name, value }) =>
  [undefined, false, true].flatMap((enabled) =>
    [undefined, false, true].map((graphsEnabled) => ({
      name,
      capabilities: value,
      enabled,
      graphsEnabled,
    })),
  ),
);

test.each(matrix)(
  'preserves spawn authorization for $name capabilities, singles=$enabled, graphs=$graphsEnabled',
  ({ capabilities, enabled, graphsEnabled }) => {
    const config: AgentSubagentsConfig = {
      enabled,
      graphsEnabled,
      allowSelf: true,
      agent_ids: ['child'],
      graphs: [graph],
    };
    const original = JSON.stringify(config);
    const singles =
      enabled === true &&
      (capabilities == null || capabilities.includes(AgentCapabilities.subagents));
    const requiredCapability =
      graphsEnabled == null ? AgentCapabilities.subagents : AgentCapabilities.subagent_graphs;
    const teams =
      (graphsEnabled ?? enabled === true) &&
      (capabilities == null || capabilities.includes(requiredCapability));
    const resolved = resolveSubagents(config, capabilities);
    expect(isSubagentGraphsEnabled(config, capabilities)).toBe(teams);
    expect(resolved?.enabled).toBe(singles || teams);
    expect(resolved?.allowSelf !== false && resolved?.enabled === true).toBe(singles);
    expect(resolved?.agent_ids).toEqual(singles ? ['child'] : []);
    expect(resolved?.graphs).toEqual(teams ? [graph] : []);
    expect(resolveSubagents(resolved, capabilities)).toEqual(resolved);
    expect(JSON.stringify(config)).toBe(original);
  },
);

test('a new graph capability never authorizes untouched legacy teams', () => {
  const legacy = { enabled: true, graphs: [graph] };
  expect(resolveSubagents(legacy, [AgentCapabilities.subagent_graphs])).toMatchObject({
    enabled: false,
    graphs: [],
    agent_ids: [],
    allowSelf: false,
  });
  expect(
    resolveSubagents({ ...legacy, graphsEnabled: true }, [AgentCapabilities.subagent_graphs]),
  ).toMatchObject({ enabled: true, graphs: [graph], agent_ids: [], allowSelf: false });
});
