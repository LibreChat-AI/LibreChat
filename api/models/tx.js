const { matchModelName } = require('@librechat/api');
const defaultRate = 1;

/**
 * AWS Bedrock pricing
 * source: https://aws.amazon.com/bedrock/pricing/
 * */
const bedrockValues = {
  // Basic llama2 patterns
  'llama2-13b': { prompt: 0.75, completion: 1.0 },
  'llama2:13b': { prompt: 0.75, completion: 1.0 },
  'llama2:70b': { prompt: 1.95, completion: 2.56 },
  'llama2-70b': { prompt: 1.95, completion: 2.56 },

  // Basic llama3 patterns
  'llama3-8b': { prompt: 0.3, completion: 0.6 },
  'llama3:8b': { prompt: 0.3, completion: 0.6 },
  'llama3-70b': { prompt: 2.65, completion: 3.5 },
  'llama3:70b': { prompt: 2.65, completion: 3.5 },

  // llama3-x-Nb pattern
  'llama3-1-8b': { prompt: 0.22, completion: 0.22 },
  'llama3-1-70b': { prompt: 0.72, completion: 0.72 },
  'llama3-1-405b': { prompt: 2.4, completion: 2.4 },
  'llama3-2-1b': { prompt: 0.1, completion: 0.1 },
  'llama3-2-3b': { prompt: 0.15, completion: 0.15 },
  'llama3-2-11b': { prompt: 0.16, completion: 0.16 },
  'llama3-2-90b': { prompt: 0.72, completion: 0.72 },

  // llama3.x:Nb pattern
  'llama3.1:8b': { prompt: 0.22, completion: 0.22 },
  'llama3.1:70b': { prompt: 0.72, completion: 0.72 },
  'llama3.1:405b': { prompt: 2.4, completion: 2.4 },
  'llama3.2:1b': { prompt: 0.1, completion: 0.1 },
  'llama3.2:3b': { prompt: 0.15, completion: 0.15 },
  'llama3.2:11b': { prompt: 0.16, completion: 0.16 },
  'llama3.2:90b': { prompt: 0.72, completion: 0.72 },

  // llama-3.x-Nb pattern
  'llama-3.1-8b': { prompt: 0.22, completion: 0.22 },
  'llama-3.1-70b': { prompt: 0.72, completion: 0.72 },
  'llama-3.1-405b': { prompt: 2.4, completion: 2.4 },
  'llama-3.2-1b': { prompt: 0.1, completion: 0.1 },
  'llama-3.2-3b': { prompt: 0.15, completion: 0.15 },
  'llama-3.2-11b': { prompt: 0.16, completion: 0.16 },
  'llama-3.2-90b': { prompt: 0.72, completion: 0.72 },
  'llama-3.3-70b': { prompt: 2.65, completion: 3.5 },
  'mistral-7b': { prompt: 0.15, completion: 0.2 },
  'mistral-small': { prompt: 0.15, completion: 0.2 },
  'mixtral-8x7b': { prompt: 0.45, completion: 0.7 },
  'mistral-large-2402': { prompt: 4.0, completion: 12.0 },
  'mistral-large-2407': { prompt: 3.0, completion: 9.0 },
  'command-text': { prompt: 1.5, completion: 2.0 },
  'command-light': { prompt: 0.3, completion: 0.6 },
  'ai21.j2-mid-v1': { prompt: 12.5, completion: 12.5 },
  'ai21.j2-ultra-v1': { prompt: 18.8, completion: 18.8 },
  'ai21.jamba-instruct-v1:0': { prompt: 0.5, completion: 0.7 },
  'amazon.titan-text-lite-v1': { prompt: 0.15, completion: 0.2 },
  'amazon.titan-text-express-v1': { prompt: 0.2, completion: 0.6 },
  'amazon.titan-text-premier-v1:0': { prompt: 0.5, completion: 1.5 },
  'amazon.nova-micro-v1:0': { prompt: 0.035, completion: 0.14 },
  'amazon.nova-lite-v1:0': { prompt: 0.06, completion: 0.24 },
  'amazon.nova-pro-v1:0': { prompt: 0.8, completion: 3.2 },
  'deepseek.r1': { prompt: 1.35, completion: 5.4 },
};

