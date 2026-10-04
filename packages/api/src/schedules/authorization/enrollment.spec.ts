import { Types } from 'mongoose';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage, ScheduleConsentSnapshot } from '@librechat/data-schemas';
import type { IUser, AppConfig, AgentGraphAccessContext } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMCPEnrollmentDeps } from './enrollment';
import type { ParsedServerConfig } from '~/mcp/types';
import { createScheduleMCPEnrollmentResolver } from './enrollment';
import { createScheduleMCPConsentService } from './service';
import { createResolveAgentFireAccess } from '../access';

const identity: ScheduledMCPIdentity = {
  scheduleId: 's',
  ownerId: 'u',
  tenantId: 't',
  agentId: 'root',
  invocationMode: 'delegated',
};
function setup() {
  const deps: ScheduleMCPEnrollmentDeps = {
    getModelsConfig: jest.fn(async () => ({ test: ['test'] })),
    canUseRoot: jest.fn(async () => true),
    findUser: jest.fn(async () => ({ id: 'u', tenantId: 't', role: 'USER' }) as IUser),
    getAppConfig: jest.fn(async () =>
      Object.assign({} as AppConfig, {
        interfaceConfig: {
          schedules: {
            mcpConsent: {
              enabled: true,
              readOnlyPolicy: {
                warehouse: {
                  tools: { query: { effect: 'read_only', definitionSha256: 'a'.repeat(64) } },
                },
              },
              resources: {
                warehouse: {
                  url: 'https://warehouse.example/mcp',
                  credentialMode: 'resource_bearer',
                  issuer: 'https://issuer.example/',
                  audience: 'warehouse',
                  scopes: ['read'],
                },
              },
            },
          },
        },
        mcpConfig: {
          warehouse: { type: 'streamable-http', url: 'https://warehouse.example/mcp' },
        },
      }),
    ),
    resolveGraphAccess: jest.fn(async () => ({}) as AgentGraphAccessContext),
    getNodes: jest.fn(async (ids) =>
      ids.map((id) => ({ id, provider: 'test', model: 'test', tools: ['query_mcp_warehouse'] })),
    ),
    getServers: jest.fn(async (_user, config) => config),
  };
  return { deps, resolve: createScheduleMCPEnrollmentResolver(deps) };
}
it('resolves the configured root and declared resource without credentials or a connection', async () => {
  const { resolve, deps } = setup();
  const targets = await resolve(identity, {});
  expect(targets).toHaveLength(1);
  expect(targets[0].permittedTools).toEqual([{ agentId: 'root', tools: ['query'] }]);
  expect(targets[0].resource.audience).toBe('warehouse');
  expect(targets[0].resource.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
  expect(deps.getServers).toHaveBeenCalledTimes(1);
});
it('binds reachable persisted child selections without transferring the enrolled root', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: ['query_mcp_warehouse'],
      agent_ids: id === 'root' ? ['child'] : [],
    })),
  );
  expect((await resolve(identity, {}))[0].permittedTools.map((s) => s.agentId)).toEqual([
    'child',
    'root',
  ]);
});
it('does not enroll an inaccessible child that runtime skips', async () => {
  const { deps, resolve } = setup();
  jest
    .mocked(deps.getNodes)
    .mockResolvedValueOnce([
      {
        id: 'root',
        provider: 'test',
        model: 'test',
        tools: ['query_mcp_warehouse'],
        agent_ids: ['private-child'],
      },
    ])
    .mockResolvedValueOnce([]);
  expect((await resolve(identity, {}))[0].permittedTools.map((s) => s.agentId)).toEqual(['root']);
});
it('requires operator-declared recipient metadata, not a successful login or tool hint', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getAppConfig).mockResolvedValue({
    interfaceConfig: { schedules: { mcpConsent: { enabled: true } } },
  } as AppConfig);
  expect(await resolve(identity, {})).toEqual([]);
});
it('denies a changed resource URL even if the configured server name is unchanged', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getServers).mockResolvedValue({
    warehouse: { type: 'streamable-http', url: 'https://other.example/mcp' },
  });
  await expect(resolve(identity, {})).rejects.toMatchObject({ code: 'consent_unavailable' });
});
it('does not expand wildcard tools into rolling consent', async () => {
  const { deps, resolve } = setup();
  jest
    .mocked(deps.getNodes)
    .mockResolvedValue([
      { id: 'root', provider: 'test', model: 'test', tools: ['sys__all__sys_mcp_warehouse'] },
    ]);
  await expect(resolve(identity, {})).rejects.toMatchObject({ code: 'consent_unavailable' });
});
it('denies an owner/tenant mismatch and cancellation before resolving resources', async () => {
  const { deps, resolve } = setup();
  await expect(resolve({ ...identity, tenantId: 'other' }, {})).rejects.toMatchObject({
    code: 'consent_forbidden',
  });
  const controller = new AbortController();
  controller.abort();
  await expect(resolve(identity, { signal: controller.signal })).rejects.toThrow();
  expect(deps.getServers).not.toHaveBeenCalled();
});

