import { SafeSearchTypes, normalizeSearxngEngines } from 'librechat-data-provider';
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
    cohere: {
      cohereApiKey: 1 as const,
      /** Optional (0) */
      cohereApiUrl: 0 as const,
    },
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
  const cohereApiUrl = config?.cohereApiUrl ?? '${COHERE_API_URL}';
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
    cohereApiUrl,
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
