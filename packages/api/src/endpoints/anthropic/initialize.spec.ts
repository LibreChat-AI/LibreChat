import { EModelEndpoint } from 'librechat-data-provider';
import type { AnthropicClientOptions } from '@librechat/agents';
import type { BaseInitializeParams, ServerRequest } from '~/types';
import { FINE_GRAINED_TOOL_STREAMING_BETA } from './helpers';
import { initializeAnthropic } from './initialize';

const getDefaultHeaders = (llmConfig: unknown): Record<string, string> =>
  ((llmConfig as AnthropicClientOptions).clientOptions?.defaultHeaders ?? {}) as Record<
    string,
    string
  >;

function createParams(
  endpointsConfig: Record<string, unknown>,
  env: Record<string, string | undefined> = {},
): { params: BaseInitializeParams; restore: () => void } {
  const savedEnv: Record<string, string | undefined> = {};
  for (const key of Object.keys(env)) {
    savedEnv[key] = process.env[key];
  }
  Object.assign(process.env, env);

  const params: BaseInitializeParams = {
    req: {
      user: { id: 'user-42' },
      body: { conversationId: 'convo-xyz' },
      config: { endpoints: endpointsConfig },
    } as unknown as ServerRequest,
    endpoint: EModelEndpoint.anthropic,
    model_parameters: { model: 'claude-sonnet-4-5' },
    db: {
      getUserKey: jest.fn(),
      getUserKeyValues: jest.fn(),
    },
  };

  const restore = () => {
    for (const key of Object.keys(env)) {
      if (savedEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  };

  return { params, restore };
}

describe('initializeAnthropic – custom headers', () => {
  it('threads configured headers into clientOptions.defaultHeaders without resolving placeholders', async () => {
    const { params, restore } = createParams(
      {
        [EModelEndpoint.anthropic]: {
          headers: { 'X-Conversation-Id': '{{LIBRECHAT_BODY_CONVERSATIONID}}' },
        },
      },
      { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_REVERSE_PROXY: 'https://gateway.example.com' },
    );

    try {
      const result = await initializeAnthropic(params);
      const defaultHeaders = getDefaultHeaders(result.llmConfig);
      /** Placeholder kept intact — resolved at request time, not init time */
      expect(defaultHeaders['X-Conversation-Id']).toBe('{{LIBRECHAT_BODY_CONVERSATIONID}}');
      /** Provider-managed beta header preserved alongside the custom header */
      expect(defaultHeaders['anthropic-beta']).toBe(FINE_GRAINED_TOOL_STREAMING_BETA);
      /** Reverse proxy still wired through native Anthropic config */
      expect(result.llmConfig).toHaveProperty('anthropicApiUrl', 'https://gateway.example.com');
    } finally {
      restore();
    }
  });

  it('merges endpoints.all headers beneath endpoint-specific headers', async () => {
    const { params, restore } = createParams(
      {
        all: { headers: { 'X-Common': 'all', 'X-Override': 'all' } },
        [EModelEndpoint.anthropic]: { headers: { 'X-Override': 'anthropic' } },
      },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );

    try {
      const result = await initializeAnthropic(params);
      const defaultHeaders = getDefaultHeaders(result.llmConfig);
      expect(defaultHeaders['X-Common']).toBe('all');
      expect(defaultHeaders['X-Override']).toBe('anthropic');
    } finally {
      restore();
    }
  });

  it('leaves defaultHeaders provider-managed when no custom headers are configured', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );

    try {
      const result = await initializeAnthropic(params);
      expect(getDefaultHeaders(result.llmConfig)).toEqual({
        'anthropic-beta': FINE_GRAINED_TOOL_STREAMING_BETA,
      });
    } finally {
      restore();
    }
  });
});

describe('initializeAnthropic – web search tool version', () => {
  it('keeps web_search_20250305 when webSearchToolVersion is not configured', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: {} },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );
    params.model_parameters = { model: 'claude-sonnet-4-5', web_search: true };

    try {
      const result = await initializeAnthropic(params);
      expect(result.tools).toEqual([{ type: 'web_search_20250305', name: 'web_search' }]);
    } finally {
      restore();
    }
  });

  it('threads endpoints.anthropic.webSearchToolVersion into the web search tool', async () => {
    const { params, restore } = createParams(
      { [EModelEndpoint.anthropic]: { webSearchToolVersion: 'web_search_20260209' } },
      { ANTHROPIC_API_KEY: 'sk-ant-test' },
    );
    params.model_parameters = { model: 'claude-sonnet-4-5', web_search: true };

    try {
      const result = await initializeAnthropic(params);
      expect(result.tools).toEqual([{ type: 'web_search_20260209', name: 'web_search' }]);
    } finally {
      restore();
    }
  });
});
