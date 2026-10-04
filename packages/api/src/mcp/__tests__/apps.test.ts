import { logger } from '@librechat/data-schemas';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { PluginAuthMethods } from '@librechat/data-schemas';
import type { MCPAppRequestContext, MCPAppsProxyManager, ToolWithMeta } from '../apps';
import {
  buildAppProxyErrorResponse,
  callAppTool,
  isDeniedAppRequest,
  isToolHiddenFromApp,
  isToolHiddenFromModel,
  listAppResources,
  listAppResourceTemplates,
  readAppResource,
  resolveAppRequestContext,
  resolveEffectiveAppServerConfig,
} from '../apps';
import { MCPAuthenticationRefreshError, MCPAuthenticationRejectedError } from '../errors';
import { createMCPAppBindingCodec, projectMCPAppRuntimeTarget } from '../apps/binding';
import { OpenIDReauthRequiredError } from '~/utils/oidc';
import { getPluginAuthMap } from '~/agents/auth';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

jest.mock('~/agents/auth', () => ({ getPluginAuthMap: jest.fn() }));

const tool = (visibility?: unknown): ToolWithMeta =>
  ({
    name: 'do_thing',
    ...(visibility === undefined ? {} : { _meta: { ui: { visibility } } }),
  }) as ToolWithMeta;

describe('MCP App server bindings', () => {
  const connectionTarget = {
    serverConfig: {
      source: 'yaml' as const,
      type: 'sse' as const,
      url: 'https://mcp.example.com',
    },
    connectionOwner: 'operator' as const,
  };
  const subject = {
    userId: 'user-1',
    tenantId: 'tenant-1',
    serverName: 'srv',
    connectionTarget,
    runtimeTarget: projectMCPAppRuntimeTarget(connectionTarget.serverConfig),
  };

  it('validates only the same opaque user, config, and resolved runtime target', () => {
    const codec = createMCPAppBindingCodec('secret');
    const binding = codec.create(subject);

    expect(binding).toMatch(/^v1\.[A-Za-z0-9_-]+$/);
    expect(codec.verify(binding, subject)).toBe(true);
    expect(codec.verify(binding, { ...subject, userId: 'user-2' })).toBe(false);
    expect(
      codec.verify(binding, {
        ...subject,
        runtimeTarget: { type: 'sse', url: 'https://replacement.example.com' },
      }),
    ).toBe(false);
  });
});

describe('tool visibility', () => {
  describe('isToolHiddenFromApp', () => {
    it('treats an absent visibility field as both scopes (not hidden)', () => {
      expect(isToolHiddenFromApp(tool())).toBe(false);
    });

    it('does not hide tools whose explicit visibility includes app', () => {
      expect(isToolHiddenFromApp(tool(['app']))).toBe(false);
      expect(isToolHiddenFromApp(tool(['model', 'app']))).toBe(false);
      expect(isToolHiddenFromApp(tool(['app', 'internal']))).toBe(false);
    });

    it('hides tools whose explicit visibility omits app, including empty/future arrays', () => {
      expect(isToolHiddenFromApp(tool(['model']))).toBe(true);
      expect(isToolHiddenFromApp(tool([]))).toBe(true);
      expect(isToolHiddenFromApp(tool(['model', 'internal']))).toBe(true);
    });
  });

  describe('isToolHiddenFromModel', () => {
    it('treats an absent visibility field as both scopes (not hidden)', () => {
      expect(isToolHiddenFromModel(tool())).toBe(false);
    });

    it('does not hide tools whose explicit visibility includes model', () => {
      expect(isToolHiddenFromModel(tool(['model']))).toBe(false);
      expect(isToolHiddenFromModel(tool(['model', 'app']))).toBe(false);
      expect(isToolHiddenFromModel(tool(['model', 'internal']))).toBe(false);
    });

    it('hides tools whose explicit visibility omits model, including empty/future arrays', () => {
      expect(isToolHiddenFromModel(tool(['app']))).toBe(true);
      expect(isToolHiddenFromModel(tool([]))).toBe(true);
      expect(isToolHiddenFromModel(tool(['app', 'internal']))).toBe(true);
    });
  });
});

