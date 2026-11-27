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
import type { ReadyCache } from './ready';
import { pinStorage, untouchedSince, admitsDefinitions } from './execution.helper';
import { createAgentKeyMCPGrantHost } from '~/apiKeys/grants';
import { createPreflight, PreflightError } from './preflight';
import { createReadyCache } from './ready';

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
async function setup(credentials?: PreflightCredentials<AgentKeyMCPIdentity>, cache?: ReadyCache) {
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
    revokeRunGrant: async (subject, revision) => {
      const grant = grants.get(subject.agentId);
      if (!found(subject) || grant?.revision !== revision) return false;
      grants.set(subject.agentId, { ...grant, revokedAtMs: Date.now() });
      return true;
    },
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
  /** The servers as the registry has them set up now. */
  const servers: Partial<Record<'warehouse' | 'docs', typeof warehouse>> = {
    warehouse: { ...warehouse },
    docs: { ...docs },
  };
  /** The tools each server lists. */
  const listed: Record<string, string[]> = { warehouse: ['query'], docs: ['search'] };
  /** While set, every connection waits for it: a probe held under way. */
  const gate: { wait?: Promise<void> } = {};
  const deps: PreflightDeps<AgentKeyMCPIdentity> = {
    resolveAgentGraphAccess: async () => ({}) as AgentGraphAccessContext,
    getAgentGraphNodes: nodes,
    getModelsConfig: async () => ({ test: ['test'] }),
    getRoleByName,
    getUser: async () => ({ ...user }) as IUser,
    getAppConfig: async () => config,
    ensureConfigServers: async () => ({}),
    getServerConfigs: async () => structuredClone(servers),
    findPluginAuthsByKeys: async () => [],
    execution: host.execution,
    connect: jest.fn(async ({ serverName, oauthStart }) => {
      await gate.wait;
      if (!ready.has(serverName)) throw new Error('connection refused');
      if (expired.has(serverName)) await oauthStart?.('https://resource.example/authorize');
      return {
        fetchToolsSnapshot: async () => ({
          tools: (listed[serverName] ?? []).map((name) => ({
            name,
            description: 'Read',
            inputSchema: { type: 'object' as const, properties: {} },
          })),
          complete: true,
        }),
      };
    }),
  };
  const preflight = createPreflight<AgentKeyMCPIdentity>(deps, credentials, cache);
  const probed = () =>
    (deps.connect as jest.Mock).mock.calls.map(([options]) => options.serverName).sort();
  return { preflight, probed, ready, expired, state, servers, listed, host, gate };
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

describe('reusing a server found ready', () => {
  const ttlMs = 300_000;
  let clock: number;
  let cache: ReadyCache;
  beforeEach(() => {
    clock = 1_000_000;
    cache = createReadyCache({ ttlMs: async () => ttlMs, now: () => clock });
  });
  const check = (preflight: Awaited<ReturnType<typeof setup>>['preflight']) =>
    preflight('agent_a', principal, { identity, concurrency: 2 });
  const ok = [{ server: 'warehouse', status: 'ready' }];

  it('does not connect again within the lifetime', async () => {
    const { preflight, probed } = await setup(undefined, cache);
    await expect(check(preflight)).resolves.toEqual(ok);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse']);
  });

  it('connects again once the lifetime is over', async () => {
    const { preflight, probed } = await setup(undefined, cache);
    await check(preflight);
    clock += ttlMs;
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('connects again when the server is set up differently', async () => {
    const { preflight, probed, servers } = await setup(undefined, cache);
    await check(preflight);
    // A setting the grant is not bound to, so only the readiness changes.
    Object.assign(servers.warehouse!, { initTimeout: 5000 });
    await check(preflight);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('reports a server removed since as missing, whatever listing was kept', async () => {
    const { preflight, probed, servers } = await setup(undefined, cache);
    await check(preflight);
    delete servers.warehouse;
    await expect(check(preflight)).rejects.toMatchObject({
      outcomes: [{ server: 'warehouse', status: 'mcp_configuration_missing' }],
    });
    expect(probed()).toEqual(['warehouse']);
  });

  it('reads the grant on every check, however recent the listing', async () => {
    const { preflight, probed, state } = await setup(undefined, cache);
    await check(preflight);
    state.down = true;
    await expect(check(preflight)).rejects.toEqual(new Error('database unavailable'));
    expect(probed()).toEqual(['warehouse']);
  });

  it('answers as a check with no cache would once the grant changes', async () => {
    const settle = (promise: Promise<unknown>) =>
      promise.then(
        (value) => ({ value }),
        (error: { code?: string; outcomes?: unknown }) => ({
          code: error.code,
          outcomes: error.outcomes,
        }),
      );
    const cached = await setup(undefined, cache);
    const fresh = await setup();
    await check(cached.preflight);
    await check(fresh.preflight);
    for (const { host } of [cached, fresh]) {
      const { revision } = await host.service.view(identity);
      await host.service.revoke(identity, revision!);
      expect((await host.service.view(identity)).state).toBe('revoked');
    }
    expect(await settle(check(cached.preflight))).toEqual(await settle(check(fresh.preflight)));
  });

  it('asks the server itself when the kept listing lacks a tool the run needs', async () => {
    const stale = { tools: [], complete: true };
    const kept: ReadyCache = {
      ...cache,
      get: () => stale,
      delete: jest.fn((key) => cache.delete(key)),
    };
    const { preflight, probed } = await setup(undefined, kept);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse']);
    expect(kept.delete).toHaveBeenCalledWith(expect.objectContaining({ server: 'warehouse' }));
  });

  it('never keeps a server that was not ready', async () => {
    const { preflight, probed, ready } = await setup(undefined, cache);
    ready.delete('warehouse');
    await expect(check(preflight)).rejects.toBeInstanceOf(PreflightError);
    ready.add('warehouse');
    await expect(check(preflight)).resolves.toEqual(ok);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('keeps nothing from a check that found the server asking for a new sign-in', async () => {
    const { preflight, probed, expired } = await setup(undefined, cache);
    expired.add('warehouse');
    await expect(check(preflight)).rejects.toMatchObject({ code: 'mcp_reauth_required' });
    expired.delete('warehouse');
    await expect(check(preflight)).resolves.toEqual(ok);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('stops reusing a server the owner was refused by during a run', async () => {
    const { preflight, probed } = await setup(undefined, cache);
    await check(preflight);
    cache.forget('owner', 'warehouse');
    await check(preflight);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('reuses nothing at a lifetime of 0, or when the lifetime cannot be read', async () => {
    const off = await setup(undefined, createReadyCache({ ttlMs: async () => 0 }));
    await check(off.preflight);
    await check(off.preflight);
    expect(off.probed()).toEqual(['warehouse', 'warehouse']);
    const unread = await setup(
      undefined,
      createReadyCache({ ttlMs: () => Promise.reject(new Error('config unavailable')) }),
    );
    await check(unread.preflight);
    await check(unread.preflight);
    expect(unread.probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('connects once for a burst of deliveries checking the same server at once', async () => {
    const { preflight, probed } = await setup(undefined, cache);
    const burst = await Promise.all(Array.from({ length: 20 }, () => check(preflight)));
    expect(burst).toEqual(Array.from({ length: 20 }, () => ok));
    expect(probed()).toEqual(['warehouse']);
  });

  it('has each delivery of a burst check for itself when the shared check was not ready', async () => {
    const { preflight, probed, ready } = await setup(undefined, cache);
    ready.delete('warehouse');
    const burst = await Promise.allSettled(Array.from({ length: 3 }, () => check(preflight)));
    expect(burst.map(({ status }) => status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(probed()).toEqual(['warehouse', 'warehouse', 'warehouse']);
  });

  it('has a delivery waiting on a probe ask the server itself once the owner was refused', async () => {
    const pending = jest.fn((key: Parameters<ReadyCache['pending']>[0]) => cache.pending(key));
    const { preflight, probed, gate } = await setup(undefined, { ...cache, pending });
    const turns = () => new Promise((resolve) => setImmediate(resolve));
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = check(preflight);
    while (probed().length === 0) await turns();
    const second = check(preflight);
    // The second delivery is waiting on the first one's probe.
    while (!pending.mock.results.some(({ value }) => value != null)) await turns();
    // A call of a run finds the owner's sign-in refused while that probe is under way.
    cache.forget('owner', 'warehouse');
    gate.wait = undefined;
    release();
    await expect(first).resolves.toEqual(ok);
    await expect(second).resolves.toEqual(ok);
    // The second asked the server itself; what it found, after the refusal, is what is kept.
    expect(probed()).toEqual(['warehouse', 'warehouse']);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('does not keep what a probe found before the owner was refused', async () => {
    const { preflight, probed, gate } = await setup(undefined, cache);
    const turns = () => new Promise((resolve) => setImmediate(resolve));
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = check(preflight);
    while (probed().length === 0) await turns();
    cache.forget('owner', 'warehouse');
    gate.wait = undefined;
    release();
    await expect(first).resolves.toEqual(ok);
    // The next delivery asks the server: nothing found before the refusal was kept.
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });

  it('does not make a delivery after a refusal wait on a probe begun before it', async () => {
    const { preflight, probed, gate } = await setup(undefined, cache);
    const turns = () => new Promise((resolve) => setImmediate(resolve));
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = check(preflight);
    while (probed().length === 0) await turns();
    cache.forget('owner', 'warehouse');
    const second = check(preflight);
    // It connects for itself while the earlier probe is still held.
    while (probed().length < 2) await turns();
    gate.wait = undefined;
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([ok, ok]);
  });

  it('hands a probe under way to a delivery that arrives before any refusal', async () => {
    const { preflight, probed, gate } = await setup(undefined, cache);
    const turns = () => new Promise((resolve) => setImmediate(resolve));
    let release!: () => void;
    gate.wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = check(preflight);
    while (probed().length === 0) await turns();
    const second = check(preflight);
    for (let turn = 0; turn < 20; turn += 1) await turns();
    gate.wait = undefined;
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([ok, ok]);
    await expect(check(preflight)).resolves.toEqual(ok);
    expect(probed()).toEqual(['warehouse']);
  });

  it('connects every time when given no cache, as schedules and keys are', async () => {
    const { preflight, probed } = await setup();
    await check(preflight);
    await check(preflight);
    expect(probed()).toEqual(['warehouse', 'warehouse']);
  });
});

describe('the ready cache', () => {
  const key = (server: string, settings: unknown = { url: 'https://a.example' }) => ({
    tenantId: 'tenant',
    ownerId: 'owner',
    server,
    settings,
  });
  const listing = { tools: [], complete: true };

  it('keeps its newest entries up to its bound', () => {
    const cache = createReadyCache({ ttlMs: async () => 1000, max: 2, now: () => 0 });
    cache.set(key('a'), listing, 1000);
    cache.set(key('b'), listing, 1000);
    cache.set(key('c'), listing, 1000);
    expect(cache.get(key('a'))).toBeUndefined();
    expect(cache.get(key('b'))).toBe(listing);
    expect(cache.get(key('c'))).toBe(listing);
  });

  it('drops one entry by its key and leaves the others', () => {
    const cache = createReadyCache({ ttlMs: async () => 1000, now: () => 0 });
    cache.set(key('a'), listing, 1000);
    cache.set(key('b'), listing, 1000);
    cache.delete(key('a'));
    expect(cache.get(key('a'))).toBeUndefined();
    expect(cache.get(key('b'))).toBe(listing);
  });

  it('keeps an owner with no tenant apart from every tenant, settings or none', () => {
    const cache = createReadyCache({ ttlMs: async () => 1000, now: () => 0 });
    const plain = { ownerId: 'owner', server: 'a', settings: undefined };
    cache.set(plain, listing, 1000);
    expect(cache.get({ ...plain })).toBe(listing);
    expect(cache.get({ ...plain, tenantId: 'tenant' })).toBeUndefined();
    expect(cache.get({ ...plain, settings: null })).toBe(listing);
  });

  it('keeps nothing for a lifetime of 0', () => {
    const cache = createReadyCache({ ttlMs: async () => 0, now: () => 0 });
    cache.set(key('a'), listing, 0);
    expect(cache.get(key('a'))).toBeUndefined();
  });

  it('reads equal settings alike whatever their key order, and other owners apart', () => {
    const cache = createReadyCache({ ttlMs: async () => 1000, now: () => 0 });
    const settings = { url: 'u', headers: { b: '2', a: '1' }, args: ['x', { d: 1, c: 2 }] };
    cache.set(key('a', settings), listing, 1000);
    expect(
      cache.get(key('a', { args: ['x', { c: 2, d: 1 }], headers: { a: '1', b: '2' }, url: 'u' })),
    ).toBe(listing);
    // Order inside a list is part of the settings.
    expect(cache.get(key('a', { ...settings, args: [{ d: 1, c: 2 }, 'x'] }))).toBeUndefined();
    expect(cache.get({ ...key('a', settings), ownerId: 'other' })).toBeUndefined();
    expect(cache.get({ ...key('a', settings), tenantId: 'other' })).toBeUndefined();
  });

  it("forgets one owner's server under every settings it was kept with", () => {
    const cache = createReadyCache({ ttlMs: async () => 1000, now: () => 0 });
    cache.set(key('a', 1), listing, 1000);
    cache.set(key('a', 2), listing, 1000);
    cache.set(key('b', 1), listing, 1000);
    cache.begin(key('a', 3), 1000);
    cache.begin(key('b', 3), 1000);
    cache.forget('owner', 'a');
    expect(cache.get(key('a', 1))).toBeUndefined();
    expect(cache.get(key('a', 2))).toBeUndefined();
    expect(cache.get(key('b', 1))).toBe(listing);
    // A check of that server under way is no longer waited on; another server's still is.
    expect(cache.pending(key('a', 3))).toBeUndefined();
    expect(cache.pending(key('b', 3))).toBeInstanceOf(Promise);
  });
});
