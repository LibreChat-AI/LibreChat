import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, type TConversation, type TMessage } from 'librechat-data-provider';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
import { getBranchTargetStorageKey } from '~/utils/branch';
import useBranchOnLoad from '../useBranchOnLoad';
import store from '~/store';

function createQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

const userMessage = {
  messageId: 'user-message',
  parentMessageId: '00000000-0000-0000-0000-000000000000',
  conversationId: conversation.conversationId,
  text: 'Hello',
  isCreatedByUser: true,
} as TMessage;

const assistantMessage = {
  messageId: 'assistant-message',
  parentMessageId: userMessage.messageId,
  conversationId: conversation.conversationId,
  text: 'Hi there',
  isCreatedByUser: false,
} as TMessage;

const olderAssistantMessage = {
  ...assistantMessage,
  messageId: 'assistant-older',
  text: 'Older branch',
} as TMessage;

const olderFollowUpUserMessage = {
  ...userMessage,
  messageId: 'user-older-follow-up',
  parentMessageId: olderAssistantMessage.messageId,
  text: 'Follow up on older branch',
} as TMessage;

const olderFollowUpAssistantMessage = {
  ...assistantMessage,
  messageId: 'assistant-older-follow-up',
  parentMessageId: olderFollowUpUserMessage.messageId,
  text: 'Older branch tail',
} as TMessage;

const branchedMessages = [
  userMessage,
  olderAssistantMessage,
  olderFollowUpUserMessage,
  olderFollowUpAssistantMessage,
  assistantMessage,
];

function createWrapper(
  queryClient: QueryClient,
  jotaiStore: ReturnType<typeof createStore>,
  initializeState?: (snapshot: MutableSnapshot) => void,
) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={jotaiStore}>
          <RecoilRoot initializeState={initializeState}>
            <MemoryRouter initialEntries={[`/c/${conversation.conversationId}`]}>
              <Routes>
                <Route path="/c/:conversationId?" element={children} />
              </Routes>
            </MemoryRouter>
          </RecoilRoot>
        </JotaiProvider>
      </QueryClientProvider>
    );
  };
}

describe('useBranchOnLoad', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('restores sibling indexes for a persisted branch target on load', () => {
    localStorage.setItem(
      getBranchTargetStorageKey(conversation.conversationId ?? ''),
      olderFollowUpAssistantMessage.messageId,
    );
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      branchedMessages,
    );
    const jotaiStore = createStore();

    renderHook(
      () => useBranchOnLoad(conversation.conversationId, () => branchedMessages, 0, true),
      {
        wrapper: createWrapper(queryClient, jotaiStore, ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        }),
      },
    );

    expect(jotaiStore.get(siblingIdxFamily(siblingKey(userMessage.messageId)))).toBe(1);
  });

  it('persists the viewed tail when sibling selection changes', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      branchedMessages,
    );
    const jotaiStore = createStore();

    const { rerender } = renderHook(
      () => useBranchOnLoad(conversation.conversationId, () => branchedMessages, 0, true),
      {
        wrapper: createWrapper(queryClient, jotaiStore, ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        }),
      },
    );

    act(() => {
      jotaiStore.set(siblingIdxFamily(siblingKey(userMessage.messageId)), 1);
    });
    rerender();

    expect(localStorage.getItem(getBranchTargetStorageKey(conversation.conversationId ?? ''))).toBe(
      olderFollowUpAssistantMessage.messageId,
    );
  });
});
