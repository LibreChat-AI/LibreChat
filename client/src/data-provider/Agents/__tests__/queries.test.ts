import { createElement } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys, EModelEndpoint, PermissionBits } from 'librechat-data-provider';
import type { AgentListResponse, AgentSortOption, TUserFavorite } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useGetFavoritesQuery, useUpdateFavoritesMutation } from '../../Favorites';
import { useListAgentsQuery, useMarketplaceAgentsInfiniteQuery } from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      listAgents: jest.fn(),
      getMarketplaceAgents: jest.fn(),
      getFavorites: jest.fn(),
      updateFavorites: jest.fn(),
    },
  };
});

const listAgents = dataService.listAgents as jest.MockedFunction<typeof dataService.listAgents>;

const page = (ids: string[], after: string | null): AgentListResponse => ({
  object: 'list',
  data: ids.map((id) => ({
    id,
    name: id,
    description: null,
    created_at: 0,
    avatar: null,
    provider: EModelEndpoint.openAI,
    model: 'gpt-4o-mini',
    model_parameters: {
      temperature: null,
      maxContextTokens: null,
      max_context_tokens: null,
      max_output_tokens: null,
      top_p: null,
      frequency_penalty: null,
      presence_penalty: null,
    },
  })),
  has_more: after != null,
  after: after ?? undefined,
  first_id: ids[0] ?? '',
  last_id: ids[ids.length - 1] ?? '',
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };

const renderListAgents = (params: Parameters<typeof useListAgentsQuery>[0]) => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  /** The hook is gated on the agents endpoint being configured. */
  queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: {} });
  return renderHook(() => useListAgentsQuery(params), {
    wrapper: createWrapper(queryClient),
  });
};

describe('useListAgentsQuery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requests the server maximum page size so a typical agent set resolves in one round trip', async () => {
    listAgents.mockResolvedValue(page(['a', 'b'], null));

    const { result } = renderListAgents({ requiredPermission: PermissionBits.VIEW });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listAgents).toHaveBeenCalledTimes(1);
    expect(listAgents).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1000, requiredPermission: PermissionBits.VIEW }),
    );
  });

  it('keeps the walk page size when a caller supplies a smaller limit', async () => {
    listAgents.mockResolvedValue(page(['a'], null));

    const { result } = renderListAgents({ limit: 10, requiredPermission: PermissionBits.VIEW });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listAgents).toHaveBeenCalledWith(expect.objectContaining({ limit: 1000 }));
  });

  it('still walks every page and flattens the result when the server returns a cursor', async () => {
    listAgents
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'))
      .mockResolvedValueOnce(page(['c'], null));

    const { result } = renderListAgents({ requiredPermission: PermissionBits.VIEW });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(listAgents).toHaveBeenCalledTimes(2);
    expect(listAgents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'cursor-1' }));
    expect(result.current.data?.data.map((agent) => agent.id)).toEqual(['a', 'b', 'c']);
    expect(result.current.data?.has_more).toBe(false);
  });
});
describe('marketplace cursor recovery', () => {
  const marketplace = jest.mocked(dataService.getMarketplaceAgents);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('restarts from page one after a cursor ordering mismatch instead of appending it', async () => {
    const mismatch = Object.assign(new Error('Cursor ordering mismatch'), {
      response: {
        status: 409,
        data: { error: 'cursor_ordering_mismatch' },
      },
    });
    marketplace
      .mockResolvedValueOnce(page(['a'], 'foreign-order'))
      .mockRejectedValueOnce(mismatch)
      .mockResolvedValueOnce(page(['b'], null));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
      logger: { log: console.log, warn: console.warn, error: () => {} },
    });
    const { result } = renderHook(
      () =>
        useMarketplaceAgentsInfiniteQuery({
          requiredPermission: PermissionBits.VIEW,
          sort: 'popular',
        }),
      { wrapper: createWrapper(queryClient) },
    );

    await waitFor(() =>
      expect(result.current.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a']),
    );
    await act(async () => {
      await result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(marketplace).toHaveBeenCalledTimes(3);
      expect(result.current.data?.pages).toHaveLength(1);
      expect(result.current.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b']);
      expect(result.current.error).toBeNull();
      expect(result.current.cursorRecovery).toEqual({ id: 1, status: 'succeeded' });
    });
    expect(marketplace.mock.calls[1][0]).toEqual(
      expect.objectContaining({ cursor: 'foreign-order', sort: 'popular' }),
    );
    expect(marketplace.mock.calls[2][0]).not.toHaveProperty('cursor');
  });
});

