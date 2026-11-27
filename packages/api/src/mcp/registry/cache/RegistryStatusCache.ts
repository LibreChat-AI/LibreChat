import Keyv from 'keyv';
import { BaseRegistryCache } from './BaseRegistryCache';
import { standardCache } from '~/cache';

// Status keys
const INITIALIZED = 'INITIALIZED';
const INITIALIZED_CONFIG_HASH = 'INITIALIZED_CONFIG_HASH';

type StatusSetOptions = {
  skipLeaderCheck?: boolean;
};

/**
 * Cache for tracking MCP Servers Registry global metadata and status across distributed instances.
 * Uses Redis-backed storage to coordinate state between leader and follower nodes.
 * Tracks global initialization status for the registry.
 *
 * Designed to be extended with additional global registry metadata as needed
 * (e.g., last update timestamps, version info, health status).
 * This cache is only meant to be used internally by registry management components.
 */
class RegistryStatusCache extends BaseRegistryCache {
  protected readonly cache: Keyv = standardCache(`${this.PREFIX}::Status`);

  public async isInitialized(): Promise<boolean> {
    return (await this.get(INITIALIZED)) === true;
  }

  public async isInitializedFor(configHash: string): Promise<boolean> {
    if (!(await this.isInitialized())) {
      return false;
    }
    return (await this.getInitializedConfigHash()) === configHash;
  }

  public async getInitializedConfigHash(): Promise<string | undefined> {
    return this.get<string>(INITIALIZED_CONFIG_HASH);
  }

  public async setInitialized(
    value: boolean,
    configHash?: string,
    options?: StatusSetOptions,
  ): Promise<void> {
    if (configHash != null) {
      await this.set(INITIALIZED_CONFIG_HASH, configHash, undefined, options);
    }
    await this.set(INITIALIZED, value, undefined, options);
  }

  private async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.cache.get(key);
  }

  private async set(
    key: string,
    value: string | number | boolean,
    ttl?: number,
    options?: StatusSetOptions,
  ): Promise<void> {
    if (!options?.skipLeaderCheck) {
      await this.leaderCheck('set MCP Servers Registry status');
    }
    const success = await this.cache.set(key, value, ttl);
    this.successCheck(`set status key "${key}"`, success);
  }
}

export const registryStatusCache: RegistryStatusCache = new RegistryStatusCache();
