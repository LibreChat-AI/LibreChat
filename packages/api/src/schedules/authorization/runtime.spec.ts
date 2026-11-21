import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import type { AppConfig, IRole, ISchedule, AgentGraphAccessContext } from '@librechat/data-schemas';
import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import type { ScheduleInput, ScheduleHost } from './subject';
import {
  getScheduleSource,
  restoreExecutionContext,
  createTriggerExecutionContext,
  createScheduleExecutionContext,
} from '~/agents/authority/context';
import { executionFixture, allowOffered, readTool } from '~/agents/authority/execution.helper';
import { bindRunGrantInvocation, narrowGrantedTools } from '~/agents/authority/execution';
import { createMCPRequestContext, getMCPRequestContext } from '~/mcp/request';
import { initializeWithAuthority } from '~/agents/authority/host';
import { RunGrantPolicyError } from '~/agents/authority/policy';
import { scheduleSubject, scheduleExecution } from './subject';
import { captureTrigger } from '~/agents/authority/trigger';
import { createScheduleMCPRuntimeHost } from './runtime';
import { captureScheduleFireContext } from '../trigger';
import { createScheduleMCPPreflight } from '../mcp';

/** Initializes a request under the schedule subject alone, as the chat route does. */
const underSchedule = <T>(
  input: ScheduleInput,
  getHost: () => ScheduleHost,
  initialize: () => Promise<T>,
  retain?: Parameters<typeof scheduleSubject>[1],
): Promise<T> => initializeWithAuthority(input, [scheduleSubject(getHost, retain)], initialize);

async function setup() {
  const fixture = await executionFixture();
  jest.spyOn(Date, 'now').mockReturnValue(1000);
  let candidates = ['query_mcp_warehouse'];
  const config = {
    interfaceConfig: {
      schedules: {
        use: true,
        create: true,
        mcpConsent: {
          enabled: true,
          maxLifetimeHours: 24,
          resources: {
            warehouse: {
              url: 'https://resource.example/mcp',
              credentialMode: 'anonymous',
              issuer: null,
              audience: null,
              scopes: [],
            },
          },
        },
      },
    },
    endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
    mcpConfig: { warehouse: fixture.config },
  } as unknown as AppConfig;
  const row = {
    id: fixture.identity.scheduleId,
    user: fixture.identity.ownerId,
    agent_id: 'root',
    tenantId: 'tenant',
    enabled: true,
    configRevision: 0,
    mcpConsent: fixture.snapshot.enrollment,
  } as unknown as ISchedule;
  const getRoleByName = jest.fn(
    async () =>
      ({
        permissions: {
          [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
        },
      }) as IRole,
  );
  const findUser = jest.fn(async () => fixture.user);
  const getAppConfig = jest.fn(
    async (
      _options?: Parameters<
        Parameters<typeof createScheduleMCPRuntimeHost>[0]['enrollment']['getAppConfig']
      >[0],
    ) => config,
  );
  const getNodes = jest.fn(async (ids: string[]) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: candidates,
      agent_ids: id === 'root' ? ['child'] : [],
    })),
  );
  const getModelsConfig = jest.fn(async () => ({ test: ['test'] }));
  /** Every server the owner can reach. A test adds to it to give the agents a second one. */
  const servers: Record<string, typeof fixture.config> = { warehouse: fixture.config };
  const getServers = jest.fn(async () => servers);
  const resolveGraphAccess = jest.fn(async () => ({}) as AgentGraphAccessContext);
  const getScheduleById = jest.fn(async () => row);
  /** What the occurrence's run row holds: its readiness outcomes. None unless a test sets some. */
  const getScheduleRunMCP = jest.fn(
    async (_scheduleId: string, _scheduledFor: string | Date): Promise<ScheduleMCPOutcome[]> => [],
  );
  /** The same, found by the conversation an occurrence started. */
  const getScheduleConversationMCP = jest.fn(
    async (
      _scope: Pick<typeof fixture.identity, 'scheduleId' | 'ownerId' | 'tenantId'>,
      _conversationId: string,
    ): Promise<ScheduleMCPOutcome[]> => [],
  );
  const getScheduleMCPCompletionState = jest.fn(async () => ({
    identity: fixture.identity,
    enrolled: false,
  }));
  let pausable = true;
  const host = createScheduleMCPRuntimeHost({
    canPauseRuns: async () => pausable,
    getScheduleMCPCompletionState,
    storage: fixture.storage,
    methods: {
      getScheduleById,
      getScheduleRunMCP,
      getScheduleConversationMCP,
    },
    findUser,
    getRoleByName,
    canViewAgent: async () => true,
    enrollment: {
      findUser,
      getAppConfig,
      getModelsConfig,
      ensureConfigServers: async () => ({}),
      getServers,
      getNodes,
      resolveGraphAccess,
      canUseRoot: async () => true,
    },
  });
  // Confirm through the actual shipped resolver, not the synthetic fixture's resolver.
  fixture.snapshot.enrollment = null;
  const offer = await host.consent.service.view(fixture.identity);
  await host.consent.service.confirm(fixture.identity, {
    offerDigest: offer.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
    allow: allowOffered(offer.targets),
  });
  row.mcpConsent = fixture.snapshot.enrollment!;
  const connect = jest.fn(async () => ({
    fetchToolsSnapshot: async () => ({ tools: [readTool], complete: true }),
  }));
  const preflight = createScheduleMCPPreflight({
    getRoleByName,
    getUser: findUser,
    getAppConfig,
    getModelsConfig,
    getAgentGraphNodes: getNodes,
    resolveAgentGraphAccess: resolveGraphAccess,
    getServerConfigs: getServers,
    ensureConfigServers: async () => servers,
    findPluginAuthsByKeys: async () => [],
    connect,
    execution: host.execution,
  });
  /** As the chat controller does, build the context once from the verified trigger. */
  const { resolve, restore } = host;
  const verified = (input: ScheduleInput): ScheduleInput => ({
    executionContext: createScheduleExecutionContext(input.req),
    ...input,
  });
  host.resolve = (input) => resolve(verified(input));
  host.restore = (input, found) => restore(verified(input), found);
  const context = createMCPRequestContext();
  const req = {
    user: fixture.user,
    _isScheduledFire: true,
    _isAgentTrigger: true,
    body: {
      agent_id: 'root',
      agentTrigger: {
        version: 1,
        event: {
          type: 'schedule.occurrence',
          occurredAt: 1000,
          source: { type: 'schedule', id: 'schedule' },
        },
      },
    },
  };
  return {
    ...fixture,
    row,
    config,
    serverConfig: fixture.config,
    host,
    context,
    req,
    preflight,
    connect,
    getRoleByName,
    findUser,
    getAppConfig,
    getScheduleById,
    getScheduleRunMCP,
    getScheduleConversationMCP,
    getScheduleMCPCompletionState,
    servers,
    setCandidates: (names: string[]) => {
      candidates = names;
    },
    cannotPause: () => {
      pausable = false;
    },
    check: () =>
      preflight('root', fixture.user, {
        scheduleId: 'schedule',
        stage: 'activation',
        concurrency: 3,
      }),
  };
}

afterEach(() => jest.restoreAllMocks());

