import { createHash } from 'node:crypto';
import { mediaActivitySchema } from 'librechat-data-provider';
import type { MediaOwnerScope, MediaStoredJob } from '@librechat/data-schemas';
import type { MediaActivity, MediaConfig } from 'librechat-data-provider';
import type { Request, Response } from 'express';
import type { IEventTransport } from '~/stream/interfaces/IJobStore';
import { emitObservedChunk } from '~/stream/internal/chunkPublication';

export const mediaActivityStreamId = (scope: MediaOwnerScope): string =>
  `media-activity:${createHash('sha256')
    .update(JSON.stringify([scope.tenantId ?? '', scope.ownerId]))
    .digest('base64url')}`;

export function mediaActivityChanged(
  previous: Pick<MediaStoredJob, 'phase' | 'outputs'>,
  next: Pick<MediaStoredJob, 'phase' | 'outputs'>,
): boolean {
  if (previous.phase !== next.phase) return true;
  const ready = new Set(
    previous.outputs
      .filter((output) => output.kind === 'text' || output.state === 'ready')
      .map((output) => output.outputId),
  );
  return next.outputs.some(
    (output) => (output.kind === 'text' || output.state === 'ready') && !ready.has(output.outputId),
  );
}

/** Observational owner channel over the host transport; never owns or destroys that transport. */
export class MediaActivityStream {
  private readonly demand = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly transport: IEventTransport,
    private readonly config: MediaConfig['events'],
  ) {}

  private rememberDemand(streamId: string): void {
    clearTimeout(this.demand.get(streamId));
    const timer = setTimeout(() => this.demand.delete(streamId), this.config.demandCacheMs);
    timer.unref?.();
    this.demand.set(streamId, timer);
  }

  async publish(scope: MediaOwnerScope, activity: MediaActivity): Promise<void> {
    if (this.closed || !this.config.enabled) return;
    const streamId = mediaActivityStreamId(scope);
    if (!this.demand.has(streamId)) {
      const demanded = this.transport.hasDemand
        ? await this.transport.hasDemand(streamId)
        : this.transport.getSubscriberCount(streamId) > 0;
      if (!demanded) return;
      this.rememberDemand(streamId);
    }
    // Untagged observation: GJM generation fencing does not apply to durable media jobs.
    await emitObservedChunk(this.transport, streamId, { event: 'media_update', data: activity });
  }

  async open(scope: MediaOwnerScope, req: Request, res: Response): Promise<void> {
    if (this.closed || req.destroyed || res.destroyed) {
      res.end();
      return;
    }
    const streamId = mediaActivityStreamId(scope);
    let closed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let subscription: ReturnType<IEventTransport['subscribe']> | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      subscription?.unsubscribe();
      this.subscriptions.delete(close);
      req.off('aborted', close);
      res.off('close', close);
      if (!res.writableEnded) res.end();
      queueMicrotask(() => {
        if (this.transport.getSubscriberCount(streamId) === 0) this.transport.cleanup(streamId);
      });
    };
    const write = (value: unknown) => {
      if (closed || res.writableEnded || !res.write(`data: ${JSON.stringify(value)}\n\n`)) close();
    };
    this.subscriptions.add(close);
    req.once('aborted', close);
    res.once('close', close);
    res.set({
      'Content-Type': 'text/event-stream',
      'Content-Encoding': 'identity',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    const synchronize = this.transport.getSubscriberCount(streamId) === 0;
    try {
      subscription = this.transport.subscribe(
        streamId,
        {
          onChunk: (value) => {
            const envelope = value as { event?: unknown; data?: unknown } | null;
            if (
              envelope?.event === 'media_update' &&
              mediaActivitySchema.safeParse(envelope.data).success
            )
              write(envelope);
          },
          onError: close,
        },
        { deferSequenceDelivery: synchronize, captureSequenceFrontier: synchronize },
      );
      await subscription.ready;
      if (synchronize) await subscription.syncReorderBuffer?.();
      if (closed) return;
      await this.transport.renewDemand?.(streamId, this.config.demandTtlMs);
      if (closed) return;
      this.rememberDemand(streamId);
      write({ ready: true });
      heartbeat = setInterval(() => {
        if (closed) return;
        if (!res.write(': keep-alive\n\n')) {
          close();
          return;
        }
        void Promise.resolve(this.transport.renewDemand?.(streamId, this.config.demandTtlMs)).catch(
          close,
        );
      }, this.config.heartbeatMs);
      heartbeat.unref?.();
    } catch (error) {
      close();
      throw error;
    }
  }

  close(): void {
    this.closed = true;
    for (const close of this.subscriptions) close();
    for (const timer of this.demand.values()) clearTimeout(timer);
    this.demand.clear();
  }
}
