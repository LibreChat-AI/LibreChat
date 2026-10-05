import React from 'react';
import { RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, screen } from '@testing-library/react';
import type { NavLink } from '~/common';
import UnifiedSidebar from '../UnifiedSidebar';

let mockMediaVisible = false;
let mockMediaActivityFetched = false;
let mockSmallScreen = false;
let mockExpanded = true;
const mockMediaAccessContext = React.createContext(false);
const mockMediaActivityContext = React.createContext(false);
const mockHistory = jest.fn();
const mockMediaSettings = jest.fn();
const mockMediaActivity = jest.fn();
const mockMediaEvents = jest.fn();
const mockSetSidebarOpen = jest.fn();

jest.mock('~/Providers', () => ({
  ...jest.requireActual('~/Providers/ActivePanelContext'),
  ChatContext: jest.requireActual('react').createContext({}),
  ChatFormProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    conversationEndpointByIndex: jest.requireActual('recoil').atomFamily({
      key: 'UnifiedSidebar.test.endpoint',
      default: null,
    }),
  },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useAuthContext: () => ({ user: { id: 'user' }, token: 'token' }),
  useChatHelpers: () => ({}),
}));

jest.mock('~/hooks/Media/useMediaAccess', () => ({
  useMediaAccess: () => ({
    studio: jest.requireActual('react').useContext(mockMediaAccessContext),
    scope: 'user',
    isAuthenticated: true,
  }),
}));

jest.mock('~/components/Media/session', () => ({
  useMediaSessionGuard: () => () => true,
}));

jest.mock('~/hooks/Nav/useSidebarState', () => ({
  __esModule: true,
  default: () => ({ isSmallScreen: mockSmallScreen, expanded: mockExpanded }),
}));

jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: mockSetSidebarOpen }),
}));

jest.mock('~/hooks/Nav/useSideNavLinks', () => ({
  __esModule: true,
  default: () => [],
}));

jest.mock('librechat-data-provider/react-query', () => ({
  useUserKeyQuery: () => ({}),
}));

jest.mock('~/data-provider', () => ({
  useGetEndpointsQuery: () => ({ data: {} }),
  useGetStartupConfig: () => ({ data: { media: { events: true } } }),
  useInsightsAccessQuery: () => ({}),
  useMediaActivity: (...args: unknown[]) => {
    mockMediaActivity(...args);
    return {
      count: 0,
      hasMore: false,
      isFetched: jest.requireActual('react').useContext(mockMediaActivityContext),
    };
  },
  useMediaEvents: (...args: unknown[]) => mockMediaEvents(...args),
}));

jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => ({
  __esModule: true,
  default: () => {
    mockHistory();
    return <div data-testid="history" />;
  },
}));

jest.mock('~/components/Media/Panel', () => ({
  __esModule: true,
  default: () => {
    mockMediaSettings();
    return <div data-testid="media-settings" />;
  },
}));

jest.mock('../Sidebar', () => {
  const SidePanelNav = jest.requireActual('~/components/SidePanel/Nav').default;
  return {
    __esModule: true,
    default: ({
      links,
      activeId,
      expanded,
    }: {
      links: NavLink[];
      activeId?: string;
      expanded: boolean;
    }) => (
      <div data-testid="sidebar" data-expanded={expanded}>
        {links.map((link) => (
          <button key={link.id} disabled={link.disabled}>
            {link.id}
          </button>
        ))}
        <SidePanelNav links={links} activeId={activeId} />
      </div>
    ),
  };
});

jest.mock('~/components/Nav/AgentMarketplaceButton', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../mobile', () => ({
  MobileHeader: () => null,
  MobileShortcutTargets: () => null,
  MobileBottomBar: () => null,
}));

function Harness({ path }: { path: string }) {
  return (
    <MemoryRouter initialEntries={[path]}>
      <RecoilRoot>
        <mockMediaAccessContext.Provider value={mockMediaVisible}>
          <mockMediaActivityContext.Provider value={mockMediaActivityFetched}>
            <UnifiedSidebar switchToHistory />
          </mockMediaActivityContext.Provider>
        </mockMediaAccessContext.Provider>
      </RecoilRoot>
    </MemoryRouter>
  );
}

beforeEach(() => {
  localStorage.clear();
  mockMediaVisible = false;
  mockMediaActivityFetched = false;
  mockSmallScreen = false;
  mockExpanded = true;
});

