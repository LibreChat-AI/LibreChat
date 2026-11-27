import {
  subscriptionIdentitySchema,
  subscriptionEnrollmentSchema,
  SUBSCRIPTION_APPROVAL_REASON,
  SCHEDULE_APPROVAL_REASON,
} from './runGrant';

const identity = {
  subscriptionId: 'sub_1',
  ownerId: 'owner',
  tenantId: null,
  agentId: 'agent_1',
  invocationMode: 'delegated' as const,
};

const whole = {
  version: 1 as const,
  scheduleRevision: 0,
  revision: 'grant-1',
  consents: [],
  everything: true as const,
  grantedAtMs: 1000,
  absoluteExpiresAtMs: 2000,
};

describe('a subscription as the subject of a grant', () => {
  it('is named by its id, owner, tenant and agent, and nothing else', () => {
    expect(subscriptionIdentitySchema.parse(identity)).toEqual(identity);
    expect(subscriptionIdentitySchema.safeParse({ ...identity, tenantId: 'tenant' }).success).toBe(
      true,
    );
    for (const field of ['subscriptionId', 'ownerId', 'tenantId', 'agentId', 'invocationMode']) {
      const { [field as keyof typeof identity]: _left, ...rest } = identity;
      expect(subscriptionIdentitySchema.safeParse(rest).success).toBe(false);
    }
    expect(subscriptionIdentitySchema.safeParse({ ...identity, keyId: 'key' }).success).toBe(false);
    expect(
      subscriptionIdentitySchema.safeParse({ ...identity, invocationMode: 'owner' }).success,
    ).toBe(false);
    expect(subscriptionIdentitySchema.safeParse({ ...identity, subscriptionId: ' ' }).success).toBe(
      false,
    );
  });

  it('holds a grant of the whole agent or of listed tools, and none that allows nothing', () => {
    expect(subscriptionEnrollmentSchema.safeParse(whole).success).toBe(true);
    expect(
      subscriptionEnrollmentSchema.safeParse({
        ...whole,
        everything: undefined,
        tools: [{ agentId: 'agent_1', tools: ['web_search'] }],
      }).success,
    ).toBe(true);
    expect(
      subscriptionEnrollmentSchema.safeParse({ ...whole, everything: undefined }).success,
    ).toBe(false);
    expect(subscriptionEnrollmentSchema.safeParse({ ...whole, version: 2 }).success).toBe(false);
  });

  it('refuses a consent made out to a schedule or a key', () => {
    const consent = (to: object) => ({
      id: 'consent-1',
      revision: 'grant-1',
      identity: to,
      resource: {
        serverName: 'warehouse',
        url: 'https://warehouse.example/mcp',
        configurationRevision: 'config-1',
        credentialMode: 'static',
        issuer: null,
        audience: null,
        scopes: [],
      },
      permittedTools: [{ agentId: 'agent_1', tools: ['query'] }],
      policyRevision: 'policy-1',
      grantedAtMs: 1000,
      absoluteExpiresAtMs: 2000,
      revokedAtMs: null,
    });
    const { subscriptionId: _id, ...rest } = identity;
    expect(
      subscriptionEnrollmentSchema.safeParse({ ...whole, consents: [consent(identity)] }).success,
    ).toBe(true);
    for (const other of [
      { ...rest, scheduleId: 'schedule' },
      { ...rest, keyId: 'key' },
    ])
      expect(
        subscriptionEnrollmentSchema.safeParse({ ...whole, consents: [consent(other)] }).success,
      ).toBe(false);
  });

  it('has its own code for an approval its owner asked for', () => {
    expect(SUBSCRIPTION_APPROVAL_REASON).toBe('subscription_owner_approval');
    expect(SUBSCRIPTION_APPROVAL_REASON).not.toBe(SCHEDULE_APPROVAL_REASON);
  });
});
