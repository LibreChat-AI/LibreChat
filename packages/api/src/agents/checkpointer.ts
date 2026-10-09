import mongoose from 'mongoose';
import { INTERRUPT } from '@langchain/langgraph-checkpoint';
import { MongoDBSaver } from '@langchain/langgraph-checkpoint-mongodb';
import { buildIndexWithRetry, isIndexBuildInProgress, logger } from '@librechat/data-schemas';
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  CheckpointTuple,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { IndexBuildOptions } from '@librechat/data-schemas';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { ResolvedCheckpointerConfig } from './checkpoints/config';
import {
  OwnedMongoSaver,
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from './checkpoints/saver';
import { checkpointOwnerNamespacePrefix } from '../stream/checkpoints';
import { resolveCheckpointerConfig } from './checkpoints/config';

export {
  LIBRECHAT_CHECKPOINT_OWNER_KEY,
  LIBRECHAT_LEGACY_CHECKPOINT_KEY,
} from './checkpoints/saver';
export { checkpointOwnerNamespacePrefix } from '../stream/checkpoints';

export { resolveCheckpointerConfig } from './checkpoints/config';
export {
  checkpointStorageConfigs,
  LIBRECHAT_CHECKPOINT_STORAGE_OWNER_KEY,
} from './checkpoints/storage';
export type { ResolvedCheckpointerConfig } from './checkpoints/config';
export { DEFAULT_CHECKPOINT_TTL_SECONDS } from '../stream/checkpoints';

/**
 * LangGraph reserves `checkpoint_ns` for nested graph namespaces and forcibly
 * resets a non-empty value to `''` for every root invocation. Carry LibreChat's
 * immutable generation scope on a private configurable key instead; the saver
 * adapter below maps it into Mongo's storage namespace without changing the
 * graph-visible conversation `thread_id`.
 */
export const LIBRECHAT_CHECKPOINT_NAMESPACE_KEY = '__librechat_checkpoint_ns';
/** Marks a checkpoint write as belonging to an isolated event-actor attempt.
 * Unlike ordinary clean chat exits, these exits are durable candidate heads. */
export const LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY = '__librechat_event_actor_invocation_id';

const CHECKPOINT_NAMESPACE_SEPARATOR = '|';

function generationCheckpointNamespace(config: RunnableConfig): string | undefined {
  const value = config.configurable?.[LIBRECHAT_CHECKPOINT_NAMESPACE_KEY];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isEventActorInvocation(config: RunnableConfig): boolean {
  const value = config.configurable?.[LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY];
  return typeof value === 'string' && value.length > 0;
}

/** Prefix every root/subgraph storage namespace with the immutable generation. */
function toStorageCheckpointConfig(config: RunnableConfig): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(config);
  if (!generationNamespace) {
    return config;
  }
  const graphNamespace =
    typeof config.configurable?.checkpoint_ns === 'string' ? config.configurable.checkpoint_ns : '';
  return {
    ...config,
    configurable: {
      ...config.configurable,
      checkpoint_ns:
        graphNamespace === ''
          ? generationNamespace
          : `${generationNamespace}${CHECKPOINT_NAMESPACE_SEPARATOR}${graphNamespace}`,
    },
  };
}

/** Restore the namespace LangGraph supplied while retaining the private scope. */
function fromStorageCheckpointConfig(
  storedConfig: RunnableConfig,
  requestedConfig: RunnableConfig,
): RunnableConfig {
  const generationNamespace = generationCheckpointNamespace(requestedConfig);
  if (!generationNamespace) {
    return storedConfig;
  }
  const graphNamespace =
    typeof requestedConfig.configurable?.checkpoint_ns === 'string'
      ? requestedConfig.configurable.checkpoint_ns
      : '';
  return {
    ...storedConfig,
    configurable: {
      ...storedConfig.configurable,
      ...(requestedConfig.configurable?.[LIBRECHAT_CHECKPOINT_OWNER_KEY] && {
        [LIBRECHAT_CHECKPOINT_OWNER_KEY]:
          requestedConfig.configurable[LIBRECHAT_CHECKPOINT_OWNER_KEY],
      }),
      ...(requestedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] && {
        [LIBRECHAT_LEGACY_CHECKPOINT_KEY]:
          storedConfig.configurable?.[LIBRECHAT_LEGACY_CHECKPOINT_KEY] ??
          requestedConfig.configurable[LIBRECHAT_LEGACY_CHECKPOINT_KEY],
      }),
      thread_id: requestedConfig.configurable?.thread_id ?? storedConfig.configurable?.thread_id,
      checkpoint_ns: graphNamespace,
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: generationNamespace,
    },
  };
}

