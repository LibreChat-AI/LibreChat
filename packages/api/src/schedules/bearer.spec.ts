import { Keyv } from 'keyv';
import { AgentCapabilities, Permissions, PermissionTypes } from 'librechat-data-provider';
import type {
  ScheduleMCPConsentStorage,
  ScheduleConsentSnapshot,
  IUser,
  IRole,
  AppConfig,
} from '@librechat/data-schemas';
import type { ScheduledMCPIdentity, ScheduledMCPTarget } from 'librechat-data-provider';
import type {
  ScheduledMCPBearerResult,
  ScheduledMCPResourceBearerResolver,
} from './authorization/contract';
import type { MCPOAuthTokens } from '~/mcp/oauth/types';
import type { ParsedServerConfig } from '~/mcp/types';
import {
  createScheduledMCPBearerHost,
  createScheduledMCPBearerHeaderResolver,
  createMCPPermissionDeniedError,
  attachScheduledMCPBearer,
  resolveScheduledMCPBearerConfig,
  prepareScheduledMCPBearer,
  bindScheduledMCPBearerInvocation,
  rejectScheduledMCPBearer,
} from './bearer';
import {
  createMCPRequestContext,
  cleanupMCPRequestContext,
  quiesceMCPRequestContext,
} from '~/mcp/request';
import { createScheduleMCPExecution, bindScheduledMCPInvocation } from './authorization/execution';
import { MockKeyv, createOAuthMCPServer } from '~/mcp/__tests__/helpers/oauthTestServer';
import { getScheduledMCPConfigurationRevision } from './authorization/configuration';
import { getScheduledMCPToolDefinitionDigest } from './authorization/policy';
import { createScheduleMCPConsentService } from './authorization/service';
import { MCPServersRegistry } from '~/mcp/registry/MCPServersRegistry';
import { MCPConnectionFactory } from '~/mcp/MCPConnectionFactory';
import { restoreScheduledTokenContext } from './context';
import { createScheduleMCPPreflight } from './mcp';
import { FlowStateManager } from '~/flow/manager';
import { MCPConnection } from '~/mcp/connection';
import { MCPManager } from '~/mcp/MCPManager';

const user = { id: 'owner', tenantId: 'tenant', role: 'USER' } as IUser;
const identity: ScheduledMCPIdentity = {
  scheduleId: 'schedule',
  ownerId: user.id,
  tenantId: 'tenant',
  agentId: 'root',
  invocationMode: 'delegated',
};
const config: ParsedServerConfig = {
  type: 'streamable-http',
  url: 'https://resource.test/mcp',
  source: 'yaml',
  headers: { Authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
};

async function bearerFixture(serverConfig = config) {
  let time = Date.now();
  let allowed = true;
  let policy = true;
  const target: ScheduledMCPTarget = {
    resource: {
      serverName: 'Files',
      url: serverConfig.url!,
      credentialMode: 'resource_bearer',
      issuer: 'https://issuer.test/',
      audience: 'files',
      scopes: ['read'],
      configurationRevision: '',
    },
    permittedTools: [
      { agentId: 'root', tools: ['echo'] },
      { agentId: 'child', tools: ['echo'] },
    ],
    policyRevision: 'read-only-policy',
  };
  target.resource.configurationRevision = getScheduledMCPConfigurationRevision(
    serverConfig,
    target.resource,
  );
  const snapshot: ScheduleConsentSnapshot = {
    agentId: 'root',
    enabled: true,
    configRevision: 0,
    enrollment: null,
  };
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: async () => structuredClone(snapshot),
    confirmScheduleMCPConsent: async (input) => {
      snapshot.enrollment = structuredClone(input.enrollment);
      return true;
    },
    revokeScheduleMCPConsent: async () => {
      for (const c of snapshot.enrollment?.consents ?? []) c.revokedAtMs = time;
      return true;
    },
    admitScheduleMCPConsent: async (input) =>
      (input.requireEnabled === false || snapshot.enabled) &&
      snapshot.configRevision === input.expectedConfigRevision &&
      snapshot.enrollment?.revision === input.revision &&
      snapshot.enrollment.consents.every(
        (c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time,
      ),
  };
  const resolveEnrollment = jest.fn(async () => [structuredClone(target)]);
  const consent = createScheduleMCPConsentService({
    storage,
    resolveEnrollment,
    now: () => time,
    canUse: async () => allowed,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 1 }),
    checkToolPolicy: async (request) =>
      policy && request.selection.tools.every((tool) => tool === 'echo'),
  });
  const offer = await consent.view(identity);
  await consent.confirm(identity, {
    expectedRevision: null,
    offerDigest: offer.offer!.digest,
    lifetimeHours: 1,
  });
  const resolveBearer = jest.fn(
    async (
      _request: Parameters<ScheduledMCPResourceBearerResolver>[0],
      _options: Parameters<ScheduledMCPResourceBearerResolver>[1],
    ): Promise<ScheduledMCPBearerResult> => ({
      state: 'ready',
      accessToken: 'resource-only',
      expiresAtMs: time + 60_000,
      issuer: target.resource.issuer!,
      audience: target.resource.audience!,
      resourceUrl: target.resource.url,
    }),
  );
  const host = createScheduledMCPBearerHost({
    authority: consent.authority,
    resolveEnrollment,
    resolveBearer,
    now: () => time,
  });
  const context = createMCPRequestContext();
  attachScheduledMCPBearer(context, identity, host);
  const input = { context, config: serverConfig, user, serverName: 'Files' };
  const call = (agentId = 'root', tools = ['echo']) =>
    resolveScheduledMCPBearerConfig({ ...input, selection: { agentId, tools } });
  return {
    host,
    context,
    input,
    call,
    consent,
    storage,
    resolveBearer,
    resolveEnrollment,
    snapshot,
    target,
    advance: (ms: number) => {
      time += ms;
    },
    deny: () => {
      allowed = false;
    },
    denyPolicy: () => {
      policy = false;
    },
    revoke: () => consent.revoke(identity, snapshot.enrollment!.revision),
  };
}

