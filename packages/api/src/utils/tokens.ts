import z from 'zod';
import { EModelEndpoint, isOpus55Model, supportsContext1m } from 'librechat-data-provider';
import type { EndpointTokenConfig, TokenConfig } from '~/types';

/**
 * Model Token Configuration Maps
 *
 * Pattern Matching
 * ================
 * `findMatchingPattern` uses `modelName.includes(key)` and selects the **longest**
 * matching key. If a key's length equals the model name's length (exact match), it
 * returns immediately — no further keys are checked.
 *
 * For keys of different lengths, definition order does not affect the result — the
 * longest match always wins. For **same-length ties**, the function iterates in
 * reverse, so the last-defined key wins. Key ordering therefore matters for:
 *
 * 1. **Performance**: list older/legacy models first, newer models last — newer
 *    models are more commonly used and will match earlier in the reverse scan.
 * 2. **Same-length tie-breaking**: in `aggregateModels`, OpenAI is spread last
 *    so its keys are preferred when two keys of equal length both match.
 */

const openAIModels = {
  'gpt-3.5-turbo-0301': 4092, // -5 from max
  'gpt-3.5-turbo-0613': 4092, // -5 from max
  'gpt-3.5-turbo-16k': 16375, // -10 from max
  'gpt-3.5-turbo-16k-0613': 16375, // -10 from max
  'gpt-3.5-turbo-1106': 16375, // -10 from max
  'gpt-3.5-turbo-0125': 16375, // -10 from max
  'gpt-3.5-turbo': 16375, // -10 from max
  'gpt-4': 8187, // -5 from max
  'gpt-4-0613': 8187, // -5 from max
  'gpt-4-32k': 32758, // -10 from max
  'gpt-4-32k-0314': 32758, // -10 from max
  'gpt-4-32k-0613': 32758, // -10 from max
  'gpt-4-1106': 127500, // -500 from max
  'gpt-4-0125': 127500, // -500 from max
  'gpt-4-turbo': 127500, // -500 from max
  'gpt-4-vision': 127500, // -500 from max
  'gpt-4o-2024-05-13': 127500, // -500 from max
  'gpt-4o-mini': 127500, // -500 from max
  'gpt-4o': 127500, // -500 from max
  'gpt-4.5': 127500, // -500 from max
  'o1-mini': 127500, // -500 from max
  'o1-preview': 127500, // -500 from max
  o1: 195000, // -5000 from max
  'o3-mini': 195000, // -5000 from max
  o3: 200000,
  'o4-mini': 200000,
  'gpt-4.1': 1047576,
  'gpt-4.1-mini': 1047576,
  'gpt-4.1-nano': 1047576,
  'gpt-5': 400000,
  'gpt-5.1': 400000,
  'gpt-5.2': 400000,
  'gpt-5.3': 400000,
  'gpt-5.4': 1050000, // >272K input prices at the long-context tier (2x input, 1.5x output)
  'gpt-5.4-pro': 1050000,
  'gpt-5.4-mini': 400000,
  'gpt-5.4-nano': 400000,
  'gpt-5.5': 1050000,
  'gpt-5.5-pro': 1050000,
  'gpt-5.6': 1050000,
  'gpt-5.6-terra': 1050000,
  'gpt-5.6-luna': 1050000,
  'gpt-6-astra': 1050000, // >272K input prices at the long-context tier (2x input/cache, 1.5x output)
  'gpt-6-sol': 1050000, // >272K input prices at the long-context tier (2x input/cache, 1.5x output)
  'gpt-6-luna': 1050000, // >272K input prices at the long-context tier (2x input/cache, 1.5x output)
  'chat-latest': 400000,
  'gpt-5-mini': 400000,
  'gpt-5-nano': 400000,
  'gpt-5-pro': 400000,
  'gpt-5.2-pro': 400000,
};

