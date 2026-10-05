import { z } from 'zod';

export const MEDIA_SCHEMA_VERSION = 1 as const;
export const mediaIdSchema = z.string().trim().min(1).max(256);
export const mediaOperationSchema = z.enum(['image.generate', 'image.edit', 'video.generate']);
export const mediaApiSchema = z.enum([
  'openrouter.images',
  'openrouter.videos',
  'openai.images',
  'openai.videos',
  'google.interactions',
  'google.generateContent',
  'google.vertex.videos',
  'bfl.images',
  'bfl.videos',
  'recraft.images',
  'xai.images',
  'xai.videos',
  'runway.videos',
  'krea.images',
  'sourceful.images',
  'alibaba.images',
  'alibaba.videos',
  'atlas.videos',
  'seed.images',
  'seed.videos',
  'minimax.videos',
  'heygen.videos',
  'microsoft.images',
]);
export const mediaInputRoleSchema = z.enum([
  'reference',
  'mask',
  'start_frame',
  'end_frame',
  'video',
  'audio',
]);
export const mediaHostedInputRoleSchema = z.enum(['video', 'audio']);
export const mediaSourceURLSchema = z
  .string()
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password && !url.hash;
    } catch {
      return false;
    }
  }, 'Media source must be an HTTPS URL without credentials or a fragment');
export const mediaInputSchema = z
  .object({
    role: mediaInputRoleSchema,
    file_id: mediaIdSchema,
    sourceURL: mediaSourceURLSchema.optional(),
  })
  .strict()
  .refine((input) => !input.sourceURL || input.role === 'audio' || input.role === 'video', {
    path: ['sourceURL'],
    message: 'Hosted sources are only supported for audio and video',
  });
export const mediaURLUploadRequestSchema = z
  .object({ url: mediaSourceURLSchema, role: mediaHostedInputRoleSchema })
  .strict();
export const mediaSelectionSchema = z
  .object({
    connectionId: mediaIdSchema,
    modelId: mediaIdSchema,
    catalogVersion: mediaIdSchema,
    providerTag: mediaIdSchema.optional(),
  })
  .strict();

const positiveInteger = z.number().finite().int().positive().safe();
export type MediaOptionValue =
  | string
  | number
  | boolean
  | null
  | MediaOptionValue[]
  | { [key: string]: MediaOptionValue };
/** Validate provider JSON iteratively so deep input reaches configurable depth checks safely. */
function isMediaOptionValue(value: unknown): value is MediaOptionValue {
  const pending: unknown[] = [value];
  const visited = new Set<object>();
  while (pending.length) {
    const item = pending.pop();
    if (item === null || typeof item === 'string' || typeof item === 'boolean') continue;
    if (typeof item === 'number') {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== 'object' || visited.has(item)) return false;
    if (
      !Array.isArray(item) &&
      Object.getPrototypeOf(item) !== Object.prototype &&
      Object.getPrototypeOf(item) !== null
    )
      return false;
    visited.add(item);
    for (const child of Object.values(item)) pending.push(child);
  }
  return true;
}
export const mediaOptionValueSchema: z.ZodType<MediaOptionValue> =
  z.custom<MediaOptionValue>(isMediaOptionValue);
export const mediaProviderOptionsSchema = z.record(
  z
    .string()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)
    .max(128),
  mediaOptionValueSchema,
);
export const mediaImageParametersSchema = z
  .object({
    count: positiveInteger.default(1),
    size: z.string().min(1).optional(),
    resolution: z.string().min(1).optional(),
    aspectRatio: z.string().min(1).optional(),
    quality: z.string().min(1).optional(),
    format: z.enum(['png', 'jpeg', 'webp', 'svg']).optional(),
    background: z.enum(['auto', 'opaque', 'transparent']).optional(),
    seed: z.number().int().nonnegative().safe().optional(),
    outputCompression: z.number().int().min(0).max(100).optional(),
    strength: z.number().finite().min(0).max(1).optional(),
    guidance: z.number().finite().nonnegative().optional(),
    negativePrompt: z.string().optional(),
    providerOptions: mediaProviderOptionsSchema.optional(),
  })
  .strict();
