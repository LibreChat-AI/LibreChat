import { logger } from '@librechat/data-schemas';
import { createHash, randomUUID } from 'node:crypto';
import { subagentActivityConfigSchema } from 'librechat-data-provider';
import type { ConversationMethods, MessageMethods } from '@librechat/data-schemas';
import type { TSubagentActivityConfig } from 'librechat-data-provider';
import type { SubagentUpdateEvent } from '@librechat/agents';
import type { Response } from 'express';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import type { ServerRequest } from '~/types';
import { emitObservedChunk } from '~/stream/internal/chunkPublication';
import { SUBAGENT_ACTIVITY_LIMITS } from './activity';

const STREAM_PREFIX = 'subagent-activity:';
const MAX_ID_BYTES = 512;
const MAX_LABEL_BYTES = 512;
const MAX_ANCESTRY_ENTRIES = 16;
/** Includes Redis type/data/seq wrappers and the largest safe omission count. */
const REPLAY_WIRE_RESERVE_BYTES = 128;
const MAX_EVENT_BYTES = SUBAGENT_ACTIVITY_LIMITS.bytes - REPLAY_WIRE_RESERVE_BYTES;
const HEARTBEAT_MS = 15_000;
const DEMAND_TTL_MS = 30_000;
const DEMAND_HEARTBEAT_MS = 10_000;
const DEMAND_CACHE_MS = 250;
const SHUTDOWN_SUBSCRIBER_ERROR = 'Server is shutting down';

export type SubagentActivityTerminalStatus = 'completed' | 'failed' | 'cancelled';

export type SubagentActivityUpdateEvent = SubagentUpdateEvent & {
  /** Host-assigned identity shared by parent and detached delivery paths. */
  activityEventId?: string;
  /** Host-assigned monotonic sequence shared by parent and detached delivery paths. */
  activitySequence?: number;
};

export type SubagentActivityEnvelope = {
  event: 'on_subagent_update';
  data: SubagentActivityUpdateEvent;
  droppedCount?: number;
};

export type SubagentActivityReplayEnvelope = {
  event: 'subagent_activity_replay';
  data: SubagentActivityEnvelope[];
};

export type SubagentActivitySubscription = {
  unsubscribe: () => void;
  ready?: Promise<void>;
};

export type SubagentActivitySubscriber = {
  onEvent: (event: SubagentActivityEnvelope | SubagentActivityReplayEnvelope) => void;
  onDone?: (event: {
    final: true;
    subagentActivity: true;
    status: SubagentActivityTerminalStatus;
  }) => void;
  onError?: (error: string) => void;
};

type SubagentActivityStreamDependencies = Pick<
  ConversationMethods,
  'getConvoOwnership' | 'getSubagentThreadForParent'
> &
  Pick<MessageMethods, 'getMessages'>;

type SubagentActivityStreamParams = {
  parentConversationId?: string;
  threadId?: string;
  taskId?: string;
};

const validId = (value: string | undefined): value is string =>
  value != null && value.trim() !== '' && Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;

const boundedString = (value: string | undefined, maxBytes = MAX_ID_BYTES): string | undefined => {
  if (value == null) return undefined;
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  let end = Math.min(value.length, maxBytes);
  while (end > 0 && Buffer.byteLength(value.slice(0, end), 'utf8') > maxBytes) end -= 1;
  return value.slice(0, end);
};

const boundedData = (data: unknown, budget: number): unknown => {
  if (data == null) return undefined;
  try {
    return Buffer.byteLength(JSON.stringify(data), 'utf8') <= budget ? data : undefined;
  } catch {
    return undefined;
  }
};

