import {
  Verbosity,
  EModelEndpoint,
  ReasoningEffort,
  ReasoningSummary,
  ReasoningResponseKey,
  ReasoningParameterFormat,
} from 'librechat-data-provider';
import type { RequestInit } from 'undici';
import type { OpenAIParameters, AzureOptions } from '~/types';
import { getOpenAIConfig } from './config';
import { knownOpenAIParams } from './llm';

describe('getOpenAIConfig', () => {
  const mockApiKey = 'test-api-key';

  it('should create basic config with default values', () => {
    const result = getOpenAIConfig(mockApiKey);

    expect(result.llmConfig).toMatchObject({
      streaming: true,
      model: '',
      apiKey: mockApiKey,
    });
    expect(result.configOptions).toEqual({});
    expect(result.tools).toEqual([]);
  });

  it('applies an explicit model transport timeout policy', () => {
    const result = getOpenAIConfig(mockApiKey, {
      transportTimeouts: { bodyTimeout: 900_000, headersTimeout: 300_000 },
    });

    expect(result.configOptions?.fetchOptions?.dispatcher).toBeDefined();
  });

  it('should apply model options', () => {
    const modelOptions = {
      model: 'gpt-4',
      temperature: 0.7,
      max_tokens: 1000,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig).toMatchObject({
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 1000,
    });
    expect((result.llmConfig as Record<string, unknown>).max_tokens).toBeUndefined();
  });

  it('should separate known and unknown params from addParams', () => {
    const addParams = {
      temperature: 0.5, // known param
      topP: 0.9, // known param
      customParam1: 'value1', // unknown param
      customParam2: { nested: true }, // unknown param
      maxTokens: 500, // known param
    };

    const result = getOpenAIConfig(mockApiKey, { addParams });

    expect(result.llmConfig.temperature).toBe(0.5);
    expect(result.llmConfig.topP).toBe(0.9);
    expect(result.llmConfig.maxTokens).toBe(500);
    expect(result.llmConfig.modelKwargs).toEqual({
      customParam1: 'value1',
      customParam2: { nested: true },
    });
  });

  it('should not add modelKwargs if all params are known', () => {
    const addParams = {
      temperature: 0.5,
      topP: 0.9,
      maxTokens: 500,
    };

    const result = getOpenAIConfig(mockApiKey, { addParams });

    expect(result.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should handle empty addParams', () => {
    const result = getOpenAIConfig(mockApiKey, { addParams: {} });

    expect(result.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should pass custom endpoint reasoning object through modelKwargs for `useResponsesApi`', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
    };

    const result = getOpenAIConfig(mockApiKey, {
      modelOptions: { ...modelOptions, useResponsesApi: true },
    });

    expect(result.llmConfig.reasoning).toBeUndefined();
    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning: {
        effort: ReasoningEffort.high,
        summary: ReasoningSummary.detailed,
      },
    });
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).reasoning_summary).toBeUndefined();
  });

  it('should pass custom endpoint reasoning through modelKwargs without `useResponsesApi`', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, 'custom-endpoint');

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning_effort: ReasoningEffort.high,
    });
    expect(result.llmConfig.reasoning).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should use reasoning_effort for openAI endpoint without useResponsesApi', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, EModelEndpoint.openAI);

    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBe(
      ReasoningEffort.high,
    );
    expect(result.llmConfig.reasoning).toBeUndefined();
  });

  it('should use reasoning_effort for azureOpenAI endpoint without useResponsesApi', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, EModelEndpoint.azureOpenAI);

    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBe(
      ReasoningEffort.high,
    );
    expect(result.llmConfig.reasoning).toBeUndefined();
  });

  it('should use reasoning object for openAI endpoint with useResponsesApi=true', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
      useResponsesApi: true,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, EModelEndpoint.openAI);

    expect(result.llmConfig.reasoning).toEqual({
      effort: ReasoningEffort.high,
      summary: ReasoningSummary.detailed,
    });
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should use reasoning object for azureOpenAI endpoint with useResponsesApi=true', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
      useResponsesApi: true,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, EModelEndpoint.azureOpenAI);

    expect(result.llmConfig.reasoning).toEqual({
      effort: ReasoningEffort.high,
      summary: ReasoningSummary.detailed,
    });
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should pass reasoning_effort through modelKwargs for non-openAI/azureOpenAI endpoints', () => {
    const modelOptions = {
      reasoning_effort: ReasoningEffort.high,
      reasoning_summary: ReasoningSummary.detailed,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions }, 'custom-endpoint');

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning_effort: ReasoningEffort.high,
    });
    expect(result.llmConfig.reasoning).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should support custom endpoint reasoning object format', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        customParams: {
          reasoningFormat: ReasoningParameterFormat.reasoningObject,
        },
        modelOptions: {
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.detailed,
        },
      },
      'custom-endpoint',
    );

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning: {
        effort: ReasoningEffort.high,
        summary: ReasoningSummary.detailed,
      },
    });
    expect(result.llmConfig.reasoning).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should replay reasoning content when custom endpoint enables includeReasoningContent', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        customParams: {
          reasoningKey: ReasoningResponseKey.reasoningContent,
          includeReasoningContent: true,
        },
        modelOptions: {
          model: 'MiMo-VL-7B-RL',
        },
      },
      'custom-endpoint',
    );

    expect(result.llmConfig).toHaveProperty('includeReasoningContent', true);
  });

  it('should enable within-run replay when custom endpoint enables includeReasoningHistory', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        customParams: {
          reasoningKey: ReasoningResponseKey.reasoningContent,
          includeReasoningHistory: true,
        },
        modelOptions: {
          model: 'MiMo-VL-7B-RL',
        },
      },
      'custom-endpoint',
    );

    expect(result.llmConfig).toHaveProperty('includeReasoningContent', true);
  });

  it('should enable within-run replay for non-OpenAI param-format gateways (anthropic/google)', () => {
    const anthropic = getOpenAIConfig(
      mockApiKey,
      {
        customParams: {
          defaultParamsEndpoint: EModelEndpoint.anthropic,
          includeReasoningContent: true,
        },
        modelOptions: { model: 'claude-3-7-sonnet' },
      },
      'custom-endpoint',
    );
    expect(anthropic.llmConfig).toHaveProperty('includeReasoningContent', true);

    const google = getOpenAIConfig(
      mockApiKey,
      {
        customParams: {
          defaultParamsEndpoint: EModelEndpoint.google,
          includeReasoningHistory: true,
        },
        modelOptions: { model: 'gemini-2.5-pro' },
      },
      'custom-endpoint',
    );
    expect(google.llmConfig).toHaveProperty('includeReasoningContent', true);
  });

  it('should not replay reasoning content for custom endpoints by default', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        modelOptions: {
          model: 'MiMo-VL-7B-RL',
        },
      },
      'custom-endpoint',
    );

    expect(result.llmConfig).not.toHaveProperty('includeReasoningContent');
  });

  it('should default Vercel custom endpoints to reasoning object format', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        reverseProxyUrl: 'https://ai-gateway.vercel.sh/v1',
        modelOptions: {
          reasoning_effort: ReasoningEffort.high,
        },
      },
      'Vercel',
    );

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning: {
        effort: ReasoningEffort.high,
      },
    });
    expect(result.llmConfig.reasoning).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should apply Vercel reasoning format to custom default params', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        reverseProxyUrl: 'https://ai-gateway.vercel.sh/v1',
        customParams: {
          paramDefinitions: [{ key: 'reasoning_effort', default: ReasoningEffort.low }],
        },
        modelOptions: {
          model: 'openai/gpt-5-mini',
        },
      },
      'Vercel',
    );

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning: {
        effort: ReasoningEffort.low,
      },
    });
    expect((result.llmConfig as Record<string, unknown>).reasoning_effort).toBeUndefined();
  });

  it('should allow Vercel reasoning format override', () => {
    const result = getOpenAIConfig(
      mockApiKey,
      {
        reverseProxyUrl: 'https://ai-gateway.vercel.sh/v1',
        customParams: {
          reasoningFormat: ReasoningParameterFormat.reasoningEffort,
        },
        modelOptions: {
          reasoning_effort: ReasoningEffort.high,
        },
      },
      'Vercel',
    );

    expect(result.llmConfig.modelKwargs).toEqual({
      reasoning_effort: ReasoningEffort.high,
    });
  });

  it('should handle OpenRouter configuration', () => {
    const reverseProxyUrl = 'https://openrouter.ai/api/v1';

    const result = getOpenAIConfig(mockApiKey, { reverseProxyUrl });

    expect(result.configOptions?.baseURL).toBe(reverseProxyUrl);
    expect(result.configOptions?.defaultHeaders).toMatchObject({
      'HTTP-Referer': 'https://librechat.ai',
      'X-Title': 'LibreChat',
      'X-OpenRouter-Title': 'LibreChat',
      'X-OpenRouter-Categories': 'general-chat,personal-agent,programming-app',
    });
    expect(result.llmConfig.include_reasoning).toBe(true);
    expect(result.llmConfig.promptCache).toBe(true);
    expect(result.provider).toBe('openrouter');
  });

  it('should handle Azure configuration', () => {
    const azure = {
      azureOpenAIApiInstanceName: 'test-instance',
      azureOpenAIApiDeploymentName: 'test-deployment',
      azureOpenAIApiVersion: '2023-05-15',
      azureOpenAIApiKey: 'azure-key',
    };

    const result = getOpenAIConfig(mockApiKey, { azure });

    expect(result.llmConfig).toMatchObject({
      ...azure,
      model: 'test-deployment',
    });
  });

  it('should handle web search model option', () => {
    const modelOptions = {
      model: 'gpt-5',
      web_search: true,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig.useResponsesApi).toBe(true);
    expect(result.tools).toEqual([{ type: 'web_search' }]);
  });

  it('should handle web_search from addParams overriding modelOptions', () => {
    const modelOptions = {
      model: 'gpt-5',
      web_search: false,
    };

    const addParams = {
      web_search: true,
      customParam: 'value',
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    expect(result.llmConfig.useResponsesApi).toBe(true);
    expect(result.tools).toEqual([{ type: 'web_search' }]);
    // web_search should not be in modelKwargs or llmConfig
    expect((result.llmConfig as Record<string, unknown>).web_search).toBeUndefined();
    expect(result.llmConfig.modelKwargs).toEqual({ customParam: 'value' });
  });

  it('should disable web_search when included in dropParams', () => {
    const modelOptions = {
      model: 'gpt-5',
      web_search: true,
    };

    const result = getOpenAIConfig(mockApiKey, {
      modelOptions,
      dropParams: ['web_search'],
    });

    expect(result.llmConfig.useResponsesApi).toBeUndefined();
    expect(result.tools).toEqual([]);
  });

  it('should handle web_search false from addParams', () => {
    const modelOptions = {
      model: 'gpt-5',
      web_search: true,
    };

    const addParams = {
      web_search: false,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    expect(result.llmConfig.useResponsesApi).toBeUndefined();
    expect(result.tools).toEqual([]);
  });

  it('should ignore non-boolean web_search values in addParams', () => {
    const modelOptions = {
      model: 'gpt-4',
      web_search: true,
    };

    const addParams = {
      web_search: 'string-value' as unknown,
      temperature: 0.7,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    // Should keep the original web_search from modelOptions since addParams value is not boolean
    expect(result.llmConfig.useResponsesApi).toBe(true);
    expect(result.tools).toEqual([{ type: 'web_search' }]);
    expect(result.llmConfig.temperature).toBe(0.7);
    // web_search should not be added to modelKwargs
    expect(result.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should handle web_search with both addParams and dropParams', () => {
    const modelOptions = {
      model: 'gpt-5',
    };

    const addParams = {
      web_search: true,
    };

    const result = getOpenAIConfig(mockApiKey, {
      modelOptions,
      addParams,
      dropParams: ['web_search'], // dropParams takes precedence
    });

    expect(result.llmConfig.useResponsesApi).toBeUndefined();
    expect(result.tools).toEqual([]);
  });

  it('should not add web_search to modelKwargs or llmConfig', () => {
    const addParams = {
      web_search: true,
      customParam1: 'value1',
      temperature: 0.5,
    };

    const result = getOpenAIConfig(mockApiKey, { addParams });

    // web_search should trigger the tool but not appear in config
    expect(result.llmConfig.useResponsesApi).toBe(true);
    expect(result.tools).toEqual([{ type: 'web_search' }]);
    expect((result.llmConfig as Record<string, unknown>).web_search).toBeUndefined();
    expect(result.llmConfig.temperature).toBe(0.5);
    expect(result.llmConfig.modelKwargs).toEqual({ customParam1: 'value1' });
  });

  it('should drop params for search models', () => {
    const modelOptions = {
      model: 'gpt-4o-search',
      temperature: 0.7,
      frequency_penalty: 0.5,
      max_tokens: 1000,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig.temperature).toBeUndefined();
    expect((result.llmConfig as Record<string, unknown>).frequency_penalty).toBeUndefined();
    expect(result.llmConfig.maxTokens).toBe(1000); // max_tokens is allowed
  });

  it('should handle custom dropParams', () => {
    const modelOptions = {
      temperature: 0.7,
      topP: 0.9,
      customParam: 'value',
    };

    const result = getOpenAIConfig(mockApiKey, {
      modelOptions,
      dropParams: ['temperature', 'customParam'],
    });

    expect(result.llmConfig.temperature).toBeUndefined();
    expect(result.llmConfig.topP).toBe(0.9);
    expect((result.llmConfig as Record<string, unknown>).customParam).toBeUndefined();
  });

  it('should handle proxy configuration', () => {
    const proxy = 'http://proxy.example.com:8080';

    const result = getOpenAIConfig(mockApiKey, { proxy });

    expect(result.configOptions?.fetchOptions).toBeDefined();
    expect((result.configOptions?.fetchOptions as RequestInit).dispatcher).toBeDefined();
  });

  it('should harden user-provided base URLs with a connect-time dispatcher and disabled redirects', () => {
    const result = getOpenAIConfig(mockApiKey, {
      reverseProxyUrl: 'https://user-provider.example.com/v1',
      baseURLIsUserProvided: true,
      allowedAddresses: ['10.0.0.5:443'],
    });

    expect(result.configOptions?.baseURL).toBe('https://user-provider.example.com/v1');
    expect(result.configOptions?.fetchOptions).toEqual(
      expect.objectContaining({
        dispatcher: expect.any(Object),
        redirect: 'error',
      }),
    );
  });

  it('should keep the SSRF-safe dispatcher when a proxy is configured for a user-provided URL', () => {
    const result = getOpenAIConfig(mockApiKey, {
      reverseProxyUrl: 'https://user-provider.example.com/v1',
      baseURLIsUserProvided: true,
      proxy: 'http://proxy.example.com:8080',
    });

    const unproxiedResult = getOpenAIConfig(mockApiKey, {
      reverseProxyUrl: 'https://user-provider.example.com/v1',
      baseURLIsUserProvided: true,
    });

    expect(result.configOptions?.fetchOptions?.dispatcher).toBeDefined();
    expect(result.configOptions?.fetchOptions?.dispatcher?.constructor.name).toBe(
      unproxiedResult.configOptions?.fetchOptions?.dispatcher?.constructor.name,
    );
    expect(result.configOptions?.fetchOptions).toEqual(
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('should handle headers and defaultQuery', () => {
    const headers = { 'X-Custom-Header': 'value' };
    const defaultQuery = { customParam: 'value' };

    const result = getOpenAIConfig(mockApiKey, {
      reverseProxyUrl: 'https://api.example.com',
      headers,
      defaultQuery,
    });

    expect(result.configOptions?.baseURL).toBe('https://api.example.com');
    expect(result.configOptions?.defaultHeaders).toEqual(headers);
    expect(result.configOptions?.defaultQuery).toEqual(defaultQuery);
  });

  it('should handle verbosity parameter in modelKwargs', () => {
    const modelOptions = {
      model: 'gpt-4',
      temperature: 0.7,
      verbosity: Verbosity.high,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig).toMatchObject({
      model: 'gpt-4',
      temperature: 0.7,
    });
    expect(result.llmConfig.modelKwargs).toEqual({
      verbosity: Verbosity.high,
    });
  });

  it('should allow addParams to override verbosity in modelKwargs', () => {
    const modelOptions = {
      model: 'gpt-4',
      verbosity: Verbosity.low,
    };

    const addParams = {
      temperature: 0.8,
      verbosity: Verbosity.high, // This should override the one from modelOptions
      customParam: 'value',
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    expect(result.llmConfig.temperature).toBe(0.8);
    expect(result.llmConfig.modelKwargs).toEqual({
      verbosity: Verbosity.high, // Should be overridden by addParams
      customParam: 'value',
    });
  });

  it('should not create modelKwargs if verbosity is empty or null', () => {
    const testCases = [
      { verbosity: null },
      { verbosity: Verbosity.none },
      { verbosity: undefined },
    ];

    testCases.forEach((modelOptions) => {
      const result = getOpenAIConfig(mockApiKey, { modelOptions });
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });
  });

  it('should nest verbosity under text when useResponsesApi is enabled', () => {
    const modelOptions = {
      model: 'gpt-4',
      temperature: 0.7,
      verbosity: Verbosity.low,
      useResponsesApi: true,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig).toMatchObject({
      model: 'gpt-4',
      temperature: 0.7,
      useResponsesApi: true,
    });
    expect(result.llmConfig.modelKwargs).toEqual({
      text: {
        verbosity: Verbosity.low,
      },
    });
  });

  it('should handle verbosity correctly when addParams overrides with useResponsesApi', () => {
    const modelOptions = {
      model: 'gpt-5',
      verbosity: Verbosity.low,
      useResponsesApi: true,
    };

    const addParams = {
      verbosity: Verbosity.high,
      customParam: 'value',
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    expect(result.llmConfig.modelKwargs).toEqual({
      text: {
        verbosity: Verbosity.high, // Should be overridden by addParams
      },
      customParam: 'value',
    });
  });

  it('should move maxTokens to modelKwargs.max_completion_tokens for GPT-5+ models', () => {
    const modelOptions = {
      model: 'gpt-5',
      max_tokens: 2048,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig).toMatchObject({
      model: 'gpt-5',
    });
    expect(result.llmConfig.maxTokens).toBeUndefined();
    expect(result.llmConfig.modelKwargs).toEqual({
      max_completion_tokens: 2048,
    });
  });

  it('should handle GPT-5+ models with existing modelKwargs', () => {
    const modelOptions = {
      model: 'gpt-6',
      max_tokens: 1000,
      verbosity: Verbosity.low,
    };

    const addParams = {
      customParam: 'value',
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions, addParams });

    expect(result.llmConfig.maxTokens).toBeUndefined();
    expect(result.llmConfig.modelKwargs).toEqual({
      verbosity: Verbosity.low,
      customParam: 'value',
      max_completion_tokens: 1000,
    });
  });

  it('should not move maxTokens for non-GPT-5+ models', () => {
    const modelOptions = {
      model: 'gpt-4',
      temperature: 0.7,
      max_tokens: 2048,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig).toMatchObject({
      model: 'gpt-4',
      temperature: 0.7,
      maxTokens: 2048,
    });
    expect(result.llmConfig.modelKwargs).toBeUndefined();
  });

  it('should handle GPT-5+ models with verbosity and useResponsesApi', () => {
    const modelOptions = {
      model: 'gpt-5',
      max_tokens: 1500,
      verbosity: Verbosity.medium,
      useResponsesApi: true,
    };

    const result = getOpenAIConfig(mockApiKey, { modelOptions });

    expect(result.llmConfig.maxTokens).toBeUndefined();
    expect(result.llmConfig.modelKwargs).toEqual({
      text: {
        verbosity: Verbosity.medium,
      },
      max_output_tokens: 1500,
    });
  });

  it('should handle complex addParams with mixed known and unknown params', () => {
    const addParams = {
      // Known params
      model: 'gpt-4-turbo',
      temperature: 0.8,
      topP: 0.95,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      maxTokens: 2048,
      stop: ['\\n\\n', 'END'],
      stream: false,
      // Unknown params
      custom_instruction: 'Be concise',
      response_style: 'formal',
      domain_specific: {
        medical: true,
        terminology: 'advanced',
      },
    };

    const result = getOpenAIConfig(mockApiKey, { addParams });

    // Check known params are in llmConfig
    expect(result.llmConfig).toMatchObject({
      model: 'gpt-4-turbo',
      temperature: 0.8,
      topP: 0.95,
      frequencyPenalty: 0.2,
      presencePenalty: 0.1,
      maxTokens: 2048,
      stop: ['\\n\\n', 'END'],
      stream: false,
    });

    // Check unknown params are in modelKwargs
    expect(result.llmConfig.modelKwargs).toEqual({
      custom_instruction: 'Be concise',
      response_style: 'formal',
      domain_specific: {
        medical: true,
        terminology: 'advanced',
      },
    });
  });

  describe('Azure Configuration', () => {
    it('should handle Azure configuration with model name as deployment', () => {
      const originalEnv = process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME;
      process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME = 'true';

      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'original-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const modelOptions = { model: 'gpt-4.0-turbo' };
      const result = getOpenAIConfig(mockApiKey, { azure, modelOptions });

      // Should sanitize model name by removing dots
      expect(result.llmConfig.model).toBe('gpt-40-turbo');
      expect((result.llmConfig as Record<string, unknown>).azureOpenAIApiDeploymentName).toBe(
        'gpt-40-turbo',
      );

      // Cleanup
      if (originalEnv !== undefined) {
        process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME = originalEnv;
      } else {
        delete process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME;
      }
    });

    it('should use default Azure deployment name when not using model name', () => {
      const originalEnv = process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME;
      delete process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME;

      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'custom-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, { azure });

      expect((result.llmConfig as Record<string, unknown>).azureOpenAIApiDeploymentName).toBe(
        'custom-deployment',
      );
      expect(result.llmConfig.model).toBe('custom-deployment');

      // Cleanup
      if (originalEnv !== undefined) {
        process.env.AZURE_USE_MODEL_AS_DEPLOYMENT_NAME = originalEnv;
      }
    });

    it('should handle Azure default model from environment', () => {
      const originalEnv = process.env.AZURE_OPENAI_DEFAULT_MODEL;
      process.env.AZURE_OPENAI_DEFAULT_MODEL = 'gpt-4-env-default';

      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, { azure });

      expect(result.llmConfig.model).toBe('deployment'); // deployment name takes precedence

      // Cleanup
      if (originalEnv !== undefined) {
        process.env.AZURE_OPENAI_DEFAULT_MODEL = originalEnv;
      } else {
        delete process.env.AZURE_OPENAI_DEFAULT_MODEL;
      }
    });

    it('should construct Azure base URL correctly', () => {
      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'test-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, {
        azure,
        reverseProxyUrl: 'https://${INSTANCE_NAME}.openai.azure.com/openai/v1',
      });

      // AzureChatOpenAI appends the deployment to its base path, including for a v1 resource URL.
      expect((result.llmConfig as Record<string, unknown>).azureOpenAIBasePath).toBe(
        'https://test-instance.openai.azure.com/openai/deployments',
      );
    });

    it('should handle Azure Responses API configuration', () => {
      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'test-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const modelOptions = { useResponsesApi: true };
      const result = getOpenAIConfig(mockApiKey, { azure, modelOptions });

      // Should construct the responses API URL
      expect(result.configOptions?.baseURL).toContain('test-instance.openai.azure.com');
      expect(result.configOptions?.defaultHeaders).toMatchObject({
        'api-key': mockApiKey,
      });
      expect(result.configOptions?.defaultQuery).toMatchObject({
        'api-version': 'preview',
      });
      expect(result.llmConfig.apiKey).toBe(mockApiKey);
      expect(
        (result.llmConfig as Record<string, unknown>).azureOpenAIApiDeploymentName,
      ).toBeUndefined();
      expect(
        (result.llmConfig as Record<string, unknown>).azureOpenAIApiInstanceName,
      ).toBeUndefined();
    });

    it('should create correct Azure baseURL when response api is selected', () => {
      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'test-deployment',
        azureOpenAIApiVersion: '2023-08-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, {
        azure,
        modelOptions: { useResponsesApi: true },
        reverseProxyUrl:
          'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
      });

      expect(result.configOptions?.baseURL).toBe(
        'https://test-instance.openai.azure.com/openai/v1',
      );
      expect(result.configOptions?.baseURL).not.toContain('deployments');
    });

    it('should handle Azure with organization from environment', () => {
      const originalOrg = process.env.OPENAI_ORGANIZATION;
      process.env.OPENAI_ORGANIZATION = 'test-org-123';

      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'test-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, { azure });

      expect(result.configOptions?.organization).toBe('test-org-123');

      // Cleanup
      if (originalOrg !== undefined) {
        process.env.OPENAI_ORGANIZATION = originalOrg;
      } else {
        delete process.env.OPENAI_ORGANIZATION;
      }
    });
  });

  describe('OpenRouter Configuration', () => {
    it('should detect OpenRouter from endpoint parameter', () => {
      const result = getOpenAIConfig(mockApiKey, {}, 'openrouter');

      expect(result.llmConfig.include_reasoning).toBe(true);
      expect(result.llmConfig.promptCache).toBe(true);
      expect(result.provider).toBe('openrouter');
    });

    it('should detect OpenRouter from baseURL case-insensitively', () => {
      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://gateway.example/v1/OpenRouter',
      });

      expect(result.llmConfig.include_reasoning).toBe(true);
      expect(result.llmConfig.promptCache).toBe(true);
      expect(result.provider).toBe('openrouter');
    });

    it('should preserve explicit promptCache false for OpenRouter', () => {
      const result = getOpenAIConfig(
        mockApiKey,
        {
          customParams: {
            defaultParamsEndpoint: 'openrouter',
            paramDefinitions: [{ key: 'promptCache', default: false }],
          },
        },
        'openrouter',
      );

      expect(result.llmConfig.promptCache).toBeUndefined();
      expect(result.provider).toBe('openrouter');
    });

    it('should honor dropParams for the OpenRouter promptCache default', () => {
      const result = getOpenAIConfig(
        mockApiKey,
        {
          dropParams: ['promptCache'],
        },
        'openrouter',
      );

      expect(result.llmConfig.promptCache).toBeUndefined();
      expect(result.provider).toBe('openrouter');
    });

    it('should honor a TTL-only selection for OpenRouter (promptCache defaulted on)', () => {
      /**
       * Reproduces selecting only the promptCacheTtl dropdown without toggling
       * the promptCache switch: modelOptions carries the TTL but not promptCache.
       * OPENROUTER_DEFAULT_PARAMS still resolves caching on, so the TTL survives.
       */
      const result = getOpenAIConfig(
        mockApiKey,
        {
          modelOptions: {
            model: 'anthropic/claude-sonnet-4.6',
            promptCacheTtl: '1h',
          } as Record<string, unknown>,
        },
        'openrouter',
      );

      expect(result.llmConfig.promptCache).toBe(true);
      expect((result.llmConfig as Record<string, unknown>).promptCacheTtl).toBe('1h');
      expect(result.provider).toBe('openrouter');
    });

    it('should drop the OpenRouter TTL when promptCache is explicitly disabled', () => {
      const result = getOpenAIConfig(
        mockApiKey,
        {
          modelOptions: {
            model: 'anthropic/claude-sonnet-4.6',
            promptCache: false,
            promptCacheTtl: '1h',
          } as Record<string, unknown>,
        },
        'openrouter',
      );

      expect(result.llmConfig.promptCache).toBeUndefined();
      expect((result.llmConfig as Record<string, unknown>).promptCacheTtl).toBeUndefined();
      expect(result.provider).toBe('openrouter');
    });

    it('should handle web_search with OpenRouter using plugins format', () => {
      const modelOptions = {
        model: 'gpt-4',
        web_search: true,
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        modelOptions,
      });

      // Should use plugins format for OpenRouter, not tools
      expect(result.llmConfig.modelKwargs).toEqual({
        plugins: [{ id: 'web' }],
      });
      expect(result.tools).toEqual([]);
      // Should NOT set useResponsesApi for OpenRouter
      expect(result.llmConfig.useResponsesApi).toBeUndefined();
      expect(result.provider).toBe('openrouter');
    });

    it('should handle web_search false with OpenRouter', () => {
      const modelOptions = {
        model: 'gpt-4',
        web_search: false,
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        modelOptions,
      });

      // Should not have plugins when web_search is false
      expect(result.llmConfig.modelKwargs).toBeUndefined();
      expect(result.tools).toEqual([]);
      expect(result.provider).toBe('openrouter');
    });

    it('should handle web_search with OpenRouter from addParams', () => {
      const addParams = {
        web_search: true,
        customParam: 'value',
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        addParams,
      });

      // Should use plugins format and include other params
      expect(result.llmConfig.modelKwargs).toEqual({
        plugins: [{ id: 'web' }],
        customParam: 'value',
      });
      expect(result.tools).toEqual([]);
      expect(result.provider).toBe('openrouter');
    });

    it('should handle web_search with OpenRouter and dropParams', () => {
      const modelOptions = {
        model: 'gpt-4',
        web_search: true,
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        modelOptions,
        dropParams: ['web_search'],
      });

      // dropParams should disable web_search even for OpenRouter
      expect(result.llmConfig.modelKwargs).toBeUndefined();
      expect(result.tools).toEqual([]);
      expect(result.provider).toBe('openrouter');
    });

    it('should handle OpenRouter with reasoning params (no summary)', () => {
      const modelOptions = {
        reasoning_effort: ReasoningEffort.high,
        reasoning_summary: ReasoningSummary.detailed,
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        modelOptions,
      });

      expect(result.llmConfig.modelKwargs).toMatchObject({
        reasoning: { effort: ReasoningEffort.high },
      });
      expect(result.llmConfig.include_reasoning).toBeUndefined();
      expect(result.provider).toBe('openrouter');
    });

    it('should merge custom headers with OpenRouter defaults', () => {
      const customHeaders = {
        'X-Custom-Header': 'custom-value',
        Authorization: 'Bearer custom-token',
      };

      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        headers: customHeaders,
      });

      expect(result.configOptions?.defaultHeaders).toEqual({
        'HTTP-Referer': 'https://librechat.ai',
        'X-Title': 'LibreChat',
        'X-OpenRouter-Title': 'LibreChat',
        'X-OpenRouter-Categories': 'general-chat,personal-agent,programming-app',
        'X-Custom-Header': 'custom-value',
        Authorization: 'Bearer custom-token',
      });
    });

    it('should allow custom OpenRouter categories to override attribution defaults', () => {
      const result = getOpenAIConfig(mockApiKey, {
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        headers: {
          'X-OpenRouter-Categories': 'general-chat',
        },
      });

      expect(result.configOptions?.defaultHeaders).toMatchObject({
        'X-OpenRouter-Categories': 'general-chat',
      });
    });
  });

  describe('Direct Endpoint Configuration', () => {
    it('should create custom fetch for direct endpoint', () => {
      const result = getOpenAIConfig(mockApiKey, {
        directEndpoint: true,
        reverseProxyUrl: 'https://direct-api.com',
      });

      // Should have a custom fetch function when directEndpoint is true
      expect(result.configOptions?.fetch).toBeDefined();
      expect(typeof result.configOptions?.fetch).toBe('function');
    });

    it('should not create custom fetch when directEndpoint is false', () => {
      const result = getOpenAIConfig(mockApiKey, {
        directEndpoint: false,
        reverseProxyUrl: 'https://proxy-api.com',
      });

      expect(result.configOptions?.fetch).toBeUndefined();
    });

    it('should not create custom fetch when baseURL is not set', () => {
      const result = getOpenAIConfig(mockApiKey, {
        directEndpoint: true,
      });

      expect(result.configOptions?.fetch).toBeUndefined();
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('should handle null and undefined values in reasoning params', () => {
      const testCases = [
        { reasoning_effort: null, reasoning_summary: null, shouldHaveReasoning: false },
        { reasoning_effort: undefined, reasoning_summary: undefined, shouldHaveReasoning: false },
        { reasoning_effort: '', reasoning_summary: '', shouldHaveReasoning: false },
        {
          reasoning_effort: ReasoningEffort.unset,
          reasoning_summary: '',
          shouldHaveReasoning: false,
        },
        {
          reasoning_effort: ReasoningEffort.none,
          reasoning_summary: null,
          shouldHaveReasoning: true,
        },
        {
          reasoning_effort: null,
          reasoning_summary: ReasoningSummary.concise,
          shouldHaveReasoning: true,
        },
        {
          reasoning_effort: ReasoningEffort.low,
          reasoning_summary: null,
          shouldHaveReasoning: true,
        },
      ];

      testCases.forEach(({ shouldHaveReasoning, ...modelOptions }) => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: { ...modelOptions, useResponsesApi: true } as Partial<OpenAIParameters>,
        });
        const reasoning = result.llmConfig?.reasoning ?? result.llmConfig?.modelKwargs?.reasoning;

        if (shouldHaveReasoning) {
          expect(reasoning).toBeDefined();
        } else {
          expect(reasoning).toBeUndefined();
        }
      });
    });

    it('should handle empty dropParams array', () => {
      const modelOptions = {
        temperature: 0.7,
        topP: 0.9,
      };

      const result = getOpenAIConfig(mockApiKey, {
        modelOptions,
        dropParams: [],
      });

      expect(result.llmConfig.temperature).toBe(0.7);
      expect(result.llmConfig.topP).toBe(0.9);
    });

    it('should handle non-array dropParams gracefully', () => {
      const modelOptions = {
        temperature: 0.7,
        topP: 0.9,
      };

      const result = getOpenAIConfig(mockApiKey, {
        modelOptions,
        /** Invalid type */
        dropParams: 'temperature' as unknown as string[],
      });

      // Should not crash and should keep all params
      expect(result.llmConfig.temperature).toBe(0.7);
      expect(result.llmConfig.topP).toBe(0.9);
    });

    it('should handle max_tokens conversion edge cases', () => {
      const testCases = [
        { model: 'gpt-4', max_tokens: 1000 }, // Should keep maxTokens
        { model: 'gpt-5', max_tokens: null }, // Should not create modelKwargs
        { model: 'gpt-6', max_tokens: undefined }, // Should not create modelKwargs
        { model: 'gpt-7', max_tokens: 0 }, // Should handle zero
      ];

      testCases.forEach(({ model, max_tokens }) => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: { model, max_tokens: max_tokens ?? undefined },
        });

        if (model === 'gpt-4') {
          expect(result.llmConfig.maxTokens).toBe(1000);
          expect(result.llmConfig.modelKwargs).toBeUndefined();
        } else if (max_tokens != null) {
          expect(result.llmConfig.maxTokens).toBeUndefined();
          expect(result.llmConfig.modelKwargs?.max_completion_tokens).toBe(max_tokens);
        } else {
          expect(result.llmConfig.maxTokens).toBeUndefined();
          expect(result.llmConfig.modelKwargs).toBeUndefined();
        }
      });
    });

    it('should handle various search model patterns', () => {
      const searchModels = [
        'gpt-4o-search',
        'gpt-4o-mini-search',
        'gpt-4o-2024-search',
        'custom-gpt-4o-search-model',
      ];

      searchModels.forEach((model) => {
        const modelOptions = {
          model,
          temperature: 0.7,
          frequency_penalty: 0.5,
          presence_penalty: 0.6,
          max_tokens: 1000,
          reasoning_effort: ReasoningEffort.high,
          custom_param: 'should-remain',
        };

        const result = getOpenAIConfig(mockApiKey, { modelOptions });

        expect(result.llmConfig.temperature).toBeUndefined();
        expect((result.llmConfig as Record<string, unknown>).frequency_penalty).toBeUndefined();
        expect((result.llmConfig as Record<string, unknown>).presence_penalty).toBeUndefined();
        /** `frequency_penalty` is converted to `frequencyPenalty` */
        expect(result.llmConfig.frequencyPenalty).toBe(0.5);
        expect(result.llmConfig.presencePenalty).toBe(0.6);
        /** `presence_penalty` is converted to `presencePenalty` */
        expect(result.llmConfig.maxTokens).toBe(1000); // max_tokens is allowed
        expect((result.llmConfig as Record<string, unknown>).custom_param).toBe('should-remain');
        expect(result.llmConfig.modelKwargs).toBeUndefined();
      });
    });

    it('should preserve streaming default when not specified', () => {
      const result = getOpenAIConfig(mockApiKey, {});
      expect(result.llmConfig.streaming).toBe(true);
    });

    it('should override streaming when explicitly set', () => {
      const result = getOpenAIConfig(mockApiKey, { streaming: false });
      expect(result.llmConfig.streaming).toBe(false);
    });
  });

  describe('Parameter Classification', () => {
    it('should correctly identify all known OpenAI parameters', () => {
      const allKnownParams = Array.from(knownOpenAIParams);
      const testParams: Record<string, unknown> = {};

      // Create test object with all known params
      allKnownParams.forEach((param) => {
        testParams[param] = `test-${param}`;
      });

      const result = getOpenAIConfig(mockApiKey, { addParams: testParams });

      // All should be in llmConfig, none in modelKwargs
      expect(result.llmConfig.modelKwargs).toBeUndefined();

      // Check a few key parameters are correctly placed
      expect((result.llmConfig as Record<string, unknown>).model).toBe('test-model');
      expect((result.llmConfig as Record<string, unknown>).temperature).toBe('test-temperature');
      expect((result.llmConfig as Record<string, unknown>).maxTokens).toBe('test-maxTokens');
    });

    it('should handle mixed case and underscore variations', () => {
      const addParams = {
        maxTokens: 1000, // camelCase - known
        topP: 0.9, // camelCase - known
        top_p: 0.8, // snake_case - unknown, should go to modelKwargs
        customParam: 'value', // unknown
      };

      const result = getOpenAIConfig(mockApiKey, { addParams });

      expect(result.llmConfig.maxTokens).toBe(1000);
      expect(result.llmConfig.topP).toBe(0.9);
      expect(result.llmConfig.modelKwargs).toEqual({
        top_p: 0.8,
        customParam: 'value',
      });
    });
  });

  describe('Complex Integration Scenarios', () => {
    it('should handle Azure + OpenRouter combination (OpenRouter still detected)', () => {
      const azure = {
        azureOpenAIApiInstanceName: 'test-instance',
        azureOpenAIApiDeploymentName: 'test-deployment',
        azureOpenAIApiVersion: '2023-05-15',
        azureOpenAIApiKey: 'azure-key',
      };

      const result = getOpenAIConfig(mockApiKey, {
        azure,
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
      });

      // Azure config should be present
      expect((result.llmConfig as Record<string, unknown>).azureOpenAIApiInstanceName).toBe(
        'test-instance',
      );
      // But OpenRouter is still detected from URL
      expect(result.provider).toBe('openrouter');
      expect(result.llmConfig.include_reasoning).toBe(true);
    });

    it('should handle all configuration options together', () => {
      const complexConfig = {
        modelOptions: {
          model: 'gpt-4-turbo',
          temperature: 0.7,
          max_tokens: 2000,
          verbosity: Verbosity.medium,
          reasoning_effort: ReasoningEffort.high,
          web_search: true,
        },
        reverseProxyUrl: 'https://api.custom.com',
        headers: { 'X-Custom': 'value' },
        defaultQuery: { version: 'v1' },
        proxy: 'http://proxy.com:8080',
        streaming: false,
        addParams: {
          customParam: 'custom-value',
          temperature: 0.8, // Should override modelOptions
        },
        dropParams: ['frequency_penalty'],
      };

      const result = getOpenAIConfig(mockApiKey, complexConfig);

      expect(result.llmConfig).toMatchObject({
        model: 'gpt-4-turbo',
        temperature: 0.8, // From addParams
        streaming: false,
        useResponsesApi: true, // From web_search
      });
      expect(result.llmConfig.reasoning).toBeUndefined();
      expect(result.llmConfig.maxTokens).toBe(2000);
      expect(result.llmConfig.modelKwargs).toEqual({
        text: { verbosity: Verbosity.medium },
        reasoning: { effort: ReasoningEffort.high },
        customParam: 'custom-value',
      });
      expect(result.tools).toEqual([{ type: 'web_search' }]);
      expect(result.configOptions).toMatchObject({
        baseURL: 'https://api.custom.com',
        defaultHeaders: { 'X-Custom': 'value' },
        defaultQuery: { version: 'v1' },
        fetchOptions: expect.objectContaining({
          dispatcher: expect.any(Object),
        }),
      });
    });

    it('should handle all configuration with OpenRouter and web_search', () => {
      const complexConfig = {
        modelOptions: {
          model: 'gpt-4-turbo',
          temperature: 0.7,
          max_tokens: 2000,
          verbosity: Verbosity.medium,
          reasoning_effort: ReasoningEffort.high,
          web_search: true,
        },
        reverseProxyUrl: 'https://openrouter.ai/api/v1',
        headers: { 'X-Custom': 'value' },
        streaming: false,
        addParams: {
          customParam: 'custom-value',
          temperature: 0.8,
        },
      };

      const result = getOpenAIConfig(mockApiKey, complexConfig);

      expect(result.llmConfig).toMatchObject({
        model: 'gpt-4-turbo',
        temperature: 0.8,
        streaming: false,
      });
      expect(result.llmConfig.include_reasoning).toBeUndefined();
      // Should NOT have useResponsesApi for OpenRouter
      expect(result.llmConfig.useResponsesApi).toBeUndefined();
      expect(result.llmConfig.maxTokens).toBe(2000);
      expect(result.llmConfig.verbosity).toBe(Verbosity.medium);
      expect(result.llmConfig.modelKwargs).toEqual({
        reasoning: { effort: ReasoningEffort.high },
        customParam: 'custom-value',
        plugins: [{ id: 'web' }], // OpenRouter web search format
      });
      expect(result.tools).toEqual([]); // No tools for OpenRouter web search
      expect(result.provider).toBe('openrouter');
    });
  });

  describe('Real Usage Integration Tests', () => {
    describe('OpenAI Initialize.js Simulation', () => {
      it('should handle OpenAI endpoint configuration like initialize.js', () => {
        // Simulate the configuration from OpenAI initialize.js
        const modelName = 'gpt-4-turbo';
        const endpointOption = {
          model_parameters: {
            temperature: 0.7,
            max_tokens: 2048,
            top_p: 0.9,
            frequency_penalty: 0.1,
            presence_penalty: 0.1,
          },
        };

        // Simulate clientOptions from initialize.js
        const clientOptions = {
          contextStrategy: 'summarize',
          proxy: null,
          debug: false,
          reverseProxyUrl: null,
          streamRate: 30,
          titleModel: 'gpt-3.5-turbo',
          titleMethod: 'completion',
          modelOptions: {
            model: modelName,
            user: 'test-user-id',
            ...endpointOption.model_parameters,
          },
        };

        const result = getOpenAIConfig(mockApiKey, clientOptions);

        expect(result.llmConfig).toMatchObject({
          model: modelName,
          temperature: 0.7,
          maxTokens: 2048,
          topP: 0.9,
          frequencyPenalty: 0.1, // converted from frequency_penalty
          presencePenalty: 0.1, // converted from presence_penalty
          user: 'test-user-id',
          streaming: true, // default
          apiKey: mockApiKey,
        });
        expect(result.llmConfig).not.toHaveProperty('top_p');
        expect(result.configOptions).toEqual({});
        expect(result.tools).toEqual([]);
      });

      it('should handle Azure OpenAI configuration like initialize.js', () => {
        // Simulate Azure configuration from mapModelToAzureConfig
        const modelName = 'gpt-4-turbo';
        const azureOptions = {
          azureOpenAIApiKey: 'azure-key-123',
          azureOpenAIApiInstanceName: 'prod-instance',
          azureOpenAIApiDeploymentName: 'gpt-4-turbo-deployment',
          azureOpenAIApiVersion: '2023-12-01-preview',
        };
        const baseURL = 'https://prod-instance.openai.azure.com';
        const headers = {
          'X-Custom-Header': 'azure-value',
          Authorization: 'Bearer custom-token',
        };

        // Simulate clientOptions from Azure initialize.js
        const clientOptions = {
          contextStrategy: null,
          proxy: null,
          debug: false,
          reverseProxyUrl: baseURL,
          headers,
          titleConvo: true,
          titleModel: 'gpt-3.5-turbo',
          streamRate: 30,
          titleMethod: 'completion',
          azure: azureOptions,
          addParams: {
            temperature: 0.8,
            max_completion_tokens: 4000,
          },
          dropParams: ['frequency_penalty'],
          modelOptions: {
            model: modelName,
            user: 'azure-user-123',
            temperature: 0.7, // Should be overridden by addParams
            frequency_penalty: 0.2, // Should be dropped
          },
        };

        const result = getOpenAIConfig(mockApiKey, clientOptions);

        expect(result.llmConfig).toMatchObject({
          model: 'gpt-4-turbo-deployment', // Uses deployment name
          temperature: 0.8, // From addParams
          user: 'azure-user-123',
          streaming: true,
          azureOpenAIApiKey: 'azure-key-123',
          azureOpenAIApiInstanceName: 'prod-instance',
          azureOpenAIApiDeploymentName: 'gpt-4-turbo-deployment',
          azureOpenAIApiVersion: '2023-12-01-preview',
        });
        expect((result.llmConfig as Record<string, unknown>).frequency_penalty).toBeUndefined(); // Dropped
        expect(result.llmConfig.modelKwargs).toMatchObject({
          max_completion_tokens: 4000,
        });
        expect(result.configOptions).toMatchObject({
          baseURL: baseURL,
          defaultHeaders: headers,
        });
      });

      it('should handle Azure serverless configuration', () => {
        const modelName = 'gpt-4';
        const azureOptions = {
          azureOpenAIApiKey: 'serverless-key',
          azureOpenAIApiInstanceName: 'serverless-instance',
          azureOpenAIApiDeploymentName: 'gpt-4-serverless',
          azureOpenAIApiVersion: '2024-02-15-preview',
        };

        const clientOptions = {
          reverseProxyUrl: 'https://serverless.openai.azure.com/openai/v1',
          headers: {
            'api-key': azureOptions.azureOpenAIApiKey,
          },
          defaultQuery: {
            'api-version': azureOptions.azureOpenAIApiVersion,
          },
          azure: false as const, // Serverless doesn't use azure object
          modelOptions: {
            model: modelName,
            user: 'serverless-user',
          },
        };

        const result = getOpenAIConfig(azureOptions.azureOpenAIApiKey, clientOptions);

        expect(result.llmConfig).toMatchObject({
          model: modelName,
          user: 'serverless-user',
          apiKey: azureOptions.azureOpenAIApiKey,
        });
        expect(result.configOptions).toMatchObject({
          baseURL: 'https://serverless.openai.azure.com/openai/v1',
          defaultHeaders: {
            'api-key': azureOptions.azureOpenAIApiKey,
          },
          defaultQuery: {
            'api-version': azureOptions.azureOpenAIApiVersion,
          },
        });
      });
    });

    describe('Custom Endpoint Initialize.js Simulation', () => {
      it('should handle custom endpoint configuration like initialize.js', () => {
        const endpoint = 'custom-openai';
        const apiKey = 'custom-api-key-456';
        const baseURL = 'https://api.custom-provider.com/v1';

        // Simulate endpointConfig from custom initialize.js
        const endpointConfig = {
          apiKey: 'user_provided',
          baseURL: baseURL,
          headers: {
            'X-Custom-Provider': 'LibreChat',
            'User-Agent': 'LibreChat/1.0',
          },
          addParams: {
            custom_parameter: 'custom_value',
            temperature: 0.9,
          },
          dropParams: ['presence_penalty'],
          titleConvo: true,
          titleModel: 'gpt-3.5-turbo',
          modelDisplayLabel: 'Custom GPT-4',
          titleMethod: 'completion',
          directEndpoint: true,
          titleMessageRole: 'user',
          streamRate: 25,
        };

        const clientOptions = {
          reverseProxyUrl: baseURL,
          proxy: null,
          headers: endpointConfig.headers,
          addParams: endpointConfig.addParams,
          dropParams: endpointConfig.dropParams,
          customParams: {},
          titleConvo: endpointConfig.titleConvo,
          titleModel: endpointConfig.titleModel,
          modelDisplayLabel: endpointConfig.modelDisplayLabel,
          titleMethod: endpointConfig.titleMethod,
          directEndpoint: endpointConfig.directEndpoint,
          titleMessageRole: endpointConfig.titleMessageRole,
          streamRate: endpointConfig.streamRate,
          modelOptions: {
            model: 'gpt-4-custom',
            user: 'custom-user-789',
            presence_penalty: 0.3, // Should be dropped
            max_tokens: 3000,
          },
        };

        const result = getOpenAIConfig(apiKey, clientOptions, endpoint);

        expect(result.llmConfig).toMatchObject({
          model: 'gpt-4-custom',
          user: 'custom-user-789',
          temperature: 0.9, // From addParams
          maxTokens: 3000,
          apiKey: apiKey,
        });
        expect((result.llmConfig as Record<string, unknown>).presence_penalty).toBeUndefined(); // Dropped
        expect(result.llmConfig.modelKwargs).toMatchObject({
          custom_parameter: 'custom_value',
        });
        expect(result.configOptions).toMatchObject({
          baseURL: baseURL,
          defaultHeaders: endpointConfig.headers,
          fetch: expect.any(Function), // directEndpoint creates custom fetch
        });
      });

      it('should handle OpenRouter configuration like custom initialize.js', () => {
        const endpoint = 'openrouter';
        const apiKey = 'sk-or-v1-custom-key';
        const baseURL = 'https://openrouter.ai/api/v1';

        const clientOptions = {
          reverseProxyUrl: baseURL,
          headers: {
            'HTTP-Referer': 'https://librechat.ai',
            'X-Title': 'LibreChat',
            Authorization: `Bearer ${apiKey}`,
          },
          addParams: {
            top_k: 50,
            repetition_penalty: 1.1,
          },
          customParams: {
            defaultParamsEndpoint: 'openrouter',
            paramDefinitions: [{ key: 'promptCache', default: true }],
          },
          modelOptions: {
            model: 'anthropic/claude-3-sonnet',
            user: 'openrouter-user',
            temperature: 0.7,
            max_tokens: 4000,
            reasoning_effort: ReasoningEffort.high,
            reasoning_summary: ReasoningSummary.detailed,
          },
        };

        const result = getOpenAIConfig(apiKey, clientOptions, endpoint);

        expect(result.llmConfig).toMatchObject({
          model: 'anthropic/claude-3-sonnet',
          user: 'openrouter-user',
          temperature: 0.7,
          maxTokens: 4000,
          apiKey: apiKey,
          promptCache: true,
        });
        expect(result.llmConfig.include_reasoning).toBeUndefined();
        expect(result.llmConfig.modelKwargs).toMatchObject({
          reasoning: { effort: ReasoningEffort.high },
          top_k: 50,
          repetition_penalty: 1.1,
        });
        expect(result.configOptions?.defaultHeaders).toMatchObject({
          'HTTP-Referer': 'https://librechat.ai',
          'X-Title': 'LibreChat',
          Authorization: `Bearer ${apiKey}`,
        });
        expect(result.provider).toBe('openrouter');
      });

      it('should honor OpenRouter defaults for proxied custom endpoint names', () => {
        const endpoint = 'company-gateway';
        const apiKey = 'sk-proxy-key';
        const baseURL = 'https://llm-proxy.example.com/v1';

        const result = getOpenAIConfig(
          apiKey,
          {
            reverseProxyUrl: baseURL,
            headers: {
              Authorization: `Bearer ${apiKey}`,
            },
            customParams: {
              defaultParamsEndpoint: 'openrouter',
              paramDefinitions: [{ key: 'promptCache', default: true }],
            },
            modelOptions: {
              model: 'anthropic/claude-sonnet-4.6',
              reasoning_effort: ReasoningEffort.high,
            },
          },
          endpoint,
        );

        expect(result.llmConfig).toMatchObject({
          model: 'anthropic/claude-sonnet-4.6',
          apiKey,
          promptCache: true,
        });
        expect(result.llmConfig.include_reasoning).toBeUndefined();
        expect(result.llmConfig.verbosity).toBe(ReasoningEffort.high);
        expect(result.llmConfig.modelKwargs).toMatchObject({
          reasoning: { enabled: true },
        });
        expect(result.configOptions?.baseURL).toBe(baseURL);
        expect(result.configOptions?.defaultHeaders).toMatchObject({
          'X-OpenRouter-Title': 'LibreChat',
          Authorization: `Bearer ${apiKey}`,
        });
        expect(result.provider).toBe('openrouter');
      });
    });

    describe('Production-like Azure Scenarios', () => {
      it('should handle complex Azure multi-group configuration', () => {
        // Simulate a production Azure setup with multiple groups
        const modelName = 'gpt-4-turbo';
        const azureConfig = {
          azureOpenAIApiKey: 'prod-key-multi',
          azureOpenAIApiInstanceName: 'prod-east-instance',
          azureOpenAIApiDeploymentName: 'gpt-4-turbo-prod',
          azureOpenAIApiVersion: '2024-02-15-preview',
        };

        const clientOptions = {
          reverseProxyUrl: 'https://prod-east-instance.openai.azure.com',
          headers: {
            'X-Environment': 'production',
            'X-Region': 'us-east-1',
            'Content-Type': 'application/json',
          },
          azure: azureConfig,
          addParams: {
            temperature: 0.2, // Conservative for production
            max_completion_tokens: 8192,
            topP: 0.95, // Use camelCase for known param
            frequencyPenalty: 0.0, // Use camelCase for known param
            presencePenalty: 0.0, // Use camelCase for known param
            seed: 12345, // For reproducibility
          },
          dropParams: [], // Don't drop any params in prod
          modelOptions: {
            model: modelName,
            user: 'prod-user-session-abc123',
            stream: true,
          },
        };

        const result = getOpenAIConfig(mockApiKey, clientOptions);

        expect(result.llmConfig).toMatchObject({
          model: 'gpt-4-turbo-prod',
          user: 'prod-user-session-abc123',
          temperature: 0.2,
          // Parameters from addParams are processed
          seed: 12345,
          stream: true,
          azureOpenAIApiKey: 'prod-key-multi',
          azureOpenAIApiInstanceName: 'prod-east-instance',
          azureOpenAIApiDeploymentName: 'gpt-4-turbo-prod',
          azureOpenAIApiVersion: '2024-02-15-preview',
        });
        // Check that camelCase conversions happened
        expect(result.llmConfig.topP).toBe(0.95);
        expect(result.llmConfig.frequencyPenalty).toBe(0.0);
        expect(result.llmConfig.presencePenalty).toBe(0.0);
        expect(result.llmConfig.modelKwargs).toMatchObject({
          max_completion_tokens: 8192,
        });
        expect(result.configOptions?.baseURL).toBe('https://prod-east-instance.openai.azure.com');
      });

      it('should handle Azure with environment variable placeholders', () => {
        const originalEnv = {
          INSTANCE_NAME: process.env.INSTANCE_NAME,
          DEPLOYMENT_NAME: process.env.DEPLOYMENT_NAME,
          API_VERSION: process.env.API_VERSION,
        };

        // Set environment variables
        process.env.INSTANCE_NAME = 'env-instance';
        process.env.DEPLOYMENT_NAME = 'env-deployment';
        process.env.API_VERSION = '2024-03-01-preview';

        const clientOptions = {
          reverseProxyUrl: 'https://${INSTANCE_NAME}.openai.azure.com/openai/v1',
          azure: {
            azureOpenAIApiKey: 'env-key',
            azureOpenAIApiInstanceName: '${INSTANCE_NAME}',
            azureOpenAIApiDeploymentName: '${DEPLOYMENT_NAME}',
            azureOpenAIApiVersion: '${API_VERSION}',
          },
          modelOptions: {
            model: 'gpt-4',
            user: 'env-user',
          },
        };

        const result = getOpenAIConfig(mockApiKey, clientOptions);

        // The constructAzureURL should process placeholders (actual replacement depends on implementation)
        expect((result.llmConfig as Record<string, unknown>).azureOpenAIBasePath).toBeDefined();
        expect(result.llmConfig.model).toBe('${DEPLOYMENT_NAME}'); // Model becomes deployment name

        // Cleanup
        Object.entries(originalEnv).forEach(([key, value]) => {
          if (value !== undefined) {
            process.env[key] = value;
          } else {
            delete process.env[key];
          }
        });
      });
    });

    describe('Error Handling and Edge Cases from Real Usage', () => {
      it('should handle missing API key scenario', () => {
        expect(() => {
          getOpenAIConfig('', {
            modelOptions: { model: 'gpt-4' },
          });
        }).not.toThrow(); // The function itself doesn't validate empty keys
      });

      it('should handle malformed Azure configuration gracefully', () => {
        const clientOptions = {
          azure: {
            azureOpenAIApiKey: 'valid-key',
            // Missing required fields
          } as Partial<AzureOptions>,
          modelOptions: {
            model: 'gpt-4',
          },
        };

        const result = getOpenAIConfig(mockApiKey, clientOptions);
        expect(result.llmConfig).toBeDefined();
      });

      it('should handle large parameter sets without performance issues', () => {
        const largeAddParams: Record<string, unknown> = {};
        const largeModelKwargs: Record<string, unknown> = {};

        // Create 50 unknown parameters (using names not in knownOpenAIParams)
        for (let i = 0; i < 50; i++) {
          largeAddParams[`unknown_param_${i}`] = 0.5;
        }

        // Create 50 more unknown parameters
        for (let i = 0; i < 50; i++) {
          largeAddParams[`custom_param_${i}`] = `value_${i}`;
          largeModelKwargs[`unknown_param_${i}`] = 0.5;
          largeModelKwargs[`custom_param_${i}`] = `value_${i}`;
        }

        const startTime = Date.now();
        const result = getOpenAIConfig(mockApiKey, {
          addParams: largeAddParams,
          modelOptions: { model: 'gpt-4' },
        });
        const endTime = Date.now();

        expect(endTime - startTime).toBeLessThan(100); // Should be fast
        expect(result.llmConfig.modelKwargs).toEqual(largeModelKwargs);
      });
    });

    describe('defaultParams Support via customParams', () => {
      it('should apply defaultParams when fields are undefined', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
            paramDefinitions: [
              { key: 'useResponsesApi', default: true },
              { key: 'temperature', default: 0.5 },
            ],
          },
        });

        expect(result.llmConfig.useResponsesApi).toBe(true);
        expect(result.llmConfig.temperature).toBe(0.5);
      });

      it('should not override existing modelOptions with defaultParams', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
            paramDefinitions: [
              { key: 'temperature', default: 0.5 },
              { key: 'maxTokens', default: 1000 },
            ],
          },
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.maxTokens).toBe(1000);
      });

      it('should allow addParams to override defaultParams', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
            paramDefinitions: [
              { key: 'useResponsesApi', default: true },
              { key: 'temperature', default: 0.5 },
            ],
          },
          addParams: {
            useResponsesApi: false,
            temperature: 0.8,
          },
        });

        expect(result.llmConfig.useResponsesApi).toBe(false);
        expect(result.llmConfig.temperature).toBe(0.8);
      });

      it('should handle defaultParams with unknown parameters', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
            paramDefinitions: [
              { key: 'customParam1', default: 'defaultValue' },
              { key: 'customParam2', default: 123 },
            ],
          },
        });

        expect(result.llmConfig.modelKwargs).toMatchObject({
          customParam1: 'defaultValue',
          customParam2: 123,
        });
      });

      it('should handle defaultParams with web_search', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
          },
          customParams: {
            defaultParamsEndpoint: 'openAI',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
        });

        expect(result.llmConfig.useResponsesApi).toBe(true);
        expect(result.tools).toEqual([{ type: 'web_search' }]);
      });

      it('should allow addParams to override defaultParams web_search', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
          },
          customParams: {
            defaultParamsEndpoint: 'openAI',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
          addParams: {
            web_search: false,
          },
        });

        expect(result.tools).toEqual([]);
      });

      it('should apply defaultParams for Anthropic via customParams', () => {
        const result = getOpenAIConfig('test-key', {
          modelOptions: {
            model: 'claude-3-5-sonnet-20241022',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topK', default: 50 },
            ],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.modelKwargs?.topK).toBe(50);
      });

      it('should apply defaultParams for Google via customParams', () => {
        const credentials = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const result = getOpenAIConfig(credentials, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [
              { key: 'temperature', default: 0.6 },
              { key: 'topK', default: 40 },
            ],
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.6);
        expect(result.llmConfig.modelKwargs?.topK).toBe(40);
      });

      it('should handle empty paramDefinitions', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
            paramDefinitions: [],
          },
        });

        expect(result.llmConfig.temperature).toBe(0.9);
      });

      it('should handle missing paramDefinitions', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4o',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'azureOpenAI',
          },
        });

        expect(result.llmConfig.temperature).toBe(0.9);
      });

      it('should preserve order: defaultParams < addParams < modelOptions', () => {
        const result = getOpenAIConfig(mockApiKey, {
          modelOptions: {
            model: 'gpt-4',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'openAI',
            paramDefinitions: [
              { key: 'temperature', default: 0.3 },
              { key: 'topP', default: 0.5 },
              { key: 'maxTokens', default: 500 },
            ],
          },
          addParams: {
            topP: 0.8,
          },
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.topP).toBe(0.8);
        expect(result.llmConfig.maxTokens).toBe(500);
      });
    });
  });
});

describe('Grok 4.7 xAI configuration', () => {
  it.each([
    ReasoningEffort.low,
    ReasoningEffort.medium,
    ReasoningEffort.high,
    ReasoningEffort.xhigh,
  ])('forwards %s effort through the existing Chat Completions path', (effort) => {
    const result = getOpenAIConfig(
      'test-xai-key',
      {
        reverseProxyUrl: 'https://api.x.ai/v1',
        modelOptions: { model: 'grok-4.7', reasoning_effort: effort },
      },
      'xai',
    );
    expect(result.configOptions?.baseURL).toBe('https://api.x.ai/v1');
    expect(result.llmConfig.model).toBe('grok-4.7');
    expect(result.llmConfig.modelKwargs).toMatchObject({ reasoning_effort: effort });
    expect(result.llmConfig.useResponsesApi).not.toBe(true);
  });

  it('leaves reasoning effort unset so xAI applies its default', () => {
    const result = getOpenAIConfig('test-xai-key', { modelOptions: { model: 'grok-4.7' } }, 'xai');
    expect(result.llmConfig.modelKwargs?.reasoning_effort).toBeUndefined();
  });
});
