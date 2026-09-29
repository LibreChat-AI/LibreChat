import { Readable } from 'node:stream';
import { GraphEvents, StepTypes } from '@librechat/agents';
import {
  projectInternalHistory,
  createInternalTranslator,
  withInternalToolsFetch,
  InternalToolsStreamHandler,
} from './internalTools';

/**
 * Generic placeholder for the custom Responses-API item type used by the
 * real upstream server-executed tool implementation. Kept generic in tests
 * so the upstream implementor's identity never leaks into the test suite.
 */
const internalType = 'implementor_slug:function_call';

/** `createInternalTranslator`'s `requestId` param is typed as a UUID template
 * literal (its default is `randomUUID()`). Tests use short, readable ids
 * instead of real UUIDs purely for assertion readability. */
const reqId = (id: string) => id as unknown as Parameters<typeof createInternalTranslator>[1];

/**
 * `createInternalTranslator`/`projectInternalHistory` return plain
 * `Record<string, unknown>` values (they operate on untyped wire events).
 * These narrow casts are only applied where a test needs to read a specific
 * nested field off a translated event for an assertion.
 */
interface TranslatedItemEvent {
  item: {
    type: string;
    id: string;
    name: string;
    arguments: string;
    output: unknown;
    error: unknown;
    status: string;
  };
}

const asItemEvent = (event: Record<string, unknown>): TranslatedItemEvent =>
  event as unknown as TranslatedItemEvent;

interface TranslatedCompletedEvent {
  response: { output: Array<Record<string, unknown>> };
}

const asCompletedEvent = (event: Record<string, unknown>): TranslatedCompletedEvent =>
  event as unknown as TranslatedCompletedEvent;

// `InternalToolsStreamHandler extends ChatModelStreamHandler`. The base class
// is swapped for a minimal stand-in so these tests exercise only the
// subclass's own logic (dispatching run steps, deduping packets, forwarding),
// not the real (complex, external) base-class streaming behavior. Real
// prototype methods are used (not instance fields) so `super.handle(...)`
// resolves correctly. Per the jest-hoist convention, factory-referenced
// variables must be prefixed with "mock".
const mockSuperHandle = jest.fn(async (..._args: unknown[]) => undefined);
const mockHandleReasoning = jest.fn((..._args: unknown[]) => undefined);

jest.mock('@librechat/agents', () => {
  const actual = jest.requireActual('@librechat/agents');
  return {
    ...actual,
    ChatModelStreamHandler: class {
      handle(...args: unknown[]) {
        return mockSuperHandle(...args);
      }

      handleReasoning(...args: unknown[]) {
        return mockHandleReasoning(...args);
      }
    },
  };
});