it('honors capability-only root access without bypassing descendant VIEW checks', async () => {
  const { deps, resolve } = setup();
  const rootAccess = createResolveAgentFireAccess({
    findAgentObjectId: async () => ({ _id: new Types.ObjectId() }),
    getRoleByName: async () => ({
      permissions: { [PermissionTypes.AGENTS]: { [Permissions.USE]: true } },
    }),
    hasCapability: async () => true,
    checkPermission: async () => false,
  });
  deps.canUseRoot = jest.fn(async (id, user) => (await rootAccess(id, user)) === 'ok');
  jest.mocked(deps.getNodes).mockImplementation(async (ids, access) => {
    if (ids.includes('root'))
      return access
        ? []
        : [
            {
              id: 'root',
              provider: 'test',
              model: 'test',
              tools: ['query_mcp_warehouse'],
              agent_ids: ['child'],
            },
          ];
    return [{ id: 'child', provider: 'test', model: 'test', tools: ['query_mcp_warehouse'] }];
  });
  expect((await resolve(identity, {}))[0].permittedTools.map((s) => s.agentId)).toEqual([
    'child',
    'root',
  ]);
  expect(deps.canUseRoot).toHaveBeenCalledWith(
    'root',
    expect.objectContaining({ id: 'u', tenantId: 't' }),
  );
  expect(deps.getNodes).toHaveBeenNthCalledWith(1, ['root']);
  expect(deps.getNodes).toHaveBeenNthCalledWith(2, ['child'], expect.any(Object));
});
it('does not load an unauthorized root through the unfiltered loader', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.canUseRoot).mockResolvedValue(false);
  await expect(resolve(identity, {})).rejects.toMatchObject({ code: 'consent_forbidden' });
  expect(deps.getNodes).not.toHaveBeenCalled();
});

it('does not expand saved edges of a legacy-chain member', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: ['query_mcp_warehouse'],
      agent_ids: id === 'root' ? ['legacy'] : [],
      edges: id === 'legacy' ? [{ from: 'legacy', to: 'private-child' }] : [],
    })),
  );
  expect((await resolve(identity, {}))[0].permittedTools.map((s) => s.agentId)).toEqual([
    'legacy',
    'root',
  ]);
  expect(jest.mocked(deps.getNodes).mock.calls.flatMap(([ids]) => ids)).not.toContain(
    'private-child',
  );
});

it.each<Partial<Extract<ParsedServerConfig, { type: 'http' | 'streamable-http' }>>>([
  { headers: { 'X-Workspace': 'other' } },
  { requestHeaders: { 'X-Account': 'other' } },
  { proxy: 'http://other-proxy.example/' },
  { dbId: 'other-server' },
])('requires fresh confirmation at every stage after a routing change: %j', async (change) => {
  const { deps, resolve } = setup();
  let server: Extract<ParsedServerConfig, { type: 'http' | 'streamable-http' }> = {
    type: 'streamable-http',
    url: 'https://warehouse.example/mcp',
    headers: { 'X-Workspace': 'original' },
    requestHeaders: { 'X-Account': 'original' },
    proxy: 'http://proxy.example/',
    dbId: 'original-server',
  };
  jest.mocked(deps.getServers).mockImplementation(async () => ({ warehouse: server }));
  const snapshot: ScheduleConsentSnapshot = {
    agentId: 'root',
    enabled: true,
    configRevision: 0,
    enrollment: null,
  };
  const admit = jest.fn(async () => true);
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: async () => structuredClone(snapshot),
    confirmScheduleMCPConsent: async ({ enrollment }) => {
      snapshot.enrollment = enrollment;
      return true;
    },
    revokeScheduleMCPConsent: async () => true,
    admitScheduleMCPConsent: admit,
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment: resolve,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
    checkToolPolicy: async () => true,
    now: () => 1000,
  });
  const preview = await service.view(identity);
  const input = { offerDigest: preview.offer!.digest, expectedRevision: null, lifetimeHours: 1 };
  const enrolled = await service.confirm(identity, input);
  const oldResource = snapshot.enrollment!.consents[0].resource;
  server = { ...server, ...change };
  expect((await service.view(identity)).state).toBe('changed');
  await expect(
    service.confirm(identity, { ...input, expectedRevision: enrolled.revision }),
  ).rejects.toMatchObject({ code: 'consent_changed' });
  for (const stage of ['activation', 'mint', 'invoke', 'resume'] as const) {
    expect(
      await service.authority.authorize(
        {
          identity,
          resource: oldResource,
          stage,
          selection: { agentId: 'root', tools: ['query'] },
        },
        {},
      ),
    ).toMatchObject({ state: 'denied', failure: { reason: 'binding_mismatch' } });
  }
  expect(admit).not.toHaveBeenCalled();
  const fresh = await service.view(identity);
  await service.confirm(identity, {
    ...input,
    offerDigest: fresh.offer!.digest,
    expectedRevision: fresh.revision,
  });
  expect(
    await service.authority.authorize(
      {
        identity,
        resource: snapshot.enrollment!.consents[0].resource,
        stage: 'invoke',
        selection: { agentId: 'root', tools: ['query'] },
      },
      {},
    ),
  ).toMatchObject({ state: 'authorized' });
});

