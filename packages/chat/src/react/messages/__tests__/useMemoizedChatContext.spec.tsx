/** @jest-environment jsdom */
import { renderHook } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ChatContract } from '../../chat/contract';
import { createChatContract } from '../../../__fixtures__/chat';
import useMemoizedChatContext from '../useMemoizedChatContext';
import { ChatContext } from '../../chat/context';

const conversation = {
  conversationId: 'convo-id',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

const message = (overrides: Partial<TMessage> = {}) =>
  ({
    messageId: 'assistant-response_',
    parentMessageId: 'user-message',
    conversationId: 'convo-id',
    sender: 'Assistant',
    text: '',
    isCreatedByUser: false,
    children: [],
    ...overrides,
  }) as TMessage;

const stableHelpers = {
  ask: jest.fn(),
  regenerate: jest.fn(),
  handleContinue: jest.fn(),
};

let contract: ChatContract = createChatContract();

function mockChatContext(
  latestMessageId: string | undefined,
  latestMessageDepth = -1,
  current: TConversation = conversation,
): void {
  contract = createChatContract({
    ...stableHelpers,
    index: 0,
    conversation: current,
    latestMessageId,
    latestMessageDepth,
    isSubmitting: true,
  });
}

function wrapper({ children }: { children: ReactNode }): ReactNode {
  return <ChatContext.Provider value={contract}>{children}</ChatContext.Provider>;
}

describe('useMemoizedChatContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    contract = createChatContract();
  });

  it('treats the latest message as submitting while streaming', () => {
    mockChatContext('assistant-response_');

    const { result } = renderHook(() => useMemoizedChatContext(message(), true), { wrapper });

    expect(result.current.effectiveIsSubmitting).toBe(true);
  });

  it('requires latestMessageId alignment before marking a row as submitting', () => {
    mockChatContext(undefined);

    const { result } = renderHook(() => useMemoizedChatContext(message(), true), { wrapper });

    expect(result.current.effectiveIsSubmitting).toBe(false);
    expect(result.current.chatContext.isSubmitting).toBe(true);
  });

  /** Each send and each server id hydration moves the tail. A context object keyed
   *  on it re-rendered every memoized row in the thread; rows now read the tail
   *  from props their comparator gates, and the object keeps its identity. */
  it('keeps the context object stable while the tail and submission state move', () => {
    mockChatContext('assistant-2', 3);
    const row = message({ messageId: 'assistant-1', depth: 1 });
    const { result, rerender } = renderHook(
      ({ submitting }: { submitting: boolean }) => useMemoizedChatContext(row, submitting),
      { initialProps: { submitting: false }, wrapper },
    );
    const initial = result.current.chatContext;

    mockChatContext('assistant-3_', 5);
    rerender({ submitting: true });

    expect(result.current.chatContext).toBe(initial);
    expect(result.current.latestMessageId).toBe('assistant-3_');
    expect(result.current.latestMessageDepth).toBe(5);
  });

  it('reads the current tail and submission state through the stable object', () => {
    mockChatContext('assistant-2', 3);
    const { result, rerender } = renderHook(
      ({ submitting }: { submitting: boolean }) => useMemoizedChatContext(message(), submitting),
      { initialProps: { submitting: false }, wrapper },
    );
    const { chatContext } = result.current;

    mockChatContext('assistant-3', 5);
    rerender({ submitting: true });

    expect(chatContext.latestMessageId).toBe('assistant-3');
    expect(chatContext.latestMessageDepth).toBe(5);
    expect(chatContext.isSubmitting).toBe(true);
  });

  /** A row decides whether to draw its author from the conversation's selection, and two specs on
   *  one model differ only in `spec` and the label it resolves. */
  it.each([
    ['another model spec on the same model', { spec: 'second-spec' }],
    ['a custom name for the model', { modelLabel: 'Renamed' }],
  ])('hands rows the new conversation when the selection moves to %s', (_case, change) => {
    const selected = { ...conversation, spec: 'first-spec' } as TConversation;
    mockChatContext('assistant-1', 1, selected);
    const { result, rerender } = renderHook(() => useMemoizedChatContext(message(), false), {
      wrapper,
    });
    const initial = result.current.chatContext;

    mockChatContext('assistant-1', 1, { ...selected, ...change } as TConversation);
    rerender();

    expect(result.current.chatContext).not.toBe(initial);
    expect(result.current.chatContext.conversation).toMatchObject(change);
  });

  it('keeps the conversation while its title and other metadata change', () => {
    mockChatContext('assistant-1', 1, { ...conversation, spec: 'first-spec' } as TConversation);
    const { result, rerender } = renderHook(() => useMemoizedChatContext(message(), false), {
      wrapper,
    });
    const initial = result.current.chatContext;

    mockChatContext('assistant-1', 1, {
      ...conversation,
      spec: 'first-spec',
      title: 'A generated title',
    } as TConversation);
    rerender();

    expect(result.current.chatContext).toBe(initial);
  });
});
