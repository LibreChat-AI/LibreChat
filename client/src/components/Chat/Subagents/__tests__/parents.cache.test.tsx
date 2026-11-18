import React from 'react';
import { act, render, waitFor } from '@testing-library/react';
import { QueryKeys, dataService } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ParentSubagentsProvider, useParentSubagents } from '@librechat/chat/react';
import type { ParentSubagentIndex, ParentSubagentSummary } from 'librechat-data-provider';
import { SubagentIndexHostProvider } from 'test/streamHost';

jest.mock('librechat-data-provider', () => {
  const actual =
    jest.requireActual<typeof import('librechat-data-provider')>('librechat-data-provider');
  return { ...actual, dataService: { ...actual.dataService } };
});

const child = (latestTaskId: string): ParentSubagentSummary => ({
  threadId: 'thread-1',
  parentMessageId: 'parent-message',
  subagentType: 'agent-1',
  subagentKind: 'agent',
  title: 'Child',
  origin: 'event',
  actorId: 'actor-a',
  status: 'completed',
  latestTaskId,
  tasks: [{ taskId: latestTaskId, status: 'completed' }],
  tasksTruncated: false,
});

const index = (latestTaskId: string): ParentSubagentIndex => ({
  parentConversationId: 'parent-conversation',
  children: [child(latestTaskId)],
  childrenTruncated: false,
});

describe('ParentSubagentsProvider on the app query cache', () => {
  afterEach(() => jest.restoreAllMocks());

  it('refetches when the app invalidates the parent subagent key, as the stream handlers do', async () => {
    const getParentSubagents = jest
      .spyOn(dataService, 'getParentSubagents')
      .mockResolvedValueOnce(index('task-1'))
      .mockResolvedValueOnce(index('task-2'));
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let context: ReturnType<typeof useParentSubagents> | undefined;
    const Probe = () => {
      context = useParentSubagents();
      return null;
    };
    render(
      <QueryClientProvider client={queryClient}>
        <SubagentIndexHostProvider>
          <ParentSubagentsProvider conversationId="parent-conversation" enabled>
            <Probe />
          </ParentSubagentsProvider>
        </SubagentIndexHostProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(context?.byThreadId.get('thread-1')?.latestTaskId).toBe('task-1'));
    expect(getParentSubagents).toHaveBeenCalledTimes(1);

    await act(async () => {
      await queryClient.invalidateQueries([QueryKeys.parentSubagents, 'parent-conversation']);
    });

    await waitFor(() => expect(context?.byThreadId.get('thread-1')?.latestTaskId).toBe('task-2'));
    expect(getParentSubagents).toHaveBeenCalledTimes(2);
    expect(getParentSubagents).toHaveBeenLastCalledWith('parent-conversation');
  });

  it('reads an index the app wrote into the cache without fetching it again', async () => {
    const getParentSubagents = jest.spyOn(dataService, 'getParentSubagents');
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.parentSubagents, 'parent-conversation'], index('task-9'));
    let context: ReturnType<typeof useParentSubagents> | undefined;
    const Probe = () => {
      context = useParentSubagents();
      return null;
    };
    render(
      <QueryClientProvider client={queryClient}>
        <SubagentIndexHostProvider>
          <ParentSubagentsProvider conversationId="parent-conversation" enabled>
            <Probe />
          </ParentSubagentsProvider>
        </SubagentIndexHostProvider>
      </QueryClientProvider>,
    );

    expect(context?.byThreadId.get('thread-1')?.latestTaskId).toBe('task-9');
    expect(getParentSubagents).not.toHaveBeenCalled();
  });
});
