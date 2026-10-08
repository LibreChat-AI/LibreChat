import { logger } from '@librechat/data-schemas';
import { DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS } from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import { getSafeErrorMetadata } from '~/utils/errors';

/** An SSE comment line: clients skip it, intermediaries see bytes on the wire. */
export const SSE_KEEPALIVE_FRAME = ':\n\n';

type KeepaliveAgentsConfig = Pick<Partial<TAgentsEndpoint>, 'streamKeepaliveIntervalMs'>;

export interface StreamKeepaliveConfig {
  endpoints?: { agents?: KeepaliveAgentsConfig };
}

export interface SseKeepaliveResponse {
  readonly writableEnded: boolean;
  readonly destroyed?: boolean;
  write(chunk: string): boolean;
  flush?: () => void;
  once(event: 'close', listener: () => void): unknown;
}

export function resolveStreamKeepaliveMs(agentsConfig: KeepaliveAgentsConfig | undefined): number {
  return agentsConfig?.streamKeepaliveIntervalMs ?? DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS;
}

/**
 * Resolves the interval from the request's config, or loads it when absent. Meant to be
 * started alongside the job lookup rather than before it, so it adds no serial read to a
 * stream attachment. A failed load keeps the default instead of failing the stream.
 */
export async function loadStreamKeepaliveMs(
  config: StreamKeepaliveConfig | undefined,
  load: () => Promise<StreamKeepaliveConfig | undefined | null>,
): Promise<number> {
  if (config != null) {
    return resolveStreamKeepaliveMs(config.endpoints?.agents);
  }
  try {
    const loaded = await load();
    return resolveStreamKeepaliveMs(loaded?.endpoints?.agents);
  } catch (error) {
    logger.warn(
      '[streamKeepalive] Could not load config; using the default interval',
      getSafeErrorMetadata(error),
    );
    return DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS;
  }
}

/**
 * Writes a comment frame on a fixed interval until the response closes, so a
 * proxy idle timeout (Cloudflare drops a response after 100 s without bytes)
 * cannot cut a stream that is quiet while a long tool call runs.
 * Returns a stop function; `intervalMs <= 0` disables it.
 */
export function startSseKeepalive(res: SseKeepaliveResponse, intervalMs: number): () => void {
  if (!(intervalMs > 0) || res.writableEnded || res.destroyed === true) {
    return () => undefined;
  }
  const timer = setInterval(() => {
    if (res.writableEnded || res.destroyed === true) {
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

/**
 * Starts the keepalive at the default interval right away, then switches to the
 * configured one once it resolves. Neither the subscription nor the first frame waits on
 * the config read, so a slow or hung config load cannot stall the stream.
 */
export function keepSseStreamAlive(
  res: SseKeepaliveResponse,
  intervalMs: Promise<number>,
): () => void {
  let stopped = false;
  let stopCurrent = startSseKeepalive(res, DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS);
  void intervalMs.then((resolvedMs) => {
    if (stopped || resolvedMs === DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS) {
      return;
    }
    stopCurrent();
    stopCurrent = startSseKeepalive(res, resolvedMs);
  });
  return () => {
    stopped = true;
    stopCurrent();
  };
}
