import {
  MAX_SCHEDULED_MCP_SERVER_TOOLS,
  confirmScheduleMCPConsentSchema,
  scheduledMCPResourceSchema,
  scheduledMCPIdentitySchema,
  scheduledMCPEnrollmentSchema,
} from './scheduleConsent';
import { scheduleMCPOutcomeSchema, readScheduleMCPOutcomes } from './schedules';
import { configSchema } from '../config';

it('keeps scheduled consent opt-in and bounds its absolute lifetime', () => {
  const config = configSchema.parse({
    version: '1.3.8',
    interface: { schedules: { mcpConsent: {} } },
  });
  expect(config.interface?.schedules).toMatchObject({
    mcpConsent: {},
  });
  expect(
    configSchema.safeParse({
      version: '1.3.8',
      interface: { schedules: { mcpConsent: { maxLifetimeHours: 0 } } },
    }).success,
  ).toBe(false);
});
it('takes the deadline for never-authorized schedules as an instant with an offset', () => {
  const parse = (requireAfter: unknown) =>
    configSchema.safeParse({
      version: '1.3.8',
      interface: { schedules: { mcpConsent: { requireAfter } } },
    }).success;
  expect(parse('2027-01-01T00:00:00Z')).toBe(true);
  expect(parse('2027-01-01T00:00:00+02:00')).toBe(true);
  expect(parse('2027-01-01')).toBe(false);
  expect(parse('2027-01-01T00:00:00')).toBe(false);
  expect(parse(1798761600000)).toBe(false);
});

it('takes the tools to ask about as an optional choice beside the allowed ones', () => {
  const parse = (ask?: unknown) =>
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
      ...(ask !== undefined && { ask }),
    }).success;
  expect(parse()).toBe(true);
  expect(parse({ warehouse: ['query'] })).toBe(true);
  expect(parse({ warehouse: [] })).toBe(true);
  expect(parse(['query'])).toBe(false);
  expect(parse({ warehouse: 'query' })).toBe(false);
});

it('requires an explicit tenant binding and delegated mode', () => {
  const identity = { scheduleId: 's', ownerId: 'u', agentId: 'a', invocationMode: 'delegated' };
  expect(scheduledMCPIdentitySchema.safeParse(identity).success).toBe(false);
  expect(scheduledMCPIdentitySchema.safeParse({ ...identity, tenantId: null }).success).toBe(true);
  expect(
    scheduledMCPIdentitySchema.safeParse({
      ...identity,
      tenantId: null,
      invocationMode: 'autonomous',
    }).success,
  ).toBe(false);
});
it.each([
  'https://token:secret@example.com/mcp',
  'https://example.com/mcp?token=secret',
  'file:///tmp/mcp',
  'https://example.com/mcp#secret',
])('rejects unsafe resource binding %s', (url) => {
  expect(
    scheduledMCPResourceSchema.safeParse({
      serverName: 'server',
      url,
      configurationRevision: 'v1',
      credentialMode: 'anonymous',
      issuer: null,
      audience: null,
      scopes: [],
    }).success,
  ).toBe(false);
});
it('accepts only a reviewed offer reference and bounded duration from the owner', () => {
  const valid = {
    offerDigest: 'a'.repeat(64),
    expectedRevision: null,
    lifetimeHours: 1,
    allow: { warehouse: ['query'] },
  };
  expect(confirmScheduleMCPConsentSchema.safeParse(valid).success).toBe(true);
  expect(
    confirmScheduleMCPConsentSchema.safeParse({ ...valid, accessToken: 'secret' }).success,
  ).toBe(false);
  expect(
    confirmScheduleMCPConsentSchema.safeParse({ ...valid, lifetimeHours: Infinity }).success,
  ).toBe(false);
});
it('does not accept an unknown persisted consent version', () => {
  expect(
    scheduledMCPEnrollmentSchema.safeParse({ version: 2, revision: 'future', consents: [] })
      .success,
  ).toBe(false);
});