function fromStorageCheckpointTuple(
  tuple: CheckpointTuple,
  requestedConfig: RunnableConfig,
): CheckpointTuple {
  return {
    ...tuple,
    config: fromStorageCheckpointConfig(tuple.config, requestedConfig),
    ...(tuple.parentConfig && {
      parentConfig: fromStorageCheckpointConfig(tuple.parentConfig, requestedConfig),
    }),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Mongo filter matching a generation's root and every nested graph namespace. */
function generationNamespaceFilter(checkpointNamespace: string): string | { $regex: string } {
  if (checkpointNamespace === '') {
    return '';
  }
  return {
    $regex: `^${escapeRegExp(checkpointNamespace)}(?:\\${CHECKPOINT_NAMESPACE_SEPARATOR}|$)`,
  };
}

/**
 * Durable checkpointing for human-in-the-loop (HITL) resume.
 *
 * This is the seam between LibreChat and LangGraph's checkpoint machinery. A run
 * that pauses for tool approval suspends its graph state to a checkpoint; resuming
 * rebuilds that state on a *fresh* `Run` (see `agents/run.ts`), which only works if
 * the checkpoint outlives the original request — across a restart, or on another
 * replica. So HITL needs a durable saver, not the SDK's process-local `MemorySaver`.
 *
 * Two adapters sit behind the one interface ({@link getAgentCheckpointer}):
 *   - `MongoDBSaver` over the app's existing Mongo connection (the default), and
 *   - `undefined`, which lets the SDK install its own in-process `MemorySaver`
 *     (single-process / dev, or whenever Mongo isn't ready yet).
 *
 * Storage is bounded two ways: a Mongo TTL index reclaims runs that are never
 * resolved ({@link DEFAULT_CHECKPOINT_TTL_SECONDS}), and {@link deleteAgentCheckpoint}
 * prunes a thread's checkpoints after ordinary terminal transitions. Approval
 * expiry relies on the TTL because a thread-wide eager delete can race a replacement run.
 */

/**
 * Soft size threshold that triggers a sweep of STALE write-anchor ids. The map normally
 * holds a handful (each id is consumed by the `put` that immediately follows its
 * `putWrites`); this only bounds a slow leak from a process that dies in that window.
 */
const WRITE_ANCHOR_SWEEP_THRESHOLD = 1024;

/**
 * A write-anchor id is considered stale once this much wall-clock has passed without its
 * matching `put` — a `put` always follows its `putWrites` within the same exit sequence
 * (milliseconds), so anything this old is from a crashed run, never a valid in-flight id.
 * Generous on purpose: we would rather keep a tracked id slightly too long than evict a
 * valid one and mis-classify its (possibly slow-I/O) interrupt `put` as a clean exit.
 */
const WRITE_ANCHOR_STALE_MS = 5 * 60 * 1000;

/**
 * Does a pending-write batch make its checkpoint worth persisting (ANCHOR it)? True if it
 * carries an interrupt (the HITL pause that resume targets) or any real state/delta channel
 * write (a value a later checkpoint's resume depends on). False for pure bookkeeping batches —
 * `__error__` (a failed, non-paused turn), `__no_writes__` (a task that completed without state
 * updates), a lone `__resume__`, `__scheduled__` — which never justify keeping a checkpoint on
 * their own. A false verdict does NOT mean the batch is discarded: bookkeeping rows are still
 * required when the checkpoint is retained (see the buffering in `LazyMongoSaver.putWrites`);
 * this predicate only decides anchoring.
 *
 * `INTERRUPT` is the one `__`-prefixed channel that IS anchor-worthy; every other `__…__`
 * channel is langgraph bookkeeping. Constants verified against `@langchain/langgraph`.
 */
function hasResumableWrite(writes: PendingWrite[]): boolean {
  return (writes ?? []).some(([channel]) => {
    const name = String(channel);
    return name === INTERRUPT || !name.startsWith('__');
  });
}

/**
 * A `MongoDBSaver` that persists ONLY checkpoints carrying a {@link hasResumableWrite resumable}
 * pending write — an interrupt (a HITL pause) or a real-channel/delta anchor — and discards both
 * the no-write checkpoint LangGraph writes on a CLEAN exit and the bookkeeping-only checkpoint of
 * a failed (non-paused) turn.
 *
 * **Why.** With `durability: 'exit'` (set by the SDK whenever a checkpointer is active) the
 * graph persists exactly one checkpoint at the exit boundary on EVERY run — paused or not.
 * A non-paused turn therefore writes a dead checkpoint whose only fate is to be pruned by
 * {@link deleteAgentCheckpoint}. HITL only ever resumes a checkpoint that has pending writes,
 * so the clean (write-less) exit checkpoint is pure write+delete churn on the common path.
 * This saver skips it.
 *
 * **How it tells them apart** (verified empirically with throwaway runnable probes against
 * `@langchain/langgraph@1.4`, not source-reading): under `durability: 'exit'` LangGraph
 * calls `putWrites` for a checkpoint BEFORE the `put` that creates it, with `config.checkpoint_id`
 * equal to that `put`'s `checkpoint.id`. An interrupt records an `INTERRUPT` ("__interrupt__")
 * write; a delta-channel graph records its delta writes on a real (non-`__`-prefixed) channel.
 * A CLEAN exit produces a checkpoint with NO pending writes. So we record the checkpoint id of
 * each `putWrites` that carries a {@link hasResumableWrite resumable} write and persist a `put`
 * only when its `checkpoint.id` was so marked — which keeps interrupt checkpoints AND any
 * real-channel/delta anchors (resume can walk the chain), while dropping the write-less clean
 * exit. Keying on the globally-unique checkpoint id (NOT thread_id) stays correct even when two
 * runs race on the same conversation (`thread_id`).
 *
 * **Bookkeeping batches follow their checkpoint's fate.** Only a {@link hasResumableWrite
 * resumable} batch ANCHORS a checkpoint (justifies persisting it); a bookkeeping-only batch
 * (`__error__`, `__no_writes__`, a lone `__resume__`, …) never does — but whether its ROWS matter
 * depends on whether the checkpoint survives, which `put` decides later. Probe-confirmed both
 * ways: a failed non-paused turn emits `putWrites([__error__])` + `put` — persisting either half
 * would leak (an orphan row or a dead checkpoint) — while a paused Send fan-out records completed
 * siblings as `__no_writes__` markers on the RETAINED interrupt checkpoint, and dropping those
 * re-executes the siblings on resume (duplicated side effects). So bookkeeping batches are
 * BUFFERED in memory until the fate is known: forwarded once the checkpoint is anchored (or was
 * just persisted), dropped when its `put` discards it. Net effect: an errored turn still leaves
 * NOTHING durable (0 checkpoints, 0 write rows), and a retained checkpoint keeps EVERY pending
 * write LangGraph recorded for it — byte-for-byte what a plain `MongoDBSaver` would store.
 *
 * For LibreChat's agent graph (standard `Annotation`/`MessagesAnnotation` channels, no
 * `DeltaChannel` — grep-confirmed in `@librechat/agents`) a clean run makes no `putWrites` at all,
 * so this is effectively interrupt-only and the common path writes nothing; the broader
 * real-channel rule just keeps it honest for delta graphs.
 *
 * **Invariant.** Correctness depends on `durability: 'exit'` (which the SDK sets whenever a
 * checkpointer is active): exactly one parentless boundary checkpoint per run, with its
 * `putWrites` ordered before its `put`. Under per-step durability LangGraph instead emits
 * `put`-before-`putWrites` for chained checkpoints — the anchor would arrive too late and a
 * checkpoint could be wrongly discarded. The SDK never runs HITL that way; if that ever changes,
 * this saver must be revisited (a parent-based guard is NOT viable — a resumed turn's clean
 * completion is itself a parented, write-less checkpoint that we correctly discard).
 *
 * **Correctness.** Checkpoints with resumable writes (interrupt + real-channel/delta anchor) and
 * the writes themselves persist exactly as before, so resume is unchanged. The write-less clean
 * checkpoint (and the now-discarded error-only checkpoint) was only ever written-then-pruned, so
 * not writing it is observationally equivalent; the pre-run prune + Mongo TTL remain the
 * backstops. The saver overrides every config-bearing read/write path to apply
 * generation storage scoping; `deleteThread` and `setup` remain inherited.
 */
/** A bookkeeping-only pending-write batch held until its checkpoint's fate is decided. */
interface BufferedWriteBatch {
  at: number;
  batches: Array<{ config: RunnableConfig; writes: PendingWrite[]; taskId: string }>;
}

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

/**
 * Construction options for {@link LazyMongoSaver}: the base saver options plus optional
 * size-guard overrides. The overrides default to the module thresholds and exist so tests can
 * exercise the guard at small sizes; production always uses the defaults.
 */
export type LazyMongoSaverOptions = ConstructorParameters<typeof MongoDBSaver>[0] & {
  /** Soft warn threshold in bytes. Defaults to {@link CHECKPOINT_WARN_BYTES}. */
  warnBytes?: number;
  /** Hard reject limit in bytes. Defaults to {@link CHECKPOINT_HARD_LIMIT_BYTES}. */
  hardLimitBytes?: number;
};

export class LazyMongoSaver extends OwnedMongoSaver {
  /** checkpoint id → time the resumable `putWrites` anchoring it arrived; consumed by `put`. */
  private readonly writeAnchorIds = new Map<string, number>();
  /** checkpoint id → time its anchored `put` persisted it, so a bookkeeping batch that lands
   * after the `put` (concurrent dispatch) is forwarded instead of buffered forever. */
  private readonly persistedIds = new Map<string, number>();
  /** checkpoint id → bookkeeping batches parked until the checkpoint persists or is discarded. */
  private readonly bufferedBookkeeping = new Map<string, BufferedWriteBatch>();

  /** Soft threshold (bytes) past which a persisted checkpoint is warned about. */
  private readonly warnBytes: number;
  /** Hard limit (bytes) past which a checkpoint is refused with {@link CheckpointTooLargeError}. */
  private readonly hardLimitBytes: number;

  constructor(options: LazyMongoSaverOptions) {
    const { warnBytes, hardLimitBytes, ...mongoOptions } = options;
    super(mongoOptions);
    this.warnBytes = warnBytes ?? CHECKPOINT_WARN_BYTES;
    this.hardLimitBytes = hardLimitBytes ?? CHECKPOINT_HARD_LIMIT_BYTES;
  }

  /**
   * LangGraph normalizes every root invocation to `checkpoint_ns: ''` before
   * touching the saver. Map LibreChat's private generation key into Mongo's
   * namespace at this storage boundary, then restore the graph-visible config
   * on the way out. This keeps callbacks/tools on the real conversation
   * `thread_id` while making replacement generations physically disjoint.
   */
  override async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const tuple = await super.getTuple(toStorageCheckpointConfig(config));
    return tuple ? fromStorageCheckpointTuple(tuple, config) : undefined;
  }

  override async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const storageConfig = toStorageCheckpointConfig(config);
    const storageOptions = options?.before
      ? { ...options, before: toStorageCheckpointConfig(options.before) }
      : options;
    for await (const tuple of super.list(storageConfig, storageOptions)) {
      yield fromStorageCheckpointTuple(tuple, config);
    }
  }

  override async putWrites(
    config: RunnableConfig,
    writes: PendingWrite[],
    taskId: string,
  ): Promise<void> {
    const storageConfig = toStorageCheckpointConfig(config);
    if (isEventActorInvocation(config)) {
      return super.putWrites(storageConfig, writes, taskId);
    }
    const checkpointId = config.configurable?.checkpoint_id as string | undefined;
    if (!checkpointId) {
      // No checkpoint id to tie a fate to — forward untouched (the base saver's contract).
      return super.putWrites(storageConfig, writes, taskId);
    }
    if (!hasResumableWrite(writes)) {
      // A bookkeeping-only batch (`__error__` from a failed turn, a completed Send-sibling's
      // `__no_writes__` marker, a lone `__resume__`, …). It must NOT anchor the checkpoint,
      // but its rows follow the checkpoint's fate: required on a RETAINED checkpoint
      // (probe-confirmed — dropping a sibling's `__no_writes__` marker re-executes the
      // sibling on resume), an orphan on a discarded one. Forward when the fate is already
      // known to be "persist"; otherwise buffer until an anchoring batch or `put` decides.
      if (this.writeAnchorIds.has(checkpointId) || this.persistedIds.has(checkpointId)) {
        return super.putWrites(storageConfig, writes, taskId);
      }
      const buffered = this.bufferedBookkeeping.get(checkpointId);
      if (buffered) {
        buffered.batches.push({ config: storageConfig, writes, taskId });
      } else {
        sweepStale(this.bufferedBookkeeping, (b) => b.at);
        this.bufferedBookkeeping.set(checkpointId, {
          at: Date.now(),
          batches: [{ config: storageConfig, writes, taskId }],
        });
      }
      return;
    }
    // A resumable batch — an interrupt (a HITL pause) or a real state/delta channel a later
    // checkpoint depends on — anchors the checkpoint so its `put` persists it. Keyed on the
    // globally-unique checkpoint id so concurrent runs on the same `thread_id` can't
    // cross-consume anchors. The anchor is recorded BEFORE the awaited super call on purpose:
    // LangGraph dispatches the matching `put` concurrently with `putWrites` (probe-confirmed),
    // so recording after the await could let a slow-I/O interrupt `put` miss its anchor and be
    // wrongly discarded.
    this.recordWriteAnchor(checkpointId);
    try {
      // The checkpoint's fate is now "persist" — flush the bookkeeping batches that
      // arrived before this anchor so the stored pending writes are complete.
      await this.flushBufferedBookkeeping(checkpointId);
      return await super.putWrites(storageConfig, writes, taskId);
    } catch (err) {
      // The write batch never landed — best-effort un-anchor so the concurrent `put` doesn't
      // persist a checkpoint whose pending writes are missing (an unresumable phantom pause).
      // If `put` already consumed the anchor, the thrown error still fails the run and the
      // pre-run prune / Mongo TTL reclaim the orphan.
      this.writeAnchorIds.delete(checkpointId);
      throw err;
    }
  }

  override async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    if (isEventActorInvocation(config)) {
      await this.assertCheckpointFitsDocument(config, checkpoint, metadata);
      const persisted = await super.put(toStorageCheckpointConfig(config), checkpoint, metadata);
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      return fromStorageCheckpointConfig(persisted, config);
    }
    if (this.writeAnchorIds.delete(checkpoint.id)) {
      // Carries a resumable write (interrupt / real-channel delta anchor) — persist so resume
      // can read it, and remember the id briefly so any bookkeeping batch dispatched after
      // this `put` is forwarded rather than parked.
      await this.assertCheckpointFitsDocument(config, checkpoint, metadata);
      sweepStale(this.persistedIds, (t) => t);
      this.persistedIds.set(checkpoint.id, Date.now());
      const persisted = await super.put(toStorageCheckpointConfig(config), checkpoint, metadata);
      logger.debug(
        `[checkpointer] Persisted durable checkpoint for thread ${config.configurable?.thread_id ?? 'unknown'} (${checkpoint.id})`,
      );
      // `assertCheckpointFitsDocument` awaits a (potentially slow) serialization AFTER the
      // anchor was consumed above but BEFORE `persistedIds` was set — a bookkeeping-only
      // `putWrites` dispatched in that window sees neither marker and parks its batch. Flush
      // it now that the checkpoint is persisted; without this the marker is dropped and a
      // resume can re-execute already-completed work.
      await this.flushBufferedBookkeeping(checkpoint.id);
      return fromStorageCheckpointConfig(persisted, config);
    }
    // No resumable writes ⇒ a clean exit (a non-paused completion, a resumed turn's clean
    // finish, or an error-only turn): discard, and drop the parked bookkeeping batches with
    // it — this is what keeps a failed turn from leaving orphan rows in the writes
    // collection. Return the config LangGraph expects (pointing at the checkpoint it believes
    // was saved) so the run finishes normally; nothing durable is written.
    this.bufferedBookkeeping.delete(checkpoint.id);
    return {
      ...config,
      configurable: {
        ...config.configurable,
        checkpoint_id: checkpoint.id,
      },
    };
  }

  /**
   * Track a checkpoint id whose `put` must persist it. Evicts ONLY genuinely-stale ids
   * (older than {@link WRITE_ANCHOR_STALE_MS}, i.e. from a crashed run whose `put` never
   * landed) — never a recent in-flight id — so a slow-I/O interrupt `put` is never
   * mis-classified as a clean exit. If nothing is stale the map is allowed to grow rather
   * than drop a valid id; the next sweep reclaims the crashed ones.
   */
  private recordWriteAnchor(checkpointId: string): void {
    sweepStale(this.writeAnchorIds, (t) => t);
    this.writeAnchorIds.set(checkpointId, Date.now());
  }

  /**
   * Forward the bookkeeping batches parked for `checkpointId` while its fate was undecided,
   * now that the checkpoint is being persisted. Snapshot-and-delete before awaiting so a batch
   * that arrives afterwards can't be double-forwarded — by then the anchor/persisted marker is
   * set, so it forwards directly instead of parking. Shared by the anchoring `putWrites` and by
   * `put` (for a batch parked during the size-check serialization window).
   */
  private async flushBufferedBookkeeping(checkpointId: string): Promise<void> {
    const buffered = this.bufferedBookkeeping.get(checkpointId);
    if (!buffered) {
      return;
    }
    this.bufferedBookkeeping.delete(checkpointId);
    await Promise.all(buffered.batches.map((b) => super.putWrites(b.config, b.writes, b.taskId)));
  }

  /**
   * Measure the checkpoint's serialized size on the persist path and act on it: `debug`-log it,
   * `warn` past {@link warnBytes}, and throw {@link CheckpointTooLargeError} past
   * {@link hardLimitBytes} — BEFORE the write, so an oversize pause fails legibly rather than as a
   * raw `BSONObjectTooLarge`. Serializes with the same `serde` the base `put` uses, so the measured
   * bytes match what would be stored. The extra serialization runs only when a checkpoint is
   * selected for durable retention: HITL pauses and event-actor invocation heads.
   */
  private async assertCheckpointFitsDocument(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<void> {
    // `MongoDBSaver.put` writes THREE size-bearing fields into the same
    // `agent_checkpoints` document: the serialized `checkpoint`, the serialized
    // `metadata`, AND `metadata_search` — the WHOLE raw `metadata` object stored a
    // second time as a queryable BSON subdocument (`metadata_search: metadata`).
    // So a large `metadata` (e.g. `metadata.writes` holding a big tool result) is
    // counted twice on the wire. Measuring only checkpoint + serialized metadata
    // let such a document pass the preflight while `metadata_search` pushed the
    // actual BSON past 16 MB — the raw `BSONObjectTooLarge` this guard exists to
    // prevent. Add the raw metadata's BSON size; the headroom now only has to
    // cover ids and BSON framing.
    const [, serializedCheckpoint] = await this.serde.dumpsTyped(checkpoint);
    const [, serializedMetadata] = await this.serde.dumpsTyped(metadata);
    const metadataSearchBytes = mongoose.mongo.BSON.calculateObjectSize(
      metadata as unknown as Record<string, unknown>,
    );
    const bytes =
      serializedCheckpoint.byteLength + serializedMetadata.byteLength + metadataSearchBytes;
    const threadId = config.configurable?.thread_id as string | undefined;
    const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
    if (bytes > this.hardLimitBytes) {
      // The anchoring write row was already persisted by `putWrites`; the pre-run prune and Mongo
      // TTL reclaim it. Drop any parked bookkeeping so it doesn't linger in memory.
      this.bufferedBookkeeping.delete(checkpoint.id);
      logger.error(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, over the ${mb(this.hardLimitBytes)} MB limit; refusing the write (a document past 16 MB cannot be stored in MongoDB).`,
      );
      throw new CheckpointTooLargeError(bytes, this.hardLimitBytes, threadId);
    }
    if (bytes >= this.warnBytes) {
      logger.warn(
        `[checkpointer] Durable checkpoint for thread ${threadId ?? 'unknown'} is ${mb(bytes)} MB, past the ${mb(this.warnBytes)} MB soft threshold (hard limit ${mb(this.hardLimitBytes)} MB) — approaching MongoDB's single-document ceiling.`,
      );
      return;
    }
    logger.debug(
      `[checkpointer] Prepared durable checkpoint for thread ${threadId ?? 'unknown'}: ${bytes} bytes`,
    );
  }
}

