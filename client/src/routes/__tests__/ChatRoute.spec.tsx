import React from 'react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';
import ChatRoute from '../ChatRoute';

const mockSetConversation = jest.fn();
const mockFetchConversation = jest.fn();
const mockHasSetConversation = { current: true };
let mockConversation: Partial<TConversation> = { conversationId: 'chat-a' };
const mockConfig = {};
const mockRoles = { USER: {} };
let mockAssistantListMap = {};
const mockNewConversation = jest.fn(({ template }: { template?: Partial<TConversation> }) => {
  mockConversation = { conversationId: 'new', ...template };
  mockSetConversation();
});

jest.mock('recoil', () => ({
  useRecoilValue: () => false,
  useRecoilCallback: () => () => {},
}));
jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    useCreateConversationAtom: () => ({
      conversation: mockConversation,
      hasSetConversation: mockHasSetConversation,
    }),
  },
}));
jest.mock('~/store/temporary', () => ({ __esModule: true, default: {} }));
jest.mock('../useAuthRedirect', () => ({
  __esModule: true,
  default: () => ({ isAuthenticated: true, roles: mockRoles }),
}));
jest.mock('librechat-data-provider/react-query', () => ({
  useGetModelsQuery: () => ({ data: mockConfig }),
}));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: mockConfig }),
  useGetEndpointsQuery: () => ({ data: mockConfig }),
  useListAgentsQuery: () => ({}),
  useProjectQuery: () => ({}),
  useGetConvoIdQuery: (id: string, options: { enabled: boolean }) => {
    const { useQuery: query } = jest.requireActual('@tanstack/react-query');
    return query(['conversation', id], () => mockFetchConversation(id), {
      ...options,
      retry: false,
      staleTime: Infinity,
    });
  },
}));
jest.mock('~/hooks', () => ({
  useAssistantListMap: () => mockAssistantListMap,
  useIdChangeEffect: () => {},
  useAppStartup: () => {},
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useLocalize: () => (key: string) => key,
}));
jest.mock('~/Providers', () => ({
  ToolCallsMapProvider: ({ children }: { children: React.ReactNode }) => children,
  useAgentsMapContext: () => mockConfig,
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => <span />,
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/utils', () => ({
  defaultSpecAwaitsAgents: () => false,
  processValidSettings: () => ({}),
  getDefaultModelSpec: () => ({}),
  hasModelSelection: () => false,
  isNotFoundError: () => false,
  isTemporaryConversation: () => false,
  clearMessagesCache: jest.fn(),
  logger: { log: jest.fn() },
}));
jest.mock('~/components/Chat/ChatView', () => ({
  __esModule: true,
  default: () => <div data-testid="composer">{mockConversation.conversationId}</div>,
}));

function Harness() {
  const [, update] = React.useReducer((n: number) => n + 1, 0);
  mockSetConversation.mockImplementation(update);
  return <ChatRoute />;
}

function setup(initialEntries = ['/c/chat-a'], initialIndex = initialEntries.length - 1) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: '/c/:conversationId', element: <Harness /> }], {
    initialEntries,
    initialIndex,
  });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { client, router };
}

beforeEach(() => {
  mockConversation = { conversationId: 'chat-a' };
  mockHasSetConversation.current = true;
  mockAssistantListMap = {};
  mockFetchConversation.mockImplementation(async (id: string) => ({ conversationId: id }));
});

it('reconciles Back and Forward with each route, including new chat', async () => {
  const { router } = setup(['/c/new', '/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('new'));
  await act(async () => {
    await router.navigate(1);
  });
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
});

it('does not reset a new conversation when its server id arrives before the URL', async () => {
  mockConversation = { conversationId: 'new' };
  const { router } = setup(['/c/new']);
  act(() => {
    mockConversation = { conversationId: 'created-chat' };
    mockSetConversation();
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  await act(async () => {
    await router.navigate('/c/created-chat', { replace: true });
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  expect(mockFetchConversation).not.toHaveBeenCalled();
});

it('reuses the full cached record when returning through history', async () => {
  const { client, router } = setup(['/c/chat-b', '/c/chat-a']);
  client.setQueryData(['conversation', 'chat-b'], {
    conversationId: 'chat-b',
    model: 'saved-model',
  });
  await act(async () => {
    await router.navigate(-1);
  });
  await waitFor(() =>
    expect(mockConversation).toMatchObject({ conversationId: 'chat-b', model: 'saved-model' }),
  );
  expect(mockFetchConversation).not.toHaveBeenCalled();
});

it('keeps the departing composer mounted but hidden until the destination record arrives', async () => {
  let resolveRecord: (value: Partial<TConversation>) => void = () => {};
  mockFetchConversation.mockReturnValue(
    new Promise<Partial<TConversation>>((resolve) => {
      resolveRecord = resolve;
    }),
  );
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  const composer = screen.getByTestId('composer');
  await act(async () => {
    await router.navigate(-1);
  });
  expect(screen.getByTestId('composer')).toBe(composer);
  expect(composer).not.toBeVisible();
  await act(async () => {
    resolveRecord({ conversationId: 'chat-b' });
  });
  await waitFor(() => expect(composer).toBeVisible());
  expect(composer).toHaveTextContent('chat-b');
});

it('ignores a response for a route left while its record was loading', async () => {
  let resolveRecord: (value: Partial<TConversation>) => void = () => {};
  mockFetchConversation.mockReturnValue(
    new Promise<Partial<TConversation>>((resolve) => {
      resolveRecord = resolve;
    }),
  );
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await act(async () => {
    await router.navigate(1);
  });
  await act(async () => {
    resolveRecord({ conversationId: 'chat-b' });
  });
  expect(screen.getByTestId('composer')).toHaveTextContent('chat-a');
  expect(mockNewConversation).not.toHaveBeenCalled();
});

it('allows retry after a failed history load without replacing the departing draft', async () => {
  const consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
  mockFetchConversation.mockRejectedValueOnce(new Error('offline'));
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  await screen.findByRole('alert');
  expect(mockConversation.conversationId).toBe('chat-a');
  expect(screen.getByTestId('composer')).not.toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
  await waitFor(() => expect(screen.getByTestId('composer')).toBeVisible());
  expect(mockConversation.conversationId).toBe('chat-b');
  expect(consoleError).toHaveBeenCalledWith(new Error('offline'));
});

it('waits for the conversation record even when assistant catalogs are already loaded', async () => {
  mockAssistantListMap = { assistants: {}, azureAssistants: {} };
  mockFetchConversation.mockReturnValue(new Promise(() => {}));
  const { router } = setup(['/c/chat-b', '/c/chat-a']);
  await act(async () => {
    await router.navigate(-1);
  });
  expect(mockNewConversation).not.toHaveBeenCalled();
  expect(mockConversation.conversationId).toBe('chat-a');
  expect(screen.getByTestId('composer')).not.toBeVisible();
});

it('reconciles a remounted chat route with conversation state retained by the shell', async () => {
  setup(['/c/chat-b']);
  await waitFor(() => expect(screen.getByTestId('composer')).toHaveTextContent('chat-b'));
  expect(mockFetchConversation).toHaveBeenCalledWith('chat-b');
});
