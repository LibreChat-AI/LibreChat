import { logger } from '@librechat/data-schemas';
import { createContentAggregator, GraphEvents } from '@librechat/agents';
import {
  subagentActivityConfigSchema,
  StepEvents,
  SteerEvents,
  ContentTypes,
  getRunStepCloseMetadata,
  getRunStepDurationMs,
} from 'librechat-data-provider';
import type {
  TSubagentActivityConfig,
  TSteerAppliedEvent,
  SubagentContentEvent,
  SubagentContentFrame,
  SubagentContentWatermark,
  SubagentTaskContentResponse,
  SubagentThreadStatus,
  TMessageContentParts,
  Agents,
} from 'librechat-data-provider';
import type {
  SubagentContentMethods,
  SubagentContentAppendResult,
  SubagentContentScope,
  ConversationMethods,
  MessageMethods,
} from '@librechat/data-schemas';
import type { SubagentUpdateEvent } from '@librechat/agents';
import type { Response } from 'express';
import type { ServerRequest } from '~/types';
import { toWireRunSteps } from '~/stream/interfaces/IJobStore';
import { createToolTimingAdapter } from './toolTiming';
import { getSafeErrorMetadata } from '~/utils/errors';

const CONTENT_GRAPH_EVENTS = {
  [StepEvents.ON_RUN_STEP]: GraphEvents.ON_RUN_STEP,
  [StepEvents.ON_MESSAGE_DELTA]: GraphEvents.ON_MESSAGE_DELTA,
  [StepEvents.ON_REASONING_DELTA]: GraphEvents.ON_REASONING_DELTA,
  [StepEvents.ON_RUN_STEP_DELTA]: GraphEvents.ON_RUN_STEP_DELTA,
  [StepEvents.ON_RUN_STEP_COMPLETED]: GraphEvents.ON_RUN_STEP_COMPLETED,
};

type SubagentContentUpdate = Pick<SubagentUpdateEvent, 'data'> & {
  phase: SubagentUpdateEvent['phase'] | 'tool_preparation' | 'steer_applied';
};

/** This boundary accepts only events already intended for the public main-chat stream. */
export function subagentContentFrame(update: SubagentContentUpdate): SubagentContentFrame | null {
  switch (update.phase) {
    case 'steer_applied':
      return { event: SteerEvents.ON_STEER_APPLIED, data: update.data as TSteerAppliedEvent };
    case 'run_step': {
      const data = update.data as Agents.RunStep | undefined;
      return data?.stepDetails == null ? null : { event: StepEvents.ON_RUN_STEP, data };
    }
    case 'message_delta':
      return { event: StepEvents.ON_MESSAGE_DELTA, data: update.data as Agents.MessageDeltaEvent };
    case 'reasoning_delta':
      return {
        event: StepEvents.ON_REASONING_DELTA,
        data: update.data as Agents.ReasoningDeltaEvent,
      };
    case 'run_step_delta':
      return { event: StepEvents.ON_RUN_STEP_DELTA, data: update.data as Agents.RunStepDeltaEvent };
    case 'run_step_completed':
      return {
        event: StepEvents.ON_RUN_STEP_COMPLETED,
        data: update.data as { result?: Agents.ToolEndEvent | null },
      };
    case 'tool_preparation':
      return {
        event: StepEvents.ON_TOOL_PREPARATION,
        data: update.data as Agents.ToolPreparationMarker,
      };
    case 'tool_calls_dispatched':
      return {
        event: StepEvents.ON_TOOL_CALLS_DISPATCHED,
        data: update.data as Agents.ToolCallsDispatchedEvent,
      };
    case 'run_step_closed':
      return {
        event: StepEvents.ON_RUN_STEP_CLOSED,
        data: update.data as Agents.RunStepClosedEvent,
      };
    default:
      return null;
  }
}

type CleanupRetry = Pick<
  TSubagentActivityConfig,
  'retryAttempts' | 'retryBaseDelayMs' | 'recoveryDelayMs'
>;