it('uses the same real enrollment policy at readiness, root, and child invocation', async () => {
  const f = await setup();
  await expect(f.check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
  await f.host.prepare({ req: f.req, context: f.context });
  expect(scheduleExecution(f.context)?.identity).toEqual(f.identity);
  for (const agentId of ['root', 'child']) {
    await expect(
      bindRunGrantInvocation(f.context, agentId, 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      }),
    ).resolves.toBeUndefined();
  }
});

it('does not refuse a run because its agent also has tools that are not MCP tools', async () => {
  const f = await setup();
  f.setCandidates(['query_mcp_warehouse', 'write_action_api', 'execute_code']);
  await expect(f.check()).resolves.toBeDefined();
});

it.each([[], ['execute_code']].map((tools) => ({ tools })))(
  'has nothing to make ready, and connects to nothing, for a run that selects no MCP tool: %s',
  async ({ tools }) => {
    const f = await setup();
    f.setCandidates(tools);
    // A grant may allow the agents' other tools and no MCP tool at all.
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  },
);

it('returns a structured unsupported-version denial and never probes the provider', async () => {
  const f = await setup();
  f.snapshot.compatible = false;
  await expect(f.check()).rejects.toMatchObject({
    outcomes: [expect.objectContaining({ reason: 'binding_mismatch' })],
  });
  expect(f.connect).not.toHaveBeenCalled();
});