const mistralModels = {
  'mistral-': 31990, // -10 from max
  'mistral-7b': 31990, // -10 from max
  'mistral-small': 31990, // -10 from max
  'mixtral-8x7b': 31990, // -10 from max
  'mixtral-8x22b': 65536,
  'mistral-large-2402': 127500,
  'mistral-large-2407': 127500,
  'mistral-large': 131000,
  'mistral-large-3': 255000,
  'mistral-saba': 32000,
  'ministral-3b': 131000,
  'ministral-8b': 131000,
  'mistral-nemo': 131000,
  'pixtral-large': 131000,
  codestral: 256000,
  'mistral-medium-3': 131000,
  'mistral-medium-3.5': 262144,
  'mistral-medium-3-5': 262144,
  'ministral-8b-2512': 262144,
  'ministral-14b-2512': 262144,
};

const cohereModels = {
  'command-light': 4086, // -10 from max
  'command-light-nightly': 8182, // -10 from max
  command: 4086, // -10 from max
  'command-nightly': 8182, // -10 from max
  'command-text': 4086, // -10 from max
  'command-r': 127500, // -500 from max
  'command-r-plus': 127500, // -500 from max
  'command-a': 255500, // -500 from max
  'command-a-plus': 127500, // -500 from max
};

const googleModels = {
  /* Max I/O is combined so we subtract the amount from max response tokens for actual total */
  gemma: 32768,
  'gemma-2': 32768,
  'gemma-3': 32768,
  'gemma-3-27b': 131072,
  'gemma4:31b': 256000,
  'gemma4-31b': 256000,
  'gemma-4-31b': 256000,
  'gemma4:26b': 256000,
  'gemma4-26b': 256000,
  'gemma-4-26b-a4b': 256000,
  'gemma-4-26b': 256000,
  gemma4: 128000,
  'gemma-4': 128000,
  gemini: 30720, // -2048 from max
  'gemini-pro-vision': 12288,
  'gemini-1.5': 1000000,
  'gemini-1.5-flash': 1000000,
  'gemini-1.5-flash-8b': 1000000,
  'gemini-2.0': 2000000,
  'gemini-2.0-flash': 1000000,
  'gemini-2.0-flash-lite': 1000000,
  'gemini-exp': 2000000,
  'gemini-2.5': 1000000,
  'gemini-2.5-pro': 1000000,
  'gemini-2.5-flash': 1000000,
  'gemini-2.5-flash-image': 1000000,
  'gemini-2.5-flash-lite': 1000000,
  'gemini-3': 1000000,
  'gemini-3-pro-image': 1000000,
  'gemini-3.1': 1000000,
  'gemini-3.1-flash-lite': 1000000,
  'gemini-3.5-flash': 1048576,
  'gemini-3.5-flash-lite': 1048576,
  'gemini-3.6-flash': 1048576,
  'gemini-3.7-flash': 1048576,
  'gemini-3.8-flash': 1048576,
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
  'claude-3-5-sonnet': 200000,
  'claude-3.5-sonnet': 200000,
  'claude-3-5-sonnet-latest': 200000,
  'claude-3.5-sonnet-latest': 200000,
  'claude-3-5-haiku': 200000,
  'claude-3.5-haiku': 200000,
  'claude-3-7-sonnet': 200000,
  'claude-3.7-sonnet': 200000,
  'claude-4': 200000,
  'claude-haiku-4-5': 200000,
  'claude-opus-4': 200000,
  'claude-opus-4-5': 200000,
  'claude-sonnet-4': 200000,
  'claude-sonnet-4-5': 200000,
  'claude-sonnet-4-6': 1000000,
  'claude-sonnet-4.6': 1000000,
  'claude-sonnet-4-7': 1000000,
  'claude-sonnet-4.7': 1000000,
  'claude-sonnet-4-8': 1000000,
  'claude-sonnet-4.8': 1000000,
  'claude-sonnet-4-9': 1000000,
  'claude-sonnet-4.9': 1000000,
  'claude-sonnet-5': 1000000,
  'claude-opus-4-6': 1000000,
  'claude-opus-4-7': 1000000,
  'claude-opus-4-8': 1000000,
  'claude-opus-5-5': 1000000,
  'claude-opus-5.5': 1000000,
  'claude-opus-5': 1000000,
  'claude-fable-5': 1000000,
  'claude-mythos-5': 1000000,
  'claude-fable-5-1': 1000000,
  'claude-mythos-5-1': 1000000,
};

