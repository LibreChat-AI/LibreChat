import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, StepEvents } from 'librechat-data-provider';
import type { Agents, SubagentContentFrame, TMessageContentParts } from 'librechat-data-provider';
import type { GenerationJobManagerClass, TerminalJobClaim } from '~/stream/GenerationJobManager';
import type { FinalMessageFields, ServerSentEvent } from '~/types';
import { createSubagentContentFold } from './subagentContent';

/** Frames waiting on a slow store before the stream is given up, matching the manager's own
 *  early-event ceiling. Merged deltas do not count twice, so only distinct steps reach it. */
const MAX_QUEUED_FRAMES = 5_000;
/** How long the child waits on its stream's store before going on without it. Both bound a
 *  best-effort live view whose fallback is the child's own persisted result, so they are
 *  internal hygiene and not operator levers. */
const DEFAULT_SETTLE_TIMEOUT_MS = 1_000;
const DEFAULT_OPEN_TIMEOUT_MS = 3_000;

const EXPIRED = Symbol('expired');

/** Resolves with the operation, or with `EXPIRED` once it has taken too long. The operation
 *  keeps running; a rejection after expiry is swallowed. */
async function within<T>(operation: Promise<T>, timeoutMs: number): Promise<T | typeof EXPIRED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof EXPIRED>((resolve) => {
    timer = setTimeout(() => resolve(EXPIRED), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, expired]);
  } finally {
    if (timer != null) clearTimeout(timer);
    operation.catch(() => undefined);
  }
}

/** The producer reuses its event objects, so the stream keeps its own copy. */
function ownCopy(frame: SubagentContentFrame): SubagentContentFrame | null {
  try {
    return structuredClone(frame);
  } catch {
    try {
      return JSON.parse(JSON.stringify(frame)) as SubagentContentFrame;
    } catch {
      return null;
    }
  }
}

/** The part of the generation job manager a child's stream needs. */
export type ChildGenerationManager = Pick<
  GenerationJobManagerClass,
  | 'getJob'
  | 'createJob'
  | 'emitChunk'
  | 'touchJob'
  | 'setContentParts'
  | 'claimTerminalJob'
  | 'publishTerminalClaim'
  | 'finishTerminalJob'
>;

export type ChildGenerationInput = {
  userId: string;
  /** The child thread's conversation id, which is also the job's stream id. */
  threadId: string;
  taskId: string;
  parentConversationId: string;
  agentId?: string;
  sender: string;
  userMessage: { messageId: string; parentMessageId: string; text: string };
};

export type ChildGenerationFinal = {
  requestMessage: FinalMessageFields;
  responseMessage: FinalMessageFields;
};

/**
 * One background child's resumable stream. It observes the run and never controls it: a stream
 * that cannot be opened or written, or a job that is aborted, reaped or retired after a failed
 * write, degrades the live view and leaves the run and its result alone. The task store stops a
 * child through its own cancellation, which deletion, shutdown and the control endpoint all use.
 */
export interface ChildGeneration {
  readonly createdAt: number;
  /** Never blocks the caller. While a write is in flight, text deltas for one step merge. */
  emit(frame: SubagentContentFrame): void;
  /** Refreshes the job's idle clock while the child works without output. */
  touch(): Promise<void>;
  /** Every frame emitted so far, folded into content parts. */
  content(): TMessageContentParts[];
  /**
   * Ends the stream around the caller's own persistence: the terminal state is claimed
   * first, `persist` writes the child's rows, and the final event is published only after
   * they exist. `persist` always runs and its failure is rethrown. When it writes nothing
   * and returns null, or throws, readers are told to refetch instead of being handed a final.
   */
  settle(aborted: boolean, persist: () => Promise<ChildGenerationFinal | null>): Promise<void>;
}

export interface ChildGenerationHost {
  /**
   * Opens the stream for a run whose caller holds the child thread's lease. Null when the
   * stream could not be opened; the child runs without one.
   */
  open(input: ChildGenerationInput): Promise<ChildGeneration | null>;
}