export const boundSubagentActivityUpdate = (
  event: SubagentActivityUpdateEvent,
): SubagentActivityUpdateEvent => {
  let base: SubagentActivityUpdateEvent = {
    runId: boundedString(event.runId) ?? '',
    parentRunId: boundedString(event.parentRunId) ?? '',
    subagentRunId: boundedString(event.subagentRunId) ?? '',
    ...(boundedString(event.activityEventId) == null
      ? {}
      : { activityEventId: boundedString(event.activityEventId) }),
    ...(Number.isSafeInteger(event.activitySequence) && (event.activitySequence ?? -1) >= 0
      ? { activitySequence: event.activitySequence }
      : {}),
    subagentType: boundedString(event.subagentType) ?? '',
    subagentKind: event.subagentKind,
    subagentAgentId: boundedString(event.subagentAgentId) ?? '',
    ...(boundedString(event.memberAgentId) == null
      ? {}
      : { memberAgentId: boundedString(event.memberAgentId) }),
    ...(boundedString(event.parentAgentId) == null
      ? {}
      : { parentAgentId: boundedString(event.parentAgentId) }),
    ...(boundedString(event.parentToolCallId) == null
      ? {}
      : { parentToolCallId: boundedString(event.parentToolCallId) }),
    depth: event.depth,
    ancestry: (event.ancestry ?? []).slice(0, MAX_ANCESTRY_ENTRIES).map((entry) => ({
      subagentRunId: boundedString(entry.subagentRunId) ?? '',
      subagentType: boundedString(entry.subagentType) ?? '',
      subagentKind: entry.subagentKind,
      subagentAgentId: boundedString(entry.subagentAgentId) ?? '',
      parentRunId: boundedString(entry.parentRunId) ?? '',
      ...(boundedString(entry.parentAgentId) == null
        ? {}
        : { parentAgentId: boundedString(entry.parentAgentId) }),
      ...(boundedString(entry.parentToolCallId) == null
        ? {}
        : { parentToolCallId: boundedString(entry.parentToolCallId) }),
    })),
    phase: event.phase,
    ...(boundedString(event.label, MAX_LABEL_BYTES) == null
      ? {}
      : { label: boundedString(event.label, MAX_LABEL_BYTES) }),
    timestamp: boundedString(event.timestamp) ?? new Date().toISOString(),
  };
  let baseBytes = Buffer.byteLength(
    JSON.stringify({ event: 'on_subagent_update', data: base }),
    'utf8',
  );
  if (baseBytes > MAX_EVENT_BYTES) {
    base = { ...base, ancestry: [] };
    baseBytes = Buffer.byteLength(
      JSON.stringify({ event: 'on_subagent_update', data: base }),
      'utf8',
    );
  }
  /** Reasoning deltas ride the detached stream like every other phase — the
   * same user reads this reasoning in the main chat view, and the durable
   * projection now retains its bounded text as well. */
  const data = boundedData(event.data, Math.max(0, MAX_EVENT_BYTES - baseBytes - 32));
  return data == null ? base : { ...base, data };
};

const isTerminalEvent = (
  value: unknown,
): value is {
  final: true;
  subagentActivity: true;
  status: SubagentActivityTerminalStatus;
} => {
  if (value == null || typeof value !== 'object') return false;
  const event = value as {
    final?: unknown;
    subagentActivity?: unknown;
    status?: unknown;
  };
  return (
    event.final === true &&
    event.subagentActivity === true &&
    (event.status === 'completed' || event.status === 'failed' || event.status === 'cancelled')
  );
};

const isActivityEnvelope = (value: unknown): value is SubagentActivityEnvelope => {
  if (value == null || typeof value !== 'object') return false;
  const envelope = value as { event?: unknown; data?: unknown };
  return (
    envelope.event === 'on_subagent_update' &&
    envelope.data != null &&
    typeof envelope.data === 'object'
  );
};

export const subagentActivityStreamId = (threadId: string, taskId: string): string =>
  `${STREAM_PREFIX}${createHash('sha256')
    .update(`${threadId}\u0000${taskId}`)
    .digest('base64url')
    .slice(0, 32)}`;

/** Task-scoped live activity over the same in-memory/Redis transports used by generation SSE. */
export class SubagentActivityStream {
  private readonly demandCache = new Map<string, { demanded: boolean; expiresAt: number }>();

  private readonly replayLimits: { items: number; bytes: number; ttlMs: number };

