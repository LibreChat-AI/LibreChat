import { File } from 'node:buffer';
import { ContentTypes } from 'librechat-data-provider';
import { ReadableStream, TransformStream, WritableStream } from 'node:stream/web';
import type { SubagentThreadMessage, TMessageContentParts } from 'librechat-data-provider';
import { hasTerminalOutcome } from './outcome';

const outcome = (text: string, textTruncated = false): SubagentThreadMessage => ({
  messageId: 'task:assistant',
  parentMessageId: 'task:user',
  role: 'assistant',
  text,
  textTruncated,
});
const textPart = (text: string): TMessageContentParts => ({ type: ContentTypes.TEXT, text });

it.each(
  [
    [
      { type: 'text', text: 'Alpha' },
      { type: 'text', text: 'Beta' },
    ],
    [
      { type: 'text', text: 'Alpha\nInside' },
      { type: 'text', text: 'Beta' },
    ],
    [
      { type: 'text_delta', index: 0, text: 'Al' },
      { type: 'text_delta', index: 0, text: 'pha' },
      { type: 'text_delta', index: 1, text: 'Beta' },
    ],
    [
      { type: 'text', text: '😀 Alpha' },
      { type: 'text', text: '' },
      { type: 'text', text: '𐐷 Beta' },
    ],
  ].map((blocks) => ({ blocks })),
)('recognizes the locked SDK aggregate of serialized blocks %j', ({ blocks }) => {
  Object.assign(globalThis, { File, ReadableStream, TransformStream, WritableStream });
  const { createContentAggregator, filterSubagentResult, GraphEvents } =
    jest.requireActual<typeof import('@librechat/agents')>('@librechat/agents');
  const { AIMessage } = jest.requireActual<typeof import('@librechat/agents/langchain/messages')>(
    '@librechat/agents/langchain/messages',
  );
  const aggregator = createContentAggregator();
  aggregator.aggregateContent({
    event: GraphEvents.ON_RUN_STEP,
    data: {
      id: 'answer',
      runId: 'provider',
      index: 0,
      type: 'message_creation',
      usage: null,
      stepDetails: { type: 'message_creation', message_creation: { message_id: 'answer' } },
    },
  });
  aggregator.aggregateContent({
    event: GraphEvents.ON_MESSAGE_DELTA,
    data: { id: 'answer', delta: { content: blocks } },
  });
  const result = filterSubagentResult([new AIMessage({ content: blocks })]);
  const content = aggregator.contentParts as TMessageContentParts[];
  expect(hasTerminalOutcome(content, outcome(result), 'completed')).toBe(true);
  expect(hasTerminalOutcome(content, outcome(result.slice(0, 4), true), 'completed')).toBe(true);
  expect(content).toHaveLength(1);
});

it.each(['failed', 'cancelled', 'interrupted'] as const)(
  'does not normalize a genuinely separate %s explanation',
  (status) => {
    expect(hasTerminalOutcome([textPart('AlphaBeta')], outcome('Alpha\nBeta'), status)).toBe(false);
    expect(hasTerminalOutcome([textPart('AlphaBeta')], outcome('Alpha\nBeta', true), status)).toBe(
      false,
    );
    expect(hasTerminalOutcome([textPart('Alpha\nBeta')], outcome('Alpha\nBeta'), status)).toBe(
      true,
    );
  },
);

it('keeps an error-marked outcome exact even if status reports completed', () => {
  expect(
    hasTerminalOutcome(
      [textPart('AlphaBeta')],
      { ...outcome('Alpha\nBeta'), error: true },
      'completed',
    ),
  ).toBe(false);
});

it.each([
  ['Alpha Beta', 'AlphaBeta'],
  ['Alpha\tBeta', 'AlphaBeta'],
  ['AlphaBeta', 'Alpha Beta'],
  ['Alpha\nBeta', 'AlphaBeta'],
  ['AlphaBeta', 'Alpha\nDifferent'],
  ['Anything', '\n\n'],
])('does not equate different output %j with %j', (rendered, durable) => {
  expect(hasTerminalOutcome([textPart(rendered)], outcome(durable), 'completed')).toBe(false);
});

it('recognizes adjacent same-author text parts without joining unrelated content', () => {
  const first = textPart('Alpha');
  const second = textPart('Beta');
  const expected = outcome('Alpha\nBeta');
  expect(hasTerminalOutcome([first, second], expected, 'completed')).toBe(true);
  expect(hasTerminalOutcome([first, { ...second, agentId: 'other' }], expected, 'completed')).toBe(
    false,
  );
  expect(hasTerminalOutcome([first, { ...second, groupId: 2 }], expected, 'completed')).toBe(false);
  expect(
    hasTerminalOutcome(
      [
        { type: ContentTypes.TEXT, text: 'Alpha', phase: 'commentary' },
        { type: ContentTypes.TEXT, text: 'Beta', phase: 'final_answer' },
      ],
      expected,
      'completed',
    ),
  ).toBe(false);
  expect(
    hasTerminalOutcome([first, { type: ContentTypes.THINK, think: 'Beta' }], expected, 'completed'),
  ).toBe(false);
  expect(
    hasTerminalOutcome(
      JSON.parse(JSON.stringify([first, undefined, second])),
      expected,
      'completed',
    ),
  ).toBe(false);
});

it('matches a truncated multi-block prefix but does not mutate recovered content', () => {
  const content = [textPart('Alpha'), textPart('Beta and full detail')];
  const before = JSON.stringify(content);
  expect(hasTerminalOutcome(content, outcome('Alpha\nBeta', true), 'completed')).toBe(true);
  expect(hasTerminalOutcome(content, outcome('Alpha\nBeta'), 'completed')).toBe(false);
  expect(JSON.stringify(content)).toBe(before);
});
