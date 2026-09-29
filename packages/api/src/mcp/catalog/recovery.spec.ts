import { logger } from '@librechat/data-schemas';
import { Constants } from 'librechat-data-provider';
import { ErrorCode, McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { IUser } from '@librechat/data-schemas';
import type {
  MCPRecoveryGenerationScope,
  MCPServerCatalogLoaderDeps,
  MCPServerCatalogRecoveryPolicy,
} from './recovery';
import type { LCAvailableTools, ParsedServerConfig, ToolDiscoveryOptions } from '../types';
import {
  MCPCatalogCapacityError,
  MCPServerCatalogRecoveryTracker,
  loadMCPServerCatalogs,
  publishMCPAuthorizationMutation,
  readMCPRecoveryGeneration,
  readMCPRecoveryGenerationAround,
  recoverMCPServerCatalogs,
} from './recovery';
import { prepareMCPAuthorizationMutation } from '../authorization';
import { MCPTokenRefreshUnavailableError } from '../oauth';

jest.mock('@librechat/data-schemas', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const user = { id: 'user-1' } as IUser;
const recoveryTracker = new MCPServerCatalogRecoveryTracker();
const serverConfig = (name: string): ParsedServerConfig =>
  ({ type: 'streamable-http', url: `https://${name}.example.com/mcp` }) as ParsedServerConfig;
const withUserVars = (config: ParsedServerConfig): ParsedServerConfig =>
  ({
    ...config,
    customUserVars: { API_KEY: { title: 'API key', description: 'Server API key' } },
  }) as ParsedServerConfig;
const availableTools = (name: string): LCAvailableTools => ({
  [name]: {
    type: 'function',
    function: {
      name,
      description: '',
      parameters: { type: 'object', properties: {} },
    },
  },
});

afterEach(() => {
  recoveryTracker.clear(user.id);
  jest.restoreAllMocks();
});

describe('readMCPRecoveryGeneration', () => {
  it('keeps recovery available when the injected shared cache is unavailable', async () => {
    const reader = jest.fn().mockRejectedValue(new Error('cache unavailable'));

    await expect(
      readMCPRecoveryGeneration({ userId: user.id, serverName: 'oauth-server' }, reader),
    ).resolves.toBeUndefined();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('oauth-server'),
      expect.any(Error),
    );
  });

  it('returns unknown instead of waiting indefinitely for the shared cache', async () => {
    const reader = jest.fn(() => new Promise<string>(() => undefined));

    await expect(
      readMCPRecoveryGeneration({ userId: user.id, serverName: 'slow-cache' }, reader, {
        timeoutMs: 5,
      }),
    ).resolves.toBeUndefined();
  });
});

describe('readMCPRecoveryGenerationAround', () => {
  it('returns a generation only when both reads coherently bracket the operation', async () => {
    const operation = jest.fn().mockResolvedValue('authorized');
    const changedReader = jest
      .fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-2');

    await expect(
      readMCPRecoveryGenerationAround(
        { userId: user.id, serverName: 'oauth' },
        changedReader,
        operation,
      ),
    ).resolves.toEqual({ value: 'authorized' });
  });
});

describe('publishMCPAuthorizationMutation', () => {
  it('retries the shared fence and clears local suppression only after it advances', async () => {
    const invalidateRecoveryGeneration = jest
      .fn()
      .mockRejectedValueOnce(new Error('cache unavailable'))
      .mockResolvedValue(undefined);
    const clearLocalRecovery = jest.fn();
    const persistPublicationRetry = jest.fn().mockResolvedValue('retry-v1');
    const clearPublicationRetry = jest.fn().mockResolvedValue(undefined);

    await publishMCPAuthorizationMutation(
      { userId: user.id, serverName: 'oauth' },
      {
        invalidateRecoveryGeneration,
        clearLocalRecovery,
        persistPublicationRetry,
        clearPublicationRetry,
        retryDelaysMs: [0, 0],
      },
    );

    expect(invalidateRecoveryGeneration).toHaveBeenCalledTimes(2);
    expect(persistPublicationRetry.mock.invocationCallOrder[0]).toBeLessThan(
      invalidateRecoveryGeneration.mock.invocationCallOrder[0],
    );
    expect(clearPublicationRetry).toHaveBeenCalledWith(
      { userId: user.id, serverName: 'oauth' },
      'retry-v1',
    );
    expect(clearLocalRecovery).toHaveBeenCalledWith(user.id, 'oauth', undefined);
  });

  it('bounds retry-intent cleanup and hands local recovery the generation it wrote', async () => {
    const clearLocalRecovery = jest.fn();

    await expect(
      publishMCPAuthorizationMutation(
        { userId: user.id, serverName: 'oauth' },
        {
          invalidateRecoveryGeneration: jest.fn().mockResolvedValue('generation-2'),
          persistPublicationRetry: jest.fn().mockResolvedValue('retry-v1'),
          clearPublicationRetry: jest.fn(() => new Promise<void>(() => undefined)),
          clearLocalRecovery,
          retryDelaysMs: [0],
          attemptTimeoutMs: 5,
        },
      ),
    ).resolves.toBe('generation-2');

    expect(clearLocalRecovery).toHaveBeenCalledWith(user.id, 'oauth', 'generation-2');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not clear its retry intent'),
      expect.any(Error),
    );
  });

  it('bounds each shared fence attempt', async () => {
    const invalidateRecoveryGeneration = jest.fn(() => new Promise(() => undefined));
    const persistPublicationRetry = jest.fn().mockResolvedValue('retry-v1');
    const clearPublicationRetry = jest.fn();

    await expect(
      publishMCPAuthorizationMutation(
        { userId: user.id, serverName: 'oauth' },
        {
          invalidateRecoveryGeneration,
          persistPublicationRetry,
          clearPublicationRetry,
          retryDelaysMs: [0],
          attemptTimeoutMs: 5,
        },
      ),
    ).rejects.toThrow('MCP authorization generation publication timed out');

    expect(invalidateRecoveryGeneration).toHaveBeenCalledTimes(1);
    expect(persistPublicationRetry).toHaveBeenCalledTimes(1);
    expect(clearPublicationRetry).not.toHaveBeenCalled();
  });
});

describe('MCPServerCatalogRecoveryTracker capacity', () => {
  const policy = {
    discoveryBackoffMs: [60_000],
    discoveryTimeoutMs: 3_000,
    discoverySettleGraceMs: 10_000,
    reauthRetryMs: 60_000,
    maxStateEntries: 2,
    maxDetachedDiscoveries: 3,
    generationReadTimeoutMs: 500,
    authorizationFenceRetryMs: [0],
    authorizationFenceTimeoutMs: 1_000,
    authorizationFenceRetryIntervalMs: 30_000,
    authorizationFenceRetryBatchSize: 100,
  };

  const candidate = (serverName: string) => ({
    serverName,
    serverConfig: serverConfig(serverName),
  });
  const failed = (serverName: string) => async () => ({
    serverName,
    tools: null,
    state: 'backoff' as const,
  });

  it('keeps one process-wide capacity when requests carry different limits', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker(2);
    const discoverA = jest.fn(failed('a'));

    await tracker.run(user, candidate('a'), policy, 'generation-1', discoverA);
    await tracker.run(
      user,
      candidate('b'),
      { ...policy, maxStateEntries: 1 },
      'generation-1',
      failed('b'),
    );
    await tracker.run(user, candidate('a'), policy, 'generation-1', discoverA);

    expect(discoverA).toHaveBeenCalledTimes(1);
  });

  it('evicts the least recently used completed entry', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker(2);
    const discoverA = jest.fn(failed('a'));
    const discoverB = jest.fn(failed('b'));

    await tracker.run(user, candidate('a'), policy, 'generation-1', discoverA);
    await tracker.run(user, candidate('b'), policy, 'generation-1', discoverB);
    await tracker.run(user, candidate('a'), policy, 'generation-1', discoverA);
    await tracker.run(user, candidate('c'), policy, 'generation-1', failed('c'));
    await tracker.run(user, candidate('a'), policy, 'generation-1', discoverA);
    await tracker.run(user, candidate('b'), policy, 'generation-1', discoverB);

    expect(discoverA).toHaveBeenCalledTimes(1);
    expect(discoverB).toHaveBeenCalledTimes(2);
  });
});

