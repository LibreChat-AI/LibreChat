import React from 'react';
import { Provider, createStore } from 'jotai';
import { ToastContext } from '@librechat/client';
import { sideChatAtom, sideChatBesideAtom } from '@librechat/chat/react';
import type { TConversation } from 'librechat-data-provider';
import { act, render, screen, waitFor, fireEvent } from 'test/layout-test-utils';
import { ChatContext } from '~/Providers/ChatContext';
import ConvoOptions from '../ConvoOptions';

/**
 * The row's real menu, opened: the production popup and items, the app's own hooks and
 * strings. Only the request for the conversation's record is replaced, at the data service.
 */
const mockGetConversation = jest.fn();
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    dataService: {
      ...actual.dataService,
      getConversationById: (...args: unknown[]) => mockGetConversation(...args),
    },
  };
});

const OPEN_BESIDE = 'Open beside chat';
const record = {
  conversationId: 'conversation-2',
  title: 'An earlier chat',
  endpoint: 'agents',
  agent_id: 'agent-1',
} as TConversation;

function setup({
  available = true,
  conversationId = 'conversation-2',
  isActiveConvo = false,
  isArchived = false,
}: {
  available?: boolean;
  conversationId?: string;
  isActiveConvo?: boolean;
  isArchived?: boolean;
} = {}) {
  const store = createStore();
  /** The reader is in `conversation-1`, with room beside it. */
  store.set(sideChatBesideAtom, available ? { conversationId: 'conversation-1' } : null);
  const showToast = jest.fn();
  const setIsPopoverActive = jest.fn();
  const chat = { index: 0, conversation: null, setConversation: jest.fn() };
  render(
    <Provider store={store}>
      <ToastContext.Provider value={{ showToast }}>
        <ChatContext.Provider value={chat as never}>
          <ConvoOptions
            conversationId={conversationId}
            title="An earlier chat"
            isArchived={isArchived}
            retainView={jest.fn()}
            renameHandler={jest.fn()}
            isPopoverActive={true}
            setIsPopoverActive={setIsPopoverActive}
            isActiveConvo={isActiveConvo}
          />
        </ChatContext.Provider>
      </ToastContext.Provider>
    </Provider>,
  );
  return { store, showToast, setIsPopoverActive };
}

const openBeside = () => screen.findByRole('menuitem', { name: OPEN_BESIDE });

describe('ConvoOptions open beside', () => {
  beforeEach(() => {
    mockGetConversation.mockReset();
  });

  it('opens the conversation as a side chat from its full record', async () => {
    mockGetConversation.mockResolvedValue(record);
    const { store, showToast, setIsPopoverActive } = setup();

    fireEvent.click(await openBeside());

    /** The row holds only an id and a title; the side chat builds its turns from the record. */
    await waitFor(() => expect(store.get(sideChatAtom)).toEqual({ conversation: record }));
    expect(mockGetConversation).toHaveBeenCalledWith('conversation-2');
    expect(setIsPopoverActive).toHaveBeenCalledWith(false);
    expect(showToast).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no chat on screen to sit beside, or side chats are off', { available: false }],
    ['the row is the chat on screen', { isActiveConvo: true }],
    ['the conversation is archived', { isArchived: true }],
  ])('is not offered when %s', async (_name, options) => {
    setup(options);

    /** The rest of the menu is there, so the item is absent and not merely late. */
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: OPEN_BESIDE })).not.toBeInTheDocument();
  });

  it('says so when the record cannot be read, and opens nothing', async () => {
    mockGetConversation.mockRejectedValue(new Error('offline'));
    const { store, showToast } = setup();

    fireEvent.click(await openBeside());

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: "This conversation couldn't be loaded." }),
      ),
    );
    expect(store.get(sideChatAtom)).toBeNull();
  });

  it('refuses a conversation that runs over routes a side chat does not drive', async () => {
    mockGetConversation.mockResolvedValue({ ...record, endpoint: 'assistants' });
    const { store, showToast } = setup();

    fireEvent.click(await openBeside());

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "This conversation can't be opened beside the chat.",
        }),
      ),
    );
    expect(store.get(sideChatAtom)).toBeNull();
  });

  describe('when the answer arrives late', () => {
    /** A record request the test answers when it chooses. */
    const slowRecord = () => {
      let land: (value: TConversation) => void = () => undefined;
      mockGetConversation.mockReturnValueOnce(
        new Promise<TConversation>((resolve) => {
          land = resolve;
        }),
      );
      return (value: TConversation = record) => act(async () => land(value));
    };

    it('opens nothing beside a chat the reader has since left', async () => {
      const land = slowRecord();
      const { store, showToast } = setup();
      fireEvent.click(await openBeside());

      /** Another chat is on screen now: what was asked for was beside the first one. */
      act(() => store.set(sideChatBesideAtom, { conversationId: 'conversation-3' }));
      await land();

      expect(store.get(sideChatAtom)).toBeNull();
      expect(showToast).not.toHaveBeenCalled();
    });

    it('does not open a conversation beside itself', async () => {
      const land = slowRecord();
      const { store } = setup();
      fireEvent.click(await openBeside());

      /** The reader opened that very conversation as the chat on screen. */
      act(() => store.set(sideChatBesideAtom, { conversationId: 'conversation-2' }));
      await land();

      expect(store.get(sideChatAtom)).toBeNull();
    });

    it('opens nothing once there is no chat left to sit beside', async () => {
      const land = slowRecord();
      const { store } = setup();
      fireEvent.click(await openBeside());

      act(() => store.set(sideChatBesideAtom, null));
      await land();

      expect(store.get(sideChatAtom)).toBeNull();
    });

    it('leaves a side chat the reader opened meanwhile where it is', async () => {
      const land = slowRecord();
      const { store } = setup();
      fireEvent.click(await openBeside());

      /** Another conversation was opened beside the chat while this record was being read. */
      const chosen = { conversation: { ...record, conversationId: 'conversation-4' } };
      act(() => store.set(sideChatAtom, chosen));
      await land();

      expect(store.get(sideChatAtom)).toEqual(chosen);
    });

    it('lets the reader’s newer choice win over an older one that answers after it', async () => {
      const landOlder = slowRecord();
      const { store } = setup();
      fireEvent.click(await openBeside());

      /** A second row's menu, asked after the first and answered before it. */
      const newer = { ...record, conversationId: 'conversation-5' };
      mockGetConversation.mockResolvedValueOnce(newer);
      render(
        <Provider store={store}>
          <ChatContext.Provider
            value={{ index: 0, conversation: null, setConversation: jest.fn() } as never}
          >
            <ConvoOptions
              conversationId="conversation-5"
              title="A newer choice"
              retainView={jest.fn()}
              renameHandler={jest.fn()}
              isPopoverActive={true}
              setIsPopoverActive={jest.fn()}
              isActiveConvo={false}
            />
          </ChatContext.Provider>
        </Provider>,
      );
      const items = await screen.findAllByRole('menuitem', { name: OPEN_BESIDE });
      fireEvent.click(items[items.length - 1]);
      await waitFor(() => expect(store.get(sideChatAtom)).toEqual({ conversation: newer }));

      await landOlder();

      expect(store.get(sideChatAtom)).toEqual({ conversation: newer });
    });
  });
});
