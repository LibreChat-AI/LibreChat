import { EModelEndpoint } from 'librechat-data-provider';
import { resolveStoredResponse, selectStoredResponseHistory } from './storage';

const responseMessage = {
  messageId: 'resp_one',
  conversationId: 'conversation-one',
  endpoint: EModelEndpoint.agents,
  sender: 'Agent',
  isCreatedByUser: false,
  finish_reason: 'stop',
};
const conversation = { conversationId: 'conversation-one', user: 'owner' };

function reads() {
  return {
    getMessage: jest.fn().mockResolvedValue(responseMessage),
    getConvo: jest.fn().mockResolvedValue(conversation),
  };
}

describe('stored Responses ID resolution', () => {
  it('looks up a response by its owner-scoped indexed message, then verifies its conversation', async () => {
    const db = reads();
    expect(await resolveStoredResponse('owner', 'resp_one', db)).toEqual({
      message: responseMessage,
      conversation,
    });
    expect(db.getMessage).toHaveBeenCalledWith({ user: 'owner', messageId: 'resp_one' });
    expect(db.getConvo).toHaveBeenCalledWith('owner', 'conversation-one');
  });

  it('does not accept unstored, foreign, non-assistant, or deleted-conversation response IDs', async () => {
    const db = reads();
    for (const message of [
      null,
      { ...responseMessage, isCreatedByUser: true },
      { ...responseMessage, endpoint: 'openAI' },
      { ...responseMessage, sender: 'User' },
      { ...responseMessage, finish_reason: 'pending_storage' },
      { ...responseMessage, conversationId: '' },
    ]) {
      db.getMessage.mockResolvedValueOnce(message);
      expect(await resolveStoredResponse('owner', 'resp_one', db)).toBeNull();
    }
    db.getMessage.mockResolvedValueOnce(responseMessage);
    db.getConvo.mockResolvedValueOnce(null);
    expect(await resolveStoredResponse('owner', 'resp_one', db)).toBeNull();
    db.getMessage.mockResolvedValueOnce(responseMessage);
    db.getConvo.mockResolvedValueOnce({ conversationId: 'different' });
    expect(await resolveStoredResponse('owner', 'resp_one', db)).toBeNull();
  });

  it('replays only through the referenced response and excludes incomplete writes', () => {
    const messages = [
      { messageId: 'user-one' },
      { messageId: 'resp_one', finish_reason: 'stop' },
      { messageId: 'resp_failed', finish_reason: 'pending_storage' },
      { messageId: 'user-two' },
      { messageId: 'resp_two', finish_reason: 'stop' },
    ];
    expect(selectStoredResponseHistory(messages, 'resp_one')).toEqual(messages.slice(0, 2));
    expect(selectStoredResponseHistory(messages, 'resp_two')).toEqual([
      messages[0],
      messages[1],
      messages[3],
      messages[4],
    ]);
    expect(selectStoredResponseHistory(messages, 'resp_missing')).toEqual([]);
  });

  it('keeps the existing authorized conversation-ID form without a guaranteed-miss message read', async () => {
    const db = reads();
    expect(await resolveStoredResponse('owner', 'conversation-one', db)).toEqual({
      message: null,
      conversation,
    });
    expect(db.getMessage).not.toHaveBeenCalled();
    expect(db.getConvo).toHaveBeenCalledWith('owner', 'conversation-one');
  });
});
