import { z } from 'zod';
import { tConversationSchema, THINKING_BLOCK_BINDING } from 'librechat-data-provider';
import type { Agent, TEndpoint } from 'librechat-data-provider';
import { sanitizeModelParameters } from './parameters';

type InferenceIssue = {
  path: string[];
  code: 'unsupported_parameter' | 'invalid_parameter';
};

type InferenceResult = {
  parameters: Record<string, unknown>;
  customParameters: Record<string, unknown>;
  issues: InferenceIssue[];
};

// Runtime-only provenance survives object spreads, but cannot arrive through JSON input.
const inferenceSource = Symbol('agentInferenceSource');
type AgentWithInferenceSource = Agent & {
  [inferenceSource]?: {
    provider: string;
    resolvedProvider: string;
    resolvedParameters: Agent['model_parameters'];
    parameters: Record<string, unknown>;
  };
};

/** Restore only input captured for this exact SDK configuration, never a submitted envelope. */
export function restoreAgentInferenceInput(agent: Agent): Agent {
  const source = (agent as AgentWithInferenceSource)[inferenceSource];
  if (
    source == null ||
    source.resolvedProvider !== agent.provider ||
    source.resolvedParameters !== agent.model_parameters
  ) {
    return agent;
  }
  return {
    ...agent,
    provider: source.provider,
    model_parameters: { ...source.parameters } as Agent['model_parameters'],
  };
}

/** Capture validated flat values before this runtime instance is reused for another run. */
export function retainAgentInferenceInput(
  agent: Agent,
  provider: string,
  parameters: Record<string, unknown>,
): void {
  (agent as AgentWithInferenceSource)[inferenceSource] = {
    provider,
    resolvedProvider: agent.provider,
    resolvedParameters: agent.model_parameters,
    parameters: { ...parameters },
  };
}

type Family = 'openai' | 'anthropic' | 'google' | 'bedrock' | 'mistral';
type CustomDefinition = NonNullable<
  NonNullable<TEndpoint['customParams']>['paramDefinitions']
>[number];
type Fields = Readonly<Record<string, z.ZodTypeAny>>;

const flat = tConversationSchema.shape;
const tokens = z.number().finite().int().nonnegative();
const probability = z.number().finite().min(0).max(1);
const penalty = z.number().finite().min(-2).max(2);
const region = z
  .string()
  .max(63)
  .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)+-\d+$/);
const legacyThinking = z
  .object({
    type: z.enum(['enabled', 'adaptive', 'disabled', 'between_tools']),
    display: flat.thinkingDisplay,
    budget_tokens: tokens.optional(),
    block_binding: z
      .object({
        prefix_mismatch_behavior: z.literal(THINKING_BLOCK_BINDING.prefix_mismatch_behavior),
      })
      .strict()
      .optional(),
  })
  .strict();
