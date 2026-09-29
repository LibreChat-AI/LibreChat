import { Keyv } from 'keyv';
import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { StoredDataNoRaw } from 'keyv';
import type { FlowState, FlowMetadata, FlowManagerOptions } from './types';
import { registerShutdownTask } from '../app/shutdown';
import { math } from '~/utils/math';

type GuardedMutationResult = 'updated' | 'stale' | 'missing';

export interface FlowLease {
  generation: number;
  release: () => Promise<void>;
}

/** The flow a waiter was monitoring disappeared before it settled. */
export class FlowStateNotFoundError extends Error {
  constructor(type: string) {
    super(`${type} Flow state not found`);
    this.name = 'FlowStateNotFoundError';
  }
}

interface InMemoryLeaseState {
  generation: number;
  owner?: string;
  purpose?: 'operation' | 'teardown';
  leaseUntil?: number;
  expiresAt?: number;
}

interface KeyvRedisStore {
  constructor: { name: string };
  namespace?: string;
  createKeyPrefix(key: string, namespace?: string): string;
  client?: {
    eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
  };
}

const GUARDED_DELETE_FLOW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
local flow = data.value
if flow.createdAt ~= tonumber(ARGV[1]) then return -1 end
local state = flow.metadata and flow.metadata.state or ''
if state ~= ARGV[2] then return -1 end
redis.call('DEL', KEYS[1])
return 1
`;

const GUARDED_FAIL_FLOW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
local flow = data.value
if flow.createdAt ~= tonumber(ARGV[1]) then return -1 end
local state = flow.metadata and flow.metadata.state or ''
if state ~= ARGV[2] then return -1 end
if flow.status == 'COMPLETED' then return -1 end
flow.status = 'FAILED'
flow.error = ARGV[3]
flow.errorName = ARGV[6]
flow.failedAt = tonumber(ARGV[4])
data.expires = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ARGV[5])
return 1
`;

const GUARDED_COMPLETE_FLOW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
local flow = data.value
if flow.createdAt ~= tonumber(ARGV[1]) then return -1 end
local state = flow.metadata and flow.metadata.state or ''
if state ~= ARGV[2] then return -1 end
if flow.status ~= 'PENDING' then return -1 end
flow.status = 'COMPLETED'
flow.result = cjson.decode(ARGV[3])
flow.completedAt = tonumber(ARGV[4])
data.expires = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ARGV[5])
return 1
`;

/** Replaces either a pending or completed result for the exact observed attempt. This is used
 * when a fresher durable credential must win a race with the handler that loaded the old one. */
const GUARDED_SETTLE_FLOW = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
local flow = data.value
if flow.createdAt ~= tonumber(ARGV[1]) then return -1 end
local state = flow.metadata and flow.metadata.state or ''
if state ~= ARGV[2] then return -1 end
flow.status = 'COMPLETED'
flow.result = cjson.decode(ARGV[3])
flow.completedAt = tonumber(ARGV[4])
data.expires = tonumber(ARGV[4]) + tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ARGV[5])
return 1
`;

/** Installs a new attempt only while the key is absent or still holds the attempt the caller
 * observed and decided to replace, so concurrent replacements run a single handler. The status
 * is part of the match because a replacement created in the same millisecond as the failure it
 * replaces shares its `createdAt`. */
const CLAIM_FLOW = `
local raw = redis.call('GET', KEYS[1])
if raw then
  if ARGV[3] == '' then return 0 end
  local flow = cjson.decode(raw).value
  if flow.createdAt ~= tonumber(ARGV[3]) then return 0 end
  local state = flow.metadata and flow.metadata.state or ''
  if state ~= ARGV[4] then return 0 end
  if flow.status ~= ARGV[5] then return 0 end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return 1
`;

const READ_LEASE_GENERATION = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
if data.owner and data.purpose ~= 'operation' and data.leaseUntil and data.leaseUntil > tonumber(ARGV[1]) then return -1 end
return data.generation or 0
`;

const ACQUIRE_LEASE = `
local raw = redis.call('GET', KEYS[1])
local data = raw and cjson.decode(raw) or { generation = 0 }
local now = tonumber(ARGV[2])
if data.owner and data.leaseUntil and data.leaseUntil > now then return -2 end
local expected = tonumber(ARGV[3])
if expected >= 0 and data.generation ~= expected then return -1 end
if ARGV[4] == '1' then data.generation = data.generation + 1 end
data.owner = ARGV[1]
data.purpose = ARGV[7]
data.leaseUntil = now + tonumber(ARGV[5])
redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ARGV[6])
return data.generation
`;

const RELEASE_LEASE = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local data = cjson.decode(raw)
if data.owner ~= ARGV[1] then return -1 end
data.owner = nil
data.purpose = nil
data.leaseUntil = nil
redis.call('SET', KEYS[1], cjson.encode(data), 'PX', ARGV[2])
return 1
`;

