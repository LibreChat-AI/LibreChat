import type {
  TMessage,
  TConversation,
  TEditedContent,
  TReasoningOverride,
} from 'librechat-data-provider';

/** The user turn an `ask` call submits. */
export type TAskProps = {
  text: string;
  overrideConvoId?: string;
  overrideUserMessageId?: string;
  parentMessageId?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  clientTimestamp?: string;
};

/** How an `ask` call submits its turn: an edit, a regenerate, a continue or a compaction. */
export type TOptions = {
  editedMessageId?: string | null;
  editedContent?: TEditedContent;
  isRegenerate?: boolean;
  isContinued?: boolean;
  isEdited?: boolean;
  /**
   * Manual context compaction: a summarize-only turn hung off the branch's
   * leaf (`messageId`). Shaped like a regenerate on the client (no new user
   * bubble, the response placeholder parents onto the leaf) and sent with
   * `compact: true` so the server runs the graph summarize-only.
   */
  compact?: boolean;
  overrideMessages?: TMessage[];
  /**
   * Authoritative attachment list for this submission: a rerun replays the edited
   * message's stored files, and an auto-drained queued message replays the ones taken
   * out of the composer when it was queued. Authoritative even when empty, so a drain
   * never vacuums up attachments the user staged for their next send.
   */
  overrideFiles?: TMessage['files'];
  /**
   * Assistant message being regenerated. Used to derive the optimistic response
   * id for non-tail regenerations without accidentally keying the stream to the
   * conversation tail.
   */
  targetResponseMessageId?: string | null;
  /**
   * Carry forward a user message's manually-invoked skills when the caller
   * is resubmitting or regenerating that same message: the compose-time
   * atom has already been drained on the original submit, so without this
   * the second turn would run without any manual priming even though the
   * pills are still visible on the user bubble.
   */
  overrideManualSkills?: string[];
  /**
   * Carry forward a user message's quoted excerpts when resubmitting or
   * regenerating that same message: the compose-time atom is drained on the
   * original submit, so without this the second turn would lose the quoted
   * context even though the references still show on the user bubble.
   */
  overrideQuotes?: string[];
  /** Request-scoped reasoning selection for this exact submission. */
  overrideReasoning?: TReasoningOverride | null;
  /** Added conversation for multi-convo feature - sent to server as part of submission payload */
  addedConvo?: TConversation;
  /** Reuse a durable submission identity (terminal steer recovery). */
  overrideClientRequestId?: string;
  /** Exact parked steer source for a recovery attempt. */
  overrideRecoverySteerId?: string;
  /** Exact terminal generation observed before an automatic queued start. */
  overrideExpectedPredecessorCreatedAt?: number;
  /** Client-only exact queue position restored if admission is rejected. */
  overrideQueuedMessageOrigin?: unknown;
};

export type TAskFunction = (props: TAskProps, options?: TOptions) => false | void;

/** Target of a regenerate: a response to redo, or the user message whose response to redo. */
export type RegenerateTarget = Partial<
  Pick<TMessage, 'messageId' | 'parentMessageId' | 'isCreatedByUser'>
>;

/** Re-runs the response to a message; see `ChatSubmissionContract.regenerate`. */
export type TRegenerateFunction = (
  target: RegenerateTarget,
  options?: { addedConvo?: TConversation | null },
) => void;
