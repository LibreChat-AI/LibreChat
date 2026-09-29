import { Providers } from '@librechat/agents';
import { logger } from '@librechat/data-schemas';
import { googleSettings, AuthKeys, removeNullishValues } from 'librechat-data-provider';
import type { GoogleClientOptions, VertexAIClientOptions } from '@librechat/agents';
import type { GoogleAIToolType } from '@librechat/agents/langchain/google-common';
import type * as t from '~/types';
import { mergeHeaders } from '~/utils/headers';
import { isEnabled } from '~/utils';

type GoogleThinkingLevel = 'THINKING_LEVEL_UNSPECIFIED' | 'MINIMAL' | 'LOW' | 'MEDIUM' | 'HIGH';
type GoogleThinkingConfig = {
  includeThoughts?: boolean;
  thinkingLevel?: GoogleThinkingLevel;
};

type GeminiFlashThinkingRule = {
  /** Model id, matched exactly or as a `${id}-` prefix for versioned aliases */
  id: string;
  /** Thinking level applied when the request doesn't set one */
  default: GoogleThinkingLevel;
  /** Levels the model rejects, mapped to the nearest level it accepts */
  substitutions?: Partial<Record<GoogleThinkingLevel, GoogleThinkingLevel>>;
};

/**
 * Gemini Flash models (3.5+) that drop the deprecated sampling parameters
 * (`temperature`/`topP`/`topK`) and `thinkingBudget` in favor of the qualitative
 * `thinkingLevel`, and that reject the penalty parameters
 * (`presencePenalty`/`frequencyPenalty`) with HTTP 400 ("Penalty is not enabled
 * for this model"). We strip all of these and apply each model's documented
 * default thinking level when the request doesn't set one. Ordered
 * most-specific-first so `gemini-3.5-flash-lite` resolves before the
 * `gemini-3.5-flash` prefix.
 *
 * Gemini 3.7 and 3.8 Flash support only `low`/`medium`/`high` and error on
 * `minimal`, so an explicit `minimal` is substituted with the nearest supported
 * level.
 * @see https://ai.google.dev/gemini-api/docs/latest-model#api-changes-and-parameter-updates
 * @see https://ai.google.dev/gemini-api/docs/models/gemini-3.7-flash
 * @see https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash
 */
const geminiFlashThinkingRules: ReadonlyArray<GeminiFlashThinkingRule> = [
  { id: 'gemini-3.8-flash', default: 'MEDIUM', substitutions: { MINIMAL: 'LOW' } },
  { id: 'gemini-3.7-flash', default: 'MEDIUM', substitutions: { MINIMAL: 'LOW' } },
  { id: 'gemini-3.6-flash', default: 'MEDIUM' },
  { id: 'gemini-3.5-flash-lite', default: 'MINIMAL' },
  { id: 'gemini-3.5-flash', default: 'MEDIUM' },
];

const geminiFlashLegacyParams = [
  'temperature',
  'topP',
  'topK',
  'top_p',
  'top_k',
  'presencePenalty',
  'presence_penalty',
  'frequencyPenalty',
  'frequency_penalty',
  'thinkingBudget',
  'thinking_budget',
] as const;

const googleThinkingLevels = new Set<GoogleThinkingLevel>([
  'THINKING_LEVEL_UNSPECIFIED',
  'MINIMAL',
  'LOW',
  'MEDIUM',
  'HIGH',
]);

const vertexMultiRegionEndpoints = new Map([
  ['eu', 'aiplatform.eu.rep.googleapis.com'],
  ['us', 'aiplatform.us.rep.googleapis.com'],
  ['global', 'aiplatform.googleapis.com'],
]);

const blockedModelOptionParams = [
  'apiKey',
  'baseUrl',
  'baseURL',
  'endpoint',
  'authOptions',
  'customHeaders',
  'headers',
] as const;

type BlockedModelOptionParam = (typeof blockedModelOptionParams)[number];
type GoogleModelOptions = Partial<t.GoogleParameters> &
  Partial<Record<BlockedModelOptionParam, unknown>>;

