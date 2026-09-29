import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Redis, Cluster } from 'ioredis';
import type { IEventTransport, PreemptMessage } from '~/stream/interfaces/IJobStore';
import type { ChunkPublicationOptions } from '~/stream/internal/chunkPublication';
import {
  MAX_COALESCED_BYTES,
  MAX_COALESCED_EVENTS,
  resolveCoalesceWindowMs,
} from '~/stream/internal/coalescing';
import {
  REDIS_ABORT_ACK_TIMEOUT_MS,
  REDIS_EVENT_REORDER_TIMEOUT_MS,
} from '~/stream/internal/timing';
import { registerChunkPublicationCapability } from '~/stream/internal/chunkPublication';
import { GenerationPublicationFencedError } from '~/stream/interfaces/IJobStore';
import { instrumentIORedisClient, RedisUseCases } from '~/cache/redisTelemetry';

/**
 * Redis key prefixes for pub/sub channels
 */
const CHANNELS = {
  /** Main event channel: stream:{streamId}:events (hash tag for cluster compatibility) */
  events: (streamId: string) => `stream:{${streamId}}:events`,
};

/**
 * Redis keys for shared state (hash-tagged for cluster slot compatibility)
 */
const KEYS = {
  /** Atomic sequence counter: shared across all replicas for a given stream */
  sequence: (streamId: string) => `stream:{${streamId}}:seq`,
  /** Job metadata, used to keep the sequence counter alive for the full job lifetime */
  job: (streamId: string) => `stream:{${streamId}}:job`,
  /** Latest generation epoch, retained briefly beyond the live job hash. */
  generationEpoch: (streamId: string) => `stream:{${streamId}}:generation-epoch`,
  /** Short-lived proof that at least one UI is watching this live-only stream. */
  demand: (streamId: string) => `stream:{${streamId}}:demand`,
  /** Owner-issued proof that this exact generation processed an abort. */
  abortAck: (streamId: string, generationId: number) =>
    `stream:{${streamId}}:abort-ack:${generationId}`,
  /** Exact proof that a provider segment has fully unwound. */
  providerDrain: (streamId: string, generationId: number, providerExecutionId: string) =>
    `stream:{${streamId}}:provider-drain:${generationId}:${providerExecutionId}`,
};

/**
 * Event types for pub/sub messages
 */
const EventTypes = {
  CHUNK: 'chunk',
  CHUNK_BATCH: 'chunk_batch',
  DONE: 'done',
  ERROR: 'error',
  SUBSCRIPTION_FRONTIER: 'subscription_frontier',
  ABORT: 'abort',
  ABORT_ACK: 'abort_ack',
  PREEMPT: 'preempt',
} as const;

interface PubSubMessage {
  type: (typeof EventTypes)[keyof typeof EventTypes];
  /** Sequence number for ordering (critical for Redis Cluster) */
  seq?: number;
  data?: unknown;
  error?: string;
  /** First sequence of a CHUNK_BATCH frame; events[i] owns baseSeq + i. */
  baseSeq?: number;
  /** Coalesced chunk payloads of a CHUNK_BATCH frame, in emission order. */
  events?: unknown[];
  /** Immutable identity of the generation that emitted the event. */
  generationId?: number;
  /** Opaque nonce linking a replacement abort to its owner acknowledgement. */
  abortRequestId?: string;
  /** Payload for PREEMPT messages; fenced by its own createdAt. */
  preempt?: PreemptMessage;
  /** Opaque local subscriber fence; never forwarded to application handlers. */
  subscriptionFrontierId?: string;
}

/**
 * Producer-side buffer of coalescable chunk publications for one stream.
 * Payload suffixes are pre-serialized at enqueue so a flush only passes strings, and
 * each resolver settles its caller's receipt with `baseSeq + index`.
 */