it('defaults unattended direct-bearer connections to denial without contacting a browser or provider', async () => {
  const context = createMCPRequestContext();
  attachScheduledMCPBearer(context, identity);
  await expect(
    resolveScheduledMCPBearerConfig({ context, config, user, serverName: 'Files' }),
  ).rejects.toMatchObject({ failure: { reason: 'provider_missing' } });
});

it('can probe activation and owner-manual use while disabled, but never automatic invocation', async () => {
  const f = await bearerFixture();
  f.snapshot.enabled = false;
  const activation = createMCPRequestContext();
  // Readiness uses activation to validate re-enable before the write enables the row.
  attachScheduledMCPBearer(activation, identity, f.host, 'activation');
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, context: activation }),
  ).resolves.toMatchObject({ headers: { Authorization: 'Bearer resource-only' } });
  expect(f.resolveBearer).toHaveBeenCalledWith(
    expect.objectContaining({ stage: 'activation' }),
    expect.anything(),
  );
  const manual = createMCPRequestContext();
  attachScheduledMCPBearer(manual, identity, f.host, 'invoke', undefined, { manual: true });
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, context: manual }),
  ).resolves.toBeDefined();
  expect(f.resolveBearer).toHaveBeenLastCalledWith(
    expect.objectContaining({ stage: 'mint', manual: true }),
    expect.anything(),
  );
  f.advance(60_001);
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, context: manual }),
  ).resolves.toBeDefined();
  await expect(f.call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  const execution = createScheduleMCPExecution({
    storage: f.storage,
    loadAuthorization: async () => ({ authority: f.consent.authority }),
  });
  for (const allowed of [true, false]) {
    const resumed = createMCPRequestContext();
    await execution.attach(resumed, identity, 'resume', true, { manual: allowed });
    prepareScheduledMCPBearer({
      req: { user, _isScheduledFire: true, body: { manual: !allowed, agent_id: 'untrusted' } },
      context: resumed,
      host: f.host,
    });
    const attempt = resolveScheduledMCPBearerConfig({ ...f.input, context: resumed });
    if (allowed) {
      await expect(attempt).resolves.toBeDefined();
      expect(f.resolveBearer).toHaveBeenLastCalledWith(
        expect.objectContaining({ manual: true, identity }),
        expect.anything(),
      );
    } else await expect(attempt).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  }
  await f.revoke();
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, context: manual }),
  ).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
});

