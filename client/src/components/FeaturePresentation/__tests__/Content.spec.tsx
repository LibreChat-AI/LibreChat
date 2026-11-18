import React, { Suspense } from 'react';
import axios, { AxiosHeaders } from 'axios';
import { ToastProvider } from '@librechat/client';
import { RecoilRoot, useRecoilValue } from 'recoil';
import userEvent from '@testing-library/user-event';
import { submissionByIndex } from '@librechat/chat/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { Provider as JotaiProvider, useAtomValue } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, EModelEndpoint, roleDefaults, SystemRoles } from 'librechat-data-provider';
import type {
  PromptGroupListResponse,
  TConversation,
  TPromptGroup,
  TUser,
} from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { TAuthContext } from '~/common';
import { act, cleanup, render, screen, waitFor } from 'test/layout-test-utils';
import { resetCatalogWarmup } from '~/hooks/useCatalogWarmup';
import ChatSettingsProvider from '~/routes/ChatSettings';
import { SteerHostTestProvider } from 'test/steerHost';
import { ChatHostTestProvider } from 'test/chatHost';
import { PromptGroupsProvider } from '~/Providers';
import { AuthContext } from '~/hooks/AuthContext';
import LiveAnnouncer from '~/a11y/LiveAnnouncer';
import { featureContent } from '../Content';
import store from '~/store';

const user: TUser = {
  id: 'user-owner',
  username: 'owner',
  email: 'owner@example.com',
  name: 'Owner',
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
const conversation: TConversation = {
  conversationId: 'chat-a',
  endpoint: EModelEndpoint.openAI,
  model: 'gpt-4o',
  title: 'Existing chat',
  createdAt: '',
  updatedAt: '',
  temperature: 0.7,
};
const group: TPromptGroup = {
  _id: 'prompt-a',
  name: 'Greeting',
  author: user.id,
  authorName: user.name,
  source: 'native',
  productionPrompt: { prompt: 'Hello from the prompt' },
};
const promptPage: PromptGroupListResponse = {
  promptGroups: [group],
  pageNumber: '1',
  pageSize: 10,
  pages: 1,
  has_more: false,
  after: null,
};

function httpResponse<T>(data: T) {
  return {
    data,
    status: 200,
    statusText: 'OK',
    headers: {},
    config: { headers: new AxiosHeaders() },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

/** Observe the actual composer handoff, turn submission, and app pane state. */
function State() {
  const activePrompt = useRecoilValue(store.activePromptByIndex(0));
  const pane = useRecoilValue(store.conversationByIndex(0));
  const submission = useAtomValue(submissionByIndex(0));
  const location = useLocation();
  return (
    <>
      <output data-testid="staged-prompt">{activePrompt ?? ''}</output>
      <output data-testid="submission">{submission?.userMessage.text ?? ''}</output>
      <output data-testid="temperature">{pane?.temperature ?? 'default'}</output>
      <output data-testid="location">{location.pathname}</output>
    </>
  );
}

const clients: QueryClient[] = [];
function mount(page: 'prompts' | 'parameters', path = '/c/chat-a', autoSend = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 }, mutations: { retry: false } },
  });
  client.setQueryData([QueryKeys.messages, conversation.conversationId], []);
  clients.push(client);
  const Content = featureContent[page];
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <JotaiProvider>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.user, user);
              set(store.queriesEnabled, true);
              set(store.autoSendPrompts, autoSend);
              set(store.conversationByIndex(0), conversation);
            }}
          >
            <MemoryRouter initialEntries={[path]}>
              <AuthContext.Provider value={auth}>
                <ToastProvider>
                  <LiveAnnouncer>
                    <ChatSettingsProvider>
                      <SteerHostTestProvider>
                        <ChatHostTestProvider>
                          <PromptGroupsProvider>{children}</PromptGroupsProvider>
                        </ChatHostTestProvider>
                      </SteerHostTestProvider>
                    </ChatSettingsProvider>
                  </LiveAnnouncer>
                </ToastProvider>
              </AuthContext.Provider>
            </MemoryRouter>
          </RecoilRoot>
        </JotaiProvider>
      </QueryClientProvider>
    );
  }
  return render(
    <>
      <Suspense fallback={null}>
        <Content visible />
      </Suspense>
      <State />
    </>,
    { wrapper: Wrapper },
  );
}

