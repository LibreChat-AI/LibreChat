import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import type {
  TArtifactApp,
  TArtifactVersion,
  TArtifactAppWithVersion,
} from 'librechat-data-provider';
import type { QueryObserverLoadingErrorResult } from '@tanstack/react-query';
import {
  useGetArtifactAppQuery,
  useGetArtifactAppVersionQuery,
  useListArtifactAppVersionsQuery,
} from '~/data-provider';
import StandaloneAppView from './StandaloneAppView';

const mockNavigate = jest.fn();
let mockVersionId: string | undefined;

jest.mock('react-router-dom', () => ({
  useParams: () => ({ artifactAppId: 'app-1', versionId: mockVersionId }),
  useNavigate: () => mockNavigate,
}));

jest.mock('~/data-provider', () => ({
  useGetArtifactAppQuery: jest.fn(),
  useGetArtifactAppVersionQuery: jest.fn(),
  useListArtifactAppVersionsQuery: jest.fn(),
}));

jest.mock('~/hooks/useLocalize', () => ({
  __esModule: true,
  default: () => (key: string) => key,
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: { id: 'user-1', role: 'USER' } }),
  useHasAccess: () => true,
}));

jest.mock('~/components/Sharing', () => ({
  GenericGrantAccessDialog: ({ resourceName }: { resourceName?: string }) => (
    <button type="button" aria-label={`Share ${resourceName}`} />
  ),
}));

jest.mock('./AppRenderer', () => ({
  __esModule: true,
  default: ({ version }: { version: TArtifactVersion }) => (
    <div data-testid="artifact-renderer">{version.sourceSnapshot}</div>
  ),
}));

const app = {
  id: 'db-app-1',
  artifactAppId: 'app-1',
  createdBy: 'user-1',
  activeVersionId: 'version-2',
  title: 'Revenue chart',
  status: 'draft',
} as TArtifactApp;

const version = {
  artifactAppId: 'app-1',
  artifactVersionId: 'version-2',
  versionNumber: 2,
  sourceSnapshot: 'selected snapshot',
} as TArtifactVersion;

function makeQueryErrorResult<T>(
  error: unknown,
  refetch = jest.fn(),
): QueryObserverLoadingErrorResult<T> {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error,
    errorUpdateCount: 1,
    errorUpdatedAt: 0,
    failureCount: 1,
    failureReason: error,
    fetchStatus: 'idle',
    isError: true,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: true,
    isPaused: false,
    isPlaceholderData: false,
    isPreviousData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: true,
    isSuccess: false,
    refetch,
    remove: jest.fn(),
    status: 'error',
  };
}

describe('StandaloneAppView', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockVersionId = undefined;
    jest.mocked(useGetArtifactAppQuery).mockReturnValue({
      data: { app, version },
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useGetArtifactAppQuery>);
    jest.mocked(useGetArtifactAppVersionQuery).mockReturnValue({
      data: version,
      isLoading: false,
      isError: false,
    } as ReturnType<typeof useGetArtifactAppVersionQuery>);
    jest.mocked(useListArtifactAppVersionsQuery).mockReturnValue({
      data: {
        pages: [
          {
            versions: [
              {
                artifactAppId: 'app-1',
                artifactVersionId: 'version-2',
                versionNumber: 2,
              },
            ],
            has_more: true,
            after: 'next-page',
          },
        ],
        pageParams: [undefined],
      },
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage: jest.fn(),
    } as unknown as ReturnType<typeof useListArtifactAppVersionsQuery>);
  });

  it('uses the active snapshot included in the backward-compatible detail response', () => {
    render(<StandaloneAppView />);

    expect(useGetArtifactAppVersionQuery).toHaveBeenCalledWith('app-1', 'version-2', {
      enabled: false,
    });
    expect(screen.getByTestId('artifact-renderer')).toHaveTextContent('selected snapshot');
    expect(screen.getByRole('button', { name: 'Share Revenue chart' })).toBeInTheDocument();
  });

  it('loads additional metadata pages on demand', () => {
    const fetchNextPage = jest.fn();
    jest.mocked(useListArtifactAppVersionsQuery).mockReturnValue({
      data: {
        pages: [{ versions: [], has_more: true, after: 'next-page' }],
        pageParams: [undefined],
      },
      hasNextPage: true,
      isFetchingNextPage: false,
      fetchNextPage,
    } as unknown as ReturnType<typeof useListArtifactAppVersionsQuery>);

    render(<StandaloneAppView />);
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_load_more' }));

    expect(fetchNextPage).toHaveBeenCalledTimes(1);
  });

  it('retries transient artifact detail failures instead of reporting not found', () => {
    const refetch = jest.fn();
    jest
      .mocked(useGetArtifactAppQuery)
      .mockReturnValue(
        makeQueryErrorResult<TArtifactAppWithVersion>({ response: { status: 500 } }, refetch),
      );

    render(<StandaloneAppView />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_artifact_app_load_error');
    expect(screen.queryByText('com_ui_artifact_app_not_found')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('reports a missing artifact without offering a retry', () => {
    jest
      .mocked(useGetArtifactAppQuery)
      .mockReturnValue(
        makeQueryErrorResult<TArtifactAppWithVersion>({ response: { status: 404 } }),
      );

    render(<StandaloneAppView />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_artifact_app_not_found');
    expect(screen.queryByRole('button', { name: 'com_ui_retry' })).not.toBeInTheDocument();
  });

  it('retries transient version failures through the version query', () => {
    const refetch = jest.fn();
    mockVersionId = 'version-1';
    jest
      .mocked(useGetArtifactAppVersionQuery)
      .mockReturnValue(
        makeQueryErrorResult<TArtifactVersion>(new Error('network unavailable'), refetch),
      );

    render(<StandaloneAppView />);

    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_artifact_app_version_load_error');
    expect(screen.queryByText('com_ui_artifact_app_not_found')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('keeps rendering the active artifact when the initial version history request fails', () => {
    const refetch = jest.fn();
    jest.mocked(useListArtifactAppVersionsQuery).mockReturnValue({
      data: undefined,
      isError: true,
      isFetching: false,
      hasNextPage: false,
      refetch,
    } as unknown as ReturnType<typeof useListArtifactAppVersionsQuery>);

    render(<StandaloneAppView />);

    expect(screen.getByTestId('artifact-renderer')).toHaveTextContent('selected snapshot');
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_artifact_app_history_load_error');
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('preserves loaded history and offers retry when pagination fails', () => {
    const refetch = jest.fn();
    jest.mocked(useListArtifactAppVersionsQuery).mockReturnValue({
      data: {
        pages: [
          {
            versions: [
              {
                artifactAppId: 'app-1',
                artifactVersionId: 'version-2',
                versionNumber: 2,
              },
              {
                artifactAppId: 'app-1',
                artifactVersionId: 'version-1',
                versionNumber: 1,
              },
            ],
            has_more: true,
            after: 'next-page',
          },
        ],
        pageParams: [undefined],
      },
      isError: true,
      isFetching: false,
      hasNextPage: true,
      refetch,
    } as unknown as ReturnType<typeof useListArtifactAppVersionsQuery>);

    render(<StandaloneAppView />);

    expect(screen.getByTestId('artifact-renderer')).toHaveTextContent('selected snapshot');
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'com_ui_load_more' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });
});
