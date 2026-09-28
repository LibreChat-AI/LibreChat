import type { ParsedServerConfig } from '~/mcp/types';
import { cleanupMCPServerOAuth, getMCPServerGeneration } from './cleanup';

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
});
