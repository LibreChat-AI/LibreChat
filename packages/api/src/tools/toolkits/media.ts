import { zodToJsonSchema } from 'zod-to-json-schema';
import { mediaToolGenerateSchema, mediaToolStatusSchema } from 'librechat-data-provider';
import type { ExtendedJsonSchema } from '../registry/schema';

export const mediaToolkit = {
  media_generate: {
    name: 'media_generate',
    description:
      'Generate or edit an image, or submit a durable video generation. Call media_status without a jobId first to discover configured models and supported options. Use existing owned file IDs for references. Images wait for completion; video jobs return immediately and continue after this run ends. Check a receipt with media_status.',
    schema: zodToJsonSchema(mediaToolGenerateSchema, {
      $refStrategy: 'none',
    }) as ExtendedJsonSchema,
    responseFormat: 'content_and_artifact' as const,
  },
  media_status: {
    name: 'media_status',
    description:
      'Without jobId, list configured media models and their capabilities. With jobId, return the durable generation status and already-saved output files. Never invent job IDs or file IDs.',
    schema: zodToJsonSchema(mediaToolStatusSchema, { $refStrategy: 'none' }) as ExtendedJsonSchema,
    responseFormat: 'content_and_artifact' as const,
  },
};
