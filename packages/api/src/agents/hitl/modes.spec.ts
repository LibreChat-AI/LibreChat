import { HookRegistry, createToolPolicyHook, executeHooks } from '@librechat/agents';
import type { ToolApprovalGrantStorage, Agents } from 'librechat-data-provider';
import type { AgentApprovalSource } from './modes';
import {
  createAgentToolApprovalSession,
  resolveAgentToolGrantBinding,
  buildMCPToolApprovalBinding,
  describeRememberedToolApprovals,
} from './modes';
import { bindToolApproval, bindToolApprovalIdentity } from '~/tools/approval';
import { buildToolApprovalPayload, toClientPendingAction } from './policy';
import { buildEffectiveToolApprovalPolicy } from './allow';
import { bindToolReviewAuthority } from '~/tools/approval';
import { buildHITLRunWiring } from './runtime';

const scope = { userId: 'user-a', tenantId: 'tenant-a', conversationId: 'chat-a' };
const name = 'query_mcp_db';
const revision = 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05';
function bindFixture<T extends { name: string; parameters?: object; description?: string }>(
  tool: T,
  binding: string,
  canonicalName?: string,
) {
  const upstreamName = tool.name.slice(0, -'_mcp_db'.length);
  return bindToolApprovalIdentity(
    bindToolApproval(tool, binding, canonicalName),
    upstreamName,
    tool.parameters,
    tool.description,
  );
}
function agent(mode: 'ask' | 'allow' | 'chat' | 'always', id = 'agent-a'): AgentApprovalSource {
  return {
    id,
    tool_options: { [name]: { approval_mode: mode, approval_revision: revision } },
    toolDefinitions: [
      bindFixture({ name, serverName: 'db', parameters: { type: 'object' } }, 'source-a'),
    ],
  };
}
function store(): ToolApprovalGrantStorage {
  const grants = new Set<string>();
  return {
    getToolApprovalGrants: jest.fn(async (_scope, candidates) =>
      candidates.map((candidate) => ({
        binding: candidate.binding,
        approved: grants.has(candidate.binding),
        revocation: 'epoch-a',
        oauthEpoch: null,
      })),
    ),
    rememberToolApprovalGrants: jest.fn(async (_scope, candidates) => {
      for (const candidate of candidates) grants.add(candidate.binding);
    }),
    resetToolApprovalGrants: jest.fn(async () => {
      grants.clear();
    }),
  };
}
const input = (agentId = 'agent-a', callId = 'call-a') => ({
  hook_event_name: 'PreToolUse' as const,
  runId: 'run-a',
  threadId: scope.conversationId,
  executingAgentId: agentId,
  toolUseId: callId,
  toolName: name,
  toolInput: {},
});

test.each(['ask', 'allow', 'chat', 'always'] as const)(
  'enforces %s per executing agent',
  async (mode) => {
    const session = createAgentToolApprovalSession({
      agents: [agent(mode), agent('allow', 'agent-b')],
      scope,
      storage: store(),
    });
    expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
      decision: mode === 'allow' ? 'allow' : 'ask',
    });
    expect(await session.hook(input('agent-b'), new AbortController().signal)).toEqual({
      decision: 'allow',
    });
    expect(await session.hook(input('missing'), new AbortController().signal)).toEqual({});
  },
);

test.each(['deny', 'ask'] as const)(
  'administrator %s wins over always approve and remembered approval',
  async (decision) => {
    const source = agent('always');
    const storage = store();
    const binding = resolveAgentToolGrantBinding(source, name, scope)!;
    await storage.rememberToolApprovalGrants(scope, [binding]);
    const session = createAgentToolApprovalSession({ agents: [source], scope, storage });
    const registry = new HookRegistry();
    registry.register('PreToolUse', {
      hooks: [createToolPolicyHook({ mode: 'bypass', [decision]: [name] }), session.hook],
    });
    const result = await executeHooks({ registry, input: input(), matchQuery: name });
    expect(result.decision).toBe(decision);
  },
);

test('coalesces parallel grant lookups and rechecks after reset', async () => {
  const storage = store();
  const source = agent('chat');
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage });
  await Promise.all([
    session.hook(input(), new AbortController().signal),
    session.hook(input('agent-a', 'call-b'), new AbortController().signal),
  ]);
  expect(storage.getToolApprovalGrants).toHaveBeenCalledTimes(1);
  const payload = buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]);
  const bindings = session.bindingsFor(payload);
  expect(bindings['call-a']).toMatchObject({
    agentId: 'agent-a',
    scope: 'chat',
    revocation: 'epoch-a',
  });
  await storage.rememberToolApprovalGrants(scope, [bindings['call-a']]);
  expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
    decision: 'allow',
  });
  await storage.resetToolApprovalGrants(scope.userId, source.id, name);
  expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
    decision: 'ask',
  });
});

