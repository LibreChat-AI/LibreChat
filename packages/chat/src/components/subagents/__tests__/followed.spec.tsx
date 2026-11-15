/**
 * @jest-environment jsdom
 */
import { useContext } from 'react';
import { Provider, createStore } from 'jotai';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, ContentTypes, QueryKeys } from 'librechat-data-provider';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ConversationSeenSource } from '../../../react/messages/host';
import type { ToolContentQuery } from '../../../react/parts/disclosure';
import type { SubagentsHost } from '../../../react/subagents/host';
import type { ChatContract } from '../../../react/chat/contract';
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
  isLoadError: false,
  retry: () => undefined,
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
  renderContentParts: ({ messageId, content }) => (
    <RowProbe
      messageId={messageId}
      text={(content ?? []).map((part) => (part as { text?: string } | undefined)?.text).join('')}
    />
  ),
});

const mount = (followed: FollowedChat, host: Partial<SubagentsHost> = {}) => {
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
});