let groupsResponse: () => Promise<PromptGroupListResponse>;
let unexpectedRequests: string[];
beforeEach(() => {
  localStorage.clear();
  resetCatalogWarmup();
  unexpectedRequests = [];
  groupsResponse = () => Promise.resolve(promptPage);
  jest.spyOn(axios, 'get').mockImplementation(async (url) => {
    const path = new URL(url, window.location.origin).pathname;
    if (path === '/api/prompts/groups') {
      return httpResponse(await groupsResponse());
    }
    if (path === '/api/categories') {
      return httpResponse([]);
    }
    if (path === '/api/config') {
      return httpResponse({ appTitle: 'Test', interface: {} });
    }
    if (path === '/api/keys') {
      return httpResponse({ expiresAt: '' });
    }
    if (path === '/api/endpoints') {
      return httpResponse({ openAI: { order: 0 } });
    }
    if (path.includes('/permissions/')) {
      return httpResponse({ [group._id ?? '']: 1 });
    }
    unexpectedRequests.push(`GET ${path}`);
    throw new Error(`Unexpected GET ${path}`);
  });
  jest.spyOn(axios, 'post').mockImplementation(async (url) => {
    if (new URL(url, window.location.origin).pathname === '/api/prompts/groups/prompt-a/use') {
      return httpResponse({ numberOfGenerations: 1 });
    }
    unexpectedRequests.push(`POST ${url}`);
    throw new Error(`Unexpected POST ${url}`);
  });
});

afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  resetCatalogWarmup();
  if (unexpectedRequests.length > 0) {
    throw new Error(`Unmatched HTTP fixtures: ${unexpectedRequests.join(', ')}`);
  }
});

it('loads real prompt rows and stages a selection without auto-send', async () => {
  const response = deferred<PromptGroupListResponse>();
  groupsResponse = () => response.promise;
  const { container } = mount('prompts');
  expect(await screen.findByText('Loading...')).toBeInTheDocument();
  expect(container.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Greeting/ })).not.toBeInTheDocument();

  await act(async () => response.resolve(promptPage));
  await userEvent.click(await screen.findByRole('button', { name: /Greeting/ }));

  expect(screen.getByTestId('staged-prompt')).toHaveTextContent('Hello from the prompt');
  expect(screen.getByTestId('submission')).toBeEmptyDOMElement();
  expect(screen.getByRole('button', { name: 'Send prompts on select' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(screen.getByTestId('location')).toHaveTextContent('/c/chat-a');
  await waitFor(() => expect(axios.post).toHaveBeenCalledTimes(1));
});

it('auto-sends a chat selection through the real chat turn builder', async () => {
  mount('prompts', '/c/chat-a', true);
  expect(screen.getByRole('button', { name: 'Send prompts on select' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await userEvent.click(await screen.findByRole('button', { name: /Greeting/ }));
  await waitFor(() =>
    expect(screen.getByTestId('submission')).toHaveTextContent('Hello from the prompt'),
  );
  expect(screen.getByTestId('staged-prompt')).toBeEmptyDOMElement();
});

it.each(['/prompts', '/prompts/other-prompt', '/skills/skill-a/edit'])(
  'opens prompt detail from %s without staging or submitting even with auto-send enabled',
  async (path) => {
    mount('prompts', path, true);
    await userEvent.click(await screen.findByRole('button', { name: /Greeting/ }));
    expect(screen.getByTestId('location')).toHaveTextContent('/prompts/prompt-a');
    expect(screen.getByTestId('staged-prompt')).toBeEmptyDOMElement();
    expect(screen.getByTestId('submission')).toBeEmptyDOMElement();
    expect(axios.post).not.toHaveBeenCalled();
    expect(
      screen.queryByRole('button', { name: 'Send prompts on select' }),
    ).not.toBeInTheDocument();
  },
);

it('shows a collection failure and retries the request into usable prompt rows', async () => {
  const response = deferred<PromptGroupListResponse>();
  groupsResponse = () => response.promise;
  mount('prompts', '/prompts');
  await act(async () => response.reject(new Error('Prompt service unavailable')));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  groupsResponse = () => Promise.resolve(promptPage);
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByRole('button', { name: /Greeting/ })).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('renders the contextual Parameters controls and updates the real pane conversation', async () => {
  mount('parameters', '/parameters');
  const temperature = await screen.findByRole('slider', { name: 'Temperature' });
  expect(temperature).toHaveAttribute('aria-valuenow', '0.7');
  temperature.focus();
  await userEvent.keyboard('{ArrowRight}');
  await waitFor(() => expect(screen.getByTestId('temperature')).toHaveTextContent(/^0\.71$/));
  expect(temperature).toHaveAttribute(
    'aria-valuenow',
    screen.getByTestId('temperature').textContent,
  );
});
