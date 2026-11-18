import { z } from 'zod';
import { MemorySaver } from '@langchain/langgraph';
import { SCHEDULE_APPROVAL_REASON } from 'librechat-data-provider';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { Run, Providers, HookRegistry, FakeChatModel } from '@librechat/agents';
import type { TToolApprovalPolicy } from 'librechat-data-provider';
import type { ToolApprovalDecisionMap } from '@librechat/agents';
import type { ScheduleMCPExecution } from './execution';
import { createAgentToolApprovalSession, bindRunToolApprovalSession } from '~/agents/hitl/modes';
import { buildHITLRunWiring, buildToolApprovalExecutionConfig } from '~/agents/hitl/runtime';
import { getToolApprovalTransportCallId } from '~/tools/approval';
import { resolveToolApprovalPolicy } from '~/agents/hitl/policy';
import { executionFixture, readTool } from './execution.helper';
import { createToolExecuteHandler } from '~/agents/handlers';
import { collectApprovedToolCalls } from './execution';
import { createMCPStructuredTool } from '~/mcp/tools';
import { createScheduledMCPRunPolicy } from './run';
import { formatToolContent } from '~/mcp/parsers';

/**
 * A real SDK run with a scripted model, the real approval session, the real schedule hook and
 * the real consent service. The tool body stands in for `MCPManager.callTool`: it asks the
 * schedule's authority with the call id the approval layer holds, then counts as dispatched.
 */
const name = 'query_mcp_warehouse';
const schema = z.object({ text: z.string() });
const chat = 'scheduled-chat';
const config = {
  configurable: {
    thread_id: chat,
    user_id: 'owner',
    ...buildToolApprovalExecutionConfig(`response-${chat}`, 1),
  },
  streamMode: 'values' as const,
  version: 'v2' as const,
};

async function scenario(choice: Parameters<typeof executionFixture>[3] = { ask: ['query'] }) {
  const fixture = await executionFixture('invoke', readTool, undefined, choice);
  const saver = new MemorySaver();
  const dispatched: string[] = [];
  const refusals: unknown[] = [];

  async function build({
    execution = fixture.execution,
    endpoint,
    scheduleHook = true,
    callId = 'call-1',
  }: {
    execution?: ScheduleMCPExecution;
    endpoint?: TToolApprovalPolicy;
    /** False stands for a hook the SDK discarded: it timed out, so it said nothing. */
    scheduleHook?: boolean;
    callId?: string;
  } = {}) {
    const tool = Object.assign(
      createMCPStructuredTool(
        async (input) => {
          const { text } = schema.parse(input);
          try {
            await execution.bind('root', 'query').authorize({
              user: fixture.user,
              serverName: 'warehouse',
              serverConfig: fixture.config,
              toolName: 'query',
              loadTools: async () => ({ tools: [readTool], complete: true }),
              toolCallId: getToolApprovalTransportCallId(),
            });
          } catch (error) {
            refusals.push(error);
            throw error;
          }
          dispatched.push(text);
          return formatToolContent({ content: [{ type: 'text' as const, text }] }, 'openai');
        },
        {
          name,
          description: 'Scripted scheduled MCP tool',
          schema,
          responseFormat: 'content_and_artifact',
        },
      ),
      { schema },
    );
    const agent = {
      id: 'root',
      toolDefinitions: [{ name, toolType: 'mcp', serverName: 'warehouse' }],
    };
    const session = createAgentToolApprovalSession({ agents: [{ id: 'root' }] });
    // As `createRun` does: the schedule's grant may turn approval on for this run.
    const wiring = buildHITLRunWiring(
      resolveToolApprovalPolicy({ endpoint, ownerApproval: execution.mayAsk }),
      {},
      [],
      [{ hook: session.hook }],
    );
    const policy = createScheduledMCPRunPolicy(execution, [agent]);
    // Also as `createRun` does: with no approval wiring the schedule hook gets its own registry.
    const hooks = wiring?.hooks ?? new HookRegistry();
    if (scheduleHook) hooks.register('PreToolUse', { hooks: [policy.hook, policy.receipt] });
    const llmConfig = {
      provider: Providers.OPENAI,
      model: 'gpt-4o-mini',
      apiKey: 'test-placeholder',
      streaming: true,
      streamUsage: false,
    };
    const run = await Run.create({
      runId: `run-${chat}`,
      graphConfig: {
        type: 'standard',
        llmConfig,
        agents: [
          {
            agentId: 'root',
            provider: Providers.OPENAI,
            endpoint: Providers.OPENAI,
            clientOptions: llmConfig,
            instructions: 'Use the scripted tool.',
            tools: [tool],
          },
        ],
        compileOptions: { checkpointer: saver },
      },
      returnContent: true,
      customHandlers: {
        on_tool_execute: createToolExecuteHandler({
          loadTools: async () => ({ loadedTools: [tool] }),
        }),
      },
      tokenCounter: (text) => String(text ?? '').length,
      indexTokenCountMap: {},
      ...(wiring && { humanInTheLoop: wiring.humanInTheLoop }),
      hooks,
    });
    if (!run.Graph) throw new Error('The test run did not initialize its graph.');
    run.Graph.overrideModel = new FakeChatModel({
      responses: ['Done.'],
      toolCalls: [{ name, args: { text: 'hello' }, id: callId, type: 'tool_call' }],
    });
    if (wiring) bindRunToolApprovalSession(run, session);
    return run;
  }

  /** What the resume controller does with the owner's validated decisions. */
  const resumedExecution = async (decisions: ToolApprovalDecisionMap) =>
    (await fixture.factory.resolve(fixture.identity, 'resume', {
      approvedToolCalls: collectApprovedToolCalls(decisions),
    }))!;

  return { fixture, build, resumedExecution, dispatched, refusals };
}
const start = { messages: [new HumanMessage('run')] };

