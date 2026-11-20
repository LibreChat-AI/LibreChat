import {
  grantLifetime,
  MAX_SCHEDULED_MCP_SERVER_TOOLS,
  agentKeyMCPIdentitySchema,
  confirmScheduleMCPConsentSchema,
  scheduledMCPResourceSchema,
  scheduledMCPIdentitySchema,
  scheduledMCPEnrollmentSchema,
} from './scheduleConsent';
import {
  scheduleMCPOutcomeSchema,
  readScheduleMCPOutcomes,
  createSchedulePayloadSchema,
  updateSchedulePayloadSchema,
} from './schedules';
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

it('leaves API key runs unrestricted unless the operator asks for grants', () => {
  const parse = (integrations?: unknown) =>
    configSchema.safeParse({
      version: '1.3.8',
      endpoints: { agents: { remoteApi: { integrations } } },
    });
  const absent = parse();
  expect(absent.success).toBe(true);
  expect(absent.success && absent.data.endpoints?.agents?.remoteApi?.integrations).toBeUndefined();
  expect(
    parse({
      mode: 'delegated',
      maxLifetimeHours: 720,
      resources: {
        warehouse: {
          url: 'https://warehouse.example/mcp',
          credentialMode: 'stored_oauth',
          issuer: 'https://issuer.example/',
          audience: 'warehouse',
          scopes: ['read'],
        },
      },
    }).success,
  ).toBe(true);
  expect(parse({ mode: 'owner' }).success).toBe(true);
  expect(parse({ mode: 'anything' }).success).toBe(false);
  expect(parse({ mode: 'delegated', maxLifetimeHours: 0 }).success).toBe(false);
  expect(parse({ mode: 'delegated', resources: { warehouse: { url: 'not a url' } } }).success).toBe(
    false,
  );
});

it('describes a grant held by an API key by key, owner, tenant and agent', () => {
  const identity = {
    keyId: 'key',
    ownerId: 'owner',
    tenantId: null,
    agentId: 'agent_a',
    invocationMode: 'delegated',
  };
  expect(agentKeyMCPIdentitySchema.safeParse(identity).success).toBe(true);
  expect(agentKeyMCPIdentitySchema.safeParse({ ...identity, scheduleId: 's' }).success).toBe(false);
  expect(scheduledMCPIdentitySchema.safeParse(identity).success).toBe(false);
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

it('lets the owner ask first about as many tools as they can allow', () => {
  const parse = (count: number) => {
    const tools = Array.from({ length: count }, (_, index) => `tool-${index}`);
    return confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: tools },
      ask: { warehouse: tools },
    }).success;
  };
  expect(parse(300)).toBe(true);
  expect(parse(MAX_SCHEDULED_MCP_SERVER_TOOLS + 1)).toBe(false);
});

it("takes the owner's choice of tools that are not MCP tools, and stores it per agent", () => {
  const confirm = (tools?: unknown) =>
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: { warehouse: ['query'] },
      ...(tools !== undefined && { tools }),
    }).success;
  expect(confirm()).toBe(true);
  expect(confirm([])).toBe(true);
  expect(confirm(['execute_code', 'send_action_mail.example'])).toBe(true);
  expect(confirm({ execute_code: true })).toBe(false);
  expect(confirm([''])).toBe(false);

  const stored = (tools?: unknown) =>
    scheduledMCPEnrollmentSchema.safeParse({
      version: 1,
      revision: 'grant-1',
      scheduleRevision: 0,
      consents: [
        {
          id: 'consent-1',
          revision: 'grant-1',
          identity: {
            scheduleId: 's',
            ownerId: 'u',
            tenantId: null,
            agentId: 'root',
            invocationMode: 'delegated',
          },
          resource: {
            serverName: 'warehouse',
            url: 'https://warehouse.example/mcp',
            configurationRevision: 'v1',
            credentialMode: 'anonymous',
            issuer: null,
            audience: null,
            scopes: [],
          },
          permittedTools: [{ agentId: 'root', tools: ['query'] }],
          policyRevision: 'p1',
          grantedAtMs: 1,
          absoluteExpiresAtMs: 2,
          revokedAtMs: null,
        },
      ],
      ...(tools !== undefined && { tools }),
    }).success;
  // A grant made before these tools could be chosen has none, and reads as it did.
  expect(stored()).toBe(true);
  expect(stored([{ agentId: 'root', tools: ['execute_code'] }])).toBe(true);
  expect(stored([{ agentId: 'root', tools: [] }])).toBe(false);
  expect(stored(['execute_code'])).toBe(false);
});

