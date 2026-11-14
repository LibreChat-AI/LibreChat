import React, { useEffect } from 'react';
import { Provider } from 'jotai';
import { useForm } from 'react-hook-form';
import { resolveNavigation } from 'librechat-data-provider';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { FeatureSlot } from '../Context';
import PresentationHost from '../Host';
import FeaturePage from '../Page';

const mockConfig = {
  interface: { navigation: resolveNavigation({ pages: { skills: { enabled: true } } }) },
};
const mockConfigFetch = jest.fn(async () => mockConfig);
const mockEndpointsFetch = jest.fn(async () => ({}));
const mockMount = jest.fn();
const mockUnmount = jest.fn();
let mockAllowed = true;
function MockEditor() {
  const { register } = useForm({ defaultValues: { name: 'stored' } });
  useEffect(() => {
    mockMount();
    return () => {
      mockUnmount();
    };
  }, []);
  return <input aria-label="Feature draft" {...register('name')} />;
}
jest.mock('../Content', () => ({ featureContent: { skills: () => <MockEditor /> } }));
jest.mock('~/components/SidePanel/Agents/AgentPanelSwitch', () => ({ AgentEditor: () => null }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () =>
    jest
      .requireActual('@tanstack/react-query')
      .useQuery(['startup'], mockConfigFetch, { staleTime: Infinity, retry: false }),
  useGetEndpointsQuery: () =>
    jest
      .requireActual('@tanstack/react-query')
      .useQuery(['endpoints'], mockEndpointsFetch, { staleTime: Infinity, retry: false }),
}));
jest.mock('~/hooks/Nav/useUnifiedSidebarLinks', () => ({
  useSidebarDestinationState: () => ({
    links: mockAllowed ? [{ id: 'skills' }] : [],
    mcpAvailability: { status: 'ready' },
  }),
}));
jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'account-a', role: 'USER' }, roles: { USER: {} } }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/hooks/Nav/useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: jest.fn() }),
}));
jest.mock('~/hooks/Nav/useRevealChat', () => ({
  __esModule: true,
  default: () => (show: () => void) => show(),
}));
jest.mock('~/hooks/Nav/useDrawerViewport', () => ({ __esModule: true, default: () => false }));
jest.mock('~/components/Chat/Menus/OpenSidebar', () => () => null);

function Status({ name }: { name: string }) {
  const { status } = useQuery([name], { enabled: false });
  return <output aria-label={name + ' status'}>{status}</output>;
}
function Layout() {
  return (
    <PresentationHost>
      <FeatureSlot page="skills" view="panel" visible />
      <Status name="startup" />
      <Status name="endpoints" />
      <Outlet />
    </PresentationHost>
  );
}
function setup({ cached = true, entry = '/c/new' } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  if (cached) {
    client.setQueryData(['startup'], mockConfig);
    client.setQueryData(['endpoints'], {});
  }
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/c/new', element: <div>{'Chat'}</div> },
          { path: '/skills', element: <FeaturePage page="skills" /> },
        ],
      },
    ],
    { initialEntries: [entry] },
  );
  const app = () => (
    <Provider>
      <QueryClientProvider client={client}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </Provider>
  );
  const view = render(app());
  return { ...view, client, router, rerenderApp: () => view.rerender(app()) };
}
beforeEach(() => {
  mockAllowed = true;
  mockConfigFetch.mockReset().mockResolvedValue(mockConfig);
  mockEndpointsFetch.mockReset().mockResolvedValue({});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

it.each(['startup', 'endpoints'])(
  'retains dirty panel identity when cached %s data fails a background refresh and retries',
  async (key) => {
    const { client, rerenderApp } = setup();
    const draft = await screen.findByLabelText('Feature draft');
    fireEvent.change(draft, { target: { value: 'private unsaved draft' } });
    const fetch = key === 'startup' ? mockConfigFetch : mockEndpointsFetch;
    fetch.mockRejectedValueOnce(new Error('temporary offline'));
    await act(async () => {
      await client.refetchQueries([key]);
    });
    await waitFor(() => expect(screen.getByLabelText(key + ' status')).toHaveTextContent('error'));
    expect(client.getQueryState([key])?.status).toBe('error');
    expect(screen.getByLabelText('Feature draft')).toBe(draft);
    expect(draft).toHaveValue('private unsaved draft');
    expect(mockUnmount).not.toHaveBeenCalled();
    await act(async () => {
      await client.refetchQueries([key]);
    });
    expect(screen.getByLabelText('Feature draft')).toBe(draft);
    mockAllowed = false;
    rerenderApp();
    await waitFor(() => expect(screen.queryByLabelText('Feature draft')).not.toBeInTheDocument());
    expect(mockUnmount).toHaveBeenCalledTimes(1);
  },
);

it.each(['startup', 'endpoints'])(
  'shows a recoverable initial %s error without mounting feature consumers',
  async (key) => {
    const fetch = key === 'startup' ? mockConfigFetch : mockEndpointsFetch;
    fetch.mockRejectedValueOnce(new Error('initial offline'));
    const { router } = setup({ cached: false, entry: '/skills' });
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/skills');
    expect(mockMount).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(await screen.findByLabelText('Feature draft')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/skills');
  },
);