test('changed agent, user, tenant, connection, schema and revision invalidate a grant binding', () => {
  const source = agent('always');
  const original = resolveAgentToolGrantBinding(source, name, scope)!.binding;
  const cases = [
    resolveAgentToolGrantBinding({ ...source, id: 'other-agent' }, name, scope),
    resolveAgentToolGrantBinding(source, name, { ...scope, userId: 'other-user' }),
    resolveAgentToolGrantBinding(source, name, { ...scope, tenantId: 'other-tenant' }),
    resolveAgentToolGrantBinding(
      {
        ...source,
        toolDefinitions: [bindFixture({ ...source.toolDefinitions![0] }, 'other-source')],
      },
      name,
      scope,
    ),
    resolveAgentToolGrantBinding(
      {
        ...source,
        toolDefinitions: [
          bindFixture(
            { ...source.toolDefinitions![0], parameters: { type: 'string' } },
            'source-a',
          ),
        ],
      },
      name,
      scope,
    ),
    resolveAgentToolGrantBinding(
      {
        ...source,
        tool_options: { [name]: { approval_mode: 'always', approval_revision: 'new-revision' } },
      },
      name,
      scope,
    ),
  ];
  for (const candidate of cases) expect(candidate?.binding).not.toBe(original);
  expect(
    resolveAgentToolGrantBinding(source, name, { ...scope, conversationId: 'other-chat' })!.binding,
  ).toBe(original);
});

test('only a verified, manually approved successful invocation creates a grant', async () => {
  const source = agent('chat');
  const binding = resolveAgentToolGrantBinding(source, name, scope)!;
  binding.revocation = 'epoch-a';
  const payload = buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]);
  const storage = store();
  for (const decision of ['reject', 'edit', 'respond', 'approve'] as const) {
    const session = createAgentToolApprovalSession({
      agents: [],
      scope,
      storage,
      reviewed: {
        bindings: { 'call-a': binding },
        decisions: [{ tool_call_id: 'call-a', decision }],
      },
    });
    session.addAgent(source);
    await session.hook(input(), new AbortController().signal);
    expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
    if (decision === 'approve')
      await session.validateExecution(source.toolDefinitions![0], {
        agentId: source.id,
        toolCallId: 'call-a',
      });
    await session.rememberHook(
      { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'success' },
      new AbortController().signal,
    );
    if (decision === 'approve')
      expect(storage.rememberToolApprovalGrants).toHaveBeenCalledWith(scope, [binding]);
    else expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
  }
  const pendingAction: Agents.PendingAction = {
    actionId: 'approval-a',
    streamId: 'chat-a',
    createdAt: 1,
    payload,
    toolApprovalBindings: { 'call-a': binding },
  };
  expect(toClientPendingAction(pendingAction)).not.toHaveProperty('toolApprovalBindings');
  const described = describeRememberedToolApprovals(
    payload,
    pendingAction.toolApprovalBindings,
  ) as Agents.ToolApprovalInterruptPayload;
  expect(described.review_configs[0].remember_scope).toBe('chat');
});

test('a changed binding is denied before an approved call executes', async () => {
  const source = agent('always');
  const binding = resolveAgentToolGrantBinding(source, name, scope)!;
  const changed = {
    ...source,
    toolDefinitions: [bindFixture({ ...source.toolDefinitions![0] }, 'rebound-server')],
  };
  const session = createAgentToolApprovalSession({
    agents: [changed],
    scope,
    storage: store(),
    reviewed: {
      bindings: { 'call-a': binding },
      decisions: [{ tool_call_id: 'call-a', decision: 'approve' }],
    },
  });
  expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
    decision: 'deny',
  });
});

test('missing storage or unknown bindings never auto-approve ask-once tools', async () => {
  const source = agent('always');
  const session = createAgentToolApprovalSession({ agents: [source], scope });
  expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
    decision: 'ask',
  });
  expect(
    resolveAgentToolGrantBinding({ ...source, toolDefinitions: [] }, name, scope),
  ).toBeUndefined();
  expect(buildMCPToolApprovalBinding('db', undefined)).toBeUndefined();
});

test('a grant lookup failure or timeout returns manual review', async () => {
  jest.useFakeTimers();
  const storage = store();
  storage.getToolApprovalGrants = async () => new Promise(() => {});
  const session = createAgentToolApprovalSession({
    agents: [agent('chat')],
    scope,
    storage,
    lookupTimeoutMs: 200,
  });
  const result = session.hook(input(), new AbortController().signal);
  await jest.advanceTimersByTimeAsync(200);
  expect(await result).toMatchObject({ decision: 'ask' });
  jest.useRealTimers();
});

