import { createHash } from 'node:crypto';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import type { ReplayLimits } from '~/stream/internal/replay';

const PREFIX = 'conversation-title:';
const SHUTDOWN_ERROR = 'Server is shutting down';

/** One terminal frame per attempt, kept long enough for a reconnect to read it. */
const REPLAY: ReplayLimits = { items: 2, bytes: 4096, ttlMs: 120_000 };

/** Whose title this is: a stream never crosses users or tenants. */
export type TitleOwner = {
  userId: string;
  tenantId?: string;
  conversationId: string;
};

/** The title the browser applies, as the conversation row holds it. */
export type TitleResult = {
  conversationId: string;
  title: string;
  titleSetByUser?: boolean;
  titleRevision?: number;
};

/** The only frame a title stream carries: the attempt ended, with or without a title. */
export type TitleSettlement = {
  attempt?: string;
  title?: TitleResult;
};

export type TitleSubscription = {
  unsubscribe: () => void;
  ready?: Promise<void>;
};

export type TitleSubscriber = {
  onSettled: (settlement: TitleSettlement) => void;
  onError: (error: string) => void;
};

export const titleKey = ({ userId, tenantId, conversationId }: TitleOwner): string =>
  `${tenantId ?? ''}:${userId}:${conversationId}`;

export const titleStreamId = (owner: TitleOwner): string =>
  `${PREFIX}${createHash('sha256').update(titleKey(owner)).digest('base64url').slice(0, 32)}`;

const isSettlement = (value: unknown): value is TitleSettlement => {
  if (value == null || typeof value !== 'object') return false;
  const { attempt, title } = value as { attempt?: unknown; title?: unknown };
  if (attempt != null && typeof attempt !== 'string') return false;
  if (title == null) return true;
  const result = title as Partial<TitleResult>;
  return typeof result.conversationId === 'string' && typeof result.title === 'string';
};

/** Conversation-scoped title delivery over the same in-memory/Redis transports as generation
 *  SSE. A settlement is retained briefly, so a browser that attaches after it still reads it. */
export class TitleStream {
  constructor(private readonly transport: IEventTransport) {}

  async settle(owner: TitleOwner, settlement: TitleSettlement): Promise<void> {
    const streamId = titleStreamId(owner);
    const id = `settled:${settlement.attempt ?? 'cancel'}`;
    if (this.transport.emitReplayableDone != null) {
      await this.transport.emitReplayableDone(streamId, settlement, REPLAY, { id });
      return;
    }
    await this.transport.emitDone(streamId, settlement);
  }

  subscribe(owner: TitleOwner, subscriber: TitleSubscriber): TitleSubscription {
    const streamId = titleStreamId(owner);
    let closed = false;
    const subscription = this.transport.subscribe(
      streamId,
      {
        onChunk: () => undefined,
        onReplay: () => undefined,
        onDone: (event) => {
          if (closed || !isSettlement(event)) return;
          subscriber.onSettled(event);
        },
        onError: (error) => {
          if (!closed) subscriber.onError(error);
        },
      },
      { replay: REPLAY },
    );
    return {
      ready: subscription.ready,
      unsubscribe: () => {
        if (closed) return;
        closed = true;
        subscription.unsubscribe();
        queueMicrotask(() => {
          if (this.transport.getSubscriberCount(streamId) === 0) this.transport.cleanup(streamId);
        });
      },
    };
  }

  /** Close this process's title responses before HTTP drain; browsers reconnect elsewhere. */
  prepareForShutdown(): void {
    for (const streamId of this.transport.getTrackedStreamIds()) {
      if (streamId.startsWith(PREFIX)) {
        this.transport.closeLocalSubscribers?.(streamId, SHUTDOWN_ERROR);
      }
    }
  }

  destroy(): void {
    this.transport.destroy();
  }
}