it('keeps activity enabled but waits for its first snapshot before connecting events', () => {
  mockMediaVisible = true;
  const view = render(<Harness path="/c/new" />);
  expect(mockMediaActivity).toHaveBeenLastCalledWith(expect.any(Object), true);
  expect(mockMediaEvents).toHaveBeenLastCalledWith(expect.any(Object), 'token', false);

  mockMediaActivityFetched = true;
  view.rerender(<Harness path="/c/new" />);
  expect(mockMediaEvents).toHaveBeenLastCalledWith(expect.any(Object), 'token', true);

  mockMediaVisible = false;
  view.rerender(<Harness path="/c/new" />);
  expect(mockMediaEvents).toHaveBeenLastCalledWith(expect.any(Object), 'token', false);
});

it('connects events immediately when an allowed session has a cached activity snapshot', () => {
  mockMediaVisible = true;
  mockMediaActivityFetched = true;
  render(<Harness path="/c/new" />);
  expect(mockMediaEvents).toHaveBeenLastCalledWith(expect.any(Object), 'token', true);
});

describe.each([false, true])('Studio sidebar routing (mobile=%s)', (smallScreen) => {
  it.each(['/studio', '/studio/threads/saved'])(
    'does not mount chat history while Media access resolves for %s',
    (path) => {
      mockSmallScreen = smallScreen;
      const view = render(<Harness path={path} />);

      expect(mockHistory).not.toHaveBeenCalled();
      expect(mockMediaSettings).not.toHaveBeenCalled();
      expect(mockMediaActivity).toHaveBeenLastCalledWith(expect.any(Object), false);
      expect(mockMediaEvents).toHaveBeenLastCalledWith(expect.any(Object), 'token', false);
      if (!smallScreen) {
        expect(screen.getByRole('button', { name: 'media-studio' })).toBeDisabled();
        expect(screen.getByTestId('sidebar')).toHaveAttribute('data-expanded', 'true');
      }

      mockMediaVisible = true;
      view.rerender(<Harness path={path} />);

      expect(screen.getByTestId('media-settings')).toBeInTheDocument();
      expect(mockHistory).not.toHaveBeenCalled();
      expect(localStorage.getItem('side:active-panel')).toBeNull();

      mockMediaVisible = false;
      view.rerender(<Harness path={path} />);

      expect(screen.queryByTestId('media-settings')).not.toBeInTheDocument();
      expect(mockHistory).not.toHaveBeenCalled();
    },
  );

  it.each(['/c/new', '/studio-other', '/unknown'])(
    'keeps history fallback and hides denied Studio navigation on %s',
    (path) => {
      mockSmallScreen = smallScreen;
      render(<Harness path={path} />);

      expect(screen.getByTestId('history')).toBeInTheDocument();
      expect(mockMediaSettings).not.toHaveBeenCalled();
      expect(screen.queryByRole('button', { name: 'media-studio' })).not.toBeInTheDocument();
    },
  );
});

it.each([true, false])(
  'keeps saved desktop geometry through pending, allowed and denied access (expanded=%s)',
  (expanded) => {
    mockExpanded = expanded;
    localStorage.setItem('side:width', '360');
    const view = render(<Harness path="/studio/threads/saved" />);
    const sidebar = screen.getByRole('complementary');
    const initialStyle = sidebar.getAttribute('style');
    expect(sidebar).toHaveStyle({ width: expanded ? '360px' : '52px' });
    expect(mockHistory).not.toHaveBeenCalled();
    expect(mockMediaSettings).not.toHaveBeenCalled();

    mockMediaVisible = true;
    view.rerender(<Harness path="/studio/threads/saved" />);
    expect(screen.getByTestId('media-settings')).toBeInTheDocument();
    expect(sidebar.getAttribute('style')).toBe(initialStyle);

    mockMediaVisible = false;
    view.rerender(<Harness path="/studio/threads/saved" />);
    expect(screen.queryByTestId('media-settings')).not.toBeInTheDocument();
    expect(sidebar.getAttribute('style')).toBe(initialStyle);
    expect(mockHistory).not.toHaveBeenCalled();
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
    expect(localStorage.getItem('side:width')).toBe('360');
    expect(localStorage.getItem('side:active-panel')).toBeNull();
  },
);
