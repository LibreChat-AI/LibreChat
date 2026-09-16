import { z } from 'zod';
import type { TMessageContentParts } from './types/content';
import type { AgentSubagentGraph } from './types/agents';
import type { SearchResultData } from './types/web';
import type { FunctionTool } from './types/tools';
import type { TFile } from './types/files';
import { CODE_ENVIRONMENT_MODES, CODE_WORKSPACE_ID_PATTERN } from './code/workspace';
import { userSubmittedMessageFieldPathSchema } from './filters';
import { TFeedback, feedbackSchema } from './feedback';
import { CODE_APPROVAL_MODES } from './code/approval';
import { Tools } from './types/tools';

export const isUUID = z.string().uuid();

export enum AuthType {
  OVERRIDE_AUTH = 'override_auth',
  USER_PROVIDED = 'user_provided',
  SYSTEM_DEFINED = 'system_defined',
}

export const authTypeSchema = z.nativeEnum(AuthType);

export enum EModelEndpoint {
  azureOpenAI = 'azureOpenAI',
  openAI = 'openAI',
  google = 'google',
  anthropic = 'anthropic',
  assistants = 'assistants',
  azureAssistants = 'azureAssistants',
  agents = 'agents',
  custom = 'custom',
  bedrock = 'bedrock',
}

/** Mirrors `@librechat/agents` providers */
export enum Providers {
  OPENAI = 'openAI',
  ANTHROPIC = 'anthropic',
  AZURE = 'azureOpenAI',
  GOOGLE = 'google',
  VERTEXAI = 'vertexai',
  BEDROCK = 'bedrock',
  MISTRALAI = 'mistralai',
  MISTRAL = 'mistral',
  DEEPSEEK = 'deepseek',
  MOONSHOT = 'moonshot',
  OPENROUTER = 'openrouter',
  XAI = 'xai',
}

/**
 * Endpoints that support direct PDF processing in the agent system
 */
export const documentSupportedProviders = new Set<string>([
  EModelEndpoint.anthropic,
  EModelEndpoint.openAI,
  EModelEndpoint.bedrock,
  EModelEndpoint.custom,
  // handled in AttachFileMenu and DragDropModal since azureOpenAI only supports documents with Use Responses API set to true
  // EModelEndpoint.azureOpenAI,
  EModelEndpoint.google,
  Providers.VERTEXAI,
  Providers.MISTRALAI,
  Providers.MISTRAL,
  Providers.DEEPSEEK,
  Providers.MOONSHOT,
  Providers.OPENROUTER,
  Providers.XAI,
]);

const openAILikeProviders = new Set<string>([
  Providers.OPENAI,
  Providers.AZURE,
  EModelEndpoint.custom,
  Providers.MISTRALAI,
  Providers.MISTRAL,
  Providers.DEEPSEEK,
  Providers.MOONSHOT,
  Providers.OPENROUTER,
  Providers.XAI,
]);

export const isOpenAILikeProvider = (provider?: string | null): boolean => {
  return openAILikeProviders.has(provider ?? '');
};

/**
 * Providers whose `usage_metadata.input_tokens` ALREADY INCLUDES cached tokens
 * (`input_token_details.cache_*` is a subset, not an additional charge):
 * Google/Vertex (`promptTokenCount`), OpenAI/Azure (`prompt_tokens`), and the
 * OpenAI-compatible family. `@librechat/agents`' `getAnthropicUsageMetadata`
 * folds `cache_creation` + `cache_read` into `input_tokens`, so Anthropic is a
 * subset provider too; without this the cache portion is billed twice. Bedrock
 * stays additive — its Converse path passes AWS `inputTokens` through unmodified.
 * Single source of truth shared by the backend billing path
 * (`packages/api/src/agents/usage.ts`) and the client usage normalization.
 */
export const cacheSubsetProviders = new Set<string>([
  Providers.OPENAI,
  Providers.AZURE,
  Providers.GOOGLE,
  Providers.VERTEXAI,
  Providers.XAI,
  Providers.DEEPSEEK,
  Providers.OPENROUTER,
  Providers.MOONSHOT,
  Providers.ANTHROPIC,
]);

export const inputTokensIncludesCache = (provider?: string | null): boolean => {
  return cacheSubsetProviders.has(provider ?? '');
};

export const isDocumentSupportedProvider = (provider?: string | null): boolean => {
  const normalized = provider?.toLowerCase() ?? '';
  return Array.from(documentSupportedProviders).some(
    (candidate) => candidate.toLowerCase() === normalized,
  );
};

/**
 * Endpoints whose encoders actually build native audio/video payloads. Narrower than
 * `documentSupportedProviders`: a provider can accept PDFs and still emit nothing for
 * media, in which case the upload has to fall back to text/STT.
 */
export const mediaSupportedProviders = new Set<string>([
  EModelEndpoint.google,
  Providers.VERTEXAI,
  Providers.OPENROUTER,
]);

export const isMediaSupportedProvider = (provider?: string | null): boolean => {
  return mediaSupportedProviders.has(provider?.toLowerCase() ?? '');
};

/**
 * Built-in endpoint and provider identifiers. A name outside this set is a custom
 * endpoint whose real provider is resolved at request time, so its capabilities
 * cannot be judged from the name alone.
 */
const knownProviderIdentifiers = new Set<string>([
  ...Object.values(EModelEndpoint),
  ...Object.values(Providers),
  ...Object.values(EModelEndpoint).map((provider) => provider.toLowerCase()),
  ...Object.values(Providers).map((provider) => provider.toLowerCase()),
]);

export const isKnownProviderIdentifier = (provider?: string | null): boolean => {
  return knownProviderIdentifiers.has(provider?.toLowerCase() ?? '');
};

export const paramEndpoints = new Set<EModelEndpoint | string>([
  EModelEndpoint.agents,
  EModelEndpoint.openAI,
  EModelEndpoint.bedrock,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.anthropic,
  EModelEndpoint.custom,
  EModelEndpoint.google,
]);

export enum BedrockProviders {
  AI21 = 'ai21',
  Amazon = 'amazon',
  Anthropic = 'anthropic',
  Cohere = 'cohere',
  DeepSeek = 'deepseek',
  Meta = 'meta',
  MistralAI = 'mistral',
  Moonshot = 'moonshot',
  MoonshotAI = 'moonshotai',
  OpenAI = 'openai',
  StabilityAI = 'stability',
  ZAI = 'zai',
}

export const getModelKey = (endpoint: EModelEndpoint | string, model: string) => {
  if (endpoint === EModelEndpoint.bedrock) {
    const parts = model.split('.');
    const provider = [parts[0], parts[1]].find((part) =>
      Object.values(BedrockProviders).includes(part as BedrockProviders),
    );
    return (provider ?? parts[0]) as BedrockProviders;
  }
  return model;
};

export const getSettingsKeys = (endpoint: EModelEndpoint | string, model: string) => {
  const endpointKey = endpoint;
  const modelKey = getModelKey(endpointKey, model);
  const combinedKey = `${endpointKey}-${modelKey}`;
  return [combinedKey, endpointKey];
};

export type AssistantsEndpoint = EModelEndpoint.assistants | EModelEndpoint.azureAssistants;

