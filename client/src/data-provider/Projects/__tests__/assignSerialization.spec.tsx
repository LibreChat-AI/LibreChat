import { RecoilRoot } from 'recoil';
import { renderHook, act, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { dataService, QueryKeys, setTokenHeader } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useAssignConversationToProjectMutation, getPendingAssignment } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, assignConversationToProject: jest.fn() },
  };
});

const assignConversationToProject = dataService.assignConversationToProject as jest.MockedFunction<
  typeof dataService.assignConversationToProject
>;

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const response = (conversationId: string, projectId: string | null) =>
  ({
    conversation: { conversationId, chatProjectId: projectId },
    projectId,
    previousProjectId: null,
  }) as never;

let activeQueryClient: QueryClient;

const wrapper = ({ children }: { children: ReactNode }) => {
  activeQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return (
    <RecoilRoot>
      <QueryClientProvider client={activeQueryClient}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
};

/** Assignments are attributed to the account whose credentials they will travel
 *  with, so the tests need a session installed. */
const signInAs = (userId: string) => {
  const claims = btoa(JSON.stringify({ id: userId })).replace(/=+$/, '');
  setTokenHeader(`header.${claims}.signature`);
};

describe('useAssignConversationToProjectMutation', () => {
  beforeEach(() => {
    /* Reset, not clear: clearing leaves an unconsumed `mockResolvedValueOnce`
     * queued, and the next test's first call would take the previous test's
     * leftover instead of its own. */
    jest.resetAllMocks();
    signInAs('user-a');
  });

  afterEach(() => {
    setTokenHeader(undefined);
  });

  /* The drag targets, the row menu and the project dialog each hold their own
   * instance of this hook. Serializing inside the mutation is what keeps two of
   * them from racing, whichever surface the user reached for. */
  it('serializes writes for one conversation across separate hook instances', async () => {
    const first = deferred<never>();
    assignConversationToProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(response('c-1', 'project-a'));

    const dragSurface = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });
    const menuSurface = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    await act(async () => {
      dragSurface.result.current.mutate({ conversationId: 'c-1', projectId: 'project-b' });
    });
    await act(async () => {
      menuSurface.result.current.mutate({ conversationId: 'c-1', projectId: 'project-a' });
    });

    /* The menu write must wait: arriving first would let the older drop land
     * afterwards and overwrite the destination the user asked for last. */
    expect(assignConversationToProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      first.resolve(response('c-1', 'project-b') as never);
    });

    await waitFor(() => expect(assignConversationToProject).toHaveBeenCalledTimes(2));
    expect(assignConversationToProject.mock.calls[0][0]).toMatchObject({ projectId: 'project-b' });
    expect(assignConversationToProject.mock.calls[1][0]).toMatchObject({ projectId: 'project-a' });
  });
  it('invalidates archived conversation list variants after assignment', async () => {
    const archivedKey = [QueryKeys.archivedConversations, { isArchived: true }];
    assignConversationToProject.mockResolvedValue(response('c-archived', 'project-b'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });
    activeQueryClient.setQueryData(archivedKey, {
      pages: [{ conversations: [{ conversationId: 'c-archived', isArchived: true }] }],
      pageParams: [undefined],
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c-archived', projectId: 'project-b' });
    });

    expect(activeQueryClient.getQueryState(archivedKey)?.isInvalidated).toBe(true);
  });

  it('leaves different conversations independent', async () => {
    const held = deferred<never>();
    assignConversationToProject
      .mockReturnValueOnce(held.promise)
      .mockResolvedValueOnce(response('c2', 'project-a'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ conversationId: 'c-2', projectId: 'project-b' });
    });
    await act(async () => {
      result.current.mutate({ conversationId: 'c-2b', projectId: 'project-a' });
    });

    expect(assignConversationToProject).toHaveBeenCalledTimes(2);

    await act(async () => {
      held.resolve(response('c-2', 'project-b') as never);
    });
  });

  /* Navigation invalidates this exact conversation, so a refetch that read the
   * old project can be in flight when the assignment confirms. Everything now
   * reads a conversation's project from this cache, so an older fetch landing
   * after the write would quietly revert the move. */
  it('cancels an in-flight conversation refetch before writing the result', async () => {
    assignConversationToProject.mockResolvedValueOnce(response('c-3', 'project-b'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });
    const cancelQueries = jest.spyOn(activeQueryClient, 'cancelQueries');

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c-3', projectId: 'project-b' });
    });

    expect(cancelQueries).toHaveBeenCalledWith([QueryKeys.conversation, 'c-3']);
    expect(
      activeQueryClient.getQueryData<{ chatProjectId: string | null }>([
        QueryKeys.conversation,
        'c-3',
      ])?.chatProjectId,
    ).toBe('project-b');
  });

  /* Between the request settling and the cache write there must be no moment
   * where neither the pending entry nor the cache names the new project, or a
   * drag started right then reads the stale row and refuses a valid drop. */
  it('writes the conversation cache before releasing the pending destination', async () => {
    let cachedDuringSettle: unknown = 'not-read';
    assignConversationToProject.mockResolvedValueOnce(response('c-4', 'project-b'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    /* Observe the cache at the moment the cancellation resolves, which is the
     * last point before the write. */
    const cancelQueries = jest
      .spyOn(activeQueryClient, 'cancelQueries')
      .mockImplementation(async () => undefined);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c-4', projectId: 'project-b' });
    });

    cachedDuringSettle = activeQueryClient.getQueryData<{ chatProjectId: string | null }>([
      QueryKeys.conversation,
      'c-4',
    ])?.chatProjectId;

    expect(cancelQueries).toHaveBeenCalledWith([QueryKeys.conversation, 'c-4']);
    expect(cachedDuringSettle).toBe('project-b');
    cancelQueries.mockRestore();
  });

  /* Conversation ids are per-user, so a queued assignment must not travel with
   * the next account's credentials and act on whatever that id names there. */
  it('abandons a queued assignment when the session turns over', async () => {
    const first = deferred<never>();
    assignConversationToProject
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(response('c-5', 'project-a'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ conversationId: 'c-5', projectId: 'project-b' });
    });
    let queued!: Promise<unknown>;
    await act(async () => {
      queued = result.current
        .mutateAsync({ conversationId: 'c-5', projectId: 'project-a' })
        .catch(() => 'abandoned');
      await Promise.resolve();
      await Promise.resolve();
    });

    setTokenHeader(undefined);

    await act(async () => {
      first.resolve(response('c-5', 'project-b') as never);
      await expect(queued).resolves.toBe('abandoned');
    });

    expect(assignConversationToProject).toHaveBeenCalledTimes(1);
  });

  /* An abandoned write still has to give its pending entry back. Kept, it would
   * describe a destination that was never sent, and `useEffectiveProjectId`
   * would read it the next time this account signed in and refuse a drop there
   * as a no-op. */
  it('releases the pending destination when a queued assignment is abandoned', async () => {
    const first = deferred<never>();
    assignConversationToProject.mockReturnValueOnce(first.promise);

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    await act(async () => {
      result.current.mutate({ conversationId: 'c-6', projectId: 'project-b' });
    });
    let queued!: Promise<unknown>;
    await act(async () => {
      queued = result.current
        .mutateAsync({ conversationId: 'c-6', projectId: 'project-c' })
        .catch(() => 'abandoned');
      await Promise.resolve();
      await Promise.resolve();
    });

    signInAs('user-b');

    await act(async () => {
      first.resolve(response('c-6', 'project-b') as never);
      await expect(queued).resolves.toBe('abandoned');
    });

    signInAs('user-a');
    expect(getPendingAssignment('c-6')).toBeUndefined();
  });

  /* An assignment can reach the database before a concurrent rename and still
   * answer after it, and the conversation it carries predates that rename.
   * Replacing the cached document with it would put the old title back. */
  it('merges the project into the cached conversation without restoring stale fields', async () => {
    assignConversationToProject.mockResolvedValueOnce({
      conversation: { conversationId: 'c-8', chatProjectId: 'project-b', title: 'Old Title' },
      projectId: 'project-b',
      previousProjectId: null,
    } as never);

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    activeQueryClient.setQueryData([QueryKeys.conversation, 'c-8'], {
      conversationId: 'c-8',
      title: 'Renamed While Assigning',
      chatProjectId: null,
    });

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c-8', projectId: 'project-b' });
    });

    expect(
      activeQueryClient.getQueryData<{ title: string; chatProjectId: string | null }>([
        QueryKeys.conversation,
        'c-8',
      ]),
    ).toMatchObject({ title: 'Renamed While Assigning', chatProjectId: 'project-b' });
  });

  /* Cancelling waits on whatever fetch is already running, so the session can
   * turn over inside that await. The write on the far side of it would then
   * install one account's conversation in the next account's cache and report
   * success for it. */
  it('abandons the write when the session turns over while cancelling', async () => {
    assignConversationToProject.mockResolvedValueOnce(response('c-7', 'project-b'));

    const { result } = renderHook(() => useAssignConversationToProjectMutation(), { wrapper });

    const cancellation = deferred<undefined>();
    const cancelQueries = jest
      .spyOn(activeQueryClient, 'cancelQueries')
      .mockImplementation(() => cancellation.promise as Promise<void>);

    let settled!: Promise<unknown>;
    await act(async () => {
      settled = result.current
        .mutateAsync({ conversationId: 'c-7', projectId: 'project-b' })
        .catch(() => 'abandoned');
      await waitFor(() => expect(cancelQueries).toHaveBeenCalled());
    });

    signInAs('user-b');

    await act(async () => {
      cancellation.resolve(undefined);
      await expect(settled).resolves.toBe('abandoned');
    });

    expect(activeQueryClient.getQueryData([QueryKeys.conversation, 'c-7'])).toBeUndefined();
    cancelQueries.mockRestore();
  });
});
