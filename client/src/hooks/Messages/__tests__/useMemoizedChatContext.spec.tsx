import { renderHook } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import useMemoizedChatContext from '../useMemoizedChatContext';
import { useChatContext } from '~/Providers';

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
}));

const mockUseChatContext = useChatContext as jest.MockedFunction<typeof useChatContext>;

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

function mockChatContext(latestMessageId: string | undefined, latestMessageDepth = -1) {
  mockUseChatContext.mockReturnValue({
    ...stableHelpers,
    index: 0,
    conversation,
    latestMessageId,
    latestMessageDepth,
    isSubmitting: true,
  } as unknown as ReturnType<typeof useChatContext>);
}

describe('useMemoizedChatContext', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('treats the latest message as submitting while streaming', () => {
    mockChatContext('assistant-response_');

    const { result } = renderHook(() => useMemoizedChatContext(message(), true));

    expect(result.current.effectiveIsSubmitting).toBe(true);
  });

  it('requires latestMessageId alignment before marking a row as submitting', () => {
    mockChatContext(undefined);

    const { result } = renderHook(() => useMemoizedChatContext(message(), true));

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
      { initialProps: { submitting: false } },
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
      { initialProps: { submitting: false } },
    );
    const { chatContext } = result.current;

    mockChatContext('assistant-3', 5);
    rerender({ submitting: true });

    expect(chatContext.latestMessageId).toBe('assistant-3');
    expect(chatContext.latestMessageDepth).toBe(5);
    expect(chatContext.isSubmitting).toBe(true);
  });
});