/** Detached from execution: one small scope and one unref'd timer until storage recovers. */
async function reconcileAbandonedContent(
  scope: SubagentContentScope,
  reconcile: SubagentContentMethods['reconcileSubagentContent'],
  policy: CleanupRetry,
  onError: (error: unknown) => void,
): Promise<void> {
  let attempt = 0;
  for (;;) {
    try {
      await reconcile(scope);
      return;
    } catch (error) {
      onError(error);
      attempt = Math.min(attempt + 1, policy.retryAttempts);
      const delay =
        attempt < policy.retryAttempts
          ? Math.min(policy.recoveryDelayMs, policy.retryBaseDelayMs * 2 ** (attempt - 1))
          : policy.recoveryDelayMs;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        timer.unref?.();
      });
    }
  }
}

function reconcileAfterWrite(
  writing: Promise<SubagentContentJournalResult> | undefined,
  scope: SubagentContentScope,
  reconcile: SubagentContentMethods['reconcileSubagentContent'],
  policy: CleanupRetry,
  onError: (error: unknown) => void,
): void {
  void Promise.resolve(writing)
    .catch(() => undefined)
    .then(() => reconcileAbandonedContent(scope, reconcile, policy, onError))
    .catch(onError);
}

type JournalOptions = {
  scope: SubagentContentScope;
  leaseToken?: string;
  flushMs: number;
  batchBytes: number;
  maxPendingBytes?: number;
  settlementTimeoutMs?: number;
  append: SubagentContentMethods['appendSubagentContentBatch'];
  reconcile?: SubagentContentMethods['reconcileSubagentContent'];
  cleanupRetry?: CleanupRetry;
  notify: (watermark: SubagentContentWatermark) => Promise<void>;
  onError: (error: unknown) => void;
};

