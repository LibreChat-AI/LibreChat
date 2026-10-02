import { formatAgentMessages, Providers } from '@librechat/agents';
import type { ToolExecuteBatchRequest } from '@librechat/agents';
import type { Response as ServerResponse } from 'express';
import type { InputItem, ResponseContext } from '../types';
import {
  buildAggregatedResponse,
  convertInputToMessages,
  createAggregatorEventHandlers,
  createResponseAggregator,
  createResponsesEventHandlers,
  validateResponseRequest,
  createResponseContext,
  buildResponsesUsage,
} from '../service';
import { clientToolDeferralContent, createClientToolExecuteHandler } from '../clientTools';
import { extractMessageContent } from '~/protection/adapters/messages';
import { buildResponse, createResponseTracker } from '../handlers';
import { buildRunToolSet } from '~/agents/tools';

describe('response usage aggregation', () => {
  const context: ResponseContext = {
    responseId: 'resp_test',
    model: 'agent_test',
    createdAt: 1778317637,
  };

  it('accumulates usage across parent and subagent model calls', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: {
        usage_metadata: {
          input_tokens: 100,
          output_tokens: 40,
          input_token_details: { cache_read: 10 },
        },
      },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: {
        usage_metadata: {
          input_tokens: 25,
          output_tokens: 15,
          cache_read_input_tokens: 5,
        },
      },
    });

    expect(aggregator.usage).toEqual({
      inputTokens: 125,
      outputTokens: 55,
      reasoningTokens: 0,
      cachedTokens: 15,
    });
  });

  it('builds one normalized wire total with an identity-free child breakdown', () => {
    const usage = buildResponsesUsage([
      { input_tokens: 100, output_tokens: 40, provider: 'openAI' },
      {
        input_tokens: 25,
        output_tokens: 10,
        provider: 'openAI',
        usage_type: 'subagent',
        input_token_details: { cache_read: 5 },
      },
    ]);

    expect(usage).toEqual({
      input_tokens: 125,
      output_tokens: 50,
      total_tokens: 175,
      input_tokens_details: { cached_tokens: 5 },
      output_tokens_details: { reasoning_tokens: 0 },
      primary: { input_tokens: 100, output_tokens: 40, total_tokens: 140 },
      subagent: { input_tokens: 25, output_tokens: 10, total_tokens: 35 },
    });

    const response = buildAggregatedResponse(context, createResponseAggregator(), usage);
    expect(response.usage).toEqual(usage);
  });

  it('uses the normalized override in the completed streaming event', () => {
    const writes: string[] = [];
    const res = {
      write: (chunk: string) => {
        writes.push(chunk);
      },
    } as unknown as ServerResponse;
    const tracker = createResponseTracker();
    const usage = buildResponsesUsage([
      { input_tokens: 100, output_tokens: 40, provider: 'openAI' },
      {
        input_tokens: 25,
        output_tokens: 10,
        provider: 'openAI',
        usage_type: 'subagent',
      },
    ]);

    createResponsesEventHandlers({ res, context, tracker }).finalizeStream(usage);

    const completed = writes.find((chunk) => chunk.startsWith('data: {'));
    expect(JSON.parse(completed?.slice(6) ?? '{}').response.usage).toEqual(usage);
  });
});

/**
 * A caller-executed tool is never run by the server, so `on_tool_end` — where a
 * server-run call gets its terminating events — cannot fire for it. The
 * streaming lifecycle still has to end the item, otherwise the caller that must
 * run the tool is handed an item that never closes.
 */
