import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, type MutableSnapshot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { QueryKeys, type TConversation, type TMessage } from 'librechat-data-provider';
import {
  useLatestMessage,
  useLatestMessageId,
  useLatestMessageMeta,
  useGetLatestMessage,
} from '~/hooks/Messages/useLatestMessage';
import { getBranchSiblingIndexesForTarget, getMessageBranchSiblingParentIds } from '~/utils';
import { siblingIdxFamily, siblingKey } from '~/components/Chat/Messages/Thread/state';
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

function createWrapper(
  queryClient = createQueryClient(),
  initializeState?: (snapshot: MutableSnapshot) => void,
  initialEntry = '/c/conversation-1',
  jotaiStore = createStore(),
) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <JotaiProvider store={jotaiStore}>
          <RecoilRoot initializeState={initializeState}>
            <MemoryRouter initialEntries={[initialEntry]}>
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

describe('useLatestMessage', () => {
  it('returns null when there is no active conversation', () => {
    const { result } = renderHook(() => useLatestMessage(0), {
      wrapper: createWrapper(),
    });

    expect(result.current).toBeNull();
  });

  it('returns the tail message from the active conversation cache', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, assistantMessage],
    );

    const { result } = renderHook(() => useLatestMessage(0), {
      wrapper: createWrapper(queryClient, ({ set }) => {
        set(store.conversationByIndex(0), conversation);
      }),
    });

    expect(result.current).toEqual(
      expect.objectContaining({
        messageId: assistantMessage.messageId,
        depth: 1,
      }),
    );
  });

  it('uses the new-conversation route cache while the conversation atom has the server id', () => {
    const queryClient = createQueryClient();
    const serverConversation = {
      ...conversation,
      conversationId: 'server-conversation',
    } as TConversation;
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, 'new'],
      [
        {
          ...userMessage,
          conversationId: serverConversation.conversationId,
        },
        {
          ...assistantMessage,
          conversationId: serverConversation.conversationId,
        },
      ],
    );

    const { result } = renderHook(() => useLatestMessage(0), {
      wrapper: createWrapper(
        queryClient,
        ({ set }) => {
          set(store.conversationByIndex(0), serverConversation);
        },
        '/c/new',
      ),
    });

    expect(result.current).toEqual(
      expect.objectContaining({
        messageId: assistantMessage.messageId,
        conversationId: serverConversation.conversationId,
      }),
    );
  });

  it('returns the active branch tail when sibling selection points at an older branch', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [
        userMessage,
        olderAssistantMessage,
        olderFollowUpUserMessage,
        olderFollowUpAssistantMessage,
        assistantMessage,
      ],
    );

    const jotaiStore = createStore();
    jotaiStore.set(siblingIdxFamily(siblingKey(userMessage.messageId)), 1);
    const { result } = renderHook(() => useLatestMessage(0), {
      wrapper: createWrapper(
        queryClient,
        ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        },
        undefined,
        jotaiStore,
      ),
    });

    expect(result.current).toEqual(
      expect.objectContaining({
        messageId: olderFollowUpAssistantMessage.messageId,
        depth: 3,
      }),
    );
  });

  it('falls back to the latest sibling when a stored sibling index is out of range', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [
        userMessage,
        olderAssistantMessage,
        olderFollowUpUserMessage,
        olderFollowUpAssistantMessage,
        assistantMessage,
      ],
    );

    const jotaiStore = createStore();
    jotaiStore.set(siblingIdxFamily(siblingKey(userMessage.messageId)), 99);
    const { result } = renderHook(() => useLatestMessage(0), {
      wrapper: createWrapper(
        queryClient,
        ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        },
        undefined,
        jotaiStore,
      ),
    });

    expect(result.current).toEqual(
      expect.objectContaining({
        messageId: assistantMessage.messageId,
        depth: 1,
      }),
    );
  });

  it('keeps latestMessageId stable across token-only cache writes', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, assistantMessage],
    );
    let renderCount = 0;

    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useLatestMessageId(0);
      },
      {
        wrapper: createWrapper(queryClient, ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        }),
      },
    );

    const firstId = result.current;

    act(() => {
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversation.conversationId],
        [userMessage, { ...assistantMessage, text: 'Hi there, still streaming' }],
      );
    });

    expect(result.current).toBe(firstId);
    expect(renderCount).toBe(1);
  });
});

