import type { TPendingSteer } from 'librechat-data-provider';

/** SSE streaming event (on_run_step, on_message_delta, etc.) */
export type StreamEvent = {
  event: string;
  data: string | Record<string, unknown>;
};

/** Control event emitted when user message is created and generation starts */
export type CreatedEvent = {
  created: true;
  message: {
    messageId: string;
    parentMessageId?: string;
    conversationId?: string;
    text?: string;
    privacyRevision?: string;
    sender: string;
    isCreatedByUser: boolean;
    /** Quoted excerpts referenced on this turn, carried through resumable job
     *  metadata so reconstructed user messages keep their `MessageQuotes`. */
    quotes?: string[];
  };
  streamId: string;
};

export type FinalMessageFields = {
  messageId?: string;
  parentMessageId?: string;
  conversationId?: string;
  text?: string;
  content?: unknown[];
  sender?: string;
  isCreatedByUser?: boolean;
  unfinished?: boolean;
  /** Per-message error flag — matches TMessage.error (boolean or error text) */
  error?: boolean | string;
  [key: string]: unknown;
};

/** Terminal event emitted when generation completes or is aborted */
export type FinalEvent = {
  final: true;
  /** The terminal status CAS committed, but its normal FINAL payload was not
   * durably published (for example, the owner crashed in that narrow window).
   * Clients close the stream and refetch authoritative message/status state. */
  reconcile?: boolean;
  reconcileReason?: 'terminal_payload_missing' | 'generation_replaced' | 'abort_persistence_failed';
  terminalStatus?: 'complete' | 'error' | 'aborted';
  generationCreatedAt?: number;
  requestMessage?: FinalMessageFields | null;
  responseMessage?: FinalMessageFields | null;
  conversation?: { conversationId?: string; [key: string]: unknown } | null;
  title?: string;
  aborted?: boolean;
  earlyAbort?: boolean;
  runMessages?: FinalMessageFields[];
  /** Steers that never reached an injection boundary; the client converts
   *  them to queued follow-up messages instead of dropping them. */
  pendingSteers?: TPendingSteer[];
  /** Top-level event error (abort-during-completion edge case) */
  error?: { message: string };
};

export type ServerSentEvent = StreamEvent | CreatedEvent | FinalEvent;
