import { webSearchAuth, webSearchKeys, webSearchSelectionFields } from '@librechat/data-schemas';
import {
  AuthType,
  RerankerTypes,
  SafeSearchTypes,
  SearchCategories,
  SearchProviders,
  ScraperProviders,
  extractVariableName,
} from 'librechat-data-provider';
import type { TWebSearchKeys, TWebSearchCategories } from '@librechat/data-schemas';
import type { TCustomConfig, TWebSearchConfig } from 'librechat-data-provider';
import { isSSRFTarget, resolveHostnameSSRF, getEffectivePort } from '../auth';

/**
 * User-provided URL keys that may pass through after SSRF preflight.
 */
const USER_PROVIDED_URL_KEYS = new Set<TWebSearchKeys>([
  'searxngInstanceUrl',
  'firecrawlApiUrl',
  'jinaApiUrl',
]);

/**
 * URL keys that require explicit admin opt-in before user-provided values may pass through.
 */
const USER_PROVIDED_OPT_IN_URL_KEYS = new Set<TWebSearchKeys>([
  'tavilySearchUrl',
  'tavilyExtractUrl',
]);

const SEARCH_PROVIDER_VALUES = new Set<string>(Object.values(SearchProviders));
const SCRAPER_PROVIDER_VALUES = new Set<string>(Object.values(ScraperProviders));
const RERANKER_VALUES = new Set<string>(Object.values(RerankerTypes));
const DEFAULT_JINA_API_URL = 'https://api.jina.ai/v1/rerank';

function isUserProvidedEnabled(field: string): boolean {
  return process.env[field] === AuthType.USER_PROVIDED;
}

/**
 * Returns true if the URL should be blocked for SSRF risk.
 * Fail-closed: unparseable URLs and non-HTTP(S) schemes return true.
 * `allowedAddresses` keeps this preflight consistent with the connect-time agent
 * so an admin-permitted private endpoint is not stripped before the agent runs.
 */
async function isSSRFUrl(url: string, allowedAddresses?: string[] | null): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return true;
  }
  const port = getEffectivePort(parsed.protocol, parsed.port);
  if (isSSRFTarget(parsed.hostname, allowedAddresses, port)) {
    return true;
  }
  return resolveHostnameSSRF(parsed.hostname, allowedAddresses, port);
}

export function extractWebSearchEnvVars({
  keys,
  config,
}: {
  keys: TWebSearchKeys[];
  config: TCustomConfig['webSearch'] | undefined;
}): string[] {
  if (!config) {
    return [];
  }

  const authFields: string[] = [];
  const relevantKeys = keys.filter((k) => k in config);

  for (const key of relevantKeys) {
    const value = config[key];
    if (typeof value === 'string') {
      const varName = extractVariableName(value);
      if (varName) {
        authFields.push(varName);
      }
    }
  }

  return authFields;
}

function mapWebSearchSelection(key: string, value: string): [string, string] | undefined {
  if (key === 'selectedProvider' && SEARCH_PROVIDER_VALUES.has(value)) {
    return [webSearchSelectionFields.selectedProvider, value];
  }
  if (key === 'selectedScraper' && SCRAPER_PROVIDER_VALUES.has(value)) {
    return [webSearchSelectionFields.selectedScraper, value];
  }
  if (key === 'selectedReranker' && RERANKER_VALUES.has(value)) {
    return [webSearchSelectionFields.selectedReranker, value];
  }
  return undefined;
}

export function getWebSearchInstallEntries({
  auth,
  config,
}: {
  auth: Partial<Record<string, string | null>>;
  config: TCustomConfig['webSearch'];
}): [string, string][] {
  const credentialEntries: [string, string][] = [];
  const selectionEntries: [string, string][] = [];

  for (const [key, value] of Object.entries(auth)) {
    if (typeof value !== 'string') {
      continue;
    }

    const selection = mapWebSearchSelection(key, value);
    if (selection) {
      selectionEntries.push(selection);
      continue;
    }

    const [authField] = extractWebSearchEnvVars({
      keys: [key as TWebSearchKeys],
      config,
    });
    if (authField) {
      credentialEntries.push([authField, value]);
    }
  }

  return [...credentialEntries, ...selectionEntries];
}