/**
 * Mapping of model token sizes to their respective multipliers for prompt and completion.
 * The rates are 1 USD per 1M tokens.
 * @type {Object.<string, {prompt: number, completion: number}>}
 */
const tokenValues = Object.assign(
  {
    '8k': { prompt: 30, completion: 60 },
    '32k': { prompt: 60, completion: 120 },
    '4k': { prompt: 1.5, completion: 2 },
    '16k': { prompt: 3, completion: 4 },
    'gpt-3.5-turbo-1106': { prompt: 1, completion: 2 },
    'o4-mini': { prompt: 1.1, completion: 4.4 },
    'o3-mini': { prompt: 1.1, completion: 4.4 },
    o3: { prompt: 2, completion: 8 },
    'o1-mini': { prompt: 1.1, completion: 4.4 },
    'o1-preview': { prompt: 15, completion: 60 },
    o1: { prompt: 15, completion: 60 },
    'gpt-4.1-nano': { prompt: 0.1, completion: 0.4 },
    'gpt-4.1-mini': { prompt: 0.4, completion: 1.6 },
    'gpt-4.1': { prompt: 2, completion: 8 },
    'gpt-4.5': { prompt: 75, completion: 150 },
    'gpt-4o-mini': { prompt: 0.15, completion: 0.6 },
    'gpt-5': { prompt: 1.25, completion: 10 },
    'gpt-5-mini': { prompt: 0.25, completion: 2 },
    'gpt-5-nano': { prompt: 0.05, completion: 0.4 },
    'gpt-4o': { prompt: 2.5, completion: 10 },
    'gpt-4o-2024-05-13': { prompt: 5, completion: 15 },
    'gpt-4-1106': { prompt: 10, completion: 30 },
    'gpt-3.5-turbo-0125': { prompt: 0.5, completion: 1.5 },
    'claude-3-opus': { prompt: 15, completion: 75 },
    'claude-3-sonnet': { prompt: 3, completion: 15 },
    'claude-3-5-sonnet': { prompt: 3, completion: 15 },
    'claude-3.5-sonnet': { prompt: 3, completion: 15 },
    'claude-3-7-sonnet': { prompt: 3, completion: 15 },
    'claude-3.7-sonnet': { prompt: 3, completion: 15 },
    'claude-3-5-haiku': { prompt: 0.8, completion: 4 },
    'claude-3.5-haiku': { prompt: 0.8, completion: 4 },
    'claude-3-haiku': { prompt: 0.25, completion: 1.25 },
    'claude-sonnet-4': { prompt: 3, completion: 15 },
    'claude-opus-4': { prompt: 15, completion: 75 },
    'claude-2.1': { prompt: 8, completion: 24 },
    'claude-2': { prompt: 8, completion: 24 },
    'claude-instant': { prompt: 0.8, completion: 2.4 },
    'claude-': { prompt: 0.8, completion: 2.4 },
    'command-r-plus': { prompt: 3, completion: 15 },
    'command-r': { prompt: 0.5, completion: 1.5 },
    'deepseek-reasoner': { prompt: 0.28, completion: 0.42 },
    //new models that I added
    'deepseek-ai/DeepSeek-V3.2-Exp': { prompt: 0.27, completion: 0.4 },
    'deepseek-ai/DeepSeek-V3.1-Terminus': { prompt: 0.27, completion: 1.00 },
    'deepseek-ai/DeepSeek-V3.1': { prompt: 0.27, completion: 1.00 },
    'deepseek-ai/DeepSeek-V4-Flash': { prompt: 0.09, completion: 0.18 },
    'deepseek-ai/DeepSeek-V4-Flash-0731': { prompt: 0.06, completion: 0.18 },
    'Qwen/Qwen3-32B': { prompt: 0.08, completion: 0.28 },
    'google/gemma-3-27b-it': { prompt: 0.08, completion: 0.16 },
    'google/gemma-4-26B-A4B-it': { prompt: 0.07, completion: 0.34 },
    'google/gemma-4-31B-it': { prompt: 0.13, completion: 0.38 },
    'google/gemma-4-31B-it-turbo': { prompt: 0.09, completion: 0.34 },
    'google/gemma-4-31B-it-Ultra': { prompt: 0.27, completion: 0.76 },
    //end of new models that I added
    deepseek: { prompt: 0.28, completion: 0.42 },
    /* cohere doesn't have rates for the older command models,
  so this was from https://artificialanalysis.ai/models/command-light/providers */
    command: { prompt: 0.38, completion: 0.38 },
    gemma: { prompt: 0, completion: 0 }, // https://ai.google.dev/pricing
    'gemma-2': { prompt: 0, completion: 0 }, // https://ai.google.dev/pricing
    'gemma-3': { prompt: 0, completion: 0 }, // https://ai.google.dev/pricing
    'gemma-3-27b': { prompt: 0, completion: 0 }, // https://ai.google.dev/pricing
    'gemini-2.0-flash-lite': { prompt: 0.075, completion: 0.3 },
    'gemini-2.0-flash': { prompt: 0.1, completion: 0.4 },
    'gemini-2.0': { prompt: 0, completion: 0 }, // https://ai.google.dev/pricing
    'gemini-2.5-pro': { prompt: 1.25, completion: 10 },
    'gemini-2.5-flash': { prompt: 0.3, completion: 2.5 },
    'gemini-2.5-flash-lite': { prompt: 0.075, completion: 0.4 },
    'gemini-2.5': { prompt: 0, completion: 0 }, // Free for a period of time
    'gemini-1.5-flash-8b': { prompt: 0.075, completion: 0.3 },
    'gemini-1.5-flash': { prompt: 0.15, completion: 0.6 },
    'gemini-1.5': { prompt: 2.5, completion: 10 },
    'gemini-pro-vision': { prompt: 0.5, completion: 1.5 },
    gemini: { prompt: 0.5, completion: 1.5 },
    'grok-2-vision-1212': { prompt: 2.0, completion: 10.0 },
    'grok-2-vision-latest': { prompt: 2.0, completion: 10.0 },
    'grok-2-vision': { prompt: 2.0, completion: 10.0 },
    'grok-vision-beta': { prompt: 5.0, completion: 15.0 },
    'grok-2-1212': { prompt: 2.0, completion: 10.0 },
    'grok-2-latest': { prompt: 2.0, completion: 10.0 },
    'grok-2': { prompt: 2.0, completion: 10.0 },
    'grok-3-mini-fast': { prompt: 0.6, completion: 4 },
    'grok-3-mini': { prompt: 0.3, completion: 0.5 },
    'grok-3-fast': { prompt: 5.0, completion: 25.0 },
    'grok-3': { prompt: 3.0, completion: 15.0 },
    'grok-4': { prompt: 3.0, completion: 15.0 },
    'grok-beta': { prompt: 5.0, completion: 15.0 },
    'mistral-large': { prompt: 2.0, completion: 6.0 },
    'pixtral-large': { prompt: 2.0, completion: 6.0 },
    'mistral-saba': { prompt: 0.2, completion: 0.6 },
    codestral: { prompt: 0.3, completion: 0.9 },
    'ministral-8b': { prompt: 0.1, completion: 0.1 },
    'ministral-3b': { prompt: 0.04, completion: 0.04 },
    // GPT-OSS models
    'gpt-oss': { prompt: 0.05, completion: 0.2 },
    'gpt-oss:20b': { prompt: 0.05, completion: 0.2 },
    'gpt-oss-20b': { prompt: 0.05, completion: 0.2 },
    'gpt-oss:120b': { prompt: 0.15, completion: 0.6 },
    'gpt-oss-120b': { prompt: 0.15, completion: 0.6 },
    // GLM models (Zhipu AI)
    glm4: { prompt: 0.1, completion: 0.1 },
    'glm-4': { prompt: 0.1, completion: 0.1 },
    'glm-4-32b': { prompt: 0.1, completion: 0.1 },
    'glm-4.5': { prompt: 0.35, completion: 1.55 },
    'glm-4.5v': { prompt: 0.6, completion: 1.8 },
    'glm-4.5-air': { prompt: 0.14, completion: 0.86 },
    'glm-4.6': { prompt: 0.5, completion: 1.75 },
  },
  bedrockValues,
);

