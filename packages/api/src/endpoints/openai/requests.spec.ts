import { EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import { Providers, initializeModel, type AgentInputs } from '@librechat/agents';
import type { OpenAI } from 'openai';
import type { OpenAIConfiguration } from '~/types';
import type * as t from '~/types';
import { buildPromptCacheKey } from './promptCache';
import { getOpenAIConfig } from './config';

describe('Azure Astra requests', () => {
  it.each([
    { deploymentName: 'gpt-6-astra', wireModel: 'gpt-6-astra', baseURL: undefined },
    {
      deploymentName: 'production-deployment',
      wireModel: 'production-deployment',
      baseURL: undefined,
    },
    ...[
      'https://test-instance.openai.azure.com',
      'https://test-instance.openai.azure.com/',
      'https://test-instance.openai.azure.com/openai/',
      'https://test-instance.openai.azure.com/openai/v1/',
      'https://${INSTANCE_NAME}.openai.azure.com/openai/deployments/${DEPLOYMENT_NAME}',
    ].map((baseURL) => ({
      deploymentName: 'production-deployment',
      wireModel: 'production-deployment',
      baseURL,
    })),
    {
      deploymentName: undefined,
      wireModel: 'url-deployment',
      baseURL:
        'https://test-instance.openai.azure.com/openai/deployments/url-deployment?api-version=2025-04-01-preview',
    },
    {
      deploymentName: undefined,
      wireModel: 'gpt-6-astra',
      baseURL: 'https://test-instance.openai.azure.com/openai/v1',
    },
  ])(
    'sends tool requests to $wireModel from $baseURL with Astra constraints',
    async ({ deploymentName, wireModel, baseURL }) => {
      const requests: {
        url: URL;
        headers: Headers;
        body: OpenAI.Responses.ResponseCreateParams;
      }[] = [];
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
        requests.push({
          url: new URL(String(url)),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          model: wireModel,
          output: [
            {
              type: 'function_call',
              id: 'fc_test',
              call_id: 'call_test',
              name: 'calculator',
              arguments: '{"input":"2 + 2"}',
              status: 'completed',
            },
          ],
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      };
      const { llmConfig, configOptions } = getOpenAIConfig(
        'test-azure-key',
        {
          streaming: false,
          reverseProxyUrl: baseURL,
          azure: {
            azureOpenAIApiInstanceName: 'test-instance',
            azureOpenAIApiDeploymentName: deploymentName,
            azureOpenAIApiVersion: '2025-04-01-preview',
            azureOpenAIApiKey: 'test-azure-key',
          },
          modelOptions: {
            model: 'gpt-6-astra',
            reasoning_effort: ReasoningEffort.none,
            max_tokens: 2048,
            temperature: 0.7,
            top_p: 0.9,
          },
          addParams: { logprobs: true, topLogprobs: 5, store: false },
        },
        EModelEndpoint.azureOpenAI,
      );
      expect(llmConfig).not.toHaveProperty('azureOpenAIApiInstanceName');
      const model = initializeModel({
        provider: Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          verbosity: undefined,
          configuration: { ...configOptions, fetch },
        },
        tools: [
          {
            type: 'function',
            function: {
              name: 'calculator',
              description: 'Compute arithmetic',
              parameters: {
                type: 'object',
                properties: { input: { type: 'string' } },
                required: ['input'],
              },
            },
          },
        ],
      });

      const result = await model.invoke('Use the calculator to compute 2 + 2.');

      expect(result.tool_calls).toEqual([
        expect.objectContaining({ name: 'calculator', args: { input: '2 + 2' } }),
      ]);
      expect(requests).toHaveLength(1);
      const { url, headers, body } = requests[0];
      expect(url.origin + url.pathname).toBe(
        'https://test-instance.openai.azure.com/openai/v1/responses',
      );
      expect(headers.get('api-key')).toBe('test-azure-key');
      if (baseURL?.includes('?api-version=')) {
        expect(url.searchParams.get('api-version')).toBe('2025-04-01-preview');
      }
      expect(body).toMatchObject({
        model: wireModel,
        max_output_tokens: 2048,
        reasoning: { effort: 'low' },
        tools: [expect.objectContaining({ type: 'function', name: 'calculator' })],
        include: expect.arrayContaining(['reasoning.encrypted_content']),
      });
      for (const key of [
        'max_tokens',
        'max_completion_tokens',
        'temperature',
        'top_p',
        'logprobs',
        'top_logprobs',
      ]) {
        expect(body).not.toHaveProperty(key);
      }
      expect(body.include).not.toContain('message.output_text.logprobs');
    },
  );
});

describe('Azure full-hostname instances', () => {
  it.each([
    {
      baseURL: undefined,
      model: 'gpt-6-astra',
      provider: Providers.OPENAI,
      path: '/openai/v1/responses',
    },
    {
      baseURL: undefined,
      model: 'gpt-4.1',
      provider: Providers.AZURE,
      path: '/openai/deployments/production-deployment/chat/completions',
    },
    {
      baseURL: 'https://test-instance.cognitiveservices.azure.com/openai/v1',
      model: 'gpt-4.1',
      provider: Providers.AZURE,
      path: '/openai/deployments/production-deployment/chat/completions',
    },
  ])('sends $model requests to the instance host (base URL: $baseURL)', async (target) => {
    const urls: URL[] = [];
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url) => {
      urls.push(new URL(String(url)));
      const text = 'Four.';
      return Response.json({
        id: 'resp_test',
        object: 'response',
        status: 'completed',
        model: 'production-deployment',
        choices: [
          { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
        ],
        output: [
          {
            type: 'message',
            id: 'msg_test',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, input_tokens: 5, output_tokens: 1 },
      });
    };
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-azure-key',
      {
        streaming: false,
        reverseProxyUrl: target.baseURL,
        azure: {
          azureOpenAIApiInstanceName: 'test-instance.cognitiveservices.azure.com',
          azureOpenAIApiDeploymentName: 'production-deployment',
          azureOpenAIApiVersion: '2024-10-21',
          azureOpenAIApiKey: 'test-azure-key',
        },
        modelOptions: { model: target.model },
      },
      EModelEndpoint.azureOpenAI,
    );
    const model = initializeModel({
      provider: target.provider,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: { ...configOptions, fetch },
      },
    });

    await model.invoke('What is 2 + 2?');

    expect(urls).toHaveLength(1);
    expect(urls[0].origin + urls[0].pathname).toBe(
      `https://test-instance.cognitiveservices.azure.com${target.path}`,
    );
  });
});

