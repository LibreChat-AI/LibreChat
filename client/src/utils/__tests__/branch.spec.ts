import { Constants } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import {
  getBranchTargetStorageKey,
  isPersistableConversationId,
  readPersistedBranchTarget,
  restorePersistedBranch,
  writePersistedBranchTarget,
} from '../branch';

const conversationId = 'conversation-1';

const userMessage = {
  messageId: 'user-message',
  parentMessageId: '00000000-0000-0000-0000-000000000000',
  conversationId,
  text: 'Hello',
  isCreatedByUser: true,
} as TMessage;

const olderAssistantMessage = {
  messageId: 'assistant-older',
  parentMessageId: userMessage.messageId,
  conversationId,
  text: 'Older branch',
  isCreatedByUser: false,
} as TMessage;

const assistantMessage = {
  messageId: 'assistant-message',
  parentMessageId: userMessage.messageId,
  conversationId,
  text: 'Hi there',
  isCreatedByUser: false,
} as TMessage;

const olderFollowUpUserMessage = {
  ...userMessage,
  messageId: 'user-older-follow-up',
  parentMessageId: olderAssistantMessage.messageId,
  text: 'Follow up on older branch',
} as TMessage;

const olderFollowUpAssistantMessage = {
  ...assistantMessage,
  messageId: 'assistant-older-follow-up',
  parentMessageId: olderFollowUpUserMessage.messageId,
  text: 'Older branch tail',
} as TMessage;

const branchedMessages = [
  userMessage,
  olderAssistantMessage,
  olderFollowUpUserMessage,
  olderFollowUpAssistantMessage,
  assistantMessage,
];

describe('persisted branch target', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('rejects ephemeral conversation ids', () => {
    expect(isPersistableConversationId(Constants.NEW_CONVO)).toBe(false);
    expect(isPersistableConversationId(Constants.SEARCH)).toBe(false);
    expect(isPersistableConversationId(Constants.PENDING_CONVO)).toBe(false);
    expect(isPersistableConversationId(conversationId)).toBe(true);
  });

  it('round-trips a target message id for a conversation', () => {
    writePersistedBranchTarget(conversationId, olderFollowUpAssistantMessage.messageId);

    expect(localStorage.getItem(getBranchTargetStorageKey(conversationId))).toBe(
      olderFollowUpAssistantMessage.messageId,
    );
    expect(readPersistedBranchTarget(conversationId)).toBe(olderFollowUpAssistantMessage.messageId);
  });

  it('does not write for a new conversation', () => {
    writePersistedBranchTarget(Constants.NEW_CONVO, olderFollowUpAssistantMessage.messageId);
    expect(readPersistedBranchTarget(Constants.NEW_CONVO)).toBeNull();
  });

  it('restores sibling indexes that select the persisted branch', () => {
    writePersistedBranchTarget(conversationId, olderFollowUpAssistantMessage.messageId);
    const applied: { parentMessageId: string | null | undefined; siblingIdx: number }[] = [];

    expect(
      restorePersistedBranch(branchedMessages, conversationId, (parentMessageId, siblingIdx) => {
        applied.push({ parentMessageId, siblingIdx });
      }),
    ).toBe(olderFollowUpAssistantMessage.messageId);

    expect(applied).toEqual([
      {
        parentMessageId: userMessage.messageId,
        siblingIdx: 1,
      },
    ]);
  });

  it('returns null when the persisted target is no longer in the tree', () => {
    writePersistedBranchTarget(conversationId, 'missing-message');
    const setSiblingIdx = jest.fn();

    expect(restorePersistedBranch(branchedMessages, conversationId, setSiblingIdx)).toBeNull();
    expect(setSiblingIdx).not.toHaveBeenCalled();
  });
});