const ANTHROPIC_CONTEXT_1M = 1000000;
const ANTHROPIC_OPUS_55_OUTPUT = 128000;
const ANTHROPIC_SONNET_4_6_PLUS_OUTPUT = 128000;
const ANTHROPIC_SONNET_4_6_PLUS_PATTERN =
  /(?:claude-sonnet[-.]?4[-.]?(?:[6-9]|\d{2})|claude[-.]?4[-.]?(?:[6-9]|\d{2})[-.]?sonnet)(?=$|[^0-9])/;

function usesAnthropicContextMap(endpoint: EModelEndpoint): boolean {
  return (
    endpoint === EModelEndpoint.anthropic ||
    endpoint === EModelEndpoint.bedrock ||
    endpoint === EModelEndpoint.openAI ||
    endpoint === EModelEndpoint.agents ||
    endpoint === EModelEndpoint.custom
  );
}

function getAnthropicContext1m(modelName: string, endpoint: EModelEndpoint): number | undefined {
  if (!usesAnthropicContextMap(endpoint) || !supportsContext1m(modelName)) {
    return undefined;
  }
  return ANTHROPIC_CONTEXT_1M;
}

function getAnthropicSonnet46PlusOutput(
  modelName: string,
  endpoint: EModelEndpoint,
): number | undefined {
  if (endpoint !== EModelEndpoint.anthropic || !ANTHROPIC_SONNET_4_6_PLUS_PATTERN.test(modelName)) {
    return undefined;
  }
  return ANTHROPIC_SONNET_4_6_PLUS_OUTPUT;
}

function getAnthropicOpus55Output(modelName: string, endpoint: EModelEndpoint): number | undefined {
  if (!usesAnthropicContextMap(endpoint) || !isOpus55Model(modelName)) {
    return undefined;
  }
  return ANTHROPIC_OPUS_55_OUTPUT;
}

const deepseekModels = {
  deepseek: 128000,
  'deepseek-chat': 128000,
  'deepseek-v3': 128000,
  'deepseek.r1': 128000,
  'deepseek-r1': 128000,
  'deepseek-reasoner': 128000,
  'deepseek-v3.1': 163840,
  'deepseek-v3.2': 163840,
  'deepseek-v3.2-speciale': 131072,
  'deepseek-v4': 1048576,
  'deepseek-v4-flash': 1048576,
  'deepseek-v4-pro': 1048576,
};

const moonshotModels = {
  // moonshot-v1 series (older)
  moonshot: 131072,
  'moonshot-v1': 131072,
  'moonshot-v1-auto': 131072,
  'moonshot-v1-8k': 8192,
  'moonshot-v1-8k-vision': 8192,
  'moonshot-v1-8k-vision-preview': 8192,
  'moonshot-v1-32k': 32768,
  'moonshot-v1-32k-vision': 32768,
  'moonshot-v1-32k-vision-preview': 32768,
  'moonshot-v1-128k': 131072,
  'moonshot-v1-128k-vision': 131072,
  'moonshot-v1-128k-vision-preview': 131072,
  // kimi series
  kimi: 262144,
  'kimi-latest': 128000,
  'kimi-k2-0711': 131072,
  'kimi-k2-0711-preview': 131072,
  'kimi-k2-0905': 262144,
  'kimi-k2-0905-preview': 262144,
  'kimi-k2': 262144,
  'kimi-k2-turbo': 262144,
  'kimi-k2-turbo-preview': 262144,
  'kimi-k2-thinking': 262144,
  'kimi-k2-thinking-turbo': 262144,
  'kimi-k2.5': 262144,
  'kimi-k2.6': 262144,
  'kimi-k2.7': 262144,
  'kimi-k3': 1048576,
  // Bedrock moonshot models
  'moonshot.kimi-k2-0711': 131072,
  'moonshot.kimi': 262144,
  'moonshot.kimi-k2': 262144,
  'moonshot.kimi-k2-thinking': 262144,
  'moonshotai.kimi': 262144,
  'moonshot.kimi-k2.5': 262144,
  'moonshotai.kimi-k2.5': 262144,
  'moonshot.kimi-k3': 1048576,
  'moonshotai.kimi-k3': 1048576,
};