export const isAssistantsEndpoint = (_endpoint?: AssistantsEndpoint | null | string): boolean => {
  const endpoint = _endpoint ?? '';
  if (!endpoint) {
    return false;
  }
  return endpoint.toLowerCase().endsWith(EModelEndpoint.assistants);
};

export type AgentProvider = Exclude<keyof typeof EModelEndpoint, EModelEndpoint.agents> | string;

export const isAgentsEndpoint = (_endpoint?: EModelEndpoint.agents | null | string): boolean => {
  const endpoint = _endpoint ?? '';
  if (!endpoint) {
    return false;
  }
  return endpoint === EModelEndpoint.agents;
};

export const isParamEndpoint = (
  endpoint: EModelEndpoint | string,
  endpointType?: EModelEndpoint | string,
): boolean => {
  if (paramEndpoints.has(endpoint)) {
    return true;
  }

  if (endpointType != null) {
    return paramEndpoints.has(endpointType);
  }

  return false;
};

export enum ImageDetail {
  low = 'low',
  auto = 'auto',
  high = 'high',
}

export enum ReasoningEffort {
  unset = '',
  none = 'none',
  minimal = 'minimal',
  low = 'low',
  medium = 'medium',
  high = 'high',
  xhigh = 'xhigh',
  max = 'max',
}

export enum ReasoningParameterFormat {
  disabled = 'disabled',
  reasoningEffort = 'reasoning_effort',
  reasoningObject = 'reasoning_object',
}

export enum ReasoningResponseKey {
  reasoning = 'reasoning',
  reasoningContent = 'reasoning_content',
}

export enum AnthropicEffort {
  unset = '',
  low = 'low',
  medium = 'medium',
  high = 'high',
  xhigh = 'xhigh',
  max = 'max',
}

/**
 * Controls whether the model's reasoning content is returned in responses.
 *
 * - `'auto'` - LibreChat decides: opt in to `'summarized'` for models that
 *   omit by default (Opus 4.7+), leave the field off for older models.
 * - `'summarized'` - always request a post-hoc summary of the reasoning.
 * - `'omitted'` - always suppress reasoning content. Slightly lower latency.
 *
 * See https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-7#thinking-content-omitted-by-default
 */
export enum ThinkingDisplay {
  auto = 'auto',
  summarized = 'summarized',
  omitted = 'omitted',
}

/**
 * Wire-level values accepted by the Anthropic Messages API `thinking.display`
 * field. Excludes the LibreChat-only `'auto'` sentinel.
 */
export type ThinkingDisplayWireValue = Exclude<ThinkingDisplay, ThinkingDisplay.auto>;

