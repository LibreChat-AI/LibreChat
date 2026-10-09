import { render, screen, fireEvent } from '@testing-library/react';
import { BarChart3, MessagesSquare, NotebookPen } from 'lucide-react';
import type { NavLink } from '~/common';
import { ActivePanelProvider } from '~/Providers/ActivePanelContext';
import ShortcutTargets from '../ShortcutTargets';

const links = [
  { id: 'conversations', title: 'com_ui_chats', icon: MessagesSquare, Component: () => null },
  { id: 'prompts', title: 'com_ui_prompts', icon: NotebookPen, Component: () => null },
] as unknown as NavLink[];

const renderTargets = ({
  targetLinks = links,
  onLeaveInsights,
  routeActiveId,
}: {
  targetLinks?: NavLink[];
  onLeaveInsights?: () => void;
  routeActiveId?: string;
} = {}) =>
  render(
    <ActivePanelProvider>
      <ShortcutTargets
        links={targetLinks}
        onLeaveInsights={onLeaveInsights}
        routeActiveId={routeActiveId}
      />
    </ActivePanelProvider>,
  );

describe('ShortcutTargets', () => {
  beforeEach(() => localStorage.clear());

  /**
   * `useKeyboardShortcuts` locates panels by these ids, reads `aria-pressed`,
   * and clicks. The mobile drawer has no rail, so this is the only thing
   * keeping the panel shortcuts working there.
   */
  it('exposes a persistent target for every available panel', () => {
    renderTargets();

    expect(screen.getByTestId('nav-panel-conversations')).toBeInTheDocument();
    expect(screen.getByTestId('nav-panel-prompts')).toBeInTheDocument();
  });

  it('reports which panel is active so a shortcut can skip a no-op click', () => {
    renderTargets();

    expect(screen.getByTestId('nav-panel-conversations')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('nav-panel-prompts')).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches the active panel when clicked', () => {
    renderTargets();

    fireEvent.click(screen.getByTestId('nav-panel-prompts'));

    expect(screen.getByTestId('nav-panel-prompts')).toHaveAttribute('aria-pressed', 'true');
    expect(localStorage.getItem('side:active-panel')).toBe('prompts');
  });

  it('uses a route link callback without changing the active panel', () => {
    const onClick = jest.fn();
    const targetLinks = [
      ...links,
      {
        id: 'insights',
        title: 'com_insights_navigation',
        icon: BarChart3,
        onClick,
      },
    ] as unknown as NavLink[];

    renderTargets({ targetLinks });
    fireEvent.click(screen.getByTestId('nav-panel-insights'));

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('side:active-panel')).toBeNull();
  });

  it('leaves a route when a panel target is selected', () => {
    const onLeaveInsights = jest.fn();

    renderTargets({ onLeaveInsights, routeActiveId: 'insights' });
    fireEvent.click(screen.getByTestId('nav-panel-prompts'));

    expect(onLeaveInsights).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem('side:active-panel')).toBe('prompts');
  });

  it('offers no target for a panel this endpoint does not have', () => {
    renderTargets();

    expect(screen.queryByTestId('nav-panel-parameters')).not.toBeInTheDocument();
  });

  it('stays out of the tab order and the accessibility tree', () => {
    renderTargets();

    const target = screen.getByTestId('nav-panel-prompts');
    expect(target).toHaveAttribute('hidden');
    expect(target).toHaveAttribute('tabindex', '-1');
  });
});