/** Known Google/Vertex AI parameters that map directly to the client config */
export const knownGoogleParams: Set<string> = new Set([
  'model',
  'modelName',
  'temperature',
  'maxOutputTokens',
  'maxReasoningTokens',
  'topP',
  'topK',
  'seed',
  'presencePenalty',
  'frequencyPenalty',
  'stopSequences',
  'stop',
  'logprobs',
  'topLogprobs',
  'safetySettings',
  'responseModalities',
  'convertSystemMessageToHumanContent',
  'speechConfig',
  'streamUsage',
  'apiKey',
  'baseUrl',
  'endpoint',
  'location',
  'authOptions',
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

function getThresholdMapping(model: string) {
  const gemini1Pattern = /gemini-(1\.0|1\.5|pro$|1\.0-pro|1\.5-pro|1\.5-flash-001)/;
  const restrictedPattern = /(gemini-(1\.5-flash-8b|2\.0|exp)|learnlm)/;

  if (gemini1Pattern.test(model)) {
    return (value: string) => {
      if (value === 'OFF') {
        return 'BLOCK_NONE';
      }
      return value;
    };
  }

  if (restrictedPattern.test(model)) {
    return (value: string) => {
      if (value === 'OFF' || value === 'HARM_BLOCK_THRESHOLD_UNSPECIFIED') {
        return 'BLOCK_NONE';
      }
      return value;
    };
  }

  return (value: string) => value;
}

function normalizeGoogleThinkingLevel(value: unknown): GoogleThinkingLevel | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const normalized = value.toUpperCase() as GoogleThinkingLevel;
  if (!googleThinkingLevels.has(normalized)) {
    return undefined;
  }
  return normalized;
}

function getGeminiFlashThinkingRule(model: string): GeminiFlashThinkingRule | undefined {
  const normalized = model.toLowerCase();
  const modelId = normalized.split('/').pop() ?? normalized;
  for (const rule of geminiFlashThinkingRules) {
    if (modelId === rule.id || modelId.startsWith(`${rule.id}-`)) {
      return rule;
    }
  }
  return undefined;
}

/**
 * Removes the parameters a Gemini Flash model rejects (see
 * {@link geminiFlashLegacyParams}) from a params object. Used by the
 * Google-compatible custom-endpoint path (`getOpenAIConfig`), where `addParams`
 * is re-applied by `transformToOpenAIConfig` after `getGoogleConfig` has already
 * stripped `llmConfig` — without this the strip is undone and the deprecated
 * sampling / rejected penalty params reach the provider again. No-op for
 * non-Flash models and when there is nothing to strip.
 */
export function stripGeminiFlashBlockedParams<T extends Record<string, unknown> | undefined>(
  params: T,
  model: string | undefined,
): T {
  if (params == null || getGeminiFlashThinkingRule(model ?? '') == null) {
    return params;
  }
  const sanitized = { ...params };
  geminiFlashLegacyParams.forEach((key) => delete sanitized[key]);
  return sanitized as T;
}

const urlContextModelRegex = /gemini-(\d+)(?:\.(\d+))?/i;
const urlContextExcludedModalityRegex = /(?:^|-)(?:image|live|tts|audio)(?:-|$)/;

/**
 * The native URL Context tool is supported only on text Gemini 2.5+ and 3.x models
 * (https://ai.google.dev/gemini-api/docs/url-context#supported_models). Modality-specific
 * variants (image, live, TTS) do not accept it, mirroring the Google tool-combination exclusion.
 * Enabling it on an unsupported model returns a provider-side error, so we skip the tool there.
 */
function supportsUrlContext(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  const modelId = normalized.split('/').pop() ?? normalized;
  if (urlContextExcludedModalityRegex.test(modelId)) {
    return false;
  }
  const match = urlContextModelRegex.exec(modelId);
  if (!match) {
    return false;
  }
  const major = Number(match[1]);
  const minor = Number(match[2] ?? '0');
  return major > 2 || (major === 2 && minor >= 5);
}

function getVertexMultiRegionEndpoint(location: string): string | undefined {
  return vertexMultiRegionEndpoints.get(location);
}

function sanitizeModelOptions(modelOptions: Partial<t.GoogleParameters> | undefined) {
  const sanitizedOptions: GoogleModelOptions = { ...(modelOptions ?? {}) };
  blockedModelOptionParams.forEach((param) => {
    delete sanitizedOptions[param];
  });
  return sanitizedOptions;
}

function applyGeminiFlashOverrides({
  config,
  provider,
  thinking,
  dropParams,
}: {
  config: GoogleClientOptions | VertexAIClientOptions;
  provider: Providers;
  thinking: boolean;
  dropParams?: string[];
}) {
  const mutableConfig = config as Record<string, unknown>;
  const model = mutableConfig.model;
  if (typeof model !== 'string') {
    return;
  }
  const thinkingRule = getGeminiFlashThinkingRule(model);
  if (!thinkingRule) {
    return;
  }

  geminiFlashLegacyParams.forEach((param) => {
    delete mutableConfig[param];
  });

  if (!thinking) {
    return;
  }

  const droppedParams = new Set(dropParams ?? []);
  if (droppedParams.has('thinkingConfig')) {
    return;
  }

  const shouldDropIncludeThoughts = droppedParams.has('includeThoughts');
  const shouldDropThinkingLevel = droppedParams.has('thinkingLevel');
  const configWithThinking = config as { thinkingConfig?: GoogleThinkingConfig };
  const thinkingConfig: GoogleThinkingConfig = { ...(configWithThinking.thinkingConfig ?? {}) };

  if (shouldDropIncludeThoughts) {
    delete thinkingConfig.includeThoughts;
  }

  if (shouldDropThinkingLevel) {
    delete thinkingConfig.thinkingLevel;
  }

  if (!shouldDropIncludeThoughts && thinkingConfig.includeThoughts == null) {
    thinkingConfig.includeThoughts = true;
  }

  if (!shouldDropThinkingLevel) {
    if (!thinkingConfig.thinkingLevel) {
      thinkingConfig.thinkingLevel = thinkingRule.default;
    }
    const substitute = thinkingRule.substitutions?.[thinkingConfig.thinkingLevel];
    if (substitute) {
      thinkingConfig.thinkingLevel = substitute;
    }
  }

  if (Object.keys(thinkingConfig).length > 0) {
    configWithThinking.thinkingConfig = thinkingConfig;
  } else {
    delete configWithThinking.thinkingConfig;
  }

  if (provider === Providers.VERTEXAI && !shouldDropIncludeThoughts) {
    (config as VertexAIClientOptions).includeThoughts = true;
  }
}

function isAllowedVertexEndpoint(endpoint: string): boolean {
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(endpoint)) {
    return false;
  }

  if (endpoint === 'aiplatform.googleapis.com') {
    return true;
  }

  if (/^[a-z0-9-]+-aiplatform\.googleapis\.com$/.test(endpoint)) {
    return true;
  }

  if (/^aiplatform-[a-z0-9-]+\.p\.googleapis\.com$/.test(endpoint)) {
    return true;
  }

  if (/^[a-z0-9-]+-aiplatform-restricted\.p\.googleapis\.com$/.test(endpoint)) {
    return true;
  }

  return /^aiplatform\.[a-z0-9-]+\.rep\.googleapis\.com$/.test(endpoint);
}