/**
 * Mapping of model token sizes to their respective multipliers for cached input, read and write.
 * See Anthropic's documentation on this: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
 * The rates are 1 USD per 1M tokens.
 * @type {Object.<string, {write: number, read: number }>}
 */
const cacheTokenValues = {
  'claude-3.7-sonnet': { write: 3.75, read: 0.3 },
  'claude-3-7-sonnet': { write: 3.75, read: 0.3 },
  'claude-3.5-sonnet': { write: 3.75, read: 0.3 },
  'claude-3-5-sonnet': { write: 3.75, read: 0.3 },
  'claude-3.5-haiku': { write: 1, read: 0.08 },
  'claude-3-5-haiku': { write: 1, read: 0.08 },
  'claude-3-haiku': { write: 0.3, read: 0.03 },
  'claude-sonnet-4': { write: 3.75, read: 0.3 },
  'claude-opus-4': { write: 18.75, read: 1.5 },
  'google/gemma-4-31B-it-turbo': { read: 0.05 },
};

/**
 * Retrieves the key associated with a given model name.
 *
 * @param {string} model - The model name to match.
 * @param {string} endpoint - The endpoint name to match.
 * @returns {string|undefined} The key corresponding to the model name, or undefined if no match is found.
 */
const getValueKey = (model, endpoint) => {
  const modelName = matchModelName(model, endpoint);
  if (!modelName) {
    return undefined;
  }

  if (modelName.includes('gpt-3.5-turbo-16k')) {
    return '16k';
  } else if (modelName.includes('gpt-3.5-turbo-0125')) {
    return 'gpt-3.5-turbo-0125';
  } else if (modelName.includes('gpt-3.5-turbo-1106')) {
    return 'gpt-3.5-turbo-1106';
  } else if (modelName.includes('gpt-3.5')) {
    return '4k';
  } else if (modelName.includes('o4-mini')) {
    return 'o4-mini';
  } else if (modelName.includes('o4')) {
    return 'o4';
  } else if (modelName.includes('o3-mini')) {
    return 'o3-mini';
  } else if (modelName.includes('o3')) {
    return 'o3';
  } else if (modelName.includes('o1-preview')) {
    return 'o1-preview';
  } else if (modelName.includes('o1-mini')) {
    return 'o1-mini';
  } else if (modelName.includes('o1')) {
    return 'o1';
  } else if (modelName.includes('gpt-4.5')) {
    return 'gpt-4.5';
  } else if (modelName.includes('gpt-4.1-nano')) {
    return 'gpt-4.1-nano';
  } else if (modelName.includes('gpt-4.1-mini')) {
    return 'gpt-4.1-mini';
  } else if (modelName.includes('gpt-4.1')) {
    return 'gpt-4.1';
  } else if (modelName.includes('gpt-4o-2024-05-13')) {
    return 'gpt-4o-2024-05-13';
  } else if (modelName.includes('gpt-5-nano')) {
    return 'gpt-5-nano';
  } else if (modelName.includes('gpt-5-mini')) {
    return 'gpt-5-mini';
  } else if (modelName.includes('gpt-5')) {
    return 'gpt-5';
  } else if (modelName.includes('gpt-4o-mini')) {
    return 'gpt-4o-mini';
  } else if (modelName.includes('gpt-4o')) {
    return 'gpt-4o';
  } else if (modelName.includes('gpt-4-vision')) {
    return 'gpt-4-1106';
  } else if (modelName.includes('gpt-4-1106')) {
    return 'gpt-4-1106';
  } else if (modelName.includes('gpt-4-0125')) {
    return 'gpt-4-1106';
  } else if (modelName.includes('gpt-4-turbo')) {
    return 'gpt-4-1106';
  } else if (modelName.includes('gpt-4-32k')) {
    return '32k';
  } else if (modelName.includes('gpt-4')) {
    return '8k';
  } else if (tokenValues[modelName]) {
    return modelName;
  }

  return undefined;
};