describe('useLatestMessageMeta', () => {
  it('projects only messageId, error, and isCreatedByUser for the branch tail', () => {
    const queryClient = createQueryClient();
    const erroredAssistant = { ...assistantMessage, error: true } as TMessage;
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, erroredAssistant],
    );

    const { result } = renderHook(() => useLatestMessageMeta(0), {
      wrapper: createWrapper(queryClient, ({ set }) => {
        set(store.conversationByIndex(0), conversation);
      }),
    });

    expect(result.current).toEqual({
      messageId: assistantMessage.messageId,
      error: true,
      isCreatedByUser: false,
    });
  });

  it('returns null when there is no active conversation', () => {
    const { result } = renderHook(() => useLatestMessageMeta(0), {
      wrapper: createWrapper(),
    });

    expect(result.current).toBeNull();
  });

  it('stays referentially stable and does not re-render across token-only cache writes', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, assistantMessage],
    );
    let renderCount = 0;

    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useLatestMessageMeta(0);
      },
      {
        wrapper: createWrapper(queryClient, ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        }),
      },
    );

    const firstMeta = result.current;
    expect(firstMeta).toEqual({
      messageId: assistantMessage.messageId,
      error: undefined,
      isCreatedByUser: false,
    });

    act(() => {
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversation.conversationId],
        [userMessage, { ...assistantMessage, text: 'Hi there, still streaming' }],
      );
    });

    expect(result.current).toBe(firstMeta);
    expect(renderCount).toBe(1);
  });
});

describe('useGetLatestMessage', () => {
  it('reads the current branch tail at call time', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, assistantMessage],
    );

    const { result } = renderHook(() => useGetLatestMessage(0), {
      wrapper: createWrapper(queryClient, ({ set }) => {
        set(store.conversationByIndex(0), conversation);
      }),
    });

    expect(result.current()).toEqual(
      expect.objectContaining({ messageId: assistantMessage.messageId }),
    );
  });

  it('keeps a stable callback and reads fresh data without re-rendering across token writes', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [userMessage, assistantMessage],
    );
    let renderCount = 0;

    const { result } = renderHook(
      () => {
        renderCount += 1;
        return useGetLatestMessage(0);
      },
      {
        wrapper: createWrapper(queryClient, ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        }),
      },
    );

    const reader = result.current;

    act(() => {
      queryClient.setQueryData<TMessage[]>(
        [QueryKeys.messages, conversation.conversationId],
        [userMessage, { ...assistantMessage, text: 'Streamed tail' }],
      );
    });

    /** Call-time reader has no cache subscription: no re-render, stable identity... */
    expect(renderCount).toBe(1);
    expect(result.current).toBe(reader);
    /** ...yet invoking it returns the freshly-written tail. */
    expect(result.current()).toEqual(
      expect.objectContaining({ messageId: assistantMessage.messageId, text: 'Streamed tail' }),
    );
  });

  it('resolves the active branch tail from the Recoil sibling snapshot', () => {
    const queryClient = createQueryClient();
    queryClient.setQueryData<TMessage[]>(
      [QueryKeys.messages, conversation.conversationId],
      [
        userMessage,
        olderAssistantMessage,
        olderFollowUpUserMessage,
        olderFollowUpAssistantMessage,
        assistantMessage,
      ],
    );

    const jotaiStore = createStore();
    jotaiStore.set(siblingIdxFamily(siblingKey(userMessage.messageId)), 1);
    const { result } = renderHook(() => useGetLatestMessage(0), {
      wrapper: createWrapper(
        queryClient,
        ({ set }) => {
          set(store.conversationByIndex(0), conversation);
        },
        undefined,
        jotaiStore,
      ),
    });

    expect(result.current()).toEqual(
      expect.objectContaining({ messageId: olderFollowUpAssistantMessage.messageId }),
    );
  });

  it('returns null when there is no active conversation', () => {
    const { result } = renderHook(() => useGetLatestMessage(0), {
      wrapper: createWrapper(),
    });

    expect(result.current()).toBeNull();
  });
});

describe('getMessageBranchSiblingParentIds', () => {
  it('returns only parent keys that have branch choices', () => {
    expect(
      getMessageBranchSiblingParentIds(
        [
          userMessage,
          olderAssistantMessage,
          olderFollowUpUserMessage,
          olderFollowUpAssistantMessage,
          assistantMessage,
        ],
        conversation.conversationId,
      ),
    ).toEqual([userMessage.messageId]);
  });
});

