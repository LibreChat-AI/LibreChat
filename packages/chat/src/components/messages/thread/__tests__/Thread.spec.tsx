/**
 * @jest-environment jsdom
 */
import { Provider, createStore } from 'jotai';
import { fireEvent, render, screen, within } from '@testing-library/react';
import type { TFile, TMessage } from 'librechat-data-provider';
import type { MessagesHost } from '../../../../react/messages/host';
import type { ChatContract } from '../../../../react/chat/contract';
import type { MessagePartsHost } from '../../../../react/host';
import type { MessagesViewProps } from '../../MessagesView';
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

const partsHost = { useFontSize: () => 'text-base' } as unknown as MessagePartsHost;

const renderActivity = jest.fn<null, Parameters<MessagesHost['renderActivity']>>(() => null);

function createHost(overrides: Partial<MessagesHost> = {}): MessagesHost {
  return {
    useHour12: () => undefined,
    renderFiles: () => null,
    useScrolling: () => ({
      contentRef: { current: null },
      scrollableRef: { current: null },
      messagesEndRef: { current: null },
      handleSmoothToRef: () => undefined,
      debouncedHandleScroll: () => undefined,
      handleNearBottomChange: () => undefined,
    }),
    useScreenshotTarget: () => undefined,
    useAutoScroll: () => false,
    useConversationSeen: () => () => undefined,
    renderMessageRow: ({
      message: row,
      siblingIdx,
      siblingCount,
      setSiblingIdx,
      setCurrentEditId,
    }) => (
      <article aria-label={row.messageId} data-sibling={`${siblingIdx + 1} / ${siblingCount}`}>
        <span>{row.files?.map((file) => file.filename).join(',')}</span>
        <button aria-label="Previous" onClick={() => setSiblingIdx(siblingIdx - 1)} />
        <button aria-label="Next" onClick={() => setSiblingIdx(siblingIdx + 1)} />
        <button aria-label="Edit" onClick={() => setCurrentEditId(row.messageId)} />
        <button aria-label="Cancel" onClick={() => setCurrentEditId(-1)} />
      </article>
    ),
    renderActivity: (props) => {
      renderActivity(props);
      return <aside aria-label={`Activity ${props.parentMessageIds.join(',')}`} />;
    },
    useFileMap: () => undefined,
    ...overrides,
  };
}

const contract = {
  index: 0,
  isSubmitting: false,
  latestMessageDepth: 0,
  messagesKey: 'convo-1',
} as ChatContract;

function renderThread(
  props: Partial<MessagesViewProps>,
  host: MessagesHost = createHost(),
  store = createStore(),
) {
  const view = (next: Partial<MessagesViewProps>) => (
    <Provider store={store}>
      <ChatContext.Provider value={contract}>
        <MessagesHostProvider host={host}>
          <MessagePartsHostProvider host={partsHost}>
            <MessagesView showScrollButton={false} maximizeChatSpace={false} {...props} {...next} />
          </MessagePartsHostProvider>
        </MessagesHostProvider>
      </ChatContext.Provider>
    </Provider>
  );
  const result = render(view({}));
  return {
    ...result,
    rerenderThread: (next: Partial<MessagesViewProps>) => result.rerender(view(next)),
  };
}

const rows = () => screen.queryAllByRole('article').map((row) => row.getAttribute('aria-label'));
const row = (id: string) => screen.getByRole('article', { name: id });

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
    expect(row('a1')).toHaveAttribute('data-sibling', '2 / 2');
    expect(row('u1')).toHaveAttribute('data-sibling', '1 / 1');

    fireEvent.click(within(row('a1')).getByRole('button', { name: 'Previous' }));
    expect(rows()).toEqual(['u1', 'a1-old']);
    expect(row('a1-old')).toHaveAttribute('data-sibling', '1 / 2');

    fireEvent.click(within(row('a1-old')).getByRole('button', { name: 'Next' }));
    expect(rows()).toEqual(['u1', 'a1']);
    expect(row('a1')).toHaveAttribute('data-sibling', '2 / 2');
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

      fireEvent.click(within(row('u1')).getByRole('button', { name: 'Edit' }));
      expect(screen.queryByRole('complementary')).not.toBeInTheDocument();

      fireEvent.click(within(row('u1')).getByRole('button', { name: 'Cancel' }));
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
    const large = Array.from({ length: 12_000 }, (_, index) =>
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