/**
 * Evict genuinely-stale entries from a fate-tracking map once it is crowded
 * ({@link WRITE_ANCHOR_SWEEP_THRESHOLD}). Entries from a crashed run (older than
 * {@link WRITE_ANCHOR_STALE_MS}) are reclaimed; recent in-flight entries never are.
 */
function sweepStale<T>(map: Map<string, T>, timeOf: (value: T) => number): void {
  if (map.size < WRITE_ANCHOR_SWEEP_THRESHOLD) {
    return;
  }
  const now = Date.now();
  for (const [id, value] of map) {
    if (now - timeOf(value) > WRITE_ANCHOR_STALE_MS) {
      map.delete(id);
    }
  }
}

/**
 * Exact checkpoint ids present before a legacy, unscoped generation is claimed.
 *
 * New jobs delete their immutable saver scope wholesale at terminal ownership.
 * Legacy jobs share storage, so cleanup deletes only this captured set; a later
 * replacement's fresh checkpoint ids cannot be removed by the delayed cleanup.
 */
export interface AgentCheckpointGeneration {
  threadId: string;
  /** Nonempty saver-level generation scope. Missing means a legacy
   * thread-wide capture; an empty string is invalid because it would omit the
   * legacy generation's nested LangGraph namespaces during deletion. */
  checkpointNamespace?: string;
  checkpointIds: string[];
}

