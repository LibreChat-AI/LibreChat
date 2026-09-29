import isEqual from 'lodash/isEqual';
import { createHash } from 'node:crypto';
import isPlainObject from 'lodash/isPlainObject';
import { logger } from '@librechat/data-schemas';
import { getMaxSubagents, setMaxSubagents } from 'librechat-data-provider';
import type {
  TCustomConfig,
  TConfigReloadResult,
  TConfigReloadSection,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { ConfigReloadError } from './loader';

const CONFIG_GENERATION_KEY = 'config:model-catalog:v1';
const PUBLISH_GENERATION_SCRIPT = `
local previous = redis.call('GET', KEYS[1])
if (previous == false and ARGV[1] ~= '0') or
   (previous ~= false and (ARGV[1] ~= '1' or previous ~= ARGV[2])) then
  return -1
end
local number = 0
if previous then
  local ok, decoded = pcall(cjson.decode, previous)
  if ok and type(decoded) == 'table' then
    number = tonumber(decoded.generation) or 0
  else
    number = tonumber(previous) or 0
  end
end
number = number + 1
redis.call('SET', KEYS[1], cjson.encode({generation = number, digest = ARGV[3]}))
return number
`;

/** Bootstrap coordination cannot read its own interval from the config it gates. One second bounds Redis reads per replica while keeping propagation responsive. */
const DEFAULT_GENERATION_POLL_MS = 1_000;

export type ConfigSectionStatus = TConfigReloadSection['status'];
export type ConfigSectionReport = TConfigReloadSection;
export type ConfigReloadResult = TConfigReloadResult;

export interface ConfigGenerationStore {
  get(key: string): Promise<string | null>;
  publish(key: string, digest: string, expectedRaw: string | null): Promise<number | null>;
}

export interface ConfigGenerationSnapshot {
  readonly raw: string | null;
  readonly digest?: string;
  readonly generation?: number;
}

export class ConfigGenerationConflictError extends Error {
  constructor() {
    super('A newer model catalog was published during reload. Verify the source and retry.');
    this.name = 'ConfigGenerationConflictError';
  }
}

export interface ConfigGenerationChange {
  readonly expectedDigest: string;
  isCurrent(): boolean;
  acknowledge(): void;
  defer(retryMs: number): void;
}

export interface ConfigGenerationTracker {
  readonly distributed: boolean;
  check(currentDigest?: string): Promise<ConfigGenerationChange | undefined>;
  bootstrap(): Promise<void>;
  snapshot(): Promise<ConfigGenerationSnapshot | undefined>;
  applied(digest: string): number | undefined;
  accept(snapshot: ConfigGenerationSnapshot): void;
  superseded(snapshot: ConfigGenerationSnapshot): boolean;
  bump(digest: string, expected: ConfigGenerationSnapshot): Promise<number | null | undefined>;
}

export interface ConfigGenerationTrackerOptions {
  pollIntervalMs?: number;
  /** Use the deployment's existing Redis connection deadline at startup. */
  bootstrapTimeoutMs?: number;
  now?: () => number;
}

export interface ConfigReloaderDeps {
  loadConfig: (current: AppConfig) => Promise<TCustomConfig | null>;
  buildBaseConfig: (config: TCustomConfig) => Promise<AppConfig>;
  getBaseConfig: () => Promise<AppConfig>;
  replaceBaseConfig: (config: AppConfig) => Promise<AppConfig>;
  clearOverrideCache: () => Promise<void>;
  withConfigUpdate?: <T>(work: () => Promise<T>) => Promise<T>;
  generation: ConfigGenerationTracker;
}

/** Only an existing, unambiguously named custom endpoint's default model list is live. */
function matchingCustomEndpoints(previous: TCustomConfig, candidate: TCustomConfig): boolean {
  const old = previous.endpoints?.custom ?? [];
  const next = candidate.endpoints?.custom ?? [];
  return (
    old.length === next.length &&
    new Set(old.map((endpoint) => endpoint.name)).size === old.length &&
    old.every(
      (endpoint, index) =>
        endpoint.name === next[index]?.name &&
        Array.isArray(endpoint.models?.default) &&
        Array.isArray(next[index]?.models?.default),
    )
  );
}

function isLivePath(path: string, previous: TCustomConfig, next: TCustomConfig): boolean {
  return (
    matchingCustomEndpoints(previous, next) &&
    /^endpoints\.custom\.\d+\.models\.default$/.test(path)
  );
}

function collectChangedPaths(previous: unknown, next: unknown, path: string): string[] {
  if (isEqual(previous, next)) {
    return [];
  }
  if (
    path === 'endpoints.custom' &&
    Array.isArray(previous) &&
    Array.isArray(next) &&
    previous.length === next.length &&
    new Set(previous.map((endpoint) => endpoint?.name)).size === previous.length &&
    previous.every((endpoint, index) => endpoint?.name === next[index]?.name)
  ) {
    return previous.flatMap((value, index) =>
      collectChangedPaths(value, next[index], `${path}.${index}`),
    );
  }
  const previousIsObject = isPlainObject(previous);
  const nextIsObject = isPlainObject(next);
  if ((!previousIsObject && previous != null) || (!nextIsObject && next != null)) {
    return [path];
  }
  if (!previousIsObject && !nextIsObject) {
    return [path];
  }

  const previousObject = previousIsObject ? (previous as Record<string, unknown>) : {};
  const nextObject = nextIsObject ? (next as Record<string, unknown>) : {};
  const keys = new Set([...Object.keys(previousObject), ...Object.keys(nextObject)]);
  if (keys.size === 0) {
    return [path];
  }
  return [...keys]
    .sort()
    .flatMap((key) =>
      collectChangedPaths(previousObject[key], nextObject[key], path ? `${path}.${key}` : key),
    );
}

export function createConfigReloadReport(
  previous: TCustomConfig,
  next: TCustomConfig,
): ConfigSectionReport[] {
  const sections = new Set([...Object.keys(previous), ...Object.keys(next)]);
  return [...sections].sort().map((section) => {
    const changedPaths = collectChangedPaths(
      previous[section as keyof TCustomConfig],
      next[section as keyof TCustomConfig],
      section,
    );
    if (changedPaths.length === 0) {
      return { section, status: 'unchanged', restartRequired: false };
    }

    const restartRequiredPaths = changedPaths.filter((path) => !isLivePath(path, previous, next));
    const restartOnly = restartRequiredPaths.length === changedPaths.length;
    return {
      section,
      status: restartOnly ? 'restart_required' : 'applied_live',
      restartRequired: restartRequiredPaths.length > 0,
      ...(restartRequiredPaths.length > 0 ? { restartRequiredPaths } : {}),
    };
  });
}

function canonicalConfig(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalConfig);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => [key, canonicalConfig(record[key])]),
  );
}

