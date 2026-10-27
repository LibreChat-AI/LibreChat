import { createPayload, EModelEndpoint } from 'librechat-data-provider';
import { mergeErrorMessages, mergeResponseMessage } from '@librechat/chat';
import type { Request, Response } from 'express';
import type { TOptions } from '~/common';
import { validateChatMessageIds } from '../../../../../packages/api/src/middleware/messageIds';
import { buildTurn } from '../ask/turn';

jest.mock('~/utils', () => ({
  getRouteChatProjectId: () => null,
  logger: { log: jest.fn(), dir: jest.fn() },
}));

describe('turn message-ID protocol', () => {
  it.each<[string, string, TOptions]>([
    ['regenerate', 'a'.repeat(257), { isRegenerate: true }],
    ['regenerate preliminary', 'a'.repeat(256) + '_', { isRegenerate: true }],
    ['regenerate ordinary', 'assistant-1', { isRegenerate: true }],
    ['regenerate boundary', 'a'.repeat(256), { isRegenerate: true }],
    ['regenerate underscored', 'a'.repeat(255) + '__', { isRegenerate: true }],
    ['edit', 'a'.repeat(257), { isEdited: true }],
    ['continue', 'a'.repeat(257), { isContinued: true, isEdited: true }],
    ['compact', 'a'.repeat(257), { compact: true }],
  ])('admits the real %s builder payload at the response boundary', (_label, id, options) => {
    const user = {
      messageId: 'user-1',
      parentMessageId: null,
      conversationId: 'conversation-1',
      text: 'Hello',
      isCreatedByUser: true,
    };
    const response = {
      messageId: id,
      parentMessageId: user.messageId,
      conversationId: user.conversationId,
      text: 'Answer',
      isCreatedByUser: false,
    };
    const turn = buildTurn({
      text: options.compact ? '' : user.text,
      params: options.compact
        ? { text: '', messageId: id, parentMessageId: id }
        : { text: user.text, messageId: user.messageId },
      options: {
        ...options,
        ...(options.isEdited && { editedMessageId: id }),
        targetResponseMessageId: id,
      },
      index: 0,
      conversationId: user.conversationId,
      conversation: {
        conversationId: user.conversationId,
        endpoint: EModelEndpoint.agents,
        title: null,
        createdAt: '2026-10-23T00:00:00.000Z',
        updatedAt: '2026-10-23T00:00:00.000Z',
      },
      latestMessage: response,
      cachedMessages: [user, response],
      canClearFiles: false,
      isTemporary: false,
      ephemeralAgent: null,
      getSender: () => 'Assistant',
      userKey: undefined,
      reasoningOverride: undefined,
      manualSkills: [],
      quotes: [],
      code: { approvalMode: undefined, environmentMode: undefined, workspaces: undefined },
    });
    const { payload } = createPayload(turn.submission);
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const next = jest.fn();
    validateChatMessageIds({ body: payload } as Request, res as unknown as Response, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(turn.initialResponse.messageId.length).toBeLessThanOrEqual(257);
    expect(payload.responseMessageId).toBe(turn.submission.userMessage.responseMessageId);
    if (options.isRegenerate) {
      expect(payload.responseMessageId).toBe(turn.initialResponse.messageId);
      expect(payload.responseMessageId).toMatch(/_$/);
      expect(payload.overrideParentMessageId).toBe(user.messageId);
      expect(turn.submission.messages).toEqual([user]);
      const updated = { ...turn.initialResponse, messageId: 'allocated-response', text: 'New' };
      const optimistic = [...turn.submission.messages, turn.initialResponse];
      const merged = mergeResponseMessage(
        {
          submission: { ...turn.submission, initialResponse: turn.initialResponse },
          getMessages: () => optimistic,
          setMessages: jest.fn(),
        },
        optimistic,
        updated,
        updated.messageId,
      );
      expect(merged.map((message) => message.messageId)).toEqual([
        user.messageId,
        updated.messageId,
      ]);
      const restored = mergeErrorMessages({
        ...turn.submission,
        errorMessage: { ...updated, error: true },
      });
      expect(restored.find((message) => message.messageId === id)).toBe(response);
    }
    if (options.isEdited) {
      expect(payload.responseMessageId).toBe(id);
    }
    expect(response.messageId).toBe(id);
  });
});
