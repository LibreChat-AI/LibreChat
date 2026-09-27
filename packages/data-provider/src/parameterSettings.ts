import type { SettingDefinition, SettingsConfiguration } from './generate';
import type { TReasoningOverride } from './schemas';
import type { ResponsesApiRouting } from './types';
import {
  Verbosity,
  ImageDetail,
  ThinkingLevel,
  ThinkingDisplay,
  EModelEndpoint,
  openAISettings,
  googleSettings,
  getGoogleThinkingBudgetBounds,
  Providers,
  ReasoningEffort,
  AnthropicEffort,
  ReasoningSummary,
  ReasoningMode,
  ReasoningContext,
  BedrockProviders,
  anthropicSettings,
} from './types';
import {
  getModelKey,
  getSettingsKeys,
  reasoningOverrideSchema,
  ReasoningParameterFormat,
} from './schemas';
import { isOpus55Model, supportsPromptCache, supportsAdaptiveThinking } from './bedrock';
import { resolveEffectiveUseResponsesApi } from './file-config';
import { clampSettingRange } from './generate';

// Base definitions
const baseDefinitions: Record<string, SettingDefinition> = {
  model: {
    key: 'model',
    label: 'com_ui_model',
    labelCode: true,
    type: 'string',
    component: 'dropdown',
    optionType: 'model',
    selectPlaceholder: 'com_ui_select_model',
    searchPlaceholder: 'com_ui_select_search_model',
    searchPlaceholderCode: true,
    selectPlaceholderCode: true,
    columnSpan: 4,
  },
  temperature: {
    key: 'temperature',
    label: 'com_endpoint_temperature',
    labelCode: true,
    description: 'com_endpoint_openai_temp',
    descriptionCode: true,
    type: 'number',
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  topP: {
    key: 'topP',
    label: 'com_endpoint_top_p',
    labelCode: true,
    description: 'com_endpoint_anthropic_topp',
    descriptionCode: true,
    type: 'number',
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  stop: {
    key: 'stop',
    label: 'com_endpoint_stop',
    labelCode: true,
    description: 'com_endpoint_openai_stop',
    descriptionCode: true,
    placeholder: 'com_endpoint_stop_placeholder',
    placeholderCode: true,
    type: 'array',
    default: [],
    component: 'tags',
    optionType: 'conversation',
    minTags: 0,
    maxTags: 4,
  },
};

const createDefinition = (
  base: Partial<SettingDefinition>,
  overrides: Partial<SettingDefinition>,
): SettingDefinition => {
  return { ...base, ...overrides } as SettingDefinition;
};

export const librechat = {
  modelLabel: {
    key: 'modelLabel',
    label: 'com_endpoint_custom_name',
    labelCode: true,
    type: 'string',
    default: '',
    component: 'input',
    placeholder: 'com_endpoint_openai_custom_name_placeholder',
    placeholderCode: true,
    optionType: 'conversation',
  } as const,
  maxContextTokens: {
    key: 'maxContextTokens',
    label: 'com_endpoint_context_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    description: 'com_endpoint_context_info',
    descriptionCode: true,
    optionType: 'model',
    columnSpan: 2,
  } as const,
  resendFiles: {
    key: 'resendFiles',
    label: 'com_endpoint_plug_resend_files',
    labelCode: true,
    description: 'com_endpoint_openai_resend_files',
    descriptionCode: true,
    type: 'boolean',
    default: true,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  } as const,
  promptPrefix: {
    key: 'promptPrefix',
    label: 'com_endpoint_prompt_prefix',
    labelCode: true,
    type: 'string',
    default: '',
    component: 'textarea',
    placeholder: 'com_endpoint_openai_prompt_prefix_placeholder',
    placeholderCode: true,
    optionType: 'model',
  } as const,
  /** Controls how LibreChat encodes image content blocks, not a provider request
   * parameter — so it belongs to this group and is stripped from model options. */
  imageDetail: {
    key: 'imageDetail',
    label: 'com_endpoint_plug_image_detail',
    labelCode: true,
    description: 'com_endpoint_openai_detail',
    descriptionCode: true,
    type: 'enum',
    default: ImageDetail.auto,
    component: 'slider',
    options: [ImageDetail.low, ImageDetail.auto, ImageDetail.high],
    enumMappings: {
      [ImageDetail.low]: 'com_ui_low',
      [ImageDetail.auto]: 'com_ui_auto',
      [ImageDetail.high]: 'com_ui_high',
    },
    optionType: 'conversation',
    columnSpan: 2,
  } as SettingDefinition,
  fileTokenLimit: {
    key: 'fileTokenLimit',
    label: 'com_ui_file_token_limit',
    labelCode: true,
    description: 'com_ui_file_token_limit_desc',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    type: 'number',
    component: 'input',
    columnSpan: 2,
  } as const,
};

const openAIParams: Record<string, SettingDefinition> = {
  chatGptLabel: {
    ...librechat.modelLabel,
    key: 'chatGptLabel',
  },
  promptPrefix: librechat.promptPrefix,
  temperature: createDefinition(baseDefinitions.temperature, {
    default: openAISettings.temperature.default,
    range: {
      min: openAISettings.temperature.min,
      max: openAISettings.temperature.max,
      step: openAISettings.temperature.step,
    },
  }),
  top_p: createDefinition(baseDefinitions.topP, {
    key: 'top_p',
    default: openAISettings.top_p.default,
    range: {
      min: openAISettings.top_p.min,
      max: openAISettings.top_p.max,
      step: openAISettings.top_p.step,
    },
  }),
  frequency_penalty: {
    key: 'frequency_penalty',
    label: 'com_endpoint_frequency_penalty',
    labelCode: true,
    description: 'com_endpoint_openai_freq',
    descriptionCode: true,
    type: 'number',
    default: openAISettings.frequency_penalty.default,
    range: {
      min: openAISettings.frequency_penalty.min,
      max: openAISettings.frequency_penalty.max,
      step: openAISettings.frequency_penalty.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  presence_penalty: {
    key: 'presence_penalty',
    label: 'com_endpoint_presence_penalty',
    labelCode: true,
    description: 'com_endpoint_openai_pres',
    descriptionCode: true,
    type: 'number',
    default: openAISettings.presence_penalty.default,
    range: {
      min: openAISettings.presence_penalty.min,
      max: openAISettings.presence_penalty.max,
      step: openAISettings.presence_penalty.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  max_tokens: {
    key: 'max_tokens',
    label: 'com_endpoint_max_output_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    description: 'com_endpoint_openai_max_tokens',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    optionType: 'model',
    columnSpan: 2,
  },
  reasoning_effort: {
    key: 'reasoning_effort',
    label: 'com_endpoint_reasoning_effort',
    labelCode: true,
    description: 'com_endpoint_openai_reasoning_effort',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningEffort.unset,
    component: 'slider',
    options: [
      ReasoningEffort.unset,
      ReasoningEffort.none,
      ReasoningEffort.minimal,
      ReasoningEffort.low,
      ReasoningEffort.medium,
      ReasoningEffort.high,
      ReasoningEffort.xhigh,
      ReasoningEffort.max,
    ],
    enumMappings: {
      [ReasoningEffort.unset]: 'com_ui_auto',
      [ReasoningEffort.none]: 'com_ui_none',
      [ReasoningEffort.minimal]: 'com_ui_minimal',
      [ReasoningEffort.low]: 'com_ui_low',
      [ReasoningEffort.medium]: 'com_ui_medium',
      [ReasoningEffort.high]: 'com_ui_high',
      [ReasoningEffort.xhigh]: 'com_ui_xhigh',
      [ReasoningEffort.max]: 'com_ui_max',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  useResponsesApi: {
    key: 'useResponsesApi',
    label: 'com_endpoint_use_responses_api',
    labelCode: true,
    description: 'com_endpoint_openai_use_responses_api',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  },
  web_search: {
    key: 'web_search',
    label: 'com_ui_web_search',
    labelCode: true,
    description: 'com_endpoint_openai_use_web_search',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  },
  reasoning_summary: {
    key: 'reasoning_summary',
    label: 'com_endpoint_reasoning_summary',
    labelCode: true,
    description: 'com_endpoint_openai_reasoning_summary',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningSummary.none,
    component: 'slider',
    options: [
      ReasoningSummary.none,
      ReasoningSummary.auto,
      ReasoningSummary.concise,
      ReasoningSummary.detailed,
    ],
    enumMappings: {
      [ReasoningSummary.none]: 'com_ui_unset',
      [ReasoningSummary.auto]: 'com_ui_auto',
      [ReasoningSummary.concise]: 'com_ui_concise',
      [ReasoningSummary.detailed]: 'com_ui_detailed',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  reasoning_mode: {
    key: 'reasoning_mode',
    label: 'com_endpoint_reasoning_mode',
    labelCode: true,
    description: 'com_endpoint_openai_reasoning_mode',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningMode.unset,
    component: 'slider',
    options: [ReasoningMode.unset, ReasoningMode.standard, ReasoningMode.pro],
    enumMappings: {
      [ReasoningMode.unset]: 'com_ui_unset',
      [ReasoningMode.standard]: 'com_ui_standard',
      [ReasoningMode.pro]: 'com_ui_pro',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  reasoning_context: {
    key: 'reasoning_context',
    label: 'com_endpoint_reasoning_context',
    labelCode: true,
    description: 'com_endpoint_openai_reasoning_context',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningContext.unset,
    component: 'slider',
    options: [
      ReasoningContext.unset,
      ReasoningContext.auto,
      ReasoningContext.current_turn,
      ReasoningContext.all_turns,
    ],
    enumMappings: {
      [ReasoningContext.unset]: 'com_ui_unset',
      [ReasoningContext.auto]: 'com_ui_auto',
      [ReasoningContext.current_turn]: 'com_ui_current_turn',
      [ReasoningContext.all_turns]: 'com_ui_all_turns',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  verbosity: {
    key: 'verbosity',
    label: 'com_endpoint_verbosity',
    labelCode: true,
    description: 'com_endpoint_openai_verbosity',
    descriptionCode: true,
    type: 'enum',
    default: Verbosity.none,
    component: 'slider',
    options: [Verbosity.none, Verbosity.low, Verbosity.medium, Verbosity.high],
    enumMappings: {
      [Verbosity.none]: 'com_ui_none',
      [Verbosity.low]: 'com_ui_low',
      [Verbosity.medium]: 'com_ui_medium',
      [Verbosity.high]: 'com_ui_high',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  disableStreaming: {
    key: 'disableStreaming',
    label: 'com_endpoint_disable_streaming_label',
    labelCode: true,
    description: 'com_endpoint_disable_streaming',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  } as const,
};

const anthropic: Record<string, SettingDefinition> = {
  maxOutputTokens: {
    key: 'maxOutputTokens',
    label: 'com_endpoint_max_output_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    description: 'com_endpoint_anthropic_maxoutputtokens',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    range: {
      min: anthropicSettings.maxOutputTokens.min,
      max: anthropicSettings.maxOutputTokens.max,
      step: anthropicSettings.maxOutputTokens.step,
    },
    optionType: 'model',
    columnSpan: 2,
  },
  temperature: createDefinition(baseDefinitions.temperature, {
    default: anthropicSettings.temperature.default,
    range: {
      min: anthropicSettings.temperature.min,
      max: anthropicSettings.temperature.max,
      step: anthropicSettings.temperature.step,
    },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    default: anthropicSettings.topP.default,
    range: {
      min: anthropicSettings.topP.min,
      max: anthropicSettings.topP.max,
      step: anthropicSettings.topP.step,
    },
  }),
  topK: {
    key: 'topK',
    label: 'com_endpoint_top_k',
    labelCode: true,
    description: 'com_endpoint_anthropic_topk',
    descriptionCode: true,
    type: 'number',
    default: anthropicSettings.topK.default,
    range: {
      min: anthropicSettings.topK.min,
      max: anthropicSettings.topK.max,
      step: anthropicSettings.topK.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  promptCache: {
    key: 'promptCache',
    label: 'com_endpoint_prompt_cache',
    labelCode: true,
    description: 'com_endpoint_anthropic_prompt_cache',
    descriptionCode: true,
    type: 'boolean',
    default: anthropicSettings.promptCache.default,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  },
  promptCacheTtl: {
    key: 'promptCacheTtl',
    label: 'com_endpoint_prompt_cache_ttl',
    labelCode: true,
    description: 'com_endpoint_anthropic_prompt_cache_ttl',
    descriptionCode: true,
    type: 'enum',
    default: anthropicSettings.promptCacheTtl.default,
    options: ['5m', '1h'],
    component: 'combobox',
    optionType: 'conversation',
    showDefault: false,
    selectPlaceholder: 'com_endpoint_prompt_cache_ttl_default',
    selectPlaceholderCode: true,
    columnSpan: 2,
  },
  thinking: {
    key: 'thinking',
    label: 'com_endpoint_thinking',
    labelCode: true,
    description: 'com_endpoint_anthropic_thinking',
    descriptionCode: true,
    type: 'boolean',
    default: anthropicSettings.thinking.default,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  },
  thinkingBudget: {
    key: 'thinkingBudget',
    label: 'com_endpoint_thinking_budget',
    labelCode: true,
    description: 'com_endpoint_anthropic_thinking_budget',
    descriptionCode: true,
    type: 'number',
    component: 'input',
    default: anthropicSettings.thinkingBudget.default,
    range: {
      min: anthropicSettings.thinkingBudget.min,
      max: anthropicSettings.thinkingBudget.max,
      step: anthropicSettings.thinkingBudget.step,
    },
    optionType: 'conversation',
    columnSpan: 2,
  },
  web_search: {
    key: 'web_search',
    label: 'com_ui_web_search',
    labelCode: true,
    description: 'com_endpoint_anthropic_use_web_search',
    descriptionCode: true,
    type: 'boolean',
    default: anthropicSettings.web_search.default,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  },
  effort: {
    key: 'effort',
    label: 'com_endpoint_effort',
    labelCode: true,
    description: 'com_endpoint_anthropic_effort',
    descriptionCode: true,
    type: 'enum',
    default: anthropicSettings.effort.default,
    component: 'slider',
    options: anthropicSettings.effort.options,
    enumMappings: {
      [AnthropicEffort.unset]: 'com_ui_auto',
      [AnthropicEffort.low]: 'com_ui_low',
      [AnthropicEffort.medium]: 'com_ui_medium',
      [AnthropicEffort.high]: 'com_ui_high',
      [AnthropicEffort.xhigh]: 'com_ui_xhigh',
      [AnthropicEffort.max]: 'com_ui_max',
    },
    optionType: 'model',
    columnSpan: 4,
  },
  thinkingDisplay: {
    key: 'thinkingDisplay',
    label: 'com_endpoint_anthropic_thinking_display',
    labelCode: true,
    description: 'com_endpoint_anthropic_thinking_display_desc',
    descriptionCode: true,
    type: 'enum',
    default: anthropicSettings.thinkingDisplay.default,
    component: 'slider',
    options: anthropicSettings.thinkingDisplay.options,
    enumMappings: {
      [ThinkingDisplay.auto]: 'com_ui_auto',
      [ThinkingDisplay.summarized]: 'com_ui_summarized',
      [ThinkingDisplay.omitted]: 'com_ui_omitted',
    },
    optionType: 'model',
    columnSpan: 4,
  },
};

const bedrock: Record<string, SettingDefinition> = {
  system: {
    key: 'system',
    label: 'com_endpoint_prompt_prefix',
    labelCode: true,
    type: 'string',
    default: '',
    component: 'textarea',
    placeholder: 'com_endpoint_openai_prompt_prefix_placeholder',
    placeholderCode: true,
    optionType: 'model',
  },
  region: {
    key: 'region',
    type: 'string',
    label: 'com_ui_region',
    labelCode: true,
    component: 'combobox',
    optionType: 'conversation',
    selectPlaceholder: 'com_ui_select_region',
    searchPlaceholder: 'com_ui_select_search_region',
    searchPlaceholderCode: true,
    selectPlaceholderCode: true,
    columnSpan: 2,
  },
  maxTokens: {
    key: 'maxTokens',
    label: 'com_endpoint_max_output_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    description: 'com_endpoint_anthropic_maxoutputtokens',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    optionType: 'model',
    columnSpan: 2,
  },
  temperature: createDefinition(baseDefinitions.temperature, {
    default: 1,
    range: { min: 0, max: 1, step: 0.01 },
  }),
  topK: createDefinition(anthropic.topK, {
    range: { min: 0, max: 500, step: 1 },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    default: 0.999,
    range: { min: 0, max: 1, step: 0.01 },
  }),
  promptCache: {
    key: 'promptCache',
    label: 'com_endpoint_prompt_cache',
    labelCode: true,
    type: 'boolean',
    description: 'com_endpoint_anthropic_prompt_cache',
    descriptionCode: true,
    default: true,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  },
  promptCacheTtl: {
    key: 'promptCacheTtl',
    label: 'com_endpoint_prompt_cache_ttl',
    labelCode: true,
    description: 'com_endpoint_anthropic_prompt_cache_ttl',
    descriptionCode: true,
    type: 'enum',
    default: undefined,
    options: ['5m', '1h'],
    component: 'combobox',
    optionType: 'conversation',
    showDefault: false,
    selectPlaceholder: 'com_endpoint_prompt_cache_ttl_default',
    selectPlaceholderCode: true,
    columnSpan: 2,
  },
  reasoning_effort: {
    key: 'reasoning_effort',
    label: 'com_endpoint_reasoning_effort',
    labelCode: true,
    description: 'com_endpoint_bedrock_reasoning_effort',
    descriptionCode: true,
    type: 'enum',
    default: ReasoningEffort.unset,
    component: 'slider',
    options: [
      ReasoningEffort.unset,
      ReasoningEffort.low,
      ReasoningEffort.medium,
      ReasoningEffort.high,
    ],
    enumMappings: {
      [ReasoningEffort.unset]: 'com_ui_off',
      [ReasoningEffort.low]: 'com_ui_low',
      [ReasoningEffort.medium]: 'com_ui_medium',
      [ReasoningEffort.high]: 'com_ui_high',
    },
    optionType: 'model',
    columnSpan: 4,
  },
};

const mistral: Record<string, SettingDefinition> = {
  temperature: createDefinition(baseDefinitions.temperature, {
    default: 0.7,
    range: { min: 0, max: 1, step: 0.01 },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    range: { min: 0, max: 1, step: 0.01 },
  }),
};

const cohere: Record<string, SettingDefinition> = {
  temperature: createDefinition(baseDefinitions.temperature, {
    default: 0.3,
    range: { min: 0, max: 1, step: 0.01 },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    default: 0.75,
    range: { min: 0.01, max: 0.99, step: 0.01 },
  }),
};

const meta: Record<string, SettingDefinition> = {
  temperature: createDefinition(baseDefinitions.temperature, {
    default: 0.5,
    range: { min: 0, max: 1, step: 0.01 },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    default: 0.9,
    range: { min: 0, max: 1, step: 0.01 },
  }),
};

const google: Record<string, SettingDefinition> = {
  /** Bounds the hand-rolled editor enforced through InputNumber, and they stay
   *  scoped to this endpoint: the shared definition is rendered by every other
   *  endpoint, whose own context windows may fall outside them. */
  maxContextTokens: createDefinition(librechat.maxContextTokens, {
    range: {
      min: googleSettings.maxContextTokens.min,
      max: googleSettings.maxContextTokens.max,
      step: googleSettings.maxContextTokens.step,
    },
  }),
  temperature: createDefinition(baseDefinitions.temperature, {
    default: googleSettings.temperature.default,
    range: {
      min: googleSettings.temperature.min,
      max: googleSettings.temperature.max,
      step: googleSettings.temperature.step,
    },
  }),
  topP: createDefinition(baseDefinitions.topP, {
    default: googleSettings.topP.default,
    range: {
      min: googleSettings.topP.min,
      max: googleSettings.topP.max,
      step: googleSettings.topP.step,
    },
  }),
  topK: {
    key: 'topK',
    label: 'com_endpoint_top_k',
    labelCode: true,
    description: 'com_endpoint_google_topk',
    descriptionCode: true,
    type: 'number',
    default: googleSettings.topK.default,
    range: {
      min: googleSettings.topK.min,
      max: googleSettings.topK.max,
      step: googleSettings.topK.step,
    },
    component: 'slider',
    optionType: 'model',
    columnSpan: 4,
  },
  maxOutputTokens: {
    key: 'maxOutputTokens',
    label: 'com_endpoint_max_output_tokens',
    labelCode: true,
    type: 'number',
    component: 'input',
    description: 'com_endpoint_google_maxoutputtokens',
    descriptionCode: true,
    placeholder: 'com_endpoint_default',
    placeholderCode: true,
    default: googleSettings.maxOutputTokens.default,
    range: {
      min: googleSettings.maxOutputTokens.min,
      max: googleSettings.maxOutputTokens.max,
      step: googleSettings.maxOutputTokens.step,
    },
    optionType: 'model',
    columnSpan: 2,
  },
  thinking: {
    key: 'thinking',
    label: 'com_endpoint_thinking',
    labelCode: true,
    description: 'com_endpoint_google_thinking',
    descriptionCode: true,
    type: 'boolean',
    default: googleSettings.thinking.default,
    component: 'switch',
    optionType: 'conversation',
    showDefault: false,
    columnSpan: 2,
  },
  thinkingBudget: {
    key: 'thinkingBudget',
    label: 'com_endpoint_thinking_budget',
    labelCode: true,
    description: 'com_endpoint_google_thinking_budget',
    descriptionCode: true,
    placeholder: 'com_ui_auto',
    placeholderCode: true,
    type: 'number',
    component: 'input',
    range: {
      min: googleSettings.thinkingBudget.min,
      max: googleSettings.thinkingBudget.max,
      step: googleSettings.thinkingBudget.step,
    },
    optionType: 'conversation',
    columnSpan: 2,
  },
  thinkingLevel: {
    key: 'thinkingLevel',
    label: 'com_endpoint_thinking_level',
    labelCode: true,
    description: 'com_endpoint_google_thinking_level',
    descriptionCode: true,
    type: 'enum',
    default: ThinkingLevel.unset,
    component: 'slider',
    options: [
      ThinkingLevel.unset,
      ThinkingLevel.minimal,
      ThinkingLevel.low,
      ThinkingLevel.medium,
      ThinkingLevel.high,
    ],
    enumMappings: {
      [ThinkingLevel.unset]: 'com_ui_auto',
      [ThinkingLevel.minimal]: 'com_ui_minimal',
      [ThinkingLevel.low]: 'com_ui_low',
      [ThinkingLevel.medium]: 'com_ui_medium',
      [ThinkingLevel.high]: 'com_ui_high',
    },
    optionType: 'conversation',
    columnSpan: 4,
  },
  web_search: {
    key: 'web_search',
    label: 'com_endpoint_use_search_grounding',
    labelCode: true,
    description: 'com_endpoint_google_use_search_grounding',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  },
  url_context: {
    key: 'url_context',
    label: 'com_endpoint_use_url_context',
    labelCode: true,
    description: 'com_endpoint_google_use_url_context',
    descriptionCode: true,
    type: 'boolean',
    default: false,
    component: 'switch',
    optionType: 'model',
    showDefault: false,
    columnSpan: 2,
  },
};

const googleConfig: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  google.maxContextTokens,
  google.maxOutputTokens,
  google.temperature,
  google.topP,
  google.topK,
  librechat.resendFiles,
  google.thinking,
  google.thinkingBudget,
  google.thinkingLevel,
  google.web_search,
  google.url_context,
  librechat.fileTokenLimit,
];

const googleCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const googleCol2: SettingsConfiguration = [
  google.maxContextTokens,
  google.maxOutputTokens,
  google.temperature,
  google.topP,
  google.topK,
  librechat.resendFiles,
  google.thinking,
  google.thinkingBudget,
  google.thinkingLevel,
  google.web_search,
  google.url_context,
  librechat.fileTokenLimit,
];

const openAI: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  openAIParams.max_tokens,
  openAIParams.temperature,
  openAIParams.top_p,
  openAIParams.frequency_penalty,
  openAIParams.presence_penalty,
  baseDefinitions.stop,
  librechat.resendFiles,
  librechat.imageDetail,
  openAIParams.web_search,
  openAIParams.reasoning_effort,
  openAIParams.useResponsesApi,
  openAIParams.reasoning_summary,
  openAIParams.reasoning_mode,
  openAIParams.reasoning_context,
  openAIParams.verbosity,
  openAIParams.disableStreaming,
  librechat.fileTokenLimit,
];

const openRouter: SettingsConfiguration = [
  ...openAI,
  anthropic.promptCache,
  anthropic.promptCacheTtl,
];

const openAICol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const openAICol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  openAIParams.max_tokens,
  openAIParams.temperature,
  openAIParams.top_p,
  openAIParams.frequency_penalty,
  openAIParams.presence_penalty,
  baseDefinitions.stop,
  librechat.resendFiles,
  librechat.imageDetail,
  openAIParams.reasoning_effort,
  openAIParams.reasoning_summary,
  openAIParams.reasoning_mode,
  openAIParams.reasoning_context,
  openAIParams.verbosity,
  openAIParams.useResponsesApi,
  openAIParams.web_search,
  openAIParams.disableStreaming,
  librechat.fileTokenLimit,
];

const anthropicConfig: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  anthropic.maxOutputTokens,
  anthropic.temperature,
  anthropic.topP,
  anthropic.topK,
  librechat.resendFiles,
  anthropic.promptCache,
  anthropic.promptCacheTtl,
  anthropic.thinking,
  anthropic.thinkingBudget,
  anthropic.effort,
  anthropic.thinkingDisplay,
  anthropic.web_search,
  librechat.fileTokenLimit,
];

const anthropicCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const anthropicCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  anthropic.maxOutputTokens,
  anthropic.temperature,
  anthropic.topP,
  anthropic.topK,
  librechat.resendFiles,
  anthropic.promptCache,
  anthropic.promptCacheTtl,
  anthropic.thinking,
  anthropic.thinkingBudget,
  anthropic.effort,
  anthropic.thinkingDisplay,
  anthropic.web_search,
  librechat.fileTokenLimit,
];

const bedrockAnthropic: SettingsConfiguration = [
  librechat.modelLabel,
  bedrock.system,
  librechat.maxContextTokens,
  bedrock.maxTokens,
  bedrock.temperature,
  bedrock.topP,
  bedrock.topK,
  baseDefinitions.stop,
  librechat.resendFiles,
  bedrock.region,
  bedrock.promptCache,
  bedrock.promptCacheTtl,
  anthropic.thinking,
  anthropic.thinkingBudget,
  anthropic.effort,
  anthropic.thinkingDisplay,
  librechat.fileTokenLimit,
];

const bedrockMistral: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  bedrock.maxTokens,
  mistral.temperature,
  mistral.topP,
  librechat.resendFiles,
  bedrock.region,
  librechat.fileTokenLimit,
];

const bedrockCohere: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  bedrock.maxTokens,
  cohere.temperature,
  cohere.topP,
  librechat.resendFiles,
  bedrock.region,
  librechat.fileTokenLimit,
];

const bedrockGeneral: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  meta.temperature,
  meta.topP,
  librechat.resendFiles,
  bedrock.region,
  bedrock.promptCache,
  bedrock.promptCacheTtl,
  librechat.fileTokenLimit,
];

const bedrockAnthropicCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  bedrock.system,
  baseDefinitions.stop,
];

const bedrockAnthropicCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  bedrock.maxTokens,
  bedrock.temperature,
  bedrock.topP,
  bedrock.topK,
  librechat.resendFiles,
  bedrock.region,
  bedrock.promptCache,
  bedrock.promptCacheTtl,
  anthropic.thinking,
  anthropic.thinkingBudget,
  anthropic.effort,
  anthropic.thinkingDisplay,
  librechat.fileTokenLimit,
];

const bedrockMistralCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const bedrockMistralCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  bedrock.maxTokens,
  mistral.temperature,
  mistral.topP,
  librechat.resendFiles,
  bedrock.region,
  librechat.fileTokenLimit,
];

const bedrockCohereCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const bedrockCohereCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  bedrock.maxTokens,
  cohere.temperature,
  cohere.topP,
  librechat.resendFiles,
  bedrock.region,
  librechat.fileTokenLimit,
];

const bedrockGeneralCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const bedrockGeneralCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  meta.temperature,
  meta.topP,
  librechat.resendFiles,
  bedrock.region,
  bedrock.promptCache,
  bedrock.promptCacheTtl,
  librechat.fileTokenLimit,
];

const bedrockZAI: SettingsConfiguration = [
  librechat.modelLabel,
  librechat.promptPrefix,
  librechat.maxContextTokens,
  meta.temperature,
  meta.topP,
  librechat.resendFiles,
  bedrock.region,
  bedrock.reasoning_effort,
  librechat.fileTokenLimit,
];

const bedrockZAICol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  librechat.promptPrefix,
];

const bedrockZAICol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  meta.temperature,
  meta.topP,
  librechat.resendFiles,
  bedrock.region,
  bedrock.reasoning_effort,
  librechat.fileTokenLimit,
];

const bedrockMoonshot: SettingsConfiguration = [
  librechat.modelLabel,
  bedrock.system,
  librechat.maxContextTokens,
  createDefinition(bedrock.maxTokens, {
    default: 16384,
  }),
  bedrock.temperature,
  bedrock.topP,
  baseDefinitions.stop,
  librechat.resendFiles,
  bedrock.region,
  bedrock.reasoning_effort,
  librechat.fileTokenLimit,
];

const bedrockMoonshotCol1: SettingsConfiguration = [
  baseDefinitions.model as SettingDefinition,
  librechat.modelLabel,
  bedrock.system,
  baseDefinitions.stop,
];

const bedrockMoonshotCol2: SettingsConfiguration = [
  librechat.maxContextTokens,
  createDefinition(bedrock.maxTokens, {
    default: 16384,
  }),
  bedrock.temperature,
  bedrock.topP,
  librechat.resendFiles,
  bedrock.region,
  bedrock.reasoning_effort,
  librechat.fileTokenLimit,
];

export const paramSettings: Record<string, SettingsConfiguration | undefined> = {
  [EModelEndpoint.openAI]: openAI,
  [EModelEndpoint.azureOpenAI]: openAI,
  [EModelEndpoint.custom]: openAI,
  [Providers.OPENROUTER]: openRouter,
  [EModelEndpoint.anthropic]: anthropicConfig,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}`]: bedrockAnthropic,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.MistralAI}`]: bedrockMistral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Cohere}`]: bedrockCohere,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Meta}`]: bedrockGeneral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.AI21}`]: bedrockGeneral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Amazon}`]: bedrockGeneral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.DeepSeek}`]: bedrockGeneral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Moonshot}`]: bedrockMoonshot,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.MoonshotAI}`]: bedrockMoonshot,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.OpenAI}`]: bedrockGeneral,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.ZAI}`]: bedrockZAI,
  [EModelEndpoint.google]: googleConfig,
};

/**
 * Maps effective backend param names for OpenAI-compatible/Azure endpoints (as deleted from
 * `llmConfig` via `dropParams`, e.g. `maxTokens`) to their corresponding UI/conversation keys
 * (e.g. `max_tokens`). Native providers (anthropic, google, bedrock, ...) already render these
 * same camelCase names as their UI key (e.g. `topP`), so this alias must only be applied to
 * OpenAI-compatible parameter sets — see `resolveDropParamsUIKeys`.
 */
const dropParamsBackendToUIKey: Record<string, string> = {
  maxTokens: 'max_tokens',
  topP: 'top_p',
  frequencyPenalty: 'frequency_penalty',
  presencePenalty: 'presence_penalty',
};

/** Endpoint keys whose parameter settings render the OpenAI-compatible (snake_case) UI keys. */
const openAILikeParamEndpointKeys: Set<string> = new Set([
  EModelEndpoint.openAI,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.custom,
  Providers.OPENROUTER,
]);

/**
 * Normalizes an admin-configured `dropParams` list into the UI/conversation keys used to hide
 * the matching controls in the settings panels. `endpointKey` should be the same key used to
 * resolve the panel's parameter settings (e.g. `overriddenEndpointKey`); the backend-name alias
 * is only applied for OpenAI-compatible endpoints, since native providers (anthropic, google,
 * bedrock, ...) already use these backend names as their UI key.
 */
export function resolveDropParamsUIKeys(
  dropParams: string[] | undefined,
  endpointKey: string,
): Set<string> {
  if (!dropParams || dropParams.length === 0) {
    return new Set();
  }
  if (!openAILikeParamEndpointKeys.has(endpointKey)) {
    return new Set(dropParams);
  }
  return new Set(dropParams.map((param) => dropParamsBackendToUIKey[param] ?? param));
}

const openAIColumns = {
  col1: openAICol1,
  col2: openAICol2,
};

const bedrockGeneralColumns = {
  col1: bedrockGeneralCol1,
  col2: bedrockGeneralCol2,
};

export const presetSettings: Record<
  string,
  | {
      col1: SettingsConfiguration;
      col2: SettingsConfiguration;
    }
  | undefined
> = {
  [EModelEndpoint.openAI]: openAIColumns,
  [EModelEndpoint.azureOpenAI]: openAIColumns,
  [EModelEndpoint.custom]: openAIColumns,
  [Providers.OPENROUTER]: {
    col1: openAICol1,
    col2: [...openAICol2, anthropic.promptCache, anthropic.promptCacheTtl],
  },
  [EModelEndpoint.anthropic]: {
    col1: anthropicCol1,
    col2: anthropicCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}`]: {
    col1: bedrockAnthropicCol1,
    col2: bedrockAnthropicCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.MistralAI}`]: {
    col1: bedrockMistralCol1,
    col2: bedrockMistralCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Cohere}`]: {
    col1: bedrockCohereCol1,
    col2: bedrockCohereCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Meta}`]: bedrockGeneralColumns,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.AI21}`]: bedrockGeneralColumns,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Amazon}`]: bedrockGeneralColumns,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.DeepSeek}`]: bedrockGeneralColumns,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Moonshot}`]: {
    col1: bedrockMoonshotCol1,
    col2: bedrockMoonshotCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.MoonshotAI}`]: {
    col1: bedrockMoonshotCol1,
    col2: bedrockMoonshotCol2,
  },
  [`${EModelEndpoint.bedrock}-${BedrockProviders.OpenAI}`]: bedrockGeneralColumns,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.ZAI}`]: {
    col1: bedrockZAICol1,
    col2: bedrockZAICol2,
  },
  [EModelEndpoint.google]: {
    col1: googleCol1,
    col2: googleCol2,
  },
};

export const agentParamSettings: Record<string, SettingsConfiguration | undefined> = Object.entries(
  presetSettings,
).reduce<Record<string, SettingsConfiguration | undefined>>((acc, [key, value]) => {
  if (value) {
    acc[key] = value.col2;
  }
  return acc;
}, {});

const reasoningSettingKeys = [
  'reasoning_effort',
  'effort',
  'thinkingLevel',
  'thinkingBudget',
] as const;

export type ReasoningSettingKey = (typeof reasoningSettingKeys)[number];

const findReasoningSetting = (
  settings: SettingsConfiguration,
  key: ReasoningSettingKey,
): SettingDefinition | undefined => settings.find((setting) => setting.key === key);

const knownReasoningProviderEndpoints: Record<string, true> = {
  [EModelEndpoint.openAI]: true,
  [EModelEndpoint.azureOpenAI]: true,
  [EModelEndpoint.anthropic]: true,
  [EModelEndpoint.bedrock]: true,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}`]: true,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.Moonshot}`]: true,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.MoonshotAI}`]: true,
  [`${EModelEndpoint.bedrock}-${BedrockProviders.ZAI}`]: true,
};

