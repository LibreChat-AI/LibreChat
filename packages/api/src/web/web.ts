import {
  webSearchAuth,
  webSearchKeys,
  webSearchUrlApiKeys,
  webSearchSelectionFields,
} from '@librechat/data-schemas';
import {
  AuthType,
  RerankerTypes,
  SafeSearchTypes,
  SearchCategories,
  SearchProviders,
  ScraperProviders,
  webSearchSchema,
  extractVariableName,
} from 'librechat-data-provider';
import type { TWebSearchKeys, TWebSearchCategories } from '@librechat/data-schemas';
import type { TCustomConfig, TWebSearchConfig } from 'librechat-data-provider';
import type { KeenableScraperConfig } from '@librechat/agents';
import { isSSRFTarget, resolveHostnameSSRF, getEffectivePort } from '../auth';
import { resolveStoredConfigSecret } from '~/admin/secrets';

/**
 * URL keys that require explicit admin opt-in before user-provided values may pass through.
 */
const USER_PROVIDED_OPT_IN_URL_KEYS = new Set<TWebSearchKeys>([
  'tavilySearchUrl',
  'tavilyExtractUrl',
]);

/**
 * Where a configured credential is read from. A `${VAR}` reference resolves
 * through the server environment or, when that is unset, the user's saved
 * value; any other value is stored in config itself, as a librechat.yaml
 * literal or a value the admin config API encrypted at rest.
 */
type CredentialSource = { kind: 'env'; field: string } | { kind: 'config'; value: string };

/** `env` and `config` values are the deployment's; `user` values are the requesting user's. */
type CredentialOrigin = 'env' | 'user' | 'config';

interface ServiceCredential {
  key: TWebSearchKeys;
  required: boolean;
  source: CredentialSource;
}

interface ResolvedCredential {
  key: TWebSearchKeys;
  required: boolean;
  origin: CredentialOrigin;
  value?: string;
  /** Environment or plugin-auth field the value was looked up under; absent for config values. */
  field?: string;
}

type WebSearchOptionBlock =
  | 'firecrawlOptions'
  | 'searxngSearchOptions'
  | 'tavilySearchOptions'
  | 'tavilyScraperOptions'
  | 'keenableSearchOptions'
  | 'keenableScraperOptions';

const WEB_SEARCH_OPTION_BLOCKS: readonly WebSearchOptionBlock[] = [
  'firecrawlOptions',
  'searxngSearchOptions',
  'tavilySearchOptions',
  'tavilyScraperOptions',
  'keenableSearchOptions',
  'keenableScraperOptions',
];

/** The fields `webSearchSchema` defines for each provider option block. */
const WEB_SEARCH_OPTION_FIELDS = new Map<WebSearchOptionBlock, ReadonlySet<string>>(
  WEB_SEARCH_OPTION_BLOCKS.map((block) => [
    block,
    new Set(Object.keys(webSearchSchema.shape[block].unwrap().shape)),
  ]),
);

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

/** Classifies a configured credential; blank, `user_provided` and undecryptable values yield nothing. */
function getCredentialSource(value?: string): CredentialSource | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const field = extractVariableName(value);
  if (field) {
    return { kind: 'env', field };
  }
  const resolved = resolveStoredConfigSecret(value.trim());
  if (!resolved || resolved === AuthType.USER_PROVIDED) {
    return undefined;
  }
  return { kind: 'config', value: resolved };
}

/**
 * Whether a key config did not store would travel to a URL stored in config.
 * An environment key belongs to the operator's own endpoint and a user's saved
 * key to the endpoint the user saved it for, so a config write must not be
 * able to redirect either to another host.
 */
function isOutsideKeyForConfigUrl(url?: ResolvedCredential, apiKey?: ResolvedCredential): boolean {
  return (
    url?.origin === 'config' &&
    !!url.value &&
    apiKey != null &&
    apiKey.origin !== 'config' &&
    !!apiKey.value
  );
}

/**
 * Gives every URL the environment did not supply an explicit API key. The
 * search library reads its default environment key (`SEARXNG_API_KEY`,
 * `KEENABLE_API_KEY`) whenever the key it receives is undefined, so a withheld
 * or unset key becomes an empty string that it sends as no key at all.
 */
function blockEnvironmentKeyFallback(
  authResult: Partial<TWebSearchConfig>,
  entries: Iterable<{ key: TWebSearchKeys; origin: CredentialOrigin }>,
): void {
  for (const { key, origin } of entries) {
    const apiKey = webSearchUrlApiKeys.get(key);
    if (apiKey != null && origin !== 'env' && authResult[key] && authResult[apiKey] == null) {
      authResult[apiKey] = '';
    }
  }
}

/**
 * Keeps only the fields the schema defines in a provider option block. The
 * search library spreads these blocks into its clients, where an `apiUrl` or
 * `apiKey` would replace the destination or credential resolved here, and a
 * config override can store keys the schema does not define.
 */