describe('streaming lifecycle of a caller-executed tool call', () => {
  const context: ResponseContext = {
    responseId: 'resp_test',
    model: 'agent_test',
    createdAt: 1778317637,
  };
  const CALL_ID = 'toolu_stream_1';
  const CLIENT_TOOL = 'submit_sql';

  /** Collects the events one streamed run writes, as parsed payloads. */
  function recorder(): { res: ServerResponse; events: Array<Record<string, unknown>> } {
    const events: Array<Record<string, unknown>> = [];
    const res = {
      write: (chunk: string) => {
        if (chunk.startsWith('data: ') && !chunk.includes('[DONE]')) {
          events.push(JSON.parse(chunk.slice(6)));
        }
      },
    } as unknown as ServerResponse;
    return { res, events };
  }

  /** The terminating events for the call itself; the tool result is its own
   *  `function_call_output` item and closes separately. */
  function terminatingEvents(events: Array<Record<string, unknown>>): string[] {
    return events
      .filter(
        (event) =>
          event.type === 'response.function_call_arguments.done' ||
          (event.type === 'response.output_item.done' &&
            (event.item as { type?: string } | undefined)?.type === 'function_call'),
      )
      .map((event) => event.type as string);
  }

  /** Streams one call to `toolName`, then ends the run as the graph would. */
  function streamToolCall(toolName: string): Array<Record<string, unknown>> {
    const { res, events } = recorder();
    const { handlers, finalizeStream } = createResponsesEventHandlers({
      res,
      context,
      tracker: createResponseTracker(),
      clientToolNames: new Set([CLIENT_TOOL]),
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, name: toolName }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, index: 0, args: '{"sql":' }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '"SELECT 1"}' }] },
    });
    finalizeStream();

    return events;
  }

  const streamClientToolCall = (): Array<Record<string, unknown>> => streamToolCall(CLIENT_TOOL);

  it('terminates the arguments and the item before the response completes', () => {
    const types = streamClientToolCall().map((event) => event.type);

    expect(types).toEqual([
      'response.output_item.added',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.delta',
      'response.function_call_arguments.done',
      'response.output_item.done',
      'response.completed',
    ]);
  });

  it('reports the assembled arguments on the terminating events', () => {
    const events = streamClientToolCall();
    const argumentsDone = events.find(
      (event) => event.type === 'response.function_call_arguments.done',
    );

    expect(argumentsDone).toMatchObject({
      call_id: CALL_ID,
      arguments: '{"sql":"SELECT 1"}',
    });
  });

  it('leaves no item in progress inside a completed response', () => {
    const events = streamClientToolCall();
    const completed = events.find((event) => event.type === 'response.completed') as {
      response: { status: string; output: Array<{ type: string; status?: string }> };
    };

    expect(completed.response.status).toBe('completed');
    expect(completed.response.output).toEqual([
      expect.objectContaining({ type: 'function_call', status: 'completed' }),
    ]);
  });

  /**
   * The first tool call of a message is announced before its arguments arrive,
   * but a second one is announced after them: the SDK opens a single
   * `tool_calls` run step per message, so any later call gets its own step only
   * at model end.
   *
   * An argument fragment that arrives before its call is announced has no item
   * to write to, so it is dropped. `on_chat_model_end` is what puts those
   * arguments back, and the only way it can tell they were dropped is by
   * checking what the tracker actually holds.
   */
  it('recovers the arguments of a call announced after its own fragments', () => {
    const { res, events } = recorder();
    const { handlers, finalizeStream } = createResponsesEventHandlers({
      res,
      context,
      tracker: createResponseTracker(),
      clientToolNames: new Set([CLIENT_TOOL]),
    });
    const FIRST = 'toolu_first';
    const SECOND = 'toolu_second';

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: FIRST, name: CLIENT_TOOL }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: FIRST, index: 1, args: '{"sql":"A"}' }] },
    });
    /* The second block opens with the id, and its fragments follow, all before
       the run step that announces it. */
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: SECOND, name: CLIENT_TOOL, index: 2, args: '' }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 2, args: '{"sql":"B"}' }] },
    });
    handlers.on_run_step.handle('on_run_step', {
      id: 'step_2',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: SECOND, name: CLIENT_TOOL }] },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: {
        tool_calls: [
          { id: FIRST, args: { sql: 'A' } },
          { id: SECOND, args: { sql: 'B' } },
        ],
      },
    });
    finalizeStream();

    const completed = events.find((event) => event.type === 'response.completed') as {
      response: { output: Array<{ call_id?: string; arguments?: string }> };
    };

    expect(completed.response.output).toEqual([
      expect.objectContaining({ call_id: FIRST, arguments: '{"sql":"A"}' }),
      expect.objectContaining({ call_id: SECOND, arguments: '{"sql":"B"}' }),
    ]);
  });

  /** The first call's fragments are already streamed, so the backfill must not
   *  append the model-end copy on top of them. */
  it('does not duplicate arguments a call already streamed', () => {
    const { res, events } = recorder();
    const { handlers, finalizeStream } = createResponsesEventHandlers({
      res,
      context,
      tracker: createResponseTracker(),
      clientToolNames: new Set([CLIENT_TOOL]),
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, name: CLIENT_TOOL }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, index: 0, args: '{"sql":' }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 0, args: '"SELECT 1"}' }] },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: CALL_ID, args: { sql: 'SELECT 1' } }] },
    });
    finalizeStream();

    const argumentsDone = events.find(
      (event) => event.type === 'response.function_call_arguments.done',
    );

    expect(argumentsDone).toMatchObject({
      call_id: CALL_ID,
      arguments: '{"sql":"SELECT 1"}',
    });
  });

  /**
   * A call the server answered itself must not look like one handed back for
   * the caller to run: the model was told to re-issue it, so a caller that
   * executed it too would run a side-effecting tool twice.
   */
  it('reports a deferred call as answered, not as handed back', () => {
    const { res, events } = recorder();
    const { handlers, finalizeStream, emitClientToolDeferral } = createResponsesEventHandlers({
      res,
      context,
      tracker: createResponseTracker(),
      clientToolNames: new Set([CLIENT_TOOL]),
    });
    const execute = createClientToolExecuteHandler({
      delegate: { handle: () => {} },
      clientToolNames: new Set([CLIENT_TOOL]),
      responseId: 'resp_test',
      onDeferred: emitClientToolDeferral,
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, name: CLIENT_TOOL }] },
    });
    execute.handle('on_tool_execute', {
      toolCalls: [{ id: CALL_ID, name: CLIENT_TOOL, args: {} }],
      resolve: () => {},
    } as unknown as ToolExecuteBatchRequest);
    finalizeStream();

    const completed = events.find((event) => event.type === 'response.completed') as {
      response: { output: Array<{ type: string; call_id?: string; output?: string }> };
    };
    const answer = completed.response.output.find((item) => item.type === 'function_call_output');

    expect(answer).toMatchObject({
      call_id: CALL_ID,
      output: clientToolDeferralContent(CLIENT_TOOL),
    });
  });

  /**
   * A mixed batch answers the client call server-side, which can terminate it
   * through `on_tool_end` after all. Finalization must not emit a second pair
   * for a call that already closed.
   */
  it('does not re-terminate a call on_tool_end already closed', () => {
    const { res, events } = recorder();
    const { handlers, finalizeStream } = createResponsesEventHandlers({
      res,
      context,
      tracker: createResponseTracker(),
      clientToolNames: new Set([CLIENT_TOOL]),
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, name: CLIENT_TOOL }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: CALL_ID, index: 0, args: '{}' }] },
    });
    handlers.on_tool_end.handle('on_tool_end', { tool_call_id: CALL_ID, output: 'done' });
    finalizeStream();

    expect(terminatingEvents(events)).toEqual([
      'response.function_call_arguments.done',
      'response.output_item.done',
    ]);
  });

  /**
   * Scoping, pinned: a server tool's call is `on_tool_end`'s to terminate, and
   * this module never sees that event because the controller replaces the
   * handler instead of composing with it. Terminating such a call from
   * finalization would paper over that separate bug AND change the event stream
   * of every request that declares no client tool, so it deliberately does not.
   */
  it('leaves a server tool call to on_tool_end', () => {
    expect(terminatingEvents(streamToolCall('bash_tool'))).toEqual([]);
  });
});