describe('projectInternalHistory', () => {
  function buildCompletedCarrier(requestId: string, callId: string, output: string) {
    const translate = createInternalTranslator(internalType, reqId(requestId));
    const added = translate({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: `fc_${callId}`,
        type: internalType,
        call_id: callId,
        status: 'in_progress',
        name: 'semantic_search',
        arguments: '',
      },
    });
    const argsDone = translate({
      type: 'response.function_call_arguments.done',
      sequence_number: 2,
      item_id: `fc_${callId}`,
      output_index: 0,
      arguments: '{"query":"parts"}',
    });
    const done = translate({
      type: 'response.output_item.done',
      sequence_number: 3,
      output_index: 0,
      item: {
        id: `fc_${callId}`,
        type: internalType,
        call_id: callId,
        status: 'completed',
        name: 'semantic_search',
        arguments: '{"query":"parts"}',
        output,
        error: null,
      },
    });
    return { added, argsDone, done };
  }

  it('returns the body unchanged when input is not an array', () => {
    const body = JSON.stringify({ model: 'x' });
    expect(projectInternalHistory(body)).toBe(body);
  });

  it('returns the body unchanged when no carrier items are present', () => {
    const body = JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hi' }] });
    expect(projectInternalHistory(body)).toBe(body);
  });

  it('converts the latest carrier snapshot into a function_call/function_call_output pair', () => {
    const { added, argsDone, done } = buildCompletedCarrier('req1', 'call_1', '[{"part":"A-102"}]');
    const body = JSON.stringify({
      model: 'agent',
      input: [
        { type: 'message', role: 'user', content: 'find parts' },
        added.item,
        argsDone.item,
        done.item,
      ],
    });

    const result = JSON.parse(projectInternalHistory(body));

    expect(result.input).toEqual([
      { type: 'message', role: 'user', content: 'find parts' },
      {
        type: 'function_call',
        call_id: 'lc_internal_req1_call_1',
        name: 'semantic_search',
        arguments: '{"query":"parts"}',
      },
      {
        type: 'function_call_output',
        call_id: 'lc_internal_req1_call_1',
        output: '[{"part":"A-102"}]',
      },
    ]);
  });

  it('dedupes multiple persisted snapshots of the same call into a single pair, using the latest revision', () => {
    const { added, argsDone, done } = buildCompletedCarrier('req1', 'call_1', '[{"part":"A-102"}]');
    const body = JSON.stringify({ input: [added.item, argsDone.item, done.item] });

    const result = JSON.parse(projectInternalHistory(body));

    expect(result.input).toHaveLength(2);
    expect(result.input[0].type).toBe('function_call');
    expect(result.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'lc_internal_req1_call_1',
      output: '[{"part":"A-102"}]',
    });
  });

  it('formats a failed call as an error string in function_call_output', () => {
    const translate = createInternalTranslator(internalType, reqId('req2'));
    translate({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc_call_2',
        type: internalType,
        call_id: 'call_2',
        status: 'in_progress',
        name: 'semantic_search',
        arguments: '',
      },
    });
    const failedDone = translate({
      type: 'response.output_item.done',
      sequence_number: 2,
      output_index: 0,
      item: {
        id: 'fc_call_2',
        type: internalType,
        call_id: 'call_2',
        status: 'failed',
        name: 'semantic_search',
        arguments: '{}',
        output: null,
        error: { type: 'tool_error', message: 'Upstream index unavailable (503)' },
      },
    });

    const body = JSON.stringify({ input: [failedDone.item] });
    const result = JSON.parse(projectInternalHistory(body));

    expect(result.input[1]).toEqual({
      type: 'function_call_output',
      call_id: 'lc_internal_req2_call_2',
      output:
        'Error processing tool: {"type":"tool_error","message":"Upstream index unavailable (503)"}',
    });
  });

  it('leaves genuine external function_call/function_call_output items untouched', () => {
    const body = JSON.stringify({
      input: [
        {
          type: 'function_call',
          call_id: 'call_ext',
          name: 'ask_multiple_choice',
          arguments: '{}',
        },
        { type: 'function_call_output', call_id: 'call_ext', output: '{"selected":"A"}' },
      ],
    });

    expect(projectInternalHistory(body)).toBe(body);
  });

  it('preserves interleaved non-carrier items in their original order around multiple distinct calls', () => {
    const first = buildCompletedCarrier('req3', 'call_a', '[1]');
    const second = buildCompletedCarrier('req3', 'call_b', '[2]');
    const body = JSON.stringify({
      input: [
        { type: 'message', role: 'user', content: 'first question' },
        first.done.item,
        { type: 'message', role: 'assistant', content: 'here is result 1' },
        { type: 'message', role: 'user', content: 'second question' },
        second.done.item,
      ],
    });

    const result = JSON.parse(projectInternalHistory(body));

    expect(result.input.map((item: { type: string }) => item.type)).toEqual([
      'message',
      'function_call',
      'function_call_output',
      'message',
      'message',
      'function_call',
      'function_call_output',
    ]);
  });
});

