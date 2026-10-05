/**
 * Internal (Backend-hosted) tool call adapter
 *
 * Custom Responses-API-compatible backend executes some tool calls server-side and streams them back as a
 * custom, non-standard Responses-API item type prefixed with its implementor
 * slug (e.g. `implementor_slug:function_call`), per the Open Responses
 * extensibility guidelines for hosted tools and extended item types. This
 * module translates that custom item type in-flight into the standard
 * `mcp_call` item shape (real data preserved under a hidden carrier key) so
 * the existing MCP UI/parsing/history-replay code paths can render and
 * round-trip these calls without any new frontend code.
 *
 * @see https://openresponses.org/specification#streaming
 * @see https://openresponses.org/specification#extending-tools
 * @see https://openresponses.org/specification#extending-items
 */
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { ChatModelStreamHandler, GraphEvents, StepTypes } from '@librechat/agents';
import type { AIMessageChunk } from '@librechat/agents/langchain/messages';

type ObjectValue = Record<string, unknown>;
export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type HandleArgs = Parameters<ChatModelStreamHandler['handle']>;
type Packet = {
  key: string;
  revision: number;
  phase: 'added' | 'delta' | 'arguments_done' | 'done';
  item: ObjectValue & {
    id: string;
    call_id: string;
    name: string;
    arguments: string;
    status: string;
  };
};
const CARRIER = '__librechat_internal_tool';
const isObject = (value: unknown): value is ObjectValue =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const asText = (value: unknown): string =>
  typeof value === 'string' ? value : JSON.stringify(value ?? null);

function resultText(item: Packet['item']): string {
  // eslint-disable-next-line no-nested-ternary
  return item.status === 'failed' || item.error != null
    ? `Error processing tool: ${asText(item.error ?? { message: 'Upstream tool failed' })}`
    : item.status === 'completed'
      ? asText(item.output)
      : '';
}

function carrier(packet: Packet): ObjectValue {
  return {
    type: 'mcp_call',
    id: packet.item.id,
    name: packet.item.name,
    server_label: 'librechat-internal-adapter',
    arguments: packet.item.arguments,
    output: resultText(packet.item),
    error: packet.item.error ?? null,
    status: packet.item.status,
    [CARRIER]: packet,
  };
}

function packetOf(value: unknown): Packet | undefined {
  if (!isObject(value) || value.type !== 'mcp_call') return;
  const p = value[CARRIER];
  if (
    !isObject(p) ||
    typeof p.key !== 'string' ||
    typeof p.revision !== 'number' ||
    !isObject(p.item) ||
    typeof p.item.id !== 'string' ||
    typeof p.item.call_id !== 'string' ||
    typeof p.item.name !== 'string' ||
    typeof p.item.arguments !== 'string' ||
    typeof p.item.status !== 'string' ||
    !['added', 'delta', 'arguments_done', 'done'].includes(String(p.phase))
  )
    return;
  return p as Packet;
}

/** Converts only the adapter's backend envelopes into normal Responses tool history. */
export function projectInternalHistory(body: string): string {
  const request: unknown = JSON.parse(body);
  if (!isObject(request) || !Array.isArray(request.input)) return body;
  const latest = new Map<string, Packet>();
  for (const item of request.input) {
    const p = packetOf(item);
    if (p && p.revision >= (latest.get(p.key)?.revision ?? -1)) latest.set(p.key, p);
  }
  if (!latest.size) return body;
  const seen = new Set<string>();
  const input = request.input.flatMap((item: unknown) => {
    const p = packetOf(item);
    if (!p) return [item];
    if (seen.has(p.key)) return [];
    seen.add(p.key);
    const last = latest.get(p.key)!;
    return [
      {
        type: 'function_call',
        call_id: last.key,
        name: last.item.name,
        arguments: last.item.arguments,
      },
      { type: 'function_call_output', call_id: last.key, output: resultText(last.item) },
    ];
  });
  return JSON.stringify({ ...request, input });
}