export const mediaVideoParametersSchema = z
  .object({
    count: positiveInteger.default(1),
    durationSeconds: z.number().finite().positive().optional(),
    aspectRatio: z.string().min(1).optional(),
    resolution: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
    audio: z.boolean().optional(),
    seed: z.number().int().nonnegative().safe().optional(),
    upscaleFactor: z.number().finite().positive().optional(),
    creativity: z.number().finite().nonnegative().optional(),
    negativePrompt: z.string().optional(),
    providerOptions: mediaProviderOptionsSchema.optional(),
  })
  .strict();

const submissionFields = {
  schemaVersion: z.literal(MEDIA_SCHEMA_VERSION).default(MEDIA_SCHEMA_VERSION),
  clientRequestId: mediaIdSchema,
  threadId: mediaIdSchema.optional(),
  parentTurnId: mediaIdSchema.optional(),
  selection: mediaSelectionSchema,
  prompt: z.string().trim().min(1),
  inputs: z.array(mediaInputSchema).default([]),
  /** A new thread that retires itself after the temporary retention window. */
  temporary: z.boolean().optional(),
  /** Turns submitted together for a side-by-side model comparison share one identifier. */
  comparisonId: mediaIdSchema.optional(),
};
export const mediaSubmissionRequestSchema = z
  .discriminatedUnion('operation', [
    z
      .object({
        ...submissionFields,
        operation: z.literal('image.generate'),
        parameters: mediaImageParametersSchema.default({}),
      })
      .strict(),
    z
      .object({
        ...submissionFields,
        operation: z.literal('image.edit'),
        parameters: mediaImageParametersSchema.default({}),
      })
      .strict(),
    z
      .object({
        ...submissionFields,
        operation: z.literal('video.generate'),
        parameters: mediaVideoParametersSchema.default({}),
      })
      .strict(),
  ])
  .superRefine((request, ctx) => {
    if (request.parentTurnId && !request.threadId) {
      ctx.addIssue({
        code: 'custom',
        path: ['parentTurnId'],
        message: 'A parent requires a thread',
      });
    }
    if (request.temporary && request.threadId) {
      ctx.addIssue({
        code: 'custom',
        path: ['temporary'],
        message: 'Only a new thread can be temporary',
      });
    }
    if (
      request.operation === 'image.edit' &&
      !request.inputs.some((input) => input.role === 'reference')
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['inputs'],
        message: 'Image editing requires a reference',
      });
    }
    const roles = request.inputs.map((input) => input.role);
    if (
      request.operation !== 'video.generate' &&
      roles.some((role) => !['reference', 'mask'].includes(role))
    ) {
      ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Unsupported image input role' });
    }
    if (request.operation !== 'image.edit' && roles.includes('mask')) {
      ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Masks require image editing' });
    }
    for (const role of ['mask', 'start_frame', 'end_frame']) {
      if (roles.filter((value) => value === role).length > 1) {
        ctx.addIssue({
          code: 'custom',
          path: ['inputs'],
          message: `Only one ${role} is permitted`,
        });
      }
    }
  });

export const mediaImportRequestSchema = z
  .object({
    schemaVersion: z.literal(MEDIA_SCHEMA_VERSION).default(MEDIA_SCHEMA_VERSION),
    clientRequestId: mediaIdSchema,
    threadId: mediaIdSchema.optional(),
    title: z.string().trim().min(1).optional(),
    inputs: z.array(mediaInputSchema).min(1),
    temporary: z.boolean().optional(),
  })
  .strict()
  .refine((request) => !request.temporary || !request.threadId, {
    path: ['temporary'],
    message: 'Only a new thread can be temporary',
  });
