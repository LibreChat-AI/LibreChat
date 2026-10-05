import React from 'react';
import { dataService } from 'librechat-data-provider';
import { act, render, waitFor } from '@testing-library/react';
import {
  completeArtifactSync,
  getCurrentArtifactSyncEntry,
  listArtifactSyncQueue,
  recordArtifactSyncBaseline,
  rescheduleArtifactSync,
  subscribeToArtifactSyncQueue,
} from './queue';
import ArtifactSyncWorker from './Worker';

const mockSetQueryData = jest.fn();
const mockFetchQuery = jest.fn();
const mockInvalidateQueries = jest.fn();
const mockRemoveQueries = jest.fn();
let mockUserId: string | null = 'user-1';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, syncArtifactApp: jest.fn() },
  };
});

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    fetchQuery: mockFetchQuery,
    invalidateQueries: mockInvalidateQueries,
    removeQueries: mockRemoveQueries,
  }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
}));

jest.mock('~/hooks', () => ({
  useAuthContext: () => ({ user: mockUserId ? { id: mockUserId } : null }),
}));

jest.mock('~/hooks/Roles/useHasAccess', () => ({
  __esModule: true,
  default: () => true,
}));

jest.mock('~/utils', () => ({ logger: { error: jest.fn() } }));

jest.mock('./queue', () => ({
  completeArtifactSync: jest.fn(),
  getCurrentArtifactSyncEntry: jest.fn(),
  listArtifactSyncQueue: jest.fn(),
  recordArtifactSyncBaseline: jest.fn(),
  rescheduleArtifactSync: jest.fn(),
  subscribeToArtifactSyncQueue: jest.fn(() => () => undefined),
}));

const entry = {
  id: 'queue-1',
  ownerId: 'user-1',
  request: {
    title: 'Chart',
    artifact: { type: 'react' as const, content: '<div />' },
    source: { conversationId: 'conversation-1', sourceKey: 'identifier:chart' },
    basedOnVersionNumber: 3,
  },
  signature: 'signature-1',
  failures: 0,
  nextAttemptAt: 0,
  updatedAt: 0,
};

/** Drains the resolve-baseline-then-send microtask chain the worker runs before each attempt. */
async function flushWorker(): Promise<void> {
  for (let tick = 0; tick < 6; tick++) {
    await Promise.resolve();
  }
}