describe('MCPServerCatalogRecoveryTracker own credential publications', () => {
  const policy = {
    discoveryBackoffMs: [60_000],
    discoveryTimeoutMs: 3_000,
    discoverySettleGraceMs: 10_000,
    reauthRetryMs: 60_000,
    maxStateEntries: 10,
    maxDetachedDiscoveries: 3,
    generationReadTimeoutMs: 500,
    authorizationFenceRetryMs: [0],
    authorizationFenceTimeoutMs: 1_000,
    authorizationFenceRetryIntervalMs: 30_000,
    authorizationFenceRetryBatchSize: 100,
  };
  const serverName = 'oauth-server';
  const candidate = { serverName, serverConfig: serverConfig(serverName) };
  const listed = () => ({ serverName, tools: availableTools('listed') });
  const failed = () => ({ serverName, tools: null, state: 'backoff' as const });

  it('stays joinable through the local clear its own publication performs', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    const replacement = jest.fn(async () => listed());
    let joined: Promise<unknown> | undefined;

    const flight = tracker.run(
      user,
      candidate,
      policy,
      'generation-1',
      async (trackPublication) => {
        await trackPublication(async () => {
          tracker.clear(user.id, serverName, 'generation-2');
          joined = tracker.run(user, candidate, policy, 'generation-2', replacement);
          return 'generation-2';
        });
        return listed();
      },
    );

    const outcome = await flight;
    expect(outcome).toEqual({ ...listed(), recoveryGeneration: 'generation-2', adopted: true });
    await expect(joined).resolves.toBe(outcome);
    expect(replacement).not.toHaveBeenCalled();
  });

  it('applies a clear that arrived during its own publication when that publication fails', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    await tracker.run(user, candidate, policy, 'generation-1', async (trackPublication) => {
      await trackPublication(async () => {
        tracker.clear(user.id, serverName);
        throw new Error('tool cache unavailable');
      }).catch(() => undefined);
      return failed();
    });

    const retry = jest.fn(async () => failed());
    await tracker.run(user, candidate, policy, 'generation-1', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('does not re-key the retained state of a flight its publication outlived', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    let releasePublication: () => void = () => undefined;
    let publication: Promise<string | undefined> | undefined;
    await tracker.run(user, candidate, policy, 'generation-1', async (trackPublication) => {
      publication = trackPublication(async () => {
        await new Promise<void>((resolve) => {
          releasePublication = resolve;
        });
        return 'generation-2';
      });
      return failed();
    });

    releasePublication();
    await publication;
    const retry = jest.fn(async () => listed());
    await tracker.run(user, candidate, policy, 'generation-2', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('applies a clear at once to a flight that settled while its own publication is open', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    let releasePublication: () => void = () => undefined;
    let publication: Promise<string | undefined> | undefined;
    await tracker.run(user, candidate, policy, 'generation-1', async (trackPublication) => {
      publication = trackPublication(async () => {
        await new Promise<void>((resolve) => {
          releasePublication = resolve;
        });
        return 'generation-2';
      });
      return failed();
    });

    tracker.clear(user.id, serverName);
    const retry = jest.fn(async () => failed());
    await tracker.run(user, candidate, policy, 'generation-1', retry);
    expect(retry).toHaveBeenCalledTimes(1);
    releasePublication();
    await publication;
  });

  it('still applies a clear from another writer that arrives during its own publication', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    const tearDownConnection = () => tracker.clear(user.id, serverName);
    const clearAfterFence = () => tracker.clear(user.id, serverName, 'generation-2');
    await tracker.run(user, candidate, policy, 'generation-1', async (trackPublication) => {
      await trackPublication(async () => {
        tearDownConnection();
        clearAfterFence();
        return 'generation-2';
      });
      return failed();
    });

    const retry = jest.fn(async () => failed());
    await tracker.run(user, candidate, policy, 'generation-2', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'spares a flight observed under the generation a clear carries',
      'generation-2',
      'generation-2',
    ],
    [
      'spares a flight observed under another generation for its requests to confirm',
      'generation-2',
      'generation-3',
    ],
    [
      'clears a flight that observed no generation on a clear that carries one',
      undefined,
      'generation-3',
    ],
    ['clears a flight on a clear that carries no generation', 'generation-2', undefined],
  ])('%s', async (_case, observedGeneration, clearedGeneration) => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    let releaseDiscovery: () => void = () => undefined;
    const flight = tracker.run(user, candidate, policy, observedGeneration, async () => {
      await new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      return listed();
    });
    await new Promise((resolve) => setImmediate(resolve));

    tracker.clear(user.id, serverName, clearedGeneration);
    releaseDiscovery();

    const kept = observedGeneration != null && clearedGeneration != null;
    const unconfirmed = kept && observedGeneration !== clearedGeneration;
    await expect(flight).resolves.toEqual(
      kept
        ? {
            ...listed(),
            recoveryGeneration: observedGeneration,
            ...(unconfirmed && { unconfirmed }),
          }
        : { serverName, tools: null },
    );
  });

  it('does not retain the outcome of a flight that a mismatched clear spared', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    let releaseDiscovery: () => void = () => undefined;
    const flight = tracker.run(user, candidate, policy, 'generation-2', async () => {
      await new Promise<void>((resolve) => {
        releaseDiscovery = resolve;
      });
      return failed();
    });
    await new Promise((resolve) => setImmediate(resolve));

    tracker.clear(user.id, serverName, 'generation-3');
    releaseDiscovery();
    await flight;

    const retry = jest.fn(async () => failed());
    await tracker.run(user, candidate, policy, 'generation-2', retry);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('discards a flight with no known generation that a clear spared while its publication failed', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    const flight = tracker.run(user, candidate, policy, undefined, async (trackPublication) => {
      await trackPublication(async () => {
        tracker.clear(user.id, serverName, 'generation-3');
        throw new Error('tool cache unavailable');
      }).catch(() => undefined);
      return listed();
    });

    await expect(flight).resolves.toEqual({ serverName, tools: null });
  });

  it('keeps a newer flight when a publication that outlived its own flight clears with its generation', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker();
    let releasePublication: () => void = () => undefined;
    let releaseNewer: () => void = () => undefined;
    let publication: Promise<string | undefined> | undefined;
    await tracker.run(user, candidate, policy, 'generation-1', async (trackPublication) => {
      publication = trackPublication(async () => {
        await new Promise<void>((resolve) => {
          releasePublication = resolve;
        });
        tracker.clear(user.id, serverName, 'generation-2');
        return 'generation-2';
      });
      return failed();
    });
    const newer = tracker.run(user, candidate, policy, 'generation-2', async () => {
      await new Promise<void>((resolve) => {
        releaseNewer = resolve;
      });
      return listed();
    });
    await new Promise((resolve) => setImmediate(resolve));

    releasePublication();
    await publication;
    releaseNewer();

    await expect(newer).resolves.toEqual({ ...listed(), recoveryGeneration: 'generation-2' });
  });
});

