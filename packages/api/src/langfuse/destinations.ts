import { createHash } from 'node:crypto';
import { logger, type AppConfig } from '@librechat/data-schemas';
import {
  hasLangfuseEnvCredentials,
  isLangfuseFanoutEnabled,
  isLangfuseTenantExportEnabled,
  isLangfuseTracingEnabled,
  isLangfuseTraceSampled,
  usesLangfuseMultiTenantRouting,
} from './policy';
import {
  isTimeout,
  normalizeBoolean,
  redirectPolicyFor,
  resolveLangfuseHeaders,
  resolveTenantCredentials,
  toBasicAuthorization,
} from './utils';
import {
  allowsLangfuseCustomHeaders,
  hasAmbiguousLangfuseOrigins,
  resolveLangfuseTenantDestination,
} from './tenantDestinations';
import { mergeHeaders } from '~/utils/headers';
import { normalizeString } from '~/utils/text';
import { traceIdForMessage } from './trace';

const DEFAULT_BASE_URL = 'https://cloud.langfuse.com';
const PROJECT_LOOKUP_TIMEOUT_MS = 10_000;
const PROJECT_LOOKUP_RETRY_MS = 30_000;

/** Tells a lookup timeout apart from any other failure (a non-200 response, an
 *  unparsable body, or a network error other than the deadline firing), so a
 *  caller that needs to can report the two differently. */
export type CentralProjectIdLookupOutcome =
  | { ok: true; projectId: string }
  | { ok: false; timedOut: boolean };

type CentralProjectIdCacheEntry = {
  projectId?: string;
  lookup?: Promise<CentralProjectIdLookupOutcome>;
  retryAt: number;
  /** Why the lookup that opened the current retry window failed, so a caller
   *  hitting the window reports `timedOut` consistently with that failure
   *  instead of always reporting `false`. */
  retryReason?: 'timeout' | 'other';
};
const centralProjectIdCache = new Map<string, CentralProjectIdCacheEntry>();

/** Waits for the shared `lookup` for at most `timeoutMs`, without affecting the
 *  lookup itself: the local timer only decides what this call returns, and is
 *  always cleared, so the lookup keeps running — and still updates the cache
 *  entry and retry window on completion — for any other caller still waiting
 *  on it. */
async function waitWithTimeout(
  lookup: Promise<CentralProjectIdLookupOutcome>,
  timeoutMs: number,
): Promise<CentralProjectIdLookupOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const localTimeout = new Promise<CentralProjectIdLookupOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), timeoutMs);
  });
  try {
    return await Promise.race([lookup, localTimeout]);
  } finally {
    clearTimeout(timer);
  }
}

export type LangfuseScoreDestination = {
  id?: string;
  name: 'central' | 'tenant' | 'connection';
  baseUrl: string;
  authorization: string;
  /** Deployment proxy/gateway headers, merged beneath `Authorization`. */
  headers?: Record<string, string>;
};

export type LangfuseScoreDestinationOptions = {
  waitForCentralProjectId?: boolean;
  /**
   * Deployments that route traces per tenant may want a turn's spans to reach
   * only the tenant destination. Setting this false drops the central project
   * from resolution without disturbing tenant or connection destinations.
   */
  centralTraceExportEnabled?: boolean;
};

let warnedAmbiguousOrigins = false;

/** Drops the deployment's headers unless this destination is the one configured
 *  Langfuse origin — a run can resolve to several destinations, and only the
 *  intended one may receive the gateway credential. */
export function scopeHeadersToDestination(
  headers: Record<string, string> | undefined,
  baseUrl: string,
): Record<string, string> | undefined {
  if (headers == null) {
    return undefined;
  }
  if (allowsLangfuseCustomHeaders(baseUrl)) {
    return headers;
  }
  if (hasAmbiguousLangfuseOrigins() && !warnedAmbiguousOrigins) {
    warnedAmbiguousOrigins = true;
    logger.warn(
      '[langfuse] Not sending langfuse.headers: this deployment configures more than one Langfuse origin, and the headers do not say which one they authenticate to.',
    );
  }
  return undefined;
}

export function getLangfuseDestinationId(baseUrl: string, projectId: string): string {
  return createHash('sha256')
    .update(`${baseUrl.replace(/\/+$/, '')}\n${projectId}`)
    .digest('hex');
}

export function getCentralEnvBaseUrl(): string {
  return (
    normalizeString(process.env.LANGFUSE_BASE_URL) ??
    normalizeString(process.env.LANGFUSE_HOST) ??
    normalizeString(process.env.LANGFUSE_BASEURL) ??
    DEFAULT_BASE_URL
  );
}

