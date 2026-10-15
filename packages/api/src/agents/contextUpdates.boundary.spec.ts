import { ContentTypes } from 'librechat-data-provider';
import { formatAgentMessages, formatMessage } from '@librechat/agents';
import { findSummaryBoundaryIndex } from './contextUpdates';

type Row = {
  messageId: string;
  isCreatedByUser: boolean;
  sender: string;
  text: string;
  content?: unknown[];
};

const user = (n: number): Row => ({
  messageId: `u${n}`,
  isCreatedByUser: true,
  sender: 'User',
  text: `question-${n}`,
});

const assistant = (n: number, summary?: { retainedFromMessageId?: string }): Row => ({
  messageId: `a${n}`,
  isCreatedByUser: false,
  sender: 'Assistant',
  text: `answer-${n}`,
  content: [
    ...(summary
      ? [
          {
            type: ContentTypes.SUMMARY,
            content: [{ type: ContentTypes.TEXT, text: 'Earlier discussion.' }],
            boundary: { messageId: `a${n}`, contentIndex: 0 },
            ...(summary.retainedFromMessageId ? { coverage: summary } : {}),
          },
        ]
      : []),
    { type: ContentTypes.TEXT, text: `answer-${n}` },
  ],
});

/** The user questions the SDK formatter keeps in the prompt, in order. */
function visibleQuestions(rows: Row[]): string[] {
  /** The formatter resolves `coverage` through the source message ids, which the payload keeps. */
  const formatted = rows.map((message) => ({
    ...formatMessage({ message: message as never }),
    messageId: message.messageId,
  }));
  const { messages } = formatAgentMessages(formatted as never, {});
  return messages
    .filter((message) => message.getType() === 'human')
    .map((message) => JSON.stringify(message.content))
    .flatMap((text) => text.match(/question-\d+/g) ?? []);
}

const questionsFrom = (rows: Row[], index: number) =>
  rows
    .slice(index)
    .filter((row) => row.isCreatedByUser)
    .map((row) => row.text);

/**
 * `findSummaryBoundaryIndex` mirrors the SDK formatter's summary boundary. If the formatter
 * changes where it cuts the history, these cases fail and the predicate must follow.
 */
describe('findSummaryBoundaryIndex against the SDK formatter', () => {
  const cases: Array<[string, Row[]]> = [
    ['no summary', [user(1), assistant(1), user(2), assistant(2), user(3)]],
    [
      'summary on an earlier answer keeps history from that answer',
      [user(1), assistant(1, {}), user(2), assistant(2), user(3)],
    ],
    [
      'latest of two summaries wins',
      [user(1), assistant(1, {}), user(2), assistant(2, {}), user(3)],
    ],
    [
      'coverage names an earlier retained user message',
      [user(1), assistant(1), user(2), assistant(2, { retainedFromMessageId: 'u2' }), user(3)],
    ],
    [
      'coverage names a later message than the carrier',
      [user(1), assistant(1, { retainedFromMessageId: 'u2' }), user(2), assistant(2), user(3)],
    ],
  ];

  it.each(cases)('%s', (_name, rows) => {
    const boundary = findSummaryBoundaryIndex(rows);
    const visible = visibleQuestions(rows);
    const expected = questionsFrom(rows, boundary);
    /** The formatter may reopen the history with the carrier's own question; never with older ones. */
    expect(visible.slice(-expected.length)).toEqual(expected);
    expect(visible.length - expected.length).toBeLessThanOrEqual(0);
  });
});
