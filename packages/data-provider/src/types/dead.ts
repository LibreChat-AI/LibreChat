/** Stable codes an admin dead-letter request can fail with; a UI maps each to its own copy. */
export const DeadLetterError = {
  invalid: 'DEAD_LETTER_INVALID',
  missing: 'DEAD_LETTER_NOT_FOUND',
  requeue: 'DEAD_LETTER_NOT_REQUEUEABLE',
  dismiss: 'DEAD_LETTER_NOT_DISMISSABLE',
  unavailable: 'DEAD_LETTER_UNAVAILABLE',
  audit: 'DEAD_LETTER_AUDIT_UNAVAILABLE',
} as const;
export type DeadLetterErrorCode = (typeof DeadLetterError)[keyof typeof DeadLetterError];

/** Shown in place of a stored failure code that is not a plain identifier. */
export const DEAD_LETTER_UNCLASSIFIED = 'UNCLASSIFIED';

/**
 * A dead agent trigger delivery as the admin API describes it. The delivery's input,
 * payload, result and failure text are never part of it.
 */
export interface DeadLetter {
  id: string;
  /** Delivery key, as the server logs name the delivery. */
  key: string;
  userId: string;
  source?: string;
  event?: string;
  agentId?: string;
  attempts: number;
  requeues: number;
  code: string;
  requeueable: boolean;
  dismissable: boolean;
  createdAt: string;
  diedAt?: string;
  expiresAt?: string;
}

export interface DeadLetterParams {
  limit?: number;
  offset?: number;
}

export interface DeadLetterPage {
  letters: DeadLetter[];
  total: number;
  limit: number;
  offset: number;
}

export interface DeadLetterRequeued {
  id: string;
  requeued: true;
}

export interface DeadLetterDismissed {
  id: string;
  dismissed: true;
}
