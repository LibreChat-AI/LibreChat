import type {
  ScheduledMCPConsent,
  ScheduledMCPFailure,
  ScheduledMCPIdentity,
  ScheduledMCPResource,
  ScheduledMCPConsentLookupResult,
  ScheduledMCPAuthorizationRequest,
} from './contract';

export interface AuthorizationFacts {
  readonly nowMs: number;
  readonly consent: ScheduledMCPConsentLookupResult;
  readonly rbac: 'allowed' | 'denied' | 'unavailable';
  readonly scheduleActive: boolean;
  readonly graphAgentIds: readonly string[];
  readonly policyRevision: string;
  readonly classifications: readonly {
    agentId: string;
    tool: string;
    effect: 'read' | 'write' | 'unknown';
    source: 'host' | 'server_hint';
  }[];
  readonly approvalRequired: boolean;
  readonly providerInstalled: boolean;
  readonly resourceAcceptanceVerified: boolean;
}

export interface AuthorizationStep {
  readonly stage: ScheduledMCPAuthorizationRequest['stage'];
  readonly facts: AuthorizationFacts;
  readonly expected: 'authorized' | 'cancelled' | ScheduledMCPFailure['reason'];
  readonly aborted?: boolean;
}

export interface AuthorizationFixture {
  readonly id: string;
  readonly request: Omit<ScheduledMCPAuthorizationRequest, 'stage'>;
  readonly steps: readonly AuthorizationStep[];
}

const identity: ScheduledMCPIdentity = {
  scheduleId: 'schedule-1',
  ownerId: 'owner-1',
  tenantId: 'tenant-1',
  agentId: 'root-agent',
  invocationMode: 'delegated',
};
const resource: ScheduledMCPResource = {
  serverName: 'warehouse',
  url: 'https://warehouse.example/mcp',
  configurationRevision: 'configuration-1',
  credentialMode: 'resource_bearer',
  issuer: 'https://issuer.example/',
  audience: 'warehouse-api',
  scopes: ['query.read'],
};
const consent: ScheduledMCPConsent = {
  id: 'consent-1',
  revision: 'consent-revision-1',
  identity,
  resource,
  permittedTools: [
    { agentId: 'root-agent', tools: ['query'] },
    { agentId: 'child-agent', tools: ['query'] },
  ],
  policyRevision: 'policy-1',
  grantedAtMs: 1_000,
  absoluteExpiresAtMs: 10_000,
  revokedAtMs: null,
};
const facts: AuthorizationFacts = {
  nowMs: 2_000,
  consent: { state: 'found', consent },
  rbac: 'allowed',
  scheduleActive: true,
  graphAgentIds: ['root-agent', 'child-agent'],
  policyRevision: 'policy-1',
  classifications: [
    { agentId: 'root-agent', tool: 'query', effect: 'read', source: 'host' },
    { agentId: 'child-agent', tool: 'query', effect: 'read', source: 'host' },
  ],
  approvalRequired: false,
  providerInstalled: true,
  resourceAcceptanceVerified: true,
};
const request: AuthorizationFixture['request'] = {
  identity,
  resource,
  selection: { agentId: 'root-agent', tools: ['query'] },
};
const stages: readonly AuthorizationStep['stage'][] = ['activation', 'mint', 'invoke', 'resume'];

function fixture(
  id: string,
  expected: AuthorizationStep['expected'],
  currentFacts: AuthorizationFacts = facts,
  currentRequest: AuthorizationFixture['request'] = request,
): AuthorizationFixture {
  return {
    id,
    request: currentRequest,
    steps: stages.map((stage) => ({ stage, facts: currentFacts, expected })),
  };
}

function changedConsent(change: Partial<ScheduledMCPConsent>): AuthorizationFacts {
  return { ...facts, consent: { state: 'found', consent: { ...consent, ...change } } };
}

