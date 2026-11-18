import { Constants } from '@librechat/agents';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { bindScheduledMCPInvocation, narrowScheduledMCPTools } from './execution';
import { createScheduledMCPRunPolicy, SCHEDULE_TOOL_NOT_ALLOWED } from './run';
import { createMCPRequestContext, getMCPRequestContext } from '~/mcp/request';
import { executionFixture, readTool } from './execution.helper';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { ScheduledMCPPolicyError } from './policy';

const catalog = (tools: Tool[] = [readTool]) => ({ tools, complete: true });

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
    'the agent dropping the tool',
    'tool_policy_denied',
    (f: Awaited<ReturnType<typeof executionFixture>>) => {
      f.target.permittedTools[0].tools = ['other'];
    },
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

it('refuses a tool the owner did not allow, even though the agent selects it', async () => {
  const exportTool: Tool = { name: 'export', inputSchema: { type: 'object' } };
  const f = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
  const input = {
    user: f.user,
    serverName: 'warehouse',
    serverConfig: f.config,
    loadTools: async () => catalog([readTool, exportTool]),
  };

  await expect(
    f.invocation('root', 'export').authorize({ ...input, toolName: 'export' }),
  ).rejects.toMatchObject({ failure: { reason: 'tool_policy_denied', automaticReplay: false } });
  await expect(f.invocation().authorize({ ...input, toolName: 'query' })).resolves.toBeUndefined();
});

it('keeps an allowed tool authorized after the agent selects another tool', async () => {
  const f = await executionFixture();
  f.target.permittedTools[0].tools.push('write');

  await expect(
    f.invocation().authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.config,
      toolName: 'query',
      loadTools: async () => catalog(),
    }),
  ).resolves.toBeUndefined();
});

it('pins the live definition on first use and refuses the tool once the server changes it', async () => {
  const fixture = await executionFixture();
  const call = (tool: Tool = readTool, agentId = 'root') =>
    fixture.invocation(agentId).authorize({
      user: fixture.user,
      serverName: 'warehouse',
      serverConfig: fixture.config,
      toolName: 'query',
      loadTools: async () => catalog([tool]),
    });
  await call();
  // Key order is not a change; a new description, schema or annotation is.
  await call({
    inputSchema: readTool.inputSchema,
    description: readTool.description,
    name: 'query',
  });
  for (const changed of [
    { ...readTool, description: 'Read a fixed resource, then forward it' },
    { ...readTool, inputSchema: { type: 'object' as const, properties: { to: {} } } },
    { ...readTool, annotations: { readOnlyHint: true } },
  ]) {
    const other = await executionFixture();
    await other.invocation().authorize({
      user: other.user,
      serverName: 'warehouse',
      serverConfig: other.config,
      toolName: 'query',
      loadTools: async () => catalog(),
    });
    await expect(
      other.invocation().authorize({
        user: other.user,
        serverName: 'warehouse',
        serverConfig: other.config,
        toolName: 'query',
        loadTools: async () => catalog([changed]),
      }),
    ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  }
  await expect(call({ ...readTool, description: 'Changed' })).rejects.toMatchObject({
    failure: { reason: 'binding_mismatch', status: 'mcp_reauth_required' },
  });
  // The other agent's use of the same tool is refused too, and so is the original definition.
  await expect(call(readTool, 'child')).rejects.toMatchObject({
    failure: { reason: 'binding_mismatch' },
  });
  expect(await fixture.service.view(fixture.identity)).toMatchObject({
    state: 'changed',
    changed: { warehouse: ['query'] },
  });
});

it('refuses an incomplete snapshot and ambiguous duplicate definitions', async () => {
  const f = await executionFixture();
  for (const snapshot of [{ ...catalog(), complete: false }, catalog([readTool, readTool])]) {
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
  // An agent that joins the run later is held to the same grant. The fixture's grant lists
  // root and child: an agent it does not list has the tool turned away, one it lists does not.
  expect(await call('query_mcp_warehouse', 'handoff')).toEqual({
    decision: 'deny',
    reason: SCHEDULE_TOOL_NOT_ALLOWED,
  });
  const lazy = createScheduledMCPRunPolicy(f.execution, [{ id: 'root' }]);
  lazy.registerAgent({
    id: 'child',
    toolRegistry: new Map([
      [
        'query_mcp_warehouse',
        { name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' },
      ],
    ]),
  });
  expect(
    await lazy.hook(
      {
        hook_event_name: 'PreToolUse',
        runId: 'run',
        toolName: 'query_mcp_warehouse',
        executingAgentId: 'child',
        toolInput: {},
        toolUseId: 'tool',
      },
      new AbortController().signal,
    ),
  ).toEqual({});
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

it.each(['consent_revoked', 'rbac_denied', 'binding_mismatch'] as const)(
  'preserves the original catalog bearer %s through A3 authorization',
  async (reason) => {
    const f = await executionFixture();
    const error = new ScheduledMCPBearerError(reason, 'warehouse', 'child');
    await expect(
      f.invocation('child').authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.config,
        toolName: 'query',
        loadTools: async () => {
          throw error;
        },
      }),
    ).rejects.toBe(error);
  },
);

describe('the tools a run loads under a grant', () => {
  it('keeps what the owner allowed and every tool that is not an MCP tool', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const keys = [
      'query_mcp_warehouse',
      'export_mcp_warehouse',
      'purge_mcp_archive',
      'web_search',
      'execute_code',
    ];
    expect(fixture.execution.narrow('root', keys)).toEqual([
      'query_mcp_warehouse',
      'web_search',
      'execute_code',
    ]);
    // A grant is per agent: one it does not list keeps no MCP tool.
    expect(fixture.execution.narrow('stranger', keys)).toEqual(['web_search', 'execute_code']);
  });

  it('leaves the tools of a schedule nobody authorized as they are', async () => {
    const fixture = await executionFixture();
    fixture.snapshot.enrollment = null;
    const legacy = (await fixture.factory.resolve(fixture.identity, 'invoke'))!;
    const keys = ['query_mcp_warehouse', 'purge_mcp_archive'];
    expect(legacy.narrow('root', keys)).toEqual(keys);
  });

  it('narrows through the request the execution is attached to, and no other', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const req = {};
    const keys = ['query_mcp_warehouse', 'export_mcp_warehouse'];
    // No context was ever opened for this request: nothing is narrowed and none is opened.
    expect(narrowScheduledMCPTools(req, 'root', keys)).toBe(keys);
    expect(narrowScheduledMCPTools(undefined, 'root', keys)).toBe(keys);
    await fixture.factory.attach(getMCPRequestContext(req)!, fixture.identity, 'invoke');
    expect(narrowScheduledMCPTools(req, 'root', keys)).toEqual(['query_mcp_warehouse']);
    expect(narrowScheduledMCPTools({}, 'root', keys)).toBe(keys);
  });
});
