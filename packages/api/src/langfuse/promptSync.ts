import { getTenantId } from '@librechat/data-schemas';
import type { TCustomConfig, TLangfusePromptErrorBody } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { LangfusePromptConnection, LangfusePromptRequestErrorCode } from './prompts';
import {
  resolveLangfusePromptConnection,
  resolveLangfusePromptMode,
  LangfusePromptRequestError,
} from './prompts';
import {
  getCentralEnvBaseUrl,
  resolveCentralProjectIdOutcome,
  scopeHeadersToDestination,
} from './destinations';
import { getLangfusePromptSyncTimeoutMs, isLangfusePromptSyncAvailable } from './policy';
import { resolveLangfuseTenantDestination } from './tenantDestinations';
import { resolveLangfuseHeaders } from './utils';
import { normalizeString } from '~/utils/text';

/** The minimal shape this module needs from a stored base config document —
 *  just its override tree — so this stays a plain structural type instead of
 *  the Mongoose `IConfig` document a caller such as `admin/langfuse.ts` reads
 *  it from. An `IConfig` satisfies this type and still type-checks as a
 *  caller. */
export type StoredBaseConfig = { overrides?: unknown };

/** Reads from the stored override tree, so this is `TCustomConfig`'s
 *  `DeepPartial` view of the section rather than the standalone
 *  `LangfuseConfig` — record-valued fields carry optional values here. */
export function readStoredLangfuse(config: StoredBaseConfig | null): TCustomConfig['langfuse'] {
  const overrides = config?.overrides as Partial<TCustomConfig> | undefined;
  return overrides?.langfuse;
}

/** The merged config a prompt-sync request resolves against: deployment/yaml-only
 *  fields such as `headers` come from `appConfig`, while the tenant-owned fields
 *  (destination, keys, `projectId`) come from `stored`, so a caller that reads
 *  from the same merged document never pairs a rotated destination with a stale
 *  credential from another instance's config cache. `buildPromptSyncConnection`
 *  and `getPromptSyncSourceIdentity` both build this merge, so the connection a
 *  request reads from and the identity recorded for it always describe the same
 *  project. */
function mergeLangfuseConfig(
  appConfig: AppConfig | undefined,
  stored: TCustomConfig['langfuse'],
): AppConfig {
  return { ...appConfig, langfuse: { ...appConfig?.langfuse, ...stored } } as AppConfig;
}

export function buildPromptSyncConnection(
  appConfig: AppConfig | undefined,
  stored: TCustomConfig['langfuse'],
  tenantId: string | undefined,
): LangfusePromptConnection | null {
  return resolveLangfusePromptConnection(mergeLangfuseConfig(appConfig, stored), { tenantId });
}

/** HTTP status for a `LangfusePromptRequestError`. A Langfuse `unauthorized`
 *  never maps to 401/403: the LibreChat client treats either as its own
 *  session expiring and reacts by refreshing the token or signing out. */
function promptRequestErrorStatus(code: LangfusePromptRequestErrorCode): number {
  return code === 'timeout' ? 504 : 502;
}

/** Maps a thrown `LangfusePromptRequestError` to the stable `{ status, body }`
 *  contract. Never forwards the upstream body, headers or credentials; the
 *  caller logs only the error's own code/status/message, which `prompts.ts`
 *  guarantees are free of secrets. */
export function toLangfusePromptErrorResponse(error: LangfusePromptRequestError): {
  status: number;
  body: TLangfusePromptErrorBody;
} {
  const body: TLangfusePromptErrorBody =
    error.code === 'upstream' && error.status != null
      ? { code: error.code, status: error.status }
      : { code: error.code };
  return { status: promptRequestErrorStatus(error.code), body };
}

export type LangfusePromptSyncSourceIdentity = {
  destination: string;
  projectId: string;
};

/**
 * The complete source identity for a Langfuse-origin prompt group's content read:
 * the connection's destination key and project id. Returns `null` when the
 * identity is not configured — tenant mode with no resolvable destination or no
 * stored project id — rather than an incomplete identity; the resolver maps that
 * `null` to `{ ok: false, reason: 'not_configured' }`.
 *
 * Builds from the same merged config `buildPromptSyncConnection` reads
 * (`mergeLangfuseConfig`) and picks its branch from the same
 * `resolveLangfusePromptMode` decision, so the two can never name different
 * projects for the same request: a tenant connection's identity is its
 * normalized `destination` key and stored `projectId`. Without tenant
 * credentials, prompt reads use the deployment's env project instead
 * (`resolveLangfusePromptConnection` in `./prompts`). `'env'` names that mode,
 * and its project id is looked up the same way `destinations.ts` resolves one
 * for env credentials, scoped with the same headers the connection would send —
 * a network call the first time, which is why this function is async. Env mode
 * with no usable env credentials throws `LangfusePromptRequestError('upstream')`
 * rather than returning an incomplete identity, so that case never reads as
 * `source_changed`. A lookup that cannot resolve a project id throws too, as
 * `'timeout'` when the lookup itself timed out and `'upstream'` for any other
 * failure. `timeoutMs` bounds only this call's wait for that lookup — it
 * defaults to the deployment's 10-second project-lookup timeout, which is too
 * long for a prompt-sync request — pass `getLangfusePromptSyncTimeoutMs()`, or
 * inject it the way `createLangfuseSourceResolver` does, so a slow lookup is
 * reported as `'timeout'` within the prompt-sync budget instead of the longer
 * one. The identity lookup's wait and the later prompt fetch
 * (`getLangfuseTextPrompt`) are each bounded by that same prompt-sync timeout,
 * so the Langfuse part of `/resolve` takes at most about twice that timeout,
 * plus the config reads around them.
 */
