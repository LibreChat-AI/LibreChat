import type { ScheduleMCPConsentStorage, ScheduleConsentSnapshot } from '@librechat/data-schemas';
import type { ScheduledMCPIdentity, ScheduledMCPTarget } from 'librechat-data-provider';
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
  let policy = true;
  const storage: ScheduleMCPConsentStorage = {
    readScheduleMCPConsent: jest.fn(async () => structuredClone(snapshot)),
    confirmScheduleMCPConsent: jest.fn(async (input) => {
      if (
        snapshot.configRevision !== input.expectedConfigRevision ||
        (snapshot.enrollment?.revision ?? null) !== input.expectedRevision
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
      async ({ revision }) =>
        snapshot.enabled &&
        snapshot.enrollment?.revision === revision &&
        snapshot.enrollment.consents.every(
          (c) => c.revokedAtMs == null && c.absoluteExpiresAtMs > time,
        ),
    ),
  };
  const service = createScheduleMCPConsentService({
    storage,
    canUse: async () => allowed,
    getLimits: async () => ({ enabled: true, maxLifetimeHours: 24 }),
    resolveEnrollment: async () => targets,
    checkToolPolicy: async () => policy,
    now: () => time,
  });
  const enroll = async () => {
    const view = await service.view(identity);
    return service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: view.revision,
      lifetimeHours: 1,
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
    changeTarget: (value: ScheduledMCPTarget) => {
      targets = [value];
    },
    deny: () => {
      allowed = false;
    },
    denyPolicy: () => {
      policy = false;
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
it('requires enrolled child tools and authoritative tool policy', async () => {
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
  s.denyPolicy();
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
    }),
  ).rejects.toMatchObject({ code: 'consent_invalid' });
  s.changeTarget({ ...target, policyRevision: 'p2' });
  await expect(
    s.service.confirm(identity, {
      offerDigest: view.offer!.digest,
      expectedRevision: null,
      lifetimeHours: 1,
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
