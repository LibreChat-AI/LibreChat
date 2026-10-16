import { ContentTypes } from 'librechat-data-provider';
import {
  formatContextUpdate,
  findSummaryBoundaryIndex,
  hasConversationDateContext,
  findSummarySegment,
  getTurnContextUpdates,
  getTurnUserMessageCreatedAt,
  createHistoryContextUpdates,
} from './contextUpdates';
import type { ContextUpdateMessage } from './contextUpdates';

const user = (messageId: string, createdAt?: string): ContextUpdateMessage => ({
  messageId,
  isCreatedByUser: true,
  createdAt,
});
const assistant = (
  messageId: string,
  createdAt: string,
  content?: unknown[],
): ContextUpdateMessage => ({ messageId, isCreatedByUser: false, createdAt, content });

const summaryPart = (coverage?: { retainedFromMessageId?: string }) => ({
  type: ContentTypes.SUMMARY,
  content: [{ type: ContentTypes.TEXT, text: 'Earlier discussion.' }],
  boundary: { messageId: 'm', contentIndex: 0 },
  ...(coverage ? { coverage } : {}),
});

/** 23:00 on Monday 2026-03-09 in Nairobi (UTC+3). */
const START = '2026-03-09T20:00:00.000Z';

describe('formatContextUpdate', () => {
  it('wraps lines in a context_update block', () => {
    expect(formatContextUpdate(['a', 'b'])).toBe('<context_update>\na\nb\n</context_update>');
  });
});

describe('findSummaryBoundaryIndex', () => {
  it('is 0 without a summary', () => {
    expect(findSummaryBoundaryIndex([user('u1'), assistant('a1', START)])).toBe(0);
  });

  it('keeps history from the message carrying the latest usable summary', () => {
    const messages = [
      user('u1'),
      assistant('a1', START, [summaryPart()]),
      user('u2'),
      assistant('a2', START, [summaryPart()]),
      user('u3'),
    ];
    expect(findSummaryBoundaryIndex(messages)).toBe(3);
  });

  it('keeps history from the covered message in coverage mode', () => {
    const messages = [
      user('u1'),
      assistant('a1', START),
      user('u2'),
      assistant('a2', START, [summaryPart({ retainedFromMessageId: 'u2' })]),
    ];
    expect(findSummaryBoundaryIndex(messages)).toBe(2);
  });

  it('falls back to the carrying message when coverage names an unknown or later message', () => {
    const messages = [
      user('u1'),
      assistant('a1', START, [summaryPart({ retainedFromMessageId: 'u2' })]),
      user('u2'),
    ];
    expect(findSummaryBoundaryIndex(messages)).toBe(1);
  });

  it('ignores summaries that failed or never finished', () => {
    const messages = [
      user('u1'),
      assistant('a1', START, [{ ...summaryPart(), failed: true }]),
      assistant('a2', START, [{ ...summaryPart(), boundary: undefined }]),
    ];
    expect(findSummaryBoundaryIndex(messages)).toBe(0);
  });
});

describe('findSummarySegment', () => {
  it('reports the message carrying the latest usable summary and the first visible one', () => {
    const messages = [
      user('u1', START),
      assistant('a1', START, [summaryPart()]),
      user('u2', START),
      assistant('a2', START, [summaryPart({ retainedFromMessageId: 'u2' })]),
      user('u3'),
    ];
    expect(findSummarySegment(messages)).toEqual({
      carrier: 3,
      visibleFrom: 2,
      summaryPartIndex: 0,
    });
    expect(findSummarySegment([user('u1'), assistant('a1', START)])).toEqual({
      carrier: -1,
      visibleFrom: 0,
      summaryPartIndex: -1,
    });
  });

  it('reports the position of the summary part inside the carrier', () => {
    const text = { type: 'text', text: 'answer' };
    const messages = [user('u1', START), assistant('a1', START, [text, summaryPart(), text])];
    expect(findSummarySegment(messages)).toMatchObject({ carrier: 1, summaryPartIndex: 1 });
  });
});

