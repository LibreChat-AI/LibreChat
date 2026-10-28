import { AsyncLocalStorage } from 'async_hooks';
import { CacheKeys } from 'librechat-data-provider';
import type { Span } from '@opentelemetry/api';
import {
  isMetricsConfigured,
  recordRedisOperation,
  type RedisClient,
  type RedisOperationStatus,
} from '~/app/metrics';

import { isEvalshaFallbackInProgress } from './redisScript';
const REDIS_CACHE_METHODS = [
  'clear',
  'delete',
  'deleteMany',
  'get',
  'getMany',
  'getManyRaw',
  'getRaw',
  'has',
  'hasMany',
  'set',
  'setMany',
] as const;

/** Keep this list aligned with direct commands used by instrumented ioredis clients. */
const IOREDIS_COMMANDS = new Set([
  'call',
  'del',
  'eval',
  'evalsha',
  'exists',
  'expire',
  'get',
  'hgetall',
  'incr',
  'lrange',
  'mget',
  'publish',
  'psubscribe',
  'punsubscribe',
  'sadd',
  'scan',
  'scard',
  'set',
  'smembers',
  'srem',
  'subscribe',
  'unsubscribe',
  'xack',
  'xgroup',
  'xrange',
  'xreadgroup',
]);

const INSTRUMENTED_CACHE = Symbol('librechat.redisTelemetry.instrumentedCache');
const MAX_DETAILED_TRACE_USE_CASES = 10;
const instrumentedClients = new WeakMap<object, Map<string, object>>();

export const RedisUseCases = {
  GENERATION_STREAM: 'generation_stream',
  LEADER_ELECTION: 'leader_election',
  MCP_REGISTRY: 'mcp_registry',
  RATE_LIMIT: 'rate_limit',
  VIOLATIONS: 'violations',
} as const;

type RedisUseCaseSummary = {
  calls: number;
  durationMs: number;
  errors: number;
  maxCallMs: number;
};

export interface RedisRequestTelemetry {
  calls: number;
  durationMs: number;
  ended: boolean;
  errors: number;
  maxCallMs: number;
  operations: Set<string>;
  span: Span;
  useCases: Map<string, RedisUseCaseSummary>;
}

const requestTelemetry = new AsyncLocalStorage<RedisRequestTelemetry>();
const activeRedisObservation = new AsyncLocalStorage<boolean>();

const normalizeLabel = (value: string): string =>
  value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64) || 'unknown';

const cacheUseCases = new Set(Object.values(CacheKeys).map((value) => normalizeLabel(value)));
const explicitUseCases = new Set<string>(Object.values(RedisUseCases));

export function normalizeRedisUseCase(namespace: string): string {
  const normalized = normalizeLabel(namespace.replace(/:+$/, ''));
  if (cacheUseCases.has(normalized) || explicitUseCases.has(normalized)) {
    return normalized;
  }
  if (normalized.startsWith('mcp_serversregistry')) {
    return RedisUseCases.MCP_REGISTRY;
  }
  if (normalized.startsWith('violations_')) {
    return RedisUseCases.VIOLATIONS;
  }
  return 'other';
}

export function createRedisRequestTelemetry(span: Span): RedisRequestTelemetry {
  return {
    calls: 0,
    durationMs: 0,
    ended: false,
    errors: 0,
    maxCallMs: 0,
    operations: new Set(),
    span,
    useCases: new Map(),
  };
}

export function runWithRedisRequestTelemetry<T>(
  telemetry: RedisRequestTelemetry,
  callback: () => T,
): T {
  return requestTelemetry.run(telemetry, callback);
}

const roundedMilliseconds = (value: number): number => Math.round(value * 1000) / 1000;

export function finishRedisRequestTelemetry(telemetry: RedisRequestTelemetry): void {
  if (telemetry.ended) {
    return;
  }
  telemetry.ended = true;
  if (telemetry.calls === 0) {
    return;
  }

  telemetry.span.setAttributes({
    'librechat.redis.calls': telemetry.calls,
    'librechat.redis.duration_ms': roundedMilliseconds(telemetry.durationMs),
    'librechat.redis.errors': telemetry.errors,
    'librechat.redis.max_call_ms': roundedMilliseconds(telemetry.maxCallMs),
    'librechat.redis.operations': [...telemetry.operations].sort(),
    'librechat.redis.use_cases': [...telemetry.useCases.keys()].sort(),
  });

  const detailedUseCases = [...telemetry.useCases.entries()]
    .sort(([, left], [, right]) => right.durationMs - left.durationMs)
    .slice(0, MAX_DETAILED_TRACE_USE_CASES);

  for (const [useCase, summary] of detailedUseCases) {
    const prefix = `librechat.redis.${useCase}`;
    telemetry.span.setAttributes({
      [`${prefix}.calls`]: summary.calls,
      [`${prefix}.duration_ms`]: roundedMilliseconds(summary.durationMs),
      [`${prefix}.errors`]: summary.errors,
      [`${prefix}.max_call_ms`]: roundedMilliseconds(summary.maxCallMs),
    });
  }
}