it('checks authority on every cache hit while minting once for root, child and preflight use', async () => {
  const f = await bearerFixture();
  await expect(resolveScheduledMCPBearerConfig(f.input)).resolves.toMatchObject({
    headers: { Authorization: 'Bearer resource-only' },
  });
  await f.call('root');
  await f.call('child');
  expect(f.resolveBearer).toHaveBeenCalledTimes(1);
  f.deny();
  await expect(f.call()).rejects.toMatchObject({ failure: { reason: 'rbac_denied' } });
  expect(f.resolveBearer).toHaveBeenCalledTimes(1);
});
it('renews after synthetic expiry without a session, retaining no login refresh credentials', async () => {
  const f = await bearerFixture();
  await f.call();
  f.advance(60_001);
  await f.call();
  expect(f.resolveBearer).toHaveBeenCalledTimes(2);
  expect(f.resolveBearer.mock.calls[0]).toEqual([
    expect.objectContaining({ stage: 'mint', identity, resource: f.target.resource }),
    { signal: expect.any(AbortSignal) },
  ]);
});
it.each(['revoke', 'expiry', 'policy', 'root', 'revision', 'resource'] as const)(
  'rejects %s after credential admission',
  async (mutation) => {
    const f = await bearerFixture();
    await f.call();
    if (mutation === 'revoke') await f.revoke();
    if (mutation === 'expiry') f.advance(3600_001);
    if (mutation === 'policy') f.denyPolicy();
    if (mutation === 'root') f.snapshot.agentId = 'other';
    if (mutation === 'revision') f.snapshot.configRevision++;
    if (mutation === 'resource') f.target.resource.url = 'https://other.test/mcp';
    await expect(f.call()).rejects.toMatchObject({ failure: { automaticReplay: false } });
    expect(f.resolveBearer).toHaveBeenCalledTimes(1);
  },
);
it('denies changed runtime routing, unknown child, mutation, and cross-tenant user before minting', async () => {
  const f = await bearerFixture();
  await expect(f.call('unknown')).rejects.toMatchObject({
    failure: { reason: 'tool_policy_denied' },
  });
  await expect(f.call('root', ['write'])).rejects.toMatchObject({
    failure: { reason: 'tool_policy_denied' },
  });
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, user: { ...user, tenantId: 'other' } }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  await expect(
    resolveScheduledMCPBearerConfig({
      ...f.input,
      config: { ...config, url: 'https://other.test/mcp' },
    }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(f.resolveBearer).not.toHaveBeenCalled();
});
it('refuses tokens with changed issuer, audience, destination, expiry or header control bytes', async () => {
  for (const change of [
    { issuer: 'https://bad.test/' },
    { audience: 'other' },
    { resourceUrl: 'https://other.test/mcp' },
    { expiresAtMs: 0 },
    { accessToken: 'secret\r\nX-Evil: true' },
  ]) {
    const f = await bearerFixture();
    f.resolveBearer.mockResolvedValueOnce({
      state: 'ready',
      accessToken: 'resource-only',
      expiresAtMs: Date.now() + 60_000,
      issuer: f.target.resource.issuer!,
      audience: f.target.resource.audience!,
      resourceUrl: config.url!,
      ...change,
    });
    await expect(f.call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  }
});
it('does not deliver a credential after authority is withdrawn during provider resolution', async () => {
  const f = await bearerFixture();
  f.resolveBearer.mockImplementationOnce(async () => {
    await f.revoke();
    return {
      state: 'ready',
      accessToken: 'private',
      expiresAtMs: Date.now() + 60_000,
      issuer: f.target.resource.issuer!,
      audience: f.target.resource.audience!,
      resourceUrl: config.url!,
    };
  });
  await expect(f.call()).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
});
it('cancels a stalled adapter, does not disclose provider errors, and permits a later deliberate retry', async () => {
  const f = await bearerFixture();
  const controller = new AbortController();
  f.resolveBearer.mockImplementationOnce(() => new Promise(() => {}));
  const pending = resolveScheduledMCPBearerConfig({ ...f.input, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 15));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});
it('withholds provider completion when request cleanup closes the occurrence during minting', async () => {
  const f = await bearerFixture();
  f.resolveBearer.mockImplementationOnce(async () => {
    f.context.cleanupStarted = true;
    return {
      state: 'ready',
      accessToken: 'resource-only',
      expiresAtMs: Date.now() + 60_000,
      issuer: f.target.resource.issuer!,
      audience: f.target.resource.audience!,
      resourceUrl: config.url!,
    };
  });
  await expect(f.call()).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
});

it('does not let one cancelled waiter cancel shared minting for a sibling', async () => {
  const f = await bearerFixture();
  let resolve!: (result: ScheduledMCPBearerResult) => void;
  const grant = new Promise<ScheduledMCPBearerResult>((done) => {
    resolve = done;
  });
  f.resolveBearer.mockImplementationOnce(() => grant);
  const controller = new AbortController();
  const first = resolveScheduledMCPBearerConfig({ ...f.input, signal: controller.signal });
  const second = resolveScheduledMCPBearerConfig(f.input);
  await new Promise((done) => setTimeout(done, 15));
  controller.abort();
  await expect(first).rejects.toMatchObject({ name: 'AbortError' });
  resolve({
    state: 'ready',
    accessToken: 'resource-only',
    expiresAtMs: Date.now() + 60_000,
    issuer: f.target.resource.issuer!,
    audience: f.target.resource.audience!,
    resourceUrl: config.url!,
  });
  await expect(second).resolves.toMatchObject({
    headers: { Authorization: 'Bearer resource-only' },
  });
  expect(f.resolveBearer).toHaveBeenCalledTimes(1);
});

it('uses requestHeaders Authorization precedence without losing declared resource binding', async () => {
  const definition: ParsedServerConfig = {
    ...config,
    headers: { Authorization: 'Bearer obsolete-static' },
    requestHeaders: {
      authorization: 'Bearer {{LIBRECHAT_OPENID_ACCESS_TOKEN}}',
      'X-Route': 'effective-route',
    },
  };
  const f = await bearerFixture(definition);
  const resolved = await f.call();
  expect(resolved).toMatchObject({
    headers: { authorization: 'Bearer resource-only', 'X-Route': 'effective-route' },
  });
  expect('headers' in resolved ? resolved.headers?.Authorization : undefined).toBeUndefined();
  expect('requestHeaders' in resolved).toBe(false);
  expect(f.resolveBearer).toHaveBeenCalledTimes(1);
});

it('maps adapter outages to retryable safe errors without exposing credential/provider details', async () => {
  const f = await bearerFixture();
  f.resolveBearer.mockRejectedValueOnce(new Error('SECRET provider response'));
  const result = await f.call().catch((error: Error) => error);
  expect(result).toMatchObject({ retryable: true, failure: { reason: 'dependency_unavailable' } });
  expect(String(result)).not.toContain('SECRET');
  await f.call();
});
it('preserves static, stored OAuth, and OBO sibling credential ownership', async () => {
  const f = await bearerFixture();
  for (const sibling of [
    { type: 'streamable-http', url: config.url },
    { ...config, obo: { scopes: 'obo-read' } },
    { ...config, oauth: { client_id: 'direct' } },
  ]) {
    const result = await resolveScheduledMCPBearerConfig({
      ...f.input,
      config: sibling as ParsedServerConfig,
    });
    expect(result).toBe(sibling);
  }
  expect(f.resolveBearer).not.toHaveBeenCalled();
  await expect(resolveScheduledMCPBearerConfig({ ...f.input, context: undefined })).resolves.toBe(
    config,
  );
});
it('blocks token placeholders outside Authorization even on an accepted destination', async () => {
  const f = await bearerFixture();
  const changed = {
    ...config,
    headers: { ...config.headers, 'X-Leak': '{{LIBRECHAT_OPENID_ACCESS_TOKEN}}' },
  };
  await expect(
    resolveScheduledMCPBearerConfig({ ...f.input, config: changed }),
  ).rejects.toMatchObject({ failure: { reason: 'binding_mismatch' } });
  expect(f.resolveBearer).not.toHaveBeenCalled();
});
it('restores the enrolled root after restart, never serializing the resource bearer in job metadata', async () => {
  const f = await bearerFixture();
  const metadata = {
    userId: user.id,
    tenantId: user.tenantId,
    scheduleId: identity.scheduleId,
    agent_id: identity.agentId,
  };
  const restored = restoreScheduledTokenContext({ user }, metadata)!;
  const req = { user, _isScheduledFire: true, body: {} };
  const context = createMCPRequestContext();
  prepareScheduledMCPBearer({ req, restoredContext: restored, context, host: f.host });
  const invocation = bindScheduledMCPBearerInvocation(context, 'child', 'echo')!;
  await expect(invocation.resolve({ config, user, serverName: 'Files' })).resolves.toMatchObject({
    headers: { Authorization: 'Bearer resource-only' },
  });
  await f.revoke();
  await expect(invocation.resolve({ config, user, serverName: 'Files' })).rejects.toMatchObject({
    failure: { reason: 'consent_revoked' },
  });
  expect(JSON.stringify(metadata)).not.toContain('resource-only');
});
it('ignores forged ordinary scheduling payloads and keeps old incomplete resumes deny-only', async () => {
  prepareScheduledMCPBearer({ req: { user, body: { scheduleId: 'forged' } } });
  const context = createMCPRequestContext();
  prepareScheduledMCPBearer({ req: { user, _isScheduledFire: true, body: {} }, context });
  await expect(
    resolveScheduledMCPBearerConfig({ context, config, user, serverName: 'Files' }),
  ).rejects.toMatchObject({ failure: { reason: 'provider_missing' } });
  const sibling = { type: 'streamable-http' as const, url: config.url! };
  await expect(
    resolveScheduledMCPBearerConfig({ context, config: sibling, user, serverName: 'Static' }),
  ).resolves.toBe(sibling);
});
it.each(['credential_rejected', 'resource_permission_denied'] as const)(
  'retires %s for the occurrence without auto-minting or tool replay',
  async (reason) => {
    const f = await bearerFixture();
    await f.call();
    rejectScheduledMCPBearer(f.context, 'Files', reason);
    await expect(f.call()).rejects.toMatchObject({
      failure: { reason, automaticReplay: false },
    });
    expect(f.resolveBearer).toHaveBeenCalledTimes(1);
  },
);
it('uses the host adapter at scheduled preflight and preserves missing-adapter diagnosis', async () => {
  const f = await bearerFixture();
  const deps: Parameters<typeof createScheduleMCPPreflight>[0] = {
    scheduledBearerHost: f.host,
    getUser: async () => user,
    getRoleByName: async () =>
      ({ permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } } }) as IRole,
    resolveAgentGraphAccess: async () => ({}) as never,
    getAgentGraphNodes: async (ids) =>
      ids.map((id) => ({ id, provider: 'test', model: 'test', tools: ['echo_mcp_Files'] })),
    getModelsConfig: async () => ({ test: ['test'] }),
    getAppConfig: async () =>
      ({ endpoints: { agents: { capabilities: [AgentCapabilities.tools] } } }) as AppConfig,
    ensureConfigServers: async () => ({}),
    getServerConfigs: async () => ({ Files: config }),
    findPluginAuthsByKeys: async () => [],
    connect: async (options) => {
      await resolveScheduledMCPBearerConfig({
        user,
        serverName: options.serverName,
        config,
        context: options.requestScopedConnections,
      });
      return {
        fetchToolsSnapshot: async () => ({
          tools: [{ name: 'echo', inputSchema: { type: 'object' as const } }],
          complete: true,
        }),
      };
    },
  };
  await expect(
    createScheduleMCPPreflight(deps)('root', user, { scheduleId: 'schedule', concurrency: 2 }),
  ).resolves.toEqual([{ server: 'Files', status: 'ready' }]);
  await expect(
    createScheduleMCPPreflight({ ...deps, scheduledBearerHost: undefined })('root', user, {
      scheduleId: 'schedule',
      concurrency: 2,
    }),
  ).rejects.toMatchObject({ outcomes: [expect.objectContaining({ reason: 'provider_missing' })] });
});