/** A digest of exactly the fields the live projection installs. Other YAML never affects it. */
export function hashConfig(config: TCustomConfig): string {
  const catalog = (config.endpoints?.custom ?? []).map((endpoint) => ({
    name: endpoint.name,
    models: endpoint.models?.default,
  }));
  return createHash('sha256')
    .update(JSON.stringify(canonicalConfig(catalog)))
    .digest('hex');
}

/** Keep startup-owned state untouched, including tool catalogs and storage clients. */
export function retainRestartOnlyConfig(
  previous: TCustomConfig | undefined,
  candidate: TCustomConfig,
): TCustomConfig {
  if (!previous || !matchingCustomEndpoints(previous, candidate)) {
    return previous ?? candidate;
  }
  const old = previous.endpoints?.custom ?? [];
  const next = candidate.endpoints?.custom ?? [];
  let changed = false;
  const custom = old.map((endpoint, index) => {
    const defaults = next[index]?.models?.default;
    if (isEqual(endpoint.models?.default, defaults)) {
      return endpoint;
    }
    changed = true;
    return { ...endpoint, models: { ...endpoint.models, default: defaults } };
  });
  return changed ? { ...previous, endpoints: { ...previous.endpoints, custom } } : previous;
}

/** One atomic, single-key operation works on Redis and Redis Cluster. */
export function createRedisConfigGenerationStore(client: {
  get(key: string): Promise<string | null>;
  eval(script: string, keys: number, key: string, ...args: string[]): Promise<unknown>;
}): ConfigGenerationStore {
  return {
    get: (key) => client.get(key),
    publish: async (key, digest, expectedRaw) => {
      const result = Number(
        await client.eval(
          PUBLISH_GENERATION_SCRIPT,
          1,
          key,
          expectedRaw == null ? '0' : '1',
          expectedRaw ?? '',
          digest,
        ),
      );
      return result === -1 ? null : result;
    },
  };
}

