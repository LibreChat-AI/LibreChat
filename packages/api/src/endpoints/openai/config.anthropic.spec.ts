import { AnthropicEffort } from 'librechat-data-provider';
import { FINE_GRAINED_TOOL_STREAMING_BETA } from '../anthropic/helpers';
import { getOpenAIConfig } from './config';

describe('getOpenAIConfig - Anthropic Compatibility', () => {
  describe('Anthropic via LiteLLM', () => {
    it('keeps Opus 5.5 effort in output_config without leaking the native SDK field', () => {
      const result = getOpenAIConfig('test-key', {
        modelOptions: { model: 'claude-opus-5-5', thinking: false, effort: AnthropicEffort.max },
        customParams: { defaultParamsEndpoint: 'anthropic' },
      });

      expect(result.llmConfig.modelKwargs?.output_config).toEqual({ effort: 'max' });
      expect(result.llmConfig.modelKwargs).not.toHaveProperty('outputConfig');
      expect(result.llmConfig.modelKwargs?.thinking).toMatchObject({
        type: 'adaptive',
        block_binding: { prefix_mismatch_behavior: 'drop_block' },
      });
    });

    it('should handle basic Anthropic configuration with defaultParamsEndpoint', () => {
      const apiKey = 'sk-xxxx';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-sonnet-4',
          user: 'some_user_id',
        },
        reverseProxyUrl: 'http://host.docker.internal:4000/v1',
        proxy: '',
        headers: {},
        addParams: undefined,
        dropParams: undefined,
        customParams: {
          defaultParamsEndpoint: 'anthropic',
          paramDefinitions: [],
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-xxxx',
          model: 'claude-sonnet-4',
          stream: true,
          maxTokens: 64000,
          modelKwargs: {
            metadata: {
              user_id: 'some_user_id',
            },
            thinking: {
              type: 'enabled',
              budget_tokens: 2000,
            },
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://host.docker.internal:4000/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle Claude 3.7 model with thinking enabled', () => {
      const apiKey = 'sk-yyyy';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.7-sonnet-20241022',
          user: 'user123',
          temperature: 0.7,
          thinking: true,
          thinkingBudget: 3000,
        },
        reverseProxyUrl: 'http://localhost:4000/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-yyyy',
          model: 'claude-3.7-sonnet-20241022',
          stream: true,
          temperature: 0.7,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'user123',
            },
            thinking: {
              type: 'enabled',
              budget_tokens: 3000,
            },
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://localhost:4000/v1',
          defaultHeaders: {
            'anthropic-beta': `token-efficient-tools-2025-02-19,output-128k-2025-02-19,${FINE_GRAINED_TOOL_STREAMING_BETA}`,
          },
        },
        tools: [],
      });
    });

    it('should handle Claude 3.7 model with thinking disabled (topP and topK included)', () => {
      const apiKey = 'sk-yyyy';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.7-sonnet-20241022',
          user: 'user123',
          temperature: 0.7,
          topP: 0.9,
          topK: 50,
          thinking: false,
        },
        reverseProxyUrl: 'http://localhost:4000/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-yyyy',
          model: 'claude-3.7-sonnet-20241022',
          stream: true,
          temperature: 0.7,
          topP: 0.9,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'user123',
            },
            topK: 50,
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://localhost:4000/v1',
          defaultHeaders: {
            'anthropic-beta': `token-efficient-tools-2025-02-19,output-128k-2025-02-19,${FINE_GRAINED_TOOL_STREAMING_BETA}`,
          },
        },
        tools: [],
      });
    });

    it('should handle Claude 3.5 sonnet with special headers', () => {
      const apiKey = 'sk-zzzz';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.5-sonnet-20240620',
          user: 'user456',
          maxOutputTokens: 4096,
        },
        reverseProxyUrl: 'https://api.anthropic.proxy.com/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-zzzz',
          model: 'claude-3.5-sonnet-20240620',
          stream: true,
          maxTokens: 4096,
          modelKwargs: {
            metadata: {
              user_id: 'user456',
            },
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'https://api.anthropic.proxy.com/v1',
          defaultHeaders: {
            'anthropic-beta': `max-tokens-3-5-sonnet-2024-07-15,${FINE_GRAINED_TOOL_STREAMING_BETA}`,
          },
        },
        tools: [],
      });
    });

    it('should apply custom headers and promptCache for models that support caching', () => {
      const apiKey = 'sk-custom';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3-sonnet',
        },
        reverseProxyUrl: 'http://custom.proxy/v1',
        headers: {
          'Custom-Header': 'custom-value',
          Authorization: 'Bearer custom-token',
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-custom',
          model: 'claude-3-sonnet',
          stream: true,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: undefined,
            },
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://custom.proxy/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
            'Custom-Header': 'custom-value',
            Authorization: 'Bearer custom-token',
          },
        },
        tools: [],
      });
    });

    it('should merge custom Anthropic beta headers with generated beta headers', () => {
      const apiKey = 'sk-custom-beta';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.5-sonnet-20240620',
        },
        reverseProxyUrl: 'http://custom.proxy/v1',
        headers: {
          'anthropic-beta': 'files-api-2025-04-14',
          'Custom-Header': 'custom-value',
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.configOptions?.defaultHeaders).toEqual({
        'anthropic-beta': `files-api-2025-04-14,max-tokens-3-5-sonnet-2024-07-15,${FINE_GRAINED_TOOL_STREAMING_BETA}`,
        'Custom-Header': 'custom-value',
      });
    });

    it('should handle models that do not match Claude patterns', () => {
      const apiKey = 'sk-other';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'gpt-4-turbo',
          user: 'userGPT',
          temperature: 0.8,
        },
        reverseProxyUrl: 'http://litellm:4000/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-other',
          model: 'gpt-4-turbo',
          stream: true,
          temperature: 0.8,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'userGPT',
            },
          },
        },
        configOptions: {
          baseURL: 'http://litellm:4000/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle dropParams correctly in Anthropic path', () => {
      const apiKey = 'sk-drop';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
          user: 'userDrop',
          temperature: 0.5,
          maxOutputTokens: 2048,
          topP: 0.9,
          topK: 40,
        },
        reverseProxyUrl: 'http://proxy.litellm/v1',
        dropParams: ['temperature', 'topK', 'metadata'],
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-drop',
          model: 'claude-3-opus-20240229',
          stream: true,
          topP: 0.9,
          maxTokens: 2048,
          modelKwargs: {
            promptCache: true,
          },
          // temperature is dropped
          // modelKwargs.topK is dropped
          // modelKwargs.metadata is dropped completely
        },
        configOptions: {
          baseURL: 'http://proxy.litellm/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle empty user string', () => {
      const apiKey = 'sk-edge';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-2.1',
          user: '',
          temperature: 0,
        },
        reverseProxyUrl: 'http://litellm/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-edge',
          model: 'claude-2.1',
          stream: true,
          temperature: 0,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: '',
            },
          },
        },
        configOptions: {
          baseURL: 'http://litellm/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle web_search tool', () => {
      const apiKey = 'sk-search';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
          user: 'searchUser',
          web_search: true,
        },
        reverseProxyUrl: 'http://litellm/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-search',
          model: 'claude-3-opus-20240229',
          stream: true,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'searchUser',
            },
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://litellm/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
      });
    });

    it('should properly transform Anthropic config with invocationKwargs', () => {
      const apiKey = 'sk-test';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.5-haiku-20241022',
          user: 'testUser',
          topP: 0.9,
          topK: 40,
        },
        reverseProxyUrl: 'http://litellm/v1',
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-test',
          model: 'claude-3.5-haiku-20241022',
          stream: true,
          topP: 0.9,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'testUser',
            },
            topK: 40,
            promptCache: true,
          },
        },
        configOptions: {
          baseURL: 'http://litellm/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle addParams with Anthropic defaults', () => {
      const apiKey = 'sk-add';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
          user: 'addUser',
          temperature: 0.7,
        },
        reverseProxyUrl: 'http://litellm/v1',
        addParams: {
          customParam1: 'value1',
          customParam2: 42,
          frequencyPenalty: 0.5, // Known OpenAI param
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-add',
          model: 'claude-3-opus-20240229',
          stream: true,
          temperature: 0.7,
          frequencyPenalty: 0.5, // Known param added to main config
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'addUser',
            },
            promptCache: true,
            customParam1: 'value1', // Unknown params added to modelKwargs
            customParam2: 42,
          },
        },
        configOptions: {
          baseURL: 'http://litellm/v1',
          defaultHeaders: {
            'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
          },
        },
        tools: [],
      });
    });

    it('should handle both addParams and dropParams together', () => {
      const apiKey = 'sk-both';
      const endpoint = 'Anthropic (via LiteLLM)';
      const options = {
        modelOptions: {
          model: 'claude-3.5-sonnet-20240620',
          user: 'bothUser',
          temperature: 0.6,
          topP: 0.9,
          topK: 40,
        },
        reverseProxyUrl: 'http://litellm/v1',
        addParams: {
          customParam: 'customValue',
          maxRetries: 3, // Known OpenAI param
        },
        dropParams: ['temperature', 'topK'], // Drop one known and one unknown param
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        endpoint: 'Anthropic (via LiteLLM)',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          apiKey: 'sk-both',
          model: 'claude-3.5-sonnet-20240620',
          stream: true,
          topP: 0.9,
          maxRetries: 3,
          maxTokens: 8192,
          modelKwargs: {
            metadata: {
              user_id: 'bothUser',
            },
            promptCache: true,
            customParam: 'customValue',
            // topK is dropped
          },
        },
        configOptions: {
          baseURL: 'http://litellm/v1',
          defaultHeaders: {
            'anthropic-beta': `max-tokens-3-5-sonnet-2024-07-15,${FINE_GRAINED_TOOL_STREAMING_BETA}`,
          },
        },
        tools: [],
      });
    });
  });

  describe('Web Search Support via addParams', () => {
    it('should enable web_search tool when web_search: true in addParams', () => {
      const apiKey = 'sk-web-search';
      const endpoint = 'Anthropic (Custom)';
      const options = {
        modelOptions: {
          model: 'claude-3-5-sonnet-latest',
          user: 'search-user',
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        addParams: {
          web_search: true,
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.tools).toEqual([
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ]);
      expect(result.llmConfig).toMatchObject({
        model: 'claude-3-5-sonnet-latest',
        stream: true,
      });
    });

    it('should disable web_search tool when web_search: false in addParams', () => {
      const apiKey = 'sk-no-search';
      const endpoint = 'Anthropic (Custom)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
          web_search: true, // This should be overridden by addParams
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        addParams: {
          web_search: false,
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.tools).toEqual([]);
    });

    it('should disable web_search when in dropParams', () => {
      const apiKey = 'sk-drop-search';
      const endpoint = 'Anthropic (Custom)';
      const options = {
        modelOptions: {
          model: 'claude-3-5-sonnet-latest',
          web_search: true,
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        dropParams: ['web_search'],
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.tools).toEqual([]);
    });

    it('should handle web_search with mixed Anthropic and OpenAI params in addParams', () => {
      const apiKey = 'sk-mixed';
      const endpoint = 'Anthropic (Custom)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
          user: 'mixed-user',
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        addParams: {
          web_search: true,
          temperature: 0.7, // Anthropic native
          maxRetries: 3, // OpenAI param (known), should go to top level
          customParam: 'custom', // Unknown param, should go to modelKwargs
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.tools).toEqual([
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ]);
      expect(result.llmConfig.temperature).toBe(0.7);
      expect(result.llmConfig.maxRetries).toBe(3); // Known OpenAI param at top level
      expect(result.llmConfig.modelKwargs).toMatchObject({
        customParam: 'custom', // Unknown param in modelKwargs
        metadata: { user_id: 'mixed-user' }, // From invocationKwargs
      });
    });

    it('should handle Anthropic native params in addParams without web_search', () => {
      const apiKey = 'sk-native';
      const endpoint = 'Anthropic (Custom)';
      const options = {
        modelOptions: {
          model: 'claude-3-opus-20240229',
        },
        customParams: {
          defaultParamsEndpoint: 'anthropic',
        },
        addParams: {
          temperature: 0.9,
          topP: 0.95,
          maxTokens: 4096,
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result.llmConfig).toMatchObject({
        model: 'claude-3-opus-20240229',
        temperature: 0.9,
        topP: 0.95,
        maxTokens: 4096,
      });
      expect(result.tools).toEqual([]);
    });

    describe('defaultParams Support via customParams', () => {
      it('should apply defaultParams when fields are undefined', () => {
        const apiKey = 'sk-defaults';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-5-sonnet-20241022',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topP', default: 0.9 },
              { key: 'maxRetries', default: 5 },
            ],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.topP).toBe(0.9);
        expect(result.llmConfig.maxRetries).toBe(5);
      });

      it('should not override existing modelOptions with defaultParams', () => {
        const apiKey = 'sk-override';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-5-sonnet-20241022',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.5 },
              { key: 'topP', default: 0.8 },
            ],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.topP).toBe(0.8);
      });

      it('should allow addParams to override defaultParams', () => {
        const apiKey = 'sk-add-override';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-opus-20240229',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.5 },
              { key: 'topP', default: 0.7 },
            ],
          },
          addParams: {
            temperature: 0.8,
            topP: 0.95,
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
        expect(result.llmConfig.topP).toBe(0.95);
      });

      it('should handle defaultParams with web_search', () => {
        const apiKey = 'sk-web-default';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-5-sonnet-latest',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.tools).toEqual([
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ]);
      });

      it('should allow addParams to override defaultParams web_search', () => {
        const apiKey = 'sk-web-override';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-opus-20240229',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [{ key: 'web_search', default: true }],
          },
          addParams: {
            web_search: false,
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.tools).toEqual([]);
      });

      it('should handle dropParams overriding defaultParams', () => {
        const apiKey = 'sk-drop';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-opus-20240229',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topP', default: 0.9 },
              { key: 'web_search', default: true },
            ],
          },
          dropParams: ['topP', 'web_search'],
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.topP).toBeUndefined();
        expect(result.tools).toEqual([]);
      });

      it('should preserve order: defaultParams < addParams < modelOptions', () => {
        const apiKey = 'sk-precedence';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-5-sonnet-20241022',
            temperature: 0.9,
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.3 },
              { key: 'topP', default: 0.5 },
              { key: 'timeout', default: 60000 },
            ],
          },
          addParams: {
            topP: 0.8,
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.9);
        expect(result.llmConfig.topP).toBe(0.8);
        expect(result.llmConfig.timeout).toBe(60000);
      });

      it('should handle Claude 3.7 with defaultParams and thinking disabled', () => {
        const apiKey = 'sk-37-defaults';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3.7-sonnet-20241022',
            thinking: false,
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topP', default: 0.9 },
              { key: 'topK', default: 50 },
            ],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.topP).toBe(0.9);
        expect(result.llmConfig.modelKwargs?.topK).toBe(50);
      });

      it('should handle empty paramDefinitions', () => {
        const apiKey = 'sk-empty';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-opus-20240229',
            temperature: 0.8,
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
      });

      it('should handle missing paramDefinitions', () => {
        const apiKey = 'sk-missing';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-opus-20240229',
            temperature: 0.8,
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.8);
      });

      it('should handle mixed Anthropic params in defaultParams', () => {
        const apiKey = 'sk-mixed';
        const result = getOpenAIConfig(apiKey, {
          modelOptions: {
            model: 'claude-3-5-sonnet-20241022',
          },
          customParams: {
            defaultParamsEndpoint: 'anthropic',
            paramDefinitions: [
              { key: 'temperature', default: 0.7 },
              { key: 'topP', default: 0.9 },
              { key: 'maxRetries', default: 3 },
            ],
          },
          reverseProxyUrl: 'https://api.anthropic.com',
        });

        expect(result.llmConfig.temperature).toBe(0.7);
        expect(result.llmConfig.topP).toBe(0.9);
        expect(result.llmConfig.maxRetries).toBe(3);
      });
    });
  });
});