function hasAllowedVertexEndpoint(config: Record<string, unknown>): boolean {
  const endpoint = config.endpoint;
  if (endpoint === undefined) {
    return false;
  }

  if (typeof endpoint !== 'string' || endpoint.trim() !== endpoint || endpoint.length === 0) {
    delete config.endpoint;
    return false;
  }

  const normalizedEndpoint = endpoint.toLowerCase();
  if (!isAllowedVertexEndpoint(normalizedEndpoint)) {
    delete config.endpoint;
    return false;
  }

  config.endpoint = normalizedEndpoint;
  return true;
}

function applyVertexMultiRegionEndpoint(config: VertexAIClientOptions & { endpoint?: string }) {
  const location = config.location;
  if (typeof location !== 'string') {
    return;
  }
  const multiRegionEndpoint = getVertexMultiRegionEndpoint(location);
  if (multiRegionEndpoint) {
    config.endpoint = multiRegionEndpoint;
  }
}

function hasServiceKeyCredentials(serviceKey: Record<string, unknown>): boolean {
  return Object.keys(serviceKey).length > 0;
}

export function getSafetySettings(
  model?: string,
): Array<{ category: string; threshold: string }> | undefined {
  if (isEnabled(process.env.GOOGLE_EXCLUDE_SAFETY_SETTINGS)) {
    return undefined;
  }
  const mapThreshold = getThresholdMapping(model ?? '');

  return [
    {
      category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      threshold: mapThreshold(
        process.env.GOOGLE_SAFETY_SEXUALLY_EXPLICIT || 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      ),
    },
    {
      category: 'HARM_CATEGORY_HATE_SPEECH',
      threshold: mapThreshold(
        process.env.GOOGLE_SAFETY_HATE_SPEECH || 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      ),
    },
    {
      category: 'HARM_CATEGORY_HARASSMENT',
      threshold: mapThreshold(
        process.env.GOOGLE_SAFETY_HARASSMENT || 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      ),
    },
    {
      category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
      threshold: mapThreshold(
        process.env.GOOGLE_SAFETY_DANGEROUS_CONTENT || 'HARM_BLOCK_THRESHOLD_UNSPECIFIED',
      ),
    },
    {
      category: 'HARM_CATEGORY_CIVIC_INTEGRITY',
      threshold: mapThreshold(process.env.GOOGLE_SAFETY_CIVIC_INTEGRITY || 'BLOCK_NONE'),
    },
  ];
}