interface PendingChunkBatch {
  generationId?: number;
  events: string[];
  resolvers: Array<(receipt: number | false | undefined) => void>;
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Reorder buffer state for a stream subscription.
 * Handles out-of-order message delivery in Redis Cluster mode.
 */
interface ReorderBuffer {
  /** Next expected sequence number */
  nextSeq: number;
  /** Buffered messages waiting for earlier sequences */
  pending: Map<number, PubSubMessage>;
  /** Timeout handle for flushing stale messages */
  flushTimeout: ReturnType<typeof setTimeout> | null;
  /** Hold sequenced delivery until first-subscriber replay establishes its frontier. */
  deliveryDeferred: boolean;
}

interface AbortRegistration {
  callback: (generationId?: number) => void | boolean;
}

interface AbortAckWaiter {
  generationId: number;
  resolve: (acknowledged: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PreemptRegistration {
  callback: (msg: PreemptMessage) => void;
}

/**
 * Allocate a sequence number and publish the event in a single round trip.
 *
 * The payload is spliced server-side rather than round-tripped through `cjson`: decoding and
 * re-encoding arbitrary event data would coerce empty arrays to objects and alter float
 * precision. The caller pre-serializes everything around the seq, so this only concatenates.
 *
 * The sequence TTL is extend-only. Once it falls below half the safety window, it is refreshed
 * to the longer of that window and the live job TTL. Checking the job TTL only at that threshold
 * keeps it off the per-delta hot path. Because stream IDs are conversation IDs, keeping this
 * counter monotonic across normal cleanup lets a lingering subscriber order later turns.
 *
 * The channel is passed as ARGV, not KEYS: ioredis applies `keyPrefix` to EVAL keys but never
 * to a pub/sub channel, so keying it here would publish to a prefixed channel that no
 * subscriber listens on. PUBLISH is broadcast cluster-wide rather than slot-routed, so it does
 * not need to be a key for Cluster correctness.
 *
 *   KEYS: [sequence, job, generationEpoch]
 *   ARGV: [
 *     channel,
 *     payloadPrefix,
 *     payloadSuffix,
 *     sequenceTtlSeconds,
 *     expectCreatedAt | "",
 *     allowRetainedEpoch ("0" | "1"),
 *     generationEpochGraceTtl,
 *     requireActiveJob ("0" | "1"),
 *     sequenceCount,
 *     ...chunkSuffixes (optional, one per event for a coalesced publication)
 *   ]
 *   RETURNS: the 0-indexed first seq assigned to this frame, or -1 when the generation
 *   guard fails. A single frame splices its seq into prefix/suffix. A coalesced
 *   publication reserves consecutive sequences in one INCRBY and publishes one
 *   legacy chunk frame per suffix, keeping pre-batching subscribers compatible.
 *
 * During a rolling deployment, a job created by the previous version can expire without
 * leaving a generation marker. A tagged terminal event may claim that absent marker only
 * while the job hash is also absent. The same bounded ambiguity exists for an extremely
 * late event after a recovery marker expires; the generationId in the payload contains it,
 * because active runtimes discard terminal events for another epoch.
 */
const PUBLISH_SEQ_LUA =
  'if ARGV[5] ~= "" then ' +
  'local currentCreatedAt = redis.call("HGET", KEYS[2], "createdAt") ' +
  'if currentCreatedAt ~= ARGV[5] then ' +
  'if redis.call("EXISTS", KEYS[2]) == 1 or ARGV[6] ~= "1" then return -1 end ' +
  'local retainedEpoch = redis.call("GET", KEYS[3]) ' +
  'if not retainedEpoch then ' +
  'redis.call("SET", KEYS[3], ARGV[5], "EX", tonumber(ARGV[7]), "NX") ' +
  'retainedEpoch = redis.call("GET", KEYS[3]) ' +
  'end ' +
  'if retainedEpoch ~= ARGV[5] then return -1 end ' +
  'end ' +
  'end ' +
  'if ARGV[8] == "1" then ' +
  'local currentStatus = redis.call("HGET", KEYS[2], "status") ' +
  'if currentStatus ~= "running" and currentStatus ~= "requires_action" then return -1 end ' +
  'end ' +
  'local count = tonumber(ARGV[9]) ' +
  'local val = redis.call("INCRBY", KEYS[1], count) ' +
  'local ttl = tonumber(ARGV[4]) ' +
  'local seqTtl = redis.call("TTL", KEYS[1]) ' +
  'if seqTtl < math.floor(ttl / 2) then ' +
  'local jobTtl = redis.call("TTL", KEYS[2]) ' +
  'if jobTtl > ttl then ttl = jobTtl end ' +
  'redis.call("EXPIRE", KEYS[1], ttl) ' +
  'end ' +
  'local seq = val - count ' +
  'if #ARGV > 9 then ' +
  'for i = 1, count do ' +
  'redis.call("PUBLISH", ARGV[1], ARGV[2] .. string.format("%d", seq + i - 1) .. ARGV[9 + i]) ' +
  'end ' +
  'else ' +
  'redis.call("PUBLISH", ARGV[1], ARGV[2] .. string.format("%d", seq) .. ARGV[3]) ' +
  'end ' +
  'return seq';

/** A normal generation guard correctly rejects events from an old epoch once
 * its replacement exists. Replacement handoff is the one exception: the
 * current create attempt must still carry the old epoch in its durable receipt
 * chain. This script verifies that proof, assigns the shared sequence, and
 * publishes the old-generation DONE in one same-slot decision. */
const PUBLISH_REPLACED_DONE_LUA =
  'if redis.call("HGET", KEYS[2], "__creationAttemptId") ~= ARGV[6] then return -1 end ' +
  'local authorized = false local raw = redis.call("HGET", KEYS[2], "__replacedGenerations") ' +
  'if raw then local ok, receipts = pcall(cjson.decode, raw) if not ok or type(receipts) ~= "table" then return -1 end ' +
  'for i = 1, #receipts do local receipt = receipts[i] ' +
  'if type(receipt) == "table" and tostring(receipt.createdAt or "") == ARGV[5] then authorized = true break end end ' +
  'else authorized = redis.call("HGET", KEYS[2], "__replacedCreatedAt") == ARGV[5] end ' +
  'if not authorized then return -1 end ' +
  'local val = redis.call("INCR", KEYS[1]) local ttl = tonumber(ARGV[4]) ' +
  'local seqTtl = redis.call("TTL", KEYS[1]) if seqTtl < math.floor(ttl / 2) then ' +
  'local jobTtl = redis.call("TTL", KEYS[2]) if jobTtl > ttl then ttl = jobTtl end ' +
  'redis.call("EXPIRE", KEYS[1], ttl) end local seq = val - 1 ' +
  'redis.call("PUBLISH", ARGV[1], ARGV[2] .. string.format("%d", seq) .. ARGV[3]) return seq';

/** Capture the counter and publish a subscriber-visible fence atomically. Once the
 * requesting subscriber observes this marker, every sequenced publication below the
 * returned frontier that it could receive is already in its local reorder buffer. */
const CAPTURE_SUBSCRIPTION_FRONTIER_LUA =
  'local frontier = redis.call("GET", KEYS[1]) or "0" ' +
  'redis.call("PUBLISH", ARGV[1], ARGV[2]) return frontier';

/** Max messages to buffer before force-flushing (prevents memory issues) */
const MAX_BUFFER_SIZE = 100;
/** Rolling-upgrade recovery window after a legacy job hash expires without an epoch marker. */
const GENERATION_EPOCH_GRACE_TTL_SECONDS = 300;
/** Durable owner proof outlives receipt retries and process-local subscriptions. */
const ABORT_ACK_TTL_SECONDS = 86400;
const PROVIDER_DRAIN_TTL_SECONDS = 86400;
const SUBSCRIPTION_ATTACHMENT_TIMEOUT_MS = 3_000;

interface SubscriptionFrontierWaiter {
  streamId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface ChannelSubscriptionState {
  ready: Promise<void>;
  phase: 'pending' | 'active';
  /** A timed-out predecessor became active while this replacement was pending. */
  fallbackActive: boolean;
}

/**
 * Subscriber state for a stream
 */
interface StreamSubscribers {
  count: number;
  handlers: Map<
    string,
    {
      onChunk: (event: unknown, generationId?: number) => void;
      onDone?: (event: unknown, generationId?: number) => void;
      onError?: (error: string, generationId?: number) => void;
    }
  >;
  /** Replaced when a stream runtime is replaced; only the current lifecycle owns cleanup. */
  allSubscribersLeftCallback?: () => void;
  /** Abort callbacks - called when abort signal is received from any replica */
  abortCallbacks: Set<AbortRegistration>;
  /** Replacement aborts awaiting the exact generation owner's acknowledgement. */
  abortAckWaiters: Map<string, AbortAckWaiter>;
  preemptCallbacks: Set<PreemptRegistration>;
  /** Reorder buffer for handling out-of-order delivery in Redis Cluster */
  reorderBuffer: ReorderBuffer;
}

/**
 * Redis Pub/Sub implementation of IEventTransport.
 * Enables real-time event delivery across multiple instances.
 *
 * Architecture (inspired by https://upstash.com/blog/resumable-llm-streams):
 * - Publisher: Emits events to Redis channel when chunks arrive
 * - Subscriber: Listens to Redis channel and forwards to SSE clients
 * - Decoupled: Generator and consumer don't need direct connection
 * - Ordering: Every sequenced event for one stream must use PUBLISH_SEQ_LUA. Its hash-tagged
 *   counter routes all publishers through one Redis slot owner, so sequence and publish order
 *   share one authoritative FIFO origin.
 *
 * Note: Requires TWO Redis connections - one for publishing, one for subscribing.
 * This is a Redis limitation: a client in subscribe mode can't publish.
 *
 * @example
 * ```ts
 * const transport = new RedisEventTransport(publisherClient, subscriberClient);
 * transport.subscribe(streamId, { onChunk: (e) => res.write(e) });
 * transport.emitChunk(streamId, { text: 'Hello' });
 * ```
 */
export class RedisEventTransport implements IEventTransport {
  /** Redis client for publishing events */
  private publisher: Redis | Cluster;
  /** Redis client for subscribing to events (separate connection required) */
  private subscriber: Redis | Cluster;
  /** Track subscribers per stream */
  private streams = new Map<string, StreamSubscribers>();
  /** Track channel subscription state: resolved promise = active, pending = in-flight */
  private channelSubscriptions = new Map<string, ChannelSubscriptionState>();
  /** Counter for generating unique subscriber IDs */
  private subscriberIdCounter = 0;
  /** Coalescable chunk publications awaiting their window flush, per stream */
  private pendingBatches = new Map<string, PendingChunkBatch>();
  /** Local waiters for atomic sequence-frontier markers published after SUBSCRIBE. */
  private subscriptionFrontierWaiters = new Map<string, SubscriptionFrontierWaiter>();
  /** Delta-coalescing window; 0 keeps every publication on the per-event path */
  private readonly coalesceWindowMs: number;

  private createStreamState(): StreamSubscribers {
    return {
      count: 0,
      handlers: new Map(),
      abortCallbacks: new Set(),
      abortAckWaiters: new Map(),
      preemptCallbacks: new Set(),
      reorderBuffer: {
        nextSeq: 0,
        pending: new Map(),
        flushTimeout: null,
        deliveryDeferred: false,
      },
    };
  }

  private getOrCreateStreamState(streamId: string): StreamSubscribers {
    const existing = this.streams.get(streamId);
    if (existing) {
      return existing;
    }
    const state = this.createStreamState();
    this.streams.set(streamId, state);
    return state;
  }

  private async captureSubscriptionFrontier(streamId: string): Promise<number> {
    const subscriptionFrontierId = randomUUID();
    let operationTimeout: ReturnType<typeof setTimeout> | undefined;
    const observed = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.subscriptionFrontierWaiters.delete(subscriptionFrontierId);
        reject(new Error(`Timed out synchronizing Redis subscription for ${streamId}`));
      }, SUBSCRIPTION_ATTACHMENT_TIMEOUT_MS);
      timeout.unref?.();
      this.subscriptionFrontierWaiters.set(subscriptionFrontierId, {
        streamId,
        resolve,
        reject,
        timeout,
      });
    });
    /** The timeout can win while EVAL is still pending; attach rejection handling now. */
    void observed.catch(() => undefined);
    try {
      /** Wait for the Redis command and its published marker concurrently. If the command
       * commits but its promise never settles, the marker timeout still releases attachment
       * admission instead of leaving every surviving local subscriber deferred forever. */
      const operation = Promise.all([
        this.publisher.eval(
          CAPTURE_SUBSCRIPTION_FRONTIER_LUA,
          1,
          KEYS.sequence(streamId),
          CHANNELS.events(streamId),
          JSON.stringify({
            type: EventTypes.SUBSCRIPTION_FRONTIER,
            subscriptionFrontierId,
          }),
        ),
        observed,
      ]);
      const operationDeadline = new Promise<never>((_, reject) => {
        operationTimeout = setTimeout(
          () => reject(new Error(`Timed out synchronizing Redis subscription for ${streamId}`)),
          SUBSCRIPTION_ATTACHMENT_TIMEOUT_MS,
        );
        operationTimeout.unref?.();
      });
      const [raw] = await Promise.race([operation, operationDeadline]);
      const parsed = raw != null ? parseInt(String(raw), 10) : 0;
      return Number.isNaN(parsed) ? 0 : parsed;
    } catch (error) {
      const waiter = this.subscriptionFrontierWaiters.get(subscriptionFrontierId);
      if (waiter != null) {
        waiter.reject(error instanceof Error ? error : new Error(String(error)));
      }
      throw error;
    } finally {
      if (operationTimeout != null) clearTimeout(operationTimeout);
      const waiter = this.subscriptionFrontierWaiters.get(subscriptionFrontierId);
      if (waiter != null) {
        clearTimeout(waiter.timeout);
        this.subscriptionFrontierWaiters.delete(subscriptionFrontierId);
      }
    }
  }

