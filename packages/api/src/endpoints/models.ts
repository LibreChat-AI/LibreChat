import axios from 'axios';
import crypto from 'crypto';
import { logger } from '@librechat/data-schemas';
import {
  Time,
  CacheKeys,
  KnownEndpoints,
  EModelEndpoint,
  defaultModels,
} from 'librechat-data-provider';
import type { IUser } from '@librechat/data-schemas';
import type { AxiosRequestConfig } from 'axios';
import {
  processModelData,
  extractBaseURL,
  isUserProvided,
  resolveHeaders,
  deriveBaseURL,
  logAxiosError,
  inputSchema,
  applyAxiosProxyConfig,
} from '~/utils';
import { getModelCacheTokenConfigKey, isScopedTokenConfigKey } from '~/endpoints/keys';
import { createSSRFSafeAgents, validateEndpointURL } from '~/auth';
import { standardCache, tokenConfigCache } from '~/cache';

type SSRFSafeAgents = ReturnType<typeof createSSRFSafeAgents>;

export interface FetchModelsParams {
  /** User ID for API requests */
  user?: string;
  /** API key for authentication */
  apiKey: string;
  /** Base URL for the API */
  baseURL?: string;
  /** Whether the base URL came from a user-stored credential */
  baseURLIsUserProvided?: boolean;
  /** Admin-approved internal host:port exemptions for user-provided base URLs */
  allowedAddresses?: string[] | null;
  /** Endpoint name (defaults to 'openAI') */
  name?: string;
  /** Whether directEndpoint was configured */
  direct?: boolean;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to send user ID as query parameter */
  userIdQuery?: boolean;
  /** Whether to create token configuration from API response */
  createTokenConfig?: boolean;
  /** Cache key for token configuration (uses name if omitted) */
  tokenKey?: string;
  /** Optional headers for the request */
  headers?: Record<string, string> | null;
  /** Optional user object for header resolution */
  userObject?: Partial<IUser>;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
}

function applyUserProvidedBaseURLProtection(
  options: AxiosRequestConfig,
  ssrfAgents?: SSRFSafeAgents,
): AxiosRequestConfig {
  if (!ssrfAgents) {
    return options;
  }

  options.maxRedirects = 0;

  options.proxy = false;
  options.httpAgent = ssrfAgents.httpAgent;
  options.httpsAgent = ssrfAgents.httpsAgent;

  return options;
}

/**
 * Fetches Ollama models from the specified base API path.
 * @param baseURL - The Ollama server URL
 * @param options - Optional configuration
 * @returns Promise resolving to array of model names
 */
async function fetchOllamaModels(
  baseURL: string,
  options: {
    headers?: Record<string, string> | null;
    ssrfAgents?: SSRFSafeAgents;
    user?: Partial<IUser>;
  } = {},
): Promise<string[]> {
  if (!baseURL) {
    return [];
  }

  const ollamaEndpoint = deriveBaseURL(baseURL);

  const resolvedHeaders = resolveHeaders({
    headers: options.headers ?? undefined,
    user: options.user,
    stripUnresolved: true,
  });

  const requestOptions: AxiosRequestConfig & {
    headers: Record<string, string>;
    timeout: number;
  } = {
    headers: resolvedHeaders,
    timeout: 5000,
  };
  applyUserProvidedBaseURLProtection(requestOptions, options.ssrfAgents);

  const response = await axios.get<{ models: Array<{ name: string }> }>(
    `${ollamaEndpoint}/api/tags`,
    requestOptions,
  );

  return response.data.models.map((tag) => tag.name);
}

async function backfillTokenConfigFromModelCache(
  cacheKey: string,
  tokenKey: string,
): Promise<boolean> {
  const cachedTokenConfig = await tokenConfigCache().get(getModelCacheTokenConfigKey(cacheKey));
  if (cachedTokenConfig == null) {
    return false;
  }

  await tokenConfigCache().set(tokenKey, cachedTokenConfig);
  return true;
}

/**
 * Splits a string by commas and trims each resulting value.
 * @param input - The input string to split.
 * @returns An array of trimmed values.
 */