it('reads a grant with or without definition pins, and nothing but a digest as a pin', () => {
  const identity = {
    scheduleId: 'schedule',
    ownerId: 'owner',
    tenantId: 'tenant',
    agentId: 'root',
    invocationMode: 'delegated' as const,
  };
  const consent = {
    id: 'consent',
    revision: 'grant',
    identity,
    resource: {
      serverName: 'warehouse',
      url: 'https://warehouse.example/mcp',
      configurationRevision: 'v1',
      credentialMode: 'anonymous' as const,
      issuer: null,
      audience: null,
      scopes: [],
    },
    permittedTools: [{ agentId: 'root', tools: ['query'] }],
    policyRevision: 'p1',
    grantedAtMs: 1,
    absoluteExpiresAtMs: 2,
    revokedAtMs: null,
  };
  const parse = (extra: object) =>
    scheduledMCPEnrollmentSchema.safeParse({
      version: 1,
      scheduleRevision: 0,
      revision: 'grant',
      consents: [{ ...consent, ...extra }],
    }).success;
  expect(parse({})).toBe(true);
  expect(
    parse({ definitions: [{ tool: 'query', digest: 'a'.repeat(64) }], changedTools: ['query'] }),
  ).toBe(true);
  expect(parse({ definitions: [{ tool: 'query', digest: 'short' }] })).toBe(false);
  expect(
    parse({ definitions: [{ tool: 'query', digest: 'a'.repeat(64), description: 'text' }] }),
  ).toBe(false);
});

it.each([
  ['no choice at all', undefined],
  ['no servers', {}],
  ['only servers with no tools', { warehouse: [], archive: [] }],
  [
    'more servers than a grant can hold',
    Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`server-${index}`, ['query']])),
  ],
])('requires the owner to allow at least one tool: %s', (_label, allow) => {
  expect(
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow,
    }).success,
  ).toBe(false);
});

it('lets the owner allow every tool a server can be offered with, across its agents', () => {
  const parse = (count: number) =>
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: Array.from({ length: count }, (_, index) => `tool-${index}`) },
    }).success;
  // Two agents with 150 tools each: valid as an offer, so it must be confirmable whole.
  expect(parse(300)).toBe(true);
  expect(parse(MAX_SCHEDULED_MCP_SERVER_TOOLS)).toBe(true);
  expect(parse(MAX_SCHEDULED_MCP_SERVER_TOOLS + 1)).toBe(false);
});

it('accepts a server the owner left with no tools beside one with a choice', () => {
  expect(
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'], archive: [] },
    }).success,
  ).toBe(true);
});

it('no longer accepts the retired operator read-only list as schedule consent config', () => {
  const config = configSchema.parse({
    version: '1.3.8',
    interface: {
      schedules: {
        mcpConsent: {
          readOnlyPolicy: { warehouse: { tools: { query: { effect: 'read_only' } } } },
        },
      },
    },
  });
  expect(config.interface?.schedules).toEqual({ mcpConsent: {} });
});

it('keeps legacy statuses and projects only public-safe policy denial fields', () => {
  const outcome = {
    server: 'warehouse',
    status: 'mcp_permission_denied',
    reason: 'tool_policy_denied',
    recovery: 'configure',
    automaticReplay: false,
  };
  expect(scheduleMCPOutcomeSchema.parse({ ...outcome, providerResponse: 'secret' })).toEqual(
    outcome,
  );
  expect(readScheduleMCPOutcomes(`mcp_permission_denied: ${JSON.stringify([outcome])}`)).toEqual([
    outcome,
  ]);
  expect(scheduleMCPOutcomeSchema.safeParse({ server: 'warehouse', status: 'ready' }).success).toBe(
    true,
  );
  expect(scheduleMCPOutcomeSchema.safeParse({ ...outcome, automaticReplay: true }).success).toBe(
    false,
  );
});
