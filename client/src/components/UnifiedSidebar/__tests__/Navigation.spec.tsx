import React from 'react';
import { Provider, createStore } from 'jotai';
import { MessagesSquare, NotebookPen, BarChart3 } from 'lucide-react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { ConsoleProps } from '../Console';
import type { NavLink } from '~/common';
import {
  activePanelAtom,
  ActivePanelProvider,
  DEFAULT_PANEL,
} from '~/Providers/ActivePanelContext';
import { consoleRailExpandedAtom } from '../state';
import Navigation from '../Navigation';

jest.mock('~/Providers', () => jest.requireActual('~/Providers/ActivePanelContext'));

jest.mock('../Console', () => ({
  __esModule: true,
  default: (props: ConsoleProps) => (
    <div>
      <button aria-label="rail" aria-expanded={props.railExpanded} onClick={props.onToggleRail} />
      {props.onTogglePanel && (
        <button
          aria-label="panel"
          aria-expanded={props.panelExpanded}
          onClick={props.onTogglePanel}
        />
      )}
      <button aria-label="new chat" onClick={props.onNewChat} />
      {props.links.map((link) => (
        <button
          key={link.id}
          aria-label={link.id}
          aria-pressed={props.activeId === link.id}
          disabled={link.disabled}
          onClick={() => props.onSelect?.(link.id)}
        />
      ))}
    </div>
  ),
}));

const createLinks = (): NavLink[] => [
  { id: DEFAULT_PANEL, title: 'com_ui_chat_history', icon: MessagesSquare },
  { id: 'prompts', title: 'com_ui_prompts', icon: NotebookPen },
];

function renderNavigation({
  initialPanel = DEFAULT_PANEL,
  panelExpanded = true,
  routeActiveId,
  switchToHistory = true,
  onSelect,
  links = createLinks(),
}: {
  initialPanel?: string;
  panelExpanded?: boolean;
  routeActiveId?: string;
  switchToHistory?: boolean;
  onSelect?: (id: string) => void;
  links?: NavLink[];
} = {}) {
  const store = createStore();
  store.set(activePanelAtom, initialPanel);
  const onExpand = jest.fn();
  const onCollapse = jest.fn();
  const onLeavePage = jest.fn();
  render(
    <Provider store={store}>
      <ActivePanelProvider>
        <Navigation
          links={links}
          panelExpanded={panelExpanded}
          onExpand={onExpand}
          onCollapse={onCollapse}
          onLeavePage={onLeavePage}
          routeActiveId={routeActiveId}
          onSelect={onSelect}
          switchToHistory={switchToHistory}
          appTitle="Test App"
        />
      </ActivePanelProvider>
    </Provider>,
  );
  return { store, onExpand, onCollapse, onLeavePage };
}

