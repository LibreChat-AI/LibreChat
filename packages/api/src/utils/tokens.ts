import z from 'zod';
import { EModelEndpoint } from 'librechat-data-provider';

/** Configuration object mapping model keys to their respective prompt, completion rates, and context limit
 *
 * Note: the [key: string]: unknown is not in the original JSDoc typedef in /api/typedefs.js, but I've included it since
 * getModelMaxOutputTokens calls getModelTokenValue with a key of 'output', which was not in the original JSDoc typedef,
 * but would be referenced in a TokenConfig in the if(matchedPattern) portion of getModelTokenValue.
 * So in order to preserve functionality for that case and any others which might reference an additional key I'm unaware of,
 * I've included it here until the interface can be typed more tightly.
 */
export interface TokenConfig {
  prompt: number;
  completion: number;
  context: number;
  [key: string]: unknown;
}

/** An endpoint's config object mapping model keys to their respective prompt, completion rates, and context limit */
export type EndpointTokenConfig = Record<string, TokenConfig>;

const openAIModels = {
  'o4-mini': 200000,
  'o3-mini': 195000, // -5000 from max
  o3: 200000,
  o1: 195000, // -5000 from max
  'o1-mini': 127500, // -500 from max
  'o1-preview': 127500, // -500 from max
  'gpt-4': 8187, // -5 from max
  'gpt-4-0613': 8187, // -5 from max
  'gpt-4-32k': 32758, // -10 from max
  'gpt-4-32k-0314': 32758, // -10 from max
  'gpt-4-32k-0613': 32758, // -10 from max
  'gpt-4-1106': 127500, // -500 from max
  'gpt-4-0125': 127500, // -500 from max
  'gpt-4.5': 127500, // -500 from max
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-4.1-nano': 1047576,
  'gpt-5': 400000,
  'gpt-5-mini': 400000,
  'gpt-5-nano': 400000,
  'gpt-4o': 127500, // -500 from max
  'gpt-4o-mini': 127500, // -500 from max
  'gpt-4o-2024-05-13': 127500, // -500 from max
  'gpt-4o-2024-08-06': 127500, // -500 from max
  'gpt-4-turbo': 127500, // -500 from max
  'gpt-4-vision': 127500, // -500 from max
  'gpt-3.5-turbo': 16375, // -10 from max
  'gpt-3.5-turbo-0613': 4092, // -5 from max
  'gpt-3.5-turbo-0301': 4092, // -5 from max
  'gpt-3.5-turbo-16k': 16375, // -10 from max
  'gpt-3.5-turbo-16k-0613': 16375, // -10 from max
  'gpt-3.5-turbo-1106': 16375, // -10 from max
  'gpt-3.5-turbo-0125': 16375, // -10 from max
};

const mistralModels = {
  'mistral-': 31990, // -10 from max
  'mistral-7b': 31990, // -10 from max
  'mistral-small': 31990, // -10 from max
  'mixtral-8x7b': 31990, // -10 from max
  'mistral-large': 131000,
  'mistral-large-2402': 127500,
  'mistral-large-2407': 127500,
  'pixtral-large': 131000,
  'mistral-saba': 32000,
  codestral: 256000,
  'ministral-8b': 131000,
  'ministral-3b': 131000,
};

const cohereModels = {
  'command-light': 4086, // -10 from max
  'command-light-nightly': 8182, // -10 from max
  command: 4086, // -10 from max
  'command-nightly': 8182, // -10 from max
  'command-r': 127500, // -500 from max
  'command-r-plus': 127500, // -500 from max
};

const googleModels = {
  /* Max I/O is combined so we subtract the amount from max response tokens for actual total */
  gemma: 8196,
  'gemma-2': 32768,
  'gemma-3': 32768,
  'gemma-3-27b': 131072,
  gemini: 30720, // -2048 from max
  'gemini-pro-vision': 12288,
  'gemini-exp': 2000000,
  'gemini-2.5': 1000000, // 1M input tokens, 64k output tokens
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash-lite': 1000000,
  'gemini-2.0': 2000000,
  'gemini-2.0-flash': 1000000,
  'gemini-2.0-flash-lite': 1000000,
  'gemini-1.5': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-1.5-flash-8b': 1000000,
  'text-bison-32k': 32758, // -10 from max
  'chat-bison-32k': 32758, // -10 from max
  'code-bison-32k': 32758, // -10 from max
  'codechat-bison-32k': 32758,
  /* Codey, -5 from max: 6144 */
  'code-': 6139,
  'codechat-': 6139,
  /* PaLM2, -5 from max: 8192 */
  'text-': 8187,
  'chat-': 8187,
  'google/gemma-3-27b-it': 131072,
  'google/gemma-4-26B-A4B-it': 262144,
  'google/gemma-4-31B-it': 262144,
  'google/gemma-4-31B-it-turbo': 262144,
  'google/gemma-4-31B-it-Ultra': 131072,
};

