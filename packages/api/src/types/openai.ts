import { z } from 'zod';
import { openAISchema } from 'librechat-data-provider';
import type { BindToolsInput } from '@librechat/agents/langchain/language_models/chat_models';
import type { OpenAIClientOptions, Providers } from '@librechat/agents';
import type { TConfig } from 'librechat-data-provider';
import type { AzureOptions } from './azure';

export type OpenAIParameters = z.infer<typeof openAISchema>;

export type OpenAIModelOptions = Partial<OpenAIParameters>;

/**
 * `prompt_cache_retention`. `'in-memory'` is the provider default lifetime;
 * `'24h'` opts into extended retention, which is billed differently.
 */
export type OpenAIPromptCacheRetention = 'in-memory' | '24h';

/**
 * Partition a synthesized `prompt_cache_key` carries. `user` keeps each user's
 * cache accounting separate, as the `user` field already does; `shared` lets
 * one cached prefix serve every user running the same agent.
 */
export type OpenAIPromptCacheScope = 'user' | 'shared';

/**
 * Configuration options for the getLLMConfig function
 */
/**
 * What one discovered tool definition looked like before this conversation's
 * `tool_search` results reshaped it: `appended` for a definition the
 * configured request never carried, otherwise the `defer_loading` value
 * discovery overwrote.
 */
export type PromptCacheConfiguredToolState = Record<
  string,
  { appended?: true; deferLoading?: boolean }
>;

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
  /** Endpoint-level prompt-cache levers, resolved from `librechat.yaml`. */
  promptCacheKeyEnabled?: boolean;
  promptCacheScope?: OpenAIPromptCacheScope;
  promptCacheRetention?: OpenAIPromptCacheRetention;
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
   * Endpoint policy allows a deterministic `prompt_cache_key` on this request.
   * `getOpenAILLMConfig` resolves the policy but cannot produce the key, which
   * hashes stable instructions and tool schemas assembled later; `createRun`
   * consumes this flag and sets `promptCacheKey`.
   */
  promptCacheKeyEnabled?: boolean;
  /**
   * Partition the synthesized key carries. Read by `createRun` alongside the
   * flag above and, like it, removed before the request is sent.
   */
  promptCacheScope?: OpenAIPromptCacheScope;
  /**
   * Partition identity, stamped by `createRun` from the authenticated user of
   * the run. Not resolved with the policy above and never read back off the
   * request: `addParams` can pin the `user` field to a constant, `dropParams`
   * can remove it, and some models drop it on their own, each of which would
   * merge every user onto one cache entry. Consumed by `createRun` and, like
   * the other markers, never sent.
   */
  promptCacheScopeId?: string;
  /**
   * Stable instruction sources the host folds into the dynamic system tail —
   * an isolated child's always-apply skill bodies. Recorded where they are
   * still distinguishable from the memory and file context in the same
   * string, so the identity covers them without partitioning per conversation.
   * Consumed by `createRun` and never sent.
   */
  promptCacheStableInstructions?: string;
  /**
   * What each tool definition this conversation discovered looked like before
   * discovery reshaped it: `appended` for one the configured request did not
   * carry at all, otherwise the `defer_loading` value discovery overwrote. The
   * definitions reach the model either way; the identity names the configured
   * agent. Consumed by `createRun` and never sent.
   */
  promptCacheConfiguredToolState?: PromptCacheConfiguredToolState;
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