const common: Fields = {
  maxContextTokens: flat.maxContextTokens.pipe(z.number().finite().int().min(-1)),
  fileTokenLimit: flat.fileTokenLimit.pipe(tokens),
  resendFiles: flat.resendFiles,
  imageDetail: flat.imageDetail,
  promptPrefix: flat.promptPrefix,
  disableStreaming: flat.disableStreaming,
};
const openai: Fields = {
  ...common,
  temperature: flat.temperature.pipe(z.number().finite().min(0).max(2)),
  top_p: flat.top_p.pipe(probability),
  frequency_penalty: flat.frequency_penalty.pipe(penalty),
  presence_penalty: flat.presence_penalty.pipe(penalty),
  max_tokens: flat.max_tokens.pipe(tokens),
  stop: flat.stop,
  reasoning_effort: flat.reasoning_effort,
  reasoning_summary: flat.reasoning_summary,
  reasoning_mode: flat.reasoning_mode,
  reasoning_context: flat.reasoning_context,
  verbosity: flat.verbosity,
  useResponsesApi: flat.useResponsesApi,
  web_search: flat.web_search,
};
const openrouter: Fields = {
  ...openai,
  promptCache: flat.promptCache,
  promptCacheTtl: flat.promptCacheTtl,
};
const anthropic: Fields = {
  ...common,
  temperature: flat.temperature.pipe(probability),
  topP: flat.topP.pipe(probability),
  topK: flat.topK.pipe(tokens),
  maxOutputTokens: flat.maxOutputTokens.pipe(tokens),
  stop: flat.stop,
  promptCache: flat.promptCache,
  promptCacheTtl: flat.promptCacheTtl,
  thinking: flat.thinking,
  thinkingBudget: flat.thinkingBudget.pipe(tokens),
  effort: flat.effort,
  thinkingDisplay: flat.thinkingDisplay,
  web_search: flat.web_search,
};
const google: Fields = {
  ...common,
  temperature: flat.temperature.pipe(z.number().finite().min(0).max(2)),
  topP: flat.topP.pipe(probability),
  topK: flat.topK.pipe(tokens),
  maxOutputTokens: flat.maxOutputTokens.pipe(tokens),
  stop: flat.stop,
  thinking: flat.thinking,
  thinkingBudget: flat.thinkingBudget.pipe(z.number().finite().int().min(-1)),
  thinkingLevel: flat.thinkingLevel,
  web_search: flat.web_search,
  url_context: flat.url_context,
};
const bedrock: Fields = {
  ...common,
  region,
  reasoning_effort: flat.reasoning_effort,
  temperature: flat.temperature.pipe(probability),
  topP: flat.topP.pipe(probability),
  topK: flat.topK.pipe(tokens),
  maxTokens: flat.maxTokens.pipe(tokens),
  stop: flat.stop,
  system: flat.system,
  promptCache: flat.promptCache,
  promptCacheTtl: flat.promptCacheTtl,
};
const bedrockAnthropic: Fields = {
  ...bedrock,
  thinking: flat.thinking,
  thinkingBudget: flat.thinkingBudget.pipe(tokens),
  effort: flat.effort,
  thinkingDisplay: flat.thinkingDisplay,
};
const mistral: Fields = {
  ...common,
  temperature: flat.temperature.pipe(probability),
  topP: flat.topP.pipe(probability),
  maxTokens: flat.maxTokens.pipe(tokens),
  stop: flat.stop,
};

const profiles: Record<Family, Fields> = { openai, anthropic, google, bedrock, mistral };
const builtinKeys = new Set(Object.values(profiles).flatMap((fields) => Object.keys(fields)));
const aliases: Readonly<Record<string, string>> = {
  max_context_tokens: 'maxContextTokens',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
  thinking_budget: 'thinkingBudget',
  top_k: 'topK',
  stopSequences: 'stop',
  stop_sequences: 'stop',
  reasoningEffort: 'reasoning_effort',
  reasoningSummary: 'reasoning_summary',
  reasoningMode: 'reasoning_mode',
  reasoningContext: 'reasoning_context',
};

// Admin declarations describe flat wire extras, never clients or request identity.
const conversationKeys = new Set(
  Object.keys(flat).map((key) => key.replace(/_/g, '').toLowerCase()),
);
const reservedCustomKeys = new Set(
  [
    'model',
    'modelName',
    'modelId',
    'modelProvider',
    'models',
    'modelList',
    'modelKwargs',
    'invocationKwargs',
    'route',
    'routing',
    'fallback',
    'fallbacks',
    'fallbackClient',
    'fallbackClients',
    'provider',
    'providers',
    'messages',
    'input',
    'contents',
    'prompt',
    'system',
    'context',
    'examples',
    'instructions',
    'additionalInstructions',
    'tools',
    'toolChoice',
    'functions',
    'functionCall',
    'parallelToolCalls',
    'includeServerSideToolInvocations',
    'callbacks',
    'callback',
    'callbackManager',
    'timeout',
    'requestTimeout',
    'timeoutMs',
    'requestTimeoutMs',
    'retries',
    'maxRetries',
    'signal',
    'abortSignal',
    'abortController',
    'fetch',
    'tags',
    'metadata',
    'client',
    'clientOptions',
    'httpClient',
    'httpOptions',
    'fetchOptions',
    'transport',
    'connectionOptions',
    'agent',
    'maxConcurrency',
    'verbose',
    'configuration',
    'config',
    'httpAgent',
    'httpsAgent',
    'headers',
    'defaultHeaders',
    'defaultQuery',
    'query',
    'body',
    'extraBody',
    'method',
    'requestOptions',
    'apiKey',
    'apiKeys',
    'openAIApiKey',
    'anthropicApiKey',
    'googleApiKey',
    'azureOpenAIApiKey',
    'azureOpenAIApiInstanceName',
    'azureOpenAIApiDeploymentName',
    'azureOpenAIApiVersion',
    'apiVersion',
    'safetyIdentifier',
    'apiBase',
    'apiBaseURL',
    'baseURL',
    'basePath',
    'url',
    'endpoint',
    'endpoints',
    'deployment',
    'deploymentName',
    'deploymentId',
    'project',
    'projectId',
    'organization',
    'organizationId',
    'user',
    'userId',
    'credentials',
    'credential',
    'accessKeyId',
    'secretAccessKey',
    'sessionToken',
    'password',
    'token',
    'auth',
    'authorization',
    'connection',
    'proxy',
    'region',
    'stream',
    'streaming',
    'cache',
    'store',
    'previousResponseId',
    'conversation',
    'conversationId',
    'sessionId',
    'threadId',
    'assistantId',
    'agentId',
    'presetOverride',
    'additionalModelRequestFields',
    'reasoning',
    'thinkingConfig',
    'responseFormat',
    'generationConfig',
    'safetySettings',
    'constructor',
    'prototype',
  ].map((key) => key.replace(/_/g, '').toLowerCase()),
);