describe('prompt cache parameters', () => {
  const azure: t.AzureOptions = {
    azureOpenAIApiInstanceName: 'test-instance',
    azureOpenAIApiDeploymentName: 'gpt-5-6',
    azureOpenAIApiVersion: '2025-04-01-preview',
    azureOpenAIApiKey: 'test-azure-key',
  };
  const instructions = 'You are a helpful assistant with a long, stable preamble.';
  const toolDefinitions = [
    {
      type: 'function',
      function: {
        name: 'calculator',
        description: 'Compute arithmetic',
        parameters: { type: 'object', properties: { input: { type: 'string' } } },
      },
    },
  ];

  /**
   * Mirrors what `createRun` does once the stable prefix and the final tool
   * schemas exist: consume the endpoint's decision and turn it into the key.
   */
  function buildClientOptions(
    surface: { endpoint: string; azure?: t.AzureOptions; useResponsesApi?: boolean },
    fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']>,
  ) {
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-key',
      {
        streaming: false,
        azure: surface.azure,
        modelOptions: { model: 'gpt-5.6' },
        promptCacheRetention: '24h',
        ...(surface.useResponsesApi === true ? { addParams: { useResponsesApi: true } } : {}),
      },
      surface.endpoint,
    );
    const options = llmConfig as t.OAIClientOptions;
    expect(options.promptCacheKeyEnabled).toBe(true);
    options.promptCacheKey = buildPromptCacheKey({
      agentId: 'request-test-agent',
      provider: Providers.OPENAI,
      clientOptions: options,
      instructions,
      toolDefinitions: toolDefinitions as unknown as AgentInputs['toolDefinitions'],
    });
    /** `createRun` drops the markers once it has consumed them, so neither can reach the wire. */
    delete options.promptCacheKeyEnabled;
    delete options.promptCacheScope;
    delete options.promptCacheScopeId;
    return {
      ...options,
      verbosity: undefined,
      configuration: { ...configOptions, fetch },
    };
  }

  it.each([
    {
      surface: 'OpenAI Chat Completions',
      endpoint: EModelEndpoint.openAI,
      provider: Providers.OPENAI,
    },
    {
      surface: 'OpenAI Responses',
      endpoint: EModelEndpoint.openAI,
      provider: Providers.OPENAI,
      useResponsesApi: true,
    },
    {
      /** Azure serves the deployment, so the deployment alias is the cached identity. */
      surface: 'Azure Chat Completions',
      endpoint: EModelEndpoint.azureOpenAI,
      provider: Providers.AZURE,
      azure,
    },
    {
      surface: 'Azure Responses',
      endpoint: EModelEndpoint.azureOpenAI,
      provider: Providers.OPENAI,
      azure,
      useResponsesApi: true,
    },
  ])(
    'reuses one cache identity across differing user turns on $surface',
    async ({ provider, ...surface }) => {
      const bodies: Record<string, unknown>[] = [];
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (_url, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        const text = 'Four.';
        return Response.json({
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          model: 'gpt-5.6',
          choices: [
            { index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          output: [
            {
              type: 'message',
              id: 'msg_test',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text, annotations: [] }],
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 1, input_tokens: 5, output_tokens: 1 },
        });
      };
      const clientOptions = buildClientOptions(surface, fetch);
      const model = initializeModel({
        provider,
        clientOptions,
      });

      await model.invoke('What is 2 + 2?');
      await model.invoke('What is the capital of France?');

      expect(bodies).toHaveLength(2);
      const [first, second] = bodies;
      expect(first.prompt_cache_key).toBe(
        buildPromptCacheKey({
          agentId: 'request-test-agent',
          provider,
          clientOptions,
          instructions,
          toolDefinitions: toolDefinitions as unknown as AgentInputs['toolDefinitions'],
        }),
      );
      expect(second.prompt_cache_key).toBe(first.prompt_cache_key);
      expect(first.prompt_cache_retention).toBe('24h');
      for (const key of [
        'promptCacheKey',
        'promptCacheKeyEnabled',
        'promptCacheScope',
        'promptCacheScopeId',
        'promptCacheRetention',
      ]) {
        expect(first).not.toHaveProperty(key);
      }
    },
  );
});
