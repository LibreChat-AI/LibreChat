import { HumanMessage } from '@librechat/agents/langchain';
import { Providers, initializeModel } from '@librechat/agents';
import { EModelEndpoint, ReasoningEffort } from 'librechat-data-provider';
import type { OpenAIConfiguration } from '~/types';
import { getOpenAIConfig } from './config';
import { getOpenAILLMConfig } from './llm';

const model = 'gpt-6.2-sol';
const config = (options: Partial<Parameters<typeof getOpenAILLMConfig>[0]> = {}) =>
  getOpenAILLMConfig({
    apiKey: 'test-key',
    streaming: false,
    endpoint: EModelEndpoint.openAI,
    modelOptions: { model },
    ...options,
  }).llmConfig;

it.each([undefined, false, true])('normalizes saved efforts on route %s', (useResponsesApi) => {
  for (const effort of [ReasoningEffort.none, ReasoningEffort.minimal]) {
    const saved = { model, useResponsesApi, reasoning_effort: effort };
    const result = config({ modelOptions: saved });
    expect(result.reasoning?.effort ?? result.modelKwargs?.reasoning_effort).toBe('low');
    if (useResponsesApi === false) expect(result.modelKwargs?.reasoning_effort).toBe('low');
    expect(saved.reasoning_effort).toBe(effort);
  }
});

it.each(['addParams', 'defaultParams'] as const)('normalizes nested and flat %s', (source) => {
  for (const useResponsesApi of [false, true]) {
    for (const params of [
      { reasoning: { effort: 'none', summary: 'auto' } },
      { reasoning_effort: 'none' },
    ]) {
      const original = structuredClone(params);
      const result = config({ [source]: params, modelOptions: { model, useResponsesApi } });
      expect(result.reasoning?.effort ?? result.modelKwargs?.reasoning_effort).toBe('low');
      if (!useResponsesApi) expect(result.modelKwargs?.reasoning_effort).toBe('low');
      expect(params).toEqual(original);
    }
  }
});

it('honors reasoning and routing drops before normalizing', () => {
  const result = config({
    modelOptions: { model, reasoning_effort: ReasoningEffort.none, useResponsesApi: true },
    dropParams: ['reasoning_effort', 'reasoning', 'useResponsesApi'],
  });
  expect(result.reasoning).toBeUndefined();
  expect(result.modelKwargs?.reasoning_effort).toBeUndefined();
  expect(result.useResponsesApi).toBeUndefined();
});

it('uses the final model override and recognizes snapshots', () => {
  for (const name of [model, `${model}-2026-11-17`]) {
    const result = config({
      modelOptions: { model: 'gpt-4.1', temperature: 0.7, reasoning_effort: ReasoningEffort.none },
      addParams: { model: name },
    });
    expect(result.useResponsesApi).toBe(true);
    expect(result.reasoning?.effort).toBe('low');
    expect(result.temperature).toBeUndefined();
  }
  expect(config({ addParams: { model: 'gpt-4.1', temperature: 0.7 } }).temperature).toBe(0.7);
});

it('normalizes effort after an explicit route drop', () => {
  const result = config({
    modelOptions: { model, useResponsesApi: true, reasoning_effort: ReasoningEffort.none },
    dropParams: ['useResponsesApi'],
  });
  expect(result.useResponsesApi).toBeUndefined();
  expect(result.modelKwargs?.reasoning_effort).toBe('low');
});

it.each([
  { endpoint: EModelEndpoint.custom },
  { useOpenRouter: true },
  { baseURL: 'https://gateway.example/v1' },
])('preserves compatible provider controls: %j', (options) => {
  const result = config({
    ...options,
    modelOptions: { model, temperature: 0.7, reasoning_effort: ReasoningEffort.none },
  });
  expect(result.temperature).toBe(0.7);
  expect(result.useResponsesApi).not.toBe(true);
  expect(
    result.reasoning?.effort ??
      ('reasoning_effort' in result ? result.reasoning_effort : undefined) ??
      (result.modelKwargs?.reasoning as { effort?: string } | undefined)?.effort ??
      result.modelKwargs?.reasoning_effort,
  ).toBe('none');
});