  private releaseSubscriptionFrontiers(streamId: string): void {
    for (const [id, waiter] of this.subscriptionFrontierWaiters) {
      if (waiter.streamId !== streamId) continue;
      clearTimeout(waiter.timeout);
      this.subscriptionFrontierWaiters.delete(id);
      waiter.resolve();
    }
  }

  /**
   * Create a new Redis event transport.
   *
   * @param publisher - Redis client for publishing (can be shared)
   * @param subscriber - Redis client for subscribing (must be dedicated)
   */
  constructor(publisher: Redis | Cluster, subscriber: Redis | Cluster) {
    this.publisher = instrumentIORedisClient(publisher, RedisUseCases.GENERATION_STREAM);
    this.subscriber = instrumentIORedisClient(subscriber, RedisUseCases.GENERATION_STREAM);
    this.coalesceWindowMs = resolveCoalesceWindowMs();
    registerChunkPublicationCapability(this, (streamId, event, generationId, publishOptions) =>
      this.publishChunkWithReceipt(streamId, event, generationId, publishOptions),
    );

    // Set up message handler for all subscriptions
    this.subscriber.on('message', (channel: string, message: string) => {
      this.handleMessage(channel, message);
    });
  }

  /** Minimum safety-net TTL in seconds; publishing and pause transitions may only extend it. */
  private static readonly SEQUENCE_TTL_SECONDS = 86400;

  /**
   * Split a seq-less message into the JSON fragments surrounding its `seq`, so the sequence
   * can be spliced in by {@link PUBLISH_SEQ_LUA} without re-encoding the payload.
   *
   * Omitting a field (e.g. `data: undefined`) yields an empty tail, matching what
   * `JSON.stringify` would have dropped from the whole-object encoding.
   */
  private static buildPayloadParts(message: Omit<PubSubMessage, 'seq'>): [string, string] {
    const { type, ...rest } = message;
    const encodedRest = JSON.stringify(rest);
    const inner = encodedRest.slice(1, -1);
    return [`{"type":${JSON.stringify(type)},"seq":`, inner.length > 0 ? `,${inner}}` : '}'];
  }

  /**
   * Allocate a sequence number and publish, in one Redis round trip.
   *
   * The shared counter survives local cleanup and expires after its sliding TTL once no
   * generation is publishing. This bounds storage without resetting another replica's
   * subscriber frontier between turns.
   */
  private async publishWithSequence(
    streamId: string,
    message: Omit<PubSubMessage, 'seq'>,
    expectedGenerationId?: number,
    allowRetainedEpoch = false,
    requireActiveJob = false,
  ): Promise<number> {
    const [prefix, suffix] = RedisEventTransport.buildPayloadParts(message);
    return this.evalPublishSequenced(
      streamId,
      prefix,
      suffix,
      1,
      expectedGenerationId,
      allowRetainedEpoch,
      requireActiveJob,
    );
  }

  private async evalPublishSequenced(
    streamId: string,
    prefix: string,
    suffix: string,
    count: number,
    expectedGenerationId?: number,
    allowRetainedEpoch = false,
    requireActiveJob = false,
    chunkSuffixes: string[] = [],
  ): Promise<number> {
    const seq = await this.publisher.eval(
      PUBLISH_SEQ_LUA,
      3,
      KEYS.sequence(streamId),
      KEYS.job(streamId),
      KEYS.generationEpoch(streamId),
      CHANNELS.events(streamId),
      prefix,
      suffix,
      String(RedisEventTransport.SEQUENCE_TTL_SECONDS),
      expectedGenerationId != null ? String(expectedGenerationId) : '',
      allowRetainedEpoch ? '1' : '0',
      String(GENERATION_EPOCH_GRACE_TTL_SECONDS),
      requireActiveJob ? '1' : '0',
      String(count),
      ...chunkSuffixes,
    );
    return seq as number;
  }

  private publishChunkWithReceipt(
    streamId: string,
    event: unknown,
    generationId?: number,
    options?: ChunkPublicationOptions,
  ): Promise<number | false | void> {
    if (options?.coalesce === true && this.coalesceWindowMs > 0) {
      return this.enqueueCoalescedChunk(streamId, event, generationId);
    }
    /** A sequenced non-coalescable publication is an ordering barrier: pending
     * deltas must be issued first so their reserved sequences stay below this
     * frame's. Both EVALs ride the same connection (and, under Cluster, the
     * same hash slot), so issue order alone preserves sequence order. */
    if (this.pendingBatches.has(streamId)) {
      void this.flushCoalescedChunks(streamId);
    }
    return this.publishWithSequence(
      streamId,
      {
        type: EventTypes.CHUNK,
        data: event,
        ...(generationId != null && { generationId }),
      },
      generationId,
      false,
      generationId != null,
    )
      .then((sequence) => (sequence === -1 ? false : sequence))
      .catch((err) => {
        logger.error(`[RedisEventTransport] Failed to publish chunk:`, err);
        /** `false` is reserved for an authoritative generation/status fence.
         * An operational publication failure has no such ownership proof and
         * remains replayable from the durable/local buffer. */
        return undefined;
      });
  }

  /**
   * Buffer a coalescable chunk for the current window and settle its receipt when the
   * batch flushes. The receipt keeps per-event semantics: its own absolute sequence,
   * `false` under a generation/status fence, `undefined` on operational failure.
   */
  private enqueueCoalescedChunk(
    streamId: string,
    event: unknown,
    generationId?: number,
  ): Promise<number | false | undefined> {
    let pending = this.pendingBatches.get(streamId);
    if (pending && pending.generationId !== generationId) {
      void this.flushCoalescedChunks(streamId);
      pending = undefined;
    }
    if (!pending) {
      pending = { generationId, events: [], resolvers: [], bytes: 0, timer: null };
      this.pendingBatches.set(streamId, pending);
    }

    const batch = pending;
    const payload = JSON.stringify(event);
    const [, envelopeSuffix] = RedisEventTransport.buildPayloadParts({
      type: EventTypes.CHUNK,
      ...(generationId != null && { generationId }),
    });
    batch.events.push(
      payload === undefined ? envelopeSuffix : `,"data":${payload}${envelopeSuffix}`,
    );
    /** Match RedisJobStore's raw JSON length, excluding the publication envelope.
     * Counting its wrapper would flush publications before their durable appends
     * near the byte cap, letting a remote resume skip not-yet-durable events.
     * Reuse the serialized payload so size accounting adds no second traversal. */
    batch.bytes += payload?.length ?? 0;
    const receipt = new Promise<number | false | undefined>((resolve) => {
      batch.resolvers.push(resolve);
    });

    if (batch.events.length >= MAX_COALESCED_EVENTS || batch.bytes >= MAX_COALESCED_BYTES) {
      void this.flushCoalescedChunks(streamId);
    } else if (batch.timer == null) {
      batch.timer = setTimeout(() => {
        void this.flushCoalescedChunks(streamId);
      }, this.coalesceWindowMs);
    }
    return receipt;
  }

