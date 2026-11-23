import { Constants, EModelEndpoint } from 'librechat-data-provider';
import type { TMessage, EventSubmission } from 'librechat-data-provider';
import type { TResData } from '../turns/types';
import { resolveErrorTurn } from '../turns/errors';

/** A first send from the new-chat route: the server names the conversation it created. */
const newChatSubmission = (endpoint: string): EventSubmission =>
  ({
    messages: [],
    userMessage: {
      messageId: 'user-1',
      conversationId: Constants.NEW_CONVO,
      parentMessageId: Constants.NO_PARENT,
      isCreatedByUser: true,
      text: 'Hello',
      sender: 'User',
    },
    initialResponse: {
      messageId: 'user-1_',
      parentMessageId: 'user-1',
      conversationId: Constants.NEW_CONVO,
      isCreatedByUser: false,
      text: '',
      sender: 'Assistant',
      endpoint,
    },
    conversation: { conversationId: Constants.NEW_CONVO, endpoint },
  }) as unknown as EventSubmission;

const ERROR_TEXT =
  'The Assistant run failed to initialize. Try sending a message in a new conversation.';

/** The settled error message `sendError` writes: final, addressed to the saved conversation. It
 *  carries the conversation's reply stamp only when the server saved the error turn. */
const settledError = (endpoint: string, saved: boolean): TResData =>
  ({
    sender: 'System',
    messageId: 'error-1',
    conversationId: 'saved-1',
    parentMessageId: Constants.NO_PARENT,
    unfinished: false,
    error: true,
    final: true,
    text: ERROR_TEXT,
    isCreatedByUser: false,
    endpoint,
    ...(saved
      ? {
          conversation: {
            conversationId: 'saved-1',
            lastResponseAt: '2026-10-31T12:00:00.000Z',
            lastResponseMessageId: 'error-1',
          },
        }
      : {}),
  }) as unknown as TResData;

const resolve = (endpoint: string, saved: boolean) =>
  resolveErrorTurn({
    data: settledError(endpoint, saved),
    submission: newChatSubmission(endpoint),
    getMessages: (): TMessage[] => [],
    isNewConversationRoute: true,
  });

describe('resolveErrorTurn on the new-chat route', () => {
  it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants, EModelEndpoint.agents])(
    'keeps an unsaved settled %s error on screen instead of rebuilding into a conversation without it',
    (endpoint) => {
      const turn = resolve(endpoint, false);
      expect(turn.recover).toBe(false);
      expect(turn.errorResponse.error).toBe(true);
      expect(turn.errorResponse.text).toBe(ERROR_TEXT);
    },
  );

  it.each([EModelEndpoint.agents, EModelEndpoint.assistants])(
    'still rebuilds into the saved conversation when the server saved the %s error turn',
    (endpoint) => {
      const turn = resolve(endpoint, true);
      expect(turn.recover).toBe(true);
      expect(turn.conversationId).toBe('saved-1');
    },
  );

  it('keeps the recovery for errors that are not settled messages', () => {
    const turn = resolveErrorTurn({
      data: {
        conversationId: 'saved-1',
        messageId: 'user-1_',
        isCreatedByUser: false,
        sender: 'Assistant',
        text: 'Provider failed',
      } as unknown as TResData,
      submission: newChatSubmission(EModelEndpoint.agents),
      getMessages: (): TMessage[] => [],
      isNewConversationRoute: true,
    });
    expect(turn.recover).toBe(true);
  });
});
