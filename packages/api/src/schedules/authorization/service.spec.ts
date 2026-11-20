import type { ScheduleMCPConsentStorage, ScheduleConsentSnapshot } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity, ScheduledMCPTarget } from 'librechat-data-provider';
import { pinStorage, untouchedSince, admitsDefinitions } from './execution.helper';
import { createScheduleMCPConsentHandlers } from './handlers';
import { createScheduleMCPConsentService } from './service';

const identity: ScheduledMCPIdentity = {
  scheduleId: 's',
  ownerId: 'u',
  tenantId: 't',
  agentId: 'root',
  invocationMode: 'delegated',
};
const target: ScheduledMCPTarget = {
  resource: {
    serverName: 'warehouse',
    url: 'https://warehouse.example/mcp',
    configurationRevision: 'v1',
    credentialMode: 'resource_bearer',
    issuer: 'https://issuer.example/',
    audience: 'warehouse',
    scopes: ['read'],
  },
  permittedTools: [
    { agentId: 'root', tools: ['query'] },
    { agentId: 'child', tools: ['query'] },
  ],
  policyRevision: 'p1',
};
const jestPins = (
  pins: Pick<
    ScheduleMCPConsentStorage,
    'pinScheduleMCPToolDefinition' | 'flagScheduleMCPToolChange'
  >,
) => ({
  pinScheduleMCPToolDefinition: jest.fn(pins.pinScheduleMCPToolDefinition),
  flagScheduleMCPToolChange: jest.fn(pins.flagScheduleMCPToolChange),
});
function setup() {
  let time = 1000;
  const snapshot: ScheduleConsentSnapshot = {
    agentId: 'root',
    enabled: true,
    configRevision: 0,
    enrollment: null,
  };
  let targets = [structuredClone(target)];
  /** The agents' tools that are not MCP tools. None unless a test offers some. */
  let others: { agentId: string; tools: string[] }[] = [];
  let allowed = true;
  let pausable = true;
  /** The servers the agents use. Those on offer, unless a test says one lost its declaration. */
  let used: string[] | undefined;
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: jest.fn(async () => structuredClone(snapshot)),
    confirmScheduleMCPConsent: jest.fn(async (input) => {
      if (
        snapshot.configRevision !== input.expectedConfigRevision ||
        (snapshot.enrollment?.revision ?? null) !== input.expectedRevision ||
        !untouchedSince(snapshot.enrollment, input.basis)
      )
        return false;
      snapshot.enrollment = structuredClone(input.enrollment);
      return true;
    }),
    revokeScheduleMCPConsent: jest.fn(async (_identity, revision) => {
      if (snapshot.enrollment?.revision !== revision) return false;
      snapshot.enrollment.revision = 'revoked';
      snapshot.enrollment.revokedAtMs = time;
      snapshot.enrollment.consents = snapshot.enrollment.consents.map((c) => ({
        ...c,
        revision: 'revoked',
        revokedAtMs: time,
      }));
      return true;
    }),
    admitScheduleMCPConsent: jest.fn(
      async ({ revision, consentId, definitions }) =>
        snapshot.enabled &&
        snapshot.enrollment?.revision === revision &&
        snapshot.enrollment.consents.every(
          (c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time,
        ) &&
        admitsDefinitions(snapshot.enrollment, consentId, definitions),
    ),
    ...jestPins(pinStorage(() => snapshot.enrollment)),
  };
  const service = createScheduleMCPConsentService({
    storage,
    canUse: async () => allowed,
    canPause: async () => pausable,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    resolveEnrollment: async () => targets,
    resolveTools: async () => others,
    resolveServers: async () => used ?? targets.map((item) => item.resource.serverName),
    now: () => time,
  });
  const enroll = async (
    allow: Record<string, string[]> = { warehouse: ['query'] },
    ask?: Record<string, string[]>,
    tools?: string[],
  ) => {
    const view = await service.view(identity);
    return service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow,
      ...(ask && { ask }),
      ...(tools && { tools }),
    });
  };
  return {
    service,
    storage,
    snapshot,
    enroll,
    setTime: (value: number) => {
      time = value;
    },
    changeTarget: (...value: ScheduledMCPTarget[]) => {
      targets = value;
    },
    offerTools: (...value: { agentId: string; tools: string[] }[]) => {
      others = value;
    },
    useServers: (...value: string[]) => {
      used = value;
    },
    deny: () => {
      allowed = false;
    },
    cannotPause: () => {
      pausable = false;
    },
  };
}
const request = (stage: 'activation' | 'mint' | 'invoke' | 'resume') => ({
  identity,
  resource: target.resource,
  selection: { agentId: 'root', tools: ['query'] },
  stage,
});

