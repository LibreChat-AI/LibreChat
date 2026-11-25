import type { ConversationMethods } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { TitleOwner, TitleResult, TitleStream, TitleSettlement } from './stream';
import type { ServerRequest } from '~/types';
import type { TitleMarkers } from './task';
import { getSafeErrorMetadata } from '~/utils/errors';
import { titleKey } from './stream';
import { hasTitle } from './task';

const HEARTBEAT_MS = 15_000;
const MAX_ID_BYTES = 512;
/** Timers above this overflow to 1 ms; a longer wait re-arms instead. */
const MAX_TIMER_MS = 2_147_483_647;

type TitleStreamDependencies = Pick<ConversationMethods, 'getConvoTitleState'> & {
  markers: Pick<TitleMarkers, 'get'>;
  stream: Pick<TitleStream, 'subscribe'>;
  logger: { error: (message: string, metadata: ReturnType<typeof getSafeErrorMetadata>) => void };
};

const validId = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  Buffer.byteLength(value, 'utf8') <= MAX_ID_BYTES;

/**
 * Streams one conversation's pending title. Answers at once when the row already has a title or
 * no attempt owns it (`titleSettled: false`, so the browser can fall back to `/gen_title`);
 * otherwise waits for the attempt to settle. The stream is keyed by the signed-in user, so a conversation
 * that belongs to someone else always reads as nothing pending.
 */
export function createTitleStreamHandler(deps: TitleStreamDependencies) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { conversationId } = req.params as { conversationId?: string };
    if (!userId || !validId(conversationId)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    const owner: TitleOwner = { userId, tenantId: req.user?.tenantId || undefined, conversationId };

    let closed = req.destroyed || res.destroyed;
    let attempt: string | undefined;
    let resolved = false;
    const early: TitleSettlement[] = [];
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    let subscription: ReturnType<TitleStream['subscribe']> | undefined;

    const dispose = () => {
      closed = true;
      if (heartbeat != null) clearInterval(heartbeat);
      if (expiry != null) clearTimeout(expiry);
      subscription?.unsubscribe();
    };
    req.once('aborted', dispose);
    res.once('close', dispose);

    const write = (frame: unknown) => {
      if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(frame)}\n\n`);
    };
    /** `settled` tells the browser an attempt answered; without it the browser asks
     *  `/gen_title`, which still serves titles this stream never saw. */
    const finish = (settled: boolean, title?: TitleResult) => {
      if (closed) return;
      dispose();
      if (title != null) write({ event: 'title', data: title });
      write({ final: true, titleSettled: settled || title != null });
      if (!res.writableEnded && !res.destroyed) res.end();
    };
    const accept = (settlement: TitleSettlement) => {
      if (settlement.attempt != null && attempt != null && settlement.attempt !== attempt) return;
      finish(true, settlement.title);
    };
    const durable = async (): Promise<TitleResult | undefined> => {
      const state = await deps.getConvoTitleState(userId, conversationId);
      if (state == null || !hasTitle(state)) return undefined;
      return {
        conversationId,
        title: state.title as string,
        ...(state.titleSetByUser === true && { titleSetByUser: true }),
        ...(state.titleRevision != null && { titleRevision: state.titleRevision }),
      };
    };
    /** Waits out the owning attempt's lease, then reports what the row holds. */
    const watch = (expiresAt: number) => {
      expiry = setTimeout(
        () => {
          expiry = undefined;
          void (async () => {
            const marker = await deps.markers.get(titleKey(owner));
            if (closed) return;
            if (marker != null && marker.attempt === attempt && marker.expiresAt > Date.now()) {
              watch(marker.expiresAt);
              return;
            }
            finish(false, await durable());
          })().catch((error) => {
            deps.logger.error('[titles] Title stream recheck failed', getSafeErrorMetadata(error));
            finish(false);
          });
        },
        Math.min(Math.max(expiresAt - Date.now(), 0), MAX_TIMER_MS),
      );
      expiry.unref?.();
    };

    try {
      res.setHeader('Content-Encoding', 'identity');
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();

      /** Subscribe before reading, so a settlement between the reads below is never lost. */
      subscription = deps.stream.subscribe(owner, {
        onSettled: (settlement) => (resolved ? accept(settlement) : early.push(settlement)),
        /** A transport failure or shutdown ends without a verdict, so the browser reconnects. */
        onError: () => {
          dispose();
          if (!res.writableEnded && !res.destroyed) res.end();
        },
      });
      await subscription.ready;
      if (closed) return;

      const [title, marker] = await Promise.all([durable(), deps.markers.get(titleKey(owner))]);
      if (closed) return;
      if (title != null || marker == null) {
        const replayed = early.find((settlement) => settlement.title != null) ?? early[0];
        finish(replayed != null, title ?? replayed?.title);
        return;
      }
      attempt = marker.attempt;
      resolved = true;
      for (const settlement of early.splice(0)) accept(settlement);
      if (closed) return;
      heartbeat = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(': keep-alive\n\n');
      }, HEARTBEAT_MS);
      heartbeat.unref?.();
      watch(marker.expiresAt);
    } catch (error) {
      if (closed) return;
      deps.logger.error('[titles] Failed to open title stream', getSafeErrorMetadata(error));
      finish(false);
    }
  };
}
