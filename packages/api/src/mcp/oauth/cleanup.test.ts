import type { MCPOAuthCleanupDependencies } from './cleanup';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  cleanupMCPServerOAuth,
  getMCPServerGeneration,
  MCPOAuthRevocationError,
  MCP_OAUTH_REVOCATION_REFUSED,
  cleanupDeletedMCPServerOAuthUsers,
} from './cleanup';

const createFlowManager = () => ({
  acquireLease: jest.fn().mockResolvedValue({
    generation: 1,
    release: jest.fn().mockResolvedValue(undefined),
  }),
  deleteFlow: jest.fn(),
});

describe('getMCPServerGeneration', () => {
  it('includes the durable database identity for user servers', () => {
    const config = { type: 'streamable-http', url: 'https://example.com', dbId: 'server-1' };

    expect(getMCPServerGeneration(config as ParsedServerConfig)).toMatch(/^db:server-1:/);
  });

  it('ignores inspection-only fields for config servers', () => {
    const config = {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      source: 'config',
      initDuration: 12,
      updatedAt: 100,
    } as ParsedServerConfig;
    const reinspected = { ...config, initDuration: 987, updatedAt: 200 };

    expect(getMCPServerGeneration(reinspected)).toBe(getMCPServerGeneration(config));
  });

  it('changes when the stable server definition changes', () => {
    const config = {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      source: 'config',
    } as ParsedServerConfig;

    expect(getMCPServerGeneration({ ...config, url: 'https://other.example.com/mcp' })).not.toBe(
      getMCPServerGeneration(config),
    );
  });

  it('versions DB-backed servers when their definition changes', () => {
    const config = {
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      dbId: 'server-1',
    } as ParsedServerConfig;

    expect(getMCPServerGeneration({ ...config, url: 'https://other.example.com/mcp' })).not.toBe(
      getMCPServerGeneration(config),
    );
  });
});