it.each(['activation', 'mint', 'invoke', 'resume'] as const)(
  'checks durable consent and live RBAC at %s',
  async (stage) => {
    const s = setup();
    expect(await s.service.authority.authorize(request(stage), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'consent_missing' },
    });
    await s.enroll();
    expect(await s.service.authority.authorize(request(stage), {})).toMatchObject({
      state: 'authorized',
    });
    s.deny();
    expect(await s.service.authority.authorize(request(stage), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'rbac_denied' },
    });
  },
);
it('keeps expiry fixed across mint/use and denies approval resume at the absolute boundary', async () => {
  const s = setup();
  await s.enroll();
  const deadline = s.snapshot.enrollment!.consents[0].absoluteExpiresAtMs;
  await s.service.authority.authorize(request('mint'), {});
  expect(s.snapshot.enrollment!.consents[0].absoluteExpiresAtMs).toBe(deadline);
  s.setTime(deadline);
  expect((await s.service.view(identity)).state).toBe('expired');
  expect(await s.service.authority.authorize(request('resume'), {})).toMatchObject({
    state: 'denied',
    failure: { reason: 'consent_expired' },
  });
});
it('stops use/resume after revocation even when mint previously succeeded', async () => {
  const s = setup();
  const enrolled = await s.enroll();
  await s.service.authority.authorize(request('mint'), {});
  await s.service.revoke(identity, enrolled.revision!);
  for (const stage of ['invoke', 'resume'] as const)
    expect(await s.service.authority.authorize(request(stage), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'consent_revoked' },
    });
});
it('does not authorize by mutable schedule-agent equality alone', async () => {
  const s = setup();
  await s.enroll();
  s.snapshot.agentId = 'other';
  s.snapshot.configRevision++;
  expect(
    await s.service.authority.authorize(
      { ...request('invoke'), identity: { ...identity, agentId: 'other' } },
      {},
    ),
  ).toMatchObject({ state: 'denied', failure: { reason: 'binding_mismatch' } });
});
it.each(['url', 'issuer', 'audience', 'configurationRevision'] as const)(
  'invalidates a changed %s binding',
  async (field) => {
    const s = setup();
    await s.enroll();
    s.changeTarget({
      ...target,
      resource: {
        ...target.resource,
        [field]: ['url', 'issuer'].includes(field) ? 'https://other.example/' : 'different',
      },
    });
    expect((await s.service.view(identity)).state).toBe('changed');
    expect(await s.service.authority.authorize(request('invoke'), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
  },
);
it('authorizes each agent only for tools it selected and the owner allowed', async () => {
  const s = setup();
  await s.enroll();
  expect(
    await s.service.authority.authorize(
      { ...request('invoke'), selection: { agentId: 'child', tools: ['query'] } },
      {},
    ),
  ).toMatchObject({ state: 'authorized' });
  expect(
    await s.service.authority.authorize(
      { ...request('invoke'), selection: { agentId: 'child', tools: ['write'] } },
      {},
    ),
  ).toMatchObject({ state: 'denied', failure: { reason: 'tool_policy_denied' } });
});

const offering = (tools: string[], serverName = 'warehouse'): ScheduledMCPTarget => ({
  ...target,
  resource: { ...target.resource, serverName },
  permittedTools: [
    { agentId: 'root', tools },
    { agentId: 'child', tools },
  ],
});

it('grants only the tools the owner chose from the offer', async () => {
  const s = setup();
  s.changeTarget(offering(['export', 'query']));
  const view = await s.enroll({ warehouse: ['query'] });

  expect(view).toMatchObject({ state: 'active', allowed: { warehouse: ['query'] } });
  expect(view.targets[0].permittedTools[0].tools).toEqual(['export', 'query']);
  expect(s.snapshot.enrollment!.consents[0].permittedTools).toEqual([
    { agentId: 'child', tools: ['query'] },
    { agentId: 'root', tools: ['query'] },
  ]);
  expect(await s.service.authority.authorize(request('invoke'), {})).toMatchObject({
    state: 'authorized',
  });
  expect(
    await s.service.authority.authorize(
      { ...request('invoke'), selection: { agentId: 'root', tools: ['export'] } },
      {},
    ),
  ).toMatchObject({ state: 'denied', failure: { reason: 'tool_policy_denied' } });
});

it('confirms a selection as large as many agents can offer without stalling the process', async () => {
  const s = setup();
  // 20 agents with 256 tools each, all distinct: 5,120 tools on one server.
  const permittedTools = Array.from({ length: 20 }, (_, agent) => ({
    agentId: agent === 0 ? 'root' : `agent-${agent}`,
    tools: Array.from({ length: 256 }, (_, tool) => `tool-${agent}-${tool}`),
  }));
  s.changeTarget({ ...target, permittedTools });
  const every = permittedTools.flatMap((selection) => selection.tools);
  const started = performance.now();
  const view = await s.enroll({ warehouse: every });
  const elapsed = performance.now() - started;
  expect(view.allowed.warehouse).toHaveLength(every.length);
  // The quadratic check took over two seconds for this input; the linear one takes a few
  // dozen milliseconds. The bound is loose enough for a loaded machine.
  expect(elapsed).toBeLessThan(1000);
  await expect(s.enroll({ warehouse: [...every, 'not-on-offer'] })).rejects.toMatchObject({
    code: 'consent_invalid',
  });
});

it('leaves a server out of the grant when the owner chose nothing on it', async () => {
  const s = setup();
  s.changeTarget(offering(['query']), offering(['read'], 'archive'));
  const view = await s.enroll({ warehouse: ['query'], archive: [] });

  expect(view.allowed).toEqual({ warehouse: ['query'] });
  expect(s.snapshot.enrollment!.consents.map((c) => c.resource.serverName)).toEqual(['warehouse']);
  expect(
    await s.service.authority.authorize(
      {
        ...request('invoke'),
        resource: { ...target.resource, serverName: 'archive' },
        selection: { agentId: 'root', tools: ['read'] },
      },
      {},
    ),
  ).toMatchObject({ state: 'denied', failure: { reason: 'consent_missing' } });
});

it.each([
  ['a server that is not on offer', { other: ['query'] }],
  ['a tool that is not on offer', { warehouse: ['delete'] }],
  ['nothing at all', { warehouse: [] }],
])('rejects a choice of %s without writing', async (_label, allow) => {
  const s = setup();
  await expect(s.enroll(allow)).rejects.toMatchObject({ code: 'consent_invalid' });
  expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
});

it('stays active when the agent selects another tool, and changes when it drops an allowed one', async () => {
  const s = setup();
  await s.enroll();
  s.changeTarget(offering(['query', 'write']));
  expect((await s.service.view(identity)).state).toBe('active');
  expect(await s.service.authority.authorize(request('invoke'), {})).toMatchObject({
    state: 'authorized',
  });

  s.changeTarget(offering(['write']));
  expect(await s.service.view(identity)).toMatchObject({
    state: 'changed',
    allowed: { warehouse: ['query'] },
  });
  expect(await s.service.authority.authorize(request('invoke'), {})).toMatchObject({
    state: 'denied',
    failure: { reason: 'tool_policy_denied' },
  });
});
it('rejects stale offers/excessive lifetimes without writing', async () => {
  const s = setup();
  const view = await s.service.view(identity);
  await expect(
    s.service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 25,
      allow: { warehouse: ['query'] },
    }),
  ).rejects.toMatchObject({ code: 'consent_invalid' });
  s.changeTarget({ ...target, policyRevision: 'p2' });
  await expect(
    s.service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    }),
  ).rejects.toMatchObject({ code: 'consent_changed' });
  expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
});
it('keeps owner revocation available after permission removal', async () => {
  const s = setup();
  const enrolled = await s.enroll();
  s.deny();
  await s.service.revoke(identity, enrolled.revision!);
  expect((await s.service.view(identity)).state).toBe('revoked');
  expect((await s.service.view(identity)).offer).toBeNull();
});
it('denies without a trusted resolver and preserves cancellation', async () => {
  const s = setup();
  const service = createScheduleMCPConsentService({
    storage: s.storage,
    canUse: async () => true,
    getLimits: async () => ({ enabled: false, maxLifetimeHours: 24 }),
  });
  expect((await service.view(identity)).state).toBe('unsupported');
  expect(await service.authority.authorize(request('mint'), {})).toMatchObject({
    state: 'denied',
    failure: { reason: 'provider_missing' },
  });
  const controller = new AbortController();
  controller.abort();
  expect(
    await service.authority.authorize(request('resume'), { signal: controller.signal }),
  ).toEqual({ state: 'cancelled' });
});
it('does not turn a storage outage into absent consent or leak it from the owner API', async () => {
  const s = setup();
  jest
    .mocked(s.storage.readScheduleMCPConsent)
    .mockRejectedValue(new Error('secret-token-in-cause'));
  await expect(s.service.authority.lookupConsent(identity, target.resource, {})).rejects.toThrow(
    'secret-token-in-cause',
  );
  const handlers = createScheduleMCPConsentHandlers({
    service: s.service,
    resolveIdentity: async () => identity,
  });
  const res = Object.assign({} as Parameters<typeof handlers.get>[1], {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });
  await handlers.get({} as Parameters<typeof handlers.get>[0], res);
  expect(res.status).toHaveBeenCalledWith(503);
  expect(res.json).toHaveBeenCalledWith({ code: 'consent_unavailable' });
});

it('denies a removed child selection even without a policy revision change', async () => {
  const s = setup();
  await s.enroll();
  s.changeTarget({ ...target, permittedTools: [{ agentId: 'root', tools: ['query'] }] });
  expect(
    await s.service.authority.authorize(
      { ...request('invoke'), selection: { agentId: 'child', tools: ['query'] } },
      {},
    ),
  ).toMatchObject({ state: 'denied', failure: { reason: 'tool_policy_denied' } });
});

it('offers no overwrite of an incompatible stored grant', async () => {
  const s = setup();
  s.snapshot.compatible = false;
  expect(await s.service.view(identity)).toMatchObject({
    state: 'unsupported',
    offer: null,
    revision: null,
  });
});