describe('getTurnContextUpdates', () => {
  const entries = [{ key: 'artifacts', value: 'default' }];
  it('returns the entries only for the user message they were planned for', () => {
    const req = { turnContextUpdates: { messageId: 'u2', entries } };
    expect(getTurnContextUpdates(req, 'u2')).toBe(entries);
    expect(getTurnContextUpdates(req, 'u1')).toBeUndefined();
    expect(getTurnContextUpdates({}, 'u2')).toBeUndefined();
    expect(getTurnContextUpdates(undefined, undefined)).toBeUndefined();
  });
});

describe('hasConversationDateContext', () => {
  it('detects the web search runtime context or temporal instructions', () => {
    expect(hasConversationDateContext([{ dynamicToolContextMap: { web_search: 'x' } }])).toBe(true);
    expect(
      hasConversationDateContext([
        {},
        { dynamicToolContextMap: { agent_temporal_instructions: 'Today is ...' } },
      ]),
    ).toBe(true);
    expect(hasConversationDateContext([null, { dynamicToolContextMap: { other: 'x' } }])).toBe(
      false,
    );
  });
});

const STABLE_CONFIG = { endpoints: { agents: { promptCache: { stableContext: true } } } };
const TIMESTAMPS_CONFIG = { endpoints: { agents: { promptMessageTimestamps: true } } };

describe('getTurnUserMessageCreatedAt', () => {
  const turnStartedAt = Date.parse('2026-10-14T13:41:07.250Z');

  it.each([
    ['stableContext', STABLE_CONFIG],
    ['promptMessageTimestamps', TIMESTAMPS_CONFIG],
  ])('dates the stored user message by the turn start with %s', (_name, config) => {
    expect(getTurnUserMessageCreatedAt({ turnStartedAt, config })).toEqual(new Date(turnStartedAt));
  });

  it('leaves the storage timestamp when neither feature that reads it is on', () => {
    expect(getTurnUserMessageCreatedAt({ turnStartedAt })).toBeUndefined();
    expect(getTurnUserMessageCreatedAt({ turnStartedAt, config: {} })).toBeUndefined();
  });

  it('leaves the storage timestamp when the turn start is unknown', () => {
    expect(getTurnUserMessageCreatedAt(undefined)).toBeUndefined();
    expect(getTurnUserMessageCreatedAt({ config: STABLE_CONFIG })).toBeUndefined();
    expect(
      getTurnUserMessageCreatedAt({ turnStartedAt: Number.NaN, config: STABLE_CONFIG }),
    ).toBeUndefined();
  });
});

describe('createHistoryContextUpdates', () => {
  const AGENT_WITH_DATE = { dynamicToolContextMap: { web_search: 'stated' } };
  const messages = [
    user('u1', START),
    assistant('a1', START),
    user('u2', '2026-03-10T10:00:00.000Z'),
  ];
  const run = (config: object, agents: object[] = [AGENT_WITH_DATE]) => {
    const history = createHistoryContextUpdates({
      req: {
        conversationCreatedAt: START,
        turnStartedAt: '2026-03-10T10:00:00.000Z',
        body: { timezone: 'Africa/Nairobi' },
        config,
      },
      messages,
      agents,
    });
    const formatted = messages.map(() => ({ content: 'text' }));
    const applied = formatted.map((message, index) => history.apply(message as never, index));
    return { history, formatted, applied };
  };

  it('prepends the date-change note to the prompt copy with stableContext', () => {
    const { history, formatted, applied } = run(STABLE_CONFIG);
    expect(history.hasUpdates).toBe(true);
    expect(applied[2]).toContain('Current date changed to: 2026-03-10 (Tue)');
    expect(formatted[2].content).toContain(applied[2] as string);
    expect(formatted[0].content).toBe('text');
  });

  it('announces nothing without stableContext, so the history is as stored', () => {
    const { history, formatted } = run({});
    expect(history.hasUpdates).toBe(false);
    expect(formatted.every((message) => message.content === 'text')).toBe(true);
  });

  it('announces nothing when no agent states the conversation date', () => {
    expect(run(STABLE_CONFIG, [{}]).history.hasUpdates).toBe(false);
  });

  it('stamps send times only with promptMessageTimestamps', () => {
    const { applied } = run(TIMESTAMPS_CONFIG);
    expect(applied[0]).toContain('Message sent: 2026-03-09 23:00:00 +03:00 (Mon)');
    expect(applied[2]).not.toContain('Current date changed');
  });
});