describe('recoverMCPServerCatalogs', () => {
  it('does not discover with a credential snapshot superseded while auth was loading', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const getRecoveryGeneration = jest
      .fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-2');

    const result = await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          {
            serverName: 'guarded',
            serverConfig: withUserVars(serverConfig('guarded')),
          },
        ],
      },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({
          [`${Constants.mcp_prefix}guarded`]: { API_KEY: 'old-value' },
        }),
        discoverServerTools,
        formatServerTools: jest.fn().mockReturnValue({}),
        getRecoveryGeneration,
        recoveryTracker,
      },
    );

    expect(result.size).toBe(0);
    expect(discoverServerTools).not.toHaveBeenCalled();
  });

  it('does not discover custom credentials when either bracketing generation is unknown', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const getRecoveryGeneration = jest
      .fn()
      .mockRejectedValueOnce(new Error('cache unavailable'))
      .mockResolvedValueOnce('generation-2');

    await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          {
            serverName: 'guarded',
            serverConfig: withUserVars(serverConfig('guarded')),
          },
        ],
      },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({
          [`${Constants.mcp_prefix}guarded`]: { API_KEY: 'possibly-stale' },
        }),
        discoverServerTools,
        formatServerTools: jest.fn().mockReturnValue({}),
        getRecoveryGeneration,
        recoveryTracker,
      },
    );

    expect(discoverServerTools).not.toHaveBeenCalled();
  });

  it('discards discovery completed after its authorization generation was superseded', async () => {
    const getRecoveryGeneration = jest
      .fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-2');

    const result = await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'oauth', serverConfig: serverConfig('oauth') }] },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn().mockResolvedValue({
          tools: [{ name: 'stale', inputSchema: { type: 'object' } }],
        }),
        formatServerTools: jest.fn().mockReturnValue(availableTools('stale')),
        getRecoveryGeneration,
        recoveryTracker,
      },
    );

    expect(result.size).toBe(0);
  });

  it('preserves backoff when generation reads intermittently fail', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: null });
    const getRecoveryGeneration = jest
      .fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-1')
      .mockRejectedValue(new Error('cache unavailable'));
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue({}),
      getRecoveryGeneration,
      recoveryTracker,
    };
    const servers = [{ serverName: 'offline', serverConfig: serverConfig('offline') }];

    await recoverMCPServerCatalogs({ user, servers }, deps);
    await recoverMCPServerCatalogs({ user, servers }, deps);

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
  });

  it('retains a known generation when a due retry runs during a cache outage', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: null });
    const getRecoveryGeneration = jest
      .fn()
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-1')
      .mockResolvedValueOnce('generation-1');
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue({}),
      getRecoveryGeneration,
      recoveryTracker,
    };
    const servers = [{ serverName: 'offline', serverConfig: serverConfig('offline') }];
    const recoveryPolicy = { discoveryBackoffMs: [10, 20] };

    await recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
    now += 10;
    getRecoveryGeneration.mockRejectedValue(new Error('cache unavailable'));
    await recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
    now += 1;
    getRecoveryGeneration.mockResolvedValue('generation-1');
    await recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);

    expect(discoverServerTools).toHaveBeenCalledTimes(2);
  });

  it('loads user auth once and preserves config-only lookup context for each server', async () => {
    const servers = [
      { serverName: 'alpha', serverConfig: withUserVars(serverConfig('alpha')) },
      { serverName: 'beta', serverConfig: withUserVars(serverConfig('beta')) },
    ];
    const loadUserMCPAuthMap = jest.fn().mockResolvedValue({
      [`${Constants.mcp_prefix}alpha`]: { API_KEY: 'alpha-secret' },
      [`${Constants.mcp_prefix}beta`]: { API_KEY: 'beta-secret' },
    });
    const discoverServerTools = jest.fn(async ({ serverName }: ToolDiscoveryOptions) => ({
      tools: [{ name: `${serverName}-tool`, inputSchema: { type: 'object' as const } }],
    }));
    const formatServerTools = jest.fn((serverName: string) =>
      availableTools(`tool${Constants.mcp_delimiter}${serverName}`),
    );

    const result = await recoverMCPServerCatalogs(
      { user, servers },
      {
        loadUserMCPAuthMap,
        discoverServerTools,
        formatServerTools,
        getRecoveryGeneration: jest.fn().mockResolvedValue('generation-1'),
      },
    );

    expect(loadUserMCPAuthMap).toHaveBeenCalledTimes(1);
    expect(loadUserMCPAuthMap).toHaveBeenCalledWith('user-1', ['alpha', 'beta']);
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        serverName: 'alpha',
        configServers: { alpha: servers[0].serverConfig },
        customUserVars: { API_KEY: 'alpha-secret' },
      }),
    );
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        user,
        serverName: 'beta',
        configServers: { beta: servers[1].serverConfig },
        customUserVars: { API_KEY: 'beta-secret' },
      }),
    );
    expect(result.size).toBe(2);
  });

  it('limits passive discovery to three concurrent servers across simultaneous catalog loads', async () => {
    const servers = Array.from({ length: 7 }, (_, index) => ({
      serverName: `server-${index}`,
      serverConfig: serverConfig(`server-${index}`),
    }));
    let active = 0;
    let maxActive = 0;
    const discoverServerTools = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { tools: [] };
    });
    const getServerToolFunctionsSnapshot = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return { tools: null };
    });

    const deps = {
      getCachedServerTools: jest.fn().mockResolvedValue(null),
      getServerToolFunctionsSnapshot,
      cacheServerTools: jest.fn(),
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue({}),
    };
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, () => loadMCPServerCatalogs({ user, servers }, deps)),
    );

    expect(getServerToolFunctionsSnapshot).toHaveBeenCalledTimes(21);
    expect(discoverServerTools.mock.calls.length).toBeGreaterThan(0);
    expect(discoverServerTools.mock.calls.length).toBeLessThanOrEqual(21);
    expect(maxActive).toBe(3);
    expect(results).toHaveLength(4);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(3);
    expect(results.filter(({ status }) => status === 'rejected')).toEqual([
      { status: 'rejected', reason: expect.any(MCPCatalogCapacityError) },
    ]);
    expect(
      results.flatMap((result) =>
        result.status === 'fulfilled' ? [...result.value.serverTools.keys()] : [],
      ),
    ).toHaveLength(21);
  });

  it('logs configuration-impossible discovery failures at debug, keeping error for the unexpected', async () => {
    const servers = [
      { serverName: 'policy-blocked', serverConfig: serverConfig('blocked') },
      { serverName: 'crashed', serverConfig: serverConfig('crashed') },
    ];

    const result = await recoverMCPServerCatalogs(
      { user, servers },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn(async ({ serverName }: ToolDiscoveryOptions) => {
          if (serverName === 'policy-blocked') {
            throw new McpError(
              ErrorCode.InvalidRequest,
              'Resolved MCP server URL is not allowed by the configured domain policy.',
            );
          }
          throw new Error('socket hang up');
        }),
        formatServerTools: jest.fn(),
      },
    );

    expect(result.size).toBe(0);
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('policy-blocked is not recoverable under current configuration'),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('crashed'),
      expect.any(Error),
    );
  });

  it('keeps successful catalogs when another server fails or has no authoritative tools', async () => {
    const servers = ['good', 'failed', 'missing'].map((serverName) => ({
      serverName,
      serverConfig: serverConfig(serverName),
    }));

    const result = await recoverMCPServerCatalogs(
      { user, servers },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn(async ({ serverName }: ToolDiscoveryOptions) => {
          if (serverName === 'failed') {
            throw new Error('offline');
          }
          return { tools: serverName === 'missing' ? null : [] };
        }),
        formatServerTools: jest.fn().mockReturnValue({}),
      },
    );

    expect([...result.keys()]).toEqual(['good']);
  });

  it('single-flights concurrent discovery for the same user and server', async () => {
    let release: ((value: { tools: Tool[] }) => void) | undefined;
    const discoverServerTools = jest.fn(
      () =>
        new Promise<{ tools: Tool[] }>((resolve) => {
          release = resolve;
        }),
    );
    const servers = [{ serverName: 'shared', serverConfig: serverConfig('shared') }];
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('shared-tool')),
      recoveryTracker,
    };

    const first = recoverMCPServerCatalogs({ user, servers }, deps);
    const second = recoverMCPServerCatalogs({ user, servers }, deps);
    await new Promise((resolve) => setImmediate(resolve));

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    release?.({ tools: [] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      new Map([['shared', availableTools('shared-tool')]]),
      new Map([['shared', availableTools('shared-tool')]]),
    ]);
  });

  it('retains reauthorization state and recovered public tools during the retry window', async () => {
    let recoveryGeneration = 'generation-1';
    const discoverServerTools = jest.fn().mockResolvedValue({
      tools: [{ name: 'public-tool', inputSchema: { type: 'object' as const } }],
      oauthRequired: true,
      authenticationKind: 'oauth' as const,
    });
    const servers = [{ serverName: 'oauth-server', serverConfig: serverConfig('oauth-server') }];
    const deps = {
      getCachedServerTools: jest.fn().mockResolvedValue(null),
      getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
      cacheServerTools: jest.fn(),
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('public-tool')),
      recoveryTracker,
      getRecoveryGeneration: jest.fn(async () => recoveryGeneration),
    };

    const first = await loadMCPServerCatalogs({ user, servers }, deps);
    const second = await loadMCPServerCatalogs({ user, servers }, deps);

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(first.reauthRequiredServers).toEqual(new Set(['oauth-server']));
    expect(first.reauthRequiredGenerations).toEqual(new Map([['oauth-server', 'generation-1']]));
    expect(first.serverTools).toEqual(new Map([['oauth-server', availableTools('public-tool')]]));
    expect(second.reauthRequiredServers).toEqual(new Set(['oauth-server']));
    expect(second.serverTools).toEqual(new Map());

    recoveryGeneration = 'generation-2';
    const afterCredentialMutation = await loadMCPServerCatalogs({ user, servers }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
    expect(afterCredentialMutation.reauthRequiredGenerations).toEqual(
      new Map([['oauth-server', 'generation-2']]),
    );
  });

  it('backs off non-OAuth authorization failures instead of requesting reauthorization', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({
      tools: null,
      oauthRequired: true,
      authenticationKind: 'server' as const,
    });
    const servers = [{ serverName: 'server-auth', serverConfig: serverConfig('server-auth') }];
    const deps = {
      getCachedServerTools: jest.fn().mockResolvedValue(null),
      getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
      cacheServerTools: jest.fn(),
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn(),
      recoveryTracker,
    };

    const first = await loadMCPServerCatalogs({ user, servers }, deps);
    const second = await loadMCPServerCatalogs({ user, servers }, deps);

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(first.reauthRequiredServers).toEqual(new Set());
    expect(second.reauthRequiredServers).toEqual(new Set());
  });

  it('backs off transient OAuth refresh failures instead of requesting reauthorization', async () => {
    const discoverServerTools = jest
      .fn()
      .mockRejectedValue(
        new MCPTokenRefreshUnavailableError('oauth-server', new Error('provider unavailable')),
      );
    const servers = [{ serverName: 'oauth-server', serverConfig: serverConfig('oauth-server') }];
    const deps = {
      getCachedServerTools: jest.fn().mockResolvedValue(null),
      getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
      cacheServerTools: jest.fn(),
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn(),
      recoveryTracker,
    };

    const first = await loadMCPServerCatalogs({ user, servers }, deps);
    const second = await loadMCPServerCatalogs({ user, servers }, deps);

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(first.reauthRequiredServers).toEqual(new Set());
    expect(second.reauthRequiredServers).toEqual(new Set());
  });

  it.each([
    [
      'OBO',
      {
        ...serverConfig('request-auth'),
        obo: { scopes: 'api://mcp/.default' },
      } as ParsedServerConfig,
    ],
    [
      'direct OpenID bearer',
      {
        ...serverConfig('request-auth'),
        source: 'yaml',
        headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
      } as ParsedServerConfig,
    ],
  ])('keeps %s discovery request-bound', async (_kind, requestAuthConfig) => {
    const firstController = new AbortController();
    const secondController = new AbortController();
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: null });
    const servers = [{ serverName: 'request-auth', serverConfig: requestAuthConfig }];
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn(),
      recoveryTracker,
    };

    await Promise.all([
      recoverMCPServerCatalogs({ user, servers, signal: firstController.signal }, deps),
      recoverMCPServerCatalogs({ user, servers, signal: secondController.signal }, deps),
    ]);

    expect(discoverServerTools).toHaveBeenCalledTimes(2);
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ signal: firstController.signal }),
    );
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ signal: secondController.signal }),
    );
  });

  it('backs off failed discovery progressively and resets after explicit reconnect', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const discoverServerTools = jest.fn().mockRejectedValue(new Error('offline'));
    const servers = [{ serverName: 'offline', serverConfig: serverConfig('offline') }];
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn(),
      recoveryTracker,
    };

    await recoverMCPServerCatalogs({ user, servers }, deps);
    await recoverMCPServerCatalogs({ user, servers }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(1);

    now += 5 * 60_000;
    await recoverMCPServerCatalogs({ user, servers }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);

    now += 5 * 60_000;
    await recoverMCPServerCatalogs({ user, servers }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);

    recoveryTracker.clear(user.id, 'offline');
    await recoverMCPServerCatalogs({ user, servers }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(3);
  });
});

