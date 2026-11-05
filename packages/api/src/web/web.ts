import { webSearchAuth } from '@librechat/data-schemas';
import {
  AuthType,
  SafeSearchTypes,
  SearchCategories,
  SearchProviders,
  ScraperProviders,
  extractVariableName,
} from 'librechat-data-provider';
import type { RerankerTypes, TCustomConfig, TWebSearchConfig } from 'librechat-data-provider';
import type { TWebSearchKeys, TWebSearchCategories } from '@librechat/data-schemas';
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

/**
 * Maps submitted web-search auth fields to environment-variable keys while keeping each
 * value paired with the key it was submitted under.
 */
export function pairWebSearchInstallAuth({
  keys,
  values,
  config,
}: {
  keys: string[];
  values: string[];
  config: TCustomConfig['webSearch'] | undefined;
}): { keys: string[]; values: string[] } {
  const mappedKeys: string[] = [];
  const mappedValues: string[] = [];

  for (let i = 0; i < keys.length; i++) {
    const [envVar] = extractWebSearchEnvVars({
      keys: [keys[i] as TWebSearchKeys],
      config,
    });
    if (envVar) {
      mappedKeys.push(envVar);
      mappedValues.push(values[i]);
    }
  }

  return { keys: mappedKeys, values: mappedValues };
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
  }) => Promise<Record<string, string>>;
  throwError?: boolean;
}): Promise<WebSearchAuthResult> {
  let authenticated = true;
  const authResult: Partial<TWebSearchConfig> = {};

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

      // Special case: skipping the reranker means skipping auth as well
      if (specificService === 'none') {
        authResult.rerankerType = specificService as RerankerTypes;
        return [true, false];
      }
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
          if (originalKey) {
            authResult[originalKey] = value;
            contributed = true;
          }

          if (!isUserProvided && isFieldUserProvided && contributed) {
            isUserProvided = true;
          }
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
    if (category === SearchCategories.RERANKERS && !webSearchConfig?.rerankerType) {
      authResult.rerankerType = 'none' as RerankerTypes;
      return [true, false];
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
  }

  const searchProvider = authResult.searchProvider ?? webSearchConfig?.searchProvider;
  if (searchProvider !== SearchProviders.TAVILY) {
    authResult.safeSearch = webSearchConfig?.safeSearch ?? SafeSearchTypes.MODERATE;
  }
  authResult.scraperTimeout = webSearchConfig?.scraperTimeout ?? scraperOptionsTimeout ?? 7500;
  authResult.firecrawlOptions = webSearchConfig?.firecrawlOptions;
  authResult.tavilySearchOptions = webSearchConfig?.tavilySearchOptions;
  authResult.tavilyScraperOptions = webSearchConfig?.tavilyScraperOptions;

  return {
    authTypes,
    authResult,
    authenticated,
  };
}