it("refuses a resumed run whose saved job was restored for someone other than the request's user", async () => {
  const f = await setup();
  const other = { id: 'intruder', tenantId: 'tenant' };
  const req = { user: f.user, _isScheduledFire: true, body: {} };
  jest.mocked(f.storage.readRunGrant).mockClear();
  await expect(
    f.host.prepare({
      req,
      context: f.context,
      restoredJob: { scheduleId: 'schedule' },
      // A context restored from a job another user owns, on a request the owner authenticated.
      executionContext: restoreExecutionContext(
        { user: other },
        { userId: 'intruder', tenantId: 'tenant', scheduleId: 'schedule', agent_id: 'root' },
      ),
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(f.storage.readRunGrant).not.toHaveBeenCalled();
});

it('puts back on a resumed run the servers its occurrence went without, read from its run row', async () => {
  const f = await setup();
  f.getScheduleRunMCP.mockResolvedValue([
    { server: 'notes', status: 'mcp_reauth_required', skipped: true },
    { server: 'warehouse', status: 'ready' },
  ]);
  const scheduledFor = '2026-09-09T12:00:00.000Z';
  const req: {
    user: typeof f.user;
    _isScheduledFire: boolean;
    body: Record<string, unknown>;
    _scheduleSkippedServers?: string[];
    _scheduleCheckedServers?: string[];
  } = { user: f.user, _isScheduledFire: true, body: {} };
  await f.host.prepare({
    req,
    // The request's own context, as the chat route passes it: tools are narrowed through it.
    context: getMCPRequestContext(req)!,
    restoredJob: { scheduleId: 'schedule', scheduledFor },
    executionContext: restoreExecutionContext(req, {
      userId: 'owner',
      tenantId: 'tenant',
      scheduleId: 'schedule',
      agent_id: 'root',
    }),
  });
  expect(f.getScheduleRunMCP).toHaveBeenCalledWith('schedule', scheduledFor);
  expect(req._scheduleSkippedServers).toEqual(['notes']);
  expect(req._scheduleCheckedServers).toEqual(['notes', 'warehouse']);
  // The resumed run then loads nothing on that server.
  expect(narrowGrantedTools(req, 'root', ['search_mcp_notes', 'query_mcp_warehouse'])).toEqual([
    'query_mcp_warehouse',
  ]);
});

it('reads no run row for a fresh occurrence, whose trigger already says what it goes without', async () => {
  const f = await setup();
  await f.host.prepare({ req: f.req, context: f.context });
  expect(f.getScheduleRunMCP).not.toHaveBeenCalled();
});

describe('a server the grant allows and the occurrence went without', () => {
  const keys = ['query_mcp_warehouse', 'web_search'];

  it('is not loaded by a fresh occurrence, which hands its trigger’s lists to the grant', async () => {
    const f = await setup();
    // With nothing skipped the grant loads the tool: what follows is the skip list alone.
    const ready = { ...f.req };
    await f.host.prepare({ req: ready, context: getMCPRequestContext(ready)! });
    expect(narrowGrantedTools(ready, 'root', keys)).toEqual(['query_mcp_warehouse']);
    const req = { ...f.req, body: structuredClone(f.req.body) };
    Object.assign(req.body.agentTrigger, {
      metadata: { skip: ['warehouse'], servers: ['warehouse', 'notes'] },
    });
    // As the chat route does before the run host is asked.
    captureScheduleFireContext(req);
    await f.host.prepare({ req, context: getMCPRequestContext(req)! });
    expect(narrowGrantedTools(req, 'root', keys)).toEqual([]);
  });

  it('is not loaded by the resumed run either, which reads the lists from its run row', async () => {
    const f = await setup();
    f.getScheduleRunMCP.mockResolvedValue([
      { server: 'warehouse', status: 'mcp_reauth_required', skipped: true },
      { server: 'notes', status: 'ready' },
    ]);
    const req = { user: f.user, _isScheduledFire: true, body: {} };
    await f.host.prepare({
      req,
      context: getMCPRequestContext(req)!,
      restoredJob: { scheduleId: 'schedule', scheduledFor: '2026-09-09T12:00:00.000Z' },
      executionContext: restoreExecutionContext(req, {
        userId: 'owner',
        tenantId: 'tenant',
        scheduleId: 'schedule',
        agent_id: 'root',
      }),
    });
    expect(narrowGrantedTools(req, 'root', keys)).toEqual([]);
  });
});

describe('a turn that reports on a task a scheduled run started', () => {
  type Marked = { _scheduleSkippedServers?: string[]; _scheduleCheckedServers?: string[] };
  /** As the signed host delivers it: in the conversation the occurrence started. */
  const completionRequest = (f: Awaited<ReturnType<typeof setup>>, origin = true) => ({
    ...f.req,
    _isScheduledFire: false,
    body: {
      conversationId: 'occurrence-conversation',
      agent_id: 'root',
      agentCompletion: {
        version: 1,
        sourceId: 'background-tool-completion',
        ...(origin && { scheduleMCPIdentity: f.identity }),
      },
    },
  });
  const wentWithout = (server: string): ScheduleMCPOutcome[] => [
    { server, status: 'mcp_reauth_required', skipped: true },
    { server: 'ledger', status: 'ready' },
  ];

  it.each([
    { name: 'under the grant its schedule holds', grant: true },
    { name: 'with no grant', grant: false },
  ])('goes without the servers its occurrence went without, $name', async ({ grant }) => {
    const f = await setup();
    if (!grant) {
      f.snapshot.enrollment = null;
      f.row.mcpConsent = undefined;
    }
    f.getScheduleConversationMCP.mockResolvedValue(wentWithout('warehouse'));
    const req: ReturnType<typeof completionRequest> & Marked = completionRequest(f);
    const keys = ['query_mcp_warehouse', 'post_mcp_ledger'];
    await f.host.prepare({ req, context: getMCPRequestContext(req)! });
    expect(f.getScheduleConversationMCP).toHaveBeenCalledWith(
      expect.objectContaining({
        scheduleId: f.identity.scheduleId,
        ownerId: f.identity.ownerId,
        tenantId: f.identity.tenantId,
      }),
      'occurrence-conversation',
    );
    expect(req._scheduleSkippedServers).toEqual(['warehouse']);
    expect(req._scheduleCheckedServers).toEqual(['warehouse', 'ledger']);
    expect(narrowGrantedTools(req, 'root', keys)).not.toContain('query_mcp_warehouse');
  });

  it('loads what it would have without that record: the grant alone decides', async () => {
    const f = await setup();
    const req: ReturnType<typeof completionRequest> & Marked = completionRequest(f);
    await f.host.prepare({ req, context: f.context });
    expect(req._scheduleSkippedServers).toBeUndefined();
    expect(narrowGrantedTools(req, 'root', ['query_mcp_warehouse'])).toEqual([
      'query_mcp_warehouse',
    ]);
  });

  it('reads the conversation from the saved job when the turn is resumed, not from the request', async () => {
    const f = await setup();
    f.getScheduleConversationMCP.mockResolvedValue(wentWithout('warehouse'));
    const req: Marked & { user: typeof f.user; body: Record<string, unknown> } = {
      user: f.user,
      body: { conversationId: 'another-conversation' },
    };
    await f.host.prepare({
      req,
      context: f.context,
      restoredJob: { scheduleMCPCompletion: f.identity, conversationId: 'occurrence-conversation' },
    });
    expect(f.getScheduleConversationMCP).toHaveBeenCalledTimes(1);
    expect(f.getScheduleConversationMCP).toHaveBeenCalledWith(
      expect.objectContaining({ scheduleId: f.identity.scheduleId }),
      'occurrence-conversation',
    );
    expect(req._scheduleSkippedServers).toEqual(['warehouse']);
  });

  it('is prepared as it always was when its context also names the schedule and where the task began', async () => {
    const prepared = async (kept: boolean) => {
      const f = await setup();
      const req = completionRequest(f);
      Object.assign(req.body, {
        clientRequestId: 'trigger_wake',
        agentEvent: {
          id: 'task-1',
          type: 'background_tool.completed',
          occurredAt: 2_000,
          source: { type: 'internal', id: 'background-tool-completion' },
        },
      });
      // What the task kept of the occurrence that started it, handed back by the trigger host.
      if (kept)
        Object.assign(req.body.agentCompletion, {
          trigger: captureTrigger(createTriggerExecutionContext(f.req)),
        });
      const executionContext = createTriggerExecutionContext(req);
      await f.host.prepare({ req, context: f.context, executionContext });
      const execution = scheduleExecution(f.context);
      return {
        executionContext,
        execution: {
          identity: execution?.identity,
          stage: execution?.stage,
          enrolled: execution?.enrolled,
          completion: execution?.completion,
          manual: execution?.manual,
        },
        loaded: narrowGrantedTools(req, 'root', ['query_mcp_warehouse', 'post_mcp_ledger']),
        lookups: f.getScheduleMCPCompletionState.mock.calls,
      };
    };
    const before = await prepared(false);
    const after = await prepared(true);

    expect(after.execution).toEqual(before.execution);
    expect(after.execution).toMatchObject({
      identity: { scheduleId: 'schedule', agentId: 'root' },
      stage: 'invoke',
      completion: true,
    });
    expect(after.loaded).toEqual(before.loaded);
    expect(after.lookups).toEqual(before.lookups);
    expect(before.executionContext?.source).not.toHaveProperty('subject');
    expect(after.executionContext?.source).toMatchObject({
      subject: { kind: 'schedule', id: 'schedule' },
      origin: { agentId: 'root' },
    });
    // The turn acts for the schedule and is still not its occurrence.
    expect(getScheduleSource(after.executionContext)).toBeUndefined();
  });

  it('reads no run for a turn whose task no schedule started', async () => {
    const f = await setup();
    await f.host.prepare({ req: completionRequest(f, false), context: f.context });
    expect(f.getScheduleConversationMCP).not.toHaveBeenCalled();
  });
});

it('rebuilds the protected root on resume and refuses revoked consent even after approval', async () => {
  const f = await setup();
  const req = { user: f.user, _isScheduledFire: true, body: {} };
  await f.host.prepare({
    req,
    context: f.context,
    executionContext: restoreExecutionContext(req, {
      userId: 'owner',
      tenantId: 'tenant',
      scheduleId: 'schedule',
      agent_id: 'root',
    }),
  });
  expect(scheduleExecution(f.context)?.stage).toBe('resume');
  await f.host.consent.service.revoke(f.identity, f.snapshot.enrollment!.revision);
  await expect(
    bindRunGrantInvocation(f.context, 'child', 'query')!.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: { type: 'streamable-http', url: 'https://resource.example/mcp' },
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    }),
  ).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
});

it('never grants enrolled legacy resumes lacking trusted root metadata', async () => {
  const f = await setup();
  await expect(
    f.host.prepare({
      req: { user: f.user, _isScheduledFire: true, body: { agent_id: 'root' } },
      context: f.context,
      restoredJob: { scheduleId: 'schedule' },
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  f.row.mcpConsent = undefined;
  f.snapshot.enrollment = null;
  await expect(
    f.host.prepare({
      req: { user: f.user, _isScheduledFire: true, body: {} },
      context: f.context,
      restoredJob: { scheduleId: 'schedule' },
    }),
  ).resolves.toBeUndefined();
  expect(scheduleExecution(f.context)).toMatchObject({ enrolled: false });
});

it('ignores spoofed body fields on ordinary chat and refuses cross-tenant triggers', async () => {
  const f = await setup();
  await f.host.prepare({
    req: { ...f.req, _isScheduledFire: false, _isAgentTrigger: false },
    context: f.context,
  });
  expect(scheduleExecution(f.context)).toBeUndefined();
  const user = Object.assign(structuredClone(f.user), { tenantId: 'other' });
  await expect(
    f.host.prepare({ req: { ...f.req, user }, context: f.context }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it('keeps live role denial fail-closed for enrolled schedules', async () => {
  const f = await setup();
  f.getRoleByName.mockResolvedValue({ permissions: {} } as IRole);
  await expect(f.check()).rejects.toMatchObject({ code: 'mcp_permission_denied' });
});

it('does not construct the host for ordinary chats', async () => {
  const f = await setup();
  const getHost = jest.fn(() => f.host);
  const initialize = jest.fn().mockResolvedValue(undefined);
  await underSchedule(
    { req: { ...f.req, _isScheduledFire: false, _isAgentTrigger: false }, context: f.context },
    getHost,
    initialize,
  );
  expect(getHost).not.toHaveBeenCalled();
  expect(initialize).toHaveBeenCalledTimes(1);
});

it('does not downgrade if enrollment disappears during run preparation', async () => {
  const f = await setup();
  f.snapshot.enrollment = null;
  await expect(f.host.prepare({ req: f.req, context: f.context })).rejects.toMatchObject({
    failure: { reason: 'consent_missing' },
  });
});

it.each([null, false, 0, ''])(
  'does not downgrade malformed stored consent %s to legacy execution',
  async (value) => {
    const f = await setup();
    Reflect.set(f.row, 'mcpConsent', value);
    f.snapshot.enrollment = null;
    f.snapshot.compatible = false;
    await expect(f.host.prepare({ req: f.req, context: f.context })).rejects.toMatchObject({
      failure: { reason: 'binding_mismatch' },
    });
    expect(scheduleExecution(f.context)).toBeUndefined();
  },
);

it('loads one fresh principal and configuration pair per authorization, not per phase', async () => {
  const f = await setup();
  await f.host.prepare({ req: f.req, context: f.context });
  const call = () =>
    bindRunGrantInvocation(f.context, 'root', 'query')!.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.serverConfig,
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    });
  for (let round = 0; round < 2; round++) {
    f.findUser.mockClear();
    f.getAppConfig.mockClear();
    await call();
    expect(f.findUser).toHaveBeenCalledTimes(1);
    expect(f.getAppConfig).toHaveBeenCalledTimes(2);
    expect(f.getAppConfig).toHaveBeenCalledWith({ baseOnly: true, failClosed: true });
    expect(f.getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', failClosed: true }),
    );
  }
  f.getRoleByName.mockResolvedValue({ permissions: {} } as IRole);
  await expect(call()).rejects.toMatchObject({ failure: { reason: 'rbac_denied' } });
});

it('reuses the captured configuration and preserves the global stop on later calls', async () => {
  const f = await setup();
  await f.host.prepare({ req: f.req, context: f.context });
  const call = () =>
    bindRunGrantInvocation(f.context, 'child', 'query')!.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.serverConfig,
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    });
  await call();
  f.getAppConfig.mockImplementation(async (options) =>
    options?.baseOnly
      ? ({ ...f.config, interfaceConfig: { schedules: false } } as AppConfig)
      : f.config,
  );
  await expect(call()).rejects.toMatchObject({ failure: { reason: 'provider_missing' } });
});

it('does not share an authority snapshot across concurrent attempts', async () => {
  const f = await setup();
  await f.host.prepare({ req: f.req, context: f.context });
  f.findUser.mockClear();
  f.getAppConfig.mockClear();
  const call = (agentId: string) =>
    bindRunGrantInvocation(f.context, agentId, 'query')!.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.serverConfig,
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    });
  await Promise.all([call('root'), call('child')]);
  expect(f.findUser).toHaveBeenCalledTimes(2);
  expect(f.getAppConfig).toHaveBeenCalledTimes(4);
});

it.each([false, true])(
  'allows a paused enrolled manual run at readiness and execution, restored=%s',
  async (restored) => {
    const f = await setup();
    f.row.enabled = false;
    f.snapshot.enabled = false;
    await expect(
      f.preflight('root', f.user, { scheduleId: 'schedule', manual: true, concurrency: 2 }),
    ).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    await expect(
      f.preflight('root', f.user, { scheduleId: 'schedule', concurrency: 2 }),
    ).rejects.toMatchObject({
      outcomes: [expect.objectContaining({ reason: 'binding_mismatch' })],
    });
    const trigger = structuredClone(f.req);
    const manualReq = {
      ...trigger,
      body: {
        ...trigger.body,
        agentTrigger: { ...trigger.body.agentTrigger, metadata: { manual: true } },
      },
    };
    await f.host.prepare(
      restored
        ? {
            req: { user: f.user, _isScheduledFire: true, body: { manual: false } },
            context: f.context,
            executionContext: restoreExecutionContext(
              { user: f.user },
              { userId: 'owner', tenantId: 'tenant', scheduleId: 'schedule', agent_id: 'root' },
            ),
            restoredJob: { scheduleId: 'schedule', scheduleManual: true },
          }
        : { req: manualReq, context: f.context },
    );
    const call = () =>
      bindRunGrantInvocation(f.context, 'child', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    await expect(call()).resolves.toBeUndefined();
    expect(f.storage.admitRunGrant).toHaveBeenLastCalledWith(
      expect.objectContaining({ requireEnabled: false }),
    );
    await f.host.consent.service.revoke(f.identity, f.snapshot.enrollment!.revision);
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
    expect(f.row.enabled).toBe(false);
  },
);

it('does not elevate automatic paused runs from body or mutable request flags', async () => {
  const f = await setup();
  f.row.enabled = false;
  f.snapshot.enabled = false;
  const req = {
    ...f.req,
    _isManualScheduledFire: true,
    body: { ...f.req.body, manual: true, scheduleManual: true },
  };
  await f.host.prepare({ req, context: f.context });
  await expect(
    bindRunGrantInvocation(f.context, 'root', 'query')!.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.serverConfig,
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it.each(['expire', 'deny'] as const)('manual invocation still denies %s', async (mutation) => {
  const f = await executionFixture();
  f.snapshot.enabled = false;
  const execution = (await f.factory.resolve(f.identity, 'invoke', { manual: true }))!;
  f[mutation]();
  await expect(
    execution.bind('root', 'query').authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.config,
      toolName: 'query',
      loadTools: async () => ({ tools: [readTool], complete: true }),
    }),
  ).rejects.toMatchObject({
    failure: { reason: mutation === 'expire' ? 'consent_expired' : 'rbac_denied' },
  });
});

it('attaches a legacy monitor without minting a grant and fences its next tool after confirmation', async () => {
  const f = await setup();
  f.snapshot.enrollment = null;
  f.row.mcpConsent = undefined;
  await f.host.prepare({ req: f.req, context: f.context });
  const execution = scheduleExecution(f.context)!;
  expect(execution.enrolled).toBe(false);
  const guard = bindRunGrantInvocation(f.context, 'root', 'write')!;
  const call = () =>
    guard.authorize({
      user: f.user,
      serverName: 'warehouse',
      serverConfig: f.serverConfig,
      toolName: 'write',
      loadTools: async () => ({ tools: [], complete: true }),
    });
  await expect(call()).resolves.toBeUndefined();
  const offer = await f.host.consent.service.view(f.identity);
  await f.host.consent.service.confirm(f.identity, {
    offerDigest: offer.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
    allow: allowOffered(offer.targets),
  });
  await expect(call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it.each(['schedule', 'consent', 'completion'] as const)(
  'sanitizes %s preparation failures before tool initialization',
  async (phase) => {
    const f = await setup();
    const privateError = new Error('PRIVATE database authorization query');
    if (phase === 'schedule') f.getScheduleById.mockRejectedValue(privateError);
    if (phase === 'consent') jest.mocked(f.storage.readRunGrant).mockRejectedValue(privateError);
    if (phase === 'completion') f.getScheduleMCPCompletionState.mockRejectedValue(privateError);
    const req =
      phase === 'completion'
        ? {
            ...f.req,
            _isScheduledFire: false,
            body: {
              conversationId: 'completion',
              agent_id: 'root',
              agentCompletion: {
                version: 1,
                sourceId: 'subagent-completion',
                scheduleMCPIdentity: f.identity,
              },
            },
          }
        : f.req;
    const initialize = jest.fn();
    for (const call of [
      () => f.host.prepare({ req, context: f.context }),
      () => underSchedule({ req, context: f.context }, () => f.host, initialize),
    ]) {
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
      });
      expect(String(failure)).not.toContain('PRIVATE');
      expect(failure).not.toHaveProperty('cause');
    }
    expect(initialize).not.toHaveBeenCalled();
  },
);

it('sanitizes consent attachment failures on authenticated completion approval resumes', async () => {
  const f = await setup();
  jest.mocked(f.storage.readRunGrant).mockRejectedValue(new Error('PRIVATE consent query'));
  const initialize = jest.fn();
  await expect(
    underSchedule(
      {
        req: { ...f.req, _isAgentTrigger: false, _isScheduledFire: false },
        context: f.context,
        restoredJob: { scheduleMCPCompletion: f.identity },
      },
      () => f.host,
      initialize,
    ),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
  expect(initialize).not.toHaveBeenCalled();
});

it('sanitizes host construction and lineage-retention failures without masking provider initialization', async () => {
  const f = await setup();
  const privateError = new Error('PRIVATE dependency details');
  const initialize = jest.fn();
  const getHost = () => {
    throw privateError;
  };
  await expect(
    underSchedule({ req: f.req, context: f.context }, getHost, initialize),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
  f.snapshot.enrollment = null;
  f.row.mcpConsent = undefined;
  const req = {
    ...f.req,
    _isScheduledFire: false,
    body: {
      conversationId: 'completion',
      agent_id: 'child',
      agentCompletion: {
        version: 1,
        sourceId: 'subagent-completion',
        scheduleMCPIdentity: f.identity,
      },
    },
  };
  await expect(
    underSchedule(
      { req, context: f.context },
      () => f.host,
      initialize,
      async () => {
        throw privateError;
      },
    ),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
  expect(initialize).not.toHaveBeenCalled();
  await expect(
    underSchedule(
      { req, context: f.context },
      () => f.host,
      async () => {
        throw privateError;
      },
      async () => {},
    ),
  ).rejects.toBe(privateError);
});

it('preserves typed denials and owned cancellation at the preparation boundary', async () => {
  const f = await setup();
  const controller = new AbortController();
  const typed = new RunGrantPolicyError('rbac_denied', 'warehouse', 'root');
  f.getScheduleById.mockRejectedValue(typed);
  await expect(f.host.prepare({ req: f.req, context: f.context })).rejects.toBe(typed);
  const stop = new Error('Owner stopped');
  f.getScheduleById.mockImplementation(async () => {
    controller.abort(stop);
    throw stop;
  });
  await expect(
    underSchedule(
      { req: f.req, context: f.context, signal: controller.signal },
      () => f.host,
      jest.fn(),
    ),
  ).rejects.toBe(stop);
  const other = new Error('PRIVATE non-abort');
  const otherController = new AbortController();
  f.getScheduleById.mockImplementation(async () => {
    otherController.abort(stop);
    throw other;
  });
  await expect(
    underSchedule(
      { req: f.req, context: f.context, signal: otherController.signal },
      () => f.host,
      jest.fn(),
    ),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
});

describe('a grant for only some of what the agents select', () => {
  /** The agents select `query` and `export`; the owner allows `query`. */
  async function partial() {
    const f = await setup();
    f.setCandidates(['query_mcp_warehouse', 'export_mcp_warehouse']);
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    return f;
  }

  it('is ready to run, and still refuses the tool the owner left out when it is called', async () => {
    const f = await partial();
    await expect(f.check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    await f.host.prepare({ req: f.req, context: f.context });
    const call = (tool: string) =>
      bindRunGrantInvocation(f.context, 'root', tool)!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: tool,
        loadTools: async () => ({ tools: [{ ...readTool, name: tool }], complete: true }),
      });
    await expect(call('query')).resolves.toBeUndefined();
    await expect(call('export')).rejects.toMatchObject({
      failure: { reason: 'tool_policy_denied' },
    });
  });

  it('does not connect to a server the owner left out of the grant', async () => {
    const f = await setup();
    const archive = { type: 'streamable-http' as const, url: 'https://archive.example/mcp' };
    f.servers.archive = archive;
    Object.assign(f.config.mcpConfig as object, { archive });
    const consent = (f.config.interfaceConfig!.schedules as { mcpConsent: { resources: object } })
      .mcpConsent;
    Object.assign(consent.resources, {
      archive: {
        url: archive.url,
        credentialMode: 'anonymous',
        issuer: null,
        audience: null,
        scopes: [],
      },
    });
    f.setCandidates(['query_mcp_warehouse', 'purge_mcp_archive']);
    const offer = await f.host.consent.service.view(f.identity);
    expect(offer.targets.map((target) => target.resource.serverName)).toEqual([
      'archive',
      'warehouse',
    ]);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    f.connect.mockClear();
    await expect(f.check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'warehouse' }));
  });

  it('has nothing to make ready once the agents select no MCP tool the owner allowed', async () => {
    const f = await partial();
    f.setCandidates(['export_mcp_warehouse']);
    f.connect.mockClear();
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
    // The tool left out is still refused where it is called.
    await f.host.prepare({ req: f.req, context: f.context });
    await expect(
      bindRunGrantInvocation(f.context, 'root', 'export')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'export',
        loadTools: async () => ({ tools: [{ ...readTool, name: 'export' }], complete: true }),
      }),
    ).rejects.toMatchObject({ failure: { reason: 'tool_policy_denied' } });
  });

  it('is ready to run when the owner allowed another tool and none of the MCP tools', async () => {
    const f = await setup();
    f.setCandidates(['web_search', 'query_mcp_warehouse']);
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: {},
      tools: ['web_search'],
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    expect(f.row.mcpConsent.consents).toEqual([]);
    f.connect.mockClear();
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe('an owner whose role may not use MCP servers', () => {
  const role = {
    permissions: {
      [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
    },
  } as IRole;

  it('authorizes the other tools of a schedule, and is offered no MCP tool', async () => {
    const f = await setup();
    f.snapshot.enrollment = null;
    f.row.mcpConsent = undefined;
    f.getRoleByName.mockResolvedValue(role);
    f.setCandidates(['web_search', 'query_mcp_warehouse']);
    const offer = await f.host.consent.service.view(f.identity);
    expect(offer).toMatchObject({ targets: [], tools: { offered: ['web_search'] } });
    const confirm = (choice: { allow: Record<string, string[]>; tools?: string[] }) =>
      f.host.consent.service.confirm(f.identity, {
        offerDigest: offer.offer!.digest,
        expectedRevision: offer.revision,
        lifetimeHours: 1,
        ...choice,
      });
    await expect(confirm({ allow: { warehouse: ['query'] } })).rejects.toMatchObject({
      code: 'consent_invalid',
    });
    await expect(confirm({ allow: {}, tools: ['web_search'] })).resolves.toMatchObject({
      state: 'active',
      tools: { allowed: ['web_search'] },
    });
    expect(f.snapshot.enrollment).toMatchObject({ consents: [] });
    // And the schedule runs: the MCP tool it selects is not one the grant allows.
    f.row.mcpConsent = f.snapshot.enrollment!;
    f.connect.mockClear();
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('is refused an MCP tool it was granted while it could use them', async () => {
    const f = await setup();
    await f.host.prepare({ req: f.req, context: f.context });
    const call = () =>
      bindRunGrantInvocation(f.context, 'root', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    await expect(call()).resolves.toBeUndefined();
    f.getRoleByName.mockResolvedValue(role);
    await expect(call()).rejects.toMatchObject({ failure: { reason: 'rbac_denied' } });
    // Nor is the schedule ready to run with it, and nothing is connected to find that out.
    f.connect.mockClear();
    await expect(f.check()).rejects.toMatchObject({
      code: 'mcp_permission_denied',
      outcomes: expect.arrayContaining([
        expect.objectContaining({ server: 'warehouse', status: 'mcp_permission_denied' }),
      ]),
    });
    expect(f.connect).not.toHaveBeenCalled();
  });
});

describe('a schedule authorized for the whole agent', () => {
  /** The agents use a declared server, one the operator never declared, and another tool. */
  async function whole() {
    const f = await setup();
    const archive = { type: 'streamable-http' as const, url: 'https://archive.example/mcp' };
    f.servers.archive = archive;
    Object.assign(f.config.mcpConfig as object, { archive });
    f.snapshot.enrollment = null;
    f.setCandidates(['query_mcp_warehouse', 'query_mcp_archive', 'web_search']);
    const offer = await f.host.consent.service.view(f.identity);
    // Only the declared server can be listed. The grant is not limited to what is listed.
    expect(offer.targets.map((target) => target.resource.serverName)).toEqual(['warehouse']);
    expect(offer.offer).toMatchObject({ everything: true });
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: {},
      everything: true,
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    f.connect.mockClear();
    return { ...f, archive };
  }

  it('is ready on every server its agents use, declared or not', async () => {
    const f = await whole();
    await expect(f.check()).resolves.toEqual(
      expect.arrayContaining([
        { server: 'warehouse', status: 'ready' },
        { server: 'archive', status: 'ready' },
      ]),
    );
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'archive' }));
  });

  it('is ready on both while it is being created, with nothing stored yet', async () => {
    const f = await whole();
    const grant = f.snapshot.enrollment!;
    jest.mocked(f.storage.readRunGrant).mockResolvedValue(null);
    await expect(
      f.preflight('root', f.user, {
        scheduleId: 'sched_new',
        stage: 'activation',
        concurrency: 3,
        grant,
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        { server: 'warehouse', status: 'ready' },
        { server: 'archive', status: 'ready' },
      ]),
    );
  });

  it('makes ready a server its agents select as a whole, which a listed grant leaves out', async () => {
    const f = await setup();
    f.snapshot.enrollment = null;
    f.setCandidates(['sys__all__sys_mcp_warehouse', 'web_search']);
    const confirm = async (choice: object) => {
      const offer = await f.host.consent.service.view(f.identity);
      await f.host.consent.service.confirm(f.identity, {
        offerDigest: offer.offer!.digest,
        expectedRevision: offer.revision,
        lifetimeHours: 1,
        allow: {},
        ...choice,
      });
      f.row.mcpConsent = f.snapshot.enrollment!;
      f.connect.mockClear();
    };
    await confirm({ everything: true });
    await expect(f.check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'warehouse' }));
    // A server that is not there is reported, not passed over.
    f.connect.mockRejectedValueOnce(new Error('down'));
    await expect(f.check()).rejects.toMatchObject({ code: 'mcp_unavailable' });
    // A grant that lists its tools names none on that server: nothing to make ready.
    await confirm({ tools: ['web_search'] });
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('reports the grant as changed once a server it was made for is at another address', async () => {
    const f = await whole();
    expect((await f.host.consent.service.view(f.identity)).state).toBe('active');
    // The server moved and the operator's declaration did not follow.
    f.servers.warehouse = { ...f.servers.warehouse, url: 'https://moved.example/mcp' } as never;
    expect((await f.host.consent.service.view(f.identity)).state).toBe('changed');
  });

  it('runs with every tool, and calls both servers', async () => {
    const f = await whole();
    await f.host.prepare({ req: f.req, context: f.context });
    const keys = ['query_mcp_warehouse', 'query_mcp_archive', 'web_search', 'execute_code'];
    expect(scheduleExecution(f.context)!.narrow('root', keys)).toEqual(keys);
    const call = (serverName: string, tool: string, serverConfig: object) =>
      bindRunGrantInvocation(f.context, 'root', tool)!.authorize({
        user: f.user,
        serverName,
        serverConfig: serverConfig as typeof f.serverConfig,
        toolName: tool,
        loadTools: async () => ({ tools: [{ ...readTool, name: tool }], complete: true }),
      });
    await expect(call('warehouse', 'query', f.serverConfig)).resolves.toBeUndefined();
    await expect(call('archive', 'query', f.archive)).resolves.toBeUndefined();
    // The owner takes it back: nothing is called on either.
    await f.host.consent.service.revoke(f.identity, f.snapshot.enrollment!.revision);
    await expect(call('archive', 'query', f.archive)).rejects.toMatchObject({
      failure: { reason: 'consent_revoked' },
    });
    await expect(call('warehouse', 'query', f.serverConfig)).rejects.toMatchObject({
      failure: { reason: 'consent_revoked' },
    });
  });
});

describe('a schedule being edited with a new grant', () => {
  it('is checked against the grant the edit carries, not the one it replaces', async () => {
    const f = await setup();
    f.setCandidates(['web_search', 'query_mcp_warehouse']);
    const view = await f.host.consent.service.view(f.identity);
    // The stored grant allows the MCP tool. The edit comes with one that allows only the other.
    const { enrollment: grant } = await f.host.consent.service.renew(
      f.identity,
      {
        offerDigest: view.offer!.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: {},
        tools: ['web_search'],
      },
      1,
    );
    expect(grant).toMatchObject({ scheduleRevision: 1, consents: [] });
    f.connect.mockClear();
    const options = { scheduleId: 'schedule', stage: 'activation' as const, concurrency: 3 };
    await expect(f.preflight('root', f.user, { ...options, grant })).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(f.preflight('root', f.user, options)).resolves.toEqual([
      { server: 'warehouse', status: 'ready' },
    ]);
  });
});

describe('a grant that lists a tool on a server the operator did not declare', () => {
  it('offers it by its key, makes only that server ready, loads it and calls it', async () => {
    const f = await setup();
    const archive = { type: 'streamable-http' as const, url: 'https://archive.example/mcp' };
    f.servers.archive = archive;
    Object.assign(f.config.mcpConfig as object, { archive });
    f.snapshot.enrollment = null;
    f.setCandidates(['query_mcp_warehouse', 'query_mcp_archive']);
    const offer = await f.host.consent.service.view(f.identity);
    // The declared server is a target with a recipient. The other has none: it is a tool key.
    expect(offer.targets.map((target) => target.resource.serverName)).toEqual(['warehouse']);
    expect(offer.tools.offered).toEqual(['query_mcp_archive']);
    // With the servers in use, so the dialog can tell a tool's name from its server's.
    expect(offer.tools.servers).toEqual(['archive', 'warehouse']);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: {},
      tools: ['query_mcp_archive'],
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    f.connect.mockClear();
    // Readiness is for what was allowed: the declared server was left out.
    await expect(f.check()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ server: 'archive', status: 'ready' })]),
    );
    expect(f.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'warehouse' }),
    );
    await f.host.prepare({ req: f.req, context: f.context });
    expect(
      scheduleExecution(f.context)!.narrow('root', ['query_mcp_warehouse', 'query_mcp_archive']),
    ).toEqual(['query_mcp_archive']);
    const call = (serverName: string, serverConfig: object) =>
      bindRunGrantInvocation(f.context, 'root', 'query')!.authorize({
        user: f.user,
        serverName,
        serverConfig: serverConfig as typeof f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    await expect(call('archive', archive)).resolves.toBeUndefined();
    await expect(call('warehouse', f.serverConfig)).rejects.toMatchObject({
      failure: { reason: 'tool_policy_denied' },
    });
    // A schedule being created with such a grant has nothing stored yet: readiness is
    // handed the grant, and still reaches the listed server, so one that is down is reported.
    const grant = f.snapshot.enrollment!;
    const stored = jest.mocked(f.storage.readRunGrant).getMockImplementation()!;
    jest.mocked(f.storage.readRunGrant).mockResolvedValue(null);
    const creating = () =>
      f.preflight('root', f.user, {
        scheduleId: 'sched_new',
        stage: 'activation',
        concurrency: 3,
        grant,
      });
    f.connect.mockClear();
    await expect(creating()).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ server: 'archive', status: 'ready' })]),
    );
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'archive' }));
    expect(f.connect).not.toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'warehouse' }),
    );
    f.connect.mockRejectedValueOnce(new Error('down'));
    await expect(creating()).rejects.toMatchObject({ code: 'mcp_unavailable' });
    jest.mocked(f.storage.readRunGrant).mockImplementation(stored);
    // The owner loses the right to use MCP servers: the listed tool goes with it.
    f.getRoleByName.mockResolvedValue({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
      },
    } as IRole);
    await expect(call('archive', archive)).rejects.toMatchObject({
      failure: { reason: 'rbac_denied' },
    });
  });
});