/** Approval-window milliseconds from the resolved config; drives pending-action expiry. */
export function getApprovalTtlMs(cfg: TCheckpointerConfig | undefined): number {
  return resolveCheckpointerConfig(cfg).ttlSeconds * 1000;
}

/**
 * Prove that the durable saver contains a complete interrupt checkpoint for one generation.
 *
 * A pending Redis action is useful only when LangGraph can reload the state it
 * interrupted. Read the exact checkpoint selected by the current interrupt and
 * require its matching interrupt id, so an older retained pause cannot satisfy
 * verification for a missing or misrouted re-pause.
 * This runs once per interrupt, never on the ordinary generation path.
 */
export async function hasDurableAgentInterruptCheckpoint(
  threadId: string,
  cfg?: TCheckpointerConfig,
  options?: {
    checkpointNamespace?: string;
    checkpointId: string;
    checkpointNs?: string;
    interruptId: string;
  },
): Promise<boolean> {
  if (!threadId || !options?.checkpointId || !options.interruptId) {
    return false;
  }
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return false;
  }

  const checkpointNamespace = options?.checkpointNamespace ?? '';
  const tuple = await saver.getTuple({
    configurable: {
      thread_id: threadId,
      checkpoint_ns: options.checkpointNs ?? '',
      checkpoint_id: options.checkpointId,
      ...(checkpointNamespace !== '' && {
        [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: checkpointNamespace,
      }),
    },
  });
  if (tuple?.checkpoint.id !== options.checkpointId) {
    return false;
  }
  return (tuple.pendingWrites ?? []).some((write) => {
    if (write[1] !== INTERRUPT) {
      return false;
    }
    const values = Array.isArray(write[2]) ? write[2] : [write[2]];
    return values.some(
      (value) =>
        value != null &&
        typeof value === 'object' &&
        'id' in value &&
        value.id === options.interruptId,
    );
  });
}

