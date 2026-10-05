import { createElement } from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useWithdrawArtifactVersionMutation } from '../mutations';

const mockWithdrawArtifactAppVersion = jest.fn();

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      withdrawArtifactAppVersion: (...args: unknown[]) => mockWithdrawArtifactAppVersion(...args),
    },
  };
});

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  };

describe('useWithdrawArtifactVersionMutation', () => {
  it('invalidates the catalog list, the app detail (by id and by source), and the version list', async () => {
    const queryClient = new QueryClient({
      logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    queryClient.setQueryData(
      [QueryKeys.artifactApp, 'source', 'conversation-1', 'identifier:chart'],
      {
        app: { artifactAppId: 'app-1', activeVersionId: 'version-1' },
        version: { artifactVersionId: 'version-1' },
      },
    );
    const invalidateQueries = jest.spyOn(queryClient, 'invalidateQueries');
    mockWithdrawArtifactAppVersion.mockResolvedValueOnce({ artifactVersionId: 'version-1' });
    const { result } = renderHook(() => useWithdrawArtifactVersionMutation(), {
      wrapper: createWrapper(queryClient),
    });

    await act(async () => {
      await result.current.mutateAsync({ artifactAppId: 'app-1', versionId: 'version-1' });
    });

    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.artifactApps]);
    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.artifactApp]);
    expect(invalidateQueries).toHaveBeenCalledWith([QueryKeys.artifactAppVersions, 'app-1']);
    expect(
      queryClient.getQueryState([
        QueryKeys.artifactApp,
        'source',
        'conversation-1',
        'identifier:chart',
      ])?.isInvalidated,
    ).toBe(true);
    queryClient.clear();
  });
});