describe('App request config and auth resolution', () => {
  const findPluginAuthsByKeys = jest.fn() as unknown as PluginAuthMethods['findPluginAuthsByKeys'];
  const mockGetPluginAuthMap = getPluginAuthMap as jest.MockedFunction<typeof getPluginAuthMap>;
  const user = { id: 'user-1', role: 'USER' } as Parameters<
    typeof resolveAppRequestContext
  >[0]['user'];
  const flowManager = {} as Parameters<typeof resolveAppRequestContext>[0]['flowManager'];
  const onOAuthCredentialsChanging = jest.fn(async () => async () => undefined);
  const allowlists = {
    allowedDomains: ['a.example.com'],
    allowedAddresses: null,
    useSSRFProtection: false,
  };

  beforeEach(() => jest.clearAllMocks());

  it('resolves the request config and the server customUserVars together', async () => {
    mockGetPluginAuthMap.mockResolvedValue({ mcp_srv: { API_KEY: 'secret' } });

    const ctx = await resolveAppRequestContext({
      user,
      serverName: 'srv',
      serverBinding: 'binding',
      resolveServerConfig: () =>
        Promise.resolve({
          serverConfig: { type: 'sse', url: 'https://a.example.com' },
          connectionOwner: 'principal',
        }),
      findPluginAuthsByKeys,
      flowManager,
      onOAuthCredentialsChanging,
      allowlists,
    });

    expect(ctx.connectionTarget.serverConfig).toEqual({
      type: 'sse',
      url: 'https://a.example.com',
    });
    expect(ctx.customUserVars).toEqual({ API_KEY: 'secret' });
    expect(ctx.user).toBe(user);
    expect(ctx.serverName).toBe('srv');
    expect(ctx.onOAuthCredentialsChanging).toBe(onOAuthCredentialsChanging);
    expect(ctx.allowlists).toBe(allowlists);
  });

  it('fails closed when config resolution fails', async () => {
    await expect(
      resolveAppRequestContext({
        user,
        serverName: 'srv',
        serverBinding: 'binding',
        resolveServerConfig: () => Promise.reject(new Error('config unavailable')),
        findPluginAuthsByKeys,
        flowManager,
        onOAuthCredentialsChanging,
        allowlists,
      }),
    ).rejects.toThrow('config unavailable');
  });

  it('fails closed when auth-value resolution fails rather than proceeding unresolved', async () => {
    mockGetPluginAuthMap.mockRejectedValue(new Error('db down'));

    await expect(
      resolveAppRequestContext({
        user,
        serverName: 'srv',
        serverBinding: 'binding',
        resolveServerConfig: () =>
          Promise.resolve({
            serverConfig: { type: 'sse', url: 'https://a.example.com' },
            connectionOwner: 'principal',
          }),
        findPluginAuthsByKeys,
        flowManager,
        onOAuthCredentialsChanging,
        allowlists,
      }),
    ).rejects.toThrow('db down');
    expect(logger.error).toHaveBeenCalled();
  });

  it('resolves without customUserVars for a user with no stored vars', async () => {
    mockGetPluginAuthMap.mockResolvedValue({});

    const ctx = await resolveAppRequestContext({
      user,
      serverName: 'srv',
      serverBinding: 'binding',
      resolveServerConfig: () =>
        Promise.resolve({
          serverConfig: { type: 'sse', url: 'https://a.example.com' },
          connectionOwner: 'principal',
        }),
      findPluginAuthsByKeys,
      flowManager,
      onOAuthCredentialsChanging,
      allowlists,
    });

    expect(ctx.customUserVars).toBeUndefined();
    expect(ctx.connectionTarget.serverConfig).toEqual({
      type: 'sse',
      url: 'https://a.example.com',
    });
  });

  it('rejects a target omitted by the effective user and role config', async () => {
    mockGetPluginAuthMap.mockResolvedValue({});

    await expect(
      resolveAppRequestContext({
        user,
        serverName: 'srv',
        serverBinding: 'binding',
        resolveServerConfig: () => Promise.resolve(undefined),
        findPluginAuthsByKeys,
        flowManager,
        onOAuthCredentialsChanging,
        allowlists,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.InvalidRequest });
  });

  it('initializes and resolves only the admitted target through the role-aware registry merge', async () => {
    const target = { type: 'sse' as const, url: 'https://raw.example.com' };
    const parsed = { ...target, source: 'yaml' as const };
    const effective = { ...parsed, url: 'https://effective.example.com' };
    const unrelated = new Promise<Record<string, never>>(() => undefined);
    const ensureConfigServers = jest.fn(
      async (config: Record<string, unknown>): Promise<Record<string, typeof parsed>> => {
        if ('unrelated' in config) {
          await unrelated;
        }
        return { srv: parsed };
      },
    );
    const getAllServerConfigs = jest.fn().mockResolvedValue({ srv: effective });
    const recoverServerConfig = jest.fn();

    await expect(
      resolveEffectiveAppServerConfig({
        serverName: 'srv',
        user,
        mcpConfig: {
          srv: target,
          unrelated: { type: 'stdio', command: 'never-initialized', args: [] },
        },
        ensureConfigServers,
        getAllServerConfigs,
        recoverServerConfig,
        isAppServerConfig: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toEqual({ serverConfig: effective, connectionOwner: 'principal' });

    expect(ensureConfigServers).toHaveBeenCalledWith({ srv: target });
    expect(getAllServerConfigs).toHaveBeenCalledWith(user.id, { srv: parsed }, user.role);
    expect(recoverServerConfig).not.toHaveBeenCalled();
  });

  it('lets the role-aware registry supply an unmodified base target when no raw override exists', async () => {
    const effective = {
      source: 'yaml' as const,
      type: 'sse' as const,
      url: 'https://base.example.com',
    };
    const ensureConfigServers = jest.fn().mockResolvedValue({});
    const getAllServerConfigs = jest.fn().mockResolvedValue({ srv: effective });
    const recoverServerConfig = jest.fn();

    await expect(
      resolveEffectiveAppServerConfig({
        serverName: 'srv',
        user,
        mcpConfig: {},
        ensureConfigServers,
        getAllServerConfigs,
        recoverServerConfig,
        isAppServerConfig: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toEqual({ serverConfig: effective, connectionOwner: 'principal' });

    expect(ensureConfigServers).toHaveBeenCalledWith({});
    expect(getAllServerConfigs).toHaveBeenCalledWith(user.id, {}, user.role);
    expect(recoverServerConfig).not.toHaveBeenCalled();
  });

  it('resolves an inspection-failed target through the upstream recovery owner', async () => {
    const stub = {
      source: 'yaml' as const,
      type: 'sse' as const,
      url: 'https://unavailable.example.com',
      inspectionFailed: true,
    };
    const recovered = {
      source: 'yaml' as const,
      type: 'sse' as const,
      url: 'https://recovered.example.com',
    };
    const recoverServerConfig = jest.fn().mockResolvedValue(recovered);

    await expect(
      resolveEffectiveAppServerConfig({
        serverName: 'srv',
        user,
        mcpConfig: {},
        ensureConfigServers: jest.fn().mockResolvedValue({}),
        getAllServerConfigs: jest.fn().mockResolvedValue({ srv: stub }),
        recoverServerConfig,
        isAppServerConfig: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toEqual({ serverConfig: recovered, connectionOwner: 'principal' });

    expect(recoverServerConfig).toHaveBeenCalledWith('srv', stub, user.id);
  });

  it('returns a missing target without invoking recovery', async () => {
    const recoverServerConfig = jest.fn();

    await expect(
      resolveEffectiveAppServerConfig({
        serverName: 'srv',
        user,
        mcpConfig: {},
        ensureConfigServers: jest.fn().mockResolvedValue({}),
        getAllServerConfigs: jest.fn().mockResolvedValue({}),
        recoverServerConfig,
        isAppServerConfig: jest.fn().mockResolvedValue(false),
      }),
    ).resolves.toBeUndefined();

    expect(recoverServerConfig).not.toHaveBeenCalled();
  });
});

describe('app proxy error mapping', () => {
  it('treats an InvalidRequest denial as a client error and surfaces its message', () => {
    const denial = new McpError(ErrorCode.InvalidRequest, 'Resource "x" is not permitted.');
    expect(isDeniedAppRequest(denial)).toBe(true);
    expect(buildAppProxyErrorResponse(denial, 'Failed to read resource')).toEqual({
      status: 400,
      body: { error: denial.message },
    });
  });

  it.each([new McpError(ErrorCode.InternalError, 'boom'), new Error('boom'), null, 'boom'])(
    'hides an unexpected failure behind the fallback message: %s',
    (error) => {
      expect(isDeniedAppRequest(error)).toBe(false);
      expect(buildAppProxyErrorResponse(error, 'Failed to read resource')).toEqual({
        status: 500,
        body: { error: 'Failed to read resource' },
      });
    },
  );

  it('returns the established actionable response for expired OpenID sessions', () => {
    const error = new OpenIDReauthRequiredError('Please sign in again.');

    expect(buildAppProxyErrorResponse(error, 'Failed to read resource')).toEqual({
      status: 401,
      body: { error: 'invalid_token', message: 'Please sign in again.' },
    });
    expect(isDeniedAppRequest(error)).toBe(true);
  });

  it('returns bounded authentication rejection and refresh responses', () => {
    const rejected = new MCPAuthenticationRejectedError('srv', true);
    const refresh = new MCPAuthenticationRefreshError();

    expect(buildAppProxyErrorResponse(rejected, 'Failed to read resource')).toEqual({
      status: 403,
      body: {
        error: 'invalid_token',
        code: 'MCP_AUTHENTICATION_REJECTED',
        message:
          'MCP server "srv" rejected the bearer credential. The connection was refreshed; retry the tool deliberately.',
        retryable: true,
        connectionRefreshed: true,
      },
    });
    expect(buildAppProxyErrorResponse(refresh, 'Failed to read resource')).toEqual({
      status: 503,
      body: {
        code: 'MCP_AUTHENTICATION_REFRESH_FAILED',
        message: 'The OpenID session could not refresh the MCP bearer credential temporarily.',
        retryable: true,
      },
    });
  });
});

describe('app proxy input validation', () => {
  const manager = {
    readResource: jest.fn(),
    listResources: jest.fn(),
    listResourceTemplates: jest.fn(),
    validateAppBinding: jest.fn(),
    appToolCall: jest.fn(),
  } as jest.Mocked<MCPAppsProxyManager>;
  const context = { serverName: 'srv' } as MCPAppRequestContext;

  beforeEach(() => jest.clearAllMocks());

  it('rejects malformed values before calling the manager', async () => {
    await expect(readAppResource(manager, context, 42)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await expect(listAppResources(manager, context, 42)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await expect(listAppResourceTemplates(manager, context, null)).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await expect(callAppTool(manager, context, 42, {})).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });
    await expect(callAppTool(manager, context, 'tool', [])).rejects.toMatchObject({
      code: ErrorCode.InvalidRequest,
    });

    expect(manager.readResource).not.toHaveBeenCalled();
    expect(manager.listResources).not.toHaveBeenCalled();
    expect(manager.listResourceTemplates).not.toHaveBeenCalled();
    expect(manager.appToolCall).not.toHaveBeenCalled();
  });
});