it('does not bind consent to renewed user tokens or client secrets', async () => {
  const { deps, resolve } = setup();
  const user = Object.assign({} as IUser, {
    id: 'u',
    tenantId: 't',
    role: 'USER',
    federatedTokens: {
      access_token: 'fixture-access-one',
      refresh_token: 'fixture-refresh-one',
      expires_at: 10000,
    },
  });
  let secret = 'fixture-secret-one';
  jest.mocked(deps.findUser).mockImplementation(async () => user);
  jest.mocked(deps.getServers).mockImplementation(async () => ({
    warehouse: {
      type: 'streamable-http',
      url: 'https://warehouse.example/mcp',
      headers: {
        Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
        'X-Workspace': 'original',
      },
      oauth: {
        client_id: 'client',
        client_secret: secret,
        authorization_url: 'https://issuer.example/authorize',
        token_url: 'https://issuer.example/token',
      },
    },
  }));
  const before = await resolve(identity, {});
  secret = 'fixture-secret-two';
  user.federatedTokens = {
    access_token: 'fixture-access-two',
    refresh_token: 'fixture-refresh-two',
    expires_at: 20000,
  };
  expect(await resolve(identity, {})).toEqual(before);
});

it('does not offer owner consent for recipient-defining custom user variables', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getServers).mockResolvedValue({
    warehouse: {
      type: 'streamable-http',
      url: 'https://warehouse.example/mcp',
      headers: { 'X-Workspace': '{{WORKSPACE}}' },
      customUserVars: {
        WORKSPACE: { title: 'Workspace', description: 'Recipient', sensitive: false },
      },
    },
  });
  const snapshot: ScheduleConsentSnapshot = {
    agentId: 'root',
    enabled: true,
    configRevision: 0,
    enrollment: null,
  };
  const confirm = jest.fn(async () => true);
  const service = createScheduleMCPConsentService({
    storage: {
      readScheduleMCPConsent: async () => snapshot,
      confirmScheduleMCPConsent: confirm,
      revokeScheduleMCPConsent: async () => true,
      admitScheduleMCPConsent: async () => true,
    },
    resolveEnrollment: resolve,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
  });
  await expect(service.view(identity)).rejects.toMatchObject({ code: 'consent_unavailable' });
  await expect(
    service.confirm(identity, {
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
    }),
  ).rejects.toMatchObject({ code: 'consent_unavailable' });
  expect(confirm).not.toHaveBeenCalled();
});

it.each([
  undefined,
  {},
  { tools: {} },
  { tools: { query: { effect: 'write', definitionSha256: 'a'.repeat(64) } } },
  { tools: { other: { effect: 'read_only', definitionSha256: 'a'.repeat(64) } } },
])('does not offer or confirm unusable read-only consent for policy %s', async (policy) => {
  const f = setup();
  const config = (await f.deps.getAppConfig({}))!;
  if (typeof config.interfaceConfig?.schedules !== 'object')
    throw new Error('Expected schedule config');
  config.interfaceConfig.schedules.mcpConsent!.readOnlyPolicy = { warehouse: policy } as never;
  jest.mocked(f.deps.getAppConfig).mockResolvedValue(config);
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: jest.fn(async () => ({
      agentId: 'root',
      enabled: true,
      configRevision: 0,
      enrollment: null,
    })),
    confirmScheduleMCPConsent: jest.fn(async () => true),
    revokeScheduleMCPConsent: jest.fn(async () => true),
    admitScheduleMCPConsent: jest.fn(async () => true),
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment: f.resolve,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
  });
  await expect(service.view(identity)).rejects.toMatchObject({ code: 'consent_unavailable' });
  await expect(
    service.confirm(identity, {
      expectedRevision: null,
      offerDigest: 'outdated',
      lifetimeHours: 1,
    }),
  ).rejects.toMatchObject({ code: 'consent_unavailable' });
  expect(storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
});

it('cannot offer read-only authority supplied only by a principal-specific configuration override', async () => {
  const f = setup();
  const effective = (await f.deps.getAppConfig({}))!;
  const base = structuredClone(effective);
  if (typeof base.interfaceConfig?.schedules !== 'object')
    throw new Error('Expected schedule config');
  delete base.interfaceConfig.schedules.mcpConsent!.readOnlyPolicy;
  jest
    .mocked(f.deps.getAppConfig)
    .mockImplementation(async (options) => (options.baseOnly ? base : effective));
  await expect(f.resolve(identity, {})).rejects.toMatchObject({ code: 'consent_unavailable' });
});