/**
 * The deployment's own Langfuse project id for its env credentials, cached and
 * looked up at most once per retry window. `waitForLookup` awaits an in-flight
 * lookup instead of returning a not-ok outcome while it resolves, for a caller
 * that needs a definitive answer rather than best-effort warm cache data.
 * The underlying fetch always runs with the deployment-wide
 * `PROJECT_LOOKUP_TIMEOUT_MS`, and owns the cache entry and retry window exactly
 * as if `timeoutMs` were never passed. `timeoutMs` only bounds how long this
 * call itself waits for that shared fetch: when it elapses first, this call
 * returns `{ ok: false, timedOut: true }` without touching the cache entry or
 * retry window, and the shared fetch keeps running for any other waiter. A
 * lookup that genuinely fails inside the shared fetch — rather than this call
 * giving up on waiting for it — keeps reporting `timedOut` from that real
 * failure. A caller inside the retry window gets the reason recorded by the
 * failure that opened it. The outcome tells a lookup timeout apart from any
 * other failure, which `resolveCentralProjectId` collapses for callers that
 * only need the resolved id.
 */
export async function resolveCentralProjectIdOutcome(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  waitForLookup: boolean,
  headers?: Record<string, string>,
  timeoutMs: number = PROJECT_LOOKUP_TIMEOUT_MS,
): Promise<CentralProjectIdLookupOutcome> {
  const configuredProjectId = normalizeString(process.env.LANGFUSE_PROJECT_ID);
  if (configuredProjectId) {
    return { ok: true, projectId: configuredProjectId };
  }

  /** Headers participate in the key so the header-less module warm-up below
   *  cannot record a proxy rejection against the entry the request path
   *  (which does send them) later reads. */
  const cacheKey = createHash('sha256')
    .update(`${baseUrl}\n${publicKey}\n${secretKey}\n${JSON.stringify(headers ?? null)}`)
    .digest('hex');
  const cached = centralProjectIdCache.get(cacheKey) ?? { retryAt: 0 };
  centralProjectIdCache.set(cacheKey, cached);
  if (cached.projectId) {
    return { ok: true, projectId: cached.projectId };
  }

  if (!cached.lookup && Date.now() >= cached.retryAt) {
    cached.lookup = (async (): Promise<CentralProjectIdLookupOutcome> => {
      try {
        const response = await fetch(`${baseUrl}/api/public/projects`, {
          headers: mergeHeaders(headers, {
            Authorization: toBasicAuthorization(publicKey, secretKey),
          }),
          // Always the deployment-wide timeout: this lookup is shared by every
          // caller's cache entry, so it must not inherit the budget of whichever
          // caller happened to start it. A caller-specific bound is applied only
          // to that caller's own wait, below.
          signal: AbortSignal.timeout(PROJECT_LOOKUP_TIMEOUT_MS),
          ...redirectPolicyFor(headers),
        });
        if (!response.ok) {
          logger.warn(
            `[langfuse] Could not resolve central project identity: Langfuse responded with ${response.status}`,
          );
          return { ok: false, timedOut: false };
        }

        const projects: unknown = await response.json();
        const projectId =
          projects != null &&
          typeof projects === 'object' &&
          Array.isArray((projects as { data?: unknown }).data) &&
          (projects as { data: unknown[] }).data.length === 1 &&
          typeof (projects as { data: Array<{ id?: unknown }> }).data[0]?.id === 'string'
            ? (projects as { data: Array<{ id: string }> }).data[0].id.trim()
            : '';
        if (!projectId) {
          logger.warn(
            '[langfuse] Could not resolve central project identity from Langfuse response',
          );
          return { ok: false, timedOut: false };
        }
        return { ok: true, projectId };
      } catch (error) {
        logger.warn('[langfuse] Could not resolve central project identity:', error);
        return { ok: false, timedOut: isTimeout(error) };
      }
    })().then((outcome) => {
      cached.lookup = undefined;
      if (outcome.ok) {
        cached.projectId = outcome.projectId;
      } else {
        cached.retryAt = Date.now() + PROJECT_LOOKUP_RETRY_MS;
        cached.retryReason = outcome.timedOut ? 'timeout' : 'other';
      }
      return outcome;
    });
  }

  if (!cached.lookup) {
    // Inside the retry window a prior failure opened: report the reason that
    // failure recorded instead of always reporting `timedOut: false`, so
    // `/resolve` keeps mapping a timeout to 504 for the whole window.
    return { ok: false, timedOut: cached.retryReason === 'timeout' };
  }
  if (!waitForLookup) {
    return { ok: false, timedOut: false };
  }
  return waitWithTimeout(cached.lookup, timeoutMs);
}

/**
 * The string-or-undefined view of {@link resolveCentralProjectIdOutcome} for callers that
 * only need the resolved id and always use the default lookup timeout.
 */