describe('a grant that lists the whole of a declared server', () => {
  it('offers the selection as one item, makes the server ready, loads it and calls its tools', async () => {
    const f = await setup();
    f.snapshot.enrollment = null;
    f.setCandidates(['sys__all__sys_mcp_warehouse', 'web_search']);
    const offer = await f.host.consent.service.view(f.identity);
    expect(offer.targets).toMatchObject([
      {
        resource: { serverName: 'warehouse' },
        permittedTools: expect.arrayContaining([{ agentId: 'root', tools: ['sys__all__sys'] }]),
      },
    ]);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['sys__all__sys'] },
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    expect(f.row.mcpConsent).not.toHaveProperty('everything');
    f.connect.mockClear();
    await expect(f.check()).resolves.toEqual([{ server: 'warehouse', status: 'ready' }]);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'warehouse' }));
    await f.host.prepare({ req: f.req, context: f.context });
    const keys = ['sys__all__sys_mcp_warehouse', 'web_search'];
    // The server's tools load. The other tool was not ticked.
    expect(scheduleExecution(f.context)!.narrow('root', keys)).toEqual([
      'sys__all__sys_mcp_warehouse',
    ]);
    await expect(
      bindRunGrantInvocation(f.context, 'root', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('a schedule being created with its grant', () => {
  /** Nothing is stored for it yet: the grant comes with the readiness check. */
  async function creating(
    candidates: string[],
    choice: { allow: Record<string, string[]>; tools?: string[] },
  ) {
    const f = await setup();
    f.snapshot.enrollment = null;
    f.setCandidates(candidates);
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      ...choice,
    });
    const grant = f.snapshot.enrollment!;
    jest.mocked(f.storage.readRunGrant).mockResolvedValue(null);
    f.connect.mockClear();
    const check = (withGrant = true) =>
      f.preflight('root', f.user, {
        scheduleId: 'sched_new',
        stage: 'activation',
        concurrency: 3,
        ...(withGrant && { grant }),
      });
    return { ...f, check };
  }

  it('is ready on the MCP tools the grant allows, and connects to no server it leaves out', async () => {
    const f = await setup();
    const archive = { type: 'streamable-http' as const, url: 'https://archive.example/mcp' };
    f.servers.archive = archive;
    Object.assign(f.config.mcpConfig as object, { archive });
    const consent = (f.config.interfaceConfig!.schedules as { mcpConsent: { resources: object } })
      .mcpConsent;
    Object.assign(consent.resources, {
      archive: {
        url: archive.url,
        credentialMode: 'anonymous',
        issuer: null,
        audience: null,
        scopes: [],
      },
    });
    f.snapshot.enrollment = null;
    f.setCandidates(['query_mcp_warehouse', 'purge_mcp_archive']);
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    });
    const grant = f.snapshot.enrollment!;
    jest.mocked(f.storage.readRunGrant).mockResolvedValue(null);
    f.connect.mockClear();
    const options = { scheduleId: 'sched_new', stage: 'activation' as const, concurrency: 3 };
    await expect(f.preflight('root', f.user, { ...options, grant })).resolves.toEqual([
      { server: 'warehouse', status: 'ready' },
    ]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'warehouse' }));
    // Without the grant, the same check reaches for both servers.
    f.connect.mockClear();
    await f.preflight('root', f.user, options).catch(() => undefined);
    expect(f.connect).toHaveBeenCalledWith(expect.objectContaining({ serverName: 'archive' }));
  });

  it('is ready with nothing to connect when the grant allows no MCP tool, whatever the role', async () => {
    const f = await creating(['web_search', 'query_mcp_warehouse'], {
      allow: {},
      tools: ['web_search'],
    });
    f.getRoleByName.mockResolvedValue({
      permissions: {
        [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true, [Permissions.CREATE]: true },
      },
    } as IRole);
    await expect(f.check()).resolves.toEqual([]);
    expect(f.connect).not.toHaveBeenCalled();
    await expect(f.check(false)).rejects.toMatchObject({ code: 'mcp_permission_denied' });
  });
});

