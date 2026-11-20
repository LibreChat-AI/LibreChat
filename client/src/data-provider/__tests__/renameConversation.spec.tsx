import { RecoilRoot } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider, isCancelledError } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useUpdateConversationMutation } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: { ...actual.dataService, updateConversation: jest.fn() },
  };
});

const updateConversation = dataService.updateConversation as jest.MockedFunction<
  typeof dataService.updateConversation
>;

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

describe('useUpdateConversationMutation', () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  /* A rename request carries only a title. Its response is a whole
   * conversation as it stood when the server handled it, so writing all of it
   * back would restore the pre-request value of every other field. */
  it('does not undo a project assignment that landed while the rename was in flight', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('c1'), { wrapper });

    /* The assignment has already been confirmed and cached. */
    activeQueryClient.setQueryData<TConversation>([QueryKeys.conversation, 'c1'], {
      conversationId: 'c1',
      title: 'Old title',
      chatProjectId: 'project-b',
    } as TConversation);

    /* The rename's response still shows the chat where it was beforehand. */
    updateConversation.mockResolvedValueOnce({
      conversationId: 'c1',
      title: 'New title',
      chatProjectId: null,
    } as TConversation);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c1', title: 'New title' });
    });

    const cached = activeQueryClient.getQueryData<TConversation>([QueryKeys.conversation, 'c1']);
    expect(cached?.title).toBe('New title');
    expect(cached?.chatProjectId).toBe('project-b');
  });

  it('writes the response through when nothing is cached yet', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('c2'), { wrapper });

    updateConversation.mockResolvedValueOnce({
      conversationId: 'c2',
      title: 'Fresh',
      chatProjectId: 'project-a',
    } as TConversation);

    await act(async () => {
      await result.current.mutateAsync({ conversationId: 'c2', title: 'Fresh' });
    });

    const cached = activeQueryClient.getQueryData<TConversation>([QueryKeys.conversation, 'c2']);
    expect(cached?.title).toBe('Fresh');
    expect(cached?.chatProjectId).toBe('project-a');
  });
  it.each([true, false])('fences a delayed point read (warm cache: %s)', async (warm) => {
    const { result } = renderHook(() => useUpdateConversationMutation('refreshing'), { wrapper });
    const key = [QueryKeys.conversation, 'refreshing'];
    const old = { conversationId: 'refreshing', title: 'Old' } as TConversation;
    if (warm) activeQueryClient.setQueryData(key, old);
    let release!: (value: TConversation) => void;
    const delayed = activeQueryClient
      .fetchQuery(
        key,
        () =>
          new Promise<TConversation>((resolve) => {
            release = resolve;
          }),
      )
      .catch((error) => isCancelledError(error));
    updateConversation.mockResolvedValueOnce({
      ...old,
      title: 'Renamed',
      titleSetByUser: true,
      titleRevision: 1,
    });
    await act(async () =>
      result.current.mutateAsync({ conversationId: 'refreshing', title: 'Renamed' }),
    );
    expect(await delayed).toBe(true);
    release(old);
    await act(async () => Promise.resolve());
    expect(activeQueryClient.getQueryData<TConversation>(key)).toEqual(
      expect.objectContaining({
        title: 'Renamed',
        titleSetByUser: true,
      }),
    );
  });
  it('does not publish ownership when the rename response is invalid', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('invalid-rename'), {
      wrapper,
    });
    const key = [QueryKeys.conversation, 'invalid-rename'];
    const old = { conversationId: 'invalid-rename', title: 'Old' } as TConversation;
    activeQueryClient.setQueryData(key, old);
    updateConversation.mockResolvedValueOnce({ ...old, title: null });
    await act(async () => {
      await expect(
        result.current.mutateAsync({ conversationId: 'invalid-rename', title: 'New' }),
      ).rejects.toThrow('Conversation rename did not return a title');
    });
    expect(activeQueryClient.getQueryData(key)).toEqual(old);
  });
  it('does not let an older rename response roll back a newer committed revision', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('revision-chat'), {
      wrapper,
    });
    const key = [QueryKeys.conversation, 'revision-chat'];
    const current = {
      conversationId: 'revision-chat',
      title: 'Newer rename',
      titleSetByUser: true,
      titleRevision: 3,
    } as TConversation;
    activeQueryClient.setQueryData(key, current);
    updateConversation.mockResolvedValueOnce({
      ...current,
      title: 'Older rename',
      titleRevision: 2,
    });
    await act(async () =>
      result.current.mutateAsync({ conversationId: 'revision-chat', title: 'Older rename' }),
    );
    expect(activeQueryClient.getQueryData(key)).toEqual(current);
  });
  it('accepts the first durable revision after a legacy rename response', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('rolling-chat'), { wrapper });
    const key = [QueryKeys.conversation, 'rolling-chat'];
    const base = { conversationId: 'rolling-chat', title: 'Old' } as TConversation;
    activeQueryClient.setQueryData(key, base);
    updateConversation.mockResolvedValueOnce({ ...base, title: 'Legacy rename' });
    await act(async () =>
      result.current.mutateAsync({ conversationId: 'rolling-chat', title: 'Legacy rename' }),
    );
    expect(activeQueryClient.getQueryData<TConversation>(key)?.titleRevision).toBeUndefined();
    expect(activeQueryClient.getQueryData<TConversation>(key)?.titleSetByUser).toBeUndefined();
    updateConversation.mockResolvedValueOnce({
      ...base,
      title: 'Upgraded rename',
      titleSetByUser: true,
      titleRevision: 1,
    });
    await act(async () =>
      result.current.mutateAsync({ conversationId: 'rolling-chat', title: 'Upgraded rename' }),
    );
    expect(activeQueryClient.getQueryData(key)).toEqual(
      expect.objectContaining({
        title: 'Upgraded rename',
        titleSetByUser: true,
        titleRevision: 1,
      }),
    );
  });
  it('does not invent ownership when a legacy replica omits its metadata', async () => {
    const { result } = renderHook(() => useUpdateConversationMutation('legacy-rename'), {
      wrapper,
    });
    const key = [QueryKeys.conversation, 'legacy-rename'];
    activeQueryClient.setQueryData(key, {
      conversationId: 'legacy-rename',
      title: 'Before',
      titleSetByUser: true,
      titleRevision: 1,
    });
    updateConversation.mockResolvedValueOnce({
      conversationId: 'legacy-rename',
      title: 'Legacy saved',
    } as TConversation);
    await act(async () =>
      result.current.mutateAsync({ conversationId: 'legacy-rename', title: 'Legacy saved' }),
    );
    expect(activeQueryClient.getQueryData(key)).toEqual(
      expect.objectContaining({
        title: 'Legacy saved',
        titleSetByUser: undefined,
        titleRevision: undefined,
      }),
    );
  });
});
