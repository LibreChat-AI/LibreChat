import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { initializeModel, Providers } from '@librechat/agents';
import { HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { TCustomConfig } from 'librechat-data-provider';
import type { OpenAIConfiguration } from '~/types';
import { getOpenAIConfig } from './config';

const config = yaml.load(
  fs.readFileSync(path.resolve(__dirname, '../../../../../../librechat.example.yaml'), 'utf8'),
) as TCustomConfig;
const endpoint = config.endpoints?.custom?.find((entry) => entry.name === 'MiniMax');

const tool = {
  type: 'function' as const,
  function: {
    name: 'lookup',
    description: 'Look up a value',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};

describe('MiniMax example', () => {
  it('offers Flash first and M3 without replacing the configured catalog remotely', () => {
    expect(endpoint?.models).toEqual({
      default: ['MiniMax-M3.1-Flash', 'MiniMax-M3'],
      fetch: false,
    });
    expect(endpoint?.titleModel).toBe('MiniMax-M3.1-Flash');
    expect(endpoint?.customParams?.includeReasoningHistory).toBe(true);
  });

  it.each(
    ['https://api.minimax.io/v1', 'https://api.minimaxi.com/v1'].flatMap((baseURL) =>
      ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2.7', 'my-minimax-deployment'].map(
        (modelName) => ({ baseURL, modelName }),
      ),
    ),
  )(
    'sends $modelName unchanged to $baseURL and preserves reasoning and tool history',
    async ({ baseURL, modelName }) => {
      if (!endpoint) {
        throw new Error('Missing MiniMax example');
      }
      const requests: { url: string; headers: Headers; body: Record<string, any> }[] = [];
      const fetch: NonNullable<NonNullable<OpenAIConfiguration>['fetch']> = async (url, init) => {
        requests.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: modelName,
          choices: [
            {
              index: 0,
              finish_reason: requests.length === 1 ? 'tool_calls' : 'stop',
              message:
                requests.length === 1
                  ? {
                      role: 'assistant',
                      content: '<think>Keep this history.</think>',
                      reasoning_content: 'Look up the value before answering.',
                      tool_calls: [
                        {
                          id: 'call_lookup',
                          type: 'function',
                          function: { name: 'lookup', arguments: '{"query":"test"}' },
                        },
                      ],
                    }
                  : { role: 'assistant', content: 'Found it.' },
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
        });
      };
      const { llmConfig, configOptions } = getOpenAIConfig(
        'test-minimax-key',
        {
          streaming: false,
          reverseProxyUrl: baseURL,
          modelOptions: { model: modelName },
          dropParams: endpoint.dropParams,
          customParams: endpoint.customParams,
        },
        endpoint.name,
      );
      const model = initializeModel({
        provider: Providers.OPENAI,
        clientOptions: {
          ...llmConfig,
          configuration: { ...configOptions, fetch },
        },
        tools: [tool],
      });
      const content = [
        { type: 'text' as const, text: 'Look up test.' },
        {
          type: 'image_url' as const,
          image_url: { url: 'https://example.com/test.png' },
        },
      ];
      const input = new HumanMessage({ content });
      const response = await model.invoke([input]);
      await model.invoke([
        input,
        response,
        new ToolMessage({ tool_call_id: 'call_lookup', content: 'Found it.' }),
      ]);

      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.url).toBe(`${baseURL}/chat/completions`);
        expect(request.body.messages[0].content).toEqual(content);
        expect(request.headers.get('authorization')).toBe('Bearer test-minimax-key');
        expect(request.body.model).toBe(modelName);
        expect(request.body.tools).toEqual([tool]);
        for (const key of ['service_tier', 'response_format', 'reasoning_split', 'thinking']) {
          expect(request.body).not.toHaveProperty(key);
        }
        expect(request.body.reasoning_effort).not.toBe('none');
      }
      expect(requests[1].body.messages[1]).toMatchObject({
        role: 'assistant',
        content: '<think>Keep this history.</think>',
        reasoning_content: 'Look up the value before answering.',
        tool_calls: [
          {
            id: 'call_lookup',
            type: 'function',
            function: { name: 'lookup', arguments: '{"query":"test"}' },
          },
        ],
      });
      expect(requests[1].body.messages[2]).toMatchObject({
        role: 'tool',
        tool_call_id: 'call_lookup',
        content: 'Found it.',
      });
    },
  );
});