describe('a schedule its owner never authorized', () => {
  async function unauthorized() {
    const f = await setup();
    f.snapshot.enrollment = null;
    f.row.mcpConsent = undefined;
    const consent = (f.config.interfaceConfig!.schedules as { mcpConsent: object }).mcpConsent;
    const call = async () => {
      const context = createMCPRequestContext();
      await f.host.prepare({ req: f.req, context });
      return bindRunGrantInvocation(context, 'root', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    };
    /** `Date.now()` is pinned to 1000 by `setup`. */
    const setDeadline = (ms: number) =>
      Object.assign(consent, { requireAfter: new Date(ms).toISOString() });
    return { ...f, consent, call, setDeadline };
  }
  const missing = {
    failure: { reason: 'consent_missing', status: 'mcp_reauth_required', recovery: 'authorize' },
  };

  it('keeps using MCP tools with no deadline, and until one that has not passed', async () => {
    const f = await unauthorized();
    await expect(f.call()).resolves.toBeUndefined();
    f.setDeadline(1001);
    await expect(f.call()).resolves.toBeUndefined();
    expect(await f.host.consent.service.view(f.identity)).toMatchObject({
      state: 'missing',
      required: false,
      requireAfterMs: 1001,
    });
  });

  it('is refused MCP tools from the operator deadline on, at readiness and in a run', async () => {
    const f = await unauthorized();
    f.setDeadline(1000);
    await expect(f.call()).rejects.toMatchObject(missing);
    await expect(f.check()).rejects.toMatchObject({
      code: 'mcp_reauth_required',
      outcomes: [expect.objectContaining({ server: 'warehouse', reason: 'consent_missing' })],
    });
    expect(await f.host.consent.service.view(f.identity)).toMatchObject({
      state: 'missing',
      required: true,
      requireAfterMs: null,
    });
  });

  it('is refused MCP tools once its owner has edited it, with no deadline set', async () => {
    const f = await unauthorized();
    f.snapshot.required = true;
    await expect(f.call()).rejects.toMatchObject(missing);
  });

  it('is left alone where consent is off, whatever the deadline or the edit mark', async () => {
    const f = await unauthorized();
    f.setDeadline(0);
    f.snapshot.required = true;
    Object.assign(f.consent, { enabled: false });
    await expect(f.call()).resolves.toBeUndefined();
    await expect(f.check()).resolves.toBeDefined();
  });

  it('runs again once the owner confirms', async () => {
    const f = await unauthorized();
    f.setDeadline(0);
    await expect(f.call()).rejects.toMatchObject(missing);
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
      allow: allowOffered(offer.targets),
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    await expect(f.call()).resolves.toBeUndefined();
    expect(await f.host.consent.service.view(f.identity)).toMatchObject({
      state: 'active',
      required: false,
      requireAfterMs: null,
    });
  });

  it('reads the configuration fail-closed, so an override outage cannot lift the requirement', async () => {
    const f = await unauthorized();
    f.setDeadline(0);
    await expect(f.call()).rejects.toMatchObject(missing);
    // The override store goes down. Asked without `failClosed`, the config service answers
    // with the deployment's base, which here does not turn consent on at all.
    const base = { ...f.config, interfaceConfig: { schedules: { use: true } } } as AppConfig;
    f.getAppConfig.mockImplementation(async (options) => {
      if (options?.failClosed) throw new Error('PRIVATE override store');
      return base;
    });
    let failure: unknown;
    await f.call().catch((error) => {
      failure = error;
    });
    expect(failure).toMatchObject({ failure: { reason: 'dependency_unavailable' } });
    expect(String(failure)).not.toContain('PRIVATE');
  });

  it('asks once per run, and not at all for a run that calls no MCP tool', async () => {
    const f = await unauthorized();
    f.setDeadline(1001);
    const context = createMCPRequestContext();
    f.getAppConfig.mockClear();
    f.findUser.mockClear();
    await f.host.prepare({ req: f.req, context });
    expect(f.getAppConfig).not.toHaveBeenCalled();
    expect(f.findUser).not.toHaveBeenCalled();
    const guard = bindRunGrantInvocation(context, 'root', 'query')!;
    const use = () =>
      guard.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    await use();
    const reads = f.findUser.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await use();
    expect(f.findUser).toHaveBeenCalledTimes(reads);
  });

  it('does not treat a failed lookup as permission, and looks again on the next call', async () => {
    const f = await unauthorized();
    f.setDeadline(1001);
    const context = createMCPRequestContext();
    await f.host.prepare({ req: f.req, context });
    f.getAppConfig.mockRejectedValueOnce(new Error('PRIVATE config store'));
    const guard = bindRunGrantInvocation(context, 'root', 'query')!;
    const use = () =>
      guard.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    let failure: unknown;
    await use().catch((error) => {
      failure = error;
    });
    expect(failure).toMatchObject({ failure: { reason: 'dependency_unavailable' } });
    expect(String(failure)).not.toContain('PRIVATE');
    await expect(use()).resolves.toBeUndefined();
  });
});

describe('a tool the owner approves call by call', () => {
  async function asking() {
    const f = await setup();
    const offer = await f.host.consent.service.view(f.identity);
    await f.host.consent.service.confirm(f.identity, {
      offerDigest: offer.offer!.digest,
      expectedRevision: offer.revision,
      lifetimeHours: 1,
      allow: allowOffered(offer.targets),
      ask: { warehouse: ['query'] },
    });
    f.row.mcpConsent = f.snapshot.enrollment!;
    const use = (context: ReturnType<typeof createMCPRequestContext>, toolCallId?: string) =>
      bindRunGrantInvocation(context, 'root', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
        toolCallId,
      });
    return { ...f, use };
  }
  const refused = { failure: { reason: 'approval_required' } };

  it('takes approvals only from the request that resumes a run', async () => {
    const f = await asking();
    const fresh = createMCPRequestContext();
    await f.host.prepare({ req: f.req, context: fresh, approvedToolCalls: ['call-1'] });
    expect(scheduleExecution(fresh)?.mayAsk).toBe(true);
    await expect(f.use(fresh, 'call-1')).rejects.toMatchObject(refused);

    const req = { user: f.user, _isScheduledFire: true, body: {} };
    const resumed = createMCPRequestContext();
    await f.host.prepare({
      req,
      context: resumed,
      executionContext: restoreExecutionContext(req, {
        userId: 'owner',
        tenantId: 'tenant',
        scheduleId: 'schedule',
        agent_id: 'root',
      }),
      approvedToolCalls: ['call-1'],
    });
    await expect(f.use(resumed, 'call-1')).resolves.toBeUndefined();
    await expect(f.use(resumed, 'call-2')).rejects.toMatchObject(refused);
  });

  it('carries them into a resumed completion turn of a background task, and into no fresh one', async () => {
    const f = await asking();
    const marker = { version: 1, sourceId: 'background-tool-completion' };
    const completion = (resumed: boolean) => {
      const context = createMCPRequestContext();
      return f.host
        .prepare({
          req: {
            user: f.user,
            _isAgentTrigger: !resumed,
            body: {
              conversationId: 'completion',
              agent_id: 'root',
              agentCompletion: { ...marker, scheduleMCPIdentity: f.identity },
            },
          },
          context,
          ...(resumed && { restoredJob: { scheduleMCPCompletion: f.identity } }),
          approvedToolCalls: ['call-1'],
        })
        .then(() => context);
    };
    // The turn that picks the result up runs under the schedule's grant: it asks like any run.
    const fresh = await completion(false);
    expect(scheduleExecution(fresh)).toMatchObject({
      enrolled: true,
      stage: 'invoke',
      // A schedule is found again by its identity, so its runs may send work off.
      detaches: true,
      // And the turn may be rooted at the agent that started the work.
      completion: true,
    });
    await expect(f.use(fresh, 'call-1')).rejects.toMatchObject(refused);
    // Paused for the owner and resumed: the call they approved goes through, and only that one.
    const resumed = await completion(true);
    expect(scheduleExecution(resumed)).toMatchObject({ enrolled: true, stage: 'resume' });
    await expect(f.use(resumed, 'call-1')).resolves.toBeUndefined();
    await expect(f.use(resumed, 'call-2')).rejects.toMatchObject(refused);
  });

  it('does not fail the readiness check of a schedule that will ask', async () => {
    const f = await asking();
    await expect(f.check()).resolves.toBeDefined();
  });

  it('reports whether this deployment can pause a scheduled run', async () => {
    const f = await setup();
    expect(await f.host.consent.service.view(f.identity)).toMatchObject({ approval: true });
    f.cannotPause();
    expect(await f.host.consent.service.view(f.identity)).toMatchObject({ approval: false });
  });
});
