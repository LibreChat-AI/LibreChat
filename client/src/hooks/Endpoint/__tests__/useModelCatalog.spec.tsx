import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { getModelCatalog } from '~/utils/availability';
import useModelCatalog from '../useModelCatalog';

it('ignores the static seed and initial failure, then keeps fetched catalogs after refetch failure', async () => {
  const client = new QueryClient({
    defaultOptions: { queries: { enabled: false, retry: false, cacheTime: 0 } },
    logger: { log: console.log, warn: console.warn, error: jest.fn() },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, unmount } = renderHook(() => useModelCatalog(), { wrapper });
  const failFetch = async () => {
    await act(async () => {
      await expect(
        client.fetchQuery({
          queryKey: [QueryKeys.models],
          staleTime: 0,
          queryFn: async () => {
            throw new Error('offline');
          },
        }),
      ).rejects.toThrow('offline');
    });
  };
  try {
    expect(client.getQueryData([QueryKeys.models])).toBeDefined();
    expect(result.current.data).toBeUndefined();
    await failFetch();
    expect(result.current.data).toBeUndefined();
    expect(getModelCatalog(client)).toBeUndefined();
    for (const models of [{ Personal: [] }, { Personal: ['saved'] }]) {
      act(() => {
        client.setQueryData([QueryKeys.models], models);
      });
      await waitFor(() => expect(result.current.data).toEqual(models));
      await failFetch();
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(result.current.data).toEqual(models);
      expect(getModelCatalog(client)).toEqual(models);
    }
  } finally {
    unmount();
    client.clear();
  }
});