  constructor(
    private readonly transport: IEventTransport,
    options: Partial<TSubagentActivityConfig> = {},
  ) {
    const config = subagentActivityConfigSchema.parse(options);
    this.replayLimits = {
      items: SUBAGENT_ACTIVITY_LIMITS.items,
      bytes: SUBAGENT_ACTIVITY_LIMITS.bytes,
      ttlMs: config.replayTtlMs,
    };
  }

  private async isDemanded(streamId: string): Promise<boolean> {
    if (this.transport.hasDemand == null) return true;
    const cached = this.demandCache.get(streamId);
    if (cached != null && cached.expiresAt > Date.now()) return cached.demanded;
    const demanded = await this.transport.hasDemand(streamId);
    /** A negative observation is replica-local and can become stale as soon as a panel on
     * another owner renews the shared lease. Cache only positive demand so attachment never
     * creates a forward-only delivery hole on a remote producer. */
    if (demanded) {
      this.demandCache.set(streamId, { demanded: true, expiresAt: Date.now() + DEMAND_CACHE_MS });
    } else {
      this.demandCache.delete(streamId);
    }
    return demanded;
  }

  private async renewDemand(streamId: string, isActive = () => true): Promise<void> {
    await this.transport.renewDemand?.(streamId, DEMAND_TTL_MS);
    if (!isActive()) {
      this.demandCache.delete(streamId);
      return;
    }
    this.demandCache.set(streamId, { demanded: true, expiresAt: Date.now() + DEMAND_CACHE_MS });
  }

  async publish(
    threadId: string,
    taskId: string,
    event: SubagentActivityUpdateEvent,
    droppedCount = 0,
  ): Promise<void> {
    const streamId = subagentActivityStreamId(threadId, taskId);
    if (this.transport.emitReplayableChunk == null && !(await this.isDemanded(streamId))) return;
    const envelope: SubagentActivityEnvelope = {
      event: 'on_subagent_update',
      data: boundSubagentActivityUpdate(event),
      ...(droppedCount > 0 ? { droppedCount } : {}),
    };
    if (this.transport.emitReplayableChunk != null) {
      await this.transport.emitReplayableChunk(streamId, envelope, this.replayLimits, {
        id: `${droppedCount > 0 ? 'gap' : 'event'}:${envelope.data.activityEventId ?? envelope.data.activitySequence?.toString() ?? randomUUID()}`,
        sequence: envelope.data.activitySequence,
      });
      return;
    }
    await emitObservedChunk(this.transport, streamId, envelope);
  }

  subscribe(
    threadId: string,
    taskId: string,
    subscriber: SubagentActivitySubscriber,
  ): SubagentActivitySubscription {
    const streamId = subagentActivityStreamId(threadId, taskId);
    let unsubscribe = (): void => undefined;
    const cleanupIfIdle = (): void => {
      queueMicrotask(() => {
        if (this.transport.getSubscriberCount(streamId) > 0) return;
        this.transport.cleanup(streamId);
        this.demandCache.delete(streamId);
      });
    };
    /** subscribe() registers synchronously. Sampling zero before it distinguishes a fresh
     * local attachment without moving an already-active shared reorder frontier. */
    const replayable = this.transport.emitReplayableChunk != null;
    const synchronizeAttachment = !replayable && this.transport.getSubscriberCount(streamId) === 0;
    const subscription = this.transport.subscribe(
      streamId,
      {
        onReplay: (events) => {
          subscriber.onEvent({
            event: 'subagent_activity_replay',
            data: events.filter(isActivityEnvelope),
          });
        },
        onChunk: (event) => {
          if (isActivityEnvelope(event)) subscriber.onEvent(event);
        },
        onDone: (event) => {
          if (!isTerminalEvent(event)) return;
          try {
            subscriber.onDone?.(event);
          } finally {
            unsubscribe();
          }
        },
        onError: (error) => {
          try {
            subscriber.onError?.(error);
          } finally {
            unsubscribe();
          }
        },
      },
      {
        ...(replayable ? { replay: this.replayLimits } : {}),
        deferSequenceDelivery: synchronizeAttachment,
        captureSequenceFrontier: synchronizeAttachment,
      },
    );
    let closed = false;
    let demandHeartbeat: ReturnType<typeof setInterval> | undefined;
    unsubscribe = () => {
      if (closed) return;
      closed = true;
      if (demandHeartbeat != null) clearInterval(demandHeartbeat);
      subscription.unsubscribe();
      cleanupIfIdle();
    };
    const ready = Promise.resolve(subscription.ready).then(async () => {
      if (synchronizeAttachment) {
        /** The attachment that deferred the shared buffer owns synchronization even if
         * its panel closes meanwhile; a surviving local subscriber still needs release. */
        await subscription.syncReorderBuffer?.();
      }
      if (closed) return;
      await this.renewDemand(streamId, () => !closed);
      if (closed) {
        this.demandCache.delete(streamId);
        return;
      }
      demandHeartbeat = setInterval(() => {
        void this.renewDemand(streamId, () => !closed).catch(() => undefined);
      }, DEMAND_HEARTBEAT_MS);
      demandHeartbeat.unref?.();
    });
    return { unsubscribe, ready };
  }

