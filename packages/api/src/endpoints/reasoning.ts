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
  /** Returns the provider's model catalog (`GET {baseURL}/models`) as parsed JSON. */
  fetchCatalog: (params: { baseURL: string; apiKey: string }) => Promise<unknown>;
  cache: ReasoningCapabilityCache;
}

const catalogSchema = z.object({
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
});

function isOpenRouterHost(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return (
      host === `${KnownEndpoints.openrouter}.ai` ||
      host.endsWith(`.${KnownEndpoints.openrouter}.ai`)
    );
  } catch {
    return false;
  }
}

/** Per-model reasoning efforts out of a catalog; models without any are omitted. */
function parseCatalog(catalog: unknown): Record<string, TModelReasoning> | undefined {
  const parsed = catalogSchema.safeParse(catalog);
  if (!parsed.success) {
    return undefined;
  }
  const models: Record<string, TModelReasoning> = {};
  for (const { id, reasoning } of parsed.data.data) {
    const efforts = reasoning?.supported_efforts;
    if (efforts == null || efforts.length === 0) {
      continue;
    }
    models[id] = { efforts, mandatory: reasoning?.mandatory === true };
  }
  return models;
}

function cacheKey(baseURL: string, apiKey: string): string {
  const digest = crypto.createHash('sha256').update(`${baseURL}:${apiKey}`).digest('hex');
  return digest.slice(0, 32);
}

/**
 * Resolves which reasoning efforts each OpenRouter model accepts, for the
 * endpoints configured against OpenRouter. The catalog is fetched with the
 * administrator's key, never a user's, and is the same for every caller, so it
 * is cached by base URL and key and shared across users. A catalog that cannot
 * be fetched or read leaves its endpoints out of the result and is not cached,
 * so the next request retries; the client then keeps the generic effort list.
 */
export async function loadReasoningCapabilities(
  customEndpoints: TEndpoint[] | undefined,
  deps: ReasoningCapabilityDeps,
): Promise<TReasoningCapabilityMap> {
  const result: TReasoningCapabilityMap = {};
  const pending = new Map<string, Promise<Record<string, TModelReasoning> | undefined>>();

  const resolveCatalog = (baseURL: string, apiKey: string) => {
    const key = cacheKey(baseURL, apiKey);
    const existing = pending.get(key);
    if (existing != null) {
      return existing;
    }
    const lookup = (async () => {
      const cached = (await deps.cache.get(key)) as Record<string, TModelReasoning> | undefined;
      if (cached != null) {
        return cached;
      }
      try {
        const models = parseCatalog(await deps.fetchCatalog({ baseURL, apiKey }));
        if (models != null) {
          await deps.cache.set(key, models, Time.ONE_HOUR);
        }
        return models;
      } catch (error) {
        logger.warn('[loadReasoningCapabilities] Failed to load the OpenRouter model catalog', {
          baseURL,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return undefined;
      }
    })();
    pending.set(key, lookup);
    return lookup;
  };

  const resolved = (customEndpoints ?? []).flatMap((endpoint) => {
    const name = normalizeEndpointName(endpoint.name);
    const baseURL = resolveConfigSecret(endpoint.baseURL) ?? '';
    const apiKey = resolveConfigSecret(endpoint.apiKey) ?? '';
    if (!name || isUserProvided(baseURL) || isUserProvided(apiKey) || !isOpenRouterHost(baseURL)) {
      return [];
    }
    return [{ name, baseURL, apiKey }];
  });

  await Promise.all(
    resolved.map(async ({ name, baseURL, apiKey }) => {
      const models = await resolveCatalog(baseURL, apiKey);
      if (models != null) {
        result[name] = models;
      }
    }),
  );

  return result;
}

const reasoningCache = (): ReasoningCapabilityCache =>
  standardCache(CacheKeys.REASONING_CAPABILITIES, Time.ONE_HOUR);

async function fetchCatalog({
  baseURL,
  apiKey,
}: {
  baseURL: string;
  apiKey: string;
}): Promise<unknown> {
  const url = `${baseURL.replace(/\/+$/, '')}/models`;
  const options = applyAxiosProxyConfig(
    { headers: { Authorization: `Bearer ${apiKey}` }, timeout: 5000 },
    url,
  );
  return (await axios.get(url, options)).data;
}

/**
 * Per-model reasoning efforts for the OpenRouter endpoints in an app config,
 * wired to the real catalog fetch and cache. Callers in `/api` use this rather
 * than composing the dependencies themselves.
 */
export function getReasoningCapabilities(appConfig?: AppConfig): Promise<TReasoningCapabilityMap> {
  return loadReasoningCapabilities(
    (appConfig?.endpoints?.[EModelEndpoint.custom] ?? []) as TEndpoint[],
    { fetchCatalog, cache: reasoningCache() },
  );
}
