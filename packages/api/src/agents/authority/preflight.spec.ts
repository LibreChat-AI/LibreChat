import { Types } from 'mongoose';
import {
  Permissions,
  PermissionBits,
  PermissionTypes,
  AgentCapabilities,
} from 'librechat-data-provider';
import type {
  AgentGraphAccessContext,
  RunGrantStorage,
  AppConfig,
  IRole,
  IUser,
} from '@librechat/data-schemas';
import type { AgentKeyMCPIdentity, RunGrant } from 'librechat-data-provider';
import type { PreflightCredentials, PreflightDeps } from './preflight';
import { pinStorage, untouchedSince, admitsDefinitions } from './execution.helper';
import { createAgentKeyMCPGrantHost } from '~/apiKeys/grants';
import { createPreflight, PreflightError } from './preflight';

const warehouse = { type: 'streamable-http' as const, url: 'https://resource.example/mcp' };
const docs = { type: 'streamable-http' as const, url: 'https://docs.example/mcp' };
const user = { id: 'owner', tenantId: 'tenant', role: 'USER' } as IUser;
const principal = { id: 'owner', tenantId: 'tenant' };
const identity: AgentKeyMCPIdentity = {
  keyId: 'key-1',
  ownerId: 'owner',
  tenantId: 'tenant',
  agentId: 'agent_a',
  invocationMode: 'delegated',
};

/**
 * An agent that selects a tool on each of two servers, and a personal API key whose owner
 * granted it the warehouse tool only. No schedule exists: the grant is the key's, read by
 * the key's own host.
 */
async function setup(credentials?: PreflightCredentials<AgentKeyMCPIdentity>) {
  const config = {
    interfaceConfig: {},
    endpoints: {
      agents: {
        capabilities: [AgentCapabilities.tools],
        remoteApi: {
          integrations: {
            mode: 'delegated',
            resources: {
              warehouse: {
                url: warehouse.url,
                credentialMode: 'anonymous',
                issuer: null,
                audience: null,
                scopes: [],
              },
            },
          },
        },
      },
    },
    mcpConfig: { warehouse, docs },
  } as unknown as AppConfig;
  const grants = new Map<string, RunGrant<AgentKeyMCPIdentity>>();
  const found = (subject: AgentKeyMCPIdentity) =>
    subject.keyId === 'key-1' && subject.ownerId === 'owner' && subject.tenantId === 'tenant';
  const state = { down: false };
  const storage: RunGrantStorage<AgentKeyMCPIdentity> = {
    readRunGrant: async (subject) => {
      if (state.down) throw new Error('database unavailable');
      return found(subject)
        ? {
            agentId: subject.agentId,
            enabled: true,
            configRevision: 0,
            enrollment: structuredClone(grants.get(subject.agentId) ?? null),
          }
        : null;
    },
    confirmRunGrant: async ({ identity: subject, expectedRevision, enrollment, basis }) => {
      const stored = grants.get(subject.agentId);
      if (
        !found(subject) ||
        (stored?.revision ?? null) !== expectedRevision ||
        !untouchedSince(stored, basis)
      )
        return false;
      grants.set(subject.agentId, structuredClone(enrollment));
      return true;
    },
    revokeRunGrant: async () => true,
    admitRunGrant: async ({ identity: subject, revision, consentId, definitions }) => {
      const grant = grants.get(subject.agentId);
      return (
        found(subject) &&
        grant?.revision === revision &&
        admitsDefinitions(grant, consentId, definitions)
      );
    },
    pinRunGrantTool: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).pinRunGrantTool(input),
    flagRunGrantTool: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).flagRunGrantTool(input),
  };
  const getRoleByName = async () =>
    ({
      permissions: {
        [PermissionTypes.REMOTE_AGENTS]: { [Permissions.USE]: true },
        [PermissionTypes.MCP_SERVERS]: { [Permissions.USE]: true },
      },
    }) as IRole;
  const nodes = async (ids: string[]) =>
    ids.map((id) => ({
      id,
      provider: 'test',
      model: 'test',
      tools: ['query_mcp_warehouse', 'search_mcp_docs'],
      agent_ids: [],
    }));
  const agentId = new Types.ObjectId();
  const host = createAgentKeyMCPGrantHost({
    storage,
    findUser: async () => user,
    getRoleByName,
    getAgent: async () => ({ _id: agentId }),
    getEffectivePermissions: async () => PermissionBits.VIEW as number,
    getKey: async (keyId) => (keyId === 'key-1' ? {} : null),
    enrollment: {
      getAppConfig: async () => config,
      getModelsConfig: async () => ({ test: ['test'] }),
      ensureConfigServers: async () => ({}),
      getServers: async () => ({ warehouse }),
      getNodes: nodes,
      resolveGraphAccess: async () => ({}) as AgentGraphAccessContext,
    },
  });
  const view = await host.service.view(identity);
  await host.service.confirm(identity, {
    offerDigest: view.offer!.digest,
    expectedRevision: view.revision,
    lifetimeHours: 1,
    allow: { warehouse: ['query'] },
  });
  const ready = new Set(['warehouse', 'docs']);
  /** Servers that answer, but only after asking the owner to sign in again. */
  const expired = new Set<string>();
  const deps: PreflightDeps<AgentKeyMCPIdentity> = {
    resolveAgentGraphAccess: async () => ({}) as AgentGraphAccessContext,
    getAgentGraphNodes: nodes,
    getModelsConfig: async () => ({ test: ['test'] }),
    getRoleByName,
    getUser: async () => ({ ...user }) as IUser,
    getAppConfig: async () => config,
    ensureConfigServers: async () => ({}),
    getServerConfigs: async () => ({ warehouse, docs }),
    findPluginAuthsByKeys: async () => [],
    execution: host.execution,
    connect: jest.fn(async ({ serverName, oauthStart }) => {
      if (!ready.has(serverName)) throw new Error('connection refused');
      if (expired.has(serverName)) await oauthStart?.('https://resource.example/authorize');
      return {
        fetchToolsSnapshot: async () => ({
          tools: [
            {
              name: serverName === 'warehouse' ? 'query' : 'search',
              description: 'Read',
              inputSchema: { type: 'object' as const, properties: {} },
            },
          ],
          complete: true,
        }),
      };
    }),
  };
  const preflight = createPreflight<AgentKeyMCPIdentity>(deps, credentials);
  const probed = () =>
    (deps.connect as jest.Mock).mock.calls.map(([options]) => options.serverName).sort();
  return { preflight, probed, ready, expired, state };
}