const metaModels = {
  // Llama 2 (oldest)
  llama2: 4000,
  'llama-2': 4000,
  'llama2-13b': 4000,
  'llama2-70b': 4000,
  'llama2:70b': 4000,
  // Llama 3 base
  llama3: 8000,
  'llama-3': 8000,
  'llama3-8b': 8000,
  'llama3-70b': 8000,
  'llama3:8b': 8000,
  'llama3:70b': 8000,
  // Llama 3.1
  'llama3.1': 127500,
  'llama3-1': 127500,
  'llama-3.1': 127500,
  'llama3.1:8b': 127500,
  'llama3.1:70b': 127500,
  'llama3.1:405b': 127500,
  'llama3-1-8b': 127500,
  'llama3-1-70b': 127500,
  'llama3-1-405b': 127500,
  'llama-3.1-8b': 127500,
  'llama-3.1-70b': 127500,
  'llama-3.1-405b': 127500,
  // Llama 3.2
  'llama3.2': 127500,
  'llama3-2': 127500,
  'llama-3.2': 127500,
  'llama3.2:1b': 127500,
  'llama3.2:3b': 127500,
  'llama3.2:11b': 127500,
  'llama3.2:90b': 127500,
  'llama3-2-1b': 127500,
  'llama3-2-3b': 127500,
  'llama3-2-11b': 127500,
  'llama3-2-90b': 127500,
  'llama-3.2-1b': 127500,
  'llama-3.2-3b': 127500,
  'llama-3.2-11b': 127500,
  'llama-3.2-90b': 127500,
  // Llama 3.3
  'llama3.3': 127500,
  'llama3-3': 127500,
  'llama-3.3': 127500,
  'llama3.3:70b': 127500,
  'llama3-3-70b': 127500,
  'llama-3.3-70b': 127500,
  /* Llama 4. Scout's native ceiling is 10M, but no host serves anywhere near it,
     so capping at 1M keeps pruning useful instead of never firing. */
  llama4: 1048576,
  'llama-4': 1048576,
  'llama4-scout': 1048576,
  'llama-4-scout': 1048576,
  'llama4-maverick': 1048576,
  'llama-4-maverick': 1048576,
  // Muse (newest)
  musespark: 1000000,
  'muse-spark': 1000000,
  'muse-spark-1.1': 1000000,
  'muse-spark-1.2': 1000000,
  'muse-glimmer': 131072,
  'muse-glimmer-30b': 131072,
};

const qwenModels = {
  qwen: 32000,
  'qwen2.5': 32000,
  'qwen-max': 32000,
  'qwen-plus': 131000,
  'qwen-turbo': 1000000,
  'qwq-32b': 32000,
  // Qwen3 models (newest)
  qwen3: 40960,
  'qwen3-14b': 40960,
  'qwen3-30b-a3b': 40960,
  'qwen3-32b': 40960,
  'qwen3-235b-a22b': 40960,
  'qwen3-8b': 128000,
  'qwen3-vl-235b-a22b': 131072,
  'qwen3-vl-8b-thinking': 256000,
  'qwen3-max': 256000,
  'qwen3-vl-8b-instruct': 262144,
  'qwen3-vl-30b-a3b': 262144,
  'qwen3-coder': 262144,
  'qwen3-coder-30b-a3b': 262144,
  'qwen3-coder-plus': 128000,
  'qwen3-coder-flash': 128000,
  'qwen3-next-80b-a3b': 262144,
  'qwen3-coder-next': 262144,
  /* Qwen3.5 onward: every open-weight size ships a 262K native window, while the
     hosted plus/flash tiers serve 1M. */
  'qwen3.5': 262144,
  'qwen3.5-plus': 1000000,
  'qwen3.5-flash': 1000000,
  'qwen3.6': 262144,
  'qwen3.6-plus': 1000000,
  'qwen3.6-flash': 1000000,
  'qwen3.7': 262144,
  'qwen3.7-plus': 1000000,
  'qwen3.7-flash': 1000000,
  'qwen3.8': 262144,
  'qwen3.8-plus': 1000000,
  'qwen3.8-flash': 1000000,
};

