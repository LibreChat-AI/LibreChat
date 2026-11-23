import { AIMessageChunk } from '@langchain/core/messages';
import type { OutputTruncationSink, TruncationContentPart } from './truncation';
import {
  isModelTruncated,
  getModelCallEnding,
  recordModelTruncation,
  settleOutputTruncation,
} from './truncation';

/** A streamed Gemini turn as the SDK aggregates it: each chunk carries its candidate's fields. */
function streamed(chunks: ConstructorParameters<typeof AIMessageChunk>[0][]): AIMessageChunk {
  return chunks
    .map((fields) => new AIMessageChunk(fields))
    .reduce((left, right) => left.concat(right));
}

const code = JSON.stringify({ type: 'output_budget_exhausted' });
const think: TruncationContentPart = { type: 'think', think: 'Reasoning so far' };

describe('isModelTruncated', () => {
  it('reads the Google AI Studio finish reason', () => {
    const output = streamed([
      { content: '', additional_kwargs: { reasoning: 'Thinking...' } },
      { content: '', response_metadata: { index: 0, finishReason: 'MAX_TOKENS' } },
    ]);
    expect(isModelTruncated(output)).toBe(true);
  });

  it('reads the Vertex AI finish reason past its stream-end stop sentinel', () => {
    const output = streamed([
      {
        content: [{ type: 'reasoning', reasoning: 'Thinking...' }],
        response_metadata: { finish_reason: 'MAX_TOKENS' },
      },
      { content: '', response_metadata: { finishReason: 'stop' } },
    ]);
    expect(isModelTruncated(output)).toBe(true);
  });

  it('treats a CONTINUATION segment as truncated', () => {
    expect(
      isModelTruncated({ content: 'Segment', response_metadata: { finishReason: 'CONTINUATION' } }),
    ).toBe(true);
  });

  it.each([
    { content: 'Done', response_metadata: { finishReason: 'STOP' } },
    { content: '', response_metadata: { finish_reason: 'STOP', finishReason: 'stop' } },
    { content: 'Done', response_metadata: {} },
    { content: 'Too long', response_metadata: { finish_reason: 'length' } },
    { content: 'Too long', response_metadata: { stop_reason: 'max_tokens' } },
  ])('leaves other endings alone: %j', (output) => {
    expect(isModelTruncated(output)).toBe(false);
  });

  it('does not count calls with tool calls as answers', () => {
    expect(
      isModelTruncated({
        content: '',
        tool_calls: [{ id: 'call_1', name: 'search', args: {} }],
        response_metadata: { finishReason: 'MAX_TOKENS' },
      }),
    ).toBe(false);
    expect(
      isModelTruncated({
        content: '',
        tool_call_chunks: [{ id: 'call_1', name: 'search', args: '{"q":' }],
        response_metadata: { finishReason: 'MAX_TOKENS' },
      }),
    ).toBe(false);
  });

  it('tolerates a missing output', () => {
    expect(isModelTruncated(undefined)).toBe(false);
    expect(isModelTruncated(null)).toBe(false);
  });
});

describe('getModelCallEnding', () => {
  it.each([
    [{ content: '', response_metadata: { finishReason: 'MAX_TOKENS' } }, 'exhausted'],
    [
      {
        content: [{ type: 'text', text: '\n\n' }],
        response_metadata: { finishReason: 'MAX_TOKENS' },
      },
      'exhausted',
    ],
    [
      {
        content: [
          { type: 'reasoning', text: 'not an answer' },
          { type: 'text', text: 'An answer' },
        ],
        response_metadata: { finish_reason: 'MAX_TOKENS' },
      },
      'partial',
    ],
    [{ content: 'Segment', response_metadata: { finishReason: 'CONTINUATION' } }, 'partial'],
    [{ content: 'Done', response_metadata: { finishReason: 'STOP' } }, 'complete'],
  ] as const)('judges %j as %s', (output, expected) => {
    expect(getModelCallEnding(output)).toBe(expected);
  });
});