describe('convertInputToMessages', () => {
  // ── String input shorthand ─────────────────────────────────────────
  it('converts a string input to a single user message', () => {
    const result = convertInputToMessages('Hello');
    expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  // ── Empty input array ──────────────────────────────────────────────
  it('returns an empty array for empty input', () => {
    const result = convertInputToMessages([]);
    expect(result).toEqual([]);
  });

  // ── Role mapping ───────────────────────────────────────────────────
  it('maps developer role to system', () => {
    const input: InputItem[] = [
      { type: 'message', role: 'developer', content: 'You are helpful.' },
    ];
    expect(convertInputToMessages(input)).toEqual([
      { role: 'system', content: 'You are helpful.' },
    ]);
  });

  it('maps system role to system', () => {
    const input: InputItem[] = [{ type: 'message', role: 'system', content: 'System prompt.' }];
    expect(convertInputToMessages(input)).toEqual([{ role: 'system', content: 'System prompt.' }]);
  });

  it('maps user role to user', () => {
    const input: InputItem[] = [{ type: 'message', role: 'user', content: 'Hi' }];
    expect(convertInputToMessages(input)).toEqual([{ role: 'user', content: 'Hi' }]);
  });

  it('maps assistant role to assistant', () => {
    const input: InputItem[] = [{ type: 'message', role: 'assistant', content: 'Hello!' }];
    expect(convertInputToMessages(input)).toEqual([{ role: 'assistant', content: 'Hello!' }]);
  });

  it('defaults unknown roles to user', () => {
    const input = [
      { type: 'message', role: 'unknown_role', content: 'test' },
    ] as unknown as InputItem[];
    expect(convertInputToMessages(input)[0].role).toBe('user');
  });

  // ── input_text content blocks ──────────────────────────────────────
  it('converts input_text blocks to text blocks', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello world' }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello world' }] }]);
  });

  // ── output_text content blocks (the original bug) ──────────────────
  it('converts output_text blocks to text blocks', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'I can help!', annotations: [], logprobs: [] }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'I can help!' }] },
    ]);
  });

  // ── refusal content blocks ─────────────────────────────────────────
  it('converts refusal blocks to text blocks', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot do that.' }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'I cannot do that.' }] },
    ]);
  });

  // ── input_image content blocks ─────────────────────────────────────
  it('converts input_image blocks to image_url blocks', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_image', image_url: 'https://example.com/img.png', detail: 'high' },
        ],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: 'https://example.com/img.png', detail: 'high' },
          },
        ],
      },
    ]);
  });

  // ── input_file content blocks ──────────────────────────────────────
  it('converts input_file blocks to text placeholders', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', filename: 'report.pdf', file_id: 'f_123' }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[File: report.pdf]' }] },
    ]);
  });

  it('uses "unknown" for input_file without filename', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_id: 'f_123' }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      { role: 'user', content: [{ type: 'text', text: '[File: unknown]' }] },
    ]);
  });

  // ── Null / undefined filtering ─────────────────────────────────────
  it('filters out null elements in content arrays', () => {
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [null, { type: 'input_text', text: 'valid' }, undefined],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'valid' }] }]);
  });

  // ── Missing text field defaults to empty string ────────────────────
  it('defaults to empty string when text field is missing on input_text', () => {
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text' }],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: '' }] }]);
  });

  it('defaults to empty string when text field is missing on output_text', () => {
    const input = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text' }],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '' }] }]);
  });

  it('defaults to empty string when refusal field is missing on refusal block', () => {
    const input = [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal' }],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'assistant', content: [{ type: 'text', text: '' }] }]);
  });

  // ── Unknown block types are filtered out ───────────────────────────
  it('filters out unknown content block types', () => {
    const input = [
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'keep me' },
          { type: 'some_future_type', data: 'ignore' },
        ],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: [{ type: 'text', text: 'keep me' }] }]);
  });

  // ── Mixed valid/invalid content in same array ──────────────────────
  it('handles mixed valid and invalid content blocks', () => {
    const input = [
      {
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'output_text', text: 'Hello', annotations: [], logprobs: [] },
          null,
          { type: 'unknown_type' },
          { type: 'refusal', refusal: 'No can do' },
        ],
      },
    ] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'text', text: 'No can do' },
        ],
      },
    ]);
  });

  // ── Non-array, non-string content defaults to empty string ─────────
  it('defaults to empty string for non-array non-string content', () => {
    const input = [{ type: 'message', role: 'user', content: 42 }] as unknown as InputItem[];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: '' }]);
  });

  // ── Function call items ────────────────────────────────────────────
  it('pairs a function_call with its output into one assistant tool_call part', () => {
    const input: InputItem[] = [
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'get_weather',
        arguments: '{"city":"NYC"}',
      },
      { type: 'function_call_output', call_id: 'call_abc', output: '{"temp":72}' },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: 'call_abc',
              name: 'get_weather',
              args: '{"city":"NYC"}',
              output: '{"temp":72}',
            },
          },
        ],
      },
    ]);
  });

  it('never emits a tool-role message, which formats as a stray SystemMessage', () => {
    const input: InputItem[] = [
      { type: 'message', role: 'user', content: 'Run it' },
      {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'call_abc',
        name: 'get_weather',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'call_abc', output: 'ok' },
    ];
    const result = convertInputToMessages(input);
    expect(result.map((message) => message.role)).toEqual(['user', 'assistant']);
  });

  it('keeps a parallel batch on a single assistant turn', () => {
    const input: InputItem[] = [
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'first', arguments: '{}' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'second', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'a' },
      { type: 'function_call_output', call_id: 'call_b', output: 'b' },
    ];
    const result = convertInputToMessages(input);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([
      { type: 'tool_call', tool_call: { id: 'call_a', name: 'first', args: '{}', output: 'a' } },
      { type: 'tool_call', tool_call: { id: 'call_b', name: 'second', args: '{}', output: 'b' } },
    ]);
  });

  it('starts a new assistant turn when a message separates two calls', () => {
    const input: InputItem[] = [
      { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'first', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_a', output: 'a' },
      { type: 'message', role: 'user', content: 'And again' },
      { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'second', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_b', output: 'b' },
    ];
    const result = convertInputToMessages(input);
    expect(result.map((message) => message.role)).toEqual(['assistant', 'user', 'assistant']);
  });

  // ── Item references are skipped ────────────────────────────────────
  it('skips item_reference items', () => {
    const input: InputItem[] = [
      { type: 'item_reference', id: 'ref_123' },
      { type: 'message', role: 'user', content: 'Hello' },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  // ── Multi-turn conversation (the real-world scenario) ──────────────
  it('handles a full multi-turn conversation with output_text blocks', () => {
    const input: InputItem[] = [
      {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'You are a helpful assistant.' }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'What is 2+2?' }],
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: '2+2 is 4.', annotations: [], logprobs: [] }],
      },
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'And 3+3?' }],
      },
    ];
    const result = convertInputToMessages(input);
    expect(result).toEqual([
      { role: 'system', content: [{ type: 'text', text: 'You are a helpful assistant.' }] },
      { role: 'user', content: [{ type: 'text', text: 'What is 2+2?' }] },
      { role: 'assistant', content: [{ type: 'text', text: '2+2 is 4.' }] },
      { role: 'user', content: [{ type: 'text', text: 'And 3+3?' }] },
    ]);
  });
});

