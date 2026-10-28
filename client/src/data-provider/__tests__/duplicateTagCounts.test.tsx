import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { dataService, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TConversationTag } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { useDuplicateConversationMutation } from '../mutations';

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      duplicateConversation: jest.fn(),
    },
  };
});

const duplicateConversation = dataService.duplicateConversation as jest.MockedFunction<
  typeof dataService.duplicateConversation
>;

const createWrapper = (queryClient: QueryClient) =>
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };

const tagCount = (queryClient: QueryClient) =>
  queryClient.getQueryData<TConversationTag[]>([QueryKeys.conversationTags])?.[0]?.count;

async function duplicateWith(conversation: Partial<TConversation>): Promise<QueryClient> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient.setQueryData<TConversationTag[]>(
    [QueryKeys.conversationTags],
    [{ tag: 'work', count: 1 } as TConversationTag],
  );
  duplicateConversation.mockResolvedValue({
    conversation: { conversationId: 'copy-1', tags: ['work'], ...conversation } as TConversation,
    messages: [],
  });

  const { result } = renderHook(() => useDuplicateConversationMutation(), {
    wrapper: createWrapper(queryClient),
  });
  await act(async () => {
    await result.current.mutateAsync({ conversationId: 'source-1' });
  });
  return queryClient;
}

describe('duplicate tag counts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('counts the tags of a copy that stays in history', async () => {
    const queryClient = await duplicateWith({ isTemporary: false });

    expect(tagCount(queryClient)).toBe(2);
  });

  it('adds no count for a copy that retention keeps hidden', async () => {
    const queryClient = await duplicateWith({ isTemporary: true });

    expect(tagCount(queryClient)).toBe(1);
  });
});
