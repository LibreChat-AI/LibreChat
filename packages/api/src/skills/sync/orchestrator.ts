import { skillSyncConfigSchema } from 'librechat-data-provider';
import type { SkillSyncConfig } from 'librechat-data-provider';
import type { GitHubSkillSyncRunner } from './github';

const REQUEST_SYNC_MIN_INTERVAL_MS = 5 * 60 * 1000;
const REQUEST_SYNC_STALE_RUNNING_MS = 35 * 60 * 1000;

type MaybePromise<T> = T | Promise<T>;

export type SkillSyncAppConfigLike = {
  skillSync?: unknown;
  config?: {
    skillSync?: unknown;
  };
};

export type SkillSyncRequestUser = {
  tenantId?: string | null;
};

export type SkillSyncRequestLike = {
  config?: SkillSyncAppConfigLike;
  user?: SkillSyncRequestUser;
  skillSyncAllowServerCredentials?: boolean;
};

type ResolvedSkillSyncConfig = NonNullable<SkillSyncConfig>;
type ResolvedGitHubSkillSyncConfig = NonNullable<ResolvedSkillSyncConfig['github']>;
type SkillSyncConfigWithGitHub = ResolvedSkillSyncConfig & {
  github: ResolvedGitHubSkillSyncConfig;
};

type SkillSyncRunnerStatus = Awaited<ReturnType<GitHubSkillSyncRunner['getStatus']>>;

type SkillSyncTriggerLogger = {
  warn: (message: string, metadata?: object) => void;
  error: (message: string, error?: unknown) => void;
};

export type SkillSyncTriggerRunnerFactoryInput = {
  getConfig: () => MaybePromise<SkillSyncConfig | undefined>;
  loadAppConfig: () => MaybePromise<SkillSyncAppConfigLike | undefined>;
  allowServerCredentials?: boolean;
};

export type SkillSyncTriggerOrchestratorDeps = {
  createRunner: (input: SkillSyncTriggerRunnerFactoryInput) => GitHubSkillSyncRunner;
  logger: SkillSyncTriggerLogger;
  minIntervalMs?: number;
  staleRunningMs?: number;
  inFlight?: Set<string>;
};

export type SkillSyncTriggerOrchestrator = {
  getRunnerForAdminRequest: (request: SkillSyncRequestLike) => GitHubSkillSyncRunner;
  maybeRunForRequest: (request: SkillSyncRequestLike) => Promise<boolean>;
};

function parseSkillSyncConfig(
  raw: unknown,
  logger: SkillSyncTriggerLogger,
): SkillSyncConfig | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const parsed = skillSyncConfigSchema.safeParse(raw);
  if (!parsed.success) {
    logger.warn('[GitHubSkillSync] Ignoring invalid skill sync config', {
      issues: parsed.error.flatten(),
    });
    return undefined;
  }
  return parsed.data;
}

function hasGitHubConfig(config: SkillSyncConfig | undefined): config is SkillSyncConfigWithGitHub {
  return Boolean(config?.github);
}

function isSameSkillSyncConfig(
  left: SkillSyncConfig | undefined,
  right: SkillSyncConfig | undefined,
) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function getRequestTenantId(user: SkillSyncRequestUser | undefined): string | undefined {
  return typeof user?.tenantId === 'string' && user.tenantId ? user.tenantId : undefined;
}

function withRequestTenant(
  config: SkillSyncConfigWithGitHub,
  user: SkillSyncRequestUser | undefined,
  { disableRunOnStartup = false }: { disableRunOnStartup?: boolean } = {},
): SkillSyncConfig {
  const tenantId = getRequestTenantId(user);
  return {
    ...config,
    github: {
      ...config.github,
      ...(disableRunOnStartup ? { runOnStartup: false } : {}),
      sources: config.github.sources.map((source) => ({
        ...source,
        // Tenant-scoped requests derive their tenant from the request; platform
        // requests have no tenant and preserve an explicitly configured source.
        tenantId: tenantId ?? source.tenantId,
      })),
    },
  };
}

