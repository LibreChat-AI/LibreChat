/**
 * @jest-environment jsdom
 */
import { useSyncExternalStore } from 'react';
import { getDefaultStore } from 'jotai';
import { act, render } from '@testing-library/react';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import type { ChatHost, ChatMessagesQuery } from '../host';
import type { ChatContract } from '../contract';
import { submissionByIndex, clearSubmissions, isSubmittingFamily } from '../../submission';
import { ChatSessionProvider, useChatSessionMessages } from '../session';
import { useChatContext } from '../context';
import { ChatHostProvider } from '../host';

const mockUseChatHelpers = jest.fn();
const mockUseQueueDrain = jest.fn();
const mockUseAdaptiveSSE = jest.fn();
const mockUseResumeOnLoad = jest.fn();
const mockRevealQueuedTurn = jest.fn();

/** The contract and the queue have specs of their own; here they only witness the order and
 *  arguments the session hands them. */
jest.mock('../helpers', () => ({
  __esModule: true,
  default: (index?: number, conversationId?: string) => mockUseChatHelpers(index, conversationId),
}));
jest.mock('../../steering/useQueuedTurnReveal', () => ({
  __esModule: true,
  default: () => mockRevealQueuedTurn,
}));
jest.mock('../../stream/adaptive', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseAdaptiveSSE(...args),
}));
jest.mock('../../stream/resume/load', () => ({
  useResumeOnLoad: (...args: unknown[]) => mockUseResumeOnLoad(...args),
}));
jest.mock('../../steering/useQueueDrain', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseQueueDrain(...args),
}));

const contract = {
  index: 1,
  conversation: { conversationId: 'convo-1' } as TConversation,
  getMessages: () => [],
  ask: jest.fn(),
} as unknown as ChatContract;

function createHost(query: ChatMessagesQuery) {
  const useMessages = jest.fn((): ChatMessagesQuery => query);
  const host = { useMessages } as unknown as ChatHost;
  return { host, useMessages };
}

function renderSession(host: ChatHost, pane = jest.fn(() => <Probe />)) {
  render(
    <ChatHostProvider host={host}>
      <ChatSessionProvider index={1} conversationId="convo-1">
        {pane}
      </ChatSessionProvider>
    </ChatHostProvider>,
  );
  return pane;
}

let served: ChatContract | null = null;
function Probe() {
  served = useChatContext();
  return null;
}

const messages = [{ messageId: 'm-1' }] as TMessage[];

