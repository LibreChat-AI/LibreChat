import fetch from 'node-fetch';
import { createHash } from 'node:crypto';
import { HumanMessage } from '@librechat/agents/langchain';
import { Providers, initializeModel } from '@librechat/agents';
import { EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { OpenAIConfiguration, BaseInitializeParams } from '~/types';
import { initializeOpenAI } from './initialize';
import { getOpenAILLMConfig } from './llm';
import { getOpenAIConfig } from './config';

jest.mock('node-fetch', () => jest.fn());

const model = 'gpt-6-cyber';
const identity = { userId: 'authenticated-user', tenantId: 'tenant-a' };
const safetyId = (userId = identity.userId, tenantId = identity.tenantId) =>
  createHash('sha256')
    .update(JSON.stringify(['librechat:gpt-6-cyber:v1', tenantId, userId]))
    .digest('hex');
const config = (overrides: Partial<Parameters<typeof getOpenAILLMConfig>[0]> = {}) =>
  getOpenAILLMConfig({
    apiKey: 'test-key',
    streaming: false,
    endpoint: EModelEndpoint.openAI,
    modelOptions: { model },
    requestIdentity: identity,
    ...overrides,
  }).llmConfig;

it('defaults approved Cyber requests to Responses without a guessed reasoning effort', () => {
  expect(config()).toMatchObject({
    useResponsesApi: true,
    modelKwargs: {
      access_programs: { cyber: 'daybreak_red' },
      safety_identifier: safetyId(),
    },
  });
  expect(config()).not.toHaveProperty('reasoning');
  expect(
    config({ modelOptions: { model, reasoning_effort: ReasoningEffort.high } }),
  ).not.toHaveProperty('reasoning');
});

it('derives identity from the authenticated principal rather than overrideable wire parameters', () => {
  const addParams = { user: 'spoofed', safety_identifier: 'shared-literal' };
  const result = config({ modelOptions: { model, user: 'request-user' }, addParams });
  expect(result).not.toHaveProperty('user');
  expect(result.modelKwargs).not.toHaveProperty('user');
  expect(result.modelKwargs?.safety_identifier).toBe(safetyId());
  expect(config().modelKwargs?.safety_identifier).toBe(result.modelKwargs?.safety_identifier);
  expect(
    config({ requestIdentity: { ...identity, userId: 'another-user' } }).modelKwargs
      ?.safety_identifier,
  ).not.toBe(safetyId());
  expect(
    config({ requestIdentity: { ...identity, tenantId: 'tenant-b' } }).modelKwargs
      ?.safety_identifier,
  ).not.toBe(safetyId());
  expect(addParams).toEqual({ user: 'spoofed', safety_identifier: 'shared-literal' });
});

it.each([{}, { userId: '' }, { userId: ' ' }])(
  'rejects missing authenticated identity: %j',
  (requestIdentity) => {
    expect(() => config({ requestIdentity })).toThrow(
      'GPT-6 Cyber requires an authenticated user.',
    );
  },
);

it.each(['modelKwargs', 'access_programs', 'safety_identifier'])(
  'rejects removal of required wire fields: %s',
  (field) => {
    expect(() => config({ dropParams: [field] })).toThrow(
      'GPT-6 Cyber requires its access program and safety identifier.',
    );
  },
);

it('preserves explicit administrator access-program and routing selections', () => {
  const access_programs = { cyber: 'standard' };
  const result = config({ addParams: { access_programs, useResponsesApi: false } });
  expect(result.modelKwargs?.access_programs).toEqual(access_programs);
  expect(result.useResponsesApi).toBe(false);
});

it.each([
  { modelOptions: { model: 'gpt-6-sol' } },
  { modelOptions: { model: 'gpt-6-cyber-other' } },
  { baseURL: 'https://gateway.example/v1' },
  { baseURL: 'https://api.openai.com.evil.example/v1' },
  { useOpenRouter: true },
  { endpoint: EModelEndpoint.azureOpenAI },
])('leaves unrelated models and transports unchanged: %j', (overrides) => {
  expect(config(overrides).modelKwargs ?? {}).not.toHaveProperty('access_programs');
  expect(config(overrides).modelKwargs ?? {}).not.toHaveProperty('safety_identifier');
});

it('recognizes a custom endpoint pointed directly at OpenAI, using the final model override', () => {
  expect(
    config({ endpoint: 'Daybreak', baseURL: 'https://api.openai.com/v1' }).modelKwargs
      ?.safety_identifier,
  ).toBe(safetyId());
  expect(config({ modelOptions: { model: 'gpt-4.1' }, addParams: { model } }).useResponsesApi).toBe(
    true,
  );
  expect(config({ addParams: { model: 'gpt-4.1' } }).modelKwargs ?? {}).not.toHaveProperty(
    'safety_identifier',
  );
});

it.each([false, true])(
  'serializes the required Cyber wire body with tools and images (streaming=%s)',
  async (streaming) => {
    const bodies: Record<string, unknown>[] = [];
    const urls: string[] = [];
    const response = {
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      model,
      output: [
        {
          type: 'message',
          id: 'msg_test',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'OK', annotations: [] }],
        },
      ],
      usage: {
        input_tokens: 300000,
        output_tokens: 100,
        total_tokens: 300100,
        input_tokens_details: { cached_tokens: 100000 },
        output_tokens_details: { reasoning_tokens: 10 },
      },
    };
    const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
      urls.push(String(url));
      bodies.push(JSON.parse(String(init?.body)));
      if (!streaming) return Response.json(response);
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        {
          type: 'response.output_text.delta',
          item_id: 'msg_test',
          output_index: 0,
          content_index: 0,
          delta: 'OK',
        },
        { type: 'response.completed', response },
      ];
      return new Response(
        events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    };
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-key',
      {
        streaming,
        requestIdentity: identity,
        modelOptions: { model, max_tokens: 128000, reasoning_effort: ReasoningEffort.high },
      },
      EModelEndpoint.openAI,
    );
    const llm = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        streamUsage: true,
        configuration: { ...configOptions, fetch },
      },
      tools: [
        {
          type: 'function',
          function: {
            name: 'verify_patch',
            description: 'Verify a fix',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
    });
    const messages = [
      new HumanMessage({
        content: [
          { type: 'text', text: 'Verify the fix' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } },
        ],
      }),
    ];
    if (streaming) {
      for await (const chunk of await llm.stream(messages)) expect(chunk).toBeDefined();
    } else {
      expect((await llm.invoke(messages)).usage_metadata?.input_token_details?.cache_read).toBe(
        100000,
      );
    }
    expect(urls).toEqual(['https://api.openai.com/v1/responses']);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model,
      stream: streaming,
      max_output_tokens: 128000,
      access_programs: { cyber: 'daybreak_red' },
      safety_identifier: safetyId(),
      tools: [expect.objectContaining({ type: 'function', name: 'verify_patch' })],
    });
    expect(JSON.stringify(bodies[0].input)).toContain('data:image/png;base64,dGVzdA==');
    for (const key of [
      'user',
      'reasoning',
      'reasoning_effort',
      'max_tokens',
      'max_completion_tokens',
    ])
      expect(bodies[0]).not.toHaveProperty(key);
  },
);

