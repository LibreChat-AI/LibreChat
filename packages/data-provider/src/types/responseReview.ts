import { z } from 'zod';
import type { Agents } from './agents';

export const responseReviewDecisionSchema = z
  .object({
    actionId: z.string().min(1).max(256),
    answer: z.string().optional(),
    answers: z.record(z.string(), z.string()).optional(),
    decisions: z
      .array(
        z
          .object({
            tool_call_id: z.string(),
            decision: z.enum(['approve', 'reject', 'edit', 'respond']),
            editedArguments: z.record(z.string(), z.unknown()).optional(),
            responseText: z.string().optional(),
            reason: z.string().optional(),
            scope: z.enum(['once', 'session', 'always']).optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export type ResponseReviewDecision = z.infer<typeof responseReviewDecisionSchema>;
export const responseReviewDecisionReceiptSchema = z.object({
  responseId: z.string().min(1),
  actionId: z.string().min(1),
  intentId: z.string().min(1),
  status: z.enum(['queued', 'settled']),
});
export type ResponseReviewDecisionReceipt = z.infer<typeof responseReviewDecisionReceiptSchema>;
export const responseCancelReceiptSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['queued', 'in_progress', 'completed', 'failed', 'incomplete', 'cancelled']),
});
export type ResponseCancelReceipt = z.infer<typeof responseCancelReceiptSchema>;

/** Owner-authenticated browser view; OAuth URLs must never be delivered to a channel. */
export interface ResponseReviewView {
  /** Missing/mismatched execution is not proof that provider work stopped. */
  recovery?: 'execution_state_unavailable';
  responseId: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'incomplete' | 'cancelled';
  oauth: Array<{
    actionId: string;
    toolName: string;
    authURL: string;
    expiresAt: number;
  }>;
  pendingAction?: Pick<Agents.PendingAction, 'actionId' | 'payload' | 'expiresAt'>;
  pendingDecision?: { intentId: string; decision: ResponseReviewDecision };
  canSubmitDecision?: boolean;
}