describe("the agents' tools that are not MCP tools", () => {
  const offered = [
    { agentId: 'child', tools: ['web_search'] },
    { agentId: 'root', tools: ['execute_code', 'send_action_mail.example', 'web_search'] },
  ];

  it('offers each of them once, and nothing has been allowed before the owner chooses', async () => {
    const s = setup();
    s.offerTools(...offered);
    expect(await s.service.view(identity)).toMatchObject({
      state: 'missing',
      tools: { offered: ['execute_code', 'send_action_mail.example', 'web_search'], allowed: [] },
    });
  });

  it('stores the ones the owner allows for every agent that has them, and no others', async () => {
    const s = setup();
    s.offerTools(...offered);
    const view = await s.enroll(undefined, undefined, ['execute_code', 'web_search']);
    expect(view).toMatchObject({
      state: 'active',
      tools: { allowed: ['execute_code', 'web_search'] },
    });
    expect(s.snapshot.enrollment!.tools).toEqual([
      { agentId: 'child', tools: ['web_search'] },
      { agentId: 'root', tools: ['execute_code', 'web_search'] },
    ]);
  });

  it('stores nothing when the owner allows none, and still grants the MCP tools', async () => {
    const s = setup();
    s.offerTools(...offered);
    expect(await s.enroll(undefined, undefined, [])).toMatchObject({
      state: 'active',
      tools: { allowed: [] },
    });
    expect(s.snapshot.enrollment).not.toHaveProperty('tools');
  });

  it('rejects a tool that is not on offer without writing', async () => {
    const s = setup();
    s.offerTools(...offered);
    await expect(s.enroll(undefined, undefined, ['file_search'])).rejects.toMatchObject({
      code: 'consent_invalid',
    });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
  });

  it('keeps the stored choice when a confirmation does not say, for the tools still on offer', async () => {
    const s = setup();
    s.offerTools(...offered);
    await s.enroll(undefined, undefined, ['execute_code', 'web_search']);
    // The agent drops code execution; a client that does not send `tools` renews the grant.
    s.offerTools({ agentId: 'root', tools: ['web_search'] });
    expect(await s.enroll()).toMatchObject({ tools: { allowed: ['web_search'] } });
    expect(s.snapshot.enrollment!.tools).toEqual([{ agentId: 'root', tools: ['web_search'] }]);
  });

  it('grants a schedule whose agents use no MCP server at all', async () => {
    const s = setup();
    s.changeTarget();
    s.offerTools({ agentId: 'root', tools: ['execute_code', 'web_search'] });
    expect(await s.service.view(identity)).toMatchObject({
      state: 'missing',
      targets: [],
      tools: { offered: ['execute_code', 'web_search'] },
      offer: { digest: expect.any(String) },
    });
    const view = await s.enroll({}, undefined, ['web_search']);
    // The lifetime is the grant's own: there is no MCP server to carry it.
    expect(view).toMatchObject({ state: 'active', expiresAtMs: 1000 + 3_600_000, targets: [] });
    expect(s.snapshot.enrollment).toMatchObject({
      consents: [],
      tools: [{ agentId: 'root', tools: ['web_search'] }],
      grantedAtMs: 1000,
      absoluteExpiresAtMs: 1000 + 3_600_000,
      revokedAtMs: null,
    });
    s.setTime(1000 + 3_600_000);
    expect(await s.service.view(identity)).toMatchObject({ state: 'expired' });
    s.setTime(2000);
    await s.service.revoke(identity, view.revision!);
    expect(await s.service.view(identity)).toMatchObject({ state: 'revoked' });
  });

  it('rejects a grant that allows nothing, MCP tool or other', async () => {
    const s = setup();
    s.offerTools({ agentId: 'root', tools: ['web_search'] });
    await expect(s.enroll({ warehouse: [] }, undefined, [])).rejects.toMatchObject({
      code: 'consent_invalid',
    });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
    // One of either kind is enough.
    expect(await s.enroll({ warehouse: [] }, undefined, ['web_search'])).toMatchObject({
      state: 'active',
      allowed: {},
    });
  });

  it('binds a confirmation to the tools the owner was shown', async () => {
    const s = setup();
    const before = await s.service.view(identity);
    s.offerTools(...offered);
    const shown = await s.service.view(identity);
    // An offer with no such tools keeps the digest it had before they could be offered.
    expect(shown.offer!.digest).not.toBe(before.offer!.digest);
    s.offerTools({ agentId: 'root', tools: ['execute_code'] });
    await expect(
      s.service.confirm(identity, {
        offerDigest: shown.offer!.digest,
        expectedRevision: null,
        lifetimeHours: 1,
        allow: { warehouse: ['query'] },
        tools: ['execute_code'],
      }),
    ).rejects.toMatchObject({ code: 'consent_changed' });
  });
});

