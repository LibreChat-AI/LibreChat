import React from 'react';
import { getDefaultStore } from 'jotai';
import { act, render, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/extend-expect';
import {
  DEFAULT_PANEL,
  activePanelAtom,
  useActivePanel,
  resolveActivePanel,
  ActivePanelProvider,
} from '~/Providers/ActivePanelContext';

const LEGACY_KEY = 'side:active-panel';

function TestConsumer() {
  const { active, setActive } = useActivePanel();
  return (
    <div>
      <span data-testid="active">{active}</span>
      <button data-testid="switch-btn" onClick={() => setActive('bookmarks')} />
    </div>
  );
}

const dispatchPageShow = (persisted: boolean) =>
  act(() => {
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted }));
  });

describe('ActivePanelContext', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    getDefaultStore().set(activePanelAtom, DEFAULT_PANEL);
  });

  const renderProvider = () =>
    render(
      <ActivePanelProvider>
        <TestConsumer />
      </ActivePanelProvider>,
    );

  it('lands a first visit on conversations', () => {
    renderProvider();
    expect(screen.getByTestId('active')).toHaveTextContent('conversations');
  });

  it('ignores a panel persisted by an earlier version and leaves it for older tabs', () => {
    localStorage.setItem(LEGACY_KEY, 'skills');
    sessionStorage.setItem(LEGACY_KEY, 'skills');
    renderProvider();
    expect(screen.getByTestId('active')).toHaveTextContent('conversations');
    expect(localStorage.getItem(LEGACY_KEY)).toBe('skills');
  });

  it('keeps the chosen panel when the provider remounts in the same document', () => {
    const { unmount } = renderProvider();
    fireEvent.click(screen.getByTestId('switch-btn'));
    unmount();

    renderProvider();
    expect(screen.getByTestId('active')).toHaveTextContent('bookmarks');
  });

  it('returns to conversations when the page is restored from the back-forward cache', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('switch-btn'));

    dispatchPageShow(false);
    expect(screen.getByTestId('active')).toHaveTextContent('bookmarks');

    dispatchPageShow(true);
    expect(screen.getByTestId('active')).toHaveTextContent('conversations');
  });

  it('setActive updates state without writing to Web Storage', () => {
    renderProvider();
    fireEvent.click(screen.getByTestId('switch-btn'));
    expect(screen.getByTestId('active')).toHaveTextContent('bookmarks');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('throws when useActivePanel is called outside provider', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<TestConsumer />)).toThrow(
      'useActivePanel must be used within an ActivePanelProvider',
    );
    spy.mockRestore();
  });
});

describe('resolveActivePanel', () => {
  const links = [{ id: 'conversations' }, { id: 'prompts' }, { id: 'files' }];

  it('returns active when it matches a link', () => {
    expect(resolveActivePanel('prompts', links)).toBe('prompts');
  });

  it('falls back to first link when active does not match', () => {
    expect(resolveActivePanel('hide-panel', links)).toBe('conversations');
  });

  it('returns active unchanged when links is empty', () => {
    expect(resolveActivePanel('agents', [])).toBe('agents');
  });

  it('falls back to the only link when active is stale', () => {
    expect(resolveActivePanel('agents', [{ id: 'conversations' }])).toBe('conversations');
  });
});
