import { fromPairs } from 'lodash';
import { logger } from '@librechat/data-schemas';
import type Keyv from 'keyv';
import type { IServerConfigsRepositoryInterface } from '~/mcp/registry/ServerConfigsRepositoryInterface';
import type { ParsedServerConfig, AddServerResult } from '~/mcp/types';
import {
  cacheConfig,
  evalKeyvRedisScript,
  keyvRedisClient,
  observeRedisOperation,
  RedisUseCases,
  standardCache,
} from '~/cache';
import { PRESERVE_EMPTY_ARRAYS_LUA } from './preserveEmptyArraysLua';
import { BaseRegistryCache } from './BaseRegistryCache';

/**
 * Redis-backed implementation of MCP server configurations cache for distributed deployments.
 * Stores server configs in Redis with namespace isolation.
 * Enables data sharing across multiple server instances in a cluster environment.
 * Supports optional leader-only write operations to prevent race conditions during initialization.
 * Data persists across server restarts and is accessible from any instance in the cluster.
 */
const BATCH_SIZE = 100;

const PATCH_ENTRY = `
${PRESERVE_EMPTY_ARRAYS_LUA}
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local sentinel = emptyArraySentinel(encoded, ARGV[1])
local envelope = cjson.decode(protectEmptyArrays(encoded, sentinel))
if not envelope.value then return 0 end
local fields = cjson.decode(protectEmptyArrays(ARGV[1], sentinel))
if ARGV[2] ~= '' and tonumber(ARGV[2]) ~= envelope.value.updatedAt then return 0 end
if fields.resolvedInstructions and envelope.value.resolvedInstructions then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
for field, value in pairs(fields) do envelope.value[field] = value end
redis.call('SET', KEYS[1], restoreEmptyArrays(cjson.encode(envelope), sentinel))
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

export class ServerConfigsCacheRedis
  extends BaseRegistryCache
  implements IServerConfigsRepositoryInterface
{
  protected readonly cache: Keyv;
  private readonly namespace: string;

  constructor(namespace: string, leaderOnly: boolean) {
    super(leaderOnly);
    this.namespace = namespace;
    this.cache = standardCache(`${this.PREFIX}::Servers::${namespace}`);
  }

  private usesRedisStore(): boolean {
    const namespace = this.cache.namespace;
    return (
      keyvRedisClient != null &&
      namespace != null &&
      !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(namespace)
    );
  }

  private redisKey(serverName: string): string {
    const prefix = cacheConfig.REDIS_KEY_PREFIX
      ? `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}`
      : '';
    return `${prefix}${this.cache.namespace}:${serverName}`;
  }

  public async add(serverName: string, config: ParsedServerConfig): Promise<AddServerResult> {
    if (this.leaderOnly) await this.leaderCheck(`add ${this.namespace} MCP servers`);
    const exists = await this.cache.has(serverName);
    if (exists)
      throw new Error(
        `Server "${serverName}" already exists in cache. Use update() to modify existing configs.`,
      );
    const storedConfig = { ...config, updatedAt: Date.now() };
    const success = await this.cache.set(serverName, storedConfig);
    this.successCheck(`add ${this.namespace} server "${serverName}"`, success);
    return { serverName, config: storedConfig };
  }

  public async update(serverName: string, config: ParsedServerConfig): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck(`update ${this.namespace} MCP servers`);
    const exists = await this.cache.has(serverName);
    if (!exists)
      throw new Error(
        `Server "${serverName}" does not exist in cache. Use add() to create new configs.`,
      );
    const success = await this.cache.set(serverName, { ...config, updatedAt: Date.now() });
    this.successCheck(`update ${this.namespace} server "${serverName}"`, success);
  }

  public async upsert(serverName: string, config: ParsedServerConfig): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck(`upsert ${this.namespace} MCP servers`);
    const success = await this.cache.set(serverName, { ...config, updatedAt: Date.now() });
    this.successCheck(`upsert ${this.namespace} server "${serverName}"`, success);
  }

  /** Merges derived fields into an existing entry without bumping `updatedAt` —
   * see the interface doc: a bump would mark live connections stale. */
  public async patch(
    serverName: string,
    fields: Partial<ParsedServerConfig>,
    expectedUpdatedAt?: number,
  ): Promise<boolean> {
    if (this.leaderOnly) await this.leaderCheck(`patch ${this.namespace} MCP servers`);
    if (this.usesRedisStore()) {
      const result = await evalKeyvRedisScript(PATCH_ENTRY, {
        keys: [this.redisKey(serverName)],
        arguments: [
          JSON.stringify(fields),
          expectedUpdatedAt != null ? String(expectedUpdatedAt) : '',
        ],
      });
      return result === 1;
    }
    const existing = (await this.cache.get(serverName)) as ParsedServerConfig | undefined;
    if (!existing) {
      return false;
    }
    if (expectedUpdatedAt != null && existing.updatedAt !== expectedUpdatedAt) {
      return false;
    }
    if (fields.resolvedInstructions != null && existing.resolvedInstructions != null) {
      return false;
    }
    const success = await this.cache.set(serverName, { ...existing, ...fields });
    this.successCheck(`patch ${this.namespace} server "${serverName}"`, success);
    return true;
  }

  public async remove(serverName: string): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck(`remove ${this.namespace} MCP servers`);
    const success = await this.cache.delete(serverName);
    this.successCheck(`remove ${this.namespace} server "${serverName}"`, success);
  }

  public async get(serverName: string): Promise<ParsedServerConfig | undefined> {
    return this.cache.get(serverName);
  }

  public async getAll(): Promise<Record<string, ParsedServerConfig>> {
    const redisClient = keyvRedisClient;
    if (!redisClient || !('scanIterator' in redisClient)) {
      throw new Error('Redis client with scanIterator not available.');
    }

    const startTime = Date.now();
    const pattern = `*${this.cache.namespace}:*`;

    const keys = await observeRedisOperation(
      'keyv',
      RedisUseCases.MCP_REGISTRY,
      'scan',
      async () => {
        const scannedKeys: string[] = [];
        for await (const page of redisClient.scanIterator({ MATCH: pattern })) {
          scannedKeys.push(...page);
        }
        return scannedKeys;
      },
    );

    if (keys.length === 0) {
      logger.debug(`[ServerConfigsCacheRedis] getAll(${this.namespace}): no keys found`);
      return {};
    }

    /** Extract keyName from full Redis key format: "prefix::namespace:keyName" */
    const keyNames = keys.map((key) => key.substring(key.lastIndexOf(':') + 1));

    const entries: Array<[string, ParsedServerConfig]> = [];

    for (let i = 0; i < keyNames.length; i += BATCH_SIZE) {
      const batchEnd = Math.min(i + BATCH_SIZE, keyNames.length);
      const promises: Promise<ParsedServerConfig | undefined>[] = [];

      for (let j = i; j < batchEnd; j++) {
        promises.push(this.cache.get(keyNames[j]));
      }

      const configs = await Promise.all(promises);

      for (let j = 0; j < configs.length; j++) {
        if (configs[j]) {
          entries.push([keyNames[i + j], configs[j]!]);
        }
      }
    }

    const elapsed = Date.now() - startTime;
    logger.debug(
      `[ServerConfigsCacheRedis] getAll(${this.namespace}): fetched ${entries.length} configs in ${elapsed}ms`,
    );

    return fromPairs(entries);
  }
}