/**
 * Retrieves the multiplier for a given value key and token type. If no value key is provided,
 * it attempts to derive it from the model name.
 *
 * @param {Object} params - The parameters for the function.
 * @param {string} [params.valueKey] - The key corresponding to the model name.
 * @param {'prompt' | 'completion'} [params.tokenType] - The type of token (e.g., 'prompt' or 'completion').
 * @param {string} [params.model] - The model name to derive the value key from if not provided.
 * @param {string} [params.endpoint] - The endpoint name to derive the value key from if not provided.
 * @param {EndpointTokenConfig} [params.endpointTokenConfig] - The token configuration for the endpoint.
 * @returns {number} The multiplier for the given parameters, or a default value if not found.
 */
const getMultiplier = ({ valueKey, tokenType, model, endpoint, endpointTokenConfig }) => {
  if (endpointTokenConfig) {
    return endpointTokenConfig?.[model]?.[tokenType] ?? defaultRate;
  }

  if (valueKey && tokenType) {
    return tokenValues[valueKey][tokenType] ?? defaultRate;
  }

  if (!tokenType || !model) {
    return 1;
  }

  valueKey = getValueKey(model, endpoint);
  if (!valueKey) {
    return defaultRate;
  }

  // If we got this far, and values[tokenType] is undefined somehow, return a rough average of default multipliers
  return tokenValues[valueKey]?.[tokenType] ?? defaultRate;
};

