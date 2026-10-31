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

/** The settled error message `sendError` writes: final, addressed to the saved conversation. */
const settledError = (endpoint: string): TResData =>
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
  }) as unknown as TResData;

const resolve = (endpoint: string) =>
  resolveErrorTurn({
    data: settledError(endpoint),
    submission: newChatSubmission(endpoint),
    getMessages: (): TMessage[] => [],
    isNewConversationRoute: true,
  });

describe('resolveErrorTurn on the new-chat route', () => {
  it.each([EModelEndpoint.assistants, EModelEndpoint.azureAssistants])(
    'keeps a settled %s error on screen instead of rebuilding into a conversation that never saved it',
    (endpoint) => {
      const turn = resolve(endpoint);
      expect(turn.recover).toBe(false);
      expect(turn.errorResponse.error).toBe(true);
      expect(turn.errorResponse.text).toBe(ERROR_TEXT);
    },
  );

  it('still rebuilds into the saved conversation for an agents error, which the server persists', () => {
    const turn = resolve(EModelEndpoint.agents);
    expect(turn.recover).toBe(true);
    expect(turn.conversationId).toBe('saved-1');
  });
});
