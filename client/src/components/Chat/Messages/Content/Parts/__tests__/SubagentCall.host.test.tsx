import React from 'react';
import { RecoilRoot } from 'recoil';
import { useAtomValue } from 'jotai';
import { SubagentConversation } from '@librechat/chat/components';
import { Constants, ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { activeSubagentPanel, MessagePartsHostProvider } from '@librechat/chat/react';
import type { TAgentsMap, TAttachment } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '@librechat/chat/react';
import { appMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import { AgentsMapContext } from '~/Providers/AgentsMapContext';
import { MessageContext } from '~/Providers/MessageContext';
import { ShareContext } from '~/Providers/ShareContext';
import { ChatSurfaceHarness } from 'test/harness';
import SubagentCall from '../SubagentCall';
import '~/Providers/SubagentsHostContext';
import '~/components/Chat/Messages/hosts';

const agents = {
  'agent-1': {
    id: 'agent-1',
    name: 'Analyst One',
    avatar: { filepath: '/analyst.png' },
  },
} as unknown as TAgentsMap;

function renderCard(ui: React.ReactElement, share?: { isSharedConvo?: boolean; shareId?: string }) {
  let selection: ActiveSubagentPanel | null = null;
  const Observer = () => {
    selection = useAtomValue(activeSubagentPanel);
    return null;
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const rendered = render(
    <RecoilRoot>
      <QueryClientProvider client={queryClient}>
        <ChatSurfaceHarness>
          <AgentsMapContext.Provider value={agents}>
            <ShareContext.Provider value={share ?? {}}>
              <MessageContext.Provider
                value={{
                  messageId: 'parent-message',
                  conversationId: 'parent-conversation',
                  isExpanded: false,
                }}
              >
                <Observer />
                {ui}
              </MessageContext.Provider>
            </ShareContext.Provider>
          </AgentsMapContext.Provider>
        </ChatSurfaceHarness>
      </QueryClientProvider>
    </RecoilRoot>,
  );
  return { ...rendered, getSelection: () => selection };
}

describe('app subagent call adapter', () => {
  it('shows the saved agent and opens the panel through the app subscriptions', () => {
    const rendered = renderCard(
      <SubagentCall
        toolCallId="wired-call"
        initialProgress={1}
        args={{ subagent_type: 'agent-1', description: 'Review the release.' }}
        subagentIdentity={{ subagentKind: 'agent', subagentAgentId: 'agent-1' }}
        output="Done."
      />,
    );

    expect(screen.getByText('Analyst One')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Analyst One: Ran agent' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Analyst One: Ran agent' }));

    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({
        host: 'conversation',
        parentConversationId: 'parent-conversation',
        parentMessageId: 'parent-message',
        toolCallId: 'wired-call',
        prompt: 'Review the release.',
      }),
    );
  });

  it('opens a nested card through the real child transcript and app content renderer', () => {
    const rendered = renderCard(
      <SubagentConversation
        conversationId="child-thread"
        author={{ name: 'Child', icon: null }}
        parentAuthor={{ name: 'Parent', icon: null }}
        turns={[
          {
            taskId: 'child-task',
            trigger: { kind: 'parent_dispatch', summary: '', createdAt: '2026-11-14T12:00:00Z' },
            activity: {
              title: 'Child',
              status: 'completed',
              items: [],
              messageId: 'nested-message',
              content: [
                {
                  type: ContentTypes.TOOL_CALL,
                  tool_call: {
                    id: 'nested-call',
                    name: String(Constants.SUBAGENT),
                    progress: 1,
                    args: { subagent_type: 'self' },
                    output: 'Nested result.',
                  },
                },
              ],
            },
          },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({
        parentConversationId: 'child-thread',
        parentMessageId: 'nested-message',
        toolCallId: 'nested-call',
      }),
    );
  });

  it.each([
    [true, 'running'],
    [false, 'running'],
    [true, 'cancelled'],
    [true, 'completed'],
  ] as const)('uses the effective host fade policy in a child (%s, %s)', (smooth, status) => {
    const host = { ...appMessagePartsHost, useSmoothStreaming: () => smooth };
    const { container } = renderCard(
      <MessagePartsHostProvider host={host}>
        <SubagentConversation
          conversationId="live-child"
          author={{ name: 'Child', icon: null }}
          parentAuthor={{ name: 'Parent', icon: null }}
          turns={[
            {
              taskId: 'live-task',
              trigger: { kind: 'parent_dispatch', summary: '', createdAt: '2026-11-14T12:00:00Z' },
              activity: {
                title: 'Child',
                status,
                items: [],
                messageId: 'live-child-message',
                content: [{ type: ContentTypes.TEXT, text: 'Child streaming words' }],
              },
            },
          ]}
        />
      </MessagePartsHostProvider>,
    );
    expect(container).toHaveTextContent('Child streaming words');
    expect(container.querySelectorAll('[data-lc-fade]').length > 0).toBe(
      smooth && status === 'running',
    );
    expect(container.querySelector('.result-streaming') !== null).toBe(
      !smooth && status === 'running',
    );
  });

  it('keeps a shared detached card closed when the share host has no persisted activity', () => {
    const output = JSON.stringify({
      background_task_id: 'task-1',
      subagent_thread_id: 'thread-1',
      tool: 'subagent',
      subagent_type: 'researcher',
      status: 'running',
      message: 'Started subagent background task. Poll with background_task_id task-1.',
    });
    const rendered = renderCard(
      <SubagentCall
        toolCallId="shared-call"
        initialProgress={1}
        args={{ subagent_type: 'researcher', run_in_background: true }}
        output={output}
      />,
      { isSharedConvo: true, shareId: 'share-1' },
    );

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(rendered.getSelection()).toBeNull();
  });

  it('draws the run attachments from the app adapter', () => {
    const file = {
      type: 'file',
      filename: 'notes.txt',
      filepath: '/notes.txt',
    } as TAttachment;
    renderCard(
      <SubagentCall
        toolCallId="files-call"
        initialProgress={1}
        args={{ subagent_type: 'self' }}
        output="Shown."
        attachments={[file]}
      />,
    );

    expect(screen.getByText('notes.txt')).toBeInTheDocument();
  });
});
