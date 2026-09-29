import { Providers, isOpenAILike } from '@librechat/agents';
import {
  EModelEndpoint,
  ReasoningEffort,
  ReasoningParameterFormat,
  removeNullishValues,
  prefersResponsesApiByModel,
  supportsAdaptiveThinking,
} from 'librechat-data-provider';
import type { BindToolsInput } from '@librechat/agents/langchain/language_models/chat_models';
import type { AzureOpenAIInput } from '@librechat/agents/langchain/openai';
import type { SettingDefinition } from 'librechat-data-provider';
import type { OpenAI } from 'openai';
import type * as t from '~/types';
import {
  sanitizeModelName,
  constructAzureURL,
  isCanonicalAzureURL,
  getAzureDeploymentName,
  constructAzureChatBasePath,
  constructAzureInstanceBasePath,
} from '~/utils/azure';
import { isEnabled } from '~/utils/common';

type OpenAILLMConfig = Omit<Partial<t.OAIClientOptions>, 'verbosity'> &
  Omit<Partial<t.OpenAIParameters>, 'verbosity'> &
  Omit<Partial<AzureOpenAIInput>, 'verbosity'> & {
    verbosity?: string | null;
  };

export const knownOpenAIParams: Set<string> = new Set([
  // Constructor/Instance Parameters
  'model',
  'modelName',
  'temperature',
  'topP',
  'frequencyPenalty',
  'presencePenalty',
  'n',
  'logitBias',
  'stop',
  'stopSequences',
  'user',
  'timeout',
  'stream',
  'maxTokens',
  'maxCompletionTokens',
  'logprobs',
  'topLogprobs',
  'apiKey',
  'organization',
  'audio',
  'modalities',
  'reasoning',
  'zdrEnabled',
  'service_tier',
  'supportsStrictToolCalling',
  'useResponsesApi',
  'configuration',
  // Call-time Options
  'tools',
  'tool_choice',
  'functions',
  'function_call',
  'response_format',
  'seed',
  'stream_options',
  'parallel_tool_calls',
  'strict',
  'prediction',
  'promptIndex',
  // Responses API specific
  'text',
  'truncation',
  'include',
  'previous_response_id',
  // LangChain specific
  '__includeRawResponse',
  'maxConcurrency',
  'maxRetries',
  'verbose',
  'streaming',
  'streamUsage',
  'disableStreaming',
]);

function hasReasoningParams({
  reasoning_effort,
  reasoning_summary,
  reasoning_mode,
  reasoning_context,
}: {
  reasoning_effort?: string | null;
  reasoning_summary?: string | null;
  reasoning_mode?: string | null;
  reasoning_context?: string | null;
}): boolean {
  return (
    (reasoning_effort != null && reasoning_effort !== '') ||
    (reasoning_summary != null && reasoning_summary !== '') ||
    (reasoning_mode != null && reasoning_mode !== '') ||
    (reasoning_context != null && reasoning_context !== '')
  );
}

function getReasoningObject({
  reasoningEffort,
  reasoningSummary,
  reasoningMode,
  reasoningContext,
}: {
  reasoningEffort?: OpenAILLMConfig['reasoning_effort'];
  reasoningSummary?: OpenAILLMConfig['reasoning_summary'];
  reasoningMode?: OpenAILLMConfig['reasoning_mode'];
  reasoningContext?: OpenAILLMConfig['reasoning_context'];
}): OpenAI.Reasoning {
  return removeNullishValues(
    {
      effort: reasoningEffort,
      summary: reasoningSummary,
      mode: reasoningMode,
      context: reasoningContext,
    },
    true,
  ) as OpenAI.Reasoning;
}

function isOpenAIEndpoint(endpoint?: EModelEndpoint | string | null): boolean {
  return endpoint === EModelEndpoint.openAI || endpoint === EModelEndpoint.azureOpenAI;
}

/**
 * GPT-5.6 models reject function tools combined with `reasoning_effort` in
 * `/v1/chat/completions` (400: "To use function tools, use /v1/responses or
 * set reasoning_effort to 'none'"). Reasoning without tools still works on
 * Chat Completions, but tools are bound after config time, so GPT-5.6
 * reasoning requests default to the Responses API to avoid tool failures.
 */
const responsesApiRequiredPattern = /\bgpt-5\.6\b/;

/** Native model defaults apply only to canonical Azure transports; gateways
 * may implement a different API contract even for the same model name. */
function isCanonicalAzureBaseURL(baseURL?: string | null, azure?: false | t.AzureOptions): boolean {
  if (!azure) {
    return false;
  }
  if (!baseURL) {
    return true;
  }
  return isCanonicalAzureURL(constructAzureURL({ baseURL, azureOptions: azure }));
}