type SubagentContentJournalResult =
  | SubagentContentAppendResult
  | { ok: false; error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' } };

/** Immutable append batches, not per-token replacements of a growing Mongo document. */
export class SubagentContentJournal {
  private readonly pending: Array<{ sequence: number; json?: string; bytes: number }> = [];
  private pendingBytes = 0;
  private captureStopped = false;
  private readonly maxPendingBytes: number;
  private timer?: ReturnType<typeof setTimeout>;
  private writing?: Promise<SubagentContentJournalResult>;
  private closing?: Promise<SubagentContentJournalResult>;
  private terminalResult?: SubagentContentJournalResult;
  private abandoned = false;
  private closed = false;
  private revision = 0;
  private committedSequence = -1;
  private observedSequence = -1;
  private notification?: Promise<void>;
  private pendingNotification?: SubagentContentWatermark;
  private staged?: {
    count: number;
    bytes: number;
    revision: number;
    fromSequence: number;
    throughSequence: number;
    eventsJson: string;
  };

  constructor(private readonly options: JournalOptions) {
    this.maxPendingBytes =
      options.maxPendingBytes ?? subagentActivityConfigSchema.parse({}).contentPendingBytes;
  }

  get throughSequence(): number {
    return this.observedSequence;
  }

  record(update: SubagentContentUpdate, sequence: number): void {
    if (this.closed || sequence <= this.observedSequence) return;
    if (sequence !== this.observedSequence + 1) throw new Error('Subagent content sequence gap');
    this.observedSequence = sequence;
    if (this.captureStopped) return;
    const frame = subagentContentFrame(update);
    /** Serialize before returning to the producer, which can mutate its event objects. */
    let json: string | undefined;
    try {
      json = frame == null ? undefined : JSON.stringify({ sequence, frame });
    } catch (error) {
      this.captureStopped = true;
      this.options.onError(error);
      return;
    }
    const bytes = (json == null ? 0 : Buffer.byteLength(json, 'utf8')) + 64;
    if (this.pendingBytes + bytes > this.maxPendingBytes) {
      this.captureStopped = true;
      this.options.onError(
        new Error('Subagent content persistence backlog exceeded its byte limit'),
      );
      return;
    }
    this.pending.push({ sequence, json, bytes });
    this.pendingBytes += bytes;
    if (this.pendingBytes >= this.options.batchBytes && this.writing == null) {
      this.startFlush();
    } else {
      this.schedule();
    }
  }

  private schedule(): void {
    if (this.closed || this.timer != null || this.pending.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.startFlush();
    }, this.options.flushMs);
    this.timer.unref?.();
  }

  private startFlush(): void {
    void this.flush()
      .catch(this.options.onError)
      .finally(() => this.schedule());
  }

  flush(): Promise<SubagentContentJournalResult> {
    if (this.terminalResult != null) return Promise.resolve(this.terminalResult);
    if (this.writing != null) return this.writing;
    const operation = this.drain();
    this.writing = operation;
    void operation
      .finally(() => {
        if (this.writing === operation) this.writing = undefined;
      })
      .catch(() => undefined);
    return operation;
  }

  private async drain(): Promise<SubagentContentJournalResult> {
    while (this.pending.length > 0) {
      if (this.staged == null) {
        let count = 0;
        let bytes = 2;
        for (const entry of this.pending) {
          if (count > 0 && bytes + entry.bytes + 1 > this.options.batchBytes) break;
          bytes += entry.bytes + 1;
          count++;
        }
        const batch = this.pending.slice(0, count);
        this.staged = {
          count,
          bytes: batch.reduce((total, entry) => total + entry.bytes, 0),
          revision: this.revision + 1,
          fromSequence: this.committedSequence + 1,
          throughSequence: batch[count - 1].sequence,
          eventsJson: `[${batch.flatMap((entry) => (entry.json == null ? [] : [entry.json])).join(',')}]`,
        };
      }
      const { count, bytes, ...batch } = this.staged;
      const result = await this.options.append({
        ...this.options.scope,
        leaseToken: this.options.leaseToken,
        ...batch,
      });
      if (this.abandoned) {
        return { ok: false, error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' } };
      }
      if (!result.ok) {
        this.closed = true;
        this.terminalResult = result;
        return result;
      }
      this.pending.splice(0, count);
      this.pendingBytes -= bytes;
      this.revision = batch.revision;
      this.committedSequence = batch.throughSequence;
      this.staged = undefined;
      this.notify({
        taskId: this.options.scope.taskId,
        revision: batch.revision,
        throughSequence: batch.throughSequence,
      });
    }
    return { ok: true };
  }

  private notify(watermark: SubagentContentWatermark): void {
    if (this.abandoned) return;
    this.pendingNotification = watermark;
    if (this.notification != null) return;
    const operation = (async () => {
      while (this.pendingNotification != null) {
        const next = this.pendingNotification;
        this.pendingNotification = undefined;
        await this.options.notify(next).catch(this.options.onError);
      }
    })();
    this.notification = operation;
    void operation
      .finally(() => {
        if (this.notification === operation) this.notification = undefined;
        if (this.pendingNotification != null) this.notify(this.pendingNotification);
      })
      .catch(this.options.onError);
  }

  close(): Promise<SubagentContentJournalResult> {
    if (this.closing != null) return this.closing;
    this.closed = true;
    if (this.timer != null) clearTimeout(this.timer);
    this.closing = this.closeWithinBudget();
    return this.closing;
  }

  private async closeWithinBudget(): Promise<SubagentContentJournalResult> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timeoutMs =
      this.options.settlementTimeoutMs ??
      subagentActivityConfigSchema.parse({}).contentSettlementTimeoutMs;
    const timeoutResult: SubagentContentJournalResult = {
      ok: false,
      error: { code: 'SUBAGENT_CONTENT_SETTLEMENT_TIMEOUT' },
    };
    const deadline = new Promise<SubagentContentJournalResult>((resolve) => {
      timeout = setTimeout(() => {
        this.abandoned = true;
        this.terminalResult = timeoutResult;
        this.pending.length = 0;
        this.pendingBytes = 0;
        this.staged = undefined;
        this.pendingNotification = undefined;
        if (this.options.reconcile != null) {
          const { user, tenantId, parentConversationId, conversationId, taskId } =
            this.options.scope;
          reconcileAfterWrite(
            this.writing,
            { user, tenantId, parentConversationId, conversationId, taskId },
            this.options.reconcile,
            this.options.cleanupRetry ?? subagentActivityConfigSchema.parse({}),
            this.options.onError,
          );
        }
        resolve(timeoutResult);
      }, timeoutMs);
    });
    try {
      while (!this.abandoned) {
        try {
          return await Promise.race([this.flush(), deadline]);
        } catch (error) {
          this.options.onError(error);
          /** Yield between attempts without letting a long flush cadence consume the whole budget. */
          await Promise.race([
            new Promise<void>((resolve) => {
              retry = setTimeout(
                resolve,
                Math.max(1, Math.min(this.options.flushMs, timeoutMs / 2)),
              );
            }),
            deadline,
          ]);
        }
      }
      return timeoutResult;
    } finally {
      if (timeout != null) clearTimeout(timeout);
      if (retry != null) clearTimeout(retry);
    }
  }
}