  /**
   * Publish the pending window in one EVAL using legacy CHUNK frames.
   *
   * One INCRBY reserves consecutive sequences and Lua publishes each serialized
   * suffix with its own sequence. This saves round trips and repeated guard/TTL
   * work without requiring older subscribers to understand CHUNK_BATCH. Payloads
   * are spliced, not decoded/re-encoded by Lua, preserving JSON semantics.
   */
  private flushCoalescedChunks(streamId: string): Promise<void> {
    const pending = this.pendingBatches.get(streamId);
    if (!pending) {
      return Promise.resolve();
    }
    this.pendingBatches.delete(streamId);
    if (pending.timer != null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }

    const { generationId, events, resolvers } = pending;
    const prefix = `{"type":${JSON.stringify(EventTypes.CHUNK)},"seq":`;

    return this.evalPublishSequenced(
      streamId,
      prefix,
      '',
      events.length,
      generationId,
      false,
      generationId != null,
      events,
    ).then(
      (baseSeq) => {
        if (baseSeq === -1) {
          for (const resolve of resolvers) {
            resolve(false);
          }
          return;
        }
        for (let i = 0; i < resolvers.length; i++) {
          resolvers[i](baseSeq + i);
        }
      },
      (err) => {
        logger.error(`[RedisEventTransport] Failed to publish chunk batch:`, err);
        for (const resolve of resolvers) {
          resolve(undefined);
        }
      },
    );
  }

  /** Publish a stream's pending coalesced chunks now (pre-transition barrier). */
  async flushPendingChunks(streamId: string): Promise<void> {
    await this.flushCoalescedChunks(streamId);
  }

