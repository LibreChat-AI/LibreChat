import { ServerConfigsCacheRedisAggregateKey } from './ServerConfigsCacheRedisAggregateKey';
import { ServerConfigsCacheInMemory } from './ServerConfigsCacheInMemory';
import { cacheConfig } from '~/cache';

export type ServerConfigsCache = ServerConfigsCacheInMemory | ServerConfigsCacheRedisAggregateKey;

/**
 * Namespace for YAML-loaded app-level MCP configs. When Redis is enabled, uses a single
 * aggregate key instead of per-server keys to avoid the costly SCAN + batch-GET pattern
 * that caused 60s+ stalls under concurrent load (see GitHub #11624, #12408). When Redis is
 * disabled, uses in-memory storage.
 */
export const APP_CACHE_NAMESPACE = 'App' as const;

/** Namespace for admin-defined config-override MCP server inspection results. */
export const CONFIG_CACHE_NAMESPACE = 'Config' as const;

/**
 * Factory for creating the appropriate ServerConfigsCache implementation based on
 * deployment mode.
 *
 * When Redis is enabled, all configs of a namespace are stored under a single key via
 * {@link ServerConfigsCacheRedisAggregateKey}, so `getAll()` is one GET instead of
 * SCAN + N GETs. Cross-instance visibility is preserved: reinspection results
 * propagate through Redis automatically.
 */
export class ServerConfigsCacheFactory {
  /**
   * Create a ServerConfigsCache instance.
   *
   * @param namespace - The namespace for the cache (aggregate-key Redis storage, or
   *   in-memory when Redis is disabled).
   * @param leaderOnly - Whether write operations should only be performed by the leader.
   * @returns ServerConfigsCache instance
   */
  static create(namespace: string, leaderOnly: boolean): ServerConfigsCache {
    if (!cacheConfig.USE_REDIS) {
      return new ServerConfigsCacheInMemory();
    }

    return new ServerConfigsCacheRedisAggregateKey(namespace, leaderOnly);
  }
}
