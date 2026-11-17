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
const jestPins = (pins: ReturnType<typeof pinStorage>) => ({
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
  let allowed = true;
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
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    resolveEnrollment: async () => targets,
    now: () => time,
  });
  const enroll = async (allow: Record<string, string[]> = { warehouse: ['query'] }) => {
    const view = await service.view(identity);
    return service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
      allow,
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
    deny: () => {
      allowed = false;
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
