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
import { createScheduledMCPRunPolicy, SCHEDULE_TOOL_NOT_ALLOWED } from './run';
import { executionFixture, readTool } from './execution.helper';
import { createScheduleMCPExecution } from './execution';

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

it('lets a granted tool run in the background, and a held schedule start nothing there', async () => {
  const agent = {
    id: 'root',
    backgroundToolNames: ['query_mcp_warehouse'],
    toolRegistry: new Map([
      [
        'query_mcp_warehouse',
        { name: 'query_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' },
      ],
    ]),
  };
  const input = (toolName: string, background: boolean) => ({
    hook_event_name: 'PreToolUse' as const,
    runId: 'scheduled',
    executingAgentId: 'root',
    toolName,
    toolInput: { run_in_background: background },
    toolUseId: 'read',
  });
  const signal = new AbortController().signal;
  // Under a grant: whatever the tool finishes with is picked up in a turn that resolves the
  // grant again, so the background is no different from the foreground.
  const f = await executionFixture();
  const granted = createScheduledMCPRunPolicy(f.execution, [agent]);
  for (const background of [true, false]) {
    expect(await granted.hook(input('query_mcp_warehouse', background), signal)).toEqual({});
    expect(await granted.hook(input(Constants.SUBAGENT, background), signal)).toEqual({});
  }
  // A tool the owner did not allow is refused there as anywhere.
  expect(await granted.hook(input('web_search', true), signal)).toMatchObject({
    decision: 'deny',
  });

  // A grant the completion turn could not find again keeps its run in the foreground.
  const bound = await executionFixture('invoke', readTool, undefined, { detaches: false });
  const foreground = createScheduledMCPRunPolicy(bound.execution, [agent]);
  expect(await foreground.hook(input('query_mcp_warehouse', true), signal)).toMatchObject({
    decision: 'deny',
  });
  expect(await foreground.hook(input('query_mcp_warehouse', false), signal)).toEqual({});

  // No grant where one is required: nothing may be started in the background.
  const unenrolled = (required: boolean) => {
    f.snapshot.enrollment = null;
    return createScheduleMCPExecution({
      storage: f.storage,
      loadAuthorization: f.loadAuthorization,
      requiresGrant: async () => required,
      coversTools: true,
    }).resolve(f.identity, 'invoke');
  };
  const held = createScheduledMCPRunPolicy((await unenrolled(true))!, [agent]);
  for (const name of ['query_mcp_warehouse', Constants.SUBAGENT])
    expect(await held.hook(input(name, true), signal)).toMatchObject({ decision: 'deny' });
  // A schedule nobody has to authorize runs as it always did.
  const exempt = createScheduledMCPRunPolicy((await unenrolled(false))!, [agent]);
  expect(await exempt.hook(input('query_mcp_warehouse', true), signal)).toEqual({});
});

it('lets a run ask what became of the work it sent off, under a grant that lists its tools', async () => {
  const f = await executionFixture();
  const policy = createScheduledMCPRunPolicy(f.execution, [{ id: 'root' }]);
  const poll = {
    hook_event_name: 'PreToolUse' as const,
    runId: 'scheduled',
    executingAgentId: 'root',
    toolName: 'check_background_task',
    toolInput: { task_id: 'task-1' },
    toolUseId: 'poll',
  };
  // The host adds the poll to the run. No owner selects it, so no grant could list it.
  expect(await policy.hook(poll, new AbortController().signal)).toEqual({});
  expect(
    await policy.hook({ ...poll, toolName: 'web_search' }, new AbortController().signal),
  ).toMatchObject({ decision: 'deny' });
});