describe('cleanupMCPServerOAuth', () => {
  it('fails before deletion when a credential snapshot read fails', async () => {
    const deleteTokens = jest.fn();

    await expect(
      cleanupMCPServerOAuth({
        userId: 'user-1',
        pluginKey: 'mcp_test-server',
        dependencies: {
          flowManager: createFlowManager() as never,
          oauthHandler: {
            generateFlowId: jest.fn(),
            generateTokenFlowId: jest.fn(),
            deleteFlowAndStateMapping: jest.fn(),
            revokeOAuthToken: jest.fn(),
          },
          tokenStorage: {
            deleteUserTokens: jest.fn(),
            getClientInfoAndMetadata: jest.fn(),
            getTokens: jest.fn(),
            assertCredentialSetBinding: jest.fn(),
          },
          findToken: jest.fn().mockRejectedValue(new Error('database unavailable')),
          deleteTokens,
          getServerConfig: jest.fn(),
          isRegisteredOAuthServer: jest.fn(),
        },
      }),
    ).rejects.toThrow('database unavailable');

    expect(deleteTokens).not.toHaveBeenCalled();
  });

  it('retries when callback persistence crosses the credential snapshot', async () => {
    const deleteTokens = jest.fn();
    const flowManager = createFlowManager();
    let clientRead = 0;
    const findToken = jest.fn(async ({ type }: { type?: string }) => {
      const generation =
        type === 'mcp_oauth_client' && clientRead++ === 0 ? 'old-generation' : 'new-generation';
      return {
        token: `encrypted-${generation}-${type}`,
        metadata: { credential_set_id: generation },
      } as never;
    });
    const deleteUserTokens = jest.fn(
      async ({
        userId,
        serverName,
        deleteToken,
      }: {
        userId: string;
        serverName: string;
        deleteToken: (filter: {
          userId: string;
          type: string;
          identifier: string;
        }) => Promise<void>;
      }) => {
        const identifier = `mcp:${serverName}`;
        await Promise.all([
          deleteToken({ userId, type: 'mcp_oauth_client', identifier: `${identifier}:client` }),
          deleteToken({ userId, type: 'mcp_oauth', identifier }),
          deleteToken({
            userId,
            type: 'mcp_oauth_refresh',
            identifier: `${identifier}:refresh`,
          }),
        ]);
      },
    );

    await cleanupMCPServerOAuth({
      userId: 'user-1',
      pluginKey: 'mcp_test-server',
      serverConfigOverride: { type: 'streamable-http', url: 'https://example.com/mcp' },
      dependencies: {
        flowManager: flowManager as never,
        oauthHandler: {
          generateFlowId: jest.fn(() => 'user-1:test-server'),
          generateTokenFlowId: jest.fn(() => 'tokens-v2:user-1:test-server'),
          deleteFlowAndStateMapping: jest.fn(),
          revokeOAuthToken: jest.fn(),
        },
        tokenStorage: {
          deleteUserTokens,
          getClientInfoAndMetadata: jest.fn(),
          getTokens: jest.fn(),
          assertCredentialSetBinding: jest.fn(),
        },
        findToken: findToken as never,
        deleteTokens,
        getServerConfig: jest.fn(),
        isRegisteredOAuthServer: jest.fn(),
      },
    });

    expect(flowManager.deleteFlow).toHaveBeenCalledWith(
      'tokens-v2:user-1:test-server',
      'mcp_get_tokens',
    );
    expect(flowManager.deleteFlow).toHaveBeenCalledWith('user-1:test-server', 'mcp_get_tokens');
    expect(findToken).toHaveBeenCalledTimes(8);
    expect(deleteTokens).toHaveBeenCalledTimes(3);
    for (const [filter] of deleteTokens.mock.calls) {
      expect(filter.token).toContain('new-generation');
    }
  });

  it('deletes only token records snapshotted before flow cancellation', async () => {
    const deleteTokens = jest.fn();
    const findToken = jest.fn(async ({ type }: { type?: string }) => {
      if (type === 'mcp_oauth') {
        return {
          token: 'encrypted-old-access',
          metadata: { credential_set_id: 'partially-versioned' },
        } as never;
      }
      return type === 'mcp_oauth_refresh' ? ({ token: 'encrypted-legacy-refresh' } as never) : null;
    });
    const deleteUserTokens = jest.fn(
      async ({
        userId,
        serverName,
        deleteToken,
      }: {
        userId: string;
        serverName: string;
        deleteToken: (filter: {
          userId: string;
          type: string;
          identifier: string;
        }) => Promise<void>;
      }) => {
        const identifier = `mcp:${serverName}`;
        await deleteToken({
          userId,
          type: 'mcp_oauth_client',
          identifier: `${identifier}:client`,
        });
        await deleteToken({ userId, type: 'mcp_oauth', identifier });
        await deleteToken({
          userId,
          type: 'mcp_oauth_refresh',
          identifier: `${identifier}:refresh`,
        });
      },
    );

    await cleanupMCPServerOAuth({
      userId: 'user-1',
      pluginKey: 'mcp_test-server',
      serverConfigOverride: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        oauth: {},
      },
      dependencies: {
        flowManager: createFlowManager() as never,
        oauthHandler: {
          generateFlowId: jest.fn(() => 'user-1:test-server'),
          generateTokenFlowId: jest.fn(() => 'user-1:test-server'),
          deleteFlowAndStateMapping: jest.fn(),
          revokeOAuthToken: jest.fn(),
        },
        tokenStorage: {
          deleteUserTokens,
          getClientInfoAndMetadata: jest.fn(async () => null),
          getTokens: jest.fn(),
          assertCredentialSetBinding: jest.fn(),
        },
        findToken: findToken as never,
        deleteTokens,
        getServerConfig: jest.fn(),
        isRegisteredOAuthServer: jest.fn(),
      },
    });

    expect(deleteTokens).toHaveBeenCalledTimes(2);
    expect(deleteTokens).toHaveBeenCalledWith({
      userId: 'user-1',
      type: 'mcp_oauth',
      identifier: 'mcp:test-server',
      token: 'encrypted-old-access',
    });
  });

  it('does not revoke a credential generation created after the teardown snapshot', async () => {
    const revokeOAuthToken = jest.fn();
    const getTokens = jest.fn();
    const deleteTokens = jest.fn();
    const findToken = jest.fn(async ({ type }: { type?: string }) => ({
      token: `encrypted-old-${type}`,
      metadata: { credential_set_id: 'old-generation' },
    })) as never;

    await cleanupMCPServerOAuth({
      userId: 'user-1',
      pluginKey: 'mcp_test-server',
      serverConfigOverride: {
        type: 'streamable-http',
        url: 'https://example.com/mcp',
        oauth: {},
      },
      dependencies: {
        flowManager: createFlowManager() as never,
        oauthHandler: {
          generateFlowId: jest.fn(() => 'user-1:test-server'),
          generateTokenFlowId: jest.fn(() => 'user-1:test-server'),
          deleteFlowAndStateMapping: jest.fn(),
          revokeOAuthToken,
        },
        tokenStorage: {
          deleteUserTokens: jest.fn(),
          getClientInfoAndMetadata: jest.fn(async () => ({
            clientInfo: { client_id: 'replacement-client' },
            clientMetadata: { credential_set_id: 'replacement-generation' },
          })),
          getTokens,
          assertCredentialSetBinding: jest.fn(),
        },
        findToken,
        deleteTokens,
        getServerConfig: jest.fn(),
        isRegisteredOAuthServer: jest.fn(),
      },
    });

    expect(getTokens).not.toHaveBeenCalled();
    expect(revokeOAuthToken).not.toHaveBeenCalled();
  });

  describe('provider revocation failures', () => {
    const createRevocationDependencies = (revokeOAuthToken: jest.Mock) => {
      const deleteTokens = jest.fn();
      const findToken = jest.fn(async ({ type }: { type?: string }) => ({
        token: `encrypted-${type}`,
        metadata: { credential_set_id: 'generation-1' },
      })) as never;
      return {
        deleteTokens,
        dependencies: {
          flowManager: createFlowManager() as never,
          oauthHandler: {
            generateFlowId: jest.fn(() => 'user-1:test-server'),
            generateTokenFlowId: jest.fn(() => 'user-1:test-server'),
            deleteFlowAndStateMapping: jest.fn(),
            revokeOAuthToken,
          },
          tokenStorage: {
            deleteUserTokens: jest.fn(
              async ({
                userId,
                serverName,
                deleteToken,
              }: {
                userId: string;
                serverName: string;
                deleteToken: (filter: Record<string, string>) => Promise<void>;
              }) => {
                await deleteToken({ userId, type: 'mcp_oauth', identifier: `mcp:${serverName}` });
              },
            ),
            getClientInfoAndMetadata: jest.fn(async () => ({
              clientInfo: { client_id: 'client' },
              clientMetadata: {
                credential_set_id: 'generation-1',
                server_url: 'https://example.com/mcp',
                token_endpoint: 'https://auth.example.com/token',
                revocation_endpoint: 'https://auth.example.com/revoke',
                client_source: 'dynamic',
              },
            })),
            getTokens: jest.fn(async () => ({
              access_token: 'access',
              refresh_token: 'refresh',
              credential_set_id: 'generation-1',
            })),
            assertCredentialSetBinding: jest.fn(),
          } as unknown as MCPOAuthCleanupDependencies['tokenStorage'],
          findToken,
          deleteTokens,
          getServerConfig: jest.fn(),
          isRegisteredOAuthServer: jest.fn(),
        } satisfies MCPOAuthCleanupDependencies,
      };
    };
    const params = {
      userId: 'user-1',
      pluginKey: 'mcp_test-server',
      serverConfigOverride: {
        type: 'streamable-http' as const,
        url: 'https://example.com/mcp',
        oauth: {},
      },
    };

    it('stays best effort for a user removing their own connection', async () => {
      const revokeOAuthToken = jest.fn().mockRejectedValue(new Error('503'));
      const { deleteTokens, dependencies } = createRevocationDependencies(revokeOAuthToken);

      await expect(cleanupMCPServerOAuth({ ...params, dependencies })).resolves.toBeUndefined();
      expect(deleteTokens).toHaveBeenCalled();
    });

    it('clears local credentials and then rejects in strict mode', async () => {
      const revokeOAuthToken = jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('503'));
      const { deleteTokens, dependencies } = createRevocationDependencies(revokeOAuthToken);

      await expect(
        cleanupMCPServerOAuth({ ...params, dependencies, teardown: { strictRevocation: true } }),
      ).rejects.toMatchObject({
        code: MCP_OAUTH_REVOCATION_REFUSED,
        tokenTypes: ['refresh'],
        message: 'OAuth provider did not revoke the refresh token for test-server',
      });
      expect(revokeOAuthToken).toHaveBeenCalledTimes(2);
      expect(deleteTokens).toHaveBeenCalled();
    });

    it('hands over the fence before reporting a refused revocation', async () => {
      const { dependencies } = createRevocationDependencies(
        jest.fn().mockRejectedValue(new Error('503')),
      );
      const retainFence = jest.fn();

      await expect(
        cleanupMCPServerOAuth({
          ...params,
          dependencies,
          teardown: { strictRevocation: true, retainFence },
        }),
      ).rejects.toMatchObject({ code: MCP_OAUTH_REVOCATION_REFUSED });
      expect(retainFence).toHaveBeenCalledTimes(1);
      const lease = await (dependencies.flowManager as ReturnType<typeof createFlowManager>)
        .acquireLease.mock.results[0].value;
      expect(lease.release).not.toHaveBeenCalled();
      await retainFence.mock.calls[0][0].release();
      expect(lease.release).toHaveBeenCalledTimes(1);
    });

    it('does not hand over a fence when a local token delete fails', async () => {
      const { dependencies } = createRevocationDependencies(jest.fn());
      dependencies.tokenStorage.deleteUserTokens = jest.fn(async () => {
        throw new Error('mongo down');
      });
      const retainFence = jest.fn();

      await expect(
        cleanupMCPServerOAuth({
          ...params,
          dependencies,
          teardown: { strictRevocation: true, retainFence },
        }),
      ).rejects.toThrow('Failed to delete stored MCP OAuth tokens for test-server');
      expect(retainFence).not.toHaveBeenCalled();
      const lease = await (dependencies.flowManager as ReturnType<typeof createFlowManager>)
        .acquireLease.mock.results[0].value;
      expect(lease.release).toHaveBeenCalledTimes(1);
    });
  });
});