describe('Console navigation host adapter', () => {
  beforeEach(() => localStorage.clear());

  it('persists only label expansion without changing the selected panel or its visibility', () => {
    const { store, onExpand, onCollapse, onLeavePage } = renderNavigation({
      initialPanel: 'prompts',
    });
    fireEvent.click(screen.getByRole('button', { name: 'rail' }));
    expect(store.get(consoleRailExpandedAtom)).toBe(false);
    expect(localStorage.getItem('nav:console:expanded')).toBe('false');
    expect(store.get(activePanelAtom)).toBe('prompts');
    expect(onExpand).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
    expect(onLeavePage).not.toHaveBeenCalled();
  });

  it('restores the label preference independently of a collapsed secondary panel', async () => {
    localStorage.setItem('nav:console:expanded', 'false');
    renderNavigation({ panelExpanded: false });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'rail' })).toHaveAttribute('aria-expanded', 'false'),
    );
    expect(screen.getByRole('button', { name: 'panel' })).toHaveAttribute('aria-expanded', 'false');
  });

  it.each([true, false])(
    'panel toggle with panelExpanded=%s does not change label expansion',
    (panelExpanded) => {
      const { store, onExpand, onCollapse } = renderNavigation({ panelExpanded });
      fireEvent.click(screen.getByRole('button', { name: 'panel' }));
      expect(panelExpanded ? onCollapse : onExpand).toHaveBeenCalledTimes(1);
      expect(panelExpanded ? onExpand : onCollapse).not.toHaveBeenCalled();
      expect(store.get(consoleRailExpandedAtom)).toBe(true);
      expect(store.get(activePanelAtom)).toBe(DEFAULT_PANEL);
    },
  );

  it.each([DEFAULT_PANEL, 'insights'])(
    'forwards %s to a supplied host adapter with no fallback side effects',
    (id) => {
      const onClick = jest.fn();
      const onSelect = jest.fn();
      const { store, onExpand, onCollapse, onLeavePage } = renderNavigation({
        panelExpanded: false,
        onSelect,
        links: [
          ...createLinks(),
          { id: 'insights', title: 'com_insights_navigation', icon: BarChart3, onClick },
        ],
      });
      fireEvent.click(screen.getByRole('button', { name: id }));
      expect(onSelect).toHaveBeenCalledTimes(1);
      expect(onSelect).toHaveBeenCalledWith(id);
      expect(onClick).not.toHaveBeenCalled();
      expect(store.get(activePanelAtom)).toBe(DEFAULT_PANEL);
      expect(onExpand).not.toHaveBeenCalled();
      expect(onCollapse).not.toHaveBeenCalled();
      expect(onLeavePage).not.toHaveBeenCalled();
    },
  );

  it('uses the existing route callback once without opening, closing, or selecting a panel', () => {
    const onClick = jest.fn();
    const { store, onExpand, onCollapse } = renderNavigation({
      initialPanel: 'prompts',
      panelExpanded: false,
      links: [
        ...createLinks(),
        { id: 'insights', title: 'com_insights_navigation', icon: BarChart3, onClick },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'insights' }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(store.get(activePanelAtom)).toBe('prompts');
    expect(onExpand).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('preserves existing panel selection/open behavior when no page adapter is supplied', () => {
    const { store, onExpand, onCollapse } = renderNavigation({ panelExpanded: false });
    fireEvent.click(screen.getByRole('button', { name: 'prompts' }));
    expect(store.get(activePanelAtom)).toBe('prompts');
    expect(store.get(consoleRailExpandedAtom)).toBe(true);
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(onCollapse).not.toHaveBeenCalled();
  });

  it('collapses the secondary panel on an active destination click without collapsing labels', () => {
    const { store, onCollapse } = renderNavigation();
    fireEvent.click(screen.getByRole('button', { name: DEFAULT_PANEL }));
    expect(onCollapse).toHaveBeenCalledTimes(1);
    expect(store.get(consoleRailExpandedAtom)).toBe(true);
  });

  it('can change labels on a full-page feature without leaving it', () => {
    const { store, onExpand, onCollapse, onLeavePage } = renderNavigation({
      routeActiveId: 'prompts',
      panelExpanded: false,
    });
    expect(screen.queryByRole('button', { name: 'panel' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'prompts' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(screen.getByRole('button', { name: 'rail' }));
    expect(store.get(consoleRailExpandedAtom)).toBe(false);
    expect(onExpand).not.toHaveBeenCalled();
    expect(onCollapse).not.toHaveBeenCalled();
    expect(onLeavePage).not.toHaveBeenCalled();
  });

  it('resolves inaccessible stale selections against the provided links only', () => {
    renderNavigation({ initialPanel: 'unavailable' });
    expect(screen.getByRole('button', { name: DEFAULT_PANEL })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.queryByRole('button', { name: 'unavailable' })).not.toBeInTheDocument();
  });

  it.each([true, false])(
    'applies the host new-chat preference=%s without toggling either pane',
    (switchToHistory) => {
      const { store, onExpand, onCollapse } = renderNavigation({
        initialPanel: 'prompts',
        switchToHistory,
      });
      fireEvent.click(screen.getByRole('button', { name: 'new chat' }));
      expect(store.get(activePanelAtom)).toBe(switchToHistory ? DEFAULT_PANEL : 'prompts');
      expect(store.get(consoleRailExpandedAtom)).toBe(true);
      expect(onExpand).not.toHaveBeenCalled();
      expect(onCollapse).not.toHaveBeenCalled();
    },
  );
});
