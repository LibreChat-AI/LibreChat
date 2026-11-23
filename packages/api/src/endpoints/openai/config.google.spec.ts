import { ReasoningParameterFormat } from 'librechat-data-provider';
import { getOpenAIConfig } from './config';

describe('getOpenAIConfig - Google Compatibility', () => {
  describe('Google via Custom Endpoint', () => {
    describe('Web Search Support via addParams', () => {
      it('should enable googleSearch tool when web_search: true in addParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          addParams: {
            web_search: true,
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.tools).toEqual([{ googleSearch: {} }]);
        expect(result.llmConfig).toMatchObject({
          model: 'gemini-2.0-flash-exp',
        });
      });

      it('should disable googleSearch tool when web_search: false in addParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            web_search: true, // Should be overridden by addParams
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          addParams: {
            web_search: false,
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.tools).toEqual([]);
      });

      it('should disable googleSearch when in dropParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            web_search: true,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          dropParams: ['web_search'],
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.tools).toEqual([]);
      });

      it('should filter out googleSearch when web_search is only in modelOptions (not explicitly in addParams/defaultParams)', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            web_search: true,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        /** googleSearch should be filtered out since web_search was not explicitly added via addParams or defaultParams */
        expect(result.tools).toEqual([]);
      });

      it('should handle web_search with mixed Google and OpenAI params in addParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          addParams: {
            web_search: true,
            temperature: 0.8, // Shared param (both Google and OpenAI)
            topK: 40, // Google-only param, goes to modelKwargs
            frequencyPenalty: 0.5, // Known OpenAI param, goes to top level
            customUnknown: 'test', // Unknown param, goes to modelKwargs
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.tools).toEqual([{ googleSearch: {} }]);
        expect(result.llmConfig.temperature).toBe(0.8); // Shared param at top level
        expect(result.llmConfig.frequencyPenalty).toBe(0.5); // Known OpenAI param at top level
        expect(result.llmConfig.modelKwargs).toMatchObject({
          topK: 40, // Google-specific in modelKwargs
          customUnknown: 'test', // Unknown param in modelKwargs
        });
      });

      it('should handle Google native params in addParams without web_search', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          addParams: {
            temperature: 0.9, // Shared param (both Google and OpenAI)
            topP: 0.95, // Shared param (both Google and OpenAI)
            topK: 50, // Google-only, goes to modelKwargs
            maxOutputTokens: 8192, // Google-only, goes to modelKwargs
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.llmConfig).toMatchObject({
          model: 'gemini-2.0-flash-exp',
          temperature: 0.9, // Shared params at top level
          topP: 0.95,
        });
        expect(result.llmConfig.modelKwargs).toMatchObject({
          topK: 50, // Google-specific in modelKwargs
          maxOutputTokens: 8192,
        });
        expect(result.tools).toEqual([]);
      });

      it.each(['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash', 'gemini-4-argon'])(
        'should strip Flash-blocked addParams so the transform cannot re-add them (%s)',
        (model) => {
          const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
          const endpoint = 'Gemini (Custom)';
          const options = {
            modelOptions: {
              model,
            },
            customParams: {
              defaultParamsEndpoint: 'google',
            },
            addParams: {
              temperature: 0.8,
              topP: 0.95,
              topK: 40,
              presencePenalty: 0.5,
              frequencyPenalty: 0.5,
              maxOutputTokens: 8192, // Supported Google param, should survive
            },
            reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          };

          const result = getOpenAIConfig(apiKey, options, endpoint);

          expect(result.llmConfig).not.toHaveProperty('temperature');
          expect(result.llmConfig).not.toHaveProperty('topP');
          expect(result.llmConfig).not.toHaveProperty('presencePenalty');
          expect(result.llmConfig).not.toHaveProperty('frequencyPenalty');
          expect(result.llmConfig.modelKwargs ?? {}).not.toHaveProperty('topK');
          expect(result.llmConfig.modelKwargs ?? {}).not.toHaveProperty('presencePenalty');
          expect(result.llmConfig.modelKwargs).toMatchObject({ maxOutputTokens: 8192 });
        },
      );

      it.each([
        ['gemini-4-argon', false],
        ['gemini-3.8-flash', true],
      ])(
        'should strip candidate-count addParams only where the model rejects them (%s)',
        (model, kept) => {
          const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
          const options = {
            modelOptions: { model },
            customParams: { defaultParamsEndpoint: 'google' },
            addParams: { candidateCount: 2, candidate_count: 2, n: 2 },
            reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          };

          const result = getOpenAIConfig(apiKey, options, 'Gemini (Custom)');
          const sent = { ...result.llmConfig, ...(result.llmConfig.modelKwargs ?? {}) };

          for (const key of ['candidateCount', 'candidate_count', 'n']) {
            expect(Object.prototype.hasOwnProperty.call(sent, key)).toBe(kept);
          }
        },
      );

      it('should drop Google native params with dropParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            temperature: 0.7,
            topK: 40,
            topP: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          dropParams: ['topK', 'topP'],
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.llmConfig.temperature).toBe(0.7);
        expect((result.llmConfig as Record<string, unknown>).topK).toBeUndefined();
        expect(result.llmConfig.topP).toBeUndefined();
      });

      it('should handle both addParams and dropParams for Google', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const endpoint = 'Gemini (Custom)';
        const options = {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            topK: 30, // Will be dropped
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          addParams: {
            web_search: true,
            temperature: 0.8, // Shared param
            maxOutputTokens: 4096, // Google-only param
          },
          dropParams: ['topK'],
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        };

        const result = getOpenAIConfig(apiKey, options, endpoint);

        expect(result.tools).toEqual([{ googleSearch: {} }]);
        expect(result.llmConfig).toMatchObject({
          model: 'gemini-2.0-flash-exp',
          temperature: 0.8,
        });
        expect(result.llmConfig.modelKwargs).toMatchObject({
          maxOutputTokens: 4096, // Google-specific in modelKwargs
        });
        expect((result.llmConfig as Record<string, unknown>).topK).toBeUndefined();
        // Verify topK is not in modelKwargs either
        expect(result.llmConfig.modelKwargs?.topK).toBeUndefined();
      });
    });

    describe('URL Context Support via addParams', () => {
      const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
      const endpoint = 'Gemini (Custom)';
      const reverseProxyUrl = 'https://generativelanguage.googleapis.com/v1beta/openai';

      it('should enable urlContext tool when url_context: true in addParams', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash' },
            customParams: { defaultParamsEndpoint: 'google' },
            addParams: { url_context: true },
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toEqual([{ urlContext: {} }]);
      });

      it('should disable urlContext tool when url_context: false in addParams', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash', url_context: true },
            customParams: { defaultParamsEndpoint: 'google' },
            addParams: { url_context: false },
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toEqual([]);
      });

      it('should disable urlContext when in dropParams', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash', url_context: true },
            customParams: { defaultParamsEndpoint: 'google' },
            dropParams: ['url_context'],
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toEqual([]);
      });

      it('should filter out urlContext when url_context is only in modelOptions', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash', url_context: true },
            customParams: { defaultParamsEndpoint: 'google' },
            reverseProxyUrl,
          },
          endpoint,
        );

        /** urlContext is filtered since url_context was not explicitly added via addParams/defaultParams */
        expect(result.tools).toEqual([]);
      });

      it('should not enable urlContext on a model that does not support it (Gemini < 2.5)', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.0-flash-exp' },
            customParams: { defaultParamsEndpoint: 'google' },
            addParams: { url_context: true },
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toEqual([]);
      });

      it('should enable urlContext via defaultParams', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash' },
            customParams: {
              defaultParamsEndpoint: 'google',
              paramDefinitions: [{ key: 'url_context', default: true }],
            },
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toEqual([{ urlContext: {} }]);
      });

      it('should preserve both googleSearch and urlContext when both are enabled via addParams', () => {
        const result = getOpenAIConfig(
          apiKey,
          {
            modelOptions: { model: 'gemini-2.5-flash' },
            customParams: { defaultParamsEndpoint: 'google' },
            addParams: { web_search: true, url_context: true },
            reverseProxyUrl,
          },
          endpoint,
        );

        expect(result.tools).toContainEqual({ googleSearch: {} });
        expect(result.tools).toContainEqual({ urlContext: {} });
      });
    });

    describe('defaultParams Support via customParams', () => {
      it('should apply defaultParams when fields are undefined', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const result = getOpenAIConfig(apiKey, {
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

      it('should not override existing modelOptions with defaultParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [
              { key: 'temperature', default: 0.5 },
              { key: 'topK', default: 40 },
            ],
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.modelKwargs?.topK).toBe(40);
      });

      it('should allow addParams to override defaultParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [
              { key: 'temperature', default: 0.5 },
              { key: 'topK', default: 30 },
            ],
          },
          addParams: {
            temperature: 0.8,
            topK: 50,
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
        expect(result.llmConfig.modelKwargs?.topK).toBe(50);
      });

      it('should handle defaultParams with web_search', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.tools).toEqual([{ googleSearch: {} }]);
      });

      it('should allow addParams to override defaultParams web_search', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
          addParams: {
            web_search: false,
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.tools).toEqual([]);
      });

      it('should handle dropParams overriding defaultParams', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topK', default: 40 },
              { key: 'web_search', default: true },
            ],
          },
          dropParams: ['topK', 'web_search'],
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.modelKwargs?.topK).toBeUndefined();
        expect(result.tools).toEqual([]);
      });

      it('should preserve order: defaultParams < addParams < modelOptions', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [
              { key: 'temperature', default: 0.3 },
              { key: 'topP', default: 0.5 },
              { key: 'topK', default: 20 },
            ],
          },
          addParams: {
            topP: 0.8,
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.topP).toBe(0.8);
        expect(result.llmConfig.modelKwargs?.topK).toBe(20);
      });

      it('should handle empty paramDefinitions', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            temperature: 0.8,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
            paramDefinitions: [],
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
      });

      it('should handle missing paramDefinitions', () => {
        const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });

        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'gemini-2.0-flash-exp',
            temperature: 0.8,
          },
          customParams: {
            defaultParamsEndpoint: 'google',
          },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
      });
    });

    describe('Thinking level as reasoning_effort', () => {
      const apiKey = JSON.stringify({ GOOGLE_API_KEY: 'test-google-key' });
      type ConfigOptions = NonNullable<Parameters<typeof getOpenAIConfig>[1]>;

      /** Builds the Google-compatible custom endpoint config for one model selection. */
      function getGeminiConfig(
        modelOptions: object,
        rest: Omit<ConfigOptions, 'modelOptions'> = {},
        customParams: ConfigOptions['customParams'] = {},
      ) {
        const options: ConfigOptions = {
          modelOptions,
          customParams: { defaultParamsEndpoint: 'google', ...customParams },
          reverseProxyUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
          ...rest,
        };
        return getOpenAIConfig(apiKey, options, 'Gemini (Custom)');
      }

      const sentEffort = (result: ReturnType<typeof getOpenAIConfig>) =>
        result.llmConfig.modelKwargs?.reasoning_effort;

      it.each([
        ['minimal', 'minimal'],
        ['low', 'low'],
        ['medium', 'medium'],
        ['high', 'high'],
        ['HIGH', 'high'],
      ])('sends an explicit %s thinking level as reasoning_effort %s', (thinkingLevel, effort) => {
        const result = getGeminiConfig({ model: 'gemini-3.1-pro-preview', thinkingLevel });

        expect(result.llmConfig.modelKwargs).toMatchObject({ reasoning_effort: effort });
        expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
        expect(result.llmConfig.modelKwargs).not.toHaveProperty('thinkingConfig');
        expect(result.llmConfig.modelKwargs).not.toHaveProperty('thinkingLevel');
      });

      it.each([undefined, '', 'THINKING_LEVEL_UNSPECIFIED'])(
        'sends no reasoning_effort when the thinking level is %j so the model default applies',
        (thinkingLevel) => {
          const result = getGeminiConfig({ model: 'gemini-3.1-pro-preview', thinkingLevel });

          expect(sentEffort(result)).toBeUndefined();
        },
      );

      it.each([
        'gemini-3.5-flash',
        'gemini-3.5-flash-lite',
        'gemini-3.6-flash',
        'gemini-3.7-flash',
        'gemini-3.8-flash',
        'gemini-4-argon',
        'gemini-4-argon-cyber-permissive',
      ])('does not forward the default level a Flash model fills in (%s)', (model) => {
        const result = getGeminiConfig({ model });

        expect(sentEffort(result)).toBeUndefined();
      });

      it.each([
        ['gemini-4-argon', 'minimal', 'low'],
        ['gemini-4-argon', 'high', 'high'],
        ['gemini-4-argon-cyber-permissive', 'low', 'low'],
        ['gemini-3.8-flash', 'minimal', 'low'],
        ['gemini-3.7-flash', 'minimal', 'low'],
        ['gemini-3.6-flash', 'minimal', 'minimal'],
        ['gemini-3.5-flash-lite', 'minimal', 'minimal'],
        ['gemini-3.5-flash', 'low', 'low'],
      ])('sends %s thinking level %s as reasoning_effort %s', (model, thinkingLevel, effort) => {
        const result = getGeminiConfig({ model, thinkingLevel });

        expect(sentEffort(result)).toBe(effort);
      });

      it('sends no reasoning_effort when thinking is turned off', () => {
        const result = getGeminiConfig({
          model: 'gemini-3.1-pro-preview',
          thinking: false,
          thinkingLevel: 'high',
        });

        expect(sentEffort(result)).toBeUndefined();
      });

      it('leaves thinkingBudget unsent and adds no reasoning_effort before Gemini 3', () => {
        const result = getGeminiConfig({
          model: 'gemini-2.5-pro',
          thinkingBudget: 2048,
          thinkingLevel: 'high',
        });
        const kwargs = result.llmConfig.modelKwargs ?? {};

        expect(sentEffort(result)).toBeUndefined();
        expect(result.llmConfig).not.toHaveProperty('thinkingConfig');
        expect(kwargs).not.toHaveProperty('thinkingConfig');
        expect(kwargs).not.toHaveProperty('thinkingBudget');
      });

      it('lets an addParams reasoning_effort replace the selected thinking level', () => {
        const result = getGeminiConfig(
          { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' },
          { addParams: { reasoning_effort: 'high' } },
        );

        expect(sentEffort(result)).toBe('high');
      });

      it('keeps an addParams reasoning object instead of adding reasoning_effort beside it', () => {
        const result = getGeminiConfig(
          { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' },
          { addParams: { reasoning: { effort: 'medium' } } },
        );

        expect(result.llmConfig.reasoning).toEqual({ effort: 'medium' });
        expect(sentEffort(result)).toBeUndefined();
      });

      it.each(['thinking_config', 'thinkingConfig'])(
        'does not send reasoning_effort beside an addParams Google %s',
        (key) => {
          const extraBody = { google: { [key]: { thinking_level: 'high' } } };
          const result = getGeminiConfig(
            { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' },
            { addParams: { extra_body: extraBody } },
          );

          expect(result.llmConfig.modelKwargs?.extra_body).toEqual(extraBody);
          expect(sentEffort(result)).toBeUndefined();
        },
      );

      it.each([
        ['gemini-3.1-pro-preview', 'reasoning_effort'],
        ['gemini-3.1-pro-preview', 'thinkingLevel'],
        ['gemini-3.1-pro-preview', 'thinkingConfig'],
        ['gemini-3.7-flash', 'reasoning_effort'],
        ['gemini-3.7-flash', 'thinkingLevel'],
        ['gemini-3.7-flash', 'thinkingConfig'],
      ])('sends no reasoning_effort for %s when %s is in dropParams', (model, param) => {
        const result = getGeminiConfig({ model, thinkingLevel: 'high' }, { dropParams: [param] });

        expect(sentEffort(result)).toBeUndefined();
      });

      it('keeps an addParams reasoning_effort when only thinkingLevel is dropped', () => {
        const result = getGeminiConfig(
          { model: 'gemini-3.1-pro-preview', thinkingLevel: 'high' },
          { addParams: { reasoning_effort: 'low' }, dropParams: ['thinkingLevel'] },
        );

        expect(sentEffort(result)).toBe('low');
      });

      it('sends no reasoning_effort when the endpoint disables reasoning parameters', () => {
        const result = getGeminiConfig(
          { model: 'gemini-3.1-pro-preview', thinkingLevel: 'high' },
          {},
          { reasoningFormat: ReasoningParameterFormat.disabled },
        );

        expect(sentEffort(result)).toBeUndefined();
      });

      describe('configured default', () => {
        const withDefault = (level: string | number) => ({
          paramDefinitions: [{ key: 'thinkingLevel', default: level }],
        });

        it('sends the endpoint default thinking level when none is selected', () => {
          const result = getGeminiConfig(
            { model: 'gemini-3.1-pro-preview' },
            {},
            withDefault('high'),
          );

          expect(sentEffort(result)).toBe('high');
        });

        it.each([undefined, ''])(
          'sends the endpoint default when the selected thinking level is %j',
          (thinkingLevel) => {
            const result = getGeminiConfig(
              { model: 'gemini-3.1-pro-preview', thinkingLevel },
              {},
              withDefault('medium'),
            );

            expect(sentEffort(result)).toBe('medium');
          },
        );

        it('lets a selected thinking level replace the endpoint default', () => {
          const result = getGeminiConfig(
            { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' },
            {},
            withDefault('high'),
          );

          expect(sentEffort(result)).toBe('low');
        });

        it.each([
          ['gemini-3.7-flash', 'minimal', 'low'],
          ['gemini-3.5-flash', 'high', 'high'],
        ])('applies the model rules to the endpoint default (%s %s)', (model, level, effort) => {
          const result = getGeminiConfig({ model }, {}, withDefault(level));

          expect(sentEffort(result)).toBe(effort);
        });

        it.each([['unset'], [''], [7], ['THINKING_LEVEL_UNSPECIFIED']])(
          'sends nothing for the unusable endpoint default %j',
          (level) => {
            for (const model of ['gemini-3.1-pro-preview', 'gemini-3.5-flash']) {
              expect(
                sentEffort(getGeminiConfig({ model }, {}, withDefault(level))),
              ).toBeUndefined();
            }
          },
        );

        it.each([
          ['before Gemini 3', { model: 'gemini-2.5-pro' }, {}],
          ['with thinking off', { model: 'gemini-3.1-pro-preview', thinking: false }, {}],
          [
            'with thinkingLevel dropped',
            { model: 'gemini-3.1-pro-preview' },
            { dropParams: ['thinkingLevel'] },
          ],
          [
            'with reasoning_effort dropped',
            { model: 'gemini-3.1-pro-preview' },
            { dropParams: ['reasoning_effort'] },
          ],
        ])('sends no endpoint default %s', (_name, modelOptions, rest) => {
          const result = getGeminiConfig(modelOptions, rest, withDefault('high'));

          expect(sentEffort(result)).toBeUndefined();
        });
      });
    });
  });
});
