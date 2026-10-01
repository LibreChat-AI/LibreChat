import React from 'react';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ChatContract } from '../contract';
import { useChatActions } from '../facade';
import { ChatProvider } from '../provider';

const mockUseChatHelpers = jest.fn();

jest.mock('../useChatHelpers', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockUseChatHelpers(...args),
}));

const contract = {
  conversation: { conversationId: 'convo-1' },
  messagesKey: 'convo-1',
  getMessages: () => [],
  latestMessageId: undefined,
  isSubmitting: false,
  ask: jest.fn(),
  regenerate: jest.fn(),
  stopGenerating: jest.fn(() => Promise.resolve()),
} as unknown as ChatContract;

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
