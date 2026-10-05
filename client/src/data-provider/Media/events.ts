import { useEffect } from 'react';
import { SSE } from 'sse.js';
import { useQueryClient } from '@tanstack/react-query';
import { QueryKeys, apiBaseUrl, mediaActivitySchema } from 'librechat-data-provider';
import type { MediaQueryScope } from './queries';

const STREAM_CLOSED = 2;

/** Live hints only. Reconnect, focus and regular HTTP polling always restore durable state. */
export function useMediaEvents(
  host: MediaQueryScope,
  token: string | undefined,
  enabled: boolean,
): void {
  const client = useQueryClient();
  const { scope, isCurrentSession, pollIntervalMs, catchUpIntervalMs } = host;
  useEffect(() => {
    if (!enabled || !token) return;
    let stream: SSE | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    let closed = false;
    let denied = false;
    const closeStream = () => {
      const current = stream;
      stream = undefined;
      current?.close();
    };
    const connect = () => {
      retry = undefined;
      if (closed || denied || !isCurrentSession() || document.visibilityState === 'hidden') return;
      const next = new SSE(`${apiBaseUrl()}/api/media/events`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` },
      });
      stream = next;
      next.addEventListener('message', (message: MessageEvent) => {
        if (stream !== next || closed || !isCurrentSession()) return;
        let envelope: { ready?: boolean; event?: unknown; data?: unknown };
        try {
          envelope = JSON.parse(message.data);
        } catch {
          return;
        }
        if (envelope?.ready === true) {
          attempts = 0;
          void client.invalidateQueries(
            { queryKey: [QueryKeys.mediaThreads, scope] },
            { cancelRefetch: false },
          );
          void client.invalidateQueries(
            { queryKey: [QueryKeys.mediaThread, scope] },
            { cancelRefetch: false },
          );
          for (const key of [
            QueryKeys.mediaTurns,
            QueryKeys.mediaTurnJobs,
            QueryKeys.mediaJobOutputs,
          ])
            void client.invalidateQueries({ queryKey: [key, scope] }, { cancelRefetch: false });
          return;
        }
        const activity = mediaActivitySchema.safeParse(envelope?.data);
        if (envelope?.event !== 'media_update' || !activity.success) return;
        void client.invalidateQueries(
          { queryKey: [QueryKeys.mediaThreads, scope] },
          { cancelRefetch: false },
        );
        for (const key of [QueryKeys.mediaThread, QueryKeys.mediaTurns, QueryKeys.mediaTurnJobs])
          void client.invalidateQueries(
            { queryKey: [key, scope, activity.data.threadId] },
            { cancelRefetch: false },
          );
        void client.invalidateQueries(
          { queryKey: [QueryKeys.mediaJobOutputs, scope] },
          { cancelRefetch: false },
        );
      });
      const reconnect = () => {
        closeStream();
        const delay = Math.min(pollIntervalMs * 2 ** attempts++, catchUpIntervalMs);
        retry = setTimeout(connect, delay);
      };
      next.addEventListener('error', (event: MessageEvent & { responseCode?: number }) => {
        if (stream !== next || closed) return;
        denied = [401, 403, 404].includes(event.responseCode ?? 0);
        if (denied) closeStream();
        else reconnect();
      });
      /** A server that ends the response cleanly (restart, backpressure) raises no `error`. */
      next.addEventListener('readystatechange', (event: Event & { readyState?: number }) => {
        if (stream !== next || closed || event.readyState !== STREAM_CLOSED) return;
        reconnect();
      });
    };
    const visibility = () => {
      clearTimeout(retry);
      closeStream();
      if (document.visibilityState !== 'hidden') connect();
    };
    document.addEventListener('visibilitychange', visibility);
    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      closeStream();
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [client, scope, token, enabled, isCurrentSession, pollIntervalMs, catchUpIntervalMs]);
}