export enum BedrockReasoningConfig {
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum ReasoningSummary {
  none = '',
  auto = 'auto',
  concise = 'concise',
  detailed = 'detailed',
}

export enum Verbosity {
  none = '',
  low = 'low',
  medium = 'medium',
  high = 'high',
}

export enum ThinkingLevel {
  unset = '',
  minimal = 'minimal',
  low = 'low',
  medium = 'medium',
  high = 'high',
}

/** OpenAI Responses API `reasoning.mode` (GPT-5.6+). */
export enum ReasoningMode {
  unset = '',
  standard = 'standard',
  pro = 'pro',
}

/** OpenAI Responses API `reasoning.context` (GPT-5.6+). */
export enum ReasoningContext {
  unset = '',
  auto = 'auto',
  current_turn = 'current_turn',
  all_turns = 'all_turns',
}

export const imageDetailNumeric = {
  [ImageDetail.low]: 0,
  [ImageDetail.auto]: 1,
  [ImageDetail.high]: 2,
};

export const imageDetailValue = {
  0: ImageDetail.low,
  1: ImageDetail.auto,
  2: ImageDetail.high,
};

export const eImageDetailSchema = z.nativeEnum(ImageDetail);
export const eReasoningEffortSchema = z.nativeEnum(ReasoningEffort);
export const eReasoningParameterFormatSchema = z.nativeEnum(ReasoningParameterFormat);
export const eReasoningResponseKeySchema = z.nativeEnum(ReasoningResponseKey);
export const eAnthropicEffortSchema = z.nativeEnum(AnthropicEffort);
export const eThinkingDisplaySchema = z.nativeEnum(ThinkingDisplay);
export const eReasoningSummarySchema = z.nativeEnum(ReasoningSummary);
export const eVerbositySchema = z.nativeEnum(Verbosity);
export const eThinkingLevelSchema = z.nativeEnum(ThinkingLevel);
export const eReasoningModeSchema = z.nativeEnum(ReasoningMode);
export const eReasoningContextSchema = z.nativeEnum(ReasoningContext);

export const reasoningOverrideSchema = z.discriminatedUnion('key', [
  z
    .object({
      key: z.literal('reasoning_effort'),
      value: eReasoningEffortSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('effort'),
      value: eAnthropicEffortSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('thinkingLevel'),
      value: eThinkingLevelSchema,
    })
    .strict(),
  z
    .object({
      key: z.literal('thinkingBudget'),
      value: z.number().int().min(-1).max(200000),
    })
    .strict(),
]);

export type TReasoningOverride = z.infer<typeof reasoningOverrideSchema>;

export const defaultAssistantFormValues = {
  assistant: '',
  id: '',
  name: '',
  description: '',
  instructions: '',
  conversation_starters: [],
  model: '',
  functions: [],
  code_interpreter: false,
  image_vision: false,
  retrieval: false,
  append_current_datetime: false,
};

export const defaultAgentFormValues = {
  agent: {},
  id: '',
  name: '',
  description: '',
  instructions: '',
  model: '',
  model_parameters: {},
  tools: [],
  tool_options: {},
  provider: {},
  edges: [],
  artifacts: '',
  recursion_limit: undefined,
  [Tools.execute_code]: false,
  [Tools.file_search]: false,
  [Tools.web_search]: false,
  [Tools.memory]: false,
  stateful_code_environment: 'user' as const,
  code_environment_id: undefined as string | null | undefined,
  code_workspace_id: undefined as string | undefined,
  repositoryInstructions: undefined as 'prefer' | 'defer' | 'off' | undefined,
  category: 'general',
  support_contact: {
    name: '',
    email: '',
  },
  /** Optional allowlist. Only applies when `skills_enabled === true`.
   *  Empty/undefined + enabled = full catalog; non-empty + enabled = narrow to ids. */
  skills: undefined as string[] | undefined,
  /** Master toggle for skill use on this agent. `true` activates skills
   *  (full catalog unless `skills` narrows it). Anything else = inactive. */
  skills_enabled: undefined as boolean | undefined,
  /** Enables runtime skill creation without exposing an existing skill catalog. */
  skill_authoring_enabled: undefined as boolean | undefined,
  /** Explicit catalog scope. Missing preserves the legacy enabled + empty = all behavior. */
  skills_scope: undefined as SkillsScope | undefined,
  /** `undefined` = feature disabled by default (no subagent tool injected). */
  subagents: undefined as
    | {
        enabled?: boolean;
        allowSelf?: boolean;
        agent_ids?: string[];
        graphs?: AgentSubagentGraph[];
      }
    | undefined,
  /** Memory partition: 'agent' isolates memories per (user, agent); default shared pool */
  memory_scope: undefined as MemoryScope | undefined,
};

export const ImageVisionTool: FunctionTool = {
  type: Tools.function,
  [Tools.function]: {
    name: 'image_vision',
    description: 'Get detailed text descriptions for all current image attachments.',
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
};

/** Structural on purpose: accepts assistants tools/tool calls and agents function tool
 *  calls alike — the check only ever reads `type` and `function.name`. */
export const isImageVisionTool = (tool: { type?: string; function?: { name?: string } }) =>
  tool.type === 'function' && tool.function?.name === ImageVisionTool.function?.name;

export const openAISettings = {
  model: {
    default: 'gpt-4o-mini' as const,
  },
  temperature: {
    min: 0 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  top_p: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  presence_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  frequency_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  resendFiles: {
    default: true as const,
  },
  maxContextTokens: {
    default: undefined,
  },
  max_tokens: {
    default: undefined,
  },
  imageDetail: {
    default: ImageDetail.auto as const,
    min: 0 as const,
    max: 2 as const,
    step: 1 as const,
  },
};

/**
 * `65535` (not 65536) is the value valid on both Google AI Studio and Vertex AI:
 * Vertex caps current Gemini text models at 65,535 output tokens, so defaulting to
 * 65,536 would make otherwise-default Vertex requests fail validation.
 */
const GOOGLE_MAX_OUTPUT = 65535 as const;
const GOOGLE_IMAGE_MAX_OUTPUT = 32768 as const;
const GOOGLE_LEGACY_MAX_OUTPUT = 8192 as const;

/**
 * Resolves the documented max output-token limit for a Google/Gemini model.
 * Current Gemini text models (2.5 and 3+) support 64K output tokens; their image
 * variants (e.g. `gemini-2.5-flash-image`) cap at 32K; legacy/deprecated models
 * (2.0 and earlier, including legacy image models) and Gemma retain the 8K limit.
 */
const getGoogleMaxOutputTokens = (modelName: string): number => {
  if (/gemini-(?:2\.5|[3-9]|\d{2,})/i.test(modelName)) {
    if (/image/i.test(modelName)) {
      return GOOGLE_IMAGE_MAX_OUTPUT;
    }
    return GOOGLE_MAX_OUTPUT;
  }
  return GOOGLE_LEGACY_MAX_OUTPUT;
};

/**
 * Per-model thinking budget bounds, documented in
 * `com_endpoint_google_thinking_budget`: Gemini 2.5 Pro accepts 128-32,768,
 * Flash accepts 0-24,576, and Flash Lite accepts 512-24,576. The generic
 * 32,000 in the shared definition both under-limits Pro and lets invalid
 * Flash values through.
 *
 * `-1` remains the "decide automatically" sentinel and is not part of these
 * floors. Callers must keep `range.min` at -1 and apply `min` only to
 * non-negative values.
 */
const GOOGLE_THINKING_BUDGET_PRO_MAX = 32768 as const;
const GOOGLE_THINKING_BUDGET_FLASH_MAX = 24576 as const;
const GOOGLE_THINKING_BUDGET_PRO_MIN = 128 as const;
const GOOGLE_THINKING_BUDGET_FLASH_MIN = 0 as const;
const GOOGLE_THINKING_BUDGET_FLASH_LITE_MIN = 512 as const;

export type GoogleThinkingBudgetBounds = { min: number; max: number };

export const getGoogleThinkingBudgetBounds = (
  modelName: string,
): GoogleThinkingBudgetBounds | undefined => {
  if (!/gemini-2\.5/i.test(modelName)) {
    return undefined;
  }
  if (/flash[-_.]?lite/i.test(modelName)) {
    return { min: GOOGLE_THINKING_BUDGET_FLASH_LITE_MIN, max: GOOGLE_THINKING_BUDGET_FLASH_MAX };
  }
  if (/flash/i.test(modelName)) {
    return { min: GOOGLE_THINKING_BUDGET_FLASH_MIN, max: GOOGLE_THINKING_BUDGET_FLASH_MAX };
  }
  if (/pro/i.test(modelName)) {
    return { min: GOOGLE_THINKING_BUDGET_PRO_MIN, max: GOOGLE_THINKING_BUDGET_PRO_MAX };
  }
  return undefined;
};

export const getGoogleThinkingBudgetMax = (modelName: string): number | undefined =>
  getGoogleThinkingBudgetBounds(modelName)?.max;

export const googleSettings = {
  model: {
    default: 'gemini-1.5-flash-latest' as const,
  },
  maxContextTokens: {
    min: 10 as const,
    max: 2000000 as const,
    step: 1000 as const,
  },
  maxOutputTokens: {
    min: 1 as const,
    max: GOOGLE_MAX_OUTPUT,
    step: 1 as const,
    default: GOOGLE_LEGACY_MAX_OUTPUT,
    reset: (modelName: string): number => getGoogleMaxOutputTokens(modelName),
    set: (value: number, modelName: string): number => {
      const max = getGoogleMaxOutputTokens(modelName);
      return value > max ? max : value;
    },
  },
  temperature: {
    min: 0 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  topP: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 0.95 as const,
  },
  topK: {
    min: 1 as const,
    max: 40 as const,
    step: 1 as const,
    default: 40 as const,
  },
  thinking: {
    default: true as const,
  },
  thinkingBudget: {
    min: -1 as const,
    max: 32000 as const,
    step: 1 as const,
    /** `-1` = Dynamic Thinking, meaning the model will adjust
     * the budget based on the complexity of the request.
     */
    default: -1 as const,
  },
  thinkingLevel: {
    default: ThinkingLevel.unset as const,
  },
};

const ANTHROPIC_MAX_OUTPUT = 128000 as const;
const CLAUDE_4_64K_MAX_OUTPUT = 64000 as const;
const CLAUDE_32K_MAX_OUTPUT = 32000 as const;
const DEFAULT_MAX_OUTPUT = 8192 as const;
const LEGACY_ANTHROPIC_MAX_OUTPUT = 4096 as const;
const CLAUDE_SONNET_128K_OUTPUT_PATTERN =
  /claude-sonnet[-.]?(?:4[-.]?(?:[6-9]|\d{2})|[5-9]|\d{2,})(?=$|[^0-9])/;

/**
 * Claude "Mythos-class" model families — new top-level classes (peers of
 * `opus`/`sonnet`/`haiku`) that ship with the post-Opus-4.7 modern profile:
 * adaptive thinking always on, raw thinking omitted by default (summarized
 * opt-in), sampling parameters rejected, and a 1M context window. The tier
 * word is the class name itself, so the `opus`/`sonnet` version parsers don't
 * cover them.
 *
 * Single source of truth: add a future sibling class name here and every
 * Mythos-class gate (adaptive thinking, sampling omission, prompt caching, 1M
 * context, 128K output) picks it up.
 */
export const MYTHOS_CLASS_FAMILIES = ['fable', 'mythos'] as const;
const MYTHOS_CLASS_PATTERN = new RegExp(`claude-(?:${MYTHOS_CLASS_FAMILIES.join('|')})[-.]?\\d`);

/** Whether the model is a Claude Mythos-class model (e.g. `claude-fable-5`). */
export function isMythosClassModel(model: string): boolean {
  return MYTHOS_CLASS_PATTERN.test(model);
}

export const anthropicSettings = {
  model: {
    default: 'claude-3-5-sonnet-latest' as const,
  },
  temperature: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  promptCache: {
    default: true as const,
  },
  promptCacheTtl: {
    default: undefined,
  },
  thinking: {
    default: true as const,
  },
  thinkingBudget: {
    min: 1024 as const,
    step: 100 as const,
    max: 200000 as const,
    default: 2000 as const,
  },
  maxOutputTokens: {
    min: 1 as const,
    max: ANTHROPIC_MAX_OUTPUT,
    step: 1 as const,
    default: DEFAULT_MAX_OUTPUT,
    reset: (modelName: string) => {
      if (isMythosClassModel(modelName)) {
        return ANTHROPIC_MAX_OUTPUT;
      }

      if (/claude-opus[-.]?(?:4[-.]?(?:[6-9]|\d{2,})|[5-9]|\d{2,})/.test(modelName)) {
        return ANTHROPIC_MAX_OUTPUT;
      }

      if (CLAUDE_SONNET_128K_OUTPUT_PATTERN.test(modelName)) {
        return ANTHROPIC_MAX_OUTPUT;
      }

      if (/claude-(?:sonnet|haiku)[-.]?[4-9]/.test(modelName)) {
        return CLAUDE_4_64K_MAX_OUTPUT;
      }

      if (/claude-opus[-.]?(?:[5-9]|4[-.]?([5-9]|\d{2,}))/.test(modelName)) {
        return CLAUDE_4_64K_MAX_OUTPUT;
      }

      if (/claude-opus[-.]?[4-9]/.test(modelName)) {
        return CLAUDE_32K_MAX_OUTPUT;
      }

      return DEFAULT_MAX_OUTPUT;
    },
    set: (value: number, modelName: string) => {
      if (isMythosClassModel(modelName)) {
        if (value > ANTHROPIC_MAX_OUTPUT) {
          return ANTHROPIC_MAX_OUTPUT;
        }
        return value;
      }

      if (/claude-opus[-.]?(?:4[-.]?(?:[6-9]|\d{2,})|[5-9]|\d{2,})/.test(modelName)) {
        if (value > ANTHROPIC_MAX_OUTPUT) {
          return ANTHROPIC_MAX_OUTPUT;
        }
        return value;
      }

      if (CLAUDE_SONNET_128K_OUTPUT_PATTERN.test(modelName)) {
        if (value > ANTHROPIC_MAX_OUTPUT) {
          return ANTHROPIC_MAX_OUTPUT;
        }
        return value;
      }

      if (/claude-(?:sonnet|haiku)[-.]?[4-9]/.test(modelName) && value > CLAUDE_4_64K_MAX_OUTPUT) {
        return CLAUDE_4_64K_MAX_OUTPUT;
      }

      if (/claude-opus[-.]?(?:[5-9]|4[-.]?([5-9]|\d{2,}))/.test(modelName)) {
        if (value > CLAUDE_4_64K_MAX_OUTPUT) {
          return CLAUDE_4_64K_MAX_OUTPUT;
        }
        return value;
      }

      if (/claude-opus[-.]?[4-9]/.test(modelName) && value > CLAUDE_32K_MAX_OUTPUT) {
        return CLAUDE_32K_MAX_OUTPUT;
      }

      if (value > ANTHROPIC_MAX_OUTPUT) {
        return ANTHROPIC_MAX_OUTPUT;
      }

      return value;
    },
  },
  topP: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 0.7 as const,
  },
  topK: {
    min: 1 as const,
    max: 40 as const,
    step: 1 as const,
    default: 5 as const,
  },
  resendFiles: {
    default: true as const,
  },
  maxContextTokens: {
    default: undefined,
  },
  legacy: {
    maxOutputTokens: {
      min: 1 as const,
      max: LEGACY_ANTHROPIC_MAX_OUTPUT,
      step: 1 as const,
      default: LEGACY_ANTHROPIC_MAX_OUTPUT,
    },
  },
  effort: {
    default: AnthropicEffort.unset,
    options: [
      AnthropicEffort.unset,
      AnthropicEffort.low,
      AnthropicEffort.medium,
      AnthropicEffort.high,
      AnthropicEffort.xhigh,
      AnthropicEffort.max,
    ],
  },
  thinkingDisplay: {
    default: ThinkingDisplay.auto,
    options: [ThinkingDisplay.auto, ThinkingDisplay.summarized, ThinkingDisplay.omitted],
  },
  web_search: {
    default: false as const,
  },
};

export const agentsSettings = {
  model: {
    default: 'gpt-3.5-turbo-test' as const,
  },
  temperature: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  top_p: {
    min: 0 as const,
    max: 1 as const,
    step: 0.01 as const,
    default: 1 as const,
  },
  presence_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  frequency_penalty: {
    min: -2 as const,
    max: 2 as const,
    step: 0.01 as const,
    default: 0 as const,
  },
  resendFiles: {
    default: true as const,
  },
  maxContextTokens: {
    default: undefined,
  },
  max_tokens: {
    default: undefined,
  },
  imageDetail: {
    default: ImageDetail.auto as const,
  },
};

export const endpointSettings = {
  [EModelEndpoint.openAI]: openAISettings,
  [EModelEndpoint.google]: googleSettings,
  [EModelEndpoint.anthropic]: anthropicSettings,
  [EModelEndpoint.agents]: agentsSettings,
  [EModelEndpoint.bedrock]: agentsSettings,
};

const google = endpointSettings[EModelEndpoint.google];

export const eModelEndpointSchema = z.nativeEnum(EModelEndpoint);

export const extendedModelEndpointSchema = z.union([eModelEndpointSchema, z.string()]);

export const tPluginAuthConfigSchema = z.object({
  authField: z.string(),
  label: z.string(),
  description: z.string(),
  optional: z.boolean().optional(),
  /** Whether the field holds a secret and should be masked in the UI (defaults to masked when omitted). */
  sensitive: z.boolean().optional(),
});

export type TPluginAuthConfig = z.infer<typeof tPluginAuthConfigSchema>;

export const tPluginSchema = z.object({
  name: z.string(),
  pluginKey: z.string(),
  description: z.string().optional(),
  icon: z.string().optional(),
  authConfig: z.array(tPluginAuthConfigSchema).optional(),
  authenticated: z.boolean().optional(),
  chatMenu: z.boolean().optional(),
  isButton: z.boolean().optional(),
  toolkit: z.boolean().optional(),
  /** Raw upstream tool name when the model-facing key stripped a redundant
   *  server-name prefix — proves upstream identity for legacy id migration. */
  serverToolName: z.string().optional(),
});

export type TPlugin = z.infer<typeof tPluginSchema>;

export type TInput = {
  inputStr: string;
};

export const tExampleSchema = z.object({
  input: z.object({
    content: z.string(),
  }),
  output: z.object({
    content: z.string(),
  }),
});

export type TExample = z.infer<typeof tExampleSchema>;

/** Compact context-fading tier persisted beside a message's calibration ratio. */
const agentFadingTierSchema = z.object({
  v: z.literal(1),
  budgetTokens: z.number().positive(),
  masked: z.boolean(),
});

export const tMessageSchema = z.object({
  messageId: z.string(),
  endpoint: z.string().optional(),
  clientId: z.string().nullable().optional(),
  conversationId: z.string().nullable(),
  parentMessageId: z.string().nullable(),
  responseMessageId: z.string().nullable().optional(),
  overrideParentMessageId: z.string().nullable().optional(),
  bg: z.string().nullable().optional(),
  model: z.string().nullable().optional(),
  title: z.string().nullable().or(z.literal('New Chat')).default('New Chat'),
  sender: z.string().optional(),
  text: z.string(),
  /** @deprecated */
  generation: z.string().nullable().optional(),
  isCreatedByUser: z.boolean(),
  /** True when the complete stored row came from outside the model. */
  isUserSubmitted: z.boolean().optional(),
  /** JSON pointers to caller-authored fields in an otherwise mixed model response. */
  userSubmittedPaths: z.array(z.string().startsWith('/')).optional(),
  /** Exact HITL message-field identity for caller-authored values stored in mixed responses. */
  userSubmittedMessageFieldPaths: z.array(userSubmittedMessageFieldPathSchema).optional(),
  isTemporary: z.boolean().optional(),
  expiredAt: z.string().nullable().optional(),
  error: z.boolean().optional(),
  clientTimestamp: z.string().optional(),
  createdAt: z
    .string()
    .optional()
    .default(() => new Date().toISOString()),
  updatedAt: z
    .string()
    .optional()
    .default(() => new Date().toISOString()),
  current: z.boolean().optional(),
  unfinished: z.boolean().optional(),
  searchResult: z.boolean().optional(),
  finish_reason: z.string().optional(),
  /* assistant */
  thread_id: z.string().optional(),
  /* frontend components */
  iconURL: z.string().nullable().optional(),
  feedback: feedbackSchema.optional(),
  /** metadata */
  metadata: z.record(z.unknown()).optional(),
  /** Output tokens for assistant messages, calibrated prompt-side estimate for user messages */
  tokenCount: z.number().optional(),
  contextMeta: z
    .object({
      calibrationRatio: z
        .number()
        .optional()
        .describe(
          'EMA ratio of provider-reported vs local token estimates; seeds the pruner on subsequent runs',
        ),
      encoding: z
        .string()
        .optional()
        .describe(
          'Tokenizer encoding used when this ratio was computed (e.g. "claude", "o200k_base")',
        ),
      fading: agentFadingTierSchema
        .optional()
        .describe(
          'Latched context-fading tier of the default agent; seeds the next run so the provider projection of history keeps the same bytes',
        ),
      fadingTiers: z
        .array(agentFadingTierSchema.extend({ agentId: z.string().min(1) }))
        .optional()
        .describe('Latched context-fading tiers keyed by agent ID, stored as entries'),
    })
    .optional(),
  /**
   * Skill names the user invoked manually via the `$` popover on this turn.
   * Purely UI metadata — `SkillPills` renders these above the message
   * bubble so users can see which skills they asked for in history and on
   * reload. Runtime resolution uses the top-level payload field with the
   * same name. Empty / absent for model-invoked skills (shown as tool_call
   * content parts on the assistant message instead).
   */
  manualSkills: z.array(z.string()).optional(),
  /**
   * Skill names auto-primed on this turn because their `always-apply`
   * frontmatter flag is set. Persisted at turn time so the pinned-variant
   * pills on the user bubble survive reload and stay stable across later
   * edits to the skill's `alwaysApply` flag (the user bubble reflects
   * what actually ran, not the current catalog).
   */
  alwaysAppliedSkills: z.array(z.string()).optional(),
  /**
   * Verbatim excerpts the user quoted (via the "Add to chat" selection
   * popup) to reference on this turn. UI metadata that `MessageQuotes`
   * renders above the user bubble so the references persist on reload. The
   * excerpts are merged into the user message text sent to the model at
   * request time and counted in the user message token count.
   */
  quotes: z.array(z.string()).optional(),
  /** Request-scoped reasoning selection that produced this user turn. */
  reasoningOverride: reasoningOverrideSchema.optional(),
});

/**
 * Which memory partition an agent reads/writes.
 * `user` = the shared personal pool (default); `agent` = a partition
 * isolated per (user, agent) so the agent only sees its own memories.
 */
export enum MemoryScope {
  user = 'user',
  agent = 'agent',
}

/** Catalog exposure for a persisted agent with skills enabled. */
export enum SkillsScope {
  all = 'all',
  selected = 'selected',
  none = 'none',
}

/** Resolves explicit and legacy persisted-agent skill catalog states. */
export function resolveAgentSkillsScope(
  skills: readonly string[] | undefined,
  enabled: boolean | undefined,
  scope: SkillsScope | undefined,
): SkillsScope {
  if (enabled !== true) {
    return SkillsScope.none;
  }
  if (scope !== undefined) {
    return scope;
  }
  return (skills ?? []).length > 0 ? SkillsScope.selected : SkillsScope.all;
}

export type MemoryArtifact = {
  key: string;
  value?: string;
  tokenCount?: number;
  type: 'update' | 'delete' | 'error';
  /** Agent partition the write targeted; absent = shared personal pool */
  agentId?: string;
};

export type UIResource = {
  resourceId: string;
  uri: string;
  name?: string;
  mimeType?: string;
  text?: string;
  serverName?: string;
  toolName?: string;
  /** Opaque server-issued binding required for executable MCP App callbacks. */
  serverBinding?: string;
  structuredContent?: Record<string, unknown>;
  content?: unknown[];
  csp?: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  permissions?: {
    camera?: Record<string, never>;
    microphone?: Record<string, never>;
    geolocation?: Record<string, never>;
    clipboardWrite?: Record<string, never>;
  };
  toolArgs?: Record<string, unknown>;
  isError?: boolean;
  resultMeta?: Record<string, unknown>;
  [key: string]: unknown;
};

export type WorkspaceChange = {
  profile: 'stateful';
  operation: 'created' | 'updated';
  path: string;
};

export type TAttachmentMetadata = {
  type?: Tools;
  messageId: string;
  toolCallId: string;
  /** Saved-agent owner when provider tool-call ids repeat across handoffs. */
  agentId?: string;
  /** Host run-step owner when one agent repeats a provider tool-call id. */
  stepId?: string;
  workspaceChange?: WorkspaceChange;
  [Tools.memory]?: MemoryArtifact;
  [Tools.ui_resources]?: UIResource[];
  [Tools.web_search]?: SearchResultData;
  [Tools.file_search]?: SearchResultData;
};

export type TAttachment =
  | (TFile & TAttachmentMetadata)
  | (Pick<TFile, 'filename' | 'filepath' | 'conversationId'> & {
      expiresAt: number;
    } & TAttachmentMetadata)
  | (Partial<Pick<TFile, 'filename' | 'filepath'>> &
      Pick<TFile, 'conversationId'> &
      TAttachmentMetadata);

export type TMessage = z.input<typeof tMessageSchema> & {
  children?: TMessage[];
  content?: TMessageContentParts[];
  files?: Partial<TFile>[];
  depth?: number;
  siblingIndex?: number;
  attachments?: TAttachment[];
  clientTimestamp?: string;
  /** Client-only durable branch anchor while this message is an optimistic response. */
  clientQueueParentMessageId?: string;
  feedback?: TFeedback;
};

export const coerceNumber = z.union([z.number(), z.string()]).transform((val) => {
  if (typeof val === 'string') {
    return val.trim() === '' ? undefined : parseFloat(val);
  }
  return val;
});

type DocumentTypeValue =
  | null
  | boolean
  | number
  | string
  | DocumentTypeValue[]
  | { [key: string]: DocumentTypeValue };

const DocumentType: z.ZodType<DocumentTypeValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(z.lazy(() => DocumentType)),
    z.record(z.lazy(() => DocumentType)),
  ]),
);

