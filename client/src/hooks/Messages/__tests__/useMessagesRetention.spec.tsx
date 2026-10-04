import React, { useEffect } from 'react';
import { createStore, Provider as JotaiProvider } from 'jotai';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { act, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Route,
  Routes,
  useParams,
  useNavigate,
  MemoryRouter,
  useSearchParams,
} from 'react-router-dom';
import type { Agents, TMessage } from 'librechat-data-provider';
import type { NavigateFunction } from 'react-router-dom';
import { RELEASE_SETTLE_MS, LEFT_HISTORY_TTL_MS } from '~/data-provider/Messages/retention';
import { pendingApprovalActionFamily } from '~/components/Chat/approval/state';
import { useGetMessagesByConvoId } from '~/data-provider/Messages/queries';
import useMessagesRetention from '../useMessagesRetention';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getMessagesByConvoId: jest.fn(),
    },
  };
});

const getMessagesByConvoId = jest.mocked(dataService.getMessagesByConvoId);

const history = (conversationId: string): TMessage[] => [
  {
    messageId: `${conversationId}-1`,
    conversationId,
    parentMessageId: '00000000-0000-0000-0000-000000000000',
    text: `transcript of ${conversationId}`,
    sender: 'User',
    isCreatedByUser: true,
    createdAt: '2026-10-01T12:00:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
  } as TMessage,
];

function Transcript() {
  const { conversationId = '' } = useParams();
  const { data } = useGetMessagesByConvoId(conversationId);
  return <p>{data?.[0]?.text ?? 'loading'}</p>;
}

/** Stands in for the gap between a route change and the next view subscribing. */
function Chat() {
  const [params] = useSearchParams();
  return params.has('mount') ? null : <Transcript />;
}

function Shell({ onNavigate }: { onNavigate: (navigate: NavigateFunction) => void }) {
  const navigate = useNavigate();
  useMessagesRetention();
  useEffect(() => {
    onNavigate(navigate);
  }, [navigate, onNavigate]);
  return (
    <Routes>
      <Route path="/c/:conversationId" element={<Chat />} />
    </Routes>
  );
}

const isCached = (queryClient: QueryClient, conversationId: string) =>
  queryClient.getQueryData([QueryKeys.messages, conversationId]) != null;

const fetchesOf = (conversationId: string) =>
  getMessagesByConvoId.mock.calls.filter(([id]) => id === conversationId).length;

describe('useMessagesRetention', () => {
  let queryClient: QueryClient;
  let store: ReturnType<typeof createStore>;
  let navigate: NavigateFunction;

  const open = async (conversationId: string) => {
    act(() => {
      navigate(`/c/${conversationId}`);
    });
    expect(await screen.findByText(`transcript of ${conversationId}`)).toBeInTheDocument();
  };

  const elapse = (ms: number) =>
    act(() => {
      jest.advanceTimersByTime(ms);
    });

  beforeEach(() => {
    jest.useFakeTimers();
    getMessagesByConvoId.mockImplementation(async (id: string) => history(id));
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    store = createStore();
    render(
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={store}>
          <MemoryRouter initialEntries={['/c/idle']}>
            <Shell
              onNavigate={(next) => {
                navigate = next;
              }}
            />
          </MemoryRouter>
        </JotaiProvider>
      </QueryClientProvider>,
    );
  });

  afterEach(() => {
    queryClient.clear();
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('releases a left conversation after the TTL, keeps running and approval-pending ones, and refetches on return', async () => {
    expect(await screen.findByText('transcript of idle')).toBeInTheDocument();
    await open('running');
    queryClient.setQueryData([QueryKeys.activeJobs], { activeJobIds: ['running'] });
    await open('approval');
    store.set(pendingApprovalActionFamily('approval'), {
      actionId: 'action-1',
    } as Agents.PendingAction);
    await open('current');

    elapse(RELEASE_SETTLE_MS);
    expect(isCached(queryClient, 'idle')).toBe(true);

    elapse(LEFT_HISTORY_TTL_MS * 2);
    expect(isCached(queryClient, 'idle')).toBe(false);
    expect(isCached(queryClient, 'running')).toBe(true);
    expect(isCached(queryClient, 'approval')).toBe(true);
    expect(isCached(queryClient, 'current')).toBe(true);

    queryClient.setQueryData([QueryKeys.activeJobs], { activeJobIds: [] });
    elapse(LEFT_HISTORY_TTL_MS);
    expect(isCached(queryClient, 'running')).toBe(false);

    expect(fetchesOf('idle')).toBe(1);
    await open('idle');
    expect(fetchesOf('idle')).toBe(2);
    await waitFor(() => expect(isCached(queryClient, 'idle')).toBe(true));
  });

  it('keeps the routed conversation while its view has not subscribed yet', async () => {
    expect(await screen.findByText('transcript of idle')).toBeInTheDocument();
    await open('other');
    act(() => {
      navigate('/c/idle?mount=later');
    });
    expect(screen.queryByText(/transcript of/)).not.toBeInTheDocument();

    elapse(LEFT_HISTORY_TTL_MS * 2);

    expect(isCached(queryClient, 'other')).toBe(false);
    expect(isCached(queryClient, 'idle')).toBe(true);
  });
});