const isKnownReasoningProvider = (endpoint?: string | null): boolean =>
  endpoint != null && knownReasoningProviderEndpoints[endpoint] === true;

const isKnownOpenAIReasoningModel = (model: string): boolean =>
  /(?:^|[/._-])(?:o[134](?:[-.]|$)|gpt[-.]?(?:[5-9]|\d{2,})(?:[-.]|$)|gpt[-.]?oss(?:[-.]|$))/i.test(
    model,
  );

const isManualClaudeThinkingModel = (model: string): boolean =>
  /claude-3[-.]7|claude-(?:sonnet|opus|haiku)-[4-9]|claude-[4-9](?:[-.][0-9]+)?-(?:sonnet|opus|haiku)/i.test(
    model,
  );

/**
 * Selects the request-scoped reasoning control supported by the active model.
 * Custom and OpenRouter endpoints remain definition-driven because their model
 * catalogs are deployment-owned and cannot be inferred safely from a name.
 */
export function resolveReasoningSetting({
  endpoint,
  model,
  settings,
}: {
  endpoint: string;
  model?: string | null;
  settings: SettingsConfiguration;
}): SettingDefinition | undefined {
  if (!model) {
    return undefined;
  }

  if (endpoint === EModelEndpoint.google) {
    if (getGoogleThinkingBudgetBounds(model) != null) {
      return findReasoningSetting(settings, 'thinkingBudget');
    }
    if (/gemini-(?:[3-9]|\d{2,})|gemma-(?:[4-9]|\d{2,})/i.test(model)) {
      return findReasoningSetting(settings, 'thinkingLevel');
    }
    return undefined;
  }

  const isAnthropicEndpoint =
    endpoint === EModelEndpoint.anthropic ||
    endpoint === `${EModelEndpoint.bedrock}-${BedrockProviders.Anthropic}` ||
    (endpoint === EModelEndpoint.bedrock &&
      getModelKey(endpoint, model) === BedrockProviders.Anthropic);
  if (isAnthropicEndpoint) {
    if (supportsAdaptiveThinking(model)) {
      return findReasoningSetting(settings, 'effort');
    }
    if (isManualClaudeThinkingModel(model)) {
      return findReasoningSetting(settings, 'thinkingBudget');
    }
    return undefined;
  }

  if (endpoint === EModelEndpoint.azureOpenAI) {
    /* Azure deployment names are administrator-defined and often contain no
     * model-family signal. An explicit resolved parameter definition is the
     * capability evidence available to this layer. */
    return findReasoningSetting(settings, 'reasoning_effort');
  }

  if (endpoint === EModelEndpoint.openAI) {
    return isKnownOpenAIReasoningModel(model)
      ? findReasoningSetting(settings, 'reasoning_effort')
      : undefined;
  }

  return reasoningSettingKeys.reduce<SettingDefinition | undefined>(
    (resolved, key) => resolved ?? findReasoningSetting(settings, key),
    undefined,
  );
}

