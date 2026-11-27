import { scheduleMCPOutcomeSchema } from 'librechat-data-provider';
import type { ScheduledMCPAuthorizationResult } from './contract';
import type { AuthorizationFixture } from './fixtures.helper';
import { authorizationFixtures, failureFixtures } from './fixtures.helper';
import { verifyAuthorizationFixture } from './conformance.helper';

/** Exercises the harness, not a production authorization implementation. */
function scriptedResults(fixture: AuthorizationFixture): ScheduledMCPAuthorizationResult[] {
  return fixture.steps.map((step) => {
    if (step.expected === 'cancelled') return { state: 'cancelled' };
    if (step.expected !== 'authorized') {
      return { state: 'denied', failure: failureFixtures[step.expected] };
    }
    if (step.facts.consent.state !== 'found') throw new Error('Invalid positive fixture');
    const consent = step.facts.consent.consent;
    return {
      state: 'authorized',
      consentId: consent.id,
      consentRevision: consent.revision,
      policyRevision: step.facts.policyRevision,
      validUntilMs: consent.absoluteExpiresAtMs,
    };
  });
}

it.each(authorizationFixtures)('accepts the complete scripted contract: $id', async (fixture) => {
  const results = scriptedResults(fixture);
  const evaluate = jest.fn(async () => results.shift()!);
  await verifyAuthorizationFixture(fixture, evaluate);
  expect(evaluate.mock.calls).toHaveLength(fixture.steps.length);
});

it.each(
  authorizationFixtures.filter((fixture) =>
    fixture.steps.some((step) => step.expected !== 'authorized'),
  ),
)('rejects an implementation that reuses an allow decision: $id', async (fixture) => {
  const evaluate = jest.fn(
    async (): Promise<ScheduledMCPAuthorizationResult> => ({
      state: 'authorized',
      consentId: 'consent-1',
      consentRevision: 'consent-revision-1',
      policyRevision: 'policy-1',
      validUntilMs: 10_000,
    }),
  );
  await expect(verifyAuthorizationFixture(fixture, evaluate)).rejects.toThrow(
    'Authorization contract mismatch',
  );
});

it('rejects token expiry used to extend the consent deadline', async () => {
  const fixture = authorizationFixtures[0];
  const result = scriptedResults(fixture)[0];
  if (result.state !== 'authorized') throw new Error('Invalid positive fixture');
  await expect(
    verifyAuthorizationFixture(fixture, async () => ({ ...result, validUntilMs: 20_000 })),
  ).rejects.toThrow('Authorization contract mismatch');
});

it('rejects a stale policy revision', async () => {
  const fixture = authorizationFixtures[0];
  const result = scriptedResults(fixture)[0];
  if (result.state !== 'authorized') throw new Error('Invalid positive fixture');
  await expect(
    verifyAuthorizationFixture(fixture, async () => ({ ...result, policyRevision: 'old-policy' })),
  ).rejects.toThrow('Authorization contract mismatch');
});

it('does not permit automatic replay or an incompatible public failure status', () => {
  for (const failure of Object.values(failureFixtures)) {
    expect(failure.automaticReplay).toBe(false);
    expect(
      scheduleMCPOutcomeSchema.safeParse({ server: 'warehouse', status: failure.status }).success,
    ).toBe(true);
  }
});

it('requires unique vector IDs and explicit tenant bindings', () => {
  expect(new Set(authorizationFixtures.map((fixture) => fixture.id)).size).toBe(
    authorizationFixtures.length,
  );
  for (const fixture of authorizationFixtures) {
    expect(fixture.request.identity).toHaveProperty('tenantId');
    expect(fixture.steps.length).toBeGreaterThan(0);
  }
});

it('isolates dependency snapshots from a mutating test adapter', async () => {
  const fixture = authorizationFixtures[0];
  const results = scriptedResults(fixture);
  await verifyAuthorizationFixture(fixture, async (request, facts) => {
    Object.assign(request.identity, { agentId: 'tampered' });
    Object.assign(facts, { rbac: 'denied' });
    return results.shift()!;
  });
  expect(fixture.request.identity.agentId).toBe('root-agent');
  expect(fixture.steps[0].facts.rbac).toBe('allowed');
});

it('delivers cancellation to the adapter without inventing a reauth failure', async () => {
  const fixture = authorizationFixtures.find((item) => item.id === 'cancelled-before-admission')!;
  await verifyAuthorizationFixture(fixture, async (_request, _facts, { signal }) => {
    expect(signal.aborted).toBe(true);
    return { state: 'cancelled' };
  });
});
