import { StandardGraph } from '@librechat/agents';
import { HumanMessage } from '@langchain/core/messages';
import { CustomChatGoogleGenerativeAI } from '@librechat/agents/llm/google';
import type { GenerateContentRequest } from '@google/generative-ai';
import type { NativeMediaPort } from '@librechat/agents';
import type { ClientOptions } from '@librechat/agents';
import type { NativeMediaSelection } from './native';
import { createRun as createHostRun } from '~/agents/run';
import { createDeferredNativeMediaPort } from './sdk';

type RunAgent = Parameters<typeof createHostRun>[0]['agents'][number];
function nativeAgent(id: string, extra: Partial<RunAgent> = {}): RunAgent {
  return {
    id,
    name: id,
    description: null,
    avatar: null,
    created_at: 0,
    provider: 'google',
    endpoint: 'google',
    model: 'gemini-image',
    tools: [],
    model_parameters: {
      model: 'gemini-image',
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
    ...extra,
  };
}

async function admitNativeOptions(options?: ClientOptions): Promise<void> {
  if (!options || !('nativeMedia' in options) || !options.nativeMedia) {
    throw new Error('Expected native model admission');
  }
  await options.nativeMedia.start({ modelRunId: 'ownership-probe', model: 'gemini-image' });
}
function fixtureModel(nativeMedia: NativeMediaPort) {
  const model = new CustomChatGoogleGenerativeAI({
    model: 'gemini-3-pro-image-preview',
    apiKey: 'fixture',
    nativeMedia,
    _lc_stream_delay: 0,
    maxRetries: 0,
  });
  const response = {
    candidates: [{ index: 0, content: { role: 'model', parts: [{ text: 'text only' }] } }],
    text: () => 'text only',
    functionCalls: () => undefined,
  };
  const client = Reflect.get(model, 'client') as {
    generationConfig: { responseModalities?: string[] };
    generateContent: (request: GenerateContentRequest) => Promise<{ response: typeof response }>;
  };
  client.generateContent = jest.fn(async () => ({ response }));
  return { model, client };
}

describe('native media host integration', () => {
  it.each([false, true])(
    'carries top-level visibility and child ownership into native admission: hidden=%s',
    async (hidden) => {
      const selections: NativeMediaSelection[] = [];
      const run = await createHostRun({
        agents: [
          nativeAgent('first', {
            hide_sequential_outputs: hidden,
            subagents: { enabled: true, allowSelf: false, agent_ids: ['child'] },
            subagentAgentConfigs: [nativeAgent('child')],
          }),
          nativeAgent('last'),
        ],
        signal: new AbortController().signal,
        centralTraceExportEnabled: false,
        nativeMediaFactory: async (selection) => {
          selections.push(selection);
          return undefined;
        },
      });
      if (!(run.Graph instanceof StandardGraph)) throw new Error('Expected standard graph');
      const first = run.Graph.agentContexts.get('first');
      const last = run.Graph.agentContexts.get('last');
      await admitNativeOptions(first?.clientOptions);
      await admitNativeOptions(last?.clientOptions);
      const child = first?.subagentConfigs?.[0];
      if (!child || !('agentInputs' in child)) throw new Error('Expected eager child');
      await admitNativeOptions(child.agentInputs?.clientOptions);
      expect(selections.map(({ agentId, usageType }) => ({ agentId, usageType }))).toEqual([
        { agentId: 'first', usageType: hidden ? 'sequential' : undefined },
        { agentId: 'last', usageType: undefined },
        { agentId: 'child', usageType: 'subagent' },
      ]);
    },
  );
  it('resolves deferred admission once before a paid call and preserves an explicit text-only invocation', async () => {
    const port: NativeMediaPort = {
      start: jest.fn(async () => undefined),
      part: jest.fn(async () => ({ type: 'text' as const, text: 'text only' })),
      complete: jest.fn(async () => undefined),
      fail: jest.fn(async () => undefined),
      restore: jest.fn(async () => {
        throw new Error('Unexpected continuation');
      }),
    };
    const factory = jest.fn(async () => port);
    const selection = {
      provider: 'google',
      model: 'gemini-3-pro-image-preview',
      responseModalities: ['TEXT'],
    };
    const { model, client } = fixtureModel(createDeferredNativeMediaPort(factory, selection));
    expect(factory).not.toHaveBeenCalled();
    await model._generate([new HumanMessage('Hello')], {});
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith(selection);
    expect(client.generationConfig.responseModalities).toBeUndefined();
    const rejected = fixtureModel(
      createDeferredNativeMediaPort(async () => {
        throw new Error('not permitted');
      }, selection),
    );
    await expect(rejected.model._generate([new HumanMessage('Draw')], {})).rejects.toThrow(
      'not permitted',
    );
    expect(rejected.client.generateContent).not.toHaveBeenCalled();
  });
});