describe('marketplace popularity cache', () => {
  const marketplace = jest.mocked(dataService.getMarketplaceAgents);
  const getFavorites = jest.mocked(dataService.getFavorites);
  const updateFavorites = jest.mocked(dataService.updateFavorites);
  let queryClient: QueryClient;
  let popularOrder: string[];
  let newestOrder: string[];
  let favorites: TUserFavorite[];

  beforeEach(() => {
    jest.clearAllMocks();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
      logger: { log: console.log, warn: console.warn, error: () => {} },
    });
    popularOrder = ['a', 'b'];
    newestOrder = ['b', 'a'];
    favorites = [{ agentId: 'a' }];
    marketplace.mockImplementation(async ({ sort }) =>
      page(sort === 'popular' ? popularOrder : newestOrder, null),
    );
    getFavorites.mockImplementation(async () => favorites);
    updateFavorites.mockImplementation(async (nextFavorites) => {
      favorites = nextFavorites;
      return favorites;
    });
  });

  afterEach(() => {
    queryClient.clear();
  });

  const renderMarketplace = () =>
    renderHook(
      ({ sort }: { sort: AgentSortOption }) => ({
        query: useMarketplaceAgentsInfiniteQuery({
          requiredPermission: PermissionBits.VIEW,
          sort,
        }),
        favorites: useGetFavoritesQuery(),
        updateFavorites: useUpdateFavoritesMutation(),
      }),
      {
        initialProps: { sort: 'popular' as AgentSortOption },
        wrapper: createWrapper(queryClient),
      },
    );

  it('keeps a pin from reordering the active list, then refreshes popularity on return', async () => {
    const { result, rerender } = renderMarketplace();
    await waitFor(() => {
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a', 'b']);
      expect(result.current.favorites.data).toEqual([{ agentId: 'a' }]);
    });

    rerender({ sort: 'newest' });
    await waitFor(() =>
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b', 'a']),
    );
    rerender({ sort: 'popular' });
    await waitFor(() =>
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a', 'b']),
    );

    popularOrder = ['b', 'a'];
    newestOrder = ['a', 'b'];
    const requestsBeforePin = marketplace.mock.calls.length;
    await act(async () => {
      await result.current.updateFavorites.mutateAsync([{ agentId: 'a' }, { agentId: 'b' }]);
    });
    expect(marketplace).toHaveBeenCalledTimes(requestsBeforePin);
    expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a', 'b']);

    rerender({ sort: 'newest' });
    await waitFor(() => {
      expect(result.current.query.isFetching).toBe(false);
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b', 'a']);
    });
    rerender({ sort: 'popular' });
    await waitFor(() => {
      expect(result.current.query.isFetching).toBe(false);
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b', 'a']);
    });
  });

  it('does not invalidate popularity when only favorite order and model pins change', async () => {
    favorites = [{ agentId: 'a' }, { agentId: 'b' }];
    const { result, rerender } = renderMarketplace();
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
      expect(result.current.favorites.data).toEqual(favorites);
    });

    popularOrder = ['b', 'a'];
    await act(async () => {
      await result.current.updateFavorites.mutateAsync([
        { agentId: 'b' },
        { model: 'gpt-4o-mini', endpoint: EModelEndpoint.openAI },
        { agentId: 'a' },
      ]);
    });
    rerender({ sort: 'newest' });
    await waitFor(() =>
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b', 'a']),
    );
    rerender({ sort: 'popular' });
    await waitFor(() => {
      expect(result.current.query.isFetching).toBe(false);
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a', 'b']);
    });
  });

  it('rolls back rejected pins without invalidating the cached ranking', async () => {
    const { result, rerender } = renderMarketplace();
    await waitFor(() => {
      expect(result.current.query.isSuccess).toBe(true);
      expect(result.current.favorites.data).toEqual([{ agentId: 'a' }]);
    });
    updateFavorites.mockRejectedValueOnce(new Error('Pin rejected'));
    popularOrder = ['b', 'a'];

    await act(async () => {
      await expect(result.current.updateFavorites.mutateAsync([])).rejects.toThrow('Pin rejected');
    });
    expect(result.current.favorites.data).toEqual([{ agentId: 'a' }]);
    rerender({ sort: 'newest' });
    await waitFor(() =>
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['b', 'a']),
    );
    rerender({ sort: 'popular' });
    await waitFor(() => {
      expect(result.current.query.isFetching).toBe(false);
      expect(result.current.query.data?.pages[0].data.map((agent) => agent.id)).toEqual(['a', 'b']);
    });
  });
});