describe('createInternalTranslator', () => {
  it('passes through unrelated events unchanged', () => {
    const translate = createInternalTranslator(internalType);
    const event = {
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      delta: 'hello',
    };

    expect(translate(event)).toBe(event);
  });

  it('ignores response.output_item.added for a different item type (e.g. an external function_call)', () => {
    const translate = createInternalTranslator(internalType);
    const event = {
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        id: 'fc_ext',
        type: 'function_call',
        call_id: 'call_ext',
        status: 'in_progress',
        name: 'ask_multiple_choice',
        arguments: '',
      },
    };

    expect(translate(event)).toBe(event);
  });

  it('disguises response.output_item.added for the internal type as an mcp_call carrier', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    const result = translate({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'semantic_search',
        arguments: '',
      },
    });

    expect(result.type).toBe('response.output_item.done');
    expect(result.output_index).toBe(0);
    expect(result.sequence_number).toBe(1);
    expect(result.item).toMatchObject({
      type: 'mcp_call',
      id: 'fc_1',
      name: 'semantic_search',
      arguments: '',
      status: 'in_progress',
      output: '',
    });
  });

  it('accumulates argument deltas onto the tracked packet', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const r1 = translate({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 0,
      delta: '{"q":',
    });
    const r2 = translate({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_1',
      output_index: 0,
      delta: '"x"}',
    });

    expect(asItemEvent(r1).item.arguments).toBe('{"q":');
    expect(asItemEvent(r2).item.arguments).toBe('{"q":"x"}');
  });

  it('sets the full arguments string on response.function_call_arguments.done', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const result = translate({
      type: 'response.function_call_arguments.done',
      item_id: 'fc_1',
      output_index: 0,
      arguments: '{"query":"x"}',
    });

    expect(asItemEvent(result).item.arguments).toBe('{"query":"x"}');
  });

  it('captures the final output on response.output_item.done for a completed call', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'search',
        arguments: '{}',
        output: '[1,2,3]',
        error: null,
      },
    });

    expect(asItemEvent(done).item.output).toBe('[1,2,3]');
    expect(asItemEvent(done).item.status).toBe('completed');
    expect(asItemEvent(done).item.error).toBeNull();
  });

  it('throws when an internal item is missing required string fields', () => {
    const translate = createInternalTranslator(internalType);

    expect(() =>
      translate({
        type: 'response.output_item.added',
        output_index: 0,
        item: { id: 'fc_1', type: internalType },
      }),
    ).toThrow('Invalid internal tool item');
  });

  it('throws when the tracked item identity changes at the same output_index', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'a',
        arguments: '',
      },
    });

    expect(() =>
      translate({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'fc_2',
          type: internalType,
          call_id: 'call_2',
          status: 'in_progress',
          name: 'b',
          arguments: '',
        },
      }),
    ).toThrow('Internal tool identity changed at the same output_index');
  });

  it('throws when an argument event item_id does not match the tracked packet', () => {
    const translate = createInternalTranslator(internalType);
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'a',
        arguments: '',
      },
    });

    expect(() =>
      translate({
        type: 'response.function_call_arguments.delta',
        item_id: 'fc_WRONG',
        output_index: 0,
        delta: 'x',
      }),
    ).toThrow('Internal argument item_id mismatch');
  });

  it('rewrites matching items inside a terminal response.completed output array, using the tracked packet state', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'search',
        arguments: '{}',
        output: '[1]',
        error: null,
      },
    });

    const completed = translate({
      type: 'response.completed',
      response: {
        id: 'resp_1',
        status: 'completed',
        output: [
          {
            id: 'fc_1',
            type: internalType,
            call_id: 'call_1',
            status: 'completed',
            name: 'search',
            arguments: '{}',
            // Deliberately different from the tracked packet: the code must
            // rely on the tracked state, not on the value carried by this event.
            output: '[STALE]',
          },
          { id: 'msg_1', type: 'message', role: 'assistant', content: [] },
        ],
      },
    });

    expect(asCompletedEvent(completed).response.output[0].type).toBe('mcp_call');
    expect(asCompletedEvent(completed).response.output[0].output).toBe('[1]');
    expect(asCompletedEvent(completed).response.output[1]).toEqual({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [],
    });
  });

  it('throws when the final output item does not match the streamed item at that index', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });

    expect(() =>
      translate({
        type: 'response.completed',
        response: {
          output: [
            {
              id: 'fc_MISMATCH',
              type: internalType,
              call_id: 'call_1',
              status: 'completed',
              name: 'search',
              arguments: '{}',
              output: '[]',
            },
          ],
        },
      }),
    ).toThrow('Internal final output does not match streamed output');
  });

  it('throws when the completed output references an index that was never streamed', () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));

    expect(() =>
      translate({
        type: 'response.completed',
        response: {
          output: [
            {
              id: 'fc_1',
              type: internalType,
              call_id: 'call_1',
              status: 'completed',
              name: 'search',
              arguments: '{}',
              output: '[]',
            },
          ],
        },
      }),
    ).toThrow('Internal final output does not match streamed output');
  });

  it('leaves non-internal items inside response.completed untouched', () => {
    const translate = createInternalTranslator(internalType);
    const event = {
      type: 'response.completed',
      response: {
        output: [{ id: 'msg_1', type: 'message', role: 'assistant', content: [] }],
      },
    };

    const result = translate(event);

    expect(asCompletedEvent(result).response.output[0]).toBe(event.response.output[0]);
  });
});

function sseStreamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]));
      i += 1;
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  result += decoder.decode();
  return result;
}

describe('withInternalToolsFetch', () => {
  it('throws for an empty (or whitespace-only) internal type', () => {
    expect(() => withInternalToolsFetch(jest.fn(), '   ')).toThrow(
      'Internal tool type must not be empty',
    );
  });

  it('passes through non-ok responses untouched', async () => {
    const baseFetch = jest.fn(async () => new Response('plain text', { status: 404 }));
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    const response = await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: '{"input":[]}',
    });

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('plain text');
  });

  it('passes through ok, non-SSE responses untouched', async () => {
    const baseFetch = jest.fn(
      async () =>
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    const response = await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: '{"input":[]}',
    });

    expect(await response.text()).toBe('{"ok":true}');
  });

  it('rewrites the outgoing request body and drops content-length when history contains internal carriers', async () => {
    const translate = createInternalTranslator(internalType, reqId('req1'));
    translate({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'search',
        arguments: '{}',
        output: '[]',
        error: null,
      },
    });

    const originalBody = JSON.stringify({ input: [done.item] });
    let receivedInit: RequestInit | undefined;
    const baseFetch = jest.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      receivedInit = init;
      return new Response('{}', { status: 200 });
    });
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: originalBody,
      headers: {
        'content-length': String(originalBody.length),
        'content-type': 'application/json',
      },
    });

    expect(baseFetch).toHaveBeenCalledTimes(1);
    const forwardedBody = JSON.parse(receivedInit!.body as string);
    expect(forwardedBody.input).toEqual([
      {
        type: 'function_call',
        call_id: 'lc_internal_req1_call_1',
        name: 'search',
        arguments: '{}',
      },
      { type: 'function_call_output', call_id: 'lc_internal_req1_call_1', output: '[]' },
    ]);
    expect(new Headers(receivedInit!.headers).has('content-length')).toBe(false);
  });

  it('leaves the request body/headers untouched when history has no internal carriers', async () => {
    const baseFetch = jest.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response('{}', { status: 200 }),
    );
    const wrapped = withInternalToolsFetch(baseFetch, internalType);
    const body = JSON.stringify({ input: [{ type: 'message', role: 'user', content: 'hi' }] });
    const init = { method: 'POST', body, headers: { 'content-length': String(body.length) } };

    await wrapped('https://internal.example.com/v1/responses', init);

    const [, receivedInit] = baseFetch.mock.calls[0]!;
    expect(receivedInit).toBe(init);
  });

  it('translates SSE frames and strips length/encoding headers on the transformed response', async () => {
    const raw = JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const body = sseStreamFromChunks([`data: ${raw}\n\n`, 'data: [DONE]\n\n']);
    const baseFetch = jest.fn(
      async () =>
        new Response(body, {
          status: 200,
          headers: {
            'content-type': 'text/event-stream',
            'content-length': '1234',
            'content-encoding': 'gzip',
          },
        }),
    );
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    const response = await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: '{"input":[]}',
    });

    expect(response.headers.has('content-length')).toBe(false);
    expect(response.headers.has('content-encoding')).toBe(false);

    const text = await readAll(response.body!);
    const frames = text
      .split('\n\n')
      .filter(Boolean)
      .map((f) => f.replace(/^data: /, ''));
    expect(frames).toHaveLength(2);
    expect(frames[1]).toBe('[DONE]');
    const translated = JSON.parse(frames[0]);
    expect(translated.type).toBe('response.output_item.done');
    expect(translated.item.type).toBe('mcp_call');
    expect(translated.item.name).toBe('search');
  });

  it('reassembles an SSE frame split across multiple stream chunks', async () => {
    const raw = JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const frame = `data: ${raw}\n\n`;
    const splitPoint = Math.floor(frame.length / 2);
    const body = sseStreamFromChunks([frame.slice(0, splitPoint), frame.slice(splitPoint)]);
    const baseFetch = jest.fn(
      async () =>
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    );
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    const response = await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: '{"input":[]}',
    });
    const text = await readAll(response.body!);
    const translated = JSON.parse(text.replace(/^data: /, '').trim());

    expect(translated.item.type).toBe('mcp_call');
  });

  it('supports a Node Readable response body alongside a Web ReadableStream', async () => {
    const raw = JSON.stringify({
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: {
        id: 'fc_1',
        type: internalType,
        call_id: 'call_1',
        status: 'in_progress',
        name: 'search',
        arguments: '',
      },
    });
    const nodeReadable = Readable.from([
      Buffer.from(`data: ${raw}\n\n`),
      Buffer.from('data: [DONE]\n\n'),
    ]);
    expect(typeof (nodeReadable as unknown as { getReader?: unknown }).getReader).not.toBe(
      'function',
    );

    const baseFetch = jest.fn(async () => {
      const response = new Response('{}', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      Object.defineProperty(response, 'body', { value: nodeReadable, configurable: true });
      return response;
    });
    const wrapped = withInternalToolsFetch(baseFetch, internalType);

    const response = await wrapped('https://internal.example.com/v1/responses', {
      method: 'POST',
      body: '{"input":[]}',
    });
    const text = await readAll(response.body!);

    expect(text).toContain('"type":"mcp_call"');
    expect(text).toContain('[DONE]');
  });
});

