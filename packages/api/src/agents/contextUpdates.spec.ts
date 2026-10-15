import { ContentTypes } from 'librechat-data-provider';
import {
  formatContextUpdate,
  findSummaryBoundaryIndex,
  hasConversationDateContext,
  buildUserMessageContextUpdates,
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

describe('buildUserMessageContextUpdates', () => {
  const base = {
    conversationStartedAt: START,
    timezone: 'Africa/Nairobi',
    trackDateChanges: true,
    includeTimestamps: false,
  };

  it('adds nothing while the local date matches the conversation start', () => {
    const updates = buildUserMessageContextUpdates({
      ...base,
      messages: [user('u1', START), assistant('a1', START), user('u2')],
      currentTurnStartedAt: '2026-03-09T20:59:00.000Z',
    });
    expect(updates.size).toBe(0);
  });

  it('announces a date change once, on the first message after local midnight', () => {
    const messages = [
      user('u1', START),
      assistant('a1', '2026-03-09T20:00:10.000Z'),
      /** 00:30 in Nairobi (UTC+3) — the next local day. */
      user('u2', '2026-03-09T21:30:00.000Z'),
      assistant('a2', '2026-03-09T21:30:10.000Z'),
      user('u3'),
    ];
    const updates = buildUserMessageContextUpdates({
      ...base,
      messages,
      currentTurnStartedAt: '2026-03-09T22:00:00.000Z',
    });
    expect([...updates.entries()]).toEqual([
      [2, '<context_update>\nCurrent date changed to: 2026-03-10 (Tue)\n</context_update>'],
    ]);
  });

  it('dates the newest unsaved message by the current turn start', () => {
    const updates = buildUserMessageContextUpdates({
      ...base,
      messages: [user('u1', START), assistant('a1', START), user('u2')],
      currentTurnStartedAt: '2026-03-11T08:00:00.000Z',
    });
    expect(updates.get(2)).toBe(
      '<context_update>\nCurrent date changed to: 2026-03-11 (Wed)\n</context_update>',
    );
  });

  it('evaluates the local date in the user timezone', () => {
    const messages = [user('u1', START), assistant('a1', START), user('u2')];
    const currentTurnStartedAt = '2026-03-09T23:00:00.000Z';
    expect(buildUserMessageContextUpdates({ ...base, messages, currentTurnStartedAt }).size).toBe(
      1,
    );
    expect(
      buildUserMessageContextUpdates({
        ...base,
        timezone: 'America/New_York',
        messages,
        currentTurnStartedAt,
      }).size,
    ).toBe(0);
  });

  it('skips messages a summary replaced and compares against the conversation start', () => {
    const messages = [
      user('u1', START),
      assistant('a1', START),
      user('u2', '2026-03-12T09:00:00.000Z'),
      assistant('a2', '2026-03-12T09:00:10.000Z', [summaryPart()]),
      user('u3', '2026-03-12T10:00:00.000Z'),
      assistant('a3', '2026-03-12T10:00:10.000Z'),
      user('u4'),
    ];
    const updates = buildUserMessageContextUpdates({
      ...base,
      messages,
      currentTurnStartedAt: '2026-03-12T11:00:00.000Z',
    });
    expect([...updates.keys()]).toEqual([4]);
    expect(updates.get(4)).toContain('Current date changed to: 2026-03-12 (Thu)');
  });

  it('stamps every visible user message with its send time when timestamps are enabled', () => {
    const messages = [
      user('u1', START),
      assistant('a1', START),
      user('u2', '2026-03-09T21:30:05.000Z'),
      assistant('a2', START),
      user('u3'),
    ];
    const updates = buildUserMessageContextUpdates({
      ...base,
      includeTimestamps: true,
      messages,
      currentTurnStartedAt: '2026-03-09T21:45:07.000Z',
    });
    expect([...updates.entries()]).toEqual([
      [0, '<context_update>\nMessage sent: 2026-03-09 23:00:00 +03:00 (Mon)\n</context_update>'],
      [
        2,
        '<context_update>\nCurrent date changed to: 2026-03-10 (Tue)\nMessage sent: 2026-03-10 00:30:05 +03:00 (Tue)\n</context_update>',
      ],
      [4, '<context_update>\nMessage sent: 2026-03-10 00:45:07 +03:00 (Tue)\n</context_update>'],
    ]);
  });

  it('only stamps send times when the date is not tracked', () => {
    const updates = buildUserMessageContextUpdates({
      ...base,
      trackDateChanges: false,
      includeTimestamps: true,
      messages: [user('u1', '2026-03-15T09:00:00.000Z')],
    });
    expect(updates.get(0)).toBe(
      '<context_update>\nMessage sent: 2026-03-15 12:00:00 +03:00 (Sun)\n</context_update>',
    );
  });

  it('returns nothing when both features are off', () => {
    const updates = buildUserMessageContextUpdates({
      ...base,
      trackDateChanges: false,
      messages: [user('u1', '2026-04-01T00:00:00.000Z')],
    });
    expect(updates.size).toBe(0);
  });

  it('renders history identically on a later turn', () => {
    const turn2 = [user('u1', START), assistant('a1', START), user('u2')];
    const first = buildUserMessageContextUpdates({
      ...base,
      includeTimestamps: true,
      messages: turn2,
      currentTurnStartedAt: '2026-03-10T08:00:00.000Z',
    });
    const turn3 = [
      user('u1', START),
      assistant('a1', START),
      user('u2', '2026-03-10T08:00:00.000Z'),
      assistant('a2', '2026-03-10T08:00:30.000Z'),
      user('u3'),
    ];
    const second = buildUserMessageContextUpdates({
      ...base,
      includeTimestamps: true,
      messages: turn3,
      currentTurnStartedAt: '2026-03-10T09:00:00.000Z',
    });
    expect(second.get(0)).toBe(first.get(0));
    expect(second.get(2)).toBe(first.get(2));
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
