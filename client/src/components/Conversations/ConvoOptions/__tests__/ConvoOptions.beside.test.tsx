import React from 'react';
import { Provider, createStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sideChatAtom, sideChatAvailableAtom } from '@librechat/chat/react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';
import ConvoOptions from '../ConvoOptions';

const mockGetConversation = jest.fn();
const mockShowToast = jest.fn();
const mockSetIsPopoverActive = jest.fn();

jest.mock('@ariakit/react', () => ({
  MenuButton: jest
    .requireActual('react')
    .forwardRef(
      (
        { children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>,
        ref: React.ForwardedRef<HTMLButtonElement>,
      ) => (
        <button ref={ref} {...props}>
          {children}
        </button>
      ),
    ),
}));
jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  rowActionClasses: () => 'row-action',
}));
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
/** The menu as the items that are offered: an item whose `show` is false is not one. */
jest.mock('@librechat/client', () => ({
  DropdownPopup: ({
    trigger,
    items,
  }: {
    trigger: React.ReactNode;
    items: Array<{ label: string; onClick: () => void; show?: boolean }>;
  }) => (
    <>
      {trigger}
      {items
        .filter((item) => item.show !== false)
        .map((item) => (
          <button key={item.label} type="button" onClick={item.onClick}>
            {item.label}
          </button>
        ))}
    </>
  ),
  Spinner: () => <span role="status" />,
  buttonVariants: () => '',
  useToastContext: () => ({ showToast: mockShowToast }),
  useMediaQuery: () => false,
  useRemScale: () => 1,
}));
jest.mock('~/data-provider', () => ({
  useDeleteConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useArchiveConvoMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  usePinConversationMutation: () => ({ mutate: jest.fn(), isLoading: false }),
  useMarkConversationUnreadMutation: () => ({ mutate: jest.fn(), isLoading: false }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: jest.fn() }),
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ index: 0, conversation: null, setConversation: jest.fn() }),
  useLiveAnnouncer: () => ({ announcePolite: jest.fn() }),
}));
jest.mock('../DeleteButton', () => () => null);

const OPEN_BESIDE = 'com_ui_side_chat_open_beside';
const record = {
  conversationId: 'conversation-2',
  title: 'An earlier chat',
  endpoint: 'agents',
  agent_id: 'agent-1',
};

function setup({
  available = true,
  isActiveConvo = false,
  isArchived = false,
}: { available?: boolean; isActiveConvo?: boolean; isArchived?: boolean } = {}) {
  const store = createStore();
  store.set(sideChatAvailableAtom, available);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <Provider store={store}>
        <MemoryRouter initialEntries={['/c/conversation-1']}>
          <ConvoOptions
            conversationId="conversation-2"
            title="An earlier chat"
            isArchived={isArchived}
            retainView={jest.fn()}
            renameHandler={jest.fn()}
            isPopoverActive={true}
            setIsPopoverActive={mockSetIsPopoverActive}
            isActiveConvo={isActiveConvo}
          />
        </MemoryRouter>
      </Provider>
    </QueryClientProvider>,
  );
  return { store };
}

describe('ConvoOptions open beside', () => {
  beforeEach(() => {
    mockGetConversation.mockReset();
    mockShowToast.mockReset();
    mockSetIsPopoverActive.mockReset();
  });

  it('opens the conversation as a side chat from its full record', async () => {
    mockGetConversation.mockResolvedValue(record);
    const { store } = setup();

    fireEvent.click(screen.getByRole('button', { name: OPEN_BESIDE }));

    /** The row holds only an id and a title; the side chat builds its turns from the record. */
    await waitFor(() => expect(store.get(sideChatAtom)).toEqual({ conversation: record }));
    expect(mockGetConversation).toHaveBeenCalledWith('conversation-2');
    expect(mockSetIsPopoverActive).toHaveBeenCalledWith(false);
    expect(mockShowToast).not.toHaveBeenCalled();
  });

  it.each([
    ['there is no chat on screen to sit beside, or side chats are off', { available: false }],
    ['the row is the chat on screen', { isActiveConvo: true }],
    ['the conversation is archived', { isArchived: true }],
  ])('is not offered when %s', (_name, options) => {
    setup(options);

    expect(screen.queryByRole('button', { name: OPEN_BESIDE })).not.toBeInTheDocument();
    /** The rest of the menu is still there. */
    expect(screen.getByRole('button', { name: 'com_ui_rename' })).toBeInTheDocument();
  });

  it('says so when the record cannot be read, and opens nothing', async () => {
    mockGetConversation.mockRejectedValue(new Error('offline'));
    const { store } = setup();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: OPEN_BESIDE }));
    });

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_side_chat_load_error' }),
      ),
    );
    expect(store.get(sideChatAtom)).toBeNull();
  });

  it('refuses a conversation that runs over routes a side chat does not drive', async () => {
    mockGetConversation.mockResolvedValue({ ...record, endpoint: 'assistants' });
    const { store } = setup();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: OPEN_BESIDE }));
    });

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'com_ui_side_chat_unsupported' }),
      ),
    );
    expect(store.get(sideChatAtom)).toBeNull();
  });
});
