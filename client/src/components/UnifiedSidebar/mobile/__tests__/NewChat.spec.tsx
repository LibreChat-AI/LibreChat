import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutAriaKey: () => 'Meta+Shift+O',
}));

jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    asChild: _asChild,
    ...props
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => <div {...props}>{children}</div>,
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
  /** The real `useNewChat` pulls the file-deletion mutation, which reads the toast context. */
  useToastContext: () => ({ showToast: jest.fn() }),
}));

const mockSetActive = jest.fn();
jest.mock('~/Providers', () => ({
  useActivePanel: () => ({ active: 'conversations', setActive: mockSetActive }),
  resolveActivePanel: () => 'conversations',
  DEFAULT_PANEL: 'conversations',
}));

/** The heavy reset itself is the unit under order-test; only the navigation
 *  internals below useNewChat are stubbed. */
const mockNewConversation = jest.fn();
jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: mockNewConversation }),
}));

import NewChat from '../NewChat';

let queryClient: QueryClient;

describe('mobile header new chat', () => {
  beforeEach(() => {
    queryClient = new QueryClient();
    jest.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    queryClient.clear();
  });

  /**
   * The drawer close must start BEFORE the conversation reset: run
   * synchronously, the reset's cache clearing and navigation flush in the
   * tap's task and stall the slide's first frame. The reset rides the
   * close's `afterSlide` callback instead.
   */
  it('closes the drawer first and defers the conversation reset to afterSlide', () => {
    const order: string[] = [];
    let afterSlide: (() => void) | undefined;
    const onNewChat = jest.fn((callback?: () => void) => {
      order.push('close');
      afterSlide = callback;
    });
    mockNewConversation.mockImplementation(() => {
      order.push('reset');
    });

    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <NewChat onNewChat={onNewChat} switchToHistory={true} />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('nav-new-chat-fab'));

    expect(order).toEqual(['close']);
    expect(afterSlide).toBeDefined();

    act(() => afterSlide?.());
    expect(order).toEqual(['close', 'reset']);
  });

  it('leaves modified clicks to the browser (new tab)', () => {
    const onNewChat = jest.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <NewChat onNewChat={onNewChat} switchToHistory={true} />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('nav-new-chat-fab'), { ctrlKey: true });

    expect(onNewChat).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });
  /** The host supplies the "new chat returns to the chat list" preference;
   *  the switch-back rides the same afterSlide as the reset. */
  it.each([
    [true, 1],
    [false, 0],
  ])('with switchToHistory=%s returns to the chat list %i time(s)', (switchToHistory, calls) => {
    let afterSlide: (() => void) | undefined;
    const onNewChat = jest.fn((callback?: () => void) => {
      afterSlide = callback;
    });
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <NewChat onNewChat={onNewChat} switchToHistory={switchToHistory} />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('nav-new-chat-fab'));
    act(() => afterSlide?.());

    expect(mockSetActive).toHaveBeenCalledTimes(calls);
    if (calls) {
      expect(mockSetActive).toHaveBeenCalledWith('conversations');
    }
  });
});
