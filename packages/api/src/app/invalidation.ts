import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { Cluster, Redis } from 'ioredis';
import type { ConfigLoadResult } from './loader';
import { createIoRedisSubscriber, duplicateIoRedisClient } from '~/cache/redisUtils';
import { getSafeErrorMetadata } from '~/utils/errors';

/** Pub/sub channel every instance listens on for admin config cache invalidations. */
export const CONFIG_INVALIDATION_CHANNEL = 'librechat:config:invalidate';

/** The publishing half of a pub/sub client (an ioredis client in production). */
export interface ConfigInvalidationPublisher {
  publish(channel: string, message: string): Promise<number>;
}

/**
 * A dedicated subscriber connection (a client in subscribe mode cannot publish). It emits
 * `ready` each time its connection is established, as an ioredis client does.
 */
export interface ConfigInvalidationSubscriber {
  subscribe(channel: string): Promise<unknown>;
  unsubscribe(channel: string): Promise<unknown>;
  on(event: 'message', listener: (channel: string, message: string) => void): unknown;
  on(event: 'ready', listener: () => void): unknown;
  off(event: 'message', listener: (channel: string, message: string) => void): unknown;
  off(event: 'ready', listener: () => void): unknown;
}

/** The connections and channel cross-instance invalidation runs on. */
export interface ConfigInvalidationPubSub {
  publisher: ConfigInvalidationPublisher;
  subscriber: ConfigInvalidationSubscriber;
  channel?: string;
}

/** One cache a config write invalidates; `tenantId` scopes it when the cache supports that. */
export interface ConfigCacheClear {
  label: string;
  clear: (tenantId?: string) => Promise<void>;
}

/** What one reload reached; failures are logged and reported, never thrown. */
export interface ConfigReloadReport {
  /** Whether every clear on this instance succeeded. */
  cleared: boolean;
  /** Loading the config again on this instance after the clear; absent without a `load` step. */
  loaded?: ConfigLoadResult;
  /**
   * `sent` once published to the other instances, `failed` when publishing failed, `none`
   * without a pub/sub (no other instance is told), `skipped` when the load here failed, so the
   * others were not told either. An instance that misses the broadcast keeps its cached
   * librechat.yaml, which never expires, until it receives a later one or restarts.
   */
  broadcast: 'sent' | 'failed' | 'none' | 'skipped';
}

export interface ConfigCacheInvalidation {
  /**
   * Clears this instance's config caches and tells every other instance to do the same.
   * Resolves once the local clears settle; failures are logged, never thrown, because the
   * write that triggered them has already committed.
   */
  invalidate(tenantId?: string): Promise<void>;
  /**
   * The same clear, then the `load` step, then the broadcast, resolving with what each reached,
   * for a reload no write triggered: its caller answers for the outcome, so it must learn of a
   * failed clear, load or broadcast instead of only having it logged. A reload whose load fails
   * here is not broadcast, so the other instances keep serving what they have.
   */
  reload(tenantId?: string): Promise<ConfigReloadReport>;
  /** Stops listening for other instances' invalidations. */
  close(): Promise<void>;
}

interface InvalidationMessage {
  origin: string;
  tenantId?: string;
}

function parseMessage(message: string): InvalidationMessage | null {
  try {
    const parsed: unknown = JSON.parse(message);
    if (parsed == null || typeof parsed !== 'object') {
      return null;
    }
    const { origin, tenantId } = parsed as Record<string, unknown>;
    if (typeof origin !== 'string' || (tenantId !== undefined && typeof tenantId !== 'string')) {
      return null;
    }
    return tenantId === undefined ? { origin } : { origin, tenantId };
  } catch {
    return null;
  }
}

/**
 * Admin config cache invalidation for one instance, and across instances when a pub/sub pair
 * is supplied. The merged-config cache is per process, so without the pub/sub another instance
 * keeps serving a pre-write merge until its TTL expires.
 */
