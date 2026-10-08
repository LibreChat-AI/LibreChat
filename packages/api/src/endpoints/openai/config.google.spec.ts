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

      it.each(['gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.8-flash'])(
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
  });
});
