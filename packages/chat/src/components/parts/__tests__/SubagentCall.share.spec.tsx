/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Provider as JotaiProvider, createStore, useAtomValue } from 'jotai';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import type { ActiveSubagentPanel } from '../../../react/subagents/state';
import type { ChatSurface } from '../../../react/subagents/context';
import type { StreamHost } from '../../../react/stream/host';
import type { SubagentCallProps } from '../SubagentCall';
import { ParentSubagentsProvider } from '../../../react/subagents/parents';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { SubagentsHostProvider } from '../../../react/subagents/host';
import { activeSubagentPanel } from '../../../react/subagents/state';
import { StreamHostProvider } from '../../../react/stream/host';
import { MessagePartsHostProvider } from '../../../react/host';
import PackageSubagentCall from '../SubagentCall';

const localize = (key: string): string => {
  if (key === 'com_ui_subagent_complete') return 'Ran agent';
  if (key === 'com_ui_subagent_activity') return 'Agent activity';
  return key;
};

function SubagentCall(props: SubagentCallProps) {
  return (
    <PackageSubagentCall
      {...props}
      message={{ messageId: 'shared-parent', conversationId: 'shared-conversation', partIndex: 0 }}
      isSharedConvo
      shareId="share-1"
      localize={localize}
      renderAgentIcon={() => null}
      renderAttachments={() => null}
    />
  );
}
const partsHost = createMessagePartsHost();

const streamHost = {
  useParentSubagentIndex: () => ({
    data: undefined,
    isError: false,
    refetch: async () => ({ data: undefined }),
  }),
} as unknown as StreamHost;

const surface: ChatSurface = {
  enterToSend: true,
  maximizeChatSpace: false,
  showScrollButton: true,
  composerBindings: {
    shortcutsEnabled: true,
    submitOverride: undefined,
    yieldedChords: new Set<string>(),
  },
  claimForeground: () => undefined,
  handOffComposerText: () => undefined,
};

function Providers({ children }: { children: ReactNode }) {
  const [store] = useState(() => createStore());
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
  );
  return (
    <QueryClientProvider client={queryClient}>
      <StreamHostProvider host={streamHost}>
        <ParentSubagentsProvider conversationId="shared-conversation" enabled>
          <JotaiProvider store={store}>
            <SubagentsHostProvider host={createSubagentsHost()}>
              <ChatSurfaceProvider value={surface}>
                <MessagePartsHostProvider host={partsHost}>{children}</MessagePartsHostProvider>
              </ChatSurfaceProvider>
            </SubagentsHostProvider>
          </JotaiProvider>
        </ParentSubagentsProvider>
      </StreamHostProvider>
    </QueryClientProvider>
  );
}

const persistedContent = (text: string): TMessageContentParts[] => [
  { type: ContentTypes.TEXT, text },
];

const detachedOutput = JSON.stringify({
  background_task_id: 'task-1',
  subagent_thread_id: 'thread-1',
  tool: 'subagent',
  subagent_type: 'researcher',
  status: 'running',
  message:
    'Started subagent "researcher" background task. Poll the host background-task tool with background_task_id "task-1".',
});

function renderSharedCall(input: {
  output?: string;
  persistedContent?: TMessageContentParts[];
  detached?: boolean;
}) {
  let selection: ActiveSubagentPanel | null = null;
  const Observer = () => {
    selection = useAtomValue(activeSubagentPanel);
    return null;
  };
  render(
    <Providers>
      <Observer />
      <SubagentCall
        toolCallId="shared-call"
        initialProgress={1}
        args={{
          subagent_type: 'researcher',
          description: 'Review the release.',
          run_in_background: input.detached === true,
        }}
        output={input.output}
        persistedContent={input.persistedContent}
      />
    </Providers>,
  );
  return { getSelection: () => selection };
}

describe('SubagentCall on a shared link', () => {
  it('opens detached persisted activity as a share selection without a durable handle', () => {
    const rendered = renderSharedCall({
      output: detachedOutput,
      persistedContent: persistedContent('Detached work survived refresh.'),
      detached: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }));

    expect(rendered.getSelection()).toEqual(
      expect.objectContaining({
        host: 'share',
        shareId: 'share-1',
        persistedContent: persistedContent('Detached work survived refresh.'),
      }),
    );
    expect(rendered.getSelection()?.durable).toBeUndefined();
  });

  it('makes a detached shared card without persisted activity explicitly noninteractive', () => {
    const rendered = renderSharedCall({ output: detachedOutput, detached: true });

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(rendered.getSelection()).toBeNull();
  });

  it('keeps a shared detached card with only invisible reservations noninteractive', () => {
    const rendered = renderSharedCall({
      output: detachedOutput,
      detached: true,
      persistedContent: [
        {
          type: ContentTypes.ACTIVITY_LABEL,
          activity_label: '',
        },
      ],
    });

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(rendered.getSelection()).toBeNull();
  });
});
