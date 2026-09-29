import {
  ChatModelStreamHandler,
  HandlerRegistry,
  Providers,
  StandardGraph,
  handleToolCalls,
  toolsCondition,
} from '@librechat/agents';
import type { ToolExecuteBatchRequest } from '@librechat/agents';
import type { Response as ServerResponse } from 'express';
import { AIMessageChunk } from '@langchain/core/messages';
import { createClientToolHandoff } from './clientTools';
import { createResponseTracker } from './handlers';
import { createResponsesEventHandlers } from './service';

jest.mock('@librechat/data-schemas', () => ({ logger: { warn: jest.fn() } }));
jest.mock('../usage', () => ({ aggregateCollectedUsage: jest.fn() }));

/** Exercise the SDK's actual step dispatch and stream-key behavior, not stand-in steps. */
function setup() {
  const events: Array<{
    type: string;
    call_id?: string;
    arguments?: string;
    delta?: string;
    response?: {
      output: Array<{
        type: string;
        call_id?: string;
        arguments?: string;
        output?: string;
      }>;
    };
  }> = [];
  const tracker = createResponseTracker();
  const handoff = createClientToolHandoff({
    tools: [{ type: 'function', name: 'submit_sql' }],
    responseId: 'resp_sdk',
  });
  const res = {
    write: (chunk: string) => {
      if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
        events.push(JSON.parse(chunk.slice(6)));
      }
    },
  } as ServerResponse;
  const stream = createResponsesEventHandlers({
    res,
    tracker,
    context: { responseId: 'resp_sdk', model: 'agent_sdk', createdAt: 0 },
    clientToolNames: handoff.clientToolNames,
  });
  const graph = new StandardGraph({
    runId: 'sdk',
    agents: [
      {
        agentId: 'agent_sdk',
        provider: Providers.OPENAI,
        toolDefinitions: handoff.toolDefinitions,
      },
    ],
  });
  graph.config = { configurable: { run_id: 'sdk', thread_id: 'sdk_thread' } };
  const registry = new HandlerRegistry();
  graph.handlerRegistry = registry;
  registry.register('on_run_step', handoff.wrapRunStep(stream.handlers.on_run_step));
  registry.register('on_run_step_delta', stream.handlers.on_run_step_delta);
  const metadata = {
    run_id: 'sdk',
    thread_id: 'sdk_thread',
    langgraph_node: 'agent=agent_sdk',
    langgraph_step: 1,
  };
  return { events, tracker, handoff, stream, graph, metadata };
}

const completed = (events: ReturnType<typeof setup>['events']) =>
  events.find((event) => event.type === 'response.completed')?.response?.output ?? [];