it('checks a completion turn rooted at the agent that started the work by what the grant holds for it', async () => {
  const f = await executionFixture();
  // The root handed off to the child, which sent a tool to the background. The turn that
  // picks its result up is the child's: its graph does not contain the schedule's root.
  const child = {
    id: 'child',
    toolDefinitions: [{ name: 'query_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' }],
  };
  const input = (toolName: string, agentId = 'child') => ({
    hook_event_name: 'PreToolUse' as const,
    runId: 'completion',
    executingAgentId: agentId,
    toolName,
    toolInput: {},
    toolUseId: 'call',
  });
  const signal = new AbortController().signal;
  const completion = (await f.factory.resolve(f.identity, 'invoke', { completion: true }))!;
  expect(completion).toMatchObject({ enrolled: true, completion: true });
  const policy = createScheduledMCPRunPolicy(completion, [child]);
  expect(await policy.hook(input('query_mcp_warehouse'), signal)).toEqual({});
  // Still only what the grant holds for that agent, and only for agents of this turn.
  expect(await policy.hook(input('web_search'), signal)).toMatchObject({ decision: 'deny' });
  expect(await policy.hook(input('query_mcp_warehouse', 'stranger'), signal)).toMatchObject({
    decision: 'deny',
  });
  // An ordinary run without its root is not the schedule's graph at all.
  const ordinary = createScheduledMCPRunPolicy(f.execution, [child]);
  expect(await ordinary.hook(input('query_mcp_warehouse'), signal)).toMatchObject({
    decision: 'deny',
  });
});

describe('a tool the owner left out of the grant', () => {
  const tool = (name: string) => ({
    name: `${name}_mcp_warehouse`,
    toolType: 'mcp',
    serverName: 'warehouse',
  });
  /** The agents select `query` and `export`; the owner allowed `query`. */
  async function partial() {
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const record = jest.fn(async () => true);
    const policy = createScheduledMCPRunPolicy(
      fixture.execution,
      [{ id: 'root', toolDefinitions: [tool('query'), tool('export')] }],
      [],
      record,
    );
    const input = (toolName: string, executingAgentId = 'root') =>
      ({ toolName, toolInput: {}, executingAgentId }) as Parameters<typeof policy.hook>[0];
    const signal = new AbortController().signal;
    return { fixture, policy, record, input, signal };
  }

  it('is turned away with a plain message, and nothing is recorded against the run', async () => {
    const { policy, record, input, signal } = await partial();
    const call = input('export_mcp_warehouse');
    expect(await policy.hook(call, signal)).toEqual({
      decision: 'deny',
      reason: SCHEDULE_TOOL_NOT_ALLOWED,
    });
    await policy.receipt(call, signal);
    expect(record).not.toHaveBeenCalled();
    expect(await policy.hook(input('query_mcp_warehouse'), signal)).toEqual({});
  });

  it('is turned away for an agent that joins the run later, by its registry key', async () => {
    const { policy, input, signal } = await partial();
    policy.registerAgent({
      id: 'child',
      toolRegistry: new Map([
        ['export_mcp_warehouse', { ...tool('export'), mcpRawServerName: 'warehouse' }],
        ['query_mcp_warehouse', { ...tool('query'), mcpRawServerName: 'warehouse' }],
      ]),
    });
    expect(await policy.hook(input('export_mcp_warehouse', 'child'), signal)).toMatchObject({
      decision: 'deny',
      reason: SCHEDULE_TOOL_NOT_ALLOWED,
    });
    expect(await policy.hook(input('query_mcp_warehouse', 'child'), signal)).toEqual({});
  });

  it('still records a tool that is not an MCP tool at all as a refusal', async () => {
    const { policy, record, input, signal } = await partial();
    const call = input('execute_code');
    expect(await policy.hook(call, signal)).toMatchObject({ decision: 'deny' });
    await policy.receipt(call, signal);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('leaves a tool whose key does not name its server to the check at the call', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const policy = createScheduledMCPRunPolicy(fixture.execution, [
      {
        id: 'root',
        toolDefinitions: [{ name: 'export', toolType: 'mcp', serverName: 'warehouse' }],
      },
    ]);
    expect(
      await policy.hook(
        { toolName: 'export', toolInput: {}, executingAgentId: 'root' } as Parameters<
          typeof policy.hook
        >[0],
        new AbortController().signal,
      ),
    ).toEqual({});
  });
});
