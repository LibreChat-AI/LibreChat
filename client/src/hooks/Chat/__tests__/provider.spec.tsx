import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { useChatActions } from '@librechat/chat/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ChatContract } from '../contract';
import { ChatSessionProvider } from '../provider';

const mockUseChatHelpers = jest.fn();
const mockUseAdaptiveSSE = jest.fn();
const mockUseResumeOnLoad = jest.fn();
const mockUseQueueDrain = jest.fn();
const mockRevealQueuedTurn = jest.fn();

jest.mock('~/hooks/SSE', () => ({
  useAdaptiveSSE: (...args: unknown[]) => mockUseAdaptiveSSE(...args),
  useResumeOnLoad: (...args: unknown[]) => mockUseResumeOnLoad(...args),
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
  useChatHelpers: (index?: number, paramId?: string) => mockUseChatHelpers(index, paramId),
  useQueuedTurnReveal: () => mockRevealQueuedTurn,
  useQueueDrain: (...args: unknown[]) => mockUseQueueDrain(...args),
}));

const noop = () => undefined;

const contract: ChatContract = {
  index: 0,
  conversation: { conversationId: 'convo-1' } as TConversation,
  setConversation: noop,
  newConversation: noop,
  preset: null,
  setPreset: noop,
  optionSettings: {},
  setOptionSettings: noop,
  getMessages: () => [],
  messagesKey: 'convo-1',
  setMessages: noop,
  setSiblingIdx: noop,
  latestMessageId: undefined,
  latestMessageDepth: undefined,
  subscribeMessages: () => () => undefined,
  getMessagesRevision: () => 0,
  useLiveAttachments: () => ({}),
  getMappingOptions: () => ({}),
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
  feedbackEnabled: false,
};

describe('ChatSessionProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseChatHelpers.mockReturnValue(contract);
  });

  it('runs the stream, resume and queue drain against the contract it serves', () => {
    const queryClient = new QueryClient();
    const { result } = renderHook(() => useChatActions(), {
      wrapper: ({ children }) => (
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <ChatSessionProvider index={1} conversationId="convo-1">
              {() => children}
            </ChatSessionProvider>
          </QueryClientProvider>
        </MemoryRouter>
      ),
    });

    expect(mockUseChatHelpers).toHaveBeenCalledWith(1, 'convo-1');
    expect(result.current.id).toBe('convo-1');
    expect(mockUseAdaptiveSSE).toHaveBeenCalledWith(null, contract, false, 1);
    expect(mockUseResumeOnLoad).toHaveBeenCalledWith('convo-1', contract.getMessages, 1, false);
    expect(mockUseQueueDrain).toHaveBeenCalledWith(
      1,
      'convo-1',
      contract.ask,
      mockRevealQueuedTurn,
    );
  });
});