test('templated connection authorities never reuse remembered approval', () => {
  const base = {
    type: 'streamable-http' as const,
    url: 'https://mcp.example.test/mcp',
    source: 'yaml' as const,
  };
  expect(buildMCPToolApprovalBinding('db', base)).toEqual(expect.any(String));
  expect(
    buildMCPToolApprovalBinding('db', {
      ...base,
      url: '{{MCP_URL}}',
      customUserVars: { MCP_URL: { title: 'URL', description: 'Target server' } },
    }),
  ).toBeUndefined();
  expect(
    buildMCPToolApprovalBinding('db', {
      ...base,
      headers: { Authorization: 'Bearer ${MCP_TOKEN}' },
    }),
  ).toBeUndefined();
});

test('collision-preserved tool keys remain distinct and resettable', () => {
  const other = 'db_query_mcp_db';
  const source = agent('always');
  source.tool_options![other] = { approval_mode: 'always', approval_revision: revision };
  source.toolDefinitions!.push(
    bindFixture({ name: other, serverName: 'db', parameters: { type: 'object' } }, 'source-a'),
  );
  const first = resolveAgentToolGrantBinding(source, name, scope)!;
  const second = resolveAgentToolGrantBinding(source, other, scope)!;
  expect(second.toolName).toBe(other);
  expect(second.binding).not.toBe(first.binding);
});

test('only a verified catalog alias changes the remembered grant key', () => {
  const legacy = 'db_query_mcp_db';
  const source = agent('always');
  source.tool_options![legacy] = { approval_mode: 'always', approval_revision: revision };
  source.toolDefinitions!.push(
    bindFixture(
      { name: legacy, serverName: 'db', parameters: { type: 'object' } },
      'source-a',
      name,
    ),
  );
  expect(resolveAgentToolGrantBinding(source, legacy, scope)?.toolName).toBe(name);
});

test('a reviewed background launch does not teach approval before its deferred result succeeds', async () => {
  const source = agent('chat');
  const scopeBinding = resolveAgentToolGrantBinding(source, name, scope)!;
  const storage = store();
  const session = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: {
      bindings: { 'call-a': scopeBinding },
      decisions: [{ tool_call_id: 'call-a', decision: 'approve' }],
    },
  });
  await session.hook(
    { ...input(), toolInput: { run_in_background: true } },
    new AbortController().signal,
  );
  await session.rememberHook(
    {
      ...input(),
      hook_event_name: 'PostToolUse',
      toolOutput: 'Task launched',
      toolInput: { run_in_background: true },
    },
    new AbortController().signal,
  );
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});

test('raw upstream reassignment changes consent despite an identical catalog key and schema', () => {
  const source = agent('always');
  const original = resolveAgentToolGrantBinding(source, name, scope)!;
  const reassigned = bindToolApprovalIdentity({ ...source.toolDefinitions![0] }, 'db_query', {
    type: 'object',
  });
  source.toolDefinitions = [reassigned];
  expect(resolveAgentToolGrantBinding(source, name, scope)?.binding).not.toBe(original.binding);
});

test('execution compares the loaded authority and rechecks revocation after pre-tool approval', async () => {
  const source = agent('always');
  const storage = store();
  const expected = resolveAgentToolGrantBinding(source, name, scope)!;
  await storage.rememberToolApprovalGrants(scope, [expected]);
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage });
  expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
    decision: 'allow',
  });
  const targetB = bindToolApproval({ ...source.toolDefinitions![0] }, 'source-b');
  await expect(
    session.validateExecution(targetB, { agentId: source.id, toolCallId: 'call-a' }),
  ).rejects.toThrow('changed');
  await storage.resetToolApprovalGrants(scope.userId, source.id, name);
  await session.hook(input(), new AbortController().signal);
  await expect(
    session.validateExecution(source.toolDefinitions![0], {
      agentId: source.id,
      toolCallId: 'call-a',
    }),
  ).rejects.toThrow('revoked');
});

test('unverified success hooks cannot teach consent', async () => {
  const source = agent('always');
  const binding = resolveAgentToolGrantBinding(source, name, scope)!;
  const storage = store();
  const session = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: {
      bindings: { 'call-a': binding },
      decisions: [{ tool_call_id: 'call-a', decision: 'approve' }],
    },
  });
  await session.hook(input(), new AbortController().signal);
  await session.rememberHook(
    { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'success' },
    new AbortController().signal,
  );
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});

