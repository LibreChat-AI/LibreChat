import { randomUUID } from 'crypto';
import { logger } from '@librechat/data-schemas';
import type { MCPRecoveryGenerationScope } from './catalog/recovery';
import { registerShutdownTask } from '~/app/shutdown';

const DEFAULT_RETRY_INTERVAL_MS = 30_000;
const DEFAULT_RETRY_BATCH_SIZE = 100;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 1_000;

export interface MCPAuthorizationFenceRetryRecord extends MCPRecoveryGenerationScope {
  tenantId?: string | null;
  version: string;
  updatedAt: Date;
}

export interface MCPAuthorizationFenceRetryStorage {
  upsert(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
    now: Date;
  }): Promise<void>;
  deleteVersion(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
  }): Promise<void>;
  deferVersion(input: {
    scope: MCPRecoveryGenerationScope;
    tenantId?: string | null;
    version: string;
    updatedAt: Date;
  }): Promise<void>;
  list(limit: number): Promise<readonly MCPAuthorizationFenceRetryRecord[]>;
}

export interface MCPAuthorizationFenceRetryServiceDeps {
  storage: MCPAuthorizationFenceRetryStorage;
  getTenantId: () => string | null | undefined;
  runInRetryScope: (
    retry: MCPAuthorizationFenceRetryRecord,
    operation: () => Promise<void>,
  ) => Promise<void>;
  registerShutdown?: typeof registerShutdownTask;
}

export interface MCPAuthorizationFenceRetryWorkerPolicy {
  intervalMs?: number;
  batchSize?: number;
  attemptTimeoutMs?: number;
}

export interface MCPAuthorizationFenceRetryService {
  clear(scope: MCPRecoveryGenerationScope, version: string): Promise<void>;
  drain(): Promise<void>;
  persist(scope: MCPRecoveryGenerationScope): Promise<string>;
  start(
    invalidator: (scope: MCPRecoveryGenerationScope) => Promise<unknown>,
    policy?: MCPAuthorizationFenceRetryWorkerPolicy,
  ): void;
  stop(): Promise<void>;
}

