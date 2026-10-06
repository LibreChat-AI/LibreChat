import { z } from 'zod';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  Time,
  CacheKeys,
  ReasoningEffort,
  EModelEndpoint,
  normalizeEndpointName,
  getModelReasoning,
  effectiveModelReasoning,
  isOpenRouterEffortSupported,
} from 'librechat-data-provider';
import type { TEndpoint, TModelReasoning } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type {
  ReasoningCapabilityDeps,
  ReasoningCapabilityCache,
  ReasoningCapabilityResult,
} from '~/types';
import { usesOpenRouterCatalog } from '~/endpoints/custom/config';
import { isUserProvided, applyAxiosProxyConfig } from '~/utils';
import { resolveConfigSecret } from '~/admin/secrets';
import { standardCache } from '~/cache';

/** Applies when an endpoint does not set `customParams.reasoningCatalogTimeoutMs`. */
const DEFAULT_CATALOG_TIMEOUT_MS = 5000;

/** Applies when an endpoint does not set `customParams.reasoningCatalogFailureTtlMs`. */
const DEFAULT_CATALOG_FAILURE_TTL_MS = 30000;

/** Applies when an endpoint does not set `customParams.reasoningCatalogTtlMs`. */
const DEFAULT_CATALOG_TTL_MS = Time.ONE_HOUR;

/** Applies when an endpoint does not set `customParams.reasoningCatalogMaxPages`. */
const DEFAULT_CATALOG_MAX_PAGES = 20;

const reasoningSchema = z.object({
  supported_efforts: z.array(z.string()).nullable().optional(),
  mandatory: z.boolean().optional(),
});

const pageSchema = z.object({
  data: z.array(z.object({ id: z.string(), reasoning: z.unknown().optional() })),
  links: z.object({ next: z.string().nullable().optional() }).optional().catch(undefined),
});

/** Models whose reasoning depends on the route a request takes, so no fixed efforts exist. */
const isDynamicRouterModel = (id: string): boolean => id.startsWith('openrouter/');

type CatalogModels = Record<string, TModelReasoning>;

/**
 * OpenRouter's `supported_efforts: null` means no allowlist applies and every gateway effort
 * is accepted; an omitted field, or an omitted `reasoning` object, means the model exposes no
 * effort selection at all, which is recorded as an empty list. A `reasoning` object that does not
 * parse leaves the model unknown instead.
 */
const UNRESTRICTED_EFFORTS: string[] = Object.values(ReasoningEffort).filter(
  (effort) => effort !== ReasoningEffort.unset,
);

/**
 * Identity of a catalog lookup: the endpoint and the limits that decide its outcome. Two
 * endpoints sharing a base URL and key but configuring different page or time limits must
 * not share a result, or the first one's limits would govern both.
 */
function cacheKey({
  baseURL,
  apiKey,
  timeoutMs,
  maxPages,
  failureTtlMs,
  ttlMs,
}: ResolvedTarget): string {
  const identity = JSON.stringify([baseURL, apiKey, timeoutMs, maxPages, failureTtlMs, ttlMs]);
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}

/** The scheme and host of a configured URL: never its credentials, path or query. */
function safeOrigin(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return 'invalid-url';
  }
}

