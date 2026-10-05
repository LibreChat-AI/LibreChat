import { z } from 'zod';
import { mediaIdSchema, mediaOperationSchema, mediaSelectionSchema } from './requests';
import { mediaErrorCodeSchema, mediaJobPhaseSchema } from './responses';

const fields = {
  clientRequestId: mediaIdSchema,
  expectedVersion: z.number().int().positive().safe(),
  evidence: z.string().trim().min(1),
};
export const mediaRecoveryRequestSchema = z.discriminatedUnion('action', [
  z.object({ ...fields, action: z.literal('resume') }).strict(),
  z
    .object({
      ...fields,
      action: z.literal('settle'),
      terminalStatus: z.enum(['failed', 'cancelled']),
      costUSD: z.number().finite().nonnegative(),
    })
    .strict(),
  z.object({ ...fields, action: z.literal('acknowledge') }).strict(),
]);
export type MediaRecoveryRequest = z.infer<typeof mediaRecoveryRequestSchema>;

export const mediaRecoveryJobSchema = z
  .object({
    ownerId: mediaIdSchema,
    jobId: mediaIdSchema,
    threadId: mediaIdSchema,
    version: z.number().int().positive().safe(),
    phase: mediaJobPhaseSchema,
    executionOwner: z.enum(['chat', 'media']),
    operation: mediaOperationSchema,
    selection: mediaSelectionSchema,
    errorCode: mediaErrorCodeSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    provider: z
      .object({
        certainty: z.enum(['unsubmitted', 'unknown', 'submitted', 'terminal']),
        operationId: z.string().optional(),
        requestId: z.string().optional(),
      })
      .strict(),
    accounting: z
      .object({
        mode: z.enum(['none', 'balance', 'transactions']),
        phase: z.enum(['held', 'settled']).optional(),
        credits: z.number().optional(),
      })
      .strict(),
    allowedActions: z
      .object({ resume: z.boolean(), settle: z.boolean(), acknowledge: z.boolean() })
      .strict(),
  })
  .strict();
export type MediaRecoveryJob = z.infer<typeof mediaRecoveryJobSchema>;
export const mediaWorkerHealthSchema = z
  .object({
    state: z.enum(['starting', 'armed', 'draining', 'unavailable']),
    consecutiveScanFailures: z.number().int().nonnegative(),
    lastScanAt: z.string().datetime().optional(),
  })
  .strict();
export type MediaWorkerHealth = z.infer<typeof mediaWorkerHealthSchema>;
export const mediaRecoveryPageSchema = z
  .object({
    items: z.array(mediaRecoveryJobSchema),
    nextCursor: mediaIdSchema.optional(),
    maxEvidenceChars: z.number().int().positive(),
    worker: mediaWorkerHealthSchema.optional(),
  })
  .strict();
export type MediaRecoveryPage = z.infer<typeof mediaRecoveryPageSchema>;
export const mediaRecoveryCapabilitiesSchema = z
  .object({ canRead: z.boolean(), canManage: z.boolean() })
  .strict();
export type MediaRecoveryCapabilities = z.infer<typeof mediaRecoveryCapabilitiesSchema>;
