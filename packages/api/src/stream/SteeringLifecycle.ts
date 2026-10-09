import { logger } from '@librechat/data-schemas';
import { ContentTypes, SteerEvents } from 'librechat-data-provider';
import type { TPendingSteer } from 'librechat-data-provider';
import type {
  GenerationProtocolVersion,
  IJobStoreV2,
  SteerArmOutcome,
  SteerArmResult,
  SteerEnqueueReceiptResult,
  SteerEnqueueVersionedResult,
  SteerQueueItem,
  SteerReceipt,
  SteerReceiptInput,
  TerminalSteerAdmissionPolicy,
  TerminalSteerAdmissionResult,
} from '~/stream/interfaces/IJobStore';
import type { ServerSentEvent } from '~/types';

/** Client-safe projection of a queued steer (drops the server-only userId). */
export function toPendingSteer(item: SteerQueueItem): TPendingSteer {
  return {
    steerId: item.steerId,
    ...(item.clientSteerId && { clientSteerId: item.clientSteerId }),
    text: item.text,
    createdAt: item.createdAt,
    ...(item.files && item.files.length > 0 && { files: item.files }),
    ...(item.quotes && item.quotes.length > 0 && { quotes: item.quotes }),
    ...(item.preempt === true && { preempt: true }),
    ...(item.preemptRevision != null && { preemptRevision: item.preemptRevision }),
  };
}

/** Who a parked payload belongs to — the claim surface can outlive the job
 *  record, so ownership must travel with the payload itself. */
export interface SteerOwner {
  userId: string;
  tenantId?: string;
}

interface ParkedSteers extends SteerOwner {
  generationProtocolVersion?: GenerationProtocolVersion;
  steers: TPendingSteer[];
}

export interface ParkedSteerRecovery {
  generationProtocolVersion: GenerationProtocolVersion;
  steers: TPendingSteer[];
}

/** Loosely-shaped content part for steer-id inspection across content views. */
export type SteerContentView = Array<
  { type?: string; steerId?: string; clientSteerId?: string } | undefined
>;

/**
 * Synthesize the `on_steer_applied` events a reconnecting subscriber missed in
 * the snapshot→subscribe window. Sourced from the FRESH content view, not the
 * snapshot queue: a steer accepted AND applied inside the gap never had a
 * snapshot id, so any steer part neither in the snapshot's applied set nor
 * still queued live was applied in the gap. Over-emitting a part the client
 * already holds is benign: re-delivery is idempotent client-side (applied-id
 * dedupe; the part is index-stable).
 */
export function synthesizeAppliedSteerEvents(
  snapshotContent: SteerContentView,
  liveQueue: SteerQueueItem[],
  freshContent: SteerContentView,
  meta: { conversationId: string; responseMessageId?: string },
): ServerSentEvent[] {
  const knownIds = new Set<string>();
  for (const part of snapshotContent) {
    if (part?.type === ContentTypes.STEER && part.steerId != null) {
      knownIds.add(part.steerId);
    }
  }
  for (const item of liveQueue) {
    knownIds.add(item.steerId);
  }
  const events: ServerSentEvent[] = [];
  for (let i = 0; i < freshContent.length; i++) {
    const part = freshContent[i];
    if (part?.type !== ContentTypes.STEER || part.steerId == null || knownIds.has(part.steerId)) {
      continue;
    }
    events.push({
      event: SteerEvents.ON_STEER_APPLIED,
      data: {
        steerId: part.steerId,
        ...(part.clientSteerId && { clientSteerId: part.clientSteerId }),
        index: i,
        part,
        conversationId: meta.conversationId,
        ...(meta.responseMessageId && { responseMessageId: meta.responseMessageId }),
      },
    } as ServerSentEvent);
  }
  return events;
}

/**
 * The FIFO queue of mid-run steering messages for a generation job.
 *
 * A steer is a user message submitted while a run is generating. The steer
 * route (any instance) enqueues it against the job; the owning process's
 * run-scoped `PostToolBatch` hook drains the queue at the next tool-batch
 * boundary and injects each entry into graph state as its own user message.
 *
 * Race-safety mirrors {@link ApprovalLifecycle}: enqueue is status-guarded in
 * the store (a steer can never land on a completed/aborted job — the caller
 * gets a rejection code instead), and drain is an atomic take-all so a steer
 * is delivered to exactly one drain. Steers left in the queue when the run
 * reaches a terminal state are drained by the finalization paths and reported
 * to the client, which converts them to queued follow-up turns.
 */