/** The `/models` URL of an API base, with `/models` on the path and any query kept in place. */
function catalogURL(baseURL: string): string {
  const url = new URL(baseURL);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/models`;
  return url.toString();
}

/**
 * Reads every page of a model catalog, following `links.next` on the provider's own host.
 * A page that cannot be read, a link that leaves the host or revisits a page, or a catalog
 * longer than the endpoint's page limit makes the whole catalog unavailable: serving part of
 * it would hide the controls of every model on the pages not read.
 */
async function readCatalog(
  target: ResolvedTarget,
  deps: ReasoningCapabilityDeps,
): Promise<CatalogModels | undefined> {
  const { baseURL, apiKey, timeoutMs, maxPages } = target;
  const models: CatalogModels = {};
  const origin = new URL(baseURL).origin;
  const seen = new Set<string>();
  let url: string | null = catalogURL(baseURL);

  while (url != null) {
    if (seen.has(url) || seen.size >= maxPages) {
      return undefined;
    }
    seen.add(url);
    const parsed = pageSchema.safeParse(await deps.fetchPage({ url, apiKey, timeoutMs }));
    if (!parsed.success) {
      return undefined;
    }
    for (const { id, reasoning } of parsed.data.data) {
      if (isDynamicRouterModel(id)) {
        continue;
      }
      if (reasoning == null) {
        models[id] = { efforts: [] };
        continue;
      }
      const details = reasoningSchema.safeParse(reasoning);
      if (!details.success) {
        continue;
      }
      const reported = details.data.supported_efforts;
      const efforts = reported === null ? UNRESTRICTED_EFFORTS : (reported ?? []);
      models[id] =
        efforts.length === 0
          ? { efforts: [] }
          : { efforts, mandatory: details.data.mandatory === true };
    }
    const next: string | null | undefined = parsed.data.links?.next;
    if (next == null || next === '') {
      return models;
    }
    const nextURL = new URL(next, origin);
    if (nextURL.origin !== origin) {
      return undefined;
    }
    url = nextURL.toString();
  }
  return models;
}

type ResolvedTarget = {
  name: string;
  baseURL: string;
  apiKey: string;
  timeoutMs: number;
  maxPages: number;
  failureTtlMs: number;
  ttlMs: number;
};

/**
 * The endpoint's catalog target, or nothing when it does not use the OpenRouter catalog (see
 * {@link usesOpenRouterCatalog}) or has no administrator credentials. A `directEndpoint` is skipped:
 * its base URL is the exact inference URL, so `/models` cannot be derived from it. So is an endpoint
 * that pins its model through `addParams.model`: every request goes to that one model, so the efforts
 * of the model a user selected say nothing about what is sent, and narrowing by them would be wrong.
 */
function resolveTarget(endpoint: TEndpoint): ResolvedTarget | undefined {
  if (endpoint.directEndpoint === true || typeof endpoint.addParams?.model === 'string') {
    return undefined;
  }
  const name = normalizeEndpointName(endpoint.name);
  const baseURL = resolveConfigSecret(endpoint.baseURL) ?? '';
  const apiKey = resolveConfigSecret(endpoint.apiKey) ?? '';
  if (
    !name ||
    isUserProvided(baseURL) ||
    isUserProvided(apiKey) ||
    !usesOpenRouterCatalog(endpoint, baseURL)
  ) {
    return undefined;
  }
  return {
    name,
    baseURL,
    apiKey,
    timeoutMs: endpoint.customParams?.reasoningCatalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
    maxPages: endpoint.customParams?.reasoningCatalogMaxPages ?? DEFAULT_CATALOG_MAX_PAGES,
    failureTtlMs:
      endpoint.customParams?.reasoningCatalogFailureTtlMs ?? DEFAULT_CATALOG_FAILURE_TTL_MS,
    ttlMs: endpoint.customParams?.reasoningCatalogTtlMs ?? DEFAULT_CATALOG_TTL_MS,
  };
}

/** Where a recent failed lookup is remembered, beside the entry a successful one fills. */
const failureKey = (key: string): string => `${key}:failed`;

/**
 * Lookups in progress, by base URL and key. Held at module scope so concurrent requests,
 * from any caller and any user, share one catalog walk instead of each issuing their own
 * when the cache is cold or has just expired. An entry is removed once it settles; a failure is
 * then remembered for `reasoningCatalogFailureTtlMs` so it is retried after that, not per call.
 */
const inFlight = new Map<string, Promise<CatalogModels | undefined>>();

/** One cached, shared lookup per base URL and key; `undefined` when the catalog is unavailable. */
function resolveCatalog(
  target: ResolvedTarget,
  deps: ReasoningCapabilityDeps,
): Promise<CatalogModels | undefined> {
  const key = cacheKey(target);
  const existing = inFlight.get(key);
  if (existing != null) {
    return existing;
  }
  const lookup = (async () => {
    const cached = (await deps.cache.get(key)) as CatalogModels | undefined;
    if (cached != null) {
      return cached;
    }
    /** A recent failure is not retried: the middleware and the endpoint initializer of one
     *  request, and the requests that follow it, would otherwise each wait out the timeout. */
    if (target.failureTtlMs > 0 && (await deps.cache.get(failureKey(key))) != null) {
      return undefined;
    }
    let models: CatalogModels | undefined;
    try {
      models = await readCatalog(target, deps);
    } catch (error) {
      logger.warn('[reasoning] Failed to load the OpenRouter model catalog', {
        origin: safeOrigin(target.baseURL),
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
    if (models != null) {
      await deps.cache.set(key, models, target.ttlMs);
    } else if (target.failureTtlMs > 0) {
      await deps.cache.set(failureKey(key), true, target.failureTtlMs);
    }
    return models;
  })().finally(() => inFlight.delete(key));
  inFlight.set(key, lookup);
  return lookup;
}

/**
 * Resolves which reasoning efforts each OpenRouter model accepts, for the
 * endpoints configured against OpenRouter. The catalog is fetched with the
 * administrator's key, never a user's, and is the same for every caller, so it
 * is cached by base URL and key and shared across users. A catalog that cannot
 * be fetched or read is reported in `unavailable`, never as an endpoint without
 * reasoning, and is not cached, so the next request retries. `only` limits the result to one
 * endpoint, so one endpoint's outage does not hide another's data.
 */
export async function loadReasoningCapabilities(
  customEndpoints: TEndpoint[] | undefined,
  deps: ReasoningCapabilityDeps,
  only?: string,
): Promise<ReasoningCapabilityResult> {
  const wanted = only == null ? undefined : normalizeEndpointName(only);
  const targets = (customEndpoints ?? []).flatMap((endpoint) => {
    const target = resolveTarget(endpoint);
    return target != null && (wanted == null || target.name === wanted) ? [target] : [];
  });
  const catalogs = await Promise.all(targets.map((target) => resolveCatalog(target, deps)));

  const result: ReasoningCapabilityResult = { capabilities: {}, unavailable: [] };
  targets.forEach(({ name }, index) => {
    const models = catalogs[index];
    if (models == null) {
      result.unavailable.push(name);
    } else {
      result.capabilities[name] = models;
    }
  });
  return result;
}

/**
 * Drops a stored `reasoning_effort` the selected OpenRouter model does not accept, so a
 * conversation or agent saved on another model cannot send a request the provider rejects.
 * Auto sends no effort and is kept, as is everything while the catalog is unavailable, and
 * an effort the administrator defined for the endpoint, including one set through
 * `addParams`, which replaces the stored value outright. An endpoint that pins its model
 * through `addParams.model` is not checked (see {@link resolveTarget}). Only a request that
 * stores an effort on an eligible OpenRouter endpoint reads the catalog.
 */
export async function withSupportedEffort<T extends object>(
  modelOptions: T,
  endpoint: TEndpoint,
  deps: ReasoningCapabilityDeps,
): Promise<T> {
  const { model, reasoning_effort: effort } = modelOptions as {
    model?: unknown;
    reasoning_effort?: unknown;
  };
  if (
    typeof effort !== 'string' ||
    effort === '' ||
    typeof model !== 'string' ||
    endpoint.addParams?.reasoning_effort !== undefined
  ) {
    return modelOptions;
  }
  const target = resolveTarget(endpoint);
  if (target == null) {
    return modelOptions;
  }
  const models = await resolveCatalog(target, deps);
  const modelReasoning = effectiveModelReasoning(
    getModelReasoning(models == null ? undefined : { [target.name]: models }, target.name, model),
    endpoint.customParams?.paramDefinitions,
  );
  if (isOpenRouterEffortSupported(effort, modelReasoning)) {
    return modelOptions;
  }
  const rest = { ...modelOptions } as T & { reasoning_effort?: unknown };
  delete rest.reasoning_effort;
  return rest;
}

const reasoningCache = (): ReasoningCapabilityCache =>
  standardCache(CacheKeys.REASONING_CAPABILITIES, Time.ONE_HOUR);

async function fetchPage({
  url,
  apiKey,
  timeoutMs,
}: {
  url: string;
  apiKey: string;
  timeoutMs: number;
}): Promise<unknown> {
  const options = applyAxiosProxyConfig(
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: timeoutMs },
    url,
  );
  return (await axios.get(url, options)).data;
}

/** The dependencies the server uses; callers in `/api` and the endpoint initializers share them. */
export function getReasoningCapabilityDeps(): ReasoningCapabilityDeps {
  return { fetchPage, cache: reasoningCache() };
}

/**
 * Per-model reasoning efforts for the OpenRouter endpoints in an app config, or for the one
 * named by `endpoint`, wired to the real catalog fetch and cache.
 */
export function getReasoningCapabilities(
  appConfig?: AppConfig,
  endpoint?: string,
): Promise<ReasoningCapabilityResult> {
  return loadReasoningCapabilities(
    (appConfig?.endpoints?.[EModelEndpoint.custom] ?? []) as TEndpoint[],
    getReasoningCapabilityDeps(),
    endpoint,
  );
}
