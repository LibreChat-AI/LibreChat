import { z } from 'zod';
import { response } from 'express';
import { tool } from '@langchain/core/tools';
import { AIMessageChunk, HumanMessage } from '@librechat/agents/langchain/messages';
import {
  ChatModelStreamHandler,
  HandlerRegistry,
  Providers,
  StandardGraph,
  Run,
} from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';
import type { Response } from 'express';
import type { ChatCompletionChunk, ToolCall } from './types';
import {
  createOpenAIHandlers,
  createOpenAIStreamTracker,
  createOpenAIContentAggregator,
  createOpenAIToolCallStream,
  OpenAIRunStepHandler,
  createChunk,
  OpenAIRunStepDeltaHandler,
  sendFinalChunk,
} from './handlers';

/** No graph event fixtures: the SDK generates run steps and deltas from real
 * AIMessageChunk instances. Only the provider transport is omitted. */
describe('tool-call projection with real SDK graph dispatch', () => {
  it.each([true, false])(
    'preserves interleaved calls across SDK steps (stream=%s)',
    async (streaming) => {
      const frames: string[] = [];
      const tracker = createOpenAIStreamTracker();
      const context = { requestId: 'test', created: 1, model: 'fixture' };
      const res: Response = Object.create(response);
      jest.spyOn(res, 'write').mockImplementation((frame) => {
        frames.push(String(frame));
        return true;
      });
      const config = { tracker, context, res };
      const stream = createOpenAIToolCallStream({
        toolCalls: tracker.toolCalls,
        emit: streaming
          ? (delta) => frames.push(`data: ${JSON.stringify(createChunk(context, delta))}\n\n`)
          : undefined,
      });
      const handlers = {
        on_run_step: new OpenAIRunStepHandler(stream),
        on_run_step_delta: new OpenAIRunStepDeltaHandler(stream),
      };
      const graph = new StandardGraph({
        runId: 'test',
        agents: [{ agentId: 'agent', provider: Providers.OPENAI, tools: [] }],
      });
      graph.config = { configurable: { run_id: 'test', thread_id: 'thread' } };
      graph.handlerRegistry = new HandlerRegistry();
      for (const [event, handler] of Object.entries(handlers)) {
        graph.handlerRegistry.register(
          event,
          handler as unknown as Parameters<HandlerRegistry['register']>[1],
        );
      }
      const producer = new ChatModelStreamHandler();
      for (const chunk of [
        { index: 0, id: 'a', name: 'get_time', args: '' },
        { index: 1, id: 'b', name: 'get_time', args: '' },
        { index: 0, args: '{"city":' },
        { index: 1, args: '{"city":"Paris"}' },
        { index: 0, args: '"Madrid"}' },
      ]) {
        await producer.handle(
          'on_chat_model_stream',
          {
            chunk: new AIMessageChunk({
              content: '',
              tool_call_chunks: [{ ...chunk, type: 'tool_call_chunk' }],
            }),
          },
          { langgraph_node: 'agent=agent', langgraph_step: 1 },
          graph,
        );
      }
      expect(frames).toEqual([]);
      stream.finish();
      expect([...tracker.toolCalls.values()].map((call) => call.function.arguments)).toEqual([
        '{"city":"Madrid"}',
        '{"city":"Paris"}',
      ]);
      if (streaming) {
        const received = new Map<number, ToolCall>();
        for (const frame of frames) {
          const chunk: ChatCompletionChunk = JSON.parse(frame.slice(6));
          for (const part of chunk.choices[0].delta.tool_calls ?? []) {
            const existing = received.get(part.index);
            if (existing) {
              existing.function.arguments += part.function?.arguments ?? '';
            } else {
              expect(part.id).toBeDefined();
              expect(part.function?.name).toBe('get_time');
              received.set(part.index, {
                id: part.id!,
                type: 'function',
                function: {
                  name: part.function!.name!,
                  arguments: part.function?.arguments ?? '',
                },
              });
            }
          }
        }
        expect([...received.values()]).toEqual([...tracker.toolCalls.values()]);
        tracker.addText();
        expect(tracker.hasText).toBe(true);
        sendFinalChunk(config, 'stop');
        const final: ChatCompletionChunk = JSON.parse(frames[frames.length - 2].slice(6));
        expect(final.choices[0].finish_reason).toBe('stop');
      }
    },
  );

  it('isolates provider index zero across agents, invocations and checkpoint namespaces', () => {
    const tracker = createOpenAIStreamTracker();
    const stream = createOpenAIToolCallStream({ toolCalls: tracker.toolCalls });
    const metadata = [
      { langgraph_node: 'agent=a', langgraph_step: 1 },
      { langgraph_node: 'agent=b', langgraph_step: 1 },
      { langgraph_node: 'agent=a', langgraph_step: 3 },
      { langgraph_node: 'agent=a', langgraph_step: 3, checkpoint_ns: 'child' },
    ];
    for (const [i, meta] of metadata.entries()) {
      stream.onRunStep(
        {
          id: `step_${i}`,
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'call_0', name: 'get_time' }] },
        },
        meta,
      );
      stream.onRunStepDelta(
        {
          id: `step_${i}`,
          delta: { type: 'tool_calls', tool_calls: [{ index: 0, id: 'call_0', name: 'get_time' }] },
        },
        meta,
      );
    }
    for (const [i, meta] of metadata.entries()) {
      stream.onRunStepDelta(
        {
          id: `step_${i}`,
          delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: JSON.stringify({ i }) }] },
        },
        meta,
      );
    }
    stream.finish();
    expect([...tracker.toolCalls.values()].map((call) => call.function.arguments)).toEqual(
      metadata.map((_, i) => JSON.stringify({ i })),
    );
    expect(new Set([...tracker.toolCalls.values()].map((call) => call.id)).size).toBe(4);
  });
  it.each([true, false])(
    'omits graph-owned SDK calls from accepted output (stream=%s)',
    async (streaming) => {
      const frames: string[] = [];
      const res: Response = Object.create(response);
      jest.spyOn(res, 'write').mockImplementation((frame) => {
        frames.push(String(frame));
        return true;
      });
      const tracker = createOpenAIStreamTracker();
      const aggregator = createOpenAIContentAggregator();
      const config = {
        tracker,
        res,
        context: { requestId: 'complete', created: 1, model: 'fixture' },
      };
      const handlers = createOpenAIHandlers(streaming ? config : { aggregator });
      const graph = new StandardGraph({
        runId: 'complete',
        agents: [{ agentId: 'agent', provider: Providers.OPENAI, tools: [] }],
      });
      graph.config = { configurable: { run_id: 'complete', thread_id: 'thread' } };
      graph.handlerRegistry = new HandlerRegistry();
      for (const [event, handler] of Object.entries(handlers))
        graph.handlerRegistry.register(event, handler);
      await new ChatModelStreamHandler().handle(
        'on_chat_model_stream',
        {
          chunk: new AIMessageChunk({
            content: '',
            tool_calls: [{ id: 'a', name: 'get_time', args: { city: 'Madrid' } }],
          }),
        },
        { langgraph_node: 'agent=agent', langgraph_step: 1 },
        graph,
      );
      await handlers.on_model_response.handle('on_model_response', {
        type: 'model_response',
        id: 'accepted-internal',
        agentId: 'agent',
        toolCalls: [{ id: 'a', name: 'get_time', args: { city: 'Madrid' } }],
        toolCallDispositions: ['sdk'],
        invalidToolCalls: [],
      });
      const target = streaming ? tracker : aggregator;
      expect(target.toolCalls.size).toBe(0);
      if (streaming) sendFinalChunk(config);
      else target.finishToolCalls?.();
      expect(target.toolCalls.size).toBe(0);
      if (streaming) {
        const chunks: ChatCompletionChunk[] = frames
          .filter((frame) => frame !== 'data: [DONE]\n\n')
          .map((frame) => JSON.parse(frame.slice(6)));
        expect(chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])).toEqual([]);
      }
    },
  );

  it('uses graph-owned stream segments without stealing late fragments from the old segment', () => {
    const graph = new StandardGraph({
      runId: 'segments',
      agents: [{ agentId: 'a', provider: Providers.OPENAI, tools: [] }],
    });
    graph.config = { configurable: { run_id: 'segments', thread_id: 'thread' } };
    const meta = { langgraph_node: 'agent=a', langgraph_step: 1 };
    const tracker = createOpenAIStreamTracker();
    const stream = createOpenAIToolCallStream({ toolCalls: tracker.toolCalls });
    const start = new OpenAIRunStepHandler(stream);
    const delta = new OpenAIRunStepDeltaHandler(stream);
    for (let i = 0; i < 2; i++) {
      start.handle(
        'on_run_step',
        {
          id: `step_${i}`,
          stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'call_0', name: 'get_time' }] },
        },
        meta,
        graph,
      );
      delta.handle(
        'on_run_step_delta',
        {
          id: `step_${i}`,
          delta: { type: 'tool_calls', tool_calls: [{ id: 'call_0', index: 0, name: 'get_time' }] },
        },
        meta,
        graph,
      );
      graph.advanceStreamSegment();
    }
    for (let i = 0; i < 2; i++)
      delta.handle(
        'on_run_step_delta',
        {
          id: `step_${i}`,
          delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: JSON.stringify({ i }) }] },
        },
        meta,
        graph,
      );
    stream.finish();
    expect([...tracker.toolCalls.values()].map((call) => call.function.arguments)).toEqual([
      '{"i":0}',
      '{"i":1}',
    ]);
  });
  it('keeps tools executed by the SDK out of the final OpenAI response', async () => {
    const frames: string[] = [];
    const tracker = createOpenAIStreamTracker();
    const context = { requestId: 'accepted', created: 1, model: 'fixture' };
    const res: Response = Object.create(response);
    jest.spyOn(res, 'write').mockImplementation((frame) => {
      frames.push(String(frame));
      return true;
    });
    const config = { tracker, context, res };
    const executed: string[] = [];
    const handlers = createOpenAIHandlers(config);
    const run = await Run.create({
      runId: 'accepted-host-integration',
      skipCleanup: true,
      tokenCounter: () => 1,
      graphConfig: {
        type: 'standard',
        maxContextTokens: 100_000,
        llmConfig: {
          provider: Providers.OPENAI,
          streaming: false,
          streamUsage: false,
        },
        tools: [
          tool(
            async ({ city }) => {
              executed.push(city);
              return 'sunny';
            },
            {
              name: 'lookup',
              description: 'Weather',
              schema: z.object({ city: z.string() }),
            },
          ),
        ],
      },
      customHandlers: handlers,
    });
    if (run.Graph == null) throw new Error('Missing graph');
    let calls = 0;
    run.Graph.overrideModel = {
      invoke: async (messages: BaseMessage[]): Promise<AIMessageChunk> => {
        calls++;
        return messages.some((message) => message.getType() === 'tool')
          ? new AIMessageChunk('done')
          : new AIMessageChunk({
              content: '',
              tool_calls: [{ id: 'internal', name: 'lookup', args: { city: 'Paris' } }],
            });
      },
    };

    await run.processStream(
      { messages: [new HumanMessage('weather')] },
      { configurable: { thread_id: 'accepted-host-integration' }, version: 'v2' },
    );
    sendFinalChunk(config);

    expect(calls).toBe(2);
    expect(executed).toEqual(['Paris']);
    expect(tracker.toolCalls.size).toBe(0);
    const chunks: ChatCompletionChunk[] = frames
      .filter((frame) => frame !== 'data: [DONE]\n\n')
      .map((frame) => JSON.parse(frame.slice(6)));
    expect(chunks.flatMap((chunk) => chunk.choices[0].delta.tool_calls ?? [])).toEqual([]);
    expect(chunks.some((chunk) => chunk.choices[0].delta.content === 'done')).toBe(true);
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });

  it('assembles the name before emitting when real SDK chunks split it', async () => {
    const tracker = createOpenAIStreamTracker();
    const emitted: ChatCompletionChunk['choices'][number]['delta'][] = [];
    const stream = createOpenAIToolCallStream({
      toolCalls: tracker.toolCalls,
      emit: (delta) => emitted.push(delta),
    });
    const graph = new StandardGraph({
      runId: 'split',
      agents: [{ agentId: 'a', provider: Providers.OPENAI, tools: [] }],
    });
    graph.config = { configurable: { run_id: 'split', thread_id: 'split' } };
    graph.handlerRegistry = new HandlerRegistry();
    const handlers: ReturnType<typeof createOpenAIHandlers> = {
      on_run_step: new OpenAIRunStepHandler(stream),
      on_run_step_delta: new OpenAIRunStepDeltaHandler(stream),
    };
    for (const [event, handler] of Object.entries(handlers))
      graph.handlerRegistry.register(event, handler);
    const producer = new ChatModelStreamHandler();
    for (const chunk of [
      { id: 'a', index: 0, name: 'get_', args: '' },
      { index: 0, args: '{}' },
      { index: 0, name: 'weather' },
    ])
      await producer.handle(
        'on_chat_model_stream',
        {
          chunk: new AIMessageChunk({
            content: '',
            tool_call_chunks: [{ ...chunk, type: 'tool_call_chunk' }],
          }),
        },
        { langgraph_node: 'agent=a', langgraph_step: 1 },
        graph,
      );
    expect(emitted).toEqual([]);
    stream.finish();
    expect(tracker.toolCalls.get(0)?.function.name).toBe('get_weather');
    expect(emitted[0].tool_calls?.[0].function?.name).toBe('get_weather');
  });
});