type ContentReadMethods = Pick<
  SubagentContentMethods,
  'getSubagentContentHead' | 'streamSubagentContentBatches'
>;

export type SubagentContentReadResult =
  | {
      ok: true;
      value: {
        content: TMessageContentParts[];
        runSteps: Agents.RunStep[];
        events: SubagentContentEvent[];
        throughSequence: number;
        revision: number;
        targetThroughSequence: number;
        nextCursor?: string;
      };
    }
  | { ok: false; error: { code: 'SUBAGENT_CONTENT_AHEAD' | 'SUBAGENT_CONTENT_GAP' } };

/** A sampled commit head fences the snapshot. Later batches are a suffix, never
 * folded into this snapshot accidentally. Reads stream from one Mongo cursor. */
export async function readSubagentContent(
  methods: ContentReadMethods,
  scope: SubagentContentScope,
  afterSequence?: number,
  options: { pageBytes?: number; throughRevision?: number } = {},
): Promise<SubagentContentReadResult> {
  const head = (await methods.getSubagentContentHead(scope, options.throughRevision)) ?? {
    revision: 0,
    throughSequence: -1,
  };
  if (options.throughRevision != null && head.revision !== options.throughRevision) {
    return { ok: false, error: { code: 'SUBAGENT_CONTENT_GAP' } };
  }
  if ((afterSequence ?? -1) > head.throughSequence) {
    return { ok: false, error: { code: 'SUBAGENT_CONTENT_AHEAD' } };
  }
  if (afterSequence != null && afterSequence === head.throughSequence) {
    return {
      ok: true,
      value: {
        revision: head.revision,
        throughSequence: afterSequence,
        targetThroughSequence: head.throughSequence,
        content: [],
        runSteps: [],
        events: [],
      },
    };
  }
  const aggregator = createContentAggregator();
  const timing = createToolTimingAdapter({
    emit: (event) =>
      timing.child(aggregator, {
        phase: event.event.slice(3),
        data: event.data,
      }),
  });
  const events: SubagentContentEvent[] = [];
  let throughSequence = afterSequence ?? -1;
  let revision: number | undefined;
  let pageBytes = 0;
  let stopped = false;
  const pageLimit = options.pageBytes ?? subagentActivityConfigSchema.parse({}).contentPageBytes;
  pages: for await (const batch of methods.streamSubagentContentBatches(
    scope,
    head.revision,
    afterSequence,
  )) {
    if (
      batch.fromSequence > throughSequence + 1 ||
      batch.throughSequence <= throughSequence ||
      (revision != null && batch.revision !== revision + 1)
    ) {
      return { ok: false, error: { code: 'SUBAGENT_CONTENT_GAP' } };
    }
    const entries: SubagentContentEvent[] = JSON.parse(batch.eventsJson);
    let previous = batch.fromSequence - 1;
    for (const entry of entries) {
      if (
        !Number.isSafeInteger(entry.sequence) ||
        entry.sequence <= previous ||
        entry.sequence < batch.fromSequence ||
        entry.sequence > batch.throughSequence
      ) {
        return { ok: false, error: { code: 'SUBAGENT_CONTENT_GAP' } };
      }
      previous = entry.sequence;
      if (entry.sequence <= (afterSequence ?? -1)) continue;
      const bytes = Buffer.byteLength(JSON.stringify(entry), 'utf8');
      /** One oversized public event remains whole; a full-part/preview protocol
       * is required before this can be a hard per-response byte ceiling. */
      if (pageBytes > 0 && pageBytes + bytes > pageLimit) {
        stopped = true;
        break pages;
      }
      pageBytes += bytes;
      throughSequence = entry.sequence;
      revision = batch.revision;
      if (afterSequence != null) {
        events.push(entry);
        continue;
      }
      const frame = entry.frame;
      if (frame.event === SteerEvents.ON_STEER_APPLIED) {
        aggregator.contentParts[frame.data.index] = frame.data.part;
        continue;
      }
      if (frame.event === StepEvents.ON_RUN_STEP_CLOSED) {
        const step = aggregator.stepMap.get(frame.data.id);
        if (step != null) step.status = frame.data.status;
        const part = step == null ? undefined : aggregator.contentParts[step.index];
        if (part?.type === ContentTypes.TOOL_CALL && part.tool_call != null) {
          part.tool_call.runStepStatus = frame.data.status;
          Object.assign(part.tool_call, getRunStepCloseMetadata(frame.data));
          const duration = getRunStepDurationMs(frame.data);
          if (duration != null) part.tool_call.runStepDurationMs = duration;
        }
        continue;
      }
      if (frame.event === StepEvents.ON_RUN_STEP_DELTA) await timing.delta(frame.data);
      /** SDK and wire enums have identical values, as in main-chat Redis recovery. */
      if (
        frame.event !== StepEvents.ON_TOOL_PREPARATION &&
        frame.event !== StepEvents.ON_TOOL_CALLS_DISPATCHED
      ) {
        aggregator.aggregateContent({
          event: CONTENT_GRAPH_EVENTS[frame.event],
          data: frame.data,
        } as Parameters<typeof aggregator.aggregateContent>[0]);
      }
      if (frame.event === StepEvents.ON_MESSAGE_DELTA) {
        const step = aggregator.stepMap.get(frame.data.id);
        const part = step == null ? undefined : aggregator.contentParts[step.index];
        if (part?.type === ContentTypes.TEXT && step?.stepDetails.type === 'message_creation') {
          const creation = step.stepDetails.message_creation;
          const phase = creation != null && 'phase' in creation ? creation.phase : undefined;
          if (phase === 'commentary' || phase === 'final_answer') part.phase = phase;
        }
      }
      timing.child(aggregator, { phase: frame.event.slice(3), data: frame.data });
    }
    throughSequence = batch.throughSequence;
    revision = batch.revision;
  }
  if (
    !stopped &&
    (throughSequence !== head.throughSequence || (revision != null && revision !== head.revision))
  ) {
    return { ok: false, error: { code: 'SUBAGENT_CONTENT_GAP' } };
  }
  return {
    ok: true,
    value: {
      revision: revision ?? head.revision,
      throughSequence,
      targetThroughSequence: head.throughSequence,
      ...(stopped
        ? {
            nextCursor: Buffer.from(
              JSON.stringify({
                afterSequence: throughSequence,
                throughRevision: head.revision,
              }),
            ).toString('base64url'),
          }
        : {}),
      content: aggregator.contentParts as TMessageContentParts[],
      runSteps: toWireRunSteps(
        [...aggregator.stepMap.values()].filter(
          (step): step is NonNullable<typeof step> => step != null,
        ),
      ),
      events,
    },
  };
}

