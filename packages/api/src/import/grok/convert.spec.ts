import { Constants } from 'librechat-data-provider';
import type {
  GrokResponse,
  ConvertedMessage,
  GrokConversationMeta,
  GrokConversationEntry,
} from '~/import/types';
import { convertGrokConversation, parseGrokTimestamp } from './convert';
import { GROK_FIXTURE_CONVERSATIONS } from '~/import/__data__/grok';

const OPTIONS = { defaultModel: 'gpt-4o-mini' };

function conversation(
  responses: GrokResponse[],
  meta: Partial<GrokConversationMeta> = {},
): GrokConversationEntry {
  return {
    conversation: {
      id: 'conv-1',
      title: 'Fixture',
      create_time: '2026-07-14T03:25:09.401949Z',
      ...meta,
    },
    responses: responses.map((response) => ({ response })),
  };
}

function turn(
  id: string,
  parent: string | null | undefined,
  sender: string,
  message: string,
  model = 'grok-4',
): GrokResponse {
  const response: GrokResponse = {
    _id: id,
    sender,
    model,
    message,
    create_time: { $date: { $numberLong: '1783999510820' } },
  };
  if (parent !== undefined) {
    response.parent_response_id = parent;
  }
  return response;
}

function byText(messages: ConvertedMessage[], text: string): ConvertedMessage {
  const found = messages.find((message) => message.text === text);
  if (!found) {
    throw new Error(`no converted message with text ${text}`);
  }
  return found;
}

describe('parseGrokTimestamp', () => {
  it('reads the canonical extended-json form every real response uses', () => {
    expect(parseGrokTimestamp({ $date: { $numberLong: '1783999510820' } })).toBe(1783999510820);
  });

  it('reads the relaxed extended-json, iso string and plain millisecond forms', () => {
    expect(parseGrokTimestamp({ $date: '2026-07-15T10:01:00.000Z' })).toBe(
      Date.parse('2026-07-15T10:01:00.000Z'),
    );
    expect(parseGrokTimestamp({ $date: 1783999510820 })).toBe(1783999510820);
    expect(parseGrokTimestamp('2026-07-14T03:25:09.401949Z')).toBe(
      Date.parse('2026-07-14T03:25:09.401949Z'),
    );
    expect(parseGrokTimestamp(1783999510820)).toBe(1783999510820);
  });

  it('returns null for every unusable value rather than an invalid date', () => {
    expect(parseGrokTimestamp(undefined)).toBeNull();
    expect(parseGrokTimestamp(null)).toBeNull();
    expect(parseGrokTimestamp('not a date')).toBeNull();
    expect(parseGrokTimestamp({})).toBeNull();
    expect(parseGrokTimestamp({ $date: null })).toBeNull();
    expect(parseGrokTimestamp({ $date: {} })).toBeNull();
    expect(parseGrokTimestamp({ $date: { $numberLong: 'nope' } })).toBeNull();
    expect(parseGrokTimestamp(Number.NaN)).toBeNull();
  });
});

