/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { Constants, StepTypes, StepEvents, ContentTypes } from 'librechat-data-provider';
import type { TMessage, ChatEvent, TConversation } from 'librechat-data-provider';
import type { ReactElement } from 'react';
import type { ChatStream, ChatTransport, ChatStreamStatus } from '../../../core';
import type { ChatContract } from '../../../react/chat/contract';
import type { FollowChatOptions } from '../../../react/follow';
import { inertSeenSource, MessagesHostProvider } from '../../../react/messages/host';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { useIsMessagesViewReadOnly } from '../../../react/messages/view';
import { createMessagesHost } from '../../../__fixtures__/messagesHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { MessagePartsHostProvider } from '../../../react/host';
import { useChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import { useFollowChat } from '../../../react/follow';
import FollowedThread from '../Followed';

beforeAll(initEnglish);

type TestStream = ChatStream & { push(event: ChatEvent): void; closed: boolean };

const createStream = (): TestStream => {
  const queued: ChatEvent[] = [];
  let wake: (() => void) | undefined;
  const stream: TestStream = {
    closed: false,
    push(event) {
      queued.push(event);
      wake?.();
    },
    close() {
      stream.closed = true;
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queued.length > 0) {
          yield queued.shift() as ChatEvent;
        }
        if (stream.closed) {
          return;
        }
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
  };
  return stream;
};

const createTransport = (initial: ChatStreamStatus) => {
  const streams: TestStream[] = [];
  let status = initial;
  const transport: ChatTransport = {
    sendMessages: jest.fn(() => Promise.reject(new Error('view only'))),
    abort: jest.fn(() => Promise.reject(new Error('view only'))),
    getStatus: async () => status,
    reconnectToStream: async () => {
      if (!status.active) {
        return null;
      }
      const stream = createStream();
      streams.push(stream);
      return stream;
    },
  };
  return {
    transport,
    streams,
    setStatus: (next: ChatStreamStatus) => {
      status = next;
    },
  };
};

const brief: TMessage = {
  messageId: 'task-1:user',
  conversationId: 'thread-1',
  parentMessageId: Constants.NO_PARENT as string,
  isCreatedByUser: true,
  text: 'Research this',
};

const answer = (id: string, parentMessageId: string, text: string): TMessage => ({
  messageId: id,
  conversationId: 'thread-1',
  parentMessageId,
  isCreatedByUser: false,
  text: '',
  content: [{ type: ContentTypes.TEXT, text }],
});

const snapshot = (text: string): ChatEvent =>
  ({
    type: 'sync',
    data: {
      sync: true,
      resumeState: {
        conversationId: 'thread-1',
        responseMessageId: 'task-1:assistant',
        userMessage: { ...brief },
        runSteps: [
          {
            id: 's0',
            runId: 'task-1:assistant',
            index: 0,
            type: StepTypes.MESSAGE_CREATION,
            stepDetails: {
              type: StepTypes.MESSAGE_CREATION,
              message_creation: { message_id: 's0' },
            },
            usage: null,
          },
        ],
        aggregatedContent: [{ type: ContentTypes.TEXT, text }],
      },
    },
  }) as ChatEvent;

const token = (text: string): ChatEvent =>
  ({
    type: 'step',
    data: {
      event: StepEvents.ON_MESSAGE_DELTA,
      data: { id: 's0', delta: { content: [{ type: ContentTypes.TEXT, text }] } },
    },
  }) as ChatEvent;

const final = (text: string): ChatEvent =>
  ({
    type: 'final',
    data: {
      final: true,
      conversation: { conversationId: 'thread-1' },
      requestMessage: brief,
      responseMessage: answer('task-1:assistant', 'task-1:user', text),
    },
  }) as ChatEvent;

const partsText = (content: ReadonlyArray<object | undefined> | undefined): string =>
  (content ?? []).map((part) => (part as { text?: string } | undefined)?.text ?? '').join('');

/**
 * Rows render as `id=text`, so a spec reads which messages the real thread drew, and with what.
 * A text turn draws through the messages host and a content turn through the parts host, as in
 * the app.
 */
/** The page's read state, which a list asks for when reading it can mark a conversation seen. */
const pageSeenSource = jest.fn(() => inertSeenSource);
const messagesHost = createMessagesHost({
  useSeenSource: pageSeenSource,
  renderMessageBody: ({ message }) => (
    <div data-testid="row">{`${message.messageId}=${message.text ?? ''}`}</div>
  ),
});
const partsHost = createMessagePartsHost({
  renderContentParts: ({ messageId, content }) => (
    <div data-testid="row">{`${messageId}=${partsText(content)}`}</div>
  ),
});
const conversation = { conversationId: 'thread-1', endpoint: 'agents' } as TConversation;

let contract: ChatContract | undefined;
let viewReadOnly: boolean | undefined;

/** Reads the chat contract and the view mode the rows see, from inside the list. */
function ContractProbe(): null {
  contract = useChatContext();
  viewReadOnly = useIsMessagesViewReadOnly();
  return null;
}

function Pane({
  transport,
  loadMessages,
  nav,
}: {
  transport: ChatTransport;
  loadMessages: FollowChatOptions['loadMessages'];
  nav?: boolean;
}): ReactElement {
  const followed = useFollowChat({ id: 'thread-1', transport, loadMessages });
  return (
    <FollowedThread
      id="thread-1"
      index={2}
      followed={followed}
      conversation={conversation}
      slots={{
        renderScrollButton: () => <ContractProbe />,
        ...(nav ? { renderNav: () => <div data-testid="rail" /> } : {}),
      }}
    />
  );
}

const mount = (ui: ReactElement) =>
  render(
    <QueryClientProvider client={new QueryClient()}>
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
          <MessagesHostProvider host={messagesHost}>
            <MessagePartsHostProvider host={partsHost}>{ui}</MessagePartsHostProvider>
          </MessagesHostProvider>
        </ChatSurfaceProvider>
      </Provider>
    </QueryClientProvider>,
  );

const rows = () => screen.queryAllByTestId('row').map((row) => row.textContent);

const settle = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });

describe('FollowedThread', () => {
  beforeEach(() => {
    contract = undefined;
    viewReadOnly = undefined;
  });

  it("draws the stored conversation with main chat's thread", async () => {
    const { transport } = createTransport({ active: false });
    const stored = [brief, answer('task-1:assistant', 'task-1:user', 'Done')];
    mount(<Pane transport={transport} loadMessages={async () => stored} />);

    await waitFor(() =>
      expect(rows()).toEqual(['task-1:user=Research this', 'task-1:assistant=Done']),
    );
    expect(contract).toMatchObject({
      index: 2,
      messagesKey: 'thread-1',
      readOnly: true,
      isSubmitting: false,
      latestMessageId: 'task-1:assistant',
      conversation: { conversationId: 'thread-1' },
    });
    expect(contract?.getMessages()).toEqual(stored);
  });

  it("marks nothing seen: the thread is not a conversation of the reader's", async () => {
    pageSeenSource.mockClear();
    const { transport } = createTransport({ active: false });
    const stored = [brief, answer('task-1:assistant', 'task-1:user', 'Done')];
    mount(<Pane transport={transport} loadMessages={async () => stored} />);
    await waitFor(() => expect(rows()).toHaveLength(2));

    expect(pageSeenSource).not.toHaveBeenCalled();
  });

  it('tells its rows the view is read-only, so host-bound actions in them stay off', async () => {
    const { transport } = createTransport({ active: false });
    mount(<Pane transport={transport} loadMessages={async () => [brief]} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    expect(viewReadOnly).toBe(true);
  });

  it('draws a running generation as it streams, then the stored result', async () => {
    const { transport, streams, setStatus } = createTransport({ active: true });
    const loadMessages = jest.fn(async () => [brief]);
    mount(<Pane transport={transport} loadMessages={loadMessages} />);
    await waitFor(() => expect(streams).toHaveLength(1));

    act(() => streams[0].push(snapshot('Hel')));
    act(() => streams[0].push(token('lo')));
    await settle();

    expect(rows()).toEqual(['task-1:user=Research this', 'task-1:assistant=Hello']);
    expect(contract?.isSubmitting).toBe(true);
    expect(contract?.latestMessageId).toBe('task-1:assistant');

    loadMessages.mockResolvedValue([
      brief,
      answer('task-1:assistant', 'task-1:user', 'Hello, stored'),
    ]);
    setStatus({ active: false });
    act(() => streams[0].push(final('Hello')));
    await waitFor(() =>
      expect(rows()).toEqual(['task-1:user=Research this', 'task-1:assistant=Hello, stored']),
    );
    expect(contract?.isSubmitting).toBe(false);
  });

  it('takes no turn: sending, regenerating and stopping reach nothing', async () => {
    const { transport } = createTransport({ active: false });
    mount(<Pane transport={transport} loadMessages={async () => [brief]} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    await act(async () => {
      contract?.ask({ text: 'hello' });
      contract?.regenerate({ parentMessageId: 'task-1:user' });
      await contract?.stopGenerating();
    });

    expect(transport.sendMessages).not.toHaveBeenCalled();
    expect(transport.abort).not.toHaveBeenCalled();
    expect(rows()).toEqual(['task-1:user=Research this']);
  });

  it("leaves the page's end marker and screenshot target to the main list", async () => {
    const { transport } = createTransport({ active: false });
    mount(<Pane transport={transport} loadMessages={async () => [brief]} />);
    await waitFor(() => expect(rows()).toHaveLength(1));

    expect(document.getElementById('messages-end')).toBeNull();
    expect(screen.queryByTestId('screenshot-target')).toBeNull();
  });

  it('leaves the navigation rail out unless a host supplies one', async () => {
    const { transport } = createTransport({ active: false });
    const load = async () => [brief];
    const { unmount } = mount(<Pane transport={transport} loadMessages={load} />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.queryByTestId('rail')).toBeNull();
    unmount();

    mount(<Pane transport={transport} loadMessages={load} nav />);
    await waitFor(() => expect(rows()).toHaveLength(1));
    expect(screen.getByTestId('rail')).toBeInTheDocument();
  });

  describe('a conversation longer than one page', () => {
    /** Four stored turns, served two rows at a time from the end. */
    const stored = [
      brief,
      answer('task-1:assistant', 'task-1:user', 'One'),
      {
        ...brief,
        messageId: 'task-2:user',
        parentMessageId: 'task-1:assistant',
        text: 'And then?',
      },
      answer('task-2:assistant', 'task-2:user', 'Two'),
    ];
    const paged = () =>
      jest.fn(async (cursor?: string) => {
        const end = cursor == null ? stored.length : Number(cursor);
        const start = Math.max(0, end - 2);
        return { messages: stored.slice(start, end), earlier: start > 0 ? String(start) : null };
      });
    const earlier = () => screen.queryByRole('button', { name: 'Show earlier messages' });

    it('offers the rows before the newest page, and draws them above it', async () => {
      const { transport } = createTransport({ active: false });
      mount(<Pane transport={transport} loadMessages={paged()} />);
      await waitFor(() =>
        expect(rows()).toEqual(['task-2:user=And then?', 'task-2:assistant=Two']),
      );

      const control = earlier();
      expect(control).toBeInTheDocument();
      /** Ahead of the first row drawn, where the older rows will go. */
      expect(
        control!.compareDocumentPosition(screen.getAllByTestId('row')[0]) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();

      fireEvent.click(control!);
      await waitFor(() =>
        expect(rows()).toEqual([
          'task-1:user=Research this',
          'task-1:assistant=One',
          'task-2:user=And then?',
          'task-2:assistant=Two',
        ]),
      );
      /** The first row is in: there is nothing earlier to offer. */
      expect(earlier()).not.toBeInTheDocument();
    });

    it('says it is loading, and cannot be asked twice', async () => {
      const { transport } = createTransport({ active: false });
      const loadMessages = paged();
      mount(<Pane transport={transport} loadMessages={loadMessages} />);
      await waitFor(() => expect(earlier()).toBeInTheDocument());
      let land: (page: { messages: TMessage[]; earlier: null }) => void = () => undefined;
      loadMessages.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            land = resolve;
          }),
      );

      fireEvent.click(earlier()!);
      const busy = await screen.findByRole('button', { name: 'Loading...' });
      expect(busy).toBeDisabled();
      expect(busy).toHaveAttribute('aria-busy', 'true');
      fireEvent.click(busy);
      expect(loadMessages).toHaveBeenCalledTimes(2);

      await act(async () => land({ messages: stored.slice(0, 2), earlier: null }));
      await waitFor(() => expect(rows()).toHaveLength(4));
    });

    it('says when the earlier rows could not be read, and tries again', async () => {
      const { transport } = createTransport({ active: false });
      const loadMessages = paged();
      mount(<Pane transport={transport} loadMessages={loadMessages} />);
      await waitFor(() => expect(earlier()).toBeInTheDocument());
      loadMessages.mockRejectedValueOnce(new Error('offline'));

      fireEvent.click(earlier()!);
      expect(await screen.findByRole('alert')).toHaveTextContent(
        "Earlier messages couldn't be loaded.",
      );
      expect(rows()).toHaveLength(2);

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(rows()).toHaveLength(4));
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('draws nothing above a conversation that fits one page', async () => {
      const { transport } = createTransport({ active: false });
      mount(<Pane transport={transport} loadMessages={async () => stored} />);
      await waitFor(() => expect(rows()).toHaveLength(4));

      expect(earlier()).not.toBeInTheDocument();
    });
  });
});
