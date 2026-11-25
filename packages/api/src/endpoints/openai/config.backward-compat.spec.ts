import {
  Verbosity,
  EModelEndpoint,
  ReasoningEffort,
  ReasoningSummary,
} from 'librechat-data-provider';
import { getOpenAIConfig } from './config';

describe('getOpenAIConfig - Backward Compatibility', () => {
  describe('OpenAI endpoint', () => {
    it('should handle GPT-5 model with reasoning and web search', () => {
      const apiKey = 'sk-proj-somekey';
      const endpoint = EModelEndpoint.openAI;
      const options = {
        modelOptions: {
          model: 'gpt-5-nano',
          verbosity: Verbosity.high,
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.detailed,
          useResponsesApi: true,
          web_search: true,
          user: 'some-user',
        },
        proxy: '',
        reverseProxyUrl: null,
        endpoint: EModelEndpoint.openAI,
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'gpt-5-nano',
          useResponsesApi: true,
          firstPartyEndpoint: true,
          user: 'some-user',
          apiKey: 'sk-proj-somekey',
          reasoning: {
            effort: ReasoningEffort.high,
            summary: ReasoningSummary.detailed,
          },
          modelKwargs: {
            text: {
              verbosity: Verbosity.high,
            },
          },
        },
        configOptions: {},
        tools: [
          {
            type: 'web_search',
          },
        ],
      });
    });
  });

  describe('OpenRouter endpoint', () => {
    it('should handle OpenRouter configuration with dropParams and custom headers', () => {
      const apiKey = 'sk-xxxx';
      const endpoint = 'OpenRouter';
      const options = {
        modelOptions: {
          model: 'qwen/qwen3-max',
          user: 'some-user',
        },
        reverseProxyUrl: 'https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/openrouter',
        headers: {
          'x-librechat-thread-id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          'x-test-key': '{{TESTING_USER_VAR}}',
        },
        proxy: '',
        dropParams: ['user'],
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'qwen/qwen3-max',
          include_reasoning: true,
          promptCache: true,
          apiKey: 'sk-xxxx',
        },
        configOptions: {
          baseURL: 'https://gateway.ai.cloudflare.com/v1/account-id/gateway-id/openrouter',
          defaultHeaders: {
            'HTTP-Referer': 'https://librechat.ai',
            'X-Title': 'LibreChat',
            'X-OpenRouter-Title': 'LibreChat',
            'X-OpenRouter-Categories': 'general-chat,personal-agent,programming-app',
            'x-librechat-thread-id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
            'x-test-key': '{{TESTING_USER_VAR}}',
          },
        },
        tools: [],
        provider: 'openrouter',
      });
    });
  });

  describe('Azure OpenAI endpoint', () => {
    it('should handle basic Azure OpenAI configuration', () => {
      const apiKey = 'some_key';
      const endpoint = undefined;
      const options = {
        modelOptions: {
          model: 'gpt-4o',
          user: 'some_user_id',
        },
        reverseProxyUrl: null,
        endpoint: 'azureOpenAI',
        azure: {
          azureOpenAIApiKey: 'some_azure_key',
          azureOpenAIApiInstanceName: 'some_instance_name',
          azureOpenAIApiDeploymentName: 'gpt-4o',
          azureOpenAIApiVersion: '2024-02-15-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'gpt-4o',
          user: 'some_user_id',
          azureOpenAIApiKey: 'some_azure_key',
          azureOpenAIApiInstanceName: 'some_instance_name',
          azureOpenAIApiDeploymentName: 'gpt-4o',
          azureOpenAIApiVersion: '2024-02-15-preview',
        },
        configOptions: {},
        tools: [],
      });
    });

    it('should handle Azure OpenAI with Responses API and reasoning', () => {
      const apiKey = 'some_azure_key';
      const endpoint = EModelEndpoint.azureOpenAI;
      const options = {
        modelOptions: {
          model: 'gpt-5',
          reasoning_effort: ReasoningEffort.high,
          reasoning_summary: ReasoningSummary.detailed,
          verbosity: Verbosity.high,
          useResponsesApi: true,
          user: 'some_user_id',
        },
        endpoint: 'azureOpenAI',
        azure: {
          azureOpenAIApiKey: 'some_azure_key',
          azureOpenAIApiInstanceName: 'some_instance_name',
          azureOpenAIApiDeploymentName: 'gpt-5',
          azureOpenAIApiVersion: '2024-12-01-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'gpt-5',
          useResponsesApi: true,
          firstPartyEndpoint: true,
          user: 'some_user_id',
          apiKey: 'some_azure_key',
          reasoning: {
            effort: ReasoningEffort.high,
            summary: ReasoningSummary.detailed,
          },
          modelKwargs: {
            text: {
              verbosity: Verbosity.high,
            },
          },
        },
        configOptions: {
          baseURL: 'https://some_instance_name.openai.azure.com/openai/v1',
          defaultHeaders: {
            'api-key': 'some_azure_key',
          },
          defaultQuery: {
            'api-version': 'preview',
          },
        },
        tools: [],
      });
    });

    it('should handle Azure serverless configuration with dropParams', () => {
      const apiKey = 'some_azure_key';
      const endpoint = undefined;
      const options = {
        modelOptions: {
          model: 'jais-30b-chat',
          user: 'some_user_id',
        },
        reverseProxyUrl: 'https://some_endpoint_name.services.ai.azure.com/models',
        endpoint: 'azureOpenAI',
        headers: {
          'api-key': 'some_azure_key',
        },
        dropParams: ['stream_options', 'user'],
        azure: false as const,
        defaultQuery: {
          'api-version': '2024-05-01-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'jais-30b-chat',
          apiKey: 'some_azure_key',
        },
        configOptions: {
          baseURL: 'https://some_endpoint_name.services.ai.azure.com/models',
          defaultHeaders: {
            'api-key': 'some_azure_key',
          },
          defaultQuery: {
            'api-version': '2024-05-01-preview',
          },
        },
        tools: [],
      });
    });

    it('should handle Azure serverless with user-provided key configuration', () => {
      const apiKey = 'some_azure_key';
      const endpoint = undefined;
      const options = {
        modelOptions: {
          model: 'grok-3',
          user: 'some_user_id',
        },
        reverseProxyUrl: 'https://some_endpoint_name.services.ai.azure.com/models',
        endpoint: 'azureOpenAI',
        headers: {
          'api-key': 'some_azure_key',
        },
        dropParams: ['stream_options', 'user'],
        azure: false as const,
        defaultQuery: {
          'api-version': '2024-05-01-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'grok-3',
          apiKey: 'some_azure_key',
        },
        configOptions: {
          baseURL: 'https://some_endpoint_name.services.ai.azure.com/models',
          defaultHeaders: {
            'api-key': 'some_azure_key',
          },
          defaultQuery: {
            'api-version': '2024-05-01-preview',
          },
        },
        tools: [],
      });
    });

    it('should handle Azure serverless with Mistral model configuration', () => {
      const apiKey = 'some_azure_key';
      const endpoint = undefined;
      const options = {
        modelOptions: {
          model: 'Mistral-Large-2411',
          user: 'some_user_id',
        },
        reverseProxyUrl: 'https://some_endpoint_name.services.ai.azure.com/models',
        endpoint: 'azureOpenAI',
        headers: {
          'api-key': 'some_azure_key',
        },
        dropParams: ['stream_options', 'user'],
        azure: false as const,
        defaultQuery: {
          'api-version': '2024-05-01-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'Mistral-Large-2411',
          apiKey: 'some_azure_key',
        },
        configOptions: {
          baseURL: 'https://some_endpoint_name.services.ai.azure.com/models',
          defaultHeaders: {
            'api-key': 'some_azure_key',
          },
          defaultQuery: {
            'api-version': '2024-05-01-preview',
          },
        },
        tools: [],
      });
    });

    it('should handle Azure serverless with DeepSeek model without dropParams', () => {
      const apiKey = 'some_azure_key';
      const endpoint = undefined;
      const options = {
        modelOptions: {
          model: 'DeepSeek-R1',
          user: 'some_user_id',
        },
        reverseProxyUrl: 'https://some_endpoint_name.models.ai.azure.com/v1/',
        endpoint: 'azureOpenAI',
        headers: {
          'api-key': 'some_azure_key',
        },
        azure: false as const,
        defaultQuery: {
          'api-version': '2024-08-01-preview',
        },
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'DeepSeek-R1',
          user: 'some_user_id',
          apiKey: 'some_azure_key',
          includeReasoningContent: true,
        },
        configOptions: {
          baseURL: 'https://some_endpoint_name.models.ai.azure.com/v1/',
          defaultHeaders: {
            'api-key': 'some_azure_key',
          },
          defaultQuery: {
            'api-version': '2024-08-01-preview',
          },
        },
        tools: [],
      });
    });
  });

  describe('Custom endpoints', () => {
    it('should handle Groq custom endpoint configuration', () => {
      const apiKey = 'gsk_somekey';
      const endpoint = 'groq';
      const options = {
        modelOptions: {
          model: 'qwen/qwen3-32b',
          user: 'some-user',
        },
        reverseProxyUrl: 'https://api.groq.com/openai/v1/',
        proxy: '',
        headers: {},
        endpoint: 'groq',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: 'qwen/qwen3-32b',
          user: 'some-user',
          apiKey: 'gsk_somekey',
        },
        configOptions: {
          baseURL: 'https://api.groq.com/openai/v1/',
          defaultHeaders: {},
        },
        tools: [],
      });
    });

    it('should handle Cloudflare Workers AI with custom headers and addParams', () => {
      const apiKey = 'someKey';
      const endpoint = 'Cloudflare Workers AI';
      const options = {
        modelOptions: {
          model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
          user: 'some-user',
          reasoning_effort: ReasoningEffort.high,
        },
        reverseProxyUrl:
          'https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/workers-ai/v1',
        proxy: '',
        headers: {
          'x-librechat-thread-id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
          'x-test-key': '{{TESTING_USER_VAR}}',
        },
        addParams: {
          disableStreaming: true,
        },
        endpoint: 'Cloudflare Workers AI',
        endpointType: 'custom',
      };

      const result = getOpenAIConfig(apiKey, options, endpoint);

      expect(result).toEqual({
        llmConfig: {
          streaming: true,
          model: '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b',
          user: 'some-user',
          disableStreaming: true,
          apiKey: 'someKey',
          modelKwargs: {
            reasoning_effort: ReasoningEffort.high,
          },
        },
        configOptions: {
          baseURL:
            'https://gateway.ai.cloudflare.com/v1/${CF_ACCOUNT_ID}/${CF_GATEWAY_ID}/workers-ai/v1',
          defaultHeaders: {
            'x-librechat-thread-id': '{{LIBRECHAT_BODY_CONVERSATIONID}}',
            'x-test-key': '{{TESTING_USER_VAR}}',
          },
        },
        tools: [],
      });
    });
  });
});