/** Per-request state. External calls are never renamed or consumed. */
export function createInternalTranslator(internalType: string, requestId = randomUUID()) {
  const calls = new Map<number, Packet>();
  let sequence = 0;
  return (event: ObjectValue): ObjectValue => {
    const index = event.output_index;
    const item = event.item;
    let packet = typeof index === 'number' ? calls.get(index) : undefined;
    let phase: Packet['phase'] | undefined;
    if (
      (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') &&
      isObject(item) &&
      item.type === internalType
    ) {
      if (
        typeof index !== 'number' ||
        typeof item.id !== 'string' ||
        typeof item.call_id !== 'string' ||
        typeof item.name !== 'string' ||
        typeof item.arguments !== 'string' ||
        typeof item.status !== 'string'
      ) {
        throw new Error('Invalid internal tool item');
      }
      if (packet && (packet.item.id !== item.id || packet.item.call_id !== item.call_id)) {
        throw new Error('Internal tool identity changed at the same output_index');
      }
      packet = {
        key: packet?.key ?? `lc_internal_${requestId}_${item.call_id}`,
        revision: sequence++,
        phase: event.type === 'response.output_item.added' ? 'added' : 'done',
        item: { ...item } as Packet['item'],
      };
      phase = packet.phase;
    } else if (
      packet &&
      (event.type === 'response.function_call_arguments.delta' ||
        event.type === 'response.function_call_arguments.done')
    ) {
      if (event.item_id !== packet.item.id) throw new Error('Internal argument item_id mismatch');
      const delta = event.type === 'response.function_call_arguments.delta';
      const value = delta ? event.delta : event.arguments;
      if (typeof value !== 'string') throw new Error('Invalid internal tool arguments');
      phase = delta ? 'delta' : 'arguments_done';
      packet = {
        ...packet,
        revision: sequence++,
        phase,
        item: { ...packet.item, arguments: delta ? packet.item.arguments + value : value },
      };
    }
    if (packet && phase && typeof index === 'number') {
      calls.set(index, packet);
      // mcp_call is a non-executable backend carrier supported by the existing parser.
      return {
        type: 'response.output_item.done',
        output_index: index,
        sequence_number: event.sequence_number,
        item: carrier(packet),
      };
    }
    if (isObject(event.response) && Array.isArray(event.response.output)) {
      return {
        ...event,
        response: {
          ...event.response,
          output: event.response.output.map((output: unknown, outputIndex: number) => {
            if (!isObject(output) || output.type !== internalType) return output;
            const p = calls.get(outputIndex);
            if (!p || p.item.id !== output.id)
              throw new Error('Internal final output does not match streamed output');
            return carrier(p);
          }),
        },
      };
    }
    return event;
  };
}

export function withInternalToolsFetch(baseFetch: FetchFn, internalType: string): FetchFn {
  if (!internalType.trim()) throw new Error('Internal tool type must not be empty');
  return async (input, init) => {
    let options = init;
    if (typeof init?.body === 'string') {
      const body = projectInternalHistory(init.body);
      if (body !== init.body) {
        const headers = new Headers(init.headers);
        headers.delete('content-length');
        options = { ...init, body, headers };
      }
    }
    const response = await baseFetch(input, options);
    if (
      !response.ok ||
      !response.body ||
      !response.headers.get('content-type')?.includes('text/event-stream')
    )
      return response;
    const source =
      typeof response.body.getReader === 'function'
        ? response.body
        : (Readable.toWeb(
            response.body as unknown as Readable,
          ) as unknown as ReadableStream<Uint8Array>);
    const translate = createInternalTranslator(internalType);
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let data: string[] = [];
    let previousCR = false;
    const frame = (controller: TransformStreamDefaultController<Uint8Array>) => {
      if (!data.length) return;
      const value = data.join('\n');
      data = [];
      if (!value) return;
      const output = value === '[DONE]' ? value : JSON.stringify(translate(JSON.parse(value)));
      controller.enqueue(encoder.encode(`data: ${output}\n\n`));
    };
    const append = (text: string, controller: TransformStreamDefaultController<Uint8Array>) => {
      if (!text) return;
      if (previousCR && text.startsWith('\n')) text = text.slice(1);
      previousCR = text.endsWith('\r');
      buffer += text.replace(/\r\n|\r/g, '\n');
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        if (!line) frame(controller);
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    };
    const transform = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        append(decoder.decode(chunk, { stream: true }), controller);
      },
      flush(controller) {
        append(decoder.decode(), controller);
        if (buffer) append('\n', controller);
        frame(controller);
      },
    });
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    headers.delete('content-encoding');
    return new Response(source.pipeThrough(transform), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

/** Uses standard run steps; never adds executable tool_calls to an AIMessage. */
export class InternalToolsStreamHandler extends ChatModelStreamHandler {
  private graphs = new WeakMap<
    NonNullable<HandleArgs[3]>,
    {
      calls: Map<string, { stepId: string; revision: number; args: string }>;
      internalSteps: Set<string>;
    }
  >();

  override async handle(...args: HandleArgs): Promise<void> {
    const [event, data, metadata, graph] = args;
    if (!graph || !data.chunk) return super.handle(...args);
    let graphState = this.graphs.get(graph);
    if (!graphState) {
      graphState = { calls: new Map(), internalSteps: new Set() };
      this.graphs.set(graph, graphState);
    }
    const { calls, internalSteps } = graphState;
    // Match the standard handler's AIMessageChunk input. Generation wrappers
    // are unwrapped here before forwarding them to the standard handler.
    const chunk = ('message' in data.chunk ? data.chunk.message : data.chunk) as AIMessageChunk;
    const forwardedData = { ...data, chunk };
    const outputs = chunk.additional_kwargs?.tool_outputs;
    let handled = false;
    if (Array.isArray(outputs)) {
      for (const output of outputs) {
        const packet = packetOf(output);
        if (!packet) continue;
        handled = true;
        let state = calls.get(packet.key);
        if (state && state.revision >= packet.revision) continue;
        if (!state) {
          const stepId = await graph.dispatchRunStep(
            graph.getStepKey(metadata),
            {
              type: StepTypes.TOOL_CALLS,
              tool_calls: [{ type: 'tool_call', id: packet.key, name: packet.item.name, args: {} }],
            },
            metadata,
          );
          state = { stepId, revision: -1, args: '' };
          calls.set(packet.key, state);
          internalSteps.add(stepId);
        }
        if (packet.phase !== 'done' && packet.item.arguments.startsWith(state.args)) {
          const delta = packet.item.arguments.slice(state.args.length);
          if (delta)
            await graph.dispatchRunStepDelta(
              state.stepId,
              {
                type: StepTypes.TOOL_CALLS,
                tool_calls: [{ type: 'tool_call_chunk', id: packet.key, index: 0, args: delta }],
              },
              metadata,
            );
          state.args = packet.item.arguments;
        }
        state.revision = packet.revision;
        if (packet.phase === 'done') {
          const step = graph.getRunStep(state.stepId);
          const handler = graph.handlerRegistry?.getHandler(GraphEvents.ON_RUN_STEP_COMPLETED);
          if (!step || !handler) throw new Error('Standard tool completion handler is missing');
          await handler.handle(
            GraphEvents.ON_RUN_STEP_COMPLETED,
            {
              result: {
                id: state.stepId,
                index: step.index,
                type: 'tool_call',
                tool_call: {
                  id: packet.key,
                  name: packet.item.name,
                  args: packet.item.arguments,
                  output: resultText(packet.item),
                  progress:
                    packet.item.status === 'completed' ||
                    packet.item.status === 'failed' ||
                    packet.item.error != null
                      ? 1
                      : 0.1,
                },
              },
            },
            metadata,
            graph,
          );
          if (typeof graph.recordStepCompletion === 'function') {
            await graph.recordStepCompletion(state.stepId, {
              toolCallId: packet.key,
              metadata,
            });
          }
        }
      }
    }
    const content = chunk.content;
    const hasContent =
      typeof content === 'string'
        ? content.length > 0
        : Array.isArray(content) && content.length > 0;
    if (handled && !hasContent && !chunk.tool_call_chunks?.length) return;
    if (hasContent && !chunk.tool_call_chunks?.length) {
      this.handleReasoning(chunk, graph.getAgentContext(metadata));
      const stepKey = graph.getStepKey(metadata);
      const ids = graph.stepKeyIds.get(stepKey);
      const previous = ids?.[ids.length - 1];
      if (previous && internalSteps.has(previous)) {
        await graph.dispatchRunStep(
          stepKey,
          {
            type: StepTypes.MESSAGE_CREATION,
            message_creation: { message_id: chunk.id ?? `msg_${randomUUID()}` },
          },
          metadata,
        );
      }
    }
    return super.handle(event, forwardedData, metadata, graph);
  }
}
