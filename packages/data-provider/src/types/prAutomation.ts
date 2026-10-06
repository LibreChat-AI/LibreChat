export const PR_AUTOMATION_STATES = ['idle', 'waiting', 'fixing', 'needs_user', 'stopped'] as const;

/**
 * Stable, machine-readable reasons an automation stopped. The client maps each
 * code to localized copy; none of them carries provider text or a comment body.
 */
export const PR_AUTOMATION_STOP_CODES = [
  'user_stopped',
  'round_cap',
  'time_cap',
  'fork_pull_request',
  'untrusted_head_commit',
  'approval_expired',
  'pull_request_closed',
  'disabled_by_admin',
  'conversation_deleting',
  'account_deleting',
] as const;

/** Largest per-repository bot allowlist a deployment can configure. */
export const MAX_PR_AUTOMATION_BOTS = 100;
export const DEFAULT_PR_AUTOMATION_BOTS = 20;

/** Ordered from narrowest to widest: who may be acted on. */
export const PR_AUTOMATION_TRUST_LEVELS = ['approvedBots', 'collaborators', 'anyone'] as const;

export type PRAutomationState = (typeof PR_AUTOMATION_STATES)[number];
export type PRAutomationStopCode = (typeof PR_AUTOMATION_STOP_CODES)[number];
export type PRAutomationTrustLevel = (typeof PR_AUTOMATION_TRUST_LEVELS)[number];

/**
 * An administrator's ceiling bounds what a user may choose. A user can only
 * narrow it, so the result is whichever level is narrower.
 */
export function clampPRAutomationTrust(
  requested: PRAutomationTrustLevel | undefined,
  ceiling: PRAutomationTrustLevel,
): PRAutomationTrustLevel {
  if (requested == null) {
    return PR_AUTOMATION_TRUST_LEVELS[0];
  }
  const requestedRank = PR_AUTOMATION_TRUST_LEVELS.indexOf(requested);
  const ceilingRank = PR_AUTOMATION_TRUST_LEVELS.indexOf(ceiling);
  if (requestedRank < 0) {
    return PR_AUTOMATION_TRUST_LEVELS[0];
  }
  return PR_AUTOMATION_TRUST_LEVELS[Math.min(requestedRank, ceilingRank)];
}
