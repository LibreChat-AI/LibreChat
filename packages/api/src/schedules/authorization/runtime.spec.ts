import { Permissions, PermissionTypes, AgentCapabilities } from 'librechat-data-provider';
import type { AppConfig, IRole, ISchedule, AgentGraphAccessContext } from '@librechat/data-schemas';
import { createScheduleMCPRuntimeHost, prepareScheduleMCPExecution } from './runtime';
import { bindScheduledMCPInvocation, getScheduleMCPExecution } from './execution';
import { executionFixture, readTool } from './execution.helper';
import { createMCPRequestContext } from '~/mcp/request';
import { createScheduleMCPPreflight } from '../mcp';

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
          resources: {
            warehouse: {
              url: 'https://resource.example/mcp',
              credentialMode: 'anonymous',
              issuer: null,
              audience: null,
              scopes: [],
            },
          },
          readOnlyPolicy: fixture.policy,
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
  const getAppConfig = jest.fn(async () => config);
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
  const host = createScheduleMCPRuntimeHost({
    methods: { ...fixture.storage, getScheduleById: jest.fn(async () => row) },
    getLimits: jest.fn(async () => ({
      enabled: true,
      maxPerUser: 10,
      minIntervalMinutes: 1,
      autoDisableAfterFailures: 3,
      admissionConcurrency: 3,
      fireConcurrency: 3,
      mcpPreflightConcurrency: 3,
      mcpPreflightTimeoutMs: 1000,
      requireProject: false,
      mcpConsent: { enabled: true, maxLifetimeHours: 24 },
    })) as Parameters<typeof createScheduleMCPRuntimeHost>[0]['getLimits'],
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
    setCandidates: (names: string[]) => {
      candidates = names;
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
    restoredContext: {
      scheduleId: 'schedule',
      ownerId: 'owner',
      tenantId: 'tenant',
      agentId: 'root',
      invocationMode: 'delegated',
    },
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
  expect(getScheduleMCPExecution(f.context)).toBeUndefined();
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

it('keeps live role denial and policy removal fail-closed for enrolled schedules', async () => {
  const f = await setup();
  const role = await f.getRoleByName();
  f.getRoleByName.mockResolvedValue({ permissions: {} } as IRole);
  await expect(f.check()).rejects.toMatchObject({ code: 'mcp_permission_denied' });
  f.getRoleByName.mockResolvedValue(role);
  const schedules = f.config.interfaceConfig?.schedules;
  if (typeof schedules === 'object') delete schedules.mcpConsent?.readOnlyPolicy;
  await expect(f.check()).rejects.toMatchObject({
    outcomes: [expect.objectContaining({ reason: 'tool_policy_denied' })],
  });
});

it('does not construct the host for ordinary chats', async () => {
  const f = await setup();
  const getHost = jest.fn(() => f.host);
  await prepareScheduleMCPExecution(
    { req: { ...f.req, _isScheduledFire: false, _isAgentTrigger: false }, context: f.context },
    getHost,
  );
  expect(getHost).not.toHaveBeenCalled();
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
