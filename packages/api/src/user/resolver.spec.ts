import { tenantStorage, runAsSystem } from '@librechat/data-schemas';
import type { IMongoFile } from '@librechat/data-schemas';
import type { ErasureResolverDeps } from './resolver';
import { createErasureResolver } from './resolver';

function createDeps(overrides: Partial<ErasureResolverDeps> = {}) {
  const disconnectUserConnection = jest.fn().mockResolvedValue(undefined);
  const deps = {
    db: { deleteConvos: jest.fn() },
    getAppConfig: jest
      .fn()
      .mockResolvedValue({ endpoints: { agents: { checkpointer: { ttl: 5 } } } }),
    processDeleteRequest: jest.fn().mockResolvedValue({ deletedFileIds: [], failedFileIds: [] }),
    invalidateCachedTools: jest.fn().mockResolvedValue(undefined),
    getMCPManager: jest.fn(() => ({ disconnectUserConnection })),
    openCheckpointDeletion: jest.fn(),
    deleteSharedLinks: jest.fn(),
    withTenant: <T>(tenant: string | undefined, operation: () => Promise<T>) =>
      tenant ? tenantStorage.run({ tenantId: tenant }, operation) : runAsSystem(operation),
    ...overrides,
  } as unknown as ErasureResolverDeps;
  return { deps, disconnectUserConnection };
}

const target = { id: 'user-1', role: 'USER', tenantId: 'tenant-1' };

