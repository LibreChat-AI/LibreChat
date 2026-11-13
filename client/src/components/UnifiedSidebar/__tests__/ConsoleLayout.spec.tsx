import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { render, screen, fireEvent } from '@testing-library/react';
import type { ReactNode, Ref } from 'react';
import { MOBILE_DRAWER_ID } from '../constants';
import UnifiedSidebar from '../UnifiedSidebar';

const mockSidebarState = { isSmallScreen: false, expanded: true };
const mockSetSidebarOpen = jest.fn();
let mockReducedMotion = false;

jest.mock('@librechat/client', () => ({
  pxToRem: (value: number) => `${value / 16}rem`,
  useMediaQuery: () => mockReducedMotion,
  useRemScale: () => 1,
}));

jest.mock('~/hooks/Nav/useSidebarState', () => ({
  __esModule: true,
  default: () => mockSidebarState,
}));

jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: mockSetSidebarOpen }),
}));

jest.mock('~/hooks/Nav/useUnifiedSidebarLinks', () => ({
  __esModule: true,
  default: () => [],
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useShowMarketplace: () => false,
}));

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' '),
  DEFAULT_APP_TITLE: 'LibreChat',
}));

jest.mock('@librechat/chat/react', () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('~/Providers', () => ({
  ChatFormProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  ActivePanelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

jest.mock('~/components/Chat/Input/Files/MyFilesModal', () => ({ MyFilesModal: () => null }));
jest.mock('~/components/Nav/AgentMarketplaceButton', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/SidePanel/Nav', () => ({
  __esModule: true,
  default: () => <button data-testid="panel-field">Panel field</button>,
}));

jest.mock('../ExpandedPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="current-navigation" />,
}));

jest.mock('../Console', () => ({ CONSOLE_PANEL_ID: 'console-sidebar-panel' }));

jest.mock('../Navigation', () => ({
  __esModule: true,
  default: ({
    panelToggleRef,
    onSelect,
  }: {
    panelToggleRef?: Ref<HTMLButtonElement>;
    onSelect?: (id: string) => void;
  }) => (
    <nav data-testid="console-navigation">
      <button ref={panelToggleRef} data-testid="panel-toggle" />
      <button onClick={() => onSelect?.('prompts')}>Select prompts</button>
    </nav>
  ),
}));

jest.mock('../mobile', () => ({
  MobileHeader: () => <div data-testid="mobile-header" />,
  MobileBottomBar: () => <div data-testid="mobile-bottom-bar" />,
  MobileShortcutTargets: () => <div data-testid="mobile-shortcut-targets" />,
}));

describe('optional console shell composition', () => {
  beforeEach(() => {
    localStorage.clear();
    mockSidebarState.isSmallScreen = false;
    mockSidebarState.expanded = true;
    mockReducedMotion = false;
    mockSetSidebarOpen.mockClear();
  });

  it('keeps the current navigation as the default without console controls', () => {
    render(<UnifiedSidebar switchToHistory={true} />, { wrapper: MemoryRouter });
    expect(screen.getByTestId('current-navigation')).toBeInTheDocument();
    expect(screen.queryByTestId('console-navigation')).not.toBeInTheDocument();
  });

  it('replaces the current strip instead of mounting duplicate controls', () => {
    render(<UnifiedSidebar layout="console" switchToHistory={true} />, { wrapper: MemoryRouter });
    expect(screen.getAllByTestId('console-navigation')).toHaveLength(1);
    expect(screen.queryByTestId('current-navigation')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('panel-field')).toHaveLength(1);
  });

  it('makes the collapsed secondary panel inert and returns focus to its rail control', () => {
    const view = render(<UnifiedSidebar layout="console" switchToHistory={true} />, {
      wrapper: MemoryRouter,
    });
    screen.getByTestId('panel-field').focus();
    mockSidebarState.expanded = false;
    view.rerender(<UnifiedSidebar layout="console" switchToHistory={true} />);
    expect(screen.getByTestId('panel-toggle')).toHaveFocus();
    const panel = document.getElementById('console-sidebar-panel');
    expect(panel).toHaveAttribute('inert');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    const aside = panel?.closest('aside');
    expect(aside).toHaveAttribute('inert');
    expect(aside).toHaveStyle({ width: '0rem' });
    expect(aside?.querySelector('[role="separator"]')).toHaveAttribute('tabindex', '-1');
    expect(screen.getByTestId('console-navigation')).not.toHaveAttribute('inert');
  });

  it('forwards selection to the feature presentation host exactly once', () => {
    const onSelect = jest.fn();
    render(
      <UnifiedSidebar layout="console" switchToHistory={true} onSelect={onSelect} />,
      { wrapper: MemoryRouter },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Select prompts' }));
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('prompts');
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
  });

  it('supports a full-page feature without mutating the stored panel preference', () => {
    render(<UnifiedSidebar layout="console" routeActiveId="prompts" switchToHistory={true} />, {
      wrapper: MemoryRouter,
    });
    expect(document.getElementById('console-sidebar-panel')).toHaveAttribute('inert');
    expect(screen.getByTestId('console-navigation')).toBeInTheDocument();
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
  });

  it('does not replace the mobile drawer when the optional layout is selected', () => {
    mockSidebarState.isSmallScreen = true;
    render(<UnifiedSidebar layout="console" switchToHistory={true} />, { wrapper: MemoryRouter });
    expect(document.getElementById(MOBILE_DRAWER_ID)).toBeInTheDocument();
    expect(screen.getByTestId('mobile-header')).toBeInTheDocument();
    expect(screen.queryByTestId('console-navigation')).not.toBeInTheDocument();
  });

  it('disables panel width and opacity animations for reduced motion', () => {
    mockReducedMotion = true;
    render(<UnifiedSidebar layout="console" switchToHistory={true} />, { wrapper: MemoryRouter });
    const panel = document.getElementById('console-sidebar-panel');
    expect(panel).toHaveStyle({ transition: 'none' });
    expect(panel?.closest('aside')).toHaveStyle({ transition: 'none' });
  });
});
