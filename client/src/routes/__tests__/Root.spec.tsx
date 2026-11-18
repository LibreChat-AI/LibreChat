import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import Root from '../Root';

let mockUser: { id?: string; _id: string; role: string } = { _id: 'account-a', role: 'USER' };
const mockEmpty = {};
const mockSetExpanded = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, getMessagesByConvoId: jest.fn(async () => []) },
  };
});
jest.mock('recoil', () => ({ useRecoilValue: () => false }));
jest.mock('~/store', () => ({ __esModule: true, default: {} }));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUser, isAuthenticated: true }),
  useFileMap: () => mockEmpty,
  useAgentsMap: () => mockEmpty,
  useAssistantsMap: () => mockEmpty,
  useUnseenConversations: () => ({ unseen: [] }),
  useReplyAlerts: () => {},
  useReplyWatcher: () => {},
  useUnseenBadge: () => {},
  useSearchEnabled: () => {},
  useMessagesRetention: () => {},
  useCatalogWarmup: () => {},
}));
jest.mock('~/Providers', () => {
  const { createContext } = jest.requireActual('react');
  const pass = ({ children }: { children: React.ReactNode }) => children;
  return {
    PromptGroupsProvider: pass,
    SetConvoProvider: pass,
    MCPAppsPolicyProvider: pass,
    AssistantsMapContext: createContext(null),
    AgentsMapContext: createContext(null),
    FileMapContext: createContext(null),
  };
});
jest.mock('~/Providers/ComposerHostContext', () => ({
  ComposerHostProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/Providers/StreamHostContext', () => ({
  StreamHostProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/Providers/SteerHostContext', () => ({
  SteerHostProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/Providers/ChatHostContext', () => ({
  ChatHostProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('../ChatSettings', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/components/FeaturePresentation/Host', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock('~/components/FeaturePresentation/Workspace', () => ({
  __esModule: true,
  default: function Workspace() {
    const { useGetMessagesByConvoId, refetchMessagesOnMount } = jest.requireActual(
      '~/data-provider/Messages/queries',
    );
    useGetMessagesByConvoId('saved', { refetchOnMount: refetchMessagesOnMount });
    return <input aria-label="Composer" defaultValue="unsent" />;
  },
}));
jest.mock('../Record', () => ({
  __esModule: true,
  default: function Record() {
    jest
      .requireActual('~/data-provider/Messages/queries')
      .usePrefetchConversationMessages('saved', true);
    return null;
  },
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {}, isSuccess: true }),
  useUserTermsQuery: () => ({}),
  useHealthCheck: () => {},
}));
jest.mock('~/hooks/Nav/useSidebarState', () => ({
  __esModule: true,
  default: () => ({ isSmallScreen: true, expanded: true, setExpanded: mockSetExpanded }),
}));
jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: () => {} }),
}));
jest.mock('~/hooks/Nav/useDrawerDismiss', () => ({
  __esModule: true,
  default: () => ({ isSliding: false, onScrimClick: () => {} }),
}));
jest.mock('~/hooks/useKeyboardShortcuts', () => ({ __esModule: true, default: () => {} }));
jest.mock('~/components/UnifiedSidebar', () => ({
  UnifiedSidebar: () => <aside id="mobile-drawer" data-testid="drawer" />,
}));
jest.mock('~/components/UnifiedSidebar/mobile', () => ({ MobileDrawerScrim: () => null }));
jest.mock('~/components/Nav/KeyboardShortcutsDialog', () => () => null);
jest.mock('~/components/Nav/KeyboardDeleteDialog', () => () => null);
jest.mock('~/components/Nav/Settings', () => () => null);
jest.mock('~/components/Banners', () => ({ Banner: () => null }));
jest.mock('~/components/ui', () => ({ TermsAndConditionsModal: () => null }));
jest.mock('~/components/System/AnalyticsConsent', () => () => null);
jest.mock('~/components/Chat/Messages/Content/Parts/useLazyHighlight', () => ({
  CodeHighlightThrottleContext: jest.requireActual('react').createContext(0),
  normalizeCodeHighlightThrottleMs: () => 0,
}));
jest.mock('@librechat/client', () => ({ useMediaQuery: () => false }));
jest.mock('~/utils', () => ({
  logger: { warn: jest.fn() },
  findConvoInAllQueries: () => undefined,
  beginMessagesReplyFetch: () => ({}),
  completeMessagesReplyFetch: () => {},
}));

function closeDrawer(drawer: HTMLElement) {
  drawer.style.direction = 'rtl';
  const touch = (type: string, x: number, t: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 1, clientX: x, clientY: 200 };
    Object.defineProperties(event, {
      touches: { value: type === 'touchend' ? [] : [point] },
      changedTouches: { value: [point] },
      timeStamp: { value: t },
    });
    return event;
  };
  act(() => {
    drawer.dispatchEvent(touch('touchstart', 100, 0));
    drawer.dispatchEvent(touch('touchmove', 340, 50));
    drawer.dispatchEvent(touch('touchend', 340, 60));
  });
  expect(mockSetExpanded).toHaveBeenLastCalledWith(false);
}

it('keeps the shell, drawer listeners, and single transcript load across same-account identity hydration', async () => {
  mockUser = { _id: 'account-a', role: 'USER' };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const app = () => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/c/saved']}>
        <Root />
      </MemoryRouter>
    </QueryClientProvider>
  );
  const { rerender } = render(app());
  const drawer = screen.getByTestId('drawer');
  const pane = screen.getByTestId('app-pane');
  const composer = screen.getByLabelText('Composer');
  await waitFor(() => expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(client.getQueryState(['messages', 'saved'])?.status).toBe('success'));
  mockUser = { _id: 'account-a', id: 'account-a', role: 'USER' };
  rerender(app());
  expect(screen.getByTestId('drawer')).toBe(drawer);
  expect(screen.getByTestId('app-pane')).toBe(pane);
  expect(screen.getByLabelText('Composer')).toBe(composer);
  expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1);
  closeDrawer(screen.getByTestId('drawer'));
  mockSetExpanded.mockClear();
  mockUser = { _id: 'account-b', id: 'account-b', role: 'USER' };
  rerender(app());
  expect(screen.getByTestId('drawer')).not.toBe(drawer);
  expect(screen.getByLabelText('Composer')).not.toBe(composer);
  closeDrawer(screen.getByTestId('drawer'));
});