/** Narrows an enum reasoning setting to the options a request-scoped override
 * can carry. A deployment may declare provider values the override schema does
 * not accept; offering them rendered a choice that could never be submitted. */
const toSubmittableReasoningSetting = (
  setting: SettingDefinition | undefined,
): SettingDefinition | undefined => {
  if (setting?.options == null) {
    return setting;
  }
  const options = setting.options.filter(
    (option) => reasoningOverrideSchema.safeParse({ key: setting.key, value: option }).success,
  );
  if (options.length === setting.options.length) {
    return setting;
  }
  return options.length === 0 ? undefined : { ...setting, options };
};

/** Builds the effective reasoning definition shared by the composer and the server.
 * A model-spec lock is part of capability resolution, not a caller-only UI check:
 * both surfaces must see the same unavailable result before an override is staged. */
export function resolveReasoningSettingForTarget({
  endpoint,
  model,
  isAgent = false,
  defaultParamsEndpoint,
  reasoningFormat,
  paramDefinitions,
  blockedReasoningKeys,
}: {
  endpoint: string;
  model?: string | null;
  isAgent?: boolean;
  defaultParamsEndpoint?: string | null;
  reasoningFormat?: ReasoningParameterFormat | null;
  paramDefinitions?: Partial<SettingDefinition>[] | null;
  blockedReasoningKeys?: ReadonlySet<string>;
}): SettingDefinition | undefined {
  if (!model || reasoningFormat === ReasoningParameterFormat.disabled) {
    return undefined;
  }
  const [combinedSettingsKey, endpointSettingsKey] = getSettingsKeys(endpoint, model);
  const effectiveDefaultParamsEndpoint = defaultParamsEndpoint ?? endpointSettingsKey;

  const hasExplicitCapability =
    (paramDefinitions?.some((setting) =>
      reasoningSettingKeys.includes(setting.key as ReasoningSettingKey),
    ) ??
      false) ||
    reasoningFormat != null ||
    isKnownReasoningProvider(effectiveDefaultParamsEndpoint);
  const usesGenericSettings =
    endpoint === EModelEndpoint.custom ||
    endpoint === Providers.OPENROUTER ||
    paramSettings[endpoint] == null;
  if (usesGenericSettings && !hasExplicitCapability) {
    return undefined;
  }
  const baseSettings = isAgent
    ? (agentParamSettings[combinedSettingsKey] ??
      agentParamSettings[effectiveDefaultParamsEndpoint] ??
      agentParamSettings[endpointSettingsKey] ??
      paramSettings[combinedSettingsKey] ??
      paramSettings[effectiveDefaultParamsEndpoint] ??
      paramSettings[endpointSettingsKey] ??
      [])
    : (paramSettings[combinedSettingsKey] ??
      paramSettings[effectiveDefaultParamsEndpoint] ??
      paramSettings[endpointSettingsKey] ??
      []);

  const customSettingsByKey = new Map(
    (paramDefinitions ?? []).flatMap((setting) =>
      setting.key == null ? [] : ([[setting.key, setting]] as const),
    ),
  );
  const settings = applyModelAwareDefaults(baseSettings, effectiveDefaultParamsEndpoint, model).map(
    (setting) => {
      const override = customSettingsByKey.get(setting.key);
      return override == null ? setting : { ...setting, ...override };
    },
  );
  const declaredReasoningSettings = (paramDefinitions ?? [])
    .filter((setting) => reasoningSettingKeys.includes(setting.key as ReasoningSettingKey))
    .filter((setting) => !settings.some((baseSetting) => baseSetting.key === setting.key))
    .map((setting) => setting as SettingDefinition);
  const effectiveSettings = [...settings, ...declaredReasoningSettings];
  const explicitReasoningKey = paramDefinitions?.find((setting) =>
    reasoningSettingKeys.includes(setting.key as ReasoningSettingKey),
  )?.key as ReasoningSettingKey | undefined;
  if (explicitReasoningKey != null) {
    const explicitSetting = findReasoningSetting(effectiveSettings, explicitReasoningKey);
    return explicitSetting != null && blockedReasoningKeys?.has(explicitSetting.key)
      ? undefined
      : toSubmittableReasoningSetting(explicitSetting);
  }
  const resolutionEndpoint = isKnownReasoningProvider(effectiveDefaultParamsEndpoint)
    ? effectiveDefaultParamsEndpoint
    : endpoint;
  if (
    resolutionEndpoint === EModelEndpoint.azureOpenAI &&
    !paramDefinitions?.some((setting) =>
      reasoningSettingKeys.includes(setting.key as ReasoningSettingKey),
    )
  ) {
    return undefined;
  }
  const resolvedSetting = resolveReasoningSetting({
    endpoint: resolutionEndpoint,
    model,
    settings: effectiveSettings,
  });
  return resolvedSetting != null && blockedReasoningKeys?.has(resolvedSetting.key)
    ? undefined
    : toSubmittableReasoningSetting(resolvedSetting);
}