describe('tool call argument attribution', () => {
  /** Reproduces the SQL Console construct run: an MCP lookup, then a caller-declared submit_sql. */
  it('keeps arguments with their own call when a run makes two calls in separate steps', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_lookup', name: 'list_tables' }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_lookup', index: 1, args: '{"database":' }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 1, args: '"default"}' }] },
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_2',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'toolu_submit', name: 'submit_sql' }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_2',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_submit', index: 1, args: '{"sql":' }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_2',
      delta: { type: 'tool_calls', tool_calls: [{ index: 1, args: '"SELECT 1"}' }] },
    });

    expect(aggregator.toolCalls.get('toolu_lookup')?.arguments).toBe('{"database":"default"}');
    expect(aggregator.toolCalls.get('toolu_submit')?.arguments).toBe('{"sql":"SELECT 1"}');
  });

  it('separates two calls made in one step under provider content-block indexes', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          { id: 'toolu_a', name: 'list_tables' },
          { id: 'toolu_b', name: 'submit_sql' },
        ],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: {
        type: 'tool_calls',
        tool_calls: [
          { id: 'toolu_a', index: 1, args: '{"a":1}' },
          { id: 'toolu_b', index: 2, args: '{"sql":' },
        ],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 2, args: '"SELECT 2"}' }] },
    });

    expect(aggregator.toolCalls.get('toolu_a')?.arguments).toBe('{"a":1}');
    expect(aggregator.toolCalls.get('toolu_b')?.arguments).toBe('{"sql":"SELECT 2"}');
  });

  it('attributes an index-less chunk to the only call in the step', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'toolu_only', name: 'submit_sql' }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ args: '{"sql":"SELECT 3"}' }] },
    });

    expect(aggregator.toolCalls.get('toolu_only')?.arguments).toBe('{"sql":"SELECT 3"}');
  });

  it('drops an unattributable chunk rather than guessing between two calls', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [
          { id: 'toolu_a', name: 'list_tables' },
          { id: 'toolu_b', name: 'submit_sql' },
        ],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ index: 7, args: '{"sql":"nope"}' }] },
    });

    expect(aggregator.toolCalls.get('toolu_a')?.arguments).toBe('');
    expect(aggregator.toolCalls.get('toolu_b')?.arguments).toBe('');
  });

  it('seeds arguments a provider delivers on the step instead of as deltas', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_whole', name: 'submit_sql', args: '{"sql":"SELECT 4"}' }],
      },
    });

    expect(aggregator.toolCalls.get('toolu_whole')?.arguments).toBe('{"sql":"SELECT 4"}');
  });

  it('ignores a non-string args object rather than stringifying it', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_obj', name: 'submit_sql', args: {} }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: 'toolu_obj', args: { sql: 'SELECT 5' } }] },
    });

    expect(aggregator.toolCalls.get('toolu_obj')?.arguments).toBe('');
  });
});

