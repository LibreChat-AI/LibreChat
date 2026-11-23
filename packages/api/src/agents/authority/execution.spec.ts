import { SCHEDULE_APPROVAL_REASON } from 'librechat-data-provider';
import { Constants, DEFAULT_HOOK_TIMEOUT_MS } from '@librechat/agents';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { HookCallback } from '@librechat/agents';
import {
  asksEveryUse,
  createRunGrantExecution,
  narrowGrantedTools,
  collectApprovedToolCalls,
  withoutServers,
  bindRunGrantInvocation,
} from './execution';
import { SCHEDULE_TOOL_NOT_ALLOWED } from '~/schedules/authorization/subject';
import { createMCPRequestContext, getMCPRequestContext } from '~/mcp/request';
import { executionFixture, readTool } from './execution.helper';
import { ScheduledMCPBearerError } from '~/mcp/errors';
import { RunGrantPolicyError } from './policy';
import { createRunPolicy } from './run';

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
    expect(fixture.storage.admitRunGrant).toHaveBeenCalledWith(
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
  expect(f.storage.admitRunGrant).not.toHaveBeenCalled();
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
  const bound = bindRunGrantInvocation(context, 'root', 'query')!;
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
  expect(bindRunGrantInvocation(createMCPRequestContext(), 'root', 'query')).toBeUndefined();
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
  const policy = createRunPolicy(f.execution, [
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
  const lazy = createRunPolicy(f.execution, [{ id: 'root' }]);
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

it('lets a run use the other tools its owner allowed, and code tools only with code execution', async () => {
  const f = await executionFixture('invoke', readTool, undefined, {
    tools: ['execute_code', 'send_action_mail.example', 'web_search'],
    allowTools: ['execute_code', 'web_search'],
  });
  const mcp = [{ name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' }];
  const decide = (execution: typeof f.execution, toolName: string, executingAgentId = 'root') =>
    createRunPolicy(execution, [
      { id: 'root', toolDefinitions: mcp },
      { id: 'child', toolDefinitions: mcp },
    ]).hook(
      { toolName, toolInput: {}, executingAgentId } as Parameters<HookCallback<'PreToolUse'>>[0],
      new AbortController().signal,
    );
  const refused = { decision: 'deny', reason: expect.any(String) };
  expect(await decide(f.execution, 'web_search')).toEqual({});
  expect(await decide(f.execution, 'web_search', 'child')).toEqual({});
  // The code environment's tools go by several names; code execution allows them all.
  expect(await decide(f.execution, 'execute_code')).toEqual({});
  expect(await decide(f.execution, 'bash_tool')).toEqual({});
  // Left out by the owner, or not something the owner was offered at all.
  expect(await decide(f.execution, 'send_action_mail.example')).toEqual(refused);
  expect(await decide(f.execution, 'memory')).toEqual(refused);

  // Memory runs as two tools of other names, both allowed by the one item.
  const remembers = await executionFixture('invoke', readTool, undefined, {
    tools: ['memory', 'web_search'],
    allowTools: ['memory'],
  });
  expect(await decide(remembers.execution, 'set_memory')).toEqual({});
  expect(await decide(remembers.execution, 'delete_memory')).toEqual({});
  expect(await decide(f.execution, 'set_memory')).toEqual(refused);

  const without = await executionFixture('invoke', readTool, undefined, {
    tools: ['execute_code', 'web_search'],
    allowTools: ['web_search'],
  });
  expect(await decide(without.execution, 'bash_tool')).toEqual(refused);
  expect(await decide(without.execution, 'web_search')).toEqual({});
});

it('refuses a consent deadline crossed while the final database admission is in flight', async () => {
  const f = await executionFixture();
  jest.mocked(f.storage.admitRunGrant).mockImplementationOnce(async () => {
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
      if (phase === 'consent') jest.mocked(f.storage.readRunGrant).mockRejectedValue(internal);
      if (phase === 'admission') jest.mocked(f.storage.admitRunGrant).mockRejectedValue(internal);
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
        expect(failure).toBeInstanceOf(RunGrantPolicyError);
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
    const typed = new RunGrantPolicyError('rbac_denied', 'warehouse', 'child');
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
  const keys = [
    'query_mcp_warehouse',
    'export_mcp_warehouse',
    'purge_mcp_archive',
    'web_search',
    'execute_code',
    'send_action_mail.example',
    // The SDK's own controls are not the owner's to allow: they always load.
    'tool_search',
  ];

  it('keeps the MCP tools and the other tools the owner allowed, each on its own', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['export'],
      tools: ['execute_code', 'send_action_mail.example', 'web_search'],
      allowTools: ['send_action_mail.example', 'web_search'],
    });
    expect(fixture.execution.narrow('root', keys)).toEqual([
      'query_mcp_warehouse',
      'web_search',
      'send_action_mail.example',
      'tool_search',
    ]);
    expect(fixture.execution.grantsTool('root', 'web_search')).toBe(true);
    expect(fixture.execution.grantsTool('root', 'execute_code')).toBe(false);
    // A grant is per agent: one it does not list keeps only the controls.
    expect(fixture.execution.narrow('stranger', keys)).toEqual(['tool_search']);
    expect(fixture.execution.grantsTool('stranger', 'web_search')).toBe(false);
  });

  it('loads and allows every tool under a grant of the whole agent, while it lasts', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { everything: true });
    const all = [...keys, 'sys__server__sys_mcp_archive', 'sys__all__sys_mcp_archive'];
    // Nothing was listed, on a server with no consent or as another tool, and nothing is left out.
    expect(fixture.execution.narrow('root', all)).toEqual(all);
    expect(fixture.execution.narrow('stranger', all)).toEqual(all);
    expect(fixture.execution.grants('later', 'archive', 'purge')).toBe(true);
    expect(fixture.execution.grantsTool('root', 'execute_code')).toBe(true);
    const policy = createRunPolicy(fixture.execution, [
      { id: 'root', toolDefinitions: [{ name: 'purge_mcp_archive', serverName: 'archive' }] },
    ]);
    const decide = (toolName: string) =>
      policy.hook(
        { toolName, toolInput: {}, executingAgentId: 'root' } as Parameters<
          HookCallback<'PreToolUse'>
        >[0],
        new AbortController().signal,
      );
    // A skill, a file read, a tool added to the agent since: none of them is on any list.
    expect(await decide('skill')).toEqual({});
    expect(await decide('read_file')).toEqual({});
    expect(await decide('purge_mcp_archive')).toEqual({});

    fixture.expire();
    expect(fixture.execution.grantsTool('root', 'execute_code')).toBe(false);
    expect(fixture.execution.narrow('root', all)).not.toContain('web_search');
    expect(await decide('skill')).toMatchObject({ decision: 'deny' });
  });

  it('pauses a whole-agent run for a tool the owner approves each time, whoever calls it and however it is selected', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      everything: true,
      ask: ['query'],
    });
    const key = 'query_mcp_warehouse';
    expect(fixture.execution.mayAsk).toBe(true);
    expect(fixture.execution.asksAbout('root', key)).toBe(true);
    // An agent added since the grant was made is asked about it too.
    expect(fixture.execution.asksAbout('later', key)).toBe(true);
    expect(fixture.execution.asksAboutAny([key])).toBe(true);
    expect(fixture.execution.asksAbout('root', 'export_mcp_warehouse')).toBe(false);
    // The agents come to select the whole server: the consent names no tool, the question stays.
    for (const consent of fixture.snapshot.enrollment!.consents)
      consent.permittedTools = [{ agentId: 'root', tools: ['sys__all__sys'] }];
    const next = (await fixture.factory.resolve(fixture.identity, 'invoke'))!;
    expect(next.mayAsk).toBe(true);
    expect(next.asksAbout('root', key)).toBe(true);
    // Under a grant that lists its tools a question belongs to the agents it lists.
    const listed = await executionFixture('invoke', readTool, undefined, { ask: ['query'] });
    expect(listed.execution.asksAbout('root', key)).toBe(true);
    expect(listed.execution.asksAbout('later', key)).toBe(false);
  });

  it('lets a whole-agent run call a server its grant holds no consent for, while the grant stands', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { everything: true });
    const notes = { type: 'stdio' as const, command: 'notes', args: [] };
    const call = (execution = fixture.execution) =>
      execution.bind('root', 'lookup').authorize({
        user: fixture.user,
        serverName: 'notes',
        serverConfig: notes as never,
        toolName: 'lookup',
        loadTools: async () => ({ tools: [{ ...readTool, name: 'lookup' }], complete: true }),
      });
    jest.mocked(fixture.storage.readRunGrant).mockClear();
    await expect(call()).resolves.toBeUndefined();
    // Checked again at the call, by the same authority a server with a consent is: the grant
    // this run started under is still the stored one, and its owner may still use it.
    expect(fixture.loadAuthorization).toHaveBeenCalledTimes(1);
    expect(fixture.storage.readRunGrant).toHaveBeenCalledTimes(1);

    // The owner edited the schedule: the grant was made for what it was before.
    fixture.snapshot.configRevision = 1;
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
    fixture.snapshot.configRevision = 0;
    const stored = fixture.snapshot.enrollment!;
    fixture.snapshot.enrollment = { ...stored, revision: 'another' };
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
    fixture.snapshot.enrollment = stored;
    await fixture.revoke();
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
    jest.mocked(fixture.storage.readRunGrant).mockRejectedValueOnce(new Error('PRIVATE'));
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });

    // The owner lost the permission the schedule runs on.
    const denied = await executionFixture('invoke', readTool, undefined, { everything: true });
    denied.deny();
    await expect(call(denied.execution)).rejects.toMatchObject({
      failure: { reason: 'rbac_denied' },
    });

    // A grant that lists its tools still refuses a server it does not list.
    const listed = await executionFixture('invoke', readTool);
    await expect(call(listed.execution)).rejects.toMatchObject({
      failure: { reason: 'tool_policy_denied' },
    });
  });

  it('treats the skills of an agent as one item: allowed, the tools that run them pass the hook', async () => {
    const decide = async (allowTools: string[], toolName: string) => {
      const fixture = await executionFixture('invoke', readTool, undefined, {
        tools: ['skills', 'web_search'],
        allowTools,
      });
      expect(fixture.execution.narrow('root', ['skills'])).toEqual(
        allowTools.includes('skills') ? ['skills'] : [],
      );
      return createRunPolicy(fixture.execution, [{ id: 'root' }]).hook(
        { toolName, toolInput: {}, executingAgentId: 'root' } as Parameters<
          HookCallback<'PreToolUse'>
        >[0],
        new AbortController().signal,
      );
    };
    // The catalog registers a tool to run a skill and one to read its files.
    expect(await decide(['skills'], 'skill')).toEqual({});
    expect(await decide(['skills'], 'read_file')).toEqual({});
    // Another item does not stand for them, and skills stand for nothing else.
    expect(await decide(['web_search'], 'skill')).toMatchObject({ decision: 'deny' });
    expect(await decide(['skills'], 'execute_code')).toMatchObject({ decision: 'deny' });
  });

  it('loads and calls a tool on a server the operator did not declare, once the owner listed it', async () => {
    const notes = { type: 'stdio' as const, command: 'notes', args: [] };
    const offered = ['lookup_mcp_notes', 'purge_mcp_notes', 'web_search'];
    const fixture = await executionFixture('invoke', readTool, undefined, {
      tools: offered,
      allowTools: ['lookup_mcp_notes'],
    });
    const call = (tool: string, execution = fixture.execution) =>
      execution.bind('root', tool).authorize({
        user: fixture.user,
        serverName: 'notes',
        serverConfig: notes as never,
        toolName: tool,
        loadTools: async () => ({ tools: [{ ...readTool, name: tool }], complete: true }),
      });
    // It loads under the key the agent has it by, and so does the key for its server alone.
    expect(
      fixture.execution.narrow('root', [...offered, 'sys__server__sys_mcp_notes', 'x_mcp_other']),
    ).toEqual(['lookup_mcp_notes', 'sys__server__sys_mcp_notes']);
    expect(fixture.execution.grants('root', 'notes', 'lookup')).toBe(true);
    expect(fixture.execution.grants('root', 'notes', 'purge')).toBe(false);
    expect(fixture.execution.grants('stranger', 'notes', 'lookup')).toBe(false);
    await expect(call('lookup')).resolves.toBeUndefined();
    expect(fixture.loadAuthorization).toHaveBeenCalledTimes(1);
    await expect(call('purge')).rejects.toMatchObject({
      failure: { reason: 'tool_policy_denied' },
    });
    // Once the grant has run out it is not loaded, and a call says why.
    fixture.expire();
    expect(fixture.execution.narrow('root', offered)).toEqual([]);
    await expect(call('lookup')).rejects.toMatchObject({ failure: { reason: 'consent_expired' } });

    // A selection of the whole server is one key, and stands for every tool there.
    const every = await executionFixture('invoke', readTool, undefined, {
      tools: ['sys__all__sys_mcp_notes'],
      allowTools: ['sys__all__sys_mcp_notes'],
    });
    expect(every.execution.narrow('root', ['sys__all__sys_mcp_notes'])).toEqual([
      'sys__all__sys_mcp_notes',
    ]);
    expect(every.execution.grants('root', 'notes', 'anything')).toBe(true);
    await expect(call('anything', every.execution)).resolves.toBeUndefined();
    // A grant that limits MCP tools only has no other tools: nothing is listed there.
    const limited = await executionFixture('invoke', readTool, undefined, {
      tools: offered,
      allowTools: ['lookup_mcp_notes'],
      coversTools: false,
    });
    expect(limited.execution.grants('root', 'notes', 'lookup')).toBe(false);
  });

  it('loads every key on a declared server once the owner allowed the whole server', async () => {
    const keys = [
      'query_mcp_warehouse',
      'export_mcp_warehouse',
      'sys__all__sys_mcp_warehouse',
      'sys__server__sys_mcp_warehouse',
      'purge_mcp_archive',
    ];
    const whole = await executionFixture('invoke', readTool, undefined, {
      offered: ['sys__all__sys'],
      allow: ['sys__all__sys'],
    });
    // A grant that lists its tools, with one item ticked: every tool on that server.
    expect(whole.snapshot.enrollment).not.toHaveProperty('everything');
    expect(whole.execution.narrow('root', keys)).toEqual(keys.slice(0, 4));
    expect(whole.execution.grants('root', 'warehouse', 'anything')).toBe(true);
    expect(whole.execution.grants('stranger', 'warehouse', 'anything')).toBe(false);
    // With only a tool named, the key for the whole server is still not loaded.
    const named = await executionFixture('invoke', readTool, undefined, {
      offered: ['sys__all__sys'],
    });
    expect(named.execution.narrow('root', keys)).toEqual([
      'query_mcp_warehouse',
      'sys__server__sys_mcp_warehouse',
    ]);
    expect(named.execution.grants('root', 'warehouse', 'export')).toBe(false);
  });

  it('pauses an agent granted the whole server for a tool the owner approves each time', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['sys__all__sys'],
      allow: ['query', 'sys__all__sys'],
      ask: ['query'],
    });
    // The root has the whole server and names no tool. The child names the tool asked about.
    for (const consent of fixture.snapshot.enrollment!.consents)
      consent.permittedTools = [
        { agentId: 'child', tools: ['query'] },
        { agentId: 'root', tools: ['sys__all__sys'] },
      ];
    const execution = (await fixture.factory.resolve(fixture.identity, 'invoke'))!;
    expect(execution.asksAbout('child', 'query_mcp_warehouse')).toBe(true);
    // The root can call it through the whole server, so it is asked about for the root too.
    expect(execution.asksAbout('root', 'query_mcp_warehouse')).toBe(true);
    expect(execution.asksAbout('root', 'export_mcp_warehouse')).toBe(false);
    // An agent the grant holds nothing for is not asked: it cannot call it at all.
    expect(execution.asksAbout('stranger', 'query_mcp_warehouse')).toBe(false);
  });

  it('loads none of the other tools when the owner allowed none', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      tools: ['execute_code', 'web_search'],
    });
    expect(fixture.execution.narrow('root', keys)).toEqual(['query_mcp_warehouse', 'tool_search']);
  });

  it('stops loading and allowing the other tools once the grant has run out or been revoked', async () => {
    const choice = { tools: ['execute_code', 'web_search'], allowTools: ['web_search'] };
    const fixture = await executionFixture('invoke', readTool, undefined, choice);
    expect(fixture.execution.narrow('root', keys)).toContain('web_search');
    // Nothing checks these tools at the call as an MCP call is checked, so the run does.
    fixture.expire();
    expect(fixture.execution.grantsTool('root', 'web_search')).toBe(false);
    // The MCP tool still loads: its call is refused where it is made.
    expect(fixture.execution.narrow('root', keys)).toEqual(['query_mcp_warehouse', 'tool_search']);

    const revoked = await executionFixture('invoke', readTool, undefined, choice);
    await revoked.revoke();
    const next = (await revoked.factory.resolve(revoked.identity, 'invoke'))!;
    expect(next.grantsTool('root', 'web_search')).toBe(false);
    expect(next.narrow('root', keys)).not.toContain('web_search');
  });

  it('refuses every tool of a schedule that needs a grant it does not have, with the same reason', async () => {
    const fixture = await executionFixture();
    fixture.snapshot.enrollment = null;
    let required = true;
    const requiresGrant = jest.fn(async () => required);
    const build = (coversTools?: boolean) =>
      createRunGrantExecution({
        storage: fixture.storage,
        loadAuthorization: fixture.loadAuthorization,
        requiresGrant,
        ...(coversTools && { coversTools }),
      }).resolve(fixture.identity, 'invoke');
    const mcp = [{ name: 'query_mcp_warehouse', serverName: 'warehouse', toolType: 'mcp' }];
    const decide = (execution: typeof fixture.execution, toolName: string) =>
      createRunPolicy(execution, [{ id: 'root', toolDefinitions: mcp }]).hook(
        { toolName, toolInput: {}, executingAgentId: 'root' } as Parameters<
          HookCallback<'PreToolUse'>
        >[0],
        new AbortController().signal,
      );
    const legacy = (await build(true))!;
    // The tools still load, so the refusal is seen where the tool is called and recorded.
    expect(legacy.narrow('root', keys)).toEqual(keys);
    expect(await decide(legacy, 'web_search')).toEqual({
      decision: 'deny',
      reason: new RunGrantPolicyError('consent_missing', '', 'root').message,
    });
    // An MCP call is refused where it is made, and the SDK's own controls are not tools to grant.
    expect(await decide(legacy, 'query_mcp_warehouse')).toEqual({});
    expect(await decide(legacy, 'tool_search')).toEqual({});
    expect(requiresGrant).toHaveBeenCalledTimes(1);

    required = false;
    expect(await decide((await build(true))!, 'web_search')).toEqual({});
    // A lookup that fails is not permission.
    requiresGrant.mockRejectedValueOnce(new Error('PRIVATE store detail'));
    const failed = await decide((await build(true))!, 'web_search');
    expect(failed).toMatchObject({ decision: 'deny' });
    expect(JSON.stringify(failed)).not.toContain('PRIVATE');
    // A grant that limits MCP tools only never holds back the other tools.
    required = true;
    expect(await (await build())!.needsGrant()).toBe(false);
  });

  it('refuses a held tool before the hook times out, however slow the reads behind it', async () => {
    const fixture = await executionFixture();
    fixture.snapshot.enrollment = null;
    const limit = DEFAULT_HOOK_TIMEOUT_MS / 2;
    const read = fixture.storage.readRunGrant;
    // The lookup never answers.
    const build = () =>
      createRunGrantExecution({
        storage: fixture.storage,
        loadAuthorization: fixture.loadAuthorization,
        requiresGrant: () => new Promise<boolean>(() => undefined),
        coversTools: true,
      }).resolve(fixture.identity, 'invoke');
    const decide = async (execution: Awaited<ReturnType<typeof build>>) =>
      createRunPolicy(execution!, [{ id: 'root' }]).hook(
        { toolName: 'web_search', toolInput: {}, executingAgentId: 'root' } as Parameters<
          HookCallback<'PreToolUse'>
        >[0],
        new AbortController().signal,
      );
    const refusal = {
      decision: 'deny',
      reason: new RunGrantPolicyError('dependency_unavailable', '', 'root').message,
    };
    const [one, two] = [await build(), await build()];
    jest.useFakeTimers();
    try {
      const stalled = decide(one);
      const seen = jest.fn();
      void stalled.then(seen);
      await jest.advanceTimersByTimeAsync(limit - 1);
      expect(seen).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(await stalled).toEqual(refusal);

      // The read before it spent most of the time: the lookup gets only what is left.
      const first = await read(fixture.identity);
      jest
        .mocked(read)
        .mockImplementationOnce(
          () => new Promise((resolve) => setTimeout(() => resolve(first), limit - 100)),
        );
      const late = decide(two);
      const settled = jest.fn();
      void late.then(settled);
      await jest.advanceTimersByTimeAsync(limit - 100);
      expect(settled).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(100);
      expect(settled).toHaveBeenCalledWith(refusal);
    } finally {
      jest.useRealTimers();
    }
  });

  it('loads the other tools of a grant that allows no MCP server, until its own deadline', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      tools: ['execute_code', 'web_search'],
      allowTools: ['web_search'],
    });
    const stored = fixture.snapshot.enrollment!;
    fixture.snapshot.enrollment = { ...stored, consents: [] };
    const run = (await fixture.factory.resolve(fixture.identity, 'invoke'))!;
    expect(run.narrow('root', keys)).toEqual(['web_search', 'tool_search']);
    fixture.expire();
    expect(run.grantsTool('root', 'web_search')).toBe(false);
  });

  it('leaves the other tools alone under a grant that limits MCP tools only', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { coversTools: false });
    expect(fixture.execution.narrow('root', keys)).toEqual([
      'query_mcp_warehouse',
      'web_search',
      'execute_code',
      'send_action_mail.example',
      'tool_search',
    ]);
    expect(fixture.execution.grantsTool('root', 'web_search')).toBe(false);
  });

  it('loads no key that stands for a whole server unless the grant lists a tool on it', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const wildcards = [
      'query_mcp_warehouse',
      'sys__all__sys_mcp_warehouse',
      'sys__server__sys_mcp_warehouse',
      'sys__all__sys_mcp_archive',
      'sys__server__sys_mcp_archive',
      'tool_search',
    ];
    // "Every tool" names none of them, so it would define what the owner left out.
    expect(fixture.execution.narrow('root', wildcards)).toEqual([
      'query_mcp_warehouse',
      'sys__server__sys_mcp_warehouse',
      'tool_search',
    ]);
    expect(fixture.execution.narrow('stranger', wildcards)).toEqual(['tool_search']);
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
    expect(narrowGrantedTools(req, 'root', keys)).toBe(keys);
    expect(narrowGrantedTools(undefined, 'root', keys)).toBe(keys);
    await fixture.factory.attach(getMCPRequestContext(req)!, fixture.identity, 'invoke');
    expect(narrowGrantedTools(req, 'root', keys)).toEqual(['query_mcp_warehouse']);
    expect(narrowGrantedTools({}, 'root', keys)).toBe(keys);
  });

  it('loads nothing on a server the delivery was started without, with a grant or with none', async () => {
    const keys = ['query_mcp_warehouse', 'export_mcp_warehouse', 'search_mcp_notes', 'web_search'];
    const without = { skip: ['warehouse'], servers: ['warehouse', 'notes'] };
    // No grant, and no stored grant to read at all: only the skipped server's tools are left out.
    const bare = {};
    const none = await executionFixture();
    (none.storage.readRunGrant as jest.Mock).mockResolvedValueOnce(null);
    expect(
      await none.factory.attach(getMCPRequestContext(bare)!, none.identity, 'invoke', false, {
        without,
      }),
    ).toBe(false);
    expect(narrowGrantedTools(bare, 'root', keys)).toEqual(['search_mcp_notes', 'web_search']);
    // Under a grant, what it leaves out and what was skipped are both left out.
    const fixture = await executionFixture('invoke', readTool, undefined, { offered: ['export'] });
    const req = {};
    await fixture.factory.attach(getMCPRequestContext(req)!, fixture.identity, 'invoke', false, {
      without,
    });
    expect(
      narrowGrantedTools(req, 'root', ['query_mcp_warehouse', 'export_mcp_warehouse']),
    ).toEqual([]);
    // What one request goes without says nothing about another, nor does an empty list.
    const other = {};
    await fixture.factory.attach(getMCPRequestContext(other)!, fixture.identity, 'invoke', false, {
      without: { skip: [], servers: ['warehouse'] },
    });
    expect(narrowGrantedTools(other, 'root', ['query_mcp_warehouse'])).toEqual([
      'query_mcp_warehouse',
    ]);
  });

  it('drops every key on a skipped server, by its name and by its normalized name', () => {
    const keys = [
      'search_mcp_Notion',
      'sys__all__sys_mcp_Notion',
      'sys__server__sys_mcp_Notion',
      'query_mcp_Sales_Force',
      'list_mcp_Linear',
      'execute_code',
      'web_search',
    ];
    expect(
      withoutServers(keys, {
        skip: ['Notion', 'Sales Force'],
        servers: ['Notion', 'Sales Force', 'Linear'],
      }),
    ).toEqual(['list_mcp_Linear', 'execute_code', 'web_search']);
  });

  it('leaves a ready server alone when its name ends with a skipped one', () => {
    expect(
      withoutServers(['query_mcp_bar', 'query_mcp_foo_mcp_bar', 'web_search'], {
        skip: ['bar'],
        servers: ['bar', 'foo_mcp_bar'],
      }),
    ).toEqual(['query_mcp_foo_mcp_bar', 'web_search']);
    // And the other way round: the longer name skipped, the shorter one ready.
    expect(
      withoutServers(['query_mcp_bar', 'query_mcp_foo_mcp_bar'], {
        skip: ['foo_mcp_bar'],
        servers: ['bar', 'foo_mcp_bar'],
      }),
    ).toEqual(['query_mcp_bar']);
  });

  it('hands back the same list when nothing is left out', () => {
    const keys = ['list_mcp_Linear', 'execute_code'];
    expect(withoutServers(keys, { skip: ['Notion'], servers: [] })).toBe(keys);
    expect(withoutServers(keys, { skip: [], servers: ['Linear'] })).toBe(keys);
    expect(withoutServers(keys, undefined)).toBe(keys);
  });
});

