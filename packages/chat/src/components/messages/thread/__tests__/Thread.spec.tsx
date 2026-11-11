/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { EModelEndpoint } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { MessagesHost } from '../../../../react/messages/host';
import type { ChatContract } from '../../../../react/chat/contract';
import type { MessagePartsHost } from '../../../../react/host';
import type { MessagesViewProps } from '../../MessagesView';
import { createMessagesHost } from '../../../../__fixtures__/messagesHost';
import { MessagesHostProvider } from '../../../../react/messages/host';
import { MessagePartsHostProvider } from '../../../../react/host';
import { ChatContext } from '../../../../react/chat/context';
import { initEnglish } from '../../../../__fixtures__/i18n';
import { resolveThreadRows } from '../../../../core/thread';
import { siblingIdxFamily } from '../../../../react/thread';
import MessagesView from '../../MessagesView';

/** Wrap the real resolver so calls are recorded and rows still resolve. */
jest.mock('../../../../core/thread', () => {
  const actual = jest.requireActual('../../../../core/thread');
  return { ...actual, resolveThreadRows: jest.fn(actual.resolveThreadRows) };
});

beforeAll(initEnglish);

const ROOT = '00000000-0000-0000-0000-000000000000';

function message(messageId: string, parentMessageId: string, extra: Partial<TMessage> = {}) {
  return {
    messageId,
    parentMessageId,
    conversationId: 'convo-1',
    text: messageId,
    isCreatedByUser: messageId.startsWith('u'),
    ...extra,
  } as TMessage;
}

/** u1 -> (a1-old, a1): one branched reply. */
const branched = (): TMessage[] => [
  message('u1', ROOT),
  message('a1-old', 'u1'),
  message('a1', 'u1'),
];

/** The same conversation as the nested tree the recursive renderer reads. */
const branchedTree = (): TMessage[] => {
  const [user, older, newer] = branched();
  return [{ ...user, children: [older, newer] }];
};

