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
    default:
      return chatCompletionsReply(reply, request, id);
  }
}