const ai21Models = {
  'j2-mid': 8182, // -10 from max
  'j2-ultra': 8182, // -10 from max
  'jamba-instruct': 255500, // -500 from max
};

const amazonModels = {
  // Amazon Titan models
  'titan-text-lite': 4000,
  'titan-text-express': 8000,
  'titan-text-premier': 31500, // -500 from max
  // Amazon Nova models
  // https://aws.amazon.com/ai/generative-ai/nova/
  'nova-micro': 127000, // -1000 from max
  'nova-lite': 295000, // -5000 from max
  'nova-pro': 295000, // -5000 from max
  'nova-premier': 995000, // -5000 from max
  'nova-2-lite': 995000, // -5000 from max
  'nova-2-pro': 995000, // -5000 from max
};

/** Bedrock can reject near-limit GPT prompts before its published window is reached. */
const bedrockOpenAIContext = 950000;

const openAIBedrockModels = {
  'openai.gpt-oss-20b': 128000,
  'openai.gpt-oss-120b': 128000,
  'openai.gpt-5.6': bedrockOpenAIContext,
  'openai.gpt-6-astra': bedrockOpenAIContext,
  'openai.gpt-6-sol': bedrockOpenAIContext,
  'openai.gpt-6-luna': bedrockOpenAIContext,
};

const bedrockModels = {
  ...mistralModels,
  ...cohereModels,
  ...deepseekModels,
  ...moonshotModels,
  ...metaModels,
  ...ai21Models,
  ...amazonModels,
  ...openAIBedrockModels,
  ...anthropicModels,
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
  'grok-code-fast': 256000, // 256K context
  'grok-4': 256000, // 256K context
  'grok-4-fast': 2000000, // 2M context
  'grok-4-1-fast': 2000000, // 2M context (covers reasoning & non-reasoning variants)
  'grok-4.5': 500000,
  'grok-4-5': 500000,
  'grok-4.6': 500000,
  'grok-4-6': 500000,
  'grok-4.7': 500000,
  'grok-4-7': 500000,
};

const aggregateModels = {
  // GLM models (Zhipu AI)
  glm4: 128000,
  'glm-4': 128000,
  'glm-4-32b': 128000,
  'glm-4.5': 131000,
  'glm-4.5-air': 131000,
  'glm-4.5v': 66000,
  'glm-4.6': 200000,
  'glm-4.7': 204800,
  'glm-4.7-flash': 202752,
  'glm-5': 204800,
  'glm-5.1': 204800,
  'glm-5.2': 1048576,
  'glm-5.3': 1048576,
  // MiniMax
  'minimax-m1': 1000000,
  'minimax-m2': 204800,
  'minimax-m2.7': 204800,
  'minimax-m3': 1048576,
  // GPT-OSS
  'gpt-oss': 131000,
  'gpt-oss:20b': 131000,
  'gpt-oss-20b': 131000,
  'gpt-oss:120b': 131000,
  'gpt-oss-120b': 131000,
  ...qwenModels,
  ...xAIModels,
  ...googleModels,
  ...bedrockModels,
  // OpenAI last — reverse iteration checks last-spread keys first for same-length ties
  ...openAIModels,
};

export const maxTokensMap: Record<string, Record<string, number>> = {
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
  'gpt-5.1': 128000,
  'gpt-5.2': 128000,
  'gpt-5.3': 128000,
  'gpt-5.4': 128000,
  'gpt-5.4-pro': 128000,
  'gpt-5.4-mini': 128000,
  'gpt-5.4-nano': 128000,
  'gpt-5.5': 128000,
  'gpt-5.5-pro': 128000,
  'gpt-5.6': 128000,
  'gpt-5.6-terra': 128000,
  'gpt-5.6-luna': 128000,
  'gpt-6-astra': 128000,
  'gpt-6-sol': 128000,
  'gpt-6-luna': 128000,
  'chat-latest': 128000,
  'gpt-5-mini': 128000,
  'gpt-5-nano': 128000,
  'gpt-5-pro': 128000,
  'gpt-5.2-pro': 128000,
  'gpt-oss-20b': 131000,
  'gpt-oss-120b': 131000,
  system_default: 32000,
};