export function splitAndTrim(input: string | null | undefined): string[] {
  if (!input || typeof input !== 'string') {
    return [];
  }
  return input
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Fetches models from the specified base API path or Azure, based on the provided configuration.
 *
 * @param params - The parameters for fetching the models.
 * @returns A promise that resolves to an array of model identifiers.
 */
export async function fetchModels({
  user,
  apiKey,
  baseURL: _baseURL,
  baseURLIsUserProvided = false,
  allowedAddresses,
  name = EModelEndpoint.openAI,
  direct = false,
  azure = false,
  userIdQuery = false,
  createTokenConfig = true,
  tokenKey,
  headers,
  userObject,
  skipCache = false,
}: FetchModelsParams): Promise<string[]> {
  let models: string[] = [];
  const baseURL = direct ? extractBaseURL(_baseURL ?? '') : _baseURL;

  if (!baseURL && !azure) {
    return models;
  }

  if (!apiKey) {
    return models;
  }

  const ssrfAgents = baseURLIsUserProvided ? createSSRFSafeAgents(allowedAddresses) : undefined;
  if (baseURLIsUserProvided && baseURL) {
    await validateEndpointURL(baseURL, name, allowedAddresses);
  }

  // The MODEL_QUERIES cache is keyed by baseURL+apiKey only. That's safe
  // when the response is identical for every caller, but fails when callers
  // forward header templates that resolve to a user-bound value (e.g.
  // `Authorization: Bearer {{LIBRECHAT_OPENID_ID_TOKEN}}`): one user's
  // filtered list could otherwise be served to the next request that
  // shares the same baseURL+apiKey. Skip the cache whenever both `headers`
  // and `userObject` are supplied, since that's the signal the caller is
  // resolving headers against a specific user's identity.
  const hasUserScopedHeaders = !!headers && Object.keys(headers).length > 0 && !!userObject;
  const shouldCache = !skipCache && !(userIdQuery && user) && !hasUserScopedHeaders;
  const cacheKey = shouldCache ? modelsCacheKey(baseURL ?? '', apiKey) : '';
  const modelsCache = shouldCache ? standardCache(CacheKeys.MODEL_QUERIES) : null;
  if (modelsCache && cacheKey) {
    const cachedModels = await modelsCache.get(cacheKey);
    if (cachedModels) {
      if (createTokenConfig && tokenKey) {
        const tokenConfigBackfilled = await backfillTokenConfigFromModelCache(cacheKey, tokenKey);
        if (!tokenConfigBackfilled && isScopedTokenConfigKey(tokenKey)) {
          models = cachedModels as string[];
        } else {
          return cachedModels as string[];
        }
      } else {
        return cachedModels as string[];
      }
    }
  }

  if (name && name.toLowerCase().startsWith(KnownEndpoints.ollama)) {
    let ollamaModels: string[] | null = null;
    try {
      ollamaModels = await fetchOllamaModels(baseURL ?? '', {
        headers,
        ssrfAgents,
        user: userObject,
      });
    } catch (ollamaError) {
      logAxiosError({
        message:
          'Failed to fetch models from Ollama API. Attempting to fetch via OpenAI-compatible endpoint.',
        error: ollamaError as Error,
      });
    }
    if (ollamaModels !== null) {
      if (modelsCache && cacheKey && ollamaModels.length > 0) {
        await modelsCache.set(cacheKey, ollamaModels, Time.TWO_MINUTES);
      }
      return ollamaModels;
    }
  }

  try {
    // Resolve template variables (e.g. {{LIBRECHAT_OPENID_ID_TOKEN}}) in the
    // configured headers, mirroring fetchOllamaModels above. Without this,
    // placeholder strings are forwarded literally on the model-fetch path.
    const resolvedHeaders = resolveHeaders({
      headers: headers ?? undefined,
      user: userObject,
      stripUnresolved: true,
    });

    const options: AxiosRequestConfig & {
      headers: Record<string, string>;
      timeout: number;
    } = {
      headers: {
        ...resolvedHeaders,
      },
      timeout: 5000,
    };

    if (name === EModelEndpoint.anthropic) {
      // Keep configured custom headers (e.g. gateway metadata) while the
      // provider-managed auth/version headers stay authoritative.
      options.headers = {
        ...resolvedHeaders,
        'x-api-key': apiKey,
        'anthropic-version': process.env.ANTHROPIC_VERSION || '2023-06-01',
      };
    } else {
      // Only fall back to the apiKey-based Bearer when the configured
      // headers did not already supply an Authorization. This lets
      // auth-aware proxies (e.g. LiteLLM with JWT auth) receive the user's
      // token on /v1/models so they can return a per-user filtered list.
      const hasAuthHeader = Object.keys(options.headers).some(
        (k) => k.toLowerCase() === 'authorization',
      );
      if (!hasAuthHeader) {
        options.headers.Authorization = `Bearer ${apiKey}`;
      }
    }

    if (process.env.OPENAI_ORGANIZATION && baseURL?.includes('openai')) {
      options.headers['OpenAI-Organization'] = process.env.OPENAI_ORGANIZATION;
    }

    const url = new URL(`${(baseURL ?? '').replace(/\/+$/, '')}${azure ? '' : '/models'}`);
    if (user && userIdQuery) {
      url.searchParams.append('user', user);
    }
    applyAxiosProxyConfig(options, url);
    applyUserProvidedBaseURLProtection(options, ssrfAgents);
    const res = await axios.get(url.toString(), options);

    const input = res.data;

    const validationResult = inputSchema.safeParse(input);
    if (validationResult.success && createTokenConfig) {
      const endpointTokenConfig = processModelData(input);
      const cache = tokenConfigCache();
      await cache.set(tokenKey ?? name, endpointTokenConfig);
      if (modelsCache && cacheKey) {
        await cache.set(getModelCacheTokenConfigKey(cacheKey), endpointTokenConfig);
      }
    }
    models = input.data.map((item: { id: string }) => item.id);
  } catch (error) {
    const logMessage = `Failed to fetch models from ${azure ? 'Azure ' : ''}${name} API`;
    logAxiosError({ message: logMessage, error: error as Error });
  }

  if (modelsCache && cacheKey && models.length > 0) {
    await modelsCache.set(cacheKey, models, Time.TWO_MINUTES);
  }

  return models;
}

function modelsCacheKey(baseURL: string, apiKey: string): string {
  return crypto.createHash('sha256').update(`${baseURL}:${apiKey}`).digest('hex').slice(0, 32);
}

/** Options for fetching OpenAI models */
export interface GetOpenAIModelsOptions {
  /** User ID for API requests */
  user?: string;
  /** Whether to fetch from Azure */
  azure?: boolean;
  /** Whether to fetch models for the Assistants endpoint */
  assistants?: boolean;
  /** OpenAI API key (if not using environment variable) */
  openAIApiKey?: string;
  /** Skip MODEL_QUERIES cache (e.g., for user-provided keys) */
  skipCache?: boolean;
  /** Configured custom headers forwarded to the (gateway-fronted) provider */
  headers?: Record<string, string> | null;
  /** User object for resolving header placeholders */
  userObject?: Partial<IUser>;
  /** A model list configured for the endpoint; when set, it is returned without discovery. */
  configuredModels?: string[];
}

function resolveOpenAIApiKey(opts: GetOpenAIModelsOptions): string | undefined {
  return opts.openAIApiKey || process.env.OPENAI_API_KEY;
}

/**
 * Fetches models from OpenAI or Azure based on the provided options.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchOpenAIModels(
  opts: GetOpenAIModelsOptions,
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = resolveOpenAIApiKey(opts);
  const openaiBaseURL = 'https://api.openai.com/v1';
  let baseURL = openaiBaseURL;
  let reverseProxyUrl = process.env.OPENAI_REVERSE_PROXY;

  if (opts.assistants && process.env.ASSISTANTS_BASE_URL) {
    reverseProxyUrl = process.env.ASSISTANTS_BASE_URL;
  } else if (opts.azure) {
    return models;
  }

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? openaiBaseURL;
  }

  if (baseURL || opts.azure) {
    models = await fetchModels({
      apiKey: apiKey ?? '',
      baseURL,
      azure: opts.azure,
      user: opts.user,
      name: EModelEndpoint.openAI,
      skipCache: opts.skipCache,
      headers: opts.headers,
      userObject: opts.userObject,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  if (baseURL === openaiBaseURL) {
    const regex = /(text-davinci-003|gpt-|o\d+|chat-latest)/;
    const excludeRegex = /audio|realtime/;
    models = models.filter((model) => regex.test(model) && !excludeRegex.test(model));
    const instructModels = models.filter((model) => model.includes('instruct'));
    const otherModels = models.filter((model) => !model.includes('instruct'));
    models = otherModels.concat(instructModels);
  }

  return models;
}

/**
 * Loads the default models for OpenAI or Azure.
 * @param opts - Options for getting models
 * @returns Promise resolving to array of model IDs
 */
export async function getOpenAIModels(opts: GetOpenAIModelsOptions = {}): Promise<string[]> {
  if (opts.configuredModels) {
    return opts.configuredModels;
  }
  let models = defaultModels[EModelEndpoint.openAI];

  if (opts.assistants) {
    models = defaultModels[EModelEndpoint.assistants];
  } else if (opts.azure) {
    models = defaultModels[EModelEndpoint.azureAssistants];
  }

  let key: string;
  if (opts.assistants) {
    key = 'ASSISTANTS_MODELS';
  } else if (opts.azure) {
    key = 'AZURE_OPENAI_MODELS';
  } else {
    key = 'OPENAI_MODELS';
  }

  if (process.env[key]) {
    return splitAndTrim(process.env[key]);
  }

  if (isUserProvided(resolveOpenAIApiKey(opts))) {
    return models;
  }

  return await fetchOpenAIModels(opts, models);
}

/**
 * Fetches models from the Anthropic API.
 * @param opts - Options for fetching models
 * @param _models - Fallback models array
 * @returns Promise resolving to array of model IDs
 */
export async function fetchAnthropicModels(
  opts: {
    user?: string;
    skipCache?: boolean;
    headers?: Record<string, string> | null;
    userObject?: Partial<IUser>;
  } = {},
  _models: string[] = [],
): Promise<string[]> {
  let models = _models.slice() ?? [];
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const anthropicBaseURL = 'https://api.anthropic.com/v1';
  let baseURL = anthropicBaseURL;
  const reverseProxyUrl = process.env.ANTHROPIC_REVERSE_PROXY;

  if (reverseProxyUrl) {
    baseURL = extractBaseURL(reverseProxyUrl) ?? anthropicBaseURL;
  }

  if (!apiKey) {
    return models;
  }

  if (baseURL) {
    models = await fetchModels({
      apiKey,
      baseURL,
      user: opts.user,
      name: EModelEndpoint.anthropic,
      tokenKey: EModelEndpoint.anthropic,
      skipCache: opts.skipCache,
      headers: opts.headers,
      userObject: opts.userObject,
    });
  }

  if (models.length === 0) {
    return _models;
  }

  return models;
}

/**
 * Gets Anthropic models from environment or API.
 * @param opts - Options for fetching models
 * @returns Promise resolving to array of model IDs
 */
export async function getAnthropicModels(
  opts: {
    user?: string;
    vertexModels?: string[];
    headers?: Record<string, string> | null;
    userObject?: Partial<IUser>;
    /** A model list configured for the endpoint; when set, it is returned without discovery. */
    configuredModels?: string[];
  } = {},
): Promise<string[]> {
  if (opts.configuredModels) {
    return opts.configuredModels;
  }
  const models = defaultModels[EModelEndpoint.anthropic];

  // Vertex AI models from YAML config take priority
  if (opts.vertexModels && opts.vertexModels.length > 0) {
    return opts.vertexModels;
  }

  if (process.env.ANTHROPIC_MODELS) {
    return splitAndTrim(process.env.ANTHROPIC_MODELS);
  }

  if (isUserProvided(process.env.ANTHROPIC_API_KEY)) {
    return models;
  }

  try {
    return await fetchAnthropicModels(opts, models);
  } catch (error) {
    logger.error('Error fetching Anthropic models:', error);
    return models;
  }
}

/**
 * Gets Google models from environment or defaults.
 * @returns Array of model IDs
 */
export function getGoogleModels(): string[] {
  let models = defaultModels[EModelEndpoint.google];
  if (process.env.GOOGLE_MODELS) {
    models = splitAndTrim(process.env.GOOGLE_MODELS);
  }
  return models;
}

/**
 * Gets Bedrock models from environment or defaults.
 * @returns Array of model IDs
 */
export function getBedrockModels(): string[] {
  let models = defaultModels[EModelEndpoint.bedrock];
  if (process.env.BEDROCK_AWS_MODELS) {
    models = splitAndTrim(process.env.BEDROCK_AWS_MODELS);
  }
  return models;
}
