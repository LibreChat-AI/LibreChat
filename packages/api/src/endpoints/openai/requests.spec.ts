import { Providers, initializeModel } from '@librechat/agents';
import { EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { OpenAI } from 'openai';
import type { OpenAIConfiguration } from '~/types';
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

describe('Gemini-compatible custom endpoint requests', () => {
  const GATEWAY_URL = 'https://gateway.example.com/v1beta/openai';

  /** Sends one chat completion through the real client and returns the body the gateway receives. */
  async function getRequestBody(
    modelOptions: object,
    rest: { addParams?: Record<string, unknown> } = {},
  ): Promise<Record<string, unknown>> {
    const bodies: Record<string, unknown>[] = [];
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({
        id: 'chatcmpl_test',
        object: 'chat.completion',
        created: 1,
        model: 'gemini-3.1-pro-preview',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'Four.' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      });
    };
    const options: NonNullable<Parameters<typeof getOpenAIConfig>[1]> = {
      streaming: false,
      reverseProxyUrl: GATEWAY_URL,
      customParams: { defaultParamsEndpoint: 'google' },
      modelOptions,
      ...rest,
    };
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-google-key',
      options,
      'Gemini (Custom)',
    );
    const model = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: { ...configOptions, fetch },
      },
    });

    await model.invoke('What is 2 + 2?');

    expect(bodies).toHaveLength(1);
    return bodies[0];
  }

  it.each(['minimal', 'low', 'medium', 'high'])(
    'sends a selected %s thinking level as reasoning_effort',
    async (thinkingLevel) => {
      const body = await getRequestBody({ model: 'gemini-3.1-pro-preview', thinkingLevel });

      expect(body).toMatchObject({
        model: 'gemini-3.1-pro-preview',
        reasoning_effort: thinkingLevel,
      });
      for (const key of ['thinkingConfig', 'thinking_config', 'thinkingLevel', 'extra_body']) {
        expect(body).not.toHaveProperty(key);
      }
    },
  );

  it('sends no reasoning_effort when no thinking level is selected', async () => {
    const body = await getRequestBody({ model: 'gemini-3.1-pro-preview' });

    expect(body).toMatchObject({ model: 'gemini-3.1-pro-preview' });
    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('sends the level a Flash model accepts when the selection is not supported', async () => {
    const body = await getRequestBody({ model: 'gemini-4-argon', thinkingLevel: 'minimal' });

    expect(body).toMatchObject({ reasoning_effort: 'low' });
  });

  it.each([
    ['reasoning_effort', { reasoning_effort: 'high' }],
    ['reasoning object', { reasoning: { effort: 'high' } }],
  ])('lets an addParams %s replace the selected thinking level', async (_name, addParams) => {
    const body = await getRequestBody(
      { model: 'gemini-3.1-pro-preview', thinkingLevel: 'low' },
      { addParams },
    );

    expect(body).toMatchObject({ reasoning_effort: 'high' });
  });
});
