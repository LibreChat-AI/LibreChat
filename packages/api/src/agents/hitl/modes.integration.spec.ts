import { z } from 'zod';
import mongoose from 'mongoose';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@librechat/agents/langchain/tools';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Run, Providers, FakeChatModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { ToolApprovalGrantStorage, Agents } from 'librechat-data-provider';
import type { AgentApprovalSource, ReviewedToolApprovals } from './modes';
import {
  createAgentToolApprovalSession,
  bindRunToolApprovalSession,
  captureRunToolApprovalBindings,
} from './modes';
import { buildHITLRunWiring, buildToolApprovalExecutionConfig } from './runtime';
import { bindToolApproval } from '~/tools/approval';

let mongo: MongoMemoryServer;
let storage: ToolApprovalGrantStorage;
let executions = 0;
const name = 'echo_mcp_fixture';
const guarded = tool(
  async ({ text }) => {
    executions++;
    return text;
  },
  { name, description: 'Scripted SDK integration tool', schema: z.object({ text: z.string() }) },
);

beforeAll(async () => {
  mongo = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
  await mongoose.connect(mongo.getUri());
  createModels(mongoose);
  await mongoose.models.ToolApprovalGrant.syncIndexes();
  storage = createMethods(mongoose);
}, 60000);
afterAll(async () => {
  await mongoose.disconnect();
  await mongo?.stop();
});
beforeEach(async () => {
  executions = 0;
  await mongoose.models.ToolApprovalGrant.deleteMany({});
});

async function build({
  source,
  chat,
  saver,
  reviewed,
  callId,
}: {
  source: AgentApprovalSource;
  chat: string;
  saver: MemorySaver;
  reviewed?: ReviewedToolApprovals;
  callId?: string;
}) {
  const session = createAgentToolApprovalSession({
    agents: [source],
    storage,
    scope: { userId: 'sdk-user', conversationId: chat },
    reviewed,
  });
  const wiring = buildHITLRunWiring(
    { enabled: true, mode: 'bypass' },
    {},
    [],
    [{ hook: session.hook }],
  )!;
  wiring.hooks.register('PostToolUse', { hooks: [session.rememberHook] });
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
          agentId: source.id,
          provider: Providers.OPENAI,
          endpoint: Providers.OPENAI,
          clientOptions: llmConfig,
          instructions: 'Use the scripted tool.',
          tools: [guarded],
        },
      ],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {},
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    humanInTheLoop: wiring.humanInTheLoop,
    hooks: wiring.hooks,
  });
  run.Graph.overrideModel = new FakeChatModel({
    responses: ['Done.'],
    ...(callId
      ? { toolCalls: [{ name, args: { text: 'hello' }, id: callId, type: 'tool_call' }] }
      : {}),
  });
  bindRunToolApprovalSession(run, session);
  return run;
}
const config = (chat: string) => ({
  configurable: { thread_id: chat, ...buildToolApprovalExecutionConfig(`response-${chat}`, 1) },
  streamMode: 'values' as const,
  version: 'v2' as const,
});

test.each(['chat', 'always'] as const)(
  '%s mode learns only after a real reviewed execution and scopes a rebuilt chat',
  async (mode) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: { approval_mode: mode, approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05' },
      },
      toolDefinitions: [
        bindToolApproval(
          { name, serverName: 'fixture', parameters: { type: 'object' } },
          'source-one',
        ),
      ],
    };
    const saver = new MemorySaver();
    const first = await build({ source, chat: 'chat-a', saver, callId: 'first-call' });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('chat-a'));
    const interrupt = first.getInterrupt();
    expect(interrupt?.payload.type).toBe('tool_approval');
    expect(executions).toBe(0);
    const bindings = captureRunToolApprovalBindings(
      first,
      interrupt!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    expect(bindings['first-call']?.agentId).toBe(source.id);
    const resumed = await build({
      source,
      chat: 'chat-a',
      saver,
      reviewed: { bindings, decisions: [{ tool_call_id: 'first-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'first-call': { type: 'approve' } }, config('chat-a'));
    expect(executions).toBe(1);
    expect(
      await mongoose.models.ToolApprovalGrant.countDocuments({
        binding: bindings['first-call'].binding,
      }),
    ).toBe(1);
    const next = await build({
      source,
      chat: 'chat-b',
      saver: new MemorySaver(),
      callId: 'next-call',
    });
    await next.processStream({ messages: [new HumanMessage('run')] }, config('chat-b'));
    if (mode === 'chat') {
      expect(next.getInterrupt()?.payload.type).toBe('tool_approval');
      expect(executions).toBe(1);
    } else {
      expect(next.getInterrupt()).toBeUndefined();
      expect(executions).toBe(2);
    }
  },
  30000,
);