export function createConfigGenerationTracker(
  store?: ConfigGenerationStore | null,
  options: ConfigGenerationTrackerOptions = {},
): ConfigGenerationTracker {
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_GENERATION_POLL_MS);
  const now = options.now ?? Date.now;
  let seenGeneration: string | undefined;
  let seenDigest: string | undefined;
  let bootstrapComplete = false;
  let nextPollAt = 0;
  let checkFlight: Promise<ConfigGenerationChange | undefined> | undefined;
  let readFlight: Promise<string | null> | undefined;
  let readSequence = 0;

  function readPersisted(): Promise<string | null> {
    if (!store) return Promise.resolve(null);
    if (readFlight) return readFlight;
    const flight = store.get(CONFIG_GENERATION_KEY);
    readFlight = flight;
    void flight
      .finally(() => {
        if (readFlight === flight) readFlight = undefined;
      })
      .catch(() => undefined);
    return flight;
  }

  function parseSnapshot(raw: string | null): ConfigGenerationSnapshot {
    if (raw == null) return { raw };
    try {
      const value = JSON.parse(raw) as { generation: number; digest: string };
      if (Number.isSafeInteger(value?.generation) && typeof value?.digest === 'string') {
        return { raw, digest: value.digest, generation: value.generation };
      }
    } catch {
      // Unknown persisted formats remain conditionally replaceable but never acknowledged.
    }
    return { raw };
  }

  async function readGeneration(
    currentDigest: string | undefined,
    sequence: number,
    read: Promise<string | null>,
  ): Promise<ConfigGenerationChange | undefined> {
    const generationBeforeRead = seenGeneration;
    const raw = await read;
    if (sequence !== readSequence || seenGeneration !== generationBeforeRead || raw == null) {
      return undefined;
    }
    const payload = parseSnapshot(raw);
    if (payload.generation == null || payload.digest == null) return undefined;
    const generation = String(payload.generation);
    if (payload.digest === currentDigest) {
      seenGeneration = generation;
      seenDigest = payload.digest;
      return undefined;
    }
    if (seenGeneration == null && (!bootstrapComplete || payload.digest === currentDigest)) {
      seenGeneration = generation;
      seenDigest = payload.digest;
      return undefined;
    }
    if (generation === seenGeneration) {
      return undefined;
    }
    const previousGeneration = seenGeneration;
    return {
      expectedDigest: payload.digest,
      isCurrent: () => seenGeneration === previousGeneration && readSequence === sequence,
      acknowledge() {
        if (seenGeneration === previousGeneration) {
          seenGeneration = generation;
          seenDigest = payload.digest;
        }
      },
      defer(retryMs) {
        nextPollAt = Math.max(nextPollAt, now() + retryMs);
      },
    };
  }

  async function check(currentDigest?: string): Promise<ConfigGenerationChange | undefined> {
    if (!store) {
      return undefined;
    }
    if (checkFlight) {
      return checkFlight;
    }
    if (now() < nextPollAt) {
      return undefined;
    }
    nextPollAt = now() + pollIntervalMs;
    const sequence = ++readSequence;
    const flight = readGeneration(currentDigest, sequence, readPersisted());
    checkFlight = flight;
    try {
      return await flight;
    } finally {
      if (checkFlight === flight) {
        checkFlight = undefined;
      }
    }
  }

  async function bootstrap(): Promise<void> {
    if (!store) {
      return;
    }
    // Capture the persisted generation before startup reads its local source.
    // A publication during that load remains visible to the next check. If
    // Redis is offline, startup proceeds and the first recovered read becomes
    // the baseline rather than treating an old persisted digest as new work.
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        check().then(() => undefined),
        new Promise<void>((resolve) => {
          timeout = setTimeout(() => {
            readSequence += 1;
            resolve();
          }, options.bootstrapTimeoutMs ?? 1_000);
          timeout.unref?.();
        }),
      ]);
    } finally {
      bootstrapComplete = true;
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  async function snapshot(): Promise<ConfigGenerationSnapshot | undefined> {
    if (!store) return undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        readPersisted(),
        new Promise<undefined>((resolve) => {
          timeout = setTimeout(() => resolve(undefined), options.bootstrapTimeoutMs ?? 1_000);
          timeout.unref?.();
        }),
      ]);
      return raw === undefined ? undefined : parseSnapshot(raw);
    } catch (error) {
      logger.warn('[configReload] Could not read model catalog generation:', error);
      return undefined;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  function accept(value: ConfigGenerationSnapshot): void {
    if (value.generation == null || value.digest == null) return;
    ++readSequence;
    seenGeneration = String(value.generation);
    seenDigest = value.digest;
    nextPollAt = now() + pollIntervalMs;
  }

  async function bump(
    digest: string,
    expected: ConfigGenerationSnapshot,
  ): Promise<number | null | undefined> {
    if (!store) return undefined;
    const generation = await store.publish(CONFIG_GENERATION_KEY, digest, expected.raw);
    if (generation == null) return null;
    accept({ raw: null, generation, digest });
    return generation;
  }

  const applied = (digest: string): number | undefined =>
    seenDigest === digest && seenGeneration != null ? Number(seenGeneration) : undefined;

  const superseded = (value: ConfigGenerationSnapshot): boolean =>
    value.generation != null &&
    (seenGeneration == null || value.generation > Number(seenGeneration));

  return {
    distributed: store != null,
    check,
    bootstrap,
    snapshot,
    applied,
    accept,
    superseded,
    bump,
  };
}