describe('scheduled resource bearer with real MCP SDK and HTTP', () => {
  it.each(['consent_revoked', 'rbac_denied'] as const)(
    'preserves the original %s after real session setup and before required catalog reads',
    async (reason) => {
      let requests = 0;
      const server = await createOAuthMCPServer({
        onResourceRequest: (req) => {
          if (req.method !== 'DELETE') requests++;
        },
      });
      const definition: ParsedServerConfig = { ...config, url: server.url, requiresOAuth: false };
      const f = await bearerFixture(definition);
      server.issuedTokens.add('resource-only');
      server.tokenIssueTimes.set('resource-only', Date.now());
      const connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          ephemeralConnection: true,
          useSSRFProtection: false,
        },
        { user, requestScopedConnections: f.context },
      );
      try {
        await connection.fetchToolsSnapshot();
        if (reason === 'consent_revoked') await f.revoke();
        else f.deny();
        const before = requests;
        const read = connection.fetchOrderedToolsSnapshot();
        await expect(read).rejects.toMatchObject({
          failure: { reason },
          outcomes: [expect.objectContaining({ server: 'Files', reason, automaticReplay: false })],
        });
        await expect(connection.fetchTools()).rejects.toMatchObject({ failure: { reason } });
        await expect(connection.refreshToolList()).rejects.toMatchObject({ failure: { reason } });
        expect(requests).toBe(before);
        expect(f.resolveBearer).toHaveBeenCalledTimes(1);
      } finally {
        await connection.dispose();
        await cleanupMCPRequestContext(f.context);
        MCPConnection.clearCooldown('Files');
        await server.close();
      }
    },
  );

  it.each(['revoke', 'expiry', 'automatic'] as const)(
    'withholds automatic session reopening after %s without replay',
    async (change) => {
      let requests = 0;
      const server = await createOAuthMCPServer({
        onResourceRequest: (req) => {
          if (req.method !== 'DELETE') requests++;
        },
      });
      const definition: ParsedServerConfig = { ...config, url: server.url, requiresOAuth: false };
      const f = await bearerFixture(definition);
      server.issuedTokens.add('resource-only');
      server.tokenIssueTimes.set('resource-only', Date.now());
      const connection = await MCPConnectionFactory.create(
        {
          serverName: 'Files',
          serverConfig: definition,
          ephemeralConnection: true,
          useSSRFProtection: false,
        },
        { user, requestScopedConnections: f.context },
      );
      try {
        await connection.fetchToolsSnapshot();
        if (change !== 'expiry') await f.revoke();
        else f.advance(60 * 60_000 + 1);
        const before = requests;
        if (change === 'automatic') {
          const connect = jest.spyOn(connection, 'connect');
          await connection['handleReconnection']();
          expect(connect).toHaveBeenCalledTimes(1);
          await expect(connect.mock.results[0].value).rejects.toMatchObject({
            failure: { reason: 'consent_revoked' },
          });
          connect.mockRestore();
        } else
          await expect(connection.connect()).rejects.toMatchObject({
            failure: { reason: change === 'revoke' ? 'consent_revoked' : 'consent_expired' },
          });
        // Teardown DELETE is permitted; initialize and catalog requests are withheld.
        expect(requests).toBe(before);
        expect(f.resolveBearer).toHaveBeenCalledTimes(1);
      } finally {
        await connection.dispose();
        await cleanupMCPRequestContext(f.context);
        MCPConnection.clearCooldown('Files');
        await server.close();
      }
    },
  );

  it('runs headlessly across expiry, reconnect and restart without replaying rejected calls', async () => {
    const seen: string[] = [];
    let calls = 0;
    const server = await createOAuthMCPServer({
      onResourceRequest: (req) => {
        if (req.headers.authorization) seen.push(req.headers.authorization);
      },
      echoHandler: (message) => {
        calls++;
        return message;
      },
    });
    const definition: ParsedServerConfig = {
      ...config,
      url: server.url,
      requiresOAuth: false,
      initTimeout: 1000,
    };
    const f = await bearerFixture(definition);
    let counter = 0;
    f.resolveBearer.mockImplementation(async () => {
      const token = `resource-${++counter}`;
      server.issuedTokens.add(token);
      server.tokenIssueTimes.set(token, Date.now());
      return {
        state: 'ready',
        accessToken: token,
        expiresAtMs: Date.now() + 60_000,
        issuer: f.target.resource.issuer!,
        audience: f.target.resource.audience!,
        resourceUrl: server.url,
      };
    });
    const flowManager = new FlowStateManager<MCPOAuthTokens | null>(
      new MockKeyv() as unknown as Keyv,
      { ci: true, ttl: 30000 },
    );
    const manager = new MCPManager();
    const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: async () => false,
      resolveAllowlists: async () => ({
        allowedDomains: ['127.0.0.1'],
        allowedAddresses: [`127.0.0.1:${server.port}`],
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const contexts = [f.context];
    const input = {
      user,
      serverName: 'Files',
      serverConfig: definition,
      requestScopedConnections: f.context,
      flowManager,
    };
    const call = (toolName = 'echo', agent = 'root') =>
      manager.callTool({
        ...input,
        provider: 'openai',
        toolName,
        toolArguments: { message: 'headless' },
        scheduledBearerInvocation: bindScheduledMCPBearerInvocation(
          input.requestScopedConnections,
          agent,
          toolName,
        ),
      });
    try {
      const connected = await manager.getConnection(input);
      expect(input.requestScopedConnections.connections.size).toBe(1);
      expect(manager.getUserConnections(user.id)).toBeUndefined();
      expect((await connected.fetchToolsSnapshot()).tools.map((tool) => tool.name)).toContain(
        'echo',
      );
      await call();
      await call('echo', 'child');
      expect(calls).toBe(2);
      expect(counter).toBe(1);
      f.advance(120_001);
      f.resolveBearer.mockImplementation(async () => {
        const token = `resource-${++counter}`;
        server.issuedTokens.add(token);
        server.tokenIssueTimes.set(token, Date.now());
        return {
          state: 'ready',
          accessToken: token,
          expiresAtMs: Date.now() + 180_000,
          issuer: f.target.resource.issuer!,
          audience: f.target.resource.audience!,
          resourceUrl: server.url,
        };
      });
      await call();
      expect(counter).toBe(2);
      expect(calls).toBe(3);
      await connected.disconnect();
      await call();
      expect(counter).toBe(2);
      expect(calls).toBe(4);
      await expect(call('write')).rejects.toMatchObject({
        failure: { reason: 'tool_policy_denied' },
      });
      expect(calls).toBe(4);
      server.issuedTokens.clear();
      await expect(call()).rejects.toMatchObject({
        failure: { reason: 'credential_rejected', automaticReplay: false },
      });
      expect(counter).toBe(2);
      expect(calls).toBe(4);
      await expect(call()).rejects.toMatchObject({ failure: { reason: 'credential_rejected' } });
      expect(counter).toBe(2);
      const resumed = createMCPRequestContext();
      contexts.push(resumed);
      prepareScheduledMCPBearer({
        req: { user, _isScheduledFire: true, body: {} },
        context: resumed,
        host: f.host,
        restoredContext: restoreScheduledTokenContext(
          { user },
          {
            userId: user.id,
            tenantId: user.tenantId,
            scheduleId: identity.scheduleId,
            agent_id: 'root',
          },
        ),
      });
      input.requestScopedConnections = resumed;
      await call('echo', 'child');
      expect(counter).toBe(3);
      expect(calls).toBe(5);
      await f.revoke();
      await expect(call()).rejects.toMatchObject({ failure: { reason: 'consent_revoked' } });
      expect(calls).toBe(5);
      expect(server.tokenRequests).toEqual([]);
      expect(seen.some((header) => header.includes('resource-'))).toBe(true);
    } finally {
      await Promise.all(contexts.map((context) => cleanupMCPRequestContext(context)));
      registry.mockRestore();
      MCPConnection.clearCooldown('Files');
      await server.close();
    }
  });
  it.each([false, true])(
    'isolates cold and restored scheduled checkout from a warm browser pool, requestHeaders=%s',
    async (requestHeaders) => {
      const observed: string[] = [];
      const server = await createOAuthMCPServer({
        onResourceRequest: (req) => {
          if (req.headers.authorization) observed.push(req.headers.authorization);
        },
      });
      const definition: ParsedServerConfig = {
        ...config,
        url: server.url,
        requiresOAuth: false,
        ...(requestHeaders ? { headers: {}, requestHeaders: config.headers } : {}),
      };
      const f = await bearerFixture(definition);
      for (const token of ['browser-only', 'resource-only']) {
        server.issuedTokens.add(token);
        server.tokenIssueTimes.set(token, Date.now());
      }
      const manager = new MCPManager();
      const upstreamTokenProvider = jest.fn(async () => ({ access_token: 'browser-only' }));
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
        }),
      } as unknown as MCPServersRegistry);
      const restored = createMCPRequestContext();
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(
        new MockKeyv() as unknown as Keyv,
        { ci: true, ttl: 30000 },
      );
      try {
        const browser = await manager.getConnection({
          user,
          serverName: 'Files',
          serverConfig: definition,
          upstreamTokenProvider,
        });
        expect(manager.getUserConnections(user.id)?.get('Files')).toBe(browser);
        upstreamTokenProvider.mockClear();
        prepareScheduledMCPBearer({
          req: { user, _isScheduledFire: true, body: {} },
          context: restored,
          host: f.host,
          restoredContext: restoreScheduledTokenContext(
            { user },
            {
              userId: user.id,
              tenantId: user.tenantId,
              scheduleId: identity.scheduleId,
              agent_id: 'root',
            },
          ),
        });
        observed.length = 0;
        const connections: MCPConnection[] = [];
        for (const context of [f.context, restored]) {
          await manager.callTool({
            user,
            serverName: 'Files',
            serverConfig: definition,
            provider: 'openai',
            toolName: 'echo',
            toolArguments: { message: 'scoped' },
            flowManager,
            requestScopedConnections: context,
            upstreamTokenProvider,
            scheduledBearerInvocation: bindScheduledMCPBearerInvocation(context, 'child', 'echo'),
          });
          expect(context.connections.size).toBe(1);
          const connection = [...context.connections.values()][0] as MCPConnection;
          expect(connection).not.toBe(browser);
          connections.push(connection);
        }
        expect(connections[0]).not.toBe(connections[1]);
        expect(upstreamTokenProvider).not.toHaveBeenCalled();
        expect(f.resolveBearer).toHaveBeenCalledTimes(2);
        expect(observed.length).toBeGreaterThan(0);
        expect(observed.every((header) => header === 'Bearer resource-only')).toBe(true);
        expect(manager.getUserConnections(user.id)?.get('Files')).toBe(browser);
        await cleanupMCPRequestContext(f.context);
        expect(restored.connections.size).toBe(1);
        expect(await browser.isConnected()).toBe(true);
      } finally {
        await cleanupMCPRequestContext(f.context);
        await cleanupMCPRequestContext(restored);
        await manager.disconnectUserConnections(user.id);
        registry.mockRestore();
        MCPConnection.clearCooldown('Files');
        await server.close();
      }
    },
  );

  it.each(['invoke', 'resume'] as const)(
    'enforces the merged A3 ceiling with a B2 bearer at %s',
    async (stage) => {
      let calls = 0;
      const server = await createOAuthMCPServer({
        echoHandler: (message) => {
          calls++;
          return message;
        },
      });
      const definition: ParsedServerConfig = { ...config, url: server.url, requiresOAuth: false };
      const f = await bearerFixture(definition);
      server.issuedTokens.add('resource-only');
      server.tokenIssueTimes.set('resource-only', Date.now());
      const manager = new MCPManager();
      const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
        isAppServerConfig: async () => false,
        resolveAllowlists: async () => ({
          allowedDomains: ['127.0.0.1'],
          allowedAddresses: [`127.0.0.1:${server.port}`],
          useSSRFProtection: false,
        }),
      } as unknown as MCPServersRegistry);
      const flowManager = new FlowStateManager<MCPOAuthTokens | null>(
        new MockKeyv() as unknown as Keyv,
        { ci: true, ttl: 30000 },
      );
      try {
        const input = {
          user,
          serverName: 'Files',
          serverConfig: definition,
          requestScopedConnections: f.context,
          flowManager,
        };
        const connected = await manager.getConnection(input);
        const catalog = await connected.fetchToolsSnapshot();
        const echo = catalog.tools.find((tool) => tool.name === 'echo')!;
        let digest = getScheduledMCPToolDefinitionDigest(echo);
        const execution = createScheduleMCPExecution({
          storage: f.storage,
          loadAuthorization: async () => ({
            authority: f.consent.authority,
            policy: {
              Files: { tools: { echo: { effect: 'read_only', definitionSha256: digest } } },
            },
          }),
        });
        await execution.attach(f.context, identity, stage, true);
        const call = () =>
          manager.callTool({
            ...input,
            provider: 'openai',
            toolName: 'echo',
            toolArguments: { message: 'guarded' },
            scheduledBearerInvocation: bindScheduledMCPBearerInvocation(f.context, 'child', 'echo'),
            scheduledMCPInvocation: bindScheduledMCPInvocation(f.context, 'child', 'echo'),
          });
        await call();
        expect(calls).toBe(1);
        digest = '0'.repeat(64);
        await expect(call()).rejects.toMatchObject({ failure: { reason: 'tool_policy_denied' } });
        expect(calls).toBe(1);
        expect(server.tokenRequests).toEqual([]);
        expect(manager.getUserConnections(user.id)).toBeUndefined();
      } finally {
        registry.mockRestore();
        await cleanupMCPRequestContext(f.context);
        MCPConnection.clearCooldown('Files');
        await server.close();
      }
    },
  );

  it('retains effective request headers on an unrelated scheduled static sibling', async () => {
    const observed: Array<string | undefined> = [];
    const server = await createOAuthMCPServer({
      onResourceRequest: (req) => observed.push(req.headers['x-route'] as string | undefined),
    });
    server.issuedTokens.add('static-key');
    server.tokenIssueTimes.set('static-key', Date.now());
    const context = createMCPRequestContext();
    attachScheduledMCPBearer(context, identity);
    let connection: MCPConnection | undefined;
    try {
      connection = await MCPConnectionFactory.create(
        {
          serverName: 'Static',
          useSSRFProtection: false,
          serverConfig: {
            type: 'streamable-http',
            url: server.url,
            headers: { Authorization: 'Bearer static-key' },
            requestHeaders: { 'X-Route': 'sibling-route' },
            requiresOAuth: false,
          },
        },
        { user, requestScopedConnections: context },
      );
      await connection.fetchToolsSnapshot();
      expect(observed.filter(Boolean)).toEqual(expect.arrayContaining(['sibling-route']));
      expect(observed.every((value) => value === 'sibling-route')).toBe(true);
    } finally {
      await connection?.dispose();
      await cleanupMCPRequestContext(context);
      await server.close();
    }
  });

  it('changes only Authorization at invocation, preserving expanded routing headers', async () => {
    process.env.B2_ROUTE = 'resolved-route';
    const observed: Array<string | undefined> = [];
    const server = await createOAuthMCPServer({
      onResourceRequest: (req) => observed.push(req.headers['x-route'] as string | undefined),
    });
    const definition: ParsedServerConfig = {
      ...config,
      url: server.url,
      requiresOAuth: false,
      headers: { ...config.headers, 'X-Route': '${B2_ROUTE}' },
    };
    const f = await bearerFixture(definition);
    server.issuedTokens.add('resource-only');
    server.tokenIssueTimes.set('resource-only', Date.now());
    const manager = new MCPManager();
    const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: async () => false,
      resolveAllowlists: async () => ({
        allowedDomains: ['127.0.0.1'],
        allowedAddresses: [`127.0.0.1:${server.port}`],
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    try {
      await manager.callTool({
        user,
        serverName: 'Files',
        serverConfig: definition,
        provider: 'openai',
        toolName: 'echo',
        toolArguments: { message: 'routing' },
        requestScopedConnections: f.context,
        scheduledBearerInvocation: bindScheduledMCPBearerInvocation(f.context, 'root', 'echo'),
        flowManager: new FlowStateManager<MCPOAuthTokens | null>(
          new MockKeyv() as unknown as Keyv,
          { ttl: 30000, ci: true },
        ),
      });
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((route) => route === 'resolved-route')).toBe(true);
    } finally {
      registry.mockRestore();
      await cleanupMCPRequestContext(f.context);
      MCPConnection.clearCooldown('Files');
      await server.close();
      delete process.env.B2_ROUTE;
    }
  });

  it('preflights a real protected resource without browser auth and preserves bearer rejection', async () => {
    const server = await createOAuthMCPServer();
    const definition: ParsedServerConfig = {
      ...config,
      url: server.url,
      requiresOAuth: false,
      initTimeout: 1000,
    };
    const f = await bearerFixture(definition);
    server.issuedTokens.add('resource-only');
    server.tokenIssueTimes.set('resource-only', Date.now());
    const manager = new MCPManager();
    const registry = jest.spyOn(MCPServersRegistry, 'getInstance').mockReturnValue({
      isAppServerConfig: async () => false,
      resolveAllowlists: async () => ({
        allowedDomains: ['127.0.0.1'],
        allowedAddresses: [`127.0.0.1:${server.port}`],
        useSSRFProtection: false,
      }),
    } as unknown as MCPServersRegistry);
    const flowManager = new FlowStateManager<MCPOAuthTokens | null>(
      new MockKeyv() as unknown as Keyv,
      { ttl: 30000, ci: true },
    );
    const deps: Parameters<typeof createScheduleMCPPreflight>[0] = {
      scheduledBearerHost: f.host,
      getUser: async () => user,
      getRoleByName: async () =>
        ({ permissions: { [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true } } }) as IRole,
      resolveAgentGraphAccess: async () => ({}) as never,
      getAgentGraphNodes: async (ids) =>
        ids.map((id) => ({ id, provider: 'test', model: 'test', tools: ['echo_mcp_Files'] })),
      getModelsConfig: async () => ({ test: ['test'] }),
      getAppConfig: async () =>
        ({ endpoints: { agents: { capabilities: [AgentCapabilities.tools] } } }) as AppConfig,
      ensureConfigServers: async () => ({}),
      getServerConfigs: async () => ({ Files: definition }),
      findPluginAuthsByKeys: async () => [],
      connect: (options) => manager.getConnection({ ...options, flowManager }),
    };
    try {
      const preflight = createScheduleMCPPreflight(deps);
      await expect(
        preflight('root', user, { scheduleId: 'schedule', concurrency: 2 }),
      ).resolves.toEqual([{ server: 'Files', status: 'ready' }]);
      f.snapshot.enabled = false;
      for (const admission of [{ stage: 'activation' as const }, { manual: true }]) {
        await expect(
          preflight('root', user, { scheduleId: 'schedule', concurrency: 2, ...admission }),
        ).resolves.toEqual([{ server: 'Files', status: 'ready' }]);
      }
      await expect(
        preflight('root', user, { scheduleId: 'schedule', concurrency: 2 }),
      ).rejects.toMatchObject({
        outcomes: [expect.objectContaining({ reason: 'binding_mismatch' })],
      });
      f.snapshot.enabled = true;
      server.issuedTokens.clear();
      await expect(
        preflight('root', user, { scheduleId: 'schedule', concurrency: 2 }),
      ).rejects.toMatchObject({
        outcomes: [expect.objectContaining({ reason: 'credential_rejected' })],
      });
      expect(server.tokenRequests).toEqual([]);
    } finally {
      registry.mockRestore();
      MCPConnection.clearCooldown('Files');
      await server.close();
    }
  });

  it('denies the absent host before SDK setup can reuse browser credentials', async () => {
    let observed = 0;
    const server = await createOAuthMCPServer({
      onResourceRequest: () => {
        observed++;
      },
    });
    const context = createMCPRequestContext();
    attachScheduledMCPBearer(context, identity);
    const session = jest.fn(async () => ({ access_token: 'browser-login' }));
    try {
      await expect(
        MCPConnectionFactory.create(
          {
            serverName: 'Files',
            serverConfig: { ...config, url: server.url },
            useSSRFProtection: false,
          },
          { user, requestScopedConnections: context, upstreamTokenProvider: session },
        ),
      ).rejects.toMatchObject({ failure: { reason: 'provider_missing' } });
      expect(session).not.toHaveBeenCalled();
      expect(observed).toBe(0);
    } finally {
      await cleanupMCPRequestContext(context);
      await server.close();
    }
  });
});

