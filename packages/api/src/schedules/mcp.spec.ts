import { AgentCapabilities, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { IUser, IRole, AppConfig, AgentGraphNode } from '@librechat/data-schemas';
import type { UpstreamTokenProvider } from '../mcp/oauth/obo';
import type { ParsedServerConfig } from '../mcp/types';
import {
  bindUpstreamTokenProviderResolver,
  createScheduleMCPPreflight,
  ScheduleMCPError,
} from './mcp';
import { OboTokenResolutionError, createLazyOboUpstreamTokenProvider } from '../mcp/oauth/obo';

const principal = { id: 'owner', role: 'USER' };
const server: ParsedServerConfig = { type: 'streamable-http', url: 'https://mcp.example.test/mcp' };

it('retries through both run-bound and consumer lookup caches after failure', async () => {
  const tokenProvider = jest.fn().mockResolvedValue({ access_token: 'fresh' });
  const lookup = jest
    .fn()
    .mockRejectedValueOnce(new Error('temporary unavailable'))
    .mockResolvedValue(tokenProvider);
  const bound = bindUpstreamTokenProviderResolver(principal as IUser, lookup)!;
  const first = createLazyOboUpstreamTokenProvider(bound);
  const second = createLazyOboUpstreamTokenProvider(bound);
  const results = await Promise.allSettled([first(), second()]);
  expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected']);
  expect(lookup).toHaveBeenCalledTimes(1);
  await expect(Promise.all([first(), second()])).resolves.toEqual([
    { access_token: 'fresh' },
    { access_token: 'fresh' },
  ]);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('shares credential lookup across sibling consumers without adopting child cancellation', async () => {
  const owner = new AbortController();
  const child = new AbortController();
  child.abort();
  const provider = jest.fn();
  const lookup = jest.fn().mockResolvedValue(provider);
  const resolve = bindUpstreamTokenProviderResolver(principal as IUser, lookup, owner.signal)!;
  expect(lookup).not.toHaveBeenCalled();
  await expect(Promise.all([resolve({ signal: child.signal }), resolve()])).resolves.toEqual([
    provider,
    provider,
  ]);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledWith(principal, { signal: owner.signal });
  owner.abort();
  expect(() => resolve()).toThrow();
});

function graphNode(id: string, fields: Partial<AgentGraphNode> = {}): AgentGraphNode {
  return { id, provider: 'openAI', model: 'gpt-test', ...fields };
}

function setup(tools = ['search_mcp_docs']) {
  const disconnect = jest.fn();
  const deps: Parameters<typeof createScheduleMCPPreflight>[0] = {
    resolveAgentGraphAccess: jest.fn(async () => ({}) as never),
    getAgentGraphNodes: jest.fn(async (ids) =>
      ids.map((id) => ({ id, provider: 'openAI', model: 'gpt-test', tools })),
    ),
    getModelsConfig: jest.fn(async () => ({ openAI: ['gpt-test'] })),
    getRoleByName: jest.fn(
      async () =>
        ({ permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } } }) as IRole,
    ),
    getUser: jest.fn(
      async () => ({ id: 'owner', role: 'USER', email: 'owner@example.test' }) as IUser,
    ),
    getAppConfig: jest.fn(
      async () =>
        ({
          endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        }) as AppConfig,
    ),
    ensureConfigServers: jest.fn(async () => ({})),
    getServerConfigs: jest.fn(async () => ({ docs: server })),
    findPluginAuthsByKeys: jest.fn(async () => []),
    connect: jest.fn(async (options) => {
      options.requestScopedConnections?.connections.set(options.serverName, { disconnect });
      return {
        fetchToolsSnapshot: async () => ({
          tools: [{ name: 'search', inputSchema: { type: 'object' as const } }],
          complete: true,
        }),
      };
    }),
  };
  const preflight = createScheduleMCPPreflight(deps);
  return {
    deps,
    disconnect,
    check: (
      agentId: string,
      user: typeof principal & { tenantId?: string },
      options?: {
        concurrency?: number;
        signal?: AbortSignal;
        deadlineMs?: number;
        scheduleId?: string;
      },
    ) => preflight(agentId, user, { concurrency: 3, ...options }),
  };
}

it('leaves agents without MCP tools independent of MCP config and credentials', async () => {
  const { check, deps } = setup(['web_search']);
  await expect(check('agent', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('uses persisted identity with isolated connections and disposes them after discovery', async () => {
  const { check, deps, disconnect } = setup();
  await expect(check('agent', principal)).resolves.toEqual([{ server: 'docs', status: 'ready' }]);
  expect(deps.connect).toHaveBeenCalledWith(
    expect.objectContaining({
      user: { id: 'owner', role: 'USER', email: 'owner@example.test' },
      ephemeralConnection: true,
      returnOnOAuth: true,
      requestBody: expect.objectContaining({
        parentMessageId: '00000000-0000-0000-0000-000000000000',
      }),
    }),
  );
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it('lazily resolves an upstream token provider for an OBO preflight', async () => {
  const { check, deps } = setup();
  deps.getServerConfigs = jest.fn(async () => ({
    docs: { ...server, obo: { scopes: 'api://mcp/.default' } },
  }));
  const upstreamTokenProvider: UpstreamTokenProvider = jest.fn(async () => ({
    access_token: 'current-token',
  }));
  deps.resolveUpstreamTokenProvider = jest.fn(async () => upstreamTokenProvider);
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    await options.upstreamTokenProviderResolver?.({ signal: options.signal });
    return connect(options);
  });

  await check('agent', principal);

  expect(deps.resolveUpstreamTokenProvider).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'owner' }),
    { signal: undefined },
  );
  expect(deps.connect).toHaveBeenCalledWith(
    expect.objectContaining({ upstreamTokenProviderResolver: expect.any(Function) }),
  );
});

it('reports missing unattended OBO credentials without offering a browser reconnect', async () => {
  const { check, deps } = setup();
  deps.getServerConfigs = jest.fn(async () => ({
    docs: { ...server, obo: { scopes: 'api://mcp/.default' } },
  }));
  deps.resolveUpstreamTokenProvider = jest.fn(async () => undefined);
  deps.connect = jest.fn(async (options) => {
    const provider = createLazyOboUpstreamTokenProvider(
      options.upstreamTokenProviderResolver!,
      options.signal,
      { mcpServer: options.serverName, scopes: options.serverConfig!.obo!.scopes },
    );
    await provider();
    throw new Error('A missing provider must never connect');
  });

  await expect(check('agent', principal, { scheduleId: 'schedule' })).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
    outcomes: [
      { server: 'docs', status: 'mcp_configuration_missing', detail: 'unattended_auth_required' },
    ],
  });
  expect(deps.resolveUpstreamTokenProvider).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'owner' }),
    {
      signal: undefined,
      context: {
        scheduleId: 'schedule',
        ownerId: 'owner',
        agentId: 'agent',
        invocationMode: 'delegated',
      },
      target: { mcpServer: 'docs', scopes: 'api://mcp/.default' },
    },
  );
});

