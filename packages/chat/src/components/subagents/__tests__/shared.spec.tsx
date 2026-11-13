/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import { ContentTypes } from 'librechat-data-provider';
import { Provider as JotaiProvider, createStore, useAtom } from 'jotai';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { ActiveSubagentPanel } from '../../../react/subagents/state';
import type { ChatSurface } from '../../../react/subagents/surface';
import type { SubagentsHost } from '../../../react/subagents/host';
import type { MessagePartsHost } from '../../../react/host';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { useOpenSubagentPanel } from '../../../react/subagents/surface';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { SubagentsHostProvider } from '../../../react/subagents/host';
import { activeSubagentPanel } from '../../../react/subagents/state';
import { MessagesHostProvider } from '../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../react/host';
import SharedSubagentActivityDialog from '../shared';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLanguage: () => 'en',
  useLocalize: () => (key: string) => key,
}));

jest.mock('../transcript', () => ({
  ...jest.requireActual('../transcript'),
  SubagentActivityScrollSurface: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="shared-scroll-surface">{children}</div>
  ),
  SubagentActivity: ({
    activity,
  }: {
    activity: { title: string; items: Array<{ type: string; text?: string }> };
  }) => (
    <div data-testid="shared-subagent-activity">
      <span>{activity.title}</span>
      {activity.items.map((item, index) => (
        <span key={index}>{item.text ?? item.type}</span>
      ))}
    </div>
  ),
}));

jest.mock('../conversation', () => ({
  __esModule: true,
  default: ({
    turns,
    author,
    parentAuthor,
  }: {
    author: { name: string };
    parentAuthor: { name: string };
    turns: Array<{
      taskId: string;
      trigger: { summary: string };
      activity: { items: Array<{ type: string; text?: string }> };
    }>;
  }) => {
    const { MessageSurfaceContext } = jest.requireActual('../../../react/messages/surface');
    return (
      <MessageSurfaceContext.Consumer>
        {(surface: string) => (
          <div
            data-testid="subagent-conversation"
            data-message-surface={surface}
            data-author={author.name}
            data-parent-author={parentAuthor.name}
          >
            {turns.map((turn) => (
              <div key={turn.taskId}>
                {turn.trigger.summary}
                {turn.activity.items.map((item, index) => (
                  <span key={index}>{item.text ?? item.type}</span>
                ))}
              </div>
            ))}
          </div>
        )}
      </MessageSurfaceContext.Consumer>
    );
  },
}));

const partsHost: MessagePartsHost = {
  useMessage: () => ({ messageId: 'shared-parent' }),
  renderMarkdown: ({ content }) => content,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  renderAgentAvatar: () => null,
  renderContentParts: () => null,
  renderImage: () => null,
  renderFilePreview: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => false,
  useChatDirection: () => 'ltr',
  useUserTextPreferences: () => ({
    usernameDisplay: false,
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => jest.fn(),
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, jest.fn()],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, jest.fn()],
  useShare: () => ({}),
};

const messagesHost = createMessagesHost({
  renderMessageIcon: ({ iconData }) => (
    <span data-testid="author-face" data-icon={iconData?.iconURL} />
  ),
});

const subagentsHost: SubagentsHost = createSubagentsHost({
  renderSteer: () => null,
  useRetainedControl: () => ({ isFetching: false, isError: false, refetch: () => undefined }),
  useTaskContent: () => ({ isError: false, isUnavailable: false, refetch: () => undefined }),
  useAgentsMap: () => ({}),
  useChildPartsHost: (host) => host,
});

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

function ChatSurfaceHarness({ children }: { children: React.ReactNode }) {
  const [store] = useState(() => createStore());
  return (
    <JotaiProvider store={store}>
      <MessagesHostProvider host={messagesHost}>
        <MessagePartsHostProvider host={partsHost}>
          <SubagentsHostProvider host={subagentsHost}>
            <ChatSurfaceProvider value={surface}>{children}</ChatSurfaceProvider>
          </SubagentsHostProvider>
        </MessagePartsHostProvider>
      </MessagesHostProvider>
    </JotaiProvider>
  );
}

/** The card a shared message draws for a child: the attributes the dialog finds it by to
 *  restore focus, and the selection it opens the panel with. */
function SharedCallTrigger({ selection }: { selection: ActiveSubagentPanel }) {
  const open = useOpenSubagentPanel();
  return (
    <button
      type="button"
      onClick={() => open?.(selection)}
      data-subagent-tool-call={selection.toolCallId}
      data-subagent-parent-message={selection.parentMessageId}
      data-subagent-part-index={selection.partIndex}
    >
      Ran agent
    </button>
  );
}

