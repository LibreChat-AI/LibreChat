import { ContentTypes } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { pickTailIndex, pickTailPart } from '../tail';

const text = (value: string): TMessageContentParts =>
  ({ type: ContentTypes.TEXT, text: value }) as TMessageContentParts;
const call = (id: string): TMessageContentParts =>
  ({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: { id, name: 'bash_tool', args: '{}' },
  }) as TMessageContentParts;
const reply = (content: TMessageContentParts[], overrides: Partial<TMessage> = {}): TMessage =>
  ({
    messageId: 'reply',
    conversationId: 'thread',
    parentMessageId: 'brief',
    isCreatedByUser: false,
    text: '',
    content,
    ...overrides,
  }) as TMessage;

describe('pickTailPart', () => {
  it('is the newest part of the reply the branch ends on', () => {
    const tail = reply([text('Starting.'), call('call-1')]);
    expect(pickTailIndex(tail)).toBe(1);
    expect(pickTailPart(tail)).toBe(tail.content?.[1]);
  });

  it('answers nothing before the child has replied', () => {
    expect(pickTailPart(null)).toBeNull();
    expect(pickTailPart(reply([text('The brief.')], { isCreatedByUser: true }))).toBeNull();
    expect(pickTailIndex(reply([]))).toBeNull();
  });

  it('skips a label still waiting for its text, so the row is what a reader would see', () => {
    const reserved = {
      type: ContentTypes.ACTIVITY_LABEL,
      [ContentTypes.ACTIVITY_LABEL]: '',
    } as TMessageContentParts;
    const tail = reply([call('call-1'), reserved]);
    expect(pickTailIndex(tail)).toBe(0);
    expect(pickTailPart(tail)).toBe(tail.content?.[0]);
  });
});
