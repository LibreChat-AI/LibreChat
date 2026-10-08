import { DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS } from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';

/** An SSE comment line: clients skip it, intermediaries see bytes on the wire. */
export const SSE_KEEPALIVE_FRAME = ':\n\n';

export interface SseKeepaliveResponse {
  readonly writableEnded: boolean;
  write(chunk: string): boolean;
  flush?: () => void;
  once(event: 'close', listener: () => void): unknown;
}

export function resolveStreamKeepaliveMs(
  agentsConfig: Pick<Partial<TAgentsEndpoint>, 'streamKeepaliveIntervalMs'> | undefined,
): number {
  return agentsConfig?.streamKeepaliveIntervalMs ?? DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS;
}

/**
 * Writes a comment frame on a fixed interval until the response closes, so a
 * proxy idle timeout (Cloudflare drops a response after 100 s without bytes)
 * cannot cut a stream that is quiet while a long tool call runs.
 * Returns a stop function; `intervalMs <= 0` disables it.
 */
export function startSseKeepalive(res: SseKeepaliveResponse, intervalMs: number): () => void {
  if (!(intervalMs > 0)) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    if (res.writableEnded) {
      stop();
      return;
    }
    res.write(SSE_KEEPALIVE_FRAME);
    res.flush?.();
  }, intervalMs);
  timer.unref?.();
  function stop(): void {
    clearInterval(timer);
  }
  res.once('close', stop);
  return stop;
}
