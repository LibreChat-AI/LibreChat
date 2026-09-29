import { RecoilRoot } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
});
