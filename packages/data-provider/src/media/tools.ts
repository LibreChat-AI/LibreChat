import { z } from 'zod';
import {
  mediaIdSchema,
  mediaInputSchema,
  mediaOperationSchema,
  mediaImageParametersSchema,
  mediaVideoParametersSchema,
} from './requests';
import { mediaJobPhaseSchema, mediaAssetSchema, mediaErrorSchema } from './responses';

export const mediaToolReceiptSchema = z
  .object({
    jobId: mediaIdSchema,
    threadId: mediaIdSchema,
    operation: mediaOperationSchema,
    phase: mediaJobPhaseSchema,
  })
  .strict();

export const mediaToolGenerateSchema = z
  .object({
    operation: mediaOperationSchema,
    prompt: z.string().min(1),
    connectionId: mediaIdSchema,
    modelId: mediaIdSchema,
    providerTag: mediaIdSchema.optional(),
    inputs: z.array(mediaInputSchema).default([]),
    parameters: z.union([mediaImageParametersSchema, mediaVideoParametersSchema]).default({}),
  })
  .strict();

export const mediaToolStatusSchema = z.object({ jobId: mediaIdSchema.optional() }).strict();
export type MediaToolReceipt = z.infer<typeof mediaToolReceiptSchema>;
export type MediaToolGenerateInput = z.infer<typeof mediaToolGenerateSchema>;
export const mediaToolArtifactSchema = z
  .object({
    media: mediaToolReceiptSchema,
    files: z.array(mediaAssetSchema),
    error: mediaErrorSchema.optional(),
  })
  .strict();
export type MediaToolArtifact = z.infer<typeof mediaToolArtifactSchema>;
