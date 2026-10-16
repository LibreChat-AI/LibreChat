/**
 * Runs one agent turn through the real `createRun` and provider chat model
 * classes and records every serialized provider request right before it would
 * leave the process: fetch-based clients through a mocked global `fetch`,
 * Bedrock through an injected runtime client. A request is answered with the
 * scripted response for its position, or aborted when none is scripted, so no
 * request reaches the network.
 */
import { Providers } from '@librechat/agents';
import type { BaseMessage } from '@librechat/agents/langchain/messages';
import { createRun } from '../../run';

export const CAPTURED = 'request captured before network';

export type RequestFormat = 'openai' | 'anthropic' | 'google' | 'bedrock';

export interface ProviderCase {
  name: string;
  provider: string;
  endpoint?: string;
  format: RequestFormat;
  modelParameters: Record<string, unknown>;
}

export interface Captured {
  system: unknown;
  tools: unknown;
  messages: unknown[];
}

const OPENAI_KEY = { apiKey: 'test-key', maxRetries: 0 };

export const PROVIDERS: ProviderCase[] = [
  {
    name: 'openAI',
    provider: Providers.OPENAI,
    format: 'openai',
    modelParameters: { model: 'gpt-4.1', ...OPENAI_KEY },
  },
  {
    name: 'custom OpenAI-compatible (vLLM)',
    provider: Providers.OPENAI,
    endpoint: 'vLLM',
    format: 'openai',
    modelParameters: {
      model: 'local-model',
      ...OPENAI_KEY,
      configuration: { baseURL: 'https://vllm.invalid/v1' },
    },
  },
  {
    name: 'azureOpenAI',
    provider: Providers.AZURE,
    format: 'openai',
    modelParameters: {
      model: 'gpt-4.1',
      azureOpenAIApiKey: 'test-key',
      azureOpenAIApiInstanceName: 'instance',
      azureOpenAIApiDeploymentName: 'deployment',
      azureOpenAIApiVersion: '2024-10-21',
      maxRetries: 0,
    },
  },
  {
    name: 'anthropic',
    provider: Providers.ANTHROPIC,
    format: 'anthropic',
    modelParameters: { model: 'claude-sonnet-4-5', ...OPENAI_KEY },
  },
  {
    name: 'anthropic with promptCache',
    provider: Providers.ANTHROPIC,
    format: 'anthropic',
    modelParameters: { model: 'claude-sonnet-4-5', ...OPENAI_KEY, promptCache: true },
  },
  {
    name: 'openrouter',
    provider: Providers.OPENROUTER,
    format: 'openai',
    modelParameters: { model: 'openai/gpt-4.1', ...OPENAI_KEY },
  },
  {
    name: 'openrouter with promptCache',
    provider: Providers.OPENROUTER,
    format: 'openai',
    modelParameters: { model: 'anthropic/claude-sonnet-4.5', ...OPENAI_KEY, promptCache: true },
  },
  {
    name: 'bedrock',
    provider: Providers.BEDROCK,
    format: 'bedrock',
    modelParameters: {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxRetries: 0,
    },
  },
  {
    name: 'bedrock with promptCache',
    provider: Providers.BEDROCK,
    format: 'bedrock',
    modelParameters: {
      model: 'anthropic.claude-sonnet-4-5-20250929-v1:0',
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
      maxRetries: 0,
      promptCache: true,
    },
  },
  {
    name: 'google',
    provider: Providers.GOOGLE,
    format: 'google',
    modelParameters: { model: 'gemini-2.5-flash', ...OPENAI_KEY },
  },
  {
    /** Vertex AI express mode: an API key instead of service account credentials. */
    name: 'vertexai',
    provider: Providers.VERTEXAI,
    format: 'google',
    modelParameters: { model: 'gemini-2.5-flash', ...OPENAI_KEY },
  },
  {
    name: 'mistralai',
    provider: Providers.MISTRALAI,
    format: 'openai',
    modelParameters: { model: 'mistral-large-latest', ...OPENAI_KEY },
  },
  {
    name: 'deepseek',
    provider: Providers.DEEPSEEK,
    format: 'openai',
    modelParameters: { model: 'deepseek-chat', ...OPENAI_KEY },
  },
  {
    name: 'xai',
    provider: Providers.XAI,
    format: 'openai',
    modelParameters: { model: 'grok-4', ...OPENAI_KEY },
  },
  {
    name: 'moonshot',
    provider: Providers.MOONSHOT,
    format: 'openai',
    modelParameters: { model: 'kimi-k2', ...OPENAI_KEY },
  },
];

