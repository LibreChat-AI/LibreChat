import { z } from 'zod';
import { CODE_APPROVAL_MODES } from '../code/approval';

export const agentQueuedTurnStatuses = [
  'queued',
  'claimed',
  'admitted',
  'cancelled',
  'dead',
] as const;

export const agentQueuedTurnDurability = ['process_local', 'durable'] as const;

export const agentQueuedTurnFileRefSchema = z.object({
  file_id: z.string().trim().min(1),
  type: z.string().optional(),
  filepath: z.string().optional(),
  filename: z.string().optional(),
  height: z.number().optional(),
  width: z.number().optional(),
  bytes: z.number().nonnegative().optional(),
  llmDeliveryPath: z.enum(['provider', 'text', 'none']).optional(),
});
export type TAgentQueuedTurnFileRef = z.infer<typeof agentQueuedTurnFileRefSchema>;

export const enqueueAgentQueuedTurnSchema = z.object({
  conversationId: z.string().trim().min(1),
  parentMessageId: z.string().trim().min(1),
  clientRequestId: z.string().trim().min(1).max(128),
  text: z.string(),
  files: z.array(agentQueuedTurnFileRefSchema).optional(),
  quotes: z.array(z.string()).optional(),
  manualSkills: z.array(z.string().trim().min(1)).optional(),
  /** Selected when queued, revalidated against live policy at turn admission. */
  codeApprovalMode: z.enum(CODE_APPROVAL_MODES).optional(),
  priority: z.boolean().optional(),
  expectedPredecessorCreatedAt: z.number().int().nonnegative().optional(),
});
export type TEnqueueAgentQueuedTurnRequest = z.infer<typeof enqueueAgentQueuedTurnSchema>;

export const listAgentQueuedTurnsSchema = z.object({
  conversationId: z.string().trim().min(1),
  clientRequestIds: z
    .array(z.string().trim().min(1).max(128))
    .max(100)
    .transform((ids) => Array.from(new Set(ids)))
    .optional(),
});
export type TListAgentQueuedTurnsRequest = z.infer<typeof listAgentQueuedTurnsSchema>;

export const cancelAgentQueuedTurnSchema = z.object({
  queuedTurnId: z.string().trim().min(1),
});
export type TCancelAgentQueuedTurnRequest = z.infer<typeof cancelAgentQueuedTurnSchema>;

export const agentQueuedTurnReceiptSchema = enqueueAgentQueuedTurnSchema.extend({
  queuedTurnId: z.string().trim().min(1),
  status: z.enum(agentQueuedTurnStatuses),
  /** Effective generation boundary consumed by an admitted turn. This can
   * advance beyond the originally captured root as queued turns chain. */
  effectivePredecessorCreatedAt: z.number().int().nonnegative().optional(),
  /** Explicitly proves that this admission consumed no predecessor boundary. */
  rootPredecessor: z.literal(true).optional(),
  position: z.number().int().nonnegative().optional(),
  /** Immutable queue sequence retained as `revision` for wire compatibility. */
  revision: z.number().int().nonnegative(),
  failure: z
    .object({
      code: z.string().trim().min(1).max(128),
      message: z.string().max(2048).optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TAgentQueuedTurnReceipt = z.infer<typeof agentQueuedTurnReceiptSchema>;

export const agentQueuedTurnCapabilitySchema = z.discriminatedUnion('supported', [
  z.object({ supported: z.literal(false) }),
  z.object({
    supported: z.literal(true),
    durability: z.enum(agentQueuedTurnDurability),
    /** v2 preserves approval snapshots through admission and execution. */
    protocolVersion: z.literal(2).optional(),
  }),
]);
export type TAgentQueuedTurnCapability = z.infer<typeof agentQueuedTurnCapabilitySchema>;

export const enqueueAgentQueuedTurnResponseSchema = z.object({
  receipt: agentQueuedTurnReceiptSchema,
  capability: agentQueuedTurnCapabilitySchema,
});
export type TEnqueueAgentQueuedTurnResponse = z.infer<typeof enqueueAgentQueuedTurnResponseSchema>;

export const listAgentQueuedTurnsResponseSchema = z.object({
  queuedTurns: z.array(agentQueuedTurnReceiptSchema),
  capability: agentQueuedTurnCapabilitySchema,
  revision: z.number().int().nonnegative(),
});
export type TListAgentQueuedTurnsResponse = z.infer<typeof listAgentQueuedTurnsResponseSchema>;

export const cancelAgentQueuedTurnResponseSchema = z.object({
  receipt: agentQueuedTurnReceiptSchema,
});
export type TCancelAgentQueuedTurnResponse = z.infer<typeof cancelAgentQueuedTurnResponseSchema>;