export const authorizationFixtures: readonly AuthorizationFixture[] = [
  fixture('bound-root', 'authorized'),
  fixture('bound-child', 'authorized', facts, {
    ...request,
    selection: { agentId: 'child-agent', tools: ['query'] },
  }),
  fixture(
    'single-tenant',
    'authorized',
    changedConsent({ identity: { ...identity, tenantId: null } }),
    {
      ...request,
      identity: { ...identity, tenantId: null },
    },
  ),
  fixture('missing-consent', 'consent_missing', { ...facts, consent: { state: 'missing' } }),
  fixture('consent-store-outage', 'dependency_unavailable', {
    ...facts,
    consent: { state: 'unavailable' },
  }),
  fixture('just-before-deadline', 'authorized', { ...facts, nowMs: 9_999 }),
  fixture('expired-at-deadline', 'consent_expired', { ...facts, nowMs: 10_000 }),
  fixture('expired-after-deadline', 'consent_expired', { ...facts, nowMs: 10_001 }),
  fixture(
    'nonfinite-deadline',
    'binding_mismatch',
    changedConsent({ absoluteExpiresAtMs: Number.NaN }),
  ),
  fixture(
    'deadline-before-grant',
    'binding_mismatch',
    changedConsent({ absoluteExpiresAtMs: 500 }),
  ),
  fixture('revoked', 'consent_revoked', changedConsent({ revokedAtMs: 1_999 })),
  ...(['scheduleId', 'ownerId', 'tenantId', 'agentId'] as const).map((key) =>
    fixture(`changed-${key}`, 'binding_mismatch', facts, {
      ...request,
      identity: { ...identity, [key]: 'different' },
    }),
  ),
  fixture('missing-tenant-is-not-a-match', 'binding_mismatch', facts, {
    ...request,
    identity: { ...identity, tenantId: null },
  }),
  ...(['url', 'configurationRevision', 'issuer', 'audience', 'serverName'] as const).map((key) =>
    fixture(`changed-${key}`, 'binding_mismatch', facts, {
      ...request,
      resource: { ...resource, [key]: 'different' },
    }),
  ),
  fixture('changed-scopes', 'binding_mismatch', facts, {
    ...request,
    resource: { ...resource, scopes: ['query.read', 'query.write'] },
  }),
  fixture('changed-mode', 'binding_mismatch', facts, {
    ...request,
    resource: { ...resource, credentialMode: 'renewable_obo' },
  }),
  fixture('revoked-rbac', 'rbac_denied', { ...facts, rbac: 'denied' }),
  fixture('rbac-store-outage', 'dependency_unavailable', { ...facts, rbac: 'unavailable' }),
  fixture('inactive-schedule', 'binding_mismatch', { ...facts, scheduleActive: false }),
  fixture(
    'child-no-longer-reachable',
    'binding_mismatch',
    {
      ...facts,
      graphAgentIds: ['root-agent'],
    },
    { ...request, selection: { agentId: 'child-agent', tools: ['query'] } },
  ),
  fixture('changed-trusted-policy', 'binding_mismatch', { ...facts, policyRevision: 'policy-2' }),
  fixture('empty-tool-selection', 'tool_policy_denied', facts, {
    ...request,
    selection: { agentId: 'root-agent', tools: [] },
  }),
  fixture('new-tool-not-enrolled', 'tool_policy_denied', facts, {
    ...request,
    selection: { agentId: 'root-agent', tools: ['query', 'delete'] },
  }),
  ...(['write', 'unknown'] as const).map((effect) =>
    fixture(`tool-effect-${effect}`, 'tool_policy_denied', {
      ...facts,
      classifications: [{ agentId: 'root-agent', tool: 'query', effect, source: 'host' }],
    }),
  ),
  fixture('server-readonly-hint-is-not-authority', 'tool_policy_denied', {
    ...facts,
    classifications: [
      { agentId: 'root-agent', tool: 'query', effect: 'read', source: 'server_hint' },
    ],
  }),
  fixture('unclassified-tool', 'tool_policy_denied', { ...facts, classifications: [] }),
  fixture('approval-needed-headlessly', 'approval_required', { ...facts, approvalRequired: true }),
  fixture('missing-provider', 'provider_missing', { ...facts, providerInstalled: false }),
  fixture('resource-not-certified', 'resource_unverified', {
    ...facts,
    resourceAcceptanceVerified: false,
  }),
  fixture(
    'browser-bearer-not-headless',
    'unsupported_mode',
    changedConsent({ resource: { ...resource, credentialMode: 'browser_bearer' } }),
    { ...request, resource: { ...resource, credentialMode: 'browser_bearer' } },
  ),
  ...(['stored_oauth', 'renewable_obo', 'static', 'anonymous'] as const).map((credentialMode) => {
    const target = {
      ...resource,
      credentialMode,
      ...((credentialMode === 'static' || credentialMode === 'anonymous') && {
        issuer: null,
        audience: null,
        scopes: [],
      }),
    };
    return fixture(
      `candidate-${credentialMode}`,
      'authorized',
      changedConsent({ resource: target }),
      {
        ...request,
        resource: target,
      },
    );
  }),
  {
    id: 'cancelled-before-admission',
    request,
    steps: stages.map((stage) => ({ stage, facts, expected: 'cancelled', aborted: true })),
  },
  {
    id: 'revocation-after-mint',
    request,
    steps: [
      { stage: 'mint', facts, expected: 'authorized' },
      {
        stage: 'invoke',
        facts: changedConsent({ revokedAtMs: 2_000 }),
        expected: 'consent_revoked',
      },
      {
        stage: 'resume',
        facts: changedConsent({ revokedAtMs: 2_000 }),
        expected: 'consent_revoked',
      },
    ],
  },
  {
    id: 'expiry-during-approval-pause',
    request,
    steps: [
      { stage: 'invoke', facts, expected: 'authorized' },
      { stage: 'resume', facts: { ...facts, nowMs: 10_000 }, expected: 'consent_expired' },
    ],
  },
];

export { failureFixtures } from './failures';
