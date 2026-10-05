import { Keyv } from 'keyv';
import jwt from 'jsonwebtoken';
import { createHmac } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { AgentCapabilities, Permissions, PermissionTypes } from 'librechat-data-provider';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { UpstreamTokenTarget } from '../mcp/oauth/obo';
import type { MCPOAuthTokens } from '../mcp/oauth/types';
import type { ParsedServerConfig } from '../mcp/types';
import type { ServerRequest } from '../types/http';
import {
  InMemoryTokenStore,
  MockKeyv,
  createOAuthMCPServer,
} from '../mcp/__tests__/helpers/oauthTestServer';
import {
  MCPTokenStorage,
  getMCPOAuthLeaseId,
  getMCPOAuthRefreshFlightLeaseId,
} from '../mcp/oauth/tokens';
import { createScheduledOboGrantService, createLazyScheduledOboGrantService } from './obo';
import { OboTokenResolutionError, resolveOboToken } from '../mcp/oauth/obo';
import { createScheduleMCPPreflight, ScheduleMCPError } from './mcp';
import { createScheduleUpstreamTokenProviderResolver } from './mcp';
import { MCPConnectionFactory } from '../mcp/MCPConnectionFactory';
import { restoreScheduledTokenContext } from './context';
import { resolveScheduledOboServer } from './target';
import { FlowStateManager } from '../flow/manager';
import { MCPConnection } from '../mcp/connection';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  decrypt: jest.fn(async (value: string) => value),
  encryptV2: jest.fn(async (value: string) => `enc:${value}`),
  decryptV2: jest.fn(async (value: string) => value.replace(/^enc:/, '')),
  getTenantId: jest.fn(() => 'tenant'),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const user = {
  id: 'owner',
  tenantId: 'tenant',
  role: 'USER',
  provider: 'openid',
  openidId: 'subject',
  openidIssuer: 'https://login.test/tenant',
} as IUser;
const config: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.test/tools',
  obo: { scopes: 'api://resource/Read' },
  source: 'yaml',
};
const context = {
  scheduleId: 'sched-1',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'root',
  invocationMode: 'delegated' as const,
};
const target = { mcpServer: 'Files', scopes: config.obo!.scopes, url: config.url };