/**
 * Lifetime of a PENDING OAuth flow: how long the auth button stays valid and an
 * in-flight flow can be reused before it is replaced. Mirrors
 * `mcpConfig.OAUTH_HANDLING_TIMEOUT` (`MCP_OAUTH_HANDLING_TIMEOUT`) so the reuse
 * window matches the wait the server grants the user. Default: 10 minutes.
 */
export const PENDING_STALE_MS: number = math(
  process.env.MCP_OAUTH_HANDLING_TIMEOUT ?? 10 * 60 * 1000,
);

const SECONDS_THRESHOLD = 1e10;

/**
 * Normalizes an expiration timestamp to milliseconds.
 * Timestamps below 10 billion are assumed to be in seconds (valid until ~2286).
 */
export function normalizeExpiresAt(timestamp: number): number {
  return timestamp < SECONDS_THRESHOLD ? timestamp * 1000 : timestamp;
}

export class FlowStateManager<T = unknown> {
  private static readonly inMemoryLeases = new Map<string, InMemoryLeaseState>();

  private static evictExpiredInMemoryLeases(now: number): void {
    for (const [key, lease] of this.inMemoryLeases) {
      if (lease.expiresAt != null && lease.expiresAt <= now) {
        this.inMemoryLeases.delete(key);
      }
    }
  }

  private keyv: Keyv;
  private ttl: number;
  private monitorTimeout: number;
  private retainedFailureTypes: Set<string>;
  private intervals: Set<NodeJS.Timeout>;
  private redisScriptExecutor?: FlowManagerOptions['redisScriptExecutor'];

  constructor(store: Keyv, options?: FlowManagerOptions) {
    if (!options) {
      options = { ttl: 60000 * 3 };
    }
    const {
      ci = false,
      ttl,
      monitorTimeout = ttl,
      retainedFailureTypes = [],
      redisScriptExecutor,
    } = options;

    if (!ci && !(store instanceof Keyv)) {
      throw new Error('Invalid store provided to FlowStateManager');
    }

    this.ttl = ttl;
    this.monitorTimeout = monitorTimeout;
    this.retainedFailureTypes = new Set(retainedFailureTypes);
    this.redisScriptExecutor = redisScriptExecutor;
    this.keyv = store;
    this.intervals = new Set();

    if (!ci) {
      this.setupCleanupHandlers();
    }
  }

  private setupCleanupHandlers() {
    // Register cleanup with the centralized graceful-shutdown coordinator
    // (see ../app/shutdown.ts) rather than attaching direct signal
    // handlers — multiple competing handlers race the HTTP drain.
    registerShutdownTask('flow manager cleanup', () => {
      logger.info('Cleaning up FlowStateManager intervals...');
      this.intervals.forEach((interval) => clearInterval(interval));
      this.intervals.clear();
    });
  }

  /**
   * Flow keys are intentionally NOT tenant-scoped. OAuth callbacks arrive
   * without tenant ALS context (the provider redirect doesn't carry
   * X-Tenant-Id). Flow IDs are random UUIDs with no collision risk, and
   * flow data is ephemeral (TTL-bounded, no sensitive user content).
   */
  private getFlowKey(flowId: string, type: string): string {
    return `${type}:${flowId}`;
  }

