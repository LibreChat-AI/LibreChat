import { z } from 'zod';

const id = z.string().min(1).max(128);
const prompt = z.strictObject({ feature: z.literal('prompts'), groupId: id });
const skill = z.strictObject({ feature: z.literal('skills'), skillId: id });

export const agentServerFacts = [
  z.strictObject({
    name: z.literal('librechat.agents.saved'),
    feature: z.literal('agents'),
    agentId: id,
    promptGroupId: id.nullable(),
    skillIds: z.array(id),
  }),
  prompt.extend({ name: z.literal('librechat.prompts.linked_to_agent'), agentId: id }),
  prompt.extend({ name: z.literal('librechat.prompts.unlinked_from_agent'), agentId: id }),
  skill.extend({ name: z.literal('librechat.skills.linked_to_agent'), agentId: id }),
  skill.extend({ name: z.literal('librechat.skills.unlinked_from_agent'), agentId: id }),
] as const;