  /** Drop a stream's pending coalesced chunks without publishing (teardown path). */
  private discardCoalescedChunks(streamId: string): void {
    const pending = this.pendingBatches.get(streamId);
    if (!pending) {
      return;
    }
    this.pendingBatches.delete(streamId);
    if (pending.timer != null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    for (const resolve of pending.resolvers) {
      resolve(undefined);
    }
  }

  private ensureChannelSubscription(streamId: string): Promise<void> {
    const channel = CHANNELS.events(streamId);
    const existing = this.channelSubscriptions.get(channel);
    if (existing) {
      return existing.ready;
    }

    const operation = this.subscriber.subscribe(channel);
    let expired = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const state: ChannelSubscriptionState = {
      ready: Promise.resolve(),
      phase: 'pending',
      fallbackActive: false,
    };
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(() => {
        expired = true;
        reject(new Error(`Timed out synchronizing Redis subscription for ${channel}`));
      }, SUBSCRIPTION_ATTACHMENT_TIMEOUT_MS);
      timeout.unref?.();
    });
    const ready = Promise.race([operation, deadline]).then(() => {
      state.phase = 'active';
      state.fallbackActive = false;
      logger.debug(`[RedisEventTransport] Subscription active for channel ${channel}`);
    });
    state.ready = ready;
    operation.then(
      () => {
        if (timeout != null) clearTimeout(timeout);
        if (expired) {
          const current = this.channelSubscriptions.get(channel);
          if (current == null || current === state) {
            if (current === state) this.channelSubscriptions.delete(channel);
            this.trackOrReleaseActiveChannel(streamId, channel);
          } else if (current.phase === 'pending') {
            /** If this replacement later fails, its rejection promotes the known-active
             * predecessor instead of losing the only tracked channel subscription. */
            current.fallbackActive = true;
          }
        }
      },
      () => {
        if (timeout != null) clearTimeout(timeout);
      },
    );
    this.channelSubscriptions.set(channel, state);
    void ready.catch((err) => {
      if (this.channelSubscriptions.get(channel) === state) {
        this.channelSubscriptions.delete(channel);
        if (state.fallbackActive) this.trackOrReleaseActiveChannel(streamId, channel);
      }
      logger.error(`[RedisEventTransport] Failed to subscribe to ${channel}:`, err);
    });
    return ready;
  }

  private trackOrReleaseActiveChannel(streamId: string, channel: string): void {
    const streamState = this.streams.get(streamId);
    const hasOwner =
      streamState != null &&
      (streamState.count > 0 ||
        streamState.abortCallbacks.size > 0 ||
        streamState.abortAckWaiters.size > 0 ||
        streamState.preemptCallbacks.size > 0);
    if (hasOwner) {
      /** Re-track the active channel so its surviving owner can release it normally. */
      this.channelSubscriptions.set(channel, {
        ready: Promise.resolve(),
        phase: 'active',
        fallbackActive: false,
      });
      return;
    }
    this.subscriber.unsubscribe(channel).catch((error) => {
      logger.error(`[RedisEventTransport] Failed to release late subscription ${channel}:`, error);
    });
  }

  /** Reset subscriber reorder buffer state to initial values */
  private resetReorderBuffer(streamId: string): void {
    const state = this.streams.get(streamId);
    if (state) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      state.reorderBuffer.nextSeq = 0;
      state.reorderBuffer.pending.clear();
      state.reorderBuffer.deliveryDeferred = false;
    }
  }

  /** Release a deferred attachment into the ordinary ordered-delivery fallback.
   * The state identity fence prevents a failed stale attachment from touching a
   * replacement lifecycle that happens to reuse the same stream ID. */
  private releaseDeferredDelivery(streamId: string, expectedState: StreamSubscribers): void {
    const state = this.streams.get(streamId);
    if (state !== expectedState || !state.reorderBuffer.deliveryDeferred) {
      return;
    }
    const buffer = state.reorderBuffer;
    buffer.deliveryDeferred = false;
    this.flushPendingMessages(streamId, state);
    if (buffer.pending.size > 0) {
      this.scheduleFlushTimeout(streamId, state);
    }
  }

  /**
   * Advance subscriber reorder buffer to the authoritative Redis sequence counter
   * (cross-replica safe).
   *
   * @param replayedNextSeq - Absolute Redis sequence immediately after the last event replayed
   *   from earlyEventBuffer. Pending entries below it were already delivered; entries at or
   *   above it are live chunks from the ongoing generation. Using the exact replay frontier
   *   (not the Redis counter) is critical: INCR can advance the counter past a live chunk's
   *   sequence during the GET window. Undefined means no local replay, so currentSeq is trusted.
   * @param preserveBufferedBeforeFrontier - A fresh post-SUBSCRIBE fence has no replay log;
   *   preserve every frame observed before its marker and begin at the earliest buffered seq.
   */
  async syncReorderBuffer(
    streamId: string,
    replayedNextSeq?: number,
    preserveBufferedBeforeFrontier = false,
  ): Promise<void> {
    const initialState = this.streams.get(streamId);
    try {
      const key = KEYS.sequence(streamId);
      /** The atomic post-SUBSCRIBE marker already returned an authoritative frontier;
       * another GET would add a new failure/race point before releasing delivery. */
      const rawStr =
        preserveBufferedBeforeFrontier && replayedNextSeq != null
          ? String(replayedNextSeq)
          : await this.publisher.get(key);
      const parsed = rawStr != null ? parseInt(rawStr, 10) : 0;
      const currentSeq = Number.isNaN(parsed) ? 0 : parsed;
      const state = this.streams.get(streamId);
      // cleanup() may replace this stream's local state while the Redis GET is in
      // flight. An obsolete snapshot must never move the replacement's frontier.
      if (state !== initialState) {
        return;
      }
      if (!state) {
        return;
      }

      const buffer = state.reorderBuffer;
      if (buffer.flushTimeout) {
        clearTimeout(buffer.flushTimeout);
        buffer.flushTimeout = null;
      }

      // Prune true duplicates already delivered via earlyEventBuffer. Entries at or above
      // the absolute replay frontier are live (possibly from an ongoing generation).
      if (replayedNextSeq != null && !preserveBufferedBeforeFrontier) {
        for (const seq of buffer.pending.keys()) {
          if (seq < replayedNextSeq) {
            buffer.pending.delete(seq);
          }
        }
      }

      // Set nextSeq from remaining state. Never regress — handleOrderedChunk may have
      // already advanced it during the async GET window.
      if (buffer.pending.size === 0) {
        // Same-replica replay: INCR precedes PUBLISH, so currentSeq may reflect
        // allocated-but-not-yet-delivered events. Cap at the exact replay frontier to
        // avoid skipping in-flight chunks. With no local replay, trust the Redis counter.
        const ceiling = replayedNextSeq ?? currentSeq;
        buffer.nextSeq = Math.max(buffer.nextSeq, ceiling);
      } else {
        let minPending = Infinity;
        for (const seq of buffer.pending.keys()) {
          if (seq < minPending) {
            minPending = seq;
          }
        }
        const replayOrRedisFrontier = replayedNextSeq ?? currentSeq;
        buffer.nextSeq = Math.max(buffer.nextSeq, Math.min(replayOrRedisFrontier, minPending));
      }

      buffer.deliveryDeferred = false;
      this.flushPendingMessages(streamId, state);

      // Re-arm flush timeout if gaps remain after sync — without this,
      // buffered messages could sit indefinitely if no new messages arrive.
      if (buffer.pending.size > 0) {
        this.scheduleFlushTimeout(streamId, state);
      }
    } catch (err) {
      const state = this.streams.get(streamId);
      // A failed Redis GET must not leave a live subscription permanently paused.
      // Fall back to normal reorder/timeout behavior and let the caller log the sync error.
      if (state === initialState && state?.reorderBuffer.deliveryDeferred) {
        const buffer = state.reorderBuffer;
        // The local replay frontier remains authoritative even when the shared counter
        // cannot be read. Drop its pub/sub copies before releasing any later live events.
        if (replayedNextSeq != null && !preserveBufferedBeforeFrontier) {
          for (const seq of buffer.pending.keys()) {
            if (seq < replayedNextSeq) {
              buffer.pending.delete(seq);
            }
          }
          buffer.nextSeq = Math.max(buffer.nextSeq, replayedNextSeq);
        }
        this.releaseDeferredDelivery(streamId, state);
      }
      throw err;
    }
  }

  /**
   * Handle incoming pub/sub message with reordering support for Redis Cluster
   */
  private handleMessage(channel: string, message: string): void {
    const match = channel.match(/^stream:\{([^}]+)\}:events$/);
    if (!match) {
      return;
    }
    const streamId = match[1];

    const streamState = this.streams.get(streamId);
    if (!streamState) {
      return;
    }

    try {
      const parsed = JSON.parse(message) as PubSubMessage;
      if (
        parsed.type === EventTypes.SUBSCRIPTION_FRONTIER &&
        parsed.subscriptionFrontierId != null
      ) {
        const waiter = this.subscriptionFrontierWaiters.get(parsed.subscriptionFrontierId);
        if (waiter?.streamId === streamId) {
          clearTimeout(waiter.timeout);
          this.subscriptionFrontierWaiters.delete(parsed.subscriptionFrontierId);
          waiter.resolve();
        }
        return;
      }
      /** Aborts, preempts, and abort acknowledgements are consumed by
       *  transport-internal waiters (e.g. pending-ack resolution), not SSE
       *  subscribers, so they must flow even with zero local subscribers. */
      if (
        streamState.count === 0 &&
        parsed.type !== EventTypes.ABORT &&
        parsed.type !== EventTypes.ABORT_ACK &&
        parsed.type !== EventTypes.PREEMPT
      ) {
        return;
      }
      if (parsed.type === EventTypes.CHUNK && parsed.seq != null) {
        this.handleOrderedChunk(streamId, streamState, parsed);
      } else if (
        parsed.type === EventTypes.CHUNK_BATCH &&
        parsed.baseSeq != null &&
        Array.isArray(parsed.events)
      ) {
        /** Unpack at ingress: each coalesced payload owns baseSeq + i, so the
         * reorder buffer sees the exact per-event sequences it would have seen
         * from individual frames (dup drop, gap buffering, force-flush). Each
         * event is isolated: a throwing subscriber callback must degrade like
         * a lost individual frame (that sequence stalls until the reorder
         * force-flush) instead of discarding the rest of the batch, whose
         * sequences are already reserved and would otherwise never arrive. */
        for (let i = 0; i < parsed.events.length; i++) {
          try {
            this.handleOrderedChunk(streamId, streamState, {
              type: EventTypes.CHUNK,
              seq: parsed.baseSeq + i,
              data: parsed.events[i],
              ...(parsed.generationId != null && { generationId: parsed.generationId }),
            });
          } catch (err) {
            logger.error(`[RedisEventTransport] Failed to deliver coalesced chunk:`, err);
          }
        }
      } else if (
        (parsed.type === EventTypes.DONE || parsed.type === EventTypes.ERROR) &&
        parsed.seq != null
      ) {
        this.handleTerminalEvent(streamId, streamState, parsed);
      } else {
        this.deliverMessage(streamId, streamState, parsed);
      }
    } catch (err) {
      logger.error(`[RedisEventTransport] Failed to parse message:`, err);
    }
  }

  /**
   * Handle terminal events (done/error) with sequence-based ordering.
   * Buffers the terminal event and delivers after all preceding chunks arrive.
   */
  private handleTerminalEvent(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (buffer.deliveryDeferred) {
      buffer.pending.set(seq, message);
      return;
    }

    if (seq < buffer.nextSeq) {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate terminal event for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
      return;
    }

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamId, streamState, message);
      buffer.nextSeq++;
      this.flushPendingMessages(streamId, streamState);
    } else {
      buffer.pending.set(seq, message);
      this.scheduleFlushTimeout(streamId, streamState);
    }
  }

  /**
   * Handle chunk messages with sequence-based reordering.
   * Buffers out-of-order messages and delivers them in sequence.
   */
  private handleOrderedChunk(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    const buffer = streamState.reorderBuffer;
    const seq = message.seq!;

    if (buffer.deliveryDeferred) {
      buffer.pending.set(seq, message);
      return;
    }

    if (seq === buffer.nextSeq) {
      this.deliverMessage(streamId, streamState, message);
      buffer.nextSeq++;

      this.flushPendingMessages(streamId, streamState);
    } else if (seq > buffer.nextSeq) {
      buffer.pending.set(seq, message);

      if (buffer.pending.size >= MAX_BUFFER_SIZE) {
        logger.warn(`[RedisEventTransport] Buffer overflow for stream ${streamId}, force-flushing`);
        this.forceFlushBuffer(streamId, streamState);
      } else {
        this.scheduleFlushTimeout(streamId, streamState);
      }
    } else {
      logger.debug(
        `[RedisEventTransport] Dropping duplicate/old message for stream ${streamId}: seq=${seq}, expected=${buffer.nextSeq}`,
      );
    }
  }

  /** Deliver consecutive pending messages */
  private flushPendingMessages(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    while (buffer.pending.has(buffer.nextSeq)) {
      const message = buffer.pending.get(buffer.nextSeq)!;
      buffer.pending.delete(buffer.nextSeq);
      this.deliverMessage(streamId, streamState, message);
      buffer.nextSeq++;
    }

    if (buffer.pending.size === 0 && buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }
  }

  /** Force-flush all pending messages in order (used on timeout or overflow) */
  private forceFlushBuffer(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      clearTimeout(buffer.flushTimeout);
      buffer.flushTimeout = null;
    }

    if (buffer.pending.size === 0) {
      return;
    }

    const sortedSeqs = [...buffer.pending.keys()].sort((a, b) => a - b);
    const skipped = sortedSeqs[0] - buffer.nextSeq;

    if (skipped > 0) {
      logger.warn(
        `[RedisEventTransport] Stream ${streamId}: skipping ${skipped} missing messages (seq ${buffer.nextSeq}-${sortedSeqs[0] - 1})`,
      );
    }

    for (const seq of sortedSeqs) {
      const message = buffer.pending.get(seq)!;
      buffer.pending.delete(seq);
      this.deliverMessage(streamId, streamState, message);
    }

    buffer.nextSeq = sortedSeqs[sortedSeqs.length - 1] + 1;
  }

  /** Schedule a timeout to force-flush if gaps aren't filled */
  private scheduleFlushTimeout(streamId: string, streamState: StreamSubscribers): void {
    const buffer = streamState.reorderBuffer;

    if (buffer.flushTimeout) {
      return;
    }

    buffer.flushTimeout = setTimeout(() => {
      buffer.flushTimeout = null;
      if (buffer.pending.size > 0) {
        logger.warn(
          `[RedisEventTransport] Stream ${streamId}: timeout waiting for seq ${buffer.nextSeq}, force-flushing ${buffer.pending.size} messages`,
        );
        this.forceFlushBuffer(streamId, streamState);
      }
    }, REDIS_EVENT_REORDER_TIMEOUT_MS);
  }

  /** Deliver a message to all handlers */
  private deliverMessage(
    streamId: string,
    streamState: StreamSubscribers,
    message: PubSubMessage,
  ): void {
    for (const [, handlers] of streamState.handlers) {
      switch (message.type) {
        case EventTypes.CHUNK:
          if (message.generationId == null) {
            handlers.onChunk(message.data);
          } else {
            handlers.onChunk(message.data, message.generationId);
          }
          break;
        case EventTypes.DONE:
          if (message.generationId == null) {
            handlers.onDone?.(message.data);
          } else {
            handlers.onDone?.(message.data, message.generationId);
          }
          break;
        case EventTypes.ERROR:
          if (message.generationId == null) {
            handlers.onError?.(message.error ?? 'Unknown error');
          } else {
            handlers.onError?.(message.error ?? 'Unknown error', message.generationId);
          }
          break;
        case EventTypes.ABORT:
        case EventTypes.ABORT_ACK:
          break;
        case EventTypes.PREEMPT:
          break;
      }
    }

    if (message.type === EventTypes.ABORT_ACK) {
      const requestId = message.abortRequestId;
      const generationId = message.generationId;
      if (requestId == null || generationId == null) {
        return;
      }
      const waiter = streamState.abortAckWaiters.get(requestId);
      if (waiter == null || waiter.generationId !== generationId) {
        return;
      }
      this.settleAbortAck(streamId, streamState, requestId, true);
      return;
    }

    if (message.type === EventTypes.ABORT) {
      let ownerAcknowledged = false;
      for (const registration of streamState.abortCallbacks) {
        try {
          if (message.generationId == null) {
            ownerAcknowledged = registration.callback() === true || ownerAcknowledged;
          } else {
            ownerAcknowledged =
              registration.callback(message.generationId) === true || ownerAcknowledged;
          }
        } catch (err) {
          logger.error(`[RedisEventTransport] Error in abort callback:`, err);
        }
      }
      if (ownerAcknowledged && message.abortRequestId != null && message.generationId != null) {
        void this.publishAbortAcknowledgement(
          streamId,
          message.generationId,
          message.abortRequestId,
        );
      }
    }

    if (message.type === EventTypes.PREEMPT && message.preempt != null) {
      for (const registration of streamState.preemptCallbacks) {
        try {
          registration.callback(message.preempt);
        } catch (err) {
          logger.error(`[RedisEventTransport] Error in preempt callback:`, err);
        }
      }
    }
  }

  private detachStreamSubscribers(streamId: string, state: StreamSubscribers): void {
    this.resetReorderBuffer(streamId);
    this.releaseSubscriptionFrontiers(streamId);

    this.unsubscribeUnusedChannel(streamId, state);

    try {
      state.allSubscribersLeftCallback?.();
    } catch (err) {
      logger.error(`[RedisEventTransport] Error in allSubscribersLeft callback:`, err);
    }
  }

  private unsubscribeUnusedChannel(streamId: string, state: StreamSubscribers): void {
    if (
      this.streams.get(streamId) !== state ||
      state.count > 0 ||
      state.abortCallbacks.size > 0 ||
      state.abortAckWaiters.size > 0 ||
      state.preemptCallbacks.size > 0
    ) {
      return;
    }

    const channel = CHANNELS.events(streamId);
    if (!this.channelSubscriptions.has(channel)) {
      return;
    }

    this.subscriber.unsubscribe(channel).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to unsubscribe from ${channel}:`, err);
    });
    this.channelSubscriptions.delete(channel);
  }

  /**
   * Subscribe to events for a stream.
   *
   * Ensures the Redis channel is active and returns an SSE-specific unsubscribe function.
   */
  subscribe(
    streamId: string,
    handlers: {
      onChunk: (event: unknown, generationId?: number) => void;
      onDone?: (event: unknown, generationId?: number) => void;
      onError?: (error: string, generationId?: number) => void;
    },
    options?: {
      deferSequenceDelivery?: boolean;
      captureSequenceFrontier?: boolean;
      /** @deprecated Use deferSequenceDelivery. */
      deferDeliveryUntilSynchronized?: boolean;
    },
  ): {
    unsubscribe: () => void;
    ready?: Promise<void>;
    syncReorderBuffer?: () => void | Promise<void>;
  } {
    const subscriberId = `sub_${++this.subscriberIdCounter}`;

    // Initialize stream state if needed
    const streamState = this.getOrCreateStreamState(streamId);
    // Internal listeners (for example cross-replica abort) can leave ordering
    // state behind with no real SSE subscribers. A new subscriber is a fresh
    // attachment and must not inherit that prior generation's expected seq.
    if (streamState.count === 0) {
      this.resetReorderBuffer(streamId);
      streamState.reorderBuffer.deliveryDeferred =
        options?.deferSequenceDelivery === true || options?.deferDeliveryUntilSynchronized === true;
    }
    streamState.count++;
    streamState.handlers.set(subscriberId, handlers);

    /** A fresh activity attachment has no replay log. SUBSCRIBE first, then atomically
     * capture the sequence and publish a marker. Observing that marker proves every
     * receivable pre-frontier frame is already buffered locally. */
    const captureSequenceFrontier =
      options?.captureSequenceFrontier === true && streamState.reorderBuffer.deliveryDeferred;
    const channelReady = this.ensureChannelSubscription(streamId);
    const attachmentFrontier = captureSequenceFrontier
      ? channelReady
          .then(() => {
            if (this.streams.get(streamId) !== streamState || streamState.count === 0) return;
            return this.captureSubscriptionFrontier(streamId);
          })
          .catch((error) => {
            /** The initiating route may leave while another local viewer remains.
             * A failed fence must not strand that survivor behind shared deferral. */
            this.releaseDeferredDelivery(streamId, streamState);
            throw error;
          })
      : undefined;
    const readyPromise = attachmentFrontier?.then(() => undefined) ?? channelReady;

    return {
      ready: readyPromise,
      syncReorderBuffer: async () => {
        /** A delayed attachment must never synchronize state recreated under the same ID. */
        if (this.streams.get(streamId) !== streamState) return;
        if (captureSequenceFrontier) {
          const capturedFrontier = await attachmentFrontier;
          if (
            capturedFrontier == null ||
            this.streams.get(streamId) !== streamState ||
            streamState.count === 0
          ) {
            return;
          }
          return this.syncReorderBuffer(streamId, capturedFrontier, true);
        }
        return this.syncReorderBuffer(streamId);
      },
      unsubscribe: () => {
        // An unsubscribe closure belongs to the exact state and handler created
        // above. After cleanup + stream reuse, it must not decrement or detach
        // the replacement subscription that happens to share the same stream ID.
        if (
          this.streams.get(streamId) !== streamState ||
          !streamState.handlers.delete(subscriberId)
        ) {
          return;
        }

        streamState.count--;

        // If the last SSE subscriber left, reset attachment state and notify.
        // Keep the Redis channel active while the generation's abort listener owns it.
        if (streamState.count === 0) {
          /**
           * Preserve callbacks for reconnect, but drop ordering state from the
           * previous attachment. Reconnects always call syncReorderBuffer(), so
           * keeping a detached subscriber's pending gaps or frontier here can
           * only delay the next attachment before that authoritative sync.
           */
          this.detachStreamSubscribers(streamId, streamState);
          /**
           *  Preserve stream state (callbacks, abort handlers) for reconnection.
           *  Previously this deleted the entire state, which lost the
           *  allSubscribersLeft callback and abortCallbacks registered by
           *  GenerationJobManager.createJob(). On the next subscribe() call,
           *  fresh state was created without those callbacks, causing
           *  hasSubscriber to never reset and syncReorderBuffer to be skipped.
           *  State is fully cleaned up by cleanup() when the job completes.
           */
        }
      },
    };
  }

  /**
   * Publish a chunk event to all subscribers across all instances.
   * Includes sequence number for ordered delivery in Redis Cluster mode.
   *
   * Performance: sequence allocation and publish share one round trip. This runs per streamed
   * delta, so the saved round trip is multiplied by the token count of every response.
   */
  emitChunk(streamId: string, event: unknown, generationId?: number): Promise<void> {
    return this.publishChunkWithReceipt(streamId, event, generationId).then(() => undefined);
  }

  /**
   * Publish a done event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitDone(streamId: string, event: unknown, generationId?: number): Promise<void> {
    try {
      /** Terminal frames must carry a later sequence than every pending delta,
       * or subscribers would close on DONE and drop the coalesced tail. */
      await this.flushCoalescedChunks(streamId);
      const sequence = await this.publishWithSequence(
        streamId,
        {
          type: EventTypes.DONE,
          data: event,
          ...(generationId != null && { generationId }),
        },
        generationId,
        true,
      );
      if (sequence === -1) {
        throw new GenerationPublicationFencedError('done', streamId, generationId);
      }
    } catch (err) {
      if (err instanceof GenerationPublicationFencedError) {
        logger.warn(`[RedisEventTransport] Skipped stale terminal publication:`, {
          streamId,
          generationId,
          eventType: err.eventType,
        });
      } else {
        logger.error(`[RedisEventTransport] Failed to publish done:`, err);
      }
      throw err;
    }
  }

  async renewDemand(streamId: string, ttlMs: number): Promise<void> {
    await this.publisher.set(KEYS.demand(streamId), '1', 'PX', ttlMs);
  }

  async hasDemand(streamId: string): Promise<boolean> {
    return (await this.publisher.exists(KEYS.demand(streamId))) > 0;
  }

  async emitReplacedDoneConfirmed(
    streamId: string,
    event: unknown,
    replacedGenerationId: number,
    creationAttemptId: string,
  ): Promise<void> {
    await this.flushCoalescedChunks(streamId);
    const [prefix, suffix] = RedisEventTransport.buildPayloadParts({
      type: EventTypes.DONE,
      data: event,
      generationId: replacedGenerationId,
    });
    const result = await this.publisher.eval(
      PUBLISH_REPLACED_DONE_LUA,
      2,
      KEYS.sequence(streamId),
      KEYS.job(streamId),
      CHANNELS.events(streamId),
      prefix,
      suffix,
      String(RedisEventTransport.SEQUENCE_TTL_SECONDS),
      String(replacedGenerationId),
      creationAttemptId,
    );
    if (result === -1) {
      throw new Error('Generation replacement DONE receipt is no longer current');
    }
  }

  /**
   * Publish an error event to all subscribers.
   * Includes sequence number to ensure delivery after all chunks.
   */
  async emitError(streamId: string, error: string, generationId?: number): Promise<void> {
    try {
      await this.flushCoalescedChunks(streamId);
      const sequence = await this.publishWithSequence(
        streamId,
        {
          type: EventTypes.ERROR,
          error,
          ...(generationId != null && { generationId }),
        },
        generationId,
        true,
      );
      if (sequence === -1) {
        throw new GenerationPublicationFencedError('error', streamId, generationId);
      }
    } catch (err) {
      if (err instanceof GenerationPublicationFencedError) {
        logger.warn(`[RedisEventTransport] Skipped stale terminal publication:`, {
          streamId,
          generationId,
          eventType: err.eventType,
        });
      } else {
        logger.error(`[RedisEventTransport] Failed to publish error:`, err);
      }
      throw err;
    }
  }

  closeLocalSubscribers(streamId: string, error: string): void {
    const state = this.streams.get(streamId);
    if (!state) {
      return;
    }

    const localHandlers = [...state.handlers.values()];
    for (const handlers of localHandlers) {
      try {
        handlers.onError?.(error);
      } catch (err) {
        logger.error(
          `[RedisEventTransport] Failed to close local subscriber for ${streamId}:`,
          err,
        );
      }
    }

    if (state.handlers.size === 0) {
      return;
    }

    state.handlers.clear();
    state.count = 0;
    this.detachStreamSubscribers(streamId, state);
  }

  /**
   * Get subscriber count for a stream (local instance only).
   *
   * Note: In a multi-instance setup, this only returns local subscriber count.
   * For global count, would need to track in Redis (e.g., with a counter key).
   */
  getSubscriberCount(streamId: string): number {
    return this.streams.get(streamId)?.count ?? 0;
  }

  /**
   * Check if this is the first subscriber (local instance only).
   */
  isFirstSubscriber(streamId: string): boolean {
    return this.getSubscriberCount(streamId) === 1;
  }

  /**
   * Register callback for when all subscribers leave.
   */
  onAllSubscribersLeft(streamId: string, callback: () => void): void {
    this.getOrCreateStreamState(streamId).allSubscribersLeftCallback = callback;
  }

  /**
   * Publish an abort signal to all replicas.
   * This enables cross-replica abort: when a user aborts on Replica B,
   * the generating Replica A receives the signal and stops.
   */
  emitAbort(streamId: string, generationId?: number): void {
    void this.publishAbort(streamId, generationId).catch((err) => {
      logger.error(`[RedisEventTransport] Failed to publish abort:`, err);
    });
  }

  private publishAbort(
    streamId: string,
    generationId?: number,
    abortRequestId?: string,
  ): Promise<number> {
    const channel = CHANNELS.events(streamId);
    const message: PubSubMessage = {
      type: EventTypes.ABORT,
      ...(generationId != null && { generationId }),
      ...(abortRequestId != null && { abortRequestId }),
    };
    return this.publisher.publish(channel, JSON.stringify(message));
  }

  private settleAbortAck(
    streamId: string,
    state: StreamSubscribers,
    abortRequestId: string,
    acknowledged: boolean,
  ): void {
    const waiter = state.abortAckWaiters.get(abortRequestId);
    if (!waiter) {
      return;
    }
    state.abortAckWaiters.delete(abortRequestId);
    clearTimeout(waiter.timeout);
    waiter.resolve(acknowledged);
    this.unsubscribeUnusedChannel(streamId, state);
  }

  private async hasDurableAbortAck(streamId: string, generationId: number): Promise<boolean> {
    return (await this.publisher.get(KEYS.abortAck(streamId, generationId))) === '1';
  }

  async recordAbortAcknowledgement(streamId: string, generationId: number): Promise<boolean> {
    try {
      await this.publisher.set(
        KEYS.abortAck(streamId, generationId),
        '1',
        'EX',
        ABORT_ACK_TTL_SECONDS,
      );
      return true;
    } catch (error) {
      logger.error(`[RedisEventTransport] Failed to persist generation abort proof:`, error);
      return false;
    }
  }

  async recordProviderDrain(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    try {
      await this.publisher.set(
        KEYS.providerDrain(streamId, generationId, providerExecutionId),
        '1',
        'EX',
        PROVIDER_DRAIN_TTL_SECONDS,
      );
      return true;
    } catch (error) {
      logger.error(`[RedisEventTransport] Failed to persist provider drain proof:`, error);
      return false;
    }
  }

  async hasProviderDrain(
    streamId: string,
    generationId: number,
    providerExecutionId: string,
  ): Promise<boolean> {
    return (
      (await this.publisher.get(
        KEYS.providerDrain(streamId, generationId, providerExecutionId),
      )) === '1'
    );
  }

  private async publishAbortAcknowledgement(
    streamId: string,
    generationId: number,
    abortRequestId: string,
  ): Promise<void> {
    if (!(await this.recordAbortAcknowledgement(streamId, generationId))) {
      // A live acknowledgement is only useful if a racing or inherited receipt
      // can prove the same owner stop after this subscription disappears. A
      // SET that committed despite a lost reply is recovered by the requester's
      // timeout read, so do not publish an ephemeral success here.
      return;
    }

    const acknowledgement: PubSubMessage = {
      type: EventTypes.ABORT_ACK,
      generationId,
      abortRequestId,
    };
    try {
      await this.publisher.publish(CHANNELS.events(streamId), JSON.stringify(acknowledgement));
    } catch (error) {
      logger.error(`[RedisEventTransport] Failed to acknowledge generation abort:`, error);
    }
  }

  /** Awaitable variant for replacement handoff receipts. Success requires an
   * acknowledgement from the callback that owns this exact generation; Redis
   * PUBLISH receiver counts are deliberately not treated as proof. */
  async emitAbortConfirmed(streamId: string, generationId: number): Promise<boolean> {
    try {
      if (await this.hasDurableAbortAck(streamId, generationId)) {
        return true;
      }
    } catch (error) {
      logger.error(`[RedisEventTransport] Failed to inspect generation abort proof:`, error);
    }

    const state = this.getOrCreateStreamState(streamId);
    await this.ensureChannelSubscription(streamId);
    if (this.streams.get(streamId) !== state) {
      return false;
    }

    const abortRequestId = randomUUID();
    const acknowledgement = new Promise<boolean>((resolve) => {
      const timeout = setTimeout(() => {
        void this.hasDurableAbortAck(streamId, generationId).then(
          (acknowledged) => this.settleAbortAck(streamId, state, abortRequestId, acknowledged),
          () => this.settleAbortAck(streamId, state, abortRequestId, false),
        );
      }, REDIS_ABORT_ACK_TIMEOUT_MS);
      state.abortAckWaiters.set(abortRequestId, { generationId, resolve, timeout });
    });

    try {
      // Redis Cluster may report zero receivers on the publishing node while a
      // subscriber on another node is still processing the abort. Only the
      // correlated acknowledgement (or its durable proof) can settle this.
      await this.publishAbort(streamId, generationId, abortRequestId);
    } catch (error) {
      this.settleAbortAck(streamId, state, abortRequestId, false);
      throw error;
    }
    return acknowledgement;
  }

  /**
   * Register callback for abort signals from any replica.
   * Called when abort is triggered on any replica (including this one).
   * Resolves once the Redis channel is active so callers can safely expose the stream.
   *
   * @param streamId - The stream identifier
   * @param callback - Called when abort signal is received
   */
  async onAbort(
    streamId: string,
    callback: (generationId?: number) => void | boolean,
  ): Promise<() => void> {
    const state = this.getOrCreateStreamState(streamId);

    const registration = { callback };
    state.abortCallbacks.add(registration);

    try {
      await this.ensureChannelSubscription(streamId);
    } catch (error) {
      state.abortCallbacks.delete(registration);
      this.unsubscribeUnusedChannel(streamId, state);
      throw error;
    }

    return () => {
      if (this.streams.get(streamId) !== state || !state.abortCallbacks.delete(registration)) {
        return;
      }
      this.unsubscribeUnusedChannel(streamId, state);
    };
  }

  /**
   * Publish a preempt arm/clear to all replicas. Unlike abort this does NOT
   * stop the run — the generating replica seals its current model stream at
   * the next provider-safe boundary. Same channel and subscription as every
   * other stream event; fenced by `msg.createdAt` on the receiving side.
   */
  /**
   * Resolves to the number of replicas that received the message, so an ARM
   * can be acknowledged only once it actually reached someone. Unlike abort
   * (fire-and-forget, because a failed abort is retried by the user hitting
   * stop again) an unheard arm is invisible: the route would answer
   * `preempt: true` for a seal that never happens. Rejects on publish
   * failure; callers decide what to do.
   */
  async emitPreempt(streamId: string, msg: PreemptMessage): Promise<number> {
    const channel = CHANNELS.events(streamId);
    const message: PubSubMessage = {
      type: EventTypes.PREEMPT,
      preempt: msg,
    };

    return this.publisher.publish(channel, JSON.stringify(message));
  }

  /**
   * Register callback for preempt signals from any replica.
   * Resolves once the Redis channel is active so callers can safely arm.
   * The returned function removes only this registration, so a terminal
   * generation releases its channel without touching a same-stream
   * replacement.
   */
  async onPreempt(streamId: string, callback: (msg: PreemptMessage) => void): Promise<() => void> {
    const state = this.getOrCreateStreamState(streamId);

    const registration = { callback };
    state.preemptCallbacks.add(registration);

    try {
      await this.ensureChannelSubscription(streamId);
    } catch (error) {
      state.preemptCallbacks.delete(registration);
      this.unsubscribeUnusedChannel(streamId, state);
      throw error;
    }

    return () => {
      if (this.streams.get(streamId) !== state || !state.preemptCallbacks.delete(registration)) {
        return;
      }
      this.unsubscribeUnusedChannel(streamId, state);
    };
  }

  /**
   * Get all tracked stream IDs (for orphan cleanup)
   */
  getTrackedStreamIds(): string[] {
    return Array.from(this.streams.keys());
  }

  /**
   * Cleanup local resources for a specific stream.
   *
   * The sequence counter is deliberately left in Redis. A stream ID is currently the
   * conversation ID, so later turns reuse the same ordering namespace. Another replica
   * may also still have a subscriber whose reorder buffer is positioned at this counter.
   * Deleting it here would restart the next producer at zero and make that subscriber
   * discard the entire next turn as duplicate traffic. The counter's sliding TTL bounds
   * orphan lifetime.
   */
  cleanup(streamId: string): void {
    const channel = CHANNELS.events(streamId);
    const state = this.streams.get(streamId);
    this.releaseSubscriptionFrontiers(streamId);

    /** Terminal publications flushed ahead of themselves; anything still pending
     * here belongs to a torn-down generation and stays recoverable from the
     * durable chunk log, matching a dropped per-event publication. */
    this.discardCoalescedChunks(streamId);

    if (state) {
      state.handlers.clear();
      state.allSubscribersLeftCallback = undefined;
      state.abortCallbacks.clear();
      for (const waiter of state.abortAckWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.resolve(false);
      }
      state.abortAckWaiters.clear();
      state.preemptCallbacks.clear();
    }

    this.resetReorderBuffer(streamId);

    if (this.channelSubscriptions.has(channel)) {
      this.subscriber.unsubscribe(channel).catch((err) => {
        logger.error(`[RedisEventTransport] Failed to cleanup ${channel}:`, err);
      });
      this.channelSubscriptions.delete(channel);
    }

    this.streams.delete(streamId);
  }

  /**
   * Destroy all resources.
   */
  destroy(): void {
    for (const streamId of new Set(
      [...this.subscriptionFrontierWaiters.values()].map((waiter) => waiter.streamId),
    )) {
      this.releaseSubscriptionFrontiers(streamId);
    }
    for (const streamId of this.pendingBatches.keys()) {
      this.discardCoalescedChunks(streamId);
    }

    // Clear all flush timeouts and buffered messages.
    // Sequence keys are NOT deleted here — they are shared across replicas.
    // A shutting-down replica must not nuke the counter for active publishers.
    // A sliding 24h safety-net TTL caps orphan lifetime after the last publish.
    for (const [, state] of this.streams) {
      if (state.reorderBuffer.flushTimeout) {
        clearTimeout(state.reorderBuffer.flushTimeout);
        state.reorderBuffer.flushTimeout = null;
      }
      state.reorderBuffer.pending.clear();
      for (const waiter of state.abortAckWaiters.values()) {
        clearTimeout(waiter.timeout);
        waiter.resolve(false);
      }
      state.abortAckWaiters.clear();
    }

    for (const channel of this.channelSubscriptions.keys()) {
      this.subscriber.unsubscribe(channel).catch(() => {});
    }

    this.channelSubscriptions.clear();
    this.streams.clear();

    try {
      this.subscriber.disconnect();
    } catch {
      /* ignore */
    }

    logger.info('[RedisEventTransport] Destroyed');
  }
}
