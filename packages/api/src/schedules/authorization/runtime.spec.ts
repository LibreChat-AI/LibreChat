import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import type { AppConfig, IRole, ISchedule, AgentGraphAccessContext } from '@librechat/data-schemas';
import {
  restoreExecutionContext,
  createScheduleExecutionContext,
} from '~/agents/authority/context';
import { createScheduleMCPRuntimeHost, initializeWithScheduleMCPExecution } from './runtime';
import { bindScheduledMCPInvocation, getScheduleMCPExecution } from './execution';
import { executionFixture, allowOffered, readTool } from './execution.helper';
import { createMCPRequestContext } from '~/mcp/request';
import { createScheduleMCPPreflight } from '../mcp';
import { ScheduledMCPPolicyError } from './policy';

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
  const getServers = jest.fn(async () => ({ warehouse: fixture.config }));
  const resolveGraphAccess = jest.fn(async () => ({}) as AgentGraphAccessContext);
  const getScheduleById = jest.fn(async () => row);
  const getScheduleMCPCompletionState = jest.fn(async () => ({
    identity: fixture.identity,
    enrolled: false,
  }));
  let pausable = true;
  const host = createScheduleMCPRuntimeHost({
    canPauseRuns: async () => pausable,
    getScheduleMCPCompletionState,
    methods: { ...fixture.storage, getScheduleById },
    findUser,
    getRoleByName,
    canViewAgent: async () => true,
    enrollment: {
      findUser,
      getAppConfig,
      getModelsConfig,
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
    ensureConfigServers: async () => ({ warehouse: fixture.config }),
    findPluginAuthsByKeys: async () => [],
    connect,
    execution: host.execution,
  });
  /** As the chat controller does, build the context once from the verified trigger. */
  const prepare = host.prepare;
  host.prepare = (input) =>
    prepare({ executionContext: createScheduleExecutionContext(input.req), ...input });
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
    getScheduleMCPCompletionState,
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
  expect(getScheduleMCPExecution(f.context)?.identity).toEqual(f.identity);
  for (const agentId of ['root', 'child']) {
    await expect(
      bindScheduledMCPInvocation(f.context, agentId, 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      }),
    ).resolves.toBeUndefined();
  }
});

it.each(
  [[], ['execute_code'], ['query_mcp_warehouse', 'write_action_api']].map((tools) => ({ tools })),
)(
  'refuses prohibited or empty protected candidate sets before connecting: %s',
  async ({ tools }) => {
    const f = await setup();
    f.setCandidates(tools);
    await expect(f.check()).rejects.toMatchObject({
      outcomes: [expect.objectContaining({ automaticReplay: false })],
    });
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
  expect(getScheduleMCPExecution(f.context)?.stage).toBe('resume');
  await f.host.consent.service.revoke(f.identity, f.snapshot.enrollment!.revision);
  await expect(
    bindScheduledMCPInvocation(f.context, 'child', 'query')!.authorize({
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
  expect(getScheduleMCPExecution(f.context)).toMatchObject({ enrolled: false });
});

it('ignores spoofed body fields on ordinary chat and refuses cross-tenant triggers', async () => {
  const f = await setup();
  await f.host.prepare({
    req: { ...f.req, _isScheduledFire: false, _isAgentTrigger: false },
    context: f.context,
  });
  expect(getScheduleMCPExecution(f.context)).toBeUndefined();
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
  await initializeWithScheduleMCPExecution(
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
    expect(getScheduleMCPExecution(f.context)).toBeUndefined();
  },
);

it('loads one fresh principal and configuration pair per authorization, not per phase', async () => {
  const f = await setup();
  await f.host.prepare({ req: f.req, context: f.context });
  const call = () =>
    bindScheduledMCPInvocation(f.context, 'root', 'query')!.authorize({
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
    bindScheduledMCPInvocation(f.context, 'child', 'query')!.authorize({
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
    bindScheduledMCPInvocation(f.context, agentId, 'query')!.authorize({
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
      bindScheduledMCPInvocation(f.context, 'child', 'query')!.authorize({
        user: f.user,
        serverName: 'warehouse',
        serverConfig: f.serverConfig,
        toolName: 'query',
        loadTools: async () => ({ tools: [readTool], complete: true }),
      });
    await expect(call()).resolves.toBeUndefined();
    expect(f.storage.admitScheduleMCPConsent).toHaveBeenLastCalledWith(
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
    bindScheduledMCPInvocation(f.context, 'root', 'query')!.authorize({
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
  const execution = getScheduleMCPExecution(f.context)!;
  expect(execution.enrolled).toBe(false);
  const guard = bindScheduledMCPInvocation(f.context, 'root', 'write')!;
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
    if (phase === 'consent')
      jest.mocked(f.storage.readScheduleMCPConsent).mockRejectedValue(privateError);
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
      () =>
        initializeWithScheduleMCPExecution({ req, context: f.context }, () => f.host, initialize),
    ]) {
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
      });
      expect(String(failure)).not.toContain('PRIVATE');
      expect(failure).not.toHaveProperty('cause');
    }
    expect(initialize).not.toHaveBeenCalled();
  },
);

it('sanitizes consent attachment failures on authenticated completion approval resumes', async () => {
  const f = await setup();
  jest
    .mocked(f.storage.readScheduleMCPConsent)
    .mockRejectedValue(new Error('PRIVATE consent query'));
  const initialize = jest.fn();
  await expect(
    initializeWithScheduleMCPExecution(
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
    initializeWithScheduleMCPExecution({ req: f.req, context: f.context }, getHost, initialize),
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
    initializeWithScheduleMCPExecution(
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
    initializeWithScheduleMCPExecution(
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
  const typed = new ScheduledMCPPolicyError('rbac_denied', 'warehouse', 'root');
  f.getScheduleById.mockRejectedValue(typed);
  await expect(f.host.prepare({ req: f.req, context: f.context })).rejects.toBe(typed);
  const stop = new Error('Owner stopped');
  f.getScheduleById.mockImplementation(async () => {
    controller.abort(stop);
    throw stop;
  });
  await expect(
    initializeWithScheduleMCPExecution(
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
    initializeWithScheduleMCPExecution(
      { req: f.req, context: f.context, signal: otherController.signal },
      () => f.host,
      jest.fn(),
    ),
  ).rejects.toMatchObject({ failure: { reason: 'dependency_unavailable' } });
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
      return bindScheduledMCPInvocation(context, 'root', 'query')!.authorize({
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

  it('asks once per run, and not at all for a run that calls no MCP tool', async () => {
    const f = await unauthorized();
    f.setDeadline(1001);
    const context = createMCPRequestContext();
    f.getAppConfig.mockClear();
    f.findUser.mockClear();
    await f.host.prepare({ req: f.req, context });
    expect(f.getAppConfig).not.toHaveBeenCalled();
    expect(f.findUser).not.toHaveBeenCalled();
    const guard = bindScheduledMCPInvocation(context, 'root', 'query')!;
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
    const guard = bindScheduledMCPInvocation(context, 'root', 'query')!;
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
      bindScheduledMCPInvocation(context, 'root', 'query')!.authorize({
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
    expect(getScheduleMCPExecution(fresh)?.mayAsk).toBe(true);
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