/**
 * Replicates core logic from GoogleClient's constructor and setOptions, plus client determination.
 * Returns an object with the provider label and the final options that would be passed to createLLM.
 *
 * @param credentials - Either a JSON string or an object containing Google keys
 * @param options - The same shape as the "GoogleClient" constructor options
 */

export function getGoogleConfig(
  credentials: string | t.GoogleCredentials | undefined,
  options: t.GoogleConfigOptions = {},
  acceptRawApiKey = false,
): {
  /** @type {GoogleAIToolType[]} */
  tools: GoogleAIToolType[];
  /** @type {Providers.GOOGLE | Providers.VERTEXAI} */
  provider: Providers.VERTEXAI | Providers.GOOGLE;
  /** @type {GoogleClientOptions | VertexAIClientOptions} */
  llmConfig: VertexAIClientOptions | GoogleClientOptions;
} {
  let creds: t.GoogleCredentials = {};
  if (acceptRawApiKey && typeof credentials === 'string') {
    creds[AuthKeys.GOOGLE_API_KEY] = credentials;
  } else if (typeof credentials === 'string') {
    try {
      creds = JSON.parse(credentials);
    } catch (err: unknown) {
      throw new Error(
        `Error parsing string credentials: ${err instanceof Error ? err.message : 'Unknown error'}`,
      );
    }
  } else if (credentials && typeof credentials === 'object') {
    creds = credentials;
  }

  const serviceKeyRaw = creds[AuthKeys.GOOGLE_SERVICE_KEY] ?? {};
  const serviceKey =
    typeof serviceKeyRaw === 'string' ? JSON.parse(serviceKeyRaw) : (serviceKeyRaw ?? {});

  const apiKey = creds[AuthKeys.GOOGLE_API_KEY] ?? null;
  let project_id = null;
  if (options.forceVertex === true) {
    project_id = options.projectId ?? serviceKey?.project_id ?? null;
  } else if (!apiKey) {
    project_id = serviceKey?.project_id ?? null;
  }

  const reverseProxyUrl = options.reverseProxyUrl;
  const authHeader = options.authHeader;

  const {
    web_search,
    url_context,
    thinkingLevel,
    thinking = googleSettings.thinking.default,
    thinkingBudget = googleSettings.thinkingBudget.default,
    ...modelOptions
  } = sanitizeModelOptions(options.modelOptions);

  let enableWebSearch = web_search;
  let enableUrlContext = url_context;

  const llmConfig = removeNullishValues(
    {
      ...(modelOptions || {}),
      model: modelOptions?.model ?? '',
      maxRetries: 2,
      topP: modelOptions?.topP ?? undefined,
      topK: modelOptions?.topK ?? undefined,
      temperature: modelOptions?.temperature ?? undefined,
      maxOutputTokens: modelOptions?.maxOutputTokens ?? undefined,
    },
    true,
  ) as GoogleClientOptions | VertexAIClientOptions;
  const initialConfig = llmConfig as Record<string, unknown>;
  let hasCustomVertexEndpoint = hasAllowedVertexEndpoint(initialConfig);
  let shouldSyncVertexEndpoint = true;

  /** Used only for Safety Settings */
  llmConfig.safetySettings = getSafetySettings(llmConfig.model);

  let provider;

  if (options.forceVertex === true || project_id) {
    provider = Providers.VERTEXAI;
  } else {
    provider = Providers.GOOGLE;
  }

  // If we have a GCP project => Vertex AI
  if (provider === Providers.VERTEXAI) {
    (llmConfig as VertexAIClientOptions).authOptions = removeNullishValues(
      {
        ...(hasServiceKeyCredentials(serviceKey) && { credentials: { ...serviceKey } }),
        projectId: project_id,
      },
      true,
    );
    const location = process.env.GOOGLE_LOC || 'us-central1';
    (llmConfig as VertexAIClientOptions).location = location;
  } else if (apiKey && provider === Providers.GOOGLE) {
    llmConfig.apiKey = apiKey;
  } else {
    throw new Error(
      `Invalid credentials provided. Please provide either a valid API key or service account credentials for Google Cloud.`,
    );
  }

  const modelName = (modelOptions?.model ?? '') as string;

  /**
   * Gemini 3+ and Gemma 4+ use a qualitative `thinkingLevel` ('minimal'|'low'|'medium'|'high')
   * instead of the numeric `thinkingBudget` used by earlier models.
   * When `thinking` is enabled (default: true), we always send `thinkingConfig`
   * with `includeThoughts: true`. The `thinkingBudget` param is ignored for these models.
   *
   * For Vertex AI, top-level `includeThoughts` is still required because
   * `@librechat/agents/langchain/google-common`'s `formatGenerationConfig` reads it separately
   * from `thinkingConfig` — they serve different purposes in the request pipeline.
   */
  const supportsThinkingLevel = /gemini-([3-9]|\d{2,})|gemma-([4-9]|\d{2,})/i.test(modelName);

  if (supportsThinkingLevel && thinking) {
    const thinkingConfig: GoogleThinkingConfig = {
      includeThoughts: true,
    };
    const normalizedThinkingLevel = normalizeGoogleThinkingLevel(thinkingLevel);
    if (normalizedThinkingLevel) {
      thinkingConfig.thinkingLevel = normalizedThinkingLevel;
    }
    if (provider === Providers.GOOGLE) {
      (llmConfig as { thinkingConfig?: GoogleThinkingConfig }).thinkingConfig = thinkingConfig;
    } else if (provider === Providers.VERTEXAI) {
      (llmConfig as { thinkingConfig?: GoogleThinkingConfig }).thinkingConfig = thinkingConfig;
      (llmConfig as VertexAIClientOptions).includeThoughts = true;
    }
  } else if (!supportsThinkingLevel) {
    const shouldEnableThinking =
      thinking && thinkingBudget != null && (thinkingBudget > 0 || thinkingBudget === -1);

    if (shouldEnableThinking && provider === Providers.GOOGLE) {
      (llmConfig as GoogleClientOptions).thinkingConfig = {
        thinkingBudget: thinking ? thinkingBudget : googleSettings.thinkingBudget.default,
        includeThoughts: Boolean(thinking),
      };
    } else if (shouldEnableThinking && provider === Providers.VERTEXAI) {
      (llmConfig as VertexAIClientOptions).thinkingBudget = thinking
        ? thinkingBudget
        : googleSettings.thinkingBudget.default;
      (llmConfig as VertexAIClientOptions).includeThoughts = Boolean(thinking);
    }
  }

  /*
  let legacyOptions = {};
  // Filter out any "examples" that are empty
  legacyOptions.examples = (legacyOptions.examples ?? [])
    .filter(Boolean)
    .filter((obj) => obj?.input?.content !== '' && obj?.output?.content !== '');

  // If user has "examples" from legacyOptions, push them onto llmConfig
  if (legacyOptions.examples?.length) {
    llmConfig.examples = legacyOptions.examples.map((ex) => {
      const { input, output } = ex;
      if (!input?.content || !output?.content) {return undefined;}
      return {
        input: new HumanMessage(input.content),
        output: new AIMessage(output.content),
      };
    }).filter(Boolean);
  }
  */

  if (reverseProxyUrl) {
    (llmConfig as GoogleClientOptions).baseUrl = reverseProxyUrl;
  }

  if (authHeader) {
    (llmConfig as GoogleClientOptions).customHeaders = {
      Authorization: `Bearer ${apiKey}`,
    };
  }

  /**
   * Attach admin-configured custom headers (e.g. AI-gateway metadata) beneath
   * the provider-managed `Authorization` header above, so auth always wins.
   * `options.headers` are already resolved by `initializeGoogle`, keeping the
   * key-derived `Authorization` out of placeholder/env expansion.
   */
  if (options.headers && Object.keys(options.headers).length > 0) {
    (llmConfig as GoogleClientOptions).customHeaders = mergeHeaders(
      options.headers,
      (llmConfig as GoogleClientOptions).customHeaders as Record<string, string> | undefined,
    );
  }

  /** Handle defaultParams first - only process Google-native params if undefined */
  if (options.defaultParams && typeof options.defaultParams === 'object') {
    for (const [key, value] of Object.entries(options.defaultParams)) {
      /** Handle web_search separately - don't add to config */
      if (key === 'web_search') {
        if (enableWebSearch === undefined && typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }

      /** Handle url_context separately - resolved to a native tool, not config */
      if (key === 'url_context') {
        if (enableUrlContext === undefined && typeof value === 'boolean') {
          enableUrlContext = value;
        }
        continue;
      }

      if (knownGoogleParams.has(key)) {
        /** Route known Google params to llmConfig only if undefined */
        applyDefaultParams(llmConfig as Record<string, unknown>, { [key]: value });
        if (key === 'endpoint') {
          hasCustomVertexEndpoint = hasAllowedVertexEndpoint(llmConfig as Record<string, unknown>);
        }
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

      /** Handle url_context separately - resolved to a native tool, not config */
      if (key === 'url_context') {
        if (typeof value === 'boolean') {
          enableUrlContext = value;
        }
        continue;
      }

      if (knownGoogleParams.has(key)) {
        /** Route known Google params to llmConfig */
        (llmConfig as Record<string, unknown>)[key] = value;
        if (key === 'endpoint') {
          hasCustomVertexEndpoint = hasAllowedVertexEndpoint(llmConfig as Record<string, unknown>);
        }
      }
      /** Leave other params for transform to handle - they might be OpenAI params */
    }
  }

  /** Handle dropParams - only drop from Google config */
  if (options.dropParams && Array.isArray(options.dropParams)) {
    options.dropParams.forEach((param) => {
      if (param === 'web_search') {
        enableWebSearch = false;
        return;
      }

      if (param === 'url_context') {
        enableUrlContext = false;
        return;
      }

      if (param === 'endpoint') {
        shouldSyncVertexEndpoint = false;
        hasCustomVertexEndpoint = false;
      }

      if (param in llmConfig) {
        delete (llmConfig as Record<string, unknown>)[param];
      }
    });
  }

  /**
   * Apply the model-aware `maxOutputTokens` default last, so an explicit value,
   * `defaultParams`, and `addParams` all take precedence and a `dropParams` entry
   * is respected. Only fill in when the field is genuinely unset (`undefined`/`null`);
   * an empty-string value stays stripped per Gemini empty-payload handling. Without
   * this, current Gemini models would inherit the legacy 8K default instead of their
   * documented limit.
   */
  const maxOutputDropped =
    Array.isArray(options.dropParams) && options.dropParams.includes('maxOutputTokens');
  if (
    !maxOutputDropped &&
    modelOptions?.maxOutputTokens == null &&
    (llmConfig as Record<string, unknown>).maxOutputTokens == null
  ) {
    const resolvedModel = (llmConfig as { model?: string }).model || modelName;
    (llmConfig as GoogleClientOptions).maxOutputTokens =
      googleSettings.maxOutputTokens.reset(resolvedModel);
  }

  applyGeminiFlashOverrides({
    config: llmConfig,
    provider,
    thinking,
    dropParams: Array.isArray(options.dropParams) ? options.dropParams : undefined,
  });

  if (provider === Providers.VERTEXAI && shouldSyncVertexEndpoint && !hasCustomVertexEndpoint) {
    applyVertexMultiRegionEndpoint(llmConfig as VertexAIClientOptions & { endpoint?: string });
  }

  const tools: GoogleAIToolType[] = [];

  if (enableWebSearch) {
    tools.push({ googleSearch: {} });
  }

  if (enableUrlContext) {
    const urlContextModel = ((llmConfig as { model?: string }).model || modelName) ?? '';
    if (supportsUrlContext(urlContextModel)) {
      tools.push({ urlContext: {} });
    } else {
      logger.debug(
        `[getGoogleConfig] url_context enabled but model "${urlContextModel}" does not support the URL Context tool (Gemini 2.5+ only); skipping.`,
      );
    }
  }

  // Return the final shape
  return {
    /** @type {GoogleAIToolType[]} */
    tools,
    /** @type {Providers.GOOGLE | Providers.VERTEXAI} */
    provider,
    /** @type {GoogleClientOptions | VertexAIClientOptions} */
    llmConfig,
  };
}
