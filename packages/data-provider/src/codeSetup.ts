import { z } from 'zod';

export const codeSetupStatusSchema = z.enum([
  'pending',
  'provisioning',
  'approved',
  'completed',
  'denied',
  'cancelled',
  'expired',
  'failed',
]);

export const codeSetupFailureSchema = z.object({
  code: z.string(),
  retryable: z.boolean(),
});

/** Browser projection only. Credentials, endpoints and local paths never belong here. */
export const codeSetupAttemptSchema = z.object({
  version: z.literal(1),
  attemptId: z.string().min(1),
  status: codeSetupStatusSchema,
  expiresAt: z.string().datetime({ offset: true }),
  verificationCode: z.string(),
  machineName: z.string(),
  workspace: z.object({ type: z.enum(['private', 'directory']) }),
  allowWorkspaceWrites: z.boolean(),
  allowWorkspaceCommands: z.boolean(),
  /** Server-computed SHA-256 of the DER SPKI public key, encoded as lowercase hex. */
  keyFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  controlPlanes: z.array(z.object({ id: z.string().min(1), name: z.string() })),
  controlPlaneId: z.string().optional(),
  failure: codeSetupFailureSchema.optional(),
});

export const codeSetupApprovalRequestSchema = z
  .object({ controlPlaneId: z.string().min(1) })
  .strict();
export const codeSetupDenyRequestSchema = z.object({}).strict();

export type CodeSetupStatus = z.infer<typeof codeSetupStatusSchema>;
export type CodeSetupFailure = z.infer<typeof codeSetupFailureSchema>;
export type CodeSetupAttempt = z.infer<typeof codeSetupAttemptSchema>;
export type CodeSetupApprovalRequest = z.infer<typeof codeSetupApprovalRequestSchema>;
export type CodeSetupDenyRequest = z.infer<typeof codeSetupDenyRequestSchema>;
