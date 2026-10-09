/**
 * What a turn's message writes reported about the conversation row.
 *
 * `saveMessageToDatabase` writes a message and upserts its conversation, and
 * resolves with both. That result is the only in-band evidence of either, and two
 * things in a resumable turn depend on it:
 *
 * - An immediate-mode title is generated in parallel with the response, so it can
 *   resolve before the row exists, and its `saveConvo` runs with `noUpsert` — a
 *   silent no-op against a missing row. It waits on `ready`, which opens as soon
 *   as a write reports the row. Waiting for the end of the turn instead leaves the
 *   database on `New Chat` for the whole run, and every reader that does not hold
 *   the live stream reads that.
 * - A message write that failed is swallowed by BaseClient, or resolves falsy on a
 *   duplicate key it cannot re-read, and the turn retries it later as a bare
 *   message row — which does not append its id to the conversation. The caller asks
 *   `recordedMessageReference(id)` whether that exact row was ever appended, and
 *   repairs the reference when it was not.
 *
 * Those are different facts about one write. `saveMessageToDatabase` hands its saved
 * id to `saveTurnConversation` as `savedMessageId`, which appends only when the id
 * is present — so a write that saved no message still writes the conversation and
 * still reports it, having appended nothing. The row exists, so the title may save;
 * the reference does not, so the repair must run. Tracking the ids rather than a
 * single flag is what lets each of a turn's rows be asked about separately.
 */
export interface ConvoPersistenceSignal {
  /** Awaited by title persistence; resolves once the conversation row exists. */
  readonly ready: Promise<void>;
  /** Opens `ready` unconditionally. The caller knows the row is written. */
  open(): void;
  /**
   * Records what a message write reported. A write that rejects, never settles, or
   * persisted no conversation leaves `ready` shut for the caller's own `open()` to
   * settle: a title written against a row that does not exist is a title silently
   * dropped.
   */
  observeMessageWrite(write: unknown): void;
  /**
   * Whether an observed write appended this exact message row to the conversation.
   * False also means "not yet", so read it only once the writes it observes have
   * settled, and false for a missing id, which nothing could have appended.
   */
  recordedMessageReference(messageId: unknown): boolean;
}

/** What a message write resolves with once it has saved the row and the conversation. */
type MessageWriteResult = {
  message?: { _id?: unknown } | null;
  conversation?: { conversationId?: string | null } | null;
};

const asResult = (value: unknown): MessageWriteResult | undefined =>
  value != null && typeof value === 'object' ? (value as MessageWriteResult) : undefined;

const persistedConversationId = (result?: MessageWriteResult): string | undefined => {
  const conversation = result?.conversation;
  if (conversation == null || typeof conversation !== 'object') {
    return undefined;
  }
  const { conversationId } = conversation;
  return typeof conversationId === 'string' && conversationId !== '' ? conversationId : undefined;
};

/** The id `saveTurnConversation` would have appended. Absent means it appended nothing. */
const appendedMessageId = (result?: MessageWriteResult): unknown => {
  const message = result?.message;
  if (message == null || typeof message !== 'object') {
    return undefined;
  }
  return message._id ?? undefined;
};

export function createConvoPersistenceSignal(): ConvoPersistenceSignal {
  let openGate: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  /** Stringified so an id object and its re-read equivalent compare equal. */
  const appended = new Set<string>();

  return {
    ready,
    open: () => openGate(),
    recordedMessageReference: (messageId: unknown) =>
      messageId != null && appended.has(String(messageId)),
    observeMessageWrite: (write: unknown) => {
      if (write == null || typeof (write as PromiseLike<unknown>).then !== 'function') {
        return;
      }
      void Promise.resolve(write as PromiseLike<unknown>).then(
        (value) => {
          const result = asResult(value);
          if (persistedConversationId(result) == null) {
            return;
          }
          const messageId = appendedMessageId(result);
          if (messageId != null) {
            appended.add(String(messageId));
          }
          openGate();
        },
        /** The write's own owner logs and recovers it; the signal only learns that
         *  nothing was persisted. */
        () => {},
      );
    },
  };
}
