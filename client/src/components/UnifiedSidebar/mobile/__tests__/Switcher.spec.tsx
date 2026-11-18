import React from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import userEvent from '@testing-library/user-event';
import { resolveNavigation } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import type { NavLink } from '~/common';
import {
  FeaturePresentationProvider,
  useFeaturePresentation,
} from '~/components/FeaturePresentation/Context';
import useUnifiedSidebarLinks from '~/hooks/Nav/useUnifiedSidebarLinks';
import { ActivePanelProvider } from '~/Providers/ActivePanelContext';
import Switcher from '../Switcher';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/Providers', () => jest.requireActual('~/Providers/ActivePanelContext'));
let mockNavigation = resolveNavigation();
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { interface: { navigation: mockNavigation } } }),
}));
jest.mock('~/hooks/Nav/useSideNavLinks', () => ({ useSideNavDestinations: jest.fn() }));
jest.mock('~/components/UnifiedSidebar/ConversationsSection', () => () => null);

const onNavigate = jest.fn();
const onPanelOpen = jest.fn();
const links: NavLink[] = [
  { id: 'agents', title: 'com_sidepanel_agent_builder', icon: Bot, Component: () => null },
  { id: 'skills', title: 'com_ui_skills', icon: Bot, Component: () => null },
  { id: 'assistants', title: 'com_sidepanel_assistant_builder', icon: Bot, Component: () => null },
  { id: 'conversations', title: 'com_ui_chat_history', icon: Bot, Component: () => null },
  { id: 'insights', title: 'com_insights_navigation', icon: Bot, onClick: jest.fn() },
];
const features = { agentBuilder: () => null, skills: () => null };

function Menu() {
  const presentation = useFeaturePresentation()!;
  const destinations = useUnifiedSidebarLinks();
  return (
    <>
      <button onClick={() => presentation.expand('agentBuilder')}>{'Expand builder'}</button>
      <Switcher links={destinations} onNavigate={onNavigate} />
    </>
  );
}

function setup(defaultView: 'page' | 'panel' = 'panel') {
  mockNavigation = resolveNavigation({
    pages: { agentBuilder: { enabled: true }, skills: { defaultView } },
  });
  const router = createMemoryRouter(
    [
      {
        element: (
          <FeaturePresentationProvider
            links={links}
            features={features}
            navigation={mockNavigation}
            onPanelOpen={onPanelOpen}
          >
            <ActivePanelProvider>
              <Menu />
              <Outlet />
            </ActivePanelProvider>
          </FeaturePresentationProvider>
        ),
        children: [
          { path: '/c/:conversationId', element: <div /> },
          { path: '/agent-builder', element: <div /> },
          { path: '/skills', element: <div /> },
        ],
      },
    ],
    { initialEntries: ['/c/origin?projectId=project-a'] },
  );
  render(
    <Provider>
      <RouterProvider router={router} />
    </Provider>,
  );
  return router;
}

beforeEach(() => jest.clearAllMocks());

it.each([
  ['com_ui_skills', 'skills'],
  ['com_sidepanel_assistant_builder', 'assistants'],
  ['com_ui_chat_history', 'conversations'],
])('keeps %s visible after selecting it from a feature page', async (label, id) => {
  const user = userEvent.setup();
  const router = setup();
  await user.click(screen.getByText('Expand builder'));
  await waitFor(() => expect(router.state.location.pathname).toBe('/agent-builder'));
  await user.click(screen.getByTestId('panel-switcher-button'));
  await user.click(await screen.findByRole('menuitemcheckbox', { name: label }));
  await waitFor(() =>
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/c/origin?projectId=project-a',
    ),
  );
  expect(onPanelOpen).toHaveBeenCalledWith(id);
  expect(onNavigate).not.toHaveBeenCalled();
});

it('still dismisses the drawer for a page-only navigation callback', async () => {
  const user = userEvent.setup();
  setup();
  await user.click(screen.getByTestId('panel-switcher-button'));
  await user.click(
    await screen.findByRole('menuitemcheckbox', { name: 'com_insights_navigation' }),
  );
  expect(links.find((link) => link.id === 'insights')?.onClick).toHaveBeenCalledTimes(1);
  expect(onNavigate).toHaveBeenCalledTimes(1);
});

it('dismisses the drawer when the destination is configured to open as a page', async () => {
  const user = userEvent.setup();
  const router = setup('page');
  await user.click(screen.getByText('Expand builder'));
  await user.click(screen.getByTestId('panel-switcher-button'));
  await user.click(await screen.findByRole('menuitemcheckbox', { name: 'com_ui_skills' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/skills'));
  expect(onNavigate).toHaveBeenCalledTimes(1);
  expect(onPanelOpen).not.toHaveBeenCalled();
});
