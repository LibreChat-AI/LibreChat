import { z } from 'zod';
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { MemorySaver } from '@langchain/langgraph';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { Run, Providers, FakeChatModel } from '@librechat/agents';
import { HumanMessage } from '@librechat/agents/langchain/messages';
import { createModels, createMethods } from '@librechat/data-schemas';
import type { ToolApprovalGrantStorage, Agents } from 'librechat-data-provider';
import type { AgentApprovalSource, ReviewedToolApprovals, AgentToolApprovalSession } from './modes';
import {
  createAgentToolApprovalSession,
  bindRunToolApprovalSession,
  captureRunToolApprovalBindings,
  buildMCPToolApprovalBinding,
  describeRememberedToolApprovals,
  resolveAgentToolGrantBinding,
} from './modes';
import { ServerConfigsCacheInMemory } from '~/mcp/registry/cache/ServerConfigsCacheInMemory';
import { buildHITLRunWiring, buildToolApprovalExecutionConfig } from './runtime';
import { bindToolApproval, bindToolApprovalIdentity } from '~/tools/approval';
import { assertToolApprovalTransportEpoch } from '~/tools/approval';
import { createResetToolApprovalController } from './controller';
import { buildMCPToolReviewAuthority } from '~/mcp/approval';
import { getMCPToolApprovalAuthKind } from '~/mcp/approval';
import { bindToolReviewAuthority } from '~/tools/approval';
import { createToolExecuteHandler } from '../handlers';
import { createMCPStructuredTool } from '~/mcp/tools';
import { markMCPToolResultError } from '~/mcp/status';
import { formatMCPServerTools } from '~/mcp/tools';
import { formatToolContent } from '~/mcp/parsers';