/** Outputs from https://docs.anthropic.com/en/docs/about-claude/models/all-models#model-names */
const anthropicMaxOutputs = {
  'claude-3-haiku': 4096,
  'claude-3-sonnet': 4096,
  'claude-3-opus': 4096,
  'claude-haiku-4-5': 64000,
  'claude-sonnet-4': 64000,
  'claude-sonnet-4-6': 128000,
  'claude-sonnet-4.6': 128000,
  'claude-sonnet-4-7': 128000,
  'claude-sonnet-4.7': 128000,
  'claude-sonnet-4-8': 128000,
  'claude-sonnet-4.8': 128000,
  'claude-sonnet-4-9': 128000,
  'claude-sonnet-4.9': 128000,
  'claude-sonnet-5': 128000,
  'claude-opus-4': 32000,
  'claude-opus-4-5': 64000,
  'claude-opus-4-6': 128000,
  'claude-opus-4-7': 128000,
  'claude-opus-4-8': 128000,
  'claude-opus-5-5': 128000,
  'claude-opus-5.5': 128000,
  'claude-opus-5': 128000,
  'claude-fable-5': 128000,
  'claude-mythos-5': 128000,
  'claude-fable-5-1': 128000,
  'claude-mythos-5-1': 128000,
  'claude-3.5-sonnet': 8192,
  'claude-3-5-sonnet': 8192,
  'claude-3.7-sonnet': 128000,
  'claude-3-7-sonnet': 128000,
};

/** Outputs from https://api-docs.deepseek.com/quick_start/pricing */
const deepseekMaxOutputs = {
  deepseek: 8000, // deepseek-chat default: 4K, max: 8K
  'deepseek-chat': 8000,
  'deepseek-reasoner': 64000, // default: 32K, max: 64K
  'deepseek-r1': 64000,
  'deepseek-v3': 8000,
  'deepseek.r1': 64000,
};

export const maxOutputTokensMap: Record<string, Record<string, number>> = {
  [EModelEndpoint.anthropic]: anthropicMaxOutputs,
  [EModelEndpoint.azureOpenAI]: modelMaxOutputs,
  [EModelEndpoint.openAI]: { ...modelMaxOutputs, ...deepseekMaxOutputs },
  [EModelEndpoint.custom]: { ...modelMaxOutputs, ...deepseekMaxOutputs },
};

/**
 * Any model-keyed map. Matching reads keys only and never inspects a value, so
 * the value type is deliberately open rather than a union that every caller has
 * to cast into.
 */
type ModelKeyedMap = Readonly<Record<string, unknown>>;

function findLongestKey(lowerModelName: string, tokensMap: ModelKeyedMap): string | null {
  const keys = Object.keys(tokensMap);
  let bestMatch: string | null = null;
  let bestLength = 0;
  for (let i = keys.length - 1; i >= 0; i--) {
    const key = keys[i];
    const lowerKey = key.toLowerCase();
    if (lowerKey.length > bestLength && lowerModelName.includes(lowerKey)) {
      if (lowerKey.length === lowerModelName.length) {
        return key;
      }
      bestMatch = key;
      bestLength = lowerKey.length;
    }
  }

  return bestMatch;
}

/**
 * Finds the longest matching key in the tokens map via substring match.
 *
 * A vendor prefix can outrank the id it precedes: `moonshotai/kimi-k2` matched
 * `moonshot` (8) over `kimi-k2` (7) and reported half the real window. When the
 * whole id resolves to a prefix-only match, retry against the model segment.
 *
 * A key that carries the vendor itself is already the most specific answer and
 * is kept. `EndpointTokenConfig` is an arbitrary record, and one built from
 * OpenRouter is keyed by `org/model`, so those must still beat a bare `model`.
 */