function requiresResponsesApiForReasoning({
  model,
  reasoningEffort,
}: {
  model?: string;
  reasoningEffort?: string | null;
}): boolean {
  if (typeof model !== 'string' || !responsesApiRequiredPattern.test(model)) {
    return false;
  }
  return (
    reasoningEffort != null &&
    reasoningEffort !== ReasoningEffort.unset &&
    reasoningEffort !== ReasoningEffort.none
  );
}

/**
 * The GPT-5.6 Responses API default is first-party OpenAI only. A
 * `reverseProxyUrl`/`directEndpoint` gateway sets a custom base URL and may
 * expose only `/v1/chat/completions`, so it keeps its configured path.
 */
function isCanonicalOpenAIBaseURL(baseURL?: string | null): boolean {
  if (!baseURL) {
    return true;
  }
  try {
    return /(^|\.)api\.openai\.com$/i.test(new URL(baseURL).hostname);
  } catch {
    return false;
  }
}

function removeReasoningField(target: Record<string, unknown>, field: string) {
  const { reasoning } = target;
  if (reasoning == null || typeof reasoning !== 'object' || Array.isArray(reasoning)) {
    return;
  }

  const rest = { ...(reasoning as Record<string, unknown>) };
  delete rest[field];
  if (Object.keys(rest).length === 0) {
    delete target.reasoning;
    return;
  }

  target.reasoning = rest;
}

function removeReasoningPayload(target: Record<string, unknown>) {
  delete target.reasoning;
  delete target.reasoning_effort;
}

function deleteConfigParam({
  param,
  llmConfig,
  modelKwargs,
}: {
  param: string;
  llmConfig: OpenAILLMConfig;
  modelKwargs: Record<string, unknown>;
}) {
  if (param === 'reasoning_effort') {
    removeReasoningPayload(llmConfig as Record<string, unknown>);
    removeReasoningPayload(modelKwargs);
    return;
  }

  if (param === 'reasoning_summary') {
    delete (llmConfig as Record<string, unknown>).reasoning_summary;
    delete modelKwargs.reasoning_summary;
    removeReasoningField(llmConfig as Record<string, unknown>, 'summary');
    removeReasoningField(modelKwargs, 'summary');
    return;
  }

  if (param === 'reasoning_mode') {
    delete (llmConfig as Record<string, unknown>).reasoning_mode;
    delete modelKwargs.reasoning_mode;
    removeReasoningField(llmConfig as Record<string, unknown>, 'mode');
    removeReasoningField(modelKwargs, 'mode');
    return;
  }

  if (param === 'reasoning_context') {
    delete (llmConfig as Record<string, unknown>).reasoning_context;
    delete modelKwargs.reasoning_context;
    removeReasoningField(llmConfig as Record<string, unknown>, 'context');
    removeReasoningField(modelKwargs, 'context');
    return;
  }

  if (param in llmConfig) {
    delete llmConfig[param as keyof t.OAIClientOptions];
  }
  if (param in modelKwargs) {
    delete modelKwargs[param];
  }
}

const openRouterAnthropicVerbosityByEffort: Record<
  string,
  NonNullable<OpenAILLMConfig['verbosity']>
> = {
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
};

function isStringVerbosity(value: unknown): value is string {
  return typeof value === 'string' && value !== '';
}

function applyVerbosityParam({
  value,
  override,
  llmConfig,
  modelKwargs,
  useOpenRouter,
}: {
  value: unknown;
  override: boolean;
  llmConfig: OpenAILLMConfig;
  modelKwargs: Record<string, unknown>;
  useOpenRouter?: boolean;
}): boolean {
  if (!isStringVerbosity(value)) {
    return false;
  }

  if (useOpenRouter && (override || llmConfig.verbosity === undefined)) {
    llmConfig.verbosity = value;
    return false;
  }

  if (useOpenRouter) {
    return false;
  }

  if (!override && modelKwargs.verbosity !== undefined) {
    return true;
  }

  modelKwargs.verbosity = value;
  return true;
}

function isOpenRouterAnthropicAdaptiveModel(model?: string | null): boolean {
  if (typeof model !== 'string') {
    return false;
  }
  const normalizedModel = normalizeOpenRouterModel(model);
  return normalizedModel.startsWith('anthropic/') && supportsAdaptiveThinking(model);
}

function normalizeOpenRouterModel(model: string): string {
  return model.toLowerCase().replace(/^~/, '');
}

