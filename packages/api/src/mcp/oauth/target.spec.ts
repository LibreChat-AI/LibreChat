import type { AppConfig } from '@librechat/data-schemas';
import type { MCPOAuthFlowServer, MCPOAuthTargetDeps } from './target';
import type * as t from '~/mcp/types';
import { getMCPServerGeneration } from './cleanup';
import { resolveMCPOAuthTarget } from './target';

const URL = 'https://mcp.example.com/mcp';
const principal: t.MCPPrincipal = { userId: 'user-1', role: 'USER', idOnTheSource: null };

function createDeps({
  configs = {},
  appConfig = {},
  registryConfig,
}: {
  configs?: Record<string, t.ParsedServerConfig>;
  appConfig?: Partial<AppConfig>;
  registryConfig?: t.ParsedServerConfig;
} = {}) {
  return {
    getAppConfig: jest.fn(async () => appConfig as AppConfig),
    getServerConfigs: jest.fn(async () => configs),
    registry: { getServerConfig: jest.fn(async () => registryConfig) },
  } satisfies MCPOAuthTargetDeps;
}

function resolve(deps: MCPOAuthTargetDeps, flow: MCPOAuthFlowServer, serverName = 'docs') {
  return resolveMCPOAuthTarget({ serverName, flow, principal }, deps);
}

describe('resolveMCPOAuthTarget', () => {
  it("reads the principal's config strictly, with the identity the caller loaded", async () => {
    const deps = createDeps({ configs: { docs: { type: 'streamable-http', url: URL } } });

    await resolve(deps, { serverName: 'docs', serverUrl: URL });

    expect(deps.getServerConfigs).toHaveBeenCalledWith(principal);
    expect(deps.getAppConfig).toHaveBeenCalledWith({
      userId: 'user-1',
      role: 'USER',
      idOnTheSource: null,
      failClosed: true,
    });
  });

  it('rejects instead of falling back when the principal config cannot be read', async () => {
    const deps = createDeps({ configs: { docs: { type: 'streamable-http', url: URL } } });
    deps.getAppConfig.mockRejectedValue(new Error('principal read failed'));

    await expect(resolve(deps, { serverName: 'docs', serverUrl: URL })).rejects.toThrow(
      'principal read failed',
    );
  });

  it('refuses a flow admitted for another server before reading anything', async () => {
    const deps = createDeps({ configs: { docs: { type: 'streamable-http', url: URL } } });

    await expect(resolve(deps, { serverName: 'github', serverUrl: URL })).resolves.toEqual({
      ok: false,
      error: { code: 'flow_mismatch' },
    });
    expect(deps.getAppConfig).not.toHaveBeenCalled();
  });

  it('answers server_not_found when no principal-scoped read has the server', async () => {
    const deps = createDeps();

    await expect(resolve(deps, { serverName: 'docs', serverUrl: URL })).resolves.toEqual({
      ok: false,
      error: { code: 'server_not_found' },
    });
    expect(deps.registry.getServerConfig).toHaveBeenCalledWith(
      'docs',
      'user-1',
      undefined,
      'USER',
      { idOnTheSource: null },
    );
  });

  it('finds a config-tier server the resolved catalog omits in the merged config', async () => {
    const merged = { type: 'streamable-http', url: URL } as const;
    const deps = createDeps({ appConfig: { mcpConfig: { docs: merged } } });

    const result = await resolve(deps, {
      serverName: 'docs',
      serverGeneration: getMCPServerGeneration(merged),
    });

    expect(result).toEqual({ ok: true, value: expect.objectContaining({ config: merged }) });
    expect(deps.registry.getServerConfig).not.toHaveBeenCalled();
  });

  it('answers server_changed for a redefined server, by generation or, for older flows, by URL', async () => {
    const admitted: t.ParsedServerConfig = {
      type: 'streamable-http',
      url: URL,
      oauth_headers: { 'X-Key': 'a' },
    };
    const current: t.ParsedServerConfig = { type: 'streamable-http', url: URL };
    const deps = createDeps({ configs: { docs: current } });

    await expect(
      resolve(deps, { serverName: 'docs', serverGeneration: getMCPServerGeneration(admitted) }),
    ).resolves.toEqual({ ok: false, error: { code: 'server_changed' } });
    await expect(
      resolve(deps, { serverName: 'docs', serverUrl: 'https://old.example.com/mcp' }),
    ).resolves.toEqual({ ok: false, error: { code: 'server_changed' } });
  });

  describe('the headers the flow sends', () => {
    const config: t.ParsedServerConfig = {
      type: 'streamable-http',
      url: URL,
      oauth_headers: { 'X-Team': 'principal' },
    };

    it('are the snapshot initiation took, an empty one included', async () => {
      const deps = createDeps({ configs: { docs: config } });

      const snapshot = await resolve(deps, {
        serverUrl: URL,
        oauthHeaders: { 'X-Team': 'resolved' },
      });
      const empty = await resolve(deps, { serverUrl: URL, oauthHeaders: {} });

      expect(snapshot.ok && snapshot.value.oauthHeaders).toEqual({ 'X-Team': 'resolved' });
      expect(empty.ok && empty.value.oauthHeaders).toEqual({});
    });

    it("are the principal's config for a flow that took no snapshot", async () => {
      const deps = createDeps({
        configs: { docs: config },
        appConfig: {
          mcpSettings: { catalogRecovery: { authorizationFenceTimeoutMs: 250 } },
        } as Partial<AppConfig>,
      });

      const result = await resolve(deps, { serverUrl: URL });

      expect(result).toEqual({
        ok: true,
        value: {
          config,
          oauthHeaders: { 'X-Team': 'principal' },
          recoveryPolicy: { authorizationFenceTimeoutMs: 250 },
        },
      });
    });
  });
});
