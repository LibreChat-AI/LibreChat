import { Providers, initializeModel } from '@librechat/agents';
import { EModelEndpoint, ReasoningEffort, validateAzureGroups } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { OpenAI } from 'openai';
import type { OpenAIConfiguration, OAIClientOptions } from '~/types';
import { initializeOpenAI } from './initialize';
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

describe('First-party GPT-5.6 function tool requests', () => {
  const calculator = {
    type: 'function' as const,
    function: {
      name: 'calculator',
      description: 'Compute arithmetic',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    },
  };

  /** Sends one tool request through the real client and returns what OpenAI receives. */
  async function send(modelOptions: object) {
    const requests: { url: URL; body: Record<string, unknown> }[] = [];
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
      requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
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
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-openai-key',
      { streaming: false, reverseProxyUrl: 'https://api.openai.com/v1', modelOptions },
      EModelEndpoint.openAI,
    );
    const model = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: { ...configOptions, fetch },
      },
      tools: [calculator],
    });

    await model.invoke('Use the calculator to compute 2 + 2.');

    expect(requests).toHaveLength(1);
    return { path: requests[0].url.origin + requests[0].url.pathname, body: requests[0].body };
  }

  it.each(['gpt-5.6', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])(
    'sends %s tool requests to the Responses API when no reasoning effort is set',
    async (model) => {
      const { path, body } = await send({ model, max_tokens: 2048 });

      expect(path).toBe('https://api.openai.com/v1/responses');
      expect(body).toMatchObject({
        model,
        max_output_tokens: 2048,
        tools: [expect.objectContaining({ type: 'function', name: 'calculator' })],
      });
      for (const key of ['reasoning', 'reasoning_effort', 'max_tokens', 'max_completion_tokens']) {
        expect(body).not.toHaveProperty(key);
      }
    },
  );

  it.each([ReasoningEffort.none, ReasoningEffort.high])(
    'sends a selected %s reasoning effort as reasoning.effort',
    async (effort) => {
      const { path, body } = await send({ model: 'gpt-5.6', reasoning_effort: effort });

      expect(path).toBe('https://api.openai.com/v1/responses');
      expect(body).toMatchObject({ reasoning: { effort } });
      expect(body).not.toHaveProperty('reasoning_effort');
    },
  );

  it('keeps tool requests on Chat Completions when Responses is switched off', async () => {
    const { path } = await send({ model: 'gpt-5.6', useResponsesApi: false });

    expect(path).toBe('https://api.openai.com/v1/chat/completions');
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

describe('Chat Completions reasoning effort', () => {
  type Sent = { url: URL; body: Record<string, unknown> };

  /** Records each request and answers it the way either API does. */
  function recorder() {
    const requests: Sent[] = [];
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
      requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
      const text = 'Four.';
      return Response.json({
        id: 'resp_test',
        object: 'response',
        status: 'completed',
        created: 1,
        model: 'test',
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
    return { requests, fetch };
  }

  /** Sends one message through the real client and returns the request the provider receives. */
  async function send(
    modelOptions: object,
    options: Partial<NonNullable<Parameters<typeof getOpenAIConfig>[1]>> = {},
    endpoint: EModelEndpoint = EModelEndpoint.openAI,
  ): Promise<Sent> {
    const { requests, fetch } = recorder();
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-key',
      { streaming: false, reverseProxyUrl: 'https://api.openai.com/v1', modelOptions, ...options },
      endpoint,
    );
    const model = initializeModel({
      provider: options.azure ? Providers.AZURE : Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: { ...configOptions, fetch },
      },
    });

    await model.invoke('What is 2 + 2?');

    expect(requests).toHaveLength(1);
    return requests[0];
  }

  it.each([
    ['o3', ReasoningEffort.high],
    ['o4-mini', ReasoningEffort.low],
    ['gpt-5', ReasoningEffort.minimal],
    ['gpt-5.1', ReasoningEffort.none],
    ['gpt-5.5', ReasoningEffort.xhigh],
  ])('sends the effort selected for %s', async (model, effort) => {
    const { url, body } = await send({ model, reasoning_effort: effort });

    expect(url.pathname).toBe('/v1/chat/completions');
    expect(body).toMatchObject({ model, reasoning_effort: effort });
  });

  it('sends the effort selected for GPT-5.6 after Chat Completions was chosen', async () => {
    const { url, body } = await send({
      model: 'gpt-5.6',
      reasoning_effort: ReasoningEffort.high,
      useResponsesApi: false,
    });

    expect(url.pathname).toBe('/v1/chat/completions');
    expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.high });
  });

  it('sends the selected effort to a gateway on the OpenAI endpoint', async () => {
    const { url, body } = await send(
      { model: 'o3', reasoning_effort: ReasoningEffort.high },
      { reverseProxyUrl: 'https://gateway.example.com/v1' },
    );

    expect(url.origin + url.pathname).toBe('https://gateway.example.com/v1/chat/completions');
    expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.high });
  });

  it.each(['gpt-4o', 'gpt-4.1', 'gpt-5-chat-latest', 'o1-mini'])(
    'keeps a saved effort away from %s, which takes none',
    async (model) => {
      const { body } = await send({ model, reasoning_effort: ReasoningEffort.high });

      expect(body).toMatchObject({ model });
      expect(body).not.toHaveProperty('reasoning_effort');
    },
  );

  it.each(['gpt-5.1', 'gpt-5.2'])(
    'drops the sampling controls %s rejects alongside a selected effort',
    async (model) => {
      const { url, body } = await send(
        { model, reasoning_effort: ReasoningEffort.high, temperature: 0.7, top_p: 0.9 },
        { addParams: { logprobs: true, topLogprobs: 2 } },
      );

      expect(url.pathname).toBe('/v1/chat/completions');
      expect(body).toMatchObject({ model, reasoning_effort: ReasoningEffort.high });
      for (const key of ['temperature', 'top_p', 'logprobs', 'top_logprobs']) {
        expect(body).not.toHaveProperty(key);
      }
    },
  );

  it('keeps the sampling controls of GPT-5.1 at effort none', async () => {
    const { body } = await send({
      model: 'gpt-5.1',
      reasoning_effort: ReasoningEffort.none,
      temperature: 0.7,
    });

    expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.none, temperature: 0.7 });
  });

  it('drops the sampling controls GPT-5.1 rejects alongside an effort on the Responses API', async () => {
    const { url, body } = await send({
      model: 'gpt-5.1',
      reasoning_effort: ReasoningEffort.high,
      temperature: 0.7,
      useResponsesApi: true,
    });

    expect(url.pathname).toBe('/v1/responses');
    expect(body).toMatchObject({ reasoning: { effort: ReasoningEffort.high } });
    expect(body).not.toHaveProperty('temperature');
  });

  it.each(['o3', 'gpt-6-sol'])(
    'sends the effort selected for %s over a configured reasoning.effort',
    async (model) => {
      const { body } = await send(
        { model, reasoning_effort: ReasoningEffort.high, useResponsesApi: false },
        { addParams: { reasoning: { effort: ReasoningEffort.low } } },
      );

      expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.high });
    },
  );

  it('sends a configured reasoning.effort when no effort is selected', async () => {
    const { body } = await send(
      { model: 'o3' },
      { addParams: { reasoning: { effort: ReasoningEffort.low } } },
    );

    expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.low });
  });

  it('sends no effort after a reasoning_effort drop', async () => {
    const { body } = await send(
      { model: 'o3', reasoning_effort: ReasoningEffort.high },
      { dropParams: ['reasoning_effort'] },
    );

    expect(body).not.toHaveProperty('reasoning_effort');
  });

  it('sends no configured effort after a reasoning drop', async () => {
    const { body } = await send(
      { model: 'o3' },
      { addParams: { reasoning: { effort: ReasoningEffort.low } }, dropParams: ['reasoning'] },
    );

    expect(body).not.toHaveProperty('reasoning_effort');
  });

  describe('on Azure', () => {
    it('sends the selected effort to a deployment of a reasoning model', async () => {
      const { url, body } = await send(
        { model: 'o3', reasoning_effort: ReasoningEffort.high },
        {
          reverseProxyUrl: undefined,
          azure: {
            azureOpenAIApiInstanceName: 'test-instance',
            azureOpenAIApiDeploymentName: 'production-deployment',
            azureOpenAIApiVersion: '2025-04-01-preview',
            azureOpenAIApiKey: 'test-azure-key',
          },
        },
        EModelEndpoint.azureOpenAI,
      );

      expect(url.origin + url.pathname).toBe(
        'https://test-instance.openai.azure.com/openai/deployments/production-deployment/chat/completions',
      );
      expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.high });
    });

    it('keeps a saved effort away from an o1-mini deployment, which takes none', async () => {
      const { url, body } = await send(
        { model: 'o1-mini', reasoning_effort: ReasoningEffort.high },
        {
          reverseProxyUrl: undefined,
          azure: {
            azureOpenAIApiInstanceName: 'test-instance',
            azureOpenAIApiDeploymentName: 'production-deployment',
            azureOpenAIApiVersion: '2025-04-01-preview',
            azureOpenAIApiKey: 'test-azure-key',
          },
        },
        EModelEndpoint.azureOpenAI,
      );

      expect(url.pathname).toBe('/openai/deployments/production-deployment/chat/completions');
      expect(body).not.toHaveProperty('reasoning_effort');
    });

    /** Initializes the configured deployment as chat does and returns the request it sends. */
    async function sendToDeployment(model: string, declared?: ReasoningEffort[]): Promise<Sent> {
      const azure = validateAzureGroups([
        {
          group: 'test',
          apiKey: 'test-azure-key',
          instanceName: 'test-instance',
          version: '2025-04-01-preview',
          models: {
            [model]: {
              deploymentName: 'production-deployment',
              ...(declared ? { reasoningEfforts: declared } : {}),
            },
          },
        },
      ]);
      expect(azure.isValid).toBe(true);
      const { llmConfig, configOptions } = await initializeOpenAI({
        endpoint: EModelEndpoint.azureOpenAI,
        model_parameters: { model, reasoning_effort: ReasoningEffort.high },
        db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
        runtime: {
          appConfig: { endpoints: { azureOpenAI: azure } } as AppConfig,
          requestBody: {},
        },
      });
      const { requests, fetch } = recorder();
      const client = initializeModel<Providers>({
        provider: Providers.AZURE,
        clientOptions: {
          ...(llmConfig as OAIClientOptions),
          streaming: false,
          verbosity: undefined,
          configuration: { ...configOptions, fetch },
        },
      });

      await client.invoke('What is 2 + 2?');

      expect(requests).toHaveLength(1);
      expect(requests[0].url.pathname).toBe(
        '/openai/deployments/production-deployment/chat/completions',
      );
      return requests[0];
    }

    it('sends the selected effort to a deployment that declares its efforts', async () => {
      const { body } = await sendToDeployment('production-west', [
        ReasoningEffort.low,
        ReasoningEffort.high,
      ]);

      expect(body).toMatchObject({ reasoning_effort: ReasoningEffort.high });
    });

    it('keeps a saved effort away from a deployment that declares none', async () => {
      const { body } = await sendToDeployment('production-chat');

      expect(body).not.toHaveProperty('reasoning_effort');
    });
  });
});