export function getWebSearchUninstallFields(config: TCustomConfig['webSearch']): string[] {
  return [
    ...extractWebSearchEnvVars({ keys: webSearchKeys, config }),
    ...Object.values(webSearchSelectionFields),
  ];
}

/**
 * Type for web search authentication result
 */
export interface WebSearchAuthResult {
  /** Whether all required categories have at least one authenticated service */
  authenticated: boolean;
  /** Authentication type (user_provided or system_defined) by category */
  authTypes: [TWebSearchCategories, AuthType][];
  /** Original authentication values mapped to their respective keys */
  authResult: Partial<TWebSearchConfig>;
}

interface KeenableAuthResolution {
  isUserProvided: boolean;
  hasSystemApiKey: boolean;
  rejectedUserApiUrl: boolean;
  lookupFailed: boolean;
}

/**
 * Loads and verifies web search authentication values
 * @param params - Authentication parameters
 * @returns Authentication result
 */
export async function loadWebSearchAuth({
  userId,
  webSearchConfig,
  loadAuthValues,
  throwError = true,
}: {
  userId: string;
  webSearchConfig: TCustomConfig['webSearch'];
  loadAuthValues: (params: {
    userId: string;
    authFields: string[];
    optional?: Set<string>;
    throwError?: boolean;
    failOnOptionalError?: boolean;
  }) => Promise<Record<string, string>>;
  throwError?: boolean;
}): Promise<WebSearchAuthResult> {
  let authenticated = true;
  const authResult: Partial<TWebSearchConfig> = {};

  /**
   * Keenable is keyless by default: both its search and its page fetch work
   * against public endpoints with no key, so neither category needs a secret to
   * authenticate. This resolves the optional key/URL overrides once (a key only
   * lifts rate limits) and reports whether any of them came from the user.
   */
  const keenableAuth = new Map<boolean, Promise<KeenableAuthResolution>>();
  function resolveKeenableAuth(includeApiUrl: boolean): Promise<KeenableAuthResolution> {
    const cached = keenableAuth.get(includeApiUrl);
    if (cached) {
      return cached;
    }

    const resolution = (async () => {
      let keenableUserProvided = false;
      let hasSystemApiKey = false;
      let rejectedUserApiUrl = false;
      const keenableKeys: TWebSearchKeys[] = includeApiUrl
        ? ['keenableApiKey', 'keenableApiUrl']
        : ['keenableApiKey'];
      const authEntries: Array<{ key: TWebSearchKeys; field: string }> = [];

      for (const originalKey of keenableKeys) {
        const [field] = extractWebSearchEnvVars({
          keys: [originalKey],
          config: webSearchConfig,
        });
        if (field) {
          authEntries.push({ key: originalKey, field });
        }
      }

      let authValues: Record<string, string> = {};
      try {
        const authFields = authEntries.map(({ field }) => field);
        authValues = await loadAuthValues({
          userId,
          authFields,
          optional: new Set(authFields),
          throwError: true,
          failOnOptionalError: true,
        });
      } catch {
        return {
          isUserProvided: false,
          hasSystemApiKey: false,
          rejectedUserApiUrl: false,
          lookupFailed: true,
        };
      }

      const resolvedEntries: Array<{
        key: TWebSearchKeys;
        value: string;
        isFieldUserProvided: boolean;
      }> = [];
      for (const { key: originalKey, field } of authEntries) {
        const value = authValues[field];
        const envValue = process.env[field];
        const normalizedEnvValue = envValue?.trim();
        const isFieldUserProvided =
          normalizedEnvValue == null ||
          normalizedEnvValue === '' ||
          normalizedEnvValue === AuthType.USER_PROVIDED;
        if (isFieldUserProvided) {
          // The category stays editable even before the user saves a value.
          // Otherwise a system key would hide a separately user-provided URL.
          keenableUserProvided = true;
        }
        if (!value) {
          continue;
        }
        if (
          originalKey === 'keenableApiUrl' &&
          isFieldUserProvided &&
          (await isSSRFUrl(value, webSearchConfig?.allowedAddresses))
        ) {
          rejectedUserApiUrl = true;
          continue;
        }
        resolvedEntries.push({ key: originalKey, value, isFieldUserProvided });
      }

      if (rejectedUserApiUrl) {
        return {
          isUserProvided: true,
          hasSystemApiKey: false,
          rejectedUserApiUrl: true,
          lookupFailed: false,
        };
      }

      const hasUserProvidedApiUrl = resolvedEntries.some(
        ({ key, isFieldUserProvided }) => key === 'keenableApiUrl' && isFieldUserProvided,
      );
      for (const { key: originalKey, value, isFieldUserProvided } of resolvedEntries) {
        // Never forward an administrator's secret to an endpoint controlled by
        // the user. Keenable remains functional without the key at that URL.
        if (originalKey === 'keenableApiKey' && !isFieldUserProvided && hasUserProvidedApiUrl) {
          continue;
        }
        authResult[originalKey] = value;
        if (originalKey === 'keenableApiKey' && !isFieldUserProvided) {
          hasSystemApiKey = true;
        }
      }

      return {
        isUserProvided: keenableUserProvided,
        hasSystemApiKey,
        rejectedUserApiUrl: false,
        lookupFailed: false,
      };
    })();
    keenableAuth.set(includeApiUrl, resolution);
    return resolution;
  }

  let userSelections:
    | Promise<{
        searchProvider?: SearchProviders;
        scraperProvider?: ScraperProviders;
        rerankerType?: RerankerTypes;
        lookupFailed?: boolean;
      }>
    | undefined;
  function resolveUserSelections(): Promise<{
    searchProvider?: SearchProviders;
    scraperProvider?: ScraperProviders;
    rerankerType?: RerankerTypes;
    lookupFailed?: boolean;
  }> {
    userSelections ??= (async () => {
      const fields: string[] = [];
      if (!webSearchConfig?.searchProvider) {
        fields.push(webSearchSelectionFields.selectedProvider);
      }
      if (!webSearchConfig?.scraperProvider) {
        fields.push(webSearchSelectionFields.selectedScraper);
      }
      if (!webSearchConfig?.rerankerType) {
        fields.push(webSearchSelectionFields.selectedReranker);
      }
      if (fields.length === 0) {
        return {};
      }

      let values: Record<string, string>;
      try {
        values = await loadAuthValues({
          userId,
          authFields: fields,
          optional: new Set(fields),
          throwError: true,
          failOnOptionalError: true,
        });
      } catch {
        return { lookupFailed: true };
      }

      const searchProvider = values[webSearchSelectionFields.selectedProvider];
      const scraperProvider = values[webSearchSelectionFields.selectedScraper];
      const rerankerType = values[webSearchSelectionFields.selectedReranker];
      return {
        searchProvider:
          searchProvider != null && SEARCH_PROVIDER_VALUES.has(searchProvider)
            ? (searchProvider as SearchProviders)
            : undefined,
        scraperProvider:
          scraperProvider != null && SCRAPER_PROVIDER_VALUES.has(scraperProvider)
            ? (scraperProvider as ScraperProviders)
            : undefined,
        rerankerType:
          rerankerType != null && RERANKER_VALUES.has(rerankerType)
            ? (rerankerType as RerankerTypes)
            : undefined,
      };
    })();
    return userSelections;
  }

  /** Type-safe iterator for the category-service combinations */
  async function checkAuth<C extends TWebSearchCategories>(
    category: C,
  ): Promise<[boolean, boolean]> {
    type ServiceType = keyof (typeof webSearchAuth)[C];
    let isUserProvided = false;

    // Check if a specific service is specified in the config
    let specificService: ServiceType | undefined;
    if (category === SearchCategories.PROVIDERS && webSearchConfig?.searchProvider) {
      specificService = webSearchConfig.searchProvider as unknown as ServiceType;
    } else if (category === SearchCategories.SCRAPERS && webSearchConfig?.scraperProvider) {
      specificService = webSearchConfig.scraperProvider as unknown as ServiceType;
    } else if (category === SearchCategories.RERANKERS && webSearchConfig?.rerankerType) {
      specificService = webSearchConfig.rerankerType as unknown as ServiceType;
    }

    if (!specificService) {
      const selections = await resolveUserSelections();
      if (selections.lookupFailed) {
        return [false, true];
      }
      if (category === SearchCategories.PROVIDERS && selections.searchProvider) {
        specificService = selections.searchProvider as unknown as ServiceType;
        authResult.searchProvider = selections.searchProvider;
        isUserProvided = true;
      } else if (category === SearchCategories.SCRAPERS && selections.scraperProvider) {
        specificService = selections.scraperProvider as unknown as ServiceType;
        authResult.scraperProvider = selections.scraperProvider;
        isUserProvided = true;
      } else if (category === SearchCategories.RERANKERS && selections.rerankerType) {
        specificService = selections.rerankerType as unknown as ServiceType;
        authResult.rerankerType = selections.rerankerType;
        isUserProvided = true;
      }
    }

    if (category === SearchCategories.RERANKERS && specificService === 'none') {
      authResult.rerankerType = specificService as RerankerTypes;
      return [true, isUserProvided];
    }

    // Special case: Keenable is keyless by default. The public endpoints need no
    // key, so a pinned Keenable authenticates even when nothing is configured —
    // as a search provider and as a scraper alike.
    if (category === SearchCategories.PROVIDERS && specificService === SearchProviders.KEENABLE) {
      const keenable = await resolveKeenableAuth(true);
      authResult.searchProvider = SearchProviders.KEENABLE;
      if (keenable.lookupFailed || keenable.rejectedUserApiUrl) {
        return [false, true];
      }
      return [true, isUserProvided || keenable.isUserProvided || !keenable.hasSystemApiKey];
    }
    if (category === SearchCategories.SCRAPERS && specificService === ScraperProviders.KEENABLE) {
      const searchUsesKeenable =
        authResult.searchProvider === SearchProviders.KEENABLE ||
        webSearchConfig?.searchProvider === SearchProviders.KEENABLE;
      const keenable = await resolveKeenableAuth(searchUsesKeenable);
      authResult.scraperProvider = ScraperProviders.KEENABLE;
      if (keenable.lookupFailed || keenable.rejectedUserApiUrl) {
        return [false, true];
      }
      return [true, isUserProvided || keenable.isUserProvided || !keenable.hasSystemApiKey];
    }

    // If a specific service is specified, only check that one
    const services = specificService
      ? [specificService]
      : (Object.keys(webSearchAuth[category]) as ServiceType[]);

    for (const service of services) {
      // Skip if the service doesn't exist in the webSearchAuth config
      if (!webSearchAuth[category][service]) {
        continue;
      }

      const serviceConfig = webSearchAuth[category][service];

      // Split keys into required and optional
      const requiredKeys: TWebSearchKeys[] = [];
      const optionalKeys: TWebSearchKeys[] = [];

      for (const key in serviceConfig) {
        const typedKey = key as TWebSearchKeys;
        if (serviceConfig[typedKey as keyof typeof serviceConfig] === 1) {
          requiredKeys.push(typedKey);
        } else if (serviceConfig[typedKey as keyof typeof serviceConfig] === 0) {
          optionalKeys.push(typedKey);
        }
      }

      if (requiredKeys.length === 0) continue;

      const requiredAuthFields = extractWebSearchEnvVars({
        keys: requiredKeys,
        config: webSearchConfig,
      });
      const optionalAuthFields = extractWebSearchEnvVars({
        keys: optionalKeys,
        config: webSearchConfig,
      });
      if (requiredAuthFields.length !== requiredKeys.length) continue;

      const allKeys = [...requiredKeys, ...optionalKeys];
      const allAuthFields = [...requiredAuthFields, ...optionalAuthFields];
      const optionalSet = new Set(optionalAuthFields);

      try {
        const authValues = await loadAuthValues({
          userId,
          authFields: allAuthFields,
          optional: optionalSet,
          throwError,
        });

        const jinaApiKeyIndex = allKeys.indexOf('jinaApiKey');
        const jinaApiKeyField = allAuthFields[jinaApiKeyIndex];
        const jinaApiKeyValue = jinaApiKeyField ? authValues[jinaApiKeyField] : undefined;
        const isJinaApiKeyUserProvided =
          jinaApiKeyValue != null && process.env[jinaApiKeyField] !== jinaApiKeyValue;

        let allFieldsAuthenticated = true;
        for (let j = 0; j < allAuthFields.length; j++) {
          const field = allAuthFields[j];
          const value = authValues[field];
          const originalKey = allKeys[j];

          if (!optionalSet.has(field) && !value) {
            allFieldsAuthenticated = false;
            break;
          }

          const isFieldUserProvided = value != null && process.env[field] !== value;
          const isUserProvidedUrlKey =
            originalKey != null && USER_PROVIDED_URL_KEYS.has(originalKey);
          const isUserProvidedOptInUrlKey =
            originalKey != null && USER_PROVIDED_OPT_IN_URL_KEYS.has(originalKey);
          const isUserProvidedUrlEnabled =
            isUserProvidedUrlKey || (isUserProvidedOptInUrlKey && isUserProvidedEnabled(field));
          let contributed = false;

          if (isUserProvidedOptInUrlKey && isFieldUserProvided && !isUserProvidedUrlEnabled) {
            if (!optionalSet.has(field)) {
              allFieldsAuthenticated = false;
              break;
            }
            continue;
          }

          if (
            isUserProvidedUrlEnabled &&
            isFieldUserProvided &&
            (await isSSRFUrl(value, webSearchConfig?.allowedAddresses))
          ) {
            if (!optionalSet.has(field)) {
              allFieldsAuthenticated = false;
              break;
            }
            continue;
          }

          if (originalKey === 'jinaApiUrl' && isFieldUserProvided && !isJinaApiKeyUserProvided) {
            continue;
          }
          if (originalKey) {
            authResult[originalKey] = value;
            contributed = true;
          }

          if (!isUserProvided && isFieldUserProvided && contributed) {
            isUserProvided = true;
          }
        }

        if (jinaApiKeyValue && authResult.jinaApiUrl == null) {
          authResult.jinaApiUrl = DEFAULT_JINA_API_URL;
        }

        if (!allFieldsAuthenticated) {
          continue;
        }
        if (category === SearchCategories.PROVIDERS) {
          authResult.searchProvider = service as SearchProviders;
        } else if (category === SearchCategories.SCRAPERS) {
          authResult.scraperProvider = service as ScraperProviders;
        } else if (category === SearchCategories.RERANKERS) {
          authResult.rerankerType = service as RerankerTypes;
        }
        return [true, isUserProvided];
      } catch {
        continue;
      }
    }
    if (
      category === SearchCategories.RERANKERS &&
      !webSearchConfig?.rerankerType &&
      !specificService
    ) {
      authResult.rerankerType = 'none' as RerankerTypes;
      return [true, false];
    }

    /**
     * Keyless fallback, reached only when no keyed service in the category
     * authenticated. The loop above skips Keenable whenever it isn't pinned,
     * because none of its auth fields are required (`requiredKeys.length === 0`),
     * so a legacy Keenable credential saved before provider selections were
     * persisted would otherwise leave the category unauthenticated. Gating the
     * compatibility path on an actual Keenable value preserves those installs
     * without making Keenable the implicit default for new users.
     */
    if (category === SearchCategories.PROVIDERS && !specificService) {
      const keenable = await resolveKeenableAuth(true);
      if (keenable.lookupFailed || keenable.rejectedUserApiUrl) {
        return [false, true];
      }
      if (authResult.keenableApiKey || authResult.keenableApiUrl) {
        authResult.searchProvider = SearchProviders.KEENABLE;
        return [true, keenable.isUserProvided];
      }
    }

    /**
     * Same for the scraper. Reached only when no keyed scraper authenticated, so
     * the alternative is web search staying disabled entirely. Two triggers:
     * Keenable being the resolved search provider (providers are checked first),
     * which is what completes a fully keyless stack, or a Keenable value actually
     * being present, which is how the API-key dialog expresses "scrape with
     * Keenable" for a deployment whose search runs on someone else. With neither,
     * it stays unauthenticated rather than silently scraping for a provider that
     * was never told to use Keenable.
     */
    if (category === SearchCategories.SCRAPERS && !specificService) {
      const searchUsesKeenable = authResult.searchProvider === SearchProviders.KEENABLE;
      const keenable = await resolveKeenableAuth(searchUsesKeenable);
      if (keenable.lookupFailed || keenable.rejectedUserApiUrl) {
        return [false, true];
      }
      if (
        authResult.searchProvider === SearchProviders.KEENABLE ||
        authResult.keenableApiKey ||
        authResult.keenableApiUrl
      ) {
        authResult.scraperProvider = ScraperProviders.KEENABLE;
        return [true, keenable.isUserProvided];
      }
    }

    return [false, isUserProvided];
  }

  const categories = [
    SearchCategories.PROVIDERS,
    SearchCategories.SCRAPERS,
    SearchCategories.RERANKERS,
  ] as const;
  const authTypes: [TWebSearchCategories, AuthType][] = [];
  for (const category of categories) {
    const [isCategoryAuthenticated, isUserProvided] = await checkAuth(category);
    if (!isCategoryAuthenticated) {
      authenticated = false;
      authTypes.push([category, AuthType.USER_PROVIDED]);
      continue;
    }
    authTypes.push([category, isUserProvided ? AuthType.USER_PROVIDED : AuthType.SYSTEM_DEFINED]);
  }

  const scraperProvider =
    authResult.scraperProvider ?? webSearchConfig?.scraperProvider ?? ScraperProviders.FIRECRAWL;
  let scraperOptionsTimeout: number | undefined;
  if (scraperProvider === ScraperProviders.TAVILY) {
    scraperOptionsTimeout = webSearchConfig?.tavilyScraperOptions?.timeout;
  } else if (scraperProvider === ScraperProviders.FIRECRAWL) {
    scraperOptionsTimeout = webSearchConfig?.firecrawlOptions?.timeout;
  } else if (scraperProvider === ScraperProviders.KEENABLE) {
    scraperOptionsTimeout = webSearchConfig?.keenableScraperOptions?.timeout;
  }

  const searchProvider = authResult.searchProvider ?? webSearchConfig?.searchProvider;
  if (searchProvider !== SearchProviders.TAVILY) {
    authResult.safeSearch = webSearchConfig?.safeSearch ?? SafeSearchTypes.MODERATE;
  }
  authResult.scraperTimeout = webSearchConfig?.scraperTimeout ?? scraperOptionsTimeout ?? 7500;
  authResult.firecrawlOptions = webSearchConfig?.firecrawlOptions;
  authResult.searxngSearchOptions = webSearchConfig?.searxngSearchOptions;
  authResult.tavilySearchOptions = webSearchConfig?.tavilySearchOptions;
  authResult.tavilyScraperOptions = webSearchConfig?.tavilyScraperOptions;
  authResult.keenableSearchOptions = webSearchConfig?.keenableSearchOptions;
  authResult.keenableScraperOptions = webSearchConfig?.keenableScraperOptions;

  return {
    authTypes,
    authResult,
    authenticated,
  };
}
