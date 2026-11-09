import React from 'react';
import { useAtom } from 'jotai';
import { ContentTypes } from 'librechat-data-provider';
import { activeSubagentPanel } from '@librechat/chat/react';
import { fireEvent, render, screen } from '@testing-library/react';
import { SharedSubagentActivityDialog } from '@librechat/chat/components';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import { MessageContext } from '~/Providers/MessageContext';
import { ShareContext } from '~/Providers/ShareContext';
import { ChatSurfaceHarness } from 'test/harness';
import SubagentCall from '../SubagentCall';
import '~/Providers/MessagePartsHostContext';
import '~/Providers/MessagesHostContext';

const mockUseSubagentThreadQuery = jest.fn();

jest.mock('~/data-provider', () => ({
  useSubagentThreadQuery: (...args: unknown[]) => mockUseSubagentThreadQuery(...args),
}));

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string): string => {
      if (key === 'com_ui_subagent_complete') return 'Ran agent';
      if (key === 'com_ui_subagent_activity') return 'Agent activity';
      return key;
    },
}));

jest.mock('~/Providers', () => ({ useAgentsMapContext: () => ({}) }));
jest.mock('~/components/Share/MessageIcon', () => ({ __esModule: true, default: () => null }));
jest.mock('~/components/Chat/Messages/MessageIcon', () => ({
  __esModule: true,
  default: ({ iconData }: { iconData: { iconURL?: string } }) => (
    <span data-testid="author-face" data-icon={iconData.iconURL} />
  ),
}));
jest.mock('~/hooks/MCP', () => ({ useMCPServerNames: () => [] }));

jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
  /** The dialog's own rendering is specced in the package (shared.spec); here it only shows
   *  which shared selection the card opened, and with what content. */
  SharedSubagentActivityDialog: ({
    shareId,
    selected,
  }: {
    shareId?: string;
    selected: { host: string; shareId?: string; persistedContent?: TMessageContentParts[] } | null;
  }) => {
    if (selected?.host !== 'share' || selected.shareId !== shareId) return null;
    return (
      <div role="dialog">
        {selected.persistedContent?.map((part, index) =>
          part.type === 'text' && typeof part.text === 'string' ? (
            <span key={index}>{part.text}</span>
          ) : null,
        )}
      </div>
    );
  },
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
  detached?: boolean;
  partIndex?: number;
  messages?: TMessage[];
  subagentType?: string;
  subagentIdentity?: { subagentKind: 'graph'; subagentAgentId: 'graph:self' };
}) {
  return render(
    <ChatSurfaceHarness>
      <ShareContext.Provider value={{ isSharedConvo: true, shareId: 'share-1' }}>
        <MessageContext.Provider
          value={{
            conversationId: 'shared-conversation',
            messageId: 'shared-parent',
            partIndex: input.partIndex,
            isExpanded: false,
          }}
        >
          <SubagentCall
            toolCallId="shared-call"
            initialProgress={1}
            args={{
              subagent_type: input.subagentType ?? 'researcher',
              description: 'Review the release.',
              run_in_background: input.detached === true,
            }}
            output={input.output}
            subagentIdentity={input.subagentIdentity}
            persistedContent={input.persistedContent}
          />
          <SharedDialog messages={input.messages ?? sharedMessages} />
        </MessageContext.Provider>
      </ShareContext.Provider>
    </ChatSurfaceHarness>,
  );
}

describe('SubagentCall on a shared link', () => {
  beforeEach(() => mockUseSubagentThreadQuery.mockClear());

  it('renders detached persisted activity without performing the private durable query', () => {
    renderSharedCall({
      output: detachedOutput,
      persistedContent: persistedContent('Detached work survived refresh.'),
      detached: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Agent activity' }));

    expect(screen.getByText('Detached work survived refresh.')).toBeInTheDocument();
    expect(mockUseSubagentThreadQuery).not.toHaveBeenCalled();
  });

  it('makes a detached shared card without persisted activity explicitly noninteractive', () => {
    renderSharedCall({ output: detachedOutput, detached: true });

    expect(screen.getByRole('button', { name: 'Agent activity' })).toBeDisabled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(mockUseSubagentThreadQuery).not.toHaveBeenCalled();
  });

  it('keeps a shared detached card with only invisible reservations noninteractive', () => {
    renderSharedCall({
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
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
