import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, screen, cleanup } from '@testing-library/react';
import type { NavLink } from '~/common';

const activePanel = { active: 'conversations' };

jest.mock('~/Providers', () => ({
  useActivePanel: () => ({ active: activePanel.active, setActive: jest.fn() }),
  resolveActivePanel: (active: string) => active,
  DEFAULT_PANEL: 'conversations',
}));

jest.mock('~/components/Nav/SearchBar', () => ({
  __esModule: true,
  default: () => <div data-testid="search-bar" />,
}));

import BottomBar from '../BottomBar';
import store from '~/store';

const links = [] as NavLink[];

const renderBar = (searchEnabled = true) =>
  render(
    <RecoilRoot
      initializeState={({ set }) =>
        set(store.search, (prev) => ({ ...prev, enabled: searchEnabled }))
      }
    >
      <BottomBar links={links} />
    </RecoilRoot>,
  );

describe('mobile bottom bar', () => {
  afterEach(() => {
    activePanel.active = 'conversations';
    cleanup();
  });

  /** New chat moved to the header strip: repeated under every panel it was a
   *  second, larger copy of a destination the panel has nothing to do with. */
  it('carries search and nothing else', () => {
    renderBar();

    expect(screen.getByTestId('search-bar')).toBeInTheDocument();
    expect(screen.queryByTestId('nav-new-chat-fab')).not.toBeInTheDocument();
  });

  /** Searching messages only means anything from the conversation list. What
   *  remains is an empty spacer for the bottom safe-area inset, so the panel
   *  above still stops short of the home indicator. */
  it('stands down to the safe-area spacer on a panel that has nothing to search', () => {
    activePanel.active = 'prompts';
    const { container } = renderBar();

    expect(screen.queryByTestId('search-bar')).not.toBeInTheDocument();
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });

  it('stands down to the safe-area spacer where the deployment has search off', () => {
    const { container } = renderBar(false);

    expect(screen.queryByTestId('search-bar')).not.toBeInTheDocument();
    expect(container.firstElementChild).toBeEmptyDOMElement();
  });
});