describe('cleanupDeletedMCPServerOAuthUsers', () => {
  it('fences ACL-named viewers without a token and passes the teardown mode through', async () => {
    const fenceAndDisconnectUser = jest.fn(async (_userId: string) => undefined);
    const uninstallOAuthMCP = jest.fn(async () => undefined);
    const getUserPrincipals = jest.fn(async (_userId: string) => []);
    const retainFence = jest.fn();

    await cleanupDeletedMCPServerOAuthUsers({
      ownerUserId: 'owner',
      serverName: 'shared',
      snapshot: { tokenUserIds: ['stranger'], aclEntries: [], viewerUserIds: ['owner', 'viewer'] },
      getTokenUserIds: async () => [],
      getUserPrincipals,
      resolveAllowlists: async () => ({}),
      fenceAndDisconnectUser,
      uninstallOAuthMCP,
      strictRevocation: true,
      retainFence,
    });

    expect(fenceAndDisconnectUser.mock.calls.map(([userId]) => userId)).toEqual([
      'owner',
      'viewer',
    ]);
    expect(getUserPrincipals.mock.calls.map(([userId]) => userId)).toEqual(['stranger']);
    expect(uninstallOAuthMCP).toHaveBeenCalledWith(
      'viewer',
      'mcp_shared',
      { mcpSettings: {} },
      undefined,
      { strictRevocation: true, retainFence },
    );
  });

  it('returns refused revocations instead of failing the cleanup', async () => {
    const uninstallOAuthMCP = jest.fn(async (userId: string) => {
      if (userId === 'viewer') {
        throw new MCPOAuthRevocationError('shared', ['access']);
      }
    });

    const refusals = await cleanupDeletedMCPServerOAuthUsers({
      ownerUserId: 'owner',
      serverName: 'shared',
      snapshot: { tokenUserIds: [], aclEntries: [], viewerUserIds: ['viewer'] },
      getTokenUserIds: async () => [],
      getUserPrincipals: async () => [],
      resolveAllowlists: async () => ({}),
      uninstallOAuthMCP,
      strictRevocation: true,
    });

    expect(refusals).toEqual([{ userId: 'viewer', tokenTypes: ['access'] }]);
  });

  it('still fails the cleanup on a local teardown failure', async () => {
    await expect(
      cleanupDeletedMCPServerOAuthUsers({
        ownerUserId: 'owner',
        serverName: 'shared',
        snapshot: { tokenUserIds: [], aclEntries: [], viewerUserIds: ['viewer'] },
        getTokenUserIds: async () => [],
        getUserPrincipals: async () => [],
        resolveAllowlists: async () => ({}),
        uninstallOAuthMCP: async () => {
          throw new Error('mongo down');
        },
        strictRevocation: true,
      }),
    ).rejects.toThrow('OAuth cleanup failed for shared');
  });
});
