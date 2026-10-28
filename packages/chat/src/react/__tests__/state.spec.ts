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

  it('reads back its writes and reports other writes under a host key hash', async () => {
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
    expect(listener).not.toHaveBeenCalled();

    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('b')]);
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);
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
    expect(listener).not.toHaveBeenCalled();
    expect(state.messages).toEqual([message('b')]);

    stored = [message('c')];
    hostListeners.forEach((notify) => notify());
    await flushMicrotasks();
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(hostListeners.size).toBe(0);
  });

  it('reports a host store write made between reading the version and subscribing', async () => {
    const queryClient = new QueryClient();
    let stored = [message('a')];
    const state = new ReactQueryChatState({
      queryClient,
      key: 'convo-1',
      read: () => stored,
      write: (next) => {
        stored = next;
      },
      subscribe: () => () => undefined,
    });
    const rendered = state.version;
    stored = [message('b')];
    const listener = jest.fn();
    const unsubscribe = state.subscribe(listener);
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(state.version).not.toBe(rendered);
    unsubscribe();
  });

  it('counts writes to a host store that bypass the cache, same array included', () => {
    const queryClient = new QueryClient();
    const stored = [message('a')];
    const hostListeners = new Set<() => void>();
    const state = new ReactQueryChatState({
      queryClient,
      key: 'convo-1',
      read: () => stored,
      write: () => undefined,
      subscribe: (notify) => {
        hostListeners.add(notify);
        return () => hostListeners.delete(notify);
      },
    });
    const unsubscribe = state.subscribe(() => undefined);
    const versions = [state.version];

    state.replaceMessages(stored);
    versions.push(state.version);
    stored[0] = { ...stored[0], text: 'changed in place' };
    hostListeners.forEach((notify) => notify());
    versions.push(state.version);

    expect(new Set(versions).size).toBe(3);
    unsubscribe();
  });

  it('keeps counting up when its cache entry is removed and created again', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const key = [QueryKeys.messages, 'convo-1'];
    queryClient.setQueryData(key, [message('a')]);
    const before = state.version;

    queryClient.removeQueries({ queryKey: key, exact: true });
    queryClient.setQueryData(key, [message('b')]);

    expect(state.version).toBeGreaterThan(before);
  });

  it('moves past the last version when an observer creates its entry with initial data', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const key = [QueryKeys.messages, 'convo-1'];
    const before = state.version;

    queryClient.getQueryCache().build(queryClient, { queryKey: key, initialData: [message('a')] });

    expect(state.messages).toEqual([message('a')]);
    expect(state.version).toBeGreaterThan(before);
  });

  it('moves past the last version when its entry is reset and written again', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const key = [QueryKeys.messages, 'convo-1'];
    queryClient.setQueryData(key, [message('a')]);
    const before = state.version;

    queryClient.resetQueries({ queryKey: key, exact: true });
    queryClient.setQueryData(key, [message('b')]);

    expect(state.version).toBeGreaterThan(before);
  });

  it('moves past the last version when a reset keeps the same array and count', () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const key = [QueryKeys.messages, 'convo-1'];
    const list = [message('a')];
    queryClient.getQueryCache().build(queryClient, { queryKey: key, initialData: list });
    const unsubscribe = state.subscribe(() => undefined);
    queryClient.setQueryData(key, list);
    const before = state.version;

    queryClient.resetQueries({ queryKey: key, exact: true });
    list[0] = { ...list[0], text: 'changed in place' };
    queryClient.setQueryData(key, list);

    expect(state.version).not.toBe(before);
    unsubscribe();
  });

  it('reports a write that creates its cache entry once', async () => {
    const queryClient = new QueryClient();
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const listener = jest.fn();
    state.subscribe(listener);

    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('a')]);
    await flushMicrotasks();

    expect(listener).toHaveBeenCalledTimes(1);
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

  it('restores a row the cache committed as a copy when a replaced start rolls back', async () => {
    const queryClient = new QueryClient();
    const response: TMessage = { ...message('response-1'), isCreatedByUser: false, text: 'old' };
    queryClient.setQueryData([QueryKeys.messages, 'convo-1'], [message('a'), response]);
    const state = new ReactQueryChatState({ queryClient, key: 'convo-1' });
    const chat = new Chat({
      id: 'convo-1',
      state,
      transport: {
        sendMessages: jest.fn(async () => ({
          status: 'replaced' as const,
          generationProtocolVersion: 2 as const,
          conversationId: 'convo-1',
          streamId: 'stream-2',
          generationCreatedAt: 200,
        })),
        reconnectToStream: jest.fn(async () => null),
        abort: jest.fn(),
      },
      prepareRequest: jest.fn(() => ({
        payload: {} as never,
        responseMessageId: response.messageId,
        messages: (list: TMessage[]) =>
          list.map((row) => (row.messageId === response.messageId ? { ...row, text: '' } : row)),
      })),
    });

    await chat.regenerate({ messageId: response.messageId });

    expect(chat.messages).toEqual([message('a'), response]);
  });
});
