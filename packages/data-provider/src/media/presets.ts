import { z } from 'zod';
import {
  MEDIA_SCHEMA_VERSION,
  mediaIdSchema,
  mediaInputSchema,
  mediaOperationSchema,
  mediaImageParametersSchema,
  mediaVideoParametersSchema,
} from './requests';
import { mediaAssetSchema } from './responses';

const timestamp = z.string().datetime();

/** The generation settings a Studio preset restores; the catalog version is resolved on apply. */
export const mediaPresetSettingsSchema = z
  .object({
    operation: mediaOperationSchema,
    connectionId: mediaIdSchema,
    modelId: mediaIdSchema,
    providerTag: mediaIdSchema.optional(),
    parameters: mediaImageParametersSchema.merge(mediaVideoParametersSchema).default({}),
    inputs: z
      .array(mediaInputSchema.refine((input) => !input.sourceURL, 'Save an uploaded reference'))
      .optional(),
  })
  .strict();
export const mediaPresetWriteSchema = z
  .object({
    title: z.string().trim().min(1),
    isDefault: z.boolean().optional(),
    settings: mediaPresetSettingsSchema,
  })
  .strict();
export const mediaPresetUpdateSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    isDefault: z.boolean().optional(),
    settings: mediaPresetSettingsSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.title !== undefined || value.isDefault !== undefined || value.settings !== undefined,
    { message: 'At least one update is required' },
  );
export const mediaPresetSchema = z
  .object({
    schemaVersion: z.literal(MEDIA_SCHEMA_VERSION),
    presetId: mediaIdSchema,
    title: z.string(),
    isDefault: z.boolean(),
    settings: mediaPresetSettingsSchema,
    createdAt: timestamp,
    updatedAt: timestamp,
    assets: z.array(mediaAssetSchema).default([]),
  })
  .strict();
export const mediaPresetListSchema = z.object({ items: z.array(mediaPresetSchema) }).strict();

export type MediaPresetSettings = z.infer<typeof mediaPresetSettingsSchema>;
export type MediaPresetWrite = z.infer<typeof mediaPresetWriteSchema>;
export type MediaPresetWriteInput = z.input<typeof mediaPresetWriteSchema>;
export type MediaPresetUpdate = z.infer<typeof mediaPresetUpdateSchema>;
export type MediaPreset = z.infer<typeof mediaPresetSchema>;
export type MediaPresetList = z.infer<typeof mediaPresetListSchema>;

export function createMediaPresetSchema(limits: { maxTitleChars: number; maxInputs: number }) {
  return mediaPresetWriteSchema
    .refine((value) => value.title.length <= limits.maxTitleChars, {
      path: ['title'],
      message: 'Title exceeds the configured limit',
    })
    .refine((value) => (value.settings.inputs?.length ?? 0) <= limits.maxInputs, {
      path: ['settings', 'inputs'],
      message: 'References exceed the configured limit',
    });
}

export function createMediaPresetUpdateSchema(limits: {
  maxTitleChars: number;
  maxInputs: number;
}) {
  return mediaPresetUpdateSchema
    .refine((value) => value.title === undefined || value.title.length <= limits.maxTitleChars, {
      path: ['title'],
      message: 'Title exceeds the configured limit',
    })
    .refine((value) => (value.settings?.inputs?.length ?? 0) <= limits.maxInputs, {
      path: ['settings', 'inputs'],
      message: 'References exceed the configured limit',
    });
}