const partsHost: MessagePartsHost = {
  useMessage: () => ({ messageId: '' }),
  renderMarkdown: ({ content }) => <p>{content}</p>,
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

const renderActivity = jest.fn<null, Parameters<MessagesHost['renderActivity']>>(() => null);

function createHost(overrides: Partial<MessagesHost> = {}): MessagesHost {
  return createMessagesHost({
    renderMessageBody: ({ text }) => <p>{text}</p>,
    renderFiles: (row) => <span>{row.files?.map((file) => file.filename).join(',')}</span>,
    renderActivity: (props) => {
      renderActivity(props);
      return <aside aria-label={`Activity ${props.parentMessageIds.join(',')}`} />;
    },
    ...overrides,
  });
}

const contract = {
  index: 0,
  isSubmitting: false,
  latestMessageDepth: 0,
  messagesKey: 'convo-1',
  conversation: { conversationId: 'convo-1', endpoint: EModelEndpoint.agents },
} as ChatContract;

function renderThread(
  props: Partial<MessagesViewProps>,
  host: MessagesHost = createHost(),
  store = createStore(),
) {
  const queryClient = new QueryClient();
  const view = (next: Partial<MessagesViewProps>) => (
    <Provider store={store}>
      <QueryClientProvider client={queryClient}>
        <ChatContext.Provider value={contract}>
          <MessagesHostProvider host={host}>
            <MessagePartsHostProvider host={partsHost}>
              <MessagesView
                showScrollButton={false}
                maximizeChatSpace={false}
                {...props}
                {...next}
              />
            </MessagePartsHostProvider>
          </MessagesHostProvider>
        </ChatContext.Provider>
      </QueryClientProvider>
    </Provider>
  );
  const result = render(view({}));
  return {
    ...result,
    rerenderThread: (next: Partial<MessagesViewProps>) => result.rerender(view(next)),
  };
}

/** The real row is a labelled group whose id is the message id. */
const rowElements = () => screen.queryAllByRole('group', { name: /^Message/ });
const rows = () => rowElements().map((element) => element.id);
const row = (id: string) => {
  const element = rowElements().find((candidate) => candidate.id === id);
  if (element == null) {
    throw new Error(`No row rendered for ${id}`);
  }
  return element;
};
const position = (id: string) => within(row(id)).queryByRole('status')?.textContent;
const previous = (id: string) =>
  within(row(id)).getByRole('button', { name: 'Previous sibling message' });
const next = (id: string) => within(row(id)).getByRole('button', { name: 'Next sibling message' });
const edit = (id: string) => within(row(id)).getByRole('button', { name: 'Edit' });

beforeEach(() => {
  renderActivity.mockClear();
  jest.mocked(resolveThreadRows).mockClear();
});

describe('MessagesView default thread', () => {
  it('renders the flat rows from the messages by default', () => {
    renderThread({ messages: branched(), messagesTree: [message('from-tree', ROOT)] });
    expect(rows()).toEqual(['u1', 'a1']);
  });

  it('renders the recursive tree when the flat thread is off', () => {
    renderThread({
      flatThread: false,
      messages: [message('from-messages', ROOT)],
      messagesTree: branchedTree(),
    });
    expect(rows()).toEqual(['u1', 'a1']);
  });

  it.each([true, false])('switches siblings through the row slot (flat %s)', (flatThread) => {
    renderThread({ flatThread, messages: branched(), messagesTree: branchedTree() });
    expect(position('a1')).toBe('2 / 2');
    /** A lone turn has no siblings, so the real switch is not rendered at all. */
    expect(position('u1')).toBeUndefined();

    fireEvent.click(previous('a1'));
    expect(rows()).toEqual(['u1', 'a1-old']);
    expect(position('a1-old')).toBe('1 / 2');

    fireEvent.click(next('a1-old'));
    expect(rows()).toEqual(['u1', 'a1']);
    expect(position('a1')).toBe('2 / 2');
  });

  it.each([true, false])(
    'anchors activity after the reply and hides it while an anchor is edited (flat %s)',
    (flatThread) => {
      renderThread({ flatThread, messages: branched(), messagesTree: branchedTree() });
      expect(renderActivity).toHaveBeenLastCalledWith({
        conversationId: 'convo-1',
        parentMessageIds: ['a1', 'u1'],
        hasParallelContent: false,
      });
      expect(
        screen.getAllByRole('complementary').map((group) => group.getAttribute('aria-label')),
      ).toEqual(['Activity a1,u1']);

      fireEvent.click(edit('u1'));
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

      fireEvent.click(edit('u1'));
      expect(screen.getByRole('complementary', { name: 'Activity a1,u1' })).toBeInTheDocument();
    },
  );

  it('anchors activity on a user turn that has no reply yet', () => {
    renderThread({ messages: [message('u1', ROOT)] });
    expect(screen.getByRole('complementary', { name: 'Activity u1' })).toBeInTheDocument();
  });

  it("hydrates a row's files from the host's file map", () => {
    const fileMap = { f1: { file_id: 'f1', filename: 'hydrated.txt' } as TFile };
    renderThread(
      { messages: [message('u1', ROOT, { files: [{ file_id: 'f1' }] })] },
      createHost({ useFileMap: () => fileMap }),
    );
    expect(within(row('u1')).getByText('hydrated.txt')).toBeInTheDocument();
  });

  it('does not reuse outgoing rows while the conversation context still names the source', () => {
    /** Real rows mount for every message, so the outgoing thread stays modest. */
    const large = Array.from({ length: 60 }, (_, index) =>
      message(`large-${index}`, index === 0 ? ROOT : `large-${index - 1}`),
    );
    const view = renderThread({ messages: large, messagesTree: large });
    const small = [message('small', ROOT, { conversationId: 'convo-2' })];
    view.rerenderThread({ messages: small, messagesTree: small });

    expect(resolveThreadRows).toHaveBeenLastCalledWith(
      expect.anything(),
      'convo-2',
      expect.anything(),
      null,
    );
  });

  it('preserves the destination root branch while the context still names the source', () => {
    const store = createStore();
    store.set(siblingIdxFamily('convo-2'), 1);
    const destination = [
      message('older-root', ROOT, { conversationId: 'convo-2' }),
      message('newer-root', ROOT, { conversationId: 'convo-2' }),
    ];
    renderThread({ messages: destination, messagesTree: destination }, createHost(), store);

    expect(rows()).toEqual(['older-root']);
    expect(store.get(siblingIdxFamily('convo-2'))).toBe(1);
  });

  it('keys the recursive root selection to the rendered conversation too', () => {
    const store = createStore();
    store.set(siblingIdxFamily('convo-2'), 1);
    const destination = [
      message('older-root', ROOT, { conversationId: 'convo-2' }),
      message('newer-root', ROOT, { conversationId: 'convo-2' }),
    ];
    renderThread(
      { flatThread: false, messages: destination, messagesTree: destination },
      createHost(),
      store,
    );

    expect(rows()).toEqual(['older-root']);
  });
});