const anthropicModels = {
  'claude-': 100000,
  'claude-instant': 100000,
  'claude-2': 100000,
  'claude-2.1': 200000,
  'claude-3': 200000,
  'claude-3-haiku': 200000,
  'claude-3-sonnet': 200000,
  'claude-3-opus': 200000,
  'claude-3.5-haiku': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3-5-sonnet': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-3-7-sonnet': 200000,
  'claude-3.7-sonnet': 200000,
  'claude-3-5-sonnet-latest': 200000,
  'claude-3.5-sonnet-latest': 200000,
  'claude-sonnet-4': 1000000,
  'claude-opus-4': 200000,
  'claude-4': 200000,
};

const deepseekModels = {
  'deepseek-reasoner': 128000,
  deepseek: 128000,
  'deepseek.r1': 128000,
  //new models that I added to DeepSeek models
  'deepseek-ai/DeepSeek-V3.2-Exp': 64000, // actually it is 128K context, I artificially limited it to 64K context
  'deepseek-ai/DeepSeek-V3.1-Terminus': 64000, // actually it is bigger, I artificially limited it to 64K context
  'deepseek-ai/DeepSeek-V3.1': 64000, // actually it is bigger, I artificially limited it to 64K context
  'deepseek-ai/DeepSeek-V4-Flash': 1048576,
  'deepseek-ai/DeepSeek-V4-Flash-0731': 1048576,
  //end of new models that I added to DeepSeek models  
};

const metaModels = {
  // Basic patterns
  llama3: 8000,
  llama2: 4000,
  'llama-3': 8000,
  'llama-2': 4000,

  // llama3.x pattern
  'llama3.1': 127500,
  'llama3.2': 127500,
  'llama3.3': 127500,

  // llama3-x pattern
  'llama3-1': 127500,
  'llama3-2': 127500,
  'llama3-3': 127500,

  // llama-3.x pattern
  'llama-3.1': 127500,
  'llama-3.2': 127500,
  'llama-3.3': 127500,

  // llama3.x:Nb pattern
  'llama3.1:405b': 127500,
  'llama3.1:70b': 127500,
  'llama3.1:8b': 127500,
  'llama3.2:1b': 127500,
  'llama3.2:3b': 127500,
  'llama3.2:11b': 127500,
  'llama3.2:90b': 127500,
  'llama3.3:70b': 127500,

  // llama3-x-Nb pattern
  'llama3-1-405b': 127500,
  'llama3-1-70b': 127500,
  'llama3-1-8b': 127500,
  'llama3-2-1b': 127500,
  'llama3-2-3b': 127500,
  'llama3-2-11b': 127500,
  'llama3-2-90b': 127500,
  'llama3-3-70b': 127500,

  // llama-3.x-Nb pattern
  'llama-3.1-405b': 127500,
  'llama-3.1-70b': 127500,
  'llama-3.1-8b': 127500,
  'llama-3.2-1b': 127500,
  'llama-3.2-3b': 127500,
  'llama-3.2-11b': 127500,
  'llama-3.2-90b': 127500,
  'llama-3.3-70b': 127500,

  // Original llama2/3 patterns
  'llama3-70b': 8000,
  'llama3-8b': 8000,
  'llama2-70b': 4000,
  'llama2-13b': 4000,
  'llama3:70b': 8000,
  'llama3:8b': 8000,
  'llama2:70b': 4000,
};

const ollamaModels = {
  'qwen2.5': 32000,
};

const ai21Models = {
  'ai21.j2-mid-v1': 8182, // -10 from max
  'ai21.j2-ultra-v1': 8182, // -10 from max
  'ai21.jamba-instruct-v1:0': 255500, // -500 from max
};

const amazonModels = {
  'amazon.titan-text-lite-v1': 4000,
  'amazon.titan-text-express-v1': 8000,
  'amazon.titan-text-premier-v1:0': 31500, // -500 from max
  // https://aws.amazon.com/ai/generative-ai/nova/
  'amazon.nova-micro-v1:0': 127000, // -1000 from max,
  'amazon.nova-lite-v1:0': 295000, // -5000 from max,
  'amazon.nova-pro-v1:0': 295000, // -5000 from max,
  'amazon.nova-premier-v1:0': 995000, // -5000 from max,
};

const bedrockModels = {
  ...anthropicModels,
  ...mistralModels,
  ...cohereModels,
  ...ollamaModels,
  ...deepseekModels,
  ...metaModels,
  ...ai21Models,
  ...amazonModels,
};

