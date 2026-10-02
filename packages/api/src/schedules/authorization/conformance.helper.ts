import type { ScheduledMCPAuthorizationRequest, ScheduledMCPAuthorizationResult } from './contract';
import type { AuthorizationFacts, AuthorizationFixture } from './fixtures.helper';
import { failureFixtures } from './fixtures.helper';

/** Test-only adapter: supply these snapshots through an implementation's injected dependencies. */
export type AuthorizationFixtureEvaluator = (
  request: ScheduledMCPAuthorizationRequest,
  facts: AuthorizationFacts,
  options: { signal: AbortSignal },
) => Promise<ScheduledMCPAuthorizationResult>;

/** Reuses the evaluator across fresh snapshots to expose stale authorization decisions. */
export async function verifyAuthorizationFixture(
  fixture: AuthorizationFixture,
  evaluate: AuthorizationFixtureEvaluator,
): Promise<void> {
  for (const step of fixture.steps) {
    const controller = new AbortController();
    if (step.aborted) controller.abort();
    const result = await evaluate(
      structuredClone({ ...fixture.request, stage: step.stage }),
      structuredClone(step.facts),
      { signal: controller.signal },
    );
    const fail = (): never => {
      throw new Error(`Authorization contract mismatch: ${fixture.id}/${step.stage}`);
    };
    if (step.expected === 'cancelled') {
      if (result.state !== 'cancelled') fail();
      continue;
    }
    if (step.expected !== 'authorized') {
      const expected = failureFixtures[step.expected];
      if (
        result.state !== 'denied' ||
        result.failure.reason !== expected.reason ||
        result.failure.status !== expected.status ||
        result.failure.recovery !== expected.recovery ||
        result.failure.automaticReplay !== false ||
        Object.keys(result.failure).length !== Object.keys(expected).length
      ) {
        fail();
      }
      continue;
    }
    if (result.state !== 'authorized' || step.facts.consent.state !== 'found') {
      fail();
      continue;
    }
    const consent = step.facts.consent.consent;
    if (
      result.consentId !== consent.id ||
      result.consentRevision !== consent.revision ||
      result.policyRevision !== step.facts.policyRevision ||
      !Number.isFinite(result.validUntilMs) ||
      result.validUntilMs <= step.facts.nowMs ||
      result.validUntilMs > consent.absoluteExpiresAtMs
    ) {
      fail();
    }
  }
}
