import { QueryKeys } from 'librechat-data-provider';
import { QueryClient } from '@tanstack/react-query';
import type { TMessage } from 'librechat-data-provider';
import { ReactQueryChatState } from '../state';
import { Chat } from '../../core';

const message = (messageId: string): TMessage => ({
  messageId,
  conversationId: 'convo-1',
  parentMessageId: null,
  isCreatedByUser: true,
  text: messageId,
});

const flushMicrotasks = () => Promise.resolve();

describe('ReactQueryChatState', () => {
  it('reads and writes the conversation entry of the message cache', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    expect(state.messages).toEqual([]);
    expect(state.version).toBe(0);

    state.replaceMessages([message('a')]);

    expect(queryClient.getQueryData([QueryKeys.messages, 'convo-1'])).toEqual([message('a')]);
    expect(state.messages).toEqual([message('a')]);
    expect(state.version).toBe(1);
  });

  it('reads back its writes and reports them under a host key hash', async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { queryKeyHashFn: (key) => `custom:${JSON.stringify(key)}` } },
    });
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const listener = jest.fn();
    const unsubscribe = state.subscribe(listener);

    state.replaceMessages([message('a')]);
    await flushMicrotasks();

    expect(state.messages).toEqual([message('a')]);
    expect(state.version).toBe(1);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('counts a write that keeps the same array', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const list = [message('a')];
    state.replaceMessages(list);

    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], list);

    expect(state.messages).toBe(list);
    expect(state.version).toBe(2);
  });

  it('reads and writes through the host when it supplies both', () => {
    const queryClient = new QueryClient();
    const stored = [message('a')];
    const write = jest.fn();
    const state = new ReactQueryChatState({
      queryClient,
      key: 'convo-1',
      read: () => stored,
      write,
    });

    state.replaceMessages([message('b')]);

    expect(state.messages).toBe(stored);
    expect(write).toHaveBeenCalledWith([message('b')]);
    expect(queryClient.getQueryData([QueryKeys.messages, 'convo-1'])).toBeUndefined();
  });

  it('reports writes to a host store that bypass the cache', async () => {
    const queryClient = new QueryClient();
    let stored = [message('a')];
    const hostListeners = new Set<() => void>();
    const state = new ReactQueryChatState({
      queryClient,
      key: 'convo-1',
      read: () => stored,
      write: (next) => {
        stored = next;
        hostListeners.forEach((notify) => notify());
      },
      subscribe: (notify) => {
        hostListeners.add(notify);
        return () => hostListeners.delete(notify);
      },
    });
    const listener = jest.fn();
    const unsubscribe = state.subscribe(listener);

    state.replaceMessages([message('b')]);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(state.messages).toEqual([message('b')]);

    unsubscribe();
    expect(hostListeners.size).toBe(0);
  });

  it('reports writes to its own key only, after the writing call returns', async () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const listener = jest.fn();
    const unsubscribe = state.subscribe(listener);

    queryClient.setQueryData([QueryKeys.messages, 'convo-2'], [message('x')]);
    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('a')]);
    expect(listener).not.toHaveBeenCalled();

    await flushMicrotasks();
    expect(listener).toHaveBeenCalled();

    listener.mockClear();
    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('b')]);
    unsubscribe();
    await flushMicrotasks();
    expect(listener).not.toHaveBeenCalled();
  });

  it('backs a chat, which hears writes other hooks make to the cache', async () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const chat = new Chat({
      id: 'convo-1',
      state,
      transport: {
        sendMessages: jest.fn(),
        reconnectToStream: jest.fn(),
        abort: jest.fn(),
      },
      prepareRequest: jest.fn(),
    });
    const listener = jest.fn();
    const unsubscribe = chat.subscribe(listener);

    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('a')]);
    await flushMicrotasks();

    expect(listener).toHaveBeenCalled();
    expect(chat.messages).toEqual([message('a')]);
    expect(chat.status).toBe('ready');
    unsubscribe();
  });
});
