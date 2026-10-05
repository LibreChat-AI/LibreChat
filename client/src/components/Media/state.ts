import { z } from 'zod';
import { atomFamily } from 'jotai/utils';
import {
  mediaAssetSchema,
  mediaInputSchema,
  mediaInputRoleSchema,
  mediaParameterNameSchema,
  mediaOperationSchema,
  mediaImportRequestSchema,
  mediaImageParametersSchema,
  mediaVideoParametersSchema,
  mediaSubmissionRequestSchema,
  mediaRetryRequestSchema,
  mediaRecoveryJobSchema,
  mediaRecoveryRequestSchema,
} from 'librechat-data-provider';
import type { MediaImportReceipt, MediaSubmissionReceipt } from 'librechat-data-provider';
import type { PendingMediaRecovery } from '~/data-provider';
import { registerSessionCleanup } from '~/store/session';
import { createSessionAtom } from '~/store/jotai-utils';

const prefix = 'librechat:media:';
const parameterContextSchema = z.object({
  operation: mediaOperationSchema,
  roles: z.array(mediaInputRoleSchema),
});
export type MediaParameterContext = z.infer<typeof parameterContextSchema>;
const draftSchema = z.object({
  prompt: z.string(),
  operation: mediaOperationSchema,
  offering: z.string(),
  parentTurnId: z.string().optional(),
  autoEdit: z.boolean().optional(),
  videoAutoEdit: z.boolean().optional(),
  providerTag: z.string().optional(),
  providerOptionsText: z.string().optional(),
  referenceURL: z.string().optional(),
  referenceURLRole: z.enum(['video', 'audio']).optional(),
  temporary: z.boolean().optional(),
  compare: z.object({ offering: z.string(), providerTag: z.string().optional() }).optional(),
  inputs: z.array(mediaInputSchema),
  assets: z.array(mediaAssetSchema),
  parameters: mediaImageParametersSchema.merge(mediaVideoParametersSchema),
  parameterContexts: z.record(mediaParameterNameSchema, parameterContextSchema).optional(),
  revision: z.number(),
});
export type MediaDraft = z.infer<typeof draftSchema>;
export const emptyDraft = (): MediaDraft => ({
  prompt: '',
  operation: 'image.generate',
  offering: '',
  inputs: [],
  assets: [],
  parameters: { count: 1 },
  revision: 0,
});

const pendingSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('retry'),
    request: mediaRetryRequestSchema,
    jobId: z.string(),
    draftKey: z.string(),
    draftRevision: z.number(),
  }),
  z.object({
    kind: z.literal('submission'),
    request: mediaSubmissionRequestSchema,
    following: mediaSubmissionRequestSchema.optional(),
    after: z.string().optional(),
    draftKey: z.string(),
    draftRevision: z.number(),
  }),
  z.object({
    kind: z.literal('import'),
    request: mediaImportRequestSchema,
    draftKey: z.string(),
    draftRevision: z.number(),
  }),
]);
export type PendingMedia = z.infer<typeof pendingSchema>;
export type MediaSend = (
  command: PendingMedia,
) => Promise<MediaSubmissionReceipt | MediaImportReceipt | undefined>;

export const mediaDraftFamily = atomFamily((key: string) =>
  createSessionAtom(prefix + key, emptyDraft(), draftSchema),
);
export const mediaPendingFamily = atomFamily((scope: string) =>
  createSessionAtom<PendingMedia[]>(prefix + `${scope}:pending`, [], z.array(pendingSchema)),
);
const recoverySchema = z.object({
  job: mediaRecoveryJobSchema,
  request: mediaRecoveryRequestSchema,
});
export type { PendingMediaRecovery } from '~/data-provider';
export const mediaRecoveryFamily = atomFamily((scope: string) =>
  createSessionAtom<PendingMediaRecovery[]>(
    prefix + `${scope}:recovery`,
    [],
    z.array(recoverySchema),
  ),
);
const librarySchema = z.object({
  filter: z.enum(['all', 'pending', 'completed']),
  search: z.string(),
  columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).default(2),
  view: z.enum(['thread', 'gallery']).default('thread'),
  threadId: z.string().optional(),
});
export type MediaLibrary = z.infer<typeof librarySchema>;
export const mediaLibraryFamily = atomFamily((scope: string) =>
  createSessionAtom(
    prefix + `${scope}:library`,
    { filter: 'all', search: '', columns: 2, view: 'thread' } as MediaLibrary,
    librarySchema,
  ),
);

export function clearMediaSessionStorage() {
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const key = sessionStorage.key(i);
      if (key?.startsWith(prefix)) sessionStorage.removeItem(key);
    }
  } catch {
    // Browser storage may be unavailable.
  }
  mediaDraftFamily.setShouldRemove(() => true);
  mediaPendingFamily.setShouldRemove(() => true);
  mediaLibraryFamily.setShouldRemove(() => true);
  mediaRecoveryFamily.setShouldRemove(() => true);
  mediaDraftFamily.setShouldRemove(null);
  mediaPendingFamily.setShouldRemove(null);
  mediaLibraryFamily.setShouldRemove(null);
  mediaRecoveryFamily.setShouldRemove(null);
}
registerSessionCleanup(clearMediaSessionStorage);
