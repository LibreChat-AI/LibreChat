import type Keyv from 'keyv';
import type { IServerConfigsRepositoryInterface } from '~/mcp/registry/ServerConfigsRepositoryInterface';
import type { ParsedServerConfig, AddServerResult } from '~/mcp/types';
import { cacheConfig, evalKeyvRedisScript, keyvRedisClient, standardCache } from '~/cache';
import { PRESERVE_EMPTY_ARRAYS_LUA } from './preserveEmptyArraysLua';
import { BaseRegistryCache } from './BaseRegistryCache';

/**
 * Redis-backed MCP server configs cache that stores all entries under a single aggregate key.
 *
 * Unlike {@link ServerConfigsCacheRedis} which uses SCAN + batch-GET for `getAll()`, this
 * implementation stores the entire config map as a single JSON value in Redis. This makes
 * `getAll()` a single O(1) GET regardless of keyspace size, eliminating the 60s+ stalls
 * caused by SCAN under concurrent load in large deployments (see GitHub #11624, #12408).
 *
 * Trade-offs:
 * - In-memory writes use a serialized read-modify-write via a promise-based mutex.
 *   Redis writes use single-key Lua mutations, so replicas cannot overwrite one another.
 * - The entire config map is serialized/deserialized on every operation. With typical MCP
 *   deployments (~5-50 servers), the JSON payload is small (10-50KB).
 * - Cross-instance visibility is preserved: all instances read/write the same Redis key,
 *   so reinspection results propagate automatically after readThroughCache TTL expiry.
 *
 * All mutations use Redis-side Lua when Redis backs this cache. This keeps
 * simultaneous replicas from losing one another's changes and makes
 * `resolvedInstructions` first-write-wins.
 */
const AGGREGATE_KEY = '__all__';

