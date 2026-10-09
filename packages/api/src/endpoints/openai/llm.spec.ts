import {
  Verbosity,
  EModelEndpoint,
  ReasoningMode,
  ReasoningEffort,
  ReasoningContext,
  ReasoningSummary,
  ReasoningParameterFormat,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { getOpenAILLMConfig, extractDefaultParams, applyDefaultParams } from './llm';

describe('getOpenAILLMConfig', () => {
  describe('Basic Configuration', () => {
    it('should create a basic configuration with required fields', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
        },
      });

      expect(result.llmConfig).toHaveProperty('apiKey', 'test-api-key');
      expect(result.llmConfig).toHaveProperty('model', 'gpt-4');
      expect(result.llmConfig).toHaveProperty('streaming', true);
      expect(result.tools).toEqual([]);
    });

    it('should handle model options including temperature and penalties', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: 0.7,
          frequency_penalty: 0.5,
          presence_penalty: 0.3,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).toHaveProperty('frequencyPenalty', 0.5);
      expect(result.llmConfig).toHaveProperty('presencePenalty', 0.3);
    });

    it('should handle max_tokens conversion to maxTokens', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          max_tokens: 4096,
        },
      });

      expect(result.llmConfig).toHaveProperty('maxTokens', 4096);
      expect(result.llmConfig).not.toHaveProperty('max_tokens');
    });
  });

  describe('Empty String Handling (Issue Fix)', () => {
    it('should remove empty string values for numeric parameters', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: '' as unknown as number,
          topP: '' as unknown as number,
          max_tokens: '' as unknown as number,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).not.toHaveProperty('maxTokens');
      expect(result.llmConfig).not.toHaveProperty('max_tokens');
    });

    it('should remove empty string values for frequency and presence penalties', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          frequency_penalty: '' as unknown as number,
          presence_penalty: '' as unknown as number,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
      expect(result.llmConfig).not.toHaveProperty('presencePenalty');
      expect(result.llmConfig).not.toHaveProperty('frequency_penalty');
      expect(result.llmConfig).not.toHaveProperty('presence_penalty');
    });

    it('should preserve valid numeric values while removing empty strings', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: 0.7,
          topP: '' as unknown as number,
          max_tokens: 4096,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).not.toHaveProperty('topP');
      expect(result.llmConfig).toHaveProperty('maxTokens', 4096);
    });

    it('should preserve zero values (not treat them as empty)', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: 0,
          frequency_penalty: 0,
          presence_penalty: 0,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0);
      expect(result.llmConfig).toHaveProperty('frequencyPenalty', 0);
      expect(result.llmConfig).toHaveProperty('presencePenalty', 0);
    });
  });

  describe('OpenAI Reasoning Models (o1/o3/gpt-5)', () => {
    const reasoningModels = [
      'o1',
      'o1-mini',
      'o1-preview',
      'o1-pro',
      'o3',
      'o3-mini',
      'gpt-5',
      'gpt-5-pro',
      'gpt-5-turbo',
    ];

    const excludedParams = [
      'frequencyPenalty',
      'presencePenalty',
      'temperature',
      'topP',
      'logitBias',
      'n',
      'logprobs',
    ];

    it.each(reasoningModels)(
      'should exclude unsupported parameters for reasoning model: %s',
      (model) => {
        const result = getOpenAILLMConfig({
          apiKey: 'test-api-key',
          streaming: true,
          modelOptions: {
            model,
            temperature: 0.7,
            frequency_penalty: 0.5,
            presence_penalty: 0.3,
            topP: 0.9,
            logitBias: { '50256': -100 },
            n: 2,
            logprobs: true,
          } as Partial<t.OpenAIParameters>,
        });

        excludedParams.forEach((param) => {
          expect(result.llmConfig).not.toHaveProperty(param);
        });

        expect(result.llmConfig).toHaveProperty('model', model);
        expect(result.llmConfig).toHaveProperty('streaming', true);
      },
    );

    it('should preserve maxTokens for reasoning models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'o1',
          max_tokens: 4096,
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).toHaveProperty('maxTokens', 4096);
      expect(result.llmConfig).not.toHaveProperty('temperature');
    });

    it('should preserve other valid parameters for reasoning models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'o1',
          max_tokens: 8192,
          stop: ['END'],
        },
      });

      expect(result.llmConfig).toHaveProperty('maxTokens', 8192);
      expect(result.llmConfig).toHaveProperty('stop', ['END']);
    });

    it('should handle GPT-5 max_tokens conversion to max_completion_tokens', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-5',
          max_tokens: 8192,
          stop: ['END'],
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('max_completion_tokens', 8192);
      expect(result.llmConfig).not.toHaveProperty('maxTokens');
      expect(result.llmConfig).toHaveProperty('stop', ['END']);
    });

    it('should combine user dropParams with reasoning exclusion params', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'o3-mini',
          temperature: 0.7,
          stop: ['END'],
        },
        dropParams: ['stop'],
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('stop');
    });

    it('should NOT exclude parameters for non-reasoning models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4-turbo',
          temperature: 0.7,
          frequency_penalty: 0.5,
          presence_penalty: 0.3,
          topP: 0.9,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).toHaveProperty('frequencyPenalty', 0.5);
      expect(result.llmConfig).toHaveProperty('presencePenalty', 0.3);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });

    it('should NOT exclude parameters for gpt-5.x versioned models (they support sampling params)', () => {
      const versionedModels = ['gpt-5.1', 'gpt-5.1-turbo', 'gpt-5.2', 'gpt-5.5-preview'];

      versionedModels.forEach((model) => {
        const result = getOpenAILLMConfig({
          apiKey: 'test-api-key',
          streaming: true,
          modelOptions: {
            model,
            temperature: 0.7,
            frequency_penalty: 0.5,
            presence_penalty: 0.3,
            topP: 0.9,
          },
        });

        expect(result.llmConfig).toHaveProperty('temperature', 0.7);
        expect(result.llmConfig).toHaveProperty('frequencyPenalty', 0.5);
        expect(result.llmConfig).toHaveProperty('presencePenalty', 0.3);
        expect(result.llmConfig).toHaveProperty('topP', 0.9);
      });
    });

    it('should NOT exclude parameters for gpt-5-chat (it supports sampling params)', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-5-chat',
          temperature: 0.7,
          frequency_penalty: 0.5,
          presence_penalty: 0.3,
          topP: 0.9,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.7);
      expect(result.llmConfig).toHaveProperty('frequencyPenalty', 0.5);
      expect(result.llmConfig).toHaveProperty('presencePenalty', 0.3);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });

    it('should handle reasoning models with reasoning_effort parameter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'o1',
          reasoning_effort: ReasoningEffort.high,
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
      expect(result.llmConfig).not.toHaveProperty('temperature');
    });
  });

  describe('OpenAI Web Search Models', () => {
    it('should exclude parameters for gpt-4o search models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4o-search-preview',
          temperature: 0.7,
          top_p: 0.9,
          seed: 42,
        } as Partial<t.OpenAIParameters>,
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).not.toHaveProperty('top_p');
      expect(result.llmConfig).not.toHaveProperty('seed');
    });

    it('should preserve max_tokens for search models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4o-search',
          max_tokens: 4096,
          temperature: 0.7,
        },
      });

      expect(result.llmConfig).toHaveProperty('maxTokens', 4096);
      expect(result.llmConfig).not.toHaveProperty('temperature');
    });
  });

  describe('Web Search Functionality', () => {
    it('should enable web search with Responses API', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          web_search: true,
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.tools).toContainEqual({ type: 'web_search' });
    });

    it('should handle web search with OpenRouter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'gpt-4',
          web_search: true,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('plugins', [{ id: 'web' }]);
      expect(result.llmConfig).toHaveProperty('include_reasoning', true);
    });

    it('should combine web search plugins and reasoning object for OpenRouter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-3-sonnet',
          reasoning_effort: ReasoningEffort.high,
          web_search: true,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
      expect(result.llmConfig).not.toHaveProperty('include_reasoning');
      expect(result.llmConfig.modelKwargs).toHaveProperty('plugins', [{ id: 'web' }]);
    });

    it('should disable web search via dropParams', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          web_search: true,
        },
        dropParams: ['web_search'],
      });

      expect(result.tools).not.toContainEqual({ type: 'web_search' });
    });
  });

  describe('GPT-5 max_tokens Handling', () => {
    it('should convert maxTokens to max_completion_tokens for GPT-5 models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-5',
          max_tokens: 8192,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('max_completion_tokens', 8192);
      expect(result.llmConfig).not.toHaveProperty('maxTokens');
    });

    it('should convert maxTokens to max_output_tokens for GPT-5 with Responses API', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-5',
          max_tokens: 8192,
        },
        addParams: {
          useResponsesApi: true,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('max_output_tokens', 8192);
      expect(result.llmConfig).not.toHaveProperty('maxTokens');
    });
  });

  describe('Reasoning Parameters', () => {
    it('should handle reasoning_effort for OpenAI endpoint', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'o1',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
    });

    it('should pass reasoning_effort through modelKwargs for custom endpoints', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        modelOptions: {
          model: 'provider/reasoning-model',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning_effort', ReasoningEffort.high);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should support reasoning object passthrough for custom endpoints', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        modelOptions: {
          model: 'provider/reasoning-model',
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.concise,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
        summary: ReasoningSummary.concise,
      });
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should include reasoning_mode and reasoning_context in the custom reasoning object', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        modelOptions: {
          model: 'provider/gpt-5.6',
          reasoning_effort: ReasoningEffort.high,
          reasoning_mode: ReasoningMode.pro,
          reasoning_context: ReasoningContext.all_turns,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
        mode: ReasoningMode.pro,
        context: ReasoningContext.all_turns,
      });
      expect(result.llmConfig).not.toHaveProperty('reasoning_mode');
      expect(result.llmConfig).not.toHaveProperty('reasoning_context');
    });

    it('should apply reasoning format to default reasoning params', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        defaultParams: {
          reasoning_effort: ReasoningEffort.low,
          reasoning_summary: ReasoningSummary.concise,
        },
        modelOptions: {
          model: 'provider/reasoning-model',
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.low,
        summary: ReasoningSummary.concise,
      });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('reasoning_effort');
    });

    it('should let addParams reasoning override default reasoning params before formatting', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        defaultParams: {
          reasoning_effort: ReasoningEffort.low,
        },
        addParams: {
          reasoning_effort: ReasoningEffort.high,
        },
        modelOptions: {
          model: 'provider/reasoning-model',
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('reasoning_effort');
    });

    it('should allow custom endpoints to disable reasoning passthrough', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.disabled,
        modelOptions: {
          model: 'provider/reasoning-model',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should use Responses API reasoning when web_search enables Responses API', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        modelOptions: {
          model: 'provider/reasoning-model',
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.concise,
          web_search: true,
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
        summary: ReasoningSummary.concise,
      });
      expect(result.tools).toContainEqual({ type: 'web_search' });
    });

    it('should remove reasoning kwargs for GPT-4o search models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        modelOptions: {
          model: 'gpt-4o-search',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should honor dropParams after reasoning object conversion', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        reasoningFormat: ReasoningParameterFormat.reasoningObject,
        dropParams: ['reasoning_effort'],
        modelOptions: {
          model: 'provider/reasoning-model',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should use reasoning object when useResponsesApi is true', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'o1',
          reasoning_effort: ReasoningEffort.medium,
          reasoning_summary: ReasoningSummary.detailed,
        },
        addParams: {
          useResponsesApi: true,
        },
      });

      expect(result.llmConfig).toHaveProperty('reasoning');
      expect(result.llmConfig.reasoning).toEqual({
        effort: ReasoningEffort.medium,
        summary: ReasoningSummary.detailed,
      });
    });

    it('should build the OpenAI Responses reasoning object from mode and context alone', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6',
          reasoning_mode: ReasoningMode.pro,
          reasoning_context: ReasoningContext.current_turn,
          useResponsesApi: true,
        },
      });

      expect(result.llmConfig.reasoning).toEqual({
        mode: ReasoningMode.pro,
        context: ReasoningContext.current_turn,
      });
    });

    it('should omit reasoning_mode and reasoning_context on OpenAI Chat Completions', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6',
          reasoning_effort: ReasoningEffort.high,
          reasoning_mode: ReasoningMode.pro,
          reasoning_context: ReasoningContext.all_turns,
          /** Explicit opt-out: GPT-5.6 reasoning otherwise defaults to the Responses API */
          useResponsesApi: false,
        },
      });

      /** Chat Completions uses reasoning_effort; mode/context are Responses-only
       *  and must never leak as top-level params or a reasoning object. */
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
      expect(result.llmConfig).not.toHaveProperty('reasoning_mode');
      expect(result.llmConfig).not.toHaveProperty('reasoning_context');
    });
  });

  describe('GPT-6 Astra Responses API routing', () => {
    const astraConfig = (overrides: Record<string, unknown> = {}) =>
      getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: { model: 'gpt-6-astra' },
        ...overrides,
      });

    it('routes every Astra turn to the Responses API, not only reasoning ones', () => {
      expect(astraConfig().llmConfig).toHaveProperty('useResponsesApi', true);
    });

    /**
     * The reason routing is decided here rather than at invocation time: the
     * max-tokens field is shaped from `useResponsesApi`, so switching APIs later
     * would send `max_completion_tokens` to an endpoint expecting
     * `max_output_tokens`.
     */
    it('shapes max tokens for the API it actually uses', () => {
      const result = astraConfig({
        modelOptions: { model: 'gpt-6-astra', max_tokens: 4096 },
      });
      const kwargs = (result.llmConfig.modelKwargs ?? {}) as Record<string, unknown>;
      expect(kwargs).not.toHaveProperty('max_completion_tokens');
      expect(kwargs.max_output_tokens ?? result.llmConfig.maxTokens).toBeDefined();
    });

    it('keeps routing when a drop rule only clears reasoning_effort', () => {
      /**
       * Unlike the GPT-5.6 default, Astra's routing is not reasoning-driven, so
       * a rule clearing an unsupported stored effort must not disable it.
       */
      expect(astraConfig({ dropParams: ['reasoning_effort'] }).llmConfig).toHaveProperty(
        'useResponsesApi',
        true,
      );
    });

    it('respects an explicit opt-out', () => {
      expect(astraConfig({ dropParams: ['useResponsesApi'] }).llmConfig).not.toHaveProperty(
        'useResponsesApi',
        true,
      );
    });

    it('leaves a custom gateway on its configured path', () => {
      expect(astraConfig({ baseURL: 'https://gateway.internal/v1' }).llmConfig).not.toHaveProperty(
        'useResponsesApi',
        true,
      );
    });

    it('does not change routing for other models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: { model: 'gpt-5.5' },
      });
      expect(result.llmConfig).not.toHaveProperty('useResponsesApi', true);
    });
  });

  describe('First-party endpoint declaration', () => {
    /**
     * The agents SDK gates its model-specific request constraints on this flag
     * and defaults them off, rather than inferring the endpoint from a base
     * URL. Only this layer can tell a faithful first-party route from a
     * gateway, so the decision is made here and declared downstream.
     */
    const configFor = (overrides: Record<string, unknown> = {}) =>
      getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: { model: 'gpt-6-astra' },
        ...overrides,
      });

    it('declares the first-party endpoint for canonical OpenAI', () => {
      expect(configFor().llmConfig).toHaveProperty('firstPartyEndpoint', true);
    });

    it('declares it for an explicit api.openai.com base URL', () => {
      expect(configFor({ baseURL: 'https://api.openai.com/v1' }).llmConfig).toHaveProperty(
        'firstPartyEndpoint',
        true,
      );
    });

    it('does not declare it for Azure serverless without Azure OpenAI configuration', () => {
      expect(configFor({ endpoint: EModelEndpoint.azureOpenAI }).llmConfig).not.toHaveProperty(
        'firstPartyEndpoint',
      );
    });

    it('does not declare it for a custom gateway base URL', () => {
      expect(configFor({ baseURL: 'https://gateway.internal/v1' }).llmConfig).not.toHaveProperty(
        'firstPartyEndpoint',
      );
    });

    it('does not declare it for a non-OpenAI endpoint', () => {
      expect(configFor({ endpoint: EModelEndpoint.custom }).llmConfig).not.toHaveProperty(
        'firstPartyEndpoint',
      );
    });
  });

  describe('Azure Astra routing', () => {
    const azure = {
      azureOpenAIApiInstanceName: 'test-instance',
      azureOpenAIApiDeploymentName: 'production-deployment',
      azureOpenAIApiVersion: '2025-04-01-preview',
      azureOpenAIApiKey: 'test-api-key',
    };
    const azureConfig = (overrides: Partial<Parameters<typeof getOpenAILLMConfig>[0]> = {}) =>
      getOpenAILLMConfig({
        azure,
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.azureOpenAI,
        modelOptions: { model: 'gpt-6-astra', max_tokens: 2048 },
        ...overrides,
      });

    it.each([
      undefined,
      'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
      'https://test-instance.openai.azure.com/openai/v1',
      'https://test-instance.services.ai.azure.com/openai/v1',
      'https://test-instance.cognitiveservices.azure.com/openai/v1',
      'https://test-instance.openai.azure.us/openai/v1',
      'https://test-instance.openai.azure.cn/openai/v1',
    ])('routes Azure Astra to Responses at %s and retains its model identity', (baseURL) => {
      expect(azureConfig({ baseURL }).llmConfig).toMatchObject({
        model: 'gpt-6-astra',
        useResponsesApi: true,
        firstPartyEndpoint: true,
        modelKwargs: { model: 'production-deployment', max_output_tokens: 2048 },
      });
    });

    it.each([
      { modelOptions: { model: 'gpt-6-astra-2026-09-03', max_tokens: 2048 } },
      { modelOptions: { model: 'gpt-4.1', max_tokens: 2048 }, addParams: { model: 'gpt-6-astra' } },
      { dropParams: ['reasoning_effort'] },
      { reasoningFormat: ReasoningParameterFormat.disabled },
    ])('routes using the effective model independently of reasoning: %j', (overrides) => {
      expect(azureConfig(overrides).llmConfig.useResponsesApi).toBe(true);
    });

    it.each([
      { modelOptions: { model: 'gpt-6-astra', max_tokens: 2048, useResponsesApi: false } },
      { addParams: { useResponsesApi: false } },
      { dropParams: ['useResponsesApi'] },
    ])('keeps Astra constraints on an explicit Chat Completions opt-out: %j', (overrides) => {
      const { llmConfig } = azureConfig(overrides);
      expect(llmConfig.useResponsesApi).not.toBe(true);
      expect(llmConfig).toMatchObject({
        model: 'gpt-6-astra',
        firstPartyEndpoint: true,
        azureOpenAIApiDeploymentName: 'production-deployment',
        modelKwargs: { model: 'production-deployment', max_completion_tokens: 2048 },
      });
    });

    it.each([
      { modelOptions: { model: 'gpt-5.4-mini' } },
      { addParams: { model: 'gpt-5.4-mini' } },
    ])('leaves other Azure models on the deployment name: %j', (overrides) => {
      const { llmConfig } = azureConfig(overrides);
      expect(llmConfig.useResponsesApi).not.toBe(true);
      expect(llmConfig).toMatchObject({
        model: 'production-deployment',
        firstPartyEndpoint: true,
      });
      expect(llmConfig.modelKwargs?.model).toBeUndefined();
    });

    it.each([
      'https://gateway.internal/openai/v1',
      'https://test-instance.openai.azure.com.example.org/openai/v1',
      'https://openai.azure.com/openai/v1',
      'not-a-url',
    ])('leaves gateway routing and request constraints unchanged: %s', (baseURL) => {
      const { llmConfig } = azureConfig({ baseURL });
      expect(llmConfig.useResponsesApi).not.toBe(true);
      expect(llmConfig.firstPartyEndpoint).toBeUndefined();
      expect(llmConfig.model).toBe('production-deployment');
    });
  });

  describe('GPT-5.6 Responses API Requirement', () => {
    it.each(['gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.6-sol', 'gpt-5.6'])(
      'should default to Responses API for %s when reasoning_effort is set',
      (model) => {
        const result = getOpenAILLMConfig({
          apiKey: 'test-api-key',
          streaming: true,
          endpoint: EModelEndpoint.openAI,
          modelOptions: {
            model,
            reasoning_effort: ReasoningEffort.high,
          },
        });

        expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
        expect(result.llmConfig.reasoning).toEqual({ effort: ReasoningEffort.high });
        expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
      },
    );

    it('should NOT default to Responses API without reasoning params', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).not.toHaveProperty('reasoning');
    });

    it('should NOT default to Responses API when reasoning_effort is none', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.none,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.none);
    });

    it('should respect an explicit useResponsesApi: false', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
          useResponsesApi: false,
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', false);
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
    });

    it.each(['gpt-5', 'gpt-5-pro', 'gpt-5.4-nano', 'gpt-5.5-preview', 'gpt-5-chat', 'o3-mini'])(
      'should NOT default to Responses API for %s',
      (model) => {
        const result = getOpenAILLMConfig({
          apiKey: 'test-api-key',
          streaming: true,
          endpoint: EModelEndpoint.openAI,
          modelOptions: {
            model,
            reasoning_effort: ReasoningEffort.high,
          },
        });

        expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
        expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
      },
    );

    it('should NOT default to Responses API for non-OpenAI endpoints', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: 'custom',
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning_effort', ReasoningEffort.high);
    });

    it('should default to Responses API when reasoning_effort comes from defaultParams', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        defaultParams: {
          reasoning_effort: ReasoningEffort.medium,
        },
        modelOptions: {
          model: 'gpt-5.6-terra',
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig.reasoning).toEqual({ effort: ReasoningEffort.medium });
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should evaluate the final model when addParams overrides it to GPT-5.6', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-4o',
          reasoning_effort: ReasoningEffort.high,
        },
        addParams: {
          model: 'gpt-5.6-terra',
        },
      });

      expect(result.llmConfig).toHaveProperty('model', 'gpt-5.6-terra');
      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig.reasoning).toEqual({ effort: ReasoningEffort.high });
    });

    it('should NOT default to Responses API when addParams overrides GPT-5.6 away', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
        addParams: {
          model: 'gpt-4.1',
        },
      });

      expect(result.llmConfig).toHaveProperty('model', 'gpt-4.1');
      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
    });

    it('should NOT default to Responses API when dropParams removes reasoning_effort', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
        dropParams: ['reasoning_effort'],
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should still default to Responses API when dropParams removes only the reasoning object', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
        dropParams: ['reasoning'],
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should NOT default to Responses API when dropParams removes useResponsesApi', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
        dropParams: ['useResponsesApi'],
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
    });

    it('should NOT default to Responses API for OpenRouter-backed OpenAI endpoints', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        useOpenRouter: true,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
    });

    it('should carry reasoning_mode and reasoning_context when defaulting to Responses API', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        modelOptions: {
          model: 'gpt-5.6',
          reasoning_effort: ReasoningEffort.high,
          reasoning_mode: ReasoningMode.pro,
          reasoning_context: ReasoningContext.all_turns,
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig.reasoning).toEqual({
        effort: ReasoningEffort.high,
        mode: ReasoningMode.pro,
        context: ReasoningContext.all_turns,
      });
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
      expect(result.llmConfig).not.toHaveProperty('reasoning_mode');
      expect(result.llmConfig).not.toHaveProperty('reasoning_context');
    });

    it('should NOT default to Responses API for a custom gateway base URL', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        baseURL: 'https://gateway.example.com/v1',
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).toHaveProperty('reasoning_effort', ReasoningEffort.high);
    });

    it('should default to Responses API for the canonical OpenAI base URL', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        baseURL: 'https://api.openai.com/v1',
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).toHaveProperty('useResponsesApi', true);
      expect(result.llmConfig.reasoning).toEqual({ effort: ReasoningEffort.high });
    });

    it('should NOT default to Responses API when reasoningFormat is disabled', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        endpoint: EModelEndpoint.openAI,
        reasoningFormat: ReasoningParameterFormat.disabled,
        modelOptions: {
          model: 'gpt-5.6-terra',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('useResponsesApi');
      expect(result.llmConfig).not.toHaveProperty('reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });
  });

  describe('Default and Add Parameters', () => {
    it('should apply default parameters when fields are undefined', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
        },
        defaultParams: {
          temperature: 0.5,
          topP: 0.9,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.5);
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });

    it('should NOT override existing values with default parameters', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: 0.8,
        },
        defaultParams: {
          temperature: 0.5,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.8);
    });

    it('should apply addParams and override defaults', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
        },
        defaultParams: {
          temperature: 0.5,
        },
        addParams: {
          temperature: 0.9,
          seed: 42,
        },
      });

      expect(result.llmConfig).toHaveProperty('temperature', 0.9);
      expect(result.llmConfig).toHaveProperty('seed', 42);
    });

    it('should handle unknown params via modelKwargs', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
        },
        addParams: {
          custom_param: 'custom_value',
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('custom_param', 'custom_value');
    });
  });

  describe('Drop Parameters', () => {
    it('should drop specified parameters', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          temperature: 0.7,
          topP: 0.9,
        },
        dropParams: ['temperature'],
      });

      expect(result.llmConfig).not.toHaveProperty('temperature');
      expect(result.llmConfig).toHaveProperty('topP', 0.9);
    });
  });

  describe('OpenRouter Configuration', () => {
    it('should include include_reasoning for OpenRouter when no reasoning_effort set', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'gpt-4',
        },
      });

      expect(result.llmConfig).toHaveProperty('include_reasoning', true);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
    });

    it('should use reasoning object for OpenRouter when reasoning_effort is set', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-3-sonnet',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
      expect(result.llmConfig).not.toHaveProperty('include_reasoning');
      expect(result.llmConfig).not.toHaveProperty('reasoning_effort');
    });

    it('should map OpenRouter adaptive Claude reasoning effort to enabled reasoning and verbosity', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          reasoning_effort: ReasoningEffort.high,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', ReasoningEffort.high);
      expect(result.llmConfig).not.toHaveProperty('include_reasoning');
    });

    it('should not override explicit OpenRouter verbosity for adaptive Claude models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-opus-4.7',
          verbosity: Verbosity.low,
          reasoning_effort: ReasoningEffort.xhigh,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', Verbosity.low);
    });

    it('should handle OpenRouter adaptive Claude model ids with latest routing prefix', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: '~anthropic/claude-4.7-opus-20260416',
          reasoning_effort: ReasoningEffort.xhigh,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', ReasoningEffort.xhigh);
    });

    it('should map extra-high OpenRouter Claude 4.6 effort to max verbosity', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          reasoning_effort: ReasoningEffort.xhigh,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', 'max');
    });

    it('should map OpenRouter adaptive Claude max effort to max verbosity', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          reasoning_effort: 'max' as ReasoningEffort,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', 'max');
    });

    it('should preserve extra-high OpenRouter verbosity for future adaptive Claude models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-5',
          reasoning_effort: ReasoningEffort.xhigh,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        enabled: true,
      });
      expect(result.llmConfig).toHaveProperty('verbosity', ReasoningEffort.xhigh);
    });

    it('should pass OpenRouter verbosity as a top-level parameter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          verbosity: Verbosity.high,
        },
      });

      expect(result.llmConfig).toHaveProperty('verbosity', Verbosity.high);
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should pass OpenRouter default verbosity as a top-level parameter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: {
          verbosity: Verbosity.high,
        },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });

      expect(result.llmConfig).toHaveProperty('verbosity', Verbosity.high);
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should pass OpenRouter max verbosity as a top-level parameter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        addParams: {
          verbosity: 'max',
        },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });

      expect(result.llmConfig).toHaveProperty('verbosity', 'max');
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should preserve provider-specific OpenRouter verbosity values', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        addParams: {
          verbosity: 'ultra',
        },
        modelOptions: {
          model: 'custom/openrouter-model',
        },
      });

      expect(result.llmConfig).toHaveProperty('verbosity', 'ultra');
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should pass OpenRouter Responses API verbosity under text', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        addParams: {
          verbosity: 'xhigh',
        },
        modelOptions: {
          model: 'anthropic/claude-opus-4.7',
          useResponsesApi: true,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('verbosity');
      expect(result.llmConfig.modelKwargs).toHaveProperty('text', {
        verbosity: 'xhigh',
      });
    });

    it('should pass adaptive OpenRouter Responses API effort verbosity under text', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: '~anthropic/claude-4.7-opus-20260416',
          useResponsesApi: true,
          reasoning_effort: ReasoningEffort.xhigh,
        },
      });

      expect(result.llmConfig).not.toHaveProperty('verbosity');
      expect(result.llmConfig.modelKwargs).toMatchObject({
        reasoning: { enabled: true },
        text: { verbosity: ReasoningEffort.xhigh },
      });
    });

    it('should let OpenRouter added verbosity override model verbosity', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        addParams: {
          verbosity: Verbosity.high,
        },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          verbosity: Verbosity.low,
        },
      });

      expect(result.llmConfig).toHaveProperty('verbosity', Verbosity.high);
      expect(result.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should disable adaptive Claude reasoning when OpenRouter reasoning_effort is none', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-opus-4.7',
          reasoning_effort: ReasoningEffort.none,
        },
      });

      expect(result.llmConfig).toHaveProperty('include_reasoning', false);
      expect(result.llmConfig).not.toHaveProperty('modelKwargs');
    });

    it('should exclude reasoning_summary from OpenRouter reasoning object', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-3-sonnet',
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.detailed,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
    });

    it('should exclude reasoning_mode and reasoning_context from OpenRouter reasoning object', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-3-sonnet',
          reasoning_effort: ReasoningEffort.high,
          reasoning_mode: ReasoningMode.pro,
          reasoning_context: ReasoningContext.all_turns,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', {
        effort: ReasoningEffort.high,
      });
    });

    it.each([ReasoningEffort.xhigh, ReasoningEffort.minimal, ReasoningEffort.none])(
      'should support OpenRouter effort level: %s',
      (effort) => {
        const result = getOpenAILLMConfig({
          apiKey: 'test-api-key',
          streaming: true,
          useOpenRouter: true,
          modelOptions: {
            model: 'openai/o3-mini',
            reasoning_effort: effort,
          },
        });

        expect(result.llmConfig.modelKwargs).toHaveProperty('reasoning', { effort });
        expect(result.llmConfig).not.toHaveProperty('include_reasoning');
      },
    );

    it('should fall back to include_reasoning when reasoning_effort is unset (empty string)', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-3-sonnet',
          reasoning_effort: ReasoningEffort.unset,
        },
      });

      expect(result.llmConfig).toHaveProperty('include_reasoning', true);
      expect(result.llmConfig).not.toHaveProperty('reasoning');
    });

    it('should pass promptCache only for OpenRouter', () => {
      const openRouterResult = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
          promptCache: true,
        } as Partial<t.OpenAIParameters & { promptCache?: boolean }>,
      });
      const openAIResult = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: false,
        modelOptions: {
          model: 'gpt-4o',
          promptCache: true,
        } as Partial<t.OpenAIParameters & { promptCache?: boolean }>,
      });

      expect(openRouterResult.llmConfig).toHaveProperty('promptCache', true);
      expect(openRouterResult.llmConfig.modelKwargs).toBeUndefined();
      expect(openAIResult.llmConfig).not.toHaveProperty('promptCache');
      expect(openAIResult.llmConfig.modelKwargs).toBeUndefined();
    });

    it('should resolve OpenRouter promptCache default/add/drop params', () => {
      const enabled = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });
      const disabled = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true },
        addParams: { promptCache: false },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });
      const dropped = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true },
        dropParams: ['promptCache'],
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });

      expect(enabled.llmConfig).toHaveProperty('promptCache', true);
      expect(disabled.llmConfig).not.toHaveProperty('promptCache');
      expect(dropped.llmConfig).not.toHaveProperty('promptCache');
    });

    it('should resolve OpenRouter promptCacheTtl default/add/drop params', () => {
      const fromDefault = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true, promptCacheTtl: '1h' },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });
      const overridden = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true, promptCacheTtl: '1h' },
        addParams: { promptCacheTtl: '5m' },
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });
      const dropped = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        defaultParams: { promptCache: true, promptCacheTtl: '1h' },
        dropParams: ['promptCacheTtl'],
        modelOptions: {
          model: 'anthropic/claude-sonnet-4.6',
        },
      });

      expect((fromDefault.llmConfig as Record<string, unknown>).promptCacheTtl).toBe('1h');
      expect((overridden.llmConfig as Record<string, unknown>).promptCacheTtl).toBe('5m');
      /** promptCache stays on, but the TTL is dropped so the SDK applies its default */
      expect(dropped.llmConfig).toHaveProperty('promptCache', true);
      expect((dropped.llmConfig as Record<string, unknown>).promptCacheTtl).toBeUndefined();
    });

    it('should set includeReasoningContent for DeepSeek models via OpenRouter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'deepseek/deepseek-v4-pro',
        },
      });

      expect(result.llmConfig).toHaveProperty('includeReasoningContent', true);
    });

    it('should set includeReasoningContent case-insensitively for OpenRouter DeepSeek models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'DeepSeek/DeepSeek-V4',
        },
      });

      expect(result.llmConfig).toHaveProperty('includeReasoningContent', true);
    });

    it('should set includeReasoningContent for OpenRouter DeepSeek models with the latest-routing `~` prefix', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: '~deepseek/deepseek-v4-pro',
        },
      });

      expect(result.llmConfig).toHaveProperty('includeReasoningContent', true);
    });

    it('should not set includeReasoningContent for non-DeepSeek OpenRouter models', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: true,
        modelOptions: {
          model: 'anthropic/claude-opus-4-7',
        },
      });

      expect(result.llmConfig).not.toHaveProperty('includeReasoningContent');
    });

    it('should set includeReasoningContent for DeepSeek-flavored models outside OpenRouter (custom proxies)', () => {
      const directLike = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: false,
        modelOptions: {
          model: 'deepseek-chat',
        },
      });
      expect(directLike.llmConfig).toHaveProperty('includeReasoningContent', true);

      const customProxy = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: false,
        modelOptions: {
          model: 'deepseek/deepseek-v4-pro',
        },
      });
      expect(customProxy.llmConfig).toHaveProperty('includeReasoningContent', true);
    });

    it('should not set includeReasoningContent for non-DeepSeek models outside OpenRouter', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        useOpenRouter: false,
        modelOptions: {
          model: 'gpt-4',
        },
      });

      expect(result.llmConfig).not.toHaveProperty('includeReasoningContent');
    });
  });

  describe('Verbosity Handling', () => {
    it('should add verbosity to modelKwargs', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          verbosity: Verbosity.high,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('verbosity', Verbosity.high);
    });

    it('should preserve provider-specific verbosity values in modelKwargs', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        defaultParams: {
          verbosity: 'detailed',
        },
        modelOptions: {
          model: 'custom-model',
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('verbosity', 'detailed');
    });

    it('should convert verbosity to text object with Responses API', () => {
      const result = getOpenAILLMConfig({
        apiKey: 'test-api-key',
        streaming: true,
        modelOptions: {
          model: 'gpt-4',
          verbosity: Verbosity.low,
        },
        addParams: {
          useResponsesApi: true,
        },
      });

      expect(result.llmConfig.modelKwargs).toHaveProperty('text', { verbosity: Verbosity.low });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('verbosity');
    });
  });
});

describe('extractDefaultParams', () => {
  it('should extract default values from param definitions', () => {
    const paramDefinitions = [
      { key: 'temperature', default: 0.7 },
      { key: 'maxTokens', default: 4096 },
      { key: 'noDefault' },
    ];

    const result = extractDefaultParams(paramDefinitions);

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 4096,
    });
  });

  it('should return undefined for undefined or non-array input', () => {
    expect(extractDefaultParams(undefined)).toBeUndefined();
    expect(extractDefaultParams(null as unknown as undefined)).toBeUndefined();
  });

  it('should handle empty array', () => {
    const result = extractDefaultParams([]);
    expect(result).toEqual({});
  });
});

describe('applyDefaultParams', () => {
  it('should apply defaults only when field is undefined', () => {
    const target: Record<string, unknown> = {
      temperature: 0.8,
      maxTokens: undefined,
    };

    const defaults = {
      temperature: 0.5,
      maxTokens: 4096,
      topP: 0.9,
    };

    applyDefaultParams(target, defaults);

    expect(target).toEqual({
      temperature: 0.8,
      maxTokens: 4096,
      topP: 0.9,
    });
  });
});