interface FakeGraph {
  getStepKey: jest.Mock;
  dispatchRunStep: jest.Mock;
  dispatchRunStepDelta: jest.Mock;
  getRunStep: jest.Mock;
  handlerRegistry?: { getHandler: jest.Mock };
  recordStepCompletion?: jest.Mock;
  getAgentContext: jest.Mock;
  stepKeyIds: Map<string, string[]>;
}

function createFakeGraph(overrides: Partial<FakeGraph> = {}) {
  const stepKeyIds = new Map<string, string[]>();
  let stepCounter = 0;
  const completionHandler = { handle: jest.fn(async () => undefined) };
  const graph: FakeGraph = {
    getStepKey: jest.fn(() => 'step-key-1'),
    dispatchRunStep: jest.fn(async (stepKey: string) => {
      stepCounter += 1;
      const stepId = `step-${stepCounter}`;
      const ids = stepKeyIds.get(stepKey) ?? [];
      ids.push(stepId);
      stepKeyIds.set(stepKey, ids);
      return stepId;
    }),
    dispatchRunStepDelta: jest.fn(async () => undefined),
    getRunStep: jest.fn((stepId: string) => ({ index: 0, id: stepId })),
    handlerRegistry: { getHandler: jest.fn(() => completionHandler) },
    recordStepCompletion: jest.fn(async () => undefined),
    getAgentContext: jest.fn(() => ({ agent: 'ctx' })),
    stepKeyIds,
    ...overrides,
  };
  return { graph, completionHandler, stepKeyIds };
}

