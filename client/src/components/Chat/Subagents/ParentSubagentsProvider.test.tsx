import React from 'react';
import { QueryKeys } from 'librechat-data-provider';
import { act, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ParentSubagentIndex, ParentSubagentSummary } from 'librechat-data-provider';
import { ParentSubagentsProvider, useParentSubagents } from './ParentSubagentsProvider';

const mockUseParentSubagentsQuery = jest.fn();

const renderProvider = (element: React.ReactElement, client = new QueryClient()) =>
  render(element, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });

jest.mock('~/data-provider', () => ({
  useParentSubagentsQuery: (...args: unknown[]) => mockUseParentSubagentsQuery(...args),
}));

const eventChild: ParentSubagentSummary = {
  threadId: 'event-thread',
  parentMessageId: 'parent-message',
  subagentType: 'agent-1',
  subagentKind: 'agent',
  title: 'Event child',
  origin: 'event',
  actorId: 'actor-a',
  status: 'completed',
  latestTaskId: 'task-1',
  tasks: [{ taskId: 'task-1', status: 'completed' }],
  tasksTruncated: false,
};
const toolChild: ParentSubagentSummary = {
  ...eventChild,
  threadId: 'tool-thread',
  parentToolCallId: 'tool-call',
  origin: 'tool',
  actorId: undefined,
};

describe('ParentSubagentsProvider', () => {
  it('reconstructs event groups from one durable conversation query and refreshes that index', async () => {
    const refreshed: ParentSubagentIndex = {
      parentConversationId: 'parent-conversation',
      children: [{ ...eventChild, latestTaskId: 'task-2' }],
      childrenTruncated: false,
    };
    const refetch = jest.fn().mockResolvedValue({ data: refreshed });
    mockUseParentSubagentsQuery.mockReturnValue({
      data: {
        parentConversationId: 'parent-conversation',
        children: [eventChild, toolChild],
        childrenTruncated: false,
      },
      refetch,
    });
    let context: ReturnType<typeof useParentSubagents> | undefined;
    const Probe = () => {
      context = useParentSubagents();
      return null;
    };

    renderProvider(
      <ParentSubagentsProvider conversationId="parent-conversation" enabled>
        <Probe />
      </ParentSubagentsProvider>,
    );

    expect(mockUseParentSubagentsQuery).toHaveBeenCalledWith(
      'parent-conversation',
      { enabled: true },
      false,
    );
    expect(context?.byMessageId.get('parent-message')).toEqual([eventChild]);
    expect(context?.byThreadId.get('tool-thread')).toEqual(toolChild);
    let result: ParentSubagentIndex | undefined;
    await act(async () => {
      result = await context?.refresh();
    });
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual(refreshed);
  });

  it('marks an active parent run for prompt discovery', () => {
    mockUseParentSubagentsQuery.mockReturnValue({ data: undefined, refetch: jest.fn() });
    renderProvider(
      <ParentSubagentsProvider conversationId="parent-conversation" enabled isSubmitting>
        <div />
      </ParentSubagentsProvider>,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenCalledWith(
      'parent-conversation',
      { enabled: true },
      true,
    );
  });

  it('retains discovery on endpoint switches but resets for a different conversation', () => {
    mockUseParentSubagentsQuery.mockReturnValue({ data: undefined, refetch: jest.fn() });
    const { rerender } = renderProvider(
      <ParentSubagentsProvider conversationId="agent-chat" enabled>
        <div />
      </ParentSubagentsProvider>,
    );
    rerender(
      <ParentSubagentsProvider conversationId="agent-chat" enabled={false}>
        <div />
      </ParentSubagentsProvider>,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'agent-chat',
      { enabled: true },
      false,
    );
    rerender(
      <ParentSubagentsProvider conversationId="plain-chat" enabled={false}>
        <div />
      </ParentSubagentsProvider>,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'plain-chat',
      { enabled: false },
      false,
    );
  });

  it.each(['history', 'tools', 'subagents'])(
    'restores discovery from cached %s after switching endpoints',
    (evidence) => {
      mockUseParentSubagentsQuery.mockReturnValue({ data: undefined, refetch: jest.fn() });
      const client = new QueryClient();
      if (evidence === 'history')
        client.setQueryData([QueryKeys.messages, 'restored'], [{ endpoint: 'agents' }]);
      if (evidence === 'tools')
        client.setQueryData([QueryKeys.backgroundTasks, 'restored'], { tasks: [{}] });
      if (evidence === 'subagents')
        client.setQueryData([QueryKeys.parentSubagents, 'restored'], { children: [eventChild] });
      renderProvider(
        <ParentSubagentsProvider conversationId="restored" enabled={false}>
          <div />
        </ParentSubagentsProvider>,
        client,
      );
      expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
        'restored',
        { enabled: true },
        false,
      );
    },
  );

  it('does not discover tasks for a new or genuinely non-agent conversation', () => {
    mockUseParentSubagentsQuery.mockReturnValue({ data: undefined, refetch: jest.fn() });
    const { rerender } = renderProvider(
      <ParentSubagentsProvider conversationId="plain" enabled={false}>
        <div />
      </ParentSubagentsProvider>,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'plain',
      { enabled: false },
      false,
    );
    rerender(
      <ParentSubagentsProvider conversationId="new" enabled>
        <div />
      </ParentSubagentsProvider>,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith('new', { enabled: false }, false);
  });

  it('starts discovery when agent history arrives after the initial render', async () => {
    mockUseParentSubagentsQuery.mockReturnValue({ data: undefined, refetch: jest.fn() });
    const client = new QueryClient();
    renderProvider(
      <ParentSubagentsProvider conversationId="restored" enabled={false}>
        <div />
      </ParentSubagentsProvider>,
      client,
    );
    expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
      'restored',
      { enabled: false },
      false,
    );
    await act(async () => {
      client.setQueryData([QueryKeys.messages, 'restored'], [{ endpoint: 'agents' }]);
    });
    await waitFor(() =>
      expect(mockUseParentSubagentsQuery).toHaveBeenLastCalledWith(
        'restored',
        { enabled: true },
        false,
      ),
    );
  });
});