test('always-ask cannot execute through an unreviewed inner invocation', async () => {
  const source = agent('ask');
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage: store() });
  await expect(
    session.validateExecution(source.toolDefinitions![0], {
      agentId: source.id,
      toolCallId: 'inner-call',
    }),
  ).rejects.toThrow('foreground');
});

test.each(['ask', 'deny'] as const)(
  'the final boundary retains administrator %s over a learned grant',
  async (decision) => {
    const source = agent('always');
    const storage = store();
    await storage.rememberToolApprovalGrants(scope, [
      resolveAgentToolGrantBinding(source, name, scope)!,
    ]);
    const session = createAgentToolApprovalSession({
      agents: [source],
      scope,
      storage,
      policy: () => ({ enabled: true, mode: 'bypass', [decision]: [name] }),
    });
    await session.hook(input('agent-a', 'inner-call'), new AbortController().signal);
    await expect(
      session.validateExecution(source.toolDefinitions![0], {
        agentId: source.id,
        toolCallId: 'inner-call',
      }),
    ).rejects.toThrow();
  },
);

test('an automatic mode cannot bypass a missing SDK policy evaluation', async () => {
  const source = agent('allow');
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage: store() });
  await expect(
    session.validateExecution(source.toolDefinitions![0], {
      agentId: source.id,
      toolCallId: 'inner-call',
    }),
  ).rejects.toThrow('policy could not be verified');
  await session.hook(input('agent-a', 'inner-call'), new AbortController().signal);
  await expect(
    session.validateExecution(source.toolDefinitions![0], {
      agentId: source.id,
      toolCallId: 'inner-call',
    }),
  ).resolves.toBeUndefined();
});

test('non-rememberable review is agent/tool bound and single-use', async () => {
  const source = agent('chat');
  const definition = bindToolApprovalIdentity(
    bindToolReviewAuthority(
      { name, serverName: 'db', parameters: { type: 'object' } },
      'review-only-target',
    ),
    'query',
    { type: 'object' },
  );
  source.toolDefinitions = [definition];
  const storage = store();
  const session = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: { bindings: {}, decisions: [{ tool_call_id: 'call-a', decision: 'approve' }] },
  });
  await session.hook(input(), new AbortController().signal);
  await expect(
    session.validateExecution(definition, { agentId: 'other-agent', toolCallId: 'call-a' }),
  ).rejects.toThrow();
  await expect(
    session.validateExecution(definition, { agentId: source.id, toolCallId: 'call-a' }),
  ).resolves.toBeUndefined();
  await session.hook(input(), new AbortController().signal);
  await expect(
    session.validateExecution(definition, { agentId: source.id, toolCallId: 'call-a' }),
  ).rejects.toThrow('foreground');
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});

test.each(['allow', 'chat', 'always'] as const)(
  'parallel agents keep independent %s witnesses for the same provider call ID',
  async (mode) => {
    const sources = [agent(mode, 'agent-a'), agent(mode, 'agent-b')];
    const storage = store();
    if (mode !== 'allow') {
      await storage.rememberToolApprovalGrants(
        scope,
        sources.map((source) => resolveAgentToolGrantBinding(source, name, scope)!),
      );
    }
    const session = createAgentToolApprovalSession({ agents: sources, scope, storage });
    const decisions = await Promise.all(
      sources.map((source) =>
        session.hook(input(source.id, 'call_0'), new AbortController().signal),
      ),
    );
    expect(decisions).toEqual([{ decision: 'allow' }, { decision: 'allow' }]);
    await expect(
      Promise.all(
        sources.map((source) =>
          session.validateExecution(source.toolDefinitions![0], {
            agentId: source.id,
            toolCallId: 'call_0',
          }),
        ),
      ),
    ).resolves.toEqual([undefined, undefined]);
  },
);

test('colliding paused call IDs cannot choose another agent’s approval binding', async () => {
  const sources = [agent('chat', 'agent-a'), agent('chat', 'agent-b')];
  const session = createAgentToolApprovalSession({ agents: sources, scope, storage: store() });
  await Promise.all(
    sources.map((source) => session.hook(input(source.id, 'call_0'), new AbortController().signal)),
  );
  const payload = buildToolApprovalPayload([{ name, tool_call_id: 'call_0', arguments: {} }]);
  expect(session.bindingsFor(payload)).toEqual({});
  const childPayload = { ...payload, subagent: { agent_id: 'agent-a' } };
  expect(session.bindingsFor(childPayload)['call_0'].agentId).toBe('agent-a');
});