/** Confirms that a stored one-shot override still belongs to the selected
 * model and remains inside its advertised enum or numeric range. */
export function isReasoningOverrideSupported(
  reasoningOverride: TReasoningOverride,
  setting: SettingDefinition | undefined,
): boolean {
  if (setting?.key !== reasoningOverride.key) {
    return false;
  }
  if (typeof reasoningOverride.value === 'number') {
    return (
      setting.range == null ||
      clampSettingRange(reasoningOverride.value, setting.range) === reasoningOverride.value
    );
  }
  return setting.options == null || setting.options.includes(reasoningOverride.value);
}

/**
 * Resolves model-aware defaults for a settings configuration before rendering.
 * Google's `maxOutputTokens` default depends on the selected Gemini model so that
 * current models (2.5 and 3+) surface their 64K output limit instead of the legacy 8K value.
 * Anthropic prompt-cache controls are only surfaced for models that support them.
 */
export function applyModelAwareDefaults(
  settings: SettingsConfiguration,
  endpoint: string,
  model?: string,
  responsesApiRouting?: ResponsesApiRouting,
): SettingsConfiguration {
  if (!model) {
    return settings;
  }
  if (/^grok-4[.-]7(?:$|[-:])/.test(model.split('/').pop() ?? '')) {
    return settings.map((setting) =>
      setting.key === 'reasoning_effort'
        ? {
            ...setting,
            options: [
              ReasoningEffort.unset,
              ReasoningEffort.low,
              ReasoningEffort.medium,
              ReasoningEffort.high,
              ReasoningEffort.xhigh,
            ],
          }
        : setting,
    );
  }
  if (/^gpt-6-(?:sol|luna)(?:$|-)/i.test(model)) {
    return settings.map((setting) => {
      if (setting.key === 'reasoning_effort') {
        return {
          ...setting,
          options: setting.options?.filter((effort) => effort !== ReasoningEffort.minimal),
        };
      }
      /** Match the native backend's unset default without writing into stored
       * settings. Explicit false still overrides this rendered default. */
      if (setting.key === 'useResponsesApi') {
        const route = (value?: boolean) =>
          resolveEffectiveUseResponsesApi({ endpoint, model, routing: responsesApiRouting, value });
        return {
          ...setting,
          default: route() ?? false,
          enumMappings: { true: route(true) ?? true, false: route(false) ?? false },
        };
      }
      return setting;
    });
  }
  if (isOpus55Model(model)) {
    return settings.filter(
      (setting) =>
        !['thinking', 'thinkingBudget', 'temperature', 'topP', 'topK'].includes(setting.key),
    );
  }
  const modelAwareSettings =
    endpoint === EModelEndpoint.google
      ? settings.map((setting) => {
          if (setting.key === 'maxOutputTokens') {
            return { ...setting, default: googleSettings.maxOutputTokens.reset(model) };
          }
          /** The shared thinking budget range is model-agnostic, so it caps Pro below
           *  its real ceiling and accepts Flash values the provider rejects. The
           *  maximum and the positive floor move together. `range.min` stays -1 so
           *  the "decide automatically" sentinel remains typeable. */
          if (setting.key === 'thinkingBudget' && setting.range != null) {
            const bounds = getGoogleThinkingBudgetBounds(model);
            if (bounds != null) {
              return {
                ...setting,
                range: {
                  ...setting.range,
                  max: bounds.max,
                  positiveMin: bounds.min,
                  modelSpecific: true,
                },
              };
            }
          }
          return setting;
        })
      : settings;

  if (endpoint !== EModelEndpoint.anthropic || supportsPromptCache(model)) {
    return modelAwareSettings;
  }

  return modelAwareSettings.filter(
    (setting) => setting.key !== 'promptCache' && setting.key !== 'promptCacheTtl',
  );
}
