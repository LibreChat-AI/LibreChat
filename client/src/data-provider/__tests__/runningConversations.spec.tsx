import { renderHook, waitFor } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TSharedLinkGetResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { removeConvoFromAllQueries, updateConvoInAllQueries } from '~/utils/convos';
import { useRunningConversationsQuery } from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: jest.fn(),
      getSharedLink: jest.fn(),
    },
  };
});

const getConversationById = dataService.getConversationById as jest.MockedFunction<
  typeof dataService.getConversationById
>;
const getSharedLink = dataService.getSharedLink as jest.MockedFunction<
  typeof dataService.getSharedLink
>;

const record = (overrides: Partial<TConversation> = {}): TConversation =>
  ({
    conversationId: 'c1',
    title: 'Running project chat',
    chatProjectId: 'project-1',
    updatedAt: '2026-01-02T00:00:00.000Z',
    ...overrides,
  }) as TConversation;

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

let queryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe('useRunningConversationsQuery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getSharedLink.mockResolvedValue({ shareId: null, success: true } as TSharedLinkGetResponse);
  });

  afterEach(() => {
    queryClient.clear();
  });

  it('returns the record with its shared-link state and seeds an empty conversation cache', async () => {
    getConversationById.mockResolvedValue(record());
    getSharedLink.mockResolvedValue({
      shareId: 'share-1',
      success: true,
    } as TSharedLinkGetResponse);

    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0]).toMatchObject({ conversationId: 'c1', isShared: true });
    expect(queryClient.getQueryData([QueryKeys.conversation, 'c1'])).toEqual(record());
  });

  it('leaves a conversation the chat view already cached untouched', async () => {
    const cached = record({ title: 'Edited locally' });
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], cached);
    getConversationById.mockResolvedValue(record());

    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(queryClient.getQueryData([QueryKeys.conversation, 'c1'])).toBe(cached);
  });

  it('asks again within seconds for a record that is not written yet', async () => {
    getConversationById.mockRejectedValueOnce(notFound()).mockResolvedValue(record());

    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });

    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(1));
    expect(result.current).toEqual([]);
    expect(queryClient.getQueryData([QueryKeys.conversation, 'c1'])).toBeUndefined();
    await waitFor(() => expect(result.current).toHaveLength(1), { timeout: 4000 });
    expect(getConversationById).toHaveBeenCalledTimes(2);
  });

  it('follows renames and removals made through the shared cache helpers', async () => {
    getConversationById.mockResolvedValue(record());
    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    updateConvoInAllQueries(queryClient, 'c1', (c) => ({ ...c, title: 'Renamed' }));
    await waitFor(() => expect(result.current[0]?.title).toBe('Renamed'));

    removeConvoFromAllQueries(queryClient, 'c1');
    await waitFor(() => expect(result.current).toEqual([]));
  });
});
