import { logger } from '@librechat/data-schemas';
import { DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS } from 'librechat-data-provider';
import type { TAgentsEndpoint } from 'librechat-data-provider';
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import { getAppConfigOptionsFromUser } from '~/app/service';
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
 * Resolves the interval from the request's config, or loads it when absent. A failed load
 * keeps the default instead of failing the stream, and logs only safe error metadata.
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

export interface StreamKeepaliveRequest {
  config?: StreamKeepaliveConfig;
  user?: AppConfigUserLike | null;
}

/**
 * Builds the request-scoped interval reader for the stream route. Only YAML settings are
 * needed here, so the principal's config is read without runtime augmentation: a stream
 * attach or reconnect never pays for code-environment merges or their database reads.
 * `failClosed` makes the service reject instead of logging and swallowing, so every
 * failure reaches the sanitized fallback in `loadStreamKeepaliveMs`.
 */
export function createStreamKeepaliveLoader(
  getAppConfig: (options: GetAppConfigOptions) => Promise<StreamKeepaliveConfig | undefined | null>,
): (req: StreamKeepaliveRequest) => Promise<number> {
  return (req) =>
    loadStreamKeepaliveMs(req.config, () =>
      getAppConfig({
        ...getAppConfigOptionsFromUser(req.user),
        skipRuntimeAugmentation: true,
        failClosed: true,
      }),
    );
}

const isClosed = (res: SseKeepaliveResponse): boolean =>
  res.writableEnded || res.destroyed === true;

/**
 * Writes a comment frame whenever the response has been quiet for the interval, until it
 * closes, so a proxy idle timeout (Cloudflare drops a response after 100 s without bytes)
 * cannot cut a stream that is silent while a long tool call runs.
 *
 * The interval may be a promise: the default applies until it resolves, so neither the
 * caller nor the first frame waits on a config read. A late interval counts the time
 * already waited, so switching never pushes the next frame past its deadline. `0` stops it.
 * Stopping drops the response reference, so a pending interval that never settles cannot
 * keep a closed response alive.
 */
export function startSseKeepalive(
  res: SseKeepaliveResponse,
  intervalMs: number | Promise<number>,
): () => void {
  if (isClosed(res)) {
    return () => undefined;
  }
  let currentMs =
    typeof intervalMs === 'number' ? intervalMs : DEFAULT_STREAM_KEEPALIVE_INTERVAL_MS;
  let lastFrameAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let target: SseKeepaliveResponse | null = res;

  const stop = (): void => {
    target = null;
    clearTimeout(timer);
  };
  const schedule = (): void => {
    clearTimeout(timer);
    if (target == null || !(currentMs > 0)) {
      return;
    }
    const delay = Math.max(0, currentMs - (Date.now() - lastFrameAt));
    timer = setTimeout(beat, delay);
    timer.unref?.();
  };
  const beat = (): void => {
    if (target == null || isClosed(target)) {
      stop();
      return;
    }
    target.write(SSE_KEEPALIVE_FRAME);
    target.flush?.();
    lastFrameAt = Date.now();
    schedule();
  };

  res.once('close', stop);
  schedule();
  if (typeof intervalMs !== 'number') {
    void intervalMs.then(
      (resolvedMs) => {
        currentMs = resolvedMs;
        schedule();
      },
      () => undefined,
    );
  }
  return stop;
}
