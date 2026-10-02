import { RecoilRoot } from 'recoil';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, dataService, setTokenHeader } from 'librechat-data-provider';
import type { TConversation, TSharedLinkGetResponse } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  findConvoInAllQueries,
  removeConvoFromAllQueries,
  updateConvoInAllQueries,
} from '~/utils/convos';
import { useUpdateConversationMutation, useArchiveAllConversationsMutation } from '../mutations';
import { useAssignConversationToProjectMutation } from '../Projects/mutations';
import { useRunningConversationsQuery } from '../queries';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: jest.fn(),
      getSharedLink: jest.fn(),
      assignConversationToProject: jest.fn(),
      archiveAllConversations: jest.fn(),
      updateConversation: jest.fn(),
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

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const notFound = () => Object.assign(new Error('Not found'), { status: 404 });

let queryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => (
  <RecoilRoot>
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  </RecoilRoot>
);

describe('useRunningConversationsQuery', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    getSharedLink.mockResolvedValue({ shareId: null, success: true } as TSharedLinkGetResponse);
  });

  afterEach(() => {
    queryClient.clear();
    setTokenHeader(undefined);
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
    expect(queryClient.getQueryData([QueryKeys.conversation, 'c1'])).toEqual({
      ...record(),
      isShared: true,
    });
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
  it('does not let an older poll overwrite a local update', async () => {
    const poll = deferred<TConversation>();
    getConversationById.mockResolvedValueOnce(record()).mockReturnValueOnce(poll.promise);
    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));
    const refetch = queryClient.refetchQueries([QueryKeys.runningConversation, 'c1']);
    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(2));

    act(() => updateConvoInAllQueries(queryClient, 'c1', (c) => ({ ...c, title: 'Renamed' })));
    await act(async () => {
      poll.resolve(record());
      await refetch;
    });
    await waitFor(() => expect(result.current[0]?.title).toBe('Renamed'));
  });

  it.each(['pending', 'missing'] as const)(
    'shows a renamed pin immediately with a %s Running row',
    async (state) => {
      const initial = deferred<TConversation>();
      const newerReply = '2026-01-03T00:00:00.000Z';
      queryClient.setQueryData([QueryKeys.pinnedConversations], {
        conversations: [record({ pinned: true, isShared: true })],
      });
      if (state === 'pending') {
        getConversationById.mockReturnValue(initial.promise);
      } else {
        getConversationById.mockRejectedValueOnce(notFound());
      }
      jest
        .mocked(dataService.updateConversation)
        .mockResolvedValue(record({ title: 'Renamed', pinned: true, lastResponseAt: newerReply }));
      const { result } = renderHook(
        () => ({
          rows: useRunningConversationsQuery(['c1']),
          rename: useUpdateConversationMutation('c1'),
        }),
        { wrapper },
      );
      await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(1));
      if (state === 'missing') {
        await waitFor(() =>
          expect(queryClient.getQueryData([QueryKeys.runningConversation, 'c1'])).toBeNull(),
        );
      }
      expect(result.current.rows).toEqual([]);

      await act(async () => {
        await result.current.rename.mutateAsync({ conversationId: 'c1', title: 'Renamed' });
      });
      await waitFor(() =>
        expect(result.current.rows[0]).toMatchObject({
          title: 'Renamed',
          pinned: true,
          isShared: true,
          lastResponseAt: newerReply,
        }),
      );
      expect(getConversationById).toHaveBeenCalledTimes(1);

      await act(async () => initial.resolve(record()));
      expect(result.current.rows[0]?.title).toBe('Renamed');
    },
  );

  it('restarts an interrupted initial fetch when no local row is available', async () => {
    const initial = deferred<TConversation>();
    getConversationById.mockReturnValueOnce(initial.promise).mockResolvedValue(record());
    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(1));

    act(() => updateConvoInAllQueries(queryClient, 'c1', (row) => ({ ...row, title: 'Changed' })));
    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current).toHaveLength(1));
    await act(async () => initial.resolve(record({ title: 'Stale' })));
    expect(result.current[0]?.title).not.toBe('Stale');
  });

  it('does not create a Running query just because an unrelated cached chat changes', () => {
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], record());
    updateConvoInAllQueries(queryClient, 'c1', (row) => ({ ...row, title: 'Changed' }));
    expect(queryClient.getQueryState([QueryKeys.runningConversation, 'c1'])).toBeUndefined();
  });

  it('preserves sidebar flags and read state when replacing a running row', async () => {
    const stamps = {
      lastResponseAt: '2026-01-02T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
    };
    getConversationById.mockResolvedValue(record({ pinned: true, ...stamps }));
    getSharedLink.mockResolvedValue({
      shareId: 'share-1',
      success: true,
    } as TSharedLinkGetResponse);
    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    act(() => updateConvoInAllQueries(queryClient, 'c1', () => record({ title: 'New title' })));
    await waitFor(() =>
      expect(result.current[0]).toMatchObject({
        title: 'New title',
        pinned: true,
        isShared: true,
        ...stamps,
      }),
    );
  });

  it('does not seed the navigation cache after its last observer leaves', async () => {
    const pending = deferred<TConversation>();
    getConversationById.mockReturnValue(pending.promise);
    const { unmount } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(getConversationById).toHaveBeenCalled());
    unmount();
    await act(async () => pending.resolve(record()));
    expect(queryClient.getQueryData([QueryKeys.conversation, 'c1'])).toBeUndefined();
  });

  it('drops a removed row without allowing an older poll to restore it', async () => {
    const poll = deferred<TConversation>();
    getConversationById.mockResolvedValueOnce(record()).mockReturnValueOnce(poll.promise);
    const { result } = renderHook(() => useRunningConversationsQuery(['c1']), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));
    const refetch = queryClient.refetchQueries([QueryKeys.runningConversation, 'c1']);
    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(2));

    act(() => removeConvoFromAllQueries(queryClient, 'c1'));
    await act(async () => {
      poll.resolve(record());
      await refetch;
    });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('uses the newest running row when reading cached reply state', () => {
    queryClient.setQueryData([QueryKeys.conversation, 'c1'], record());
    const running = record({ lastResponseAt: '2026-01-03T00:00:00.000Z' });
    queryClient.setQueryData([QueryKeys.runningConversation, 'c1'], running);
    expect(findConvoInAllQueries(queryClient, 'c1')?.lastResponseAt).toBe(running.lastResponseAt);
  });

  it('publishes a project assignment to the running row immediately', async () => {
    const claims = btoa(JSON.stringify({ id: 'user-a' })).replace(/=+$/, '');
    setTokenHeader(`header.${claims}.signature`);
    getConversationById.mockResolvedValue(record());
    jest.mocked(dataService.assignConversationToProject).mockResolvedValue({
      conversation: record({ chatProjectId: 'project-2' }),
      projectId: 'project-2',
      previousProjectId: 'project-1',
    });
    const { result } = renderHook(
      () => ({
        rows: useRunningConversationsQuery(['c1']),
        assignment: useAssignConversationToProjectMutation(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));
    getConversationById.mockResolvedValue(record({ chatProjectId: 'project-2' }));

    await act(async () => {
      await result.current.assignment.mutateAsync({ conversationId: 'c1', projectId: 'project-2' });
    });
    await waitFor(() => expect(result.current.rows[0]?.chatProjectId).toBe('project-2'));
  });

  it('refreshes running rows immediately after Archive All', async () => {
    getConversationById
      .mockResolvedValueOnce(record())
      .mockResolvedValue(record({ isArchived: true }));
    jest.mocked(dataService.archiveAllConversations).mockResolvedValue({ archivedCount: 1 });
    const { result } = renderHook(
      () => ({
        rows: useRunningConversationsQuery(['c1']),
        archive: useArchiveAllConversationsMutation(),
      }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.rows).toHaveLength(1));

    await act(async () => {
      await result.current.archive.mutateAsync();
    });
    await waitFor(() => expect(getConversationById).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.rows[0]?.isArchived).toBe(true));
  });
});