export async function getPromptSyncSourceIdentity(
  appConfig: AppConfig | undefined,
  stored: TCustomConfig['langfuse'],
  tenantId: string | undefined,
  timeoutMs?: number,
): Promise<LangfusePromptSyncSourceIdentity | null> {
  const merged = mergeLangfuseConfig(appConfig, stored);
  if (resolveLangfusePromptMode(tenantId) === 'tenant') {
    const destination = resolveLangfuseTenantDestination(merged.langfuse?.destination);
    const projectId = merged.langfuse?.projectId;
    if (!destination?.key || !projectId) {
      return null;
    }
    return { destination: destination.key, projectId };
  }

  const publicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
  if (!publicKey || !secretKey) {
    throw new LangfusePromptRequestError(
      'upstream',
      'Could not resolve the Langfuse project for the env connection',
    );
  }

  const baseUrl = getCentralEnvBaseUrl();
  const headers = scopeHeadersToDestination(
    resolveLangfuseHeaders(merged.langfuse?.headers),
    baseUrl,
  );
  const outcome = await resolveCentralProjectIdOutcome(
    baseUrl,
    publicKey,
    secretKey,
    true,
    headers,
    timeoutMs,
  );
  if (!outcome.ok) {
    throw new LangfusePromptRequestError(
      outcome.timedOut ? 'timeout' : 'upstream',
      outcome.timedOut
        ? 'Timed out resolving the Langfuse project for the env connection'
        : 'Could not resolve the Langfuse project for the env connection',
    );
  }
  return { destination: 'env', projectId: outcome.projectId };
}

export type LangfuseSourceGroup = {
  tenantId?: string;
  sourceDestination?: string;
  sourceProjectId?: string;
};

export type LangfuseSourceResolution =
  | { ok: true; connection: LangfusePromptConnection }
  | { ok: false; reason: 'disabled' | 'not_configured' | 'source_changed' };

export interface CreateLangfuseSourceResolverDeps {
  findBaseConfig: () => Promise<StoredBaseConfig | null>;
  getAppConfig: (options?: { tenantId?: string }) => Promise<AppConfig>;
  /** Bounds the env-mode project lookup inside `getPromptSyncSourceIdentity`.
   *  Defaults to the prompt-sync timeout, so a slow lookup fails as `timeout`
   *  within that budget instead of the longer deployment-wide lookup timeout. */
  getTimeoutMs?: () => number;
}

/**
 * Resolves a Langfuse-origin prompt group to the connection its content read
 * should use, re-reading the stored config on every call — nothing here is
 * cached. Checked in order: the deployment gate, the group's tenant against
 * the active request's tenant, the tenant's own prompt-sync switch, whether a
 * connection can be built at all, whether a complete source identity can be
 * resolved for it, and finally whether the group's recorded source identity
 * still matches the one the connection would read from. The stored base
 * config and `getAppConfig({ tenantId })` are read concurrently — not series
 * — because the prompt-sync switch lives only in the stored config: a
 * disabled tenant returns `{ ok: false, reason: 'disabled' }` without ever
 * surfacing a `getAppConfig` rejection as an unhandled one.
 */
export function createLangfuseSourceResolver({
  findBaseConfig,
  getAppConfig,
  getTimeoutMs = getLangfusePromptSyncTimeoutMs,
}: CreateLangfuseSourceResolverDeps): (
  group: LangfuseSourceGroup,
) => Promise<LangfuseSourceResolution> {
  return async function resolveLangfuseSource(
    group: LangfuseSourceGroup,
  ): Promise<LangfuseSourceResolution> {
    if (!isLangfusePromptSyncAvailable()) {
      return { ok: false, reason: 'disabled' };
    }
    if (group.tenantId !== getTenantId()) {
      return { ok: false, reason: 'not_configured' };
    }

    const [baseConfigResult, appConfigResult] = await Promise.allSettled([
      findBaseConfig(),
      getAppConfig({ tenantId: group.tenantId }),
    ]);
    if (baseConfigResult.status === 'rejected') {
      throw baseConfigResult.reason;
    }

    const stored = readStoredLangfuse(baseConfigResult.value);
    if (stored?.promptSync?.enabled !== true) {
      return { ok: false, reason: 'disabled' };
    }
    if (appConfigResult.status === 'rejected') {
      throw appConfigResult.reason;
    }

    const appConfig = appConfigResult.value;
    const connection = buildPromptSyncConnection(appConfig, stored, group.tenantId);
    if (!connection) {
      return { ok: false, reason: 'not_configured' };
    }

    const identity = await getPromptSyncSourceIdentity(
      appConfig,
      stored,
      group.tenantId,
      getTimeoutMs(),
    );
    if (!identity) {
      return { ok: false, reason: 'not_configured' };
    }
    const sourceMatches =
      group.sourceDestination === identity.destination &&
      group.sourceProjectId === identity.projectId;
    if (!sourceMatches) {
      return { ok: false, reason: 'source_changed' };
    }

    return { ok: true, connection };
  };
}
