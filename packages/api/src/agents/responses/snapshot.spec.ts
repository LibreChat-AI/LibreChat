import { responseSnapshotEvents } from './snapshot';

it('preserves IDs, phase, annotations, usage and content through a complete text lifecycle', () => {
  const response = {
    object: 'response',
    id: 'response',
    status: 'completed',
    usage: { total_tokens: 7 },
    output: [
      {
        id: 'message',
        type: 'message',
        status: 'completed',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'héllo 🌎', annotations: [{ type: 'test' }] }],
      },
    ],
  };
  const events = [...responseSnapshotEvents(response)];
  expect(events.map((event) => event.sequence_number)).toEqual(events.map((_, index) => index));
  expect(events.map((event) => event.type)).toEqual([
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  expect(events[4]).toMatchObject({
    item_id: 'message',
    output_index: 0,
    content_index: 0,
    delta: 'héllo 🌎',
    logprobs: [],
  });
  expect(events[events.length - 1]?.response).toEqual(response);
  expect(response.output[0].content[0].text).toBe('héllo 🌎');
});

it('projects tool calls and tool outputs without inventing IDs or arguments', () => {
  const output = [
    {
      id: 'call',
      type: 'function_call',
      call_id: 'client-call',
      name: 'client',
      arguments: '{"x":1}',
      status: 'completed',
    },
    {
      id: 'result',
      type: 'function_call_output',
      call_id: 'client-call',
      output: 'done',
      status: 'completed',
    },
  ];
  const events = [
    ...responseSnapshotEvents({ object: 'response', id: 'r', status: 'completed', output }),
  ];
  expect(
    events.find((event) => event.type === 'response.function_call_arguments.done'),
  ).toMatchObject({ item_id: 'call', call_id: 'client-call', arguments: '{"x":1}' });
  expect(
    events.filter((event) => event.type === 'response.output_item.done').map((event) => event.item),
  ).toEqual(output);
});

it('projects reasoning, summary and refusal content with their own event fields', () => {
  const events = [
    ...responseSnapshotEvents({
      object: 'response',
      id: 'r',
      status: 'incomplete',
      output: [
        {
          id: 'reason',
          type: 'reasoning',
          status: 'completed',
          content: [{ type: 'reasoning_text', text: 'think' }],
          summary: [{ type: 'summary_text', text: 'summary' }],
        },
        {
          id: 'answer',
          type: 'message',
          status: 'incomplete',
          content: [{ type: 'refusal', refusal: 'Cannot answer' }],
        },
      ],
    }),
  ];
  expect(events.find((event) => event.type === 'response.reasoning.done')).toMatchObject({
    text: 'think',
    content_index: 0,
  });
  expect(
    events.find((event) => event.type === 'response.reasoning_summary_text.done'),
  ).toMatchObject({ text: 'summary', summary_index: 0 });
  expect(events.find((event) => event.type === 'response.refusal.done')).toMatchObject({
    refusal: 'Cannot answer',
  });
  expect(events[events.length - 1]?.type).toBe('response.incomplete');
});

it('rejects a non-response JSON body before emitting events', () => {
  expect(() => [...responseSnapshotEvents({ message: 'not a response' })]).toThrow();
});