it('does not resolve upstream credentials for non-OBO servers', async () => {
  const { check, deps } = setup();
  deps.resolveUpstreamTokenProvider = jest.fn(async () => {
    throw new Error('credential service unavailable');
  });

  await expect(check('agent', principal)).resolves.toEqual([{ server: 'docs', status: 'ready' }]);
  expect(deps.resolveUpstreamTokenProvider).not.toHaveBeenCalled();
});

it('passes admission identity to the host and rejects a changed tenant before connection', async () => {
  const { check, deps } = setup();
  const user = { ...principal, tenantId: 'tenant' };
  deps.getUser = jest.fn(async () => user as IUser);
  deps.resolveUpstreamTokenProvider = jest.fn(async () =>
    jest.fn(async () => ({ access_token: 'token' })),
  );
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    await options.upstreamTokenProviderResolver?.();
    return connect(options);
  });
  await check('agent', user, { scheduleId: 'schedule' });
  expect(deps.resolveUpstreamTokenProvider).toHaveBeenCalledWith(user, {
    signal: undefined,
    context: {
      scheduleId: 'schedule',
      ownerId: 'owner',
      tenantId: 'tenant',
      agentId: 'agent',
      invocationMode: 'delegated',
    },
  });
  jest.mocked(deps.connect).mockClear();
  await expect(
    check('agent', { ...user, tenantId: 'different' }, { scheduleId: 'schedule' }),
  ).rejects.toBeInstanceOf(ScheduleMCPError);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('does not expose an OBO provider to a sibling direct-bearer server', async () => {
  const { check, deps } = setup(['search_mcp_obo', 'search_mcp_direct']);
  deps.getServerConfigs = jest.fn(async () => ({
    obo: { ...server, obo: { scopes: 'api://mcp/.default' } },
    direct: { ...server, headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' } },
  }));
  const upstreamTokenProvider: UpstreamTokenProvider = jest.fn(async () => ({
    access_token: 'current-token',
  }));
  deps.resolveUpstreamTokenProvider = jest.fn(async () => upstreamTokenProvider);
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    if (options.serverConfig?.obo) {
      await options.upstreamTokenProviderResolver?.({ signal: options.signal });
    }
    return connect(options);
  });

  await check('agent', principal);

  expect(deps.resolveUpstreamTokenProvider).toHaveBeenCalledTimes(1);
  const directOptions = (deps.connect as jest.Mock).mock.calls.find(
    ([options]) => options.serverName === 'direct',
  )?.[0];
  expect(directOptions.upstreamTokenProvider).toBeUndefined();
});

it('rejects partial readiness and reports each server without exception details', async () => {
  const { check, deps, disconnect } = setup(['search_mcp_docs', 'read_mcp_private']);
  deps.getServerConfigs = async () => ({ docs: server, private: server });
  const connect = deps.connect;
  deps.connect = async (options) => {
    if (options.serverName === 'private') {
      await options.oauthStart?.('https://example.test/secret-oauth-code');
      throw new Error('secret credential');
    }
    return connect(options);
  };
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_reauth_required',
    outcomes: [
      { server: 'docs', status: 'ready' },
      { server: 'private', status: 'mcp_reauth_required' },
    ],
  });
  expect(disconnect).toHaveBeenCalledTimes(1);
});

it('rejects missing durable user variables before connecting', async () => {
  const { check, deps } = setup();
  deps.getServerConfigs = async () => ({
    docs: { ...server, customUserVars: { API_KEY: { title: 'API key', description: 'Key' } } },
  });
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
  });
  expect(deps.connect).not.toHaveBeenCalled();
});

