import { createElement } from 'react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { usePinConversationMutation } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService, pinConversation: jest.fn() } };
});

const pinConversation = dataService.pinConversation as jest.MockedFunction<
  typeof dataService.pinConversation
>;

describe('pin mutation and the open chat point cache', () => {
  it('writes the new pin state into an existing conversation point entry', async () => {
    const convo = {
      conversationId: 'convo-1',
      title: 'Hello',
      endpoint: 'openAI',
    } as TConversation;
    pinConversation.mockResolvedValue({ ...convo, pinned: true } as never);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.conversation, 'convo-1'], { ...convo, pinned: false });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const { result } = renderHook(() => usePinConversationMutation(), { wrapper });

    act(() => result.current.mutate({ conversationId: 'convo-1', pinned: true }));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(
      queryClient.getQueryData<TConversation>([QueryKeys.conversation, 'convo-1'])?.pinned,
    ).toBe(true);
  });
});