  async complete(
    threadId: string,
    taskId: string,
    status: SubagentActivityTerminalStatus,
  ): Promise<void> {
    const streamId = subagentActivityStreamId(threadId, taskId);
    this.demandCache.delete(streamId);
    try {
      const terminal = { final: true, subagentActivity: true, status };
      if (this.transport.emitReplayableDone != null) {
        await this.transport.emitReplayableDone(streamId, terminal, this.replayLimits, {
          id: 'done',
        });
        return;
      }
      if (!(await this.isDemanded(streamId))) return;
      await this.transport.emitDone(streamId, terminal);
    } finally {
      this.demandCache.delete(streamId);
    }
  }

  /** Close this process's SSE responses before HTTP drain. Durable child execution and
   * cross-replica activity remain untouched; clients reconnect to another live owner. */
  prepareForShutdown(): void {
    for (const streamId of this.transport.getTrackedStreamIds()) {
      this.transport.closeLocalSubscribers?.(streamId, SHUTDOWN_SUBSCRIBER_ERROR);
    }
  }

  destroy(): void {
    this.demandCache.clear();
    this.transport.destroy();
  }
}

const terminalStatus = (status: string | undefined): SubagentActivityTerminalStatus | undefined => {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'failed';
    case 'cancelled':
      return 'cancelled';
    default:
      return undefined;
  }
};

const terminalTaskStatus = async (
  deps: Pick<SubagentActivityStreamDependencies, 'getMessages'>,
  userId: string,
  threadId: string,
  taskId: string,
  tenantId?: string,
): Promise<SubagentActivityTerminalStatus | undefined> => {
  const messages = await deps.getMessages(
    {
      user: userId,
      conversationId: threadId,
      messageId: `${taskId}:assistant`,
      ...(tenantId == null ? { tenantId: { $exists: false } } : { tenantId }),
    },
    'messageId error unfinished +subagentTask',
    { limit: 1 },
  );
  const message = messages[0];
  let status = message?.subagentTask?.status;
  if (status == null && message != null) {
    if (message.error === true) {
      status = 'error';
    } else if (message.unfinished === true) {
      return undefined;
    } else {
      status = 'completed';
    }
  }
  return terminalStatus(status);
};

const notFound = (res: Response): void => {
  res.status(404).json({ error: 'Conversation not found' });
};

/** Snapshot plus attachment buffer can each hold one retention window. Public IDs
 * may JSON-escape to six bytes per input byte; budget that expansion without trimming. */
const MAX_PUBLIC_REPLAY_BYTES =
  2 * (SUBAGENT_ACTIVITY_LIMITS.bytes + SUBAGENT_ACTIVITY_LIMITS.items * (6 * MAX_ID_BYTES + 32)) +
  128;