const persistedContent = (text: string): TMessageContentParts[] => [
  { type: ContentTypes.TEXT, text },
];

/** The shared thread as ShareView holds it: the agent that dispatched the child. */
const sharedMessages: TMessage[] = [
  {
    messageId: 'shared-parent',
    parentMessageId: null,
    conversationId: 'shared-conversation',
    isCreatedByUser: false,
    endpoint: 'agents',
    model: 'agent_parent',
    sender: 'Lia',
    iconURL: '/lia.png',
    text: '',
  },
];

/** The dialog as ShareView mounts it: the app's panel selection, passed in. */
function SharedDialog({ messages }: { messages: TMessage[] }) {
  const [selected, setSelected] = useAtom(activeSubagentPanel);
  return (
    <SharedSubagentActivityDialog
      shareId="share-1"
      messages={messages}
      selected={selected}
      setSelected={setSelected}
    />
  );
}

function renderSharedCall(input: {
  output?: string;
  persistedContent?: TMessageContentParts[];
  partIndex?: number;
  messages?: TMessage[];
  subagentType?: string;
  subagentIdentity?: ActiveSubagentPanel['subagentIdentity'];
}) {
  const selection: ActiveSubagentPanel = {
    host: 'share',
    shareId: 'share-1',
    parentConversationId: 'shared-conversation',
    parentMessageId: 'shared-parent',
    toolCallId: 'shared-call',
    partIndex: input.partIndex ?? 0,
    subagentType: input.subagentType ?? 'researcher',
    subagentIdentity: input.subagentIdentity,
    prompt: 'Review the release.',
    legacyOutput: input.output,
    ...(input.persistedContent == null ? {} : { persistedContent: input.persistedContent }),
    initialProgress: 1,
    isSubmitting: false,
  };
  return render(
    <ChatSurfaceHarness>
      <SharedCallTrigger selection={selection} />
      <SharedDialog messages={input.messages ?? sharedMessages} />
    </ChatSurfaceHarness>,
  );
}

describe('SharedSubagentActivityDialog', () => {
  it('opens readable foreground activity from the shared message payload and restores focus', async () => {
    renderSharedCall({
      output: 'Legacy fallback.',
      persistedContent: persistedContent('Shared review complete.'),
    });
    const trigger = screen.getByRole('button', { name: 'Ran agent' });

    fireEvent.click(trigger);

    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-message-surface',
      'bg-surface-dialog',
    );
    expect(screen.getByText('Shared review complete.')).toBeInTheDocument();
    /** Named as main chat names them: the child by its readable type, the
     *  briefing by the shared agent that sent it. */
    expect(screen.getByRole('heading', { name: 'researcher' })).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-author',
      'researcher',
    );
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-parent-author',
      'Lia',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it('reuses the historical parent avatar for a shared self-spawn', () => {
    renderSharedCall({ subagentType: 'self', persistedContent: persistedContent('Self work.') });
    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(screen.getByRole('heading', { name: 'Lia' })).toBeInTheDocument();
    expect(screen.getByTestId('author-face')).toHaveAttribute('data-icon', '/lia.png');
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-author', 'Lia');
  });

  it('uses the exact shared part when provider tool IDs repeat', () => {
    renderSharedCall({
      subagentType: 'self',
      partIndex: 1,
      persistedContent: persistedContent('Lane work.'),
      messages: [
        {
          ...sharedMessages[0],
          content: [
            {
              type: ContentTypes.TOOL_CALL,
              agentId: 'agent_parent',
              tool_call: { id: 'shared-call', name: 'subagent', args: {} },
            },
            {
              type: ContentTypes.TOOL_CALL,
              agentId: 'agent_missing_lane',
              tool_call: { id: 'shared-call', name: 'subagent', args: {} },
            },
          ],
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute(
      'data-parent-author',
      'com_ui_subagent_parent_agent',
    );
    expect(screen.queryByRole('heading', { name: 'Lia' })).not.toBeInTheDocument();
  });

  it('preserves a shared graph alias named self instead of the parent author', () => {
    renderSharedCall({
      subagentType: 'self',
      subagentIdentity: { subagentKind: 'graph', subagentAgentId: 'graph:self' },
      persistedContent: persistedContent('Graph work.'),
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ran agent' }));
    expect(screen.getByRole('heading', { name: 'self' })).toBeInTheDocument();
    expect(screen.getByTestId('subagent-conversation')).toHaveAttribute('data-author', 'self');
    expect(screen.getByTestId('author-face')).not.toHaveAttribute('data-icon', '/lia.png');
  });
});
