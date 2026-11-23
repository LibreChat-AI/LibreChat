/** @jest-environment jsdom */
import { renderHook, act } from '@testing-library/react';
import { EModelEndpoint } from 'librechat-data-provider';
import type { Agent, Assistant, TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { MessageFeedbackEvents, MessagesHost } from '../../../react/messages/host';
import type { MessagePartsHost, MessagePartsUser } from '../../../react/host';
import type { TMessageChatContext } from '../../../react/messages/types';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import useMessageActions from '../useMessageActions';

jest.mock('@librechat/client', () => ({
  useLocalize: () => (key: string) => key,
}));

const agent = { id: 'agent-1', name: 'Research Agent' } as Agent;
const assistant = { id: 'asst-1', name: 'Helper' } as Assistant;

const reply = {
  messageId: 'reply-1',
  sender: 'Model',
  isCreatedByUser: false,
  text: 'hello',
} as TMessage;

const prompt = { ...reply, messageId: 'prompt-1', isCreatedByUser: true } as TMessage;

function chatContextOf(
  conversation: Partial<TConversation>,
  overrides: Partial<TMessageChatContext> = {},
): TMessageChatContext {
  return {
    ask: jest.fn(),
    index: 0,
    regenerate: jest.fn(),
    conversation: { conversationId: 'convo-1', ...conversation } as TConversation,
    latestMessageId: undefined,
    latestMessageDepth: undefined,
    handleContinue: jest.fn(),
    feedbackEnabled: true,
    isSubmitting: false,
    ...overrides,
  };
}

type Setup = {
  parts?: Partial<MessagePartsHost>;
  messages?: Partial<MessagesHost>;
  user?: MessagePartsUser;
  usernameDisplay?: boolean;
};

function render({ parts = {}, messages = {}, user, usernameDisplay = false }: Setup = {}) {
  const partsHost = {
    useAgent: (id: string) => (id === agent.id ? agent : undefined),
    useUser: () => user,
    useUserTextPreferences: () => ({
      usernameDisplay,
      enableUserMsgMarkdown: false,
      collapseLongUserMessages: false,
    }),
    ...parts,
  } as MessagePartsHost;
  const messagesHost = createMessagesHost({
    useAssistant: (_endpoint, model) => (model === assistant.id ? assistant : undefined),
    ...messages,
  });
  return ({ children }: { children: ReactNode }): ReactNode => (
    <MessagesHostProvider host={messagesHost}>
      <MessagePartsHostProvider host={partsHost}>{children}</MessagePartsHostProvider>
    </MessagesHostProvider>
  );
}

function run(
  message: TMessage | undefined,
  chatContext: TMessageChatContext,
  setup: Setup = {},
): ReturnType<typeof renderHook<ReturnType<typeof useMessageActions>, unknown>> {
  return renderHook(
    () => useMessageActions({ message, chatContext, currentEditId: null, setCurrentEditId: null }),
    { wrapper: render(setup) },
  );
}

describe('useMessageActions', () => {
  describe('agent lookup', () => {
    it('finds the agent by the message model on an agents endpoint', () => {
      const { result } = run(
        { ...reply, model: 'agent-1' },
        chatContextOf({ endpoint: EModelEndpoint.agents }),
      );
      expect(result.current.agent).toBe(agent);
      expect(result.current.messageLabel).toBe('Research Agent');
    });

    it('falls back to the conversation agent_id when the message has no model', () => {
      const { result } = run(
        reply,
        chatContextOf({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }),
      );
      expect(result.current.agent).toBe(agent);
    });

    it('prefers the message model over the conversation agent_id', () => {
      const { result } = run(
        { ...reply, model: 'agent-unknown' },
        chatContextOf({ endpoint: EModelEndpoint.agents, agent_id: 'agent-1' }),
      );
      expect(result.current.agent).toBeUndefined();
    });

    it('returns no agent off an agents endpoint', () => {
      const { result } = run(
        { ...reply, model: 'agent-1' },
        chatContextOf({ endpoint: EModelEndpoint.openAI, agent_id: 'agent-1' }),
      );
      expect(result.current.agent).toBeUndefined();
    });
  });

  describe('assistant lookup', () => {
    it('finds the assistant on an assistants endpoint', () => {
      const useAssistant = jest.fn(
        (_e: string | null | undefined, model: string | null | undefined) =>
          model === assistant.id ? assistant : undefined,
      );
      const { result } = run(
        { ...reply, model: 'asst-1' },
        chatContextOf({ endpoint: EModelEndpoint.assistants }),
        { messages: { useAssistant } },
      );
      expect(useAssistant).toHaveBeenCalledWith(EModelEndpoint.assistants, 'asst-1');
      expect(result.current.assistant).toBe(assistant);
      expect(result.current.messageLabel).toBe('Helper');
    });

    it('returns no assistant off an assistants endpoint', () => {
      const { result } = run(
        { ...reply, model: 'asst-1' },
        chatContextOf({ endpoint: EModelEndpoint.openAI }),
      );
      expect(result.current.assistant).toBeUndefined();
      expect(result.current.messageLabel).toBe('Model');
    });
  });

  describe('message label', () => {
    const user = { name: 'Ada Lovelace', username: 'ada' };

    it('shows the user name when username display is on', () => {
      const { result } = run(prompt, chatContextOf({}), { user, usernameDisplay: true });
      expect(result.current.messageLabel).toBe('Ada Lovelace');
    });

    it('falls back to the username when the user has no name', () => {
      const { result } = run(prompt, chatContextOf({}), {
        user: { username: 'ada' },
        usernameDisplay: true,
      });
      expect(result.current.messageLabel).toBe('ada');
    });

    it('shows the localized label when username display is off', () => {
      const { result } = run(prompt, chatContextOf({}), { user, usernameDisplay: false });
      expect(result.current.messageLabel).toBe('com_user_message');
    });
  });

  describe('regenerate', () => {
    it('passes the added conversation read from the host at call time', () => {
      const added = { conversationId: 'added' } as TConversation;
      const chatContext = chatContextOf({});
      const { result } = run(reply, chatContext, {
        messages: { useGetAddedConvo: () => () => added },
      });
      act(() => result.current.regenerateMessage());
      expect(chatContext.regenerate).toHaveBeenCalledWith(reply, { addedConvo: added });
    });

    it('refuses a user message while the chat is submitting', () => {
      const chatContext = chatContextOf({}, { isSubmitting: true });
      const { result } = run(prompt, chatContext);
      act(() => result.current.regenerateMessage());
      expect(chatContext.regenerate).not.toHaveBeenCalled();
    });

    it('still regenerates a reply while the chat is submitting', () => {
      const chatContext = chatContextOf({}, { isSubmitting: true });
      const { result } = run(reply, chatContext);
      act(() => result.current.regenerateMessage());
      expect(chatContext.regenerate).toHaveBeenCalledTimes(1);
    });

    it('does nothing without a message', () => {
      const chatContext = chatContextOf({});
      const { result } = run(undefined, chatContext);
      act(() => result.current.regenerateMessage());
      expect(chatContext.regenerate).not.toHaveBeenCalled();
    });
  });

  describe('copy', () => {
    it('reads the copy action and availability through the host', () => {
      const copyToClipboard = jest.fn();
      const useMessageCopy = jest.fn(() => ({ copyToClipboard, canCopy: true }));
      const searchResults = {};
      const { result } = renderHook(
        () =>
          useMessageActions({
            message: reply,
            searchResults,
            chatContext: chatContextOf({}),
            currentEditId: null,
          }),
        { wrapper: render({ messages: { useMessageCopy } }) },
      );
      expect(useMessageCopy).toHaveBeenCalledWith({ message: reply, searchResults });
      expect(result.current.copyToClipboard).toBe(copyToClipboard);
      expect(result.current.getCanCopy()).toBe(true);
    });
  });

  describe('feedback', () => {
    it('withholds the handler when feedback is disabled', () => {
      const { result } = run(reply, chatContextOf({}, { feedbackEnabled: false }));
      expect(result.current.handleFeedback).toBeUndefined();
    });

    it('updates the feedback state when the host write succeeds', () => {
      const write = jest.fn((_payload: unknown, events: MessageFeedbackEvents): void =>
        events.onSuccess({
          messageId: 'reply-1',
          conversationId: 'convo-1',
          feedback: { rating: 'thumbsUp', tag: 'accurate_reliable', text: 'nice' },
        }),
      );
      const useMessageFeedback = jest.fn(() => write);
      const { result } = run(reply, chatContextOf({}), { messages: { useMessageFeedback } });
      expect(useMessageFeedback).toHaveBeenCalledWith('convo-1', 'reply-1');
      expect(result.current.feedback).toBeUndefined();

      act(() =>
        result.current.handleFeedback?.({ feedback: { rating: 'thumbsUp', tag: undefined } }),
      );

      expect(write).toHaveBeenCalledTimes(1);
      expect(result.current.feedback).toMatchObject({ rating: 'thumbsUp', text: 'nice' });
    });

    it('clears the feedback state when the server returns none', () => {
      const write = (_payload: unknown, events: MessageFeedbackEvents): void =>
        events.onSuccess({ messageId: 'reply-1', conversationId: 'convo-1' });
      const { result } = run(
        { ...reply, feedback: { rating: 'thumbsUp' } } as TMessage,
        chatContextOf({}),
        { messages: { useMessageFeedback: () => write } },
      );
      expect(result.current.feedback).toMatchObject({ rating: 'thumbsUp' });

      act(() => result.current.handleFeedback?.({ feedback: undefined }));

      expect(result.current.feedback).toBeUndefined();
    });

    it('logs and keeps the state when the host write fails', () => {
      const error = new Error('boom');
      const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const write = (_payload: unknown, events: MessageFeedbackEvents): void =>
        events.onError(error);
      const { result } = run(reply, chatContextOf({}), {
        messages: { useMessageFeedback: () => write },
      });

      act(() =>
        result.current.handleFeedback?.({ feedback: { rating: 'thumbsUp', tag: undefined } }),
      );

      expect(spy).toHaveBeenCalledWith('Failed to update feedback:', error);
      expect(result.current.feedback).toBeUndefined();
      spy.mockRestore();
    });
  });
});
