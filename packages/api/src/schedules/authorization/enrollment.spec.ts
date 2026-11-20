import { Types } from 'mongoose';
import { SkillsScope, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { ScheduleMCPConsentStorage, ScheduleConsentSnapshot } from '@librechat/data-schemas';
import type { IUser, AppConfig, AgentGraphAccessContext } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMCPEnrollmentDeps } from './enrollment';
import type { ParsedServerConfig } from '~/mcp/types';
import { createScheduleMCPEnrollmentResolver, createScheduleMCPOffer } from './enrollment';
import { allowOffered, pinStorage } from './execution.helper';
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
it("offers the agents' other tools beside their MCP tools, from one walk of the agent graph", async () => {
  const { deps } = setup();
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools:
        id === 'root'
          ? ['query_mcp_warehouse', 'web_search', 'execute_code', 'send_action_mail.example']
          : ['query_mcp_warehouse', 'web_search', 'tool_search'],
      agent_ids: id === 'root' ? ['child'] : [],
    })),
  );
  const offer = createScheduleMCPOffer(deps);
  const [targets, tools] = await Promise.all([
    offer.targets(identity, {}),
    offer.tools(identity, {}),
  ]);
  // An agent with other tools is offered a grant like any other: they no longer rule it out.
  expect(targets[0].permittedTools).toEqual([
    { agentId: 'child', tools: ['query'] },
    { agentId: 'root', tools: ['query'] },
  ]);
  // Each is its own item, per agent. The SDK's own controls are not the owner's to allow.
  expect(tools).toEqual([
    { agentId: 'child', tools: ['web_search'] },
    { agentId: 'root', tools: ['execute_code', 'send_action_mail.example', 'web_search'] },
  ]);
  expect(deps.findUser).toHaveBeenCalledTimes(1);
  expect(deps.getServers).toHaveBeenCalledTimes(1);
  // A grant that limits MCP tools only, as an API key's does, offers none of them.
  const limited = createScheduleMCPOffer(deps, { otherTools: 'ignore' });
  expect(await limited.tools(identity, {})).toEqual([]);
});
it('offers the skills of an agent as one item, where it uses any and the deployment has skills on', async () => {
  const { deps } = setup();
  const config = await deps.getAppConfig({});
  const withSkills = (capabilities: string[]) =>
    jest.mocked(deps.getAppConfig).mockResolvedValue({
      ...config,
      endpoints: { agents: { capabilities } },
    } as unknown as AppConfig);
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: ['web_search'],
      agent_ids: id === 'root' ? ['all', 'picked', 'off', 'none'] : [],
      // Every skill the owner can use, two picked ones, switched off, and on with none picked.
      ...(id === 'root' && { skills_enabled: true }),
      ...(id === 'all' && { skills_enabled: true, skills_scope: SkillsScope.all }),
      ...(id === 'picked' && { skills_enabled: true, skills: ['a', 'b'] }),
      ...(id === 'off' && { skills_enabled: false, skills: ['a'] }),
      ...(id === 'none' && { skills_enabled: true, skills_scope: SkillsScope.none }),
    })),
  );
  withSkills(['skills']);
  const using = (tools: { agentId: string; tools: string[] }[]) =>
    tools.filter((selection) => selection.tools.includes('skills')).map(({ agentId }) => agentId);
  expect(using([...(await createScheduleMCPOffer(deps).tools(identity, {}))])).toEqual([
    'all',
    'picked',
    'root',
  ]);
  // With the capability off no agent runs a skill, so there is nothing to allow.
  withSkills([]);
  expect(using([...(await createScheduleMCPOffer(deps).tools(identity, {}))])).toEqual([]);
});
it("offers the agents' other tools where the operator declared no MCP server at all", async () => {
  const { deps } = setup();
  jest.mocked(deps.getAppConfig).mockResolvedValue({
    interfaceConfig: { schedules: { mcpConsent: { enabled: true } } },
  } as AppConfig);
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: ['web_search', 'query_mcp_warehouse'],
    })),
  );
  const offer = createScheduleMCPOffer(deps);
  expect(await offer.targets(identity, {})).toEqual([]);
  expect(await offer.tools(identity, {})).toEqual([{ agentId: 'root', tools: ['web_search'] }]);
  // A grant that limits MCP tools only has nothing to offer there, and walks no graph for it.
  jest.mocked(deps.getNodes).mockClear();
  const limited = createScheduleMCPOffer(deps, { otherTools: 'ignore' });
  expect(await limited.tools(identity, {})).toEqual([]);
  expect(deps.getNodes).not.toHaveBeenCalled();
});
it('does not offer a server whose URL changed, even if its configured name did not', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.getServers).mockResolvedValue({
    warehouse: { type: 'streamable-http', url: 'https://other.example/mcp' },
  });
  expect(await resolve(identity, {})).toEqual([]);
});
it('reports a selection of every tool on a server under its marker, not as a list of them', async () => {
  const { deps, resolve } = setup();
  jest
    .mocked(deps.getNodes)
    .mockResolvedValue([
      { id: 'root', provider: 'test', model: 'test', tools: ['sys__all__sys_mcp_warehouse'] },
    ]);
  const targets = await resolve(identity, {});
  expect(targets.map((target) => target.permittedTools)).toEqual([
    [{ agentId: 'root', tools: ['sys__all__sys'] }],
  ]);
  expect(targets[0].resource.audience).toBe('warehouse');
});
it('still offers the rest when one server the agents use cannot be offered', async () => {
  const { deps } = setup();
  jest.mocked(deps.getServers).mockImplementation(async (_user, config) => ({
    ...config,
    notes: { type: 'stdio', command: 'notes', args: [] },
    archive: { type: 'streamable-http', url: 'https://archive.example/mcp' },
  }));
  jest.mocked(deps.getNodes).mockImplementation(async (ids) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      // One declared, one the operator never declared, one local, one named by no server.
      tools: [
        'query_mcp_warehouse',
        'purge_mcp_archive',
        'lookup_mcp_notes',
        'lost_mcp_nowhere',
        'web_search',
      ],
    })),
  );
  const offer = createScheduleMCPOffer(deps);
  const targets = await offer.targets(identity, {});
  expect(targets.map((target) => target.resource.serverName)).toEqual(['warehouse']);
  expect(targets[0].permittedTools).toEqual([{ agentId: 'root', tools: ['query'] }]);
  // A server the operator declared nothing for has no recipient to bind: its tools are
  // offered among the other tools, under the key the agent has them by. A key that names no
  // server the owner can reach is not offered at all.
  expect(await offer.tools(identity, {})).toEqual([
    { agentId: 'root', tools: ['lookup_mcp_notes', 'purge_mcp_archive', 'web_search'] },
  ]);
  // A grant that limits MCP tools only has no such list to put them in.
  const limited = createScheduleMCPOffer(deps, { otherTools: 'ignore' });
  expect(await limited.tools(identity, {})).toEqual([]);
  expect((await limited.targets(identity, {})).map((t) => t.resource.serverName)).toEqual([
    'warehouse',
  ]);
  // Every server in use is reported by name, offered or not, so a grant can tell a server
  // that lost its declaration from one the agents dropped.
  expect(await offer.servers(identity, {})).toEqual(['archive', 'notes', 'warehouse']);
  jest.mocked(deps.getAppConfig).mockResolvedValue({
    interfaceConfig: { schedules: { mcpConsent: { enabled: true } } },
    mcpConfig: { warehouse: { type: 'streamable-http', url: 'https://warehouse.example/mcp' } },
  } as unknown as AppConfig);
  const undeclared = createScheduleMCPOffer(deps);
  expect(await undeclared.targets(identity, {})).toEqual([]);
  expect(await undeclared.servers(identity, {})).toEqual(['archive', 'notes', 'warehouse']);
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
    findAgentObjectId: async () => ({ _id: new Types.ObjectId().toString() }),
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
    ...pinStorage(() => snapshot.enrollment),
  };
  const service = createScheduleMCPConsentService({
    storage,
    resolveEnrollment: resolve,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
    now: () => 1000,
  });
  const preview = await service.view(identity);
  const input = {
    offerDigest: preview.offer!.digest,
    expectedRevision: null,
    lifetimeHours: 1,
    allow: allowOffered(preview.targets),
  };
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
      ...pinStorage(() => snapshot.enrollment),
    },
    resolveEnrollment: resolve,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    canUse: async () => true,
  });
  // The server is not offered, so there is nothing to confirm for it.
  expect(await service.view(identity)).toMatchObject({ state: 'unsupported', offer: null });
  await expect(
    service.confirm(identity, {
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    }),
  ).rejects.toMatchObject({ code: 'consent_unavailable' });
  expect(confirm).not.toHaveBeenCalled();
});

it('offers every MCP tool the agent graph selects, with no operator tool list', async () => {
  const f = setup();
  const [target] = await f.resolve(identity, {});

  expect(target.resource.serverName).toBe('warehouse');
  expect(target.permittedTools.flatMap((selection) => selection.tools)).toContain('query');
  expect(f.deps.getAppConfig).not.toHaveBeenCalledWith(expect.objectContaining({ baseOnly: true }));
});