/** Node accepts a write that returns false. Hold later frames until drain instead of
 * closing a healthy socket. One public snapshot has its own derived budget; later
 * queued live activity retains the standard byte/item budget. */
function createActivityWriter(res: Response, onClose: () => void) {
  const pending: Array<{ frame: string; bytes: number }> = [];
  let replaySent = false;
  let pendingBytes = 0;
  let blocked = false;
  let ending = false;
  let stopped = false;
  let terminal: string | undefined;
  const dispose = () => {
    stopped = true;
    pending.length = 0;
    pendingBytes = 0;
    terminal = undefined;
    res.off('drain', flush);
  };
  const finish = () => {
    dispose();
    onClose();
    if (!res.writableEnded && !res.destroyed) res.end();
  };
  const write = (frame: string) => {
    if (res.writableEnded || res.destroyed) {
      dispose();
      onClose();
      return;
    }
    blocked = !res.write(frame);
  };
  function flush(): void {
    if (stopped) return;
    blocked = false;
    while (pending.length > 0 && !blocked && !stopped) {
      const next = pending.shift()!;
      pendingBytes -= next.bytes;
      write(next.frame);
    }
    if (blocked || stopped || pending.length > 0) return;
    if (terminal != null) {
      const frame = terminal;
      terminal = undefined;
      write(frame);
    }
    if (ending && !blocked && !stopped) finish();
  }
  res.on('drain', flush);
  return {
    dispose,
    isEnding: () => ending,
    send: (value: unknown, final = false, replay = false): void => {
      if (stopped || ending) return;
      const frame = `data: ${JSON.stringify(value)}\n\n`;
      if (final) {
        ending = true;
        terminal = frame;
      } else {
        const frameBytes = Buffer.byteLength(frame, 'utf8');
        /** Reserve one bounded snapshot separately so public identity expansion cannot
         * consume the live queue or cause a reconnect loop on an otherwise valid replay. */
        const bytes = replay ? 0 : frameBytes;
        if (replay && (replaySent || frameBytes > MAX_PUBLIC_REPLAY_BYTES)) {
          finish();
          return;
        }
        if (replay) replaySent = true;
        if (!blocked && pending.length === 0) {
          /** The socket accepts this already-bounded public frame. Queue limits govern
           * waiting frames, not identity expansion of an immediately writable update. */
          write(frame);
          return;
        }
        if (
          pending.length >= SUBAGENT_ACTIVITY_LIMITS.items ||
          pendingBytes + bytes > SUBAGENT_ACTIVITY_LIMITS.bytes
        ) {
          /** A stalled reader cannot allocate unbounded memory; reconnect replays Redis. */
          finish();
          return;
        }
        pending.push({ frame, bytes });
        pendingBytes += bytes;
      }
      if (!blocked) flush();
    },
    heartbeat: (): void => {
      if (!stopped && !ending && !blocked) write(': keep-alive\n\n');
    },
  };
}

/** Event-bound children use a private binding id as their internal tool-call
 * identity. Keep that delivery identity behind the parent-authorized API
 * boundary while preserving a stable public identity for the activity UI. */
const publicActivityEnvelope = (
  event: SubagentActivityEnvelope | SubagentActivityReplayEnvelope,
  threadId: string,
  eventBound: boolean,
): SubagentActivityEnvelope | SubagentActivityReplayEnvelope => {
  if (event.event === 'subagent_activity_replay') {
    return {
      ...event,
      data: event.data.map(
        (entry) => publicActivityEnvelope(entry, threadId, eventBound) as SubagentActivityEnvelope,
      ),
    };
  }
  if (!eventBound) return event;
  const ancestry = (event.data.ancestry ?? []).map((entry) => {
    if (!entry.parentToolCallId?.startsWith('event-binding:')) return entry;
    const { parentToolCallId: _privateDeliveryId, ...publicEntry } = entry;
    return publicEntry;
  });
  return {
    ...event,
    data: {
      ...event.data,
      parentToolCallId: `event-thread:${boundedString(threadId, MAX_ID_BYTES - 13) ?? ''}`,
      ancestry,
    },
  };
};