export const mediaRetryRequestSchema = z.object({ clientRequestId: mediaIdSchema }).strict();
export const mediaThreadUpdateSchema = z
  .object({
    expectedVersion: positiveInteger,
    title: z.string().trim().min(1).optional(),
    coverFileId: mediaIdSchema.nullable().optional(),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.coverFileId !== undefined, {
    message: 'At least one update is required',
  });
export const mediaPageRequestSchema = z
  .object({
    cursor: mediaIdSchema.optional(),
    limit: z.coerce.number().int().positive().safe().optional(),
  })
  .strict();
export const mediaThreadListRequestSchema = mediaPageRequestSchema.extend({
  filter: z.enum(['all', 'pending', 'completed']).optional(),
  include: z.literal('activity').optional(),
  search: z.string().trim().optional(),
});
export const mediaThreadDetailRequestSchema = z.object({
  include: z.literal('videoContext').optional(),
  videoContextVersion: z.literal('2').optional(),
});
export const mediaThreadsDeleteRequestSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('selected'), threadIds: z.array(mediaIdSchema).min(1) }).strict(),
  z.object({ mode: z.literal('all') }).strict(),
]);

export type MediaOperation = z.infer<typeof mediaOperationSchema>;
export type MediaApi = z.infer<typeof mediaApiSchema>;
export type MediaInput = z.infer<typeof mediaInputSchema>;
export type MediaURLUploadRequest = z.infer<typeof mediaURLUploadRequestSchema>;
export type MediaSelection = z.infer<typeof mediaSelectionSchema>;
export type MediaImageParameters = z.infer<typeof mediaImageParametersSchema>;
export type MediaVideoParameters = z.infer<typeof mediaVideoParametersSchema>;
export type MediaSubmissionRequest = z.infer<typeof mediaSubmissionRequestSchema>;
export type MediaSubmissionInput = z.input<typeof mediaSubmissionRequestSchema>;
export type MediaImportRequest = z.infer<typeof mediaImportRequestSchema>;
export type MediaImportInput = z.input<typeof mediaImportRequestSchema>;
export type MediaRetryRequest = z.infer<typeof mediaRetryRequestSchema>;
export type MediaThreadUpdate = z.infer<typeof mediaThreadUpdateSchema>;
export type MediaPageRequest = z.infer<typeof mediaPageRequestSchema>;
export type MediaThreadListRequest = z.infer<typeof mediaThreadListRequestSchema>;
export type MediaThreadDetailRequest = z.infer<typeof mediaThreadDetailRequestSchema>;
export type MediaThreadsDeleteRequest = z.infer<typeof mediaThreadsDeleteRequestSchema>;

export type MediaRequestLimits = {
  maxPromptChars: number;
  maxTitleChars: number;
  maxInputs: number;
  maxOutputs: number;
};

export function createMediaSubmissionSchema(limits: MediaRequestLimits) {
  return mediaSubmissionRequestSchema.superRefine((value, ctx) => {
    if (value.prompt.length > limits.maxPromptChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['prompt'],
        message: 'Prompt exceeds the configured limit',
      });
    }
    if (value.inputs.length > limits.maxInputs) {
      ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Too many input files' });
    }
    if (value.parameters.count > limits.maxOutputs) {
      ctx.addIssue({ code: 'custom', path: ['parameters', 'count'], message: 'Too many outputs' });
    }
  });
}

export function createMediaImportSchema(limits: MediaRequestLimits) {
  return mediaImportRequestSchema.superRefine((value, ctx) => {
    if (value.inputs.length > limits.maxInputs) {
      ctx.addIssue({ code: 'custom', path: ['inputs'], message: 'Too many input files' });
    }
    if (value.title && value.title.length > limits.maxTitleChars) {
      ctx.addIssue({
        code: 'custom',
        path: ['title'],
        message: 'Title exceeds the configured limit',
      });
    }
  });
}
