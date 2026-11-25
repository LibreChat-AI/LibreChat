import {
  AuthType,
  SafeSearchTypes,
  extractVariableName,
  normalizeSearxngEngines,
} from 'librechat-data-provider';
import type { TCustomConfig, TWebSearchConfigInput } from 'librechat-data-provider';
import type { TWebSearchKeys, TWebSearchCategories } from '~/types/web';

export const webSearchAuth = {
  providers: {
    serper: {
      serperApiKey: 1 as const,
    },
    searxng: {
      searxngInstanceUrl: 1 as const,
      /** Optional (0) */
      searxngApiKey: 0 as const,
    },
    tavily: {
      tavilyApiKey: 1 as const,
      tavilySearchUrl: 0 as const,
    },
    keenable: {
      /** Optional (0) — Keenable works keyless; a key only lifts rate limits */
      keenableApiKey: 0 as const,
      keenableApiUrl: 0 as const,
    },
  },
  scrapers: {
    firecrawl: {
      firecrawlApiKey: 1 as const,
      /** Optional (0) */
      firecrawlApiUrl: 0 as const,
      firecrawlVersion: 0 as const,
    },
    serper: {
      serperApiKey: 1 as const,
    },
    tavily: {
      tavilyApiKey: 1 as const,
      tavilyExtractUrl: 0 as const,
    },
    keenable: {
      /** Optional (0) — Keenable's page fetch is keyless as well; a key only
       * lifts rate limits. The fetch endpoint itself is overridden with the
       * `KEENABLE_FETCH_URL` env var, not through this config. */
      keenableApiKey: 0 as const,
    },
  },
  rerankers: {
    jina: {
      jinaApiKey: 1 as const,
      /** Optional (0) */
      jinaApiUrl: 0 as const,
    },
    cohere: { cohereApiKey: 1 as const },
  },
};

/**
 * Extracts all unique API keys from the webSearchAuth configuration object
 */
export function getWebSearchKeys(): TWebSearchKeys[] {
  const keysSet = new Set<TWebSearchKeys>();

  // Iterate through each category (providers, scrapers, rerankers)
  for (const category of Object.keys(webSearchAuth)) {
    const categoryObj = webSearchAuth[category as TWebSearchCategories];

    // Iterate through each service within the category
    for (const service of Object.keys(categoryObj)) {
      const serviceObj = categoryObj[service as keyof typeof categoryObj];

      // Extract the API keys from the service and add to set for deduplication
      for (const key of Object.keys(serviceObj)) {
        keysSet.add(key as TWebSearchKeys);
      }
    }
  }

  return Array.from(keysSet);
}

export const webSearchKeys: TWebSearchKeys[] = getWebSearchKeys();

/** Each configurable service URL and the API key sent to it. */
export const webSearchUrlApiKeys: ReadonlyMap<TWebSearchKeys, TWebSearchKeys> = new Map<
  TWebSearchKeys,
  TWebSearchKeys
>([
  ['searxngInstanceUrl', 'searxngApiKey'],
  ['firecrawlApiUrl', 'firecrawlApiKey'],
  ['jinaApiUrl', 'jinaApiKey'],
  ['tavilySearchUrl', 'tavilyApiKey'],
  ['tavilyExtractUrl', 'tavilyApiKey'],
  ['keenableApiUrl', 'keenableApiKey'],
]);

/** Every web search URL that receives an API key, and every key sent to one. */
export const webSearchPairedFields: readonly TWebSearchKeys[] = [
  ...new Set([...webSearchUrlApiKeys.keys(), ...webSearchUrlApiKeys.values()]),
];

/**
 * Whether a web search value is stored in config itself, as a librechat.yaml
 * literal or a value the admin config API saved, rather than a `${VAR}`
 * reference to the environment. Blank and `user_provided` values supply nothing.
 */
export function isStoredWebSearchValue(value: unknown): value is string {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  return (
    trimmed !== '' && trimmed !== AuthType.USER_PROVIDED && extractVariableName(trimmed) == null
  );
}

/** A web search URL and the stored API key a binding rule keeps from it. */
export interface WebSearchKeyBinding {
  url: TWebSearchKeys;
  apiKey: TWebSearchKeys;
}

/**
 * Removes each stored API key that would reach a destination it was not
 * entered for:
 * - a later layer than the key's own set or removed its paired URL, whatever
 *   the new value (a literal, a `${VAR}` reference, blank or a tombstone);
 * - the paired URL is stored in config and another layer set it, which covers
 *   a key stored for a URL it inherits.
 *
 * A key stored over an inherited `${VAR}` URL is kept. `${VAR}` keys are left
 * to web search's runtime rules, which never send an environment key or a
 * user's own key to a URL stored in config.
 * @param layerOf - The merge position of the layer that last set or removed a field; `undefined` for the base config, which merges first.
 */