describe('loadMCPServerCatalogs', () => {
  it('loads cache hits and connected snapshots in parallel, then caches only the snapshot', async () => {
    const cachedTools = availableTools('cached');
    const snapshotTools = availableTools('live');
    const servers = [
      { serverName: 'cached-server', serverConfig: serverConfig('cached') },
      { serverName: 'live-server', serverConfig: serverConfig('live') },
    ];
    const getCachedServerTools = jest.fn(
      async (
        _userId: string,
        serverName: string,
        _serverConfig: ParsedServerConfig,
      ): Promise<LCAvailableTools | null> => (serverName === 'cached-server' ? cachedTools : null),
    );
    const getServerToolFunctionsSnapshot = jest.fn().mockResolvedValue({
      tools: snapshotTools,
      publicationGeneration: 'generation-1',
    });
    const cacheServerTools = jest.fn().mockResolvedValue(undefined);
    const loadUserMCPAuthMap = jest.fn();

    const result = await loadMCPServerCatalogs(
      { user, servers },
      {
        getCachedServerTools,
        getServerToolFunctionsSnapshot,
        cacheServerTools,
        loadUserMCPAuthMap,
        discoverServerTools: jest.fn(),
        formatServerTools: jest.fn(),
      },
    );

    expect(getCachedServerTools).toHaveBeenCalledTimes(2);
    expect(getServerToolFunctionsSnapshot).toHaveBeenCalledTimes(1);
    expect(loadUserMCPAuthMap).not.toHaveBeenCalled();
    expect(cacheServerTools).toHaveBeenCalledWith({
      userId: user.id,
      serverName: 'live-server',
      serverTools: snapshotTools,
      serverConfig: servers[1].serverConfig,
      publicationGeneration: 'generation-1',
      publicationRevision: undefined,
    });
    expect(result.serverTools).toEqual(
      new Map([
        ['cached-server', cachedTools],
        ['live-server', snapshotTools],
      ]),
    );
    expect(result.serversWithoutTools).toEqual([]);
  });

  it('serves passive recovery only to the request and does not cache it without a fence', async () => {
    const servers = [{ serverName: 'cold-server', serverConfig: serverConfig('cold') }];
    const recoveredTools = availableTools('recovered');
    const cacheServerTools = jest.fn();

    const result = await loadMCPServerCatalogs(
      { user, servers },
      {
        getCachedServerTools: jest.fn().mockResolvedValue(null),
        getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
        cacheServerTools,
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn().mockResolvedValue({
          tools: [{ name: 'recovered', inputSchema: { type: 'object' as const } }],
        }),
        formatServerTools: jest.fn().mockReturnValue(recoveredTools),
      },
    );

    expect(result.serverTools).toEqual(new Map([['cold-server', recoveredTools]]));
    expect(result.serversWithoutTools).toEqual([]);
    expect(cacheServerTools).not.toHaveBeenCalled();
  });

  it('isolates cache and snapshot failures and reports only unresolved servers', async () => {
    const servers = [
      { serverName: 'recovered', serverConfig: serverConfig('recovered') },
      { serverName: 'missing', serverConfig: serverConfig('missing') },
    ];

    const result = await loadMCPServerCatalogs(
      { user, servers },
      {
        getCachedServerTools: jest.fn().mockRejectedValue(new Error('cache unavailable')),
        getServerToolFunctionsSnapshot: jest
          .fn()
          .mockRejectedValueOnce(new Error('connection unavailable'))
          .mockResolvedValueOnce({ tools: null }),
        cacheServerTools: jest.fn(),
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn(async ({ serverName }: ToolDiscoveryOptions) => ({
          tools: serverName === 'recovered' ? [] : null,
        })),
        formatServerTools: jest.fn().mockReturnValue({}),
      },
    );

    expect(result.serverTools).toEqual(new Map([['recovered', {}]]));
    expect(result.serversWithoutTools).toEqual(['missing']);
  });

  it('applies the configured recovery policy through the catalog loader', async () => {
    let now = 1_800_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
    const servers = [{ serverName: 'offline', serverConfig: serverConfig('offline') }];
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: null });
    const deps = {
      getCachedServerTools: jest.fn().mockResolvedValue(null),
      getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
      cacheServerTools: jest.fn(),
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn(),
      recoveryTracker,
    };
    const recoveryPolicy = {
      discoveryBackoffMs: [10],
      reauthRetryMs: 20,
      maxStateEntries: 10,
    };

    await loadMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
    now += 9;
    await loadMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(1);

    now += 1;
    await loadMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
  });
});