describe('createErasureResolver', () => {
  it('resolves the target config and its checkpointer', async () => {
    const { deps } = createDeps();
    const result = await createErasureResolver(deps)(target);

    expect(deps.getAppConfig).toHaveBeenCalledWith({
      role: 'USER',
      userId: 'user-1',
      tenantId: 'tenant-1',
      failClosed: true,
    });
    expect(result.checkpointer).toEqual({ ttl: 5 });
    expect(result.deps.openCheckpointDeletion).toBe(deps.openCheckpointDeletion);
    expect(result.deps.deleteSharedLinks).toBe(deps.deleteSharedLinks);
  });

  it('passes the loaded external identity so principal resolution does not re-read the user', async () => {
    const { deps } = createDeps();
    await createErasureResolver(deps)({ ...target, idOnTheSource: 'ext-1' });

    expect(deps.getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-1', idOnTheSource: 'ext-1' }),
    );
  });

  it('builds the shared-server OAuth hooks for the target account', async () => {
    const registry = {
      getServerConfig: jest.fn().mockResolvedValue({ url: 'https://srv' }),
      resolveAllowlists: jest.fn().mockResolvedValue({}),
    };
    const mcpOAuth = {
      getRegistry: () => registry,
      getUserPrincipals: jest.fn().mockResolvedValue([]),
      uninstallOAuthMCP: jest.fn(),
    };
    const { deps } = createDeps({ mcpOAuth });
    const { deps: erasure } = await createErasureResolver(deps)(target);

    await erasure.mcpOAuth?.getServerConfig?.('srv', 'srv-id');
    await erasure.mcpOAuth?.getUserPrincipals('other-user');
    await erasure.mcpOAuth?.resolveAllowlists('other-user');
    await erasure.mcpOAuth?.invalidateUserTools?.('other-user', 'srv');
    await erasure.mcpOAuth?.disconnectUser?.('other-user', 'srv');

    /** Cleanup revokes credentials, so it reaches a server the account's profile hides. */
    expect(registry.getServerConfig).toHaveBeenCalledWith('srv', 'user-1', undefined, undefined, {
      includeHidden: true,
    });
    expect(mcpOAuth.getUserPrincipals).toHaveBeenCalledWith({ userId: 'other-user' });
    expect(registry.resolveAllowlists).toHaveBeenCalledWith({ userId: 'other-user' });
    expect(deps.invalidateCachedTools).toHaveBeenCalledWith({
      userId: 'other-user',
      serverName: 'srv',
    });
    await erasure.mcpOAuth?.uninstallOAuthMCP('other-user', 'mcp_srv', {});
    expect(mcpOAuth.uninstallOAuthMCP).toHaveBeenCalledWith('other-user', 'mcp_srv', {}, undefined);
  });

  it('runs id-keyed lookups in the target tenant, not the calling admin tenant', async () => {
    const seen: Record<string, unknown> = {};
    const record = (key: string) => async () => {
      seen[key] = tenantStorage.getStore()?.tenantId;
      return [];
    };
    const registry = {
      getServerConfig: jest.fn(record('config')),
      resolveAllowlists: jest.fn(record('allowlists')),
    };
    const { deps } = createDeps({
      db: {
        deleteUserAgents: jest.fn(record('agents')),
        findMCPServerOAuthTokenUserIds: jest.fn(record('tokens')),
        findMCPServerViewerEntries: jest.fn(record('viewers')),
      } as unknown as ErasureResolverDeps['db'],
      processDeleteRequest: jest.fn(record('files')),
      invalidateCachedTools: jest.fn(record('fence')),
      mcpOAuth: {
        getRegistry: () => registry,
        getUserPrincipals: jest.fn(record('principals')),
        uninstallOAuthMCP: jest.fn(record('uninstall')),
      },
    } as unknown as Partial<ErasureResolverDeps>);
    const { deps: erasure } = await createErasureResolver(deps)(target);

    await tenantStorage.run({ tenantId: 'admin-tenant' }, async () => {
      await erasure.deleteUserAgents('user-1');
      await erasure.findMCPServerOAuthTokenUserIds?.('srv');
      await erasure.findMCPServerViewerEntries?.('srv-id');
      await erasure.deleteStoredFiles([]);
      await erasure.mcpOAuth?.getServerConfig?.('srv', 'srv-id');
      await erasure.mcpOAuth?.getUserPrincipals('other');
      await erasure.mcpOAuth?.resolveAllowlists('other');
      await erasure.mcpOAuth?.uninstallOAuthMCP('other', 'mcp_srv', {});
      await erasure.mcpOAuth?.invalidateUserTools?.('other', 'srv');
      await erasure.mcpOAuth?.disconnectUser?.('other', 'srv');
    });

    expect(Object.keys(seen)).toHaveLength(9);
    expect(Object.values(seen).every((tenant) => tenant === 'tenant-1')).toBe(true);
  });

  it('resolves the target config under the target tenant, not the calling admin tenant', async () => {
    let seen: string | undefined;
    const { deps } = createDeps({
      getAppConfig: jest.fn(async () => {
        seen = tenantStorage.getStore()?.tenantId;
        return {};
      }),
    });

    await tenantStorage.run({ tenantId: 'admin-tenant' }, () =>
      createErasureResolver(deps)(target),
    );

    expect(seen).toBe('tenant-1');
  });

  it('rejects when the target config cannot be resolved', async () => {
    const { deps } = createDeps({
      getAppConfig: jest.fn().mockRejectedValue(new Error('override store down')),
    });
    await expect(createErasureResolver(deps)(target)).rejects.toThrow('override store down');
  });

  it('deletes stored files with a request that carries the target user', async () => {
    const { deps } = createDeps();
    const { deps: erasure } = await createErasureResolver(deps)(target);
    const files = [{ file_id: 'f1' }] as IMongoFile[];

    await erasure.deleteStoredFiles(files);

    expect(deps.processDeleteRequest).toHaveBeenCalledWith({
      req: expect.objectContaining({
        user: { id: 'user-1', _id: 'user-1', role: 'USER', tenantId: 'tenant-1' },
        body: {},
        query: {},
        baseUrl: '',
      }),
      files,
    });
  });

  it('preserves storage failure receipts for the account-erasure contract', async () => {
    const { deps } = createDeps();
    const outcome = { deletedFileIds: [], failedFileIds: ['file-1'] };
    (deps.processDeleteRequest as jest.Mock).mockResolvedValue(outcome);
    const { deps: erasure } = await createErasureResolver(deps)(target);
    expect(await erasure.deleteStoredFiles([])).toBe(outcome);
  });

  it('carries the target profile fields for header templates', async () => {
    const { deps } = createDeps();
    const { deps: erasure } = await createErasureResolver(deps)({
      ...target,
      profile: { email: 'target@example.com', name: 'Target' },
    });

    await erasure.deleteStoredFiles([]);

    expect(deps.processDeleteRequest).toHaveBeenCalledWith({
      req: expect.objectContaining({
        user: {
          email: 'target@example.com',
          name: 'Target',
          id: 'user-1',
          _id: 'user-1',
          role: 'USER',
          tenantId: 'tenant-1',
        },
      }),
      files: [],
    });
  });

  it('scopes MCP runtime cleanup to the target user', async () => {
    const { deps, disconnectUserConnection } = createDeps();
    const { deps: erasure } = await createErasureResolver(deps)(target);

    await erasure.invalidateMCPServerTools?.('srv');
    await erasure.disconnectMCPServer?.('srv');

    expect(deps.invalidateCachedTools).toHaveBeenCalledWith({
      userId: 'user-1',
      serverName: 'srv',
    });
    expect(disconnectUserConnection).toHaveBeenCalledWith('user-1', 'srv');
  });

  it('tolerates a missing MCP manager', async () => {
    const { deps } = createDeps({ getMCPManager: jest.fn(() => undefined) });
    const { deps: erasure } = await createErasureResolver(deps)(target);

    await expect(erasure.disconnectMCPServer?.('srv')).resolves.toBeUndefined();
  });
});
