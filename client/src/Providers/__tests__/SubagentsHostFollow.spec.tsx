import React from 'react';
import { RecoilRoot } from 'recoil';
import { TaskContentScopeContext } from '@librechat/chat/react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, ToolCallPartParams } from 'librechat-data-provider';

const mockThreadMessages = jest.fn();
const mockThreadToolCallPart = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getSubagentThreadMessages: (...args: unknown[]) => mockThreadMessages(...args),
      getSubagentThreadToolCallPart: (...args: unknown[]) => mockThreadToolCallPart(...args),
    },
  };
});

const mockStreamStatus = jest.fn();
jest.mock('~/data-provider/SSE/queries', () => ({
  ...jest.requireActual('~/data-provider/SSE/queries'),
  fetchStreamStatus: (...args: unknown[]) => mockStreamStatus(...args),
}));

const { appSubagentsHost } = jest.requireActual('~/Providers/SubagentsHostContext');

const brief = {
  messageId: 'task:user',
  conversationId: 'child-thread',
  parentMessageId: null,
  isCreatedByUser: true,
  text: 'Investigate the release.',
} as TMessage;

const wrapper =
  (scope?: { parentConversationId: string; threadId: string; taskId: string }) =>
  ({ children }: { children: React.ReactNode }) => {
    const [client] = React.useState(
      () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    );
    return (
      <RecoilRoot>
        <QueryClientProvider client={client}>
          <TaskContentScopeContext.Provider value={scope ?? null}>
            {children}
          </TaskContentScopeContext.Provider>
        </QueryClientProvider>
      </RecoilRoot>
    );
  };

describe("the app's subagents host, following a child thread", () => {
  beforeEach(() => {
    mockThreadMessages.mockReset();
    mockThreadToolCallPart.mockReset();
    mockStreamStatus.mockReset();
  });

  it("reads the thread's messages through its parent, with tool previews", async () => {
    mockStreamStatus.mockResolvedValue({ active: false });
    mockThreadMessages.mockResolvedValue({ messages: [brief], earlier: null });

    const { result } = renderHook(
      () =>
        appSubagentsHost.useThreadChat('parent-conversation', 'child-thread', {
          live: false,
          enabled: true,
        }),
      { wrapper: wrapper() },
    );
    expect(result.current.isLoading).toBe(true);

    await waitFor(() => expect(result.current.messages).toEqual([brief]));
    expect(mockStreamStatus).toHaveBeenCalledWith('child-thread');
    expect(mockThreadMessages).toHaveBeenCalledWith('parent-conversation', 'child-thread', {
      toolPreviews: true,
      cursor: undefined,
    });
    expect(result.current.isLoading).toBe(false);
    expect(result.current.hasEarlier).toBe(false);
  });

  it('reads a long thread a page at a time, each earlier page by the cursor before it', async () => {
    mockStreamStatus.mockResolvedValue({ active: false });
    const older = { ...brief, messageId: 'earlier:user' };
    mockThreadMessages.mockImplementation(async (_parent, _thread, options) =>
      options.cursor == null
        ? { messages: [brief], earlier: 'cursor-1' }
        : { messages: [older], earlier: null },
    );

    const { result } = renderHook(
      () =>
        appSubagentsHost.useThreadChat('parent-conversation', 'child-thread', {
          live: false,
          enabled: true,
        }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.hasEarlier).toBe(true));
    expect(result.current.messages).toEqual([brief]);

    act(() => result.current.loadEarlier());

    await waitFor(() => expect(result.current.messages).toEqual([older, brief]));
    expect(mockThreadMessages).toHaveBeenLastCalledWith('parent-conversation', 'child-thread', {
      toolPreviews: true,
      cursor: 'cursor-1',
    });
    expect(result.current.hasEarlier).toBe(false);
  });

  it('reports messages it could not read instead of an empty thread', async () => {
    mockStreamStatus.mockResolvedValue({ active: false });
    mockThreadMessages.mockRejectedValue(new Error('not found'));

    const { result } = renderHook(
      () =>
        appSubagentsHost.useThreadChat('parent-conversation', 'child-thread', {
          live: false,
          enabled: true,
        }),
      { wrapper: wrapper() },
    );

    await waitFor(() => expect(result.current.isLoadError).toBe(true));
  });

  it('reads nothing for a selection that has no thread to follow', async () => {
    renderHook(
      () =>
        appSubagentsHost.useThreadChat('parent-conversation', '', { live: false, enabled: false }),
      { wrapper: wrapper() },
    );
    await Promise.resolve();

    expect(mockStreamStatus).not.toHaveBeenCalled();
    expect(mockThreadMessages).not.toHaveBeenCalled();
  });

  const params: ToolCallPartParams = {
    conversationId: 'child-thread',
    messageId: 'task:assistant',
    partIndex: 1,
    toolCallId: 'call-1',
  };

  it("reads a tool call's full output through the parent the task scope names", async () => {
    const part = { type: 'tool_call', tool_call: { id: 'call-1', output: 'whole output' } };
    mockThreadToolCallPart.mockResolvedValue(part);
    const scope = {
      parentConversationId: 'parent-conversation',
      threadId: 'child-thread',
      taskId: 'task',
    };

    const { result } = renderHook(() => appSubagentsHost.useThreadToolContent(params), {
      wrapper: wrapper(scope),
    });

    await waitFor(() => expect(result.current.data).toEqual(part));
    expect(mockThreadToolCallPart).toHaveBeenCalledWith('parent-conversation', params);
  });

  it('asks for nothing outside a task scope, where it could not name the parent', async () => {
    const { result } = renderHook(() => appSubagentsHost.useThreadToolContent(params), {
      wrapper: wrapper(),
    });
    await Promise.resolve();

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockThreadToolCallPart).not.toHaveBeenCalled();
  });
});
