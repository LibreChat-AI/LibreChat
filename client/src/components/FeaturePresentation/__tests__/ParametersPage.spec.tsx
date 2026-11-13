import React from 'react';
import { Provider } from 'jotai';
import axios, { AxiosHeaders } from 'axios';
import { ToastProvider } from '@librechat/client';
import { RecoilRoot, useRecoilValue } from 'recoil';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, Outlet, RouterProvider } from 'react-router-dom';
import {
  EModelEndpoint,
  QueryKeys,
  dataService,
  getConfigDefaults,
  roleDefaults,
  resolveNavigation,
  SystemRoles,
} from 'librechat-data-provider';
import type { TConversation, TUser } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { act, cleanup, render, screen, waitFor } from 'test/layout-test-utils';
import { PromptGroupsProvider, SetConvoProvider } from '~/Providers';
import { resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import ChatSettingsProvider from '~/routes/ChatSettings';
import { SteerHostTestProvider } from 'test/steerHost';
import { ChatHostTestProvider } from 'test/chatHost';
import { AuthContext } from '~/hooks/AuthContext';
import LiveAnnouncer from '~/a11y/LiveAnnouncer';
import ParametersPage from '../ParametersPage';
import PresentationHost from '../Host';
import store from '~/store';

const user: TUser = {
  id: 'parameters-user',
  username: 'parameters',
  email: 'parameters@example.com',
  name: 'Parameters',
  avatar: '',
  role: SystemRoles.USER,
  provider: 'local',
  createdAt: '',
  updatedAt: '',
};
const auth: TAuthContext = {
  user,
  token: undefined,
  isAuthenticated: true,
  isAuthReady: true,
  error: undefined,
  roles: roleDefaults,
  login: jest.fn(),
  logout: jest.fn(),
  completeAuthentication: jest.fn(),
  setError: jest.fn(),
};
const saved: TConversation = {
  conversationId: 'saved-chat',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  title: 'Saved',
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
  temperature: 0.4,
};
const clients: QueryClient[] = [];
let enabled = true;
let delayRecord: Promise<TConversation> | undefined;
let modelsResponse: () => Promise<{ openAI: string[] }>;
function response<T>(data: T) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}
function State() {
  const conversation = useRecoilValue(store.conversationByIndex(0));
  return <output data-testid="context">{JSON.stringify(conversation)}</output>;
}
function Layout() {
  return (
    <PresentationHost>
      <Outlet />
      <State />
    </PresentationHost>
  );
}
function mount(path = '/parameters') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  clients.push(client);
  // Exercise real discovery, rather than the model hook's bundled initial catalog.
  client
    .getQueryCache()
    .build(client, { queryKey: [QueryKeys.models], queryFn: () => dataService.getModels() });
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/parameters', element: <ParametersPage /> },
          { path: '/c/new', element: <output data-testid="redirect" /> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <Provider>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.user, user);
              set(store.queriesEnabled, true);
            }}
          >
            <AuthContext.Provider value={auth}>
              <ToastProvider>
                <LiveAnnouncer>
                  <ChatSettingsProvider>
                    <SteerHostTestProvider>
                      <ChatHostTestProvider>
                        <SetConvoProvider>
                          <PromptGroupsProvider>{children}</PromptGroupsProvider>
                        </SetConvoProvider>
                      </ChatHostTestProvider>
                    </SteerHostTestProvider>
                  </ChatSettingsProvider>
                </LiveAnnouncer>
              </ToastProvider>
            </AuthContext.Provider>
          </RecoilRoot>
        </Provider>
      </QueryClientProvider>
    );
  }
  render(<RouterProvider router={router} />, { wrapper: Wrapper });
  return router;
}
beforeEach(() => {
  jest.spyOn(Element.prototype, 'getAnimations').mockReturnValue([]);
  localStorage.clear();
  resetCatalogWarmup();
  enabled = true;
  delayRecord = undefined;
  modelsResponse = async () => ({ openAI: ['gpt-4o'] });
  jest.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === '/api/config')
      return response({
        appTitle: 'Parameters',
        interface: {
          ...getConfigDefaults().interface,
          navigation: resolveNavigation({ pages: { parameters: { enabled } } }),
        },
      });
    if (path === '/api/endpoints') return response({ openAI: { order: 0, userProvide: false } });
    if (path === '/api/models') return response(await modelsResponse());
    if (path === '/api/convos/saved-chat')
      return response(await (delayRecord ?? Promise.resolve(saved)));
    if (
      path === '/api/presets' ||
      path === '/api/keys' ||
      path === '/api/files' ||
      path === '/api/prompts/categories'
    )
      return response([]);
    if (path === '/api/agents') return response({ data: [], has_more: false });
    if (path === '/api/prompts/groups')
      return response({
        promptGroups: [],
        has_more: false,
        after: null,
        pages: 1,
        pageNumber: '1',
        pageSize: 10,
      });
    if (path.startsWith('/api/messages/')) return response([]);
    if (
      path === '/api/endpoints/token-config' ||
      path === '/api/files/speech/config/get' ||
      path === '/api/mcp/servers' ||
      path.includes('/permissions/')
    )
      return response({});
    throw new Error('Unexpected HTTP GET ' + path);
  });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  resetCatalogWarmup();
});

it('initializes real model controls on a cold Parameters route without rendering a composer', async () => {
  const router = mount();
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    conversationId: 'new',
    endpoint: 'openAI',
    model: 'gpt-4o',
  });
  expect(screen.queryByRole('textbox', { name: 'Message input' })).not.toBeInTheDocument();
});
it('waits for the contextual saved conversation rather than redirecting or replacing it', async () => {
  let finish!: (value: TConversation) => void;
  delayRecord = new Promise((resolve) => {
    finish = resolve;
  });
  const router = mount('/parameters?' + new URLSearchParams({ chat: '/c/saved-chat' }));
  await waitFor(() =>
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/convos/saved-chat'),
      expect.anything(),
    ),
  );
  expect(router.state.location.pathname).toBe('/parameters');
  expect(screen.queryByRole('button', { name: /Save as Preset/i })).not.toBeInTheDocument();
  await act(async () => finish(saved));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    conversationId: saved.conversationId,
    endpoint: saved.endpoint,
    model: saved.model,
    temperature: saved.temperature,
  });
});
it('does not initialize conversation context when the standalone page is disabled', async () => {
  enabled = false;
  const router = mount();
  await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  expect(screen.getByTestId('context')).toHaveTextContent('null');
  expect(axios.get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/convos/'),
    expect.anything(),
  );
});

it('waits for model discovery without treating unresolved context as a denied page', async () => {
  let finish!: (value: { openAI: string[] }) => void;
  modelsResponse = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const router = mount();
  await waitFor(() =>
    expect(axios.get).toHaveBeenCalledWith(
      expect.stringContaining('/api/models'),
      expect.anything(),
    ),
  );
  expect(router.state.location.pathname).toBe('/parameters');
  expect(screen.getByTestId('context')).toHaveTextContent('null');
  await act(async () => finish({ openAI: ['gpt-4o'] }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
});

it('retries failed model discovery without abandoning the requested page', async () => {
  modelsResponse = async () => {
    throw new Error('Model service unavailable');
  };
  const router = mount();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  modelsResponse = async () => ({ openAI: ['gpt-4o'] });
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
});