describe('tool call arguments from the completed model message', () => {
  const SQL = 'SELECT\n    created_at\nFROM default.analytics_test_v2\nLIMIT 100';

  /**
   * The SQL Console construct run: the provider sent list_tables as fragments and submit_sql
   * whole, so only the completed message carries the query.
   */
  it('fills arguments for a call the provider delivered without fragments', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_lookup', name: 'list_tables' }],
      },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: {
        type: 'tool_calls',
        tool_calls: [{ id: 'toolu_lookup', index: 1, args: '{"database":"default"}' }],
      },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: {
        tool_calls: [{ id: 'toolu_lookup', args: { database: 'default' } }],
      },
    });

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_2',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'toolu_submit', name: 'submit_sql' }] },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: 'toolu_submit', args: { sql: SQL } }] },
    });

    expect(aggregator.toolCalls.get('toolu_lookup')?.arguments).toBe('{"database":"default"}');
    expect(JSON.parse(aggregator.toolCalls.get('toolu_submit')?.arguments ?? '{}')).toEqual({
      sql: SQL,
    });
  });

  it('leaves fragment-accumulated arguments untouched', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_run_step.handle('on_run_step', {
      id: 'step_1',
      stepDetails: { type: 'tool_calls', tool_calls: [{ id: 'toolu_a', name: 'submit_sql' }] },
    });
    handlers.on_run_step_delta.handle('on_run_step_delta', {
      id: 'step_1',
      delta: { type: 'tool_calls', tool_calls: [{ id: 'toolu_a', args: '{"sql":"SELECT 1"}' }] },
    });
    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: { tool_calls: [{ id: 'toolu_a', args: { sql: 'SELECT 999' } }] },
    });

    expect(aggregator.toolCalls.get('toolu_a')?.arguments).toBe('{"sql":"SELECT 1"}');
  });

  it('ignores completed calls the run never announced, and usage still accumulates', () => {
    const aggregator = createResponseAggregator();
    const handlers = createAggregatorEventHandlers(aggregator);

    handlers.on_chat_model_end.handle('on_chat_model_end', {
      output: {
        usage_metadata: { input_tokens: 10, output_tokens: 2 },
        tool_calls: [{ id: 'toolu_unknown', args: { sql: 'SELECT 1' } }],
      },
    });

    expect(aggregator.toolCalls.size).toBe(0);
    expect(aggregator.usage.inputTokens).toBe(10);
  });
});

