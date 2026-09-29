import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useModelCatalogRefresh } from './queries';

const mockGetRevision = jest.fn();
const mockGetModelsAtRevision = jest.fn();
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    ...jest.requireActual('librechat-data-provider').dataService,
    getConfigRevision: (...args: unknown[]) => mockGetRevision(...args),
    getModelsAtRevision: (...args: unknown[]) => mockGetModelsAtRevision(...args),
  },
}));

function makeClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

describe('model catalog refresh', () => {
  beforeEach(() => {
    mockGetRevision.mockReset();
    mockGetModelsAtRevision.mockReset();
  });

  it('does not poll configuration when the browser is unauthenticated', async () => {
    const client = makeClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useModelCatalogRefresh(false), { wrapper });
    expect(mockGetRevision).not.toHaveBeenCalled();
    expect(mockGetModelsAtRevision).not.toHaveBeenCalled();
    view.unmount();
    client.clear();
  });

  it('retains the old picker until a replica serves models at its applied revision', async () => {
    const client = makeClient();
    client.setQueryData([QueryKeys.models], { gateway: ['old-model'] });
    mockGetRevision.mockResolvedValue({ distributed: true, generation: 2, pollIntervalMs: 3000 });
    mockGetModelsAtRevision.mockRejectedValueOnce(new Error('replica still on generation 1'));
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const view = renderHook(() => useModelCatalogRefresh(true, 'user-1'), { wrapper });
    const key = [QueryKeys.configRevision, 'user-1', 'models', 2];
    await waitFor(() => expect(client.getQueryState(key)?.status).toBe('error'));
    expect(client.getQueryData([QueryKeys.models])).toEqual({ gateway: ['old-model'] });
    mockGetModelsAtRevision.mockResolvedValue({ gateway: ['new-model'] });
    await client.invalidateQueries(key);
    await waitFor(() =>
      expect(client.getQueryData([QueryKeys.models])).toEqual({ gateway: ['new-model'] }),
    );
    expect(mockGetModelsAtRevision).toHaveBeenCalledWith(2, expect.anything());
    view.unmount();
    client.clear();
  });
});