describe('a schedule that is authorized as it is created', () => {
  const draft = { ...identity, scheduleId: 'draft' };
  const created = { ...identity, scheduleId: 'sched_new' };

  it('offers what the agent could be allowed without any stored schedule', async () => {
    const s = setup();
    s.offerTools({ agentId: 'root', tools: ['web_search'] });
    const offer = await s.service.draft(draft);
    expect(offer).toMatchObject({
      state: 'missing',
      revision: null,
      targets: [
        expect.objectContaining({ resource: expect.objectContaining({ serverName: 'warehouse' }) }),
      ],
      tools: { offered: ['web_search'], allowed: [] },
      offer: { maxLifetimeHours: 24 },
    });
    expect(s.storage.readScheduleMCPConsent).not.toHaveBeenCalled();
    // Bound to the owner and the agent, so it holds for the id the schedule is then given.
    expect((await s.service.draft(created)).offer!.digest).toBe(offer.offer!.digest);
    expect((await s.service.draft({ ...draft, agentId: 'other' })).offer!.digest).not.toBe(
      offer.offer!.digest,
    );
  });

  it("builds the grant for the new schedule from the owner's choice, and stores nothing", async () => {
    const s = setup();
    s.offerTools({ agentId: 'root', tools: ['execute_code', 'web_search'] });
    const offer = await s.service.draft(draft);
    const grant = await s.service.grant(created, {
      offerDigest: offer.offer!.digest,
      lifetimeHours: 2,
      allow: { warehouse: ['query'] },
      tools: ['web_search'],
    });
    expect(grant).toMatchObject({
      version: 1,
      scheduleRevision: 0,
      consents: [
        {
          identity: created,
          permittedTools: [
            { agentId: 'child', tools: ['query'] },
            { agentId: 'root', tools: ['query'] },
          ],
          absoluteExpiresAtMs: 1000 + 2 * 3_600_000,
        },
      ],
      tools: [{ agentId: 'root', tools: ['web_search'] }],
      grantedAtMs: 1000,
      absoluteExpiresAtMs: 1000 + 2 * 3_600_000,
      revokedAtMs: null,
    });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
  });

  it.each([
    ['an offer that has since changed', { offerDigest: 'b'.repeat(64) }, 'consent_changed'],
    ['nothing allowed', { allow: {}, tools: [] }, 'consent_invalid'],
    ['a tool that is not on offer', { tools: ['file_search'] }, 'consent_invalid'],
    ["a lifetime past the operator's limit", { lifetimeHours: 25 }, 'consent_invalid'],
  ])('refuses a choice with %s', async (_label, change, code) => {
    const s = setup();
    s.offerTools({ agentId: 'root', tools: ['web_search'] });
    const offer = await s.service.draft(draft);
    await expect(
      s.service.grant(created, {
        offerDigest: offer.offer!.digest,
        lifetimeHours: 1,
        allow: { warehouse: ['query'] },
        tools: ['web_search'],
        ...change,
      }),
    ).rejects.toMatchObject({ code });
  });

  it('offers nothing to an owner who may not use the agent, and refuses to ask first where a run cannot pause', async () => {
    const s = setup();
    s.cannotPause();
    const offer = await s.service.draft(draft);
    await expect(
      s.service.grant(created, {
        offerDigest: offer.offer!.digest,
        lifetimeHours: 1,
        allow: { warehouse: ['query'] },
        ask: { warehouse: ['query'] },
      }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
    s.deny();
    await expect(s.service.draft(draft)).rejects.toMatchObject({ code: 'consent_forbidden' });
  });
});

describe('a grant of the whole agent', () => {
  const wider: ScheduledMCPTarget = {
    ...target,
    permittedTools: [
      { agentId: 'root', tools: ['export', 'query'] },
      { agentId: 'child', tools: ['query'] },
      { agentId: 'later', tools: ['query'] },
    ],
    policyRevision: 'p2',
  };
  const call = (tool: string, agentId = 'root', digest = 'a'.repeat(64)) => ({
    ...request('invoke'),
    selection: { agentId, tools: [tool] },
    definitions: { [tool]: digest },
  });
  const whole = async (s: ReturnType<typeof setup>, ask?: Record<string, string[]>) => {
    const view = await s.service.view(identity);
    return s.service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow: {},
      everything: true,
      ...(ask && { ask }),
    });
  };

  it('is offered, stored with every server on offer, and reported as the whole agent', async () => {
    const s = setup();
    s.offerTools({ agentId: 'root', tools: ['web_search'] });
    expect((await s.service.view(identity)).offer).toMatchObject({ everything: true });
    expect(await whole(s)).toMatchObject({ state: 'active', everything: true });
    expect(s.snapshot.enrollment).toMatchObject({
      everything: true,
      consents: [
        {
          resource: { serverName: 'warehouse' },
          permittedTools: expect.arrayContaining(target.permittedTools),
        },
      ],
      absoluteExpiresAtMs: 1000 + 3_600_000,
    });
    // Nothing is listed one by one: the other tools are allowed without being named.
    expect(s.snapshot.enrollment).not.toHaveProperty('tools');
    // A later choice of tools replaces it.
    expect(await s.enroll({ warehouse: ['query'] })).toMatchObject({ everything: false });
    expect(s.snapshot.enrollment).not.toHaveProperty('everything');
  });

  it('can be made for an agent with nothing to list today', async () => {
    const s = setup();
    s.changeTarget();
    expect(await whole(s)).toMatchObject({ state: 'active', everything: true, targets: [] });
    expect(s.snapshot.enrollment).toMatchObject({ everything: true, consents: [] });
  });

  it('allows a tool and an agent added after it was made, and stays active', async () => {
    const s = setup();
    await whole(s);
    s.changeTarget(wider);
    expect(await s.service.view(identity)).toMatchObject({ state: 'active', everything: true });
    expect(await s.service.authority.authorize(call('export'), {})).toMatchObject({
      state: 'authorized',
    });
    expect(await s.service.authority.authorize(call('query', 'later'), {})).toMatchObject({
      state: 'authorized',
    });
    // Nor one the agents have through a selection of every tool on the server, which no list names.
    expect(await s.service.authority.authorize(call('purge'), {})).toMatchObject({
      state: 'authorized',
    });
    // The agents dropping a server does not make the grant stale either.
    s.changeTarget();
    expect(await s.service.view(identity)).toMatchObject({ state: 'active', everything: true });
    // A server they still use that can no longer be offered does: its calls are refused.
    s.useServers('warehouse');
    expect(await s.service.view(identity)).toMatchObject({ state: 'changed', everything: true });
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    s.changeTarget(wider);
    expect(await s.service.view(identity)).toMatchObject({ state: 'active', everything: true });
    // A grant that lists its tools still refuses what it does not list.
    await s.enroll({ warehouse: ['query'] });
    expect(await s.service.authority.authorize(call('export'), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'tool_policy_denied' },
    });
  });

  it('does not hold back a tool whose definition changed, and pins nothing', async () => {
    const s = setup();
    await whole(s);
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
    });
    expect(
      await s.service.authority.authorize(call('query', 'root', 'b'.repeat(64)), {}),
    ).toMatchObject({ state: 'authorized' });
    expect(s.storage.pinScheduleMCPToolDefinition).not.toHaveBeenCalled();
    expect(s.storage.flagScheduleMCPToolChange).not.toHaveBeenCalled();
    expect((await s.service.view(identity)).state).toBe('active');
  });

  it('drops the pins of the listed grant it replaces', async () => {
    const s = setup();
    await s.enroll();
    await s.service.authority.authorize(call('query'), {});
    expect(s.snapshot.enrollment!.consents[0]).toMatchObject({
      definitions: [{ tool: 'query' }],
    });
    await whole(s);
    expect(s.snapshot.enrollment!.consents[0]).not.toHaveProperty('definitions');
    expect(
      await s.service.authority.authorize(call('query', 'root', 'b'.repeat(64)), {}),
    ).toMatchObject({ state: 'authorized' });
  });

  it('still ends at its deadline, on revocation, and when a server it was made for moves', async () => {
    const s = setup();
    await whole(s);
    s.changeTarget({ ...target, resource: { ...target.resource, audience: 'elsewhere' } });
    expect((await s.service.view(identity)).state).toBe('changed');
    expect(
      await s.service.authority.authorize(
        { ...call('query'), resource: { ...target.resource, audience: 'elsewhere' } },
        {},
      ),
    ).toMatchObject({ state: 'denied', failure: { reason: 'binding_mismatch' } });
    s.changeTarget(target);
    s.setTime(1000 + 3_600_000);
    expect((await s.service.view(identity)).state).toBe('expired');
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'consent_expired' },
    });
  });

  it('keeps asking about a tool the owner wants to approve each time', async () => {
    const s = setup();
    await whole(s, { warehouse: ['query'] });
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
      approvalRequired: true,
    });
  });

  it('checks the owner, the deployment and the grant before a call on a server it holds no consent for', async () => {
    const s = setup();
    await whole(s);
    const standing = (over: Record<string, unknown> = {}) =>
      s.service.authority.standing(
        {
          identity,
          revision: s.snapshot.enrollment!.revision,
          stage: 'invoke' as const,
          ...over,
        },
        {},
      );
    const refused = (reason: string) => ({ state: 'denied', failure: { reason } });
    expect(await standing()).toEqual({ state: 'authorized' });
    // Another grant than the one the run started under, or the schedule as it was.
    expect(await standing({ revision: 'earlier' })).toMatchObject(refused('binding_mismatch'));
    s.snapshot.configRevision = 1;
    expect(await standing()).toMatchObject(refused('binding_mismatch'));
    s.snapshot.configRevision = 0;
    // A paused schedule runs only when its owner starts it by hand.
    s.snapshot.enabled = false;
    expect(await standing()).toMatchObject(refused('binding_mismatch'));
    expect(await standing({ manual: true })).toEqual({ state: 'authorized' });
    s.snapshot.enabled = true;
    s.setTime(1000 + 3_600_000);
    expect(await standing()).toMatchObject(refused('consent_expired'));
    s.setTime(1000);
    s.deny();
    expect(await standing()).toMatchObject(refused('rbac_denied'));

    const listed = setup();
    await listed.enroll();
    expect(
      await listed.service.authority.standing(
        { identity, revision: listed.snapshot.enrollment!.revision, stage: 'invoke' },
        {},
      ),
    ).toMatchObject(refused('tool_policy_denied'));
  });

  it('passes that call under a grant that lists the tool for the agent, and no other', async () => {
    const s = setup();
    s.offerTools(
      { agentId: 'root', tools: ['lookup_mcp_notes', 'web_search'] },
      { agentId: 'child', tools: ['web_search'] },
    );
    await s.enroll({}, undefined, ['lookup_mcp_notes', 'web_search']);
    const standing = (agentId: string, keys: string[], over: Record<string, unknown> = {}) =>
      s.service.authority.standing(
        {
          identity,
          revision: s.snapshot.enrollment!.revision,
          stage: 'invoke' as const,
          listed: { agentId, keys },
          ...over,
        },
        {},
      );
    const refused = (reason: string) => ({ state: 'denied', failure: { reason } });
    // Any of the keys the tool could be listed under.
    expect(await standing('root', ['lookup_mcp_Notes', 'lookup_mcp_notes'])).toEqual({
      state: 'authorized',
    });
    expect(await standing('root', ['purge_mcp_notes'])).toMatchObject(
      refused('tool_policy_denied'),
    );
    // Listed for one agent is not listed for another.
    expect(await standing('child', ['lookup_mcp_notes'])).toMatchObject(
      refused('tool_policy_denied'),
    );
    // The same live checks as for the whole agent.
    expect(await standing('root', ['lookup_mcp_notes'], { revision: 'earlier' })).toMatchObject(
      refused('binding_mismatch'),
    );
    s.setTime(1000 + 3_600_000);
    expect(await standing('root', ['lookup_mcp_notes'])).toMatchObject(refused('consent_expired'));
    s.setTime(1000);
    s.deny();
    expect(await standing('root', ['lookup_mcp_notes'])).toMatchObject(refused('rbac_denied'));
  });

  it('is refused that call where the owner may no longer use MCP servers, or schedules are off', async () => {
    const s = setup();
    await whole(s);
    let mcp = true;
    let enabled = true;
    const service = createScheduleMCPConsentService({
      storage: s.storage,
      canUse: async () => true,
      canUseMCP: async () => mcp,
      getLimits: async () => ({ enabled, maxLifetimeHours: 24 }),
      resolveEnrollment: async () => [structuredClone(target)],
      resolveTools: async () => [],
      now: () => 1000,
    });
    const standing = () =>
      service.authority.standing(
        { identity, revision: s.snapshot.enrollment!.revision, stage: 'invoke' },
        {},
      );
    expect(await standing()).toEqual({ state: 'authorized' });
    mcp = false;
    expect(await standing()).toMatchObject({ failure: { reason: 'rbac_denied' } });
    mcp = true;
    enabled = false;
    expect(await standing()).toMatchObject({ failure: { reason: 'provider_missing' } });
  });

  it('keeps its servers when the agents come to select every tool on one', async () => {
    const s = setup();
    await whole(s);
    // What the resolver reports for a selection of every tool: the server, under a marker.
    const every: ScheduledMCPTarget = {
      ...target,
      permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }],
      policyRevision: 'p3',
    };
    s.changeTarget(every);
    expect(await s.service.authority.authorize(call('anything'), {})).toMatchObject({
      state: 'authorized',
    });
    // The grant is not stale, and the selection is on offer as one item for the server.
    expect(await s.service.view(identity)).toMatchObject({
      state: 'active',
      everything: true,
      targets: [{ permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }] }],
    });
    expect(await s.service.authority.lookupConsent(identity, target.resource, {})).toMatchObject({
      state: 'found',
      everything: true,
    });
  });

  it('holds a consent for a server the agents select as a whole when it is made', async () => {
    const every: ScheduledMCPTarget = {
      ...target,
      permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }],
      policyRevision: 'p3',
    };
    const s = setup();
    s.changeTarget(every);
    const offered = [{ permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }] }];
    expect((await s.service.view(identity)).targets).toMatchObject(offered);
    expect(await whole(s)).toMatchObject({ state: 'active', everything: true });
    expect(s.snapshot.enrollment!.consents).toMatchObject([
      { resource: { serverName: 'warehouse', audience: 'warehouse' } },
    ]);
    expect(await s.service.authority.authorize(call('anything'), {})).toMatchObject({
      state: 'authorized',
    });
    // The view notices when its recipient moves.
    s.changeTarget({ ...every, resource: { ...every.resource, audience: 'elsewhere' } });
    expect((await s.service.view(identity)).state).toBe('changed');
    s.changeTarget(every);
    expect((await s.service.view(identity)).state).toBe('active');
    // The same for a schedule that is being created.
    const offer = await s.service.draft(identity);
    expect(offer.targets).toMatchObject(offered);
    const grant = await s.service.grant(identity, {
      offerDigest: offer.offer!.digest,
      lifetimeHours: 1,
      allow: {},
      everything: true,
    });
    expect(grant.consents).toMatchObject([{ resource: { serverName: 'warehouse' } }]);
  });

  it('covers a declared server the agents take up after it was made', async () => {
    const s = setup();
    // Made while the agents used no MCP server at all.
    s.changeTarget();
    await whole(s);
    expect(s.snapshot.enrollment!.consents).toEqual([]);
    s.changeTarget(target);
    const refused = (reason: string) => ({ state: 'denied', failure: { reason } });
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
      consentRevision: s.snapshot.enrollment!.revision,
      validUntilMs: 1000 + 3_600_000,
    });
    expect(s.storage.pinScheduleMCPToolDefinition).not.toHaveBeenCalled();
    // The recipient is the one the operator declares now, and no other.
    expect(
      await s.service.authority.authorize(
        { ...call('query'), resource: { ...target.resource, audience: 'elsewhere' } },
        {},
      ),
    ).toMatchObject(refused('binding_mismatch'));
    s.changeTarget();
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject(
      refused('binding_mismatch'),
    );
    s.changeTarget(target);
    s.snapshot.configRevision = 1;
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject(
      refused('binding_mismatch'),
    );
    s.snapshot.configRevision = 0;
    s.setTime(1000 + 3_600_000);
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject(
      refused('consent_expired'),
    );
    s.setTime(1000);
    s.deny();
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject(
      refused('rbac_denied'),
    );

    // A grant that lists its tools has no consent for a server it does not list.
    const listed = setup();
    listed.offerTools({ agentId: 'root', tools: ['web_search'] });
    listed.changeTarget();
    await listed.enroll({}, undefined, ['web_search']);
    listed.changeTarget(target);
    expect(await listed.service.authority.authorize(call('query'), {})).toMatchObject(
      refused('consent_missing'),
    );
  });

  it('keeps a question about a tool through a renewal after the agents select its server as a whole', async () => {
    const s = setup();
    // The owner approves each use of `query`.
    await s.enroll({ warehouse: ['query'] }, { warehouse: ['query'] });
    // The agents now select the whole server: no tool is named there any more.
    s.changeTarget({
      ...target,
      permittedTools: [{ agentId: 'root', tools: ['sys__all__sys'] }],
      policyRevision: 'p3',
    });
    // Renewed for the whole agent, as the dialog does: nothing said about asking.
    expect(await whole(s)).toMatchObject({
      state: 'active',
      everything: true,
      asking: { warehouse: ['query'] },
    });
    expect(s.snapshot.enrollment!.consents[0].askTools).toEqual(['query']);
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
      approvalRequired: true,
    });
    expect(await s.service.authority.authorize(call('export'), {})).not.toHaveProperty(
      'approvalRequired',
    );
    // Only an explicit choice makes it run unattended, and a question may be added there too.
    await whole(s, {});
    expect(s.snapshot.enrollment!.consents[0]).not.toHaveProperty('askTools');
    await whole(s, { warehouse: ['export'] });
    expect(s.snapshot.enrollment!.consents[0].askTools).toEqual(['export']);
    // A question about a server the grant does not hold is not one it can keep.
    const view = await s.service.view(identity);
    await expect(
      s.service.confirm(identity, {
        offerDigest: view.offer!.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: {},
        everything: true,
        ask: { elsewhere: ['query'] },
      }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
  });
});