describe('loadMCPServerCatalogs — credential refresh during discovery', () => {
  const serverName = 'oauth-server';
  const scope = { userId: user.id, serverName };
  const servers = [{ serverName, serverConfig: serverConfig(serverName) }];
  const listedTools = [{ name: 'listed', inputSchema: { type: 'object' as const } }];
  const recoveredTools = availableTools('listed');

  /**
   * Mirrors the application wiring: one shared tool-cache generation, and an authorization fence
   * that persists retry intent, rotates the generation, and then clears this replica's recovery
   * state in the same tracker with the generation it wrote.
   */
  const createFence = ({ attemptTimeoutMs }: { attemptTimeoutMs?: number } = {}) => {
    let rotations = 1;
    let generation = 'generation-1';
    let readsFail = false;
    let publicationHold: Promise<void> | undefined;
    let retryIntentHold: Promise<void> | undefined;
    let retryCleanup: Promise<void> = Promise.resolve();
    const recoveryTracker = new MCPServerCatalogRecoveryTracker();
    const rotate = () => {
      rotations += 1;
      generation = `generation-${rotations}`;
      return generation;
    };
    const invalidateRecoveryGeneration = async () => {
      const written = rotate();
      await publicationHold;
      return written;
    };
    const onOAuthCredentialsChanging = (changed: MCPRecoveryGenerationScope) =>
      prepareMCPAuthorizationMutation(changed, {
        invalidateRecoveryGeneration,
        persistPublicationRetry: async () => {
          if (retryIntentHold != null) {
            await retryIntentHold;
          }
          return 'retry-v1';
        },
        clearPublicationRetry: () => retryCleanup,
        clearLocalRecovery: (userId, changedServerName, published) =>
          recoveryTracker.clear(userId, changedServerName, published),
        retryDelaysMs: [0],
        attemptTimeoutMs,
      });
    return {
      recoveryTracker,
      onOAuthCredentialsChanging,
      /** Leaves the durable retry-intent delete hanging, as a stalled store would. */
      stallRetryCleanup: () => {
        retryCleanup = new Promise<void>(() => undefined);
      },
      /** Holds the durable retry-intent write that precedes every token-row write. */
      holdRetryIntent: () => {
        let release: () => void = () => undefined;
        retryIntentHold = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => {
          retryIntentHold = undefined;
          release();
        };
      },
      getRecoveryGeneration: async () => {
        if (readsFail) {
          throw new Error('tool cache unavailable');
        }
        return generation;
      },
      failReads: () => {
        readsFail = true;
      },
      restoreReads: () => {
        readsFail = false;
      },
      /** A credential change committed on another replica moves only the shared generation. */
      rotateOnAnotherReplica: async () => rotate(),
      /** A credential change committed by another request on this replica. */
      rotateOnThisReplica: async () => (await onOAuthCredentialsChanging(scope))(),
      /** Keeps a publication open after its generation is visible, as its remaining writes would. */
      holdPublication: () => {
        let release: () => void = () => undefined;
        publicationHold = new Promise<void>((resolve) => {
          release = resolve;
        });
        return () => {
          publicationHold = undefined;
          release();
        };
      },
    };
  };

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const loadCatalogs = (
    fence: ReturnType<typeof createFence>,
    discoverServerTools: MCPServerCatalogLoaderDeps['discoverServerTools'],
    recoveryPolicy?: Partial<MCPServerCatalogRecoveryPolicy>,
  ) =>
    loadMCPServerCatalogs(
      { user, servers, recoveryPolicy },
      {
        getCachedServerTools: jest.fn().mockResolvedValue(null),
        getServerToolFunctionsSnapshot: jest.fn().mockResolvedValue({ tools: null }),
        cacheServerTools: jest.fn(),
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools,
        formatServerTools: jest.fn().mockReturnValue(recoveredTools),
        recoveryTracker: fence.recoveryTracker,
        getRecoveryGeneration: fence.getRecoveryGeneration,
        onOAuthCredentialsChanging: fence.onOAuthCredentialsChanging,
      },
    );

  /** Refreshes an expired access token the way the connection factory does during discovery. */
  const refreshAccessToken = async ({ onOAuthCredentialsChanging }: ToolDiscoveryOptions) => {
    const publish = await onOAuthCredentialsChanging?.(scope);
    await publish?.();
  };

  it('keeps a catalog discovered after its own credential refresh rotated the generation', async () => {
    const fence = createFence();
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      await refreshAccessToken(options);
      return { tools: listedTools };
    });

    const result = await loadCatalogs(fence, discoverServerTools);

    await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-2');
    expect(result.serverTools).toEqual(new Map([[serverName, recoveredTools]]));
    expect(result.serversWithoutTools).toEqual([]);
  });

  it.each([false, true])(
    'tracks peer adoption and still fences a later writer (%s)',
    async (superseded) => {
      const fence = createFence();
      const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
        await fence.rotateOnAnotherReplica();
        await options.onOAuthCredentialsAdopted?.('generation-2');
        if (superseded) await fence.rotateOnAnotherReplica();
        return { tools: listedTools };
      });
      const result = await loadCatalogs(fence, discoverServerTools);
      expect(result.serverTools).toEqual(
        superseded ? new Map() : new Map([[serverName, recoveredTools]]),
      );
      expect(result.serversWithoutTools).toEqual(superseded ? [serverName] : []);
    },
  );

  it.each([
    ['another replica', 'rotateOnAnotherReplica'],
    ['another request on this replica', 'rotateOnThisReplica'],
  ] as const)(
    'still discards that catalog when %s rotates the generation after the refresh',
    async (_writer, rotate) => {
      const fence = createFence();
      const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
        await refreshAccessToken(options);
        await fence[rotate]();
        return { tools: listedTools };
      });

      const result = await loadCatalogs(fence, discoverServerTools);

      await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-3');
      expect(result.serverTools).toEqual(new Map());
      expect(result.serversWithoutTools).toEqual([serverName]);
    },
  );

  it.each([
    ['after its refresh published', false],
    ['while its refresh is still publishing', true],
  ])(
    'shares the discovery with a request that reads the refreshed generation %s',
    async (_when, duringPublication) => {
      const fence = createFence();
      const releaseDiscovery: Array<() => void> = [];
      const releasePublication = duringPublication ? fence.holdPublication() : undefined;
      let accessTokenExpired = true;
      const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
        if (accessTokenExpired) {
          accessTokenExpired = false;
          await refreshAccessToken(options);
        }
        await new Promise<void>((resolve) => releaseDiscovery.push(resolve));
        return { tools: listedTools };
      });

      const first = loadCatalogs(fence, discoverServerTools);
      await flush();
      await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-2');
      const second = loadCatalogs(fence, discoverServerTools);
      await flush();
      releasePublication?.();
      await flush();
      releaseDiscovery.splice(0).forEach((release) => release());

      const results = await Promise.all([first, second]);
      expect(results.map(({ serverTools }) => serverTools)).toEqual([
        new Map([[serverName, recoveredTools]]),
        new Map([[serverName, recoveredTools]]),
      ]);
      expect(discoverServerTools).toHaveBeenCalledTimes(1);
    },
  );

  it('releases a request that joined a publication whose retry-intent cleanup stalls', async () => {
    const fence = createFence({ attemptTimeoutMs: 100 });
    fence.stallRetryCleanup();
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      await refreshAccessToken(options);
      return { tools: listedTools };
    });

    const first = loadCatalogs(fence, discoverServerTools);
    await flush();
    await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-2');
    const second = loadCatalogs(fence, discoverServerTools);

    const results = await Promise.all([first, second]);
    expect(results.map(({ serverTools }) => serverTools)).toEqual([
      new Map([[serverName, recoveredTools]]),
      new Map([[serverName, recoveredTools]]),
    ]);
    expect(discoverServerTools).toHaveBeenCalledTimes(1);
  });

  it('rediscovers once a refresh released with its stalled flight publishes the rotation', async () => {
    const fence = createFence();
    const releaseRetryIntent = fence.holdRetryIntent();
    const recoveryPolicy = { discoveryTimeoutMs: 100, discoverySettleGraceMs: 20 };
    let refresh: Promise<void> | undefined;
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      if (refresh == null) {
        refresh = refreshAccessToken(options);
        await refresh;
      }
      return { tools: listedTools };
    });

    const released = await loadCatalogs(fence, discoverServerTools, recoveryPolicy);
    const suppressed = await loadCatalogs(fence, discoverServerTools, recoveryPolicy);
    expect(released.serversWithoutTools).toEqual([serverName]);
    expect(suppressed.serversWithoutTools).toEqual([serverName]);
    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-1');

    releaseRetryIntent();
    await refresh;
    await flush();
    await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-2');

    const recovered = await loadCatalogs(fence, discoverServerTools, recoveryPolicy);
    expect(recovered.serverTools).toEqual(new Map([[serverName, recoveredTools]]));
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
  });

  it('discards a shared catalog that the shared generation cannot confirm for a request that saw a newer one', async () => {
    const fence = createFence();
    const releasePublication = fence.holdPublication();
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      await refreshAccessToken(options);
      return { tools: listedTools };
    });

    const first = loadCatalogs(fence, discoverServerTools);
    await flush();
    await fence.rotateOnAnotherReplica();
    const second = loadCatalogs(fence, discoverServerTools);
    await flush();
    fence.failReads();
    releasePublication();

    const [refreshed, sawNewer] = await Promise.all([first, second]);
    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(sawNewer.serverTools).toEqual(new Map());
    expect(refreshed.serverTools).toEqual(new Map());
  });

  it('retains a reauthorization decision under the generation its refresh published', async () => {
    const fence = createFence();
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      await refreshAccessToken(options);
      return { tools: null, oauthRequired: true, authenticationKind: 'oauth' as const };
    });

    const first = await loadCatalogs(fence, discoverServerTools);
    const second = await loadCatalogs(fence, discoverServerTools);
    fence.failReads();
    const duringOutage = await loadCatalogs(fence, discoverServerTools);

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(first.reauthRequiredGenerations).toEqual(new Map([[serverName, 'generation-2']]));
    expect(second.reauthRequiredGenerations).toEqual(new Map([[serverName, 'generation-2']]));
    expect(duringOutage.reauthRequiredGenerations).toEqual(new Map([[serverName, 'generation-2']]));
  });

  it.each([
    ['keeps', 'the shared generation confirms it', true],
    ['discards', 'the shared generation cannot confirm it', false],
  ])(
    '%s a catalog its refresh published for a request that observed no generation when %s',
    async (_verb, _condition, confirmable) => {
      const fence = createFence();
      fence.failReads();
      const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
        await refreshAccessToken(options);
        if (confirmable) {
          fence.restoreReads();
        } else {
          await fence.rotateOnAnotherReplica();
        }
        return { tools: listedTools };
      });

      const result = await loadCatalogs(fence, discoverServerTools);

      expect(result.serverTools).toEqual(
        confirmable ? new Map([[serverName, recoveredTools]]) : new Map(),
      );
    },
  );

  it('keeps a catalog discovered under a newer generation when an outlived refresh clears with an older one', async () => {
    const fence = createFence();
    const releaseDiscovery: Array<() => void> = [];
    let completeRefresh: (() => Promise<string | undefined>) | undefined;
    const discoverServerTools = jest
      .fn()
      .mockImplementationOnce(async ({ onOAuthCredentialsChanging }: ToolDiscoveryOptions) => {
        completeRefresh = await onOAuthCredentialsChanging?.(scope);
        return { tools: null };
      })
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => releaseDiscovery.push(resolve));
        return { tools: listedTools };
      });

    await loadCatalogs(fence, discoverServerTools);
    const releasePublication = fence.holdPublication();
    const publication = completeRefresh?.();
    await flush();
    await fence.rotateOnAnotherReplica();
    const takeover = loadCatalogs(fence, discoverServerTools);
    await flush();
    releasePublication();
    await publication;
    releaseDiscovery.splice(0).forEach((release) => release());

    await expect(fence.getRecoveryGeneration()).resolves.toBe('generation-3');
    expect((await takeover).serverTools).toEqual(new Map([[serverName, recoveredTools]]));
  });

  it('discards a catalog a mismatched clear spared when the shared generation cannot confirm it', async () => {
    const fence = createFence();
    const releaseDiscovery: Array<() => void> = [];
    let completeRefresh: (() => Promise<string | undefined>) | undefined;
    const discoverServerTools = jest
      .fn()
      .mockImplementationOnce(async ({ onOAuthCredentialsChanging }: ToolDiscoveryOptions) => {
        completeRefresh = await onOAuthCredentialsChanging?.(scope);
        return { tools: listedTools };
      })
      .mockImplementation(async () => {
        await new Promise<void>((resolve) => releaseDiscovery.push(resolve));
        return { tools: listedTools };
      });

    await loadCatalogs(fence, discoverServerTools);
    const replacement = loadCatalogs(fence, discoverServerTools);
    await flush();
    await completeRefresh?.();
    fence.failReads();
    releaseDiscovery.splice(0).forEach((release) => release());

    expect(discoverServerTools).toHaveBeenCalledTimes(2);
    expect((await replacement).serverTools).toEqual(new Map());
  });

  it('lets a refresh that outlives its discovery clear the backoff instead of adopting it', async () => {
    const fence = createFence();
    let completeRefresh: (() => Promise<string | undefined>) | undefined;
    const discoverServerTools = jest
      .fn()
      .mockImplementationOnce(async ({ onOAuthCredentialsChanging }: ToolDiscoveryOptions) => {
        completeRefresh = await onOAuthCredentialsChanging?.(scope);
        return { tools: null };
      })
      .mockResolvedValue({ tools: listedTools });

    const expired = await loadCatalogs(fence, discoverServerTools);
    await completeRefresh?.();
    const refreshed = await loadCatalogs(fence, discoverServerTools);

    expect(expired.serversWithoutTools).toEqual([serverName]);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
    expect(refreshed.serverTools).toEqual(new Map([[serverName, recoveredTools]]));
  });
});