export async function resolveCentralProjectId(
  baseUrl: string,
  publicKey: string,
  secretKey: string,
  waitForLookup: boolean,
  headers?: Record<string, string>,
): Promise<string | undefined> {
  const outcome = await resolveCentralProjectIdOutcome(
    baseUrl,
    publicKey,
    secretKey,
    waitForLookup,
    headers,
  );
  return outcome.ok ? outcome.projectId : undefined;
}

async function getCentralScoreDestination(
  waitForProjectId: boolean,
  headers?: Record<string, string>,
): Promise<LangfuseScoreDestination | undefined> {
  // Central feedback scores are sent directly by the app, not through the
  // collector, so they use LibreChat's normal central Langfuse credentials.
  // LANGFUSE_FANOUT_CENTRAL_AUTH_HEADER is intentionally collector-only.
  const publicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
  const secretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
  if (!publicKey || !secretKey) {
    return undefined;
  }

  const baseUrl = getCentralEnvBaseUrl();
  const scopedHeaders = scopeHeadersToDestination(headers, baseUrl);
  const projectId = await resolveCentralProjectId(
    baseUrl,
    publicKey,
    secretKey,
    waitForProjectId,
    scopedHeaders,
  );
  return {
    id: projectId ? getLangfuseDestinationId(baseUrl, projectId) : undefined,
    name: 'central',
    baseUrl,
    authorization: toBasicAuthorization(publicKey, secretKey),
    ...(scopedHeaders ? { headers: scopedHeaders } : {}),
  };
}

function getTenantScoreDestination(
  appConfig?: AppConfig,
  headers?: Record<string, string>,
): LangfuseScoreDestination | undefined {
  if (!isLangfuseTenantExportEnabled()) {
    return undefined;
  }

  const config = appConfig?.langfuse;
  if (normalizeBoolean(config?.enabled) !== true) {
    return undefined;
  }
  if (!isLangfuseFanoutEnabled()) {
    return undefined;
  }
  const fanoutCollectorUrl = normalizeString(process.env.LANGFUSE_FANOUT_COLLECTOR_URL);
  if (!fanoutCollectorUrl) {
    return undefined;
  }

  const tenantCredentials = resolveTenantCredentials(config);
  if (!tenantCredentials) {
    return undefined;
  }
  const destination = resolveLangfuseTenantDestination(config?.destination);
  if (!destination) {
    return undefined;
  }

  const scopedHeaders = scopeHeadersToDestination(headers, destination.baseUrl);
  return {
    id: config?.projectId
      ? getLangfuseDestinationId(destination.baseUrl, config.projectId)
      : undefined,
    name: 'tenant',
    baseUrl: destination.baseUrl,
    authorization: toBasicAuthorization(tenantCredentials.publicKey, tenantCredentials.secretKey),
    ...(scopedHeaders ? { headers: scopedHeaders } : {}),
  };
}

function getConfiguredScoreDestination(
  appConfig?: AppConfig,
  headers?: Record<string, string>,
): LangfuseScoreDestination | undefined {
  const config = appConfig?.langfuse;
  if (normalizeBoolean(config?.enabled) !== true) {
    return undefined;
  }

  const credentials = resolveTenantCredentials(config);
  const destination = resolveLangfuseTenantDestination(config?.destination);
  if (!credentials || !destination) {
    return undefined;
  }

  const scopedHeaders = scopeHeadersToDestination(headers, destination.baseUrl);
  return {
    id: config?.projectId
      ? getLangfuseDestinationId(destination.baseUrl, config.projectId)
      : undefined,
    name: 'connection',
    baseUrl: destination.baseUrl,
    authorization: toBasicAuthorization(credentials.publicKey, credentials.secretKey),
    ...(scopedHeaders ? { headers: scopedHeaders } : {}),
  };
}

/**
 * Scores use Langfuse's direct REST API. Multi-tenant score fanout follows the
 * collector availability gate used by traces; single-tenant connections send
 * directly to their configured destination.
 */