/**
 * Retrieves the cache multiplier for a given value key and token type. If no value key is provided,
 * it attempts to derive it from the model name.
 *
 * @param {Object} params - The parameters for the function.
 * @param {string} [params.valueKey] - The key corresponding to the model name.
 * @param {'write' | 'read'} [params.cacheType] - The type of token (e.g., 'write' or 'read').
 * @param {string} [params.model] - The model name to derive the value key from if not provided.
 * @param {string} [params.endpoint] - The endpoint name to derive the value key from if not provided.
 * @param {EndpointTokenConfig} [params.endpointTokenConfig] - The token configuration for the endpoint.
 * @returns {number | null} The multiplier for the given parameters, or `null` if not found.
 */
const getCacheMultiplier = ({ valueKey, cacheType, model, endpoint, endpointTokenConfig }) => {
  if (endpointTokenConfig) {
    return endpointTokenConfig?.[model]?.[cacheType] ?? null;
  }

  if (valueKey && cacheType) {
    return cacheTokenValues[valueKey]?.[cacheType] ?? null;
  }

  if (!cacheType || !model) {
    return null;
  }

  valueKey = getValueKey(model, endpoint);
  if (!valueKey) {
    return null;
  }

  // If we got this far, and values[cacheType] is undefined somehow, return a rough average of default multipliers
  return cacheTokenValues[valueKey]?.[cacheType] ?? null;
};

module.exports = {
  tokenValues,
  getValueKey,
  getMultiplier,
  getCacheMultiplier,
  defaultRate,
  cacheTokenValues,
};
