import type { DeleteSkillCleanupStep, DeleteSkillResult } from '@librechat/data-schemas';

const CLEANUP_STEPS: DeleteSkillCleanupStep[] = ['agent_allowlists', 'skill_files', 'permissions'];

/**
 * Cleanup is monotonic across idempotent deletion attempts. Once any attempt
 * confirms a step succeeded, a later transient failure cannot make that work
 * incomplete again. Only steps that failed in every confirming attempt remain
 * unsettled.
 */
export function mergeDeleteSkillResults(
  current: DeleteSkillResult,
  next: DeleteSkillResult,
): DeleteSkillResult {
  const confirmingAttempts = [current, next].filter((result) => result.skillAbsent);
  const failedCleanupSteps = CLEANUP_STEPS.filter((step) =>
    confirmingAttempts.every((result) => result.failedCleanupSteps.includes(step)),
  );
  const skillAbsent = confirmingAttempts.length > 0;

  return {
    deleted: current.deleted || next.deleted,
    skillAbsent,
    cleanupComplete: skillAbsent && failedCleanupSteps.length === 0,
    failedCleanupSteps,
  };
}

/** Retry an idempotent cascade once when the skill row is already gone. */
export async function deleteSkillWithRetry(
  deleteSkill: (id: string) => Promise<DeleteSkillResult>,
  id: string,
): Promise<DeleteSkillResult> {
  const result = await deleteSkill(id);
  if (!result.skillAbsent || result.cleanupComplete) {
    return result;
  }
  return mergeDeleteSkillResults(result, await deleteSkill(id));
}