export const subagentThreadLineageSchema = z.object({
  rootConversationId: z.string().min(1),
  parentConversationId: z.string().min(1),
  parentMessageId: z.string().min(1),
  parentToolCallId: z.string().min(1),
  parentAgentId: z.string().min(1).optional(),
  subagentType: z.string().min(1),
  subagentKind: z.enum(['agent', 'graph']),
  depth: z.number().int().positive(),
});

export type TSubagentThreadLineage = z.infer<typeof subagentThreadLineageSchema>;

export const tConversationSchema = z.object({
  conversationId: z.string().nullable(),
  endpoint: eModelEndpointSchema.nullable(),
  endpointType: eModelEndpointSchema.nullable().optional(),
  isArchived: z.boolean().optional(),
  /** When the chat was archived; absent on chats archived before this was recorded. */
  archivedAt: z.string().nullable().optional(),
  pinned: z.boolean().optional(),
  /** Server-derived: an active shared link exists for this conversation. Not persisted. */
  isShared: z.boolean().optional(),
  codeApprovalMode: z.enum(CODE_APPROVAL_MODES).optional(),
  codeEnvironmentMode: z.enum(CODE_ENVIRONMENT_MODES).optional(),
  codeWorkspaces: z
    .array(
      z
        .object({
          environmentId: z.string().regex(CODE_WORKSPACE_ID_PATTERN),
          workspaceId: z.string().regex(CODE_WORKSPACE_ID_PATTERN),
        })
        .strict(),
    )
    .optional(),
  title: z.string().nullable().or(z.literal('New Chat')).default('New Chat'),
  user: z.string().optional(),
  messages: z.array(z.string()).optional(),
  tools: z.union([z.array(tPluginSchema), z.array(z.string())]).optional(),
  modelLabel: z.string().nullable().optional(),
  userLabel: z.string().optional(),
  model: z.string().nullable().optional(),
  promptPrefix: z.string().nullable().optional(),
  temperature: z.number().nullable().optional(),
  topP: z.number().optional(),
  topK: z.number().optional(),
  top_p: z.number().optional(),
  frequency_penalty: z.number().optional(),
  presence_penalty: z.number().optional(),
  parentMessageId: z.string().optional(),
  maxOutputTokens: coerceNumber.nullable().optional(),
  maxContextTokens: coerceNumber.optional(),
  max_tokens: coerceNumber.optional(),
  /* Anthropic */
  promptCache: z.boolean().optional(),
  promptCacheTtl: z.enum(['5m', '1h']).optional(),
  system: z.string().optional(),
  thinking: z.boolean().optional(),
  thinkingBudget: coerceNumber.optional(),
  thinkingLevel: eThinkingLevelSchema.optional(),
  stream: z.boolean().optional(),
  /* artifacts */
  artifacts: z.string().optional(),
  /* google */
  context: z.string().nullable().optional(),
  examples: z.array(tExampleSchema).optional(),
  /* DB */
  tags: z.array(z.string()).optional(),
  chatProjectId: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Set only when an assistant message is persisted; drives the unseen-reply indicator. */
  lastResponseAt: z.string().optional(),
  /** Durable messageId of the assistant reply named by `lastResponseAt`. */
  lastResponseMessageId: z.string().optional(),
  /** True only while `lastResponseAt` is the synthetic marker from "mark unread". */
  lastResponseIsManual: z.boolean().optional(),
  /** Set when the user has the newest message on screen; compared against `lastResponseAt`. */
  lastSeenAt: z.string().optional(),
  /* Files */
  resendFiles: z.boolean().optional(),
  file_ids: z.array(z.string()).optional(),
  /* vision */
  imageDetail: eImageDetailSchema.optional(),
  /* OpenAI: Reasoning models only */
  reasoning_effort: eReasoningEffortSchema.optional().nullable(),
  reasoning_summary: eReasoningSummarySchema.optional().nullable(),
  /* OpenAI Responses API: reasoning mode (standard/pro) + context */
  reasoning_mode: eReasoningModeSchema.optional().nullable(),
  reasoning_context: eReasoningContextSchema.optional().nullable(),
  /* OpenAI: Verbosity control */
  verbosity: eVerbositySchema.optional().nullable(),
  /* OpenAI: use Responses API */
  useResponsesApi: z.boolean().optional(),
  /* Anthropic: Effort control */
  effort: eAnthropicEffortSchema.optional().nullable(),
  /* Anthropic: Thinking visibility (Opus 4.7+ opt-in) */
  thinkingDisplay: eThinkingDisplaySchema.optional().nullable(),
  /* OpenAI Responses API / Anthropic API / Google API */
  web_search: z.boolean().optional(),
  /* Google API: URL Context tool (+ native YouTube video understanding) */
  url_context: z.boolean().optional(),
  /* disable streaming */
  disableStreaming: z.boolean().optional(),
  /* assistant */
  assistant_id: z.string().optional(),
  /* agents */
  agent_id: z.string().optional(),
  /** Durable parent/child navigation for a subagent thread. */
  subagentThread: subagentThreadLineageSchema.optional(),
  /* AWS Bedrock */
  region: z.string().optional(),
  maxTokens: coerceNumber.optional(),
  additionalModelRequestFields: DocumentType.optional(),
  /* assistants */
  instructions: z.string().optional(),
  additional_instructions: z.string().optional(),
  append_current_datetime: z.boolean().optional(),
  /** Used to overwrite active conversation settings when saving a Preset */
  presetOverride: z.record(z.unknown()).optional(),
  stop: z.array(z.string()).optional(),
  /* frontend components */
  greeting: z.string().optional(),
  spec: z.string().nullable().optional(),
  iconURL: z.string().nullable().optional(),
  /* temporary chat */
  expiredAt: z.string().nullable().optional(),
  isTemporary: z.boolean().optional(),
  /* file token limits */
  fileTokenLimit: coerceNumber.optional(),
  /** @deprecated */
  resendImages: z.boolean().optional(),
  /** @deprecated Prefer `modelLabel` over `chatGptLabel` */
  chatGptLabel: z.string().nullable().optional(),
});