function harness(
  tokenStorage: Parameters<
    typeof createScheduledOboGrantService
  >[0]['tokenStorage'] = MCPTokenStorage,
  installAuthority = true,
) {
  const tokenStore = new InMemoryTokenStore();
  const flow = new FlowStateManager<MCPOAuthTokens | null>(new MockKeyv() as unknown as Keyv, {
    ttl: 30000,
    ci: true,
  });
  const row = {
    id: 'sched-1',
    user: 'owner',
    tenantId: 'tenant',
    agent_id: 'root',
    enabled: false,
    configRevision: 1,
  };
  const requestGrant = jest.fn(
    async (
      _config: unknown,
      grantType: string,
      _params: Record<string, string>,
      _signal?: AbortSignal,
    ): Promise<{
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      scope?: string;
    }> =>
      grantType === 'refresh_token'
        ? { access_token: 'fresh-after-12h', refresh_token: 'rotated-refresh', expires_in: 3600 }
        : { access_token: 'first', refresh_token: 'server-scoped-refresh', expires_in: 3600 },
  );
  let ownerActive = true;
  let allowed = ['Files'];
  let agentAllowed = true;
  let baseAvailable = true;
  let server = config;
  let variables: Record<string, string> = {};
  let providerIssuer = user.openidIssuer;
  let providerEndpoint = 'https://login.test/token';
  const inspect = jest.fn(async (_agent, _user, _id, _server, onSelected) =>
    onSelected(resolveScheduledOboServer(server, user, variables)),
  );
  const pauseSchedule = jest.fn(async () => {
    row.enabled = false;
    row.configRevision += 1;
    return row;
  });
  let invocationAllowed = true;
  const authorizeInvocation = jest.fn(async () => invocationAllowed);
  const deps = {
    previewKey: 'test-only-preview-key',
    ...(installAuthority && { authorizeInvocation }),
    tokens: tokenStore,
    tokenStorage,
    flowManager: flow,
    getUser: async () => user,
    getSchedule: async () => ({ ...row }),
    getAppConfig: async (options) =>
      options?.baseOnly && !baseAvailable
        ? undefined
        : ({
            mcpConfig: { Files: server },
            interfaceConfig: { schedules: { use: true, oboServers: allowed } },
          } as Partial<AppConfig> as AppConfig),
    ensureConfigServers: async () => ({ Files: server }),
    getServerConfigs: async () => ({ Files: server }),
    agentAccess: async () => (agentAllowed ? 'ok' : 'forbidden'),
    findPluginAuthsByKeys: async () =>
      Object.entries(variables).map(
        ([authField, value]) =>
          ({ userId: user.id, pluginKey: 'mcp_Files', authField, value }) as never,
      ),
    getRoleByName: async () =>
      ({
        permissions: {
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
          [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true },
          [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
        },
      }) as never,
    getOpenIdConfig: () => ({
      clientMetadata: () => ({ client_id: 'client' }),
      serverMetadata: () => ({
        issuer: providerIssuer,
        authorization_endpoint: 'https://login.test/authorize',
        token_endpoint: providerEndpoint,
      }),
    }),
    requestGrant,
    inspect,
    isOwnerActive: async () => ownerActive,
    isOboConfigTrusted: async () => true,
    isLiveAccessTokenValid: (session) => {
      const decoded = session.accessToken ? jwt.decode(session.accessToken) : null;
      const expiry =
        decoded && typeof decoded === 'object' && typeof decoded.exp === 'number'
          ? decoded.exp
          : session.accessTokenExpiresAt;
      return typeof expiry === 'number' && expiry > Math.floor(Date.now() / 1000) + 30;
    },
    pauseSchedule,
  } satisfies Parameters<typeof createScheduledOboGrantService>[0];
  const service = createScheduledOboGrantService(deps);
  return {
    service,
    deps,
    authorizeInvocation,
    setInvocationAllowed: (allowed: boolean) => {
      invocationAllowed = allowed;
    },
    tokenStore,
    flow,
    row,
    pauseSchedule,
    requestGrant,
    inspect,
    setOwnerActive: (active: boolean) => {
      ownerActive = active;
    },
    setAllowed: (names: string[]) => {
      allowed = names;
    },
    setAgentAllowed: (allowed: boolean) => {
      agentAllowed = allowed;
    },
    setBaseAvailable: (available: boolean) => {
      baseAvailable = available;
    },
    setProvider: (issuer: string, tokenEndpoint: string) => {
      providerIssuer = issuer;
      providerEndpoint = tokenEndpoint;
    },
    setVariables: (values: Record<string, string>) => {
      variables = values;
    },
    setServer: (replacement: ParsedServerConfig) => {
      server = replacement;
    },
  };
}

function binding(url = config.url!, scopes = target.scopes, revision = 1): string {
  return createHmac('sha256', 'test-only-preview-key')
    .update(
      JSON.stringify([
        'scheduled-obo-preview-v1',
        user.id,
        user.tenantId,
        context.scheduleId,
        context.agentId,
        revision,
        'Files',
        url,
        scopes,
      ]),
    )
    .digest('hex');
}

describe('separately authorized scheduled OBO grants', () => {
  it('keeps decrypted URL variables out of the preview while binding enrollment to their value', async () => {
    const { service, row, setServer, setVariables } = harness();
    setServer({
      ...config,
      url: 'https://mcp.test/{{KEY}}?key={{KEY}}',
      customUserVars: { KEY: { title: 'Key', description: 'Credential', sensitive: true } },
    });
    setVariables({ KEY: 'private-provider-key' });
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await service.describeFromRequest(
      { user, params: { id: row.id, server: 'Files' } } as unknown as ServerRequest,
      response as unknown as Response,
    );
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ server: 'Files' }));
    expect(JSON.stringify(response.json.mock.calls)).not.toContain('private-provider-key');
    const preview = response.json.mock.calls[0][0];
    expect(preview.binding).toMatch(/^[a-f0-9]{64}$/);
    await service.enroll(user.id, row.id, 'Files', 'assertion', target.scopes, preview.binding);
    setVariables({ KEY: 'changed-provider-key' });
    await expect(
      service.enroll(user.id, row.id, 'Files', 'assertion', target.scopes, preview.binding),
    ).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('preserves ordinary OAuth credentials for a previously valid scheduled-looking server name', async () => {
    const { tokenStore, flow } = harness();
    const ordinary = {
      userId: user.id,
      serverName: 'schedule-obo:existing:Files',
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
      flowManager: flow,
    };
    await MCPTokenStorage.storeTokens({
      ...ordinary,
      tokens: {
        access_token: 'ordinary-access',
        refresh_token: 'ordinary-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      clientInfo: { client_id: 'ordinary-client' },
      metadata: {
        server_url: 'https://ordinary.test/mcp',
        token_endpoint: 'https://ordinary.test/token',
        client_source: 'configured',
      },
    });
    await expect(MCPTokenStorage.getTokens(ordinary)).resolves.toMatchObject({
      access_token: 'ordinary-access',
    });
    await expect(
      MCPTokenStorage.hasStoredAuthorization({ ...ordinary, validateClientBinding: jest.fn() }),
    ).resolves.toBe(true);
  });

  it('does not let a server allowlist activate enrollment or a provider without invocation authority', async () => {
    const { service, row, requestGrant, tokenStore, inspect } = harness(MCPTokenStorage, false);
    expect(service.isAvailable()).toBe(false);
    await expect(service.resolve(user, { context, target })).resolves.toBeUndefined();
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
      retryable: false,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('checks host authorization for the exact enrolled resource before contacting the provider', async () => {
    const { service, row, requestGrant, tokenStore, authorizeInvocation, setInvocationAllowed } =
      harness();
    setInvocationAllowed(false);
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
    expect(authorizeInvocation).toHaveBeenCalledWith(user, context, target);
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('refuses grant persistence when authority is withdrawn during the enrollment exchange', async () => {
    const { service, row, requestGrant, tokenStore, setInvocationAllowed } = harness();
    requestGrant.mockImplementationOnce(async () => {
      setInvocationAllowed(false);
      return { access_token: 'first', refresh_token: 'scoped-refresh', expires_in: 3600 };
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it.each(['revoke', 'purge'] as const)(
    'fences verified manual bearer delivery after %s completes during final authorization',
    async (operation) => {
      const { service, row, tokenStore, authorizeInvocation } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      const provider = (await service.resolve(user, {
        context: { ...context, manual: true },
        target,
      }))!;
      authorizeInvocation
        .mockReset()
        .mockResolvedValueOnce(true)
        .mockImplementationOnce(async () => {
          if (operation === 'revoke') await service.revoke(user.id, row.id, 'Files');
          else await service.purge(user.id, row.id);
          expect(tokenStore.getAll()).toEqual([]);
          return true;
        });
      await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
      expect(tokenStore.getAll()).toEqual([]);
    },
  );

  it('keeps final-delivery fence outages retryable without delivering a manual bearer', async () => {
    const { service, row, flow, tokenStore, authorizeInvocation } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const provider = (await service.resolve(user, {
      context: { ...context, manual: true },
      target,
    }))!;
    authorizeInvocation
      .mockReset()
      .mockResolvedValueOnce(true)
      .mockImplementationOnce(async () => {
        jest.spyOn(flow, 'acquireLease').mockResolvedValueOnce(null);
        return true;
      });
    await expect(provider()).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
    });
    expect(tokenStore.getAll().length).toBeGreaterThan(0);
    await service.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('refuses even a cached bearer after authority is withdrawn, while preserving revoke and cleanup', async () => {
    const { service, row, tokenStore, requestGrant, setInvocationAllowed } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
    setInvocationAllowed(false);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(requestGrant).toHaveBeenCalledTimes(1);
    await expect(service.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
    await service.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('refuses a renewed bearer if authority is withdrawn during refresh', async () => {
    const { service, row, requestGrant, setInvocationAllowed } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    requestGrant.mockImplementationOnce(async () => {
      setInvocationAllowed(false);
      return { access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 };
    });
    await expect(provider({ forceDownstreamRefresh: true })).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
  });

  it('keeps an older grant listable and revocable when the host has no authority adapter', async () => {
    const { service, deps, row, tokenStore, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const locked = createScheduledOboGrantService({ ...deps, authorizeInvocation: undefined });
    expect(locked.isAvailable()).toBe(false);
    await expect(locked.resolve(user, { context, target })).resolves.toBeUndefined();
    await expect(locked.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
    await locked.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
    expect(requestGrant).toHaveBeenCalledTimes(1);
  });

  it('isolates scheduled grants while an ordinary OAuth server has the same logical name', async () => {
    const { service, row, tokenStore, flow, deps } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const locked = createScheduledOboGrantService({ ...deps, authorizeInvocation: undefined });
    const ordinary = {
      userId: user.id,
      serverName: 'schedule-obo:sched-1:Files',
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
      flowManager: flow,
    };
    await expect(MCPTokenStorage.getTokens(ordinary)).rejects.toMatchObject({ reason: 'missing' });
    await expect(MCPTokenStorage.getClientInfoAndMetadata(ordinary)).resolves.toBeNull();
    const validateClientBinding = jest.fn();
    await expect(
      MCPTokenStorage.hasStoredAuthorization({ ...ordinary, validateClientBinding }),
    ).resolves.toBe(false);
    expect(validateClientBinding).not.toHaveBeenCalled();
    await MCPTokenStorage.storeTokens({
      ...ordinary,
      tokens: {
        access_token: 'ordinary',
        refresh_token: 'ordinary-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      clientInfo: { client_id: 'ordinary-client' },
      metadata: {
        server_url: 'https://ordinary.test/mcp',
        token_endpoint: 'https://ordinary.test/token',
        client_source: 'configured',
      },
    });
    const refreshTokens = jest.fn(async () => ({
      obtained_at: Date.now(),
      access_token: 'ordinary-renewed',
      refresh_token: 'ordinary-rotated',
      expires_at: Date.now() + 3600_000,
      token_type: 'Bearer',
    }));
    await expect(
      MCPTokenStorage.forceRefreshTokens({ ...ordinary, refreshTokens, coordinateRefresh: true }),
    ).resolves.toMatchObject({ access_token: 'ordinary-renewed' });
    expect(refreshTokens).toHaveBeenCalledWith(
      'ordinary-refresh',
      expect.objectContaining({ clientInfo: { client_id: 'ordinary-client' } }),
      expect.any(AbortSignal),
    );
    await expect(MCPTokenStorage.getClientInfoAndMetadata(ordinary)).resolves.toMatchObject({
      clientInfo: { client_id: 'ordinary-client' },
      clientMetadata: {
        server_url: 'https://ordinary.test/mcp',
        token_endpoint: 'https://ordinary.test/token',
        client_source: 'configured',
      },
    });
    await expect(
      MCPTokenStorage.hasStoredAuthorization({ ...ordinary, validateClientBinding }),
    ).resolves.toBe(true);
    await MCPTokenStorage.deleteUserTokens({ ...ordinary, deleteToken: tokenStore.deleteToken });
    expect(tokenStore.getAll()).toHaveLength(3);
    await expect(locked.resolve(user, { context, target })).resolves.toBeUndefined();
    await expect(locked.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
    await locked.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
  });

  it.each(['revoke', 'purge'] as const)(
    'retains legacy cleanup after client metadata expires: %s',
    async (operation) => {
      const { service, row, tokenStore, requestGrant, deps } = harness();
      requestGrant.mockResolvedValueOnce({
        access_token: 'first',
        refresh_token: 'two-year-grant',
        expires_in: 3600,
        refresh_token_expires_in: 2 * 365 * 24 * 3600,
      });
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      const refresh = tokenStore.getAll().find((record) => record.type === 'mcp_oauth_refresh')!;
      const client = tokenStore.getAll().find((record) => record.type === 'mcp_oauth_client')!;
      expect(client.expiresAt.getTime()).toBeGreaterThanOrEqual(refresh.expiresAt.getTime() - 1000);
      for (const record of tokenStore.getAll()) {
        await tokenStore.updateToken(
          { userId: user.id, type: record.type, identifier: record.identifier },
          { identifier: record.identifier.replace('scheduled-mcp:', 'mcp:') },
        );
      }
      for (const record of tokenStore.getAll()) {
        const oldMetadata =
          record.metadata instanceof Map
            ? Object.fromEntries(record.metadata)
            : { ...record.metadata };
        delete oldMetadata.credential_purpose;
        await tokenStore.updateToken(
          { userId: user.id, type: record.type, identifier: record.identifier },
          { metadata: oldMetadata },
        );
      }
      const locked = createScheduledOboGrantService({ ...deps, authorizeInvocation: undefined });
      await expect(locked.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
      await tokenStore.deleteTokens({
        userId: user.id,
        type: 'mcp_oauth_client',
        identifier: `mcp:schedule-obo:${row.id}:Files:client`,
      });
      await expect(locked.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
      if (operation === 'revoke') await locked.revoke(user.id, row.id, 'Files');
      else await locked.purge(user.id, row.id);
      expect(tokenStore.getAll()).toEqual([]);
    },
  );

  it.each(['revoke', 'purge'] as const)(
    'keeps legacy grants safely cleanable with %s while preserving an ordinary prefix server',
    async (operation) => {
      const { service, row, tokenStore, deps } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      for (const record of tokenStore.getAll()) {
        await tokenStore.updateToken(
          { userId: user.id, type: record.type, identifier: record.identifier },
          { identifier: record.identifier.replace('scheduled-mcp:', 'mcp:') },
        );
      }
      const ordinary = {
        userId: user.id,
        serverName: 'schedule-obo:sched-1:Other',
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
      };
      await MCPTokenStorage.storeTokens({
        ...ordinary,
        tokens: {
          access_token: 'ordinary',
          refresh_token: 'ordinary-refresh',
          token_type: 'Bearer',
          expires_in: 3600,
        },
        clientInfo: { client_id: 'ordinary-client' },
      });
      const locked = createScheduledOboGrantService({ ...deps, authorizeInvocation: undefined });
      await expect(locked.listEnrolled(user.id)).resolves.toEqual({ 'sched-1': ['Files'] });
      if (operation === 'revoke') await locked.revoke(user.id, row.id, 'Files');
      else await locked.purge(user.id, row.id);
      await expect(MCPTokenStorage.getTokens(ordinary)).resolves.toMatchObject({
        access_token: 'ordinary',
      });
      await expect(locked.listEnrolled(user.id)).resolves.toEqual({});
      expect(tokenStore.getAll()).toHaveLength(3);
    },
  );

  it('keeps purpose-specific persistence, redemption and teardown fences separate', async () => {
    const key = 'schedule-obo:sched-1:Files';
    expect(getMCPOAuthLeaseId(user.id, key, 'tenant', true)).not.toBe(
      getMCPOAuthLeaseId(user.id, key, 'tenant'),
    );
    expect(getMCPOAuthRefreshFlightLeaseId(user.id, key, 'tenant', true)).not.toBe(
      getMCPOAuthRefreshFlightLeaseId(user.id, key, 'tenant'),
    );
    const release = await MCPTokenStorage.beginRefreshTeardown(user.id, key, true);
    try {
      expect(MCPTokenStorage.isRefreshTeardownActive(user.id, key, 'tenant', true)).toBe(true);
      expect(MCPTokenStorage.isRefreshTeardownActive(user.id, key, 'tenant')).toBe(false);
    } finally {
      release();
    }
  });

  it('keeps legacy pre-release OBO metadata unavailable to ordinary colliding servers', async () => {
    const { tokenStore } = harness();
    const params = {
      userId: user.id,
      serverName: 'schedule-obo:sched-1:Files',
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
    };
    await MCPTokenStorage.storeTokens({
      ...params,
      tokens: {
        access_token: 'legacy-internal',
        refresh_token: 'legacy-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      clientInfo: { client_id: 'client' },
      metadata: Object.assign(
        { server_url: config.url! },
        { openid_subject: user.openidId, openid_issuer: user.openidIssuer },
      ),
    });
    await expect(MCPTokenStorage.getTokens(params)).rejects.toMatchObject({ reason: 'binding' });
    await expect(MCPTokenStorage.forceRefreshTokens(params)).rejects.toMatchObject({
      reason: 'binding',
    });
    await expect(MCPTokenStorage.getClientInfoAndMetadata(params)).rejects.toMatchObject({
      reason: 'binding',
    });
    await expect(
      MCPTokenStorage.hasStoredAuthorization({ ...params, validateClientBinding: jest.fn() }),
    ).resolves.toBe(false);
  });

  it.each([
    { outage: false, status: 400 },
    { outage: true, status: 503 },
  ])('keeps preview authority denial distinct from an outage: %p', async ({ outage, status }) => {
    const { service, row, authorizeInvocation, requestGrant, tokenStore } = harness();
    if (outage) {
      authorizeInvocation.mockRejectedValueOnce(new Error('private authority-store detail'));
    } else {
      authorizeInvocation.mockResolvedValueOnce(false);
    }
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    await service.describeFromRequest(
      { user, params: { id: row.id, server: 'Files' } } as unknown as ServerRequest,
      response as unknown as Response,
    );
    expect(response.status).toHaveBeenCalledWith(status);
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      'private authority-store detail',
    );
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('does not construct credential storage merely because routes load', async () => {
    const factory = jest.fn(() => harness().service);
    const deferred = createLazyScheduledOboGrantService(factory);
    deferred.setInspector(jest.fn(async () => []));
    expect(factory).not.toHaveBeenCalled();
    await deferred.resolve(user, { context, target });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('never enrolls or returns a token without the explicit live-session step', async () => {
    const { service, requestGrant, tokenStore } = harness();
    const provider = await service.resolve(user, { context, target });
    await expect(provider!()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('stores only the downstream grant and refreshes it after a twelve-hour gap without a browser', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'one-time-upstream-user-assertion');
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      'urn:ietf:params:oauth:grant-type:jwt-bearer',
      {
        scope: 'api://resource/Read offline_access',
        assertion: 'one-time-upstream-user-assertion',
        requested_token_use: 'on_behalf_of',
      },
    );
    expect(tokenStore.getAll()).toHaveLength(3);
    expect(
      tokenStore.getAll().some((token) => token.token.includes('one-time-upstream-user-assertion')),
    ).toBe(false);
    row.enabled = true;
    const provider = await service.resolve(user, { context, target });
    const exchange = jest.fn();
    const initial = await resolveOboToken(user, config.obo!, exchange, provider!);
    expect(initial.access_token).toBe('first');
    expect(exchange).not.toHaveBeenCalled();
    const access = tokenStore.getAll().find((t) => t.type === 'mcp_oauth')!;
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth', identifier: access.identifier },
      { expiresAt: new Date(Date.now() - 12 * 60 * 60_000) },
    );
    const after = await resolveOboToken(user, config.obo!, exchange, provider!);
    expect(after.access_token).toBe('fresh-after-12h');
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      'refresh_token',
      {
        refresh_token: 'server-scoped-refresh',
        scope: config.obo!.scopes,
      },
      expect.any(AbortSignal),
    );
    expect(exchange).not.toHaveBeenCalled();
    expect(tokenStore.getAll().find((t) => t.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:rotated-refresh',
    );
  });

  it('accepts JWT exp without expires_in on enrollment and rotating renewal', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    const initial = jwt.sign({ exp: Math.floor(Date.now() / 1000) + 3600 }, 'test-signature');
    const renewed = jwt.sign({ exp: Math.floor(Date.now() / 1000) + 7200 }, 'test-signature');
    requestGrant
      .mockResolvedValueOnce({ access_token: initial, refresh_token: 'original' })
      .mockResolvedValueOnce({ access_token: renewed, refresh_token: 'rotated' });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const storedAccess = tokenStore.getAll().find((record) => record.type === 'mcp_oauth')!;
    expect(storedAccess.expiresAt.getTime() - Date.now()).toBeGreaterThan(3500_000);
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
      scheduledObo: true,
      access_token: renewed,
    });
    expect(tokenStore.getAll().find((record) => record.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:rotated',
    );
    expect(
      tokenStore
        .getAll()
        .find((record) => record.type === 'mcp_oauth')!
        .expiresAt.getTime() - Date.now(),
    ).toBeGreaterThan(7100_000);
  });

  it('keeps client metadata alive for a non-rotating long-lived refresh grant', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    requestGrant.mockResolvedValueOnce({
      access_token: 'first',
      refresh_token: 'long-lived',
      expires_in: 3600,
      refresh_token_expires_in: 2 * 365 * 24 * 3600,
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const refreshExpiry = tokenStore
      .getAll()
      .find((record) => record.type === 'mcp_oauth_refresh')!
      .expiresAt.getTime();
    requestGrant.mockResolvedValueOnce({ access_token: 'renewed', expires_in: 3600 });
    const provider = (await service.resolve(user, { context, target }))!;
    await provider({ forceRefresh: true });
    const records = tokenStore.getAll();
    expect(records.find((record) => record.type === 'mcp_oauth_refresh')!.expiresAt.getTime()).toBe(
      refreshExpiry,
    );
    expect(
      records.find((record) => record.type === 'mcp_oauth_client')!.expiresAt.getTime(),
    ).toBeGreaterThanOrEqual(refreshExpiry);
  });

  it('preserves provider refresh expiry on enrollment and after token rotation', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    requestGrant
      .mockResolvedValueOnce({
        access_token: 'first',
        refresh_token: 'short-lived',
        expires_in: 3600,
        refresh_token_expires_in: 120,
      })
      .mockResolvedValueOnce({
        access_token: 'second',
        refresh_token: 'long-lived',
        expires_in: 3600,
        refresh_token_expires_in: 2 * 365 * 24 * 3600,
      });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const refresh = tokenStore.getAll().find((record) => record.type === 'mcp_oauth_refresh')!;
    expect(refresh.expiresAt.getTime() - Date.now()).toBeLessThan(121_000);
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await provider({ forceRefresh: true });
    const rotated = tokenStore.getAll().find((record) => record.type === 'mcp_oauth_refresh')!;
    expect(rotated.token).toBe('enc:long-lived');
    expect(rotated.expiresAt.getTime() - Date.now()).toBeGreaterThan(365 * 24 * 3600_000);
  });

  it('lists retained grant names after policy removal without exposing secrets or other owners', async () => {
    const { service, tokenStore, row, setAllowed } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    setAllowed([]);
    expect(await service.listEnrolled(user.id)).toEqual({ 'sched-1': ['Files'] });
    expect(await service.listEnrolled('other')).toEqual({});
    expect(JSON.stringify(await service.listEnrolled(user.id))).not.toContain(
      'server-scoped-refresh',
    );
    await service.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
    expect(await service.listEnrolled(user.id)).toEqual({});
  });

  it('rechecks schedule, agent, scope and allowlist at every use; revoke makes future use impossible', async () => {
    const { service, row, setAllowed, setServer, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'user-assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).resolves.toMatchObject({ scheduledObo: true, access_token: 'first' });
    setAllowed([]);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAllowed(['Files']);
    setServer({ ...config, obo: { scopes: 'api://resource/Write' } });
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setServer(config);
    row.agent_id = 'different';
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    row.agent_id = 'root';
    await service.revoke(user.id, row.id, 'Files');
    expect(tokenStore.getAll()).toEqual([]);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('fails closed on revoked root-agent access and the missing base schedule policy', async () => {
    const { service, row, setAgentAllowed, setBaseAvailable } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    setAgentAllowed(false);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAgentAllowed(true);
    setBaseAvailable(false);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('keeps a transient credential-store read retryable instead of revoking the schedule', async () => {
    const { service, row, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    const lookup = jest
      .spyOn(tokenStore, 'findToken')
      .mockRejectedValueOnce(new Error('store down'));
    await expect(provider()).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
    });
    lookup.mockRestore();
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
  });

  it('refuses enrollment if the live OpenID session does not match the persisted owner', async () => {
    const { service, requestGrant } = harness();
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    const request = {
      user,
      params: { id: 'sched-1', server: 'Files' },
      session: {
        openidTokens: {
          appUserId: 'other',
          openidSubject: 'subject',
          openidIssuer: user.openidIssuer,
          tenantId: 'tenant',
          accessToken: 'bearer',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    } as unknown as ServerRequest;
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('never pauses an enabled schedule when the requested server has no grant', async () => {
    const { service, row, pauseSchedule } = harness();
    row.enabled = true;
    await expect(service.revoke(user.id, row.id, 'unselected')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
    expect(row.enabled).toBe(true);
    expect(pauseSchedule).not.toHaveBeenCalled();
  });

  it('quiesces modern renewal before schedule deletion and keeps its purpose fence held', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let signal: AbortSignal | undefined;
    requestGrant.mockImplementationOnce(async (...args) => {
      signal = args[3];
      started();
      await Promise.race([
        blocked,
        new Promise<never>((_, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        }),
      ]);
      return { access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 };
    });
    const provider = (await service.resolve(user, { context, target }))!;
    const renewing = provider({ forceRefresh: true }).catch((error) => error);
    await entered;
    const afterPurge = jest.fn(async () => {
      expect(signal?.aborted).toBe(true);
      expect(
        MCPTokenStorage.isRefreshTeardownActive(
          user.id,
          'schedule-obo:sched-1:Files',
          user.tenantId,
          true,
        ),
      ).toBe(true);
      expect(tokenStore.getAll()).toEqual([]);
      return 'deleted';
    });
    try {
      await expect(service.purge(user.id, row.id, afterPurge)).resolves.toBe('deleted');
      expect(await renewing).toBeInstanceOf(Error);
      expect(afterPurge).toHaveBeenCalledTimes(1);
      expect(tokenStore.getAll()).toEqual([]);
    } finally {
      release();
      await renewing;
    }
  });

  it('waits for modern persistence and rollback before removing the schedule', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    await tokenStore.deleteTokens({
      userId: user.id,
      type: 'mcp_oauth',
      identifier: 'scheduled-mcp:schedule-obo:sched-1:Files',
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = tokenStore.createToken;
    jest.spyOn(tokenStore, 'createToken').mockImplementationOnce(async (data) => {
      const created = await create(data);
      entered();
      await blocked;
      return created;
    });
    const provider = (await service.resolve(user, { context, target }))!;
    const renewing = provider({ forceRefresh: true }).catch((error) => error);
    await started;
    const afterPurge = jest.fn(async () => 'deleted');
    const deletion = service.purge(user.id, row.id, afterPurge);
    try {
      await new Promise((resolve) => setImmediate(resolve));
      expect(afterPurge).not.toHaveBeenCalled();
    } finally {
      release();
      await renewing;
      await deletion;
    }
    expect(afterPurge).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAll()).toEqual([]);
    expect(requestGrant).toHaveBeenCalledTimes(2);
  });

  it('keeps custom-variable lookup failures retryable without diagnostic disclosure', async () => {
    const { service, row, deps, setServer, setVariables, tokenStore } = harness();
    setServer({
      ...config,
      url: 'https://mcp.test/{{KEY}}',
      customUserVars: { KEY: { title: 'Key', description: 'Credential', sensitive: true } },
    });
    setVariables({ KEY: 'test-key' });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const error = Object.assign(new Error(`private-variable-diagnostic-${'x'.repeat(5000)}`), {
      query: { token: 'private-variable-query' },
    });
    deps.findPluginAuthsByKeys = async () => {
      throw error;
    };
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, url: 'https://mcp.test/test-key' },
    }))!;
    await expect(provider()).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
    });
    expect(
      JSON.stringify([
        ...jest.mocked(logger.warn).mock.calls,
        ...jest.mocked(logger.error).mock.calls,
      ]),
    ).not.toMatch(/private-variable-diagnostic|private-variable-query/);
    expect(tokenStore.getAll()).toHaveLength(3);
  });

  it('logs only safe metadata through the real coordinator for credential-store diagnostics', async () => {
    const { service, row, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const diagnostic = Object.assign(new Error('private-query-secret'), {
      query: { token: 'stored-credential-secret' },
      response: { status: 503, data: { refresh_token: 'provider-secret' } },
      cause: new Error('nested-private-secret'),
    });
    const find = tokenStore.findToken;
    jest.spyOn(tokenStore, 'findToken').mockImplementation(async (...args) => {
      if (args[0].type === 'mcp_oauth') throw diagnostic;
      return find(...args);
    });
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).rejects.toMatchObject({ retryable: true });
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to retrieve tokens'),
      { type: 'Error', status: 503 },
    );
    const calls = [...jest.mocked(logger.error).mock.calls, ...jest.mocked(logger.warn).mock.calls];
    expect(JSON.stringify(calls)).not.toMatch(
      /private-query-secret|stored-credential-secret|provider-secret|nested-private-secret/,
    );
    expect(logger.warn).toHaveBeenCalledWith('[schedules] scheduled OBO credential read failed', {
      type: 'Error',
    });
  });

  it.each(['renewal', 'cached read', 'peer adoption'] as const)(
    'rechecks live operator policy after %s without deleting the retained grant',
    async (phase) => {
      const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
      const { service, row, setAllowed, tokenStore, requestGrant } = harness(coordinator);
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      row.enabled = true;
      if (phase === 'renewal')
        requestGrant.mockImplementationOnce(async () => {
          setAllowed([]);
          return { access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 };
        });
      if (phase === 'cached read')
        coordinator.getTokens = async (params) => {
          const result = await MCPTokenStorage.getTokens(params);
          setAllowed([]);
          return result;
        };
      if (phase === 'peer adoption')
        coordinator.forceRefreshTokens = async (params) => {
          await service.enroll(user.id, row.id, 'Files', 'peer-assertion');
          const result = await MCPTokenStorage.forceRefreshTokens(params);
          setAllowed([]);
          return result;
        };
      const provider = (await service.resolve(user, { context, target }))!;
      await expect(provider({ forceRefresh: phase !== 'cached read' })).rejects.toMatchObject({
        reason: 'missing_upstream_provider',
        retryable: false,
      });
      expect(tokenStore.getAll()).toHaveLength(3);
      if (phase === 'peer adoption')
        expect(requestGrant.mock.calls.filter(([, type]) => type === 'refresh_token')).toHaveLength(
          0,
        );
      await service.revoke(user.id, row.id, 'Files');
      expect(tokenStore.getAll()).toEqual([]);
    },
  );

  it.each(['destination', 'provider endpoint', 'root', 'role', 'outage'] as const)(
    'rechecks %s after renewal while retaining cleanup',
    async (changed) => {
      const {
        service,
        row,
        deps,
        requestGrant,
        tokenStore,
        setServer,
        setProvider,
        setAgentAllowed,
      } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      row.enabled = true;
      requestGrant.mockImplementationOnce(async () => {
        if (changed === 'destination') setServer({ ...config, url: 'https://changed.test/mcp' });
        else if (changed === 'provider endpoint')
          setProvider(user.openidIssuer!, 'https://changed.test/token');
        else if (changed === 'root') row.agent_id = 'changed-root';
        else if (changed === 'role') setAgentAllowed(false);
        else
          deps.getAppConfig = async () => {
            throw new Error('private-policy-outage');
          };
        return { access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 };
      });
      const provider = (await service.resolve(user, { context, target }))!;
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({
        retryable: changed === 'outage',
      });
      expect(tokenStore.getAll()).toHaveLength(3);
      await service.revoke(user.id, row.id, 'Files');
      expect(tokenStore.getAll()).toEqual([]);
    },
  );

  it('rechecks operator policy after enrollment exchange before persisting a grant', async () => {
    const { service, row, setAllowed, requestGrant, tokenStore } = harness();
    requestGrant.mockImplementationOnce(async () => {
      setAllowed([]);
      return { access_token: 'first', refresh_token: 'refresh', expires_in: 3600 };
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('refuses deletion when a modern grant fence is unavailable and releases teardown for retry', async () => {
    const { service, row, tokenStore, flow } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const leaseId = getMCPOAuthLeaseId(user.id, 'schedule-obo:sched-1:Files', user.tenantId, true);
    const acquire = flow.acquireLease.bind(flow);
    const fence = jest
      .spyOn(flow, 'acquireLease')
      .mockImplementation(async (id, options) => (id === leaseId ? null : acquire(id, options)));
    const afterPurge = jest.fn(async () => 'deleted');
    await expect(service.purge(user.id, row.id, afterPurge)).rejects.toThrow(
      'cleanup is in progress',
    );
    expect(afterPurge).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toHaveLength(3);
    expect(
      MCPTokenStorage.isRefreshTeardownActive(
        user.id,
        'schedule-obo:sched-1:Files',
        user.tenantId,
        true,
      ),
    ).toBe(false);
    fence.mockRestore();
    await expect(service.purge(user.id, row.id, afterPurge)).resolves.toBe('deleted');
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('fences modern grants only for the deleted schedule without touching ordinary prefix credentials', async () => {
    const { service, row, tokenStore, flow } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const base = {
      userId: user.id,
      findToken: tokenStore.findToken,
      createToken: tokenStore.createToken,
      updateToken: tokenStore.updateToken,
      deleteTokens: tokenStore.deleteTokens,
      flowManager: flow,
      tokens: {
        access_token: 'other',
        refresh_token: 'other-refresh',
        token_type: 'Bearer',
        expires_in: 3600,
      },
      clientInfo: { client_id: 'client' },
    };
    await MCPTokenStorage.storeTokens({
      ...base,
      serverName: 'schedule-obo:other-schedule:Files',
      scheduledGrant: true,
    });
    await MCPTokenStorage.storeTokens({ ...base, serverName: 'schedule-obo:sched-1:Files' });
    const id = getMCPOAuthLeaseId(user.id, 'schedule-obo:sched-1:Files', user.tenantId, true);
    const before = await flow.getLeaseGeneration(id);
    await service.purge(user.id, row.id, async () => {
      expect(await flow.acquireLease(id, { expectedGeneration: before!, waitMs: 0 })).toBeNull();
      expect(
        MCPTokenStorage.isRefreshTeardownActive(
          user.id,
          'schedule-obo:other-schedule:Files',
          user.tenantId,
          true,
        ),
      ).toBe(false);
      expect(
        MCPTokenStorage.isRefreshTeardownActive(
          user.id,
          'schedule-obo:sched-1:Files',
          user.tenantId,
        ),
      ).toBe(false);
    });
    await expect(
      flow.acquireLease(id, { expectedGeneration: before!, waitMs: 0 }),
    ).resolves.toBeNull();
    await expect(
      MCPTokenStorage.getTokens({ ...base, serverName: 'schedule-obo:sched-1:Files' }),
    ).resolves.toMatchObject({ access_token: 'other' });
    await expect(service.listEnrolled(user.id)).resolves.toEqual({ 'other-schedule': ['Files'] });
    expect(tokenStore.getAll()).toHaveLength(6);
  });

  it('keeps a schedule visible for retry when grant cleanup fails before deletion', async () => {
    const { service, row, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const deleteSchedule = jest.fn(async () => {
      row.enabled = false;
      return 'deleted';
    });
    const cleanup = jest
      .spyOn(tokenStore, 'deleteTokens')
      .mockRejectedValueOnce(new Error('store offline'));
    await expect(service.purge(user.id, row.id, deleteSchedule)).rejects.toThrow('store offline');
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(row.enabled).toBe(true);
    cleanup.mockRestore();
    await expect(service.purge(user.id, row.id, deleteSchedule)).resolves.toBe('deleted');
    expect(tokenStore.getAll()).toEqual([]);
    expect(deleteSchedule).toHaveBeenCalledTimes(1);
  });

  it('rejects an enrollment finishing after the owner deletes the schedule', async () => {
    const { service, tokenStore, requestGrant } = harness();
    let unblock!: () => void;
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    requestGrant.mockImplementationOnce(async () => {
      started();
      await blocked;
      return { access_token: 'late', refresh_token: 'late-secret', expires_in: 3600 };
    });
    const enrolling = service.enroll(user.id, context.scheduleId, 'Files', 'assertion');
    await entered;
    await service.purge(user.id, context.scheduleId);
    unblock();
    await expect(enrolling).rejects.toThrow();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('coalesces simultaneous expired-grant reads instead of replaying a rotating refresh token', async () => {
    const { service, row, tokenStore, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const old = tokenStore.getAll().find((record) => record.type === 'mcp_oauth')!;
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth', identifier: old.identifier },
      { expiresAt: new Date(Date.now() - 12 * 60 * 60_000) },
    );
    const [first, second] = await Promise.all([
      service.resolve(user, { context, target }),
      service.resolve(user, { context, target }),
    ]);
    await expect(Promise.all([first!(), second!()])).resolves.toEqual([
      expect.objectContaining({ access_token: 'fresh-after-12h' }),
      expect.objectContaining({ access_token: 'fresh-after-12h' }),
    ]);
    expect(requestGrant.mock.calls.filter(([, type]) => type === 'refresh_token')).toHaveLength(1);
  });

  it('retains a non-rotating provider refresh token after a subsequent access renewal', async () => {
    const { service, row, tokenStore, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    requestGrant.mockResolvedValueOnce({ access_token: 'fresh', expires_in: 3600 });
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
      access_token: 'fresh',
      scheduledObo: true,
    });
    expect(tokenStore.getAll().find((token) => token.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:server-scoped-refresh',
    );
    await expect(provider()).resolves.toMatchObject({ access_token: 'fresh' });
  });

  it('enrolls only when the signed-in session proves the owner and sends just its access token', async () => {
    const { service, requestGrant } = harness();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
    } as unknown as Response;
    const request = {
      user,
      params: { id: 'sched-1', server: 'Files' },
      body: { expectedScopes: 'api://resource/Read', expectedBinding: binding() },
      session: {
        openidTokens: {
          appUserId: 'owner',
          openidSubject: 'subject',
          openidIssuer: user.openidIssuer,
          tenantId: 'tenant',
          accessToken: 'one-time-access',
          refreshToken: 'browser-login-secret',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    } as unknown as ServerRequest;
    await service.describeFromRequest(request, response);
    expect(response.json).toHaveBeenCalledWith({
      server: 'Files',
      scopes: 'api://resource/Read',
      url: config.url,
      binding: binding(),
    });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(204);
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ assertion: 'one-time-access' }),
    );
    expect(JSON.stringify(requestGrant.mock.calls)).not.toContain('browser-login-secret');
    Object.assign(request.body, { expectedScopes: 'api://resource/Write' });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenLastCalledWith(400);
    expect(requestGrant).toHaveBeenCalledTimes(1);
  });

  it('accepts a valid live JWT access token without a redundant persisted expiry', async () => {
    const { service, requestGrant } = harness();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
    } as unknown as Response;
    const token = jwt.sign(
      { sub: user.openidId, exp: Math.floor(Date.now() / 1000) + 3600 },
      'test-only-signature',
    );
    const request = {
      user,
      params: { id: context.scheduleId, server: target.mcpServer },
      body: { expectedScopes: target.scopes, expectedBinding: binding() },
      session: {
        openidTokens: {
          appUserId: user.id,
          openidSubject: user.openidId,
          openidIssuer: user.openidIssuer,
          tenantId: user.tenantId,
          accessToken: token,
        },
      },
    } as unknown as ServerRequest;
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(204);
    expect(requestGrant).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ assertion: token }),
    );
  });

  it.each(['preflight', 'initial', 'restored'] as const)(
    'uses trusted manual provenance for paused OBO %s, never body-provided flags',
    async (path) => {
      const {
        service,
        row,
        deps,
        requestGrant,
        tokenStore,
        authorizeInvocation,
        setInvocationAllowed,
      } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      let received: string | undefined;
      const obtain = async (manual: boolean): Promise<void> => {
        if (path === 'preflight') {
          const preflight = createScheduleMCPPreflight({
            ...deps,
            resolveAgentGraphAccess: async () => ({}) as never,
            getAgentGraphNodes: async (ids) =>
              ids.map((id) => ({ id, provider: 'test', model: 'test', tools: ['read_mcp_Files'] })),
            getModelsConfig: async () => ({ test: ['test'] }),
            getAppConfig: async () =>
              ({
                endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
                mcpConfig: { Files: config },
              }) as Partial<AppConfig> as AppConfig,
            resolveUpstreamTokenProvider: service.resolve,
            connect: async (options) => {
              const provider = await options.upstreamTokenProviderResolver!({
                target: { mcpServer: options.serverName, url: config.url!, scopes: target.scopes },
              });
              received = (await provider!())?.access_token;
              return {
                fetchToolsSnapshot: async () => ({
                  tools: [{ name: 'read', inputSchema: { type: 'object' as const } }],
                  complete: true,
                }),
              };
            },
          });
          await preflight(context.agentId, user, { scheduleId: row.id, concurrency: 1, manual });
          return;
        }
        const req = {
          user,
          _isScheduledFire: true,
          _isAgentTrigger: path === 'initial',
          body: {
            manual: true,
            scheduleManual: true,
            agent_id: context.agentId,
            agentTrigger: {
              version: 1,
              event: {
                type: 'schedule.occurrence',
                occurredAt: 0,
                source: { type: 'schedule', id: row.id },
              },
              metadata: { manual: path === 'initial' ? manual : true },
            },
          },
        };
        const restored =
          path === 'restored'
            ? restoreScheduledTokenContext(req, {
                userId: user.id,
                tenantId: user.tenantId,
                scheduleId: row.id,
                agent_id: context.agentId,
                scheduleManual: manual,
              })
            : undefined;
        const resolver = createScheduleUpstreamTokenProviderResolver(
          req,
          service.resolve,
          undefined,
          restored,
        )!;
        const provider = await resolver({ target });
        received = (await provider!())?.access_token;
      };
      await obtain(true);
      expect(received).toBe('first');
      expect(authorizeInvocation).toHaveBeenLastCalledWith(
        user,
        { ...context, manual: true },
        target,
      );
      await expect(obtain(false)).rejects.toBeInstanceOf(Error);
      const access = tokenStore.getAll().find((record) => record.type === 'mcp_oauth')!;
      await tokenStore.updateToken(
        { userId: user.id, type: access.type, identifier: access.identifier },
        { expiresAt: new Date(Date.now() - 1000) },
      );
      await obtain(true);
      expect(received).toBe('fresh-after-12h');
      expect(requestGrant).toHaveBeenCalledTimes(2);
      setInvocationAllowed(false);
      await expect(obtain(true)).rejects.toBeInstanceOf(Error);
      await service.revoke(user.id, row.id, 'Files');
      expect(tokenStore.getAll()).toEqual([]);
    },
  );

  it.each(['root', 'scope', 'operator policy', 'account'] as const)(
    'does not let manual provenance bypass %s withdrawal',
    async (denial) => {
      const { service, row, tokenStore, setAllowed, setServer, setOwnerActive, requestGrant } =
        harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      const provider = (await service.resolve(user, {
        context: { ...context, manual: true },
        target,
      }))!;
      await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
      if (denial === 'root') row.agent_id = 'different';
      else if (denial === 'scope') setServer({ ...config, obo: { scopes: 'different' } });
      else if (denial === 'operator policy') setAllowed([]);
      else setOwnerActive(false);
      await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
      expect(requestGrant).toHaveBeenCalledTimes(1);
      expect(tokenStore.getAll()).toHaveLength(3);
    },
  );

  it('reads an enrolled grant for activation preflight but never for a disabled scheduled run', async () => {
    const { service, row, setAllowed, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'one-time-assertion');
    const forRun = (await service.resolve(user, { context, target }))!;
    await expect(forRun()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });

    const forActivation = (await service.resolve(user, {
      context,
      target,
      activationPreflight: true,
    }))!;
    await expect(forActivation()).resolves.toMatchObject({ access_token: 'first' });
    expect(requestGrant).toHaveBeenCalledTimes(1);
    setAllowed([]);
    await expect(forActivation()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAllowed(['Files']);
    row.enabled = true;
    await expect(forRun()).resolves.toMatchObject({ access_token: 'first' });
    row.enabled = false;
    await expect(forRun()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('fences a paused grant revocation against activation that already passed preflight', async () => {
    const { service, row, pauseSchedule, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const revisionAtPreflight = row.configRevision;
    const provider = (await service.resolve(user, {
      context,
      target,
      activationPreflight: true,
    }))!;
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
    await service.revoke(user.id, row.id, 'Files');
    expect(pauseSchedule).toHaveBeenCalledWith(row.id, user.id, revisionAtPreflight);
    expect(row.configRevision).toBe(revisionAtPreflight + 1);
    expect(tokenStore.getAll()).toEqual([]);
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('rejects a changed endpoint after preview before exchanging any OBO assertion', async () => {
    const { service, requestGrant, tokenStore, setServer } = harness();
    const response = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      end: jest.fn(),
    } as unknown as Response;
    const request = {
      user,
      params: { id: context.scheduleId, server: 'Files' },
      body: { expectedScopes: target.scopes, expectedBinding: binding() },
      session: {
        openidTokens: {
          appUserId: user.id,
          openidSubject: user.openidId,
          openidIssuer: user.openidIssuer,
          tenantId: user.tenantId,
          accessToken: 'one-time-access',
          accessTokenExpiresAt: Math.floor(Date.now() / 1000) + 3600,
        },
      },
    } as unknown as ServerRequest;
    await service.describeFromRequest(request, response);
    expect(response.json).toHaveBeenCalledWith({
      server: 'Files',
      scopes: target.scopes,
      url: config.url,
      binding: binding(),
    });
    setServer({ ...config, url: 'https://other-mcp.test/tools' });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenCalledWith(400);
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);

    setServer(config);
    Object.assign(request.body, { expectedBinding: undefined });
    await service.enrollFromRequest(request, response);
    expect(response.status).toHaveBeenLastCalledWith(400);
    expect(requestGrant).not.toHaveBeenCalled();
  });

  it('rejects endpoint changes during the exchange before storing the grant', async () => {
    const { service, setServer, tokenStore, requestGrant } = harness();
    requestGrant.mockImplementationOnce(async () => {
      setServer({ ...config, url: 'https://moved-mcp.test/tools' });
      return { access_token: 'received', refresh_token: 'grant', expires_in: 3600 };
    });
    await expect(
      service.enroll(user.id, context.scheduleId, 'Files', 'assertion', target.scopes, binding()),
    ).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('uses the injected coordinator for storage and credential lookup', async () => {
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    coordinator.storeTokens = jest.fn((...args) => MCPTokenStorage.storeTokens(...args));
    coordinator.getClientInfoAndMetadata = jest.fn(async () => null);
    const { service, row } = harness(coordinator);
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    expect(coordinator.storeTokens).toHaveBeenCalledTimes(1);
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(coordinator.getClientInfoAndMetadata).toHaveBeenCalledTimes(1);
  });

  it('uses a real MCP SDK server to validate an enrolled paused schedule on activation', async () => {
    const seen: string[] = [];
    const mcp = await createOAuthMCPServer({
      onResourceRequest: (req) => {
        if (req.method === 'POST' && req.headers.authorization)
          seen.push(req.headers.authorization);
      },
    });
    const { service, row, tokenStore, flow, requestGrant, setServer } = harness();
    const liveServer = { ...config, url: `${mcp.url}{{LIBRECHAT_USER_ID}}` };
    setServer(liveServer);
    requestGrant.mockImplementation(async () => {
      mcp.issuedTokens.add('enrolled');
      mcp.tokenIssueTimes.set('enrolled', Date.now());
      return { access_token: 'enrolled', refresh_token: 'offline-grant', expires_in: 3600 };
    });
    try {
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      const preflight = createScheduleMCPPreflight({
        resolveAgentGraphAccess: async () => ({}) as never,
        getAgentGraphNodes: async (ids) =>
          ids.map((id) => ({
            id,
            provider: 'openAI',
            model: 'gpt-test',
            tools: ['echo_mcp_Files'],
          })),
        getModelsConfig: async () => ({ openAI: ['gpt-test'] }),
        getRoleByName: async () =>
          ({
            permissions: {
              [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
              [PermissionTypes.SCHEDULES]: { [Permissions.USE]: true },
              [PermissionTypes.AGENTS]: { [Permissions.USE]: true },
            },
          }) as never,
        getUser: async () => user,
        getAppConfig: async () =>
          ({
            endpoints: { agents: { capabilities: [AgentCapabilities.tools] } },
            mcpConfig: { Files: liveServer },
            interfaceConfig: { schedules: { use: true, oboServers: ['Files'] } },
          }) as Partial<AppConfig> as AppConfig,
        ensureConfigServers: async () => ({ Files: liveServer }),
        getServerConfigs: async () => ({ Files: liveServer }),
        findPluginAuthsByKeys: async () => [],
        resolveUpstreamTokenProvider: service.resolve,
        connect: async (options) => {
          const connection = await MCPConnectionFactory.create(
            { serverName: options.serverName, serverConfig: options.serverConfig! },
            {
              user,
              useOAuth: true,
              flowManager: flow,
              tokenMethods: tokenStore,
              upstreamTokenProviderResolver: options.upstreamTokenProviderResolver,
              oboTokenResolver: async () => {
                throw new Error('The downstream grant must never be exchanged as an assertion');
              },
              oboTrustChecker: async () => true,
            },
          );
          options.requestScopedConnections?.connections.set(options.serverName, connection);
          return connection;
        },
      });
      const options = { scheduleId: row.id, concurrency: 3 };
      await expect(
        preflight('root', user, { ...options, activationPreflight: true }),
      ).resolves.toEqual([{ server: 'Files', status: 'ready' }]);
      expect(seen).toContain('Bearer enrolled');
      await expect(preflight('root', user, options)).rejects.toBeInstanceOf(ScheduleMCPError);
      row.enabled = true;
      await expect(preflight('root', user, options)).resolves.toEqual([
        { server: 'Files', status: 'ready' },
      ]);
      const writePreflight = { agentId: row.agent_id, configRevision: row.configRevision };
      await expect(preflight('new-agent', user, { ...options, writePreflight })).resolves.toEqual([
        { server: 'Files', status: 'ready' },
      ]);
      await expect(preflight('new-agent', user, options)).rejects.toBeInstanceOf(ScheduleMCPError);
      row.agent_id = 'new-agent';
      row.configRevision += 1;
      await expect(
        preflight('new-agent', user, { ...options, writePreflight }),
      ).rejects.toBeInstanceOf(ScheduleMCPError);
      await expect(preflight('new-agent', user, options)).resolves.toEqual([
        { server: 'Files', status: 'ready' },
      ]);
    } finally {
      await mcp.close();
    }
  }, 30_000);

  it.each([false, true])(
    'calls a real MCP SDK server across offline renewal with default selector=%s',
    async (selector) => {
      MCPConnection.clearCooldown('Files');
      const sentBearers: string[] = [];
      const mcp = await createOAuthMCPServer({
        onResourceRequest: (request) => {
          if (request.method === 'POST' && request.headers.authorization) {
            sentBearers.push(request.headers.authorization);
          }
        },
      });
      const { service, row, setServer, requestGrant, tokenStore, flow, setProvider } = harness();
      const liveServer = {
        ...config,
        url: mcp.url,
        obo: { scopes: selector ? 'api://resource/.default' : config.obo!.scopes },
      };
      setServer(liveServer);
      if (selector)
        setProvider(
          'https://login.microsoftonline.com/tenant/v2.0',
          'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
        );
      requestGrant.mockImplementation(async (_provider, grantType, params) => {
        const fresh = grantType === 'refresh_token';
        if (fresh && params.refresh_token !== 'offline-mcp-refresh') {
          throw new Error('Wrong refresh grant');
        }
        const token = fresh ? 'mcp-renewed' : 'mcp-first';
        mcp.issuedTokens.add(token);
        mcp.tokenIssueTimes.set(token, Date.now());
        return {
          access_token: token,
          refresh_token: 'offline-mcp-refresh',
          expires_in: 3600,
          ...(selector && { scope: fresh ? 'Read' : 'api://resource/Read' }),
        };
      });
      try {
        await service.enroll(user.id, row.id, 'Files', 'one-time-user-assertion');
        row.enabled = true;
        const options = {
          user,
          useOAuth: true as const,
          flowManager: flow,
          tokenMethods: tokenStore,
          oboTokenResolver: jest.fn(async () => {
            throw new Error('A downstream token must not be exchanged as an upstream assertion');
          }),
          oboTrustChecker: jest.fn(async () => true),
          upstreamTokenProviderResolver: (input?: { target?: UpstreamTokenTarget }) =>
            service.resolve(user, { context, target: input?.target }),
        };
        const call = async (message: string) => {
          const connection = await MCPConnectionFactory.create(
            { serverName: 'Files', serverConfig: liveServer },
            options,
          );
          try {
            expect((await connection.fetchTools()).map((tool) => tool.name)).toContain('echo');
            const reply = await connection.client.callTool({
              name: 'echo',
              arguments: { message },
            });
            expect(reply.content).toEqual([{ type: 'text', text: `echo: ${message}` }]);
          } finally {
            await connection.dispose();
          }
        };
        await call('first run');
        const access = tokenStore.getAll().find((record) => record.type === 'mcp_oauth')!;
        await tokenStore.updateToken(
          { userId: user.id, type: 'mcp_oauth', identifier: access.identifier },
          { expiresAt: new Date(Date.now() - 12 * 60 * 60_000) },
        );
        await call('later run');
        expect(sentBearers).toContain('Bearer mcp-first');
        expect(sentBearers).toContain('Bearer mcp-renewed');
        expect(options.oboTokenResolver).not.toHaveBeenCalled();
        expect(requestGrant.mock.calls.filter(([, kind]) => kind === 'refresh_token')).toHaveLength(
          1,
        );
      } finally {
        await mcp.close();
        MCPConnection.clearCooldown('Files');
      }
    },
    30_000,
  );

  it('requires the connection destination instead of guessing the latest configured endpoint', async () => {
    const { service, row, setServer, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const unbound = (await service.resolve(user, {
      context,
      target: { mcpServer: 'Files', scopes: target.scopes },
    }))!;
    await expect(unbound()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setServer({ ...config, url: 'https://replacement.test/mcp' });
    const stale = (await service.resolve(user, { context, target }))!;
    await expect(stale()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(requestGrant).toHaveBeenCalledTimes(1);
  });

  it('never sends a replacement grant to an old real MCP transport', async () => {
    const observed: string[] = [];
    const mcp = await createOAuthMCPServer({
      onResourceRequest: (req) => {
        if (req.headers.authorization) observed.push(req.headers.authorization);
      },
    });
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    const { service, row, tokenStore, flow, setServer, requestGrant } = harness(coordinator);
    const original = { ...config, url: mcp.url };
    const replacement = { ...config, url: 'https://replacement.test/mcp' };
    setServer(original);
    try {
      await service.enroll(
        user.id,
        row.id,
        'Files',
        'assertion',
        target.scopes,
        binding(original.url),
      );
      row.enabled = true;
      requestGrant.mockResolvedValue({
        access_token: 'replacement-only',
        refresh_token: 'replacement-refresh',
        expires_in: 3600,
      });
      coordinator.getTokens = async (params) => {
        setServer(replacement);
        await service.enroll(
          user.id,
          row.id,
          'Files',
          'new-assertion',
          target.scopes,
          binding(replacement.url),
        );
        mcp.issuedTokens.add('replacement-only');
        mcp.tokenIssueTimes.set('replacement-only', Date.now());
        return MCPTokenStorage.getTokens(params);
      };
      await expect(
        MCPConnectionFactory.create(
          { serverName: 'Files', serverConfig: original },
          {
            user,
            useOAuth: true,
            flowManager: flow,
            tokenMethods: tokenStore,
            oboTokenResolver: async () => {
              throw new Error('No downstream assertion exchange');
            },
            oboTrustChecker: async () => true,
            upstreamTokenProviderResolver: (input) =>
              service.resolve(user, { context, target: input?.target }),
          },
        ),
      ).rejects.toThrow();
      expect(observed).not.toContain('Bearer replacement-only');
      expect(requestGrant.mock.calls.filter(([, type]) => type === 'refresh_token')).toHaveLength(
        0,
      );
    } finally {
      await mcp.close();
    }
  });

  it('validates the returned generation even when a substituted storage bypasses token lookups', async () => {
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    const { service, row, tokenStore, setServer, requestGrant } = harness(coordinator);
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    coordinator.getTokens = async () => {
      setServer({ ...config, url: 'https://replacement.test/mcp' });
      requestGrant.mockResolvedValueOnce({
        access_token: 'replacement',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      });
      await service.enroll(
        user.id,
        row.id,
        'Files',
        'new-assertion',
        target.scopes,
        'https://replacement.test/mcp',
      );
      const access = tokenStore.getAll().find((r) => r.type === 'mcp_oauth')!;
      const generation =
        access.metadata instanceof Map
          ? access.metadata.get('credential_set_id')
          : access.metadata?.credential_set_id;
      return {
        access_token: 'replacement',
        token_type: 'Bearer',
        obtained_at: Date.now(),
        expires_at: Date.now() + 3600_000,
        credential_set_id: String(generation),
      };
    };
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('adopts a peer rotation between the initial binding check and token retrieval', async () => {
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    const { service, row, tokenStore, flow } = harness(coordinator);
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    coordinator.getTokens = async (params) => {
      await MCPTokenStorage.forceRefreshTokens({
        ...params,
        flowManager: flow,
        findToken: tokenStore.findToken,
        refreshTokens: async () => ({
          access_token: 'peer-access',
          refresh_token: 'peer-refresh',
          token_type: 'Bearer',
          obtained_at: Date.now(),
          expires_at: Date.now() + 3600_000,
        }),
      });
      return MCPTokenStorage.getTokens(params);
    };
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).resolves.toMatchObject({ access_token: 'peer-access' });
  });

  it('treats an incoherent credential generation as retryable, never permanently missing', async () => {
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    const { service, row, tokenStore } = harness(coordinator);
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const client = tokenStore.getAll().find((r) => r.type === 'mcp_oauth_client')!;
    const original = client.metadata;
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth_client', identifier: client.identifier },
      {
        metadata: {
          ...Object.fromEntries(
            original instanceof Map ? original : Object.entries(original ?? {}),
          ),
          credential_set_id: 'writer-in-progress',
        },
      },
    );
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).rejects.toMatchObject({
      reason: 'session_refresh_failed',
      retryable: true,
    });
    await tokenStore.updateToken(
      { userId: user.id, type: 'mcp_oauth_client', identifier: client.identifier },
      { metadata: original as Record<string, unknown> },
    );
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
  });

  it.each([
    'invalid_grant',
    'invalid_client',
    'unauthorized_client',
    'invalid_scope',
    'access_denied',
  ])('requires authorization after a structured provider %s error', async (code) => {
    const { service, row, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    requestGrant.mockRejectedValueOnce(
      Object.assign(new Error('server responded with an error in the response body'), {
        name: 'ResponseBodyError',
        code: 'OAUTH_RESPONSE_BODY_ERROR',
        error: code,
        status: 400,
      }),
    );
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
      retryable: false,
    });
  });

  it.each([429, 503])(
    'retains a grant after an actual transient provider status %s',
    async (status) => {
      const { service, row, requestGrant, tokenStore } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      row.enabled = true;
      requestGrant.mockRejectedValueOnce(
        Object.assign(new Error('server responded with an error in the response body'), {
          name: 'ResponseBodyError',
          code: 'OAUTH_RESPONSE_BODY_ERROR',
          error: 'temporarily_unavailable',
          status,
        }),
      );
      const provider = (await service.resolve(user, { context, target }))!;
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: true });
      expect(tokenStore.getAll()).toHaveLength(3);
      await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
        access_token: 'fresh-after-12h',
      });
    },
  );

  it('refuses enrollment completing after the account barrier and token sweep', async () => {
    const { service, row, tokenStore, requestGrant, setOwnerActive } = harness();
    requestGrant.mockImplementationOnce(async () => {
      setOwnerActive(false);
      row.enabled = false;
      await service.drainOwnerWrites(user.id);
      await tokenStore.deleteTokens({ userId: user.id });
      return { access_token: 'late', refresh_token: 'late-refresh', expires_in: 3600 };
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toThrow();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('drains token writes and rollback before the account sweep without blocking on a provider', async () => {
    const { service, row, tokenStore, setOwnerActive } = harness();
    let release!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = tokenStore.createToken;
    jest.spyOn(tokenStore, 'createToken').mockImplementationOnce(async (data) => {
      const created = await original(data);
      entered();
      await blocked;
      return created;
    });
    const enrolling = service.enroll(user.id, row.id, 'Files', 'assertion');
    await started;
    setOwnerActive(false);
    let drained = false;
    const deletion = service.drainOwnerWrites(user.id).then(async () => {
      drained = true;
      await tokenStore.deleteTokens({ userId: user.id });
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release();
    await enrolling;
    await deletion;
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('never persists a late renewal once the account deletion fence has advanced', async () => {
    const { service, row, tokenStore, requestGrant, setOwnerActive } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    requestGrant.mockImplementationOnce(async () => {
      setOwnerActive(false);
      await service.drainOwnerWrites(user.id);
      await tokenStore.deleteTokens({ userId: user.id });
      return { access_token: 'late-renewal', refresh_token: 'late-rotation', expires_in: 3600 };
    });
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider({ forceRefresh: true })).rejects.toThrow();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('binds the preview, persisted grant, activation and run to the same user/custom-variable URL', async () => {
    const { service, row, setServer, setVariables, tokenStore } = harness();
    setVariables({ REGION: 'europe' });
    setServer({
      ...config,
      url: 'https://mcp.test/{{REGION}}/{{LIBRECHAT_USER_ID}}',
      customUserVars: { REGION: { title: 'Region', description: 'Region' } },
    });
    const response = { status: jest.fn().mockReturnThis(), json: jest.fn() } as unknown as Response;
    await service.describeFromRequest(
      { user, params: { id: row.id, server: 'Files' } } as unknown as ServerRequest,
      response,
    );
    const resolved = 'https://mcp.test/europe/owner';
    expect(response.json).toHaveBeenCalledWith({
      server: 'Files',
      scopes: target.scopes,
      url: 'https://mcp.test/[redacted]/owner',
      binding: binding(resolved),
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion', target.scopes, binding(resolved));
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, url: resolved },
      activationPreflight: true,
    }))!;
    await expect(provider()).resolves.toMatchObject({ access_token: 'first' });
    row.enabled = true;
    await expect(
      (await service.resolve(user, { context, target: { ...target, url: resolved } }))!(),
    ).resolves.toMatchObject({ access_token: 'first' });
    expect(tokenStore.getAll().find((r) => r.type === 'mcp_oauth_client')?.metadata).toMatchObject({
      server_url: resolved,
    });
    setVariables({ REGION: 'america' });
    await expect(provider()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });

  it('does not persist an initial grant whose explicit scopes omit a required MCP scope', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    requestGrant.mockResolvedValueOnce({
      access_token: 'insufficient',
      refresh_token: 'unused',
      expires_in: 3600,
      scope: 'openid',
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
    });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('retires a consumed rotating grant when renewal explicitly reduces resource scopes', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    requestGrant.mockResolvedValueOnce({
      access_token: 'narrow',
      refresh_token: 'replacement',
      expires_in: 3600,
      scope: 'openid offline_access',
    });
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
    expect(tokenStore.getAll()).toEqual([]);
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
    expect(requestGrant).toHaveBeenCalledTimes(2);
  });

  it('retires the actual consumed grant when retrieval sees a newer generation than admission', async () => {
    const coordinator = Object.create(MCPTokenStorage) as typeof MCPTokenStorage;
    const { service, row, tokenStore, requestGrant } = harness(coordinator);
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    coordinator.getTokens = async (params) => {
      const key = `schedule-obo:${row.id}:Files`;
      const client = (await MCPTokenStorage.getClientInfoAndMetadata({
        userId: user.id,
        serverName: key,
        scheduledGrant: true as const,
        findToken: tokenStore.findToken,
      }))!;
      await MCPTokenStorage.storeTokens({
        userId: user.id,
        serverName: key,
        scheduledGrant: true as const,
        tokens: {
          access_token: 'peer-access',
          refresh_token: 'peer-grant',
          token_type: 'Bearer',
          expires_in: 0,
        },
        clientInfo: client.clientInfo,
        metadata: client.clientMetadata,
        findToken: tokenStore.findToken,
        createToken: tokenStore.createToken,
        updateToken: tokenStore.updateToken,
        deleteTokens: tokenStore.deleteTokens,
      });
      requestGrant.mockResolvedValueOnce({
        access_token: 'narrowed',
        refresh_token: 'rotated',
        expires_in: 3600,
        scope: 'openid',
      });
      return MCPTokenStorage.getTokens(params);
    };
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider()).rejects.toMatchObject({ retryable: false });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it.each(['narrow', 'unusable', 'structured', 'legacy'] as const)(
    'treats a superseded %s renewal failure as transient while new authorization remains usable',
    async (failure) => {
      const { service, row, requestGrant, tokenStore } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      row.enabled = true;
      requestGrant.mockImplementationOnce(async () => {
        requestGrant.mockResolvedValueOnce({
          access_token: 'new-consent',
          refresh_token: 'new-grant',
          expires_in: 3600,
        });
        await service.enroll(user.id, row.id, 'Files', 'new-assertion');
        if (failure === 'structured')
          throw Object.assign(new Error('server responded with an error in the response body'), {
            error: 'invalid_grant',
            status: 400,
          });
        if (failure === 'legacy') throw new Error('invalid_grant: old grant rejected');
        return {
          access_token: 'failed-old',
          refresh_token: 'consumed-old',
          expires_in: failure === 'unusable' ? 0 : 3600,
          scope: failure === 'narrow' ? 'openid' : target.scopes,
        };
      });
      const provider = (await service.resolve(user, { context, target }))!;
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({
        reason: 'session_refresh_failed',
        retryable: true,
      });
      expect(tokenStore.getAll()).toHaveLength(3);
      await expect(provider()).resolves.toMatchObject({ access_token: 'new-consent' });
      expect(row.enabled).toBe(true);
    },
  );

  it('probes an accessible prospective agent without giving a dispatched run the write exception', async () => {
    const { service, row, setAgentAllowed, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const prospective = { ...context, agentId: 'new-agent' };
    const writePreflight = { agentId: row.agent_id, configRevision: row.configRevision };
    const run = (await service.resolve(user, { context: prospective, target }))!;
    await expect(run()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    const admission = (await service.resolve(user, {
      context: prospective,
      target,
      writePreflight,
    }))!;
    await expect(admission()).resolves.toMatchObject({ access_token: 'first' });
    expect(requestGrant).toHaveBeenCalledTimes(1);
    setAgentAllowed(false);
    await expect(admission()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    setAgentAllowed(true);
    row.configRevision += 1;
    await expect(admission()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    row.agent_id = prospective.agentId;
    await expect(run()).resolves.toMatchObject({ access_token: 'first' });
  });

  it('requires the persisted agent snapshot and activation flag for a paused prospective update', async () => {
    const { service, row } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    const prospective = { ...context, agentId: 'new-agent' };
    const writePreflight = { agentId: row.agent_id, configRevision: row.configRevision };
    const denied = (await service.resolve(user, { context: prospective, target, writePreflight }))!;
    await expect(denied()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    const activation = (await service.resolve(user, {
      context: prospective,
      target,
      writePreflight,
      activationPreflight: true,
    }))!;
    await expect(activation()).resolves.toMatchObject({ access_token: 'first' });
    const mismatched = (await service.resolve(user, {
      context: prospective,
      target,
      writePreflight: { ...writePreflight, agentId: 'wrong' },
      activationPreflight: true,
    }))!;
    await expect(mismatched()).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
  });
  it('blocks an activation that reads the new paused revision while revocation is still deleting', async () => {
    const { service, row, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    let entered!: () => void;
    let release!: () => void;
    const deleting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = tokenStore.deleteTokens;
    jest.spyOn(tokenStore, 'deleteTokens').mockImplementationOnce(async (filter) => {
      entered();
      await blocked;
      return original(filter);
    });
    const revoking = service.revoke(user.id, row.id, 'Files');
    await deleting;
    const revision = row.configRevision;
    const provider = (await service.resolve(user, { context, target, activationPreflight: true }))!;
    let admitted = false;
    const activation = provider().then(
      () => {
        admitted = true;
        if (row.configRevision === revision) row.enabled = true;
      },
      () => undefined,
    );
    try {
      await new Promise((resolve) => setTimeout(resolve, 35));
      expect(admitted).toBe(false);
    } finally {
      release();
      await revoking;
      await activation;
    }
    expect(admitted).toBe(false);
    expect(row.enabled).toBe(false);
    expect(tokenStore.getAll()).toEqual([]);
  });

  it.each([0, 1, 30])(
    'retires a consumed rotating grant with access lifetime %s instead of replaying it',
    async (expires_in) => {
      const { service, row, requestGrant, tokenStore } = harness();
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      row.enabled = true;
      requestGrant.mockResolvedValueOnce({
        access_token: 'unusable',
        refresh_token: 'replacement',
        expires_in,
      });
      const provider = (await service.resolve(user, { context, target }))!;
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
      expect(tokenStore.getAll()).toEqual([]);
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
      expect(requestGrant).toHaveBeenCalledTimes(2);
    },
  );

  it('retires a consumed rotating grant whose returned token has no usable expiry', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    requestGrant.mockResolvedValueOnce({
      access_token: 'opaque-no-expiry',
      refresh_token: 'replacement',
    });
    const provider = (await service.resolve(user, { context, target }))!;
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
    expect(tokenStore.getAll()).toEqual([]);
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
    expect(requestGrant).toHaveBeenCalledTimes(2);
  });

  it('propagates only the coordinator cancellation to a stalled provider and completes revoke', async () => {
    const { service, row, requestGrant, tokenStore } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    let started!: () => void;
    const entered = new Promise<void>((r) => {
      started = r;
    });
    let providerSignal: AbortSignal | undefined;
    requestGrant.mockImplementationOnce(async (...args) => {
      providerSignal = args[3];
      started();
      return new Promise((_, reject) => {
        providerSignal!.addEventListener('abort', () => reject(providerSignal!.reason), {
          once: true,
        });
      });
    });
    const provider = (await service.resolve(user, { context, target }))!;
    const outcome = provider({ forceRefresh: true }).then(
      () => null,
      (e) => e,
    );
    await entered;
    expect(providerSignal?.aborted).toBe(false);
    await service.revoke(user.id, row.id, 'Files');
    expect(providerSignal?.aborted).toBe(true);
    expect(await outcome).toBeInstanceOf(Error);
    expect(tokenStore.getAll()).toEqual([]);
  });

  it.each([false, true])(
    'enrolls and renews Entra default-selector consent with initial scope omitted=%s',
    async (omitted) => {
      const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
      setProvider(
        'https://login.microsoftonline.com/tenant/v2.0',
        'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
      );
      setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
      const scoped = { ...target, scopes: 'api://resource/.default' };
      requestGrant.mockResolvedValueOnce({
        access_token: omitted
          ? jwt.sign(
              {
                aud: 'api://resource',
                scp: 'Files.Read Files.Write',
                exp: Math.floor(Date.now() / 1000) + 3600,
              },
              'test-only',
            )
          : 'initial-default',
        refresh_token: 'initial-default-grant',
        expires_in: 3600,
        ...(omitted ? {} : { scope: 'api://resource/Files.Read api://resource/Files.Write' }),
      });
      await service.enroll(user.id, row.id, 'Files', 'assertion');
      const client = tokenStore.getAll().find((r) => r.type === 'mcp_oauth_client')!;
      expect(JSON.parse(client.token.slice(4))).toMatchObject({
        scope: 'api://resource/.default offline_access',
        scheduled_obo_scope_binding: {
          version: 1,
          resource: 'api://resource',
          permissions: ['Files.Read', 'Files.Write'],
        },
      });
      row.enabled = true;
      const provider = (await service.resolve(user, { context, target: scoped }))!;
      requestGrant.mockResolvedValueOnce({
        access_token: 'renewed-default',
        refresh_token: 'rotated-default-grant',
        expires_in: 3600,
        scope: 'Files.Write Files.Read',
      });
      await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
        access_token: 'renewed-default',
      });
      expect(tokenStore.getAll().find((r) => r.type === 'mcp_oauth_refresh')?.token).toBe(
        'enc:rotated-default-grant',
      );
      expect(
        JSON.parse(
          tokenStore
            .getAll()
            .find((r) => r.type === 'mcp_oauth_client')!
            .token.slice(4),
        ).scheduled_obo_scope_binding,
      ).toEqual({
        version: 1,
        resource: 'api://resource',
        permissions: ['Files.Read', 'Files.Write'],
      });
      requestGrant.mockResolvedValueOnce({
        access_token: 'narrow-default',
        refresh_token: 'consumed-default',
        expires_in: 3600,
        scope: 'Files.Read',
      });
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
      expect(tokenStore.getAll()).toEqual([]);
      await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
      expect(requestGrant).toHaveBeenCalledTimes(3);
    },
  );

  it('preserves literal default-named scopes for a custom provider without granting wildcard semantics', async () => {
    const { service, row, requestGrant, tokenStore, setServer } = harness();
    setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'literal-default',
      refresh_token: 'grant',
      expires_in: 3600,
      scope: 'api://resource/.default',
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, scopes: 'api://resource/.default' },
    }))!;
    requestGrant.mockResolvedValueOnce({
      access_token: 'renewed-literal',
      refresh_token: 'rotated',
      expires_in: 3600,
      scope: 'api://resource/.default',
    });
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
      access_token: 'renewed-literal',
    });
    expect(
      JSON.parse(
        tokenStore
          .getAll()
          .find((r) => r.type === 'mcp_oauth_client')!
          .token.slice(4),
      ).scheduled_obo_scope_binding,
    ).toBeUndefined();
    requestGrant.mockResolvedValueOnce({
      access_token: 'not-literal',
      refresh_token: 'unused',
      expires_in: 3600,
      scope: 'Files.Read',
    });
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: false });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('does not fabricate an effective permission set for an opaque selector response or unknown provider', async () => {
    const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
    setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'opaque',
      refresh_token: 'grant',
      expires_in: 3600,
      scope: 'Files.Read',
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      retryable: false,
    });
    setProvider(
      'https://login.microsoftonline.com/tenant/v2.0',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    );
    requestGrant.mockResolvedValueOnce({
      access_token: 'opaque',
      refresh_token: 'grant',
      expires_in: 3600,
    });
    await expect(service.enroll(user.id, row.id, 'Files', 'assertion')).rejects.toMatchObject({
      retryable: false,
    });
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('retains stored selector permissions when an opaque renewal omits scope', async () => {
    const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
    setProvider(
      'https://login.microsoftonline.com/tenant/v2.0',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    );
    setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'first',
      refresh_token: 'grant',
      expires_in: 3600,
      scope: 'Files.Read Files.Write',
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    requestGrant.mockResolvedValueOnce({
      access_token: 'renewed-opaque',
      refresh_token: 'rotated',
      expires_in: 3600,
    });
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, scopes: 'api://resource/.default' },
    }))!;
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({
      access_token: 'renewed-opaque',
    });
    expect(
      JSON.parse(
        tokenStore
          .getAll()
          .find((r) => r.type === 'mcp_oauth_client')!
          .token.slice(4),
      ).scheduled_obo_scope_binding.permissions,
    ).toEqual(['Files.Read', 'Files.Write']);
    expect(requestGrant.mock.lastCall?.[2].scope).toBe('api://resource/.default');
  });

  it('renews established selector consent when a scopeless JWT uses an application audience alias', async () => {
    const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
    setProvider(
      'https://login.microsoftonline.com/tenant/v2.0',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    );
    setServer({ ...config, obo: { scopes: 'api://custom-api/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'initial',
      refresh_token: 'grant',
      expires_in: 3600,
      scope: 'Files.Read',
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const token = jwt.sign(
      {
        aud: '11111111-2222-3333-4444-555555555555',
        scp: 'Files.Read',
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      'test-only',
    );
    requestGrant.mockResolvedValueOnce({
      access_token: token,
      refresh_token: 'rotated',
      expires_in: 3600,
    });
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, scopes: 'api://custom-api/.default' },
    }))!;
    await expect(provider({ forceRefresh: true })).resolves.toMatchObject({ access_token: token });
    expect(tokenStore.getAll().find((r) => r.type === 'mcp_oauth_refresh')?.token).toBe(
      'enc:rotated',
    );
    expect(
      JSON.parse(
        tokenStore
          .getAll()
          .find((r) => r.type === 'mcp_oauth_client')!
          .token.slice(4),
      ).scheduled_obo_scope_binding,
    ).toEqual({ version: 1, resource: 'api://custom-api', permissions: ['Files.Read'] });
  });

  it('fails closed on legacy selector consent lacking a concrete binding without deleting its records', async () => {
    const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
    setProvider(
      'https://login.microsoftonline.com/tenant/v2.0',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    );
    setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'first',
      refresh_token: 'grant',
      expires_in: 3600,
      scope: 'Files.Read',
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const client = tokenStore.getAll().find((r) => r.type === 'mcp_oauth_client')!;
    const decoded = JSON.parse(client.token.slice(4));
    delete decoded.scheduled_obo_scope_binding;
    await tokenStore.updateToken(
      { userId: user.id, type: client.type, identifier: client.identifier },
      { token: `enc:${JSON.stringify(decoded)}` },
    );
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, scopes: 'api://resource/.default' },
    }))!;
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({
      reason: 'missing_upstream_provider',
      retryable: false,
    });
    expect(requestGrant).toHaveBeenCalledTimes(1);
    expect(tokenStore.getAll()).toHaveLength(3);
  });

  it('preserves newer selector consent when an obsolete renewal returns narrower effective permissions', async () => {
    const { service, row, requestGrant, tokenStore, setProvider, setServer } = harness();
    setProvider(
      'https://login.microsoftonline.com/tenant/v2.0',
      'https://login.microsoftonline.com/tenant/oauth2/v2.0/token',
    );
    setServer({ ...config, obo: { scopes: 'api://resource/.default' } });
    requestGrant.mockResolvedValueOnce({
      access_token: 'initial',
      refresh_token: 'initial-grant',
      expires_in: 3600,
      scope: 'Files.Read Files.Write',
    });
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, {
      context,
      target: { ...target, scopes: 'api://resource/.default' },
    }))!;
    requestGrant.mockImplementationOnce(async () => {
      requestGrant.mockResolvedValueOnce({
        access_token: 'new-consent',
        refresh_token: 'new-grant',
        expires_in: 3600,
        scope: 'Files.Read Files.List',
      });
      await service.enroll(user.id, row.id, 'Files', 'new-assertion');
      return {
        access_token: 'obsolete',
        refresh_token: 'obsolete-grant',
        expires_in: 3600,
        scope: 'Files.Read',
      };
    });
    await expect(provider({ forceRefresh: true })).rejects.toMatchObject({ retryable: true });
    await expect(provider()).resolves.toMatchObject({ access_token: 'new-consent' });
    expect(
      JSON.parse(
        tokenStore
          .getAll()
          .find((r) => r.type === 'mcp_oauth_client')!
          .token.slice(4),
      ).scheduled_obo_scope_binding.permissions,
    ).toEqual(['Files.List', 'Files.Read']);
  });

  it('renews a rejected scheduled downstream token without asking for browser-session renewal', async () => {
    const { service, row, requestGrant } = harness();
    await service.enroll(user.id, row.id, 'Files', 'assertion');
    row.enabled = true;
    const provider = (await service.resolve(user, { context, target }))!;
    const exchange = jest.fn();
    await expect(
      resolveOboToken(user, config.obo!, exchange, provider, undefined, true),
    ).resolves.toMatchObject({ access_token: 'fresh-after-12h' });
    expect(requestGrant.mock.calls.filter(([, kind]) => kind === 'refresh_token')).toHaveLength(1);
    expect(exchange).not.toHaveBeenCalled();
  });

  it('does not enroll a ClickHouse Cloud direct-OAuth MCP server as an OBO grant', async () => {
    const { service, setServer, requestGrant, tokenStore } = harness();
    setServer({
      type: 'streamable-http',
      url: 'https://mcp.clickhouse.cloud/mcp',
      source: 'yaml',
      requiresOAuth: true,
    });
    await expect(
      service.enroll(user.id, context.scheduleId, 'Files', 'assertion'),
    ).rejects.toMatchObject({ reason: 'missing_upstream_provider' });
    expect(requestGrant).not.toHaveBeenCalled();
    expect(tokenStore.getAll()).toEqual([]);
  });

  it('rejects an OBO server that did not issue an offline refresh token', async () => {
    const { service, requestGrant, tokenStore } = harness();
    requestGrant.mockResolvedValueOnce({ access_token: 'first', expires_in: 3600 });
    await expect(
      service.enroll(user.id, context.scheduleId, 'Files', 'assertion'),
    ).rejects.toBeInstanceOf(OboTokenResolutionError);
    expect(tokenStore.getAll()).toHaveLength(0);
  });
});