describe('a selection of every tool on a declared server, in a grant that lists its tools', () => {
  const marker = 'sys__all__sys';
  const every: ScheduledMCPTarget = {
    ...target,
    permittedTools: [{ agentId: 'root', tools: [marker] }],
    policyRevision: 'p3',
  };
  const call = (tool: string, agentId = 'root', digest = 'a'.repeat(64)) => ({
    ...request('invoke'),
    selection: { agentId, tools: [tool] },
    definitions: { [tool]: digest },
  });
  const refused = (reason: string) => ({ state: 'denied', failure: { reason } });

  it('is one item the owner may tick, and then stands for every tool there', async () => {
    const s = setup();
    s.changeTarget(every);
    expect((await s.service.view(identity)).targets[0].permittedTools).toEqual([
      { agentId: 'root', tools: [marker] },
    ]);
    await s.enroll({ warehouse: [marker] });
    expect(s.snapshot.enrollment).not.toHaveProperty('everything');
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
    });
    expect(await s.service.authority.authorize(call('anything'), {})).toMatchObject({
      state: 'authorized',
    });
    // For the agent it was ticked for, and no other.
    expect(await s.service.authority.authorize(call('query', 'child'), {})).toMatchObject(
      refused('tool_policy_denied'),
    );
    // A tool used under it is pinned like any other, and refused once it changes.
    expect(s.snapshot.enrollment!.consents[0].definitions).toEqual(
      expect.arrayContaining([expect.objectContaining({ tool: 'query' })]),
    );
    expect(
      await s.service.authority.authorize(call('query', 'root', 'b'.repeat(64)), {}),
    ).toMatchObject(refused('binding_mismatch'));
  });

  it('still fits when the agents go back to naming their tools, and the reverse', async () => {
    const s = setup();
    s.changeTarget(every);
    await s.enroll({ warehouse: [marker] });
    // The owner allowed everything there: whatever the agent selects now is within it.
    s.changeTarget(target);
    expect((await s.service.view(identity)).state).toBe('active');
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
    });
    // A grant of one named tool, once the agent selects the whole server: that tool, no more.
    const named = setup();
    await named.enroll({ warehouse: ['query'] });
    named.changeTarget({
      ...every,
      permittedTools: [
        { agentId: 'root', tools: [marker] },
        { agentId: 'child', tools: [marker] },
      ],
    });
    expect((await named.service.view(identity)).state).toBe('active');
    expect(await named.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
    });
    expect(await named.service.authority.authorize(call('export'), {})).toMatchObject(
      refused('tool_policy_denied'),
    );
  });

  it('keeps the pins of the tools used under it through a renewal, until their change is acknowledged', async () => {
    const s = setup();
    s.changeTarget(every);
    await s.enroll({ warehouse: [marker] });
    await s.service.authority.authorize(call('query'), {});
    const pinned = () => s.snapshot.enrollment!.consents[0];
    expect(pinned().definitions).toEqual([{ tool: 'query', digest: 'a'.repeat(64) }]);
    // Renewed as it is: the tool is not named in the grant, and its pin is still kept.
    await s.enroll({ warehouse: [marker] });
    expect(pinned().definitions).toEqual([{ tool: 'query', digest: 'a'.repeat(64) }]);
    const changed = call('query', 'root', 'b'.repeat(64));
    expect(await s.service.authority.authorize(changed, {})).toMatchObject(
      refused('binding_mismatch'),
    );
    expect((await s.service.view(identity)).changed).toEqual({ warehouse: ['query'] });
    // Confirming again with the change in view is allowing the new definition.
    await s.enroll({ warehouse: [marker] });
    expect(pinned()).not.toHaveProperty('definitions');
    expect(await s.service.authority.authorize(changed, {})).toMatchObject({
      state: 'authorized',
    });
  });

  it('keeps a question about a tool it still covers after the agent that named the tool drops it', async () => {
    const both: ScheduledMCPTarget = {
      ...target,
      permittedTools: [
        { agentId: 'child', tools: ['query'] },
        { agentId: 'root', tools: [marker] },
      ],
      policyRevision: 'p4',
    };
    const s = setup();
    s.changeTarget(both);
    // The owner approves each use of `query`, which the root reaches through the whole server.
    await s.enroll({ warehouse: ['query', marker] }, { warehouse: ['query'] });
    // The child stops naming it. The root still has it.
    s.changeTarget(every);
    const view = await s.service.view(identity);
    await s.service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow: { warehouse: [marker] },
    });
    expect(s.snapshot.enrollment!.consents[0].askTools).toEqual(['query']);
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
      approvalRequired: true,
    });
    // Without the whole server, a question about a tool that is no longer allowed is dropped.
    const named = setup();
    named.changeTarget(both);
    await named.enroll({ warehouse: ['query'] }, { warehouse: ['query'] });
    named.changeTarget({
      ...target,
      permittedTools: [{ agentId: 'child', tools: ['export'] }],
      policyRevision: 'p5',
    });
    const next = await named.service.view(identity);
    await named.service.confirm(identity, {
      offerDigest: next.offer!.digest,
      expectedRevision: next.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['export'] },
    });
    expect(named.snapshot.enrollment!.consents[0]).not.toHaveProperty('askTools');
  });

  it('cannot be asked about: it names no tool to pause for', async () => {
    const s = setup();
    s.changeTarget(every);
    const view = await s.service.view(identity);
    await expect(
      s.service.confirm(identity, {
        offerDigest: view.offer!.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: { warehouse: [marker] },
        ask: { warehouse: [marker] },
      }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
  });
});