export const tPresetSchema = tConversationSchema
  .omit({
    conversationId: true,
    chatProjectId: true,
    createdAt: true,
    updatedAt: true,
    title: true,
    /* Runtime unseen-reply state must not ride into presets: applying one would stamp
       stale timestamps back onto conversations. */
    lastResponseAt: true,
    lastResponseMessageId: true,
    lastResponseIsManual: true,
    lastSeenAt: true,
  })
  .merge(
    z.object({
      conversationId: z.string().nullable().optional(),
      presetId: z.string().nullable().optional(),
      title: z.string().nullable().optional(),
      defaultPreset: z.boolean().optional(),
      order: z.number().optional(),
      endpoint: extendedModelEndpointSchema.nullable(),
    }),
  );

export const tConvoUpdateSchema = tConversationSchema.merge(
  z.object({
    endpoint: extendedModelEndpointSchema.nullable(),
    createdAt: z.string().optional(),
    updatedAt: z.string().optional(),
  }),
);

export const tQueryParamsSchema = tConversationSchema
  .pick({
    // librechat settings
    /** The model spec to be used */
    spec: true,
    /** The AI context window, overrides the system-defined window as determined by `model` value */
    maxContextTokens: true,
    /**
     * Whether or not to re-submit files from previous messages on subsequent messages
     * */
    resendFiles: true,
    /**
     * @endpoints openAI, custom, azureOpenAI
     *
     * System parameter that only affects the above endpoints.
     * Image detail for re-sizing according to OpenAI spec, defaults to `auto`
     * */
    imageDetail: true,
    /**
     * AKA Custom Instructions, dynamically added to chat history as a system message;
     * for `bedrock` endpoint, this is used as the `system` model param if the provider uses it;
     * for `assistants` endpoint, this is used as the `additional_instructions` model param:
     * https://platform.openai.com/docs/api-reference/runs/createRun#runs-createrun-additional_instructions
     * ; otherwise, a message with `system` role is added to the chat history
     */
    promptPrefix: true,
    // Model parameters
    /** @endpoints openAI, custom, azureOpenAI, google, anthropic, assistants, azureAssistants, bedrock */
    model: true,
    /** @endpoints openAI, custom, azureOpenAI, google, anthropic, bedrock */
    temperature: true,
    /** @endpoints openAI, custom, azureOpenAI */
    presence_penalty: true,
    /** @endpoints openAI, custom, azureOpenAI */
    frequency_penalty: true,
    /** @endpoints openAI, custom, azureOpenAI */
    stop: true,
    /** @endpoints openAI, custom, azureOpenAI */
    top_p: true,
    /** @endpoints openAI, custom, azureOpenAI */
    max_tokens: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_effort: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_summary: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_mode: true,
    /** @endpoints openAI, custom, azureOpenAI */
    reasoning_context: true,
    /** @endpoints openAI, custom, azureOpenAI */
    verbosity: true,
    /** @endpoints openAI, custom, azureOpenAI */
    useResponsesApi: true,
    /** @endpoints openAI, anthropic, google */
    web_search: true,
    /** @endpoints google */
    url_context: true,
    /** @endpoints openAI, custom, azureOpenAI */
    disableStreaming: true,
    /** @endpoints google, anthropic, bedrock */
    topP: true,
    /** @endpoints google, anthropic */
    topK: true,
    /** @endpoints google, anthropic */
    maxOutputTokens: true,
    /** @endpoints anthropic */
    promptCache: true,
    promptCacheTtl: true,
    thinking: true,
    thinkingBudget: true,
    thinkingLevel: true,
    effort: true,
    thinkingDisplay: true,
    /** @endpoints bedrock */
    region: true,
    /** @endpoints bedrock */
    maxTokens: true,
    /** @endpoints agents */
    agent_id: true,
    /** @endpoints assistants, azureAssistants */
    assistant_id: true,
    /** @endpoints assistants, azureAssistants */
    append_current_datetime: true,
    /**
     * @endpoints assistants, azureAssistants
     *
     * Overrides existing assistant instructions, only used for the current run:
     * https://platform.openai.com/docs/api-reference/runs/createRun#runs-createrun-instructions
     * */
    instructions: true,
    /** @endpoints openAI, google, anthropic */
    fileTokenLimit: true,
  })
  .merge(
    z.object({
      /** @endpoints openAI, custom, azureOpenAI, google, anthropic, assistants, azureAssistants, bedrock, agents */
      endpoint: extendedModelEndpointSchema.nullable(),
    }),
  );

