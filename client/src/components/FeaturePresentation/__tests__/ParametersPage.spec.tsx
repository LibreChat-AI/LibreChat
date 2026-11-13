import React, { useEffect, useState } from 'react';
import { Provider } from 'jotai';
import axios, { AxiosHeaders } from 'axios';
import { ResumableRun } from '@librechat/chat';
import { ToastProvider } from '@librechat/client';
import userEvent from '@testing-library/user-event';
import { RecoilRoot, useRecoilState, useRecoilValue } from 'recoil';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  EModelEndpoint,
  LocalStorageKeys,
  getConfigDefaults,
  roleDefaults,
  resolveNavigation,
  SystemRoles,
} from 'librechat-data-provider';
import type { TConversation, TModelsConfig, TStartupConfig, TUser } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { act, cleanup, render, screen, waitFor } from 'test/layout-test-utils';
import { PromptGroupsProvider, SetConvoProvider } from '~/Providers';
import { resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import ChatSettingsProvider from '~/routes/ChatSettings';
import { SteerHostTestProvider } from 'test/steerHost';
import { ChatHostTestProvider } from 'test/chatHost';
import { useFeaturePresentation } from '../Context';
import { AuthContext } from '~/hooks/AuthContext';
import LiveAnnouncer from '~/a11y/LiveAnnouncer';
import PresentationWorkspace from '../Workspace';
import useResumablePane from '~/hooks/SSE/pane';
import ParametersPage from '../ParametersPage';
import PresentationHost from '../Host';
import ChatRouteOwner from '../Route';
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
let userProvide = false;
let credentialsResponse: () => Promise<{ expiresAt: string }>;
let configModelSpecs: TStartupConfig['modelSpecs'];
let selectedEndpoint = 'openAI';
let modelsResponse: () => Promise<TModelsConfig>;
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
const generation = jest.fn();
const newChat = jest.fn();
const mounts = jest.fn();
const unmounts = jest.fn();
let pane: ReturnType<typeof useResumablePane>['pane'];
function LiveChat() {
  const [, setConversation] = useRecoilState(store.conversationByIndex(0));
  const [run] = useState(() => new ResumableRun());
  pane = useResumablePane({
    run,
    runIndex: 0,
    isAddedRequest: false,
    setStreamId: jest.fn(),
    refreshBalance: jest.fn(),
    setIsSubmitting: jest.fn(),
    setConversation,
    newConversation: newChat,
    setGenerationEpoch: generation,
  }).pane;
  useEffect(() => {
    mounts();
    return () => {
      unmounts();
    };
  }, []);
  return <input aria-label="Live composer" defaultValue="unsent" />;
}
function Controls() {
  const presentation = useFeaturePresentation()!;
  return (
    <>
      <button
        disabled={!presentation.canOpenPage('parameters')}
        onClick={() => presentation.expand('parameters')}
      >
        {'Expand'}
      </button>
      <button onClick={() => presentation.minimize('parameters')}>{'Return to chat'}</button>
    </>
  );
}
function Layout() {
  return (
    <PresentationHost>
      <Controls />
      <PresentationWorkspace />
      <State />
    </PresentationHost>
  );
}
function mount(path = '/parameters', initialConversation?: TConversation) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, cacheTime: 0 } } });
  clients.push(client);
  const router = createMemoryRouter(
    [
      {
        element: <Layout />,
        children: [
          { path: '/parameters', element: <ParametersPage /> },
          {
            path: '/c/:conversationId',
            element: initialConversation ? (
              <ChatRouteOwner>
                <LiveChat />
              </ChatRouteOwner>
            ) : (
              <output data-testid="redirect" />
            ),
          },
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
              if (initialConversation) set(store.conversationByIndex(0), initialConversation);
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
const originalAnimations = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
function installAnimations() {
  Object.defineProperty(Element.prototype, 'getAnimations', {
    configurable: true,
    value: jest.fn(() => []),
  });
}
afterAll(() => {
  if (originalAnimations)
    Object.defineProperty(Element.prototype, 'getAnimations', originalAnimations);
  else Reflect.deleteProperty(Element.prototype, 'getAnimations');
});
beforeEach(() => {
  jest.clearAllMocks();
  installAnimations();
  localStorage.clear();
  resetCatalogWarmup();
  enabled = true;
  delayRecord = undefined;
  userProvide = false;
  credentialsResponse = async () => ({ expiresAt: '' });
  configModelSpecs = undefined;
  selectedEndpoint = 'openAI';
  modelsResponse = async () => ({ openAI: ['gpt-4o'] });
  jest.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === '/api/config')
      return response({
        appTitle: 'Parameters',
        modelSpecs: configModelSpecs,
        interface: {
          ...getConfigDefaults().interface,
          navigation: resolveNavigation({ pages: { parameters: { enabled } } }),
        },
      });
    if (path === '/api/endpoints')
      return response({
        openAI: { order: 0, userProvide },
        anthropic: { order: 1, userProvide: false },
        ...(selectedEndpoint === 'openAI'
          ? {}
          : { [selectedEndpoint]: { order: 2, userProvide: false, type: EModelEndpoint.custom } }),
      });
    if (path === '/api/keys') return response(await credentialsResponse());
    if (path === '/api/models') {
      if (new URL(url, window.location.origin).searchParams.get('endpoint') !== selectedEndpoint)
        throw new Error('Expected selected-endpoint discovery');
      return response(await modelsResponse());
    }
    if (path === '/api/convos/saved-chat')
      return response(await (delayRecord ?? Promise.resolve(saved)));
    if (path === '/api/presets' || path === '/api/files' || path === '/api/prompts/categories')
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

it('installs the browser animation boundary when JSDOM has no implementation', () => {
  Reflect.deleteProperty(Element.prototype, 'getAnimations');
  expect(Element.prototype.getAnimations).toBeUndefined();
  installAnimations();
  expect(document.createElement('div').getAnimations()).toEqual([]);
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
  expect(axios.get).toHaveBeenCalledWith('/api/models?endpoint=openAI', expect.anything());
  expect(axios.get).not.toHaveBeenCalledWith('/api/models', expect.anything());
  expect(axios.get).not.toHaveBeenCalledWith('/api/models?endpoint=anthropic', expect.anything());
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
      expect.stringContaining('/api/models?endpoint=openAI'),
      expect.anything(),
    ),
  );
  expect(router.state.location.pathname).toBe('/parameters');
  const pending = JSON.parse(screen.getByTestId('context').textContent ?? '{}');
  expect(pending).toMatchObject({ conversationId: 'new', endpoint: 'openAI' });
  expect(pending.model).toBeUndefined();
  expect(screen.queryByRole('button', { name: /Save as Preset/i })).not.toBeInTheDocument();
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

it.each(['before', 'inside'])('preserves the live first-turn ACK %s Parameters', async (when) => {
  const source = '/c/new?projectId=project-a&branch=one#draft';
  const router = mount(source, { ...saved, conversationId: 'new' });
  await waitFor(() => expect(screen.getByText('Expand')).toBeEnabled());
  // Capture the transport callbacks before changing physical routes.
  const activePane = pane;
  act(() => activePane.setGenerationEpoch('new', null));
  const composer = screen.getByLabelText('Live composer');
  const acknowledge = () => act(() => activePane.replaceNewConversationUrl('assigned-chat'));
  if (when === 'before') acknowledge();
  await userEvent.click(screen.getByText('Expand'));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  if (when === 'inside') acknowledge();
  act(() =>
    activePane.setConversation?.(
      (previous) => previous && { ...previous, conversationId: 'assigned-chat' },
    ),
  );
  await userEvent.click(screen.getByText('Return to chat'));
  await waitFor(() =>
    expect(
      router.state.location.pathname + router.state.location.search + router.state.location.hash,
    ).toBe('/c/assigned-chat?projectId=project-a&branch=one#draft'),
  );
  expect(screen.getByLabelText('Live composer')).toBe(composer);
  expect(generation).toHaveBeenCalledTimes(1);
  expect(newChat).not.toHaveBeenCalled();
  expect(mounts).toHaveBeenCalledTimes(1);
  expect(unmounts).not.toHaveBeenCalled();
  expect(axios.get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/convos/assigned-chat'),
    expect.anything(),
  );
  expect(axios.get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/messages/assigned-chat'),
    expect.anything(),
  );
});

it('returns a cold saved Parameters session to its validated original query and hash', async () => {
  const target = '/c/saved-chat?branch=original#settings';
  const router = mount('/parameters?' + new URLSearchParams({ chat: target }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  await userEvent.click(screen.getByText('Return to chat'));
  await waitFor(() =>
    expect(
      router.state.location.pathname + router.state.location.search + router.state.location.hash,
    ).toBe(target),
  );
});

it('treats an explicit saved-context change on the same page as real chat navigation', async () => {
  const router = mount('/c/saved-chat', saved);
  await waitFor(() => expect(screen.getByText('Expand')).toBeEnabled());
  await userEvent.click(screen.getByText('Expand'));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  await act(async () => {
    await router.navigate(
      '/parameters?' + new URLSearchParams({ chat: '/c/other-chat?branch=other#target' }),
    );
  });
  await waitFor(() =>
    expect(
      router.state.location.pathname + router.state.location.search + router.state.location.hash,
    ).toBe('/c/other-chat?branch=other#target'),
  );
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    conversationId: saved.conversationId,
    model: saved.model,
    temperature: saved.temperature,
  });
});

it.each(['https://example.com/c/unsafe', '//example.com/c/unsafe', '/parameters'])(
  'rejects unsafe cold return target %s',
  async (chat) => {
    const router = mount('/parameters?' + new URLSearchParams({ chat }));
    expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
    await userEvent.click(screen.getByText('Return to chat'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/c/new'));
  },
);

it('preserves an explicit model-spec selection without requiring discovery', async () => {
  configModelSpecs = {
    enforce: false,
    prioritize: true,
    list: [
      {
        name: 'selected',
        label: 'Selected',
        preset: { endpoint: EModelEndpoint.openAI, model: 'spec-model', temperature: 0.2 },
      },
    ],
  };
  const router = mount('/parameters?spec=selected');
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    endpoint: 'openAI',
    model: 'spec-model',
    temperature: 0.2,
    spec: 'selected',
  });
  expect(axios.get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/models'),
    expect.anything(),
  );
});

it('waits for endpoint credentials before mounting the Parameters editor', async () => {
  userProvide = true;
  let finish!: (value: { expiresAt: string }) => void;
  credentialsResponse = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  const router = mount();
  await waitFor(() =>
    expect(axios.get).toHaveBeenCalledWith('/api/keys?name=openAI', expect.anything()),
  );
  expect(router.state.location.pathname).toBe('/parameters');
  expect(screen.queryByRole('button', { name: /Save as Preset/i })).not.toBeInTheDocument();
  await act(async () => finish({ expiresAt: '2099-01-01T00:00:00Z' }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
});

it('retries failed endpoint credentials without leaving Parameters', async () => {
  userProvide = true;
  credentialsResponse = async () => {
    throw new Error('Credentials unavailable');
  };
  const router = mount();
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  credentialsResponse = async () => ({ expiresAt: '2099-01-01T00:00:00Z' });
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
});

it('discovers only the stored custom endpoint before choosing its server default', async () => {
  selectedEndpoint = 'custom-provider';
  localStorage.setItem(
    `${LocalStorageKeys.LAST_CONVO_SETUP}_0`,
    JSON.stringify({ endpoint: selectedEndpoint }),
  );
  modelsResponse = async () => ({ [selectedEndpoint]: ['custom-server-model'] });
  const router = mount();
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/parameters');
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    endpoint: selectedEndpoint,
    model: 'custom-server-model',
  });
  expect(axios.get).toHaveBeenCalledWith('/api/models?endpoint=custom-provider', expect.anything());
  expect(axios.get).not.toHaveBeenCalledWith('/api/models?endpoint=openAI', expect.anything());
  expect(axios.get).not.toHaveBeenCalledWith('/api/models', expect.anything());
});

it('opens saved settings with an explicit model even when model discovery is unavailable', async () => {
  modelsResponse = async () => {
    throw new Error('Catalog unavailable');
  };
  mount('/parameters?' + new URLSearchParams({ chat: '/c/saved-chat' }));
  expect(await screen.findByRole('button', { name: /Save as Preset/i })).toBeInTheDocument();
  expect(JSON.parse(screen.getByTestId('context').textContent ?? '{}')).toMatchObject({
    conversationId: saved.conversationId,
    endpoint: saved.endpoint,
    model: saved.model,
    temperature: saved.temperature,
    title: saved.title,
  });
  expect(axios.get).not.toHaveBeenCalledWith(
    expect.stringContaining('/api/models'),
    expect.anything(),
  );
});