/** Owns durable authorization-fence retry lifecycle independently of the legacy server adapter. */
export function createMCPAuthorizationFenceRetryService(
  deps: MCPAuthorizationFenceRetryServiceDeps,
): MCPAuthorizationFenceRetryService {
  type RetryAttemptResult = { succeeded: true } | { succeeded: false; error: unknown };
  let retryTimer: ReturnType<typeof setInterval> | undefined;
  let drainPromise: Promise<void> | undefined;
  const activeAttempts = new Map<string, Promise<RetryAttemptResult>>();
  let invalidateRecoveryGeneration:
    | ((scope: MCPRecoveryGenerationScope) => Promise<unknown>)
    | undefined;
  let retryBatchSize = DEFAULT_RETRY_BATCH_SIZE;
  let attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS;

  const attemptKey = (retry: MCPAuthorizationFenceRetryRecord): string =>
    JSON.stringify([retry.tenantId ?? '', retry.userId, retry.serverName, retry.version]);

  const getOrStartAttempt = (
    retry: MCPAuthorizationFenceRetryRecord,
  ): Promise<RetryAttemptResult> => {
    const key = attemptKey(retry);
    const activeAttempt = activeAttempts.get(key);
    if (activeAttempt != null) {
      return activeAttempt;
    }

    const attempt = deps
      .runInRetryScope(retry, async () => {
        await invalidateRecoveryGeneration?.({
          userId: retry.userId,
          serverName: retry.serverName,
        });
      })
      .then(async () => {
        await deps.storage.deleteVersion({
          scope: { userId: retry.userId, serverName: retry.serverName },
          tenantId: retry.tenantId,
          version: retry.version,
        });
        return { succeeded: true } as const;
      })
      .catch((error: unknown) => ({ succeeded: false, error }) as const)
      .finally(() => {
        if (activeAttempts.get(key) === attempt) {
          activeAttempts.delete(key);
        }
      });
    activeAttempts.set(key, attempt);
    return attempt;
  };

  const persist = async (scope: MCPRecoveryGenerationScope): Promise<string> => {
    const version = randomUUID();
    await deps.storage.upsert({
      scope,
      tenantId: deps.getTenantId() ?? null,
      version,
      now: new Date(),
    });
    return version;
  };

  const clear = async (scope: MCPRecoveryGenerationScope, version: string): Promise<void> => {
    await deps.storage.deleteVersion({
      scope,
      tenantId: deps.getTenantId() ?? null,
      version,
    });
  };

  const drain = async (): Promise<void> => {
    if (drainPromise != null || invalidateRecoveryGeneration == null) {
      return drainPromise;
    }
    drainPromise = (async () => {
      const retries = await deps.storage.list(retryBatchSize);
      for (const retry of retries) {
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const key = attemptKey(retry);
        const attempt = getOrStartAttempt(retry);
        try {
          const result = await Promise.race([
            attempt,
            new Promise<never>((_, reject) => {
              timeoutId = setTimeout(() => {
                timedOut = true;
                reject(new Error('MCP authorization generation replay timed out'));
              }, attemptTimeoutMs);
            }),
          ]);
          if (!result.succeeded) {
            throw result.error;
          }
        } catch (error) {
          logger.warn(
            `[MCP authorization] Durable generation retry failed for ${retry.serverName}`,
            error,
          );
          /** The underlying cache call may ignore cancellation. Retire it from deduplication so a
           * recovered dependency gets a fresh attempt; its exact-version delete remains safe if
           * the old promise eventually succeeds. */
          if (timedOut && activeAttempts.get(key) === attempt) {
            activeAttempts.delete(key);
          }
          try {
            let deferTimeoutId: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                deps.storage.deferVersion({
                  scope: { userId: retry.userId, serverName: retry.serverName },
                  tenantId: retry.tenantId,
                  version: retry.version,
                  updatedAt: new Date(Math.max(Date.now(), retry.updatedAt.getTime() + 1)),
                }),
                new Promise<never>((_, reject) => {
                  deferTimeoutId = setTimeout(
                    () => reject(new Error('MCP authorization retry deferral timed out')),
                    attemptTimeoutMs,
                  );
                }),
              ]);
            } finally {
              if (deferTimeoutId != null) {
                clearTimeout(deferTimeoutId);
              }
            }
          } catch (deferError) {
            logger.warn(
              `[MCP authorization] Could not defer generation retry for ${retry.serverName}`,
              deferError,
            );
          }
        } finally {
          if (timeoutId != null) {
            clearTimeout(timeoutId);
          }
        }
      }
    })().finally(() => {
      drainPromise = undefined;
    });
    return drainPromise;
  };

  const scheduleDrain = (): void => {
    void drain().catch((error) =>
      logger.warn('[MCP authorization] Could not read durable generation retries', error),
    );
  };

  const stop = async (): Promise<void> => {
    if (retryTimer != null) {
      clearInterval(retryTimer);
      retryTimer = undefined;
    }
    await drainPromise?.catch(() => undefined);
  };

  const start = (
    invalidator: (scope: MCPRecoveryGenerationScope) => Promise<unknown>,
    policy: MCPAuthorizationFenceRetryWorkerPolicy = {},
  ): void => {
    invalidateRecoveryGeneration = invalidator;
    retryBatchSize = policy.batchSize ?? DEFAULT_RETRY_BATCH_SIZE;
    attemptTimeoutMs = policy.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;
    if (retryTimer != null) {
      return;
    }
    retryTimer = setInterval(scheduleDrain, policy.intervalMs ?? DEFAULT_RETRY_INTERVAL_MS);
    retryTimer.unref?.();
    (deps.registerShutdown ?? registerShutdownTask)('MCP authorization fence retry worker', stop);
    scheduleDrain();
  };

  return { clear, drain, persist, start, stop };
}
