import { z } from 'zod';

const id = z.string().min(1).max(128);
const feature = z.literal('prompts');
const entryPoint = z.enum(['sidebar', 'route', 'picker', 'preview', 'editor']);

/** Keep the stable group identity without exporting a revision. */
export const productPromptReferenceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('native'), groupId: id }),
  z.strictObject({
    source: z.literal('langfuse'),
    groupId: id,
  }),
]);

export type ProductPromptReference = z.infer<typeof productPromptReferenceSchema>;

export const promptBrowserFacts = [
  z.strictObject({
    name: z.literal('librechat.prompts.opened'),
    feature,
    entryPoint,
    groupId: id.optional(),
  }),
  z.strictObject({
    name: z.literal('librechat.prompts.resolved'),
    feature,
    entryPoint,
    prompt: productPromptReferenceSchema,
    variables: z.boolean(),
  }),
] as const;

export const promptServerFacts = [
  z.strictObject({
    name: z.literal('librechat.prompts.imported'),
    feature,
    groupId: id,
    source: z.literal('langfuse'),
  }),
  z.strictObject({
    name: z.literal('librechat.prompts.created'),
    feature,
    groupId: id,
    source: z.literal('native'),
  }),
  z.strictObject({
    name: z.literal('librechat.prompts.revision.created'),
    feature,
    groupId: id,
    source: z.literal('native'),
  }),
  z.strictObject({
    name: z.literal('librechat.prompts.metadata.updated'),
    feature,
    groupId: id,
    source: z.literal('native'),
  }),
  z.strictObject({
    name: z.literal('librechat.prompts.deployed'),
    feature,
    groupId: id,
    source: z.literal('native'),
    deployment: z.enum(['initial', 'explicit', 'automatic']),
  }),
] as const;
