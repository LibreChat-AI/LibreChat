import { Types } from 'mongoose';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IUser, AppConfig, AgentGraphAccessContext } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity } from 'librechat-data-provider';
import type { ScheduleMCPEnrollmentDeps } from './enrollment';
import { createScheduleMCPEnrollmentResolver } from './enrollment';
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
it('denies a missing child instead of silently shrinking the grant', async () => {
  const { deps, resolve } = setup();
  jest
    .mocked(deps.getNodes)
    .mockResolvedValueOnce([
      { id: 'root', provider: 'test', model: 'test', agent_ids: ['private-child'] },
    ])
    .mockResolvedValueOnce([]);
  await expect(resolve(identity, {})).rejects.toMatchObject({ code: 'consent_forbidden' });
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
  expect(deps.getNodes).toHaveBeenNthCalledWith(1, ['root'], undefined);
  expect(deps.getNodes).toHaveBeenNthCalledWith(2, ['child'], expect.any(Object));
});
it('does not load an unauthorized root through the unfiltered loader', async () => {
  const { deps, resolve } = setup();
  jest.mocked(deps.canUseRoot).mockResolvedValue(false);
  await expect(resolve(identity, {})).rejects.toMatchObject({ code: 'consent_forbidden' });
  expect(deps.getNodes).not.toHaveBeenCalled();
});
