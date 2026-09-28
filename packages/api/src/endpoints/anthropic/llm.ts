import { Agent } from 'undici';
import { logger } from '@librechat/data-schemas';
import { AnthropicClientOptions } from '@librechat/agents';
import {
  isOpus55Model,
  THINKING_BINDING_BETA,
  clampOutputConfigEffort,
  omitsSamplingParameters,
  isThinkingDisabled,
  anthropicSettings,
  removeNullishValues,
  ThinkingDisplay,
  AuthKeys,
} from 'librechat-data-provider';
import type { Dispatcher } from 'undici';
import type {
  AnthropicLLMConfigResult,
  AnthropicConfigOptions,
  AnthropicCredentials,
} from '~/types/anthropic';
import {
  FINE_GRAINED_TOOL_STREAMING_BETA,
  appendAnthropicBetaHeader,
  supportsAdaptiveThinking,
  checkPromptCacheSupport,
  configureReasoning,
  getClaudeHeaders,
} from './helpers';
import {
  createAnthropicVertexClient,
  isAnthropicVertexCredentials,
  getVertexDeploymentName,
} from './vertex';
import { createSSRFSafeUndiciConnect } from '~/auth';
import { getProxyDispatcher } from '~/utils/proxy';
import { mergeHeaders } from '~/utils/headers';

const WEB_SEARCH_BETA = 'web-search-2025-03-05';

type FetchOptions = { dispatcher?: Dispatcher; redirect?: RequestRedirect };

function getEffectiveURLPort(baseURL: string): string | null {
  try {
    const parsed = new URL(baseURL);
    if (parsed.port) {
      return parsed.port;
    }
    if (parsed.protocol === 'http:') {
      return '80';
    }
    if (parsed.protocol === 'https:') {
      return '443';
    }
  } catch {
    return null;
  }

  return null;
}

function mergeFetchOptions(
  clientOptions: NonNullable<AnthropicClientOptions['clientOptions']>,
  options: FetchOptions,
): void {
  const currentOptions = (clientOptions.fetchOptions ?? {}) as FetchOptions;
  clientOptions.fetchOptions = {
    ...currentOptions,
    ...options,
  } as NonNullable<AnthropicClientOptions['clientOptions']>['fetchOptions'];
}

/**
 * Parses credentials from string or object format
 * - If a valid JSON string is passed, it parses and returns the object
 * - If a plain API key string is passed, it wraps it in an AnthropicCredentials object
 * - If an object is passed, it returns it directly
 * - If undefined, returns an empty object
 */
function parseCredentials(
  credentials: string | AnthropicCredentials | undefined,
): AnthropicCredentials {
  if (typeof credentials === 'string') {
    try {
      return JSON.parse(credentials);
    } catch {
      // If not valid JSON, treat as a plain API key
      logger.debug('[Anthropic] Credentials not JSON, treating as API key');
      return { [AuthKeys.ANTHROPIC_API_KEY]: credentials };
    }
  }
  return credentials && typeof credentials === 'object' ? credentials : {};
}

/** Known Anthropic parameters that map directly to the client config */
export const knownAnthropicParams: Set<string> = new Set([
  'model',
  'temperature',
  'topP',
  'topK',
  'maxTokens',
  'maxOutputTokens',
  'stopSequences',
  'stop',
  'stream',
  'apiKey',
  'maxRetries',
  'timeout',
  'anthropicVersion',
  'anthropicApiUrl',
  'defaultHeaders',
]);

/**
 * Applies default parameters to the target object only if the field is undefined
 * @param target - The target object to apply defaults to
 * @param defaults - Record of default parameter values
 */
