import React from 'react';
import { renderHook } from '@testing-library/react';
import { ContentTypes } from 'librechat-data-provider';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ChatContract } from '../contract';
import { ChatContext } from '~/Providers/ChatContext';
import { useChat } from '../facade';

const userMessage: TMessage = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Hi',
};

const response = (overrides: Partial<TMessage> = {}): TMessage => ({
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [],
  ...overrides,
});

const createContract = (overrides: Partial<ChatContract> = {}): ChatContract => {
  const noop = jest.fn();
  return {
    index: 0,
    conversation: { conversationId: 'convo-1' } as TConversation,
    setConversation: noop,
    newConversation: noop,
    preset: null,
    setPreset: noop,
    optionSettings: {},
    setOptionSettings: noop,
    getMessages: jest.fn(() => [userMessage]),
    setMessages: jest.fn(),
    setSiblingIdx: noop,
    latestMessageId: 'user-1',
    latestMessageDepth: 0,
    ask: jest.fn(),
    regenerate: jest.fn(),
    isSubmitting: false,
    setIsSubmitting: noop,
    handleRegenerate: noop,
    handleContinue: noop,
    stopGenerating: jest.fn(() => Promise.resolve()),
    handleStopGenerating: noop,
    abortScroll: false,
    setAbortScroll: noop,
    files: new Map(),
    setFiles: noop,
    filesLoading: false,
    setFilesLoading: noop,
    showPopover: false,
    setShowPopover: noop,
    feedbackEnabled: false,
    ...overrides,
  };
};

/** Renders `useChat` under the real `ChatContext`; `rerender` swaps the contract value. */
const renderChat = (initial: ChatContract) => {
  let contract = initial;
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>
  );
  const view = renderHook(() => useChat(), { wrapper });
  return {
    ...view,
    update: (next: ChatContract) => {
      contract = next;
      view.rerender();
    },
  };
};

/** A turn as the contract reports it: the cached messages, the branch tail, and the flag. */
const turn = (messages: TMessage[], isSubmitting: boolean) =>
  createContract({
    getMessages: jest.fn(() => messages),
    latestMessageId: messages[messages.length - 1]?.messageId,
    isSubmitting,
  });

describe('useChat', () => {
  it('views the cached messages as UI messages', () => {
    const { result } = renderChat(createContract());

    expect(result.current.id).toBe('convo-1');
    expect(result.current.messages).toEqual([
      {
        id: 'user-1',
        role: 'user',
        metadata: { conversationId: 'convo-1', parentMessageId: null, contentless: true },
        parts: [{ type: 'text', text: 'Hi' }],
      },
    ]);
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });

  it('applies the client tool outcome rules to tool parts', () => {
    const memoryFailure = response({
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'mem-1',
            type: 'tool_call',
            name: 'set_memory',
            args: '{"key":"bad key","value":"x"}',
            output: 'Invalid key: bad key',
            progress: 1,
          },
        },
      ],
    });
    const { result } = renderChat(turn([userMessage, memoryFailure], false));

    expect(result.current.messages[1].parts[0]).toMatchObject({
      type: 'tool-set_memory',
      state: 'output-error',
    });
  });

  it('walks submit, stream, and finish', () => {
    const { result, update } = renderChat(turn([userMessage], false));
    expect(result.current.status).toBe('ready');

    update(turn([userMessage], true));
    expect(result.current.status).toBe('submitted');

    update(turn([userMessage, response()], true));
    expect(result.current.status).toBe('submitted');

    const streaming = response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] });
    update(turn([userMessage, streaming], true));
    expect(result.current.status).toBe('streaming');
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hel' }]);

    const finished = response({
      text: 'Hello',
      content: [{ type: ContentTypes.TEXT, text: 'Hello' }],
    });
    update(turn([userMessage, finished], false));
    expect(result.current.status).toBe('ready');
    expect(result.current.error).toBeUndefined();
  });

  it('returns to ready after an abort', () => {
    const streaming = response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] });
    const { result, update } = renderChat(turn([userMessage, streaming], true));
    expect(result.current.status).toBe('streaming');

    const stopped = response({
      unfinished: true,
      content: [{ type: ContentTypes.TEXT, text: 'Hel' }],
    });
    update(turn([userMessage, stopped], false));

    expect(result.current.status).toBe('ready');
    expect(result.current.messages[1].metadata?.unfinished).toBe(true);
  });

  it('reports a failed turn as an error', () => {
    const failed = response({ error: true, text: 'Rate limited', content: undefined });
    const { result, update } = renderChat(turn([userMessage, failed], false));

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe('Rate limited');

    const errorPart = response({
      content: [{ type: ContentTypes.ERROR, error: 'Context too long' }],
    });
    update(turn([userMessage, errorPart], false));
    expect(result.current.error?.message).toBe('Context too long');
  });

  it('keeps the same error while the failed message is unchanged', () => {
    const failed = response({ error: true, text: 'Rate limited', content: undefined });
    const { result, update } = renderChat(turn([userMessage, failed], false));
    const first = result.current.error;

    update(turn([userMessage, failed], false));

    expect(result.current.error).toBe(first);
  });

  it('forwards sendMessage to ask with the same arguments', () => {
    const contract = createContract();
    const { result } = renderChat(contract);

    result.current.sendMessage({ text: 'Hello', conversationId: 'convo-1' }, { isEdited: true });

    expect(contract.ask).toHaveBeenCalledTimes(1);
    expect(contract.ask).toHaveBeenCalledWith(
      { text: 'Hello', conversationId: 'convo-1' },
      { isEdited: true },
    );
  });

  it('forwards regenerate for a given message and for the branch tail', () => {
    const answered = response({ text: 'Hello' });
    const contract = turn([userMessage, answered], false);
    const { result } = renderChat(contract);

    result.current.regenerate();
    result.current.regenerate({ messageId: 'user-1' });

    expect(contract.regenerate).toHaveBeenNthCalledWith(1, {
      messageId: 'response-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
    });
    expect(contract.regenerate).toHaveBeenNthCalledWith(2, {
      messageId: 'user-1',
      parentMessageId: null,
      isCreatedByUser: true,
    });
  });

  it('forwards stop to stopGenerating', async () => {
    const contract = createContract({ isSubmitting: true });
    const { result } = renderChat(contract);

    await result.current.stop();

    expect(contract.stopGenerating).toHaveBeenCalledTimes(1);
  });

  it('writes UI messages back onto the stored messages', () => {
    const answered = response({
      text: 'Hello',
      content: [{ type: ContentTypes.TEXT, text: 'Hello' }],
      tokenCount: 3,
    });
    const contract = turn([userMessage, answered], false);
    const { result } = renderChat(contract);

    result.current.setMessages((messages) => messages.slice(0, 1));
    result.current.setMessages(result.current.messages);

    expect(contract.setMessages).toHaveBeenNthCalledWith(1, [userMessage]);
    expect(contract.setMessages).toHaveBeenNthCalledWith(2, [userMessage, answered]);
  });
});
