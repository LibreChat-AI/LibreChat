import { z } from 'zod';
import axios from 'axios';
import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  Time,
  CacheKeys,
  EModelEndpoint,
  KnownEndpoints,
  normalizeEndpointName,
  getModelReasoning,
  effectiveModelReasoning,
  isOpenRouterEffortSupported,
} from 'librechat-data-provider';
import type { TEndpoint, TModelReasoning, TReasoningCapabilityMap } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { isUserProvided, applyAxiosProxyConfig } from '~/utils';
import { resolveConfigSecret } from '~/admin/secrets';
import { standardCache } from '~/cache';

/** The slice of a keyed cache this module needs. */
export interface ReasoningCapabilityCache {
  get: (key: string) => Promise<unknown>;
  set: (key: string, value: unknown, ttl?: number) => Promise<unknown>;
}

export interface ReasoningCapabilityDeps {
  /** Returns one page of the provider's model catalog as parsed JSON. */
  fetchPage: (params: { url: string; apiKey: string; timeoutMs: number }) => Promise<unknown>;
  cache: ReasoningCapabilityCache;
}

/** Applies when an endpoint does not set `customParams.reasoningCatalogTimeoutMs`. */
const DEFAULT_CATALOG_TIMEOUT_MS = 5000;

/** A catalog this long is treated as unreadable rather than walked indefinitely. */
const MAX_CATALOG_PAGES = 20;

const pageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string(),
      reasoning: z
        .object({
          supported_efforts: z.array(z.string()).optional(),
          mandatory: z.boolean().optional(),
        })
        .optional()
        .catch(undefined),
    }),
  ),
  links: z.object({ next: z.string().nullable().optional() }).optional().catch(undefined),
});

type CatalogModels = Record<string, TModelReasoning>;

function isOpenRouterHost(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    const openRouterHost = `${KnownEndpoints.openrouter}.ai`;
    return host === openRouterHost || host.endsWith(`.${openRouterHost}`);
  } catch {
    return false;
  }
}

function cacheKey(baseURL: string, apiKey: string): string {
  const digest = crypto.createHash('sha256').update(`${baseURL}:${apiKey}`).digest('hex');
  return digest.slice(0, 32);
}

/**
 * Reads every page of a model catalog, following `links.next` on the provider's own host.
 * A page that cannot be read, a link that leaves the host or revisits a page, or a catalog
 * longer than {@link MAX_CATALOG_PAGES} makes the whole catalog unavailable: serving part of
 * it would hide the controls of every model on the pages not read.
 */
async function readCatalog(
  baseURL: string,
  apiKey: string,
  timeoutMs: number,
  deps: ReasoningCapabilityDeps,
): Promise<CatalogModels | undefined> {
  const models: CatalogModels = {};
  const origin = new URL(baseURL).origin;
  const seen = new Set<string>();
  let url: string | null = `${baseURL.replace(/\/+$/, '')}/models`;

  while (url != null) {
    if (seen.has(url) || seen.size >= MAX_CATALOG_PAGES) {
      return undefined;
    }
    seen.add(url);
    const parsed = pageSchema.safeParse(await deps.fetchPage({ url, apiKey, timeoutMs }));
    if (!parsed.success) {
      return undefined;
    }
    for (const { id, reasoning } of parsed.data.data) {
      const efforts = reasoning?.supported_efforts;
      if (efforts != null && efforts.length > 0) {
        models[id] = { efforts, mandatory: reasoning?.mandatory === true };
      }
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

type ResolvedTarget = { name: string; baseURL: string; apiKey: string; timeoutMs: number };

/** The endpoint's catalog target, or nothing when it is not an OpenRouter endpoint with admin credentials. */
function resolveTarget(endpoint: TEndpoint): ResolvedTarget | undefined {
  const name = normalizeEndpointName(endpoint.name);
  const baseURL = resolveConfigSecret(endpoint.baseURL) ?? '';
  const apiKey = resolveConfigSecret(endpoint.apiKey) ?? '';
  if (!name || isUserProvided(baseURL) || isUserProvided(apiKey) || !isOpenRouterHost(baseURL)) {
    return undefined;
  }
  return {
    name,
    baseURL,
    apiKey,
    timeoutMs: endpoint.customParams?.reasoningCatalogTimeoutMs ?? DEFAULT_CATALOG_TIMEOUT_MS,
  };
}

/** One lookup per base URL and key, cached and shared; `undefined` when the catalog is unavailable. */
function createCatalogResolver(deps: ReasoningCapabilityDeps) {
  const pending = new Map<string, Promise<CatalogModels | undefined>>();
  return (target: ResolvedTarget): Promise<CatalogModels | undefined> => {
    const key = cacheKey(target.baseURL, target.apiKey);
    const existing = pending.get(key);
    if (existing != null) {
      return existing;
    }
    const lookup = (async () => {
      const cached = (await deps.cache.get(key)) as CatalogModels | undefined;
      if (cached != null) {
        return cached;
      }
      try {
        const models = await readCatalog(target.baseURL, target.apiKey, target.timeoutMs, deps);
        if (models != null) {
          await deps.cache.set(key, models, Time.ONE_HOUR);
        }
        return models;
      } catch (error) {
        logger.warn('[reasoning] Failed to load the OpenRouter model catalog', {
          baseURL: target.baseURL,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return undefined;
      }
    })();
    pending.set(key, lookup);
    return lookup;
  };
}

/**
 * Resolves which reasoning efforts each OpenRouter model accepts, for the
 * endpoints configured against OpenRouter. The catalog is fetched with the
 * administrator's key, never a user's, and is the same for every caller, so it
 * is cached by base URL and key and shared across users. A catalog that cannot
 * be fetched or read leaves its endpoints out of the result and is not cached,
 * so the next request retries; callers then keep the generic effort list.
 */
export async function loadReasoningCapabilities(
  customEndpoints: TEndpoint[] | undefined,
  deps: ReasoningCapabilityDeps,
): Promise<TReasoningCapabilityMap> {
  const result: TReasoningCapabilityMap = {};
  const resolveCatalog = createCatalogResolver(deps);
  const targets = (customEndpoints ?? []).flatMap((endpoint) => resolveTarget(endpoint) ?? []);

  await Promise.all(
    targets.map(async (target) => {
      const models = await resolveCatalog(target);
      if (models != null) {
        result[target.name] = models;
      }
    }),
  );

  return result;
}

/**
 * Drops a stored `reasoning_effort` the selected OpenRouter model does not accept, so a
 * conversation or agent saved on another model cannot send a request the provider rejects.
 * Auto sends no effort and is kept, as is everything while the catalog is unavailable, and
 * an effort the administrator defined for the endpoint. Only a request that stores an effort
 * on an OpenRouter endpoint reads the catalog.
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
  if (typeof effort !== 'string' || effort === '' || typeof model !== 'string') {
    return modelOptions;
  }
  const target = resolveTarget(endpoint);
  if (target == null) {
    return modelOptions;
  }
  const models = await createCatalogResolver(deps)(target);
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
 * Per-model reasoning efforts for the OpenRouter endpoints in an app config,
 * wired to the real catalog fetch and cache.
 */
export function getReasoningCapabilities(appConfig?: AppConfig): Promise<TReasoningCapabilityMap> {
  return loadReasoningCapabilities(
    (appConfig?.endpoints?.[EModelEndpoint.custom] ?? []) as TEndpoint[],
    getReasoningCapabilityDeps(),
  );
}