describe('InternalToolsStreamHandler', () => {
  const metadata = { runId: 'run-1' };

  beforeEach(() => {
    mockSuperHandle.mockClear();
    mockHandleReasoning.mockClear();
  });

  function addedChunk(callId: string, requestId = 'req1') {
    const translate = createInternalTranslator(internalType, reqId(requestId));
    return {
      translate,
      added: translate({
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: `fc_${callId}`,
          type: internalType,
          call_id: callId,
          status: 'in_progress',
          name: 'semantic_search',
          arguments: '',
        },
      }),
    };
  }

  it('forwards to the base handler unchanged when there is no graph', async () => {
    const handler = new InternalToolsStreamHandler();
    const data = { chunk: { content: 'hi' } } as never;

    await handler.handle('on_chat_model_stream', data, metadata as never, undefined);

    expect(mockSuperHandle).toHaveBeenCalledWith('on_chat_model_stream', data, metadata, undefined);
  });

  it('forwards to the base handler unchanged when there is no chunk', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const data = {} as never;

    await handler.handle('on_chat_model_stream', data, metadata as never, graph as never);

    expect(mockSuperHandle).toHaveBeenCalledWith('on_chat_model_stream', data, metadata, graph);
    expect(graph.getStepKey).not.toHaveBeenCalled();
  });

  it('dispatches a new tool_calls run step on the first packet for a call', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { added } = addedChunk('call_1');

    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).toHaveBeenCalledTimes(1);
    expect(graph.dispatchRunStep).toHaveBeenCalledWith(
      'step-key-1',
      {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [
          { type: 'tool_call', id: 'lc_internal_req1_call_1', name: 'semantic_search', args: {} },
        ],
      },
      metadata,
    );
  });

  it('dispatches run-step deltas for subsequent argument chunks without re-dispatching the step', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const delta1 = translate({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_call_1',
      output_index: 0,
      delta: '{"q":',
    });
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [delta1.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const delta2 = translate({
      type: 'response.function_call_arguments.delta',
      item_id: 'fc_call_1',
      output_index: 0,
      delta: '"x"}',
    });
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [delta2.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).toHaveBeenCalledTimes(1);
    expect(graph.dispatchRunStepDelta).toHaveBeenCalledTimes(2);
    expect(graph.dispatchRunStepDelta).toHaveBeenNthCalledWith(
      1,
      'step-1',
      {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [
          { type: 'tool_call_chunk', id: 'lc_internal_req1_call_1', index: 0, args: '{"q":' },
        ],
      },
      metadata,
    );
    expect(graph.dispatchRunStepDelta).toHaveBeenNthCalledWith(
      2,
      'step-1',
      {
        type: StepTypes.TOOL_CALLS,
        tool_calls: [
          { type: 'tool_call_chunk', id: 'lc_internal_req1_call_1', index: 0, args: '"x"}' },
        ],
      },
      metadata,
    );
  });

  it('ignores duplicate/out-of-order packets (same or lower revision) for a call already being tracked', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { added } = addedChunk('call_1');

    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );
    // Replay the exact same packet again (e.g. a duplicated stream chunk).
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).toHaveBeenCalledTimes(1);
    expect(graph.dispatchRunStepDelta).not.toHaveBeenCalled();
  });

  it('dispatches ON_RUN_STEP_COMPLETED with the resolved output and progress 1 when the packet is done', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph, completionHandler } = createFakeGraph();
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_call_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'semantic_search',
        arguments: '{"q":"x"}',
        output: '[{"part":"A"}]',
        error: null,
      },
    });
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [done.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.handlerRegistry!.getHandler).toHaveBeenCalledWith(
      GraphEvents.ON_RUN_STEP_COMPLETED,
    );
    expect(completionHandler.handle).toHaveBeenCalledWith(
      GraphEvents.ON_RUN_STEP_COMPLETED,
      {
        result: {
          id: 'step-1',
          index: 0,
          type: 'tool_call',
          tool_call: {
            id: 'lc_internal_req1_call_1',
            name: 'semantic_search',
            args: '{"q":"x"}',
            output: '[{"part":"A"}]',
            progress: 1,
          },
        },
      },
      metadata,
      graph,
    );
    expect(graph.recordStepCompletion).toHaveBeenCalledWith('step-1', {
      toolCallId: 'lc_internal_req1_call_1',
      metadata,
    });
  });

  it('throws when the standard tool completion handler is missing from the registry', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph({
      handlerRegistry: { getHandler: jest.fn(() => undefined) },
    });
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_call_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'semantic_search',
        arguments: '{}',
        output: '[]',
        error: null,
      },
    });

    await expect(
      handler.handle(
        'on_chat_model_stream',
        { chunk: { additional_kwargs: { tool_outputs: [done.item] }, content: '' } } as never,
        metadata as never,
        graph as never,
      ),
    ).rejects.toThrow('Standard tool completion handler is missing');
  });

  it('throws when the run step for the completed packet is missing', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph({ getRunStep: jest.fn(() => undefined) });
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_call_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'semantic_search',
        arguments: '{}',
        output: '[]',
        error: null,
      },
    });

    await expect(
      handler.handle(
        'on_chat_model_stream',
        { chunk: { additional_kwargs: { tool_outputs: [done.item] }, content: '' } } as never,
        metadata as never,
        graph as never,
      ),
    ).rejects.toThrow('Standard tool completion handler is missing');
  });

  it('tolerates the absence of an optional recordStepCompletion on the graph', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph({ recordStepCompletion: undefined });
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_call_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'semantic_search',
        arguments: '{}',
        output: '[]',
        error: null,
      },
    });

    await expect(
      handler.handle(
        'on_chat_model_stream',
        { chunk: { additional_kwargs: { tool_outputs: [done.item] }, content: '' } } as never,
        metadata as never,
        graph as never,
      ),
    ).resolves.toBeUndefined();
  });

  it('suppresses forwarding to the base handler when handled with no content and no tool_call_chunks', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { added } = addedChunk('call_1');

    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    expect(mockSuperHandle).not.toHaveBeenCalled();
  });

  it('forwards content chunks to the base handler and calls handleReasoning', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const chunk = { additional_kwargs: {}, content: 'Hello world' };

    await handler.handle(
      'on_chat_model_stream',
      { chunk } as never,
      metadata as never,
      graph as never,
    );

    expect(mockHandleReasoning).toHaveBeenCalledWith(
      chunk,
      graph.getAgentContext.mock.results[0]!.value,
    );
    expect(mockSuperHandle).toHaveBeenCalledWith(
      'on_chat_model_stream',
      { chunk },
      metadata,
      graph,
    );
  });

  it('does not dispatch a fresh message step when the previous step was not an internal tool step', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const chunk = { additional_kwargs: {}, content: 'Hello world' };

    await handler.handle(
      'on_chat_model_stream',
      { chunk } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).not.toHaveBeenCalled();
  });

  it('dispatches a MESSAGE_CREATION step when the previous step for this stepKey was an internal tool step', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { translate, added } = addedChunk('call_1');
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );
    const done = translate({
      type: 'response.output_item.done',
      output_index: 0,
      item: {
        id: 'fc_call_1',
        type: internalType,
        call_id: 'call_1',
        status: 'completed',
        name: 'semantic_search',
        arguments: '{}',
        output: '[]',
        error: null,
      },
    });
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [done.item] }, content: '' } } as never,
      metadata as never,
      graph as never,
    );

    const contentChunk = { additional_kwargs: {}, content: 'Here is what I found', id: 'msg_42' };
    await handler.handle(
      'on_chat_model_stream',
      { chunk: contentChunk } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).toHaveBeenCalledTimes(2);
    expect(graph.dispatchRunStep).toHaveBeenLastCalledWith(
      'step-key-1',
      { type: StepTypes.MESSAGE_CREATION, message_creation: { message_id: 'msg_42' } },
      metadata,
    );
  });

  it('unwraps a `message` wrapper on data.chunk before processing and forwarding', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const { added } = addedChunk('call_1');
    const innerChunk = { additional_kwargs: { tool_outputs: [added.item] }, content: '' };

    await handler.handle(
      'on_chat_model_stream',
      { chunk: { message: innerChunk } } as never,
      metadata as never,
      graph as never,
    );

    expect(graph.dispatchRunStep).toHaveBeenCalledTimes(1);
    expect(mockSuperHandle).not.toHaveBeenCalled();

    const contentInnerChunk = { additional_kwargs: {}, content: 'hi' };
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { message: contentInnerChunk } } as never,
      metadata as never,
      graph as never,
    );

    const [, forwardedData] = mockSuperHandle.mock.calls[0]!;
    expect((forwardedData as { chunk: unknown }).chunk).toBe(contentInnerChunk);
  });

  it('does not call handleReasoning or dispatch a message step when native tool_call_chunks accompany content', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph } = createFakeGraph();
    const chunk = {
      additional_kwargs: {},
      content: 'partial',
      tool_call_chunks: [{ name: 'external_tool', args: '{}', id: 'call_ext', index: 0 }],
    };

    await handler.handle(
      'on_chat_model_stream',
      { chunk } as never,
      metadata as never,
      graph as never,
    );

    expect(mockHandleReasoning).not.toHaveBeenCalled();
    expect(graph.dispatchRunStep).not.toHaveBeenCalled();
    expect(mockSuperHandle).toHaveBeenCalledWith(
      'on_chat_model_stream',
      { chunk },
      metadata,
      graph,
    );
  });

  it('keeps state isolated per graph: two graphs processing the same packet each dispatch independently', async () => {
    const handler = new InternalToolsStreamHandler();
    const { graph: graphA } = createFakeGraph();
    const { graph: graphB } = createFakeGraph();
    const { added } = addedChunk('call_1');

    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graphA as never,
    );
    await handler.handle(
      'on_chat_model_stream',
      { chunk: { additional_kwargs: { tool_outputs: [added.item] }, content: '' } } as never,
      metadata as never,
      graphB as never,
    );

    expect(graphA.dispatchRunStep).toHaveBeenCalledTimes(1);
    expect(graphB.dispatchRunStep).toHaveBeenCalledTimes(1);
  });
});