describe('convertGrokConversation', () => {
  it('classifies an uppercase ASSISTANT sender as the assistant, not the user', () => {
    const converted = convertGrokConversation(
      conversation([
        turn('r1', undefined, 'human', 'Where should I stay?', ''),
        turn('r2', 'r1', 'ASSISTANT', 'Positano.', 'grok-4-1-thinking-1129'),
        turn('r3', 'r2', 'assistant', 'Ravello too.', 'grok-3'),
      ]),
      OPTIONS,
    );

    const user = byText(converted.messages, 'Where should I stay?');
    const upper = byText(converted.messages, 'Positano.');
    const lower = byText(converted.messages, 'Ravello too.');

    expect(user.isCreatedByUser).toBe(true);
    expect(user.sender).toBe('user');
    expect(upper.isCreatedByUser).toBe(false);
    expect(upper.sender).toBe('Grok 4.1 Thinking');
    expect(lower.isCreatedByUser).toBe(false);
    expect(lower.sender).toBe('Grok 3');
  });

  it('preserves a branch as two children of one parent', () => {
    const converted = convertGrokConversation(
      conversation([
        turn('r1', undefined, 'human', 'Which town?'),
        turn('r2a', 'r1', 'ASSISTANT', 'Positano.'),
        turn('r2b', 'r1', 'assistant', 'Ravello.'),
        turn('r3', 'r2b', 'human', 'Why Ravello?'),
      ]),
      OPTIONS,
    );

    const root = byText(converted.messages, 'Which town?');
    const first = byText(converted.messages, 'Positano.');
    const second = byText(converted.messages, 'Ravello.');
    const follow = byText(converted.messages, 'Why Ravello?');

    expect(root.parentMessageId).toBe(Constants.NO_PARENT);
    expect(first.parentMessageId).toBe(root.messageId);
    expect(second.parentMessageId).toBe(root.messageId);
    expect(follow.parentMessageId).toBe(second.messageId);
    expect(first.createdAt.getTime()).toBeGreaterThan(root.createdAt.getTime());
  });

  it('roots a response with no parent_response_id, including a repeated prompt', () => {
    const converted = convertGrokConversation(
      conversation([
        turn('r1', undefined, 'human', 'Complete this script.'),
        turn('r2', 'r1', 'ASSISTANT', 'First attempt.'),
        turn('r3', undefined, 'human', 'Complete this script again.'),
        turn('r4', null, 'human', 'Explicit null parent.'),
      ]),
      OPTIONS,
    );

    expect(byText(converted.messages, 'Complete this script.').parentMessageId).toBe(
      Constants.NO_PARENT,
    );
    expect(byText(converted.messages, 'Complete this script again.').parentMessageId).toBe(
      Constants.NO_PARENT,
    );
    expect(byText(converted.messages, 'Explicit null parent.').parentMessageId).toBe(
      Constants.NO_PARENT,
    );
    expect(byText(converted.messages, 'First attempt.').parentMessageId).not.toBe(
      Constants.NO_PARENT,
    );
  });

  it('roots a response whose parent id matches nothing in the export', () => {
    const converted = convertGrokConversation(
      conversation([turn('r1', 'missing-response', 'assistant', 'Orphan.')]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(1);
    expect(converted.messages[0].parentMessageId).toBe(Constants.NO_PARENT);
  });

  it('skips a textless response and re-parents its children onto the nearest ancestor', () => {
    const converted = convertGrokConversation(
      conversation([
        turn('r1', undefined, 'human', 'Complete this script.'),
        turn('r2', 'r1', 'ASSISTANT', '', 'grok-4-1-non-thinking-w-tool'),
        turn('r3', 'r2', 'assistant', 'Here it is.'),
      ]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(2);
    expect(converted.dropped).toBe(1);
    expect(byText(converted.messages, 'Here it is.').parentMessageId).toBe(
      byText(converted.messages, 'Complete this script.').messageId,
    );
  });

  it('drops a whitespace-only response the same way', () => {
    const converted = convertGrokConversation(
      conversation([turn('r1', undefined, 'ASSISTANT', '   \n  ')]),
      OPTIONS,
    );

    expect(converted.messages).toHaveLength(0);
    expect(converted.dropped).toBe(1);
  });

  it('stores the raw slug per message and falls back to the default for a blank model', () => {
    const converted = convertGrokConversation(
      conversation([
        turn('r1', undefined, 'human', 'Blank model human turn.', ''),
        turn('r2', 'r1', 'human', 'Human turn with a slug.', 'grok-4-auto'),
        turn('r3', 'r2', 'ASSISTANT', 'Blank model assistant turn.', ''),
        turn('r4', 'r3', 'assistant', 'Slugged assistant turn.', 'grok-420'),
      ]),
      OPTIONS,
    );

    expect(byText(converted.messages, 'Blank model human turn.').model).toBe(OPTIONS.defaultModel);
    expect(byText(converted.messages, 'Human turn with a slug.').model).toBe('grok-4-auto');
    /** A blank model is not a role signal: this assistant turn keeps its
     * assistant identity and only borrows the endpoint's default model. */
    const blankAssistant = byText(converted.messages, 'Blank model assistant turn.');
    expect(blankAssistant.model).toBe(OPTIONS.defaultModel);
    expect(blankAssistant.isCreatedByUser).toBe(false);
    expect(blankAssistant.sender).toBe('Grok');
    expect(byText(converted.messages, 'Slugged assistant turn.').model).toBe('grok-420');
    expect(converted.messages.every((message) => message.model.length > 0)).toBe(true);
  });

  it('maps title, create_time and starred, and carries no assets or archived flag', () => {
    const converted = convertGrokConversation(
      conversation([turn('r1', undefined, 'human', 'Hi')], {
        id: 'ext-1',
        title: 'Amalfi trip planning',
        starred: true,
      }),
      OPTIONS,
    );

    expect(converted.externalId).toBe('ext-1');
    expect(converted.title).toBe('Amalfi trip planning');
    expect(converted.createdAt.toISOString()).toBe('2026-07-14T03:25:09.401Z');
    expect(converted.pinned).toBe(true);
    expect(converted.isArchived).toBe(false);
    expect(converted.model).toBe(OPTIONS.defaultModel);
    expect(converted.messages[0].files).toBeUndefined();
    expect(converted.messages[0].attachments).toBeUndefined();
    expect(converted.messages[0].content).toBeUndefined();
  });

  it('falls back to the summary and then to a default title', () => {
    const withSummary = convertGrokConversation(
      conversation([turn('r1', undefined, 'human', 'Hi')], {
        title: '',
        summary: 'Recovering a cut-off script',
      }),
      OPTIONS,
    );
    const withNeither = convertGrokConversation(
      conversation([turn('r1', undefined, 'human', 'Hi')], { title: null, summary: '' }),
      OPTIONS,
    );

    expect(withSummary.title).toBe('Recovering a cut-off script');
    expect(withNeither.title).toBe('Imported Grok Chat');
  });

  it('times a response from its own create_time and falls back to the conversation', () => {
    const noTime: GrokResponse = {
      _id: 'r2',
      sender: 'ASSISTANT',
      model: 'grok-4',
      message: 'No timestamp.',
      parent_response_id: 'r1',
    };
    const converted = convertGrokConversation(
      conversation([turn('r1', undefined, 'human', 'Timed.'), noTime]),
      OPTIONS,
    );

    expect(byText(converted.messages, 'Timed.').createdAt.getTime()).toBe(1783999510820);
    /** The fallback is the conversation's own creation time, nudged past its
     * parent by the shared tree ordering. */
    expect(byText(converted.messages, 'No timestamp.').createdAt.getTime()).toBe(1783999510821);
  });

  it('ignores duplicate response ids and responses missing an id', () => {
    const converted = convertGrokConversation(
      {
        conversation: { id: 'conv-1', title: 'Dupes', create_time: '2026-07-14T03:25:09.401949Z' },
        responses: [
          { response: turn('r1', undefined, 'human', 'First.') },
          { response: turn('r1', undefined, 'human', 'Duplicate id.') },
          { response: { _id: '', sender: 'human', message: 'No id.' } },
        ],
      },
      OPTIONS,
    );

    expect(converted.messages.map((message) => message.text)).toEqual(['First.']);
  });

  it('survives a cyclic parent chain by rooting the message that closes it', () => {
    const converted = convertGrokConversation(
      conversation([turn('r1', 'r2', 'human', 'First.'), turn('r2', 'r1', 'ASSISTANT', 'Second.')]),
      OPTIONS,
    );

    const roots = converted.messages.filter(
      (message) => message.parentMessageId === Constants.NO_PARENT,
    );
    expect(converted.messages).toHaveLength(2);
    expect(roots).toHaveLength(1);
  });

  it('converts a conversation with no responses at all', () => {
    const empty = convertGrokConversation({ conversation: { id: 'c-empty' } }, OPTIONS);

    expect(empty.messages).toEqual([]);
    expect(empty.dropped).toBe(0);
    expect(empty.title).toBe('Imported Grok Chat');
    expect(Number.isNaN(empty.createdAt.getTime())).toBe(false);
  });

  it('ignores the reasoning, search and partial fields a real response carries', () => {
    const [branched] = GROK_FIXTURE_CONVERSATIONS;
    const converted = convertGrokConversation(branched, OPTIONS);

    expect(converted.messages).toHaveLength(5);
    const traced = byText(converted.messages, 'Positano.');
    expect(traced.content).toBeUndefined();
    expect(traced.attachments).toBeUndefined();
    expect(traced.text).toBe('Positano.');
    /** `webpage_urls` is an echo of urls already in the message text in every
     * real occurrence, so it contributes nothing. */
    const withUrls = converted.messages.find((message) => message.isCreatedByUser);
    expect(withUrls?.text).toContain('https://earthtrekkers.com/amalfi');
    expect(withUrls?.attachments).toBeUndefined();
  });
});
