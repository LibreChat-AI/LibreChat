import React from 'react';
import { Provider, createStore } from 'jotai';
import { dataService } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TUserFavorite } from 'librechat-data-provider';
import useFavoritesData from '~/components/Nav/Favorites/useFavoritesData';
import useFavorites from '~/hooks/useFavorites';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getFavorites: jest.fn(),
      updateFavorites: jest.fn(),
    },
  };
});

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('../Favorites'),
  useGetEndpointsQuery: () => ({ data: {}, isLoading: false }),
  useGetStartupConfig: () => ({ data: { modelSpecs: { list: [] } } }),
}));

jest.mock('~/hooks', () => ({
  useFavorites: jest.requireActual('~/hooks/useFavorites').default,
  useLocalize: () => (key: string) => key,
  useGetConversation: () => () => null,
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/Providers', () => ({
  useAssistantsMapContext: () => ({}),
  useAgentsMapContext: () => ({}),
}));

jest.mock('~/hooks/Input/useSelectMention', () => ({
  __esModule: true,
  default: () => ({}),
}));

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useToastContext: () => ({ showToast: jest.fn() }),
}));

describe('favorites membership reconciliation', () => {
  beforeEach(() => localStorage.clear());

  it.each(['sidebar cleanup', 'favorite row removal'])(
    'restores a failed %s before allowing pinned-order pruning',
    async (source) => {
      const saved: TUserFavorite[] = [
        { model: 'keep', endpoint: 'openAI' },
        { model: 'restore', endpoint: 'openAI' },
      ];
      const getFavorites = jest.mocked(dataService.getFavorites).mockResolvedValue(saved);
      const write = Promise.withResolvers<TUserFavorite[]>();
      const updateFavorites = jest
        .mocked(dataService.updateFavorites)
        .mockReturnValue(write.promise);
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
        logger: { log: console.log, warn: console.warn, error: () => undefined },
      });
      const store = createStore();
      const wrapper = ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>
          <Provider store={store}>{children}</Provider>
        </QueryClientProvider>
      );
      const readyMemberships: TUserFavorite[][] = [];
      const { result, unmount } = renderHook(
        () => {
          const sidebar = useFavoritesData();
          if (sidebar.isLoaded) {
            readyMemberships.push(sidebar.favorites);
          }
          return sidebar;
        },
        { wrapper },
      );
      const row =
        source === 'favorite row removal'
          ? renderHook(() => useFavorites(), { wrapper })
          : undefined;
      try {
        await waitFor(() => {
          expect(result.current.isLoaded).toBe(true);
          expect(result.current.favorites).toEqual(saved);
        });
        readyMemberships.length = 0;
        act(() => {
          if (row) {
            row.result.current.removeFavoriteModel('restore', 'openAI');
          } else {
            result.current.reorderFavorites([saved[0]], true);
          }
        });
        await waitFor(() => {
          expect(updateFavorites).toHaveBeenCalledWith([saved[0]]);
          expect(result.current.favorites).toEqual([saved[0]]);
          expect(result.current.isLoaded).toBe(false);
        });
        await act(async () => write.reject(new Error('write failed')));
        await waitFor(() => expect(getFavorites).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(result.current.isLoaded).toBe(true));
        expect(result.current.favorites).toEqual(saved);
        expect(readyMemberships).not.toContainEqual([saved[0]]);
      } finally {
        unmount();
        row?.unmount();
        queryClient.clear();
      }
    },
  );
});
