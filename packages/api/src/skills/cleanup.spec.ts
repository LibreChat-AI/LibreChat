import type { DeleteSkillResult } from '@librechat/data-schemas';
import { deleteSkillWithRetry, mergeDeleteSkillResults } from './cleanup';

function incomplete(...failedCleanupSteps: DeleteSkillResult['failedCleanupSteps']) {
  return {
    deleted: true,
    skillAbsent: true,
    cleanupComplete: false,
    failedCleanupSteps,
  } satisfies DeleteSkillResult;
}

describe('mergeDeleteSkillResults', () => {
  it('keeps steps settled when alternating retries fail independently', () => {
    expect(mergeDeleteSkillResults(incomplete('permissions'), incomplete('skill_files'))).toEqual({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: true,
      failedCleanupSteps: [],
    });
  });

  it('retains a step that failed in every attempt', () => {
    expect(
      mergeDeleteSkillResults(incomplete('permissions', 'skill_files'), incomplete('permissions')),
    ).toEqual({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: false,
      failedCleanupSteps: ['permissions'],
    });
  });

  it('does not lose a pending upload intent when a retry cannot confirm Skill absence', () => {
    expect(
      mergeDeleteSkillResults(incomplete('upload_intents'), {
        deleted: false,
        skillAbsent: false,
        cleanupComplete: false,
        failedCleanupSteps: [],
      }),
    ).toEqual({
      deleted: true,
      skillAbsent: true,
      cleanupComplete: false,
      failedCleanupSteps: ['upload_intents'],
    });
  });

  it('does not treat a late upload intent as settled by an earlier clean pass', () => {
    expect(
      mergeDeleteSkillResults(
        { deleted: true, skillAbsent: true, cleanupComplete: true, failedCleanupSteps: [] },
        incomplete('upload_intents'),
      ),
    ).toMatchObject({
      cleanupComplete: false,
      failedCleanupSteps: ['upload_intents'],
    });
  });
});

describe('deleteSkillWithRetry', () => {
  it('retries and preserves settled cleanup steps', async () => {
    const deleteSkill = jest
      .fn()
      .mockResolvedValueOnce(incomplete('permissions'))
      .mockResolvedValueOnce(incomplete('skill_files'));

    await expect(deleteSkillWithRetry(deleteSkill, 'skill-id')).resolves.toMatchObject({
      cleanupComplete: true,
      failedCleanupSteps: [],
    });
    expect(deleteSkill).toHaveBeenCalledTimes(2);
  });
});