it("checks the servers an API key's grant allows, with no schedule to name", async () => {
  const { preflight, probed } = await setup();
  await expect(preflight('agent_a', principal, { identity, concurrency: 2 })).resolves.toEqual([
    { server: 'warehouse', status: 'ready' },
  ]);
  // The key's owner left the docs tool out, so the run is not held back for that server.
  expect(probed()).toEqual(['warehouse']);
});

it('checks every server the agents select when no subject is named', async () => {
  const { preflight, probed } = await setup();
  await expect(preflight('agent_a', principal, { concurrency: 2 })).resolves.toEqual([
    { server: 'warehouse', status: 'ready' },
    { server: 'docs', status: 'ready' },
  ]);
  expect(probed()).toEqual(['docs', 'warehouse']);
});

it("names the server a key's run needs that is not ready", async () => {
  const { preflight, ready } = await setup();
  ready.delete('warehouse');
  const failure = await preflight('agent_a', principal, { identity, concurrency: 2 }).catch(
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(PreflightError);
  expect((failure as PreflightError).code).toBe('mcp_unavailable');
  expect((failure as PreflightError).outcomes).toEqual([
    { server: 'warehouse', status: 'mcp_unavailable' },
  ]);
});

it('names a server that answers only after asking for a new sign-in', async () => {
  const { preflight, expired } = await setup();
  expired.add('warehouse');
  await expect(preflight('agent_a', principal, { identity, concurrency: 2 })).rejects.toMatchObject(
    {
      code: 'mcp_reauth_required',
      outcomes: [{ server: 'warehouse', status: 'mcp_reauth_required' }],
    },
  );
});

it('does not report a grant it could not read as a server that is not ready', async () => {
  const { preflight, probed, state } = await setup();
  state.down = true;
  const failure = await preflight('agent_a', principal, { identity, concurrency: 2 }).catch(
    (error: unknown) => error,
  );
  expect(failure).not.toBeInstanceOf(PreflightError);
  expect(failure).toEqual(new Error('database unavailable'));
  expect(probed()).toEqual([]);
});

it("connects each probe with the subject's credentials, and with none for a subject that has none", async () => {
  const attach = jest.fn();
  const tokens = jest.fn(() => undefined);
  const { preflight } = await setup({ attach, tokens });
  const { signal } = new AbortController();
  await preflight('agent_a', principal, { identity, concurrency: 2, manual: true, signal });
  expect(tokens).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'owner' }),
    identity,
    expect.any(AbortSignal),
  );
  expect(attach).toHaveBeenCalledTimes(1);
  expect(attach).toHaveBeenCalledWith(
    expect.objectContaining({ connections: expect.any(Map) }),
    identity,
    'invoke',
    expect.any(AbortSignal),
    { manual: true },
  );
  attach.mockClear();
  await preflight('agent_a', principal, { concurrency: 2 });
  expect(attach).not.toHaveBeenCalled();
});