it('does not classify a credential-store outage as missing configuration', async () => {
  const { check, deps } = setup();
  deps.findPluginAuthsByKeys = async () => {
    throw new Error('database unavailable');
  };
  await expect(check('agent', principal)).rejects.not.toBeInstanceOf(ScheduleMCPError);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('classifies a transport outage as retryable', async () => {
  const { check, deps } = setup();
  deps.connect = async () => {
    throw new Error('connection refused with secret details');
  };
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_unavailable',
    message: 'mcp_unavailable: [{"server":"docs","status":"mcp_unavailable"}]',
  });
});

it('classifies absent OBO provider wiring as a permanent unattended-auth setup failure', async () => {
  const { check, deps } = setup();
  deps.connect = async () => {
    throw new OboTokenResolutionError('missing_upstream_provider', 'Internal provider detail');
  };

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
    message:
      'mcp_configuration_missing: [{"server":"docs","status":"mcp_configuration_missing","detail":"unattended_auth_required"}]',
  });
});

it('classifies a permanent OBO credential failure as requiring reauthentication', async () => {
  const { check, deps } = setup();
  deps.connect = async () => {
    throw new OboTokenResolutionError('session_refresh_failed', 'Sign-in expired.');
  };

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_reauth_required',
  });
});

it('classifies a retryable OBO credential failure as unavailable', async () => {
  const { check, deps } = setup();
  deps.connect = async () => {
    throw new OboTokenResolutionError('session_refresh_failed', 'Refresh unavailable.', true);
  };

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_unavailable',
  });
});

it('checks graph agents once even when edges cycle', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, { tools: [], edges: [{ from: 'root', to: 'child' }] })
        : graphNode(id, { tools: ['search_mcp_docs'], agent_ids: ['root'] }),
    ),
  );
  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'child' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledTimes(2);
});

it('loads each graph frontier in one batch', async () => {
  const childIds = Array.from({ length: 20 }, (_, index) => `child-${index}`);
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      graphNode(id, {
        tools: id === childIds[0] ? ['search_mcp_docs'] : [],
        edges:
          id === 'root' ? childIds.map((childId) => ({ from: 'root', to: childId })) : undefined,
      }),
    ),
  );
  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'child-0' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenNthCalledWith(1, ['root']);
  expect(deps.getAgentGraphNodes).toHaveBeenNthCalledWith(2, childIds, expect.any(Object));
  expect(deps.resolveAgentGraphAccess).toHaveBeenCalledWith(
    expect.objectContaining({ userId: 'owner', role: 'USER' }),
  );
  expect(deps.getAgentGraphNodes).toHaveBeenCalledTimes(2);
});

it('does not count the root or legacy handoff nodes against the spawn graph budget', async () => {
  const spawnIds = Array.from({ length: 49 }, (_, index) => `spawn-${index}`);
  const legacyIds = Array.from({ length: 55 }, (_, index) => `handoff-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            tools: [],
            agent_ids: legacyIds,
            subagents: { enabled: true, agent_ids: spawnIds } as never,
          })
        : graphNode(id, {
            tools: id === spawnIds[0] ? ['search_mcp_docs'] : [],
          }),
    ),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'spawn-0' },
  ]);
});

it('rejects direct trees beyond the runtime expanded-config limit', async () => {
  const spawnIds = Array.from({ length: 50 }, (_, index) => `spawn-${index}`);
  const { check, deps } = setup([]);
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            subagents: { enabled: true, agent_ids: spawnIds } as never,
          })
        : graphNode(id, { subagents: { enabled: true } as never }),
    ),
  );

  await expect(check('root', principal)).rejects.toThrow('maximum of 100 expanded entries');
});

it('counts accepted graph descriptors against the runtime run-config limit', async () => {
  const { check, deps } = setup([]);
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            subagents: {
              enabled: true,
              graphs: Array.from({ length: 100 }, (_, index) => ({
                name: `graph-${index}`,
                agent_ids: ['member'],
              })),
            } as never,
          })
        : graphNode(id),
    ),
  );

  await expect(check('root', principal)).rejects.toThrow('maximum of 100 expanded entries');
});

it('tracks accepted lazy graphs per descriptor path', async () => {
  const { check, deps } = setup([]);
  const graphs = Array.from({ length: 50 }, (_, index) => ({
    name: `graph-${index}`,
    agent_ids: ['member'],
  }));
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          subagents: { enabled: true, agent_ids: ['a', 'b'] } as never,
        });
      }
      if (id === 'a' || id === 'b') {
        return graphNode(id, {
          subagents: { enabled: true, agent_ids: ['shared'] } as never,
        });
      }
      if (id === 'shared') {
        return graphNode(id, { subagents: { enabled: true, graphs } as never });
      }
      return graphNode(id);
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
});

it('keeps lazy descriptor ancestors when validating cyclic run-config limits', async () => {
  const { check, deps } = setup([]);
  const graphs = Array.from({ length: 49 }, (_, index) => ({
    name: `graph-${index}`,
    agent_ids: ['member'],
  }));
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          subagents: { enabled: true, agent_ids: ['child'], graphs } as never,
        });
      }
      if (id === 'child') {
        return graphNode(id, {
          subagents: { enabled: true, agent_ids: ['root'], graphs } as never,
        });
      }
      return graphNode(id);
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
});

it('skips only a subagent graph definition that exceeds the runtime member budget', async () => {
  const acceptedIds = Array.from({ length: 50 }, (_, index) => `accepted-${index}`);
  const { check, deps } = setup([]);
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          subagents: {
            enabled: true,
            graphs: [{ agent_ids: acceptedIds }, { agent_ids: ['overflow'] }],
          } as never,
        });
      }
      return graphNode(id, { tools: id === acceptedIds[0] ? ['search_mcp_docs'] : [] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'accepted-0' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledTimes(2);
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(
    expect.arrayContaining(['overflow']),
    expect.anything(),
  );
});

it('charges direct subagents before admitting graph definitions', async () => {
  const graphIds = Array.from({ length: 50 }, (_, index) => `graph-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            tools: [],
            subagents: {
              enabled: true,
              agent_ids: ['direct'],
              graphs: [{ agent_ids: graphIds }, { agent_ids: ['accepted'] }],
            } as never,
          })
        : graphNode(id, { tools: ['search_mcp_docs'] }),
    ),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'direct' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledWith(['direct'], expect.any(Object));
  expect(deps.getAgentGraphNodes).toHaveBeenCalledWith(['accepted'], expect.any(Object));
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(
    expect.arrayContaining([graphIds[0]]),
    expect.anything(),
  );
});