describe('recoverMCPServerCatalogs — bounded, skippable discovery', () => {
  const recoveryDeps = (
    discoverServerTools: jest.Mock,
    userMCPAuthMap: Record<string, Record<string, string>> = {},
  ) => ({
    loadUserMCPAuthMap: jest.fn().mockResolvedValue(userMCPAuthMap),
    discoverServerTools,
    formatServerTools: jest.fn().mockReturnValue({}),
    getRecoveryGeneration: jest.fn().mockResolvedValue('generation-1'),
  });

  it('bounds each server discovery end to end rather than per attempt', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const before = Date.now();

    await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'slow', serverConfig: serverConfig('slow') }] },
      recoveryDeps(discoverServerTools),
    );

    const [options] = discoverServerTools.mock.calls[0];
    expect(options.serverName).toBe('slow');
    expect(options.connectionTimeout).toBeUndefined();
    expect(options.deadlineMs).toBeGreaterThanOrEqual(before + 3000);
    expect(options.deadlineMs).toBeLessThanOrEqual(Date.now() + 3000);
  });

  it('keeps a shorter configured initTimeout instead of raising it to the cap', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const impatient = { ...serverConfig('impatient'), initTimeout: 900 } as ParsedServerConfig;
    const before = Date.now();

    await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'impatient', serverConfig: impatient }] },
      recoveryDeps(discoverServerTools),
    );

    const [options] = discoverServerTools.mock.calls[0];
    expect(options.deadlineMs).toBeGreaterThanOrEqual(before + 900);
    expect(options.deadlineMs).toBeLessThanOrEqual(Date.now() + 900);
  });

  it('honors a larger configured passive discovery budget', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const before = Date.now();

    await recoverMCPServerCatalogs(
      {
        user,
        servers: [{ serverName: 'remote', serverConfig: serverConfig('remote') }],
        recoveryPolicy: { discoveryTimeoutMs: 12_000 },
      },
      recoveryDeps(discoverServerTools),
    );

    const [options] = discoverServerTools.mock.calls[0];
    expect(options.deadlineMs).toBeGreaterThanOrEqual(before + 12_000);
    expect(options.deadlineMs).toBeLessThanOrEqual(Date.now() + 12_000);
  });

  it('leaves a server the config tier marked unreachable to that tier’s retry window', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const deps = recoveryDeps(discoverServerTools);
    const failed = {
      ...serverConfig('failed'),
      inspectionFailed: true,
      source: 'config',
    } as ParsedServerConfig;

    const result = await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          { serverName: 'failed', serverConfig: failed },
          { serverName: 'healthy', serverConfig: serverConfig('healthy') },
        ],
      },
      deps,
    );

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'healthy' }),
    );
    expect([...result.keys()]).toEqual(['healthy']);
  });

  it('skips a server whose user-provided variables are unset and recovers its siblings', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const needsVars = withUserVars(serverConfig('needs-vars'));

    const result = await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          { serverName: 'needs-vars', serverConfig: needsVars },
          { serverName: 'open', serverConfig: serverConfig('open') },
        ],
      },
      recoveryDeps(discoverServerTools),
    );

    expect(discoverServerTools).toHaveBeenCalledTimes(1);
    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'open' }),
    );
    expect([...result.keys()]).toEqual(['open']);
  });

  it('discovers a server whose user-provided variables are satisfied', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const needsVars = withUserVars(serverConfig('needs-vars'));

    await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'needs-vars', serverConfig: needsVars }] },
      recoveryDeps(discoverServerTools, {
        [`${Constants.mcp_prefix}needs-vars`]: { API_KEY: 'set' },
      }),
    );

    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: 'needs-vars',
        customUserVars: { API_KEY: 'set' },
      }),
    );
  });

  it('skips the auth lookup entirely when every cold server is ineligible', async () => {
    const discoverServerTools = jest.fn();
    const deps = recoveryDeps(discoverServerTools);
    const failed = {
      ...serverConfig('failed'),
      inspectionFailed: true,
      source: 'config',
    } as ParsedServerConfig;

    const result = await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'failed', serverConfig: failed }] },
      deps,
    );

    expect(deps.loadUserMCPAuthMap).not.toHaveBeenCalled();
    expect(discoverServerTools).not.toHaveBeenCalled();
    expect(result.size).toBe(0);
  });

  it('still attempts a yaml stub, which has no retry timer of its own', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const stub = {
      ...serverConfig('yaml-stub'),
      inspectionFailed: true,
      source: 'yaml',
    } as ParsedServerConfig;

    await recoverMCPServerCatalogs(
      { user, servers: [{ serverName: 'yaml-stub', serverConfig: stub }] },
      recoveryDeps(discoverServerTools),
    );

    expect(discoverServerTools).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: 'yaml-stub' }),
    );
  });

  it('reads plugin auth only when a cold server actually declares user variables', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const deps = recoveryDeps(discoverServerTools);

    await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          { serverName: 'open-a', serverConfig: serverConfig('open-a') },
          { serverName: 'open-b', serverConfig: serverConfig('open-b') },
        ],
      },
      deps,
    );

    expect(deps.loadUserMCPAuthMap).not.toHaveBeenCalled();
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
  });

  it('asks plugin auth only for the credential-bearing servers in a mixed list', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const deps = recoveryDeps(discoverServerTools, {
      [`${Constants.mcp_prefix}guarded`]: { API_KEY: 'set' },
    });

    await recoverMCPServerCatalogs(
      {
        user,
        servers: [
          { serverName: 'open', serverConfig: serverConfig('open') },
          { serverName: 'guarded', serverConfig: withUserVars(serverConfig('guarded')) },
        ],
      },
      deps,
    );

    expect(deps.loadUserMCPAuthMap).toHaveBeenCalledWith('user-1', ['guarded']);
    expect(discoverServerTools).toHaveBeenCalledTimes(2);
  });

  it('holds a limiter slot until its discovery settles, so concurrency stays honest', async () => {
    /** A slot released while its network operation is still running would let a fourth
     *  discovery start; awaiting the work rather than racing it keeps the limit real. */
    let active = 0;
    let maxActive = 0;
    const discoverServerTools = jest.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 20));
      active -= 1;
      return { tools: null };
    });
    const servers = Array.from({ length: 9 }, (_, index) => ({
      serverName: `slow-${index}`,
      serverConfig: serverConfig(`slow-${index}`),
    }));

    const result = await recoverMCPServerCatalogs(
      { user, servers },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools,
        formatServerTools: jest.fn().mockReturnValue({}),
      },
    );

    expect(discoverServerTools).toHaveBeenCalledTimes(9);
    expect(maxActive).toBe(3);
    expect(result.size).toBe(0);
  });

  it('attempts every cold server, so none is starved by those ahead of it', async () => {
    const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
    const servers = Array.from({ length: 12 }, (_, index) => ({
      serverName: `server-${index}`,
      serverConfig: serverConfig(`server-${index}`),
    }));

    await recoverMCPServerCatalogs({ user, servers }, recoveryDeps(discoverServerTools));
    await recoverMCPServerCatalogs({ user, servers }, recoveryDeps(discoverServerTools));

    expect(discoverServerTools).toHaveBeenCalledTimes(24);
    for (const { serverName } of servers) {
      expect(discoverServerTools).toHaveBeenCalledWith(expect.objectContaining({ serverName }));
    }
  });

  it('bounds snapshot refreshes, which each issue a real tools/list', async () => {
    let active = 0;
    let maxActive = 0;
    const before = Date.now();
    const servers = Array.from({ length: 9 }, (_, index) => ({
      serverName: `server-${index}`,
      serverConfig: serverConfig(`server-${index}`),
    }));
    const getServerToolFunctionsSnapshot = jest.fn(
      async (
        _userId: string,
        _serverName: string,
        _serverConfig: ParsedServerConfig,
        _options?: { deadlineMs?: number; signal?: AbortSignal },
      ) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 20));
        active -= 1;
        return { tools: null };
      },
    );

    await loadMCPServerCatalogs(
      { user, servers },
      {
        getCachedServerTools: jest.fn().mockResolvedValue(null),
        getServerToolFunctionsSnapshot,
        cacheServerTools: jest.fn(),
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn().mockResolvedValue({ tools: null }),
        formatServerTools: jest.fn().mockReturnValue({}),
      },
    );

    expect(maxActive).toBe(3);
    const options = getServerToolFunctionsSnapshot.mock.calls[0]?.[3];
    expect(options?.deadlineMs).toBeGreaterThanOrEqual(before + 30_000);
    expect(options?.deadlineMs).toBeLessThanOrEqual(Date.now() + 30_000);
  });

  it('cancels queued catalog work when the originating request ends', async () => {
    const controller = new AbortController();
    const releases: Array<() => void> = [];
    const servers = Array.from({ length: 9 }, (_, index) => ({
      serverName: `server-${index}`,
      serverConfig: serverConfig(`server-${index}`),
    }));
    const getServerToolFunctionsSnapshot = jest.fn(
      () =>
        new Promise<{ tools: null }>((resolve) => {
          releases.push(() => resolve({ tools: null }));
        }),
    );

    const loading = loadMCPServerCatalogs(
      { user, servers, signal: controller.signal },
      {
        getCachedServerTools: jest.fn().mockResolvedValue(null),
        getServerToolFunctionsSnapshot,
        cacheServerTools: jest.fn(),
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools: jest.fn().mockResolvedValue({ tools: null }),
        formatServerTools: jest.fn().mockReturnValue({}),
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(getServerToolFunctionsSnapshot).toHaveBeenCalledTimes(3);

    controller.abort();
    releases.splice(0).forEach((release) => release());
    await loading;

    expect(getServerToolFunctionsSnapshot).toHaveBeenCalledTimes(3);
    expect(getServerToolFunctionsSnapshot).toHaveBeenCalledWith(
      user.id,
      'server-0',
      servers[0].serverConfig,
      expect.objectContaining({ signal: controller.signal }),
    );
  });
});