export function findMatchingPattern(modelName: string, tokensMap: ModelKeyedMap): string | null {
  const lowerModelName = modelName.toLowerCase();
  const slashIndex = lowerModelName.lastIndexOf('/');
  if (slashIndex === -1) {
    return findLongestKey(lowerModelName, tokensMap);
  }

  const fullMatch = findLongestKey(lowerModelName, tokensMap);
  if (fullMatch != null && fullMatch.includes('/')) {
    return fullMatch;
  }
  return findLongestKey(lowerModelName.slice(slashIndex + 1), tokensMap) ?? fullMatch;
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
  endpoint: EModelEndpoint = EModelEndpoint.openAI,
  endpointTokenConfig?: EndpointTokenConfig,
): number | undefined {
  if (typeof modelName !== 'string') {
    return undefined;
  }

  /** A partial override only covers the models it lists; fall back to the
   *  built-in map for unlisted models instead of dropping to the default
   *  budget (matches buildTokenConfigMap and getMultiplier). */
  if (endpointTokenConfig != null) {
    const overrideValue = getModelTokenValue(modelName, endpointTokenConfig);
    if (overrideValue != null) {
      return overrideValue;
    }
  }
  const context1mValue = getAnthropicContext1m(modelName, endpoint);
  if (context1mValue != null) {
    return context1mValue;
  }
  return getModelTokenValue(modelName, maxTokensMap[endpoint as keyof typeof maxTokensMap]);
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
  endpoint: EModelEndpoint = EModelEndpoint.openAI,
  endpointTokenConfig?: EndpointTokenConfig,
): number | undefined {
  /** Partial override fallback — see getModelMaxTokens */
  if (endpointTokenConfig != null) {
    const overrideValue = getModelTokenValue(modelName, endpointTokenConfig, 'output');
    if (overrideValue != null) {
      return overrideValue;
    }
  }
  const opus55Value = getAnthropicOpus55Output(modelName, endpoint);
  if (opus55Value != null) {
    return opus55Value;
  }
  const sonnet46PlusValue = getAnthropicSonnet46PlusOutput(modelName, endpoint);
  if (sonnet46PlusValue != null) {
    return sonnet46PlusValue;
  }
  return getModelTokenValue(
    modelName,
    maxOutputTokensMap[endpoint as keyof typeof maxOutputTokensMap],
    'output',
  );
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
  endpoint: EModelEndpoint = EModelEndpoint.openAI,
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
  if (
    (matchedPattern === 'claude-sonnet-4' || matchedPattern === 'claude-4') &&
    getAnthropicContext1m(modelName, endpoint) != null
  ) {
    return modelName;
  }
  return matchedPattern || modelName;
}

export const modelSchema: z.ZodObject<
  {
    id: z.ZodString;
    pricing: z.ZodObject<
      {
        prompt: z.ZodString;
        completion: z.ZodString;
      },
      'strip',
      z.ZodTypeAny,
      {
        prompt: string;
        completion: string;
      },
      {
        prompt: string;
        completion: string;
      }
    >;
    context_length: z.ZodNumber;
  },
  'strip'
> = z.object({
  id: z.string(),
  pricing: z.object({
    prompt: z.string(),
    completion: z.string(),
  }),
  context_length: z.number(),
});

export const inputSchema: z.ZodObject<
  {
    data: z.ZodArray<
      z.ZodObject<
        {
          id: z.ZodString;
          pricing: z.ZodObject<
            {
              prompt: z.ZodString;
              completion: z.ZodString;
            },
            'strip',
            z.ZodTypeAny,
            {
              prompt: string;
              completion: string;
            },
            {
              prompt: string;
              completion: string;
            }
          >;
          context_length: z.ZodNumber;
        },
        'strip',
        z.ZodTypeAny,
        {
          id: string;
          pricing: {
            prompt: string;
            completion: string;
          };
          context_length: number;
        },
        {
          id: string;
          pricing: {
            prompt: string;
            completion: string;
          };
          context_length: number;
        }
      >,
      'many'
    >;
  },
  'strip'
> = z.object({
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