describe('getBranchSiblingIndexesForTarget', () => {
  it('returns sibling indexes that select the branch containing the target message', () => {
    expect(
      getBranchSiblingIndexesForTarget(
        [
          userMessage,
          olderAssistantMessage,
          olderFollowUpUserMessage,
          olderFollowUpAssistantMessage,
          assistantMessage,
        ],
        olderFollowUpAssistantMessage.messageId,
        conversation.conversationId,
      ),
    ).toEqual([
      {
        parentMessageId: userMessage.messageId,
        siblingIdx: 1,
      },
    ]);
  });
});

describe('rendered root branch ownership', () => {
  it.each(['routed', 'override', 'promoted'] as const)(
    'uses the rendered root selection for all tail readers during %s navigation',
    (mode) => {
      const queryClient = createQueryClient();
      const jotaiStore = createStore();
      const owner = mode === 'promoted' ? 'server-conversation' : 'destination';
      const queryId = mode === 'promoted' ? 'new' : owner;
      const messages = [
        { ...userMessage, messageId: 'older-root', conversationId: owner, parentMessageId: null },
        {
          ...assistantMessage,
          messageId: 'older-tail',
          conversationId: owner,
          parentMessageId: 'older-root',
        },
        { ...userMessage, messageId: 'newer-root', conversationId: owner, parentMessageId: null },
      ];
      queryClient.setQueryData([QueryKeys.messages, queryId], messages);
      jotaiStore.set(siblingIdxFamily(owner), 1);
      const override = mode === 'override' ? queryId : undefined;
      const { result } = renderHook(
        () => ({
          message: useLatestMessage(0, override),
          id: useLatestMessageId(0, override),
          meta: useLatestMessageMeta(0, override),
          read: useGetLatestMessage(0, override),
        }),
        {
          wrapper: createWrapper(
            queryClient,
            ({ set }) => set(store.conversationByIndex(0), conversation),
            mode === 'override' ? '/c/source' : `/c/${queryId}`,
            jotaiStore,
          ),
        },
      );

      expect(result.current.message?.messageId).toBe('older-tail');
      expect(result.current.id).toBe('older-tail');
      expect(result.current.meta?.messageId).toBe('older-tail');
      expect(result.current.read()?.messageId).toBe('older-tail');
    },
  );
});

describe('deep conversation branches', () => {
  const messages = Array.from({ length: 12_000 }, (_, index) => ({
    ...userMessage,
    messageId: `deep-${index}`,
    parentMessageId: index === 0 ? null : `deep-${index - 1}`,
  }));
  const olderTail = {
    ...assistantMessage,
    messageId: 'older-tail',
    parentMessageId: 'deep-11999',
  };
  const newerTail = { ...olderTail, messageId: 'newer-tail' };
  const branched = [...messages, olderTail, newerTail];

  it('collects deep branch parents without using the JavaScript call stack', () => {
    expect(getMessageBranchSiblingParentIds(branched, 'deep')).toEqual(['deep-11999']);
    expect(getMessageBranchSiblingParentIds([userMessage, assistantMessage], 'small')).toEqual([]);
  });

  it('restores deep older branches and handles a missing target without overflowing', () => {
    expect(getBranchSiblingIndexesForTarget(branched, 'older-tail', 'deep')).toEqual([
      { parentMessageId: 'deep-11999', siblingIdx: 1 },
    ]);
    expect(getBranchSiblingIndexesForTarget(branched, 'missing', 'deep')).toEqual([]);
  });

  it('stops at an ancestor target without descending through its entire history', () => {
    expect(getBranchSiblingIndexesForTarget(branched, 'deep-0', 'deep')).toEqual([]);
  });

  it('discards branch choices from an unrelated subtree', () => {
    const roots = [
      { ...userMessage, messageId: 'root-old', parentMessageId: null },
      { ...assistantMessage, messageId: 'old-first', parentMessageId: 'root-old' },
      { ...assistantMessage, messageId: 'old-second', parentMessageId: 'root-old' },
      { ...userMessage, messageId: 'root-new', parentMessageId: null },
      { ...assistantMessage, messageId: 'new-first', parentMessageId: 'root-new' },
      { ...assistantMessage, messageId: 'new-second', parentMessageId: 'root-new' },
    ];
    expect(getMessageBranchSiblingParentIds(roots, 'roots')).toEqual([
      'roots',
      'root-old',
      'root-new',
    ]);
    expect(getBranchSiblingIndexesForTarget(roots, 'new-first', 'roots')).toEqual([
      { parentMessageId: 'roots', siblingIdx: 0 },
      { parentMessageId: 'root-new', siblingIdx: 1 },
    ]);
  });
});