export async function getScoreDestinations(
  appConfig: AppConfig | undefined,
  traceId: string,
  sampled?: boolean,
  {
    waitForCentralProjectId = true,
    centralTraceExportEnabled = true,
  }: LangfuseScoreDestinationOptions = {},
): Promise<LangfuseScoreDestination[]> {
  if (
    !isLangfuseTracingEnabled() ||
    sampled === false ||
    (sampled == null && !isLangfuseTraceSampled(traceId))
  ) {
    return [];
  }

  const headers = resolveLangfuseHeaders(appConfig?.langfuse?.headers);

  if (!usesLangfuseMultiTenantRouting()) {
    /** Mirrors `resolveLangfuseExportPlan`: without fanout there is no tenant
     *  route to fall back on, so suppressing central export disables the trace
     *  outright. Capturing a destination here would let later feedback reach a
     *  project the trace never went to. */
    if (!centralTraceExportEnabled) {
      return [];
    }
    return hasLangfuseEnvCredentials()
      ? [await getCentralScoreDestination(waitForCentralProjectId, headers)].filter(
          (destination): destination is LangfuseScoreDestination => Boolean(destination),
        )
      : [getConfiguredScoreDestination(appConfig, headers)].filter(
          (destination): destination is LangfuseScoreDestination => Boolean(destination),
        );
  }

  const destinations = [
    centralTraceExportEnabled
      ? await getCentralScoreDestination(waitForCentralProjectId, headers)
      : undefined,
    getTenantScoreDestination(appConfig, headers),
  ].filter((destination): destination is LangfuseScoreDestination => Boolean(destination));
  const unique = new Map<string, LangfuseScoreDestination>();
  for (const destination of destinations) {
    const deduplicationKey = `${destination.baseUrl}\n${destination.authorization}`;
    const existing = unique.get(deduplicationKey);
    if (
      existing == null ||
      (existing.name === 'central' && destination.name !== 'central' && destination.id != null)
    ) {
      unique.set(deduplicationKey, destination);
    }
  }
  return [...unique.values()];
}

/**
 * Captures the concrete Langfuse projects eligible to receive a generated
 * trace. The opaque IDs let later feedback avoid newly configured or replaced
 * destinations without persisting credentials on the message.
 */
export async function getLangfuseTraceDestinationIds(
  appConfig: AppConfig | undefined,
  traceId: string,
  sampled?: boolean,
  {
    centralTraceExportEnabled = true,
  }: Pick<LangfuseScoreDestinationOptions, 'centralTraceExportEnabled'> = {},
): Promise<string[] | undefined> {
  const destinations = await getScoreDestinations(appConfig, traceId, sampled, {
    waitForCentralProjectId: false,
    centralTraceExportEnabled,
  });
  if (destinations.some(({ id }) => id == null)) {
    /** A tenant destination's `projectId` is optional, so an eligible project can
     *  have no stable id to record. `undefined` defers to whatever policy the
     *  feedback path resolves — an empty list would instead reject every
     *  destination, silently dropping feedback the tenant should receive.
     *  `sendFeedbackScore` must be given the same `centralTraceExportEnabled`
     *  for that deferral to honor a central opt-out. */
    return undefined;
  }
  return destinations.map(({ id }) => id as string);
}

/** The trace sampling record a response message stores. */
export type LangfuseTraceMessageFields = {
  langfuseSampled?: boolean;
  langfuseDestinationIds?: string[];
  langfuseRunId?: string;
};

/**
 * The sampling record a response stores for its run's trace. `runId` names the
 * run when it is not the response's own id, as for a failed turn's error row;
 * it is then stored too, so feedback and the trace viewer follow that run.
 */
export async function getLangfuseTraceMessageFields(
  appConfig: AppConfig | undefined,
  messageId: string,
  {
    centralTraceExportEnabled = true,
    runId = messageId,
  }: Pick<LangfuseScoreDestinationOptions, 'centralTraceExportEnabled'> & { runId?: string } = {},
): Promise<{
  langfuseSampled: boolean;
  langfuseDestinationIds?: string[];
  langfuseRunId?: string;
}> {
  const traceId = traceIdForMessage(runId);
  const langfuseSampled = isLangfuseTraceSampled(traceId);
  return {
    langfuseSampled,
    langfuseDestinationIds: await getLangfuseTraceDestinationIds(
      appConfig,
      traceId,
      langfuseSampled,
      { centralTraceExportEnabled },
    ),
    ...(runId !== messageId ? { langfuseRunId: runId } : {}),
  };
}

/**
 * The sampling record for a failed turn's error row, which keeps its own id and
 * so names the run that failed. A turn that failed before its run was created
 * has no trace to name, and a destination lookup that fails leaves the row
 * without one rather than failing the error write.
 */
export async function getFailedTurnTraceFields(
  appConfig: AppConfig | undefined,
  {
    messageId,
    runId,
    runCreated,
  }: { messageId: string; runId?: string | null; runCreated: boolean },
): Promise<LangfuseTraceMessageFields> {
  if (!runCreated || typeof runId !== 'string' || runId.length === 0) {
    return {};
  }
  try {
    return await getLangfuseTraceMessageFields(appConfig, messageId, { runId });
  } catch (error) {
    logger.warn('[langfuse] Could not record the failed run trace:', error);
    return {};
  }
}

const centralPublicKey = normalizeString(process.env.LANGFUSE_PUBLIC_KEY);
const centralSecretKey = normalizeString(process.env.LANGFUSE_SECRET_KEY);
if (centralPublicKey && centralSecretKey) {
  void resolveCentralProjectId(getCentralEnvBaseUrl(), centralPublicKey, centralSecretKey, false);
}