describe('recoverMCPServerCatalogs — discovery that outlives its budget', () => {
  /** Stands in for discovery parked on an await that ignores its deadline, such as an OAuth refresh
   *  whose redeemed tokens are waiting on a stalled authorization-fence write. */
  const stalledDiscovery = () => {
    const pending: Array<{
      resolve: (result: { tools: Tool[] | null }) => void;
      reject: (error: Error) => void;
    }> = [];
    const discoverServerTools = jest.fn(
      (_options: ToolDiscoveryOptions) =>
        new Promise<{ tools: Tool[] | null }>((resolve, reject) => {
          pending.push({ resolve, reject });
        }),
    );
    return { discoverServerTools, pending };
  };
  const recoveryPolicy = { discoveryTimeoutMs: 200, discoverySettleGraceMs: 50 };
  const stalledServers = [{ serverName: 'stalled', serverConfig: serverConfig('stalled') }];

  it('releases a stalled shared flight, the requests that joined it, and their catalog slots', async () => {
    const { discoverServerTools, pending } = stalledDiscovery();
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('late-tool')),
      recoveryTracker,
    };
    const healthyServers = [{ serverName: 'healthy', serverConfig: serverConfig('healthy') }];
    const healthyDeps = {
      ...deps,
      discoverServerTools: jest.fn().mockResolvedValue({ tools: [] }),
      formatServerTools: jest.fn().mockReturnValue(availableTools('healthy-tool')),
    };

    try {
      const joined = Array.from({ length: 3 }, () =>
        recoverMCPServerCatalogs({ user, servers: stalledServers, recoveryPolicy }, deps),
      );
      await new Promise((resolve) => setImmediate(resolve));
      expect(discoverServerTools).toHaveBeenCalledTimes(1);
      await expect(
        recoverMCPServerCatalogs({ user, servers: healthyServers, recoveryPolicy }, healthyDeps),
      ).rejects.toBeInstanceOf(MCPCatalogCapacityError);

      await expect(Promise.all(joined)).resolves.toEqual([new Map(), new Map(), new Map()]);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Discovery for stalled is still running 50ms past its budget'),
      );
      await expect(
        recoverMCPServerCatalogs({ user, servers: healthyServers, recoveryPolicy }, healthyDeps),
      ).resolves.toEqual(new Map([['healthy', availableTools('healthy-tool')]]));

      pending[0].resolve({ tools: [] });
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        recoverMCPServerCatalogs({ user, servers: stalledServers, recoveryPolicy }, deps),
      ).resolves.toEqual(new Map());
      expect(discoverServerTools).toHaveBeenCalledTimes(1);
    } finally {
      pending.forEach(({ resolve }) => resolve({ tools: null }));
    }
  });

  it('keeps observing a released discovery that fails afterwards', async () => {
    const { discoverServerTools, pending } = stalledDiscovery();

    const result = await recoverMCPServerCatalogs(
      { user, servers: stalledServers, recoveryPolicy },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools,
        formatServerTools: jest.fn(),
        recoveryTracker,
      },
    );
    expect(result).toEqual(new Map());

    /** Jest fails the test if this late rejection goes unhandled. */
    pending[0].reject(new Error('authorization fence write failed'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(discoverServerTools).toHaveBeenCalledTimes(1);
  });

  it('starts no second discovery for a server until its released discovery settles', async () => {
    const { discoverServerTools, pending } = stalledDiscovery();
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('late-tool')),
      recoveryTracker,
    };
    const servers = [{ serverName: 'held', serverConfig: serverConfig('held') }];
    const policy = { ...recoveryPolicy, discoveryBackoffMs: [10] };

    try {
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map());
      recoveryTracker.clear(user.id, 'held');
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map());
      expect(discoverServerTools).toHaveBeenCalledTimes(1);

      pending[0].resolve({ tools: null });
      await new Promise((resolve) => setImmediate(resolve));
      discoverServerTools.mockResolvedValueOnce({ tools: [] });
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map([['held', availableTools('late-tool')]]));
      expect(discoverServerTools).toHaveBeenCalledTimes(2);
    } finally {
      pending.forEach(({ resolve }) => resolve({ tools: null }));
    }
  });

  it('holds a request-bound server until its released discovery settles', async () => {
    const { discoverServerTools, pending } = stalledDiscovery();
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('obo-tool')),
      recoveryTracker,
    };
    const servers = [
      {
        serverName: 'obo',
        serverConfig: {
          ...serverConfig('obo'),
          obo: { scopes: 'api://mcp/.default' },
        } as ParsedServerConfig,
      },
    ];

    try {
      await recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps);
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps),
      ).resolves.toEqual(new Map());
      expect(discoverServerTools).toHaveBeenCalledTimes(1);

      pending[0].resolve({ tools: null });
      await new Promise((resolve) => setImmediate(resolve));
      discoverServerTools.mockResolvedValueOnce({ tools: [] });
      await expect(
        recoverMCPServerCatalogs({ user, servers, recoveryPolicy }, deps),
      ).resolves.toEqual(new Map([['obo', availableTools('obo-tool')]]));
      expect(discoverServerTools).toHaveBeenCalledTimes(2);
    } finally {
      pending.forEach(({ resolve }) => resolve({ tools: null }));
    }
  });

  it.each([
    [
      'configuration',
      {
        serverConfig: { ...serverConfig('changed'), url: 'https://changed-v2.example.com/mcp' },
        generation: 'generation-1',
      },
    ],
    [
      'credential generation',
      { serverConfig: serverConfig('changed'), generation: 'generation-2' },
    ],
  ])('lets a changed %s discover beside a released discovery', async (_change, next) => {
    let generation = 'generation-1';
    const { discoverServerTools, pending } = stalledDiscovery();
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('changed-tool')),
      recoveryTracker,
      getRecoveryGeneration: jest.fn(async () => generation),
    };
    const released = [{ serverName: 'changed', serverConfig: serverConfig('changed') }];

    try {
      await expect(
        recoverMCPServerCatalogs({ user, servers: released, recoveryPolicy }, deps),
      ).resolves.toEqual(new Map());
      generation = next.generation;
      discoverServerTools.mockResolvedValueOnce({ tools: [] });
      await expect(
        recoverMCPServerCatalogs(
          {
            user,
            servers: [
              { serverName: 'changed', serverConfig: next.serverConfig as ParsedServerConfig },
            ],
            recoveryPolicy,
          },
          deps,
        ),
      ).resolves.toEqual(new Map([['changed', availableTools('changed-tool')]]));
      expect(discoverServerTools).toHaveBeenCalledTimes(2);
    } finally {
      pending.forEach(({ resolve }) => resolve({ tools: null }));
    }
  });

  it('starts no new discovery while released discoveries fill the process-wide limit', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker(undefined, 1);
    const { discoverServerTools, pending } = stalledDiscovery();
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('fresh-tool')),
      recoveryTracker: tracker,
    };
    const named = (serverName: string, overrides: Partial<ParsedServerConfig> = {}) => [
      {
        serverName,
        serverConfig: { ...serverConfig(serverName), ...overrides } as ParsedServerConfig,
      },
    ];

    try {
      await expect(
        recoverMCPServerCatalogs({ user, servers: named('stuck'), recoveryPolicy }, deps),
      ).resolves.toEqual(new Map());
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('reached the limit of 1'));
      await expect(
        recoverMCPServerCatalogs({ user, servers: named('other'), recoveryPolicy }, deps),
      ).resolves.toEqual(new Map());
      await expect(
        recoverMCPServerCatalogs(
          {
            user,
            servers: named('request-bound', { obo: { scopes: 'api://mcp/.default' } }),
            recoveryPolicy,
          },
          deps,
        ),
      ).resolves.toEqual(new Map());
      expect(discoverServerTools).toHaveBeenCalledTimes(1);

      pending[0].resolve({ tools: null });
      await new Promise((resolve) => setImmediate(resolve));
      discoverServerTools.mockResolvedValueOnce({ tools: [] });
      await expect(
        recoverMCPServerCatalogs({ user, servers: named('other'), recoveryPolicy }, deps),
      ).resolves.toEqual(new Map([['other', availableTools('fresh-tool')]]));
      expect(discoverServerTools).toHaveBeenCalledTimes(2);
    } finally {
      pending.forEach(({ resolve }) => resolve({ tools: null }));
    }
  });

  it('counts token work a discovery hands off at its deadline toward the hold and the limit', async () => {
    const tracker = new MCPServerCatalogRecoveryTracker(undefined, 1);
    let settleTokenWork: () => void = () => undefined;
    const tokenWork = new Promise<void>((resolve) => {
      settleTokenWork = resolve;
    });
    const discoverServerTools = jest.fn(async (options: ToolDiscoveryOptions) => {
      if (options.serverName !== 'refreshing') {
        return { tools: [] };
      }
      options.onDiscoveryDetached?.(tokenWork);
      return { tools: null };
    });
    const deps = {
      loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue(availableTools('fresh-tool')),
      recoveryTracker: tracker,
    };
    const policy = { ...recoveryPolicy, discoveryBackoffMs: [10] };
    const named = (serverName: string) => [{ serverName, serverConfig: serverConfig(serverName) }];

    try {
      await expect(
        recoverMCPServerCatalogs(
          { user, servers: named('refreshing'), recoveryPolicy: policy },
          deps,
        ),
      ).resolves.toEqual(new Map());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await expect(
        recoverMCPServerCatalogs(
          { user, servers: named('refreshing'), recoveryPolicy: policy },
          deps,
        ),
      ).resolves.toEqual(new Map());
      await expect(
        recoverMCPServerCatalogs({ user, servers: named('other'), recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map());
      expect(discoverServerTools).toHaveBeenCalledTimes(1);

      settleTokenWork();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(
        recoverMCPServerCatalogs({ user, servers: named('other'), recoveryPolicy: policy }, deps),
      ).resolves.toEqual(new Map([['other', availableTools('fresh-tool')]]));
      expect(discoverServerTools).toHaveBeenCalledTimes(2);
    } finally {
      settleTokenWork();
    }
  });

  it('lets a discovery that settles just past its budget keep its slot and its catalog', async () => {
    const discoverServerTools = jest.fn(async ({ deadlineMs }: ToolDiscoveryOptions) => {
      const remainingMs = Math.max(0, (deadlineMs ?? Date.now()) - Date.now());
      await new Promise((resolve) => setTimeout(resolve, remainingMs + 30));
      return { tools: [] };
    });

    const result = await recoverMCPServerCatalogs(
      {
        user,
        servers: [{ serverName: 'closing', serverConfig: serverConfig('closing') }],
        recoveryPolicy: { discoveryTimeoutMs: 20 },
      },
      {
        loadUserMCPAuthMap: jest.fn().mockResolvedValue({}),
        discoverServerTools,
        formatServerTools: jest.fn().mockReturnValue(availableTools('closing-tool')),
        recoveryTracker,
      },
    );

    expect(result).toEqual(new Map([['closing', availableTools('closing-tool')]]));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('Discovery for closing'));
  });
});

it('recovers a catalog without loading an unused shadowed user API key', async () => {
  const discoverServerTools = jest.fn().mockResolvedValue({ tools: [] });
  const loadUserMCPAuthMap = jest.fn().mockResolvedValue({});
  await recoverMCPServerCatalogs(
    {
      user,
      servers: [
        {
          serverName: 'shadowed',
          serverConfig: {
            type: 'streamable-http',
            url: 'https://shadowed.example.com/mcp',
            apiKey: { source: 'user', authorization_type: 'basic' },
            headers: { Authorization: 'Basic {{MCP_API_KEY}}' },
            requestHeaders: { authorization: 'Bearer request-secret' },
            customUserVars: { MCP_API_KEY: { title: 'API Key', description: 'Generated key' } },
          },
        },
      ],
    },
    {
      loadUserMCPAuthMap,
      discoverServerTools,
      formatServerTools: jest.fn().mockReturnValue({}),
      getRecoveryGeneration: jest.fn().mockResolvedValue('generation-1'),
      recoveryTracker,
    },
  );
  expect(loadUserMCPAuthMap).not.toHaveBeenCalled();
  expect(discoverServerTools).toHaveBeenCalledTimes(1);
});