it.each([undefined, false, true])(
  'strips unsupported controls after overrides on route %s',
  (useResponsesApi) => {
    const params = {
      temperature: 0.7,
      topP: 0.8,
      top_p: 0.9,
      logprobs: true,
      topLogprobs: 3,
      top_logprobs: 4,
      include: ['message.output_text.logprobs', 'reasoning.encrypted_content'],
    };
    for (const source of ['addParams', 'defaultParams'] as const) {
      const result = config({
        [source]: params,
        modelOptions: { model, useResponsesApi, reasoning_effort: ReasoningEffort.none },
      });
      for (const key of Object.keys(params).filter((key) => key !== 'include')) {
        expect(result).not.toHaveProperty(key);
        expect(result.modelKwargs ?? {}).not.toHaveProperty(key);
      }
      expect(result).toHaveProperty('include', ['reasoning.encrypted_content']);
      expect(params.include).toHaveLength(2);
    }
  },
);

it.each([
  { isAzure: false, streaming: false },
  { isAzure: true, streaming: false },
  { isAzure: false, streaming: true },
  { isAzure: true, streaming: true },
])(
  'serializes tools, images and reasoning on Azure=$isAzure streaming=$streaming',
  async ({ isAzure, streaming }) => {
    for (const useResponsesApi of [undefined, false]) {
      let body: Record<string, unknown> | undefined;
      let path: string | undefined;
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
        path = new URL(String(url)).pathname;
        body = JSON.parse(String(init?.body));
        const response = {
          id: 'resp_test',
          object: 'response',
          status: 'completed',
          model,
          output: [],
          choices: [
            { index: 0, message: { role: 'assistant', content: 'OK' }, finish_reason: 'stop' },
          ],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        };
        if (!streaming || useResponsesApi === false) return Response.json(response);
        const events = [
          { type: 'response.created', response: { ...response, status: 'in_progress' } },
          { type: 'response.completed', response },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
          {
            headers: { 'Content-Type': 'text/event-stream' },
          },
        );
      };
      const { llmConfig, configOptions } = getOpenAIConfig(
        'test-key',
        {
          streaming: streaming && useResponsesApi !== false,
          modelOptions: {
            model,
            useResponsesApi,
            reasoning_effort: ReasoningEffort.none,
            max_tokens: 2048,
            temperature: 0.7,
            top_p: 0.9,
          },
          ...(isAzure
            ? {
                azure: {
                  azureOpenAIApiKey: 'test-key',
                  azureOpenAIApiInstanceName: 'test-instance',
                  azureOpenAIApiDeploymentName: 'production',
                  azureOpenAIApiVersion: '2025-04-01-preview',
                },
              }
            : {}),
        },
        isAzure ? EModelEndpoint.azureOpenAI : EModelEndpoint.openAI,
      );
      const responses = useResponsesApi !== false;
      const llm = initializeModel({
        provider: isAzure && !responses ? Providers.AZURE : Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          verbosity: undefined,
          configuration: { ...configOptions, fetch },
        },
        tools: responses
          ? [
              {
                type: 'function',
                function: { name: 'lookup', parameters: { type: 'object', properties: {} } },
              },
            ]
          : [],
      });
      const messages = [
        new HumanMessage({
          content: [
            { type: 'text', text: 'Describe the image' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,dGVzdA==' } },
          ],
        }),
      ];
      if (streaming && responses) {
        for await (const chunk of await llm.stream(messages)) expect(chunk).toBeDefined();
      } else {
        await llm.invoke(messages);
      }
      expect(path).toContain(responses ? '/responses' : '/chat/completions');
      expect(body).toHaveProperty(responses ? 'reasoning.effort' : 'reasoning_effort', 'low');
      expect(body).toHaveProperty(responses ? 'max_output_tokens' : 'max_completion_tokens', 2048);
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      if (responses) expect(body?.tools).toHaveLength(1);
      expect(JSON.stringify(body?.[responses ? 'input' : 'messages'])).toContain(
        'data:image/png;base64,dGVzdA==',
      );
    }
  },
);

it('normalizes nested administrator overrides without mutating them', () => {
  const modelKwargs = { reasoning: { effort: 'none', summary: 'auto' }, temperature: 0.7 };
  const result = config({ addParams: { modelKwargs } });
  expect(result.modelKwargs).toHaveProperty('reasoning.effort', 'low');
  expect(result.modelKwargs).not.toHaveProperty('temperature');
  expect(modelKwargs).toEqual({ reasoning: { effort: 'none', summary: 'auto' }, temperature: 0.7 });
});