describe('recordModelTruncation', () => {
  const exhausted = { content: '', response_metadata: { finishReason: 'MAX_TOKENS' } };
  const partial = { content: 'Half', response_metadata: { finishReason: 'MAX_TOKENS' } };
  const completed = { content: 'Done', response_metadata: { finishReason: 'STOP' } };

  it('keeps each agent on its latest call', () => {
    const sink: OutputTruncationSink = {};
    recordModelTruncation(sink, exhausted, { langgraph_node: 'agent=a' });
    recordModelTruncation(sink, partial, { langgraph_node: 'agent=b' });
    expect(sink.calls).toEqual({ 'agent=a': 'exhausted', 'agent=b': 'partial' });
    recordModelTruncation(sink, completed, { langgraph_node: 'agent=a' });
    expect(sink.calls).toEqual({ 'agent=a': 'complete', 'agent=b': 'partial' });
  });

  it('ignores summarization calls', () => {
    const sink: OutputTruncationSink = {};
    recordModelTruncation(sink, exhausted, { langgraph_node: 'summarize=agent_1' });
    expect(sink).toEqual({});
  });

  it('skips non-final sequential agents whose output is hidden', () => {
    const sink: OutputTruncationSink = {};
    const hidden = { hide_sequential_outputs: true, last_agent_id: 'agent_b' };
    recordModelTruncation(sink, exhausted, { ...hidden, langgraph_node: 'agent=agent_a' });
    expect(sink).toEqual({});
    recordModelTruncation(sink, partial, { ...hidden, langgraph_node: 'agent=agent_b' });
    expect(sink.calls).toEqual({ 'agent=agent_b': 'partial' });
  });

  it('accepts a missing sink and missing metadata', () => {
    expect(() => recordModelTruncation(undefined, exhausted)).not.toThrow();
    const sink: OutputTruncationSink = {};
    recordModelTruncation(sink, exhausted);
    expect(sink.calls).toEqual({ '': 'exhausted' });
  });
});

describe('settleOutputTruncation', () => {
  const preamble: TruncationContentPart = { type: 'text', text: 'Let me search first.' };

  it('adds the code-only error part when an agent wrote no answer, whatever text came before', () => {
    const parts: TruncationContentPart[] = [preamble, think];
    expect(settleOutputTruncation({ calls: { 'agent=a': 'exhausted' } }, parts)).toBeUndefined();
    expect(parts).toEqual([preamble, think, { type: 'error', error: code }]);
  });

  it('prefers the notice over Continue when parallel agents end both ways', () => {
    const parts: TruncationContentPart[] = [think];
    expect(
      settleOutputTruncation({ calls: { 'agent=a': 'exhausted', 'agent=b': 'partial' } }, parts),
    ).toBeUndefined();
    expect(parts[parts.length - 1]).toEqual({ type: 'error', error: code });
  });

  it('finishes a partial answer as length without touching the content', () => {
    const parts: TruncationContentPart[] = [think, { type: 'text', text: 'The first half' }];
    expect(settleOutputTruncation({ calls: { 'agent=a': 'partial' } }, parts)).toEqual({
      finish_reason: 'length',
    });
    expect(parts).toHaveLength(2);
  });

  it('leaves a run that was not truncated unstamped', () => {
    const parts: TruncationContentPart[] = [think];
    expect(settleOutputTruncation({ calls: { 'agent=a': 'complete' } }, parts)).toBeUndefined();
    expect(settleOutputTruncation({}, parts)).toBeUndefined();
    expect(settleOutputTruncation(undefined, parts)).toBeUndefined();
    expect(parts).toEqual([think]);
  });

  it('finishes a completed continuation as stop so a stored length does not survive', () => {
    expect(
      settleOutputTruncation({ calls: { 'agent=a': 'complete' } }, [], { continued: true }),
    ).toEqual({ finish_reason: 'stop' });
  });

  it('finishes an exhausted continuation as stop beside its notice', () => {
    const parts: TruncationContentPart[] = [think];
    expect(
      settleOutputTruncation({ calls: { 'agent=a': 'exhausted' } }, parts, { continued: true }),
    ).toEqual({ finish_reason: 'stop' });
    expect(parts[parts.length - 1]).toEqual({ type: 'error', error: code });
  });
});