it('classifies a pre-transport RBAC denial without altering ordinary permission errors', async () => {
  const f = await bearerFixture();
  const invocation = bindScheduledMCPBearerInvocation(f.context, 'child', 'echo');
  expect(createMCPPermissionDeniedError(invocation, 'Files', config)).toMatchObject({
    failure: { reason: 'rbac_denied' },
  });
  expect(createMCPPermissionDeniedError(undefined, 'Files', config).message).toBe(
    'Forbidden: Insufficient MCP server permissions',
  );
});

it('cancels the occurrence-owned mint without aborting another occurrence or accepting late credentials', async () => {
  const f = await bearerFixture();
  const other = await bearerFixture();
  let deliver!: (value: ScheduledMCPBearerResult) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = new Promise<ScheduledMCPBearerResult>((resolve) => {
    deliver = resolve;
  });
  let mintSignal: AbortSignal | undefined;
  const token: ScheduledMCPBearerResult = {
    state: 'ready',
    accessToken: 'late-only',
    expiresAtMs: Date.now() + 60_000,
    issuer: f.target.resource.issuer!,
    audience: f.target.resource.audience!,
    resourceUrl: f.target.resource.url,
  };
  f.resolveBearer.mockImplementationOnce(async (_request, options) => {
    mintSignal = options.signal;
    entered();
    return provider;
  });
  const first = f.call().catch((error) => error);
  const sibling = f.call('child').catch((error) => error);
  try {
    await started;
    await quiesceMCPRequestContext(f.context);
    const abortedBeforeRelease = mintSignal?.aborted;
    const early = await Promise.race([
      Promise.all([first, sibling]),
      new Promise<string>((resolve) => setTimeout(() => resolve('still waiting'), 100)),
    ]);
    deliver(token);
    const outcomes = await Promise.all([first, sibling]);
    expect(abortedBeforeRelease).toBe(true);
    expect(early).not.toBe('still waiting');
    for (const error of outcomes) expect(error).toMatchObject({ name: 'AbortError' });
    await expect(other.call()).resolves.toMatchObject({
      headers: expect.objectContaining({ Authorization: 'Bearer resource-only' }),
    });
    await expect(f.call()).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.resolveBearer).toHaveBeenCalledTimes(1);
  } finally {
    deliver(token);
    await Promise.all([first, sibling]);
    await cleanupMCPRequestContext(f.context);
    await cleanupMCPRequestContext(other.context);
  }
});

