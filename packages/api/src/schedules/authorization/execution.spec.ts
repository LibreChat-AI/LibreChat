import { Constants } from '@librechat/agents';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { getScheduledMCPToolDefinitionDigest, isScheduledMCPToolReadOnly } from './policy';
import { executionFixture, readTool } from './execution.helper';
import { bindScheduledMCPInvocation } from './execution';
import { createMCPRequestContext } from '~/mcp/request';
import { createScheduledMCPRunPolicy } from './run';
import { ScheduledMCPPolicyError } from './policy';

const catalog = (tools: Tool[] = [readTool]) => ({ tools, complete: true });

it('requires a trusted exact-definition declaration, ignoring misleading names and annotations', () => {
  const mutating: Tool = {
    name: 'get_read_only_data',
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
  expect(isScheduledMCPToolReadOnly(mutating)).toBe(false);
  expect(
    isScheduledMCPToolReadOnly(mutating, {
      tools: {
        query: {
          effect: 'read_only',
          definitionSha256: getScheduledMCPToolDefinitionDigest(readTool),
        },
      },
    }),
  ).toBe(false);
  expect(
    isScheduledMCPToolReadOnly(readTool, {
      tools: {
        query: {
          effect: 'read_only',
          definitionSha256: getScheduledMCPToolDefinitionDigest(readTool),
        },
      },
    }),
  ).toBe(true);
});

it('canonicalizes object key order without dropping policy-relevant definition fields', () => {
  const left: Tool = {
    name: 'read',
    inputSchema: { type: 'object', properties: { x: { type: 'string', maxLength: 8 } } },
  };
  const right: Tool = {
    inputSchema: { properties: { x: { maxLength: 8, type: 'string' } }, type: 'object' },
    name: 'read',
  };
  expect(getScheduledMCPToolDefinitionDigest(left)).toBe(
    getScheduledMCPToolDefinitionDigest(right),
  );
  expect(
    getScheduledMCPToolDefinitionDigest({ ...right, outputSchema: { type: 'object' } }),
  ).not.toBe(getScheduledMCPToolDefinitionDigest(left));
});

it.each(['root', 'child'])(
  'checks the actual %s operation through the real consent service',
  async (agentId) => {
    const fixture = await executionFixture();
    await fixture.invocation(agentId).authorize({
      user: fixture.user,
      serverName: 'warehouse',
      serverConfig: fixture.config,
      toolName: 'query',
      loadTools: async () => catalog(),
    });
    expect(fixture.storage.admitScheduleMCPConsent).toHaveBeenCalledWith(
      expect.objectContaining({ identity: fixture.identity, requireEnabled: true }),
    );
  },
);

it.each([
  [
    'revocation',
    'consent_revoked',
    (f: Awaited<ReturnType<typeof executionFixture>>) => f.revoke(),
  ],
  ['expiry', 'consent_expired', (f: Awaited<ReturnType<typeof executionFixture>>) => f.expire()],
  ['RBAC', 'rbac_denied', (f: Awaited<ReturnType<typeof executionFixture>>) => f.deny()],
  [
    'root change',
    'binding_mismatch',
    (f: Awaited<ReturnType<typeof executionFixture>>) => {
      f.snapshot.agentId = 'other';
    },
  ],
  [
    'schedule change',
    'binding_mismatch',
    (f: Awaited<ReturnType<typeof executionFixture>>) => {
      f.snapshot.configRevision++;
    },
  ],
  [
    'selected tool change',
    'binding_mismatch',
    (f: Awaited<ReturnType<typeof executionFixture>>) => {
      f.target.permittedTools[0].tools.push('write');
    },
  ],
  [
    'policy removal',
    'tool_policy_denied',
    (f: Awaited<ReturnType<typeof executionFixture>>) => f.removePolicy(),
  ],
] as const)('rechecks %s after admission on approval resume', async (_name, reason, change) => {
  const f = await executionFixture('resume');
  await change(f);
  await expect(
    f.invocation().authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.config,
      toolName: 'query',
      loadTools: async () => catalog(),
    }),
  ).rejects.toMatchObject({ failure: { reason, automaticReplay: false } });
});