function isSameGitHubSource(
  left: ResolvedGitHubSkillSyncConfig['sources'][number] | undefined,
  right: ResolvedGitHubSkillSyncConfig['sources'][number] | undefined,
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function withAdminReadableTenantScope(
  config: SkillSyncConfigWithGitHub,
  user: SkillSyncRequestUser | undefined,
  base: SkillSyncConfigWithGitHub | undefined,
): SkillSyncConfig {
  const tenantId = getRequestTenantId(user);
  const baseSourceById = new Map(base?.github.sources.map((source) => [source.id, source]) ?? []);
  const sources = tenantId
    ? config.github.sources.flatMap((source) => {
        const baseSource = baseSourceById.get(source.id);
        if (isSameGitHubSource(source, baseSource)) {
          if (source.tenantId && source.tenantId !== tenantId) {
            return [];
          }
          return [{ ...source, tenantId: source.tenantId ? tenantId : undefined }];
        }
        if (source.tenantId && source.tenantId !== tenantId) {
          return [];
        }
        return [{ ...source, tenantId }];
      })
    : [];
  return {
    ...config,
    github: {
      ...config.github,
      sources,
    },
  };
}

function getRequestSkillSyncConfig(
  appConfig: SkillSyncAppConfigLike | undefined,
  user: SkillSyncRequestUser | undefined,
  logger: SkillSyncTriggerLogger,
): SkillSyncConfig | undefined {
  const resolved = parseSkillSyncConfig(appConfig?.skillSync, logger);
  if (
    !hasGitHubConfig(resolved) ||
    !resolved.github.enabled ||
    resolved.github.sources.length === 0
  ) {
    return undefined;
  }

  const base = parseSkillSyncConfig(appConfig?.config?.skillSync, logger);
  if (isSameSkillSyncConfig(resolved, base)) {
    return undefined;
  }

  return withRequestTenant(resolved, user, { disableRunOnStartup: true });
}

function getAdminRequestSkillSyncConfig(
  appConfig: SkillSyncAppConfigLike | undefined,
  user: SkillSyncRequestUser | undefined,
  logger: SkillSyncTriggerLogger,
  { allowServerCredentials = false }: { allowServerCredentials?: boolean } = {},
): SkillSyncConfig | undefined {
  const resolved = parseSkillSyncConfig(appConfig?.skillSync, logger);
  if (!hasGitHubConfig(resolved)) {
    return resolved;
  }

  const base = parseSkillSyncConfig(appConfig?.config?.skillSync, logger);
  const baseWithGitHub = hasGitHubConfig(base) ? base : undefined;
  if (!allowServerCredentials) {
    return withAdminReadableTenantScope(resolved, user, baseWithGitHub);
  }
  if (isSameSkillSyncConfig(resolved, base)) {
    return resolved;
  }

  return withRequestTenant(resolved, user);
}

function toTimestamp(value: unknown): number {
  if (!value) {
    return 0;
  }
  if (value instanceof Date) {
    return value.getTime();
  }
  const parsed = Date.parse(String(value));
  return Number.isNaN(parsed) ? 0 : parsed;
}

function getLastAttemptAt(source: SkillSyncRunnerStatus['sources'][number]): number {
  return Math.max(
    toTimestamp(source.finishedAt),
    toTimestamp(source.startedAt),
    toTimestamp(source.updatedAt),
    toTimestamp(source.lastSuccessAt),
    toTimestamp(source.lastFailureAt),
  );
}

function shouldRunRequestSync(
  status: SkillSyncRunnerStatus,
  { minIntervalMs, staleRunningMs }: { minIntervalMs: number; staleRunningMs: number },
): boolean {
  if (!status.enabled || status.sources.length === 0) {
    return false;
  }
  const intervalMs = Math.max(minIntervalMs, (status.intervalMinutes ?? 60) * 60 * 1000);
  const now = Date.now();
  return status.sources.some((source) => {
    if (!source.credentialPresent) {
      return false;
    }
    if (source.status === 'running') {
      const startedAt = toTimestamp(source.startedAt);
      return Boolean(startedAt && now - startedAt >= staleRunningMs);
    }
    const lastAttemptAt = getLastAttemptAt(source);
    return !lastAttemptAt || now - lastAttemptAt >= intervalMs;
  });
}

function getRequestSyncKey(
  config: SkillSyncConfigWithGitHub,
  user: SkillSyncRequestUser | undefined,
) {
  const tenantId = user?.tenantId ?? '';
  const sources = config.github.sources
    .map((source) => source.id)
    .sort()
    .join(',');
  return `${tenantId}:${sources}`;
}

export function createSkillSyncTriggerOrchestrator(
  deps: SkillSyncTriggerOrchestratorDeps,
): SkillSyncTriggerOrchestrator {
  const inFlight = deps.inFlight ?? new Set<string>();
  const minIntervalMs = deps.minIntervalMs ?? REQUEST_SYNC_MIN_INTERVAL_MS;
  const staleRunningMs = deps.staleRunningMs ?? REQUEST_SYNC_STALE_RUNNING_MS;

  function getRunnerForAdminRequest(request: SkillSyncRequestLike): GitHubSkillSyncRunner {
    const allowServerCredentials = Boolean(request.skillSyncAllowServerCredentials);
    const config = getAdminRequestSkillSyncConfig(request.config, request.user, deps.logger, {
      allowServerCredentials,
    });
    return deps.createRunner({
      getConfig: async () => config,
      loadAppConfig: async () => request.config,
      allowServerCredentials,
    });
  }

  async function maybeRunForRequest(request: SkillSyncRequestLike): Promise<boolean> {
    const config = getRequestSkillSyncConfig(request.config, request.user, deps.logger);
    if (!hasGitHubConfig(config)) {
      return false;
    }

    const syncKey = getRequestSyncKey(config, request.user);
    if (inFlight.has(syncKey)) {
      return false;
    }

    const requestRunner = deps.createRunner({
      getConfig: async () => config,
      loadAppConfig: async () => request.config,
      allowServerCredentials: Boolean(request.skillSyncAllowServerCredentials),
    });
    const status = await requestRunner.getStatus();
    if (!shouldRunRequestSync(status, { minIntervalMs, staleRunningMs })) {
      return false;
    }

    inFlight.add(syncKey);
    void requestRunner
      .runOnce()
      .catch((error) => deps.logger.error('[GitHubSkillSync] Request-scoped sync failed:', error))
      .finally(() => inFlight.delete(syncKey));
    return true;
  }

  return {
    getRunnerForAdminRequest,
    maybeRunForRequest,
  };
}
