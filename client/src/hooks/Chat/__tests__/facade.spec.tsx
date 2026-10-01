import React from 'react';
import { getDefaultStore } from 'jotai';
import { act, render, renderHook } from '@testing-library/react';
import { QueryKeys, ContentTypes } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import type { TConversation, TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { ChatContract } from '../contract';
import { ChatContext } from '~/Providers/ChatContext';
import { useChat, useChatActions } from '../facade';
import { resumeRequestAtom } from '../resume';

const userMessage: TMessage = {
  messageId: 'user-1',
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Hi',
};

const initialMessages = [userMessage];

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
    getMessages: jest.fn(() => initialMessages),
    messagesKey: 'convo-1',
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

/** The facade delivers cache writes on a microtask, outside the render that caused them. */
const flushCacheNotify = () => Promise.resolve();

/** Renders `useChat` under the real `ChatContext`; `rerender` swaps the contract value. */
const renderChat = (initial: ChatContract) => {
  let contract = initial;
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>
    </QueryClientProvider>
  );
  const view = renderHook(() => useChat(), { wrapper });
  return {
    queryClient,
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
      errorText: 'Invalid key: bad key',
    });
  });

  it('reports the chat the messages are read from while the conversation catches up', () => {
    const { result } = renderChat(createContract({ messagesKey: 'convo-2' }));

    expect(result.current.id).toBe('convo-2');
  });

  it('streams once a lane placeholder is filled', () => {
    const filled = [
      userMessage,
      response({
        content: [
          { type: ContentTypes.TEXT, text: 'Lane one' },
          { type: '' },
        ] as unknown as TMessageContentParts[],
      }),
    ];
    const { result } = renderChat(
      createContract({
        getMessages: jest.fn(() => filled),
        latestMessageId: 'response-1',
        isSubmitting: true,
      }),
    );

    expect(result.current.status).toBe('streaming');
  });

  it('reports a failed user message at the tail as an error', () => {
    const failedUser = { ...userMessage, error: true };
    const { result } = renderChat(turn([failedUser], false));

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('');
  });

  it('stays submitted while the response holds only placeholder parts', () => {
    const placeholder = response({
      content: [
        { type: ContentTypes.TEXT, text: '' },
        { type: '' } as unknown as TMessageContentParts,
      ],
    });
    const { result } = renderChat(turn([userMessage, placeholder], true));

    expect(result.current.status).toBe('submitted');
  });

  it('streams once the response carries a generated file and nothing else', () => {
    const withFile = response({ files: [{ file_id: 'file-1' }] as TMessage['files'] });
    const { result } = renderChat(turn([userMessage, withFile], true));

    expect(result.current.status).toBe('streaming');
  });

  it('reads the error text of an Assistants error part', () => {
    const failed = response({
      content: [{ type: ContentTypes.ERROR, text: { value: 'Run failed' } }],
    });
    const { result } = renderChat(turn([userMessage, failed], false));

    expect(result.current.error?.message).toBe('Run failed');
  });

  it('reports the error part rather than text the failed response kept', () => {
    const failed = response({
      text: 'Partial answer',
      content: [
        { type: ContentTypes.TEXT, text: 'Partial answer' },
        { type: ContentTypes.ERROR, error: 'Provider timed out' },
      ] as TMessageContentParts[],
    });
    const { result } = renderChat(turn([userMessage, failed], false));

    expect(result.current.status).toBe('error');
    expect(result.current.error?.message).toBe('Provider timed out');
  });

  it('reads messages a write the listener never saw replaced', () => {
    let messages: TMessage[] = [userMessage];
    const contract = createContract({ getMessages: jest.fn(() => messages) });
    const { result, update } = renderChat(contract);
    expect(result.current.messages).toHaveLength(1);

    messages = [userMessage, response({ text: 'Loaded' })];
    update({ ...contract });

    expect(result.current.messages).toHaveLength(2);
  });

  it('re-reads messages when the message cache is written', async () => {
    let messages: TMessage[] = [userMessage, response({ text: 'Old' })];
    const contract = createContract({
      getMessages: jest.fn(() => messages),
      latestMessageId: 'response-1',
    });
    const { result, queryClient } = renderChat(contract);
    (contract.setMessages as jest.Mock).mockImplementation((next: TMessage[]) => {
      messages = next;
      queryClient.setQueryData([QueryKeys.messages, 'convo-1'], next);
    });

    await act(async () => {
      result.current.setMessages((views) => [
        { ...views[0], parts: [{ type: 'text', text: 'Edited' }] },
        views[1],
      ]);
      await flushCacheNotify();
    });

    expect(result.current.messages[0].parts).toEqual([{ type: 'text', text: 'Edited' }]);
  });

  it('keeps unchanged message views across a streamed update', () => {
    const first = response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] });
    const { result, update } = renderChat(turn([userMessage, first], true));
    const userView = result.current.messages[0];

    update(
      turn(
        [userMessage, response({ content: [{ type: ContentTypes.TEXT, text: 'Hello' }] })],
        true,
      ),
    );

    expect(result.current.messages[0]).toBe(userView);
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('remaps a response whose content the stream replaced in place', () => {
    const streaming = response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] });
    const messages = [userMessage, streaming];
    const { result, update } = renderChat(turn(messages, true));
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hel' }]);

    streaming.content = [{ type: ContentTypes.TEXT, text: 'Hello' }];
    update(turn([...messages], true));

    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hello' }]);
  });

  it('follows each stream frame written to the cache with the same message references', async () => {
    const key = [QueryKeys.messages, 'convo-1'];
    const streaming = response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] });
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, [userMessage, streaming]);
    const contract = createContract({
      getMessages: jest.fn(() => queryClient.getQueryData<TMessage[]>(key)),
      latestMessageId: 'response-1',
      isSubmitting: true,
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChat(), { wrapper });
    const before = queryClient.getQueryData<TMessage[]>(key);

    await act(async () => {
      streaming.content = [{ type: ContentTypes.TEXT, text: 'Hello' }];
      queryClient.setQueryData(key, [userMessage, streaming]);
      await flushCacheNotify();
    });

    expect(queryClient.getQueryData<TMessage[]>(key)).toBe(before);
    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hello' }]);
    expect(result.current.status).toBe('streaming');

    const findAll = jest.spyOn(queryClient.getQueryCache(), 'findAll');
    await act(async () => {
      streaming.content = [{ type: ContentTypes.TEXT, text: 'Hello there' }];
      queryClient.setQueryData(key, [userMessage, streaming]);
      await flushCacheNotify();
    });

    expect(result.current.messages[1].parts).toEqual([{ type: 'text', text: 'Hello there' }]);
    expect(findAll).not.toHaveBeenCalled();
  });

  it('never updates while another component mounts a query on its messages', async () => {
    const key = [QueryKeys.messages, 'convo-1'];
    const queryClient = new QueryClient();
    const contract = createContract({
      getMessages: jest.fn(() => queryClient.getQueryData<TMessage[]>(key)),
    });
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    /** Mounting an observer with initial data creates and fills the query inside this render. */
    const Reader = () => {
      useQuery({ queryKey: key, queryFn: () => [userMessage], initialData: [userMessage] });
      return null;
    };
    const Probe = ({ withReader }: { withReader: boolean }) => {
      const { messages } = useChat();
      return (
        <>
          <span data-testid="count">{messages.length}</span>
          {withReader && <Reader />}
        </>
      );
    };
    const view = render(
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>
          <Probe withReader={false} />
        </ChatContext.Provider>
      </QueryClientProvider>,
    );

    await act(async () => {
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <ChatContext.Provider value={contract}>
            <Probe withReader />
          </ChatContext.Provider>
        </QueryClientProvider>,
      );
      await flushCacheNotify();
    });

    expect(view.getByTestId('count')).toHaveTextContent('1');
    const renderPhaseUpdates = consoleError.mock.calls.filter(([message]) =>
      String(message).includes('Cannot update a component'),
    );
    consoleError.mockRestore();
    expect(renderPhaseUpdates).toEqual([]);
  });

  it('keeps its messages when another conversation is written', () => {
    const key = [QueryKeys.messages, 'convo-1'];
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, [userMessage]);
    const contract = createContract({
      getMessages: jest.fn(() => queryClient.getQueryData<TMessage[]>(key)),
    });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>
      </QueryClientProvider>
    );
    const { result } = renderHook(() => useChat(), { wrapper });
    const before = result.current.messages;

    act(() => {
      queryClient.setQueryData([QueryKeys.messages, 'convo-2'], [response()]);
    });

    expect(result.current.messages).toBe(before);
  });

  it('remaps a message whose conversation id was set in place', () => {
    const promoted = response({ conversationId: null as unknown as string, text: 'Hi there' });
    const messages = [userMessage, promoted];
    const { result, update } = renderChat(turn(messages, false));
    expect(result.current.messages[1].metadata?.conversationId).toBeNull();

    promoted.conversationId = 'convo-1';
    update(turn([...messages], false));

    expect(result.current.messages[1].metadata?.conversationId).toBe('convo-1');
  });

  it('keeps a stepless call clear of attachments its repeated id owns elsewhere', () => {
    const memoryError = {
      conversationId: 'convo-1',
      messageId: 'response-1',
      toolCallId: 'mem-1',
      stepId: 'step-old',
      type: 'memory',
      memory: { type: 'error', key: 'k', value: 'v' },
    } as unknown as NonNullable<TMessage['attachments']>[number];
    const repeated = response({
      attachments: [memoryError],
      content: [
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: {
            id: 'mem-1',
            stepId: 'step-old',
            type: 'tool_call',
            name: 'set_memory',
            args: '{}',
            output: 'Memory set',
            progress: 1,
          },
        },
        {
          type: ContentTypes.TOOL_CALL,
          tool_call: { id: 'mem-1', type: 'tool_call', name: 'set_memory', args: '{}' },
        },
      ],
    });
    const { result } = renderChat(turn([userMessage, repeated], true));

    expect(result.current.messages[1].parts[1]).toMatchObject({ state: 'input-available' });
  });

  it('joins an inserted message to the conversation under the one before it', () => {
    const contract = createContract();
    const { result } = renderChat(contract);

    result.current.setMessages((views) => [
      ...views,
      { id: 'note-1', role: 'assistant', parts: [{ type: 'text', text: 'Note' }] },
    ]);

    expect(contract.setMessages).toHaveBeenCalledWith([
      userMessage,
      expect.objectContaining({
        messageId: 'note-1',
        conversationId: 'convo-1',
        parentMessageId: 'user-1',
        content: [{ type: ContentTypes.TEXT, text: 'Note' }],
      }),
    ]);
  });

  it('joins an inserted message that names another chat to the active conversation', () => {
    const contract = createContract();
    const { result } = renderChat(contract);

    result.current.setMessages((views) => [
      ...views,
      {
        id: 'note-1',
        role: 'assistant',
        metadata: { conversationId: 'convo-2', parentMessageId: 'user-1' },
        parts: [{ type: 'text', text: 'Note' }],
      },
    ]);

    expect(contract.setMessages).toHaveBeenCalledWith([
      userMessage,
      expect.objectContaining({ messageId: 'note-1', conversationId: 'convo-1' }),
    ]);
  });

  it('leaves an inserted message unassigned in a new chat even when it names another', () => {
    const contract = createContract({ messagesKey: 'new' });
    const { result } = renderChat(contract);

    result.current.setMessages((views) => [
      ...views,
      {
        id: 'note-1',
        role: 'assistant',
        metadata: { conversationId: 'convo-2', parentMessageId: 'user-1' },
        parts: [{ type: 'text', text: 'Note' }],
      },
    ]);

    expect(contract.setMessages).toHaveBeenCalledWith([
      userMessage,
      expect.objectContaining({ messageId: 'note-1', conversationId: null }),
    ]);
  });

  it('keeps a stored message in its conversation when its view names another', () => {
    const contract = createContract();
    const { result } = renderChat(contract);

    result.current.setMessages((views) => [
      { ...views[0], metadata: { ...views[0].metadata!, conversationId: 'convo-2' } },
    ]);

    expect(contract.setMessages).toHaveBeenCalledWith([
      expect.objectContaining({ messageId: 'user-1', conversationId: 'convo-1' }),
    ]);
  });

  it('parents an appended message to the active branch, not a hidden sibling', () => {
    const shown = response({ messageId: 'response-a', text: 'Shown' });
    const hidden = response({ messageId: 'response-b', text: 'Hidden' });
    const branches = [userMessage, shown, hidden];
    const contract = createContract({
      getMessages: jest.fn(() => branches),
      latestMessageId: 'response-a',
    });
    const { result } = renderChat(contract);

    result.current.setMessages((views) => [
      ...views,
      { id: 'note-1', role: 'assistant', parts: [{ type: 'text', text: 'Note' }] },
      { id: 'note-2', role: 'assistant', parts: [{ type: 'text', text: 'Next' }] },
    ]);

    expect(contract.setMessages).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ messageId: 'note-1', parentMessageId: 'response-a' }),
        expect.objectContaining({ messageId: 'note-2', parentMessageId: 'note-1' }),
      ]),
    );
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

  it('sends an AI SDK user message as the ask call it describes', () => {
    const contract = createContract();
    const { result } = renderChat(contract);

    result.current.sendMessage(
      {
        parts: [
          { type: 'text', text: 'Hel' },
          { type: 'text', text: 'lo' },
        ],
        metadata: { parentMessageId: 'user-1' },
      },
      { isRegenerate: false },
    );

    expect(contract.ask).toHaveBeenCalledWith(
      { text: 'Hello', parentMessageId: 'user-1' },
      { isRegenerate: false },
    );
  });

  it('reports a refused send to the caller', () => {
    const contract = createContract({ ask: jest.fn(() => false as const) });
    const { result } = renderChat(contract);

    expect(result.current.sendMessage({ parts: [{ type: 'text', text: 'Hi' }] })).toBe(false);
  });

  it('rejects stop when the stop request fails', async () => {
    const failure = new Error('abort failed');
    const contract = createContract({
      isSubmitting: true,
      stopGenerating: jest.fn(() => Promise.reject(failure)),
    });
    const { result } = renderChat(contract);

    await expect(result.current.stop()).rejects.toBe(failure);
  });

  it('requests a resume of the chat it reads', async () => {
    const store = getDefaultStore();
    const before = store.get(resumeRequestAtom).count;
    const { result } = renderChat(createContract());

    await result.current.resumeStream();
    await result.current.resumeStream();

    expect(store.get(resumeRequestAtom)).toEqual({ conversationId: 'convo-1', count: before + 2 });
  });

  it('requests no resume for a chat that has no conversation yet', async () => {
    const store = getDefaultStore();
    const before = store.get(resumeRequestAtom);
    const { result } = renderChat(
      createContract({
        messagesKey: 'new',
        conversation: { conversationId: 'new' } as TConversation,
      }),
    );

    await expect(result.current.resumeStream()).resolves.toBeUndefined();
    expect(result.current.id).toBe('new');
    expect(store.get(resumeRequestAtom)).toBe(before);
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

describe('useChatActions', () => {
  const renderActions = (messages: TMessage[]) => {
    const key = [QueryKeys.messages, 'convo-1'];
    const queryClient = new QueryClient();
    queryClient.setQueryData(key, messages);
    const contract = createContract({
      getMessages: jest.fn(() => queryClient.getQueryData<TMessage[]>(key)),
      latestMessageId: 'response-1',
      isSubmitting: true,
    });
    let renders = 0;
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>
      </QueryClientProvider>
    );
    const view = renderHook(
      () => {
        renders += 1;
        return useChatActions();
      },
      { wrapper },
    );
    const write = async (next: TMessage[]) => {
      await act(async () => {
        queryClient.setQueryData(key, next);
        await flushCacheNotify();
      });
    };
    return { ...view, contract, write, renders: () => renders };
  };

  it('moves from submitted to streaming when the response gets content', async () => {
    const { result, write } = renderActions([userMessage, response()]);
    expect(result.current.status).toBe('submitted');

    await write([userMessage, response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] })]);

    expect(result.current.status).toBe('streaming');
  });

  it('does not re-render for stream frames that keep the status', async () => {
    const { result, write, renders } = renderActions([
      userMessage,
      response({ content: [{ type: ContentTypes.TEXT, text: 'Hel' }] }),
    ]);
    const first = result.current;
    const before = renders();

    await write([userMessage, response({ content: [{ type: ContentTypes.TEXT, text: 'Hello' }] })]);
    await write([
      userMessage,
      response({ content: [{ type: ContentTypes.TEXT, text: 'Hello!' }] }),
    ]);

    expect(renders()).toBe(before);
    expect(result.current).toBe(first);
  });

  it('forwards its actions to the contract', () => {
    const { result, contract } = renderActions([userMessage, response()]);

    result.current.sendMessage({ text: 'Hello' });
    expect(contract.ask).toHaveBeenCalledWith({ text: 'Hello' }, undefined);
    expect(result.current.stop).toBe(contract.stopGenerating);
    result.current.regenerate();
    expect(contract.regenerate).toHaveBeenCalledWith({
      messageId: 'response-1',
      parentMessageId: 'user-1',
      isCreatedByUser: false,
    });
  });
});
