import { z } from 'zod';
import { openAISchema } from 'librechat-data-provider';
import type { BindToolsInput } from '@librechat/agents/langchain/language_models/chat_models';
import type { OpenAIClientOptions, Providers } from '@librechat/agents';
import type { TConfig } from 'librechat-data-provider';
import type { AzureOptions } from './azure';

export type OpenAIParameters = z.infer<typeof openAISchema>;

export type OpenAIModelOptions = Partial<OpenAIParameters>;

/**
 * Configuration options for the getLLMConfig function
 */
export interface OpenAIConfigOptions {
  modelOptions?: OpenAIModelOptions;
  transportTimeouts?: {
    bodyTimeout: number;
    headersTimeout: number;
  };
  directEndpoint?: boolean;
  reverseProxyUrl?: string | null;
  baseURLIsUserProvided?: boolean;
  allowedAddresses?: string[] | null;
  defaultQuery?: Record<string, string | undefined>;
  headers?: Record<string, string>;
  proxy?: string | null;
  azure?: false | AzureOptions;
  streaming?: boolean;
  addParams?: Record<string, unknown>;
  dropParams?: string[];
  customParams?: Partial<TConfig['customParams']>;
}

export type OpenAIConfiguration = OpenAIClientOptions['configuration'];

export type OAIClientOptions = Omit<OpenAIClientOptions, 'verbosity'> & {
  include_reasoning?: boolean;
  /** Replays `reasoning_content` on tool-bearing turns (DeepSeek thinking-mode, #13366). */
  includeReasoningContent?: boolean;
  promptCache?: boolean;
  promptCacheTtl?: '5m' | '1h';
  /**
   * Declares that this client talks to a first-party OpenAI or Azure surface, which is
   * what gates the agents SDK's model-specific request constraints (GPT-6
   * Astra: Responses-only tool calls, rejected sampling parameters,
   * unsupported reasoning efforts). The SDK defaults them off and takes this as
   * a declaration rather than inferring it from a base URL, because only this
   * layer knows whether a URL is a faithful first-party route or a gateway.
   */
  firstPartyEndpoint?: boolean;
  _lc_stream_delay?: number;
  verbosity?: string | null;
};

/**
 * Return type for getLLMConfig function
 */
export interface LLMConfigResult<T = OAIClientOptions> {
  llmConfig: T;
  provider?: Providers;
  tools?: BindToolsInput[];
}

export type OpenAIConfigResult = LLMConfigResult<OAIClientOptions> & {
  configOptions?: OpenAIConfiguration;
};