type QueuedEvent = { event: ServerSentEvent; frame?: SubagentContentFrame };

const TEXT_KEYS: Readonly<Record<string, string>> = { text: 'text', think: 'think' };

type DeltaFrame = Extract<
  SubagentContentFrame,
  { event: StepEvents.ON_MESSAGE_DELTA | StepEvents.ON_REASONING_DELTA }
>;

const isDeltaFrame = (frame: SubagentContentFrame): frame is DeltaFrame =>
  frame.event === StepEvents.ON_MESSAGE_DELTA || frame.event === StepEvents.ON_REASONING_DELTA;

/** The one string a plain single-part delta carries, or null for any other shape. */
function deltaText(frame: DeltaFrame): { type: string; key: string; value: string } | null {
  const data = frame.data as { id?: unknown; delta?: { content?: unknown } };
  if (Object.keys(data).length !== 2 || data.delta == null) return null;
  if (Object.keys(data.delta).length !== 1 || !Array.isArray(data.delta.content)) return null;
  if (data.delta.content.length !== 1) return null;
  const part = data.delta.content[0] as Record<string, unknown> | null;
  if (part == null || typeof part.type !== 'string' || Object.keys(part).length !== 2) return null;
  const key = TEXT_KEYS[part.type];
  const value = key == null ? undefined : part[key];
  return typeof value === 'string' ? { type: part.type, key, value } : null;
}

/**
 * Two consecutive deltas for one step become a single frame carrying both strings, which
 * every reader folds to the same content. Anything but a plain text or reasoning delta
 * is left alone.
 */
export function mergeDeltaFrames(
  previous: SubagentContentFrame,
  next: SubagentContentFrame,
): SubagentContentFrame | null {
  if (!isDeltaFrame(previous) || !isDeltaFrame(next) || previous.event !== next.event) return null;
  if (previous.data.id !== next.data.id) return null;
  const left = deltaText(previous);
  const right = deltaText(next);
  if (left == null || right == null || left.type !== right.type) return null;
  return {
    event: previous.event,
    data: {
      id: previous.data.id,
      delta: { content: [{ type: left.type, [left.key]: left.value + right.value }] },
    },
  } as SubagentContentFrame;
}

class ManagedChildGeneration implements ChildGeneration {
  private readonly fold = createSubagentContentFold();
  private readonly queue: QueuedEvent[] = [];
  private draining?: Promise<void>;
  /** The stream is no longer written; frames are still folded so `content` stays whole. */
  private detached = false;
  private settling = false;

  constructor(
    private readonly manager: ChildGenerationManager,
    private readonly input: ChildGenerationInput,
    readonly createdAt: number,
    private readonly responseMessageId: string,
    private readonly settleTimeoutMs: number,
  ) {}

  enqueue(event: ServerSentEvent, frame?: SubagentContentFrame): void {
    this.queue.push({ event, ...(frame == null ? {} : { frame }) });
    this.pump();
  }