/** Narrowed preset schema for use in model specs — omits system/DB/deprecated fields.
 *
 * `greeting` and `iconURL` are admin-configurable display fields on a model spec's
 * preset (landing greeting, preset-level icon fallback) and must be preserved.
 * `spec` is set by the client from `modelSpec.name` via `getModelSpecPreset` and is
 * omitted to avoid duplicate configuration surface.
 */
export const tModelSpecPresetSchema = tPresetSchema
  .omit({
    conversationId: true,
    presetId: true,
    title: true,
    defaultPreset: true,
    order: true,
    isArchived: true,
    user: true,
    messages: true,
    tags: true,
    file_ids: true,
    expiredAt: true,
    parentMessageId: true,
    resendImages: true,
    chatGptLabel: true,
    presetOverride: true,
    spec: true,
  })
  .merge(
    z.object({
      /**
       * Optional here, unlike `tPresetSchema`, where the key is required (though
       * nullable). A preset naming an `agent_id` has an unambiguous endpoint, so
       * config may omit it and `resolveModelSpecEndpoint` infers `agents` when
       * specs are materialized at config load.
       */
      endpoint: extendedModelEndpointSchema.nullish(),
    }),
  )
  .superRefine((preset, ctx) => {
    /**
     * Omission is only legal when the endpoint is inferable, which requires a
     * NON-EMPTY `agent_id` — form-backed writers persist untouched fields as
     * `''`, which names no agent. An explicit `endpoint: null` stays accepted:
     * it validated before the key became optional, so rejecting it now would
     * break previously valid configs.
     */
    if (preset.endpoint === undefined && !preset.agent_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['endpoint'],
        message:
          'endpoint is required unless the preset names a non-empty agent_id (the agents endpoint is then inferred)',
      });
    }
  });

