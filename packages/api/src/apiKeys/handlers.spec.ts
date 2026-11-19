import { ResourceType, PermissionBits } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { ApiKeyHandlerDependencies } from './handlers';
import { createApiKeyHandlers } from './handlers';

const configured = (mode?: string) =>
  ({ endpoints: { agents: { remoteApi: mode ? { integrations: { mode } } : {} } } }) as AppConfig;

function setup(getAppConfig?: ApiKeyHandlerDependencies['getAppConfig']) {
  const keys = [{ id: 'key-1', name: 'CI', keyPrefix: 'sk-abc', createdAt: new Date(0) }];
  const handlers = createApiKeyHandlers({
    createAgentApiKey: jest.fn(),
    listAgentApiKeys: jest.fn(async () => keys),
    deleteAgentApiKey: jest.fn(),
    getAgentApiKeyById: jest.fn(),
    ...(getAppConfig && { getAppConfig }),
  });
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
  const list = async () => {
    await handlers.listApiKeys(
      { user: { id: 'owner', role: 'USER', tenantId: 'tenant' } } as unknown as Parameters<
        typeof handlers.listApiKeys
      >[0],
      res as unknown as Response,
    );
    return res.json.mock.calls[res.json.mock.calls.length - 1]?.[0];
  };
  return { list, keys, res };
}

describe('listApiKeys', () => {
  it('lists keys as before where nothing says grants are in use', async () => {
    const { list, keys } = setup();
    expect(await list()).toEqual({ keys });
    for (const config of [undefined, configured(), configured('owner')])
      expect(await setup(async () => config).list()).toEqual({ keys });
  });

  it('tells the client when key runs are limited to what the owner granted', async () => {
    const getAppConfig = jest.fn(async () => configured('delegated'));
    const { list, keys } = setup(getAppConfig);
    expect(await list()).toEqual({ keys, grants: true });
    // Resolved for the owner who asks: a tenant, role or user override decides their mode.
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'owner', role: 'USER', tenantId: 'tenant' }),
    );
  });

  it('does not list keys it could not establish the mode for', async () => {
    const { list, res } = setup(async () => {
      throw new Error('PRIVATE config store');
    });
    expect(await list()).toEqual({ error: 'Failed to list API keys' });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('listAgents', () => {
  const summaries = [
    { id: 'agent_b', name: 'Builder' },
    { id: 'agent_a', name: 'Analyst' },
    { id: 'agent_c', name: null },
  ];
  function setup(overrides: Partial<ApiKeyHandlerDependencies> = {}) {
    const findAccessibleResources = jest.fn(
      async ({ resourceType }: { resourceType: ResourceType }) =>
        resourceType === ResourceType.REMOTE_AGENT ? ['id-a', 'id-b'] : ['id-b', 'id-c'],
    );
    const getAgentModelSummaries = jest.fn(async () => summaries);
    const handlers = createApiKeyHandlers({
      createAgentApiKey: jest.fn(),
      listAgentApiKeys: jest.fn(),
      deleteAgentApiKey: jest.fn(),
      getAgentApiKeyById: jest.fn(),
      findAccessibleResources,
      getAgentModelSummaries,
      ...overrides,
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const list = async () => {
      await handlers.listAgents(
        { user: { id: 'owner', role: 'USER' } } as unknown as Parameters<
          typeof handlers.listAgents
        >[0],
        res as unknown as Response,
      );
      return res.json.mock.calls[res.json.mock.calls.length - 1]?.[0];
    };
    return { list, res, findAccessibleResources, getAgentModelSummaries };
  }

  it('lists the agents the caller may run remotely: shared for remote use, or theirs to share', async () => {
    const { list, findAccessibleResources, getAgentModelSummaries } = setup();
    expect(await list()).toEqual({
      // By name, and by id where an agent has none.
      agents: [
        { id: 'agent_c', name: null },
        { id: 'agent_a', name: 'Analyst' },
        { id: 'agent_b', name: 'Builder' },
      ],
    });
    // The two halves of the rule one remote run is checked against, asked together.
    expect(findAccessibleResources.mock.calls.map(([params]) => params)).toEqual([
      {
        userId: 'owner',
        role: 'USER',
        resourceType: ResourceType.REMOTE_AGENT,
        requiredPermissions: PermissionBits.VIEW,
      },
      {
        userId: 'owner',
        role: 'USER',
        resourceType: ResourceType.AGENT,
        requiredPermissions: PermissionBits.SHARE,
      },
    ]);
    // An agent reachable both ways is looked up once.
    expect(getAgentModelSummaries).toHaveBeenCalledWith(['id-a', 'id-b', 'id-c']);
  });

  it('reads no agents when the caller can run none', async () => {
    const { list, getAgentModelSummaries } = setup({ findAccessibleResources: async () => [] });
    expect(await list()).toEqual({ agents: [] });
    expect(getAgentModelSummaries).not.toHaveBeenCalled();
  });

  it('does not answer with a partial list when a lookup fails', async () => {
    const { list, res } = setup({
      getAgentModelSummaries: async () => {
        throw new Error('PRIVATE store detail');
      },
    });
    expect(await list()).toEqual({ error: 'Failed to list agents' });
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