  emit(frame: SubagentContentFrame): void {
    if (this.settling) return;
    const own = ownCopy(frame);
    if (own == null) {
      logger.warn('[subagentGeneration] Child frame could not be copied; detaching', {
        threadId: this.input.threadId,
        taskId: this.input.taskId,
        event: frame.event,
      });
      this.detach();
      return;
    }
    if (this.detached) {
      this.apply(own);
      return;
    }
    const last = this.queue[this.queue.length - 1];
    const merged = last?.frame == null ? null : mergeDeltaFrames(last.frame, own);
    if (merged != null) {
      this.queue[this.queue.length - 1] = { event: this.toEvent(merged), frame: merged };
      return;
    }
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      logger.warn('[subagentGeneration] Child stream backlog exceeded its limit; detaching', {
        threadId: this.input.threadId,
        taskId: this.input.taskId,
      });
      this.detach();
      this.apply(own);
      return;
    }
    this.enqueue(this.toEvent(own), own);
  }

  /** A detached stream is touched too: its job is still the record that the child is running,
   *  and it is ended at settlement like any other. */
  async touch(): Promise<void> {
    if (this.settling) return;
    await this.manager.touchJob(this.input.threadId, this.createdAt).catch(() => false);
  }

  content(): TMessageContentParts[] {
    return this.fold.aggregator.contentParts as TMessageContentParts[];
  }

  /** The live array the manager snapshots for a resume on this replica. */
  parts(): Agents.MessageContentComplex[] {
    return this.fold.aggregator.contentParts as Agents.MessageContentComplex[];
  }

  async settle(
    aborted: boolean,
    persist: () => Promise<ChildGenerationFinal | null>,
  ): Promise<void> {
    this.settling = true;
    await this.drainWithin(this.settleTimeoutMs);
    /** A detached stream is claimed too. Its final event carries the whole response, and a
     *  job left running would read as a live child long after this one ended. */
    const claim = await this.claimWithin(aborted);
    let final: ChildGenerationFinal | null;
    try {
      final = await persist();
    } catch (error) {
      if (claim != null) await within(this.publish(claim, null), this.settleTimeoutMs);
      throw error;
    }
    if (claim == null) return;
    await within(
      this.publish(
        claim,
        final == null
          ? null
          : {
              final: true,
              conversation: { conversationId: this.input.threadId },
              requestMessage: final.requestMessage,
              responseMessage: final.responseMessage,
              ...(aborted ? { aborted: true } : {}),
            },
      ),
      this.settleTimeoutMs,
    );
  }

  /** The child's result is never held behind a stalled store. A claim that lands after the
   *  wait is released with a refetch notice, since nothing will publish its final event. */
  private async claimWithin(aborted: boolean): Promise<TerminalJobClaim | null> {
    const claiming = this.claim(aborted);
    const claim = await within(claiming, this.settleTimeoutMs);
    if (claim !== EXPIRED) return claim;
    logger.warn('[subagentGeneration] Child stream terminal claim timed out', {
      threadId: this.input.threadId,
      taskId: this.input.taskId,
    });
    void claiming.then((late) => (late == null ? undefined : this.publish(late, null)));
    return null;
  }

  private toEvent(frame: SubagentContentFrame): ServerSentEvent {
    const data =
      frame.event === StepEvents.ON_RUN_STEP
        ? { ...frame.data, runId: this.responseMessageId }
        : frame.data;
    return { event: frame.event, data: data as unknown as Record<string, unknown> };
  }

  private apply(frame: SubagentContentFrame): void {
    try {
      this.fold.apply(frame);
    } catch (error) {
      logger.warn('[subagentGeneration] Failed to fold a child frame', error);
    }
  }

  /** Stops writing and folds whatever was still waiting, in order. */
  private detach(): void {
    this.detached = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.frame != null) this.apply(entry.frame);
    }
  }

  private pump(): void {
    if (this.draining != null) return;
    const draining = this.drain().finally(() => {
      if (this.draining === draining) this.draining = undefined;
      if (this.queue.length > 0 && !this.detached) this.pump();
    });
    this.draining = draining;
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.detached) {
      const entry = this.queue.shift()!;
      /** Fold and publish in one synchronous step: a resume snapshot taken between them
       *  would carry this frame's content and then receive the frame again. */
      if (entry.frame != null) this.apply(entry.frame);
      try {
        await this.manager.emitChunk(this.input.threadId, entry.event, {
          expectedCreatedAt: this.createdAt,
        });
      } catch (error) {
        logger.warn('[subagentGeneration] Child stream write failed; detaching', error);
        this.detach();
      }
    }
  }

  private async drainWithin(timeoutMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<'expired'>((resolve) => {
      timer = setTimeout(() => resolve('expired'), timeoutMs);
      timer.unref?.();
    });
    try {
      while (this.draining != null && !this.detached) {
        if ((await Promise.race([this.draining, expired])) === 'expired') {
          logger.warn('[subagentGeneration] Child stream did not drain before settlement', {
            threadId: this.input.threadId,
            taskId: this.input.taskId,
          });
          this.detach();
        }
      }
    } finally {
      if (timer != null) clearTimeout(timer);
    }
  }

  private async claim(aborted: boolean): Promise<TerminalJobClaim | null> {
    try {
      return await this.manager.claimTerminalJob(
        this.input.threadId,
        aborted ? 'aborted' : 'complete',
        undefined,
        this.createdAt,
        { persistencePending: true },
      );
    } catch (error) {
      logger.warn('[subagentGeneration] Failed to claim the child stream terminal state', error);
      return null;
    }
  }

  private async publish(claim: TerminalJobClaim, event: ServerSentEvent | null): Promise<void> {
    try {
      await this.manager.publishTerminalClaim(claim, event);
    } catch (error) {
      logger.warn('[subagentGeneration] Failed to publish the child stream final event', error);
    } finally {
      await this.manager.finishTerminalJob(claim).catch((error) => {
        logger.warn('[subagentGeneration] Failed to release the child stream job', error);
      });
    }
  }
}

