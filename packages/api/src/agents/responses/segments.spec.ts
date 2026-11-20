import type { Response, OutputItem, Usage } from './types';
import {
  buildAggregatedResponse,
  createResponseAggregator,
  createAggregatorEventHandlers,
} from './service';
import { createResponseAccountingCollector, combineResponseAccounting } from './accounting';
import { combineResponseSegments, seedResponseAggregator } from './segments';
import { projectResponseMessage } from './persistence';

const usage = (count: number): Usage => ({
  input_tokens: count,
  output_tokens: count,
  total_tokens: count * 2,
  input_tokens_details: { cached_tokens: count },
  output_tokens_details: { reasoning_tokens: count },
  primary: { input_tokens: count, output_tokens: count, total_tokens: count * 2 },
  subagent: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
});

function response(output: OutputItem[], count: number, amount: string): Response {
  const accounting = createResponseAccountingCollector({
    quote: () => ({ amount, basis: 'application_billing' }),
  });
  accounting.record({
    input_tokens: count,
    output_tokens: count,
    total_tokens: count * 2,
    model: 'actual-model',
    provider: 'openAI',
  });
  return {
    ...buildAggregatedResponse(
      { responseId: 'response', model: 'agent', createdAt: 1 },
      createResponseAggregator(),
      usage(count),
      accounting.snapshot(),
    ),
    output,
    background: true,
    store: true,
  };
}

const message = (id: string, text: string): OutputItem => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text, annotations: [], logprobs: [] }],
});
const call = (id: string, callId: string): OutputItem => ({
  type: 'function_call',
  id,
  call_id: callId,
  name: 'lookup',
  arguments: '{"key":"original"}',
  status: 'completed',
});
const result = (id: string, callId: string, output: string): OutputItem => ({
  type: 'function_call_output',
  id,
  call_id: callId,
  output,
  status: 'completed',
});

it('preserves the saved prefix and completes a paused tool exactly once without seeding billed usage', () => {
  const previous = response(
    [
      message('before', 'Before. '),
      call('done-call', 'done'),
      result('done-result', 'done', 'old result'),
      call('waiting-call', 'waiting'),
    ],
    3,
    '0.1',
  );
  const original = JSON.stringify(previous);
  const aggregator = createResponseAggregator();
  seedResponseAggregator(aggregator, previous);
  expect(aggregator.usage).toEqual({
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cachedTokens: 0,
  });
  expect(aggregator.getText()).toBe('');
  const handlers = createAggregatorEventHandlers(aggregator);
  handlers.on_run_step_completed.handle('on_run_step_completed', {
    result: {
      id: 'step',
      index: 0,
      type: 'tool_call',
      tool_call: {
        id: 'waiting',
        name: 'lookup',
        args: '{"key":"original"}',
        output: 'new result',
        progress: 1,
      },
    },
  });
  aggregator.addText('After.');
  const current = {
    ...response([], 5, '0.2'),
    output: buildAggregatedResponse(
      { responseId: 'response', model: 'agent', createdAt: 2 },
      aggregator,
    ).output,
  };
  const combined = combineResponseSegments(previous, current, 'segment-two');
  expect(combined.created_at).toBe(1);
  expect(combined.usage).toEqual(usage(8));
  expect(combined.accounting).toMatchObject({
    status: 'available',
    amount: '0.3',
    coverage: 'complete',
  });
  expect(combined.output.filter((item) => item.type === 'function_call')).toHaveLength(2);
  expect(combined.output.filter((item) => item.type === 'function_call_output')).toEqual([
    result('done-result', 'done', 'old result'),
    expect.objectContaining({ call_id: 'waiting', output: 'new result' }),
  ]);
  expect(combined.output[0]).toEqual(previous.output[0]);
  expect(projectResponseMessage(combined).text).toBe('Before. After.');
  expect(JSON.stringify(previous)).toBe(original);
});

