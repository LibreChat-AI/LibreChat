import { z } from 'zod';
import type { SkillSource } from '../types/skills';

const skillId = z.string().min(1).max(128);
const source = z.enum(['inline', 'deployment', 'github', 'notion'] satisfies SkillSource[]);
const feature = z.literal('skills');
const sync = { syncRunId: z.uuid() };

export const skillBrowserFacts = [
  z.strictObject({
    name: z.literal('librechat.skills.opened'),
    feature,
    entryPoint: z.enum(['route', 'sidebar', 'picker']),
    skillId: skillId.optional(),
  }),
] as const;

export const skillServerFacts = [
  z.strictObject({
    name: z.literal('librechat.skills.added'),
    feature,
    skillId,
    source,
  }),
  z.strictObject({
    name: z.literal('librechat.skills.updated'),
    feature,
    skillId,
    source: source.optional(),
  }),
  z.strictObject({
    name: z.literal('librechat.skills.removed'),
    feature,
    skillId,
  }),
  z.strictObject({
    name: z.literal('librechat.skills.synced'),
    feature,
    ...sync,
    skillId,
    change: z.enum(['added', 'updated', 'removed']),
  }),
  z.strictObject({
    name: z.literal('librechat.skills.sync.finished'),
    feature,
    ...sync,
    status: z.enum(['succeeded', 'partial', 'failed']),
    unchanged: z.boolean(),
    changedSkillCount: z.number().int().nonnegative(),
    unchangedSkillCount: z.number().int().nonnegative(),
    deletedSkillCount: z.number().int().nonnegative(),
    skippedSkillCount: z.number().int().nonnegative(),
    skippedFileCount: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
  }),
] as const;

export type SkillServerFact = z.infer<(typeof skillServerFacts)[number]>;
export type SkillSyncFact = Extract<
  SkillServerFact,
  { name: 'librechat.skills.synced' | 'librechat.skills.sync.finished' }
>;