/**
 * One saver per process, built lazily on first use so `setup()` (index creation)
 * runs exactly once. Keyed by the resolved settings so a config change rebuilds.
 */
let saverPromise: Promise<MongoDBSaver | undefined> | undefined;
let cachedKey: string | undefined;

function settingsKey(resolved: ResolvedCheckpointerConfig): string {
  return `${resolved.checkpointCollectionName}|${resolved.checkpointWritesCollectionName}|${resolved.ttlSeconds}`;
}

/**
 * The durable saver to hand to `graphConfig.compileOptions.checkpointer`, or
 * `undefined` to let the SDK fall back to its in-process `MemorySaver`.
 *
 * Returns `undefined` (without caching) when the config selects `memory` or when
 * Mongo isn't connected yet, so a later run retries once the connection is up.
 * The SDK types the checkpointer as `unknown`, so a `MongoDBSaver` passes directly.
 */
export async function getAgentCheckpointer(
  cfg: TCheckpointerConfig | undefined,
): Promise<MongoDBSaver | undefined> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') {
    return undefined;
  }
  if (mongoose.connection.readyState !== 1) {
    logger.warn(
      '[checkpointer] Mongoose not connected; durable agent continuations will use an in-process checkpointer this turn and will not survive a restart or resolve on another replica.',
    );
    return undefined;
  }

  const key = settingsKey(resolved);
  if (!saverPromise || cachedKey !== key) {
    cachedKey = key;
    saverPromise = buildMongoSaver(resolved);
  }
  return saverPromise;
}

export interface AgentEventCheckpointReference {
  threadId: string;
  checkpointId: string;
  checkpointNs: string;
}

export interface AgentEventCheckpointMessageOverlay {
  source: string;
  messages: readonly BaseMessage[];
}

function applyAgentEventCheckpointMessageOverlay(
  checkpoint: Checkpoint,
  overlay: AgentEventCheckpointMessageOverlay | undefined,
): Checkpoint {
  if (overlay == null) {
    return checkpoint;
  }
  const channelValues = checkpoint.channel_values;
  const messages = Array.isArray(channelValues.messages) ? channelValues.messages : [];
  const retainedMessages = messages.filter((message) => {
    if (message == null || typeof message !== 'object') {
      return true;
    }
    const kwargs = (message as { additional_kwargs?: { source?: unknown } }).additional_kwargs;
    return kwargs?.source !== overlay.source;
  });
  const agentMessages = channelValues.agentMessages;
  const retainedAgentMessages = Array.isArray(agentMessages)
    ? agentMessages.filter((message) => {
        if (message == null || typeof message !== 'object') {
          return true;
        }
        const kwargs = (message as { additional_kwargs?: { source?: unknown } }).additional_kwargs;
        return kwargs?.source !== overlay.source;
      })
    : agentMessages;
  return {
    ...checkpoint,
    channel_values: {
      ...channelValues,
      messages: [...retainedMessages, ...overlay.messages],
      ...(retainedAgentMessages === undefined ? {} : { agentMessages: retainedAgentMessages }),
    },
  };
}