function pickOptionFields<B extends WebSearchOptionBlock>(
  block: B,
  value: Partial<TWebSearchConfig>[B],
): Partial<TWebSearchConfig>[B] {
  const fields = WEB_SEARCH_OPTION_FIELDS.get(block);
  if (value == null || fields == null) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(value).filter(([field]) => fields.has(field)),
  ) as Partial<TWebSearchConfig>[B];
}

/**
 * Whether a resolved credential may be sent. A user-supplied URL must pass the
 * SSRF preflight and never receives a key the deployment supplied, except a
 * Tavily URL, which needs the operator's `user_provided` opt-in and then
 * receives the environment key by design; a key stored in config never goes
 * to a user-supplied URL. Neither an environment key nor a user's saved key
 * reaches a URL stored in config: an optional key is withheld, otherwise the
 * URL is dropped so the provider's default endpoint is used. A key stored in
 * config reaches a URL stored in config only when one config document set
 * both: `mergeConfigOverrides` drops a stored key whose stored URL another
 * layer set, or whose URL a later layer changed, blanked or removed, and the
 * admin config API asks for the key again when a write changes or removes the
 * URL beside it.
 */
async function isCredentialUsable(
  credential: ResolvedCredential,
  credentials: ReadonlyMap<TWebSearchKeys, ResolvedCredential>,
  allowedAddresses?: string[] | null,
): Promise<boolean> {
  const { key, field, value, origin } = credential;
  const apiKeyName = webSearchUrlApiKeys.get(key);
  if (apiKeyName == null) {
    if (origin === 'config' || credential.required) {
      return true;
    }
    for (const candidate of credentials.values()) {
      if (
        webSearchUrlApiKeys.get(candidate.key) === key &&
        isOutsideKeyForConfigUrl(candidate, credential)
      ) {
        return false;
      }
    }
    return true;
  }

  const apiKey = credentials.get(apiKeyName);
  if (origin === 'config') {
    return !(apiKey?.required && isOutsideKeyForConfigUrl(credential, apiKey));
  }
  if (origin !== 'user' || value == null) {
    return true;
  }
  const isOptIn = USER_PROVIDED_OPT_IN_URL_KEYS.has(key);
  if (isOptIn && (field == null || !isUserProvidedEnabled(field))) {
    return false;
  }
  if (await isSSRFUrl(value, allowedAddresses)) {
    return false;
  }
  if (!apiKey?.value || apiKey.origin === 'user') {
    return true;
  }
  return isOptIn && apiKey.origin === 'env';
}

/** A service's configured credentials, required first, or undefined when a required one is unset. */
function getServiceCredentials(
  requiredKeys: TWebSearchKeys[],
  optionalKeys: TWebSearchKeys[],
  config: TCustomConfig['webSearch'] | undefined,
): ServiceCredential[] | undefined {
  const credentials: ServiceCredential[] = [];
  for (const key of requiredKeys) {
    const source = getCredentialSource(config?.[key]);
    if (!source) {
      return undefined;
    }
    credentials.push({ key, required: true, source });
  }
  for (const key of optionalKeys) {
    const source = getCredentialSource(config?.[key]);
    if (source) {
      credentials.push({ key, required: false, source });
    }
  }
  return credentials;
}

