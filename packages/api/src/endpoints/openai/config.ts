import { Providers } from '@librechat/agents';
import { Agent, fetch as undiciFetch } from 'undici';
import { KnownEndpoints, EModelEndpoint, ReasoningParameterFormat } from 'librechat-data-provider';
import type { Dispatcher } from 'undici';
import type * as t from '~/types';
import { getGoogleConfig, stripGeminiFlashBlockedParams } from '~/endpoints/google/llm';
import { getLLMConfig as getAnthropicLLMConfig } from '~/endpoints/anthropic/llm';
import { createSSRFSafeAgents, createSSRFSafeUndiciConnect } from '~/auth';
import { getDirectDispatcher, getProxyDispatcher } from '~/utils/proxy';
import { getOpenAILLMConfig, extractDefaultParams } from './llm';
import { constructAzureResponsesURL } from '~/utils/azure';
import { transformToOpenAIConfig } from './transform';
import { createFetch } from '~/utils/generators';
import { mergeHeaders } from '~/utils/headers';

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type FetchOptions = RequestInit & { dispatcher?: Dispatcher };
type OpenAIConfiguration = NonNullable<t.OpenAIConfiguration>;

const OPENROUTER_DEFAULT_PARAMS = { promptCache: true };

function includesOpenRouter(value?: string | null): boolean {
  return typeof value === 'string' && value.toLowerCase().includes(KnownEndpoints.openrouter);
}

function getDefaultParams({
  customDefaultParams,
  useOpenRouter,
}: {
  customDefaultParams?: Record<string, unknown>;
  useOpenRouter: boolean;
}): Record<string, unknown> | undefined {
  if (!useOpenRouter) {
    return customDefaultParams;
  }

  return {
    ...OPENROUTER_DEFAULT_PARAMS,
    ...customDefaultParams,
  };
}

function getReasoningFormat({
  customFormat,
  isVercel,
}: {
  customFormat?: ReasoningParameterFormat;
  isVercel: boolean;
}): ReasoningParameterFormat | undefined {
  if (customFormat) {
    return customFormat;
  }
  if (isVercel) {
    return ReasoningParameterFormat.reasoningObject;
  }
  return undefined;
}

function getEffectiveURLPort(baseURL: string): string | null {
  try {
    const parsed = new URL(baseURL);
    if (parsed.port) {
      return parsed.port;
    }
    if (parsed.protocol === 'http:') {
      return '80';
    }
    if (parsed.protocol === 'https:') {
      return '443';
    }
  } catch {
    return null;
  }

  return null;
}

function mergeFetchOptions(configOptions: OpenAIConfiguration, options: FetchOptions): void {
  const currentOptions = (configOptions.fetchOptions ?? {}) as FetchOptions;
  configOptions.fetchOptions = {
    ...currentOptions,
    ...options,
  } as OpenAIConfiguration['fetchOptions'];
}

/**
 * Generates configuration options for creating a language model (LLM) instance.
 * @param apiKey - The API key for authentication.
 * @param options - Additional options for configuring the LLM.
 * @param endpoint - The endpoint name
 * @returns Configuration options for creating an LLM instance.
 */