describe('a tool the owner approves call by call', () => {
  const use = (
    fixture: Awaited<ReturnType<typeof executionFixture>>,
    extra: { toolCallId?: string; readiness?: true } = {},
    agentId = 'root',
  ) =>
    fixture.invocation(agentId).authorize({
      user: fixture.user,
      serverName: 'warehouse',
      serverConfig: fixture.config,
      toolName: 'query',
      loadTools: async () => catalog(),
      ...extra,
    });
  const refused = { failure: { reason: 'approval_required', automaticReplay: false } };

  it('is refused when the call carries no approval, whatever the run hook did', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, { ask: ['query'] });
    await expect(use(fixture)).rejects.toMatchObject(refused);
    await expect(use(fixture, { toolCallId: 'call-1' })).rejects.toMatchObject(refused);
  });

  it('tells an approval card that the tool is asked about on every use', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['export'],
      allow: ['export', 'query'],
      ask: ['query'],
    });
    const req = {};
    const asks = asksEveryUse(req);
    // Built before the grant is attached, as on a resume, and false for any other request.
    expect(asks(['query_mcp_warehouse'])).toBe(false);
    await fixture.factory.attach(getMCPRequestContext(req)!, fixture.identity, 'invoke');
    expect(asks(['query_mcp_warehouse'])).toBe(true);
    expect(asks(['other_name', 'query_mcp_warehouse'])).toBe(true);
    expect(asks(['export_mcp_warehouse'])).toBe(false);
    expect(asksEveryUse(undefined)(['query_mcp_warehouse'])).toBe(false);
  });

  it('runs the call the owner approved, and only that call', async () => {
    const fixture = await executionFixture('resume', readTool, undefined, {
      ask: ['query'],
      approvedToolCalls: ['call-1'],
    });
    await expect(use(fixture, { toolCallId: 'call-1' })).resolves.toBeUndefined();
    await expect(use(fixture, { toolCallId: 'call-1' }, 'child')).resolves.toBeUndefined();
    await expect(use(fixture, { toolCallId: 'call-2' })).rejects.toMatchObject(refused);
    await expect(use(fixture)).rejects.toMatchObject(refused);
  });

  it('passes a readiness check, which calls nothing', async () => {
    const fixture = await executionFixture('activation', readTool, undefined, { ask: ['query'] });
    await expect(use(fixture, { readiness: true })).resolves.toBeUndefined();
  });

  it('leaves a tool the owner simply allowed alone', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['list'],
      allow: ['list', 'query'],
      ask: ['list'],
    });
    await expect(use(fixture)).resolves.toBeUndefined();
  });

  it('tells the run which tools to pause for, by either spelling of the server', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['list'],
      allow: ['list', 'query'],
      ask: ['query'],
    });
    expect(fixture.execution.mayAsk).toBe(true);
    expect(fixture.execution.asksAbout('root', 'query_mcp_warehouse')).toBe(true);
    expect(fixture.execution.asksAbout('child', 'query_mcp_warehouse')).toBe(true);
    expect(fixture.execution.asksAbout('root', 'list_mcp_warehouse')).toBe(false);
    expect(fixture.execution.asksAbout('other', 'query_mcp_warehouse')).toBe(false);
    expect((await executionFixture()).execution.mayAsk).toBe(false);
  });

  it('pauses the run for it and for nothing else', async () => {
    const fixture = await executionFixture('invoke', readTool, undefined, {
      offered: ['list'],
      allow: ['list', 'query'],
      ask: ['query'],
    });
    const agent = {
      id: 'root',
      toolDefinitions: ['query', 'list', 'write'].map((name) => ({
        name: `${name}_mcp_warehouse`,
        toolType: 'mcp',
        serverName: 'warehouse',
      })),
    };
    const policy = createRunPolicy(fixture.execution, [agent]);
    const decide = (toolName: string, executingAgentId = 'root') =>
      policy.hook(
        { toolName, toolInput: {}, executingAgentId } as Parameters<typeof policy.hook>[0],
        new AbortController().signal,
      );
    expect(await decide('query_mcp_warehouse')).toEqual({
      decision: 'ask',
      reason: SCHEDULE_APPROVAL_REASON,
    });
    expect(await decide('list_mcp_warehouse')).toEqual({});
    expect(await decide('execute_code')).toMatchObject({ decision: 'deny' });
  });
});

it('reads approvals only from a validated resume value', () => {
  expect(
    collectApprovedToolCalls({
      a: { type: 'approve' },
      b: { type: 'edit', updatedInput: {} },
      c: { type: 'reject' },
      d: { type: 'respond', responseText: 'no' },
      e: null,
      f: 'approve',
    }),
  ).toEqual(['a', 'b']);
  for (const value of [undefined, null, 'approve', [{ type: 'approve' }], { answers: {} }])
    expect(collectApprovedToolCalls(value)).toEqual([]);
});
