/** @jest-environment jsdom */
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { TMessageProps } from '../types';
import { areMessageFieldsEqual, areMessageRowPropsEqual, isSameTailRelation } from '../equal';

const makeMessage = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'msg-1',
    isCreatedByUser: false,
    ...overrides,
  }) as TMessage;

const noop = () => {};
/** Shared content reference so the baseline compares equal on `content` (which
 *  the comparator diffs BY REFERENCE); the mutation below hands a fresh array. */
const SHARED_CONTENT = [] as TMessage['content'];

const makeFieldsMsg = (over: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'm1',
    text: 'hello',
    error: false,
    unfinished: false,
    finish_reason: 'stop',
    createdAt: '2026-07-01T00:00:00.000Z',
    depth: 0,
    isCreatedByUser: false,
    content: SHARED_CONTENT,
    model: 'gpt-4',
    endpoint: 'openAI',
    iconURL: '',
    ...over,
  }) as TMessage;

/**
 * One entry per field `areMessageFieldsEqual` compares, each differing from the
 * `makeFieldsMsg` baseline. This list is the guard: dropping a field from the
 * comparator makes its case here fail (a bailed row would show stale content),
 * and adding a rendered field should mean adding it in both places.
 */
const FIELD_MUTATIONS: Array<[string, Partial<TMessage>]> = [
  ['messageId', { messageId: 'm2' }],
  ['text', { text: 'changed' }],
  ['error', { error: true }],
  ['unfinished', { unfinished: true }],
  ['finish_reason', { finish_reason: 'tool_call_limit' }],
  ['createdAt', { createdAt: '2026-07-02T00:00:00.000Z' }],
  ['depth', { depth: 3 }],
  ['isCreatedByUser', { isCreatedByUser: true }],
  ['isUserSubmitted', { isUserSubmitted: true }],
  ['children length', { children: [makeFieldsMsg(), makeFieldsMsg()] }],
  ['content reference', { content: [] as TMessage['content'] }],
  ['model', { model: 'gpt-5' }],
  ['endpoint', { endpoint: 'anthropic' }],
  ['iconURL', { iconURL: 'https://example.com/icon.png' }],
  ['feedback rating', { feedback: { rating: 'thumbsDown' } as unknown as TMessage['feedback'] }],
  ['files', { files: [{ file_id: 'f1' }] as TMessage['files'] }],
  [
    'attachments length',
    { attachments: [{ file_id: 'a1' }] as unknown as TMessage['attachments'] },
  ],
  ['manualSkills length', { manualSkills: ['skill'] as unknown as TMessage['manualSkills'] }],
  [
    'alwaysAppliedSkills length',
    { alwaysAppliedSkills: ['skill'] as unknown as TMessage['alwaysAppliedSkills'] },
  ],
  ['quotes length', { quotes: [{ text: 'q' }] as unknown as TMessage['quotes'] }],
];

describe('areMessageFieldsEqual', () => {
  it('is true for the same reference', () => {
    const message = makeFieldsMsg();
    expect(areMessageFieldsEqual(message, message)).toBe(true);
  });

  it('is true for distinct objects with identical compared fields', () => {
    expect(areMessageFieldsEqual(makeFieldsMsg(), makeFieldsMsg())).toBe(true);
  });

  it('handles nullish operands', () => {
    expect(areMessageFieldsEqual(makeFieldsMsg(), null)).toBe(false);
    expect(areMessageFieldsEqual(null, makeFieldsMsg())).toBe(false);
    expect(areMessageFieldsEqual(null, null)).toBe(true);
    expect(areMessageFieldsEqual(undefined, undefined)).toBe(true);
  });

  it.each(FIELD_MUTATIONS)('re-renders when %s changes', (_label, mutation) => {
    expect(areMessageFieldsEqual(makeFieldsMsg(), makeFieldsMsg(mutation))).toBe(false);
  });
});

const baseMessage = makeFieldsMsg();

const makeProps = (over: Partial<TMessageProps> = {}): TMessageProps =>
  ({
    currentEditId: null,
    setCurrentEditId: noop,
    siblingIdx: 0,
    siblingCount: 1,
    setSiblingIdx: noop,
    isSearchView: false,
    conversation: null,
    message: baseMessage,
    ...over,
  }) as TMessageProps;

const PROP_MUTATIONS: Array<[string, Partial<TMessageProps>]> = [
  ['currentEditId', { currentEditId: 'edit-1' }],
  ['setCurrentEditId', { setCurrentEditId: () => {} }],
  ['siblingIdx', { siblingIdx: 1 }],
  ['siblingCount', { siblingCount: 2 }],
  ['setSiblingIdx', { setSiblingIdx: () => {} }],
  ['isSearchView', { isSearchView: true }],
  ['conversation', { conversation: { conversationId: 'c1' } as unknown as TConversation }],
];

describe('areMessageRowPropsEqual', () => {
  it('is true for distinct prop objects with identical values', () => {
    expect(areMessageRowPropsEqual(makeProps(), makeProps())).toBe(true);
  });

  it.each(PROP_MUTATIONS)('re-renders when %s changes', (_label, mutation) => {
    expect(areMessageRowPropsEqual(makeProps(), makeProps(mutation))).toBe(false);
  });

  it('re-renders when only a message field changes (delegates to areMessageFieldsEqual)', () => {
    expect(
      areMessageRowPropsEqual(
        makeProps(),
        makeProps({ message: makeFieldsMsg({ text: 'edited' }) }),
      ),
    ).toBe(false);
  });
});

describe('isSameTailRelation', () => {
  const tailProps = (
    messageId: string,
    depth: number,
    latestMessageId: string | undefined,
    latestMessageDepth: number | undefined,
  ) => ({
    message: makeMessage({ messageId, depth }),
    latestMessageId,
    latestMessageDepth,
  });

  it('ignores a tail move that neither reaches nor leaves the row', () => {
    expect(isSameTailRelation(tailProps('a', 1, 'b', 3), tailProps('a', 1, 'c_', 5))).toBe(true);
    expect(isSameTailRelation(tailProps('a', 1, 'c_', 5), tailProps('a', 1, 'c', 5))).toBe(true);
  });

  it('re-renders the row the tail leaves', () => {
    expect(isSameTailRelation(tailProps('b', 3, 'b', 3), tailProps('b', 3, 'c_', 5))).toBe(false);
  });

  it('re-renders the row the tail reaches', () => {
    expect(isSameTailRelation(tailProps('c', 5, 'c_', 5), tailProps('c', 5, 'c', 5))).toBe(false);
  });

  it('re-renders when the tail depth reaches or leaves the row depth', () => {
    expect(isSameTailRelation(tailProps('x', 3, 'b', 3), tailProps('x', 3, 'c', 5))).toBe(false);
  });

  it('re-renders when the tail becomes known or unknown', () => {
    expect(isSameTailRelation(tailProps('a', 1, 'b', 3), tailProps('a', 1, undefined, 3))).toBe(
      false,
    );
  });
});