function isOpenRouterClaude46Model(model: string): boolean {
  const normalizedModel = normalizeOpenRouterModel(model);
  return (
    /claude[-.](?:opus|sonnet)[-.]4[-.]6/.test(normalizedModel) ||
    /claude[-.]4[-.]6[-.](?:opus|sonnet)/.test(normalizedModel)
  );
}

function getOpenRouterAnthropicVerbosity(
  reasoningEffort?: string | null,
  model?: string | null,
): OpenAILLMConfig['verbosity'] | undefined {
  if (!reasoningEffort) {
    return undefined;
  }
  const verbosity = openRouterAnthropicVerbosityByEffort[reasoningEffort];
  if (verbosity !== 'xhigh' || typeof model !== 'string') {
    return verbosity;
  }
  return isOpenRouterClaude46Model(model) ? 'max' : 'xhigh';
}

function applyOpenRouterReasoningConfig({
  model,
  llmConfig,
  modelKwargs,
  reasoningEffort,
}: {
  model?: string | null;
  llmConfig: OpenAILLMConfig;
  modelKwargs: Record<string, unknown>;
  reasoningEffort?: string | null;
}): boolean {
  if (!hasReasoningParams({ reasoning_effort: reasoningEffort })) {
    llmConfig.include_reasoning = true;
    return false;
  }

  if (!isOpenRouterAnthropicAdaptiveModel(model)) {
    modelKwargs.reasoning = { effort: reasoningEffort };
    return true;
  }

  const adaptiveVerbosity = getOpenRouterAnthropicVerbosity(reasoningEffort, model);
  if (adaptiveVerbosity != null && llmConfig.verbosity == null) {
    llmConfig.verbosity = adaptiveVerbosity;
  }

  if (reasoningEffort === 'none') {
    llmConfig.include_reasoning = false;
    return false;
  }

  modelKwargs.reasoning = { enabled: true };
  return true;
}

/**
 * Translates a scalar `reasoning_effort` parameter into the reasoning fields an
 * already-resolved OpenAI-compatible client honors, for callers that layer
 * their own parameters on top of a client configuration built elsewhere
 * (summarization reusing the agent's client options).
 *
 * The override has to land in *top-level* fields. A nested `modelKwargs`
 * fragment would replace the inherited `modelKwargs` wholesale, and a scalar
 * `reasoning_effort` is dropped outright: LangChain reads only `reasoning` from
 * constructor fields — `reasoning_effort` is a call-time option. `reasoning` is
 * the one shape every OpenAI-compatible client honors, since Chat Completions
 * re-emits it as `reasoning_effort`, the Responses API sends it as-is, and
 * `ChatOpenRouter` merges it over an inherited `modelKwargs.reasoning`.
 *
 * Mirrors {@link applyOpenRouterReasoningConfig} for OpenRouter's adaptive
 * Anthropic models, where effort is expressed as `verbosity` rather than
 * `reasoning.effort`. Non-OpenAI-compatible providers are left untouched:
 * they have no `reasoning_effort` concept to translate into.
 */
export function resolveReasoningParams({
  provider,
  model,
  parameters,
}: {
  provider?: string | null;
  model?: string | null;
  parameters?: Record<string, unknown>;
}): Record<string, unknown> | undefined {
  if (parameters == null || provider == null) {
    return parameters;
  }

  const reasoningEffort = parameters.reasoning_effort;
  if (typeof reasoningEffort !== 'string' || reasoningEffort === ReasoningEffort.unset) {
    return parameters;
  }

  const isOpenRouter = provider.toLowerCase() === Providers.OPENROUTER;
  if (!isOpenRouter && !isOpenAILike(provider as Providers)) {
    return parameters;
  }

  const resolved = { ...parameters };
  delete resolved.reasoning_effort;

  if (isOpenRouter && isOpenRouterAnthropicAdaptiveModel(model)) {
    /** Adaptive thinking is disabled through the object itself: the inherited
     * `modelKwargs.reasoning` would otherwise keep it enabled, which the main
     * flow's `include_reasoning: false` cannot undo. */
    if (reasoningEffort === ReasoningEffort.none) {
      resolved.reasoning = { enabled: false };
      return resolved;
    }
    const adaptiveVerbosity = getOpenRouterAnthropicVerbosity(reasoningEffort, model);
    if (adaptiveVerbosity != null && resolved.verbosity == null) {
      resolved.verbosity = adaptiveVerbosity;
    }
    resolved.reasoning = { enabled: true };
    return resolved;
  }

  const inherited = resolved.reasoning;
  const base =
    inherited != null && typeof inherited === 'object' && !Array.isArray(inherited)
      ? (inherited as Record<string, unknown>)
      : undefined;
  resolved.reasoning = { ...base, effort: reasoningEffort };
  return resolved;
}