function isCustomKey(key: string): boolean {
  return (
    /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) &&
    !key.toLowerCase().startsWith('lc_') &&
    !conversationKeys.has(key.replace(/_/g, '').toLowerCase()) &&
    !reservedCustomKeys.has(key.replace(/_/g, '').toLowerCase())
  );
}

function knownFamily(provider: string): Family | undefined {
  switch (provider.toLowerCase()) {
    case 'openai':
    case 'azureopenai':
      return 'openai';
    case 'anthropic':
      return 'anthropic';
    case 'google':
    case 'vertexai':
      return 'google';
    case 'bedrock':
      return 'bedrock';
    case 'mistral':
    case 'mistralai':
      return 'mistral';
    default:
      return undefined;
  }
}

function parameterKey(key: string, family: Family): string {
  if (key === 'topP' || key === 'top_p') {
    return family === 'openai' ? 'top_p' : 'topP';
  }
  if (['max_tokens', 'maxTokens', 'maxOutputTokens', 'max_output_tokens'].includes(key)) {
    if (family === 'openai') {
      return 'max_tokens';
    }
    return family === 'bedrock' || family === 'mistral' ? 'maxTokens' : 'maxOutputTokens';
  }
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
}

function customSchema(
  definition: CustomDefinition,
  builtinValue?: unknown,
): z.ZodTypeAny | undefined {
  let type: string = definition.type ?? typeof builtinValue;
  if (definition.type == null && Array.isArray(builtinValue)) {
    type = 'array';
  }
  if (definition.type == null && definition.options != null && typeof builtinValue === 'string') {
    type = 'enum';
  }
  switch (type) {
    case 'number': {
      let schema = z.number().finite();
      const range = definition.range;
      if (range) {
        schema = schema.min(range.min).max(range.max);
      }
      const positiveMin = range?.positiveMin;
      return positiveMin == null
        ? schema
        : schema.refine((value) => value === range?.min || value >= positiveMin);
    }
    case 'boolean':
      return z.boolean();
    case 'string': {
      let schema = z.string();
      if (definition.minText != null) {
        schema = schema.min(definition.minText);
      }
      if (definition.maxText != null) {
        schema = schema.max(definition.maxText);
      }
      return schema;
    }
    case 'enum': {
      const options = definition.options;
      return options?.length ? z.string().refine((value) => options.includes(value)) : undefined;
    }
    case 'array': {
      let schema = z.array(z.union([z.string(), z.number().finite()]));
      if (definition.minTags != null) {
        schema = schema.min(definition.minTags);
      }
      if (definition.maxTags != null) {
        schema = schema.max(definition.maxTags);
      }
      const options = definition.options;
      return options == null
        ? schema
        : schema.refine((values) =>
            values.every((value) => typeof value === 'string' && options.includes(value)),
          );
    }
    default:
      return undefined;
  }
}

/** Extra YAML controls must satisfy the same policy used to project their wire values. */
export function isAgentInferenceExtension(definition: CustomDefinition): boolean {
  if (!isCustomKey(definition.key) || builtinKeys.has(definition.key)) {
    return false;
  }
  const schema = customSchema(definition);
  return (
    schema != null &&
    (definition.default === undefined || schema.safeParse(definition.default).success)
  );
}