  /** Reads the generation used to reject work that crossed a teardown boundary. */
  async getLeaseGeneration(leaseId: string): Promise<number | null> {
    const flowKey = this.getFlowKey(leaseId, 'lease');
    const inMemoryKey = this.keyv.namespace ? `${this.keyv.namespace}:${flowKey}` : flowKey;
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const result = Number(
        await this.evalRedisScript(READ_LEASE_GENERATION, redisKey, [String(Date.now())]),
      );
      return result < 0 ? null : result;
    }
    const now = Date.now();
    FlowStateManager.evictExpiredInMemoryLeases(now);
    const current = FlowStateManager.inMemoryLeases.get(inMemoryKey);
    if (current?.owner && current.purpose !== 'operation' && (current.leaseUntil ?? 0) > now) {
      return null;
    }
    return current?.generation ?? 0;
  }

  /**
   * Acquires a cross-replica lease. `expectedGeneration` rejects an operation that started
   * before teardown; `advanceGeneration` is the teardown linearization point.
   */
  async acquireLease(
    leaseId: string,
    options: {
      expectedGeneration?: number;
      advanceGeneration?: boolean;
      leaseMs?: number;
      waitMs?: number;
    } = {},
  ): Promise<FlowLease | null> {
    const flowKey = this.getFlowKey(leaseId, 'lease');
    const inMemoryKey = this.keyv.namespace ? `${this.keyv.namespace}:${flowKey}` : flowKey;
    const redisKey = this.getRedisKey(flowKey);
    const owner = randomUUID();
    const leaseMs = options.leaseMs ?? 15 * 60_000;
    const waitUntil = Date.now() + (options.waitMs ?? 15_000);
    const retentionMs = 24 * 60 * 60_000;
    while (true) {
      const now = Date.now();
      FlowStateManager.evictExpiredInMemoryLeases(now);
      let result: number;
      if (redisKey) {
        result = Number(
          await this.evalRedisScript(ACQUIRE_LEASE, redisKey, [
            owner,
            String(now),
            String(options.expectedGeneration ?? -1),
            options.advanceGeneration ? '1' : '0',
            String(leaseMs),
            String(retentionMs),
            options.advanceGeneration ? 'teardown' : 'operation',
          ]),
        );
      } else {
        const current = FlowStateManager.inMemoryLeases.get(inMemoryKey) ?? { generation: 0 };
        if (current.owner && (current.leaseUntil ?? 0) > now) {
          result = -2;
        } else if (
          options.expectedGeneration !== undefined &&
          current.generation !== options.expectedGeneration
        ) {
          result = -1;
        } else {
          result = current.generation + (options.advanceGeneration ? 1 : 0);
          FlowStateManager.inMemoryLeases.set(inMemoryKey, {
            generation: result,
            owner,
            purpose: options.advanceGeneration ? 'teardown' : 'operation',
            leaseUntil: now + leaseMs,
            expiresAt: now + retentionMs,
          });
        }
      }
      if (result === -1) return null;
      if (result >= 0) {
        return {
          generation: result,
          release: async () => {
            if (redisKey) {
              await this.evalRedisScript(RELEASE_LEASE, redisKey, [owner, String(retentionMs)]);
              return;
            }
            const current = FlowStateManager.inMemoryLeases.get(inMemoryKey);
            if (current?.owner === owner) {
              FlowStateManager.inMemoryLeases.set(inMemoryKey, {
                generation: current.generation,
                expiresAt: Date.now() + retentionMs,
              });
            }
          },
        };
      }
      if (Date.now() >= waitUntil) return null;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private getRedisKey(flowKey: string): string | null {
    const store = this.keyv.store as KeyvRedisStore;
    if (store?.constructor?.name !== 'KeyvRedis' || typeof store.createKeyPrefix !== 'function') {
      return null;
    }
    const key = this.keyv.namespace ? `${this.keyv.namespace}:${flowKey}` : flowKey;
    return store.createKeyPrefix(key, store.namespace);
  }

  private async evalRedisScript(script: string, key: string, args: string[]): Promise<unknown> {
    if (this.redisScriptExecutor) {
      return this.redisScriptExecutor(script, { keys: [key], arguments: args });
    }
    const store = this.keyv.store as KeyvRedisStore;
    if (typeof store.client?.eval !== 'function') {
      throw new Error('KeyvRedis store does not expose an atomic eval capability');
    }
    return store.client.eval(script, { keys: [key], arguments: args });
  }

  private static guardedResult(result: unknown): GuardedMutationResult {
    if (result === 1) {
      return 'updated';
    }
    return result === 0 ? 'missing' : 'stale';
  }

  private static isCurrentAttempt(
    flowState: FlowState | null | undefined,
    expectedCreatedAt: number,
    expectedState: string,
  ): boolean {
    return (
      flowState?.createdAt === expectedCreatedAt &&
      (typeof flowState.metadata?.state === 'string' ? flowState.metadata.state : '') ===
        expectedState
    );
  }

  private getInMemoryEntry(flowKey: string): {
    store: Map<string, string>;
    key: string;
    envelope: { value: FlowState<T>; expires?: number };
  } | null {
    if (!(this.keyv instanceof Keyv) || !(this.keyv.store instanceof Map)) {
      return null;
    }
    const key = this.keyv.namespace ? `${this.keyv.namespace}:${flowKey}` : flowKey;
    const raw = this.keyv.store.get(key);
    if (typeof raw !== 'string') {
      return null;
    }
    const envelope = JSON.parse(raw) as { value: FlowState<T>; expires?: number };
    if (envelope.expires != null && envelope.expires <= Date.now()) {
      this.keyv.store.delete(key);
      return null;
    }
    return {
      store: this.keyv.store as Map<string, string>,
      key,
      envelope,
    };
  }

  /** Deletes a flow only while it still represents the caller's observed attempt. */
  async deleteFlowIfCurrent(
    flowId: string,
    type: string,
    expectedCreatedAt: number,
    expectedState = '',
  ): Promise<GuardedMutationResult> {
    const flowKey = this.getFlowKey(flowId, type);
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const result = await this.evalRedisScript(GUARDED_DELETE_FLOW, redisKey, [
        String(expectedCreatedAt),
        expectedState,
      ]);
      return FlowStateManager.guardedResult(result);
    }

    const memoryEntry = this.getInMemoryEntry(flowKey);
    if (memoryEntry) {
      if (
        !FlowStateManager.isCurrentAttempt(
          memoryEntry.envelope.value,
          expectedCreatedAt,
          expectedState,
        )
      ) {
        return 'stale';
      }
      return memoryEntry.store.delete(memoryEntry.key) ? 'updated' : 'missing';
    }

    const current = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (!current) {
      return 'missing';
    }
    if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
      return 'stale';
    }
    return (await this.keyv.delete(flowKey)) ? 'updated' : 'missing';
  }

  /** Fails a flow only while it still represents the caller's observed attempt. */
  async failFlowIfCurrent(
    flowId: string,
    type: string,
    expectedCreatedAt: number,
    expectedState: string,
    error: Error | string,
  ): Promise<GuardedMutationResult> {
    const flowKey = this.getFlowKey(flowId, type);
    const message = error instanceof Error ? error.message : error;
    const errorName = error instanceof Error ? error.name : 'Error';
    const failedAt = Date.now();
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const result = await this.evalRedisScript(GUARDED_FAIL_FLOW, redisKey, [
        String(expectedCreatedAt),
        expectedState,
        message,
        String(failedAt),
        String(this.ttl),
        errorName,
      ]);
      return FlowStateManager.guardedResult(result);
    }

    const memoryEntry = this.getInMemoryEntry(flowKey);
    if (memoryEntry) {
      const current = memoryEntry.envelope.value;
      if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
        return 'stale';
      }
      if (current.status === 'COMPLETED') {
        return 'stale';
      }
      memoryEntry.envelope.value = {
        ...current,
        status: 'FAILED',
        error: message,
        errorName,
        failedAt,
      };
      memoryEntry.envelope.expires = failedAt + this.ttl;
      memoryEntry.store.set(memoryEntry.key, JSON.stringify(memoryEntry.envelope));
      return 'updated';
    }

    const current = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (!current) {
      return 'missing';
    }
    if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
      return 'stale';
    }
    if (current.status === 'COMPLETED') {
      return 'stale';
    }
    const updatedState: FlowState<T> = {
      ...current,
      status: 'FAILED',
      error: message,
      errorName,
      failedAt,
    };
    await this.keyv.set(flowKey, updatedState, this.ttl);
    return 'updated';
  }

  /** Completes a flow only while it still represents the caller's observed attempt. */
  async completeFlowIfCurrent(
    flowId: string,
    type: string,
    expectedCreatedAt: number,
    expectedState: string,
    result: T,
  ): Promise<GuardedMutationResult> {
    const flowKey = this.getFlowKey(flowId, type);
    const completedAt = Date.now();
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const guardedResult = await this.evalRedisScript(GUARDED_COMPLETE_FLOW, redisKey, [
        String(expectedCreatedAt),
        expectedState,
        JSON.stringify(result) ?? 'null',
        String(completedAt),
        String(this.ttl),
      ]);
      return FlowStateManager.guardedResult(guardedResult);
    }

    const memoryEntry = this.getInMemoryEntry(flowKey);
    if (memoryEntry) {
      const current = memoryEntry.envelope.value;
      if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
        return 'stale';
      }
      if (current.status !== 'PENDING') {
        return 'stale';
      }
      memoryEntry.envelope.value = { ...current, status: 'COMPLETED', result, completedAt };
      memoryEntry.envelope.expires = completedAt + this.ttl;
      memoryEntry.store.set(memoryEntry.key, JSON.stringify(memoryEntry.envelope));
      return 'updated';
    }

    const current = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (!current) {
      return 'missing';
    }
    if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
      return 'stale';
    }
    if (current.status !== 'PENDING') {
      return 'stale';
    }
    await this.keyv.set(
      flowKey,
      { ...current, status: 'COMPLETED', result, completedAt },
      this.ttl,
    );
    return 'updated';
  }

  /** Publishes an authoritative result for the exact observed attempt even if its handler settled
   * while the caller was committing a fresher durable value. A replacement attempt is untouched. */
  async settleFlowIfCurrent(
    flowId: string,
    type: string,
    expectedCreatedAt: number,
    expectedState: string,
    result: T,
  ): Promise<GuardedMutationResult> {
    const flowKey = this.getFlowKey(flowId, type);
    const completedAt = Date.now();
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const guardedResult = await this.evalRedisScript(GUARDED_SETTLE_FLOW, redisKey, [
        String(expectedCreatedAt),
        expectedState,
        JSON.stringify(result) ?? 'null',
        String(completedAt),
        String(this.ttl),
      ]);
      return FlowStateManager.guardedResult(guardedResult);
    }

    const settle = (current: FlowState<T>): FlowState<T> | null => {
      if (!FlowStateManager.isCurrentAttempt(current, expectedCreatedAt, expectedState)) {
        return null;
      }
      return { ...current, status: 'COMPLETED', result, completedAt };
    };
    const memoryEntry = this.getInMemoryEntry(flowKey);
    if (memoryEntry) {
      const updated = settle(memoryEntry.envelope.value);
      if (updated == null) {
        return 'stale';
      }
      memoryEntry.envelope.value = updated;
      memoryEntry.envelope.expires = completedAt + this.ttl;
      memoryEntry.store.set(memoryEntry.key, JSON.stringify(memoryEntry.envelope));
      return 'updated';
    }

    const current = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (!current) {
      return 'missing';
    }
    const updated = settle(current);
    if (updated == null) {
      return 'stale';
    }
    await this.keyv.set(flowKey, updated, this.ttl);
    return 'updated';
  }

  private isTokenExpired(flowState: FlowState<T> | undefined): boolean {
    if (!flowState?.result || typeof flowState.result !== 'object') {
      return false;
    }

    if (!('expires_at' in flowState.result)) {
      return false;
    }

    const expiresAt = (flowState.result as { expires_at: unknown }).expires_at;
    if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) {
      return false;
    }

    return normalizeExpiresAt(expiresAt) < Date.now();
  }

  /**
   * Stores initial PENDING flow state without starting the monitor loop.
   * Use this when you need to guarantee the state is persisted before
   * performing an action (e.g., an OAuth redirect), then call createFlow()
   * separately to start monitoring for completion.
   */
  async initFlow(flowId: string, type: string, metadata: FlowMetadata = {}): Promise<void> {
    const flowKey = this.getFlowKey(flowId, type);
    const initialState: FlowState = {
      type,
      status: 'PENDING',
      metadata,
      createdAt: Date.now(),
    };
    logger.debug(`[${flowKey}] Storing initial flow state`);
    await this.keyv.set(flowKey, initialState, this.ttl);
  }

  /**
   * Creates a new flow and waits for its completion
   */
  async createFlow(
    flowId: string,
    type: string,
    metadata: FlowMetadata = {},
    signal?: AbortSignal,
    createIfMissing = true,
  ): Promise<T> {
    const flowKey = this.getFlowKey(flowId, type);

    let existingState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (existingState) {
      logger.debug(`[${flowKey}] Flow already exists`);
      return this.monitorFlow(flowKey, type, signal);
    }

    await new Promise((resolve) => setTimeout(resolve, 250));

    existingState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    if (existingState) {
      logger.debug(`[${flowKey}] Flow exists on 2nd check`);
      return this.monitorFlow(flowKey, type, signal);
    }

    if (!createIfMissing) {
      throw new Error(`${type} flow not found`);
    }

    const initialState: FlowState = {
      type,
      status: 'PENDING',
      metadata,
      createdAt: Date.now(),
    };

    logger.debug(`[${flowKey}] Creating initial flow state`);
    await this.keyv.set(flowKey, initialState, this.ttl);
    return this.monitorFlow(flowKey, type, signal);
  }

  /**
   * Waits for the flow to settle. An owner that aborts takes its flow down with it; a joiner that
   * aborts leaves the flow to the attempt that owns it and to the other waiters.
   */
  private monitorFlow(
    flowKey: string,
    type: string,
    signal?: AbortSignal,
    ownsFlow = true,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const checkInterval = 2000;
      let isCleanedUp = false;
      let intervalId: NodeJS.Timeout | null = null;
      let missingStateRetried = false;
      let isRetrying = false;

      // Cleanup function to avoid duplicate cleanup
      const cleanup = () => {
        if (isCleanedUp) return;
        isCleanedUp = true;
        if (intervalId) {
          clearInterval(intervalId);
          this.intervals.delete(intervalId);
        }
        if (signal && abortHandler) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      // Immediate abort handler - responds instantly to abort signal
      const abortHandler = async () => {
        cleanup();
        logger.warn(`[${flowKey}] Flow aborted (immediate)`);
        const message = `${type} flow aborted`;
        if (ownsFlow) {
          try {
            await this.keyv.delete(flowKey);
          } catch {
            // Ignore delete errors during abort
          }
        }
        reject(new Error(message));
      };

      // Register abort handler immediately if signal provided
      if (signal) {
        if (signal.aborted) {
          // Already aborted, reject immediately
          cleanup();
          reject(new Error(`${type} flow aborted`));
          return;
        }
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      intervalId = setInterval(async () => {
        if (isCleanedUp || isRetrying) return;

        try {
          let flowState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;

          if (!flowState) {
            if (!missingStateRetried) {
              missingStateRetried = true;
              isRetrying = true;
              logger.warn(
                `[${flowKey}] Flow state not found, retrying once after 500ms (race recovery)`,
              );
              await new Promise((r) => setTimeout(r, 500));
              flowState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
              isRetrying = false;
            }

            if (!flowState) {
              cleanup();
              logger.error(`[${flowKey}] Flow state not found after retry`);
              reject(new FlowStateNotFoundError(type));
              return;
            }
          }

          if (signal?.aborted) {
            cleanup();
            logger.warn(`[${flowKey}] Flow aborted`);
            const message = `${type} flow aborted`;
            if (ownsFlow) {
              await this.keyv.delete(flowKey);
            }
            reject(new Error(message));
            return;
          }

          if (flowState.status !== 'PENDING') {
            cleanup();
            logger.debug(`[${flowKey}] Flow completed`);

            if (flowState.status === 'COMPLETED' && flowState.result !== undefined) {
              resolve(flowState.result);
            } else if (flowState.status === 'FAILED') {
              if (!this.retainedFailureTypes.has(type)) {
                await this.keyv.delete(flowKey);
              }
              const error = new Error(flowState.error ?? `${type} flow failed`);
              error.name = flowState.errorName ?? 'Error';
              reject(error);
            }
            return;
          }

          const elapsedTime = Date.now() - flowState.createdAt;
          if (elapsedTime >= this.monitorTimeout) {
            cleanup();
            logger.error(
              `[${flowKey}] Flow timed out | Elapsed time: ${elapsedTime} | Timeout: ${this.monitorTimeout}`,
            );
            const message = `${type} flow timed out`;
            if (this.retainedFailureTypes.has(type)) {
              const remainingTtl = Math.max(1, this.ttl - elapsedTime);
              const timedOutState: FlowState<T> = {
                ...flowState,
                status: 'FAILED',
                error: message,
                failedAt: Date.now(),
              };
              await this.keyv.set(flowKey, timedOutState, remainingTtl);
            } else {
              await this.keyv.delete(flowKey);
            }
            reject(new Error(message));
            return;
          }
          logger.debug(`[${flowKey}] Flow state elapsed time: ${elapsedTime}, checking again...`);
        } catch (error) {
          logger.error(`[${flowKey}] Error checking flow state:`, error);
          cleanup();
          reject(error);
        }
      }, checkInterval);

      this.intervals.add(intervalId);
    });
  }

  /**
   * Completes a flow successfully
   */
  async completeFlow(flowId: string, type: string, result: T): Promise<boolean> {
    const flowKey = this.getFlowKey(flowId, type);
    const flowState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;

    if (!flowState) {
      logger.warn(
        `[FlowStateManager] completeFlow: flow not found — key=${flowKey}. ` +
          'Possible causes: flow TTL expired before callback arrived, flow was never created, or ' +
          'the callback is routing to a different instance without shared Keyv storage.',
        { flowId, type },
      );
      return false;
    }

    /** Prevent duplicate completion */
    if (flowState.status === 'COMPLETED') {
      logger.debug(
        '[FlowStateManager] Flow already completed, skipping to prevent duplicate completion',
        {
          flowId,
          type,
        },
      );
      return true;
    }

    const updatedState: FlowState<T> = {
      ...flowState,
      status: 'COMPLETED',
      result,
      completedAt: Date.now(),
    };

    await this.keyv.set(flowKey, updatedState, this.ttl);

    logger.debug('[FlowStateManager] Flow completed successfully', {
      flowId,
      type,
    });

    return true;
  }

  /**
   * Checks if a flow is stale based on its age and status
   * @param flowId - The flow identifier
   * @param type - The flow type
   * @param staleThresholdMs - Age in milliseconds after which a non-pending flow is considered stale (default: 2 minutes)
   * @returns Object with isStale boolean and age in milliseconds
   */
  async isFlowStale(
    flowId: string,
    type: string,
    staleThresholdMs: number = PENDING_STALE_MS,
  ): Promise<{ isStale: boolean; age: number; status?: string }> {
    const flowKey = this.getFlowKey(flowId, type);
    const flowState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;

    if (!flowState) {
      return { isStale: false, age: 0 };
    }

    if (flowState.status === 'PENDING') {
      return { isStale: false, age: 0, status: flowState.status };
    }

    const completedAt = flowState.completedAt || flowState.failedAt;
    const createdAt = flowState.createdAt;

    let flowAge = 0;
    if (completedAt) {
      flowAge = Date.now() - completedAt;
    } else if (createdAt) {
      flowAge = Date.now() - createdAt;
    }

    return {
      isStale: flowAge > staleThresholdMs,
      age: flowAge,
      status: flowState.status,
    };
  }

  /**
   * Marks a flow as failed
   */
  async failFlow(flowId: string, type: string, error: Error | string): Promise<boolean> {
    const flowKey = this.getFlowKey(flowId, type);
    const flowState = (await this.keyv.get(flowKey)) as FlowState | undefined;

    if (!flowState) {
      return false;
    }

    if (flowState.status === 'COMPLETED') {
      logger.debug(
        '[FlowStateManager] Flow already completed, skipping failure to prevent overwrite',
        {
          flowId,
          type,
        },
      );
      return true;
    }

    const updatedState: FlowState = {
      ...flowState,
      status: 'FAILED',
      error: error instanceof Error ? error.message : error,
      errorName: error instanceof Error ? error.name : 'Error',
      failedAt: Date.now(),
    };

    await this.keyv.set(flowKey, updatedState, this.ttl);
    return true;
  }

  /**
   * Gets current flow state
   */
  async getFlowState(flowId: string, type: string): Promise<StoredDataNoRaw<FlowState<T>> | null> {
    const flowKey = this.getFlowKey(flowId, type);
    return this.keyv.get(flowKey);
  }

  /**
   * Creates a new flow and waits for its completion, only executing the handler if no existing flow is found
   * @param flowId - The ID of the flow
   * @param type - The type of flow
   * @param handler - Async function to execute if no existing flow is found
   * @param signal - Optional AbortSignal to cancel the flow
   */
  async createFlowWithHandler(
    flowId: string,
    type: string,
    handler: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const flowKey = this.getFlowKey(flowId, type);
    let observed = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
    let joined = this.joinExistingFlow(flowKey, type, observed, signal);
    if (joined) {
      return joined;
    }

    if (!this.claimsAtomically(flowKey)) {
      await new Promise((resolve) => setTimeout(resolve, 250));

      observed = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
      joined = this.joinExistingFlow(flowKey, type, observed, signal);
      if (joined) {
        return joined;
      }
    }

    const initialState: FlowState = {
      type,
      status: 'PENDING',
      metadata: {},
      createdAt: Date.now(),
    };
    if (!(await this.claimFlow(flowKey, initialState, observed))) {
      logger.debug(`[${flowKey}] Flow was claimed by a concurrent attempt; joining it`);
      return this.createFlowWithHandler(flowId, type, handler, signal);
    }
    logger.debug(`[${flowKey}] Creating initial flow state`);

    try {
      const result = await handler();
      await this.completeFlowIfCurrent(flowId, type, initialState.createdAt, '', result);
      const completedState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
      if (completedState?.status === 'COMPLETED' && completedState.result !== undefined) {
        return completedState.result;
      }
      return result;
    } catch (error) {
      await this.failFlowIfCurrent(
        flowId,
        type,
        initialState.createdAt,
        '',
        error instanceof Error ? error : new Error(String(error)),
      );
      const settledState = (await this.keyv.get(flowKey)) as FlowState<T> | undefined;
      if (
        settledState?.status === 'COMPLETED' &&
        settledState.result !== undefined &&
        FlowStateManager.isCurrentAttempt(settledState, initialState.createdAt, '')
      ) {
        return settledState.result;
      }
      throw error;
    }
  }

  /**
   * A completed result is served as it stands and a pending attempt is monitored, as is a failure
   * of a retained type. A failure of any other type only lingers because its own attempt already
   * returned it, so the next attempt replaces it instead of waiting on it.
   */
  private joinExistingFlow(
    flowKey: string,
    type: string,
    existingState: FlowState<T> | undefined,
    signal?: AbortSignal,
  ): Promise<T> | undefined {
    if (!existingState || this.isTokenExpired(existingState)) {
      return undefined;
    }
    if (existingState.status === 'FAILED' && !this.retainedFailureTypes.has(type)) {
      return undefined;
    }
    if (signal?.aborted) {
      return Promise.reject(new Error(`${type} flow aborted`));
    }
    if (existingState.status === 'COMPLETED') {
      logger.debug(`[${flowKey}] Serving completed flow result`);
      return Promise.resolve(existingState.result as T);
    }
    logger.debug(`[${flowKey}] Flow already exists with valid token`);
    return this.monitorFlow(flowKey, type, signal, false);
  }

  /** Redis and the default in-memory store install an attempt atomically; other stores cannot. */
  private claimsAtomically(flowKey: string): boolean {
    return (
      this.getRedisKey(flowKey) != null ||
      (this.keyv instanceof Keyv && this.keyv.store instanceof Map)
    );
  }

  /**
   * Installs `initialState` only while the key is absent or still holds `observed`, the attempt
   * the caller read and decided to replace. A store without an atomic primitive installs it
   * unconditionally, as before.
   */
  private async claimFlow(
    flowKey: string,
    initialState: FlowState,
    observed: FlowState<T> | undefined,
  ): Promise<boolean> {
    const observedState =
      typeof observed?.metadata?.state === 'string' ? observed.metadata.state : '';
    const envelope = JSON.stringify({
      value: initialState,
      expires: initialState.createdAt + this.ttl,
    });
    const redisKey = this.getRedisKey(flowKey);
    if (redisKey) {
      const claimed = await this.evalRedisScript(CLAIM_FLOW, redisKey, [
        envelope,
        String(this.ttl),
        observed ? String(observed.createdAt) : '',
        observedState,
        observed?.status ?? '',
      ]);
      return Number(claimed) === 1;
    }

    if (this.keyv instanceof Keyv && this.keyv.store instanceof Map) {
      const current = this.getInMemoryEntry(flowKey);
      if (
        current &&
        (!observed ||
          current.envelope.value.status !== observed.status ||
          !FlowStateManager.isCurrentAttempt(
            current.envelope.value,
            observed.createdAt,
            observedState,
          ))
      ) {
        return false;
      }
      const key = this.keyv.namespace ? `${this.keyv.namespace}:${flowKey}` : flowKey;
      this.keyv.store.set(key, envelope);
      return true;
    }

    await this.keyv.set(flowKey, initialState, this.ttl);
    return true;
  }

  /**
   * Deletes a flow state
   */
  async deleteFlow(flowId: string, type: string): Promise<boolean> {
    const flowKey = this.getFlowKey(flowId, type);
    try {
      await this.keyv.delete(flowKey);
      logger.debug(`[${flowKey}] Flow deleted`);
      return true;
    } catch (error) {
      logger.error(`[${flowKey}] Error deleting flow:`, error);
      return false;
    }
  }
}
