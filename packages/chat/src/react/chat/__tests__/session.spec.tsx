/**
 * @jest-environment jsdom
 */
import { getDefaultStore } from 'jotai';
import { render } from '@testing-library/react';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import type { ChatHost, ChatMessagesQuery } from '../host';
import type { ChatContract } from '../contract';
import { submissionByIndex, clearSubmissions, isSubmittingFamily } from '../../submission';
import { ChatSessionProvider } from '../session';
import { useChatContext } from '../context';
import { ChatHostProvider } from '../host';

const mockUseChatHelpers = jest.fn();
const mockUseQueueDrain = jest.fn();
const mockUseAdaptiveSSE = jest.fn();
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
  const useSessionEffects = jest.fn();
  const host = { useMessages, useSessionEffects } as unknown as ChatHost;
  return { host, useMessages, useSessionEffects };
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

    expect(useMessages).toHaveBeenCalledWith('convo-1', { isStreaming: false });
    expect(pane).toHaveBeenLastCalledWith({ messages, isLoading: false });
  });

  it('asks the host for a streaming-aware query while the pane submits', () => {
    getDefaultStore().set(isSubmittingFamily(1), true);
    const { host, useMessages } = createHost({ messages, isLoading: false, isFetching: false });
    renderSession(host);

    expect(useMessages).toHaveBeenLastCalledWith('convo-1', { isStreaming: true });
    getDefaultStore().set(isSubmittingFamily(1), false);
  });

  it('serves the contract and runs the stream, resume and queue drain against it', () => {
    const submission = { conversation: {} } as TSubmission;
    getDefaultStore().set(submissionByIndex(1), submission);
    const { host, useSessionEffects } = createHost({
      messages,
      isLoading: false,
      isFetching: false,
    });
    renderSession(host);

    expect(mockUseChatHelpers).toHaveBeenCalledWith(1, 'convo-1');
    expect(served).toBe(contract);
    expect(mockUseAdaptiveSSE).toHaveBeenLastCalledWith(submission, contract, false, 1);
    expect(useSessionEffects).toHaveBeenLastCalledWith({
      index: 1,
      conversationId: 'convo-1',
      chat: contract,
      isSettled: true,
    });
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
    const { host, useSessionEffects } = createHost({ messages: null, ...state });
    renderSession(host);

    expect(useSessionEffects).toHaveBeenLastCalledWith(
      expect.objectContaining({ isSettled: false }),
    );
  });

  it('runs the stream and resume after the contract and before the drain', () => {
    const order: string[] = [];
    mockUseChatHelpers.mockImplementation(() => {
      order.push('contract');
      return contract;
    });
    mockUseQueueDrain.mockImplementation(() => order.push('drain'));
    mockUseAdaptiveSSE.mockImplementation(() => order.push('stream'));
    const { host, useMessages, useSessionEffects } = createHost({
      messages,
      isLoading: false,
      isFetching: false,
    });
    useMessages.mockImplementation(() => {
      order.push('messages');
      return { messages, isLoading: false, isFetching: false };
    });
    useSessionEffects.mockImplementation(() => order.push('resume'));
    renderSession(host);

    expect(order.slice(0, 5)).toEqual(['messages', 'contract', 'stream', 'resume', 'drain']);
  });
});
