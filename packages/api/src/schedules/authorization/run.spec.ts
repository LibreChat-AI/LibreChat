import { StructuredTool } from '@langchain/core/tools';
import { AIMessage } from '@librechat/agents/langchain/messages';
import {
  Constants,
  HookRegistry,
  MultiAgentGraph,
  Providers,
  ToolNode,
  executeHooks,
} from '@librechat/agents';
import type { GraphEdge } from '@librechat/agents';
import { executionFixture } from './execution.helper';
import { createScheduledMCPRunPolicy } from './run';

async function setup(edges: GraphEdge[]) {
  const fixture = await executionFixture();
  const agents = ['root', 'child', 'peer'].map((id) => ({ id }));
  const policy = createScheduledMCPRunPolicy(fixture.execution, agents, edges);
  const hooks = new HookRegistry();
  hooks.register('PreToolUse', { hooks: [policy.hook] });
  const graph = new MultiAgentGraph({
    agents: agents.map(({ id }) => ({ agentId: id, provider: Providers.OPENAI, tools: [] })),
    edges,
  });
  const invoke = async (agentId: string, name: string) => {
    const tools: StructuredTool[] = [];
    for (const tool of graph.agentContexts.get(agentId)?.graphTools ?? []) {
      if (tool instanceof StructuredTool) tools.push(tool);
    }
    const node = new ToolNode({ tools, agentId, hookRegistry: hooks });
    return node.invoke(
      {
        messages: [
          new AIMessage({
            content: '',
            tool_calls: [{ id: 'transfer', name, args: {} }],
          }),
        ],
      },
      { configurable: { run_id: 'scheduled', thread_id: 'thread' } },
    );
  };
  const check = (agentId: string, name: string) =>
    policy.hook(
      {
        hook_event_name: 'PreToolUse',
        runId: 'scheduled',
        executingAgentId: agentId,
        toolName: name,
        toolUseId: 'transfer',
        toolInput: {},
      },
      new AbortController().signal,
    );
  return { invoke, check, policy, graph };
}

it('executes the exact SDK handoff tool and keeps unrelated transfer names denied', async () => {
  const f = await setup([{ from: 'root', to: 'child', edgeType: 'handoff' }]);
  const result = await f.invoke('root', `${Constants.LC_TRANSFER_TO_}child`);
  expect(JSON.stringify(result)).toContain('Successfully transferred to child');
  expect(JSON.stringify(result)).not.toContain('Blocked:');
  for (const [agent, name] of [
    ['root', `${Constants.LC_TRANSFER_TO_}peer`],
    ['child', `${Constants.LC_TRANSFER_TO_}root`],
    ['root', 'conditional_transfer'],
    ['root', `${Constants.LC_TRANSFER_TO_}forged`],
  ])
    expect(await f.check(agent, name)).toMatchObject({ decision: 'deny' });
});

it('executes a conditional SDK transfer without permitting unlisted destinations', async () => {
  const f = await setup([{ from: 'root', to: ['child', 'peer'], condition: () => 'child' }]);
  const result = await f.invoke('root', 'conditional_transfer');
  expect(JSON.stringify(result)).toContain('Conditionally transferred to child');
  expect(JSON.stringify(result)).not.toContain('Blocked:');
  expect(await f.check('child', 'conditional_transfer')).toMatchObject({ decision: 'deny' });
  expect(await f.check('root', `${Constants.LC_TRANSFER_TO_}peer`)).toMatchObject({
    decision: 'deny',
  });
  const invalid = await setup([{ from: 'root', to: 'child', condition: () => 'peer' }]);
  expect(JSON.stringify(await invalid.invoke('root', 'conditional_transfer'))).toContain(
    'undeclared destination',
  );
});

it('does not invent transfer controls for direct or orphaned edges', async () => {
  const f = await setup([{ from: 'root', to: ['child', 'peer'] }]);
  expect(f.graph.agentContexts.get('root')?.graphTools).toBeUndefined();
  expect(await f.check('root', `${Constants.LC_TRANSFER_TO_}child`)).toMatchObject({
    decision: 'deny',
  });
  const fixture = await executionFixture();
  const orphan = createScheduledMCPRunPolicy(
    fixture.execution,
    [{ id: 'root' }],
    [{ from: 'root', to: 'missing', edgeType: 'handoff' }],
  );
  expect(
    await orphan.hook(
      {
        hook_event_name: 'PreToolUse',
        runId: 'run',
        executingAgentId: 'root',
        toolName: `${Constants.LC_TRANSFER_TO_}missing`,
        toolInput: {},
        toolUseId: 'call',
      },
      new AbortController().signal,
    ),
  ).toMatchObject({ decision: 'deny' });
});

it('registers nested graph controls only from their resolved member edges', async () => {
  const f = await setup([]);
  f.policy.registerAgent({
    id: 'lazy',
    subagentGraphConfigs: [
      {
        definition: { edges: [{ from: 'child', to: 'peer', edgeType: 'handoff' }] },
        memberConfigs: [{ id: 'child' }, { id: 'peer' }],
      },
    ],
  });
  expect(await f.check('child', `${Constants.LC_TRANSFER_TO_}peer`)).toEqual({});
  expect(await f.check('root', `${Constants.LC_TRANSFER_TO_}peer`)).toMatchObject({
    decision: 'deny',
  });
});

it('denies safely when an unenrolled run cannot recheck enrollment', async () => {
  const f = await executionFixture();
  f.snapshot.enrollment = null;
  const legacy = (await f.factory.resolve(f.identity, 'invoke'))!;
  const record = jest.fn(async () => true);
  const policy = createScheduledMCPRunPolicy(legacy, [{ id: 'root' }], [], record);
  jest.mocked(f.storage.readScheduleMCPConsent).mockRejectedValueOnce(new Error('PRIVATE outage'));
  const registry = new HookRegistry();
  registry.register('PreToolUse', { hooks: [policy.hook, policy.receipt], internal: true });
  const input = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'legacy',
    executingAgentId: 'root',
    toolName: 'write',
    toolInput: {},
    toolUseId: 'call',
  };
  const result = await executeHooks({ registry, input });
  expect(result).toMatchObject({ decision: 'deny' });
  expect(result.reason).toContain('dependency_unavailable');
  expect(result.reason).not.toContain('PRIVATE');
  expect(record).toHaveBeenCalledTimes(1);
});

it('denies only host-marked ordinary background MCP work, while retaining foreground reads', async () => {
  const f = await executionFixture();
  const policy = createScheduledMCPRunPolicy(f.execution, [
    {
      id: 'root',
      backgroundToolNames: ['query_mcp_warehouse'],
      toolRegistry: new Map([
        [
          'query_mcp_warehouse',
          { name: 'query_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' },
        ],
      ]),
    },
  ]);
  const input = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'scheduled',
    executingAgentId: 'root',
    toolName: 'query_mcp_warehouse',
    toolInput: { run_in_background: true },
    toolUseId: 'read',
  };
  expect(await policy.hook(input, new AbortController().signal)).toMatchObject({
    decision: 'deny',
  });
  expect(
    await policy.hook(
      { ...input, toolInput: { run_in_background: false } },
      new AbortController().signal,
    ),
  ).toEqual({});
});