function parseRequest(format: RequestFormat, body: Record<string, unknown>): Captured {
  if (format === 'google') {
    return {
      system: body.systemInstruction,
      tools: body.tools,
      messages: body.contents as unknown[],
    };
  }
  if (format === 'anthropic') {
    return { system: body.system, tools: body.tools, messages: body.messages as unknown[] };
  }
  const messages = (body.messages ?? []) as Array<{ role: string }>;
  return {
    system: messages.filter((message) => message.role === 'system'),
    tools: body.tools,
    messages: messages.filter((message) => message.role !== 'system'),
  };
}

export interface CaptureOptions {
  providerCase: ProviderCase;
  agent: Record<string, unknown>;
  messages: BaseMessage[];
  /** Response body for the request at this position; undefined aborts the run there. */
  respond?: (index: number, request: Captured) => unknown;
  customHandlers?: Record<string, unknown>;
  /** The summary `formatAgentMessages` took from the history. */
  initialSummary?: { text: string; tokenCount: number };
}

/** Runs the turn and returns every provider request it made, in order. */
export async function captureRun({
  providerCase,
  agent: agentInput,
  messages,
  respond,
  customHandlers,
  initialSummary,
}: CaptureOptions): Promise<Captured[]> {
  const requests: Captured[] = [];
  const agent = {
    ...agentInput,
    provider: providerCase.provider,
    endpoint: providerCase.endpoint ?? providerCase.provider,
    model_parameters: { ...providerCase.modelParameters },
  } as Record<string, unknown> & { model_parameters: Record<string, unknown> };

  const answer = (request: Captured): unknown => {
    requests.push(request);
    const response = respond?.(requests.length - 1, request);
    if (response === undefined) {
      throw new Error(CAPTURED);
    }
    return response;
  };

  const fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const raw = request ? await request.clone().text() : String(init?.body ?? '{}');
    const response = answer(parseRequest(providerCase.format, JSON.parse(raw)));
    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  if (providerCase.format === 'bedrock') {
    agent.model_parameters.client = {
      send: async (command: { input: Record<string, unknown> }) =>
        answer({
          system: command.input.system,
          tools: command.input.toolConfig,
          messages: command.input.messages as unknown[],
        }),
      config: {},
      destroy: () => undefined,
      middlewareStack: { add: () => undefined, use: () => undefined },
    };
  }

  try {
    const runId = `capture-${providerCase.name}-${Math.random()}`;
    const run = await createRun({
      appConfig: { endpoints: { agents: { promptCache: { stableContext: true } } } } as never,
      agents: [agent] as never,
      messages,
      runId,
      signal: new AbortController().signal,
      streaming: false,
      streamUsage: false,
      ...(initialSummary ? { initialSummary } : {}),
      ...(customHandlers ? { customHandlers: customHandlers as never } : {}),
    });
    await run
      .processStream({ messages }, { configurable: { thread_id: runId }, version: 'v2' })
      .catch(() => undefined);
  } finally {
    fetchMock.mockRestore();
  }
  if (requests.length === 0) {
    throw new Error(`No request captured for ${providerCase.name}`);
  }
  return requests;
}

function isCachePointBlock(value: unknown): boolean {
  return (
    value != null &&
    typeof value === 'object' &&
    Object.keys(value).length === 1 &&
    'cachePoint' in value
  );
}

/** Cache markers move to the newest messages every turn; they are not prompt content. */
export function stripCacheMarkers(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.filter((item) => !isCachePointBlock(item)).map(stripCacheMarkers);
  }
  if (value != null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== 'cache_control')
        .map(([key, nested]) => [key, stripCacheMarkers(nested)]),
    );
  }
  return value;
}

export const serialize = (value: unknown): string => JSON.stringify(stripCacheMarkers(value));
