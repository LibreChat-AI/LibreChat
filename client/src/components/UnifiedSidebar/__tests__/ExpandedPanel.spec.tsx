import React from 'react';
import { RecoilRoot } from 'recoil';
import '@testing-library/jest-dom/extend-expect';
import { MemoryRouter } from 'react-router-dom';
import { MessagesSquare, NotebookPen } from 'lucide-react';
import { render, fireEvent, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MutableSnapshot } from 'recoil';
import type { NavLink } from '~/common';
import { ActivePanelProvider, DEFAULT_PANEL } from '~/Providers';

const mockNewConversation = jest.fn();
const mockClearMessagesCache = jest.fn();

jest.mock('~/store', () => {
  const { atom } = jest.requireActual('recoil');
  let counter = 0;
  const switchAtom = atom({
    key: 'mock-newChatSwitchToHistory',
    default: true,
  });
  const customShortcutsAtom = atom({
    key: 'mock-customShortcuts',
    default: {},
  });
  const shortcutsEnabledAtom = atom({
    key: 'mock-shortcutsEnabled',
    default: true,
  });
  return {
    __esModule: true,
    default: {
      conversationByIndex: () =>
        atom({ key: `mock-conversationByIndex-${counter++}`, default: null }),
      conversationIdByIndex: () =>
        atom({ key: `mock-conversationIdByIndex-${counter++}`, default: null }),
      newChatSwitchToHistory: switchAtom,
      customShortcuts: customShortcutsAtom,
      shortcutsEnabled: shortcutsEnabledAtom,
    },
  };
});

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useShowMarketplace: () => false,
}));

/**
 * Stands in for the real hook, which reaches `useNewConvo` by deep path and so
 * escapes the `~/hooks` mock above. Mirrors its contract closely enough that
 * the panel-switch assertions still exercise the `onNewChat` wiring.
 */
jest.mock('~/hooks/Chat/useNewChat', () => ({
  __esModule: true,
  default: ({ onNewChat }: { onNewChat?: () => void } = {}) => ({
    newConversation: mockNewConversation,
    startNewChat: () => {
      mockNewConversation();
      onNewChat?.();
    },
    handleNewChatClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      mockClearMessagesCache();
      mockNewConversation();
      onNewChat?.();
    },
  }),
}));

jest.mock('~/utils', () => ({
  clearMessagesCache: (...args: unknown[]) => mockClearMessagesCache(...args),
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  CLOSE_SIDEBAR_ID: 'close-sidebar',
}));

jest.mock('~/components/Nav/AccountSettings', () => ({
  __esModule: true,
  default: () => <div data-testid="account-settings" />,
}));

import ExpandedPanel from '../ExpandedPanel';
import store from '~/store';

const createLinks = (): NavLink[] => [
  {
    title: 'com_ui_chat_history' as const,
    icon: MessagesSquare,
    id: DEFAULT_PANEL,
  },
  {
    title: 'com_ui_prompts' as const,
    icon: NotebookPen,
    id: 'prompts',
  },
];

const createQueryClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

function renderPanel({
  expanded = true,
  links = createLinks(),
  onCollapse = jest.fn(),
  onExpand = jest.fn(),
  onNavigate,
  initialPanel = DEFAULT_PANEL,
  initializeState,
}: {
  expanded?: boolean;
  links?: NavLink[];
  onCollapse?: jest.Mock;
  onExpand?: jest.Mock;
  onNavigate?: jest.Mock;
  initialPanel?: string;
  initializeState?: (snapshot: MutableSnapshot) => void;
} = {}) {
  if (initialPanel !== DEFAULT_PANEL) {
    localStorage.setItem('side:active-panel', initialPanel);
  }

  const result = render(
    <MemoryRouter>
      <QueryClientProvider client={createQueryClient()}>
        <RecoilRoot initializeState={initializeState}>
          <ActivePanelProvider>
            <ExpandedPanel
              links={links}
              expanded={expanded}
              onCollapse={onCollapse}
              onExpand={onExpand}
              onNavigate={onNavigate}
            />
          </ActivePanelProvider>
        </RecoilRoot>
      </QueryClientProvider>
    </MemoryRouter>,
  );

  return { ...result, onCollapse, onExpand };
}

describe('ExpandedPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
  });

  describe('NavIconButton collapse toggle', () => {
    it('collapses sidebar when clicking the active icon while expanded', () => {
      const { onCollapse } = renderPanel({ expanded: true });
      const activeButton = screen.getByRole('button', { name: 'com_ui_chat_history' });
      fireEvent.click(activeButton);
      expect(onCollapse).toHaveBeenCalledTimes(1);
    });

    it('switches panel when clicking an inactive icon while expanded', () => {
      const { onCollapse } = renderPanel({ expanded: true });
      const inactiveButton = screen.getByRole('button', { name: 'com_ui_prompts' });
      fireEvent.click(inactiveButton);
      expect(onCollapse).not.toHaveBeenCalled();
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });

    it('expands sidebar when clicking any icon while collapsed', () => {
      const { onExpand } = renderPanel({ expanded: false });
      const activeButton = screen.getByRole('button', { name: 'com_ui_chat_history' });
      fireEvent.click(activeButton);
      expect(onExpand).toHaveBeenCalledTimes(1);
    });

    it('sets active panel and expands when clicking an inactive icon while collapsed', () => {
      const { onExpand } = renderPanel({ expanded: false });
      const inactiveButton = screen.getByRole('button', { name: 'com_ui_prompts' });
      fireEvent.click(inactiveButton);
      expect(onExpand).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });

    it('notifies mobile navigation after a route link is selected', () => {
      const onClick = jest.fn();
      const onNavigate = jest.fn();
      const links = [
        ...createLinks(),
        {
          title: 'com_insights_navigation' as const,
          icon: NotebookPen,
          id: 'insights',
          onClick,
        },
      ];

      renderPanel({ links, onNavigate });
      fireEvent.click(screen.getByRole('button', { name: 'com_insights_navigation' }));

      expect(onClick).toHaveBeenCalledTimes(1);
      expect(onNavigate).toHaveBeenCalledTimes(1);
    });
  });

  describe('NewChatButton panel switch', () => {
    it('switches to chat history panel on new chat click when setting is enabled', () => {
      renderPanel({ expanded: true, initialPanel: 'prompts' });

      const newChatLink = screen.getByTestId('new-chat-button');
      fireEvent.click(newChatLink);

      expect(mockNewConversation).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).toBe(DEFAULT_PANEL);
    });

    it('does not switch panel on new chat click when setting is disabled', () => {
      renderPanel({
        expanded: true,
        initialPanel: 'prompts',
        initializeState: ({ set }: MutableSnapshot) => {
          set(store.newChatSwitchToHistory, false);
        },
      });

      const newChatLink = screen.getByTestId('new-chat-button');
      fireEvent.click(newChatLink);

      expect(mockNewConversation).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('side:active-panel')).toBe('prompts');
    });
  });
});