it('takes identity from the authenticated runtime, not submitted model fields', async () => {
  const previous = process.env.OPENAI_API_KEY;
  const previousURL = process.env.OPENAI_REVERSE_PROXY;
  process.env.OPENAI_API_KEY = 'test-key';
  delete process.env.OPENAI_REVERSE_PROXY;
  const params = {
    req: {
      user: { id: identity.userId, tenantId: identity.tenantId },
      body: {},
      config: {},
    } as BaseInitializeParams['req'],
    endpoint: EModelEndpoint.openAI,
    model_parameters: {
      model,
      user: 'spoofed-user',
      safety_identifier: 'shared-literal',
      requestIdentity: { userId: 'spoofed' },
    },
    db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
  };
  try {
    const result = await initializeOpenAI(params);
    expect(result.llmConfig).toHaveProperty('modelKwargs.safety_identifier', safetyId());
    expect(params.db.getUserKeyValues).not.toHaveBeenCalled();
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    if (previousURL === undefined) delete process.env.OPENAI_REVERSE_PROXY;
    else process.env.OPENAI_REVERSE_PROXY = previousURL;
  }
});

describe('Cyber SDK-effective URL routing', () => {
  beforeEach(() => {
    const env: NodeJS.ProcessEnv = { ...process.env, OPENAI_API_KEY: 'test-key' };
    for (const key of [
      'OPENAI_API_BASE',
      'OPENAI_BASE_URL',
      'OPENAI_REVERSE_PROXY',
      'LANGSMITH_GATEWAY',
    ]) {
      delete env[key];
    }
    jest.replaceProperty(process, 'env', env);
  });

  afterEach(() => jest.restoreAllMocks());

  it.each([
    {
      apiBase: undefined,
      sdkURL: undefined,
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://api.openai.com',
      native: true,
    },
    {
      apiBase: undefined,
      sdkURL: 'https://sdk-gateway.example/v1',
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://sdk-gateway.example',
      native: false,
    },
    {
      apiBase: 'https://api-base-gateway.example/v1',
      sdkURL: undefined,
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://api-base-gateway.example',
      native: false,
    },
    {
      apiBase: 'https://api-base-gateway.example/v1',
      sdkURL: 'https://api.openai.com/v1',
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://api-base-gateway.example',
      native: false,
    },
    {
      apiBase: 'https://api.openai.com/v1',
      sdkURL: 'https://sdk-gateway.example/v1',
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://api.openai.com',
      native: true,
    },
    {
      apiBase: '',
      sdkURL: 'https://sdk-gateway.example/v1',
      reverseProxy: undefined,
      gateway: undefined,
      origin: 'https://sdk-gateway.example',
      native: false,
    },
    {
      apiBase: 'https://api-base-gateway.example/v1',
      sdkURL: 'https://sdk-gateway.example/v1',
      reverseProxy: 'https://api.openai.com/v1',
      gateway: undefined,
      origin: 'https://api.openai.com',
      native: true,
    },
    {
      apiBase: 'https://api.openai.com/v1',
      sdkURL: undefined,
      reverseProxy: 'https://explicit-gateway.example/v1',
      gateway: undefined,
      origin: 'https://explicit-gateway.example',
      native: false,
    },
    {
      apiBase: undefined,
      sdkURL: undefined,
      reverseProxy: undefined,
      gateway: 'true',
      origin: 'https://gateway.smith.langchain.com',
      native: false,
    },
    {
      apiBase: undefined,
      sdkURL: undefined,
      reverseProxy: undefined,
      gateway: 'false',
      origin: 'https://api.openai.com',
      native: true,
    },
    {
      apiBase: undefined,
      sdkURL: undefined,
      reverseProxy: 'https://api.openai.com/v1',
      gateway: 'true',
      origin: 'https://api.openai.com',
      native: true,
    },
  ])(
    'matches the published SDK endpoint without native-field leakage: %j',
    async ({ apiBase, sdkURL, reverseProxy, gateway, origin, native }) => {
      for (const [key, value] of Object.entries({
        OPENAI_API_BASE: apiBase,
        OPENAI_BASE_URL: sdkURL,
        OPENAI_REVERSE_PROXY: reverseProxy,
        LANGSMITH_GATEWAY: gateway,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      const options = await initializeOpenAI({
        req: {
          user: { id: identity.userId, tenantId: identity.tenantId },
          body: {},
          config: {},
        } as BaseInitializeParams['req'],
        endpoint: EModelEndpoint.openAI,
        model_parameters: { model },
        db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
      });
      const llmConfig = options.llmConfig as ReturnType<typeof getOpenAIConfig>['llmConfig'];
      const requests: { url: URL; body: Record<string, unknown> }[] = [];
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
        requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
        return Response.json({
          id: 'resp_url',
          object: 'response',
          status: 'completed',
          model,
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          output: [
            {
              type: 'message',
              id: 'msg_url',
              role: 'assistant',
              status: 'completed',
              content: [{ type: 'output_text', text: 'OK', annotations: [] }],
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 2,
            input_tokens: 10,
            output_tokens: 2,
            total_tokens: 12,
          },
        });
      };
      const llm = initializeModel({
        provider: Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          verbosity: undefined,
          streaming: false,
          configuration: { ...options.configOptions, fetch },
        },
      });
      await llm.invoke('Check endpoint routing');
      expect(requests).toHaveLength(1);
      expect(requests[0].url.origin).toBe(origin);
      expect(requests[0].url.pathname.endsWith(native ? '/responses' : '/chat/completions')).toBe(
        true,
      );
      if (native) {
        expect(requests[0].body).toMatchObject({
          access_programs: { cyber: 'daybreak_red' },
          safety_identifier: safetyId(),
        });
      } else {
        expect(requests[0].body).not.toHaveProperty('access_programs');
        expect(requests[0].body).not.toHaveProperty('safety_identifier');
        expect(llmConfig.useResponsesApi).not.toBe(true);
      }
    },
  );
});

describe('Cyber exact endpoint contract', () => {
  it.each([
    { path: 'chat/completions', responses: false },
    { path: 'responses', responses: true },
  ])('matches the exact $path API with the installed SDK', async ({ path, responses }) => {
    const exactURL = `https://api.openai.com/v1/${path}?route=cyber`;
    const urls: string[] = [];
    const bodies: Record<string, unknown>[] = [];
    jest.mocked(fetch).mockImplementationOnce(async (url, init) => {
      urls.push(String(url));
      const body = JSON.parse(String(init?.body));
      bodies.push(body);
      const valid = responses ? Array.isArray(body.input) : Array.isArray(body.messages);
      const { Response } = jest.requireActual<typeof import('node-fetch')>('node-fetch');
      return new Response(
        JSON.stringify(
          valid
            ? {
                id: 'exact-cyber',
                object: 'response',
                status: 'completed',
                model,
                choices: [
                  {
                    index: 0,
                    message: { role: 'assistant', content: 'OK' },
                    finish_reason: 'stop',
                  },
                ],
                output: [
                  {
                    type: 'message',
                    id: 'msg_exact',
                    role: 'assistant',
                    status: 'completed',
                    content: [{ type: 'output_text', text: 'OK', annotations: [] }],
                  },
                ],
                usage: {
                  prompt_tokens: 10,
                  completion_tokens: 2,
                  input_tokens: 10,
                  output_tokens: 2,
                  total_tokens: 12,
                },
              }
            : {
                error: {
                  message: 'Wrong request schema for exact API path',
                  type: 'invalid_request_error',
                },
              },
        ),
        { status: valid ? 200 : 400, headers: { 'content-type': 'application/json' } },
      );
    });
    const { llmConfig, configOptions } = getOpenAIConfig(
      'test-key',
      {
        directEndpoint: true,
        reverseProxyUrl: exactURL,
        streaming: false,
        requestIdentity: identity,
        modelOptions: { model, max_tokens: 1024 },
        addParams: { maxRetries: 0, access_programs: { cyber: 'standard' } },
      },
      'Daybreak',
    );
    const llm = initializeModel({
      provider: Providers.OPENAI,
      clientOptions: {
        ...llmConfig,
        verbosity: undefined,
        configuration: configOptions,
      },
    });
    await llm.invoke('Verify exact API routing');
    expect(urls).toEqual([exactURL]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      model,
      access_programs: { cyber: 'standard' },
      safety_identifier: safetyId(),
      [responses ? 'max_output_tokens' : 'max_completion_tokens']: 1024,
    });
    expect(bodies[0]).not.toHaveProperty(responses ? 'messages' : 'input');
    expect(bodies[0]).not.toHaveProperty('user');
  });
});

it.each([
  { options: {}, expected: false },
  { options: { addParams: { useResponsesApi: true } }, expected: true },
  { options: { modelOptions: { model, useResponsesApi: true } }, expected: true },
  { options: { defaultParams: { useResponsesApi: true } }, expected: true },
  { options: { dropParams: ['useResponsesApi'] }, expected: undefined },
  {
    options: { addParams: { useResponsesApi: true }, dropParams: ['useResponsesApi'] },
    expected: undefined,
  },
])('preserves exact endpoint API overrides and drops: %j', ({ options, expected }) => {
  const result = config({
    directEndpoint: true,
    baseURL: 'https://api.openai.com/v1/chat/completions/?route=cyber',
    ...options,
  });
  expect(result.useResponsesApi).toBe(expected);
  expect(result.modelKwargs).toMatchObject({
    access_programs: { cyber: 'daybreak_red' },
    safety_identifier: safetyId(),
  });
});

it.each([
  { baseURL: 'https://api.openai.com/v1/chat/completions', expected: false },
  { baseURL: 'https://api.openai.com/v1/responses', expected: true },
  { baseURL: 'https://api.openai.com/v1', expected: true },
  { baseURL: 'https://api.openai.com/v1/chat/completions/batch', expected: true },
  {
    baseURL: 'https://api.openai.com/v1/responses',
    addParams: { useResponsesApi: false },
    expected: false,
  },
])('defaults the API from the exact URL path: %j', ({ expected, ...options }) => {
  const result = config({ endpoint: 'Daybreak', directEndpoint: true, ...options });
  expect(result.useResponsesApi).toBe(expected);
  expect(result.modelKwargs).toMatchObject({
    access_programs: { cyber: 'daybreak_red' },
    safety_identifier: safetyId(),
  });
});

it.each([
  { baseURL: 'https://gateway.example/v1/chat/completions', directEndpoint: true },
  { baseURL: 'https://gateway.example/v1/responses', directEndpoint: true },
  {
    baseURL: 'https://openrouter.ai/api/v1/chat/completions',
    directEndpoint: true,
    useOpenRouter: true,
  },
])('does not impose native Cyber routing or identity on exact gateways: %j', (options) => {
  const result = config({ endpoint: 'Gateway', ...options });
  expect(result.useResponsesApi).toBeUndefined();
  expect(result.modelKwargs ?? {}).not.toHaveProperty('access_programs');
  expect(result.modelKwargs ?? {}).not.toHaveProperty('safety_identifier');
});

it('does not infer an exact API schema when directEndpoint is disabled', () => {
  expect(
    config({ directEndpoint: false, baseURL: 'https://api.openai.com/v1/chat/completions' })
      .useResponsesApi,
  ).toBe(true);
});
