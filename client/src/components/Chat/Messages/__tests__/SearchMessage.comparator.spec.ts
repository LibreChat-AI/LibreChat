import type { TMessage } from 'librechat-data-provider';
import { areSearchMessagePropsEqual } from '../SearchMessage';

const msg = (overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'm1',
    text: 'hello zephyrine',
    content: undefined,
    createdAt: '2026-07-20T00:00:00.000Z',
    isCreatedByUser: false,
    sender: 'GPT-3.5',
    model: 'gpt-3.5-turbo',
    endpoint: 'openAI',
    iconURL: '',
    files: undefined,
    ...overrides,
  }) as TMessage;

describe('areSearchMessagePropsEqual', () => {
  it('is true for the same reference', () => {
    const m = msg();
    expect(areSearchMessagePropsEqual({ message: m }, { message: m })).toBe(true);
  });

  it('is true for distinct objects with identical rendered fields (defeats a fresh useMemo remap)', () => {
    expect(areSearchMessagePropsEqual({ message: msg() }, { message: msg() })).toBe(true);
  });

  it('is false when the text changes', () => {
    expect(
      areSearchMessagePropsEqual({ message: msg() }, { message: msg({ text: 'different' }) }),
    ).toBe(false);
  });

  it('is false when the error flag changes, which switches the row to the error renderer', () => {
    expect(areSearchMessagePropsEqual({ message: msg() }, { message: msg({ error: true }) })).toBe(
      false,
    );
  });

  it('is false when the messageId changes', () => {
    expect(
      areSearchMessagePropsEqual({ message: msg() }, { message: msg({ messageId: 'm2' }) }),
    ).toBe(false);
  });

  it('compares files by file_id, not object identity', () => {
    const a = msg({ files: [{ file_id: 'f1' }] as TMessage['files'] });
    const b = msg({ files: [{ file_id: 'f1' }] as TMessage['files'] });
    expect(areSearchMessagePropsEqual({ message: a }, { message: b })).toBe(true);
    const c = msg({ files: [{ file_id: 'f2' }] as TMessage['files'] });
    expect(areSearchMessagePropsEqual({ message: a }, { message: c })).toBe(false);
  });

  it('is false when the conversation title changes (rename), even if text/id match', () => {
    expect(
      areSearchMessagePropsEqual({ message: msg() }, { message: msg({ title: 'Renamed' }) }),
    ).toBe(false);
  });

  it('is false when the navigation target conversationId changes', () => {
    expect(
      areSearchMessagePropsEqual({ message: msg() }, { message: msg({ conversationId: 'c2' }) }),
    ).toBe(false);
  });

  it('is false when the unfinished flag changes (incomplete-response notice)', () => {
    expect(
      areSearchMessagePropsEqual({ message: msg() }, { message: msg({ unfinished: true }) }),
    ).toBe(false);
  });

  it('is false when only clientTimestamp changes (createdAt-less timestamp fallback)', () => {
    const a = msg({ createdAt: undefined, clientTimestamp: '2026-07-20T00:00:00.000Z' });
    const b = msg({ createdAt: undefined, clientTimestamp: '2026-07-20T01:00:00.000Z' });
    expect(areSearchMessagePropsEqual({ message: a }, { message: b })).toBe(false);
  });

  it('is false when exactly one message is nullish', () => {
    expect(areSearchMessagePropsEqual({ message: undefined }, { message: msg() })).toBe(false);
    expect(areSearchMessagePropsEqual({ message: msg() }, { message: undefined })).toBe(false);
  });
});