export class SteeringLifecycle {
  constructor(private readonly store: IJobStoreV2) {}

  /**
   * Append a steer, guarded on the job being `running`. Returns the new queue
   * depth, or a rejection code ({@link STEER_ENQUEUE_NOT_RUNNING} /
   * {@link STEER_ENQUEUE_QUEUE_FULL}).
   */
  async enqueue(
    streamId: string,
    item: SteerQueueItem,
    expectedCreatedAt?: number,
  ): Promise<number> {
    const depth = await this.store.enqueueSteer(streamId, item, expectedCreatedAt);
    if (depth > 0) {
      logger.debug(
        `[SteeringLifecycle] queued steer: ${streamId} steer=${item.steerId} depth=${depth}`,
      );
    }
    return depth;
  }

  enqueueVersioned(
    streamId: string,
    item: SteerQueueItem,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueVersionedResult> {
    return this.store.enqueueSteerVersioned(streamId, item, wantsPreempt, expectedCreatedAt);
  }

  enqueueWithReceipt(
    streamId: string,
    item: SteerQueueItem,
    receipt: SteerReceiptInput,
    wantsPreempt: boolean,
    expectedCreatedAt?: number,
  ): Promise<SteerEnqueueReceiptResult> {
    return this.store.enqueueSteerWithReceipt(
      streamId,
      item,
      receipt,
      wantsPreempt,
      expectedCreatedAt,
    );
  }

  getReceipt(streamId: string, clientSteerId: string): Promise<SteerReceipt | null> {
    return this.store.getSteerReceipt(streamId, clientSteerId);
  }

  /** Atomically take ALL queued steers, FIFO. `expectedCreatedAt` refuses the
   *  drain inside the store when the job was replaced. */
  drain(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    return this.store.drainSteers(streamId, expectedCreatedAt);
  }

  restoreClaimed(
    streamId: string,
    items: SteerQueueItem[],
    expectedCreatedAt?: number,
  ): Promise<boolean> {
    return this.store.restoreClaimedSteers(streamId, items, expectedCreatedAt);
  }

  admitTerminal(
    streamId: string,
    policy: TerminalSteerAdmissionPolicy,
    expectedCreatedAt?: number,
  ): Promise<TerminalSteerAdmissionResult> {
    return this.store.admitTerminalSteers(streamId, policy, expectedCreatedAt);
  }

  /**
   * Terminal drain: atomically CLOSE the queue to new steers, then take all
   * queued items. Finalization paths use this so a steer POST racing the
   * final/abort event can never be ACKed after the last drain and then
   * silently cleared — once closed, enqueue rejects (the client falls back to
   * a normal send) until the next `createJob` reopens the stream id.
   * `expectedCreatedAt` keeps a stale run's finalization from closing or
   * stealing a replacement job's queue.
   */
  closeAndDrain(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    return this.store.closeAndDrainSteers(streamId, expectedCreatedAt);
  }

  /** Non-destructive FIFO read, optionally scoped to one generation. */
  peek(streamId: string, expectedCreatedAt?: number): Promise<SteerQueueItem[]> {
    return this.store.peekSteers(streamId, expectedCreatedAt);
  }

  /**
   * User-cancelled before injection. Races with a drain settle inside the
   * store's atomic removal — `false` means the steer already injected (the
   * inline part is authoritative) or the run ended (the terminal paths own
   * delivery), and the cancel is simply too late.
   */
  cancel(streamId: string, steerId: string, expectedCreatedAt?: number): Promise<boolean> {
    return this.store.removeSteer(streamId, steerId, expectedCreatedAt);
  }

  discardLeftover(
    streamId: string,
    clientSteerId: string,
    steerId: string,
    owner: SteerOwner,
    expectedGenerationCreatedAt?: number,
  ): Promise<boolean> {
    return this.store.discardSteerLeftover(
      streamId,
      clientSteerId,
      steerId,
      owner.userId,
      owner.tenantId,
      expectedGenerationCreatedAt,
    );
  }

  consumeRecovered(
    streamId: string,
    steerId: string,
    owner: SteerOwner,
    expectedCreatedAt: number,
  ): Promise<boolean> {
    return this.store.consumeParkedSteer(
      streamId,
      steerId,
      owner.userId,
      owner.tenantId,
      expectedCreatedAt,
    );
  }

  /**
   * Escalate a still-queued steer to an interrupt IN PLACE — the durable
   * `preempt` flag flips on the existing item, so its FIFO position survives
   * (the whole queue drains at the seal, in order). Races with a drain,
   * cancel, or replacement run settle inside the store's atomic update as
   * `missing`, and the owner's LIVE capability is part of the same predicate
   * (`incapable`) — see {@link IJobStoreV2.armSteer}.
   */
  arm(streamId: string, steerId: string, expectedCreatedAt?: number): Promise<SteerArmOutcome> {
    return this.store.armSteer(streamId, steerId, expectedCreatedAt);
  }

  armVersioned(
    streamId: string,
    steerId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerArmResult> {
    return this.store.armSteerVersioned(streamId, steerId, expectedCreatedAt);
  }

  /** Relabel durable interrupt requests as ordinary steers when HITL resume
   * moves ownership to a replica that cannot seal mid-stream. */
  downgradePreempts(
    streamId: string,
    expectedCreatedAt?: number,
  ): Promise<SteerQueueItem[] | null> {
    return this.store.downgradeSteerPreempts(streamId, expectedCreatedAt);
  }

  /** Drop any queued steers (terminal cleanup backstop). */
  clear(streamId: string): Promise<void> {
    return this.store.clearSteers(streamId);
  }

  /**
   * Parks terminally-drained leftovers under their own bounded-TTL store key
   * so a client with NO live subscriber (closed tab, reload racing the final
   * event) can still recover them via the status route — even after the
   * default `completeJob` path deletes the job record itself. The owner
   * identity travels WITH the payload for exactly that reason: the jobless
   * claim path has no job record left to authorize against. Live clients keep
   * using the final/abort event copy; recovery is idempotent (queued chips
   * dedupe by steer id).
   */
  async park(
    streamId: string,
    steers: TPendingSteer[],
    owner: SteerOwner,
    expectedCreatedAt?: number,
  ): Promise<void> {
    if (steers.length === 0) {
      return;
    }
    const payload: ParkedSteers = {
      userId: owner.userId,
      ...(owner.tenantId != null && { tenantId: owner.tenantId }),
      steers,
    };
    try {
      await this.store.parkSteers(streamId, JSON.stringify(payload), expectedCreatedAt);
    } catch (error) {
      logger.warn(`[SteeringLifecycle] Failed to park leftover steers: ${streamId}`, error);
    }
  }

  /**
   * Owner-gated read of parked leftovers. The store keeps the payload until
   * a recovered item starts its deterministic next generation, so losing this
   * HTTP response cannot lose the user's words.
   */
  async claim(streamId: string, requester: SteerOwner): Promise<TPendingSteer[]> {
    return (await this.claimDetailed(streamId, requester, 2)).steers;
  }

  /** Protocol-aware recovery read used by the status route during the
   * rolling-upgrade bridge. Legacy stores fall back to destructive v1. */
  async claimDetailed(
    streamId: string,
    requester: SteerOwner,
    requestedProtocolVersion: GenerationProtocolVersion = 1,
  ): Promise<ParkedSteerRecovery> {
    let raw: string | undefined;
    let generationProtocolVersion: GenerationProtocolVersion = 1;
    try {
      const detailed = await this.store.claimParkedSteersDetailed?.(
        streamId,
        requester.userId,
        requester.tenantId,
        requestedProtocolVersion,
      );
      if (detailed != null) {
        raw = detailed.payload;
        generationProtocolVersion = detailed.generationProtocolVersion;
      } else if (this.store.claimParkedSteersDetailed == null) {
        raw = await this.store.claimParkedSteers(streamId, requester.userId, requester.tenantId);
      }
    } catch (error) {
      logger.warn(`[SteeringLifecycle] Failed to claim leftover steers: ${streamId}`, error);
      return { generationProtocolVersion, steers: [] };
    }
    if (!raw) {
      return { generationProtocolVersion, steers: [] };
    }
    try {
      const parsed = JSON.parse(raw) as ParkedSteers;
      const ownerMatch =
        parsed.userId === requester.userId &&
        (parsed.tenantId == null || parsed.tenantId === requester.tenantId);
      if (!ownerMatch) {
        return { generationProtocolVersion, steers: [] };
      }
      const payloadProtocol = parsed.generationProtocolVersion === 2 ? 2 : 1;
      if (payloadProtocol !== generationProtocolVersion) {
        return { generationProtocolVersion, steers: [] };
      }
      return {
        generationProtocolVersion,
        steers: Array.isArray(parsed.steers) ? parsed.steers : [],
      };
    } catch (error) {
      logger.warn(`[SteeringLifecycle] Failed to parse leftover steers: ${streamId}`, error);
      return { generationProtocolVersion, steers: [] };
    }
  }
}
