/**
 * @jest-environment jsdom
 */
import { useContext } from 'react';
import { Provider, createStore } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { Agent, TMessage, SubagentControlReceipt } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ConversationSeenSource } from '../../../react/messages/host';
import type { ToolContentQuery } from '../../../react/parts/disclosure';
import type { SubagentsHost } from '../../../react/subagents/host';
import type { ChatContract } from '../../../react/chat/contract';
import type { FollowedChildThreadProps } from '../followed';
import type { FollowedChat } from '../../../react/follow';
import { MessagesHostProvider, useMessagesHost } from '../../../react/messages/host';
import { ToolContentQueryContext } from '../../../react/parts/disclosure';
import { createSubagentsHost } from '../../../__fixtures__/subagentsHost';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import FollowedChildThread, { SUBAGENT_THREAD_PANE } from '../followed';
import { SubagentsHostProvider } from '../../../react/subagents/host';
import { MessagePartsHostProvider } from '../../../react/host';
import { useChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';

beforeAll(initEnglish);

const brief: TMessage = {
  messageId: 'task:user',
  conversationId: 'child-thread',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Investigate the release.',
};

const reply: TMessage = {
  messageId: 'task:assistant',
  conversationId: 'child-thread',
  parentMessageId: 'task:user',
  isCreatedByUser: false,
  text: '',
  content: [{ type: ContentTypes.TEXT, text: 'The release is ready.' }],
};

const followedChat = (overrides: Partial<FollowedChat> = {}): FollowedChat => ({
  chat: undefined,
  messages: [brief, reply],
  status: 'ready',
  connection: 'idle',
  error: undefined,
  isLoading: false,
  isFollowing: false,
  isUnattached: false,
  isLoadError: false,
  retry: () => undefined,
  hasEarlier: false,
  isLoadingEarlier: false,
  isEarlierError: false,
  loadEarlier: () => undefined,
  canSend: () => false,
  send: () => false,
  stop: () => Promise.resolve(),
  attach: () => undefined,
  ...overrides,
});

type Seen = {
  contract?: ChatContract;
  toolContent?: ToolContentQuery | null;
  seenSource?: ConversationSeenSource;
  pendingTurn?: boolean;
};
let seen: Seen = {};

/** Reads what a row of the followed thread is given, from where a row reads it. */
function RowProbe({ messageId, text }: { messageId: string; text: string }): ReactElement {
  const host = useMessagesHost();
  seen = {
    contract: useChatContext(),
    toolContent: useContext(ToolContentQueryContext),
    seenSource: host.useSeenSource(),
    pendingTurn: host.useHasPendingTurn('child-thread'),
  };
  return <div data-testid="row">{`${messageId}=${text}`}</div>;
}

const pageSeenSource: ConversationSeenSource = {
  readReply: () => undefined,
  hasReplyProof: () => false,
  markSeen: jest.fn(),
  consumeFocusSuppression: () => false,
};

const messagesHost = createMessagesHost({
  useSeenSource: () => pageSeenSource,
  useHasPendingTurn: () => true,
  renderMessageBody: ({ message }) => (
    <div data-testid="row">{`${message.messageId}=${message.text ?? ''}`}</div>
  ),
});

const partsHost = createMessagePartsHost({
  /** The child's agent has a model, which a reply's header may show; a brief's must not. */
  useAgent: () => ({ id: 'agent-1', name: 'Child agent', model: 'child-model' }) as Agent,
  renderContentParts: ({ messageId, content }) => (
    <RowProbe
      messageId={messageId}
      text={(content ?? []).map((part) => (part as { text?: string } | undefined)?.text).join('')}
    />
  ),
});

const guidance = (overrides: Partial<SubagentControlReceipt> = {}): SubagentControlReceipt => ({
  invocationId: 'invocation-1',
  controlId: 'control-1',
  action: 'steer',
  status: 'accepted',
  createdAt: '2026-11-16T13:42:38.000Z',
  updatedAt: '2026-11-16T13:42:38.000Z',
  message: 'Check the release notes too.',
  ...overrides,
});

/** The app's steer bubble, reduced to its words and its receipt state. */
const renderSteer: SubagentsHost['renderSteer'] = ({ steer, receiptState }) => (
  <div data-testid="guidance" data-receipt={receiptState ?? ''}>
    {steer}
  </div>
);

const mount = (
  followed: FollowedChat,
  host: Partial<SubagentsHost> = {},
  props: Partial<FollowedChildThreadProps> = {},
) => {
  const queryClient = new QueryClient();
  /** The tail of the branch on screen is read from the cache the followed chat writes. */
  queryClient.setQueryData([QueryKeys.messages, 'child-thread'], followed.messages);
  return render(
    <QueryClientProvider client={queryClient}>
      <Provider store={createStore()}>
        <ChatSurfaceProvider
          value={{
            enterToSend: true,
            maximizeChatSpace: false,
            showScrollButton: false,
            composerBindings: {
              shortcutsEnabled: true,
              submitOverride: undefined,
              yieldedChords: new Set<string>(),
            },
            claimForeground: () => undefined,
            handOffComposerText: () => undefined,
          }}
        >
          <SubagentsHostProvider host={createSubagentsHost(host)}>
            <MessagesHostProvider host={messagesHost}>
              <MessagePartsHostProvider host={partsHost}>
                <FollowedChildThread
                  threadId="child-thread"
                  followed={followed}
                  agentId="agent-1"
                  {...props}
                />
              </MessagePartsHostProvider>
            </MessagesHostProvider>
          </SubagentsHostProvider>
        </ChatSurfaceProvider>
      </Provider>
    </QueryClientProvider>,
  );
};

const rows = () => screen.queryAllByTestId('row').map((row) => row.textContent);

describe('FollowedChildThread', () => {
  beforeEach(() => {
    seen = {};
  });

  it('says it is loading until the thread has messages to show', () => {
    mount(followedChat({ isLoading: true, messages: [] }));

    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(rows()).toEqual([]);
  });

  it('keeps showing what it has while a later read is in flight', () => {
    mount(followedChat({ isLoading: true }));

    expect(screen.queryByRole('status')).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it("draws the thread's messages as a conversation of the child agent the reader cannot drive", () => {
    mount(followedChat());

    expect(rows()).toEqual([
      'task:user=Investigate the release.',
      'task:assistant=The release is ready.',
    ]);
    expect(seen.contract).toMatchObject({
      index: SUBAGENT_THREAD_PANE,
      readOnly: true,
      messagesKey: 'child-thread',
      latestMessageId: 'task:assistant',
      conversation: { conversationId: 'child-thread', endpoint: 'agents', agent_id: 'agent-1' },
    });
  });

  it("draws the child's brief as the turn of the agent that sent it, not the reader's", () => {
    mount(followedChat(), {}, { briefAuthor: { label: 'Lead agent', icon: <span>LA</span> } });

    const brief = screen.getByRole('heading', { name: /Lead agent/ });
    expect(brief).toBeVisible();
    expect(brief).not.toHaveClass('sr-only');
    expect(brief).toHaveTextContent('LA');
    /** Named for its author alone: the model on offer is the child's, not the sender's. */
    expect(brief).not.toHaveTextContent('child-model');
    expect(rows()[0]).toBe('task:user=Investigate the release.');
  });

  it('leaves a brief with no known sender as a plain user-side turn', () => {
    mount(followedChat());

    expect(screen.queryByText('LA')).toBeNull();
  });

  it("reads a tool call's full output through the host's parent-scoped query", () => {
    const useThreadToolContent = jest.fn() as unknown as ToolContentQuery;
    mount(followedChat(), { useThreadToolContent });

    expect(seen.toolContent).toBe(useThreadToolContent);
  });

  it('leaves tool calls as previews where the host has no parent-scoped query', () => {
    mount(followedChat());

    expect(seen.toolContent).toBeNull();
  });

  it("acts on the child thread where the page's host would act on main chat", () => {
    mount(followedChat());

    expect(seen.seenSource).not.toBe(pageSeenSource);
    expect(seen.pendingTurn).toBe(false);
  });

  describe('guidance sent to the child', () => {
    it('draws guidance the child has not taken yet after the last row, with a way to withdraw it', () => {
      const onCancelControl = jest.fn();
      mount(followedChat(), { renderSteer }, { controls: [guidance()], onCancelControl });

      const waiting = screen.getByTestId('guidance');
      expect(waiting).toHaveTextContent('Check the release notes too.');
      expect(waiting).toHaveAttribute('data-receipt', 'delivered');
      const lastRow = screen.getAllByTestId('row').pop() as HTMLElement;
      expect(
        lastRow.compareDocumentPosition(waiting) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Withdraw' }));
      expect(onCancelControl).toHaveBeenCalledWith('control-1');
    });

    it('does not draw a receipt for guidance the reply already shows where the child took it', () => {
      const taken: TMessage = {
        ...reply,
        content: [
          { type: ContentTypes.TEXT, text: 'Checking.' },
          {
            type: ContentTypes.STEER,
            [ContentTypes.STEER]: 'Check the release notes too.',
            steerId: 'control-1',
          },
        ] as TMessage['content'],
      };
      mount(
        followedChat({ messages: [brief, taken] }),
        { renderSteer },
        { controls: [guidance({ status: 'applied' })], onCancelControl: jest.fn() },
      );

      expect(screen.queryByTestId('guidance')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    });

    it('offers no withdrawal while the task cannot be controlled', () => {
      mount(followedChat(), { renderSteer }, { controls: [guidance()] });

      expect(screen.getByTestId('guidance')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Withdraw' })).toBeNull();
    });

    it('says why guidance was refused', () => {
      mount(
        followedChat(),
        { renderSteer },
        { controls: [guidance({ status: 'rejected', reason: 'task_completed' })] },
      );

      expect(screen.getByTestId('guidance')).toHaveAttribute('data-receipt', '');
      expect(
        screen.getByText('The task completed before this command applied.'),
      ).toBeInTheDocument();
    });

    it('says when earlier guidance is not shown', () => {
      mount(followedChat(), { renderSteer }, { controlsTruncated: true });

      expect(screen.getByText('Earlier control activity is not shown.')).toBeInTheDocument();
    });

    it('adds nothing after the last row when no guidance was sent', () => {
      mount(followedChat(), { renderSteer });

      expect(document.querySelector('[data-subagent-pending-guidance]')).toBeNull();
    });
  });
});
