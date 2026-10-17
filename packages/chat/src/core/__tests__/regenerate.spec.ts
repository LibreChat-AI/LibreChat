import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  hasStreamStartFailed,
  hasPendingAssistantParent,
  getAppendParentMessageId,
  getRegenerateTargetResponseMessage,
  getRegenerateSubmissionMessages,
  getPreliminaryRegenerateResponseMessageId,
} from '../regenerate';

const msg = (fields: Partial<TMessage>): TMessage => ({ text: '', ...fields }) as TMessage;

describe('regenerate helpers', () => {
  it('detects a message whose stream never started', () => {
    expect(hasStreamStartFailed(msg({ metadata: { streamStartFailed: true } as never }))).toBe(
      true,
    );
    expect(hasStreamStartFailed(msg({}))).toBe(false);
    expect(hasStreamStartFailed(null)).toBe(false);
  });

  it('appends under the user message before a failed start', () => {
    const user = msg({ messageId: 'u', isCreatedByUser: true, parentMessageId: 'p' });
    const failed = msg({
      messageId: 'a',
      parentMessageId: 'u',
      metadata: { streamStartFailed: true } as never,
    });
    expect(getAppendParentMessageId({ latestMessage: null, currentMessages: [] })).toBe(
      Constants.NO_PARENT,
    );
    expect(
      getAppendParentMessageId({ latestMessage: failed, currentMessages: [user, failed] }),
    ).toBe('p');
    expect(getAppendParentMessageId({ latestMessage: user, currentMessages: [user] })).toBe('u');
  });

  it('treats an unsaved underscore response as a pending assistant parent', () => {
    expect(hasPendingAssistantParent(msg({ messageId: 'r_' }))).toBe(true);
    expect(hasPendingAssistantParent(msg({ messageId: 'r_', createdAt: 'x' }))).toBe(false);
    expect(hasPendingAssistantParent(null)).toBe(false);
  });

  it('normalizes the preliminary response id', () => {
    expect(getPreliminaryRegenerateResponseMessageId('abc__')).toBe('abc_');
    expect(getPreliminaryRegenerateResponseMessageId('')).toBeNull();
  });

  it('prefers the targeted response, then the latest, then the newest sibling', () => {
    const first = msg({ messageId: 'a1', parentMessageId: 'u' });
    const second = msg({ messageId: 'a2', parentMessageId: 'u' });
    const messages = [first, second];
    expect(
      getRegenerateTargetResponseMessage({
        messages,
        parentMessageId: 'u',
        targetResponseMessageId: 'a1',
      }),
    ).toBe(first);
    expect(
      getRegenerateTargetResponseMessage({ messages, parentMessageId: 'u', latestMessage: first }),
    ).toBe(first);
    expect(getRegenerateTargetResponseMessage({ messages, parentMessageId: 'u' })).toBe(second);
    expect(getRegenerateTargetResponseMessage({ messages })).toBeNull();
  });

  it('removes only the regenerated subtree from the rendered list', () => {
    const target = msg({ messageId: 'a1', parentMessageId: 'u' });
    const child = msg({ messageId: 'c1', parentMessageId: 'a1' });
    const sibling = msg({ messageId: 'a2', parentMessageId: 'u' });
    const result = getRegenerateSubmissionMessages({
      messages: [target, sibling, child],
      targetResponseMessage: target,
    });
    expect(result.map((m) => m.messageId)).toEqual(['a2']);
  });
});