function eventActorRunnableConfig(
  reference: Pick<AgentEventCheckpointReference, 'threadId' | 'checkpointNs'>,
  invocationId: string,
  checkpointId?: string,
  owner?: string,
): RunnableConfig {
  return {
    configurable: {
      thread_id: reference.threadId,
      checkpoint_ns: '',
      [LIBRECHAT_CHECKPOINT_NAMESPACE_KEY]: reference.checkpointNs,
      [LIBRECHAT_EVENT_ACTOR_INVOCATION_KEY]: invocationId,
      ...(owner == null
        ? {}
        : {
            [LIBRECHAT_CHECKPOINT_OWNER_KEY]: owner,
            ...(checkpointId == null ? {} : { [LIBRECHAT_LEGACY_CHECKPOINT_KEY]: checkpointId }),
          }),
      ...(checkpointId == null ? {} : { checkpoint_id: checkpointId }),
    },
  };
}

/** Copies one committed actor head into an invocation-owned namespace. */
export async function forkAgentEventCheckpoint(
  source: AgentEventCheckpointReference,
  checkpointNs: string,
  invocationId: string,
  cfg?: TCheckpointerConfig,
  messageOverlay?: AgentEventCheckpointMessageOverlay,
  owner?: string,
): Promise<AgentEventCheckpointReference | null> {
  const saver = await getAgentCheckpointer(cfg);
  if (!saver || checkpointNs.length === 0 || invocationId.length === 0) {
    return null;
  }
  const tuple = await saver.getTuple(
    eventActorRunnableConfig(source, invocationId, source.checkpointId, owner),
  );
  if (!tuple || tuple.metadata == null || (tuple.pendingWrites?.length ?? 0) > 0) {
    return null;
  }
  const target = { threadId: source.threadId, checkpointNs };
  const persisted = await saver.put(
    eventActorRunnableConfig(target, invocationId, undefined, owner),
    applyAgentEventCheckpointMessageOverlay(tuple.checkpoint, messageOverlay),
    tuple.metadata,
  );
  const checkpointId = persisted.configurable?.checkpoint_id;
  if (typeof checkpointId !== 'string' || checkpointId.length === 0) {
    throw new Error('Event actor checkpoint fork did not return a checkpoint id');
  }
  return { ...target, checkpointId };
}

/** Historical evidence authorizes only this exact ID, never the whole legacy namespace. */
export async function deleteAgentEventCheckpointReference(
  reference: AgentEventCheckpointReference,
  cfg?: TCheckpointerConfig,
  owner?: string,
): Promise<boolean> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') {
    return false;
  }
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('Mongo checkpoint storage is unavailable');
  }
  const exact = {
    thread_id: reference.threadId,
    checkpoint_ns: reference.checkpointNs,
    checkpoint_id: reference.checkpointId,
    ...(owner == null
      ? { lc_owner: { $exists: false } }
      : { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] }),
  };
  await db.collection(resolved.checkpointWritesCollectionName).deleteMany(exact);
  await db.collection(resolved.checkpointCollectionName).deleteOne(exact);
  return true;
}

/** Consume exact historical proofs in bounded batches, retaining intent on any failure. */
export async function deleteAgentEventCheckpointReferences(
  references: readonly AgentEventCheckpointReference[],
  owner: string,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory' || references.length === 0) return;
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  for (let offset = 0; offset < references.length; offset += 256) {
    const exact = {
      $and: [
        { $or: [{ lc_owner: owner }, { lc_owner: { $exists: false } }] },
        {
          $or: references.slice(offset, offset + 256).map((reference) => ({
            thread_id: reference.threadId,
            checkpoint_ns: reference.checkpointNs,
            checkpoint_id: reference.checkpointId,
          })),
        },
      ],
    };
    await db.collection(resolved.checkpointWritesCollectionName).deleteMany(exact);
    await db.collection(resolved.checkpointCollectionName).deleteMany(exact);
  }
}

/** Reads the terminal checkpoint produced inside one invocation namespace. */
export async function captureAgentEventCheckpoint(
  threadId: string,
  checkpointNs: string,
  invocationId: string,
  cfg?: TCheckpointerConfig,
  owner?: string,
  legacyCheckpointId?: string,
): Promise<AgentEventCheckpointReference | null> {
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return null;
  }
  let tuple = await saver.getTuple(
    eventActorRunnableConfig({ threadId, checkpointNs }, invocationId, undefined, owner),
  );
  if (legacyCheckpointId != null && (tuple == null || tuple.checkpoint.id < legacyCheckpointId)) {
    tuple = await saver.getTuple(
      eventActorRunnableConfig({ threadId, checkpointNs }, invocationId, legacyCheckpointId, owner),
    );
  }
  const checkpointId = tuple?.checkpoint.id;
  return typeof checkpointId === 'string' && checkpointId.length > 0
    ? { threadId, checkpointId, checkpointNs }
    : null;
}

/** Longest wait for a peer's checkpoint index build before the saver proceeds without it. */
const CHECKPOINT_INDEX_BUILD_DEADLINE_MS = 120_000;

/**
 * `MongoDBSaver.setup()` starts the compound and TTL builds of each collection
 * concurrently and reports failures instead of throwing. Amazon DocumentDB
 * admits one index build per collection at a time, so there the second build of
 * each pair is rejected (code 40333) and the saver would otherwise run with its
 * TTL index missing — checkpoints then never expire. `setup()` is idempotent (an
 * index that already exists is a no-op), so re-running it lets one more build
 * through per pass until every index exists. Every other error is returned for
 * the caller to log, exactly as `setup()` reports it — including those reported
 * beside a conflict that outlasts the deadline. A rejection of `setup()` itself
 * propagates, so the caller keeps its in-process fallback.
 */