/** Attaches each credential's value; a looked-up value that differs from the environment is the user's. */
function resolveCredentials(
  credentials: ServiceCredential[],
  authValues: Record<string, string>,
): Map<TWebSearchKeys, ResolvedCredential> {
  const resolved = new Map<TWebSearchKeys, ResolvedCredential>();
  for (const { key, required, source } of credentials) {
    if (source.kind === 'config') {
      resolved.set(key, { key, required, origin: 'config', value: source.value });
      continue;
    }
    const value = authValues[source.field];
    const origin = value != null && process.env[source.field] !== value ? 'user' : 'env';
    resolved.set(key, { key, required, origin, value, field: source.field });
  }
  return resolved;
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
 * Settings for the search tool. The Keenable scraper option block may carry a
 * deployment key withheld from the Keenable search URL.
 */
export type WebSearchAuthValues = Omit<Partial<TWebSearchConfig>, 'keenableScraperOptions'> & {
  keenableScraperOptions?: Partial<TWebSearchConfig>['keenableScraperOptions'] &
    Pick<KeenableScraperConfig, 'apiKey'>;
};

/**
 * Type for web search authentication result
 */
export interface WebSearchAuthResult {
  /** Whether all required categories have at least one authenticated service */
  authenticated: boolean;
  /** Authentication type (user_provided or system_defined) by category */
  authTypes: [TWebSearchCategories, AuthType][];
  /** Original authentication values mapped to their respective keys */
  authResult: WebSearchAuthValues;
}

interface KeenableAuthResolution {
  isUserProvided: boolean;
  hasSystemApiKey: boolean;
  rejectedUserApiUrl: boolean;
  lookupFailed: boolean;
}

/**
 * The Keenable scraper option block, carrying a deployment key kept from a
 * search URL the user supplied. The scraper fetches from `KEENABLE_FETCH_URL`
 * or Keenable's own host, never a URL from config or the user (the option block
 * holds only schema fields), so the key may still go there.
 */
function getKeenableScraperOptions(
  options: Partial<TWebSearchConfig>['keenableScraperOptions'],
  withheldApiKey?: string,
): WebSearchAuthValues['keenableScraperOptions'] {
  if (!withheldApiKey) {
    return options;
  }
  return { ...options, apiKey: withheldApiKey };
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
  const authResult: WebSearchAuthValues = {};
  /** A deployment Keenable key kept from a user's search URL, still usable by the Keenable scraper. */
  let keenableScraperApiKey: string | undefined;

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
      const resolvedEntries: Array<{
        key: TWebSearchKeys;
        value: string;
        origin: CredentialOrigin;
      }> = [];

      for (const originalKey of keenableKeys) {
        const source = getCredentialSource(webSearchConfig?.[originalKey]);
        if (source?.kind === 'env') {
          authEntries.push({ key: originalKey, field: source.field });
        } else if (source?.kind === 'config') {
          resolvedEntries.push({ key: originalKey, value: source.value, origin: 'config' });
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
        resolvedEntries.push({
          key: originalKey,
          value,
          origin: isFieldUserProvided ? 'user' : 'env',
        });
      }

      if (rejectedUserApiUrl) {
        return {
          isUserProvided: true,
          hasSystemApiKey: false,
          rejectedUserApiUrl: true,
          lookupFailed: false,
        };
      }

      const apiUrlOrigin = resolvedEntries.find(({ key }) => key === 'keenableApiUrl')?.origin;
      const apiKeyOrigin = resolvedEntries.find(({ key }) => key === 'keenableApiKey')?.origin;
      for (const { key: originalKey, value, origin } of resolvedEntries) {
        // An environment key or the user's own key never goes to a URL stored in
        // config. The URL is ignored instead, so the key reaches `KEENABLE_API_URL`
        // or Keenable's own endpoint, as it did before stored URLs were read.
        if (
          originalKey === 'keenableApiUrl' &&
          origin === 'config' &&
          apiKeyOrigin != null &&
          apiKeyOrigin !== 'config'
        ) {
          continue;
        }
        // Never forward a deployment key to an endpoint the user controls. Keenable
        // stays functional without the key at that URL.
        if (originalKey === 'keenableApiKey' && origin !== 'user' && apiUrlOrigin === 'user') {
          keenableScraperApiKey = value;
          continue;
        }
        authResult[originalKey] = value;
        if (originalKey === 'keenableApiKey' && origin !== 'user') {
          hasSystemApiKey = true;
        }
      }
      blockEnvironmentKeyFallback(authResult, resolvedEntries);

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

      const credentials = getServiceCredentials(requiredKeys, optionalKeys, webSearchConfig);
      if (!credentials) continue;

      const authFields: string[] = [];
      const optionalFields = new Set<string>();
      for (const { required, source } of credentials) {
        if (source.kind !== 'env') {
          continue;
        }
        authFields.push(source.field);
        if (!required) {
          optionalFields.add(source.field);
        }
      }

      try {
        const authValues =
          authFields.length > 0
            ? await loadAuthValues({ userId, authFields, optional: optionalFields, throwError })
            : {};
        const resolved = resolveCredentials(credentials, authValues);

        let allFieldsAuthenticated = true;
        for (const credential of resolved.values()) {
          if (credential.required && !credential.value) {
            allFieldsAuthenticated = false;
            break;
          }
          if (
            !(await isCredentialUsable(credential, resolved, webSearchConfig?.allowedAddresses))
          ) {
            if (credential.required) {
              allFieldsAuthenticated = false;
              break;
            }
            continue;
          }
          authResult[credential.key] = credential.value;
          if (credential.origin === 'user') {
            isUserProvided = true;
          }
        }
        blockEnvironmentKeyFallback(authResult, resolved.values());

        if (resolved.get('jinaApiKey')?.value && authResult.jinaApiUrl == null) {
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
  authResult.rerankerTimeout = webSearchConfig?.rerankerTimeout;
  authResult.firecrawlOptions = pickOptionFields(
    'firecrawlOptions',
    webSearchConfig?.firecrawlOptions,
  );
  authResult.searxngSearchOptions = pickOptionFields(
    'searxngSearchOptions',
    webSearchConfig?.searxngSearchOptions,
  );
  authResult.tavilySearchOptions = pickOptionFields(
    'tavilySearchOptions',
    webSearchConfig?.tavilySearchOptions,
  );
  authResult.tavilyScraperOptions = pickOptionFields(
    'tavilyScraperOptions',
    webSearchConfig?.tavilyScraperOptions,
  );
  authResult.keenableSearchOptions = pickOptionFields(
    'keenableSearchOptions',
    webSearchConfig?.keenableSearchOptions,
  );
  authResult.keenableScraperOptions = getKeenableScraperOptions(
    pickOptionFields('keenableScraperOptions', webSearchConfig?.keenableScraperOptions),
    scraperProvider === ScraperProviders.KEENABLE ? keenableScraperApiKey : undefined,
  );

  return {
    authTypes,
    authResult,
    authenticated,
  };
}
