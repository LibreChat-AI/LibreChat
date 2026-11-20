import React from 'react';
import { atom, RecoilRoot } from 'recoil';
import { MemoryRouter } from 'react-router-dom';
import { render, waitFor } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import {
  useGetMessagesByConvoId,
  usePrefetchConversationMessages,
  refetchMessagesOnMount,
} from '~/data-provider/Messages/queries';
import { useGetConvoIdQuery } from '~/data-provider/queries';
import ChatRecord from '../Record';

const mockCurrentId = atom<string | null>({ key: 'record-test-current-id', default: null });
let mockAuthenticated = true;
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: jest.fn(),
      getMessagesByConvoId: jest.fn(),
    },
  };
});

jest.mock('~/hooks', () => ({ useAuthContext: () => ({ isAuthenticated: mockAuthenticated }) }));
jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationIdByIndex: () => mockCurrentId },
}));
jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider/queries'),
  ...jest.requireActual('~/data-provider/Messages/queries'),
}));

function setup(path: string, currentId: string | null = null, sibling?: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <RecoilRoot initializeState={({ set }) => set(mockCurrentId, currentId)}>
        <MemoryRouter initialEntries={[path]}>
          <ChatRecord />
          {sibling}
        </MemoryRouter>
      </RecoilRoot>
    </QueryClientProvider>,
  );
  return { ...view, client };
}

beforeEach(() => {
  jest.mocked(dataService.getConversationById).mockReset();
  jest.mocked(dataService.getMessagesByConvoId).mockReset().mockResolvedValue([]);
});

afterEach(() => {
  jest.restoreAllMocks();
  mockAuthenticated = true;
});

it('starts the routed record before sibling discovery and shares it with the route observer', async () => {
  const order: string[] = [];
  const fetch = jest.mocked(dataService.getConversationById).mockImplementation(async (id) => {
    order.push('record');
    return { conversationId: id, endpoint: null, title: null, createdAt: '', updatedAt: '' };
  });
  function Discovery() {
    useQuery(['record-test-discovery'], async () => {
      order.push('discovery');
      return [];
    });
    return null;
  }
  function Route() {
    useGetConvoIdQuery('saved');
    return null;
  }
  const { client } = setup(
    '/c/saved?projectId=ignored',
    null,
    <>
      <Discovery />
      <Route />
    </>,
  );
  await waitFor(() =>
    expect(client.getQueryData(['conversation', 'saved'])).toEqual({
      conversationId: 'saved',
      endpoint: null,
      title: null,
      createdAt: '',
      updatedAt: '',
    }),
  );
  expect(order).toEqual(['record', 'discovery']);
  expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  client.clear();
});

it.each(['/c/new', '/c/search', '/projects/saved', '/settings'])(
  'does not load a saved record for %s',
  async (path) => {
    const fetch = jest.mocked(dataService.getConversationById);
    const { client } = setup(path);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetch).not.toHaveBeenCalled();
    expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
    client.clear();
  },
);

it('does not refetch a conversation installed before its new server route arrives', async () => {
  const fetch = jest.mocked(dataService.getConversationById);
  const { client } = setup('/c/just-created', 'just-created');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetch).not.toHaveBeenCalled();
  expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
  client.clear();
});

it('does not request a record before authentication', async () => {
  mockAuthenticated = false;
  const fetch = jest.mocked(dataService.getConversationById);
  const { client } = setup('/c/saved');
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(fetch).not.toHaveBeenCalled();
  expect(dataService.getMessagesByConvoId).not.toHaveBeenCalled();
  client.clear();
});

it('starts rendered-but-unmounted messages before discovery without waiting for record or config', async () => {
  const order: string[] = [];
  const pending = new Promise<never>(() => {});
  jest.mocked(dataService.getConversationById).mockReturnValue(pending);
  jest.mocked(dataService.getMessagesByConvoId).mockImplementation(() => {
    order.push('messages');
    return pending;
  });
  function Discovery() {
    useQuery(['startup-config'], () => {
      order.push('config');
      return pending;
    });
    return null;
  }
  function Session() {
    useGetMessagesByConvoId('startup-saved', { refetchOnMount: refetchMessagesOnMount });
    usePrefetchConversationMessages('startup-saved', true);
    return null;
  }
  const { client, unmount } = setup(
    '/c/startup-saved',
    null,
    <>
      <Discovery />
      <Session />
    </>,
  );
  await waitFor(() => expect(dataService.getMessagesByConvoId).toHaveBeenCalledTimes(1));
  expect(order).toEqual(['messages', 'config']);
  expect(client.getQueryState([QueryKeys.conversation, 'startup-saved'])?.fetchStatus).toBe(
    'fetching',
  );
  expect(client.getQueryState(['startup-config'])?.fetchStatus).toBe('fetching');
  expect(client.getQueryState([QueryKeys.messages, 'startup-saved'])?.fetchStatus).toBe('fetching');
  expect(dataService.getMessagesByConvoId).toHaveBeenCalledWith('startup-saved', {
    toolPreviews: true,
  });
  unmount();
  client.clear();
});