describe('caller tool handoff through the pinned SDK', () => {
  it('backfills every whole-call argument before closing a parallel batch', async () => {
    const { events, graph, metadata, stream } = setup();
    const calls = [
      { id: 'call_a', name: 'submit_sql', args: { sql: 'SELECT 1' } },
      { id: 'call_b', name: 'submit_sql', args: { sql: 'SELECT 2' } },
    ];

    await handleToolCalls(calls, metadata, graph);
    stream.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: calls },
    });
    stream.finalizeStream();

    const done = events.filter((event) => event.type === 'response.function_call_arguments.done');
    expect(done.map((event) => [event.call_id, event.arguments])).toEqual([
      ['call_a', '{"sql":"SELECT 1"}'],
      ['call_b', '{"sql":"SELECT 2"}'],
    ]);
  });

  it('emits a deferral result for a client-first mixed batch instead of handing it off', async () => {
    const { events, handoff, graph, metadata, stream } = setup();
    const calls = [
      { id: 'call_a', name: 'submit_sql', args: { sql: 'UPDATE accounts SET x=1' } },
      { id: 'call_b', name: 'list_tables', args: {} },
    ];
    const execute = handoff.wrapToolExecute(
      {
        handle: (_event, data) => data.resolve([]),
      },
      stream.emitClientToolDeferral,
    );

    await handleToolCalls(calls, metadata, graph);
    stream.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: calls },
    });
    await execute.handle('on_tool_execute', {
      toolCalls: calls,
      resolve: () => {},
      reject: () => {},
    } satisfies ToolExecuteBatchRequest);
    stream.finalizeStream();

    expect(completed(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_a' }),
      ]),
    );
    expect(
      events.filter(
        (event) =>
          event.type === 'response.function_call_arguments.done' && event.call_id === 'call_a',
      ),
    ).toHaveLength(1);
  });

  it('waits for whole-call arguments when tool execution beats model end', async () => {
    const { events, handoff, graph, metadata, stream } = setup();
    const calls = [
      { id: 'call_a', name: 'submit_sql', args: { sql: 'UPDATE accounts SET x=1' } },
      { id: 'call_b', name: 'list_tables', args: {} },
    ];
    const execute = handoff.wrapToolExecute(
      {
        handle: (_event, data) => data.resolve([]),
      },
      stream.emitClientToolDeferral,
    );

    await handleToolCalls(calls, metadata, graph);
    await execute.handle('on_tool_execute', {
      toolCalls: calls,
      resolve: () => {},
      reject: () => {},
    } satisfies ToolExecuteBatchRequest);
    expect(
      events.filter((event) => event.type === 'response.function_call_arguments.done'),
    ).toHaveLength(0);
    stream.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: calls },
    });
    stream.finalizeStream();

    expect(
      events.find((event) => event.type === 'response.function_call_arguments.done'),
    ).toMatchObject({
      call_id: 'call_a',
      arguments: '{"sql":"UPDATE accounts SET x=1"}',
    });
    expect(completed(events)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'function_call_output', call_id: 'call_a' }),
      ]),
    );
  });

  it('recovers only the missing suffix when a handoff mark moves an index-only chunk', async () => {
    const { events, graph, metadata, stream } = setup();
    const sdk = new ChatModelStreamHandler();
    await sdk.handle(
      'on_chat_model_stream',
      {
        chunk: new AIMessageChunk({
          content: '',
          tool_call_chunks: [{ id: 'call_a', name: 'submit_sql', index: 0, args: '{"sql":' }],
        }),
      },
      metadata,
      graph,
    );
    await sdk.handle(
      'on_chat_model_stream',
      {
        chunk: new AIMessageChunk({
          content: '',
          tool_call_chunks: [{ index: 0, args: '"SELECT 1"}' }],
        }),
      },
      metadata,
      graph,
    );
    stream.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: 'call_a', args: { sql: 'SELECT 1' } }] },
    });
    stream.finalizeStream();

    expect(completed(events)).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_a',
        arguments: '{"sql":"SELECT 1"}',
      }),
    ]);
    expect(
      events
        .filter((event) => event.type === 'response.function_call_arguments.delta')
        .map((event) => event.delta),
    ).toEqual(['{"sql":', '"SELECT 1"}']);
  });

  it('never eagerly answers a client-only call when its name is excluded', async () => {
    const { events, handoff, graph, metadata, stream } = setup();
    graph.eagerEventToolExecution = {
      enabled: true,
      excludeToolNames: [...handoff.clientToolNames],
    };
    const calls = [{ id: 'call_a', name: 'submit_sql', args: { sql: 'SELECT 1' } }];

    await new ChatModelStreamHandler().handle(
      'on_chat_model_stream',
      {
        chunk: new AIMessageChunk({
          content: '',
          tool_calls: calls,
          response_metadata: { finish_reason: 'tool_calls' },
        }),
      },
      metadata,
      graph,
    );
    stream.handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: calls },
    });
    stream.finalizeStream();

    expect(graph.eagerEventToolExecutions.size).toBe(0);
    expect(
      toolsCondition(
        { messages: [{ tool_calls: calls }] } as unknown as Parameters<typeof toolsCondition>[0],
        'tools',
        graph.invokedToolIds,
      ),
    ).not.toBe('tools');
    expect(completed(events)).toEqual([
      expect.objectContaining({
        type: 'function_call',
        call_id: 'call_a',
        arguments: '{"sql":"SELECT 1"}',
      }),
    ]);
  });
});