describe('ArtifactSyncWorker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = 'user-1';
    jest.mocked(subscribeToArtifactSyncQueue).mockReturnValue(() => undefined);
    jest.mocked(listArtifactSyncQueue).mockResolvedValueOnce([entry]).mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entry);
    jest.mocked(recordArtifactSyncBaseline).mockResolvedValue(true);
    jest.mocked(dataService.syncArtifactApp).mockResolvedValue({
      app: { artifactAppId: 'app-1', latestVersionNumber: 4 },
      version: { artifactVersionId: 'version-1' },
      created: true,
      versionCreated: true,
    } as Awaited<ReturnType<typeof dataService.syncArtifactApp>>);
  });

  it('resumes persisted work immediately when the authenticated root mounts', async () => {
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(dataService.syncArtifactApp).toHaveBeenCalledWith(entry.request);
    expect(completeArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature);
    expect(mockInvalidateQueries).toHaveBeenCalled();
  });

  it('sends an already-resolved baseline unchanged, never re-deriving it at send time', async () => {
    // A baseline re-derived from the server right before sending would describe the current
    // state, not the state this (possibly older, still-queued) content was actually written
    // against — letting stale content pass the conflict check under a basis it never had.
    const entryWithConfirmedAbsence = {
      ...entry,
      request: { ...entry.request, basedOnVersionNumber: 0 },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithConfirmedAbsence])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithConfirmedAbsence);

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(mockFetchQuery).not.toHaveBeenCalled();
    expect(dataService.syncArtifactApp).toHaveBeenCalledWith(entryWithConfirmedAbsence.request);
  });

  it('resolves and locks in a baseline that failed to resolve at enqueue time, then sends with it', async () => {
    const entryWithoutBaseline = {
      ...entry,
      request: { ...entry.request, basedOnVersionNumber: undefined },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithoutBaseline])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithoutBaseline);
    mockFetchQuery.mockResolvedValueOnce({ app: { latestVersionNumber: 7 } });

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(recordArtifactSyncBaseline).toHaveBeenCalledWith(entry.id, entry.signature, 7);
    expect(dataService.syncArtifactApp).toHaveBeenCalledWith({
      ...entryWithoutBaseline.request,
      basedOnVersionNumber: 7,
    });
  });

  it('does not send a snapshot superseded while its baseline was resolving', async () => {
    const entryWithoutBaseline = {
      ...entry,
      request: { ...entry.request, basedOnVersionNumber: undefined },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithoutBaseline])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithoutBaseline);
    jest.mocked(recordArtifactSyncBaseline).mockResolvedValueOnce(false);
    mockFetchQuery.mockResolvedValueOnce({ app: { latestVersionNumber: 7 } });

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(recordArtifactSyncBaseline).toHaveBeenCalledWith(entry.id, entry.signature, 7);
    expect(dataService.syncArtifactApp).not.toHaveBeenCalled();
    expect(completeArtifactSync).not.toHaveBeenCalled();
  });

  it('locks in a confirmed-absence baseline of 0 when recovery finds no app exists (404)', async () => {
    const entryWithoutBaseline = {
      ...entry,
      request: { ...entry.request, basedOnVersionNumber: undefined },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithoutBaseline])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithoutBaseline);
    mockFetchQuery.mockRejectedValueOnce({ response: { status: 404 } });

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(recordArtifactSyncBaseline).toHaveBeenCalledWith(entry.id, entry.signature, 0);
    expect(dataService.syncArtifactApp).toHaveBeenCalledWith({
      ...entryWithoutBaseline.request,
      basedOnVersionNumber: 0,
    });
  });

  it('resolves the baseline from a legacy truncated key before migrating a long identity', async () => {
    const entryWithoutBaseline = {
      ...entry,
      request: {
        ...entry.request,
        basedOnVersionNumber: undefined,
        source: {
          ...entry.request.source,
          sourceKey: `${'x'.repeat(491)}:deadbeef`,
          legacySourceKey: `${'x'.repeat(491)}old-tail!`,
        },
      },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithoutBaseline])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithoutBaseline);
    mockFetchQuery
      .mockRejectedValueOnce({ response: { status: 404 } })
      .mockResolvedValueOnce({ app: { latestVersionNumber: 5 } });

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(recordArtifactSyncBaseline).toHaveBeenCalledWith(entry.id, entry.signature, 5);
    expect(dataService.syncArtifactApp).toHaveBeenCalledWith({
      ...entryWithoutBaseline.request,
      basedOnVersionNumber: 5,
    });
  });

  it('reschedules with backoff, without sending, when baseline recovery fails for a non-404 reason', async () => {
    const entryWithoutBaseline = {
      ...entry,
      request: { ...entry.request, basedOnVersionNumber: undefined },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entryWithoutBaseline])
      .mockResolvedValue([]);
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(entryWithoutBaseline);
    mockFetchQuery.mockRejectedValueOnce(new Error('network down'));

    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(dataService.syncArtifactApp).not.toHaveBeenCalled();
    expect(recordArtifactSyncBaseline).not.toHaveBeenCalled();
    expect(rescheduleArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature, 1000);
    expect(completeArtifactSync).not.toHaveBeenCalled();
  });

  it('skips a snapshot another tab already superseded or removed since the batch was read', async () => {
    jest.mocked(getCurrentArtifactSyncEntry).mockReturnValue(undefined);
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(dataService.syncArtifactApp).not.toHaveBeenCalled();
    expect(completeArtifactSync).not.toHaveBeenCalled();
    expect(rescheduleArtifactSync).not.toHaveBeenCalled();
  });

  it('keeps transient failures in the persistent queue with backoff', async () => {
    jest.mocked(dataService.syncArtifactApp).mockRejectedValueOnce(new Error('temporary'));
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(rescheduleArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature, 1000);
    expect(completeArtifactSync).not.toHaveBeenCalled();
  });

  it.each([401, 404])(
    'keeps HTTP %i failures queued for auth or rollout recovery',
    async (status) => {
      jest.mocked(dataService.syncArtifactApp).mockRejectedValueOnce({ response: { status } });
      render(<ArtifactSyncWorker />);
      await act(flushWorker);

      expect(rescheduleArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature, 1000);
      expect(completeArtifactSync).not.toHaveBeenCalled();
    },
  );

  it('discards a sync superseded by a newer edit instead of retrying stale content', async () => {
    jest.mocked(dataService.syncArtifactApp).mockRejectedValueOnce({ response: { status: 409 } });
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(completeArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature);
    expect(rescheduleArtifactSync).not.toHaveBeenCalled();
  });

  it('discards forbidden syncs that cannot succeed under the current role policy', async () => {
    jest.mocked(dataService.syncArtifactApp).mockRejectedValueOnce({ response: { status: 403 } });
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(completeArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature);
    expect(rescheduleArtifactSync).not.toHaveBeenCalled();
  });

  it('discards a queue entry only when the server confirms its source was deleted', async () => {
    jest.mocked(dataService.syncArtifactApp).mockRejectedValueOnce({ response: { status: 410 } });
    render(<ArtifactSyncWorker />);
    await act(flushWorker);

    expect(completeArtifactSync).toHaveBeenCalledWith(entry.id, entry.signature);
    expect(rescheduleArtifactSync).not.toHaveBeenCalled();
  });

  it('stops an active flush when the authenticated identity changes', async () => {
    let resolveFirst: (
      value: Awaited<ReturnType<typeof dataService.syncArtifactApp>>,
    ) => void = () => undefined;
    const firstRequest = new Promise<Awaited<ReturnType<typeof dataService.syncArtifactApp>>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const secondEntry = {
      ...entry,
      id: 'queue-2',
      signature: 'signature-2',
      request: {
        ...entry.request,
        source: { ...entry.request.source, sourceKey: 'artifact:v1:identifier:second' },
      },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entry, secondEntry])
      .mockResolvedValue([]);
    jest.mocked(dataService.syncArtifactApp).mockReset().mockReturnValueOnce(firstRequest);

    const { rerender } = render(<ArtifactSyncWorker />);
    await waitFor(() => expect(dataService.syncArtifactApp).toHaveBeenCalledTimes(1));

    mockUserId = 'user-2';
    rerender(<ArtifactSyncWorker />);
    resolveFirst({
      app: { artifactAppId: 'app-1' },
      version: { artifactVersionId: 'version-1' },
      created: true,
      versionCreated: true,
    } as Awaited<ReturnType<typeof dataService.syncArtifactApp>>);
    await act(flushWorker);

    expect(dataService.syncArtifactApp).toHaveBeenCalledTimes(1);
    expect(mockSetQueryData).not.toHaveBeenCalled();
    expect(completeArtifactSync).not.toHaveBeenCalled();
  });

  it('cancels an active flush when logout unmounts the worker', async () => {
    let resolveFirst: (
      value: Awaited<ReturnType<typeof dataService.syncArtifactApp>>,
    ) => void = () => undefined;
    const firstRequest = new Promise<Awaited<ReturnType<typeof dataService.syncArtifactApp>>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    const secondEntry = {
      ...entry,
      id: 'queue-2',
      signature: 'signature-2',
      request: {
        ...entry.request,
        source: { ...entry.request.source, sourceKey: 'artifact:v1:identifier:second' },
      },
    };
    jest
      .mocked(listArtifactSyncQueue)
      .mockReset()
      .mockResolvedValueOnce([entry, secondEntry])
      .mockResolvedValue([]);
    jest.mocked(dataService.syncArtifactApp).mockReset().mockReturnValueOnce(firstRequest);

    const mounted = render(<ArtifactSyncWorker />);
    await waitFor(() => expect(dataService.syncArtifactApp).toHaveBeenCalledTimes(1));
    mounted.unmount();

    mockUserId = 'user-2';
    render(<ArtifactSyncWorker />);
    resolveFirst({
      app: { artifactAppId: 'app-1' },
      version: { artifactVersionId: 'version-1' },
      created: true,
      versionCreated: true,
    } as Awaited<ReturnType<typeof dataService.syncArtifactApp>>);
    await act(flushWorker);

    expect(dataService.syncArtifactApp).toHaveBeenCalledTimes(1);
    expect(mockSetQueryData).not.toHaveBeenCalled();
    expect(completeArtifactSync).not.toHaveBeenCalled();
  });
});
