import { HookRegistry, createToolPolicyHook, executeHooks } from '@librechat/agents';
import type { ToolApprovalGrantStorage, Agents } from 'librechat-data-provider';
import type { AgentApprovalSource } from './modes';
import {
  createAgentToolApprovalSession,
  resolveAgentToolGrantBinding,
  buildMCPToolApprovalBinding,
  describeRememberedToolApprovals,
} from './modes';
import { buildToolApprovalPayload, toClientPendingAction } from './policy';
import { bindToolApproval } from '~/tools/approval';

const scope = { userId: 'user-a', tenantId: 'tenant-a', conversationId: 'chat-a' };
const name = 'query_mcp_db';
const revision = 'c09e8bb4-00fa-41be-90ca-f53f1a0c1f05';
function agent(mode: 'ask' | 'allow' | 'chat' | 'always', id = 'agent-a'): AgentApprovalSource {
  return {
    id,
    tool_options: { [name]: { approval_mode: mode, approval_revision: revision } },
    toolDefinitions: [
      bindToolApproval({ name, serverName: 'db', parameters: { type: 'object' } }, 'source-a'),
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
        toolDefinitions: [bindToolApproval({ ...source.toolDefinitions![0] }, 'other-source')],
      },
      name,
      scope,
    ),
    resolveAgentToolGrantBinding(
      {
        ...source,
        toolDefinitions: [{ ...source.toolDefinitions![0], parameters: { type: 'string' } }],
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
    toolDefinitions: [bindToolApproval({ ...source.toolDefinitions![0] }, 'rebound-server')],
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
    bindToolApproval({ name: other, serverName: 'db', parameters: { type: 'object' } }, 'source-a'),
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
    bindToolApproval(
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