export function getOpenAIConfig(
  apiKey: string,
  options: t.OpenAIConfigOptions = {},
  endpoint?: string | null,
): t.OpenAIConfigResult {
  const {
    proxy,
    addParams,
    dropParams,
    defaultQuery,
    directEndpoint,
    streaming = true,
    modelOptions = {},
    reverseProxyUrl: baseURL,
  } = options;
  const shouldProtectUserBaseURL = options.baseURLIsUserProvided === true && !!baseURL;
  const ssrfAgents = shouldProtectUserBaseURL
    ? createSSRFSafeAgents(options.allowedAddresses)
    : undefined;

  let llmConfig: t.OAIClientOptions;
  let tools: t.LLMConfigResult['tools'];
  const isAnthropic = options.customParams?.defaultParamsEndpoint === EModelEndpoint.anthropic;
  const isGoogle = options.customParams?.defaultParamsEndpoint === EModelEndpoint.google;
  const isOpenRouter = options.customParams?.defaultParamsEndpoint === KnownEndpoints.openrouter;

  const useOpenRouter =
    !isAnthropic &&
    !isGoogle &&
    (isOpenRouter || includesOpenRouter(baseURL) || includesOpenRouter(endpoint));
  const isVercel =
    !isAnthropic &&
    !isGoogle &&
    ((baseURL && baseURL.includes('ai-gateway.vercel.sh')) ||
      (endpoint != null && endpoint.toLowerCase().includes(KnownEndpoints.vercel)));
  const defaultParams = getDefaultParams({
    customDefaultParams: extractDefaultParams(options.customParams?.paramDefinitions),
    useOpenRouter: Boolean(useOpenRouter),
  });

  let azure = options.azure;
  let headers = options.headers;
  if (isAnthropic) {
    const anthropicResult = getAnthropicLLMConfig(apiKey, {
      modelOptions,
      proxy: options.proxy,
      reverseProxyUrl: baseURL,
      addParams,
      dropParams,
      defaultParams,
    });
    /** Transform handles addParams/dropParams - it knows about OpenAI params */
    const transformed = transformToOpenAIConfig({
      addParams,
      dropParams,
      llmConfig: anthropicResult.llmConfig,
      fromEndpoint: EModelEndpoint.anthropic,
    });
    llmConfig = transformed.llmConfig;
    tools = anthropicResult.tools;
    if (transformed.configOptions?.defaultHeaders) {
      headers = mergeHeaders(
        headers,
        transformed.configOptions.defaultHeaders as Record<string, string>,
      );
    }
  } else if (isGoogle) {
    const googleResult = getGoogleConfig(
      apiKey,
      {
        modelOptions,
        reverseProxyUrl: baseURL ?? undefined,
        authHeader: true,
        addParams,
        dropParams,
        defaultParams,
      },
      true,
    );
    /**
     * Transform handles addParams/dropParams - it knows about OpenAI params.
     * `getGoogleConfig` already stripped Flash-blocked params from `llmConfig`,
     * but the transform re-applies `addParams` raw, which would undo that; strip
     * them from the forwarded `addParams` too so the model does not receive
     * params it rejects. `defaultParams` is applied inside `getGoogleConfig`
     * (and only read here for tool detection), so it needs no sanitizing.
     */
    const transformed = transformToOpenAIConfig({
      addParams: stripGeminiFlashBlockedParams(
        addParams,
        (googleResult.llmConfig as { model?: string }).model,
      ),
      dropParams,
      defaultParams,
      tools: googleResult.tools,
      llmConfig: googleResult.llmConfig,
      fromEndpoint: EModelEndpoint.google,
    });
    llmConfig = transformed.llmConfig;
    tools = transformed.tools;
  } else {
    const openaiResult = getOpenAILLMConfig({
      azure,
      apiKey,
      baseURL,
      endpoint,
      streaming,
      addParams,
      dropParams,
      defaultParams,
      modelOptions,
      useOpenRouter,
      reasoningFormat: getReasoningFormat({
        customFormat: options.customParams?.reasoningFormat,
        isVercel: Boolean(isVercel),
      }),
    });
    llmConfig = openaiResult.llmConfig;
    azure = openaiResult.azure;
    tools = openaiResult.tools;
  }

  /**
   * Within-run `reasoning_content` replay applies across every param-format
   * branch above (OpenAI / Anthropic / Google gateway modes all resolve to the
   * OpenAI client). `includeReasoningHistory` implies it, since reconstructed
   * history reasoning is only sent when the within-run flag is set.
   */
  if (
    options.customParams?.includeReasoningContent === true ||
    options.customParams?.includeReasoningHistory === true
  ) {
    llmConfig.includeReasoningContent = true;
  }

  const configOptions: t.OpenAIConfiguration = {};
  if (baseURL) {
    configOptions.baseURL = baseURL;
  }
  if (useOpenRouter || isVercel) {
    configOptions.defaultHeaders = Object.assign(
      {
        'HTTP-Referer': 'https://librechat.ai',
        'X-Title': 'LibreChat',
        'X-OpenRouter-Title': 'LibreChat',
        'X-OpenRouter-Categories': 'general-chat,personal-agent,programming-app',
      },
      headers,
    );
  } else if (headers) {
    configOptions.defaultHeaders = headers;
  }

  if (defaultQuery) {
    configOptions.defaultQuery = defaultQuery;
  }

  const transportTimeouts = options.transportTimeouts;
  if (shouldProtectUserBaseURL) {
    mergeFetchOptions(configOptions, {
      dispatcher: new Agent({
        ...transportTimeouts,
        connect: createSSRFSafeUndiciConnect(
          options.allowedAddresses,
          getEffectiveURLPort(baseURL),
        ),
      }),
      redirect: 'error',
    });
  } else if (transportTimeouts != null) {
    const proxyDispatcher = getProxyDispatcher(proxy, transportTimeouts);
    mergeFetchOptions(configOptions, {
      dispatcher: proxyDispatcher ?? getDirectDispatcher(transportTimeouts),
    });
  } else {
    const proxyDispatcher = getProxyDispatcher(proxy);
    if (proxyDispatcher) {
      mergeFetchOptions(configOptions, { dispatcher: proxyDispatcher });
    }
  }

  if (azure && !isAnthropic) {
    const constructAzureResponsesApi = () => {
      if (!llmConfig.useResponsesApi || !azure) {
        return;
      }

      const responsesURL = constructAzureResponsesURL(configOptions.baseURL, azure);
      const urlQuery = Object.fromEntries(responsesURL.searchParams);
      responsesURL.search = '';
      responsesURL.hash = '';
      configOptions.baseURL = responsesURL.toString();

      configOptions.defaultHeaders = {
        ...configOptions.defaultHeaders,
        'api-key': apiKey,
      };
      configOptions.defaultQuery = {
        ...urlQuery,
        ...configOptions.defaultQuery,
        'api-version':
          configOptions.defaultQuery?.['api-version'] ?? urlQuery['api-version'] ?? 'preview',
      };
    };

    constructAzureResponsesApi();
  }

  if (process.env.OPENAI_ORGANIZATION && !isAnthropic) {
    configOptions.organization = process.env.OPENAI_ORGANIZATION;
  }

  if (directEndpoint === true && configOptions?.baseURL != null) {
    const directURL = configOptions.baseURL;
    if (transportTimeouts != null) {
      /** Keep the exact URL, but use the same proxy/SSRF/timeout policy as SDK requests. */
      configOptions.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
        undiciFetch(directURL, {
          ...(init as Parameters<typeof undiciFetch>[1]),
          // These options are constructed above with an Undici dispatcher, not another SDK runtime.
          ...(configOptions.fetchOptions as Parameters<typeof undiciFetch>[1]),
        })) as unknown as Fetch;
    } else {
      configOptions.fetch = createFetch({
        directEndpoint,
        reverseProxyUrl: directURL,
        ssrfAgents,
        redirect: shouldProtectUserBaseURL ? 'error' : undefined,
      }) as unknown as Fetch;
    }
  }

  const result: t.OpenAIConfigResult = {
    llmConfig,
    configOptions,
    tools,
  };
  if (useOpenRouter) {
    result.provider = Providers.OPENROUTER;
  }
  return result;
}
