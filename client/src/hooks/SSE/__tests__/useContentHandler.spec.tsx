import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EventSubmission, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useContentHandler from '../useContentHandler';

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
);

describe('useContentHandler message reconciliation', () => {
  it('keeps order and first existing response while reusing same-thread messages', () => {
    const userMessage = {
      messageId: 'user-1',
      thread_id: 'thread-1',
      conversationId: 'conversation-1',
      isCreatedByUser: true,
    } as TMessage;
    const lastUserMessage = {
      messageId: 'user-2',
      thread_id: 'thread-1',
      conversationId: 'conversation-1',
      isCreatedByUser: true,
    } as TMessage;
    const firstExistingResponse = {
      messageId: 'response-1',
      thread_id: 'thread-1',
      conversationId: 'conversation-1',
      sender: 'first-existing-copy',
      content: [{ type: 'text', text: { value: 'stale' } }],
    } as TMessage;
    const laterExistingResponse = {
      ...firstExistingResponse,
      sender: 'later-existing-copy',
    } as TMessage;
    const differentThreadMessage = {
      messageId: 'other-1',
      thread_id: 'thread-0',
      conversationId: 'conversation-1',
      isCreatedByUser: false,
      content: [],
    } as unknown as TMessage;
    let messages = [
      userMessage,
      firstExistingResponse,
      differentThreadMessage,
      lastUserMessage,
      laterExistingResponse,
    ];
    const setMessages = jest.fn((nextMessages: TMessage[]) => {
      messages = nextMessages;
    });
    const submission = {
      initialResponse: {
        messageId: 'response-1',
        conversationId: 'conversation-1',
        content: [],
      },
    } as unknown as EventSubmission;
    const { result } = renderHook(
      () => useContentHandler({ setMessages, getMessages: () => messages }),
      { wrapper },
    );

    act(() => {
      result.current.contentHandler({
        data: {
          type: 'text',
          text: 'streamed',
          messageId: 'response-1',
          thread_id: 'thread-1',
          conversationId: 'conversation-1',
          index: 0,
        } as never,
        submission,
      });
    });

    const output = setMessages.mock.calls[0][0];
    expect(output.map((message) => message.messageId)).toEqual([
      'user-1',
      'other-1',
      'user-2',
      'response-1',
    ]);
    expect(output[0]).toBe(userMessage);
    expect(output[2]).toBe(lastUserMessage);
    expect(output[1]).not.toBe(differentThreadMessage);
    expect(output[1]).toMatchObject({ thread_id: 'thread-1' });
    expect(output[3]).toMatchObject({
      sender: 'first-existing-copy',
      parentMessageId: 'user-2',
      messageId: 'response-1',
      thread_id: 'thread-1',
      content: [{ type: 'text', text: { value: 'streamed' } }],
    });
  });
  it('preserves thread IDs when a content event omits thread_id', () => {
    const userMessage = {
      messageId: 'user-1',
      thread_id: 'thread-1',
      conversationId: 'conversation-1',
      isCreatedByUser: true,
    } as TMessage;
    const existingResponse = {
      messageId: 'response-1',
      conversationId: 'conversation-1',
      parentMessageId: '',
      isCreatedByUser: false,
      sender: 'Assistant',
      text: '',
      content: [],
    } as TMessage;
    const laterMessageFromAnotherThread = {
      messageId: 'other-1',
      thread_id: 'thread-0',
      conversationId: 'conversation-1',
      isCreatedByUser: true,
      content: [],
    } as unknown as TMessage;
    const untaggedMessage = {
      messageId: 'legacy-1',
      conversationId: 'conversation-1',
      isCreatedByUser: true,
      content: [],
    } as unknown as TMessage;
    let messages = [userMessage, existingResponse, laterMessageFromAnotherThread, untaggedMessage];
    const setMessages = jest.fn((nextMessages: TMessage[]) => {
      messages = nextMessages;
    });
    const submission = {
      initialResponse: {
        messageId: 'response-1',
        conversationId: 'conversation-1',
        thread_id: 'thread-1',
        content: [],
      },
    } as unknown as EventSubmission;
    const { result } = renderHook(
      () => useContentHandler({ setMessages, getMessages: () => messages }),
      { wrapper },
    );

    act(() => {
      result.current.contentHandler({
        data: {
          type: 'text',
          text: 'streamed without thread metadata',
          messageId: 'response-1',
          conversationId: 'conversation-1',
          index: 0,
        } as never,
        submission,
      });
    });

    const output = setMessages.mock.calls[0][0];
    expect(output).toHaveLength(4);
    expect(output[0]).toBe(userMessage);
    expect(output[1]).toBe(laterMessageFromAnotherThread);
    expect(output[2]).toBe(untaggedMessage);
    expect(output[3]).toMatchObject({
      messageId: 'response-1',
      parentMessageId: 'legacy-1',
      thread_id: 'thread-1',
      content: [{ type: 'text', text: { value: 'streamed without thread metadata' } }],
    });
  });
});