it('refuses a changed catalog, an incomplete snapshot, and ambiguous duplicate definitions', async () => {
  const f = await executionFixture();
  for (const snapshot of [
    catalog([
      {
        ...readTool,
        inputSchema: { type: 'object', properties: { mutation: { type: 'boolean' } } },
      },
    ]),
    { ...catalog(), complete: false },
    catalog([readTool, readTool]),
  ]) {
    await expect(
      f.invocation().authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.config,
        toolName: 'query',
        loadTools: async () => snapshot,
      }),
    ).rejects.toMatchObject({ failure: { reason: 'tool_policy_denied' } });
  }
  expect(f.storage.admitScheduleMCPConsent).not.toHaveBeenCalled();
});

it('refuses a cross-tenant caller, unselected child, and changed transport binding', async () => {
  const f = await executionFixture();
  const input = {
    user: f.user,
    serverName: 'warehouse',
    serverConfig: f.config,
    toolName: 'query',
    loadTools: async () => catalog(),
  };
  const invocation = f.invocation();
  await expect(
    invocation.authorize({
      ...input,
      user: Object.assign(structuredClone(f.user), { tenantId: 'other' }),
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  await expect(f.invocation('stranger').authorize(input)).rejects.toMatchObject({
    failure: { reason: 'tool_policy_denied' },
  });
  await expect(
    f.invocation().authorize({
      ...input,
      serverConfig: { type: 'streamable-http', url: 'https://other.example/mcp' },
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it('fences revocation and expiry that land during catalog loading', async () => {
  for (const mutation of ['revoke', 'expire'] as const) {
    const f = await executionFixture();
    await expect(
      f.invocation().authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.config,
        toolName: 'query',
        loadTools: async () => {
          await f[mutation]();
          return catalog();
        },
      }),
    ).rejects.toMatchObject({
      failure: { reason: mutation === 'revoke' ? 'consent_revoked' : 'consent_expired' },
    });
  }
});

it('keeps a captured guard after enrollment disappears and never falls back to legacy', async () => {
  const f = await executionFixture();
  const context = createMCPRequestContext();
  await f.factory.attach(context, f.identity, 'invoke');
  const bound = bindScheduledMCPInvocation(context, 'root', 'query')!;
  f.snapshot.enrollment = null;
  await expect(
    bound.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.config,
      toolName: 'query',
      loadTools: async () => catalog(),
    }),
  ).rejects.toMatchObject({ failure: { reason: 'consent_missing' } });
  expect(bindScheduledMCPInvocation(createMCPRequestContext(), 'root', 'query')).toBeUndefined();
});

it('retains legacy schedules with no enrollment but never grandfathers revoked enrollment', async () => {
  const f = await executionFixture();
  await f.revoke();
  expect(await f.factory.resolve(f.identity, 'invoke')).toBeDefined();
  f.snapshot.enrollment = null;
  expect(await f.factory.resolve(f.identity, 'invoke')).toMatchObject({ enrolled: false });
});

it('admits disabled consent only for activation, not invocation', async () => {
  const f = await executionFixture('activation');
  f.snapshot.enabled = false;
  const input = {
    user: f.user,
    serverName: 'warehouse',
    serverConfig: f.config,
    toolName: 'query',
    loadTools: async () => catalog(),
  };
  await expect(f.invocation().authorize(input)).resolves.toBeUndefined();
  const invoke = (await f.factory.resolve(f.identity, 'invoke'))!;
  await expect(invoke.bind('root', 'query').authorize(input)).rejects.toMatchObject({
    failure: { reason: 'binding_mismatch' },
  });
});

it('installs an independent ceiling for root, child, handoff, and lazy tools without loosening approval', async () => {
  const f = await executionFixture();
  const policy = createScheduledMCPRunPolicy(f.execution, [
    {
      id: 'root',
      toolDefinitions: [{ name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' }],
      subagentAgentConfigs: [
        {
          id: 'child',
          toolRegistry: new Map([
            [
              'query_mcp_warehouse',
              { name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' },
            ],
          ]),
        },
      ],
    },
  ]);
  const call = async (toolName: string, executingAgentId = 'root') =>
    policy.hook(
      {
        hook_event_name: 'PreToolUse',
        runId: 'run',
        toolName,
        executingAgentId,
        toolInput: {},
        toolUseId: 'tool',
      },
      new AbortController().signal,
    );
  expect(await call('query_mcp_warehouse')).toEqual({});
  expect(await call('query_mcp_warehouse', 'child')).toEqual({});
  expect(await call(Constants.SUBAGENT)).toEqual({});
  for (const name of [
    'action_write',
    Constants.BASH_TOOL,
    Constants.EXECUTE_CODE,
    'forged_mcp_warehouse',
  ])
    expect(await call(name)).toMatchObject({ decision: 'deny' });
  expect(await call('query_mcp_warehouse', 'unknown')).toMatchObject({ decision: 'deny' });
  policy.registerAgent({
    id: 'handoff',
    toolRegistry: new Map([
      [
        'query_mcp_warehouse',
        { name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' },
      ],
    ]),
  });
  expect(await call('query_mcp_warehouse', 'handoff')).toEqual({});
});

it('refuses a consent deadline crossed while the final database admission is in flight', async () => {
  const f = await executionFixture();
  jest.mocked(f.storage.admitScheduleMCPConsent).mockImplementationOnce(async () => {
    f.expire();
    return true;
  });
  const call = f.invocation().authorize({
    user: f.user,
    serverName: 'warehouse',
    serverConfig: f.config,
    toolName: 'query',
    loadTools: async () => catalog(),
  });
  await expect(call).rejects.toMatchObject({
    failure: { reason: 'consent_expired', automaticReplay: false },
  });
});

it.each(['snapshot', 'consent', 'admission', 'catalog'] as const)(
  'projects %s dependency failures into a safe denial for root and resumed child calls',
  async (phase) => {
    for (const stage of ['invoke', 'resume'] as const) {
      const f = await executionFixture(stage);
      const internal = new Error('PRIVATE authorization storage query with credentials');
      if (phase === 'snapshot') f.loadAuthorization.mockRejectedValue(internal);
      if (phase === 'consent')
        jest.mocked(f.storage.readScheduleMCPConsent).mockRejectedValue(internal);
      if (phase === 'admission')
        jest.mocked(f.storage.admitScheduleMCPConsent).mockRejectedValue(internal);
      const provider = jest.fn();
      for (const agentId of ['root', 'child']) {
        const call = async () => {
          await f.invocation(agentId).authorize({
            user: f.user,
            serverName: 'warehouse',
            serverConfig: f.config,
            toolName: 'query',
            loadTools: async () => {
              if (phase === 'catalog') throw internal;
              return catalog();
            },
          });
          return provider();
        };
        let failure: unknown;
        try {
          await call();
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(ScheduledMCPPolicyError);
        expect(failure).toMatchObject({
          failure: {
            reason: 'dependency_unavailable',
            recovery: 'retry_later',
            automaticReplay: false,
          },
          outcomes: [{ server: 'warehouse', agentId, reason: 'dependency_unavailable' }],
        });
        expect(String(failure)).not.toContain('PRIVATE');
        expect(failure).not.toHaveProperty('cause');
      }
      expect(provider).not.toHaveBeenCalled();
    }
  },
);

it.each(['snapshot', 'authorize'] as const)(
  'preserves typed denials and owned cancellation from %s',
  async (phase) => {
    const f = await executionFixture();
    const controller = new AbortController();
    const typed = new ScheduledMCPPolicyError('rbac_denied', 'warehouse', 'child');
    const authorize = jest.spyOn(f.service.authority, 'authorize');
    const fail = (error: Error, cancel = false) => {
      const reject = async () => {
        if (cancel) controller.abort(error);
        throw error;
      };
      if (phase === 'snapshot') f.loadAuthorization.mockImplementation(reject);
      else authorize.mockImplementation(reject);
    };
    const invocation = f.invocation('child');
    const call = () =>
      invocation.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.config,
        toolName: 'query',
        loadTools: async () => catalog(),
        signal: controller.signal,
      });
    fail(typed);
    await expect(call()).rejects.toBe(typed);
    const unowned = Object.assign(new Error('PRIVATE unrelated abort'), { name: 'AbortError' });
    fail(unowned);
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
    const stop = new Error('Owner stopped');
    fail(stop, true);
    await expect(call()).rejects.toBe(stop);
  },
);

it('does not hide a non-abort authorization failure when Stop races its rejection', async () => {
  const f = await executionFixture();
  const controller = new AbortController();
  f.loadAuthorization.mockImplementation(async () => {
    controller.abort(new Error('Stop'));
    throw new Error('PRIVATE database failure');
  });
  const invocation = f.invocation();
  await expect(
    invocation.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.config,
      toolName: 'query',
      loadTools: async () => catalog(),
      signal: controller.signal,
    }),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
});
