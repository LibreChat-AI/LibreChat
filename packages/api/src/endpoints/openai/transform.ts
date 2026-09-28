import { EModelEndpoint } from 'librechat-data-provider';
import type { GoogleAIToolType } from '@librechat/agents/langchain/google-common';
import type { ClientOptions } from '@librechat/agents';
import type * as t from '~/types';
import { knownOpenAIParams } from './llm';

const anthropicExcludeParams = new Set(['anthropicApiUrl', 'outputConfig']);
const googleExcludeParams = new Set([
  'safetySettings',
  'location',
  'baseUrl',
  'customHeaders',
  'thinkingConfig',
  'thinkingBudget',
  'includeThoughts',
]);

/** Google-specific tool types that have no OpenAI-compatible equivalent */
const googleToolsToFilter = new Set(['googleSearch', 'urlContext']);

export type ConfigTools = Array<Record<string, unknown>> | Array<GoogleAIToolType>;

/**
 * Transforms a Non-OpenAI LLM config to an OpenAI-conformant config.
 * Non-OpenAI parameters are moved to modelKwargs.
 * Also extracts configuration options that belong in configOptions.
 * Handles addParams and dropParams for parameter customization.
 * Filters out provider-specific tools that have no OpenAI equivalent.
 */
export function transformToOpenAIConfig({
  tools,
  addParams,
  dropParams,
  defaultParams,
  llmConfig,
  fromEndpoint,
}: {
  tools?: ConfigTools;
  addParams?: Record<string, unknown>;
  dropParams?: string[];
  defaultParams?: Record<string, unknown>;
  llmConfig: ClientOptions;
  fromEndpoint: string;
}): {
  tools: ConfigTools;
  llmConfig: t.OAIClientOptions;
  configOptions: Partial<t.OpenAIConfiguration>;
} {
  const openAIConfig: Partial<t.OAIClientOptions> = {};
  let configOptions: Partial<t.OpenAIConfiguration> = {};
  let modelKwargs: Record<string, unknown> = {};
  let hasModelKwargs = false;

  const isAnthropic = fromEndpoint === EModelEndpoint.anthropic;
  const isGoogle = fromEndpoint === EModelEndpoint.google;

  let excludeParams = new Set<string>();
  if (isAnthropic) {
    excludeParams = anthropicExcludeParams;
  } else if (isGoogle) {
    excludeParams = googleExcludeParams;
  }

  for (const [key, value] of Object.entries(llmConfig)) {
    if (value === undefined || value === null) {
      continue;
    }

    if (excludeParams.has(key)) {
      continue;
    }

    if (isAnthropic && key === 'clientOptions') {
      configOptions = Object.assign({}, configOptions, value as Partial<t.OpenAIConfiguration>);
      continue;
    } else if (isAnthropic && key === 'invocationKwargs') {
      modelKwargs = Object.assign({}, modelKwargs, value as Record<string, unknown>);
      hasModelKwargs = true;
      continue;
    } else if (isGoogle && key === 'authOptions') {
      modelKwargs = Object.assign({}, modelKwargs, value as Record<string, unknown>);
      hasModelKwargs = true;
      continue;
    }

    if (knownOpenAIParams.has(key)) {
      (openAIConfig as Record<string, unknown>)[key] = value;
    } else {
      modelKwargs[key] = value;
      hasModelKwargs = true;
    }
  }

  if (addParams && typeof addParams === 'object') {
    for (const [key, value] of Object.entries(addParams)) {
      /** Skip web_search / url_context - handled separately as native tools */
      if (key === 'web_search' || key === 'url_context') {
        continue;
      }

      if (knownOpenAIParams.has(key)) {
        (openAIConfig as Record<string, unknown>)[key] = value;
      } else {
        modelKwargs[key] = value;
        hasModelKwargs = true;
      }
    }
  }

  if (hasModelKwargs) {
    openAIConfig.modelKwargs = modelKwargs;
  }

  if (dropParams && Array.isArray(dropParams)) {
    dropParams.forEach((param) => {
      /** Skip web_search / url_context - handled separately */
      if (param === 'web_search' || param === 'url_context') {
        return;
      }

      if (param in openAIConfig) {
        delete openAIConfig[param as keyof t.OAIClientOptions];
      }
      if (openAIConfig.modelKwargs && param in openAIConfig.modelKwargs) {
        delete openAIConfig.modelKwargs[param];
      }
    });

    /** Clean up empty modelKwargs after dropParams processing */
    if (openAIConfig.modelKwargs && Object.keys(openAIConfig.modelKwargs).length === 0) {
      delete openAIConfig.modelKwargs;
    }
  }

  /**
   * Filter out provider-specific tools that have no OpenAI equivalent.
   * Exception: If web_search / url_context was explicitly enabled via addParams
   * or defaultParams, preserve the matching Google-native tool (pass through in
   * Google-native format).
   */
  const webSearchExplicitlyEnabled =
    addParams?.web_search === true || defaultParams?.web_search === true;
  const urlContextExplicitlyEnabled =
    addParams?.url_context === true || defaultParams?.url_context === true;

  const filterGoogleTool = (tool: unknown): boolean => {
    if (!isGoogle) {
      return true;
    }
    if (typeof tool !== 'object' || tool === null) {
      return false;
    }
    const toolKeys = Object.keys(tool as Record<string, unknown>);
    /** Preserve googleSearch if web_search was explicitly enabled */
    if (webSearchExplicitlyEnabled && toolKeys.includes('googleSearch')) {
      return true;
    }
    /** Preserve urlContext if url_context was explicitly enabled */
    if (urlContextExplicitlyEnabled && toolKeys.includes('urlContext')) {
      return true;
    }
    const isGoogleSpecificTool = toolKeys.some((key) => googleToolsToFilter.has(key));
    return !isGoogleSpecificTool;
  };

  const filteredTools = Array.isArray(tools) ? tools.filter(filterGoogleTool) : [];

  return {
    tools: filteredTools,
    llmConfig: openAIConfig as t.OAIClientOptions,
    configOptions,
  };
}
