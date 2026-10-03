import { z } from 'zod';
import mongoose from 'mongoose';
import { MemorySaver } from '@langchain/langgraph';
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
  buildMCPToolApprovalBinding,
  describeRememberedToolApprovals,
} from './modes';
import { buildHITLRunWiring, buildToolApprovalExecutionConfig } from './runtime';
import { bindToolApproval, bindToolApprovalIdentity } from '~/tools/approval';
import { createToolExecuteHandler } from '../handlers';
import { createMCPStructuredTool } from '~/mcp/tools';
import { markMCPToolResultError } from '~/mcp/status';
import { formatToolContent } from '~/mcp/parsers';

let mongo: MongoMemoryServer;
let storage: ToolApprovalGrantStorage;
let executions = 0;
let protocolError = false;
const name = 'echo_mcp_fixture';
const fixtureSchema = z.object({ text: z.string() });
function createProbe(binding: string | null = 'source-one', upstreamName = 'echo') {
  const probe = Object.assign(
    createMCPStructuredTool(
      async (input) => {
        const { text } = z.object({ text: z.string() }).parse(input);
        executions++;
        const raw = { content: [{ type: 'text' as const, text }], isError: protocolError };
        return markMCPToolResultError(formatToolContent(raw, 'openai'), raw.isError);
      },
      {
        name,
        description: 'Scripted SDK integration tool',
        schema: fixtureSchema,
        responseFormat: 'content_and_artifact',
      },
    ),
    { schema: fixtureSchema },
  );
  return bindToolApprovalIdentity(bindToolApproval(probe, binding ?? undefined), upstreamName, {
    type: 'object',
  });
}
const guarded = createProbe();
function definition() {
  return bindToolApprovalIdentity(
    bindToolApproval({ name, serverName: 'fixture', parameters: { type: 'object' } }, 'source-one'),
    'echo',
    { type: 'object' },
  );
}

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
  protocolError = false;
  await mongoose.models.ToolApprovalGrant.deleteMany({});
});

async function build({
  source,
  chat,
  saver,
  reviewed,
  callId,
  eventDriven = false,
  executionTool = guarded,
  beforeLoad,
}: {
  source: AgentApprovalSource;
  chat: string;
  saver: MemorySaver;
  reviewed?: ReviewedToolApprovals;
  callId?: string;
  eventDriven?: boolean;
  executionTool?: typeof guarded;
  beforeLoad?: () => void | Promise<void>;
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
          tools: eventDriven ? [] : [executionTool],
          toolDefinitions: eventDriven
            ? source.toolDefinitions?.map((definition) => ({
                name: definition.name,
                description: definition.description,
                parameters: {
                  type: 'object' as const,
                  properties: { text: { type: 'string' as const } },
                },
              }))
            : undefined,
        },
      ],
      compileOptions: { checkpointer: saver },
    },
    returnContent: true,
    customHandlers: {
      on_tool_execute: createToolExecuteHandler({
        loadTools: async () => {
          await beforeLoad?.();
          return { loadedTools: [executionTool] };
        },
      }),
    },
    tokenCounter: (text) => String(text ?? '').length,
    indexTokenCountMap: {},
    humanInTheLoop: wiring.humanInTheLoop,
    hooks: wiring.hooks,
  });
  if (!run.Graph) throw new Error('The test run did not initialize its graph.');
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

test.each([
  ['chat', false],
  ['always', false],
  ['chat', true],
  ['always', true],
] as const)(
  '%s mode learns only after a real reviewed execution (event-driven: %s)',
  async (mode, eventDriven) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: { approval_mode: mode, approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05' },
      },
      toolDefinitions: [definition()],
    };
    const saver = new MemorySaver();
    const first = await build({ source, chat: 'chat-a', saver, eventDriven, callId: 'first-call' });
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
      eventDriven,
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
      eventDriven,
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