it('counts the complete nested direct tree before root graph admission', async () => {
  const graphIds = Array.from({ length: 49 }, (_, index) => `graph-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          subagents: {
            enabled: true,
            agent_ids: ['direct-a'],
            graphs: [{ agent_ids: graphIds }],
          } as never,
        });
      }
      if (id === 'direct-a') {
        return graphNode(id, {
          subagents: { enabled: true, agent_ids: ['direct-b'] } as never,
        });
      }
      return graphNode(id, { tools: id === 'direct-b' ? ['search_mcp_docs'] : [] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'direct-b' },
  ]);
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(
    expect.arrayContaining([graphIds[0]]),
    expect.anything(),
  );
});

it('does not charge inaccessible direct targets to the graph budget', async () => {
  const graphIds = Array.from({ length: 50 }, (_, index) => `graph-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.flatMap((id) => {
      if (id === 'root') {
        return [
          graphNode(id, {
            tools: [],
            subagents: {
              enabled: true,
              agent_ids: ['private'],
              graphs: [{ agent_ids: graphIds }],
            } as never,
          }),
        ];
      }
      if (id === 'private') return [];
      return [graphNode(id, { tools: id === graphIds[0] ? ['search_mcp_docs'] : [] })];
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'graph-0' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledWith(graphIds, expect.any(Object));
});

it('charges viewable invalid-model direct targets to the runtime graph budget', async () => {
  const graphIds = Array.from({ length: 50 }, (_, index) => `graph-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          tools: [],
          subagents: {
            enabled: true,
            agent_ids: ['retired'],
            graphs: [{ agent_ids: graphIds }],
          } as never,
        });
      }
      if (id === 'retired') {
        return graphNode(id, {
          provider: 'anthropic',
          model: 'retired-model',
          tools: ['search_mcp_docs'],
        });
      }
      return graphNode(id, { tools: id === graphIds[0] ? ['search_mcp_docs'] : [] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(graphIds, expect.anything());
  expect(deps.connect).not.toHaveBeenCalled();
});

it('does not retry a model-invalid handoff as a direct subagent descriptor', async () => {
  const graphIds = Array.from({ length: 50 }, (_, index) => `graph-${index}`);
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          tools: [],
          edges: [{ from: 'root', to: 'retired' }],
          subagents: {
            enabled: true,
            agent_ids: ['retired'],
            graphs: [{ agent_ids: graphIds }],
          } as never,
        });
      }
      if (id === 'retired') {
        return graphNode(id, { provider: 'anthropic', model: 'retired-model' });
      }
      return graphNode(id, { tools: id === graphIds[0] ? ['search_mcp_docs'] : [] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'graph-0' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledWith(graphIds, expect.any(Object));
});

it('rejects direct subagent trees beyond the runtime depth limit', async () => {
  const { check, deps } = setup([]);
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      const depth = id === 'root' ? 0 : Number(id.slice('depth-'.length));
      return graphNode(id, {
        subagents: {
          enabled: true,
          agent_ids: [depth === 5 ? 'depth-6' : `depth-${depth + 1}`],
        } as never,
      });
    }),
  );

  await expect(check('root', principal)).rejects.toThrow('maximum depth of 5');
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(['depth-6'], expect.anything());
});

it('does not expand persisted handoffs from graph-only members', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, {
          tools: [],
          subagents: { enabled: true, graphs: [{ agent_ids: ['member'] }] } as never,
        });
      }
      if (id === 'member') {
        return graphNode(id, {
          tools: ['search_mcp_docs'],
          edges: [{ from: 'member', to: 'downstream' }],
        });
      }
      return graphNode(id, { tools: ['read_mcp_private'] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'member' },
  ]);
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(
    expect.arrayContaining(['downstream']),
    expect.anything(),
  );
});

it('skips MCP tools on graph agents the owner cannot view', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids, access) =>
    ids.flatMap((id) => {
      if (id === 'root') {
        return [graphNode(id, { tools: [], edges: [{ from: 'root', to: 'private' }] })];
      }
      return access == null ? [graphNode(id, { tools: ['search_mcp_docs'] })] : [];
    }),
  );
  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('reuses one resolved access context across deep graph frontiers', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, { tools: [], edges: [{ from: 'root', to: 'middle' }] });
      }
      if (id === 'middle') {
        return graphNode(id, { tools: [], edges: [{ from: 'middle', to: 'leaf' }] });
      }
      return graphNode(id, { tools: ['search_mcp_docs'] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'leaf' },
  ]);
  expect(deps.getAgentGraphNodes).toHaveBeenCalledTimes(3);
  expect(deps.resolveAgentGraphAccess).toHaveBeenCalledTimes(1);
});

it('ignores accessible descendants whose provider model is unavailable at runtime', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, { tools: [], edges: [{ from: 'root', to: 'retired' }] })
        : graphNode(id, {
            provider: 'anthropic',
            model: 'retired-model',
            tools: ['search_mcp_docs'],
          }),
    ),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('prunes viewable descendants stranded behind an inaccessible edge node', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids, access) =>
    ids.flatMap((id) => {
      if (id === 'root') {
        return [
          graphNode(id, {
            tools: [],
            edges: [
              { from: 'root', to: 'private' },
              { from: 'private', to: 'visible' },
            ],
          }),
        ];
      }
      if (id === 'visible' && access != null) {
        return [graphNode(id, { tools: ['search_mcp_docs'] })];
      }
      return [];
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('prunes later legacy chain members when an earlier member is unavailable', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.flatMap((id) => {
      if (id === 'root') {
        return [graphNode(id, { tools: [], agent_ids: ['missing', 'visible'] })];
      }
      if (id === 'visible') {
        return [graphNode(id, { tools: ['search_mcp_docs'] })];
      }
      return [];
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('does not expand persisted handoffs from legacy-chain-only agents', async () => {
  const { check, deps } = setup();
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) => {
      if (id === 'root') {
        return graphNode(id, { tools: [], agent_ids: ['legacy'] });
      }
      if (id === 'legacy') {
        return graphNode(id, {
          tools: ['search_mcp_docs'],
          edges: [{ from: 'legacy', to: 'downstream' }],
        });
      }
      return graphNode(id, { tools: ['read_mcp_private'] });
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'legacy' },
  ]);
  expect(deps.getAgentGraphNodes).not.toHaveBeenCalledWith(
    expect.arrayContaining(['downstream']),
    expect.anything(),
  );
});

it('includes enabled spawn-graph members when the capability is available', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            tools: [],
            subagents: {
              enabled: true,
              graphs: [{ name: 'research', type: 'single_agent', agent_ids: ['spawned'] }],
            } as never,
          })
        : graphNode(id, { tools: ['search_mcp_docs'] }),
    ),
  );
  await expect(check('root', principal)).resolves.toEqual([
    { server: 'docs', status: 'ready', agentId: 'spawned' },
  ]);
});

it('skips every member of an incomplete spawn graph', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids, access) =>
    ids.flatMap((id) => {
      if (id === 'root') {
        return [
          graphNode(id, {
            tools: [],
            subagents: {
              enabled: true,
              graphs: [
                {
                  name: 'team',
                  type: 'team',
                  agent_ids: ['visible', 'private'],
                },
              ],
            } as never,
          }),
        ];
      }
      if (id === 'visible' && access != null) {
        return [graphNode(id, { tools: ['search_mcp_docs'] })];
      }
      return [];
    }),
  );

  await expect(check('root', principal)).resolves.toEqual([]);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('ignores a server pin when the agent selected no tools from that server', async () => {
  const { check, deps } = setup(['sys__server__sys_mcp_docs']);
  await expect(check('agent', principal)).resolves.toEqual([]);
  expect(deps.getServerConfigs).not.toHaveBeenCalled();
  expect(deps.connect).not.toHaveBeenCalled();
});

it('propagates principal-config outages instead of reporting missing configuration', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(async (options) => {
    expect(options).toMatchObject({ failClosed: true });
    throw new Error('principal config unavailable');
  });
  await expect(check('agent', principal)).rejects.not.toBeInstanceOf(ScheduleMCPError);
});

it('reuses the loaded external identity for principal configuration', async () => {
  const { check, deps } = setup();
  deps.getUser = jest.fn(
    async () =>
      ({
        id: 'owner',
        role: 'USER',
        email: 'owner@example.test',
        idOnTheSource: 'external-owner',
      }) as IUser,
  );

  await check('agent', principal);

  expect(deps.getAppConfig).toHaveBeenCalledWith(
    expect.objectContaining({
      userId: 'owner',
      role: 'USER',
      idOnTheSource: 'external-owner',
      failClosed: true,
    }),
  );
});

it('uses the freshly loaded role for MCP server ACL resolution', async () => {
  const { check, deps } = setup();
  deps.getUser = jest.fn(
    async () => ({ id: 'owner', role: 'ADMIN', email: 'owner@example.test' }) as IUser,
  );

  await check('agent', principal);

  expect(deps.getServerConfigs).toHaveBeenCalledWith('owner', {}, 'ADMIN');
});

it('initializes only config servers selected by the runnable graph', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: {
          docs: { type: 'streamable-http', url: 'https://docs.example.test/mcp' },
          unrelated: { type: 'streamable-http', url: 'https://other.example.test/mcp' },
        },
      }) as unknown as AppConfig,
  );

  await check('agent', principal);

  expect(deps.ensureConfigServers).toHaveBeenCalledWith(
    {
      docs: { type: 'streamable-http', url: 'https://docs.example.test/mcp' },
    },
    expect.any(Function),
  );
});

it('lets authoritative config names claim normalized aliases before stored hints', async () => {
  const { check, deps } = setup(['search_mcp_Sales_Force']);
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      graphNode(id, { tools: ['search_mcp_Sales_Force'], mcpServerNames: ['Sales_Force'] }),
    ),
  );
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: {
          'Sales Force': { type: 'streamable-http', url: 'https://sales.example.test/mcp' },
        },
      }) as unknown as AppConfig,
  );
  deps.getServerConfigs = async () => ({ 'Sales Force': server });

  await expect(check('agent', principal)).resolves.toEqual([
    { server: 'Sales Force', status: 'ready' },
  ]);
  expect(deps.ensureConfigServers).toHaveBeenCalledWith(
    {
      'Sales Force': { type: 'streamable-http', url: 'https://sales.example.test/mcp' },
    },
    expect.any(Function),
  );
});

it('prefers an exact accessible registry name over a colliding config alias', async () => {
  const { check, deps } = setup(['search_mcp_sales-force']);
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      graphNode(id, { tools: ['search_mcp_sales-force'], mcpServerNames: ['sales-force'] }),
    ),
  );
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: {
          'sales-force!': { type: 'streamable-http', url: 'https://alias.example.test/mcp' },
        },
      }) as unknown as AppConfig,
  );
  deps.getServerConfigs = jest.fn(async () => ({ 'sales-force': server }));

  await expect(check('agent', principal)).resolves.toEqual([
    { server: 'sales-force', status: 'ready' },
  ]);
  expect(deps.ensureConfigServers).toHaveBeenCalledWith({}, expect.any(Function));
});

it('retains a normalized alias for an inaccessible raw server hint', async () => {
  const { check, deps } = setup(['search_mcp_Sales_Force']);
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      graphNode(id, { tools: ['search_mcp_Sales_Force'], mcpServerNames: ['Sales Force'] }),
    ),
  );
  deps.getServerConfigs = jest.fn(async () => ({}));

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
    outcomes: [{ server: 'Sales Force', status: 'mcp_configuration_missing' }],
  });
  expect(deps.connect).not.toHaveBeenCalled();
});

it('rejects a selected server shadowed by an unselected config server', async () => {
  const { check, deps } = setup(['search_mcp_Sales Force']);
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: {
          'Sales Force': { type: 'streamable-http', url: 'https://first.example.test/mcp' },
          Sales_Force: { type: 'streamable-http', url: 'https://second.example.test/mcp' },
        },
      }) as unknown as AppConfig,
  );
  deps.getServerConfigs = async () => ({ 'Sales Force': server });

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
  });
  expect(deps.ensureConfigServers).toHaveBeenCalledWith(
    {
      'Sales Force': { type: 'streamable-http', url: 'https://first.example.test/mcp' },
    },
    expect.any(Function),
  );
  expect(deps.connect).not.toHaveBeenCalled();
});

it('rejects an explicitly selected tool removed from an otherwise healthy server', async () => {
  const { check } = setup(['deleted_mcp_docs']);
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
  });
});

it('attributes a missing shared-server tool to the agent that selected it', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            tools: ['search_mcp_docs'],
            subagents: { enabled: true, agent_ids: ['child'] } as never,
          })
        : graphNode(id, { tools: ['deleted_mcp_docs'] }),
    ),
  );

  await expect(check('root', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
    outcomes: [{ server: 'docs', status: 'mcp_configuration_missing', agentId: 'child' }],
  });
});

it('preserves every owner with a missing tool on a shared server', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: {
          agents: { capabilities: [AgentCapabilities.tools, AgentCapabilities.subagents] },
        },
      }) as unknown as AppConfig,
  );
  deps.getAgentGraphNodes = jest.fn(async (ids) =>
    ids.map((id) =>
      id === 'root'
        ? graphNode(id, {
            tools: ['search_mcp_docs'],
            subagents: { enabled: true, agent_ids: ['researcher', 'writer'] } as never,
          })
        : graphNode(id, {
            tools: [id === 'researcher' ? 'deleted_search_mcp_docs' : 'deleted_write_mcp_docs'],
          }),
    ),
  );

  await expect(check('root', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
    outcomes: [
      { server: 'docs', status: 'mcp_configuration_missing', agentId: 'researcher' },
      { server: 'docs', status: 'mcp_configuration_missing', agentId: 'writer' },
    ],
  });
});

it('distinguishes an incomplete catalog from missing tools', async () => {
  const { check, deps } = setup(['deleted_mcp_docs']);
  deps.connect = async () => ({ fetchToolsSnapshot: async () => ({ tools: [], complete: false }) });
  await expect(check('agent', principal)).rejects.toMatchObject({ code: 'mcp_unavailable' });
});

it('treats a complete empty catalog as missing selected configuration', async () => {
  const { check, deps } = setup(['deleted_mcp_docs']);
  deps.connect = async () => ({ fetchToolsSnapshot: async () => ({ tools: [], complete: true }) });
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
  });
});

it('preserves authentication failures reported by tools/list snapshots', async () => {
  const { check, deps } = setup();
  deps.connect = async () => ({
    fetchToolsSnapshot: async () => ({
      tools: [],
      complete: false,
      authenticationError: { status: 401 },
    }),
  });
  await expect(check('agent', principal)).rejects.toMatchObject({ code: 'mcp_reauth_required' });
});

it('does not connect when the owner loses MCP permission', async () => {
  const { check, deps } = setup();
  deps.getRoleByName = async () => null;
  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_permission_denied',
  });
  expect(deps.connect).not.toHaveBeenCalled();
});

it('rejects selected MCP tools when the effective tools capability is disabled', async () => {
  const { check, deps } = setup();
  deps.getAppConfig = jest.fn(
    async () => ({ endpoints: { agents: { capabilities: [] } } }) as unknown as AppConfig,
  );

  await expect(check('agent', principal)).rejects.toMatchObject({
    code: 'mcp_configuration_missing',
  });
  expect(deps.connect).not.toHaveBeenCalled();
});

it('keeps a role-store outage retryable instead of disabling the schedule', async () => {
  const { check, deps } = setup();
  deps.getRoleByName = async () => {
    throw new Error('role store unavailable');
  };
  await expect(check('agent', principal)).rejects.not.toBeInstanceOf(ScheduleMCPError);
  expect(deps.connect).not.toHaveBeenCalled();
});

it('starts independent server probes together instead of serializing their timeouts', async () => {
  const { check, deps } = setup(['search_mcp_docs', 'search_mcp_private']);
  deps.getServerConfigs = async () => ({ docs: server, private: server });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    await gate;
    return connect(options);
  });
  const result = check('agent', principal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(deps.connect).toHaveBeenCalledTimes(2);
  } finally {
    release();
  }
  await expect(result).resolves.toEqual([
    { server: 'docs', status: 'ready' },
    { server: 'private', status: 'ready' },
  ]);
});

it('bounds simultaneous MCP connection probes', async () => {
  const serverNames = ['one', 'two', 'three', 'four', 'five'];
  const { check, deps } = setup(serverNames.map((name) => `search_mcp_${name}`));
  deps.getServerConfigs = async () => Object.fromEntries(serverNames.map((name) => [name, server]));
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    await gate;
    return connect(options);
  });

  const result = check('agent', principal);
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(deps.connect).toHaveBeenCalledTimes(3);
  } finally {
    release();
  }
  await expect(result).resolves.toHaveLength(5);
  expect(deps.connect).toHaveBeenCalledTimes(5);
});

it('disposes each transport before releasing its shared probe slot', async () => {
  const serverNames = Array.from({ length: 12 }, (_, index) => `server-${index}`);
  const { check, deps } = setup(serverNames.map((name) => `search_mcp_${name}`));
  deps.getServerConfigs = async () => Object.fromEntries(serverNames.map((name) => [name, server]));
  let live = 0;
  let maxLive = 0;
  const disconnect = jest.fn(async () => {
    live -= 1;
  });
  deps.connect = jest.fn(async (options) => {
    live += 1;
    maxLive = Math.max(maxLive, live);
    options.requestScopedConnections?.connections.set(options.serverName, { disconnect });
    return {
      fetchToolsSnapshot: async () => ({
        tools: [{ name: 'search', inputSchema: { type: 'object' as const } }],
        complete: true,
      }),
    };
  });

  await expect(check('agent', principal, { concurrency: 10 })).resolves.toHaveLength(12);
  expect(maxLive).toBeLessThanOrEqual(10);
  expect(live).toBe(0);
  expect(disconnect).toHaveBeenCalledTimes(12);
});

it('bounds config-source initialization before connection probing', async () => {
  const serverNames = Array.from({ length: 12 }, (_, index) => `server-${index}`);
  const { check, deps } = setup(serverNames.map((name) => `search_mcp_${name}`));
  const serverConfigs = Object.fromEntries(serverNames.map((name) => [name, server]));
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: serverConfigs,
      }) as unknown as AppConfig,
  );
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markTenStarted: () => void = () => undefined;
  const tenStarted = new Promise<void>((resolve) => {
    markTenStarted = resolve;
  });
  let active = 0;
  let maxActive = 0;
  deps.ensureConfigServers = jest.fn(async (config, limit = (task) => task()) => {
    const initialized: Record<string, ParsedServerConfig> = {};
    await Promise.all(
      Object.entries(config).map(([name, value]) =>
        limit(async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          if (active === 10) markTenStarted();
          await gate;
          active -= 1;
          initialized[name] = value as ParsedServerConfig;
        }),
      ),
    );
    return initialized;
  });
  deps.getServerConfigs = async (_userId, config) => config;

  const result = check('agent', principal, { concurrency: 10 });
  await tenStarted;
  expect(active).toBe(10);
  release();
  await expect(result).resolves.toHaveLength(12);
  expect(maxActive).toBe(10);
});

it('does not start queued config initialization after cancellation', async () => {
  const serverNames = ['first', 'queued-1', 'queued-2'];
  const { check, deps } = setup(serverNames.map((name) => `search_mcp_${name}`));
  const serverConfigs = Object.fromEntries(serverNames.map((name) => [name, server]));
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: serverConfigs,
      }) as unknown as AppConfig,
  );
  let releaseFirst: () => void = () => undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let markFirstStarted: () => void = () => undefined;
  const firstStarted = new Promise<void>((resolve) => {
    markFirstStarted = resolve;
  });
  let markFinished: () => void = () => undefined;
  const finished = new Promise<void>((resolve) => {
    markFinished = resolve;
  });
  const started: string[] = [];
  deps.ensureConfigServers = jest.fn(async (config, limit = (task) => task()) => {
    await Promise.allSettled(
      Object.entries(config).map(([name]) =>
        limit(async () => {
          started.push(name);
          if (name === 'first') {
            markFirstStarted();
            await firstGate;
          }
        }),
      ),
    );
    markFinished();
    return config as Record<string, ParsedServerConfig>;
  });
  const controller = new AbortController();
  const result = check('agent', principal, { concurrency: 1, signal: controller.signal });

  await firstStarted;
  controller.abort(new Error('canceled'));
  await expect(result).rejects.toThrow('canceled');
  releaseFirst();
  await finished;
  expect(started).toEqual(['first']);
});

it('bounds MCP connection probes across concurrent schedule preflights', async () => {
  const serverNames = Array.from({ length: 12 }, (_, index) => `server-${index}`);
  const { check, deps } = setup(serverNames.map((name) => `search_mcp_${name}`));
  const serverConfigs = Object.fromEntries(serverNames.map((name) => [name, server]));
  deps.getAppConfig = jest.fn(
    async () =>
      ({
        endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
        mcpConfig: serverConfigs,
      }) as unknown as AppConfig,
  );
  deps.getServerConfigs = async () => serverConfigs;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let markTenStarted: () => void = () => undefined;
  const tenStarted = new Promise<void>((resolve) => {
    markTenStarted = resolve;
  });
  const connect = deps.connect;
  let active = 0;
  let maxActive = 0;
  deps.connect = jest.fn(async (options) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 10) markTenStarted();
    await gate;
    active -= 1;
    return connect(options);
  });

  const first = check('agent', principal, { concurrency: 10 });
  const second = check('agent', principal, { concurrency: 10 });
  await tenStarted;
  expect(deps.connect).toHaveBeenCalledTimes(10);
  release();
  await expect(Promise.all([first, second])).resolves.toEqual([
    expect.arrayContaining([{ server: serverNames[0], status: 'ready' }]),
    expect.arrayContaining([{ server: serverNames[0], status: 'ready' }]),
  ]);
  expect(maxActive).toBe(10);
  expect(deps.connect).toHaveBeenCalledTimes(24);
});

it('honors the configured MCP probe concurrency', async () => {
  const { check, deps } = setup(['search_mcp_docs', 'search_mcp_private']);
  deps.getServerConfigs = async () => ({ docs: server, private: server });
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connect = deps.connect;
  deps.connect = jest.fn(async (options) => {
    await gate;
    return connect(options);
  });

  const result = check('agent', principal, { concurrency: 1 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  try {
    expect(deps.connect).toHaveBeenCalledTimes(1);
  } finally {
    release();
  }
  await expect(result).resolves.toHaveLength(2);
});

it('passes cancellation to connection setup and tool discovery', async () => {
  const { check, deps } = setup();
  const controller = new AbortController();
  const fetchToolsSnapshot = jest.fn(
    async (
      _deadline?: number,
      signal?: AbortSignal,
    ): Promise<import('../mcp/connection').MCPToolsSnapshot> => {
      expect(signal).toBe(controller.signal);
      return {
        tools: [{ name: 'search', inputSchema: { type: 'object' as const } }],
        complete: true,
      };
    },
  );
  deps.connect = jest.fn(async (options) => {
    expect(options.signal).toBe(controller.signal);
    return { fetchToolsSnapshot };
  });

  await expect(check('agent', principal, { signal: controller.signal })).resolves.toEqual([
    { server: 'docs', status: 'ready' },
  ]);
  expect(fetchToolsSnapshot).toHaveBeenCalledWith(undefined, controller.signal);
});

it('passes the aggregate lease deadline to tool discovery', async () => {
  const { check, deps } = setup();
  const deadlineMs = Date.now() + 60_000;
  const fetchToolsSnapshot = jest.fn(async () => ({
    tools: [{ name: 'search', inputSchema: { type: 'object' as const } }],
    complete: true,
  }));
  deps.connect = jest.fn(async (options) => {
    expect(options.signal).toBeDefined();
    return { fetchToolsSnapshot };
  });

  await check('agent', principal, { deadlineMs });

  expect(fetchToolsSnapshot).toHaveBeenCalledWith(deadlineMs, expect.any(AbortSignal));
});

it('enforces the aggregate deadline while loading the agent graph', async () => {
  const { check, deps } = setup([]);
  deps.getAgentGraphNodes = jest.fn(() => new Promise<AgentGraphNode[]>(() => undefined));

  await expect(check('agent', principal, { deadlineMs: Date.now() + 20 })).rejects.toMatchObject({
    name: 'TimeoutError',
  });
});

it('admits a scheduled connection when request headers shadow an unused generated user key', async () => {
  const { check, deps } = setup();
  deps.getServerConfigs = async () => ({
    docs: {
      ...server,
      apiKey: { source: 'user', authorization_type: 'custom', custom_header: 'X-Api-Key' },
      headers: { 'X-Api-Key': '{{MCP_API_KEY}}' },
      requestHeaders: { 'x-api-key': 'request-secret' },
      customUserVars: { MCP_API_KEY: { title: 'API Key', description: 'Generated key' } },
    },
  });
  await check('agent', principal);
  expect(deps.connect).toHaveBeenCalledTimes(1);
});