function applyReasoningConfig({
  endpoint,
  llmConfig,
  modelKwargs,
  reasoningEffort,
  reasoningFormat,
  reasoningSummary,
  reasoningMode,
  reasoningContext,
}: {
  endpoint?: EModelEndpoint | string | null;
  llmConfig: OpenAILLMConfig;
  modelKwargs: Record<string, unknown>;
  reasoningEffort?: OpenAILLMConfig['reasoning_effort'];
  reasoningFormat?: ReasoningParameterFormat;
  reasoningSummary?: OpenAILLMConfig['reasoning_summary'];
  reasoningMode?: OpenAILLMConfig['reasoning_mode'];
  reasoningContext?: OpenAILLMConfig['reasoning_context'];
}): boolean {
  if (
    !hasReasoningParams({
      reasoning_effort: reasoningEffort,
      reasoning_summary: reasoningSummary,
      reasoning_mode: reasoningMode,
      reasoning_context: reasoningContext,
    })
  ) {
    return false;
  }

  const reasoning = getReasoningObject({
    reasoningEffort,
    reasoningSummary,
    reasoningMode,
    reasoningContext,
  });
  if (reasoningFormat === ReasoningParameterFormat.disabled) {
    return false;
  }

  if (isOpenAIEndpoint(endpoint)) {
    if (llmConfig.useResponsesApi === true) {
      llmConfig.reasoning = reasoning;
      return false;
    }
    if (reasoningEffort) {
      llmConfig.reasoning_effort = reasoningEffort;
    }
    return false;
  }

  if (llmConfig.useResponsesApi === true) {
    modelKwargs.reasoning = reasoning;
    return true;
  }

  if (reasoningFormat === ReasoningParameterFormat.reasoningObject) {
    modelKwargs.reasoning = reasoning;
    return true;
  }

  if (reasoningEffort) {
    modelKwargs.reasoning_effort = reasoningEffort;
    return true;
  }

  return false;
}

function getModelKwargsText(modelKwargs: Record<string, unknown>): Record<string, unknown> {
  const { text } = modelKwargs;
  if (text == null || typeof text !== 'object' || Array.isArray(text)) {
    return {};
  }
  return text as Record<string, unknown>;
}

function applyResponsesVerbosity({
  llmConfig,
  modelKwargs,
  useOpenRouter,
}: {
  llmConfig: OpenAILLMConfig;
  modelKwargs: Record<string, unknown>;
  useOpenRouter?: boolean;
}): boolean {
  if (llmConfig.useResponsesApi !== true) {
    return false;
  }

  if (useOpenRouter && llmConfig.verbosity) {
    modelKwargs.text = {
      ...getModelKwargsText(modelKwargs),
      verbosity: llmConfig.verbosity,
    };
    delete llmConfig.verbosity;
    return true;
  }

  if (!useOpenRouter && modelKwargs.verbosity) {
    modelKwargs.text = {
      ...getModelKwargsText(modelKwargs),
      verbosity: modelKwargs.verbosity,
    };
    delete modelKwargs.verbosity;
    return true;
  }

  return false;
}

/**
 * Extracts default parameters from customParams.paramDefinitions
 * @param paramDefinitions - Array of parameter definitions with key and default values
 * @returns Record of default parameters
 */