describe('ChatSessionProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    served = null;
    mockUseChatHelpers.mockReturnValue(contract);
  });

  afterEach(() => {
    clearSubmissions(getDefaultStore());
  });

  it('loads the messages through the host and hands them to the pane', () => {
    const { host, useMessages } = createHost({ messages, isLoading: false, isFetching: false });
    const pane = renderSession(host);

    expect(useMessages).toHaveBeenCalledWith('convo-1', { isStreaming: false, messages: true });
    expect(pane).toHaveBeenLastCalledWith({ messages, isLoading: false });
  });

  it('loads history but defers resume until the host has the saved record', () => {
    const { host, useMessages } = createHost({
      messages: null,
      isLoading: false,
      isFetching: false,
    });
    render(
      <ChatHostProvider host={host}>
        <ChatSessionProvider conversationId="convo-1" historyReady={false}>
          {() => null}
        </ChatSessionProvider>
      </ChatHostProvider>,
    );
    expect(useMessages).toHaveBeenCalledWith('convo-1', { isStreaming: false, messages: true });
    expect(mockUseResumeOnLoad).toHaveBeenLastCalledWith('convo-1', expect.any(Function), 0, false);
  });

  it('asks the host for a streaming-aware query while the pane submits', () => {
    getDefaultStore().set(isSubmittingFamily(1), true);
    const { host, useMessages } = createHost({ messages, isLoading: false, isFetching: false });
    renderSession(host);

    expect(useMessages).toHaveBeenLastCalledWith('convo-1', { isStreaming: true, messages: true });
    getDefaultStore().set(isSubmittingFamily(1), false);
  });

  it('serves the contract and runs the stream, resume and queue drain against it', () => {
    const submission = { conversation: {} } as TSubmission;
    getDefaultStore().set(submissionByIndex(1), submission);
    const { host } = createHost({ messages, isLoading: false, isFetching: false });
    renderSession(host);

    expect(mockUseChatHelpers).toHaveBeenCalledWith(1, 'convo-1');
    expect(served).toBe(contract);
    expect(mockUseAdaptiveSSE).toHaveBeenLastCalledWith(submission, contract, false, 1);
    expect(mockUseResumeOnLoad).toHaveBeenLastCalledWith('convo-1', contract.getMessages, 1, true);
    expect(mockUseQueueDrain).toHaveBeenCalledWith(
      1,
      'convo-1',
      contract.ask,
      mockRevealQueuedTurn,
    );
  });

  it.each([
    ['loading', { isLoading: true, isFetching: true }],
    ['revalidating a warm cache', { isLoading: false, isFetching: true }],
  ])('holds resume back while %s', (_label, state) => {
    const { host } = createHost({ messages: null, ...state });
    renderSession(host);

    expect(mockUseResumeOnLoad).toHaveBeenLastCalledWith('convo-1', contract.getMessages, 1, false);
  });

  it('runs the stream and resume after the contract and before the drain', () => {
    const order: string[] = [];
    mockUseChatHelpers.mockImplementation(() => {
      order.push('contract');
      return contract;
    });
    mockUseQueueDrain.mockImplementation(() => order.push('drain'));
    mockUseAdaptiveSSE.mockImplementation(() => order.push('stream'));
    const { host, useMessages } = createHost({
      messages,
      isLoading: false,
      isFetching: false,
    });
    useMessages.mockImplementation(() => {
      order.push('messages');
      return { messages, isLoading: false, isFetching: false };
    });
    mockUseResumeOnLoad.mockImplementation(() => order.push('resume'));
    renderSession(host);

    expect(order.slice(0, 5)).toEqual(['messages', 'contract', 'stream', 'resume', 'drain']);
  });

  describe('with its pane given as an element', () => {
    const idle = () => () => undefined;
    /** A host whose messages change the way a streamed reply changes them. */
    function createLiveHost() {
      let query: ChatMessagesQuery = { messages, isLoading: false, isFetching: false };
      const listeners = new Set<() => void>();
      const subscribe = (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      };
      const asked = jest.fn();
      /** As an app's host does: a caller that wants no messages is not told when they change. */
      const status: ChatMessagesQuery = { messages: null, isLoading: false, isFetching: false };
      const useMessages = (
        id: string | undefined,
        options: { messages?: boolean },
      ): ChatMessagesQuery => {
        asked(id, options);
        const reads = options.messages !== false;
        return useSyncExternalStore(reads ? subscribe : idle, () => (reads ? query : status));
      };
      const write = (next: TMessage[]) =>
        act(() => {
          query = { ...query, messages: next };
          listeners.forEach((listener) => listener());
        });
      return { host: { useMessages } as unknown as ChatHost, write, asked };
    }

    it('redraws what reads the messages on every change, and neither the pane nor the session', () => {
      const { host, write, asked } = createLiveHost();
      const drawn = { pane: 0, reader: [] as Array<TMessage[] | null> };
      function Reader() {
        drawn.reader.push(useChatSessionMessages('convo-1', 1).messages);
        return null;
      }
      function Pane() {
        drawn.pane += 1;
        return <Reader />;
      }
      render(
        <ChatHostProvider host={host}>
          <ChatSessionProvider index={1} conversationId="convo-1">
            <Pane />
          </ChatSessionProvider>
        </ChatHostProvider>,
      );
      expect(drawn.pane).toBe(1);
      expect(drawn.reader[drawn.reader.length - 1]).toBe(messages);
      /** The session loads the conversation and asks only whether it is loading; the reader
       *  follows that load and starts none. */
      expect(asked).toHaveBeenCalledWith('convo-1', { isStreaming: false, messages: false });
      expect(asked).toHaveBeenCalledWith('convo-1', { isStreaming: false, enabled: false });
      const sessions = mockUseChatHelpers.mock.calls.length;

      const longer = [...messages, { messageId: 'm-2' } as TMessage];
      write(longer);
      write([...longer, { messageId: 'm-3' } as TMessage]);

      /** No session hook ran again: nothing the session reads changed. */
      expect(mockUseChatHelpers.mock.calls.length).toBe(sessions);
      expect(drawn.reader[drawn.reader.length - 1]).toHaveLength(3);
      expect(drawn.pane).toBe(1);
    });

    it('has the reader say the same of the pane’s stream as the session does', () => {
      getDefaultStore().set(isSubmittingFamily(1), true);
      const { host, asked } = createLiveHost();
      function Reader() {
        useChatSessionMessages('convo-1', 1);
        return null;
      }
      render(
        <ChatHostProvider host={host}>
          <ChatSessionProvider index={1} conversationId="convo-1">
            <Reader />
          </ChatSessionProvider>
        </ChatHostProvider>,
      );

      expect(asked).toHaveBeenCalledWith('convo-1', { isStreaming: true, messages: false });
      expect(asked).toHaveBeenCalledWith('convo-1', { isStreaming: true, enabled: false });
      expect(asked).not.toHaveBeenCalledWith(
        'convo-1',
        expect.objectContaining({ isStreaming: false }),
      );
      getDefaultStore().set(isSubmittingFamily(1), false);
    });

    it('still calls a pane given as a function with the messages on every change', () => {
      const { host, write } = createLiveHost();
      const pane = jest.fn(() => null);
      render(
        <ChatHostProvider host={host}>
          <ChatSessionProvider index={1} conversationId="convo-1">
            {pane}
          </ChatSessionProvider>
        </ChatHostProvider>,
      );
      const longer = [...messages, { messageId: 'm-2' } as TMessage];
      write(longer);

      expect(pane).toHaveBeenLastCalledWith({ messages: longer, isLoading: false });
    });
  });
});
