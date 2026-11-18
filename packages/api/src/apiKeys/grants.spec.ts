import { Types } from 'mongoose';
import {
  Permissions,
  PermissionBits,
  PermissionTypes,
  AgentCapabilities,
} from 'librechat-data-provider';
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
  pinStorage,
  untouchedSince,
  admitsDefinitions,
} from '~/schedules/authorization/execution.helper';
import {
  getScheduleMCPExecution,
  bindScheduledMCPInvocation,
} from '~/schedules/authorization/execution';
import { createRemoteExecutionContext } from '~/agents/authority/context';
import { createAgentKeyMCPGrantHost, getRemoteRunKeyId } from './grants';
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
    confirmScheduleMCPConsent: async ({ identity, expectedRevision, enrollment, basis }) => {
      const stored = grants.get(identity.agentId);
      if (
        !found(identity) ||
        (stored?.revision ?? null) !== expectedRevision ||
        !untouchedSince(stored, basis)
      )
        return false;
      grants.set(identity.agentId, structuredClone(enrollment));
      return true;
    },
    revokeScheduleMCPConsent: async (identity) => {
      for (const consent of grants.get(identity.agentId)?.consents ?? [])
        consent.revokedAtMs = time;
      return true;
    },
    admitScheduleMCPConsent: async ({ identity, revision, consentId, definitions }) => {
      const grant = grants.get(identity.agentId);
      return (
        found(identity) &&
        grant?.revision === revision &&
        grant.consents.every((c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time) &&
        admitsDefinitions(grant, consentId, definitions)
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
  const findUser = jest.fn(async () => user);
  const getAppConfig = jest.fn(async () => config);
  const agentId = new Types.ObjectId();
  /** What the owner may do with the agent. View is what running it remotely needs. */
  const getEffectivePermissions = jest.fn(async () => PermissionBits.VIEW as number);
  /** The stored keys a background run can name: a personal one, and one issued to a channel. */
  const getKey = jest.fn(async (keyId: string) => {
    if (keyId === 'key-1') return {};
    return keyId === 'key-bound' ? { binding: { type: 'channel' } } : null;
  });
  const host = createAgentKeyMCPGrantHost({
    storage,
    findUser,
    getRoleByName,
    getAgent: async () => ({ _id: agentId }),
    getEffectivePermissions,
    getKey,
    enrollment: {
      getAppConfig,
      getModelsConfig: async () => ({ test: ['test'] }),
      getServers: async () => ({ warehouse: serverConfig }),
      getNodes: async (ids: string[]) =>
        ids.map((id) => ({ id, provider: 'test', model: 'test', tools, agent_ids: [] })),
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
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
  /**
   * A run of `agentId` started as the remote controllers start one. `keyId: null` is a run no
   * personal key started: a token, or a bound key. `worker` is a background run, whose
   * request was rebuilt from its admitted record and so carries no key of its own.
   */
  const run = async (agentId = 'agent_a', keyId: string | null = 'key-1', worker = false) => {
    const req = { user, ...(keyId && !worker && { apiKeyId: keyId }) } as ApiKeyAuthRequest;
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
    findUser,
    getAppConfig,
    getEffectivePermissions,
    getKey,
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

it('keeps the exemption of a key issued to an integration when its run is a background one', async () => {
  const s = setup();
  // The worker's request names the key through its admitted record, not what kind it is.
  await expect((await s.run('agent_a', 'key-bound', true)).call()).resolves.toBe('unrestricted');
  expect(s.getKey).toHaveBeenCalledWith('key-bound', 'owner');
  // A personal key stays under its grant in the background, and a key that is gone is refused.
  await expect((await s.run('agent_a', 'key-1', true)).call()).rejects.toMatchObject(
    refused('consent_missing'),
  );
  await expect(s.run('agent_a', 'key-deleted', true)).rejects.toMatchObject(
    refused('binding_mismatch'),
  );
  // A request that authenticated with the key already knows its kind: nothing is read.
  s.getKey.mockClear();
  await s.run();
  expect(s.getKey).not.toHaveBeenCalled();
});

it('asks whether the owner may run the agent, and refuses the grant and its use when they may not', async () => {
  const s = setup();
  await s.allow('agent_a', ['query']);
  const { call } = await s.run();
  await expect(call()).resolves.toBe('authorized');
  s.getEffectivePermissions.mockResolvedValue(0);
  await expect(call()).rejects.toMatchObject(refused('rbac_denied'));
  await expect(s.host.service.view(s.identity())).resolves.toMatchObject({ offer: null });
  await expect(s.allow('agent_a', ['query'])).rejects.toBeDefined();
});

it('reads the owner and their configuration once for each call it authorizes', async () => {
  const s = setup();
  await s.allow('agent_a', ['query']);
  const { call } = await s.run();
  s.findUser.mockClear();
  s.getAppConfig.mockClear();
  await expect(call()).resolves.toBe('authorized');
  expect(s.findUser).toHaveBeenCalledTimes(1);
  expect(s.getAppConfig).toHaveBeenCalledTimes(1);
  // Nothing is kept for the next call: a role or setting changed in between is seen.
  await expect(call()).resolves.toBe('authorized');
  expect(s.findUser).toHaveBeenCalledTimes(2);
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