it('detaches stalled enrollment at the occurrence cutoff and withholds its late result', async () => {
  const f = await bearerFixture();
  let entered!: () => void, release!: (value: ScheduledMCPTarget[]) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const enrollment = new Promise<ScheduledMCPTarget[]>((resolve) => {
    release = resolve;
  });
  f.resolveEnrollment.mockImplementationOnce(async () => {
    entered();
    return enrollment;
  });
  const result = f.call().catch((error) => error);
  try {
    await started;
    await quiesceMCPRequestContext(f.context);
    await expect(result).resolves.toMatchObject({ name: 'AbortError' });
    release([f.target]);
    expect(f.resolveBearer).not.toHaveBeenCalled();
  } finally {
    release([f.target]);
    await result;
    await cleanupMCPRequestContext(f.context);
  }
});

it('disposes a connection credential waiter without cancelling its sibling shared mint', async () => {
  const server = await createOAuthMCPServer();
  const definition: ParsedServerConfig = { ...config, url: server.url, requiresOAuth: false };
  const f = await bearerFixture(definition);
  let release!: (token: ScheduledMCPBearerResult) => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const mint = new Promise<ScheduledMCPBearerResult>((resolve) => {
    release = resolve;
  });
  let mintSignal: AbortSignal | undefined;
  f.resolveBearer.mockImplementationOnce(async (_input, options) => {
    mintSignal = options.signal;
    entered();
    return mint;
  });
  const headers = createScheduledMCPBearerHeaderResolver({ ...f.input, config: definition });
  const first = new MCPConnection({
    serverName: 'Files',
    serverConfig: { ...definition, initTimeout: 30 },
    resolveRequestHeaders: headers,
  });
  const second = new MCPConnection({
    serverName: 'Files',
    serverConfig: { ...definition, initTimeout: 2000 },
    resolveRequestHeaders: headers,
  });
  const close = jest.spyOn(first.client, 'close');
  server.issuedTokens.add('resource-only');
  server.tokenIssueTimes.set('resource-only', Date.now());
  const token: ScheduledMCPBearerResult = {
    state: 'ready',
    accessToken: 'resource-only',
    expiresAtMs: Date.now() + 60_000,
    issuer: f.target.resource.issuer!,
    audience: f.target.resource.audience!,
    resourceUrl: server.url,
  };
  const failed = first.connectClient().catch(async (error) => {
    await first.dispose();
    return error;
  });
  let sibling: Promise<void> | undefined;
  try {
    await started;
    sibling = second.connectClient();
    await expect(failed).resolves.toMatchObject({ message: expect.stringContaining('timeout') });
    expect(close).toHaveBeenCalled();
    expect(mintSignal?.aborted).toBe(false);
    expect(f.context.cleanupStarted).toBe(false);
    release(token);
    await sibling;
    await expect(second.fetchToolsSnapshot()).resolves.toMatchObject({ complete: true });
    expect(f.resolveBearer).toHaveBeenCalledTimes(1);
    await expect(first.client.listTools()).rejects.toThrow();
  } finally {
    release(token);
    await failed;
    await sibling?.catch(() => undefined);
    await first.dispose();
    await second.dispose();
    await cleanupMCPRequestContext(f.context);
    MCPConnection.clearCooldown('Files');
    await server.close();
  }
}, 10_000);
