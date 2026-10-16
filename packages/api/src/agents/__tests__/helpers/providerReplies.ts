/**
 * Scripted model replies in each provider's own wire format, streamed when the
 * provider class asked for a stream: a text answer, or tool calls.
 */
import type { Captured, ProviderCase } from './providerCapture';

export type Reply =
  | { text: string }
  | { calls: Array<{ id: string; name: string; args: Record<string, unknown> }> };

const sse = (events: Array<[string | null, object | string]>) =>
  events
    .map(
      ([event, data]) =>
        `${event ? `event: ${event}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`,
    )
    .join('');

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function anthropicReply(reply: Reply, id: string): string {
  const blocks =
    'text' in reply
      ? [
          [
            { type: 'text', text: '' },
            { type: 'text_delta', text: reply.text },
          ],
        ]
      : reply.calls.map(({ id, name, args }) => [
          { type: 'tool_use', id, name, input: {} },
          { type: 'input_json_delta', partial_json: JSON.stringify(args) },
        ]);
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id,
          type: 'message',
          role: 'assistant',
          model: 'model',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      },
    ],
    ...blocks.flatMap(
      ([start, delta], index): Array<[string, object]> => [
        ['content_block_start', { type: 'content_block_start', index, content_block: start }],
        ['content_block_delta', { type: 'content_block_delta', index, delta }],
        ['content_block_stop', { type: 'content_block_stop', index }],
      ],
    ),
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null },
        usage: { output_tokens: 1 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function googleReply(reply: Reply, request: Captured): unknown {
  const parts =
    'text' in reply
      ? [{ text: reply.text }]
      : reply.calls.map(({ name, args }) => ({ functionCall: { name, args } }));
  const chunk = {
    candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }],
    usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
  };
  if (request.stream !== true) {
    return chunk;
  }
  /** Without `alt=sse` the stream is one JSON array of responses. */
  return request.url?.includes('alt=sse') === true ? sse([[null, chunk]]) : JSON.stringify([chunk]);
}

function bedrockReply(reply: Reply, request: Captured): unknown {
  const blocks =
    'text' in reply
      ? [{ delta: { text: reply.text } }]
      : reply.calls.map(({ id, name, args }) => ({
          start: { toolUse: { toolUseId: id, name } },
          delta: { toolUse: { input: JSON.stringify(args) } },
        }));
  const stopReason = 'text' in reply ? 'end_turn' : 'tool_use';
  if (request.stream !== true) {
    const content =
      'text' in reply
        ? [{ text: reply.text }]
        : reply.calls.map(({ id, name, args }) => ({
            toolUse: { toolUseId: id, name, input: args },
          }));
    return {
      output: { message: { role: 'assistant', content } },
      stopReason,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
  }
  const events = [
    { messageStart: { role: 'assistant' } },
    ...blocks.flatMap((block, contentBlockIndex) => [
      ...('start' in block
        ? [{ contentBlockStart: { contentBlockIndex, start: block.start } }]
        : []),
      { contentBlockDelta: { contentBlockIndex, delta: block.delta } },
      { contentBlockStop: { contentBlockIndex } },
    ]),
    { messageStop: { stopReason } },
    {
      metadata: {
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        metrics: { latencyMs: 1 },
      },
    },
  ];
  return {
    stream: (async function* () {
      yield* events;
    })(),
  };
}

function chatCompletionsReply(reply: Reply, request: Captured, id: string): unknown {
  const toolCalls =
    'calls' in reply
      ? reply.calls.map(({ id, name, args }, index) => ({
          index,
          id,
          type: 'function',
          function: { name, arguments: JSON.stringify(args) },
        }))
      : undefined;
  const finish = toolCalls ? 'tool_calls' : 'stop';
  const content = 'text' in reply ? reply.text : '';
  const base = { id, created: 1, model: 'model', usage: USAGE };
  if (request.stream !== true) {
    return {
      ...base,
      object: 'chat.completion',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content, ...(toolCalls && { tool_calls: toolCalls }) },
          finish_reason: finish,
        },
      ],
    };
  }
  return sse([
    [
      null,
      {
        ...base,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content, ...(toolCalls && { tool_calls: toolCalls }) },
            finish_reason: finish,
          },
        ],
      },
    ],
    [null, '[DONE]'],
  ]);
}

/**
 * A Responses API reply: an encrypted reasoning item, then the text message or the function
 * calls, each with the ids and status the provider sends.
 */
function responsesReply(reply: Reply, request: Captured, id: string): unknown {
  const output: Array<Record<string, unknown>> = [
    {
      id: `rs_${id}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: `Reasoning ${id}.` }],
      encrypted_content: `encrypted_${id}`,
    },
  ];
  if ('text' in reply) {
    output.push({
      id,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', annotations: [], logprobs: [], text: reply.text }],
    });
  } else {
    reply.calls.forEach((call, index) =>
      output.push({
        id: `fc_${id}_${index}`,
        type: 'function_call',
        status: 'completed',
        call_id: call.id,
        name: call.name,
        arguments: JSON.stringify(call.args),
      }),
    );
  }
  const response = {
    id: `resp_${id}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model: 'model',
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      total_tokens: 2,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    },
  };
  if (request.stream !== true) {
    return { ...response, status: 'completed', output };
  }
  const frames: Array<[string, Record<string, unknown>]> = [
    ['response.created', { response: { ...response, status: 'in_progress', output: [] } }],
  ];
  output.forEach((item, output_index) => {
    frames.push(['response.output_item.added', { output_index, item: inProgress(item) }]);
    if (item.type === 'message') {
      frames.push([
        'response.output_text.delta',
        {
          item_id: item.id,
          output_index,
          content_index: 0,
          delta: (reply as { text: string }).text,
          logprobs: [],
        },
      ]);
    } else if (item.type === 'function_call') {
      frames.push([
        'response.function_call_arguments.delta',
        { item_id: item.id, output_index, delta: item.arguments },
      ]);
    }
    frames.push(['response.output_item.done', { output_index, item }]);
  });
  frames.push(['response.completed', { response: { ...response, status: 'completed', output } }]);
  return sse(
    frames.map(([type, data], sequence_number) => [type, { type, sequence_number, ...data }]),
  );
}

function inProgress(item: Record<string, unknown>): Record<string, unknown> {
  switch (item.type) {
    case 'message':
      return { ...item, status: 'in_progress', content: [] };
    case 'function_call':
      return { ...item, status: 'in_progress', arguments: '' };
    default:
      return { id: item.id, type: item.type, summary: [] };
  }
}

let replyCount = 0;

/**
 * The scripted reply to a captured request, in the provider's format. Every reply gets its own
 * message id: the graph's message reducer merges messages that share one.
 */
export function providerReply(
  providerCase: ProviderCase,
  request: Captured,
  reply: Reply,
): unknown {
  const id = `msg_${++replyCount}`;
  switch (providerCase.format) {
    case 'anthropic':
      return anthropicReply(reply, id);
    case 'google':
      return googleReply(reply, request);
    case 'bedrock':
      return bedrockReply(reply, request);
    case 'responses':
      return responsesReply(reply, request, id);
    default:
      return chatCompletionsReply(reply, request, id);
  }
}