export type TModelSpecPreset = z.infer<typeof tModelSpecPresetSchema>;

export type TPreset = z.infer<typeof tPresetSchema>;

export type TSetOption = (
  param: number | string,
) => (newValue: number | string | boolean | string[] | Partial<TPreset>) => void;

export type TConversation = z.infer<typeof tConversationSchema> & {
  presetOverride?: Partial<TPreset>;
  disableParams?: boolean;
};

export const tSharedLinkSchema = z.object({
  conversationId: z.string(),
  shareId: z.string(),
  targetMessageId: z.string().optional(),
  messages: z.array(z.string()),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type TSharedLink = z.infer<typeof tSharedLinkSchema>;

export const tConversationTagSchema = z.object({
  _id: z.string(),
  user: z.string(),
  tag: z.string(),
  description: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  count: z.number(),
  position: z.number(),
});
export type TConversationTag = z.infer<typeof tConversationTagSchema>;

export const googleBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  promptPrefix: true,
  examples: true,
  temperature: true,
  maxOutputTokens: true,
  resendFiles: true,
  artifacts: true,
  topP: true,
  topK: true,
  thinking: true,
  thinkingBudget: true,
  thinkingLevel: true,
  web_search: true,
  url_context: true,
  fileTokenLimit: true,
  iconURL: true,
  greeting: true,
  spec: true,
  maxContextTokens: true,
});

export const googleSchema = googleBaseSchema
  .transform((obj: Partial<TConversation>) => removeNullishValues(obj, true))
  .catch(() => ({}));

/**
   * TODO: Map the following fields:
  - presence_penalty -> presencePenalty
  - frequency_penalty -> frequencyPenalty
  - stop -> stopSequences
   */