function applyDefaultParams(target: Record<string, unknown>, defaults: Record<string, unknown>) {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

/**
 * Generates configuration options for creating an Anthropic language model (LLM) instance.
 * @param credentials - The API key for authentication with Anthropic, or credentials object for Vertex AI.
 * @param options={} - Additional options for configuring the LLM.
 * @returns Configuration options for creating an Anthropic LLM instance, with null and undefined values removed.
 */
function getLLMConfig(
  credentials: string | AnthropicCredentials | undefined,
  options: AnthropicConfigOptions = {},
): AnthropicLLMConfigResult {
  /**
   * Persisted agent `model_parameters` may round-trip `thinking` as the full
   * Anthropic object `{ type: 'adaptive', display: 'omitted' }` rather than a
   * boolean. Pull any `.display` out of it so an explicit user choice is not
   * silently demoted to `'auto'` (which would then resolve to `'summarized'`
   * on Opus 4.7+).
   */
  const persistedThinking = options.modelOptions?.thinking;
  const persistedDisplay =
    typeof persistedThinking === 'object' &&
    persistedThinking != null &&
    'display' in persistedThinking &&
    typeof (persistedThinking as { display?: unknown }).display === 'string'
      ? ((persistedThinking as { display: string }).display as ThinkingDisplay | string)
      : undefined;

  /**
   * `thinking` may round-trip as the full Anthropic object rather than a
   * boolean. Normalize to a flag so a persisted `{ type: 'disabled' }` (e.g. a
   * Sonnet 5 "thinking off" config stored back into `model_parameters`) is
   * treated as off — a truthy object would otherwise flip thinking back on.
   */
  const thinkingFlag =
    typeof persistedThinking === 'object' && persistedThinking != null
      ? (persistedThinking as { type?: string }).type !== 'disabled'
      : (persistedThinking ?? anthropicSettings.thinking.default);

  const systemOptions = {
    thinking: thinkingFlag,
    promptCache: options.modelOptions?.promptCache ?? anthropicSettings.promptCache.default,
    promptCacheTtl:
      options.modelOptions?.promptCacheTtl ?? anthropicSettings.promptCacheTtl.default,
    thinkingBudget:
      options.modelOptions?.thinkingBudget ?? anthropicSettings.thinkingBudget.default,
    effort: options.modelOptions?.effort ?? anthropicSettings.effort.default,
    thinkingDisplay:
      options.modelOptions?.thinkingDisplay ??
      persistedDisplay ??
      anthropicSettings.thinkingDisplay.default,
  };

  if (options.modelOptions) {
    delete options.modelOptions.thinking;
    delete options.modelOptions.promptCache;
    delete options.modelOptions.promptCacheTtl;
    delete options.modelOptions.thinkingBudget;
    delete options.modelOptions.effort;
    delete options.modelOptions.thinkingDisplay;
  } else {
    throw new Error('No modelOptions provided');
  }

  const defaultOptions = {
    model: anthropicSettings.model.default,
    stream: true,
  };

  const mergedOptions = Object.assign(defaultOptions, options.modelOptions);

  let enableWebSearch = mergedOptions.web_search;

  let requestOptions: AnthropicClientOptions & { stream?: boolean } = {
    model: mergedOptions.model,
    stream: mergedOptions.stream,
    temperature: mergedOptions.temperature ?? undefined,
    stopSequences: mergedOptions.stop,
    maxTokens:
      mergedOptions.maxOutputTokens || anthropicSettings.maxOutputTokens.reset(mergedOptions.model),
    clientOptions: {},
    invocationKwargs: {
      metadata: {
        user_id: mergedOptions.user,
      },
    },
  };

  const creds = parseCredentials(credentials);
  const apiKey = creds[AuthKeys.ANTHROPIC_API_KEY] ?? null;

  if (isAnthropicVertexCredentials(creds)) {
    // Vertex AI configuration - use custom client with optional YAML config
    // Map the visible model name to the actual deployment name for Vertex AI
    const deploymentName = getVertexDeploymentName(
      requestOptions.model ?? '',
      options.vertexConfig,
    );
    requestOptions.model = deploymentName;

    requestOptions.createClient = () =>
      createAnthropicVertexClient(creds, requestOptions.clientOptions, options.vertexOptions);
  } else if (apiKey) {
    // Direct API configuration
    requestOptions.apiKey = apiKey;
  } else {
    throw new Error(
      'Invalid credentials provided. Please provide either a valid Anthropic API key or service account credentials for Vertex AI.',
    );
  }

  const resolvedModel = requestOptions.model ?? mergedOptions.model;
  const shouldOmitSamplingParameters = omitsSamplingParameters(resolvedModel);

  requestOptions = configureReasoning(requestOptions, systemOptions);

  if (supportsAdaptiveThinking(resolvedModel)) {
    if (
      systemOptions.effort &&
      (systemOptions.effort as string) !== '' &&
      !requestOptions.invocationKwargs?.output_config
    ) {
      requestOptions.invocationKwargs = {
        ...requestOptions.invocationKwargs,
        output_config: { effort: systemOptions.effort },
      };
    }
  } else {
    if (
      requestOptions.thinking != null &&
      (requestOptions.thinking as unknown as { type: string }).type === 'adaptive'
    ) {
      delete requestOptions.thinking;
    }
    if (requestOptions.invocationKwargs?.output_config) {
      delete requestOptions.invocationKwargs.output_config;
    }
  }

  /**
   * Opus 5 rejects `xhigh`/`max` effort while thinking is disabled (400).
   * `configureReasoning` returns before setting effort on the disabled path, so
   * the value applied just above is the one that would ship — clamp it to the
   * highest level the model accepts in that combination.
   */
  if (isThinkingDisabled(requestOptions.thinking)) {
    clampOutputConfigEffort(resolvedModel, requestOptions.invocationKwargs?.output_config);
  }

  const hasActiveThinking = requestOptions.thinking != null;
  const isThinkingModel =
    /claude-3[-.]7/.test(resolvedModel) || supportsAdaptiveThinking(resolvedModel);
  if (!shouldOmitSamplingParameters && (!isThinkingModel || !hasActiveThinking)) {
    requestOptions.topP = mergedOptions.topP;
    requestOptions.topK = mergedOptions.topK;
  }

  const supportsCacheControl =
    systemOptions.promptCache === true && checkPromptCacheSupport(requestOptions.model ?? '');

  /** Pass promptCache boolean for downstream cache_control application */
  if (supportsCacheControl) {
    (requestOptions as Record<string, unknown>).promptCache = true;
    /** Pass an explicit TTL when configured; otherwise the agents SDK defaults to 1h */
    if (systemOptions.promptCacheTtl != null) {
      (requestOptions as Record<string, unknown>).promptCacheTtl = systemOptions.promptCacheTtl;
    }
  }

  const headers = getClaudeHeaders(requestOptions.model ?? '', supportsCacheControl);
  if (headers && requestOptions.clientOptions) {
    requestOptions.clientOptions.defaultHeaders = headers;
  }

  const shouldProtectUserBaseURL =
    options.baseURLIsUserProvided === true && !!options.reverseProxyUrl;
  const proxyDispatcher = getProxyDispatcher(options.proxy);
  if (proxyDispatcher && !shouldProtectUserBaseURL && requestOptions.clientOptions) {
    mergeFetchOptions(requestOptions.clientOptions, {
      dispatcher: proxyDispatcher,
    });
  }

  if (options.reverseProxyUrl && requestOptions.clientOptions) {
    requestOptions.clientOptions.baseURL = options.reverseProxyUrl;
    requestOptions.anthropicApiUrl = options.reverseProxyUrl;
  }

  /** Handle defaultParams first - only process Anthropic-native params if undefined */
  if (options.defaultParams && typeof options.defaultParams === 'object') {
    for (const [key, value] of Object.entries(options.defaultParams)) {
      /** Handle web_search separately - don't add to config */
      if (key === 'web_search') {
        if (enableWebSearch === undefined && typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }

      if (knownAnthropicParams.has(key)) {
        /** Route known Anthropic params to requestOptions only if undefined */
        applyDefaultParams(requestOptions as Record<string, unknown>, { [key]: value });
      }
      /** Leave other params for transform to handle - they might be OpenAI params */
    }
  }

  /** Handle addParams - can override defaultParams */
  if (options.addParams && typeof options.addParams === 'object') {
    for (const [key, value] of Object.entries(options.addParams)) {
      /** Handle web_search separately - don't add to config */
      if (key === 'web_search') {
        if (typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }

      if (knownAnthropicParams.has(key)) {
        /** Route known Anthropic params to requestOptions */
        (requestOptions as Record<string, unknown>)[key] = value;
      }
      /** Leave other params for transform to handle - they might be OpenAI params */
    }
  }

  /** Handle dropParams - only drop from Anthropic config */
  const shouldDropClientOptions =
    Array.isArray(options.dropParams) && options.dropParams.includes('clientOptions');

  if (options.dropParams && Array.isArray(options.dropParams)) {
    options.dropParams.forEach((param) => {
      if (param === 'web_search') {
        enableWebSearch = false;
        return;
      }

      if (param in requestOptions) {
        delete requestOptions[param as keyof AnthropicClientOptions];
      }
      if (requestOptions.invocationKwargs && param in requestOptions.invocationKwargs) {
        delete (requestOptions.invocationKwargs as Record<string, unknown>)[param];
      }
    });

    /** A TTL is meaningless without caching — drop it alongside promptCache. */
    if (options.dropParams.includes('promptCache')) {
      delete (requestOptions as Record<string, unknown>).promptCacheTtl;
    }
  }

  /** The SDK reads outputConfig, not invocationKwargs.output_config. Keep the
   * legacy field for persisted configs and OpenAI-compatible transforms. */
  if (
    requestOptions.invocationKwargs?.output_config &&
    !options.dropParams?.includes('outputConfig')
  ) {
    requestOptions.outputConfig = requestOptions.invocationKwargs.output_config;
  }

  /** block_binding is invalid without its beta header. Honor an administrator
   * dropping clientOptions without leaving a beta-only field in the body. */
  if (
    shouldDropClientOptions &&
    requestOptions.thinking &&
    'block_binding' in requestOptions.thinking
  ) {
    delete requestOptions.thinking.block_binding;
  }

  if (shouldOmitSamplingParameters) {
    delete requestOptions.temperature;
    delete requestOptions.topP;
    delete requestOptions.topK;
  }

  const tools = [];

  if (enableWebSearch) {
    tools.push({
      type: 'web_search_20250305',
      name: 'web_search',
    });

    if (isAnthropicVertexCredentials(creds) && !shouldDropClientOptions) {
      if (!requestOptions.clientOptions) {
        requestOptions.clientOptions = {};
      }

      requestOptions.clientOptions.defaultHeaders = appendAnthropicBetaHeader(
        requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined,
        WEB_SEARCH_BETA,
      );
    }
  }

  if (!shouldDropClientOptions) {
    if (!requestOptions.clientOptions) {
      requestOptions.clientOptions = {};
    }
    requestOptions.clientOptions.defaultHeaders = appendAnthropicBetaHeader(
      requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined,
      isOpus55Model(resolvedModel) ? THINKING_BINDING_BETA : FINE_GRAINED_TOOL_STREAMING_BETA,
    );
  }

  /**
   * Attach admin-configured custom headers (e.g. AI-gateway metadata) beneath
   * the provider-managed headers above, so beta/protocol headers always win.
   * Placeholders are kept intact here and resolved at request time.
   */
  if (options.headers && Object.keys(options.headers).length > 0 && !shouldDropClientOptions) {
    if (!requestOptions.clientOptions) {
      requestOptions.clientOptions = {};
    }
    requestOptions.clientOptions.defaultHeaders = mergeHeaders(
      options.headers,
      requestOptions.clientOptions.defaultHeaders as Record<string, string> | undefined,
    );
  }

  if (shouldProtectUserBaseURL) {
    if (!requestOptions.clientOptions) {
      requestOptions.clientOptions = {};
    }
    mergeFetchOptions(requestOptions.clientOptions, {
      dispatcher: new Agent({
        connect: createSSRFSafeUndiciConnect(
          options.allowedAddresses,
          getEffectiveURLPort(options.reverseProxyUrl ?? ''),
        ),
      }),
      redirect: 'error',
    });
  }

  return {
    tools,
    llmConfig: removeNullishValues(
      requestOptions as Record<string, unknown>,
    ) as AnthropicClientOptions & { clientOptions?: { fetchOptions?: { dispatcher: Dispatcher } } },
  };
}

export { getLLMConfig };