/**
 * The continuation a caller-executed tool needs. `previous_response_id` cannot
 * carry a tool exchange — a turn is persisted as text, so neither item of the
 * pair survives it — which leaves replaying both items in `input` as the only
 * supported shape. See the `clientTools` module docstring.
 */
describe('client tool continuation replay', () => {
  const CALL_ID = 'call_submit_1';
  const TOOL_NAME = 'submit_sql';

  const replayInput: InputItem[] = [
    { type: 'message', role: 'user', content: 'Run the query' },
    {
      type: 'function_call',
      id: 'fc_1',
      call_id: CALL_ID,
      name: TOOL_NAME,
      arguments: '{"sql":"SELECT 1"}',
    },
    { type: 'function_call_output', call_id: CALL_ID, output: 'submitted' },
  ];

  it('pairs a replayed function_call with its output on one assistant turn', () => {
    expect(convertInputToMessages(replayInput)).toEqual([
      { role: 'user', content: 'Run the query' },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_call',
            tool_call: {
              id: CALL_ID,
              name: TOOL_NAME,
              args: '{"sql":"SELECT 1"}',
              output: 'submitted',
            },
          },
        ],
      },
    ]);
  });

  /**
   * The conversion is only half the contract: the controller hands these
   * messages to `formatAgentMessages`, which reads a tool exchange ONLY from a
   * `tool_call` content part. Asserting the converted shape in isolation is
   * what let the earlier OpenAI-style `{ role: 'tool' }` message pass its unit
   * test and still fail every live replay — `formatMessage` has no branch for
   * that role, so it became a SystemMessage mid-conversation and Anthropic
   * rejected the payload ("System messages are only permitted as the first
   * passed message"). This test formats what the controller formats.
   */
  it('formats the replay into a paired tool_use and tool result', () => {
    const toolSet = buildRunToolSet({
      toolDefinitions: [{ name: TOOL_NAME, description: 'caller-executed', schema: {} }],
    } as never);
    expect(toolSet.has(TOOL_NAME)).toBe(true);

    const { messages } = formatAgentMessages(
      convertInputToMessages(replayInput) as never,
      {},
      toolSet,
      undefined,
      { provider: Providers.ANTHROPIC },
    );

    /** The invariant `_convertMessagesToAnthropicPayload` enforces before it
     *  throws: nothing past the first message may be a system message. */
    expect(messages.slice(1).map((message) => message._getType())).not.toContain('system');
    expect(messages.map((message) => message._getType())).toEqual(['human', 'ai', 'tool']);

    /** The call rides on the AIMessage as a parsed `tool_calls` entry — the
     *  provider integration renders it as the tool-use block. */
    const toolCalls = (messages[1] as unknown as { tool_calls?: Array<Record<string, unknown>> })
      .tool_calls;
    expect(toolCalls).toEqual([{ id: CALL_ID, name: TOOL_NAME, args: { sql: 'SELECT 1' } }]);

    const toolResult = messages[2] as unknown as { tool_call_id: string; content: unknown };
    expect(toolResult.tool_call_id).toBe(CALL_ID);
    expect(toolResult.content).toBe('submitted');
  });

  /**
   * The replayed arguments and result moved out of a message's own `content`
   * and into a `tool_call` part, and the controller runs the content filter
   * over these same messages (`extractMessageContent`) before the run starts.
   * Caller-supplied text must stay reachable by that traversal: a shape the
   * filter cannot see is a filter that silently stops covering the replay.
   */
  it('keeps replayed tool text visible to the content-filter traversal', () => {
    const fragments = [...extractMessageContent(convertInputToMessages(replayInput) as never)].map(
      (fragment) => fragment.text,
    );

    expect(fragments).toContain('{"sql":"SELECT 1"}');
    expect(fragments).toContain('submitted');
  });

  /**
   * What a caller gets wrong by following the OpenAI habit of sending only the
   * output: the tool result arrives with no call to answer. Rejected at ingress
   * with a message that names the item, rather than reaching the provider and
   * coming back as an opaque upstream failure.
   */
  it('rejects a bare function_call_output', () => {
    const result = validateResponseRequest({
      model: 'agent_test',
      input: [{ type: 'function_call_output', call_id: CALL_ID, output: 'submitted' }],
    });

    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain(
      `function_call_output ${CALL_ID} has no matching function_call`,
    );
  });

  /** Only the caller can answer a call to its own tool, so only there is the
   *  missing half the caller's mistake. */
  it('rejects a function_call to a declared tool whose output was not replayed', () => {
    const result = validateResponseRequest({
      model: 'agent_test',
      input: replayInput.slice(0, 2),
      tools: [{ type: 'function', name: TOOL_NAME, parameters: { type: 'object' } }],
    });

    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain(
      `function_call ${CALL_ID} has no function_call_output`,
    );
  });

  /**
   * The server emits a `function_call` for its own tools but never a
   * `function_call_output`, so appending a previous response's `output` to the
   * next request's `input` — the usual continuation — carries calls the caller
   * cannot answer. Refusing those would reject a transcript the server itself
   * produced.
   */
  it('accepts an unanswered call to a tool the caller did not declare', () => {
    const result = validateResponseRequest({
      model: 'agent_test',
      input: replayInput.slice(0, 2),
    });

    expect(result.valid).toBe(true);
  });

  it('drops an unanswered server call rather than replaying it with no result', () => {
    const messages = convertInputToMessages(replayInput.slice(0, 2));

    expect(messages).toEqual([{ role: 'user', content: 'Run the query' }]);
  });

  it.each([
    ['a duplicate call_id', [replayInput[1], replayInput[1]], 'duplicate function_call call_id'],
    [
      'non-string arguments',
      [{ type: 'function_call', id: 'fc_1', call_id: CALL_ID, name: TOOL_NAME, arguments: {} }],
      'requires arguments as a JSON string',
    ],
    [
      'a missing call_id',
      [{ type: 'function_call', id: 'fc_1', name: TOOL_NAME, arguments: '{}' }],
      'requires a non-empty string call_id',
    ],
  ])('rejects %s', (_label, input, expected) => {
    const result = validateResponseRequest({ model: 'agent_test', input });

    expect(result.valid).toBe(false);
    expect((result as { error: string }).error).toContain(expected as string);
  });
});