/** Projects persisted or submitted settings without admitting SDK constructor options. */
export function resolveAgentInferenceParameters({
  parameters,
  provider,
  model,
  customParams,
  availableRegions,
}: {
  parameters: Record<string, unknown> | null | undefined;
  provider: string;
  model: string;
  customParams?: TEndpoint['customParams'];
  availableRegions?: readonly string[];
}): InferenceResult {
  const nativeFamily =
    knownFamily(provider) ?? (provider.toLowerCase().startsWith('mistral') ? 'mistral' : undefined);
  const family =
    ((nativeFamily == null || nativeFamily === 'openai') &&
      knownFamily(customParams?.defaultParamsEndpoint ?? '')) ||
    nativeFamily ||
    'openai';
  const isOpenRouter =
    provider.toLowerCase() === 'openrouter' ||
    customParams?.defaultParamsEndpoint?.toLowerCase() === 'openrouter';
  let fields = profiles[family];
  if (family === 'bedrock' && /anthropic|claude/i.test(model)) {
    fields = bedrockAnthropic;
  }
  if (family === 'openai' && isOpenRouter) {
    fields = openrouter;
  }
  const definitions = new Map(
    (customParams?.paramDefinitions ?? []).map((definition) => [
      parameterKey(definition.key, family),
      definition,
    ]),
  );
  const result: InferenceResult = { parameters: {}, customParameters: {}, issues: [] };
  if (parameters == null) {
    return result;
  }
  const source = { ...parameters };
  const stored = source.additionalModelRequestFields;
  if (
    family === 'bedrock' &&
    stored != null &&
    typeof stored === 'object' &&
    !Array.isArray(stored)
  ) {
    const preferences = stored as Record<string, unknown>;
    if (fields === bedrockAnthropic) {
      const thinking = legacyThinking.safeParse(preferences.thinking);
      if (source.thinking === undefined && thinking.success) {
        source.thinking = thinking.data;
      }
      const output = z.object({ effort: flat.effort }).safeParse(preferences.output_config);
      if (source.effort === undefined && output.success) {
        source.effort = output.data.effort;
      }
    } else {
      const effort = flat.reasoning_effort.safeParse(preferences.reasoning_config);
      if (source.reasoning_effort === undefined && effort.success) {
        source.reasoning_effort = effort.data;
      }
    }
  }
  if (family === 'anthropic' || (family === 'bedrock' && fields === bedrockAnthropic)) {
    const thinking = legacyThinking.safeParse(source.thinking);
    if (thinking.success) {
      source.thinking = !['disabled', 'between_tools'].includes(thinking.data.type);
      source.thinkingDisplay ??= thinking.data.display;
      source.thinkingBudget ??= thinking.data.budget_tokens;
    }
  }
  const sanitized = sanitizeModelParameters(source);
  for (const [key, value] of Object.entries(source)) {
    if (value == null || (typeof value === 'string' && value.trim() === '')) {
      continue;
    }
    const target = parameterKey(key, family);
    const builtin = Object.prototype.hasOwnProperty.call(fields, target);
    const definition = definitions.get(target);
    let schema = builtin ? fields[target] : undefined;
    if (!builtin && !builtinKeys.has(target) && isCustomKey(key) && definition != null) {
      schema = customSchema(definition);
    }
    if (schema == null) {
      result.issues.push({ path: [key], code: 'unsupported_parameter' });
      continue;
    }
    let candidate = sanitized[key];
    if (!builtin && definition?.type === 'number' && typeof candidate === 'string') {
      candidate = Number(candidate);
    }
    const parsed = schema.safeParse(candidate);
    if (
      !parsed.success ||
      parsed.data == null ||
      (target === 'region' &&
        availableRegions != null &&
        !availableRegions.includes(String(parsed.data)))
    ) {
      result.issues.push({ path: [key], code: 'invalid_parameter' });
      continue;
    }
    if (builtin && definition != null) {
      const constraint = customSchema(definition, parsed.data);
      if (
        constraint == null ||
        !constraint.safeParse(parsed.data).success ||
        (definition.options != null &&
          !Array.isArray(parsed.data) &&
          !definition.options.includes(String(parsed.data)))
      ) {
        result.issues.push({ path: [key], code: 'invalid_parameter' });
        continue;
      }
    }
    const destination = builtin ? result.parameters : result.customParameters;
    if (key === target || !Object.prototype.hasOwnProperty.call(destination, target)) {
      destination[target] = parsed.data;
    }
  }
  return result;
}