const xAIModels = {
  grok: 131072,
  'grok-beta': 131072,
  'grok-vision-beta': 8192,
  'grok-2': 131072,
  'grok-2-latest': 131072,
  'grok-2-1212': 131072,
  'grok-2-vision': 32768,
  'grok-2-vision-latest': 32768,
  'grok-2-vision-1212': 32768,
  'grok-3': 131072,
  'grok-3-fast': 131072,
  'grok-3-mini': 131072,
  'grok-3-mini-fast': 131072,
  'grok-4': 256000, // 256K context
};

const aggregateModels = {
  ...openAIModels,
  ...googleModels,
  ...bedrockModels,
  ...xAIModels,
  // misc.
  kimi: 131000,
  // GPT-OSS
  'gpt-oss': 131000,
  'gpt-oss:20b': 131000,
  'gpt-oss-20b': 131000,
  'gpt-oss:120b': 131000,
  'gpt-oss-120b': 131000,
  // GLM models (Zhipu AI)
  glm4: 128000,
  'glm-4': 128000,
  'glm-4-32b': 128000,
  'glm-4.5': 131000,
  'glm-4.5-air': 131000,
  'glm-4.5v': 66000,
  'glm-4.6': 200000,
  'Qwen/Qwen3-32B': 40960,
};

export const maxTokensMap = {
  [EModelEndpoint.azureOpenAI]: openAIModels,
  [EModelEndpoint.openAI]: aggregateModels,
  [EModelEndpoint.agents]: aggregateModels,
  [EModelEndpoint.custom]: aggregateModels,
  [EModelEndpoint.google]: googleModels,
  [EModelEndpoint.anthropic]: anthropicModels,
  [EModelEndpoint.bedrock]: bedrockModels,
};

export const modelMaxOutputs = {
  o1: 32268, // -500 from max: 32,768
  'o1-mini': 65136, // -500 from max: 65,536
  'o1-preview': 32268, // -500 from max: 32,768
  'gpt-5': 128000,
  'gpt-5-mini': 128000,
  'gpt-5-nano': 128000,
  'gpt-oss-20b': 131000,
  'gpt-oss-120b': 131000,
  system_default: 32000,
};

/** Outputs from https://docs.anthropic.com/en/docs/about-claude/models/all-models#model-names */
const anthropicMaxOutputs = {
  'claude-3-haiku': 4096,
  'claude-3-sonnet': 4096,
  'claude-3-opus': 4096,
  'claude-opus-4': 32000,
  'claude-sonnet-4': 64000,
  'claude-3.5-sonnet': 8192,
  'claude-3-5-sonnet': 8192,
  'claude-3.7-sonnet': 128000,
  'claude-3-7-sonnet': 128000,
};

export const maxOutputTokensMap = {
  [EModelEndpoint.anthropic]: anthropicMaxOutputs,
  [EModelEndpoint.azureOpenAI]: modelMaxOutputs,
  [EModelEndpoint.openAI]: modelMaxOutputs,
  [EModelEndpoint.custom]: modelMaxOutputs,
};

/**
 * Finds the first matching pattern in the tokens map.
 * @param {string} modelName
 * @param {Record<string, number> | EndpointTokenConfig} tokensMap
 * @returns {string|null}
 */
export function findMatchingPattern(
  modelName: string,
  tokensMap: Record<string, number> | EndpointTokenConfig,
): string | null {
  const keys = Object.keys(tokensMap);
  const lowerModelName = modelName.toLowerCase();
  for (let i = keys.length - 1; i >= 0; i--) {
    const modelKey = keys[i];
    if (lowerModelName.includes(modelKey)) {
      return modelKey;
    }
  }

  return null;
}

/**
 * Retrieves a token value for a given model name from a tokens map.
 *
 * @param modelName - The name of the model to look up.
 * @param tokensMap - The map of model names to token values.
 * @param [key='context'] - The key to look up in the tokens map.
 * @returns The token value for the given model or undefined if no match is found.
 */
export function getModelTokenValue(
  modelName: string,
  tokensMap?: EndpointTokenConfig | Record<string, number>,
  key = 'context' as keyof TokenConfig,
): number | undefined {
  if (typeof modelName !== 'string' || !tokensMap) {
    return undefined;
  }

  const value = tokensMap[modelName];
  if (typeof value === 'number') {
    return value;
  }

  if (value?.context) {
    return value.context;
  }

  const matchedPattern = findMatchingPattern(modelName, tokensMap);

  if (matchedPattern) {
    const result = tokensMap[matchedPattern];
    if (typeof result === 'number') {
      return result;
    }

    const tokenValue = result?.[key];
    if (typeof tokenValue === 'number') {
      return tokenValue;
    }
    return tokensMap.system_default as number | undefined;
  }

  return tokensMap.system_default as number | undefined;
}

/**
 * Retrieves the maximum tokens for a given model name.
 *
 * @param modelName - The name of the model to look up.
 * @param endpoint - The endpoint (default is 'openAI').
 * @param [endpointTokenConfig] - Token Config for current endpoint to use for max tokens lookup
 * @returns The maximum tokens for the given model or undefined if no match is found.
 */