describe('reported tools and tool_choice', () => {
  const context: ResponseContext = {
    responseId: 'resp_test',
    model: 'agent_test',
    createdAt: 1778317637,
  };

  /**
   * `tool_choice` is never forwarded to the model, so echoing the request's ask
   * would tell the caller a directive was applied when the run ignored it.
   */
  it.each([
    ['required', 'required'],
    ['none', 'none'],
    ['a specific function', { type: 'function', name: 'submit_sql' }],
  ])('reports tool_choice as auto when the request asked for %s', (_label, toolChoice) => {
    const { request } = validateResponseRequest({
      model: 'agent_test',
      input: 'hi',
      tool_choice: toolChoice,
    });
    const built = createResponseContext(request!, 'resp_test');

    expect(built).not.toHaveProperty('toolChoice');
    expect(buildAggregatedResponse(built, createResponseAggregator()).tool_choice).toBe('auto');
    expect(buildResponse(built, createResponseTracker(), 'completed').tool_choice).toBe('auto');
  });

  it('does not report a request tool until the run resolves which ones applied', () => {
    const { request } = validateResponseRequest({
      model: 'agent_test',
      input: 'hi',
      tools: [{ type: 'function', name: 'submit_sql' }],
    });
    const built = createResponseContext(request!, 'resp_test');

    expect(built.tools).toBeUndefined();
    expect(buildAggregatedResponse(built, createResponseAggregator()).tools).toEqual([]);
  });

  it('reports the applied tools the run recorded on the context', () => {
    const applied: ResponseContext = {
      ...context,
      tools: [{ type: 'function', name: 'submit_sql' }],
    };

    expect(buildAggregatedResponse(applied, createResponseAggregator()).tools).toEqual([
      { type: 'function', name: 'submit_sql' },
    ]);
    expect(buildResponse(applied, createResponseTracker(), 'completed').tools).toEqual([
      { type: 'function', name: 'submit_sql' },
    ]);
  });

  it('rejects a malformed tools entry at ingress', () => {
    expect(
      validateResponseRequest({ model: 'agent_test', input: 'hi', tools: ['submit_sql'] }),
    ).toEqual({ valid: false, error: expect.stringContaining('tools[0] must be an object') });
  });
});