export async function setupCheckpointIndexes(
  saver: Pick<MongoDBSaver, 'setup'>,
  options: IndexBuildOptions = {},
): Promise<Error[]> {
  let companions: Error[] = [];
  try {
    return await buildIndexWithRetry(
      async () => {
        const errors = await saver.setup();
        const blocked = errors.find(isIndexBuildInProgress);
        if (blocked == null) {
          return errors;
        }
        companions = errors.filter((error) => !isIndexBuildInProgress(error));
        throw blocked;
      },
      'MongoDBSaver.setup()',
      { peerBuildDeadlineMs: CHECKPOINT_INDEX_BUILD_DEADLINE_MS, ...options },
    );
  } catch (error) {
    if (!isIndexBuildInProgress(error)) {
      throw error;
    }
    return [...companions, error instanceof Error ? error : new Error(String(error))];
  }
}

async function buildMongoSaver(
  resolved: ResolvedCheckpointerConfig,
): Promise<MongoDBSaver | undefined> {
  try {
    const saver = new LazyMongoSaver({
      // mongoose vends the live MongoClient; reuse it instead of opening a second
      // connection. The driver type is structurally identical but resolves to a
      // different `mongodb` copy than checkpoint-mongodb's, hence the cast.
      client: mongoose.connection.getClient() as unknown as ConstructorParameters<
        typeof MongoDBSaver
      >[0]['client'],
      // MongoDBSaver calls MongoClient.db(dbName). Passing no name makes that
      // resolve from the driver's URI default, which is not guaranteed to be the
      // database Mongoose selected (for example when Mongoose connected with a
      // dbName override). Every capture/delete path below uses connection.db, so
      // bind the saver to that exact database as well or a pause can be written to
      // one database while LibreChat looks for it in another.
      dbName: mongoose.connection.db?.databaseName,
      checkpointCollectionName: resolved.checkpointCollectionName,
      checkpointWritesCollectionName: resolved.checkpointWritesCollectionName,
      // TTL index on `upserted_at`: an unresolved paused run is reclaimed after the
      // approval window, so a forgotten approval can never leak checkpoints forever.
      ttl: resolved.ttlSeconds,
    });
    const errors = await setupCheckpointIndexes(saver);
    if (errors.length > 0) {
      logger.warn(
        '[checkpointer] MongoDBSaver.setup() reported errors (checkpoint indexes may be incomplete):',
        errors,
      );
    }
    await Promise.all(
      [resolved.checkpointCollectionName, resolved.checkpointWritesCollectionName].map(
        async (name) => {
          try {
            await buildIndexWithRetry(
              () => mongoose.connection.db!.collection(name).createIndex({ checkpoint_ns: 1 }),
              `${name}.checkpoint_ns`,
            );
          } catch (error) {
            logger.warn('[checkpointer] Owner cleanup index unavailable:', error);
          }
        },
      ),
    );
    await Promise.all(
      [resolved.checkpointCollectionName, resolved.checkpointWritesCollectionName].map(
        async (name) => {
          try {
            await buildIndexWithRetry(
              () =>
                mongoose.connection.db!.collection(name).createIndex({ lc_owner: 1, thread_id: 1 }),
              `${name}.lc_owner`,
            );
          } catch (error) {
            logger.warn('[checkpointer] Payload ownership index unavailable:', error);
          }
        },
      ),
    );
    logger.info('[checkpointer] Durable Mongo checkpointer ready for agent continuation');
    return saver;
  } catch (err) {
    // Reset so a later run can retry rather than being stuck on a failed build.
    saverPromise = undefined;
    cachedKey = undefined;
    logger.error(
      '[checkpointer] Failed to initialize Mongo checkpointer; falling back to in-process checkpointer:',
      err,
    );
    return undefined;
  }
}

function legacyCheckpointStorageFilter() {
  return { checkpoint_ns: { $not: /^lcg:v2:/ }, lc_owner: { $exists: false } };
}

/**
 * Snapshot the durable checkpoint ids that belong to the generation about to
 * resume. Capture this before atomically claiming the paused job; a replacement
 * that wins before the claim makes that claim fail, while one that starts after
 * the claim writes ids outside this snapshot.
 */
export async function captureAgentCheckpointGeneration(
  threadId: string,
  cfg?: TCheckpointerConfig,
  options?: { throwOnError?: boolean; checkpointNamespace?: string },
): Promise<AgentCheckpointGeneration> {
  const requestedNamespace = options?.checkpointNamespace ?? '';
  /** Empty is the shared legacy namespace, whose nested subgraphs live under
   * independent nonempty LangGraph namespaces. Treat it as a thread-wide id
   * capture and omit the namespace marker so deletion cannot silently filter
   * those child rows out. Only nonempty generation scopes are prefix-safe. */
  const namespaceScoped =
    options != null &&
    Object.prototype.hasOwnProperty.call(options, 'checkpointNamespace') &&
    requestedNamespace !== '';
  const generation: AgentCheckpointGeneration = {
    threadId,
    ...(namespaceScoped && { checkpointNamespace: requestedNamespace }),
    checkpointIds: [],
  };
  if (!threadId) {
    return generation;
  }
  try {
    const saver = await getAgentCheckpointer(cfg);
    const db = mongoose.connection.db;
    if (!saver || !db) {
      return generation;
    }
    const resolved = resolveCheckpointerConfig(cfg);
    const checkpoints = await db
      .collection<{ checkpoint_id?: string }>(resolved.checkpointCollectionName)
      .find(
        {
          thread_id: threadId,
          ...(namespaceScoped
            ? { checkpoint_ns: generationNamespaceFilter(requestedNamespace) }
            : legacyCheckpointStorageFilter()),
        },
        { projection: { _id: 0, checkpoint_id: 1 } },
      )
      .toArray();
    generation.checkpointIds = checkpoints.reduce<string[]>((ids, checkpoint) => {
      if (typeof checkpoint.checkpoint_id === 'string') {
        ids.push(checkpoint.checkpoint_id);
      }
      return ids;
    }, []);
  } catch (err) {
    logger.warn(
      `[checkpointer] Failed to capture checkpoint generation for thread ${threadId}:`,
      err,
    );
    if (options?.throwOnError) {
      throw err;
    }
  }
  return generation;
}

