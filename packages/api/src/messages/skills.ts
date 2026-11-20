import type { TMessage } from 'librechat-data-provider';
import type { ResolvedSkillPrime } from '~/agents/skills';

interface SkillMessageInput {
  manualSkills?: unknown;
  alwaysApplySkillPrimes?: readonly Pick<ResolvedSkillPrime, 'name'>[];
  isEdited?: boolean;
  isCompaction?: boolean;
  skipSaveUserMessage?: boolean;
}

/** Freeze skill badges before the turn is announced, preserving historical turns. */
export function skillMessageFields({
  manualSkills,
  alwaysApplySkillPrimes,
  isEdited,
  isCompaction,
  skipSaveUserMessage,
}: SkillMessageInput): Pick<TMessage, 'manualSkills' | 'alwaysAppliedSkills'> {
  if (isEdited || isCompaction || skipSaveUserMessage) {
    return {};
  }

  const fields: Pick<TMessage, 'manualSkills' | 'alwaysAppliedSkills'> = {};
  if (Array.isArray(manualSkills)) {
    const names = manualSkills.filter(
      (name): name is string => typeof name === 'string' && name.length > 0,
    );
    if (names.length > 0) {
      fields.manualSkills = names;
    }
  }
  if (Array.isArray(alwaysApplySkillPrimes)) {
    const names = alwaysApplySkillPrimes
      .map((prime) => prime?.name)
      .filter((name): name is string => typeof name === 'string' && name.length > 0);
    if (names.length > 0) {
      fields.alwaysAppliedSkills = names;
    }
  }
  return fields;
}
