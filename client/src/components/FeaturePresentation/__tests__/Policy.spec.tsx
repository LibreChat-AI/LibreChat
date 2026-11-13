import React from 'react';
import { Provider } from 'jotai';
import { Bot } from 'lucide-react';
import { resolveNavigation } from 'librechat-data-provider';
import { render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import type { NavigationPage } from 'librechat-data-provider';
import type { NavLink } from '~/common';
import { FeaturePresentationProvider } from '../Context';
import { pageRegistry } from '../registry';
import FeaturePage from '../Page';

const pages = Object.keys(pageRegistry) as NavigationPage[];
const consumer = jest.fn(() => <div>Feature content</div>);
const features = Object.fromEntries(pages.map((page) => [page, consumer]));

function setup(
  page: NavigationPage,
  { allowed = true, enabled = true, disabled = false, ready = true } = {},
) {
  const links: NavLink[] = allowed
    ? [
        {
          id: pageRegistry[page].navId,
          icon: Bot,
          title: 'com_ui_skills',
          disabled,
        },
      ]
    : [];
  const navigation = resolveNavigation({ pages: { [page]: { enabled } } });
  const router = createMemoryRouter(
    [
      {
        element: (
          <FeaturePresentationProvider
            features={features}
            links={links}
            navigation={navigation}
            ready={ready}
            onPanelOpen={jest.fn()}
          >
            <FeaturePage page={page} />
          </FeaturePresentationProvider>
        ),
        path: pageRegistry[page].path,
      },
      {
        path: '/c/new',
        element: <div>Chat</div>,
      },
    ],
    { initialEntries: [pageRegistry[page].path] },
  );
  render(
    <Provider>
      <RouterProvider router={router} />
    </Provider>,
  );
  return router;
}

beforeEach(() => consumer.mockClear());

it.each(pages)('does not mount %s when its page is disabled', async (page) => {
  const router = setup(page, { enabled: false });
  await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  expect(consumer).not.toHaveBeenCalled();
});

it.each(pages)('does not mount %s without the feature permission', async (page) => {
  const router = setup(page, { allowed: false });
  await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  expect(consumer).not.toHaveBeenCalled();
});

it.each(pages)('does not grant %s through a disabled destination', async (page) => {
  const router = setup(page, { disabled: true });
  await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  expect(consumer).not.toHaveBeenCalled();
});

it.each(pages)('renders the authorized %s page with navigation closed', async (page) => {
  setup(page);
  expect(await screen.findByText('Feature content')).toBeInTheDocument();
});

it('does not treat unresolved startup and role data as permission denial', () => {
  const router = setup('agentBuilder', { ready: false });
  expect(router.state.location.pathname).toBe('/agent-builder');
  expect(screen.getByRole('status')).toBeInTheDocument();
  expect(consumer).not.toHaveBeenCalled();
});