function addRequestObservation(
  telemetry: RedisRequestTelemetry | undefined,
  useCase: string,
  operation: string,
  status: RedisOperationStatus,
  durationMs: number,
): void {
  if (!telemetry || telemetry.ended) {
    return;
  }

  telemetry.calls += 1;
  telemetry.durationMs += durationMs;
  telemetry.maxCallMs = Math.max(telemetry.maxCallMs, durationMs);
  telemetry.operations.add(operation);
  if (status === 'error') {
    telemetry.errors += 1;
  }

  const summary = telemetry.useCases.get(useCase) ?? {
    calls: 0,
    durationMs: 0,
    errors: 0,
    maxCallMs: 0,
  };
  summary.calls += 1;
  summary.durationMs += durationMs;
  summary.maxCallMs = Math.max(summary.maxCallMs, durationMs);
  if (status === 'error') {
    summary.errors += 1;
  }
  telemetry.useCases.set(useCase, summary);
}

export async function observeRedisOperation<T>(
  client: RedisClient,
  namespace: string,
  operationName: string,
  operation: () => T | PromiseLike<T>,
  isErrorResult?: (result: T) => boolean,
): Promise<T> {
  if (activeRedisObservation.getStore()) {
    return await operation();
  }

  const telemetry = requestTelemetry.getStore();
  if ((!telemetry || telemetry.ended) && !isMetricsConfigured()) {
    return await operation();
  }

  const useCase = normalizeRedisUseCase(namespace);
  const redisOperation = normalizeLabel(operationName);
  const startedAt = process.hrtime.bigint();
  let status: RedisOperationStatus = 'success';
  try {
    const result = await activeRedisObservation.run(true, operation);
    if (isErrorResult?.(result)) {
      status = 'error';
    }
    return result;
  } catch (error) {
    status =
      redisOperation === 'evalsha' && isEvalshaFallbackInProgress(error) ? 'success' : 'error';
    throw error;
  } finally {
    const durationSeconds = Number(process.hrtime.bigint() - startedAt) / 1_000_000_000;
    addRequestObservation(telemetry, useCase, redisOperation, status, durationSeconds * 1000);
    recordRedisOperation(client, useCase, redisOperation, status, durationSeconds);
  }
}

export function instrumentRedisCache<T extends object>(
  cache: T,
  namespace: string,
  client: RedisClient = 'keyv',
): T {
  const instrumented = cache as Record<PropertyKey, unknown>;
  if (instrumented[INSTRUMENTED_CACHE]) {
    return cache;
  }

  for (const method of REDIS_CACHE_METHODS) {
    const original = instrumented[method];
    if (typeof original !== 'function') {
      continue;
    }
    instrumented[method] = (...args: unknown[]) =>
      observeRedisOperation(client, namespace, method, () => Reflect.apply(original, cache, args));
  }

  instrumented[INSTRUMENTED_CACHE] = true;
  return cache;
}

function instrumentPipeline<T extends object>(pipeline: T, namespace: string): T {
  return new Proxy(pipeline, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property !== 'exec' || typeof value !== 'function') {
        if (typeof value !== 'function') {
          return value;
        }
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? receiver : result;
        };
      }
      return (...args: unknown[]) =>
        observeRedisOperation(
          'ioredis',
          namespace,
          'pipeline',
          () => Reflect.apply(value, target, args),
          pipelineResultHasErrors,
        );
    },
  });
}

function pipelineResultHasErrors(result: unknown): boolean {
  return (
    Array.isArray(result) &&
    result.some((entry) => Array.isArray(entry) && entry.length > 0 && entry[0] != null)
  );
}

export function instrumentIORedisClient<T extends object>(client: T, namespace: string): T {
  const useCase = normalizeRedisUseCase(namespace);
  const existing = instrumentedClients.get(client)?.get(useCase);
  if (existing) {
    return existing as T;
  }

  const proxy = new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (property === 'constructor') {
        return value;
      }
      if (typeof property !== 'string' || typeof value !== 'function') {
        return value;
      }
      if (property === 'pipeline' || property === 'multi') {
        return (...args: unknown[]) =>
          instrumentPipeline(Reflect.apply(value, target, args) as object, useCase);
      }
      if (!IOREDIS_COMMANDS.has(property)) {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          return result === target ? receiver : result;
        };
      }
      return (...args: unknown[]) => {
        const operation = property === 'call' && typeof args[0] === 'string' ? args[0] : property;
        return observeRedisOperation('ioredis', useCase, operation, () =>
          Reflect.apply(value, target, args),
        );
      };
    },
  });

  const byUseCase = instrumentedClients.get(client) ?? new Map<string, object>();
  byUseCase.set(useCase, proxy);
  instrumentedClients.set(client, byUseCase);
  return proxy;
}