/** Streams one active child task after the same parent/tenant authorization as its durable view. */
export function createSubagentActivityStreamHandler(
  deps: SubagentActivityStreamDependencies,
  stream: Pick<SubagentActivityStream, 'subscribe'>,
) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const tenantId = req.user?.tenantId || undefined;
    const { parentConversationId, threadId, taskId } = req.params as SubagentActivityStreamParams;
    if (
      !userId ||
      !validId(parentConversationId) ||
      !validId(threadId) ||
      !validId(taskId) ||
      parentConversationId === threadId
    ) {
      notFound(res);
      return;
    }

    let closed = req.destroyed || res.destroyed;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let subscription: SubagentActivitySubscription | undefined;
    let writer: ReturnType<typeof createActivityWriter> | undefined;
    const dispose = () => {
      if (heartbeat != null) clearInterval(heartbeat);
      subscription?.unsubscribe();
    };
    const close = () => {
      closed = true;
      dispose();
      writer?.dispose();
    };
    req.once('aborted', close);
    res.once('close', close);

    try {
      const [parent, child] = await Promise.all([
        deps.getConvoOwnership(userId, parentConversationId, tenantId ?? null),
        deps.getSubagentThreadForParent({
          user: userId,
          parentConversationId,
          conversationId: threadId,
          ...(tenantId == null ? {} : { tenantId }),
        }),
      ]);
      const lineage = child?.subagentThread;
      const lease = child?.subagentThreadLease;
      const authorized =
        parent != null &&
        child != null &&
        lineage?.parentConversationId === parentConversationId &&
        parent.tenantId === tenantId &&
        child.tenantId === tenantId &&
        lease?.taskId === taskId &&
        lease.expiresAt > new Date();
      if (!authorized) {
        notFound(res);
        return;
      }
      if (closed || req.destroyed || res.destroyed) return;

      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      writer = createActivityWriter(res, close);
      heartbeat = setInterval(() => writer?.heartbeat(), HEARTBEAT_MS);
      heartbeat.unref?.();
      try {
        subscription = stream.subscribe(threadId, taskId, {
          onEvent: (event) => {
            writer?.send(
              publicActivityEnvelope(
                event,
                threadId,
                lineage?.parentToolCallId?.startsWith('event-binding:') === true,
              ),
              false,
              event.event === 'subagent_activity_replay',
            );
          },
          onDone: (event) => {
            dispose();
            writer?.send(event, true);
          },
          onError: () => {
            dispose();
            writer?.send({ error: 'Subagent activity stream unavailable' }, true);
          },
        });
        await subscription.ready;
      } catch (error) {
        /** Release the failed attachment while leaving `closed` to represent only a
         * client/response close; the outer catch still owns the SSE error and end. */
        dispose();
        throw error;
      }
      if (closed || res.destroyed || writer.isEnding()) {
        dispose();
        return;
      }
      const durableTerminal = await terminalTaskStatus(deps, userId, threadId, taskId, tenantId);
      if (closed || res.destroyed || writer.isEnding()) return;
      if (durableTerminal != null) {
        dispose();
        writer.send(
          {
            final: true,
            subagentActivity: true,
            status: durableTerminal,
          },
          true,
        );
        return;
      }
      writer.send({ ready: true });
    } catch (error) {
      if (closed || res.destroyed) return;
      logger.error('[subagentActivity] Failed to open child activity stream', error);
      if (!res.headersSent) {
        res.status(500).json({ error: 'Failed to open subagent activity stream' });
        return;
      }
      dispose();
      writer?.send({ error: 'Subagent activity stream unavailable' }, true);
    }
  };
}

export const SUBAGENT_ACTIVITY_STREAM_LIMITS: Readonly<{
  eventBytes: number;
  labelBytes: number;
}> = Object.freeze({
  eventBytes: MAX_EVENT_BYTES,
  labelBytes: MAX_LABEL_BYTES,
});
