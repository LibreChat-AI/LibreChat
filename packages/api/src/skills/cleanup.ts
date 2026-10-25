import type { DeleteSkillCleanupStep, DeleteSkillResult } from '@librechat/data-schemas';

const CLEANUP_STEPS: DeleteSkillCleanupStep[] = [
  'agent_allowlists',
  'skill_files',
  'upload_intents',
  'permissions',
];

/**
 * Most cleanup steps are monotonic across idempotent attempts: one confirmed
 * success settles a transient failure. Upload intents are different because a
 * late writer can create one after an earlier pass, so the latest confirming
 * result decides whether that step is settled.
 */
export function mergeDeleteSkillResults(
  current: DeleteSkillResult,
  next: DeleteSkillResult,
): DeleteSkillResult {
  const confirmingAttempts = [current, next].filter((result) => result.skillAbsent);
  const failedCleanupSteps = CLEANUP_STEPS.filter((step) => {
    if (step === 'upload_intents') {
      // A late writer can introduce a new intent after an earlier clean pass.
      // Only a newer confirming pass may settle this non-monotonic step.
      return next.skillAbsent
        ? next.failedCleanupSteps.includes(step)
        : current.failedCleanupSteps.includes(step);
    }
    return confirmingAttempts.every((result) => result.failedCleanupSteps.includes(step));
  });
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
