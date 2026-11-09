/**
 * @jest-environment jsdom
 */
import { Provider as JotaiProvider } from 'jotai';
import { ContentTypes, EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import type { ReactElement, ReactNode } from 'react';
import type { ChatContract } from '../../../../react/chat/contract';
import type { MessagesHost } from '../../../../react/messages/host';
import type { MessagePartsHost } from '../../../../react/host';
import { RowMountProvider } from '../../../../react/messages/useProgressiveRowMount';
import { createMessagesHost } from '../../../../__fixtures__/messagesHost';
import { setDefaultMessagesHost } from '../../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../../react/host';
import { ChatContext } from '../../../../react/chat/context';
import { initEnglish } from '../../../../__fixtures__/i18n';
import MultiMessage from '../MultiMessage';

const partsHost: MessagePartsHost = {
  useMessage: () => ({ messageId: '' }),
  renderMarkdown: ({ content }) => <p>{content}</p>,
  useSmoothStreaming: () => false,
  useAgent: () => undefined,
  renderAgentIcon: () => null,
  renderAgentAvatar: () => null,
  renderContentParts: ({ content }) => (
    <p>{content.map((part) => (part?.type === ContentTypes.TEXT ? part.text : '')).join('')}</p>
  ),
  renderImage: () => null,
  renderFilePreview: () => null,
  useFontSize: () => 'text-base',
  useShowThinking: () => false,
  useAutoExpandTools: () => false,
  useLaTeXParsing: () => false,
  useChatDirection: () => 'auto',
  useUserTextPreferences: () => ({
    enableUserMsgMarkdown: false,
    collapseLongUserMessages: false,
    usernameDisplay: false,
  }),
  useUser: () => undefined,
  useFileMap: () => undefined,
  useToast: () => () => undefined,
  useSandboxStarting: () => false,
  useToolArtifactClaim: () => [null, () => undefined],
  useSteerEscalating: () => false,
  usePaneConversationId: () => null,
  useLiveAppliedSteer: () => [false, () => undefined],
  useShare: () => ({}),
};

const contract = {
  index: 0,
  isSubmitting: false,
  latestMessageDepth: 0,
  messagesKey: 'c1',
  conversation: { conversationId: 'c1', endpoint: EModelEndpoint.agents },
} as ChatContract;

/** The host's activity slot exposes the anchor ids and layout flag the thread passed it. */
const host: MessagesHost = createMessagesHost({
  renderActivity: ({ parentMessageIds, hasParallelContent }) => (
    <div
      data-testid="event-subagent-activity"
      data-parent-message-ids={parentMessageIds.join(',')}
      data-has-parallel-content={String(hasParallelContent)}
    />
  ),
});

function Providers({ children }: { children: ReactNode }): ReactElement {
  return (
    <JotaiProvider>
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>
          <MessagePartsHostProvider host={partsHost}>{children}</MessagePartsHostProvider>
        </ChatContext.Provider>
      </QueryClientProvider>
    </JotaiProvider>
  );
}

const queryClient = new QueryClient();

const renderTree = (ui: ReactElement) => render(ui, { wrapper: Providers });

beforeAll(async () => {
  await initEnglish();
  setDefaultMessagesHost(host);
});

const msg = (messageId: string): TMessage =>
  ({
    messageId,
    parentMessageId: 'parent-1',
    conversationId: 'c1',
    isCreatedByUser: false,
    text: messageId,
    content: [{ type: 'text', text: messageId }],
    children: [],
  }) as unknown as TMessage;

const tree = (ids: string[]) => ids.map((id) => msg(id));

const treeElement = (ids: string[]) => (
  <MultiMessage
    messageId="parent-1"
    messagesTree={tree(ids)}
    currentEditId={null}
    setCurrentEditId={jest.fn()}
  />
);

/** The real row is a labelled group whose id is the message id. */
const rowElements = () => screen.getAllByRole('group', { name: /^Message/ });
const rowIds = () => rowElements().map((element) => element.id);
const displayed = () => rowIds()[0];
const previous = () => screen.getByRole('button', { name: 'Previous sibling message' });

describe('MultiMessage sibling selection', () => {
  it('hosts event activity for structured and legacy message rows', () => {
    const structured = msg('structured');
    const legacy = { ...msg('legacy'), content: undefined } as TMessage;
    const view = renderTree(
      <MultiMessage
        messageId="parent-1"
        messagesTree={[structured]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-parent-message-ids',
      'structured,parent-1',
    );

    view.rerender(
      <MultiMessage
        messageId="parent-1"
        messagesTree={[legacy]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );
    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-parent-message-ids',
      'legacy,parent-1',
    );
  });

  it('places a user-anchored event group after the assistant response', () => {
    const assistant = msg('assistant');
    const user = {
      ...msg('user'),
      isCreatedByUser: true,
      parentMessageId: 'root',
      children: [assistant],
    } as TMessage;
    assistant.parentMessageId = 'user';

    renderTree(
      <MultiMessage
        messageId="root"
        messagesTree={[user]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(screen.getAllByTestId('event-subagent-activity')).toHaveLength(1);
    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-parent-message-ids',
      'assistant,user',
    );
    expect(
      screen
        .getByText('assistant')
        .compareDocumentPosition(screen.getByTestId('event-subagent-activity')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('hides merged event activity while its user anchor is being edited', () => {
    const assistant = { ...msg('assistant'), parentMessageId: 'user' } as TMessage;
    const user = {
      ...msg('user'),
      isCreatedByUser: true,
      parentMessageId: 'root',
      children: [assistant],
    } as TMessage;

    renderTree(
      <MultiMessage
        messageId="root"
        messagesTree={[user]}
        currentEditId="user"
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(screen.queryByTestId('event-subagent-activity')).not.toBeInTheDocument();
  });

  it('matches the wider layout of a parallel assistant response', () => {
    const assistant = {
      ...msg('assistant'),
      /** Two agents, so the response really does lay out columns. */
      content: [
        { type: 'text', text: 'primary', agentId: 'agent_a', groupId: 1 },
        { type: 'text', text: 'added', agentId: 'agent_b____1', groupId: 1 },
      ],
    } as unknown as TMessage;

    renderTree(
      <MultiMessage
        messageId="parent-1"
        messagesTree={[assistant]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-has-parallel-content',
      'true',
    );
  });

  it('keeps the standard width when a group is backed by one agent', () => {
    /** A multi-agent graph stamps a group id on every starting node, so an
     *  ordinary agent that merely has subagents available carries one on its
     *  OWN output. Widening for columns that never arrive is the regression. */
    const assistant = {
      ...msg('assistant'),
      content: [
        { type: 'text', text: 'thinking', agentId: 'agent_a', groupId: 1 },
        { type: 'text', text: 'answer', agentId: 'agent_a', groupId: 1 },
      ],
    } as unknown as TMessage;

    renderTree(
      <MultiMessage
        messageId="parent-1"
        messagesTree={[assistant]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-has-parallel-content',
      'false',
    );
  });

  it('renders assistant content containing an undefined streaming placeholder', () => {
    const assistant = {
      ...msg('assistant'),
      content: [undefined, { type: 'text', text: 'answer' }],
    } as unknown as TMessage;

    renderTree(
      <MultiMessage
        messageId="parent-1"
        messagesTree={[assistant]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />,
    );

    expect(within(rowElements()[0]).getByTestId('message-body')).toHaveTextContent('answer');
    expect(screen.getByTestId('event-subagent-activity')).toHaveAttribute(
      'data-has-parallel-content',
      'false',
    );
  });

  it('shows the newest sibling by default and follows a newly appended one', () => {
    const view = renderTree(treeElement(['a', 'b']));
    expect(displayed()).toBe('b');

    view.rerender(treeElement(['a', 'b', 'c']));
    expect(displayed()).toBe('c');
  });

  /**
   * Regression: background cache churn (an abandoned preempt sibling restored
   * at finalize, a refetch merge) must not yank the user off the branch they
   * navigated to. Only a NEW newest sibling (a submission landing at this
   * level) moves the selection.
   */
  it('keeps the viewed older branch when a middle sibling appears without a new newest', () => {
    const view = renderTree(treeElement(['a', 'b']));
    expect(displayed()).toBe('b');

    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['a', 'restored-middle', 'b']));
    expect(displayed()).toBe('a');
  });

  it('still follows a new newest sibling from an older branch (regenerate lands)', () => {
    const view = renderTree(treeElement(['a', 'b']));
    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['a', 'b', 'c']));
    expect(displayed()).toBe('c');
  });

  it('falls back to the newest when the viewed sibling disappears', () => {
    const view = renderTree(treeElement(['a', 'b', 'c']));
    fireEvent.click(previous());
    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['b', 'c']));
    expect(displayed()).toBe('c');
  });

  it('keeps the same-position display stable across content-only tree rebuilds', () => {
    const view = renderTree(treeElement(['a', 'b']));
    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    /** Streaming mints a fresh array each write with identical membership. */
    view.rerender(treeElement(['a', 'b']));
    expect(displayed()).toBe('a');
  });

  /**
   * Regression: streaming ids hydrate to durable ids at finalize (the legacy
   * regenerate path mints a new UUID for `_`-suffixed preliminary ids). The
   * newest child's id changing WITHOUT the prior newest surviving is a
   * re-key of the same row, not an append; it must not yank a user who
   * paged to an older sibling mid-stream.
   */
  it('keeps the viewed older branch when the newest sibling is re-keyed at finalize', () => {
    const view = renderTree(treeElement(['a', 'streaming_']));
    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['a', 'durable-id']));
    expect(displayed()).toBe('a');
  });

  it('keeps the viewed branch when a re-key lands together with restored middle siblings', () => {
    const view = renderTree(treeElement(['a', 'streaming_']));
    fireEvent.click(previous());
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['a', 'restored-middle', 'durable-id']));
    expect(displayed()).toBe('a');
  });

  it('still follows a genuine append after a re-key settled', () => {
    const view = renderTree(treeElement(['a', 'streaming_']));
    fireEvent.click(previous());
    view.rerender(treeElement(['a', 'durable-id']));
    expect(displayed()).toBe('a');

    view.rerender(treeElement(['a', 'durable-id', 'appended']));
    expect(displayed()).toBe('appended');
  });

  /**
   * Regression: sibling `createdAt` ties have no sort tie-breaker, so a
   * refetch can return the same membership in a different order. A changed
   * last id without a NEW member is a reorder, not an append; the viewed
   * message must stay selected by identity.
   */
  it('treats a same-membership reorder as churn, not an append', () => {
    const view = renderTree(treeElement(['a', 'b', 'c']));
    fireEvent.click(previous());
    expect(displayed()).toBe('b');

    view.rerender(treeElement(['b', 'c', 'a']));
    expect(displayed()).toBe('b');
  });

  /**
   * Regression: the recursive instance is deliberately unkeyed and gets
   * reused across parents when an ancestor's branch switches. The
   * reconciliation refs then describe the previous parent's children, so
   * reconciling against them wiped the returned-to branch's saved selection.
   */
  it("preserves each parent's saved selection when the instance is reused across parents", () => {
    const treeFor = (messageId: string, ids: string[]) => (
      <MultiMessage
        messageId={messageId}
        messagesTree={tree(ids)}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />
    );

    const view = renderTree(treeFor('parent-a', ['a1', 'a2']));
    fireEvent.click(previous());
    expect(displayed()).toBe('a1');

    view.rerender(treeFor('parent-b', ['b1', 'b2', 'b3']));
    expect(displayed()).toBe('b3');

    view.rerender(treeFor('parent-a', ['a1', 'a2']));
    expect(displayed()).toBe('a1');
  });
});

describe('MultiMessage row mount window', () => {
  const chain = (): TMessage => {
    const leaf = { ...msg('m2'), parentMessageId: 'm1', depth: 2 } as TMessage;
    const mid = { ...msg('m1'), parentMessageId: 'm0', depth: 1, children: [leaf] } as TMessage;
    return { ...msg('m0'), depth: 0, children: [mid] } as TMessage;
  };

  const windowedTree = (mountWindow: { start: number; end: number } | null) => (
    <RowMountProvider mountWindow={mountWindow}>
      <MultiMessage
        messageId="parent-1"
        messagesTree={[chain()]}
        currentEditId={null}
        setCurrentEditId={jest.fn()}
      />
    </RowMountProvider>
  );

  it('renders every row without a window', () => {
    renderTree(windowedTree(null));
    expect(rowIds()).toEqual(['m0', 'm1', 'm2']);
  });

  it('gates rows outside the window while the recursion continues below them', () => {
    renderTree(windowedTree({ start: 2, end: 2 }));
    expect(rowIds()).toEqual(['m2']);
  });

  it('mounts newly windowed rows above without disturbing deeper rows', () => {
    const view = renderTree(windowedTree({ start: 2, end: 2 }));
    view.rerender(windowedTree({ start: 1, end: 2 }));
    expect(rowIds()).toEqual(['m1', 'm2']);

    view.rerender(windowedTree(null));
    expect(rowIds()).toEqual(['m0', 'm1', 'm2']);
  });
});