test('reviewed consent and success witnesses stay on the reviewed agent when call IDs collide', async () => {
  const a = agent('chat', 'agent-a');
  const b = agent('allow', 'agent-b');
  const binding = resolveAgentToolGrantBinding(a, name, scope)!;
  binding.revocation = 'epoch-a';
  const storage = store();
  const session = createAgentToolApprovalSession({
    agents: [a, b],
    scope,
    storage,
    reviewed: {
      bindings: { call_0: binding },
      decisions: [{ tool_call_id: 'call_0', decision: 'approve' }],
    },
  });
  await Promise.all([
    session.hook(input(a.id, 'call_0'), new AbortController().signal),
    session.hook(input(b.id, 'call_0'), new AbortController().signal),
  ]);
  await Promise.all([
    session.validateExecution(a.toolDefinitions![0], { agentId: a.id, toolCallId: 'call_0' }),
    session.validateExecution(b.toolDefinitions![0], { agentId: b.id, toolCallId: 'call_0' }),
  ]);
  await Promise.all(
    [a, b].map((source) =>
      session.rememberHook(
        { ...input(source.id, 'call_0'), hook_event_name: 'PostToolUse', toolOutput: 'success' },
        new AbortController().signal,
      ),
    ),
  );
  expect(storage.rememberToolApprovalGrants).toHaveBeenCalledTimes(1);
  expect(storage.rememberToolApprovalGrants).toHaveBeenCalledWith(scope, [binding]);
});

test('concurrent self-spawns retain separate witnesses and paused provenance', async () => {
  const source = agent('allow');
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage: store() });
  const childContext = (run: string) => ({
    rootRunId: 'root',
    hookSessionId: 'root',
    depth: 1,
    ancestry: [
      {
        subagentRunId: run,
        subagentType: 'worker',
        subagentKind: 'agent' as const,
        subagentAgentId: source.id,
        parentRunId: 'root',
      },
    ],
  });
  await Promise.all(
    ['child-a', 'child-b'].map((run) =>
      session.hook(
        {
          ...input(source.id, 'call_0'),
          executionContext: childContext(run),
        },
        new AbortController().signal,
      ),
    ),
  );

  const payload = {
    ...buildToolApprovalPayload([{ name, tool_call_id: 'call_0', arguments: {} }]),
    subagent: { agent_id: source.id, run_id: 'child-b' },
  };
  expect(session.bindingsFor(payload)['call_0'].executionScope).toBe('child-b');
  const graphPayload = { ...payload, subagent: { agent_id: 'synthetic-team', run_id: 'child-b' } };
  expect(session.bindingsFor(graphPayload)['call_0'].agentId).toBe(source.id);
  await expect(
    Promise.all(
      ['child-a', 'child-b'].map((executionScope) =>
        session.validateExecution(source.toolDefinitions![0], {
          agentId: source.id,
          toolCallId: 'call_0',
          executionScope,
        }),
      ),
    ),
  ).resolves.toEqual([undefined, undefined]);
});

test('rewritten arguments never select a colliding sibling’s original proposal', async () => {
  const sources = [agent('chat', 'agent-a'), agent('chat', 'agent-b')];
  const session = createAgentToolApprovalSession({ agents: sources, scope, storage: store() });
  await Promise.all(
    sources.map((source) =>
      session.hook(
        { ...input(source.id, 'call_0'), toolInput: { text: source.id } },
        new AbortController().signal,
      ),
    ),
  );
  const payload = buildToolApprovalPayload([
    { name, tool_call_id: 'call_0', arguments: { text: 'agent-b' } },
  ]);
  expect(session.bindingsFor(payload)).toEqual({});
  const attributed = { ...payload, subagent: { agent_id: 'agent-a' } };
  expect(session.bindingsFor(attributed)['call_0']?.agentId).toBe('agent-a');
});

test('actual background dispatch cannot teach from a synthetic success handle', async () => {
  const source = agent('chat');
  const storage = store();
  const binding = resolveAgentToolGrantBinding(source, name, scope)!;
  const session = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: {
      bindings: { 'call-a': binding },
      decisions: [{ tool_call_id: 'call-a', decision: 'approve' }],
    },
  });
  await session.hook(input(), new AbortController().signal);
  const invocation = { agentId: source.id, toolCallId: 'call-a', background: true };
  session.noteDispatch?.(invocation);
  await session.validateExecution(source.toolDefinitions![0], invocation);
  await session.rememberHook(
    { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'Task launched' },
    new AbortController().signal,
  );
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
  session.finishDispatch?.(invocation);
});

