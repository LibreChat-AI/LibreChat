import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { DRAWER_UNPAINTED, MOBILE_DRAWER_ID } from '../constants';
import UnifiedSidebar from '../UnifiedSidebar';

/**
 * A closed drawer is translated off the viewport, which hides it without taking
 * it out of the paint: iOS Safari composites the scroller inside it separately
 * and can leave that layer behind at the position it held while open, so the
 * Projects and Pinned rows keep painting over the conversation. These pin the
 * one state that cannot happen — a settled, closed drawer still being painted —
 * and the two windows where painting it is exactly the point.
 *
 * React owns the resting value here; the slide's release in useDrawerSwipe hands
 * this same value back rather than clearing the property, because React will not
 * re-assert a prop whose value it has not changed. Both sides read one constant
 * so they cannot drift apart.
 */

const mockSidebarState = { isSmallScreen: true, expanded: false, setExpanded: jest.fn() };

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
}));

jest.mock('~/hooks/Nav/useSidebarState', () => ({
  __esModule: true,
  default: () => mockSidebarState,
}));

jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: jest.fn(), toggleSidebar: jest.fn() }),
}));

jest.mock('~/hooks/Nav/useUnifiedSidebarLinks', () => ({
  __esModule: true,
  default: () => [],
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useChatHelpers: () => ({}),
}));

jest.mock('~/Providers', () => ({
  ChatContext: { Provider: ({ children }: { children: ReactNode }) => <>{children}</> },
  ChatFormProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  ActivePanelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('~/components/SidePanel/Nav', () => ({
  __esModule: true,
  default: () => <div data-testid="side-panel-nav" />,
}));

jest.mock('../mobile', () => ({
  MobileHeader: () => <div data-testid="mobile-header" />,
  MobileBottomBar: () => <div data-testid="mobile-bottom-bar" />,
  MobileShortcutTargets: () => <div data-testid="mobile-shortcut-targets" />,
}));

jest.mock('../Sidebar', () => ({
  __esModule: true,
  default: () => <div data-testid="desktop-sidebar" />,
}));

const drawerVisibility = (expanded: boolean, isSliding: boolean): string => {
  mockSidebarState.expanded = expanded;
  const { unmount } = render(
    <MemoryRouter>
      <UnifiedSidebar isSliding={isSliding} />
    </MemoryRouter>,
  );
  const drawer = document.getElementById(MOBILE_DRAWER_ID);
  if (drawer == null) {
    throw new Error('the mobile drawer did not render');
  }
  const { visibility } = drawer.style;
  unmount();
  return visibility;
};

describe('mobile drawer painting', () => {
  it('is not painted once closed and settled', () => {
    expect(drawerVisibility(false, false)).toBe(DRAWER_UNPAINTED);
  });

  /** Recoil's flip is deferred past the opening frames and the closing
   *  transition outlives it at the other end, so the committed state brackets
   *  the wrong window; `isSliding` is what covers the travel. */
  it('is painted while a slide is still travelling', () => {
    expect(drawerVisibility(false, true)).toBe('');
  });

  it('is painted while open', () => {
    expect(drawerVisibility(true, false)).toBe('');
  });
});