it('pauses a scheduled run before a tool its owner approves call by call', async () => {
  const s = await scenario();
  const run = await s.build();
  await run.processStream(start, config);
  const interrupt = run.getInterrupt();
  expect(interrupt?.payload).toMatchObject({
    type: 'tool_approval',
    action_requests: [{ tool_call_id: 'call-1', name, description: SCHEDULE_APPROVAL_REASON }],
  });
  expect(s.dispatched).toEqual([]);
  expect(s.refusals).toEqual([]);
});

it('runs the call once the owner approves it on resume', async () => {
  const s = await scenario();
  await (await s.build()).processStream(start, config);
  const decisions: ToolApprovalDecisionMap = { 'call-1': { type: 'approve' } };
  const resumed = await s.build({ execution: await s.resumedExecution(decisions) });
  await resumed.resume(decisions, config);
  expect(resumed.getInterrupt()).toBeUndefined();
  expect(s.dispatched).toEqual(['hello']);
  expect(s.refusals).toEqual([]);
});

it('does not run the call the owner rejects', async () => {
  const s = await scenario();
  await (await s.build()).processStream(start, config);
  const decisions: ToolApprovalDecisionMap = { 'call-1': { type: 'reject', reason: 'not today' } };
  const resumed = await s.build({ execution: await s.resumedExecution(decisions) });
  await resumed.resume(decisions, config);
  expect(s.dispatched).toEqual([]);
});

it('refuses the call at the tool when the hook that should have paused the run said nothing', async () => {
  const s = await scenario();
  const run = await s.build({ scheduleHook: false });
  await run.processStream(start, config);
  expect(run.getInterrupt()).toBeUndefined();
  expect(s.dispatched).toEqual([]);
  expect(s.refusals).toHaveLength(1);
  expect(s.refusals[0]).toMatchObject({ failure: { reason: 'approval_required' } });
});

it('refuses a resumed call the owner approved under a different call id', async () => {
  const s = await scenario();
  await (await s.build()).processStream(start, config);
  const resumed = await s.build({
    execution: await s.resumedExecution({ 'call-9': { type: 'approve' } }),
  });
  await resumed.resume({ 'call-1': { type: 'approve' } }, config);
  expect(s.dispatched).toEqual([]);
  expect(s.refusals[0]).toMatchObject({ failure: { reason: 'approval_required' } });
});

it('blocks the tool without pausing where the administrator turned approval off', async () => {
  const s = await scenario();
  const run = await s.build({ endpoint: { enabled: false } });
  await run.processStream(start, config);
  expect(run.getInterrupt()).toBeUndefined();
  // The SDK blocks an `ask` nobody can answer before the tool is reached.
  expect(s.dispatched).toEqual([]);
  expect(s.refusals).toEqual([]);
});

it('still refuses at the tool there if the hook said nothing', async () => {
  const s = await scenario();
  const run = await s.build({ endpoint: { enabled: false }, scheduleHook: false });
  await run.processStream(start, config);
  expect(s.dispatched).toEqual([]);
  expect(s.refusals[0]).toMatchObject({ failure: { reason: 'approval_required' } });
});

it('neither pauses nor refuses a tool the owner simply allowed', async () => {
  const s = await scenario({});
  const run = await s.build();
  await run.processStream(start, config);
  expect(run.getInterrupt()).toBeUndefined();
  expect(s.dispatched).toEqual(['hello']);
});