export function createConfigCacheInvalidation(params: {
  clears: readonly ConfigCacheClear[];
  /** Loads the cleared config again on this instance, for `reload` only; never rejects. */
  load?: () => Promise<ConfigLoadResult>;
  pubsub?: ConfigInvalidationPubSub;
  /** Identifies this instance, so it ignores its own broadcasts. */
  instanceId?: string;
}): ConfigCacheInvalidation {
  const { clears, load, pubsub } = params;
  const instanceId = params.instanceId ?? randomUUID();
  const channel = pubsub?.channel ?? CONFIG_INVALIDATION_CHANNEL;

  /** Runs every clear; resolves whether all of them succeeded, logging each that failed. */
  async function clearLocal(tenantId?: string): Promise<boolean> {
    const results = await Promise.allSettled(clears.map(({ clear }) => clear(tenantId)));
    return results.reduce((cleared, result, index) => {
      if (result.status === 'fulfilled') {
        return cleared;
      }
      logger.error(
        `[invalidateConfigCaches] ${clears[index].label} failed:`,
        getSafeErrorMetadata(result.reason),
      );
      return false;
    }, true);
  }

  const onMessage = (received: string, message: string): void => {
    if (received !== channel) {
      return;
    }
    const parsed = parseMessage(message);
    if (!parsed || parsed.origin === instanceId) {
      return;
    }
    void clearLocal(parsed.tenantId);
  };

  let subscribed = false;
  let subscribing = false;
  let closed = false;

  /**
   * Subscribes until one SUBSCRIBE succeeds; from then on the client resubscribes by itself
   * after a reconnect. A SUBSCRIBE that fails (Redis unreachable at startup, the client's
   * retries spent) is sent again the next time the subscriber becomes ready, so a transient
   * outage does not leave this instance deaf to other instances' writes until it restarts.
   */
  const subscribe = (): void => {
    if (!pubsub || subscribed || subscribing || closed) {
      return;
    }
    subscribing = true;
    pubsub.subscriber.subscribe(channel).then(
      () => {
        subscribing = false;
        subscribed = true;
      },
      (error: unknown) => {
        subscribing = false;
        logger.error(
          '[invalidateConfigCaches] Subscribing to cross-instance invalidations failed; retrying when the subscriber reconnects. Until then this instance may serve cached config until it expires:',
          getSafeErrorMetadata(error),
        );
      },
    );
  };

  if (pubsub) {
    pubsub.subscriber.on('message', onMessage);
    pubsub.subscriber.on('ready', subscribe);
    subscribe();
  }

  async function broadcast(tenantId?: string): Promise<ConfigReloadReport['broadcast']> {
    if (!pubsub) {
      return 'none';
    }
    const message: InvalidationMessage = tenantId
      ? { origin: instanceId, tenantId }
      : { origin: instanceId };
    try {
      await pubsub.publisher.publish(channel, JSON.stringify(message));
      return 'sent';
    } catch (error) {
      logger.error(
        '[invalidateConfigCaches] Publishing to other instances failed; they keep their cached librechat.yaml and serve cached merged configs until those expire:',
        getSafeErrorMetadata(error),
      );
      return 'failed';
    }
  }

  async function reload(tenantId?: string): Promise<ConfigReloadReport> {
    const cleared = await clearLocal(tenantId);
    if (!load) {
      return { cleared, broadcast: await broadcast(tenantId) };
    }
    const loaded = await load();
    if (!loaded.ok) {
      return { cleared, loaded, broadcast: 'skipped' };
    }
    return { cleared, loaded, broadcast: await broadcast(tenantId) };
  }

  async function invalidate(tenantId?: string): Promise<void> {
    await clearLocal(tenantId);
    await broadcast(tenantId);
  }

  async function close(): Promise<void> {
    if (!pubsub) {
      return;
    }
    closed = true;
    pubsub.subscriber.off('ready', subscribe);
    pubsub.subscriber.off('message', onMessage);
    await pubsub.subscriber.unsubscribe(channel);
  }

  return { invalidate, reload, close };
}

/**
 * The Redis connections cross-instance invalidation needs, or `undefined` when Redis is off (each
 * instance then relies on its own clears and the override cache TTL). The subscriber is a
 * dedicated connection, as subscribe mode requires; the publisher is one without the offline
 * queue, so a write's awaited invalidation fails fast and is logged while Redis is unreachable
 * instead of holding the admin response until it reconnects. `namespace` (the deployment's
 * Redis key prefix) keeps deployments that share one Redis from clearing each other.
 */
export function createRedisConfigInvalidationPubSub(params: {
  useRedis: boolean;
  client: Redis | Cluster | null | undefined;
  namespace?: string;
}): ConfigInvalidationPubSub | undefined {
  const { useRedis, client, namespace } = params;
  if (!useRedis || client == null) {
    return undefined;
  }
  const publisher = duplicateIoRedisClient(client, { enableOfflineQueue: false });
  publisher.on('error', (error: Error) => {
    logger.error('[ConfigInvalidation] publisher error:', getSafeErrorMetadata(error));
  });
  return {
    publisher,
    subscriber: createIoRedisSubscriber(client, '[ConfigInvalidation] subscriber'),
    channel: `${CONFIG_INVALIDATION_CHANNEL}:${namespace?.trim() || 'default'}`,
  };
}