type ContentHandlerDependencies = ContentReadMethods &
  Pick<ConversationMethods, 'getConvoOwnership' | 'getSubagentThreadForParent'> &
  Pick<MessageMethods, 'getMessages'>;

const validId = (value: string | undefined): value is string =>
  value != null && value.trim() !== '' && Buffer.byteLength(value, 'utf8') <= 512;

export function createSubagentTaskContentHandler(
  deps: ContentHandlerDependencies,
  getPageBytes: () => number = () => subagentActivityConfigSchema.parse({}).contentPageBytes,
  getRecoveryGraceMs: () => number = () =>
    subagentActivityConfigSchema.parse({}).contentRecoveryGraceMs,
): (req: ServerRequest, res: Response) => Promise<void> {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const user = req.user?.id;
    const tenantId = req.user?.tenantId || undefined;
    const { parentConversationId, threadId, taskId } = req.params as {
      parentConversationId?: string;
      threadId?: string;
      taskId?: string;
    };
    if (
      !user ||
      !validId(parentConversationId) ||
      !validId(threadId) ||
      !validId(taskId) ||
      parentConversationId === threadId
    ) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const after = req.query.afterSequence;
    let afterSequence = after == null ? undefined : Number(after);
    let throughRevision: number | undefined;
    const cursor = req.query.cursor;
    if (cursor != null) {
      try {
        if (typeof cursor !== 'string' || cursor.length > 1024 || after != null)
          throw new Error('Invalid cursor');
        const parsed: { afterSequence?: number; throughRevision?: number } = JSON.parse(
          Buffer.from(cursor, 'base64url').toString('utf8'),
        );
        if (
          !Number.isSafeInteger(parsed.afterSequence) ||
          parsed.afterSequence! < -1 ||
          !Number.isSafeInteger(parsed.throughRevision) ||
          parsed.throughRevision! < 0
        )
          throw new Error('Invalid cursor');
        afterSequence = parsed.afterSequence;
        throughRevision = parsed.throughRevision;
      } catch {
        res
          .status(400)
          .json({ error: 'Invalid content cursor', code: 'SUBAGENT_CONTENT_INVALID_CURSOR' });
        return;
      }
    }
    if (
      after != null &&
      (typeof after !== 'string' ||
        !/^-?\d+$/.test(after) ||
        !Number.isSafeInteger(afterSequence) ||
        afterSequence! < -1)
    ) {
      res
        .status(400)
        .json({ error: 'Invalid content cursor', code: 'SUBAGENT_CONTENT_INVALID_CURSOR' });
      return;
    }
    const scope: SubagentContentScope = {
      user,
      tenantId,
      parentConversationId,
      conversationId: threadId,
      taskId,
    };
    try {
      const [parent, child, messages] = await Promise.all([
        deps.getConvoOwnership(user, parentConversationId, tenantId ?? null),
        deps.getSubagentThreadForParent({
          user,
          parentConversationId,
          conversationId: threadId,
          tenantId,
        }),
        deps.getMessages(
          {
            user,
            conversationId: threadId,
            messageId: { $in: [`${taskId}:user`, `${taskId}:assistant`] },
            ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
            $or: [{ expiredAt: null }, { expiredAt: { $gt: new Date() } }],
          },
          'messageId unfinished error expiredAt createdAt +subagentTask +subagentContent',
          { limit: 2 },
        ),
      ]);
      const seed = messages.find((message) => message.messageId === `${taskId}:user`);
      const assistant = messages.find((message) => message.messageId === `${taskId}:assistant`);
      if (
        parent == null ||
        child == null ||
        seed == null ||
        parent.tenantId !== tenantId ||
        child.tenantId !== tenantId ||
        child.subagentThread?.parentConversationId !== parentConversationId
      ) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }
      if (seed.subagentContent?.version !== 1 || seed.subagentContent.deleted === true) {
        res
          .status(409)
          .json({ error: 'Subagent content unavailable', code: 'SUBAGENT_CONTENT_UNAVAILABLE' });
        return;
      }
      const result = await readSubagentContent(deps, scope, afterSequence, {
        pageBytes: getPageBytes(),
        throughRevision,
      });
      if (!result.ok) {
        res
          .status(409)
          .json({ error: 'Subagent content must be reloaded', code: result.error.code });
        return;
      }
      const { content, runSteps, events, ...watermark } = result.value;
      const durableStatus = assistant?.subagentTask?.status;
      const running = durableStatus == null || durableStatus === 'running';
      const leaseActive =
        child.subagentThreadLease?.taskId === taskId &&
        child.subagentThreadLease.expiresAt > new Date();
      let status: SubagentThreadStatus = 'completed';
      if (running) status = leaseActive ? 'running' : 'interrupted';
      else if (durableStatus === 'error') status = 'failed';
      else if (durableStatus === 'cancelled') status = 'cancelled';
      /** A live lease proves ownership, not that every producer-observed event
       * has reached storage. Only terminal expected-watermark equality is complete. */
      const recovery =
        !running && assistant?.subagentContent?.throughSequence === watermark.targetThroughSequence
          ? 'complete'
          : 'partial';
      const settledAt =
        assistant?.createdAt == null ? NaN : new Date(assistant.createdAt).getTime();
      const retryUntil = settledAt + getRecoveryGraceMs();
      const identity = {
        ...watermark,
        ...(!running &&
        recovery === 'partial' &&
        Number.isFinite(retryUntil) &&
        retryUntil > Date.now()
          ? { retryUntil }
          : {}),
        parentConversationId,
        threadId,
        taskId,
        messageId: `${taskId}:assistant`,
        parentMessageId: `${taskId}:user`,
        sender: child.subagentThread.subagentType,
        status,
        recovery,
      } as const;
      const response: SubagentTaskContentResponse =
        afterSequence == null
          ? { ...identity, mode: 'snapshot', content, runSteps }
          : { ...identity, mode: 'suffix', afterSequence, events };
      res.json(response);
    } catch (error) {
      logger.error('[subagentContent] Content recovery unavailable', getSafeErrorMetadata(error));
      res
        .status(503)
        .json({ error: 'Subagent content unavailable', code: 'SUBAGENT_CONTENT_UNAVAILABLE' });
    }
  };
}