/**
 * Prune a thread's checkpoints on a terminal transition — natural completion,
 * abort, or expiry — so the durable store stays bounded. The TTL index is the
 * safety net; this is the eager cleanup. No-op in memory mode or before any run
 * has built the saver (nothing to delete).
 *
 * @param threadId - the LangGraph `thread_id` (LibreChat's conversationId).
 * @param generation - when present, delete only the checkpoint ids captured for
 * this resumed generation; omitted by legacy callers that intentionally prune
 * the untagged legacy rows on the thread.
 */
export async function deleteAgentCheckpoint(
  threadId: string | undefined,
  cfg?: TCheckpointerConfig,
  generation?: AgentCheckpointGeneration,
  options?: { throwOnError?: boolean; checkpointNamespace?: string },
): Promise<void> {
  if (!threadId) {
    return;
  }
  const saver = await getAgentCheckpointer(cfg);
  if (!saver) {
    return;
  }
  try {
    if (generation) {
      if (generation.threadId !== threadId || generation.checkpointIds.length === 0) {
        return;
      }
      if (
        Object.prototype.hasOwnProperty.call(generation, 'checkpointNamespace') &&
        (generation.checkpointNamespace ?? '') === ''
      ) {
        throw new Error(
          'Legacy checkpoint cleanup requires a thread-wide captured generation without an empty namespace marker',
        );
      }
      const db = mongoose.connection.db;
      if (!db) {
        return;
      }
      const resolved = resolveCheckpointerConfig(cfg);
      const filter = {
        thread_id: threadId,
        ...(Object.prototype.hasOwnProperty.call(generation, 'checkpointNamespace')
          ? { checkpoint_ns: generationNamespaceFilter(generation.checkpointNamespace ?? '') }
          : legacyCheckpointStorageFilter()),
        checkpoint_id: { $in: generation.checkpointIds },
      };
      await Promise.all([
        db.collection(resolved.checkpointCollectionName).deleteMany(filter),
        db.collection(resolved.checkpointWritesCollectionName).deleteMany(filter),
      ]);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(options ?? {}, 'checkpointNamespace')) {
      const checkpointNamespace = options?.checkpointNamespace ?? '';
      /** An explicit empty namespace denotes a legacy/pre-isolation job, not
       * an immutable storage scope. Thread-wide deletion could erase a newer
       * v2 replacement, while filtering `checkpoint_ns: ''` would strand the
       * legacy job's nested subgraphs. Such callers must capture a thread-wide
       * immutable id set, verify their job epoch after that capture, and pass
       * the resulting `generation` above. */
      if (checkpointNamespace === '') {
        throw new Error(
          'Legacy checkpoint cleanup requires a captured checkpoint generation, not an empty namespace',
        );
      }
      const db = mongoose.connection.db;
      if (!db) {
        return;
      }
      const resolved = resolveCheckpointerConfig(cfg);
      const filter = {
        thread_id: threadId,
        checkpoint_ns: generationNamespaceFilter(checkpointNamespace),
      };
      await Promise.all([
        db.collection(resolved.checkpointCollectionName).deleteMany(filter),
        db.collection(resolved.checkpointWritesCollectionName).deleteMany(filter),
      ]);
      return;
    }
    const db = mongoose.connection.db;
    if (!db) return;
    const resolved = resolveCheckpointerConfig(cfg);
    const filter = { thread_id: threadId, ...legacyCheckpointStorageFilter() };
    await Promise.all([
      db.collection(resolved.checkpointCollectionName).deleteMany(filter),
      db.collection(resolved.checkpointWritesCollectionName).deleteMany(filter),
    ]);
  } catch (err) {
    logger.warn(`[checkpointer] Failed to delete checkpoints for thread ${threadId}:`, err);
    if (options?.throwOnError) {
      throw err;
    }
  }
}

/** Erase only payload rows carrying this authenticated actor owner. */
export async function deleteOwnedActorCheckpointScope(
  threadId: string,
  checkpointNs: string,
  owner: string,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory') return;
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1)
    throw new Error('Checkpoint database is unavailable');
  const filter = {
    thread_id: `${owner}${threadId}`,
    checkpoint_ns: generationNamespaceFilter(`${owner}${checkpointNs}`),
    lc_owner: owner,
  };
  await Promise.all([
    db.collection(resolved.checkpointCollectionName).deleteMany(filter),
    db.collection(resolved.checkpointWritesCollectionName).deleteMany(filter),
  ]);
}

/** Delete durable rows by authenticated ownership, independently of job/receipt lifetimes. */
export async function deleteOwnedAgentCheckpoints(
  userId: string,
  tenantId: string | undefined,
  conversationIds: readonly string[] | undefined,
  cfg?: TCheckpointerConfig,
): Promise<void> {
  if (!userId) {
    throw new Error('Checkpoint cleanup requires an owner');
  }
  const resolved = resolveCheckpointerConfig(cfg);
  if (resolved.type === 'memory' || conversationIds?.length === 0) {
    return;
  }
  const db = mongoose.connection.db;
  if (!db || mongoose.connection.readyState !== 1) {
    throw new Error('Checkpoint database is unavailable');
  }
  const owner = checkpointOwnerNamespacePrefix(userId, tenantId);
  const ownership = { $or: [{ checkpoint_ns: { $regex: `^${owner}` } }, { lc_owner: owner }] };
  const ids = conversationIds == null ? undefined : [...new Set(conversationIds)];
  const batchSize = 128;
  for (let offset = 0; offset < (ids?.length ?? 1); offset += batchSize) {
    const filter = {
      ...ownership,
      ...(ids && {
        thread_id: {
          $in: ids.slice(offset, offset + batchSize).flatMap((id) => [id, `${owner}${id}`]),
        },
      }),
    };
    await db.collection(resolved.checkpointCollectionName).deleteMany(filter);
    await db.collection(resolved.checkpointWritesCollectionName).deleteMany(filter);
  }
}

/** Test-only: drop the memoized saver so a fresh build is forced. */
export function __resetCheckpointerForTests(): void {
  saverPromise = undefined;
  cachedKey = undefined;
}
