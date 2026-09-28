import React from 'react';
import { RecoilRoot } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { NavLink } from '~/common';

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
  /** The real `useNewChat` pulls the file-deletion mutation, which reads the toast context. */
  useToastContext: () => ({ showToast: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useActivePanel: () => ({ active: 'conversations', setActive: jest.fn() }),
  resolveActivePanel: () => 'conversations',
  DEFAULT_PANEL: 'conversations',
}));

jest.mock('~/components/Nav/SearchBar', () => ({
  __esModule: true,
  default: () => <div data-testid="search-bar" />,
}));

/** The heavy reset itself is the unit under order-test; only the navigation
 *  internals below useNewChat are stubbed. */
const mockNewConversation = jest.fn();
jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: mockNewConversation }),
}));

import BottomBar from '../BottomBar';

const links = [] as NavLink[];
let queryClient: QueryClient;

describe('mobile bottom bar — new chat ordering', () => {
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
          <BottomBar links={links} onNewChat={onNewChat} />
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
          <BottomBar links={links} onNewChat={onNewChat} />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByTestId('nav-new-chat-fab'), { ctrlKey: true });

    expect(onNewChat).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });
});