it('uses the cumulative snapshot for the next pause without duplicating earlier text, calls or usage', () => {
  const first = response([message('first', 'First. ')], 1, '0.1');
  const second = combineResponseSegments(
    first,
    response([message('second', 'Second. ')], 2, '0.2'),
    'two',
  );
  const third = combineResponseSegments(
    second,
    response([message('third', 'Third.')], 3, '0.3'),
    'three',
  );
  expect(projectResponseMessage(third).text).toBe('First. Second. Third.');
  expect(third.usage).toEqual(usage(6));
  expect(third.accounting).toMatchObject({ amount: '0.6' });
  expect(third.accounting?.calls).toHaveLength(3);
  expect(third.output.map((item) => item.id)).toEqual(['first', 'second', 'third']);
});

it('keeps output IDs unique even when independent segments generate the same message ID', () => {
  const combined = combineResponseSegments(
    response([message('same', 'Before')], 1, '0.1'),
    response([message('same', 'After')], 1, '0.1'),
    'intent-two',
  );
  expect(combined.output.map((item) => item.id)).toEqual(['same', 'same_intent-two']);
});

it('does not overwrite an already completed tool result with conflicting data', () => {
  const previous = response(
    [call('call', 'lookup'), result('result', 'lookup', 'original-private-result')],
    1,
    '0.1',
  );
  expect(() =>
    combineResponseSegments(
      previous,
      response([result('other', 'lookup', 'different-private-result')], 1, '0.1'),
      'two',
    ),
  ).toThrow('Response tool result changed across segments');
});

it('preserves uncertainty when a previous segment has no usable usage or accounting', () => {
  const previous = { ...response([], 1, '0.1'), usage: null, accounting: undefined };
  const combined = combineResponseSegments(previous, response([], 1, '0.2'), 'two');
  expect(combined.usage).toBeNull();
  expect(combined.accounting).toMatchObject({
    status: 'unavailable',
    coverage: 'partial',
    reason: 'partial_coverage',
  });
  expect(combined.accounting).not.toHaveProperty('amount');
  expect(combined.accounting?.calls).toHaveLength(1);
});

it('retains past quotes rather than consulting current pricing for old calls', () => {
  const prior = response([], 1, '0.1').accounting!;
  const quote = jest.fn(() => ({ amount: '0.9', basis: 'application_billing' as const }));
  const collector = createResponseAccountingCollector({ seed: prior, quote });
  collector.record({ input_tokens: 1, output_tokens: 1 });
  expect(quote).toHaveBeenCalledTimes(1);
  expect(collector.snapshot()).toMatchObject({ amount: '1' });
  expect(prior.amount).toBe('0.1');
});

it('does not erase conflicting or incomplete provenance when combining accounting', () => {
  const priced = response([], 1, '0.1').accounting!;
  const collector = createResponseAccountingCollector();
  collector.record({ input_tokens: 1, output_tokens: 1 }, undefined, undefined, 'same-call');
  collector.record({ input_tokens: 2, output_tokens: 1 }, undefined, undefined, 'same-call');
  expect(combineResponseAccounting(priced, collector.snapshot())).toMatchObject({
    status: 'unavailable',
    reason: 'conflicting_usage',
  });
  expect(
    combineResponseAccounting(priced, createResponseAccountingCollector().snapshot()),
  ).toMatchObject({
    status: 'unavailable',
    coverage: 'partial',
    reason: 'partial_coverage',
  });
});

it('rejects response identity changes and invalid or overflowing usage', () => {
  const prior = response([], 1, '0.1');
  expect(() => combineResponseSegments(prior, { ...prior, id: 'another-response' }, 'two')).toThrow(
    'identity changed',
  );
  const invalid = response([], 1, '0.1');
  invalid.usage!.output_tokens = Number.MAX_SAFE_INTEGER;
  expect(() => combineResponseSegments(prior, invalid, 'two')).toThrow(
    'Response segment usage is invalid',
  );
});
