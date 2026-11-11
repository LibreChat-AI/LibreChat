import { z } from 'zod';
import { CODE_APPROVAL_MODES } from '../code/approval';
import { MAX_FILE_TEXT_PREVIEW_LENGTH } from './files';
import { reasoningOverrideSchema } from '../schemas';
import { Constants } from '../config';

/** Existing transport bounds, shared with send-time paste fallback. */
export const MAX_AGENT_QUEUED_TURN_TEXT_LENGTH = 16_000;
export const DEFAULT_STEER_MAX_LENGTH = 16_000;

export const agentQueuedTurnStatuses = [
  'queued',
  'claimed',
  'admitted',
  'cancelled',
  'dead',
] as const;

export const agentQueuedTurnDurability = ['process_local', 'durable'] as const;

/** Longest `clientRequestId` a queued turn may carry. */
export const MAX_QUEUED_TURN_REQUEST_ID_LENGTH = 128;

export const agentQueuedTurnFileRefSchema = z.object({
  file_id: z.string().trim().min(1),
  type: z.string().optional(),
  filepath: z.string().optional(),
  filename: z.string().optional(),
  textPreview: z.string().max(MAX_FILE_TEXT_PREVIEW_LENGTH).optional(),
  height: z.number().optional(),
  width: z.number().optional(),
  bytes: z.number().nonnegative().optional(),
  llmDeliveryPath: z.enum(['provider', 'text', 'none']).optional(),
});
export type TAgentQueuedTurnFileRef = z.infer<typeof agentQueuedTurnFileRefSchema>;

export const enqueueAgentQueuedTurnSchema = z.object({
  conversationId: z.string().trim().min(1),
  parentMessageId: z.string().trim().min(1).max(Constants.MAX_RESPONSE_MESSAGE_ID_LENGTH),
  clientRequestId: z.string().trim().min(1).max(MAX_QUEUED_TURN_REQUEST_ID_LENGTH),
  text: z.string(),
  files: z.array(agentQueuedTurnFileRefSchema).optional(),
  quotes: z.array(z.string()).optional(),
  manualSkills: z.array(z.string().trim().min(1)).optional(),
  /** Selected when queued, revalidated against live policy at turn admission. */
  codeApprovalMode: z.enum(CODE_APPROVAL_MODES).optional(),
  reasoningOverride: reasoningOverrideSchema.optional(),
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
  /** Present on a turn promoted from a steer its run accepted but never
   * applied. It names the steer by both of its ids, so any pane can retire
   * its own copy of that steer from the receipt list alone. `owned` is set
   * once the turn was proven the sole holder of the steer's words. */
  steer: z
    .object({
      steerId: z.string().trim().min(1),
      clientSteerId: z.string().trim().min(1),
      owned: z.literal(true).optional(),
    })
    .optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type TAgentQueuedTurnReceipt = z.infer<typeof agentQueuedTurnReceiptSchema>;

const PROMOTED_STEER_REQUEST_PREFIX = 'steer-leftover:';

/** Queued-turn request id of a steer promoted at run end, derived from the id
 * the sending pane chose. A replayed promotion resolves to the same row, and a
 * pane can ask for the turn's receipt by the steer it still holds, whatever
 * state the turn has reached and whether or not the pane saw FINAL. */
export function getPromotedSteerRequestId(clientSteerId: string): string {
  return `${PROMOTED_STEER_REQUEST_PREFIX}${clientSteerId}`;
}

/** An accepted steer the run ended without applying, which the server turned
 * into a durable queued turn. `steerId`/`clientSteerId` name the chip it replaces. */
export type TPromotedSteer = {
  steerId: string;
  clientSteerId?: string;
  receipt: TAgentQueuedTurnReceipt;
};

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
