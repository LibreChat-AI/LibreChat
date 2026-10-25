import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ChatContract } from '../contract';
import { ChatProvider, ChatSessionProvider } from '../provider';
import { useChatActions } from '../facade';

const mockUseChatHelpers = jest.fn();
const mockUseAdaptiveSSE = jest.fn();
const mockUseResumeOnLoad = jest.fn();
const mockUseQueueDrain = jest.fn();
const mockRevealQueuedTurn = jest.fn();

jest.mock('../useChatHelpers', () => ({
  __esModule: true,
  default: (index?: number, paramId?: string) => mockUseChatHelpers(index, paramId),
}));

jest.mock('~/hooks/SSE', () => ({
  useAdaptiveSSE: (...args: unknown[]) => mockUseAdaptiveSSE(...args),
  useResumeOnLoad: (...args: unknown[]) => mockUseResumeOnLoad(...args),
}));

jest.mock('@librechat/chat/react', () => ({
  ...jest.requireActual('@librechat/chat/react'),
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
  useLiveAttachments: () => ({}),
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

const renderUnder = (props: { index?: number; conversationId?: string }) => {
  const queryClient = new QueryClient();
  return renderHook(() => useChatActions(), {
    wrapper: ({ children }) => (
      <QueryClientProvider client={queryClient}>
        <ChatProvider {...props}>{children}</ChatProvider>
      </QueryClientProvider>
    ),
  });
};

describe('ChatProvider', () => {
  beforeEach(() => {
    mockUseChatHelpers.mockReset();
    mockUseChatHelpers.mockReturnValue(contract);
  });

  it('serves the pane contract it builds to the facade below it', async () => {
    const { result } = renderUnder({ index: 1, conversationId: 'convo-1' });

    expect(mockUseChatHelpers).toHaveBeenCalledWith(1, 'convo-1');
    expect(result.current.id).toBe('convo-1');
    expect(result.current.status).toBe('ready');
    await result.current.stop();
    expect(contract.stopGenerating).toHaveBeenCalledTimes(1);
  });

  it('builds the root pane by default', () => {
    renderUnder({});

    expect(mockUseChatHelpers).toHaveBeenCalledWith(0, undefined);
  });
});

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