describe('a grant of the whole agent, where it cannot be made', () => {
  it('is not offered, and is refused, where a grant limits MCP tools only', async () => {
    const s = setup();
    const service = createScheduleMCPConsentService({
      storage: s.storage,
      canUse: async () => true,
      getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
      resolveEnrollment: async () => [structuredClone(target)],
      now: () => 1000,
    });
    const view = await service.view(identity);
    expect(view.offer).not.toHaveProperty('everything');
    await expect(
      service.confirm(identity, {
        offerDigest: view.offer!.digest,
        expectedRevision: view.revision,
        lifetimeHours: 1,
        allow: {},
        everything: true,
      }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
  });

  it('is built for a schedule being created, whatever the agent has', async () => {
    const s = setup();
    s.changeTarget();
    const offer = await s.service.draft(identity);
    expect(offer.offer).toMatchObject({ everything: true });
    const grant = await s.service.grant(identity, {
      offerDigest: offer.offer!.digest,
      lifetimeHours: 2,
      allow: {},
      everything: true,
    });
    expect(grant).toMatchObject({
      everything: true,
      consents: [],
      absoluteExpiresAtMs: 1000 + 2 * 3_600_000,
    });
  });
});

describe('a grant made again with an edit of the schedule', () => {
  it('is decided like a confirmation, for the revision the edit makes, and stores nothing', async () => {
    const s = setup();
    await s.enroll({ warehouse: ['query'] }, { warehouse: ['query'] });
    await s.service.authority.authorize(
      { ...request('invoke'), definitions: { query: 'a'.repeat(64) } },
      {},
    );
    const before = structuredClone(s.snapshot.enrollment!);
    const view = await s.service.view(identity);
    const choice = {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 2,
      allow: { warehouse: ['query'] },
    };
    jest.mocked(s.storage.confirmScheduleMCPConsent).mockClear();
    const { enrollment: renewed, basis } = await s.service.renew(identity, choice, 1);
    // What it was decided against goes with it, so the write can refuse anything newer.
    expect(basis).toEqual(before);
    expect(renewed).toMatchObject({
      scheduleRevision: 1,
      absoluteExpiresAtMs: 1000 + 2 * 3_600_000,
      // What the stored grant asks about and has pinned comes with it.
      consents: [{ askTools: ['query'], definitions: [{ tool: 'query' }] }],
    });
    expect(renewed.revision).not.toBe(before.revision);
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
    expect(s.snapshot.enrollment).toEqual(before);
    // The same checks: another grant than the one the owner saw, or an offer that moved.
    await expect(
      s.service.renew(identity, { ...choice, expectedRevision: 'other' }, 1),
    ).rejects.toMatchObject({ code: 'consent_changed' });
    await expect(
      s.service.renew(identity, { ...choice, allow: { warehouse: ['purge'] } }, 1),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
    s.deny();
    await expect(s.service.renew(identity, choice, 1)).rejects.toMatchObject({
      code: 'consent_forbidden',
    });
  });

  it('is refused when the grant is revoked while it is being decided', async () => {
    const s = setup();
    await s.enroll();
    const view = await s.service.view(identity);
    const choice = {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    };
    // The decision reads the grant twice. The owner revokes it, in another tab, in between.
    const read = jest.mocked(s.storage.readScheduleMCPConsent);
    const stored = read.getMockImplementation()!;
    let reads = 0;
    read.mockImplementation(async (...args) => {
      if (++reads === 2) await s.service.revoke(identity, view.revision!);
      return stored(...args);
    });
    await expect(s.service.renew(identity, choice, 1)).rejects.toMatchObject({
      code: 'consent_changed',
    });
    expect(reads).toBeGreaterThanOrEqual(2);
    // And it stays revoked: nothing was returned for the edit to write over it.
    expect(s.snapshot.enrollment!.revokedAtMs).not.toBeNull();
  });

  it('is made for the revision of the edit when the edit moves the schedule to another agent', async () => {
    const s = setup();
    const offer = await s.service.draft(identity);
    const grant = await s.service.grant(
      identity,
      { offerDigest: offer.offer!.digest, lifetimeHours: 1, allow: {}, everything: true },
      { revision: 5 },
    );
    expect(grant).toMatchObject({ scheduleRevision: 5, everything: true });
  });
});

describe('definition pins', () => {
  const first = 'a'.repeat(64);
  const second = 'b'.repeat(64);
  const use = (digest: string, tool = 'query') => ({
    ...request('invoke'),
    selection: { agentId: 'root', tools: [tool] },
    definitions: { [tool]: digest },
  });
  const consent = (s: ReturnType<typeof setup>) => s.snapshot.enrollment!.consents[0];

  it('pins a tool on first use and refuses it once the definition differs', async () => {
    const s = setup();
    await s.enroll();
    expect(consent(s).definitions).toBeUndefined();
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'authorized',
    });
    expect(consent(s).definitions).toEqual([{ tool: 'query', digest: first }]);
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'authorized',
    });
    expect(await s.service.authority.authorize(use(second), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch', recovery: 'authorize' },
    });
    expect(consent(s).definitions).toEqual([{ tool: 'query', digest: first }]);
    expect(await s.service.view(identity)).toMatchObject({
      state: 'changed',
      changed: { warehouse: ['query'] },
    });
  });

  it('keeps a changed tool refused after the server restores the old definition', async () => {
    const s = setup();
    await s.enroll();
    await s.service.authority.authorize(use(first), {});
    await s.service.authority.authorize(use(second), {});
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
  });

  it('refuses only the changed tool and still mints for the server', async () => {
    const s = setup();
    s.changeTarget({ ...target, permittedTools: [{ agentId: 'root', tools: ['list', 'query'] }] });
    await s.enroll({ warehouse: ['list', 'query'] });
    await s.service.authority.authorize(use(first), {});
    await s.service.authority.authorize(use(second), {});
    expect(await s.service.authority.authorize(use(first, 'list'), {})).toMatchObject({
      state: 'authorized',
    });
    expect(
      await s.service.authority.authorize(
        { ...request('mint'), selection: { agentId: 'root', tools: ['list', 'query'] } },
        {},
      ),
    ).toMatchObject({ state: 'authorized' });
  });

  it('carries pins through a renewal and re-pins a changed tool the owner allows again', async () => {
    const s = setup();
    s.changeTarget({ ...target, permittedTools: [{ agentId: 'root', tools: ['list', 'query'] }] });
    await s.enroll({ warehouse: ['list', 'query'] });
    await s.service.authority.authorize(use(first), {});
    await s.service.authority.authorize(use(first, 'list'), {});
    await s.service.authority.authorize(use(second), {});
    const renewed = await s.enroll({ warehouse: ['list', 'query'] });
    expect(renewed).toMatchObject({ state: 'active', changed: {} });
    // `list` keeps its pin, so a definition swapped before the renewal is still caught.
    expect(consent(s).definitions).toEqual([{ tool: 'list', digest: first }]);
    expect(await s.service.authority.authorize(use(second, 'list'), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    expect(await s.service.authority.authorize(use(second), {})).toMatchObject({
      state: 'authorized',
    });
    expect(consent(s).definitions).toContainEqual({ tool: 'query', digest: second });
  });

  it('drops pins when the grant moves to a different recipient', async () => {
    const s = setup();
    await s.enroll();
    await s.service.authority.authorize(use(first), {});
    s.changeTarget({
      ...target,
      resource: { ...target.resource, url: 'https://other.example/mcp' },
    });
    await s.enroll();
    expect(consent(s).definitions).toBeUndefined();
  });

  it('accepts a pin another replica wrote first only when it matches', async () => {
    const s = setup();
    await s.enroll();
    const lose = (digest: string) =>
      jest
        .mocked(s.storage.pinScheduleMCPToolDefinition)
        .mockImplementationOnce(async ({ tool }) => {
          consent(s).definitions = [{ tool, digest }];
          return false;
        });
    lose(first);
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'authorized',
    });
    consent(s).definitions = undefined;
    lose(second);
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    // The loser marks the tool, so the definition that won the race is refused as well.
    expect(consent(s).changedTools).toEqual(['query']);
    expect(await s.service.authority.authorize(use(second), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    expect(await s.service.view(identity)).toMatchObject({
      state: 'changed',
      changed: { warehouse: ['query'] },
    });
  });

  it('does not let a dialog opened before a tool was marked confirm past the mark', async () => {
    const s = setup();
    await s.enroll();
    await s.service.authority.authorize(use(first), {});
    const opened = await s.service.view(identity);
    // A run sees a different definition while the dialog is open.
    await s.service.authority.authorize(use(second), {});
    const stale = {
      offerDigest: opened.offer!.digest,
      expectedRevision: opened.revision,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
    };
    jest.mocked(s.storage.confirmScheduleMCPConsent).mockClear();
    await expect(s.service.confirm(identity, stale)).rejects.toMatchObject({
      code: 'consent_changed',
    });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
    expect(consent(s).changedTools).toEqual(['query']);
    // Read again, the owner is shown the mark and can decide.
    const shown = await s.service.view(identity);
    expect(shown.offer!.digest).not.toBe(opened.offer!.digest);
    expect(shown.changed).toEqual({ warehouse: ['query'] });
    await expect(
      s.service.confirm(identity, { ...stale, offerDigest: shown.offer!.digest }),
    ).resolves.toMatchObject({ state: 'active', changed: {} });
  });

  it('keeps the digest of an offer in which nothing is marked', async () => {
    const s = setup();
    const before = await s.service.view(identity);
    await s.enroll();
    await s.service.authority.authorize(use(first), {});
    // Pinning is not a change the owner has to look at again.
    expect((await s.service.view(identity)).offer!.digest).toBe(before.offer!.digest);
  });

  /** Runs `between` after the next use has read the grant and before it is admitted. */
  const beforeAdmission = (s: ReturnType<typeof setup>, between: () => Promise<unknown>) => {
    const admit = jest.mocked(s.storage.admitScheduleMCPConsent);
    const real = admit.getMockImplementation()!;
    admit.mockImplementationOnce(async (input) => {
      await between();
      return real(input);
    });
  };

  it('refuses a use whose tool was marked after it read the grant', async () => {
    const s = setup();
    await s.enroll();
    await s.service.authority.authorize(use(first), {});
    // Another use sees a different definition and marks the tool before this one is admitted.
    beforeAdmission(s, () => s.service.authority.authorize(use(second), {}));
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    expect(consent(s).changedTools).toEqual(['query']);
  });

  it('refuses and marks a first use that another first use beat with a different definition', async () => {
    const s = setup();
    await s.enroll();
    beforeAdmission(s, () => s.service.authority.authorize(use(second), {}));
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
    expect(consent(s)).toMatchObject({
      definitions: [{ tool: 'query', digest: second }],
      changedTools: ['query'],
    });
    expect(s.storage.pinScheduleMCPToolDefinition).toHaveBeenCalledTimes(1);
  });

  it('does not let a confirmation drop a pin or a mark stored while it was being made', async () => {
    const s = setup();
    s.changeTarget({ ...target, permittedTools: [{ agentId: 'root', tools: ['list', 'query'] }] });
    await s.enroll({ warehouse: ['list', 'query'] });
    await s.service.authority.authorize(use(first), {});
    const confirm = jest.mocked(s.storage.confirmScheduleMCPConsent);
    const real = confirm.getMockImplementation()!;
    const during = (run: () => Promise<unknown>) =>
      confirm.mockImplementationOnce(async (input) => {
        await run();
        return real(input);
      });
    // `list` is used for the first time after the confirmation read the grant.
    during(() => s.service.authority.authorize(use(first, 'list'), {}));
    await expect(s.enroll({ warehouse: ['list', 'query'] })).rejects.toMatchObject({
      code: 'consent_changed',
    });
    expect(consent(s).definitions).toEqual([
      { tool: 'query', digest: first },
      { tool: 'list', digest: first },
    ]);
    // `query` is marked after the confirmation checked what the owner was shown.
    during(() => s.service.authority.authorize(use(second), {}));
    await expect(s.enroll({ warehouse: ['list', 'query'] })).rejects.toMatchObject({
      code: 'consent_changed',
    });
    expect(consent(s).changedTools).toEqual(['query']);
    await expect(s.enroll({ warehouse: ['list'] })).resolves.toMatchObject({ state: 'active' });
    expect(consent(s).definitions).toEqual([{ tool: 'list', digest: first }]);
  });

  it('does not authorize a first use whose pin could not be stored', async () => {
    const s = setup();
    await s.enroll();
    jest.mocked(s.storage.pinScheduleMCPToolDefinition).mockResolvedValueOnce(false);
    expect(await s.service.authority.authorize(use(first), {})).toMatchObject({
      state: 'denied',
      failure: { reason: 'binding_mismatch' },
    });
  });
});

it('requires a grant only from a schedule that has none', async () => {
  const s = setup();
  expect(await s.service.requiresGrant(identity)).toBe(false);
  s.snapshot.required = true;
  expect(await s.service.requiresGrant(identity)).toBe(true);
  await s.enroll();
  // The edit mark outlives the grant. Revoking it is then a refusal of its own, not this one.
  expect(await s.service.requiresGrant(identity)).toBe(false);
});

describe('tools the owner approves call by call', () => {
  const both = { ...target, permittedTools: [{ agentId: 'root', tools: ['list', 'query'] }] };
  const call = (tool: string) => ({
    ...request('invoke'),
    selection: { agentId: 'root', tools: [tool] },
    definitions: { [tool]: 'a'.repeat(64) },
  });

  it('stores them on the grant, reports them, and says so on each use', async () => {
    const s = setup();
    s.changeTarget(both);
    const view = await s.enroll({ warehouse: ['list', 'query'] }, { warehouse: ['query'] });
    expect(view).toMatchObject({ state: 'active', asking: { warehouse: ['query'] } });
    expect(s.snapshot.enrollment!.consents[0].askTools).toEqual(['query']);
    expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
      state: 'authorized',
      approvalRequired: true,
    });
    const allowed = await s.service.authority.authorize(call('list'), {});
    expect(allowed).toMatchObject({ state: 'authorized' });
    expect(allowed).not.toHaveProperty('approvalRequired');
    // Minting a credential calls nothing, so nothing is asked.
    expect(
      await s.service.authority.authorize(
        { ...request('mint'), selection: { agentId: 'root', tools: ['list', 'query'] } },
        {},
      ),
    ).not.toHaveProperty('approvalRequired');
  });

  it('stores nothing when the owner asks about no tool', async () => {
    const s = setup();
    expect(await s.enroll({ warehouse: ['query'] }, { warehouse: [] })).toMatchObject({
      asking: {},
    });
    expect(s.snapshot.enrollment!.consents[0]).not.toHaveProperty('askTools');
  });

  it.each([
    ['a tool that is not allowed', { warehouse: ['list'] }],
    ['a server that is not in the grant', { other: ['query'] }],
  ])('rejects asking about %s without writing', async (_case, ask) => {
    const s = setup();
    s.changeTarget(both);
    await expect(s.enroll({ warehouse: ['query'] }, ask)).rejects.toMatchObject({
      code: 'consent_invalid',
    });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
  });

  it('rejects it where a scheduled run cannot pause, and tells the dialog so', async () => {
    const s = setup();
    s.cannotPause();
    expect(await s.service.view(identity)).toMatchObject({ approval: false });
    await expect(
      s.enroll({ warehouse: ['query'] }, { warehouse: ['query'] }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
    expect(s.storage.confirmScheduleMCPConsent).not.toHaveBeenCalled();
    expect(await s.enroll({ warehouse: ['query'] })).toMatchObject({ state: 'active' });
  });

  it('keeps what the grant asks about when a confirmation does not say, and clears it when told to', async () => {
    const s = setup();
    s.changeTarget(both);
    await s.enroll({ warehouse: ['list', 'query'] }, { warehouse: ['list', 'query'] });
    // A client that does not send `ask` renews the grant; a tool it drops is no longer asked about.
    expect(await s.enroll({ warehouse: ['query'] })).toMatchObject({
      asking: { warehouse: ['query'] },
    });
    expect(await s.enroll({ warehouse: ['query'] }, {})).toMatchObject({ asking: {} });
    expect(s.snapshot.enrollment!.consents[0]).not.toHaveProperty('askTools');
  });

  it('keeps a stored question through a renewal where a run can no longer pause', async () => {
    const s = setup();
    s.changeTarget(both);
    await s.enroll({ warehouse: ['list', 'query'] }, { warehouse: ['query'] });
    s.cannotPause();
    // Renewed as it is, `query` still waits for the owner: it does not start running unattended.
    for (const ask of [undefined, { warehouse: ['query'] }]) {
      expect(await s.enroll({ warehouse: ['list', 'query'] }, ask)).toMatchObject({
        state: 'active',
        asking: { warehouse: ['query'] },
        approval: false,
      });
      expect(await s.service.authority.authorize(call('query'), {})).toMatchObject({
        approvalRequired: true,
      });
    }
    // A new question cannot be added here, and the owner can still drop the stored one.
    await expect(
      s.enroll({ warehouse: ['list', 'query'] }, { warehouse: ['list', 'query'] }),
    ).rejects.toMatchObject({ code: 'consent_invalid' });
    expect(await s.enroll({ warehouse: ['list', 'query'] }, {})).toMatchObject({ asking: {} });
  });
});
