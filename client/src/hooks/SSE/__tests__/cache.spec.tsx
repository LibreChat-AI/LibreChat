import { RecoilRoot, useSetRecoilState } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TConversation } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useResumableCache from '~/hooks/SSE/cache';
import store from '~/store';

const turn = (conversationId: string): TMessage[] => [
  {
    messageId: 'user-1',
    conversationId,
    parentMessageId: Constants.NO_PARENT,
    isCreatedByUser: true,
    text: 'E2E_SLOW_REPLY:streaming',
  } as TMessage,
  {
    messageId: 'reply-1',
    conversationId,
    parentMessageId: 'user-1',
    isCreatedByUser: false,
    text: 'chunk-000 chunk-001',
  } as TMessage,
];

const newChat = () => [QueryKeys.messages, Constants.NEW_CONVO];

/** The main pane's cache services, with the pane showing `shown` and a setter to move it. */
function setup(shown: string) {
  const queryClient = new QueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot
        initializeState={({ set }) =>
          set(store.conversationByIndex(0), { conversationId: shown } as TConversation)
        }
      >
        {children}
      </RecoilRoot>
    </QueryClientProvider>
  );
  const { result } = renderHook(
    () => ({
      cache: useResumableCache(() => undefined),
      show: useSetRecoilState(store.conversationByIndex(0)),
    }),
    { wrapper },
  );
  return { queryClient, result };
}

/** A first turn streamed from the new chat writes the same list under both keys. */
function seedFirstTurn(queryClient: QueryClient, conversationId: string): TMessage[] {
  const messages = turn(conversationId);
  queryClient.setQueryData([QueryKeys.messages, conversationId], messages);
  queryClient.setQueryData(newChat(), messages);
  return messages;
}

describe('useResumableCache releaseNewConversation', () => {
  it('takes a first turn the pane left out of the new chat before the reset has rendered', () => {
    const { queryClient, result } = setup('c-1');
    const messages = seedFirstTurn(queryClient, 'c-1');

    act(() => {
      result.current.show({ conversationId: Constants.NEW_CONVO } as TConversation);
      result.current.cache.releaseNewConversation('c-1');
    });

    expect(queryClient.getQueryData(newChat())).toEqual([]);
    expect(queryClient.getQueryData([QueryKeys.messages, 'c-1'])).toBe(messages);
  });

  it('keeps a first turn the pane still shows, as after a Stop the server never settled', () => {
    const { queryClient, result } = setup('c-1');
    const messages = seedFirstTurn(queryClient, 'c-1');

    result.current.cache.releaseNewConversation('c-1');

    expect(queryClient.getQueryData(newChat())).toBe(messages);
  });

  it('leaves the new chat alone when it holds another conversation', () => {
    const { queryClient, result } = setup(Constants.NEW_CONVO);
    const other = seedFirstTurn(queryClient, 'c-2');

    result.current.cache.releaseNewConversation('c-1');

    expect(queryClient.getQueryData(newChat())).toBe(other);
  });
});