test('synthetic responses retire call candidates at the settled batch boundary', async () => {
  const a = agent('ask', 'agent-a');
  const b = agent('chat', 'agent-b');
  const session = createAgentToolApprovalSession({ agents: [a, b], scope, storage: store() });
  await session.hook(input(a.id, 'call_0'), new AbortController().signal);
  await session.settleBatchHook(
    {
      hook_event_name: 'PostToolBatch',
      runId: 'run-a',
      executingAgentId: a.id,
      entries: [
        {
          toolName: name,
          toolUseId: 'call_0',
          toolInput: {},
          status: 'success',
          toolOutput: 'synthetic',
        },
      ],
    },
    new AbortController().signal,
  );
  await session.hook(input(b.id, 'call_0'), new AbortController().signal);
  expect(
    session.bindingsFor(buildToolApprovalPayload([{ name, tool_call_id: 'call_0', arguments: {} }]))
      .call_0?.agentId,
  ).toBe(b.id);
});

test.each(['ask', 'allow', 'chat', 'always'] as const)(
  'dev conversation allows preserve the executing agent’s %s mode',
  async (mode) => {
    const source = agent(mode);
    const storage = store();
    const policy = buildEffectiveToolApprovalPolicy(
      { enabled: true, mode: 'default', allowAlways: true },
      [],
      [name],
    );
    const session = createAgentToolApprovalSession({
      agents: [source],
      scope,
      storage,
      policy: () => policy,
    });
    const wiring = buildHITLRunWiring(policy, {}, [], [{ hook: session.hook }])!;
    const before = await executeHooks({ registry: wiring.hooks, input: input(), matchQuery: name });
    expect(before.decision).toBe(mode === 'allow' ? 'allow' : 'ask');
    if (mode === 'chat' || mode === 'always') {
      await storage.rememberToolApprovalGrants(scope, [
        resolveAgentToolGrantBinding(source, name, scope)!,
      ]);
      const after = await executeHooks({
        registry: wiring.hooks,
        input: input('agent-a', 'next-call'),
        matchQuery: name,
      });
      expect(after.decision).toBe('allow');
    }
  },
);

test('a successful reviewed call cannot learn consent after its reset epoch changes', async () => {
  const source = agent('chat');
  const binding = { ...resolveAgentToolGrantBinding(source, name, scope)!, revocation: 'epoch-a' };
  const storage = store();
  const session = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: {
      bindings: { 'call-a': binding },
      decisions: [{ tool_call_id: 'call-a', decision: 'approve' }],
    },
  });
  await session.hook(input(), new AbortController().signal);
  await session.validateExecution(source.toolDefinitions![0], {
    agentId: source.id,
    toolCallId: 'call-a',
  });
  jest
    .spyOn(storage, 'getToolApprovalGrants')
    .mockResolvedValue([
      { binding: binding.binding, approved: false, revocation: 'epoch-b', oauthEpoch: null },
    ]);
  await session.rememberHook(
    { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'success' },
    new AbortController().signal,
  );
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});

for (const mode of ['ask', 'chat', 'always'] as const) {
  test.each(['approve', 'edit'] as const)(
    `${mode} non-rememberable %s cannot authorize detached execution`,
    async (decision) => {
      const source = agent(mode);
      const definition = bindToolApprovalIdentity(
        bindToolReviewAuthority(
          {
            name,
            serverName: 'db',
            parameters: { type: 'object' },
          },
          'review-only-target',
        ),
        'query',
        { type: 'object' },
      );
      source.toolDefinitions = [definition];
      const storage = store();
      const first = createAgentToolApprovalSession({ agents: [source], scope, storage });
      await first.hook(input(), new AbortController().signal);
      const bindings = first.bindingsFor(
        buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]),
      );
      const session = createAgentToolApprovalSession({
        agents: [source],
        scope,
        storage,
        reviewed: { bindings, decisions: [{ tool_call_id: 'call-a', decision }] },
      });
      await session.hook(input(), new AbortController().signal);
      await expect(
        session.validateExecution(definition, {
          agentId: source.id,
          toolCallId: 'call-a',
          background: true,
        }),
      ).rejects.toThrow('foreground review');
      // The refused background attempt did not consume the one foreground permission.
      await session.hook(input(), new AbortController().signal);
      await expect(
        session.validateExecution(definition, { agentId: source.id, toolCallId: 'call-a' }),
      ).resolves.toBeUndefined();
      await session.rememberHook(
        { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'success' },
        new AbortController().signal,
      );
      expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
    },
  );
}