let mongo: MongoMemoryServer;
let storage: ToolApprovalGrantStorage;
let executions = 0;
let protocolError = false;
const name = 'echo_mcp_fixture';
const fixtureSchema = z.object({ text: z.string() });
function createProbe(
  binding: string | null = 'source-one',
  upstreamName = 'echo',
  reviewAuthority?: string,
) {
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
  return bindToolApprovalIdentity(
    bindToolReviewAuthority(bindToolApproval(probe, binding ?? undefined), reviewAuthority),
    upstreamName,
    {
      type: 'object',
    },
  );
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
  sharedSession,
  rewrite,
  sessionAgents,
  background = false,
}: {
  source: AgentApprovalSource;
  chat: string;
  saver: MemorySaver;
  reviewed?: ReviewedToolApprovals;
  callId?: string;
  eventDriven?: boolean;
  executionTool?: typeof guarded;
  beforeLoad?: () => void | Promise<void>;
  sharedSession?: AgentToolApprovalSession;
  rewrite?: { text: string; run_in_background?: boolean };
  sessionAgents?: AgentApprovalSource[];
  background?: boolean;
}) {
  const session =
    sharedSession ??
    createAgentToolApprovalSession({
      agents: sessionAgents ?? [source],
      storage,
      scope: { userId: '652000000000000000000001', conversationId: chat },
      reviewed,
    });
  const wiring = buildHITLRunWiring(
    { enabled: true, mode: 'bypass' },
    {},
    [],
    [{ hook: session.hook }, ...(rewrite ? [{ hook: () => ({ updatedInput: rewrite }) }] : [])],
  )!;
  wiring.hooks.register('PostToolUse', { hooks: [session.rememberHook] });
  wiring.hooks.register('PostToolBatch', { hooks: [session.settleBatchHook] });
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
          return {
            loadedTools: [executionTool],
            ...(background && {
              configurable: { backgroundToolNames: [name] },
            }),
          };
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
  configurable: {
    thread_id: chat,
    user_id: '652000000000000000000001',
    ...buildToolApprovalExecutionConfig(`response-${chat}`, 1),
  },
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
    await storage.rememberToolApprovalGrants(
      { userId: '652000000000000000000001', conversationId: 'seed-chat' },
      [bindings['seed-call']],
    );
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
              reset = storage.resetToolApprovalGrants('652000000000000000000001', source.id, name);
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
    const authority = buildMCPToolReviewAuthority({ serverName: 'fixture', config: connection });
    const templatedDefinition = bindToolApprovalIdentity(
      bindToolReviewAuthority(
        { name, serverName: 'fixture', parameters: { type: 'object' } },
        authority,
      ),
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
    const executionTool = createProbe(null, 'echo', authority);
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

test.each(['allow', 'chat', 'always'] as const)(
  'concurrent SDK agents can reuse call_0 under %s mode',
  async (mode) => {
    const sources: AgentApprovalSource[] = ['agent-a', 'agent-b'].map((id) => ({
      id,
      tool_options: {
        [name]: { approval_mode: mode, approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05' },
      },
      toolDefinitions: [definition()],
    }));
    const chat = 'parallel-chat';
    const scope = { userId: '652000000000000000000001', conversationId: chat };
    if (mode !== 'allow')
      await storage.rememberToolApprovalGrants(
        scope,
        sources.map((source) => resolveAgentToolGrantBinding(source, name, scope)!),
      );
    const sharedSession = createAgentToolApprovalSession({ agents: sources, storage, scope });
    const runs = await Promise.all(
      sources.map((source) =>
        build({
          source,
          chat,
          saver: new MemorySaver(),
          eventDriven: true,
          callId: 'call_0',
          sharedSession,
        }),
      ),
    );
    await Promise.all(
      runs.map((run) => run.processStream({ messages: [new HumanMessage('run')] }, config(chat))),
    );
    expect(executions).toBe(2);
    for (const run of runs) expect(run.getInterrupt()).toBeUndefined();
  },
);

const rewriteCases = (['ask', 'chat', 'always'] as const).flatMap((mode) =>
  [false, true].flatMap((eventDriven) =>
    (['approve', 'edit'] as const).flatMap((decision) =>
      [1, 2].map((ownerCount) => ({ mode, eventDriven, decision, ownerCount })),
    ),
  ),
);

test.each(rewriteCases)(
  'hook-rewritten $mode/$decision calls retain review with $ownerCount owners (event-driven: $eventDriven)',
  async ({ mode, eventDriven, decision, ownerCount }) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: mode,
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [definition()],
    };
    const sessionAgents = ownerCount === 2 ? [source, { ...source, id: 'agent-b' }] : [source];
    const rewrite = { text: 'sanitized-by-hook' };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'rewrite-chat',
      saver,
      eventDriven,
      sessionAgents,
      rewrite,
      callId: 'rewrite-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('rewrite-chat'));
    const payload = first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload;
    expect(payload.action_requests[0].arguments).toEqual(rewrite);
    const bindings = captureRunToolApprovalBindings(first, payload)!;
    expect(bindings['rewrite-call']?.agentId).toBe(source.id);
    const editedArguments = { text: 'edited-after-review' };
    const resumed = await build({
      source,
      chat: 'rewrite-chat',
      saver,
      eventDriven,
      sessionAgents,
      rewrite,
      reviewed: {
        bindings,
        decisions: [
          {
            tool_call_id: 'rewrite-call',
            decision,
            ...(decision === 'edit' && { editedArguments }),
          },
        ],
      },
    });
    const answer =
      decision === 'edit'
        ? { type: 'edit' as const, updatedInput: editedArguments }
        : { type: 'approve' as const };
    await resumed.resume({ 'rewrite-call': answer }, config('rewrite-chat'));
    expect(executions).toBe(1);
    const output = JSON.stringify(
      (resumed.getRunMessages() ?? [])
        .filter((message) => message._getType() === 'tool')
        .map((message) => message.content),
    );
    expect(output).toContain(decision === 'edit' ? editedArguments.text : rewrite.text);
    const canLearn = decision === 'approve' && mode !== 'ask';
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(canLearn ? 1 : 0);
  },
);

test.each([false, true])(
  'templated review refuses a changed declared endpoint before resume (event-driven: %s)',
  async (eventDriven) => {
    const configA = {
      type: 'streamable-http' as const,
      source: 'yaml' as const,
      url: 'https://a.example.test/mcp',
      headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
    };
    const configB = { ...configA, url: 'https://b.example.test/mcp' };
    const authorityA = buildMCPToolReviewAuthority({ serverName: 'fixture', config: configA });
    const authorityB = buildMCPToolReviewAuthority({ serverName: 'fixture', config: configB });
    const targetDefinition = (authority?: string) =>
      bindToolApprovalIdentity(
        bindToolReviewAuthority(
          { name, serverName: 'fixture', parameters: { type: 'object' } },
          authority,
        ),
        'echo',
        { type: 'object' },
      );
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'chat',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [targetDefinition(authorityA)],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'authority-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityA),
      callId: 'authority-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('authority-chat'));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const changed = { ...source, toolDefinitions: [targetDefinition(authorityB)] };
    const resumed = await build({
      source: changed,
      chat: 'authority-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityB),
      reviewed: { bindings, decisions: [{ tool_call_id: 'authority-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'authority-call': { type: 'approve' } }, config('authority-chat'));
    expect(executions).toBe(0);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

test.each(['ask', 'chat', 'always'] as const)(
  'completed agents do not shadow later %s reviews with reused call IDs',
  async (mode) => {
    const sources: AgentApprovalSource[] = [
      {
        id: 'agent-a',
        tool_options: { [name]: { approval_mode: 'allow' } },
        toolDefinitions: [definition()],
      },
      {
        id: 'agent-b',
        tool_options: {
          [name]: {
            approval_mode: mode,
            approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
          },
        },
        toolDefinitions: [definition()],
      },
    ];
    const chat = 'serial-owner-chat';
    const sharedSession = createAgentToolApprovalSession({
      agents: sources,
      storage,
      scope: { userId: '652000000000000000000001', conversationId: chat },
    });
    const a = await build({
      source: sources[0],
      chat,
      saver: new MemorySaver(),
      eventDriven: true,
      sharedSession,
      callId: 'call_0',
    });
    await a.processStream({ messages: [new HumanMessage('run A')] }, config(chat));
    expect(executions).toBe(1);
    const saver = new MemorySaver();
    const b = await build({
      source: sources[1],
      chat,
      saver,
      eventDriven: true,
      sharedSession,
      callId: 'call_0',
    });
    await b.processStream({ messages: [new HumanMessage('run B')] }, config(chat));
    const bindings = captureRunToolApprovalBindings(
      b,
      b.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    expect(bindings.call_0?.agentId).toBe('agent-b');
    const resumed = await build({
      source: sources[1],
      chat,
      saver,
      eventDriven: true,
      sessionAgents: sources,
      reviewed: { bindings, decisions: [{ tool_call_id: 'call_0', decision: 'approve' }] },
    });
    await resumed.resume({ call_0: { type: 'approve' } }, config(chat));
    expect(executions).toBe(2);
  },
);

test('hook-rewritten background launch never teaches approval before the detached failure', async () => {
  let release!: () => void;
  let markStarted!: () => void;
  let markFailed!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const failed = new Promise<void>((resolve) => {
    markFailed = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const delayed = Object.assign(
    createMCPStructuredTool(
      async () => {
        executions++;
        markStarted();
        await gate;
        markFailed();
        throw new Error('Scripted detached failure');
      },
      {
        name,
        description: 'Detached fixture',
        schema: fixtureSchema,
        responseFormat: 'content_and_artifact',
      },
    ),
    { schema: fixtureSchema },
  );
  bindToolApprovalIdentity(bindToolApproval(delayed, 'source-one'), 'echo', { type: 'object' });
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
  const chat = 'background-chat';
  const saver = new MemorySaver();
  const rewrite = { text: 'background', run_in_background: true };
  try {
    const first = await build({
      source,
      chat,
      saver,
      eventDriven: true,
      background: true,
      rewrite,
      executionTool: delayed,
      callId: 'background-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config(chat));
    const payload = first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload;
    expect(payload.action_requests[0].arguments).toMatchObject({ run_in_background: true });
    const bindings = captureRunToolApprovalBindings(first, payload)!;
    expect(bindings['background-call'].canRemember).toBe(false);
    const resumed = await build({
      source,
      chat,
      saver,
      eventDriven: true,
      background: true,
      rewrite,
      executionTool: delayed,
      reviewed: { bindings, decisions: [{ tool_call_id: 'background-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'background-call': { type: 'approve' } }, config(chat));
    await started;
    expect(executions).toBe(1);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
    release();
    await failed;
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  } finally {
    release();
    await new Promise((resolve) => setImmediate(resolve));
  }
});

test.each([false, true])(
  'request-only header authority cannot change between review and resume (event-driven: %s)',
  async (eventDriven) => {
    const declared = {
      type: 'streamable-http' as const,
      source: 'yaml' as const,
      url: 'https://mcp.example.test/mcp',
      requestHeaders: { 'X-Workspace': '{{WORKSPACE}}' },
    };
    const authorityA = buildMCPToolReviewAuthority({
      serverName: 'fixture',
      config: declared,
      customUserVars: { WORKSPACE: 'workspace-a' },
    });
    const authorityB = buildMCPToolReviewAuthority({
      serverName: 'fixture',
      config: declared,
      customUserVars: { WORKSPACE: 'workspace-b' },
    });
    const targetDefinition = (authority?: string) =>
      bindToolApprovalIdentity(
        bindToolReviewAuthority(
          { name, serverName: 'fixture', parameters: { type: 'object' } },
          authority,
        ),
        'echo',
        { type: 'object' },
      );
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'chat',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [targetDefinition(authorityA)],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'header-review-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityA),
      callId: 'header-call',
    });
    await first.processStream(
      { messages: [new HumanMessage('run')] },
      config('header-review-chat'),
    );
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    const changed = { ...source, toolDefinitions: [targetDefinition(authorityB)] };
    const resumed = await build({
      source: changed,
      chat: 'header-review-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityB),
      reviewed: { bindings, decisions: [{ tool_call_id: 'header-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'header-call': { type: 'approve' } }, config('header-review-chat'));
    expect(executions).toBe(0);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

test.each([false, true])(
  'mixed routing/token header changes cannot reuse paused consent (event-driven: %s)',
  async (eventDriven) => {
    const selected = {
      type: 'streamable-http' as const,
      source: 'yaml' as const,
      url: 'https://mcp.example.test/mcp',
      headers: { 'X-Workspace': '{{WORKSPACE}}:{{LIBRECHAT_OPENID_TOKEN}}' },
    };
    const authorityA = buildMCPToolReviewAuthority({
      serverName: 'fixture',
      config: selected,
      user: { id: '652000000000000000000001', openidId: 'subject-a' },
      customUserVars: { WORKSPACE: 'workspace-a' },
    });
    const authorityB = buildMCPToolReviewAuthority({
      serverName: 'fixture',
      config: selected,
      user: { id: '652000000000000000000001', openidId: 'subject-a' },
      customUserVars: { WORKSPACE: 'workspace-b' },
    });
    const targetDefinition = (authority?: string) =>
      bindToolApprovalIdentity(
        bindToolReviewAuthority(
          { name, serverName: 'fixture', parameters: { type: 'object' } },
          authority,
        ),
        'echo',
        { type: 'object' },
      );
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: {
          approval_mode: 'chat',
          approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
        },
      },
      toolDefinitions: [targetDefinition(authorityA)],
    };
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'mixed-header-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityA),
      callId: 'mixed-header-call',
    });
    await first.processStream({ messages: [new HumanMessage('run')] }, config('mixed-header-chat'));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    expect(bindings['mixed-header-call']).toBeDefined();
    const changed = { ...source, toolDefinitions: [targetDefinition(authorityB)] };
    const resumed = await build({
      source: changed,
      chat: 'mixed-header-chat',
      saver,
      eventDriven,
      executionTool: createProbe(null, 'echo', authorityB),
      reviewed: {
        bindings,
        decisions: [{ tool_call_id: 'mixed-header-call', decision: 'approve' }],
      },
    });
    await resumed.resume({ 'mixed-header-call': { type: 'approve' } }, config('mixed-header-chat'));
    expect(executions).toBe(0);
    expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  },
);

async function oauthCredential(epoch: string) {
  await mongoose.models.Token.deleteMany({ userId: '652000000000000000000001' });
  return mongoose.models.Token.create({
    userId: '652000000000000000000001',
    type: 'mcp_oauth',
    identifier: 'mcp:fixture',
    token: 'synthetic-oauth-token',
    expiresAt: new Date(Date.now() + 60000),
    metadata: { credential_set_id: epoch },
  });
}

test.each(['chat', 'always'] as const)(
  'a changed OAuth account cannot reuse a learned %s grant',
  async (mode) => {
    const source: AgentApprovalSource = {
      id: 'agent-a',
      tool_options: {
        [name]: { approval_mode: mode, approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05' },
      },
      toolDefinitions: [definition()],
    };
    const token = await oauthCredential('account-a');
    const saver = new MemorySaver();
    const first = await build({
      source,
      chat: 'oauth-consent-chat',
      saver,
      eventDriven: true,
      callId: 'oauth-call',
    });
    await first.processStream(
      { messages: [new HumanMessage('run')] },
      config('oauth-consent-chat'),
    );
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    expect(bindings['oauth-call'].oauthEpoch).toBe('account-a');
    const resumed = await build({
      source,
      chat: 'oauth-consent-chat',
      saver,
      eventDriven: true,
      reviewed: { bindings, decisions: [{ tool_call_id: 'oauth-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'oauth-call': { type: 'approve' } }, config('oauth-consent-chat'));
    expect(executions).toBe(1);
    await mongoose.models.Token.updateOne(
      { _id: token._id },
      { $set: { 'metadata.credential_set_id': 'account-b' } },
    );
    const next = await build({
      source,
      chat: 'oauth-consent-chat',
      saver: new MemorySaver(),
      eventDriven: true,
      callId: 'next-oauth-call',
    });
    await next.processStream(
      { messages: [new HumanMessage('run again')] },
      config('oauth-consent-chat'),
    );
    expect(next.getInterrupt()?.payload.type).toBe('tool_approval');
    expect(executions).toBe(1);
    await mongoose.models.Token.deleteOne({ _id: token._id });
  },
);

test('OAuth replacement after pre-tool approval is refused before invocation', async () => {
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
  const token = await oauthCredential('account-a');
  const saver = new MemorySaver();
  const first = await build({
    source,
    chat: 'oauth-dispatch-chat',
    saver,
    eventDriven: true,
    callId: 'dispatch-oauth-call',
  });
  await first.processStream({ messages: [new HumanMessage('run')] }, config('oauth-dispatch-chat'));
  const bindings = captureRunToolApprovalBindings(
    first,
    first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
  )!;
  const resumed = await build({
    source,
    chat: 'oauth-dispatch-chat',
    saver,
    eventDriven: true,
    beforeLoad: async () => {
      await mongoose.models.Token.updateOne(
        { _id: token._id },
        { $set: { 'metadata.credential_set_id': 'account-b' } },
      );
    },
    reviewed: {
      bindings,
      decisions: [{ tool_call_id: 'dispatch-oauth-call', decision: 'approve' }],
    },
  });
  await resumed.resume(
    { 'dispatch-oauth-call': { type: 'approve' } },
    config('oauth-dispatch-chat'),
  );
  expect(executions).toBe(0);
  expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  await mongoose.models.Token.deleteOne({ _id: token._id });
});

test('an OAuth account replaced during transport recovery cannot dispatch the retry', async () => {
  const token = await oauthCredential('account-a');
  let sideEffects = 0;
  const retryProbe = Object.assign(
    createMCPStructuredTool(
      async () => {
        await assertToolApprovalTransportEpoch('fixture', 'account-a', true);
        // The first rejected tools/call had no side effect. Live OAuth recovery replaces its account.
        await mongoose.models.Token.updateOne(
          { _id: token._id },
          { $set: { 'metadata.credential_set_id': 'account-b' } },
        );
        await assertToolApprovalTransportEpoch('fixture', 'account-b', true);
        sideEffects++;
        return formatToolContent(
          { content: [{ type: 'text', text: 'unexpected retry' }] },
          'openai',
        );
      },
      {
        name,
        description: 'Retry probe',
        schema: fixtureSchema,
        responseFormat: 'content_and_artifact',
      },
    ),
    { schema: fixtureSchema },
  );
  bindToolApprovalIdentity(bindToolApproval(retryProbe, 'source-one'), 'echo', { type: 'object' });
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
    chat: 'retry-consent-chat',
    saver,
    eventDriven: true,
    executionTool: retryProbe,
    callId: 'retry-consent-call',
  });
  await first.processStream({ messages: [new HumanMessage('run')] }, config('retry-consent-chat'));
  const bindings = captureRunToolApprovalBindings(
    first,
    first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
  )!;
  const resumed = await build({
    source,
    chat: 'retry-consent-chat',
    saver,
    eventDriven: true,
    executionTool: retryProbe,
    reviewed: {
      bindings,
      decisions: [{ tool_call_id: 'retry-consent-call', decision: 'approve' }],
    },
  });
  await resumed.resume({ 'retry-consent-call': { type: 'approve' } }, config('retry-consent-chat'));
  expect(sideEffects).toBe(0);
  expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
  await mongoose.models.Token.deleteOne({ _id: token._id });
});

test('unsaved verified alias reset revokes the canonical grant without resetting other tools', async () => {
  const storage = createMethods(mongoose);
  const scope = { userId: '652000000000000000000001', conversationId: 'alias-reset-chat' };
  const consent = {
    agentId: 'alias-agent',
    instanceName: 'db_query_mcp_db',
    toolName: 'query_mcp_db',
    binding: 'alias-query-binding',
    scope: 'always' as const,
  };
  const other = {
    ...consent,
    instanceName: 'other_mcp_db',
    toolName: 'other_mcp_db',
    binding: 'other-binding',
  };
  await storage.rememberToolApprovalGrants(scope, [consent, other]);
  const agent = {
    id: consent.agentId,
    tool_options: { db_query_mcp_db: { approval_mode: 'always' as const } },
  };
  const app = express();
  app.use(express.json());
  const controller = createResetToolApprovalController({
    storage,
    getAgent: async () => agent,
    canAccessAgent: async () => true,
    getMCPServerConfigs: async () => ({
      db: { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
    }),
    getMCPServerTools: async () => formatMCPServerTools('db', [{ name: 'db_query' }]),
  });
  app.post('/reset', (req, res) =>
    controller(Object.assign(req, { user: { id: scope.userId } }), res),
  );
  await request(app)
    .post('/reset')
    .send({ agentId: agent.id, toolName: 'query_mcp_db' })
    .expect(200);
  const statuses = await storage.getToolApprovalGrants(scope, [consent, other]);
  expect(statuses.map((status) => status.approved)).toEqual([false, true]);
  await storage.rememberToolApprovalGrants(scope, [consent]);
  expect((await storage.getToolApprovalGrants(scope, [consent]))[0].approved).toBe(false);
  expect(Object.keys(agent.tool_options)).toEqual(['db_query_mcp_db']);
});

for (const eventDriven of [false, true]) {
  test.each([false, true])(
    `stdio renewable env rotation permits only the unchanged reviewed route; event-driven=${eventDriven}, route changed=%s`,
    async (routeChanged) => {
      const selected = {
        type: 'stdio' as const,
        source: 'yaml' as const,
        command: 'node',
        args: ['server.js'],
        env: { UPSTREAM_ACCESS_TOKEN: '{{WORKSPACE}}:{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      };
      const authority = (token: string, workspace: string) =>
        buildMCPToolReviewAuthority({
          serverName: 'fixture',
          config: selected,
          user: {
            id: '652000000000000000000001',
            openidId: 'subject-a',
            openidTokens: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 3600 },
          },
          customUserVars: { WORKSPACE: workspace },
        });
      const a = authority('synthetic-a', 'workspace-a');
      const b = authority('synthetic-b', routeChanged ? 'workspace-b' : 'workspace-a');
      const targetDefinition = (value?: string) =>
        bindToolApprovalIdentity(
          bindToolReviewAuthority(
            {
              name,
              serverName: 'fixture',
              parameters: { type: 'object' },
            },
            value,
          ),
          'echo',
          { type: 'object' },
        );
      const source: AgentApprovalSource = {
        id: 'agent-a',
        tool_options: {
          [name]: {
            approval_mode: 'chat',
            approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
          },
        },
        toolDefinitions: [targetDefinition(a)],
      };
      const saver = new MemorySaver();
      const first = await build({
        source,
        chat: 'env-renewal-chat',
        saver,
        eventDriven,
        executionTool: createProbe(null, 'echo', a),
        callId: 'env-renewal-call',
      });
      await first.processStream(
        { messages: [new HumanMessage('run')] },
        config('env-renewal-chat'),
      );
      const bindings = captureRunToolApprovalBindings(
        first,
        first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
      )!;
      const resumed = await build({
        source: { ...source, toolDefinitions: [targetDefinition(b)] },
        chat: 'env-renewal-chat',
        saver,
        eventDriven,
        executionTool: createProbe(null, 'echo', b),
        reviewed: {
          bindings,
          decisions: [{ tool_call_id: 'env-renewal-call', decision: 'approve' }],
        },
      });
      await resumed.resume({ 'env-renewal-call': { type: 'approve' } }, config('env-renewal-chat'));
      expect(executions).toBe(routeChanged ? 0 : 1);
      expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
    },
  );
}

for (const mode of ['chat', 'always'] as const) {
  for (const eventDriven of [false, true]) {
    test.each(['approve', 'edit'] as const)(
      `${mode} reviewed templated %s refuses background dispatch; event-driven=${eventDriven}`,
      async (decision) => {
        const connection = {
          type: 'streamable-http' as const,
          source: 'yaml' as const,
          url: 'https://mcp.example.test/mcp',
          headers: { 'X-Workspace': '{{WORKSPACE}}' },
          customUserVars: { WORKSPACE: { title: 'Workspace', description: 'Selected workspace' } },
        };
        expect(buildMCPToolApprovalBinding('fixture', connection)).toBeUndefined();
        const authority = buildMCPToolReviewAuthority({
          serverName: 'fixture',
          config: connection,
          customUserVars: { WORKSPACE: 'workspace-a' },
        });
        const reviewDefinition = bindToolApprovalIdentity(
          bindToolReviewAuthority(
            { name, serverName: 'fixture', parameters: { type: 'object' } },
            authority,
          ),
          'echo',
          { type: 'object' },
        );
        const source: AgentApprovalSource = {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: mode,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [reviewDefinition],
        };
        const saver = new MemorySaver();
        const chat = `review-background-${mode}-${eventDriven}-${decision}`;
        const rewrite = { text: 'reviewed', run_in_background: true };
        const executionTool = createProbe(null, 'echo', authority);
        const first = await build({
          source,
          chat,
          saver,
          eventDriven,
          background: true,
          executionTool,
          rewrite,
          callId: 'review-background-call',
        });
        await first.processStream({ messages: [new HumanMessage('run')] }, config(chat));
        const payload = first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload;
        expect(payload.action_requests[0].arguments).toMatchObject({ run_in_background: true });
        const bindings = captureRunToolApprovalBindings(first, payload)!;
        const reviewed = {
          bindings,
          decisions: [{ tool_call_id: 'review-background-call', decision }],
        };
        const session = createAgentToolApprovalSession({
          agents: [source],
          storage,
          scope: { userId: '652000000000000000000001', conversationId: chat },
          reviewed,
        });
        let dispatched = false;
        let finish!: () => void;
        const settled = new Promise<void>((resolve) => {
          finish = resolve;
        });
        const note = session.noteDispatch;
        session.noteDispatch = (invocation) => {
          dispatched = invocation.background === true;
          note?.(invocation);
        };
        const complete = session.finishDispatch;
        session.finishDispatch = (invocation) => {
          complete?.(invocation);
          finish();
        };
        const resumed = await build({
          source,
          chat,
          saver,
          eventDriven,
          background: true,
          executionTool,
          rewrite,
          sharedSession: session,
        });
        const invocationConfig = config(chat);
        if (!eventDriven) {
          Object.assign(invocationConfig.configurable, {
            __librechatBackgroundToolInvocation: true,
          });
        }
        const answer =
          decision === 'edit'
            ? { type: 'edit' as const, updatedInput: rewrite }
            : { type: 'approve' as const };
        await resumed.resume({ 'review-background-call': answer }, invocationConfig);
        if (eventDriven) {
          expect(dispatched).toBe(true);
          await settled;
        }
        expect(executions).toBe(0);
        expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
      },
    );
  }
}

test('old detached settlement cannot erase a newer reused call ID’s OAuth transport fence', async () => {
  const token = await oauthCredential('account-a');
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
  const chat = 'reused-background-provider-id';
  const grantScope = { userId: '652000000000000000000001', conversationId: chat };
  await storage.rememberToolApprovalGrants(grantScope, [
    { ...resolveAgentToolGrantBinding(source, name, grantScope)!, oauthEpoch: 'account-a' },
  ]);
  const session = createAgentToolApprovalSession({ agents: [source], storage, scope: grantScope });
  let releaseOld!: () => void;
  let markOldStarted!: () => void;
  let markNewStarted!: () => void;
  let markOldFinished!: () => void;
  const oldGate = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldStarted = new Promise<void>((resolve) => {
    markOldStarted = resolve;
  });
  const newStarted = new Promise<void>((resolve) => {
    markNewStarted = resolve;
  });
  const oldFinished = new Promise<void>((resolve) => {
    markOldFinished = resolve;
  });
  const complete = session.finishDispatch;
  session.finishDispatch = (invocation) => {
    complete?.(invocation);
    markOldFinished();
  };
  const probe = (invoke: () => Promise<unknown>) =>
    bindToolApprovalIdentity(
      bindToolApproval(
        Object.assign(
          createMCPStructuredTool(invoke, {
            name,
            description: 'Ownership fixture',
            schema: fixtureSchema,
            responseFormat: 'content_and_artifact',
          }),
          { schema: fixtureSchema },
        ),
        'source-one',
      ),
      'echo',
      { type: 'object' },
    );
  const oldTool = probe(async () => {
    markOldStarted();
    await oldGate;
    return formatToolContent({ content: [{ type: 'text', text: 'old settled' }] }, 'openai');
  });
  let newSideEffects = 0;
  const newTool = probe(async () => {
    markNewStarted();
    await oldFinished;
    await mongoose.models.Token.updateOne(
      { _id: token._id },
      { $set: { 'metadata.credential_set_id': 'account-b' } },
    );
    await assertToolApprovalTransportEpoch('fixture', 'account-b', true);
    newSideEffects++;
    return formatToolContent({ content: [{ type: 'text', text: 'unsafe new retry' }] }, 'openai');
  });
  let newTurn: Promise<void> | undefined;
  try {
    const old = await build({
      source,
      chat,
      saver: new MemorySaver(),
      sharedSession: session,
      eventDriven: true,
      background: true,
      rewrite: { text: 'old', run_in_background: true },
      executionTool: oldTool,
      callId: 'call_0',
    });
    await old.processStream({ messages: [new HumanMessage('old background')] }, config(chat));
    await oldStarted;
    const newer = await build({
      source,
      chat,
      saver: new MemorySaver(),
      sharedSession: session,
      eventDriven: true,
      executionTool: newTool,
      callId: 'call_0',
    });
    newTurn = newer
      .processStream({ messages: [new HumanMessage('new foreground')] }, config(chat))
      .then(() => {});
    await newStarted;
    releaseOld();
    await newTurn;
    expect(newSideEffects).toBe(0);
    expect(JSON.stringify(newer.getRunMessages())).toContain('OAuth authorization changed');
  } finally {
    releaseOld();
    await newTurn;
    await mongoose.models.Token.deleteOne({ _id: token._id });
  }
});

test.each([false, true])(
  'registry reinspection preserves paused review and learned consent (event-driven=%s)',
  async (eventDriven) => {
    const registry = new ServerConfigsCacheInMemory();
    const declared = {
      type: 'streamable-http' as const,
      source: 'yaml' as const,
      url: 'https://mcp.example.test/mcp',
    };
    await registry.add('fixture', { ...declared, initDuration: 1 });
    const target = async () => {
      const selected = await registry.get('fixture');
      const binding = buildMCPToolApprovalBinding('fixture', selected);
      const authority = buildMCPToolReviewAuthority({ serverName: 'fixture', config: selected });
      return {
        source: {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: 'always' as const,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [
            bindToolApprovalIdentity(
              bindToolReviewAuthority(
                bindToolApproval(
                  { name, serverName: 'fixture', parameters: { type: 'object' } },
                  binding,
                ),
                authority,
              ),
              'echo',
              { type: 'object' },
            ),
          ],
        },
        executionTool: createProbe(binding, 'echo', authority),
      };
    };
    const initial = await target();
    const saver = new MemorySaver();
    const chat = `registry-consent-${eventDriven}`;
    const first = await build({ ...initial, chat, saver, eventDriven, callId: 'registry-call' });
    await first.processStream({ messages: [new HumanMessage('run')] }, config(chat));
    const bindings = captureRunToolApprovalBindings(
      first,
      first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
    )!;
    await registry.update('fixture', {
      ...declared,
      initDuration: 900,
      tools: 'reinspected',
      capabilities: 'new summary',
    });
    const refreshed = await target();
    const resumed = await build({
      ...refreshed,
      chat,
      saver,
      eventDriven,
      reviewed: { bindings, decisions: [{ tool_call_id: 'registry-call', decision: 'approve' }] },
    });
    await resumed.resume({ 'registry-call': { type: 'approve' } }, config(chat));
    expect(executions).toBe(1);
    await registry.update('fixture', { ...declared, initDuration: 2 });
    const again = await build({
      ...(await target()),
      chat,
      saver: new MemorySaver(),
      eventDriven,
      callId: 'registry-next',
    });
    await again.processStream({ messages: [new HumanMessage('run again')] }, config(chat));
    expect(again.getInterrupt()).toBeUndefined();
    expect(executions).toBe(2);
  },
);

for (const mode of ['chat', 'always'] as const) {
  for (const eventDriven of [false, true]) {
    test.each(['connection', 'schema', 'revision'])(
      `${mode} superseded %s completion preserves replacement consent; event-driven=${eventDriven}`,
      async (change) => {
        let release!: () => void;
        let markStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const oldTool = bindToolApprovalIdentity(
          bindToolApproval(
            Object.assign(
              createMCPStructuredTool(
                async () => {
                  markStarted();
                  await gate;
                  return formatToolContent(
                    { content: [{ type: 'text', text: 'old completed' }] },
                    'openai',
                  );
                },
                {
                  name,
                  description: 'Old approved call',
                  schema: fixtureSchema,
                  responseFormat: 'content_and_artifact',
                },
              ),
              { schema: fixtureSchema },
            ),
            'source-one',
          ),
          'echo',
          { type: 'object' },
        );
        const original: AgentApprovalSource = {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: mode,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [definition()],
        };
        const parameters =
          change === 'schema' ? { type: 'object', description: 'new schema' } : { type: 'object' };
        const sourceBinding = change === 'connection' ? 'source-two' : 'source-one';
        const changed: AgentApprovalSource = {
          ...original,
          tool_options: {
            [name]: {
              ...original.tool_options![name],
              approval_revision:
                change === 'revision'
                  ? '2782f8d4-f52b-4a37-b65e-a60a5b5d4e5b'
                  : original.tool_options![name].approval_revision,
            },
          },
          toolDefinitions: [
            bindToolApprovalIdentity(
              bindToolApproval({ name, serverName: 'fixture', parameters }, sourceBinding),
              'echo',
              parameters,
            ),
          ],
        };
        const newTool = bindToolApprovalIdentity(createProbe(sourceBinding), 'echo', parameters);
        const oldChat = `old-authority-${mode}-${eventDriven}-${change}`;
        const newChat = mode === 'chat' ? oldChat : `new-authority-${eventDriven}-${change}`;
        const oldSaver = new MemorySaver();
        const newSaver = new MemorySaver();
        let oldCompletion: Promise<void> | undefined;
        try {
          const first = await build({
            source: original,
            chat: oldChat,
            saver: oldSaver,
            eventDriven,
            executionTool: oldTool,
            callId: 'old-call',
          });
          await first.processStream({ messages: [new HumanMessage('old')] }, config(oldChat));
          const oldBindings = captureRunToolApprovalBindings(
            first,
            first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
          )!;
          const old = await build({
            source: original,
            chat: oldChat,
            saver: oldSaver,
            eventDriven,
            executionTool: oldTool,
            reviewed: {
              bindings: oldBindings,
              decisions: [{ tool_call_id: 'old-call', decision: 'approve' }],
            },
          });
          oldCompletion = old
            .resume({ 'old-call': { type: 'approve' } }, config(oldChat))
            .then(() => {});
          await started;
          const second = await build({
            source: changed,
            chat: newChat,
            saver: newSaver,
            eventDriven,
            executionTool: newTool,
            callId: 'new-call',
          });
          await second.processStream({ messages: [new HumanMessage('new')] }, config(newChat));
          const newBindings = captureRunToolApprovalBindings(
            second,
            second.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
          )!;
          const newer = await build({
            source: changed,
            chat: newChat,
            saver: newSaver,
            eventDriven,
            executionTool: newTool,
            reviewed: {
              bindings: newBindings,
              decisions: [{ tool_call_id: 'new-call', decision: 'approve' }],
            },
          });
          await newer.resume({ 'new-call': { type: 'approve' } }, config(newChat));
          const scope = { userId: '652000000000000000000001', conversationId: newChat };
          const oldGrant = resolveAgentToolGrantBinding(original, name, scope)!;
          const newGrant = resolveAgentToolGrantBinding(changed, name, scope)!;
          expect((await storage.getToolApprovalGrants(scope, [newGrant]))[0].approved).toBe(true);
          release();
          await oldCompletion;
          expect(
            (await storage.getToolApprovalGrants(scope, [oldGrant, newGrant])).map(
              (status) => status.approved,
            ),
          ).toEqual([false, true]);
        } finally {
          release();
          await oldCompletion;
        }
      },
    );
  }
}

for (const mode of ['chat', 'always'] as const) {
  for (const eventDriven of [false, true]) {
    test.each([false, true])(
      `${mode} OAuth-to-API-key consent ignores retained credentials; event-driven=${eventDriven}, templated=%s`,
      async (templated) => {
        const token = await oauthCredential('retained-account-a');
        const connection = {
          type: 'streamable-http' as const,
          source: 'yaml' as const,
          url: 'https://mcp.example.test/mcp',
          requiresOAuth: false,
          oauth: { client_id: 'retained-client' },
          apiKey: {
            source: 'admin' as const,
            authorization_type: 'bearer' as const,
            key: 'synthetic-current-key',
          },
          ...(templated
            ? {
                headers: { 'X-Workspace': '{{WORKSPACE}}' },
                customUserVars: { WORKSPACE: { title: 'Workspace', description: 'Workspace' } },
              }
            : {}),
        };
        const kind = getMCPToolApprovalAuthKind(connection)!;
        expect(kind).toBe('other');
        const binding = buildMCPToolApprovalBinding('fixture', connection);
        const authority = buildMCPToolReviewAuthority({
          serverName: 'fixture',
          config: connection,
          user: { id: '652000000000000000000001' },
          customUserVars: { WORKSPACE: 'workspace-a' },
        });
        const def = bindToolApprovalIdentity(
          bindToolApproval(
            { name, serverName: 'fixture', parameters: { type: 'object' } },
            binding,
            undefined,
            undefined,
            authority,
            kind,
          ),
          'echo',
          { type: 'object' },
        );
        const probe = bindToolApprovalIdentity(
          bindToolApproval(
            Object.assign(
              createMCPStructuredTool(
                async () => {
                  await assertToolApprovalTransportEpoch('fixture', null, true);
                  executions++;
                  return formatToolContent(
                    { content: [{ type: 'text', text: 'current API-key target' }] },
                    'openai',
                  );
                },
                {
                  name,
                  description: 'Current API-key target',
                  schema: fixtureSchema,
                  responseFormat: 'content_and_artifact',
                },
              ),
              { schema: fixtureSchema },
            ),
            binding,
            undefined,
            undefined,
            authority,
            kind,
          ),
          'echo',
          { type: 'object' },
        );
        const source: AgentApprovalSource = {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: mode,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [def],
        };
        const chat = `auth-kind-${mode}-${eventDriven}-${templated}`;
        const saver = new MemorySaver();
        try {
          const first = await build({
            source,
            chat,
            saver,
            eventDriven,
            executionTool: probe,
            callId: 'api-key-call',
          });
          await first.processStream(
            { messages: [new HumanMessage('review current target')] },
            config(chat),
          );
          const payload = first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload;
          const bindings = captureRunToolApprovalBindings(first, payload)!;
          expect(bindings['api-key-call']).toMatchObject({ authKind: 'other', oauthEpoch: null });
          const resumed = await build({
            source,
            chat,
            saver,
            eventDriven,
            executionTool: probe,
            reviewed: {
              bindings,
              decisions: [{ tool_call_id: 'api-key-call', decision: 'approve' }],
            },
          });
          await resumed.resume({ 'api-key-call': { type: 'approve' } }, config(chat));
          expect(executions).toBe(1);
          await mongoose.models.Token.updateOne(
            { _id: token._id },
            { $set: { 'metadata.credential_set_id': 'retained-account-b' } },
          );
          const again = await build({
            source,
            chat,
            saver: new MemorySaver(),
            eventDriven,
            executionTool: probe,
            callId: 'api-key-next',
          });
          await again.processStream(
            { messages: [new HumanMessage('use current key again')] },
            config(chat),
          );
          if (templated) {
            expect(again.getInterrupt()?.payload.type).toBe('tool_approval');
            expect(executions).toBe(1);
          } else {
            expect(again.getInterrupt()).toBeUndefined();
            expect(executions).toBe(2);
          }
          const oauthDefinition = bindToolApprovalIdentity(
            bindToolApproval(
              { name, serverName: 'fixture', parameters: { type: 'object' } },
              'renewed-oauth-authority',
              undefined,
              undefined,
              undefined,
              'oauth',
            ),
            'echo',
            { type: 'object' },
          );
          const switched = await build({
            source: { ...source, toolDefinitions: [oauthDefinition] },
            chat,
            saver: new MemorySaver(),
            eventDriven,
            executionTool: bindToolApproval(
              createProbe('renewed-oauth-authority'),
              'renewed-oauth-authority',
              undefined,
              undefined,
              undefined,
              'oauth',
            ),
            callId: 'oauth-again',
          });
          await switched.processStream(
            { messages: [new HumanMessage('use OAuth again')] },
            config(chat),
          );
          expect(switched.getInterrupt()?.payload.type).toBe('tool_approval');
          expect(
            captureRunToolApprovalBindings(
              switched,
              switched.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
            )!['oauth-again'],
          ).toMatchObject({ authKind: 'oauth', oauthEpoch: 'retained-account-b' });
        } finally {
          await mongoose.models.Token.deleteOne({ _id: token._id });
        }
      },
    );
  }
}

for (const mode of ['ask', 'chat', 'always'] as const) {
  for (const eventDriven of [false, true]) {
    test.each(['unchanged', 'resume', 'retry'] as const)(
      `${mode} runtime-detected OAuth reviews remain account-bound; event-driven=${eventDriven}, change=%s`,
      async (change) => {
        const token = await oauthCredential('runtime-account-a');
        const declared = {
          type: 'streamable-http' as const,
          source: 'yaml' as const,
          url: 'https://mcp.example.test/users/{{LIBRECHAT_USER_ID}}/mcp',
        };
        const authKind = getMCPToolApprovalAuthKind(declared);
        expect(authKind).toBeUndefined();
        expect(buildMCPToolApprovalBinding('fixture', declared)).toBeUndefined();
        const authority = buildMCPToolReviewAuthority({
          serverName: 'fixture',
          config: declared,
          user: { id: '652000000000000000000001' },
        });
        const definition = bindToolApprovalIdentity(
          bindToolApproval(
            { name, serverName: 'fixture', parameters: { type: 'object' } },
            undefined,
            undefined,
            undefined,
            authority,
            authKind,
          ),
          'echo',
          { type: 'object' },
        );
        let attempts = 0;
        const probe = bindToolApprovalIdentity(
          bindToolApproval(
            Object.assign(
              createMCPStructuredTool(
                async () => {
                  attempts++;
                  await assertToolApprovalTransportEpoch('fixture', 'runtime-account-a', true);
                  if (change === 'retry') {
                    await mongoose.models.Token.updateOne(
                      { _id: token._id },
                      { $set: { 'metadata.credential_set_id': 'runtime-account-b' } },
                    );
                    await assertToolApprovalTransportEpoch('fixture', 'runtime-account-b', true);
                  }
                  executions++;
                  return formatToolContent(
                    { content: [{ type: 'text', text: 'runtime OAuth completed' }] },
                    'openai',
                  );
                },
                {
                  name,
                  description: 'Runtime OAuth fixture',
                  schema: fixtureSchema,
                  responseFormat: 'content_and_artifact',
                },
              ),
              { schema: fixtureSchema },
            ),
            undefined,
            undefined,
            undefined,
            authority,
            authKind,
          ),
          'echo',
          { type: 'object' },
        );
        const source: AgentApprovalSource = {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: mode,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [definition],
        };
        const chat = `runtime-auth-${mode}-${eventDriven}-${change}`;
        const saver = new MemorySaver();
        try {
          const first = await build({
            source,
            chat,
            saver,
            eventDriven,
            executionTool: probe,
            callId: 'runtime-call',
          });
          await first.processStream({ messages: [new HumanMessage('review')] }, config(chat));
          const bindings = captureRunToolApprovalBindings(
            first,
            first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
          )!;
          expect(bindings['runtime-call']).toMatchObject({
            oauthEpoch: 'runtime-account-a',
            canRemember: false,
          });
          expect(bindings['runtime-call'].authKind).toBeUndefined();
          if (change === 'resume')
            await mongoose.models.Token.updateOne(
              { _id: token._id },
              { $set: { 'metadata.credential_set_id': 'runtime-account-b' } },
            );
          const resumed = await build({
            source,
            chat,
            saver,
            eventDriven,
            executionTool: probe,
            reviewed: {
              bindings,
              decisions: [{ tool_call_id: 'runtime-call', decision: 'approve' }],
            },
          });
          await resumed.resume({ 'runtime-call': { type: 'approve' } }, config(chat));
          expect(attempts).toBe(change === 'resume' ? 0 : 1);
          expect(executions).toBe(change === 'unchanged' ? 1 : 0);
          expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
        } finally {
          await mongoose.models.Token.deleteOne({ _id: token._id });
        }
      },
    );
  }
}

for (const mode of ['ask', 'chat', 'always'] as const) {
  for (const eventDriven of [false, true]) {
    test.each(['unchanged', 'connection', 'schema', 'account'] as const)(
      `${mode} pending approval stays fenced after mode removal; event-driven=${eventDriven}, change=%s`,
      async (change) => {
        const token = await oauthCredential('account-a');
        const original: AgentApprovalSource = {
          id: 'agent-a',
          tool_options: {
            [name]: {
              approval_mode: mode,
              approval_revision: 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05',
            },
          },
          toolDefinitions: [definition()],
        };
        const chat = `inherit-resume-${mode}-${eventDriven}-${change}`;
        const saver = new MemorySaver();
        try {
          const first = await build({
            source: original,
            chat,
            saver,
            eventDriven,
            callId: 'pending-call',
          });
          await first.processStream({ messages: [new HumanMessage('review')] }, config(chat));
          const bindings = captureRunToolApprovalBindings(
            first,
            first.getInterrupt()!.payload as Agents.ToolApprovalInterruptPayload,
          )!;
          const parameters =
            change === 'schema'
              ? { type: 'object', description: 'changed schema' }
              : { type: 'object' };
          const sourceBinding =
            change === 'connection' ? 'replacement-endpoint-authority' : 'source-one';
          const currentDefinition = bindToolApprovalIdentity(
            bindToolApproval({ name, serverName: 'fixture', parameters }, sourceBinding),
            'echo',
            parameters,
          );
          const probe = bindToolApprovalIdentity(
            Object.assign(
              createMCPStructuredTool(
                async () => {
                  await assertToolApprovalTransportEpoch(
                    'fixture',
                    change === 'account' ? 'account-b' : 'account-a',
                    true,
                  );
                  executions++;
                  return formatToolContent(
                    { content: [{ type: 'text', text: 'unexpected inherited resume' }] },
                    'openai',
                  );
                },
                {
                  name,
                  description: 'Inheritance resume probe',
                  schema: fixtureSchema,
                  responseFormat: 'content_and_artifact',
                },
              ),
              { schema: fixtureSchema },
            ),
            'echo',
            parameters,
          );
          bindToolApproval(probe, sourceBinding);
          if (change === 'account')
            await mongoose.models.Token.updateOne(
              { _id: token._id },
              { $set: { 'metadata.credential_set_id': 'account-b' } },
            );
          const resumed = await build({
            source: { ...original, tool_options: undefined, toolDefinitions: [currentDefinition] },
            chat,
            saver,
            eventDriven,
            executionTool: probe,
            reviewed: {
              bindings,
              decisions: [{ tool_call_id: 'pending-call', decision: 'approve' }],
            },
          });
          await resumed.resume({ 'pending-call': { type: 'approve' } }, config(chat));
          expect(executions).toBe(0);
          expect(JSON.stringify(resumed.getRunMessages())).toContain(
            'approval configuration changed',
          );
          expect(await mongoose.models.ToolApprovalGrant.countDocuments()).toBe(0);
        } finally {
          await mongoose.models.Token.deleteOne({ _id: token._id });
        }
      },
    );
  }
}