export function extractDefaultParams(
  paramDefinitions?: Partial<SettingDefinition>[],
): Record<string, unknown> | undefined {
  if (!paramDefinitions || !Array.isArray(paramDefinitions)) {
    return undefined;
  }

  const defaults: Record<string, unknown> = {};
  for (let i = 0; i < paramDefinitions.length; i++) {
    const param = paramDefinitions[i];
    if (param.key !== undefined && param.default !== undefined) {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}

/**
 * Applies default parameters to the target object only if the field is undefined
 * @param target - The target object to apply defaults to
 * @param defaults - Record of default parameter values
 */
export function applyDefaultParams(
  target: Record<string, unknown>,
  defaults: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(defaults)) {
    if (target[key] === undefined) {
      target[key] = value;
    }
  }
}

export function getOpenAILLMConfig({
  azure,
  apiKey,
  baseURL,
  endpoint,
  streaming,
  addParams,
  dropParams,
  defaultParams,
  useOpenRouter,
  reasoningFormat = ReasoningParameterFormat.reasoningEffort,
  modelOptions: _modelOptions,
}: {
  apiKey: string;
  streaming: boolean;
  baseURL?: string | null;
  endpoint?: EModelEndpoint | string | null;
  modelOptions: Partial<t.OpenAIParameters>;
  addParams?: Record<string, unknown>;
  dropParams?: string[];
  defaultParams?: Record<string, unknown>;
  useOpenRouter?: boolean;
  reasoningFormat?: ReasoningParameterFormat;
  azure?: false | t.AzureOptions;
}): Pick<t.LLMConfigResult, 'llmConfig' | 'tools'> & {
  azure?: t.AzureOptions;
} {
  /** Clean empty strings from model options (e.g., temperature: "" should be removed) */
  const cleanedModelOptions = removeNullishValues(
    _modelOptions,
    true,
  ) as Partial<t.OpenAIParameters>;

  const {
    reasoning_effort,
    reasoning_summary,
    reasoning_mode,
    reasoning_context,
    verbosity,
    web_search,
    promptCache,
    promptCacheTtl,
    frequency_penalty,
    presence_penalty,
    ...modelOptions
  } = cleanedModelOptions as Partial<
    t.OpenAIParameters & { promptCache?: boolean; promptCacheTtl?: '5m' | '1h' }
  >;

  const llmConfig = Object.assign(
    {
      streaming,
      model: modelOptions.model ?? '',
    },
    modelOptions,
  ) as OpenAILLMConfig;

  if (frequency_penalty != null) {
    llmConfig.frequencyPenalty = frequency_penalty;
  }
  if (presence_penalty != null) {
    llmConfig.presencePenalty = presence_penalty;
  }

  const modelKwargs: Record<string, unknown> = {};
  let hasModelKwargs = false;
  let reasoningEffort = reasoning_effort;
  let reasoningSummary = reasoning_summary;
  let reasoningMode = reasoning_mode;
  let reasoningContext = reasoning_context;

  if (verbosity != null && verbosity !== '' && useOpenRouter) {
    llmConfig.verbosity = verbosity;
  } else if (verbosity != null && verbosity !== '') {
    modelKwargs.verbosity = verbosity;
    hasModelKwargs = true;
  }

  let enableWebSearch = web_search;
  let enablePromptCache = promptCache;
  let promptCacheTtlValue = promptCacheTtl;

  /** Apply defaultParams first - only if fields are undefined */
  if (defaultParams && typeof defaultParams === 'object') {
    for (const [key, value] of Object.entries(defaultParams)) {
      if (key === 'web_search') {
        if (enableWebSearch === undefined && typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }
      if (key === 'promptCache') {
        if (enablePromptCache === undefined && typeof value === 'boolean') {
          enablePromptCache = value;
        }
        continue;
      }
      if (key === 'promptCacheTtl') {
        if (promptCacheTtlValue === undefined && (value === '5m' || value === '1h')) {
          promptCacheTtlValue = value;
        }
        continue;
      }
      if (key === 'reasoning_effort') {
        if (!reasoningEffort && typeof value === 'string') {
          reasoningEffort = value as OpenAILLMConfig['reasoning_effort'];
        }
        continue;
      }
      if (key === 'reasoning_summary') {
        if (!reasoningSummary && typeof value === 'string') {
          reasoningSummary = value as OpenAILLMConfig['reasoning_summary'];
        }
        continue;
      }
      if (key === 'reasoning_mode') {
        if (!reasoningMode && typeof value === 'string') {
          reasoningMode = value as OpenAILLMConfig['reasoning_mode'];
        }
        continue;
      }
      if (key === 'reasoning_context') {
        if (!reasoningContext && typeof value === 'string') {
          reasoningContext = value as OpenAILLMConfig['reasoning_context'];
        }
        continue;
      }
      if (key === 'verbosity') {
        hasModelKwargs =
          applyVerbosityParam({
            value,
            override: false,
            llmConfig,
            modelKwargs,
            useOpenRouter,
          }) || hasModelKwargs;
        continue;
      }

      if (knownOpenAIParams.has(key)) {
        applyDefaultParams(llmConfig as Record<string, unknown>, { [key]: value });
      } else {
        /** Apply to modelKwargs if not a known param */
        if (modelKwargs[key] === undefined) {
          modelKwargs[key] = value;
          hasModelKwargs = true;
        }
      }
    }
  }

  /** Apply addParams - can override defaultParams */
  if (addParams && typeof addParams === 'object') {
    for (const [key, value] of Object.entries(addParams)) {
      if (key === 'web_search') {
        if (typeof value === 'boolean') {
          enableWebSearch = value;
        }
        continue;
      }
      if (key === 'promptCache') {
        if (typeof value === 'boolean') {
          enablePromptCache = value;
        }
        continue;
      }
      if (key === 'promptCacheTtl') {
        if (value === '5m' || value === '1h') {
          promptCacheTtlValue = value;
        }
        continue;
      }
      if (key === 'reasoning_effort') {
        if (typeof value === 'string' || value == null) {
          reasoningEffort = value as OpenAILLMConfig['reasoning_effort'];
        }
        continue;
      }
      if (key === 'reasoning_summary') {
        if (typeof value === 'string' || value == null) {
          reasoningSummary = value as OpenAILLMConfig['reasoning_summary'];
        }
        continue;
      }
      if (key === 'reasoning_mode') {
        if (typeof value === 'string' || value == null) {
          reasoningMode = value as OpenAILLMConfig['reasoning_mode'];
        }
        continue;
      }
      if (key === 'reasoning_context') {
        if (typeof value === 'string' || value == null) {
          reasoningContext = value as OpenAILLMConfig['reasoning_context'];
        }
        continue;
      }
      if (key === 'verbosity') {
        hasModelKwargs =
          applyVerbosityParam({
            value,
            override: true,
            llmConfig,
            modelKwargs,
            useOpenRouter,
          }) || hasModelKwargs;
        continue;
      }
      if (knownOpenAIParams.has(key)) {
        (llmConfig as Record<string, unknown>)[key] = value;
      } else {
        hasModelKwargs = true;
        modelKwargs[key] = value;
      }
    }
  }

  if (useOpenRouter) {
    /**
     * OpenRouter uses a `reasoning` object — `summary` is not supported.
     * ChatOpenRouter treats `reasoning` and `include_reasoning` as mutually exclusive:
     * `include_reasoning` is legacy compat that maps to `{ enabled: true }` only when
     * no `reasoning` object is present, so we intentionally omit it here.
     */
    hasModelKwargs =
      applyOpenRouterReasoningConfig({
        reasoningEffort,
        model: modelOptions.model,
        modelKwargs,
        llmConfig,
      }) || hasModelKwargs;
  }

  if (llmConfig.max_tokens != null) {
    llmConfig.maxTokens = llmConfig.max_tokens;
    delete llmConfig.max_tokens;
  }

  const tools: BindToolsInput[] = [];

  /** Check if web_search should be disabled via dropParams */
  if (dropParams && dropParams.includes('web_search')) {
    enableWebSearch = false;
  }
  if (dropParams && dropParams.includes('promptCache')) {
    enablePromptCache = false;
  }
  if (dropParams && dropParams.includes('promptCacheTtl')) {
    promptCacheTtlValue = undefined;
  }

  if (useOpenRouter && enableWebSearch) {
    /** OpenRouter expects web search as a plugins parameter */
    modelKwargs.plugins = [{ id: 'web' }];
    hasModelKwargs = true;
  } else if (enableWebSearch) {
    /** Standard OpenAI web search uses tools API */
    llmConfig.useResponsesApi = true;
    tools.push({ type: 'web_search' });
  }
  if (useOpenRouter && enablePromptCache === true) {
    llmConfig.promptCache = true;
    /** Pass an explicit TTL when configured; otherwise the agents SDK defaults to 1h */
    if (promptCacheTtlValue != null) {
      llmConfig.promptCacheTtl = promptCacheTtlValue;
    }
  }

  /**
   * Default GPT-5.6 reasoning requests to the Responses API unless explicitly set.
   * Reads `llmConfig.model` (reflects `addParams` overrides) and skips when
   * `dropParams` removes `reasoning_effort` later anyway (`'reasoning'` only
   * drops the nested object, not the flat param) or opts out of the Responses
   * API entirely. Limited to first-party OpenAI: OpenRouter, custom gateways
   * (non-canonical base URL), and `reasoningFormat: 'disabled'` (no reasoning
   * payload is sent) keep their existing Chat Completions path.
   */
  const responsesApiOptedOut =
    dropParams != null &&
    (dropParams.includes('reasoning_effort') || dropParams.includes('useResponsesApi'));
  /**
   * The GPT-5.6 default above is reasoning-driven, so dropping `reasoning_effort`
   * removes its reason to route. GPT-6's is not: it takes Responses for every
   * turn, and a drop rule clearing an unsupported stored effort must not also
   * disable its routing. Only an explicit `useResponsesApi` drop does that.
   */
  const responsesApiExplicitlyOptedOut =
    dropParams != null && dropParams.includes('useResponsesApi');
  const firstPartyOpenAI =
    !useOpenRouter && endpoint === EModelEndpoint.openAI && isCanonicalOpenAIBaseURL(baseURL);
  const firstPartyAzure =
    !useOpenRouter &&
    endpoint === EModelEndpoint.azureOpenAI &&
    isCanonicalAzureBaseURL(baseURL, azure);
  const firstPartyEndpoint = firstPartyOpenAI || firstPartyAzure;
  /** Keep GPT-6 model identity on Azure, with the deployment name used on the wire. */
  const firstPartyResponsesModel =
    firstPartyEndpoint && prefersResponsesApiByModel(llmConfig.model);
  if (
    firstPartyOpenAI &&
    reasoningFormat !== ReasoningParameterFormat.disabled &&
    llmConfig.useResponsesApi == null &&
    !responsesApiOptedOut &&
    requiresResponsesApiForReasoning({ model: llmConfig.model, reasoningEffort })
  ) {
    llmConfig.useResponsesApi = true;
  }

  /**
   * Route GPT-6 to Responses before invocation, including unset effort, so tools
   * bound later cannot accidentally reach Chat Completions with default reasoning.
   */
  if (
    firstPartyResponsesModel &&
    llmConfig.useResponsesApi == null &&
    !responsesApiExplicitlyOptedOut
  ) {
    llmConfig.useResponsesApi = true;
  }

  /**
   * Declare the first-party surface for the agents SDK's model-specific request
   * constraints. Computed here, from the same checks the Responses default
   * above uses, so the decision lives in one place: OpenRouter and custom
   * gateways route through endpoints whose contract is not OpenAI's, and only
   * this layer can tell them apart.
   */
  if (firstPartyEndpoint) {
    llmConfig.firstPartyEndpoint = true;
  }

  /** Settle an administrator route drop before shaping API-specific fields.
   * The drop loop later removes the flag, but it must already govern effort. */
  if (responsesApiExplicitlyOptedOut) llmConfig.useResponsesApi = false;

  const solLunaRulesApply =
    firstPartyEndpoint && /^gpt-6-(?:sol|luna)(?:-|$)/i.test(llmConfig.model ?? '');
  if (!useOpenRouter) {
    hasModelKwargs =
      applyReasoningConfig({
        endpoint,
        llmConfig,
        modelKwargs,
        reasoningFormat,
        reasoningEffort,
        reasoningSummary,
        reasoningMode,
        reasoningContext,
      }) || hasModelKwargs;
  }

  /** Flat effort is an ignored constructor field in Chat Completions. Convert
   * after shaping (including nested defaults), before administrator drops. */
  if (solLunaRulesApply && llmConfig.useResponsesApi !== true) {
    const effort = llmConfig.reasoning_effort ?? llmConfig.reasoning?.effort;
    if (effort != null && effort !== '') {
      modelKwargs.reasoning_effort = effort;
      hasModelKwargs = true;
    }
    delete llmConfig.reasoning_effort;
  }

  /** DeepSeek thinking-mode requires `reasoning_content` replay on tool turns (#13366). */
  const isDeepSeekModel =
    typeof modelOptions.model === 'string' &&
    /^deepseek(?:[-/]|$)/i.test(modelOptions.model.replace(/^~/, ''));
  if (isDeepSeekModel) {
    llmConfig.includeReasoningContent = true;
  }

  /**
   * Note: OpenAI reasoning models (o1/o3/gpt-5) do not support temperature and other sampling parameters
   * Exception: gpt-5-chat and versioned models like gpt-5.1 DO support these parameters
   */
  if (
    modelOptions.model &&
    /\b(o[13]|gpt-5)(?!\.|-chat)(?:-|$)/.test(modelOptions.model as string)
  ) {
    const reasoningExcludeParams = [
      'frequencyPenalty',
      'presencePenalty',
      'temperature',
      'topP',
      'logitBias',
      'n',
      'logprobs',
    ];

    const updatedDropParams = dropParams || [];
    const combinedDropParams = [...new Set([...updatedDropParams, ...reasoningExcludeParams])];

    combinedDropParams.forEach((param) => deleteConfigParam({ param, llmConfig, modelKwargs }));
  } else if (modelOptions.model && /gpt-4o.*search/.test(modelOptions.model as string)) {
    /**
     * Note: OpenAI Web Search models do not support any known parameters besides `max_tokens`
     */
    const searchExcludeParams = [
      'frequency_penalty',
      'presence_penalty',
      'reasoning',
      'reasoning_effort',
      'temperature',
      'top_p',
      'top_k',
      'stop',
      'logit_bias',
      'seed',
      'response_format',
      'n',
      'logprobs',
      'user',
    ];

    const updatedDropParams = dropParams || [];
    const combinedDropParams = [...new Set([...updatedDropParams, ...searchExcludeParams])];

    combinedDropParams.forEach((param) => deleteConfigParam({ param, llmConfig, modelKwargs }));
  } else if (dropParams && Array.isArray(dropParams)) {
    dropParams.forEach((param) => deleteConfigParam({ param, llmConfig, modelKwargs }));
  }

  /** Normalize the final effective value in either API, regardless of whether
   * it came from saved settings, flat params, or a nested configured object.
   * Copy nested objects so administrator defaults are never mutated. */
  if (solLunaRulesApply) {
    if (llmConfig.reasoning?.effort === ReasoningEffort.minimal) {
      llmConfig.reasoning = { ...llmConfig.reasoning, effort: ReasoningEffort.low };
    }
    if (modelKwargs.reasoning_effort === ReasoningEffort.minimal) {
      modelKwargs.reasoning_effort = ReasoningEffort.low;
    }
  }

  /** Sol/Luna reject sampling controls when Responses uses reasoning. The
   * provider default is medium, so an unset effort is reasoning-enabled too.
   * Strip only the request copy; saved settings remain available when the user
   * switches models or explicitly selects `none`. */
  const solLunaResponsesReasoning =
    solLunaRulesApply &&
    llmConfig.useResponsesApi === true &&
    llmConfig.reasoning?.effort !== ReasoningEffort.none;
  if (solLunaResponsesReasoning) {
    for (const param of [
      'temperature',
      'topP',
      'top_p',
      'logprobs',
      'topLogprobs',
      'top_logprobs',
    ]) {
      deleteConfigParam({ param, llmConfig, modelKwargs });
    }
    for (const target of [llmConfig as Record<string, unknown>, modelKwargs]) {
      if (Array.isArray(target.include)) {
        target.include = target.include.filter((value) => value !== 'message.output_text.logprobs');
      }
    }
  }

  hasModelKwargs =
    applyResponsesVerbosity({
      llmConfig,
      modelKwargs,
      useOpenRouter,
    }) || hasModelKwargs;

  if (
    llmConfig.model &&
    /\bgpt-[5-9](?:\.\d+)?\b/i.test(llmConfig.model) &&
    llmConfig.maxTokens != null
  ) {
    const paramName =
      llmConfig.useResponsesApi === true ? 'max_output_tokens' : 'max_completion_tokens';
    modelKwargs[paramName] = llmConfig.maxTokens;
    delete llmConfig.maxTokens;
    hasModelKwargs = true;
  }

  if (hasModelKwargs && Object.keys(modelKwargs).length > 0) {
    llmConfig.modelKwargs = modelKwargs;
  }

  if (!azure) {
    llmConfig.apiKey = apiKey;
    return { llmConfig, tools };
  }

  const useModelName = isEnabled(process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME);
  const model = llmConfig.model;
  const updatedAzure = { ...azure };
  updatedAzure.azureOpenAIApiDeploymentName = useModelName
    ? sanitizeModelName(llmConfig.model || '')
    : azure.azureOpenAIApiDeploymentName ||
      getAzureDeploymentName(baseURL, azure) ||
      (firstPartyResponsesModel || llmConfig.useResponsesApi ? model : undefined);

  if (process.env.AZURE_OPENAI_DEFAULT_MODEL) {
    llmConfig.model = process.env.AZURE_OPENAI_DEFAULT_MODEL;
  }

  const constructAzureOpenAIBasePath = () => {
    if (baseURL) {
      updatedAzure.azureOpenAIBasePath = constructAzureChatBasePath(baseURL, updatedAzure);
      return;
    }
    const instanceBasePath = constructAzureInstanceBasePath(updatedAzure);
    if (instanceBasePath != null && updatedAzure.azureOpenAIBasePath == null) {
      updatedAzure.azureOpenAIBasePath = instanceBasePath;
    }
  };

  constructAzureOpenAIBasePath();
  Object.assign(llmConfig, updatedAzure);

  const constructAzureResponsesApi = () => {
    if (!llmConfig.useResponsesApi) {
      return;
    }

    delete llmConfig.azureOpenAIApiDeploymentName;
    delete llmConfig.azureOpenAIApiInstanceName;
    delete llmConfig.azureOpenAIApiVersion;
    delete llmConfig.azureOpenAIBasePath;
    delete llmConfig.azureOpenAIApiKey;
    llmConfig.apiKey = apiKey;
  };

  constructAzureResponsesApi();

  /** Keep Astra's identity for SDK constraints; only the wire model is a deployment alias. */
  if (firstPartyResponsesModel) {
    llmConfig.model = model;
    llmConfig.modelKwargs = {
      ...llmConfig.modelKwargs,
      model: updatedAzure.azureOpenAIApiDeploymentName,
    };
  } else {
    llmConfig.model = updatedAzure.azureOpenAIApiDeploymentName;
  }
  return { llmConfig, tools, azure: updatedAzure };
}