export const googleGenConfigSchema = z
  .object({
    maxOutputTokens: coerceNumber.optional(),
    temperature: coerceNumber.optional(),
    topP: coerceNumber.optional(),
    topK: coerceNumber.optional(),
    presencePenalty: coerceNumber.optional(),
    frequencyPenalty: coerceNumber.optional(),
    stopSequences: z.array(z.string()).optional(),
    thinkingConfig: z
      .object({
        includeThoughts: z.boolean().optional(),
        thinkingBudget: coerceNumber.optional(),
        thinkingLevel: z.string().optional(),
      })
      .optional(),
    web_search: z.boolean().optional(),
    url_context: z.boolean().optional(),
  })
  .strip()
  .optional();

export function removeNullishValues<T extends Record<string, unknown>>(
  obj: T,
  removeEmptyStrings?: boolean,
): Partial<T> {
  const newObj: Partial<T> = { ...obj };

  (Object.keys(newObj) as Array<keyof T>).forEach((key) => {
    const value = newObj[key];
    if (value === undefined || value === null) {
      delete newObj[key];
    }
    if (removeEmptyStrings && typeof value === 'string' && value === '') {
      delete newObj[key];
    }
  });

  return newObj;
}

const assistantBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  assistant_id: true,
  instructions: true,
  artifacts: true,
  promptPrefix: true,
  iconURL: true,
  greeting: true,
  spec: true,
  append_current_datetime: true,
});

export const assistantSchema = assistantBaseSchema
  .transform((obj) => ({
    ...obj,
    model: obj.model ?? openAISettings.model.default,
    assistant_id: obj.assistant_id ?? undefined,
    instructions: obj.instructions ?? undefined,
    promptPrefix: obj.promptPrefix ?? null,
    iconURL: obj.iconURL ?? undefined,
    greeting: obj.greeting ?? undefined,
    spec: obj.spec ?? undefined,
    append_current_datetime: obj.append_current_datetime ?? false,
  }))
  .catch(() => ({
    model: openAISettings.model.default,
    assistant_id: undefined,
    instructions: undefined,
    promptPrefix: null,
    iconURL: undefined,
    greeting: undefined,
    spec: undefined,
    append_current_datetime: false,
  }));

const compactAssistantBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  assistant_id: true,
  instructions: true,
  promptPrefix: true,
  artifacts: true,
  iconURL: true,
  greeting: true,
  spec: true,
});

export const compactAssistantSchema = compactAssistantBaseSchema
  .transform((obj) => removeNullishValues(obj))
  .catch(() => ({}));

export const agentsBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  temperature: true,
  top_p: true,
  presence_penalty: true,
  frequency_penalty: true,
  resendFiles: true,
  imageDetail: true,
  agent_id: true,
  instructions: true,
  promptPrefix: true,
  iconURL: true,
  greeting: true,
  maxContextTokens: true,
});

export const agentsSchema = agentsBaseSchema
  .transform((obj) => ({
    ...obj,
    model: obj.model ?? agentsSettings.model.default,
    modelLabel: obj.modelLabel ?? null,
    temperature: obj.temperature ?? 1,
    top_p: obj.top_p ?? 1,
    presence_penalty: obj.presence_penalty ?? 0,
    frequency_penalty: obj.frequency_penalty ?? 0,
    resendFiles:
      typeof obj.resendFiles === 'boolean' ? obj.resendFiles : agentsSettings.resendFiles.default,
    imageDetail: obj.imageDetail ?? ImageDetail.auto,
    agent_id: obj.agent_id ?? undefined,
    instructions: obj.instructions ?? undefined,
    promptPrefix: obj.promptPrefix ?? null,
    iconURL: obj.iconURL ?? undefined,
    greeting: obj.greeting ?? undefined,
    maxContextTokens: obj.maxContextTokens ?? undefined,
  }))
  .catch(() => ({
    model: agentsSettings.model.default,
    modelLabel: null,
    temperature: 1,
    top_p: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
    resendFiles: agentsSettings.resendFiles.default,
    imageDetail: ImageDetail.auto,
    agent_id: undefined,
    instructions: undefined,
    promptPrefix: null,
    iconURL: undefined,
    greeting: undefined,
    maxContextTokens: undefined,
  }));

export const openAIBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  chatGptLabel: true,
  promptPrefix: true,
  temperature: true,
  top_p: true,
  presence_penalty: true,
  frequency_penalty: true,
  resendFiles: true,
  artifacts: true,
  imageDetail: true,
  stop: true,
  iconURL: true,
  greeting: true,
  spec: true,
  maxContextTokens: true,
  max_tokens: true,
  reasoning_effort: true,
  reasoning_summary: true,
  reasoning_mode: true,
  reasoning_context: true,
  verbosity: true,
  useResponsesApi: true,
  web_search: true,
  disableStreaming: true,
  fileTokenLimit: true,
});

export const openAISchema = openAIBaseSchema
  .transform((obj: Partial<TConversation>) => removeNullishValues(obj, true))
  .catch(() => ({}));

export const openRouterSchema = openAIBaseSchema
  .merge(tConversationSchema.pick({ promptCache: true, promptCacheTtl: true }))
  .transform((obj: Partial<TConversation>) => removeNullishValues(obj, true))
  .catch(() => ({}));

export const compactGoogleSchema = googleBaseSchema
  .transform((obj) => {
    const newObj: Partial<TConversation> = { ...obj };
    if (newObj.temperature === google.temperature.default) {
      delete newObj.temperature;
    }
    if (newObj.maxOutputTokens === google.maxOutputTokens.reset(newObj.model ?? '')) {
      delete newObj.maxOutputTokens;
    }
    if (newObj.topP === google.topP.default) {
      delete newObj.topP;
    }
    if (newObj.topK === google.topK.default) {
      delete newObj.topK;
    }

    return removeNullishValues(newObj, true);
  })
  .catch(() => ({}));

export const anthropicBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  model: true,
  modelLabel: true,
  promptPrefix: true,
  temperature: true,
  maxOutputTokens: true,
  topP: true,
  topK: true,
  resendFiles: true,
  promptCache: true,
  promptCacheTtl: true,
  thinking: true,
  thinkingBudget: true,
  effort: true,
  thinkingDisplay: true,
  artifacts: true,
  iconURL: true,
  greeting: true,
  spec: true,
  maxContextTokens: true,
  web_search: true,
  fileTokenLimit: true,
  stop: true,
  stream: true,
});

export const anthropicSchema = anthropicBaseSchema
  .transform((obj) => removeNullishValues(obj))
  .catch(() => ({}));

export const tBannerSchema = z.object({
  bannerId: z.string(),
  message: z.string(),
  displayFrom: z.string(),
  displayTo: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isPublic: z.boolean(),
  persistable: z.boolean().default(false),
});
export type TBanner = z.infer<typeof tBannerSchema>;

export const compactAgentsBaseSchema = tConversationSchema.pick({
  chatProjectId: true,
  spec: true,
  // model: true,
  iconURL: true,
  greeting: true,
  agent_id: true,
  instructions: true,
  additional_instructions: true,
});

export const compactAgentsSchema = compactAgentsBaseSchema
  .transform((obj) => removeNullishValues(obj))
  .catch(() => ({}));