export function createConfigReloader(deps: ConfigReloaderDeps): () => Promise<ConfigReloadResult> {
  let reloadFlight: Promise<ConfigReloadResult> | undefined;

  async function reload(): Promise<ConfigReloadResult> {
    const current = await deps.getBaseConfig();
    if (deps.generation.distributed && current.config?.configReload?.clusterReady !== true) {
      throw new ConfigReloadError('Enable configReload.clusterReady after upgrading all replicas.');
    }
    // Observe Redis before loading a potentially slower source on another replica.
    const snapshotFlight = deps.generation.snapshot();
    const previousMaxSubagents = getMaxSubagents();
    let installed = false;
    try {
      const candidate = await deps.loadConfig(current);
      if (!candidate) throw new ConfigReloadError('The custom configuration could not be loaded.');
      const report = createConfigReloadReport(current.config ?? {}, candidate);
      const effective = retainRestartOnlyConfig(current.config, candidate);
      const digest = hashConfig(effective);
      const changed = digest !== hashConfig(current.config ?? {});
      const snapshot = await snapshotFlight;
      if (snapshot && snapshot.digest !== digest && deps.generation.superseded(snapshot)) {
        throw new ConfigGenerationConflictError();
      }
      if (!changed && (!deps.generation.distributed || snapshot?.digest === digest)) {
        return { scope: 'unchanged', distributed: deps.generation.distributed, sections: report };
      }

      if (changed) {
        const next = await deps.buildBaseConfig(effective);
        if (hashConfig(next.config ?? {}) !== digest) {
          throw new ConfigReloadError('Model catalog changed during validation.');
        }
        await deps.replaceBaseConfig(next);
        installed = true;
        await deps.clearOverrideCache();
      }
      if (!deps.generation.distributed) {
        return { scope: 'local', distributed: false, sections: report };
      }
      if (!snapshot) {
        return {
          scope: 'local',
          distributed: false,
          propagationError: 'Redis generation read failed',
          sections: report,
        };
      }
      if (snapshot.digest === digest) {
        deps.generation.accept(snapshot);
        return {
          scope: 'cluster',
          distributed: true,
          generation: snapshot.generation,
          sections: report,
        };
      }

      try {
        const generation = await deps.generation.bump(digest, snapshot);
        if (generation != null) {
          return { scope: 'cluster', distributed: true, generation, sections: report };
        }
        const winner = await deps.generation.snapshot();
        if (winner?.digest !== digest) throw new ConfigGenerationConflictError();
        deps.generation.accept(winner);
        return {
          scope: 'cluster',
          distributed: true,
          generation: winner.generation,
          sections: report,
        };
      } catch (error) {
        if (error instanceof ConfigGenerationConflictError) throw error;
        logger.error('[configReload] Failed to publish model catalog generation:', error);
        return {
          scope: 'local',
          distributed: false,
          propagationError: 'Redis generation update failed',
          sections: report,
        };
      }
    } catch (error) {
      if (installed) {
        await deps
          .replaceBaseConfig(current)
          .then(() => deps.clearOverrideCache())
          .catch((rollbackError) =>
            logger.error('[configReload] Could not restore the previous base:', rollbackError),
          );
      }
      setMaxSubagents(previousMaxSubagents);
      throw error;
    }
  }

  return async function reloadConfig(): Promise<ConfigReloadResult> {
    if (reloadFlight) {
      return reloadFlight;
    }
    const flight = deps.withConfigUpdate ? deps.withConfigUpdate(reload) : reload();
    reloadFlight = flight;
    try {
      return await flight;
    } finally {
      if (reloadFlight === flight) {
        reloadFlight = undefined;
      }
    }
  };
}
