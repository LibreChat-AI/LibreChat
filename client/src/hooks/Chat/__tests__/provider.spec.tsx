import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ChatContract } from '../contract';
import { useChatActions } from '../facade';
import { ChatProvider } from '../provider';

const mockUseChatHelpers = jest.fn();

jest.mock('../useChatHelpers', () => ({
  __esModule: true,
  default: (index?: number, paramId?: string) => mockUseChatHelpers(index, paramId),
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
