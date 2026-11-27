import { endpointSchema } from 'librechat-data-provider';
import { Providers, initializeModel } from '@librechat/agents';
import type { GraphTools, OpenAIClientOptions } from '@librechat/agents';
import type { AppConfig } from '@librechat/data-schemas';
import type { OpenAIConfiguration } from '~/types';
import { initializeCustom } from './initialize';

const baseURL = 'https://gateway.example.com/v1';

/** Initializes an OpenAI-compatible endpoint loaded through the librechat.yaml schema, sends one
 *  request through the real client with the tools initialization returns, and records what the
 *  gateway receives. */
async function send(parameters: Record<string, unknown>, endpoint: Record<string, unknown> = {}) {
  const requests: { url: URL; body: Record<string, unknown> }[] = [];
  const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
    requests.push({ url: new URL(String(url)), body: JSON.parse(String(init?.body)) });
    const text = 'Four.';
    return Response.json({
      id: 'resp_test',
      object: 'response',
      status: 'completed',
      model: 'ox-alpha',
      choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
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
  const custom = endpointSchema.parse({
    name: 'Stealth',
    apiKey: 'test-key',
    baseURL,
    models: { default: ['ox-alpha'] },
    ...endpoint,
  });
  const { llmConfig, configOptions, tools } = await initializeCustom({
    endpoint: 'Stealth',
    model_parameters: { model: 'ox-alpha', ...parameters },
    db: { getUserKey: jest.fn(), getUserKeyValues: jest.fn() },
    runtime: { appConfig: { endpoints: { custom: [custom] } } as AppConfig, requestBody: {} },
  });
  const options = llmConfig as OpenAIClientOptions;
  const model = initializeModel({
    provider: Providers.OPENAI,
    clientOptions: { ...options, streaming: false, configuration: { ...configOptions, fetch } },
    tools: tools as GraphTools | undefined,
  });

  await model.invoke('What is in the news today?');

  expect(requests).toHaveLength(1);
  return { path: requests[0].url.origin + requests[0].url.pathname, body: requests[0].body };
}

describe('OpenAI-compatible custom endpoint web search', () => {
  it.each([
    ['a saved Chat Completions choice', { useResponsesApi: false }, {}],
    ['an addParams override', {}, { addParams: { useResponsesApi: false } }],
    [
      'a customParams default',
      {},
      { customParams: { paramDefinitions: [{ key: 'useResponsesApi', default: false }] } },
    ],
    ['a useResponsesApi drop', {}, { dropParams: ['useResponsesApi'] }],
  ])('stays on Chat Completions after %s', async (_source, parameters, endpoint) => {
    const { path, body } = await send({ ...parameters, web_search: true }, endpoint);

    expect(path).toBe(`${baseURL}/chat/completions`);
    expect(body).not.toHaveProperty('tools');
  });

  it.each([
    ['the API is left unset', {}, {}],
    [
      'a saved Responses choice overrides the customParams default',
      { useResponsesApi: true },
      { customParams: { paramDefinitions: [{ key: 'useResponsesApi', default: false }] } },
    ],
  ])('searches through the Responses API when %s', async (_case, parameters, endpoint) => {
    const { path, body } = await send({ ...parameters, web_search: true }, endpoint);

    expect(path).toBe(`${baseURL}/responses`);
    expect(body.tools).toEqual([expect.objectContaining({ type: 'web_search' })]);
  });
});
