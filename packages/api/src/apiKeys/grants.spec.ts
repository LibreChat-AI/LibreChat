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
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Response } from 'express';
import type { ExecutionContext } from '~/agents/authority/context';
import type { ApiKeyAuthRequest } from './middleware';
import type { ServerRequest } from '~/types';
import {
  restoreExecutionContext,
  createRemoteExecutionContext,
  createTriggerExecutionContext,
} from '~/agents/authority/context';
import {
  bindRunGrantInvocation,
  grantExecution,
  approvalHooks,
} from '~/agents/authority/execution';
import { pinStorage, untouchedSince, admitsDefinitions } from '~/agents/authority/execution.helper';
import { createAgentKeyMCPGrantHost, getRemoteRunKeyId, keySubject } from './grants';
import { scheduleExecution } from '~/schedules/authorization/subject';
import { initializeWithAuthority } from '~/agents/authority/host';
import { captureTrigger } from '~/agents/authority/trigger';
import { createRunPolicy } from '~/agents/authority/run';
import { sanitizeJobMetadata } from '~/stream/metadata';
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
  const grants = new Map<string, RunGrant<AgentKeyMCPIdentity>>();
  const found = (identity: AgentKeyMCPIdentity) =>
    identity.keyId === 'key-1' && identity.ownerId === 'owner' && identity.tenantId === 'tenant';
  let time = 1000;
  const storage: RunGrantStorage<AgentKeyMCPIdentity> = {
    readRunGrant: async (identity) =>
      found(identity)
        ? {
            agentId: identity.agentId,
            enabled: true,
            configRevision: 0,
            enrollment: structuredClone(grants.get(identity.agentId) ?? null),
          }
        : null,
    confirmRunGrant: async ({ identity, expectedRevision, enrollment, basis }) => {
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
    revokeRunGrant: async (identity) => {
      for (const consent of grants.get(identity.agentId)?.consents ?? [])
        consent.revokedAtMs = time;
      return true;
    },
    admitRunGrant: async ({ identity, revision, consentId, definitions }) => {
      const grant = grants.get(identity.agentId);
      return (
        found(identity) &&
        grant?.revision === revision &&
        grant.consents.every((c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time) &&
        admitsDefinitions(grant, consentId, definitions)
      );
    },
    pinRunGrantTool: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).pinRunGrantTool(input),
    flagRunGrantTool: (input) =>
      pinStorage(() => grants.get(input.identity.agentId)).flagRunGrantTool(input),
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
      ensureConfigServers: async () => ({}),
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
  const run = async (agentId = 'agent_a', keyId: string | null = 'key-1', worker = false) =>
    start(
      { user, ...(keyId && !worker && { apiKeyId: keyId }) },
      createRemoteExecutionContext({
        principal: { userId: 'owner', tenantId: 'tenant', role: 'USER' },
        agentId,
        protocol: 'chat.completions',
        background: false,
        ...(keyId && { keyId }),
      }),
      agentId,
    );
  /**
   * A run of `agentId` on the chat route, started by a delivery of the trigger engine whose
   * event `keyId` posted: the request is the trigger host's, so it names no key itself.
   */
  const delivered = (agentId: string, keyId: string) =>
    createTriggerExecutionContext({
      user,
      _isAgentTrigger: true,
      body: {
        agent_id: agentId,
        clientRequestId: 'trigger_delivery',
        agentTrigger: {
          version: 1,
          deliveryId: 'delivery-1',
          event: {
            id: 'event-1',
            type: 'review.submitted',
            occurredAt: 1_000,
            source: { type: 'remote_api_key', id: keyId },
          },
        },
      },
    });
  const deliver = async (agentId = 'agent_a', keyId = 'key-1') =>
    start({ user }, delivered(agentId, keyId), agentId);
  /**
   * The same run resumed after it paused for an approval: a request of its owner's, which is
   * not a trigger, initialized as the chat route does with the context its saved job
   * restores. `saved: false` is a job from before a job saved its trigger.
   */
  const resume = async (agentId = 'agent_a', keyId = 'key-1', saved = true) => {
    const source = delivered(agentId, keyId)?.source;
    const job = sanitizeJobMetadata({
      agent_id: agentId,
      ...(saved && source?.type === 'trigger' && { trigger: source }),
    });
    const req = { user, body: {} };
    const executionContext = restoreExecutionContext(req, {
      userId: 'owner',
      tenantId: 'tenant',
      ...job,
    });
    await initializeWithAuthority(
      { req, executionContext },
      [keySubject(() => host)],
      async () => undefined,
    );
    return started(req, agentId);
  };
  /**
   * The turn that reports work the delivered run sent to the background, a request the
   * trigger host makes for the task's wake-up. The task kept the run's trigger, its wake-up
   * stored it, and the host hands it back on the completion marker. `addressed` is the agent
   * the turn is sent to, which the root may have handed off to. `captured: false` is a task
   * from before tasks kept a trigger. `paused` resumes the turn from its own saved job.
   * `sourceId: 'librechat-event-actor'` is instead the delivery that resumes an actor
   * suspended on a detached action, which carries the kept trigger itself.
   */
  const report = async (
    agentId = 'agent_a',
    keyId = 'key-1',
    {
      captured = true,
      addressed = agentId,
      paused = false,
      sourceId = 'background-tool-completion',
    } = {},
  ) => {
    const kept = captured ? captureTrigger(delivered(agentId, keyId)) : undefined;
    const held = kept && { trigger: JSON.parse(JSON.stringify(kept)) };
    const event = {
      id: 'task-1',
      type: 'task.completed',
      occurredAt: 2_000,
      source: { type: 'internal', id: sourceId },
    };
    const turn = {
      user,
      _isAgentTrigger: true,
      body: {
        agent_id: addressed,
        conversationId: 'conversation',
        clientRequestId: 'trigger_wakeup',
        ...(sourceId === 'librechat-event-actor'
          ? { agentEventDelivery: { deliveryKey: 'trigger_wakeup', event, ...held } }
          : { agentEvent: event, agentCompletion: { version: 1, sourceId, ...held } }),
      },
    };
    const first = createTriggerExecutionContext(turn);
    const job = sanitizeJobMetadata({
      agent_id: addressed,
      ...(first?.source.type === 'trigger' && { trigger: first.source }),
    });
    const req = paused ? { user, body: {} } : turn;
    const executionContext = paused
      ? restoreExecutionContext(req, { userId: 'owner', tenantId: 'tenant', ...job })
      : first;
    await initializeWithAuthority(
      { req, context: getMCPRequestContext(req), executionContext },
      [keySubject(() => host)],
      async () => undefined,
    );
    return started(req, agentId);
  };
  const start = async (
    req: Parameters<typeof host.prepare>[0]['req'],
    executionContext: ExecutionContext | undefined,
    agentId: string,
  ) => {
    await host.prepare({ req, executionContext });
    return started(req, agentId);
  };
  const started = (req: Parameters<typeof host.prepare>[0]['req'], agentId: string) => {
    const context = getMCPRequestContext(req)!;
    const call = async (tool = 'query'): Promise<'unrestricted' | 'authorized'> => {
      const invocation = bindRunGrantInvocation(context, agentId, tool);
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
    deliver,
    resume,
    report,
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

describe('a delivery of the trigger engine that an API key posted', () => {
  it("runs under that key's grant, as a run the key starts through the remote API does", async () => {
    const s = setup();
    const ungranted = await s.deliver();
    await expect(ungranted.call()).rejects.toMatchObject(refused('consent_missing'));
    await s.allow('agent_a', ['query']);
    const { call } = await s.deliver();
    await expect(call()).resolves.toBe('authorized');
    await expect(call('list')).rejects.toMatchObject(refused('tool_policy_denied'));
    // The grant is the key's for that agent, and no other key's.
    await expect((await s.deliver('agent_b')).call()).rejects.toMatchObject(
      refused('consent_missing'),
    );
  });

  it('is left as it was unless the operator asks for grants', async () => {
    for (const integrations of [null, {}, { mode: 'owner', resources: { warehouse: resource } }]) {
      const s = setup(integrations);
      await expect((await s.deliver()).call()).resolves.toBe('unrestricted');
    }
  });

  it('reads what kind of key posted it, since the request names none', async () => {
    const s = setup();
    // One issued to an integration holds no grants, here as on the remote API.
    await expect((await s.deliver('agent_a', 'key-bound')).call()).resolves.toBe('unrestricted');
    expect(s.getKey).toHaveBeenCalledWith('key-bound', 'owner');
    // A key that is gone is not a reason to run unrestricted.
    await expect(s.deliver('agent_a', 'key-deleted')).rejects.toMatchObject(
      refused('binding_mismatch'),
    );
  });

  it("is still under that key's grant when its run resumes after a pause", async () => {
    const s = setup();
    await expect((await s.resume()).call()).rejects.toMatchObject(refused('consent_missing'));
    await s.allow('agent_a', ['query']);
    const { call } = await s.resume();
    await expect(call()).resolves.toBe('authorized');
    await expect(call('list')).rejects.toMatchObject(refused('tool_policy_denied'));
    // A key that is gone by the time its run resumes is not a reason to run unrestricted.
    await expect(s.resume('agent_a', 'key-deleted')).rejects.toMatchObject(
      refused('binding_mismatch'),
    );
  });

  it('resumes as it always has from a job saved before a job saved its trigger', async () => {
    const s = setup();
    await expect((await s.resume('agent_a', 'key-1', false)).call()).resolves.toBe('unrestricted');
  });
});

describe("the turn that reports work a key's run sent to the background", () => {
  it.each(['background-tool-completion', 'subagent-completion', 'librechat-event-actor'])(
    "runs under that key's grant, for a %s",
    async (sourceId) => {
      const s = setup();
      const ungranted = await s.report('agent_a', 'key-1', { sourceId });
      await expect(ungranted.call()).rejects.toMatchObject(refused('consent_missing'));
      await s.allow('agent_a', ['query']);
      const { call } = await s.report('agent_a', 'key-1', { sourceId });
      await expect(call()).resolves.toBe('authorized');
      await expect(call('list')).rejects.toMatchObject(refused('tool_policy_denied'));
    },
  );

  it('finds the grant by the root agent of the first run, whichever agent the turn is sent to', async () => {
    const s = setup();
    await s.allow('agent_a', ['query']);
    const { call } = await s.report('agent_a', 'key-1', { addressed: 'agent_b' });
    await expect(call()).resolves.toBe('authorized');
    const resumed = await s.report('agent_a', 'key-1', { addressed: 'agent_b', paused: true });
    await expect(resumed.call()).resolves.toBe('authorized');
  });

  it("is still under that key's grant when the turn itself resumes after a pause", async () => {
    const s = setup();
    const ungranted = await s.report('agent_a', 'key-1', { paused: true });
    await expect(ungranted.call()).rejects.toMatchObject(refused('consent_missing'));
    await s.allow('agent_a', ['query']);
    const { call } = await s.report('agent_a', 'key-1', { paused: true });
    await expect(call()).resolves.toBe('authorized');
    await expect(call('list')).rejects.toMatchObject(refused('tool_policy_denied'));
  });

  it('is not a reason to run unrestricted that the key is gone or was issued to an integration', async () => {
    const s = setup();
    await expect(s.report('agent_a', 'key-deleted')).rejects.toMatchObject(
      refused('binding_mismatch'),
    );
    await expect(s.report('agent_a', 'key-deleted', { paused: true })).rejects.toMatchObject(
      refused('binding_mismatch'),
    );
    // One issued to an integration holds no grants, on this turn as on the first.
    await expect((await s.report('agent_a', 'key-bound')).call()).resolves.toBe('unrestricted');
  });

  it('is left as it was for a task that kept no trigger, and where the operator asks for no grants', async () => {
    const s = setup();
    await expect((await s.report('agent_a', 'key-1', { captured: false })).call()).resolves.toBe(
      'unrestricted',
    );
    for (const integrations of [null, {}, { mode: 'owner', resources: { warehouse: resource } }]) {
      const open = setup(integrations);
      await expect((await open.report()).call()).resolves.toBe('unrestricted');
    }
  });

  it('says its completion turns find the grant again', async () => {
    const s = setup();
    expect((await s.host.execution.resolve(s.identity(), 'invoke'))?.detaches).toBe(true);
  });
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
  expect(bindRunGrantInvocation(getMCPRequestContext(req), 'agent_a', 'query')).toBeUndefined();
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
  // Nothing that writes or reads a schedule's own records finds a schedule here.
  expect(scheduleExecution(context)).toBeUndefined();
  // The run's policy is built over the key's grant like over any subject's, and decides
  // nothing under it: the agent's other tools are untouched, an MCP call is checked where it
  // is made, work may go to the background, and the run is never one that could pause.
  const grant = grantExecution(context);
  expect(grant).toMatchObject({
    identity: { keyId: expect.any(String), agentId: 'agent_a' },
    enrolled: true,
    coversTools: false,
    detaches: true,
    mayAsk: false,
  });
  const policy = createRunPolicy(grant!, [
    {
      id: 'agent_a',
      backgroundToolNames: ['execute_code'],
      toolDefinitions: [
        { name: 'query_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' },
        { name: 'export_mcp_warehouse', toolType: 'mcp', serverName: 'warehouse' },
      ],
    },
  ]);
  const signal = new AbortController().signal;
  for (const [toolName, toolInput] of [
    ['execute_code', {}],
    ['execute_code', { run_in_background: true }],
    ['web_search', {}],
    ['query_mcp_warehouse', {}],
    ['export_mcp_warehouse', {}],
  ] as const) {
    const input = { toolName, toolInput, executingAgentId: 'agent_a' } as Parameters<
      typeof policy.hook
    >[0];
    expect(await policy.hook(input, signal)).toEqual({});
    expect(await policy.receipt(input, signal)).toEqual({});
  }
  expect(approvalHooks(grant)).toEqual([]);
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
