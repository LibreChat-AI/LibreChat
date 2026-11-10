import { createHash } from 'node:crypto';
import { HumanMessage } from '@librechat/agents/langchain';
import { Providers, initializeModel } from '@librechat/agents';
import { EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { OpenAIConfiguration, BaseInitializeParams } from '~/types';
import { initializeOpenAI } from './initialize';
import { getOpenAILLMConfig } from './llm';
import { getOpenAIConfig } from './config';

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