test('old detached completion cannot retire a newer reused provider ID or its transport witness', async () => {
  const source = agent('always');
  const storage = store();
  await storage.rememberToolApprovalGrants(scope, [
    resolveAgentToolGrantBinding(source, name, scope)!,
  ]);
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage });
  const old = { agentId: source.id, toolCallId: 'call_0', background: true };
  await session.hook(input(source.id, 'call_0'), new AbortController().signal);
  session.noteDispatch?.(old);
  await session.validateExecution(source.toolDefinitions![0], old);
  const newer = { agentId: source.id, toolCallId: 'call_0' };
  await session.hook(input(source.id, 'call_0'), new AbortController().signal);
  await session.validateExecution(source.toolDefinitions![0], newer);
  await expect(session.validateTransport!('db', 'account-b', newer, false)).rejects.toThrow(
    'OAuth authorization changed',
  );
  session.finishDispatch?.(old);
  session.finishDispatch?.(old);
  await expect(session.validateTransport!('db', 'account-b', newer, false)).rejects.toThrow(
    'OAuth authorization changed',
  );
  await expect(session.validateTransport!('db', null, newer, true)).resolves.toBeUndefined();
  await expect(session.validateTransport!('db', null, old, false)).rejects.toThrow(
    'invocation could not be verified',
  );
});

test('an old detached call retains its pinned OAuth epoch while a newer call is reviewed', async () => {
  const source = agent('always');
  const storage = store();
  await storage.rememberToolApprovalGrants(scope, [
    resolveAgentToolGrantBinding(source, name, scope)!,
  ]);
  let epoch = 'account-a';
  jest
    .spyOn(storage, 'getToolApprovalGrants')
    .mockImplementation(async (_scope, grants) =>
      grants.map((grant) => ({ binding: grant.binding, approved: true, oauthEpoch: epoch })),
    );
  const session = createAgentToolApprovalSession({ agents: [source], scope, storage });
  const old = { agentId: source.id, toolCallId: 'call_0', background: true };
  await session.hook(input(source.id, 'call_0'), new AbortController().signal);
  session.noteDispatch?.(old);
  await session.validateExecution(source.toolDefinitions![0], old);
  epoch = 'account-b';
  const newer = { agentId: source.id, toolCallId: 'call_0' };
  await session.hook(input(source.id, 'call_0'), new AbortController().signal);
  await session.validateExecution(source.toolDefinitions![0], newer);
  await expect(session.validateTransport!('db', 'account-b', newer, true)).resolves.toBeUndefined();
  await expect(session.validateTransport!('db', 'account-b', old, false)).rejects.toThrow(
    'OAuth authorization changed',
  );
  session.finishDispatch?.(old);
  await expect(session.validateTransport!('db', 'account-b', newer, true)).resolves.toBeUndefined();
});

test('registry reinspection metadata does not change learned tool authority', () => {
  const selected = {
    type: 'streamable-http' as const,
    source: 'yaml' as const,
    url: 'https://mcp.example.test',
    updatedAt: 1,
    initDuration: 4,
    tools: 'old summary',
    capabilities: 'old',
    resolvedInstructions: 'old',
  };
  const first = buildMCPToolApprovalBinding('db', selected);
  expect(first).toEqual(expect.any(String));
  expect(
    buildMCPToolApprovalBinding('db', {
      ...selected,
      updatedAt: 999,
      initDuration: 50,
      tools: 'new summary',
      capabilities: 'new',
      resolvedInstructions: 'new',
      inspectionFailed: false,
    }),
  ).toBe(first);
  expect(buildMCPToolApprovalBinding('db', { ...selected, source: 'config' })).not.toBe(first);
  expect(buildMCPToolApprovalBinding('db', { ...selected, dbId: 'another-source' })).not.toBe(
    first,
  );
  expect(
    buildMCPToolApprovalBinding('db', { ...selected, url: 'https://different.example.test' }),
  ).not.toBe(first);
});

test('a late successful execution cannot learn over a replacement consent binding', async () => {
  const source = agent('always');
  const storage = store();
  let consentBinding: string | null = null;
  jest.spyOn(storage, 'getToolApprovalGrants').mockImplementation(async (_scope, grants) =>
    grants.map((candidate) => ({
      binding: candidate.binding,
      approved: false,
      revocation: 'epoch-a',
      oauthEpoch: null,
      consentBinding,
    })),
  );
  const first = createAgentToolApprovalSession({ agents: [source], scope, storage });
  await first.hook(input(), new AbortController().signal);
  const bindings = first.bindingsFor(
    buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]),
  );
  expect(bindings['call-a'].consentBinding).toBeNull();
  const resumed = createAgentToolApprovalSession({
    agents: [source],
    scope,
    storage,
    reviewed: { bindings, decisions: [{ tool_call_id: 'call-a', decision: 'approve' }] },
  });
  await resumed.hook(input(), new AbortController().signal);
  await resumed.validateExecution(source.toolDefinitions![0], {
    agentId: source.id,
    toolCallId: 'call-a',
  });
  consentBinding = 'replacement-authority';
  await resumed.rememberHook(
    { ...input(), hook_event_name: 'PostToolUse', toolOutput: 'successful old call' },
    new AbortController().signal,
  );
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});