export function unbindWebSearchKeys<T extends Partial<Record<TWebSearchKeys, unknown>>>(
  webSearch: T | undefined,
  layerOf: (field: TWebSearchKeys) => number | undefined,
): { webSearch: T | undefined; unbound: WebSearchKeyBinding[] } {
  if (webSearch == null) {
    return { webSearch, unbound: [] };
  }
  const unbound: WebSearchKeyBinding[] = [];
  for (const [url, apiKey] of webSearchUrlApiKeys) {
    if (!isStoredWebSearchValue(webSearch[apiKey])) {
      continue;
    }
    const urlLayer = layerOf(url) ?? -1;
    const keyLayer = layerOf(apiKey) ?? -1;
    if (urlLayer > keyLayer || (urlLayer !== keyLayer && isStoredWebSearchValue(webSearch[url]))) {
      unbound.push({ url, apiKey });
    }
  }
  if (unbound.length === 0) {
    return { webSearch, unbound };
  }
  const bound: T = { ...webSearch };
  for (const { apiKey } of unbound) {
    delete bound[apiKey];
  }
  return { webSearch: bound, unbound };
}

/**
 * A URL as a request destination, so spellings of the same address compare
 * equal. Blank and `null` both read as `null`: each suppresses the inherited
 * URL, as a tombstone does.
 */
function toDestination(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const trimmed = value.trim();
  if (trimmed === '') {
    return null;
  }
  try {
    return new URL(trimmed).href;
  } catch {
    return trimmed;
  }
}

/**
 * Lists each stored API key that a write to one config document would send to
 * a new destination without the key being entered again: the write sets,
 * changes, blanks or removes the paired URL in that document, including a
 * change to or from a `${VAR}` reference, and leaves the stored key in place.
 * This is the admin config tier's form of the re-entry rule MCP servers apply
 * to stored credentials (`getChangedApiKeyBindingFields`).
 *
 * Pass each state as the document's own view: its stored values, with `null`
 * for a field it tombstones and does not set.
 * @param stored - The document's web search view before the write.
 * @param next - The document's web search view after the write, omitted secrets preserved.
 * @param written - The web search fields the write itself supplied.
 */
export function getRebindingWebSearchKeys(
  stored: Partial<Record<TWebSearchKeys, unknown>> | undefined,
  next: Partial<Record<TWebSearchKeys, unknown>> | undefined,
  written: ReadonlySet<string>,
): WebSearchKeyBinding[] {
  if (next == null) {
    return [];
  }
  const rebinding: WebSearchKeyBinding[] = [];
  for (const [url, apiKey] of webSearchUrlApiKeys) {
    if (
      !written.has(apiKey) &&
      isStoredWebSearchValue(next[apiKey]) &&
      toDestination(next[url]) !== toDestination(stored?.[url])
    ) {
      rebinding.push({ url, apiKey });
    }
  }
  return rebinding;
}

export const webSearchSelectionFields = {
  selectedProvider: 'LIBRECHAT_WEB_SEARCH_PROVIDER',
  selectedScraper: 'LIBRECHAT_WEB_SEARCH_SCRAPER',
  selectedReranker: 'LIBRECHAT_WEB_SEARCH_RERANKER',
} as const;

export function loadWebSearchConfig(
  config: TWebSearchConfigInput | undefined,
): TCustomConfig['webSearch'] {
  const serperApiKey = config?.serperApiKey ?? '${SERPER_API_KEY}';
  const searxngInstanceUrl = config?.searxngInstanceUrl ?? '${SEARXNG_INSTANCE_URL}';
  const searxngApiKey = config?.searxngApiKey ?? '${SEARXNG_API_KEY}';
  const firecrawlApiKey = config?.firecrawlApiKey ?? '${FIRECRAWL_API_KEY}';
  const firecrawlApiUrl = config?.firecrawlApiUrl ?? '${FIRECRAWL_API_URL}';
  const firecrawlVersion = config?.firecrawlVersion ?? '${FIRECRAWL_VERSION}';
  const tavilyApiKey = config?.tavilyApiKey ?? '${TAVILY_API_KEY}';
  const tavilySearchUrl = config?.tavilySearchUrl ?? '${TAVILY_SEARCH_URL}';
  const tavilyExtractUrl = config?.tavilyExtractUrl ?? '${TAVILY_EXTRACT_URL}';
  const keenableApiKey = config?.keenableApiKey ?? '${KEENABLE_API_KEY}';
  const keenableApiUrl = config?.keenableApiUrl ?? '${KEENABLE_API_URL}';
  const jinaApiKey = config?.jinaApiKey ?? '${JINA_API_KEY}';
  const jinaApiUrl = config?.jinaApiUrl ?? '${JINA_API_URL}';
  const cohereApiKey = config?.cohereApiKey ?? '${COHERE_API_KEY}';
  const safeSearch = config?.safeSearch ?? SafeSearchTypes.MODERATE;
  const rerankerType = config?.rerankerType;
  const searxngSearchOptions = config?.searxngSearchOptions && {
    ...config.searxngSearchOptions,
    engines: normalizeSearxngEngines(config.searxngSearchOptions.engines),
  };

  return {
    ...config, // Preserve provider-specific option blocks such as firecrawlOptions and tavilySearchOptions.
    safeSearch,
    searxngSearchOptions,
    jinaApiKey,
    jinaApiUrl,
    cohereApiKey,
    serperApiKey,
    searxngApiKey,
    tavilyApiKey,
    tavilySearchUrl,
    tavilyExtractUrl,
    keenableApiKey,
    keenableApiUrl,
    firecrawlApiKey,
    firecrawlApiUrl,
    firecrawlVersion,
    searxngInstanceUrl,
    rerankerType,
  };
}
