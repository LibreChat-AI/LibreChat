import { z } from 'zod';

const id = z.string().min(1).max(128);
const prompt = z.strictObject({ feature: z.literal('prompts'), groupId: id });
const skill = z.strictObject({ feature: z.literal('skills'), skillId: id });

/** Sharing records the changed object, never recipients or permission details. */
export const sharingBrowserFacts = [
  prompt.extend({ name: z.literal('librechat.prompts.sharing.opened') }),
  skill.extend({ name: z.literal('librechat.skills.sharing.opened') }),
] as const;

export const sharingServerFacts = [
  prompt.extend({ name: z.literal('librechat.prompts.sharing.updated') }),
  skill.extend({ name: z.literal('librechat.skills.sharing.updated') }),
] as const;