const MUTATE_AGGREGATE_ENTRY = `
${PRESERVE_EMPTY_ARRAYS_LUA}
local operation = ARGV[1]
local serverName = ARGV[2]
local encoded = redis.call('GET', KEYS[1])
local sentinel = emptyArraySentinel(encoded, ARGV[3])
local envelope
if encoded then
  envelope = cjson.decode(protectEmptyArrays(encoded, sentinel))
else
  envelope = { value = {} }
end
if not envelope.value then envelope.value = {} end
local existing = envelope.value[serverName]
if operation == 'add' and existing then return -1 end
if (operation == 'update' or operation == 'remove') and not existing then return 0 end
if operation == 'replaceStub' then
  if not existing or existing.inspectionFailed ~= true then return 0 end
  if ARGV[5] == '' and existing.updatedAt ~= nil then return 0 end
  if ARGV[5] ~= '' and tonumber(ARGV[5]) ~= existing.updatedAt then return 0 end
end
local ttl = redis.call('PTTL', KEYS[1])
if operation == 'remove' then
  envelope.value[serverName] = nil
else
  local config = cjson.decode(protectEmptyArrays(ARGV[3], sentinel))
  config.updatedAt = tonumber(ARGV[4])
  envelope.value[serverName] = config
end
redis.call('SET', KEYS[1], restoreEmptyArrays(cjson.encode(envelope), sentinel))
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

/** Keyv stores its serialized value in an envelope with a `value` member. This script
 * updates that envelope atomically and preserves a configured Redis expiration. */
const PATCH_AGGREGATE_ENTRY = `
${PRESERVE_EMPTY_ARRAYS_LUA}
local encoded = redis.call('GET', KEYS[1])
if not encoded then return 0 end
local sentinel = emptyArraySentinel(encoded, ARGV[2])
local envelope = cjson.decode(protectEmptyArrays(encoded, sentinel))
if not envelope.value then return 0 end
local entry = envelope.value[ARGV[1]]
if not entry then return 0 end
local fields = cjson.decode(protectEmptyArrays(ARGV[2], sentinel))
if ARGV[3] ~= '' and tonumber(ARGV[3]) ~= entry.updatedAt then return 0 end
if fields.resolvedInstructions and entry.resolvedInstructions then return 0 end
local ttl = redis.call('PTTL', KEYS[1])
for field, value in pairs(fields) do entry[field] = value end
redis.call('SET', KEYS[1], restoreEmptyArrays(cjson.encode(envelope), sentinel))
if ttl > 0 then redis.call('PEXPIRE', KEYS[1], ttl) end
return 1
`;

export class ServerConfigsCacheRedisAggregateKey
  extends BaseRegistryCache
  implements IServerConfigsRepositoryInterface
{
  protected readonly cache: Keyv;
  private writeLock: Promise<void> = Promise.resolve();

  /**
   * In-memory snapshot of the aggregate key to avoid redundant Redis GETs.
   * `getAll()` is called 20+ times per chat request (once per tool, per server
   * config lookup, per connection check) but the data doesn't change within a
   * request cycle. The snapshot collapses all reads within the TTL window into
   * a single Redis GET. Invalidated on every write (`add`, `update`, `remove`, `reset`).
   *
   * NOTE: In multi-instance deployments, the effective max staleness for cross-instance
   * writes is up to 2×MCP_REGISTRY_CACHE_TTL. This happens when readThroughCacheAll
   * (MCPServersRegistry) is populated from a snapshot that is nearly expired. For the
   * default 5000ms TTL, worst-case cross-instance propagation is ~10s. This is acceptable
   * given the single-writer invariant (leader-only initialization, rare manual reinspection).
   */
  private localSnapshot: Record<string, ParsedServerConfig> | null = null;
  /** Milliseconds since epoch. 0 = epoch = always expired on first check. */
  private localSnapshotExpiry = 0;

  private readonly namespace: string;

  constructor(namespace: string, leaderOnly: boolean) {
    super(leaderOnly);
    this.namespace = namespace;
    this.cache = standardCache(`${this.PREFIX}::Servers::${namespace}`);
  }

  private invalidateLocalSnapshot(): void {
    this.localSnapshot = null;
    this.localSnapshotExpiry = 0;
  }

  private usesRedisStore(): boolean {
    const namespace = this.cache.namespace;
    return (
      keyvRedisClient != null &&
      namespace != null &&
      !cacheConfig.FORCED_IN_MEMORY_CACHE_NAMESPACES?.includes(namespace)
    );
  }

  private aggregateRedisKey(): string {
    const prefix = cacheConfig.REDIS_KEY_PREFIX
      ? `${cacheConfig.REDIS_KEY_PREFIX}${cacheConfig.GLOBAL_PREFIX_SEPARATOR}`
      : '';
    return `${prefix}${this.cache.namespace}:${AGGREGATE_KEY}`;
  }

  private async mutateRedisEntry(
    operation: 'add' | 'update' | 'upsert' | 'remove' | 'replaceStub',
    serverName: string,
    config?: ParsedServerConfig,
    updatedAt?: number,
    stubUpdatedAt?: number,
  ): Promise<number> {
    const result = await evalKeyvRedisScript(MUTATE_AGGREGATE_ENTRY, {
      keys: [this.aggregateRedisKey()],
      arguments: [
        operation,
        serverName,
        config ? JSON.stringify(config) : '',
        updatedAt != null ? String(updatedAt) : '',
        stubUpdatedAt != null ? String(stubUpdatedAt) : '',
      ],
    });
    return typeof result === 'number' ? result : 0;
  }

  /**
   * Serializes write operations to prevent concurrent read-modify-write races.
   * Reads (`get`, `getAll`) are not serialized — they can run concurrently.
   * Always invalidates the local snapshot in `finally` to guarantee cleanup
   * even when the write callback throws (e.g., Redis SET failure).
   */
  private async withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
    const previousLock = this.writeLock;
    let resolve!: () => void;
    this.writeLock = new Promise<void>((r) => {
      resolve = r;
    });
    try {
      await previousLock;
      return await fn();
    } finally {
      this.invalidateLocalSnapshot();
      resolve();
    }
  }

  public async getAll(): Promise<Record<string, ParsedServerConfig>> {
    const ttl = cacheConfig.MCP_REGISTRY_CACHE_TTL;
    if (ttl > 0) {
      const now = Date.now();
      if (this.localSnapshot !== null && now < this.localSnapshotExpiry) {
        return this.localSnapshot;
      }
    }

    const result =
      ((await this.cache.get(AGGREGATE_KEY)) as Record<string, ParsedServerConfig> | undefined) ??
      {};

    if (ttl > 0) {
      this.localSnapshot = result;
      this.localSnapshotExpiry = Date.now() + ttl;
    }
    return result;
  }

  public async get(serverName: string): Promise<ParsedServerConfig | undefined> {
    const all = await this.getAll();
    return all[serverName];
  }

  /** Reads past the local snapshot, which can lag another replica's write by up to its TTL. */
  public async getCurrent(serverName: string): Promise<ParsedServerConfig | undefined> {
    this.invalidateLocalSnapshot();
    const all = await this.getAll();
    return all[serverName];
  }

  public async add(serverName: string, config: ParsedServerConfig): Promise<AddServerResult> {
    if (this.leaderOnly) await this.leaderCheck('add MCP servers');
    return this.withWriteLock(async () => {
      const storedConfig = { ...config, updatedAt: Date.now() };
      if (this.usesRedisStore()) {
        const result = await this.mutateRedisEntry(
          'add',
          serverName,
          storedConfig,
          storedConfig.updatedAt,
        );
        if (result === -1) {
          throw new Error(
            `Server "${serverName}" already exists in cache. Use update() to modify existing configs.`,
          );
        }
        this.successCheck(`add ${this.namespace} server "${serverName}"`, result === 1);
        return { serverName, config: storedConfig };
      }
      // Force fresh Redis read so the read-modify-write uses current data,
      // not a snapshot that may predate this write. Distinct from the finally-block
      // invalidation which cleans up after the write completes or throws.
      this.invalidateLocalSnapshot();
      const all = await this.getAll();
      if (all[serverName]) {
        throw new Error(
          `Server "${serverName}" already exists in cache. Use update() to modify existing configs.`,
        );
      }
      const newAll = { ...all, [serverName]: storedConfig };
      const success = await this.cache.set(AGGREGATE_KEY, newAll);
      this.successCheck(`add ${this.namespace} server "${serverName}"`, success);
      return { serverName, config: storedConfig };
    });
  }

  public async update(serverName: string, config: ParsedServerConfig): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck('update MCP servers');
    return this.withWriteLock(async () => {
      const updatedAt = Date.now();
      if (this.usesRedisStore()) {
        const result = await this.mutateRedisEntry('update', serverName, config, updatedAt);
        if (result === 0) {
          throw new Error(
            `Server "${serverName}" does not exist in cache. Use add() to create new configs.`,
          );
        }
        this.successCheck(`update ${this.namespace} server "${serverName}"`, result === 1);
        return;
      }
      this.invalidateLocalSnapshot(); // Force fresh Redis read (see add() comment)
      const all = await this.getAll();
      if (!all[serverName]) {
        throw new Error(
          `Server "${serverName}" does not exist in cache. Use add() to create new configs.`,
        );
      }
      const newAll = { ...all, [serverName]: { ...config, updatedAt } };
      const success = await this.cache.set(AGGREGATE_KEY, newAll);
      this.successCheck(`update ${this.namespace} server "${serverName}"`, success);
    });
  }

  public async upsert(serverName: string, config: ParsedServerConfig): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck('upsert MCP servers');
    return this.withWriteLock(async () => {
      const updatedAt = Date.now();
      if (this.usesRedisStore()) {
        const result = await this.mutateRedisEntry('upsert', serverName, config, updatedAt);
        this.successCheck(`upsert ${this.namespace} server "${serverName}"`, result === 1);
        return;
      }
      this.invalidateLocalSnapshot();
      const all = await this.getAll();
      const newAll = { ...all, [serverName]: { ...config, updatedAt } };
      const success = await this.cache.set(AGGREGATE_KEY, newAll);
      this.successCheck(`upsert ${this.namespace} server "${serverName}"`, success);
    });
  }

  /** Merges derived fields into an existing entry without bumping `updatedAt` —
   * see the interface doc: a bump would mark live connections stale. */
  public async patch(
    serverName: string,
    fields: Partial<ParsedServerConfig>,
    expectedUpdatedAt?: number,
  ): Promise<boolean> {
    if (this.leaderOnly) await this.leaderCheck('patch MCP servers');
    return this.withWriteLock(async () => {
      if (this.usesRedisStore()) {
        const result = await evalKeyvRedisScript(PATCH_AGGREGATE_ENTRY, {
          keys: [this.aggregateRedisKey()],
          arguments: [
            serverName,
            JSON.stringify(fields),
            expectedUpdatedAt != null ? String(expectedUpdatedAt) : '',
          ],
        });
        return result === 1;
      }
      this.invalidateLocalSnapshot(); // Force fresh Redis read (see add() comment)
      const all = await this.getAll();
      const existing = all[serverName];
      if (!existing) {
        return false;
      }
      if (expectedUpdatedAt != null && existing.updatedAt !== expectedUpdatedAt) {
        return false;
      }
      if (fields.resolvedInstructions != null && existing.resolvedInstructions != null) {
        return false;
      }
      const newAll = { ...all, [serverName]: { ...existing, ...fields } };
      const success = await this.cache.set(AGGREGATE_KEY, newAll);
      this.successCheck(`patch ${this.namespace} server "${serverName}"`, success);
      return true;
    });
  }

  /** Replaces a failed-inspection stub only while it is still that stub — see the interface doc.
   * The Redis-side check and write are one script, so replicas racing the same recovery cannot
   * both land. */
  public async replaceStub(
    serverName: string,
    config: ParsedServerConfig,
    stubUpdatedAt: number | undefined,
  ): Promise<ParsedServerConfig | undefined> {
    if (this.leaderOnly) await this.leaderCheck('replace MCP server stubs');
    return this.withWriteLock(async () => {
      const storedConfig = { ...config, updatedAt: Date.now() };
      if (this.usesRedisStore()) {
        const result = await this.mutateRedisEntry(
          'replaceStub',
          serverName,
          storedConfig,
          storedConfig.updatedAt,
          stubUpdatedAt,
        );
        return result === 1 ? storedConfig : undefined;
      }
      this.invalidateLocalSnapshot(); // Force fresh Redis read (see add() comment)
      const all = await this.getAll();
      const existing = all[serverName];
      if (existing?.inspectionFailed !== true || existing.updatedAt !== stubUpdatedAt) {
        return undefined;
      }
      const success = await this.cache.set(AGGREGATE_KEY, { ...all, [serverName]: storedConfig });
      this.successCheck(`replace ${this.namespace} server stub "${serverName}"`, success);
      return storedConfig;
    });
  }

  public async remove(serverName: string): Promise<void> {
    if (this.leaderOnly) await this.leaderCheck('remove MCP servers');
    return this.withWriteLock(async () => {
      if (this.usesRedisStore()) {
        const result = await this.mutateRedisEntry('remove', serverName);
        if (result === 0) {
          throw new Error(`Failed to remove server "${serverName}" in cache.`);
        }
        this.successCheck(`remove ${this.namespace} server "${serverName}"`, result === 1);
        return;
      }
      this.invalidateLocalSnapshot(); // Force fresh Redis read (see add() comment)
      const all = await this.getAll();
      if (!all[serverName]) {
        throw new Error(`Failed to remove server "${serverName}" in cache.`);
      }
      const { [serverName]: _, ...newAll } = all;
      const success = await this.cache.set(AGGREGATE_KEY, newAll);
      this.successCheck(`remove ${this.namespace} server "${serverName}"`, success);
    });
  }

  /**
   * Resets the aggregate key directly instead of using SCAN-based `cache.clear()`.
   * Only one key (`__all__`) ever exists in this namespace, so a targeted delete is
   * more efficient and consistent with the PR's goal of eliminating SCAN operations.
   *
   * NOTE: Intentionally not serialized via `withWriteLock`. `reset()` is only called
   * during lifecycle transitions (test teardown, full reinitialization via
   * `MCPServersInitializer`) where no concurrent writes are in flight.
   */
  public override async reset(): Promise<void> {
    if (this.leaderOnly) {
      await this.leaderCheck(`reset ${this.namespace} MCP servers cache`);
    }
    await this.cache.delete(AGGREGATE_KEY);
    this.invalidateLocalSnapshot();
  }
}