/** Runs each background child as a generation job keyed by its thread id. */
export function createChildGenerationHost(
  manager: ChildGenerationManager,
  options: { settleTimeoutMs?: number; openTimeoutMs?: number } = {},
): ChildGenerationHost {
  /** Ends a job created after its child stopped waiting for it, so it does not read as live. */
  const discard = async (streamId: string, createdAt: number): Promise<void> => {
    try {
      const claim = await manager.claimTerminalJob(streamId, 'aborted', undefined, createdAt, {
        persistencePending: true,
      });
      if (claim == null) return;
      try {
        await manager.publishTerminalClaim(claim, null);
      } finally {
        await manager.finishTerminalJob(claim);
      }
    } catch (error) {
      logger.warn('[subagentGeneration] Failed to discard a late child stream', error);
    }
  };
  return {
    async open(input) {
      const responseMessageId = `${input.taskId}:assistant`;
      const userMessage = {
        messageId: input.userMessage.messageId,
        parentMessageId: input.userMessage.parentMessageId,
        conversationId: input.threadId,
        text: input.userMessage.text,
      };
      try {
        /**
         * The caller holds the thread's lease, so a background child's job still marked live
         * here has lost its owner: a crashed replica, or a settlement that could not reach the
         * store. It is replaced, and its readers are told to refetch. Any other live job is
         * someone else's and is never replaced: an event-bound child paused for approval keeps
         * its job without holding the lease.
         */
        const abandoned = await within(
          manager.getJob(input.threadId).then((job) => job?.metadata.subagentTaskId != null),
          options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS,
        );
        if (abandoned === EXPIRED) throw new Error('child_stream_open_timeout');
        const creating = manager.createJob(input.threadId, input.userId, input.threadId, {
          ...(abandoned ? {} : { rejectActivePredecessor: true }),
          initialMetadata: {
            conversationId: input.threadId,
            endpoint: EModelEndpoint.agents,
            sender: input.sender,
            responseMessageId,
            userMessage,
            subagentTaskId: input.taskId,
            subagentParentConversationId: input.parentConversationId,
            ...(input.agentId == null ? {} : { agent_id: input.agentId }),
          },
        });
        const job = await within(creating, options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS);
        if (job === EXPIRED) {
          void creating.then(
            (late) => discard(input.threadId, late.createdAt),
            () => undefined,
          );
          throw new Error('child_stream_open_timeout');
        }
        const generation = new ManagedChildGeneration(
          manager,
          input,
          job.createdAt,
          responseMessageId,
          options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
        );
        manager.setContentParts(input.threadId, generation.parts(), job.createdAt);
        generation.enqueue({
          created: true,
          message: { ...userMessage, sender: 'User', isCreatedByUser: true },
          streamId: input.threadId,
        });
        return generation;
      } catch (error) {
        logger.warn('[subagentGeneration] Failed to open a child stream; running without one', {
          threadId: input.threadId,
          taskId: input.taskId,
          error: error instanceof Error ? error.name : typeof error,
        });
        return null;
      }
    },
  };
}
