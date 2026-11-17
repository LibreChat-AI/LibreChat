import { AgentCapabilities, PermissionTypes, Permissions } from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  MCPConsentStorage,
  AppConfig,
  IRole,
  IUser,
} from '@librechat/data-schemas';
import type { AgentKeyMCPIdentity, MCPGrantEnrollment } from 'librechat-data-provider';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Response } from 'express';
import type { ApiKeyAuthRequest } from './middleware';
import type { ServerRequest } from '~/types';
import {
  getScheduleMCPExecution,
  bindScheduledMCPInvocation,
} from '~/schedules/authorization/execution';
import { createRemoteExecutionContext } from '~/agents/authority/context';
import { createAgentKeyMCPGrantHost, getRemoteRunKeyId } from './grants';
import { pinStorage } from '~/schedules/authorization/execution.helper';
import { getMCPRequestContext } from '~/mcp/request';

const queryTool: Tool = {
  name: 'query',
  description: 'Read a table',
  inputSchema: { type: 'object', properties: {} },
};
const serverConfig = { type: 'streamable-http' as const, url: 'https://resource.example/mcp' };
const resource = {
  url: serverConfig.url,
  credentialMode: 'anonymous',
  issuer: null,
  audience: null,
  scopes: [],
};

/** `null` stands for a config with no `integrations` key at all. */
function setup(
  integrations: Record<string, unknown> | null = {
    mode: 'delegated',
    resources: { warehouse: resource },
  },
) {
  const user = { id: 'owner', tenantId: 'tenant', role: 'USER' } as IUser;
  const config = {
    interfaceConfig: {},
    endpoints: {
      agents: {
        capabilities: [AgentCapabilities.tools],
        remoteApi: integrations ? { integrations } : {},
      },
    },
    mcpConfig: { warehouse: serverConfig },
  } as unknown as AppConfig;
  /** One key, `key-1`, with a grant per agent. Any other key is not found. */
  const grants = new Map<string, MCPGrantEnrollment<AgentKeyMCPIdentity>>();
  const found = (identity: AgentKeyMCPIdentity) =>
    identity.keyId === 'key-1' && identity.ownerId === 'owner' && identity.tenantId === 'tenant';
  let time = 1000;
  const storage: MCPConsentStorage<AgentKeyMCPIdentity> = {
    readScheduleMCPConsent: async (identity) =>
      found(identity)
        ? {
            agentId: identity.agentId,
            enabled: true,
            configRevision: 0,
            enrollment: structuredClone(grants.get(identity.agentId) ?? null),
          }
        : null,
    confirmScheduleMCPConsent: async ({ identity, expectedRevision, enrollment }) => {
      if (!found(identity) || (grants.get(identity.agentId)?.revision ?? null) !== expectedRevision)
        return false;
      grants.set(identity.agentId, structuredClone(enrollment));
      return true;
    },
    revokeScheduleMCPConsent: async (identity) => {
      for (const consent of grants.get(identity.agentId)?.consents ?? [])
        consent.revokedAtMs = time;
      return true;
    },
    admitScheduleMCPConsent: async ({ identity, revision }) => {
      const grant = grants.get(identity.agentId);
      return (
        found(identity) &&
        grant?.revision === revision &&
        grant.consents.every((c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time)
      );
    },
    pinScheduleMCPToolDefinition: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).pinScheduleMCPToolDefinition(input),
    flagScheduleMCPToolChange: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).flagScheduleMCPToolChange(input),
  };
  let tools = ['query_mcp_warehouse', 'list_mcp_warehouse'];
  const getRoleByName = jest.fn(
    async () =>
      ({
        permissions: {
          [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
          [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
        },
      }) as IRole,
  );
  // Before the host is built: the consent service keeps the clock it was created with.
  jest.spyOn(Date, 'now').mockImplementation(() => time);
  const host = createAgentKeyMCPGrantHost({
    storage,
    findUser: async () => user,
    getRoleByName,
    canUseAgent: async () => true,
    enrollment: {
      findUser: async () => user,
      getAppConfig: async () => config,
      getModelsConfig: async () => ({ test: ['test'] }),
      getServers: async () => ({ warehouse: serverConfig }),
      getNodes: async (ids: string[]) =>
        ids.map((id) => ({ id, provider: 'test', model: 'test', tools, agent_ids: [] })),
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
      canUseRoot: async () => true,
    },
  });
  const identity = (agentId = 'agent_a', keyId = 'key-1'): AgentKeyMCPIdentity => ({
    keyId,
    ownerId: 'owner',
    tenantId: 'tenant',
    agentId,
    invocationMode: 'delegated',
  });
  const allow = async (agentId: string, allowed: string[]) => {
    const view = await host.service.view(identity(agentId));
    return host.service.confirm(identity(agentId), {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow: { warehouse: allowed },
    });
  };
  /** A run of `agentId` started as the remote controllers start one. */
  /** `keyId: null` is a run no personal key started: a token, or a bound key. */
  const run = async (agentId = 'agent_a', keyId: string | null = 'key-1') => {
    const req = { user } as ApiKeyAuthRequest;
    await host.prepare({
      req,
      executionContext: createRemoteExecutionContext({
        principal: { userId: 'owner', tenantId: 'tenant', role: 'USER' },
        agentId,
        protocol: 'chat.completions',
        background: false,
        ...(keyId && { keyId }),
      }),
    });
    const context = getMCPRequestContext(req)!;
    const call = async (tool = 'query'): Promise<'unrestricted' | 'authorized'> => {
      const invocation = bindScheduledMCPInvocation(context, agentId, tool);
      if (!invocation) return 'unrestricted';
      await invocation.authorize({
        user,
        serverName: 'warehouse',
        serverConfig,
        toolName: tool,
        loadTools: async () => ({ tools: [{ ...queryTool, name: tool }], complete: true }),
      });
      return 'authorized';
    };
    return { context, call };
  };
  return {
    host,
    user,
    config,
    identity,
    allow,
    run,
    setTools: (value: string[]) => {
      tools = value;
    },
    expire: () => {
      time = 4_000_000;
    },
  };
}
afterEach(() => jest.restoreAllMocks());

const refused = (reason: string) => ({ failure: { reason, automaticReplay: false } });

it('leaves key runs as they were unless the operator asks for grants', async () => {
  for (const integrations of [null, {}, { mode: 'owner', resources: { warehouse: resource } }]) {
    const s = setup(integrations);
    await expect((await s.run()).call()).resolves.toBe('unrestricted');
    expect(await s.host.service.view(s.identity())).toMatchObject({
      state: 'unsupported',
      offer: null,
    });
  }
});

it('refuses every MCP tool of a key that holds no grant for the agent', async () => {
  const s = setup();
  const { call } = await s.run();
  await expect(call()).rejects.toMatchObject(refused('consent_missing'));
  await expect(call('list')).rejects.toMatchObject(refused('consent_missing'));
});

it('lets a key use the tools its owner allowed for that agent, and no others', async () => {
  const s = setup();
  expect(await s.allow('agent_a', ['query'])).toMatchObject({
    state: 'active',
    allowed: { warehouse: ['query'] },
  });
  const { call } = await s.run();
  await expect(call()).resolves.toBe('authorized');
  await expect(call('list')).rejects.toMatchObject(refused('tool_policy_denied'));
});

it('keeps a grant to the agent it was made for', async () => {
  const s = setup();
  await s.allow('agent_a', ['query']);
  await expect((await s.run('agent_b')).call()).rejects.toMatchObject(refused('consent_missing'));
  await s.allow('agent_b', ['list']);
  await expect((await s.run('agent_b')).call('list')).resolves.toBe('authorized');
  await expect((await s.run('agent_b')).call()).rejects.toMatchObject(
    refused('tool_policy_denied'),
  );
});

it('stops honouring a grant the owner revoked or that ran out', async () => {
  const s = setup();
  const granted = await s.allow('agent_a', ['query']);
  const first = await s.run();
  await expect(first.call()).resolves.toBe('authorized');
  s.expire();
  await expect(first.call()).rejects.toMatchObject(refused('consent_expired'));

  const again = setup();
  const view = await again.allow('agent_a', ['query']);
  expect(view.revision).not.toBe(granted.revision);
  await again.host.service.revoke(again.identity(), view.revision!);
  await expect((await again.run()).call()).rejects.toMatchObject(refused('consent_revoked'));
});

it('does not run unrestricted when the key or the agent cannot be established', async () => {
  const s = setup();
  await expect(s.run('agent_a', 'key-unknown')).rejects.toMatchObject(refused('binding_mismatch'));
  await expect(
    s.host.prepare({
      req: { user: s.user } as ApiKeyAuthRequest,
      executionContext: createRemoteExecutionContext({
        principal: { userId: 'owner', tenantId: 'tenant' },
        protocol: 'responses',
        background: false,
        keyId: 'key-1',
      }),
    }),
  ).rejects.toMatchObject(refused('binding_mismatch'));
});

it('does not restrict a run that no personal key started', async () => {
  const s = setup();
  await expect((await s.run('agent_a', null)).call()).resolves.toBe('unrestricted');
  const req = { user: s.user } as ApiKeyAuthRequest;
  await s.host.prepare({ req });
  expect(bindScheduledMCPInvocation(getMCPRequestContext(req), 'agent_a', 'query')).toBeUndefined();
});

it('limits only MCP tools: an agent with other tools can still be granted, and the run is not a schedule run', async () => {
  const s = setup();
  s.setTools(['query_mcp_warehouse', 'execute_code', 'web_search']);
  expect(await s.allow('agent_a', ['query'])).toMatchObject({ state: 'active' });
  const { context, call } = await s.run();
  await expect(call()).resolves.toBe('authorized');
  // No schedule policy hook is built for it, so the agent's other tools are untouched.
  expect(getScheduleMCPExecution(context)).toBeUndefined();
});

it('offers only servers the operator declared for key grants, and never an approval pause', async () => {
  const s = setup({ mode: 'delegated' });
  Object.assign(s.config.interfaceConfig as object, {
    schedules: { mcpConsent: { enabled: true, resources: { warehouse: resource } } },
  });
  expect(await s.host.service.view(s.identity())).toMatchObject({ state: 'unsupported' });

  const declared = setup();
  const view = await declared.host.service.view(declared.identity());
  expect(view).toMatchObject({ state: 'missing', approval: false });
  await expect(
    declared.host.service.confirm(declared.identity(), {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
      ask: { warehouse: ['query'] },
    }),
  ).rejects.toMatchObject({ code: 'consent_invalid' });
});

it('answers the owner over HTTP by key and agent, and hides keys that are not theirs', async () => {
  const s = setup();
  const send = async (id: string) => {
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await s.host.handlers.get(
      { user: s.user, params: { id, agentId: 'agent_a' } } as unknown as ServerRequest,
      res as unknown as Response,
    );
    return res;
  };
  expect((await send('key-1')).json).toHaveBeenCalledWith(
    expect.objectContaining({ state: 'missing' }),
  );
  const hidden = await send('key-of-someone-else');
  expect(hidden.status).toHaveBeenCalledWith(404);
  expect(hidden.json).toHaveBeenCalledWith({ code: 'consent_not_found' });
});

describe('getRemoteRunKeyId', () => {
  it('names the personal key a request authenticated with', () => {
    expect(getRemoteRunKeyId({ apiKeyId: 'key-1' } as ApiKeyAuthRequest)).toBe('key-1');
  });

  it('names no key for a token, or for a key issued to an integration', () => {
    expect(getRemoteRunKeyId({} as ApiKeyAuthRequest)).toBeUndefined();
    expect(
      getRemoteRunKeyId({ apiKeyId: 'key-1', apiKeyBound: true } as ApiKeyAuthRequest),
    ).toBeUndefined();
  });
});