test.each([false, true])(
  'a protocol-valid MCP error never teaches approval (event-driven: %s)',
  async (eventDriven) => {
    protocolError = true;
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'always',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [definition()],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'error-chat',
      saver,
      eventDriven,
      callId: 'failed-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('error-chat'));
    const interrupt = first.getInterrupt()!;
    const bindings = captureRunToolApprovalBindings(
      first,
      interrupt.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const resumed = await build({
      source,
      chat: 'error-chat',
      saver,
      eventDriven,
      reviewed: { bindings, decisions: [{ tool_call_id: 'failed-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'failed-call': { type: 'approve' } }, config('error-chat'));
    expect(executions).toBe(1);
    const toolMessages = (resumed.getRunMessages() ?? []).filter(
      (message) => message._getType() === 'tool',
    );
    expect(JSON.stringify(toolMessages.map((message) => message.content))).toContain('hello');
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
    const next = await build({
      source,
      chat: 'retry-chat',
      saver: new MemorySaver(),
      eventDriven,
      callId: 'retry-call',
    });
    await next.processStream({ messages: [new HumanMessage('retry')] }, config('retry-chat'));
    expect(next.getInterrupt()?.payload.type).toBe('tool_approval');
    expect(executions).toBe(1);
  },
  30000,
);

test.each([false, true])(
  'a manually approved call cannot execute against a replaced target (event-driven: %s)',
  async (eventDriven) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'always',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [definition()],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'rebind-chat',
      saver,
      eventDriven,
      callId: 'first-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('rebind-chat'));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const resumed = await build({
      source,
      chat: 'rebind-chat',
      saver,
      eventDriven,
      executionTool: createProbe('source-two'),
      reviewed: { bindings, decisions: [{ tool_call_id: 'first-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'first-call': { type: 'approve' } }, config('rebind-chat'));
    expect(executions).toBe(0);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

test.each(['authority', 'upstream', 'revocation'] as const)(
  'automatic consent rejects a changed %s after initialization and before event dispatch',
  async (change) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'always',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [definition()],
    };
    const seed = await build({
      source,
      chat: 'seed-chat',
      saver: new MemorySaver(),
      eventDriven: true,
      callId: 'seed-call',
    });
    await seed.processStream({ messages: [new HumanMessage('run')] }, config('seed-chat'));
    const bindings = captureRunToolApprovalBindings(
      seed,
      seed.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    await storage.rememberToolApprovalGrants({ userId: 'sdk-user', conversationId: 'seed-chat' }, [
      bindings['seed-call'],
    ]);
    let reset: Promise<void> | undefined;
    let target = guarded;
    if (change === 'authority') target = createProbe('source-two');
    if (change === 'upstream') target = createProbe('source-one', 'fixture_echo');
    const run = await build({
      source,
      chat: 'auto-chat',
      saver: new MemorySaver(),
      eventDriven: true,
      callId: 'auto-call',
      executionTool: target,
      beforeLoad:
        change === 'revocation'
          ? () => {
              reset = storage.resetToolApprovalGrants('sdk-user', source.id, name);
              return reset;
            }
          : undefined,
    });
    await run.processStream({ messages: [new HumanMessage('run')] }, config('auto-chat'));
    await reset;
    expect(executions).toBe(0);
  },
);

test.each([false, true])(
  'editing a reviewed call can execute once but never teaches approval (event-driven: %s)',
  async (eventDriven) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'always',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [definition()],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'edit-chat',
      saver,
      eventDriven,
      callId: 'edit-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('edit-chat'));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const resumed = await build({
      source,
      chat: 'edit-chat',
      saver,
      eventDriven,
      reviewed: {
        bindings,
        decisions: [
          { tool_call_id: 'edit-call', decision: 'edit', editedArguments: { text: 'edited' } },
        ],
      },
    });
    await resumed.resume(
      { 'edit-call': { type: 'edit', updatedInput: { text: 'edited' } } },
      config('edit-chat'),
    );
    expect(executions).toBe(1);
    expect(
      JSON.stringify((resumed.getRunMessages() ?? []).map((message) => message.content)),
    ).toContain('edited');
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

test.each([false, true])(
  'always-ask still permits an exact manually approved call (event-driven: %s)',
  async (eventDriven) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: { [name]: { approval_mode: 'ask' } },
      toolDefinitions: [definition()],
    };
    const saver = new MemorySaver();
    const first = await build({ source, chat: 'ask-chat', saver, eventDriven, callId: 'ask-call' });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('ask-chat'));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const resumed = await build({
      source,
      chat: 'ask-chat',
      saver,
      eventDriven,
      reviewed: { bindings, decisions: [{ tool_call_id: 'ask-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'ask-call': { type: 'approve' } }, config('ask-chat'));
    expect(executions).toBe(1);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

test.each([
  ['chat', false, 'approve'],
  ['chat', true, 'approve'],
  ['always', false, 'approve'],
  ['always', true, 'approve'],
  ['chat', false, 'edit'],
  ['chat', true, 'edit'],
  ['always', false, 'edit'],
  ['always', true, 'edit'],
] as const)(
  'templated %s connections permit one reviewed call (event-driven: %s, decision: %s)',
  async (mode, eventDriven, decision) => {
    const connection = {
      type: 'streamable-http' as const,
      source: 'yaml' as const,
      url: 'https://mcp.example.test/mcp',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    expect(buildMCPToolApprovalBinding('fixture', connection)).toBeUndefined();
    const templatedDefinition = bindToolApprovalIdentity(
      { name, serverName: 'fixture', parameters: { type: 'object' } },
      'echo',
      { type: 'object' },
    );
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: { approval_mode: mode, approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05' },
      },
      toolDefinitions: [templatedDefinition],
    };
    const saver = new MemorySaver();
    const executionTool = createProbe(null);
    const first = await build({
      source,
      chat: 'template-chat',
      saver,
      eventDriven,
      executionTool,
      callId: 'template-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('template-chat'));
    const payload = first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload;
    const bindings = captureRunToolApprovalBindings(first, payload)!;
    const described = describeRememberedToolApprovals(
      payload,
      bindings,
      first,
    ) as Agents.ToolApprovalInterruptPayload;
    expect(described.review_configs[0].remember_scope).toBeUndefined();
    expect(described.review_configs[0].remember_unavailable).toBe('connection');
    const resumed = await build({
      source,
      chat: 'template-chat',
      saver,
      eventDriven,
      executionTool,
      reviewed: {
        bindings,
        decisions: [
          {
            tool_call_id: 'template-call',
            decision,
            ...(decision === 'edit' && { editedArguments: { text: 'edited-template' } }),
          },
        ],
      },
    });
    const answer =
      decision === 'edit'
        ? { type: 'edit' as const, updatedInput: { text: 'edited-template' } }
        : { type: 'approve' as const };
    await resumed.resume({ 'template-call': answer }, config('template-chat'));
    expect(executions).toBe(1);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
    const again = await build({
      source,
      chat: 'template-chat',
      saver: new MemorySaver(),
      eventDriven,
      executionTool,
      callId: 'next-template-call',
    });
    await again.processStream(
      { messages: [new HumanMessage('run again')] },
      config('template-chat'),
    );
    expect(again.getInterrupt()?.payload.type).toBe('tool_approval');
    expect(executions).toBe(1);
  },
);