export function getModelMaxTokens(
  modelName: string,
  endpoint = EModelEndpoint.openAI,
  endpointTokenConfig?: EndpointTokenConfig,
): number | undefined {
  const tokensMap = endpointTokenConfig ?? maxTokensMap[endpoint as keyof typeof maxTokensMap];
  return getModelTokenValue(modelName, tokensMap);
}

/**
 * Retrieves the maximum output tokens for a given model name.
 *
 * @param modelName - The name of the model to look up.
 * @param endpoint - The endpoint (default is 'openAI').
 * @param [endpointTokenConfig] - Token Config for current endpoint to use for max tokens lookup
 * @returns The maximum output tokens for the given model or undefined if no match is found.
 */
export function getModelMaxOutputTokens(
  modelName: string,
  endpoint = EModelEndpoint.openAI,
  endpointTokenConfig?: EndpointTokenConfig,
): number | undefined {
  const tokensMap =
    endpointTokenConfig ?? maxOutputTokensMap[endpoint as keyof typeof maxOutputTokensMap];
  return getModelTokenValue(modelName, tokensMap, 'output');
}

/**
 * Retrieves the model name key for a given model name input. If the exact model name isn't found,
 * it searches for partial matches within the model name, checking keys in reverse order.
 *
 * @param modelName - The name of the model to look up.
 * @param endpoint - The endpoint (default is 'openAI').
 * @returns The model name key for the given model; returns input if no match is found and is string.
 *
 * @example
 * matchModelName('gpt-4-32k-0613'); // Returns 'gpt-4-32k-0613'
 * matchModelName('gpt-4-32k-unknown'); // Returns 'gpt-4-32k'
 * matchModelName('unknown-model'); // Returns undefined
 */
export function matchModelName(
  modelName: string,
  endpoint = EModelEndpoint.openAI,
): string | undefined {
  if (typeof modelName !== 'string') {
    return undefined;
  }

  const tokensMap: Record<string, number> = maxTokensMap[endpoint as keyof typeof maxTokensMap];
  if (!tokensMap) {
    return modelName;
  }

  if (tokensMap[modelName]) {
    return modelName;
  }

  const matchedPattern = findMatchingPattern(modelName, tokensMap);
  return matchedPattern || modelName;
}

export const modelSchema = z.object({
  id: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  context_length: z.number(),
});

export const inputSchema = z.object({
  data: z.array(modelSchema),
});

/**
 * Processes a list of model data from an API and organizes it into structured data based on URL and specifics of rates and context.
 * @param {{ data: Array<z.infer<typeof modelSchema>> }} input The input object containing base URL and data fetched from the API.
 * @returns {EndpointTokenConfig} The processed model data.
 */
export function processModelData(input: z.infer<typeof inputSchema>): EndpointTokenConfig {
  const validationResult = inputSchema.safeParse(input);
  if (!validationResult.success) {
    throw new Error('Invalid input data');
  }
  const { data } = validationResult.data;

  /** @type {EndpointTokenConfig} */
  const tokenConfig: EndpointTokenConfig = {};

  for (const model of data) {
    const modelKey = model.id;
    if (modelKey === 'openrouter/auto') {
      model.pricing = {
        prompt: '0.00001',
        completion: '0.00003',
      };
    }
    const prompt = parseFloat(model.pricing.prompt) * 1000000;
    const completion = parseFloat(model.pricing.completion) * 1000000;

    tokenConfig[modelKey] = {
      prompt,
      completion,
      context: model.context_length,
    };
  }

  return tokenConfig;
}

export const tiktokenModels = new Set([
  'text-davinci-003',
  'text-davinci-002',
  'text-davinci-001',
  'text-curie-001',
  'text-babbage-001',
  'text-ada-001',
  'davinci',
  'curie',
  'babbage',
  'ada',
  'code-davinci-002',
  'code-davinci-001',
  'code-cushman-002',
  'code-cushman-001',
  'davinci-codex',
  'cushman-codex',
  'text-davinci-edit-001',
  'code-davinci-edit-001',
  'text-embedding-ada-002',
  'text-similarity-davinci-001',
  'text-similarity-curie-001',
  'text-similarity-babbage-001',
  'text-similarity-ada-001',
  'text-search-davinci-doc-001',
  'text-search-curie-doc-001',
  'text-search-babbage-doc-001',
  'text-search-ada-doc-001',
  'code-search-babbage-code-001',
  'code-search-ada-code-001',
  'gpt2',
  'gpt-4',
  'gpt-4-0314',
  'gpt-4-32k',
  'gpt-4-32k-0314',
  'gpt-3.5-turbo',
  'gpt-3.5-turbo-0301',
]);
