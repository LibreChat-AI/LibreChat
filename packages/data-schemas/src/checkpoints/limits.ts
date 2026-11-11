/**
 * MongoDB's hard per-document ceiling. A checkpoint whose serialized state pushes its
 * document past this cannot be stored — the driver throws `BSONObjectTooLarge` (code 10334).
 */
const MAX_BSON_DOCUMENT_BYTES = 16 * 1024 * 1024;

/**
 * Headroom reserved below {@link MAX_BSON_DOCUMENT_BYTES} for a checkpoint document's
 * non-state fields (ids, metadata, `metadata_search`, BSON framing). The serialized
 * `checkpoint` blob dominates the document; this margin covers everything else so the guard
 * rejects before Mongo does — with a legible error instead of a raw driver failure.
 */
const CHECKPOINT_SIZE_HEADROOM_BYTES = 1024 * 1024;

/**
 * Reject a checkpoint whose serialized state exceeds this. The pause is unrecoverable either
 * way (the document can't be written), so failing here as a typed {@link CheckpointTooLargeError}
 * turns an opaque `BSONObjectTooLarge` crash into an actionable one.
 */
export const CHECKPOINT_HARD_LIMIT_BYTES: number =
  MAX_BSON_DOCUMENT_BYTES - CHECKPOINT_SIZE_HEADROOM_BYTES;

/**
 * Warn once a persisted checkpoint crosses this soft threshold (~50% of the ceiling), so a
 * conversation's checkpoint growth is visible in logs well before it reaches the hard limit.
 */
export const CHECKPOINT_WARN_BYTES: number = 8 * 1024 * 1024;

/**
 * A durable checkpoint whose serialized state exceeds {@link CHECKPOINT_HARD_LIMIT_BYTES} — more
 * than MongoDB can hold in a single document. Thrown BEFORE the doomed write so the run fails
 * with a clear, typed message instead of a raw driver `BSONObjectTooLarge`. The checkpoint cannot
 * be persisted regardless of how it is handled upstream, so a durable resume is impossible.
 */
export class CheckpointTooLargeError extends Error {
  readonly code = 'CHECKPOINT_TOO_LARGE';
  constructor(
    readonly bytes: number,
    readonly limit: number,
    readonly threadId?: string,
  ) {
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    super(
      `Checkpoint state is ${mb(bytes)} MB, over the ${mb(limit)} MB durable limit. ` +
        'This conversation carries too much state to resume — large tool outputs or inlined ' +
        'media are the usual cause. Start a new conversation or reduce context.',
    );
    this.name = 'CheckpointTooLargeError';
  }
}
