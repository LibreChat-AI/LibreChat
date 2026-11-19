import { z } from 'zod';

const id = z.string().min(1).max(128);

/** Each save records the agent's full links, so a consumer needs only the latest snapshot. */
export const agentServerFacts = [
  z.strictObject({
    name: z.literal('librechat.agents.saved'),
    feature: z.literal('agents'),
    agentId: id,
    promptGroupId: id.nullable(),
    skillIds: z.array(id),
  }),
  z.strictObject({
    name: z.literal('librechat.agents.deleted'),
    feature: z.literal('agents'),
    agentId: id,
  }),
] as const;