for (const mode of ['ask', 'allow', 'chat', 'always'] as const) {
  test.each(['unchanged', 'connection', 'schema', 'account'])(
    `${mode} captured approval cannot lose its fences by switching to inheritance; change=%s`,
    async (change) => {
      const original = agent(mode);
      const storage = store();
      const first = createAgentToolApprovalSession({ agents: [original], scope, storage });
      await first.hook(input(), new AbortController().signal);
      const bindings = first.bindingsFor(
        buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]),
      );
      let definition = original.toolDefinitions![0];
      if (change === 'connection') {
        definition = bindFixture(
          { name, serverName: 'db', parameters: { type: 'object' } },
          'source-b',
        );
      } else if (change === 'schema') {
        definition = bindFixture(
          { name, serverName: 'db', parameters: { type: 'object', description: 'changed schema' } },
          'source-a',
        );
      }
      const inherited = {
        ...original,
        tool_options: { [name]: { defer_loading: true } },
        toolDefinitions: [definition],
      };
      if (change === 'account')
        jest
          .spyOn(storage, 'getToolApprovalGrants')
          .mockResolvedValue([
            { binding: bindings['call-a'].binding, approved: false, oauthEpoch: 'account-b' },
          ]);
      const session = createAgentToolApprovalSession({
        agents: [inherited],
        scope,
        storage,
        reviewed: { bindings, decisions: [{ tool_call_id: 'call-a', decision: 'approve' }] },
      });
      expect(await session.hook(input(), new AbortController().signal)).toMatchObject({
        decision: 'deny',
      });
      await expect(
        session.validateExecution(definition, { agentId: original.id, toolCallId: 'call-a' }),
      ).rejects.toThrow('configuration changed');
      await expect(session.validateExecution(definition, { toolCallId: 'call-a' })).rejects.toThrow(
        'executing agent identity',
      );
      await expect(
        session.validateTransport!(
          'db',
          'account-b',
          { agentId: original.id, toolCallId: 'call-a' },
          false,
        ),
      ).rejects.toThrow('invocation could not be verified');
      expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
    },
  );
}

test('fresh inherited calls without captured approvals preserve the baseline', async () => {
  const inherited = { ...agent('ask'), tool_options: undefined };
  const session = createAgentToolApprovalSession({ agents: [inherited], scope, storage: store() });
  expect(await session.hook(input(), new AbortController().signal)).toEqual({});
  await expect(
    session.validateExecution(inherited.toolDefinitions![0], {
      agentId: inherited.id,
      toolCallId: 'fresh',
    }),
  ).resolves.toBeUndefined();
  await expect(
    session.validateTransport!('db', null, { agentId: inherited.id, toolCallId: 'fresh' }, false),
  ).resolves.toBeUndefined();
});

test('a fresh inherited call with a reused ID retires only the old detached proposal', async () => {
  const original = agent('chat');
  const storage = store();
  const first = createAgentToolApprovalSession({ agents: [original], scope, storage });
  await first.hook(input(), new AbortController().signal);
  const bindings = first.bindingsFor(
    buildToolApprovalPayload([{ name, tool_call_id: 'call-a', arguments: {} }]),
  );
  const session = createAgentToolApprovalSession({
    agents: [original],
    scope,
    storage,
    reviewed: { bindings, decisions: [{ tool_call_id: 'call-a', decision: 'approve' }] },
  });
  await session.hook(input(), new AbortController().signal);
  const detached = { agentId: original.id, toolCallId: 'call-a', background: true };
  await session.validateExecution(original.toolDefinitions![0], detached);
  session.addAgent({ ...original, tool_options: undefined });
  expect(await session.hook(input(), new AbortController().signal)).toEqual({});
  const fresh = { agentId: original.id, toolCallId: 'call-a' };
  await expect(
    session.validateExecution(original.toolDefinitions![0], fresh),
  ).resolves.toBeUndefined();
  await expect(session.validateTransport!('db', null, detached, true)).resolves.toBeUndefined();
  await expect(session.validateTransport!('db', null, fresh, true)).resolves.toBeUndefined();
  session.finishDispatch!(detached);
  await expect(session.validateTransport!('db', null, detached, false)).rejects.toThrow(
    'invocation could not be verified',
  );
  await expect(session.validateTransport!('db', null, fresh, false)).resolves.toBeUndefined();
  expect(storage.rememberToolApprovalGrants).not.toHaveBeenCalled();
});