it('takes a grant for other tools only, with a lifetime of its own', () => {
  const confirm = (allow: Record<string, string[]>, tools?: string[]) =>
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow,
      ...(tools && { tools }),
    }).success;
  // Something must be allowed, of either kind.
  expect(confirm({}, ['web_search'])).toBe(true);
  expect(confirm({ warehouse: [] }, ['web_search'])).toBe(true);
  expect(confirm({})).toBe(false);
  expect(confirm({ warehouse: [] }, [])).toBe(false);

  const stored = (fields: Record<string, unknown>) =>
    scheduledMCPEnrollmentSchema.safeParse({
      version: 1,
      revision: 'grant-1',
      scheduleRevision: 0,
      consents: [],
      ...fields,
    }).success;
  const tools = [{ agentId: 'root', tools: ['web_search'] }];
  expect(stored({ tools, grantedAtMs: 1, absoluteExpiresAtMs: 2, revokedAtMs: null })).toBe(true);
  // Neither an MCP server nor a tool, or no deadline anywhere: not a grant.
  expect(stored({ grantedAtMs: 1, absoluteExpiresAtMs: 2 })).toBe(false);
  expect(stored({ tools })).toBe(false);
  expect(grantLifetime({ consents: [], absoluteExpiresAtMs: 2, revokedAtMs: 1 })).toEqual({
    expiresAtMs: 2,
    revoked: true,
  });
  // A grant made before the lifetime was stored on it is read from its consents.
  expect(
    grantLifetime({
      consents: [
        { absoluteExpiresAtMs: 9, revokedAtMs: null },
        { absoluteExpiresAtMs: 5, revokedAtMs: null },
      ],
    }),
  ).toEqual({ expiresAtMs: 5, revoked: false });
});

it('takes a grant for the whole agent, with nothing chosen one by one', () => {
  const confirm = (fields: Record<string, unknown>) =>
    confirmScheduleMCPConsentSchema.safeParse({
      offerDigest: 'a'.repeat(64),
      expectedRevision: null,
      lifetimeHours: 1,
      allow: {},
      ...fields,
    }).success;
  expect(confirm({ everything: true })).toBe(true);
  expect(confirm({ everything: true, ask: { warehouse: ['export'] } })).toBe(true);
  // Either the whole agent or a choice, never a mix that could be read both ways.
  expect(confirm({ everything: true, allow: { warehouse: ['query'] } })).toBe(false);
  expect(confirm({ everything: true, tools: ['web_search'] })).toBe(false);
  expect(confirm({ everything: false })).toBe(false);

  const stored = (fields: Record<string, unknown>) =>
    scheduledMCPEnrollmentSchema.safeParse({
      version: 1,
      revision: 'grant-1',
      scheduleRevision: 0,
      consents: [],
      ...fields,
    }).success;
  // An agent with no MCP server and no other tool today can still be allowed in full.
  expect(stored({ everything: true, grantedAtMs: 1, absoluteExpiresAtMs: 2 })).toBe(true);
  expect(stored({ everything: true })).toBe(false);
  expect(stored({ everything: false, grantedAtMs: 1, absoluteExpiresAtMs: 2 })).toBe(false);
});

it('takes the choice with an edit, naming the stored grant or not, and never as the only field', () => {
  const choice = { offerDigest: 'a'.repeat(64), lifetimeHours: 1, allow: {}, everything: true };
  const edit = (authorization: unknown) =>
    updateSchedulePayloadSchema.safeParse({ name: 'renamed', authorization }).success;
  // The same agent: the schedule's own offer, and the grant it replaces.
  expect(edit({ ...choice, expectedRevision: 'grant-1' })).toBe(true);
  expect(edit({ ...choice, expectedRevision: null })).toBe(true);
  // Another agent: that agent's offer, as for a new schedule.
  expect(edit(choice)).toBe(true);
  expect(edit({ ...choice, everything: undefined })).toBe(false);
  // A new schedule has no grant to name.
  expect(
    createSchedulePayloadSchema.shape.authorization.safeParse({
      ...choice,
      expectedRevision: 'grant-1',
    }).success,
  ).toBe(false);
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
