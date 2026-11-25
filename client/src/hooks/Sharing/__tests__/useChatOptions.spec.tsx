import '@testing-library/jest-dom';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, QueryKeys, interfaceSchema } from 'librechat-data-provider';
import { render, screen, renderHook, act, within } from '@testing-library/react';
import type { RecoilValue } from 'recoil';
import type { ReactNode } from 'react';
import type { MenuItemProps } from '~/common';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import { startupConfigKey } from '~/data-provider/Endpoints/queries';
import { clockFormatAtom } from '~/store/clockFormat';
import useChatOptions from '../useChatOptions';
import store from '~/store';
import '~/locales/i18n';

const mockState = {
  conversation: { conversationId: 'convo-1', title: 'Hello', pinned: false } as Record<
    string,
    unknown
  >,
  cached: undefined as Record<string, unknown> | undefined,
  route: 'convo-1' as string | undefined,
  activeJobs: [] as string[],
  canRenameRunningChat: false,
  projects: undefined as { _id: string; name: string }[] | undefined,
  projectsError: false,
  hasNextPage: false,
  exportShow: true,
  fetching: false,
  fetchingNext: false,
  assigning: undefined as { projectId: string | null } | undefined,
};
const mockFetchNextPage = jest.fn(() => Promise.resolve({ isError: false }));
const mockRefetch = jest.fn(() => Promise.resolve({ isError: false }));
const mockProjectsConfig: { current?: { enabled?: boolean } } = {};
const mockClient: { current: QueryClient | null } = { current: null };
const mockCloseMenu = jest.fn();
const mockPin = jest.fn();
const mockArchive = jest.fn();
const mockAssign = jest.fn();
const mockDuplicate = jest.fn();
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockSetConversation = jest.fn();
const mockAnnounce = jest.fn();
let jotaiStore: ReturnType<typeof createStore>;

jest.mock('recoil', () => {
  const recoil = jest.requireActual<typeof import('recoil')>('recoil');
  return {
    ...recoil,
    useRecoilValue: (atom: RecoilValue<unknown>) => {
      const value = recoil.useRecoilValue(atom);
      const conversationAtom = jest
        .requireActual<typeof import('~/store')>('~/store')
        .default.conversationByIndex(0);
      return atom === conversationAtom ? mockState.conversation : value;
    },
  };
});
jest.mock('react-router-dom', () => ({
  ...jest.requireActual('react-router-dom'),
  useNavigate: () => mockNavigate,
  useParams: () => ({ conversationId: mockState.route }),
}));
jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  Spinner: () => null,
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/hooks', () => ({
  useLocalize: jest.requireActual('~/hooks/useLocalize').default,
  useCopyToClipboard: jest.requireActual('~/hooks/Messages/useCopyToClipboard').default,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ setConversation: mockSetConversation }),
  useLiveAnnouncer: () => ({ announcePolite: mockAnnounce }),
}));
jest.mock('~/data-provider', () => ({
  useCachedMessages: jest.requireActual('~/data-provider/Messages/queries').useCachedMessages,
  useGetStartupConfig: jest.requireActual('~/data-provider/Endpoints/queries').useGetStartupConfig,
  useGetConvoIdQuery: () => ({ data: mockState.cached }),
  useActiveJobs: () => ({ data: { activeJobIds: mockState.activeJobs } }),
  usePinConversationMutation: () => ({ mutate: mockPin }),
  useArchiveConvoMutation: () => ({ mutate: mockArchive }),
  useAssignConversationToProjectMutation: () => ({
    mutate: mockAssign,
    isLoading: mockState.assigning != null,
    variables: mockState.assigning,
  }),
  useDuplicateConversationMutation: () => ({ mutate: mockDuplicate }),
  useProjectsInfiniteQuery: (_params: unknown, config?: { enabled?: boolean }) => {
    mockProjectsConfig.current = config;
    return {
      data: mockState.projects && { pages: [{ projects: mockState.projects }] },
      isError: mockState.projectsError,
      hasNextPage: mockState.hasNextPage,
      fetchNextPage: mockFetchNextPage,
      refetch: mockRefetch,
      isFetching: mockState.fetching,
      isFetchingNextPage: mockState.fetchingNext,
    };
  },
}));
const mockDeleteProps: {
  current?: {
    setShowDeleteDialog: (open: boolean) => void;
    setMenuOpen: (open: boolean) => void;
    getCurrentConversationId: () => string | undefined;
  };
} = {};
jest.mock('~/components/Conversations/ConvoOptions/DeleteButton', () => ({
  __esModule: true,
  default: (props: NonNullable<typeof mockDeleteProps.current>) => {
    mockDeleteProps.current = props;
    return <div data-testid="delete-dialog" />;
  },
}));
jest.mock('~/components/Chat/Rename', () => ({
  __esModule: true,
  default: () => <div data-testid="rename-dialog" />,
}));
jest.mock('../useExportShare', () => ({
  __esModule: true,
  default: () => ({
    show: mockState.exportShow,
    hasSharedLink: false,
    items: [{ label: 'share' }, { label: 'export' }],
    dialogs: null,
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={mockClient.current!}>
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, true)}>
      <Provider store={jotaiStore}>
        <ChatSettingsContext.Provider
          value={{
            ...defaultChatSettings,
            config: {
              ...defaultChatSettings.config,
              canRenameRunningChat: mockState.canRenameRunningChat,
            },
          }}
        >
          {children}
        </ChatSettingsContext.Provider>
      </Provider>
    </RecoilRoot>
  </QueryClientProvider>
);

const setup = (readOnly = false, isMenuOpen = false) =>
  renderHook(
    () =>
      useChatOptions({
        isSharedButtonEnabled: true,
        closeMenu: mockCloseMenu,
        readOnly,
        isMenuOpen,
      }),
    { wrapper },
  );
const labels = (items: MenuItemProps[]) =>
  items.filter((item) => item.show !== false && item.separate !== true).map((item) => item.label);
const find = (items: MenuItemProps[], label: string) => {
  const item = items.find((entry) => entry.label === label);
  if (item == null) {
    throw new Error(`no ${label} item`);
  }
  return item;
};

describe('useChatOptions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockState.conversation = { conversationId: 'convo-1', title: 'Hello', pinned: false };
    mockState.cached = undefined;
    mockClient.current = new QueryClient({
      defaultOptions: { queries: { retry: false, cacheTime: Infinity } },
    });
    mockClient.current.setQueryData(startupConfigKey(false), {
      interface: interfaceSchema.parse({ contextUsage: true, contextCost: false }),
    });
    mockState.route = 'convo-1';
    mockState.activeJobs = [];
    mockState.canRenameRunningChat = false;
    mockState.projects = undefined;
    mockState.projectsError = false;
    mockState.hasNextPage = false;
    mockState.exportShow = true;
    mockState.fetching = false;
    mockState.fetchingNext = false;
    mockState.assigning = undefined;
    mockProjectsConfig.current = undefined;
    jotaiStore = createStore();
    jotaiStore.set(clockFormatAtom, '24h');
  });

  afterEach(() => mockClient.current?.clear());

  it('lists share and export first, then the sidebar actions for the open chat', () => {
    const { result } = setup();

    expect(labels(result.current.items)).toEqual([
      'share',
      'export',
      'Conversation info',
      'Rename',
      'Pin',
      'Change project',
      'Duplicate',
      'Archive',
      'Delete',
    ]);
  });

  it('leaves out mark unread, which the open chat can never need', () => {
    const { result } = setup();

    expect(labels(result.current.items)).not.toContain('Mark as unread');
  });

  it('keeps the dialog-opening items open and anchored so their dialogs can restore focus', () => {
    const { result } = setup();

    for (const label of ['Conversation info', 'Rename', 'Delete']) {
      const item = find(result.current.items, label);
      expect(item.hideOnClick).toBe(false);
      expect(item.ref).toBeDefined();
    }
  });

  it('reads pin and archive state from the cached conversation over the chat state', () => {
    mockState.cached = { conversationId: 'convo-1', pinned: true, isArchived: true };
    const { result } = setup();

    expect(labels(result.current.items)).toEqual(expect.arrayContaining(['Unpin', 'Unarchive']));
  });

  it('folds project removal into the change project submenu instead of a top-level item', () => {
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    const { result } = setup(false, true);

    expect(labels(result.current.items)).not.toContain('Remove from project');
    expect(labels(find(result.current.items, 'Change project').subItems ?? [])).toContain(
      'Remove from project',
    );
  });

  it('offers removal inside the submenu only when the chat is in a project', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result } = setup(false, true);

    expect(labels(find(result.current.items, 'Change project').subItems ?? [])).not.toContain(
      'Remove from project',
    );
  });

  it('lists every project in the submenu and marks the current one', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-2' };
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    expect(find(subItems, 'Alpha').ariaChecked).toBe(false);
    expect(find(subItems, 'Beta')).toMatchObject({ ariaChecked: true });
  });

  it('keeps the checked project in the arrow-key order and does not reassign it', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-2' };
    const { result } = setup(false, true);
    const beta = find(find(result.current.items, 'Change project').subItems ?? [], 'Beta');

    /** Ariakit drops a `disabled` item from keyboard navigation, and this is the row a keyboard
     *  or screen-reader user has to find. */
    expect(beta.disabled).not.toBe(true);
    act(() => beta.onClick?.({} as never));
    expect(mockAssign).not.toHaveBeenCalled();
  });

  it('offers the projects as one exclusive choice', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    expect(find(subItems, 'Alpha').ariaRole).toBe('menuitemradio');
    expect(find(subItems, 'Beta').ariaRole).toBe('menuitemradio');
  });

  it('assigns the picked project and mirrors it into the open chat', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    act(() => find(subItems, 'Alpha').onClick?.({} as never));
    act(() => mockAssign.mock.calls[0][1].onSuccess());

    expect(mockAssign.mock.calls[0][0]).toEqual({
      conversationId: 'convo-1',
      projectId: 'project-1',
    });
    const [updater] = mockSetConversation.mock.calls[0];
    expect(updater({ conversationId: 'convo-1' })).toEqual({
      conversationId: 'convo-1',
      chatProjectId: 'project-1',
    });
  });

  it('fetches the project list only while the menu is open', () => {
    const { rerender } = renderHook(
      ({ isMenuOpen }) =>
        useChatOptions({ isSharedButtonEnabled: true, closeMenu: mockCloseMenu, isMenuOpen }),
      { initialProps: { isMenuOpen: false }, wrapper },
    );
    expect(mockProjectsConfig.current?.enabled).toBe(false);

    rerender({ isMenuOpen: true });
    expect(mockProjectsConfig.current?.enabled).toBe(true);
  });

  it('builds no project rows while the menu is closed, even when the list is cached', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result, rerender } = renderHook(
      ({ isMenuOpen }) =>
        useChatOptions({ isSharedButtonEnabled: true, closeMenu: mockCloseMenu, isMenuOpen }),
      { initialProps: { isMenuOpen: false }, wrapper },
    );
    const rows = () => labels(find(result.current.items, 'Change project').subItems ?? []);
    expect(rows()).not.toContain('Alpha');

    rerender({ isMenuOpen: true });
    expect(rows()).toContain('Alpha');
  });

  it('keeps the loaded projects and offers a retry when the next page fails', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    expect(labels(subItems)).toEqual(
      expect.arrayContaining(['Alpha', 'Could not load projects', 'Retry']),
    );
    expect(labels(subItems)).not.toContain('Load more');
    expect(find(subItems, 'Retry').hideOnClick).toBe(false);
  });

  it('retries with a refetch when an automatic refresh failed after a failed Load more', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'Change project').subItems ?? [];
    mockFetchNextPage.mockResolvedValueOnce({ isError: true });
    await act(async () => {
      find(rows(), 'Load more').onClick?.({} as never);
    });

    /** A remount or a window focus refetches the held pages without anyone clicking: that, not
     *  the earlier page request, is what failed when the error shows up now. */
    mockState.fetching = true;
    rerender();
    mockState.fetching = false;
    mockState.projectsError = true;
    rerender();
    await act(async () => {
      find(rows(), 'Retry').onClick?.({} as never);
    });

    expect(mockFetchNextPage).toHaveBeenCalledTimes(1);
    expect(mockRefetch).toHaveBeenCalledTimes(1);
  });

  it('offers a retry when the first page fails', async () => {
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    await act(async () => {
      find(subItems, 'Retry').onClick?.({} as never);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockFetchNextPage).not.toHaveBeenCalled();
  });

  it('retries a failed refresh with a refetch when there is no next page to ask for', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = false;
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    await act(async () => {
      find(subItems, 'Retry').onClick?.({} as never);
    });

    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockFetchNextPage).not.toHaveBeenCalled();
  });

  it('retries the page request that failed, not a refetch of the pages already held', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'Change project').subItems ?? [];
    mockFetchNextPage.mockResolvedValueOnce({ isError: true });
    await act(async () => {
      find(rows(), 'Load more').onClick?.({} as never);
    });
    mockState.projectsError = true;
    rerender();

    await act(async () => {
      find(rows(), 'Retry').onClick?.({} as never);
    });

    expect(mockFetchNextPage).toHaveBeenCalledTimes(2);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('ignores Retry while its request is already running and says so', async () => {
    mockState.projects = [];
    mockState.projectsError = true;
    mockState.fetching = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    await act(async () => {
      find(subItems, 'Loading...').onClick?.({} as never);
    });

    expect(mockRefetch).not.toHaveBeenCalled();
    expect(labels(subItems)).not.toContain('Retry');
  });

  it('keeps Load more focusable and inert while the next page loads', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    mockState.fetchingNext = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];
    const paging = find(subItems, 'Loading...');

    /** A disabled item is dropped from keyboard navigation, taking the focus off the control the
     *  user just activated. */
    expect(paging.disabled).not.toBe(true);
    await act(async () => {
      paging.onClick?.({} as never);
    });
    expect(mockFetchNextPage).not.toHaveBeenCalled();
  });

  it('gives every row a stable id so a focused control survives appended pages', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'Change project').subItems ?? [];
    const idOf = (label: string) => find(rows(), label).id;
    const before = { alpha: idOf('Alpha'), more: idOf('Load more') };

    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
      { _id: 'project-3', name: 'Gamma' },
    ];
    rerender();

    expect(before.alpha).toBeDefined();
    expect(idOf('Alpha')).toBe(before.alpha);
    expect(idOf('Load more')).toBe(before.more);
    const ids = rows()
      .filter((row) => row.separate !== true)
      .map((row) => row.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('disables every destination and shows the pending one while an assignment runs', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-2' };
    mockState.assigning = { projectId: 'project-1' };
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'Change project').subItems ?? [];

    expect(find(subItems, 'Alpha').disabled).toBe(true);
    expect(find(subItems, 'Beta').disabled).toBe(true);
    expect(find(subItems, 'Remove from project').disabled).toBe(true);
  });

  it('does not fetch projects for a chat whose options group is not shown', () => {
    mockState.exportShow = false;
    setup(false, true);

    expect(mockProjectsConfig.current?.enabled).toBe(false);
  });

  it('shows a loading row, then an empty row, then a failed row in the submenu', () => {
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'Change project').subItems ?? [];
    expect(rows()[0]).toMatchObject({ label: 'Loading...', disabled: true });

    mockState.projects = [];
    rerender();
    expect(rows()[0]).toMatchObject({ label: 'No projects yet', disabled: true });

    mockState.projects = undefined;
    mockState.projectsError = true;
    rerender();
    expect(rows()[0]).toMatchObject({ label: 'Could not load projects', disabled: true });
  });

  it('pins an unpinned chat', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Pin').onClick?.({} as never));

    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'convo-1', pinned: true },
      expect.any(Object),
    );
  });

  it('mirrors a landed pin into the open chat when no cached conversation carries it', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Pin').onClick?.({} as never));
    act(() => mockPin.mock.calls[0][1].onSuccess());

    expect(mockSetConversation).toHaveBeenCalledTimes(1);
    const [updater] = mockSetConversation.mock.calls[0];
    expect(updater({ conversationId: 'convo-1', pinned: false })).toEqual({
      conversationId: 'convo-1',
      pinned: true,
    });
  });

  it('does not touch another chat opened while the pin was in flight', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Pin').onClick?.({} as never));
    act(() => mockPin.mock.calls[0][1].onSuccess());

    const [updater] = mockSetConversation.mock.calls[0];
    const other = { conversationId: 'convo-2', pinned: false };
    expect(updater(other)).toBe(other);
  });

  it('mirrors a landed project removal into the open chat', () => {
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    const { result } = setup(false, true);

    const subItems = find(result.current.items, 'Change project').subItems ?? [];
    act(() => find(subItems, 'Remove from project').onClick?.({} as never));
    act(() => mockAssign.mock.calls[0][1].onSuccess());

    expect(mockAssign.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', projectId: null });
    const [updater] = mockSetConversation.mock.calls[0];
    expect(updater({ conversationId: 'convo-1', chatProjectId: 'project-1' })).toEqual({
      conversationId: 'convo-1',
      chatProjectId: null,
    });
  });

  it('offers share, export, and info on a read-only subagent thread', () => {
    const { result } = setup(true);

    expect(labels(result.current.items)).toEqual(['share', 'export', 'Conversation info']);
  });

  it.each([
    { readOnly: false, contextUsage: true, contextCost: false },
    { readOnly: true, contextUsage: true, contextCost: false },
    { readOnly: false, contextUsage: false, contextCost: false },
    { readOnly: false, contextUsage: true, contextCost: true },
  ])(
    'opens real conversation info, readOnly=$readOnly usage=$contextUsage cost=$contextCost',
    async ({ readOnly, contextUsage, contextCost }) => {
      jotaiStore.set(clockFormatAtom, readOnly ? '12h' : '24h');
      mockState.conversation.updatedAt = '2026-11-05T15:00:00';
      const client = mockClient.current!;
      client.setQueryData(startupConfigKey(false), {
        interface: interfaceSchema.parse({
          contextUsage,
          contextCost,
          currency: { code: 'EUR', rate: 2 },
        }),
      });
      client.setQueryData(
        [QueryKeys.messages, 'convo-1'],
        [
          {
            conversationId: 'convo-1',
            messageId: 'reply-1',
            parentMessageId: 'user-1',
            text: 'Hello',
            sender: 'Assistant',
            isCreatedByUser: false,
            metadata: { usage: { input: 42, output: 7, cost: 0.01 } },
          },
        ],
      );
      const { result, rerender } = setup(readOnly);
      const item = find(result.current.items, 'Conversation info');
      expect(item.ariaHasPopup).toBe('dialog');
      expect(item.render).toBeDefined();
      act(() => item.onClick?.({} as never));
      const { rerender: rerenderDialogs } = render(<>{result.current.dialogs}</>, {
        wrapper: ({ children }) => (
          <QueryClientProvider client={client}>
            <MemoryRouter>
              <Provider store={jotaiStore}>{children}</Provider>
            </MemoryRouter>
          </QueryClientProvider>
        ),
      });
      const dialog = await screen.findByRole('dialog', { name: 'Conversation info' });
      expect(within(dialog).getByText('convo-1')).toBeVisible();
      if (contextUsage) {
        expect(within(dialog).getByText('42')).toBeVisible();
      } else {
        expect(within(dialog).queryByTestId('conversation-total-usage')).not.toBeInTheDocument();
      }
      if (contextCost) {
        expect(within(dialog).getByTestId('usage-cost')).toHaveTextContent('€0.02');
      } else {
        expect(within(dialog).queryByTestId('usage-cost')).not.toBeInTheDocument();
      }
      expect(within(dialog).getByText('Last updated').nextElementSibling).toHaveTextContent(
        readOnly ? '3:00 PM' : '15:00',
      );

      mockState.route = 'convo-2';
      rerender();
      rerenderDialogs(<>{result.current.dialogs}</>);
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      expect(labels(result.current.items)).not.toContain('Conversation info');
    },
  );

  it.each(['', Constants.NEW_CONVO, Constants.PENDING_CONVO, Constants.SEARCH] as const)(
    'hides conversation info for an unsaved conversation: %s',
    (conversationId) => {
      mockState.conversation = { conversationId };
      mockState.route = conversationId;
      const { result } = setup();
      expect(labels(result.current.items)).not.toContain('Conversation info');
    },
  );

  it('disables rename while the chat is generating without title ownership support', () => {
    mockState.activeJobs = ['convo-1'];
    const { result } = setup();

    expect(find(result.current.items, 'Rename').disabled).toBe(true);
  });

  it('keeps rename enabled while generating when the deployment supports title ownership', () => {
    mockState.activeJobs = ['convo-1'];
    mockState.canRenameRunningChat = true;
    const { result } = setup();

    expect(find(result.current.items, 'Rename').disabled).toBe(false);
  });

  it('keeps rename enabled for a chat that is not generating', () => {
    const { result } = setup();

    expect(find(result.current.items, 'Rename').disabled).toBe(false);
  });

  it('stays on a chat opened while the archive request was in flight', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Archive').onClick?.({} as never));
    mockState.route = 'convo-2';
    rerender();
    act(() => mockArchive.mock.calls[0][1].onSuccess());

    expect(mockNewConversation).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('hides history-only actions for a temporary chat', () => {
    mockState.conversation = {
      conversationId: 'convo-1',
      title: 'Hello',
      isTemporary: true,
      chatProjectId: 'project-1',
    };
    const { result } = setup();

    expect(labels(result.current.items)).toEqual([
      'share',
      'export',
      'Conversation info',
      'Rename',
      'Duplicate',
      'Delete',
    ]);
  });

  it('tells assistive technology which items open a dialog', () => {
    const { result } = setup();

    expect(find(result.current.items, 'Rename')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'rename-conversation-dialog',
    });
    expect(find(result.current.items, 'Delete')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'delete-conversation-dialog',
    });
  });

  it('closes an open dialog when another chat becomes the open one', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Rename').onClick?.({} as never));
    const { rerender: rerenderDialogs } = render(<>{result.current.dialogs}</>);
    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();

    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    rerenderDialogs(<>{result.current.dialogs}</>);

    expect(screen.queryByTestId('rename-dialog')).not.toBeInTheDocument();
  });

  it('does not reopen a dialog when the first chat comes back', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Delete').onClick?.({} as never));
    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    mockState.conversation = { conversationId: 'convo-1', title: 'Hello' };
    rerender();
    render(<>{result.current.dialogs}</>);

    expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument();
  });

  it('tells the delete dialog which chat is open when the request settles', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Delete').onClick?.({} as never));
    render(<>{result.current.dialogs}</>);
    const props = mockDeleteProps.current;
    mockState.route = 'convo-2';
    rerender();

    expect(props?.getCurrentConversationId()).toBe('convo-2');
  });

  it('keeps a newer chat dialog open when an earlier delete settles', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Delete').onClick?.({} as never));
    const first = render(<>{result.current.dialogs}</>);
    const settleEarlierDelete = mockDeleteProps.current?.setShowDeleteDialog;
    first.unmount();
    mockState.route = 'convo-2';
    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    act(() => find(result.current.items, 'Rename').onClick?.({} as never));
    act(() => settleEarlierDelete?.(false));
    render(<>{result.current.dialogs}</>);

    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();
  });

  it('dismisses the menu and dialogs when the route moves before the chat state does', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Rename').onClick?.({} as never));
    mockCloseMenu.mockClear();
    mockState.route = 'convo-2';
    rerender();
    render(<>{result.current.dialogs}</>);

    expect(mockCloseMenu).toHaveBeenCalled();
    expect(screen.queryByTestId('rename-dialog')).not.toBeInTheDocument();
  });

  it('does not let a delete that settles later close the menu of the chat opened since', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'Delete').onClick?.({} as never));
    render(<>{result.current.dialogs}</>);
    const settleEarlierDelete = mockDeleteProps.current?.setMenuOpen;
    mockState.route = 'convo-2';
    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    mockCloseMenu.mockClear();
    act(() => settleEarlierDelete?.(false));

    expect(mockCloseMenu).not.toHaveBeenCalled();
  });

  it('closes the menu when the delete of the open chat settles', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Delete').onClick?.({} as never));
    render(<>{result.current.dialogs}</>);
    mockCloseMenu.mockClear();
    act(() => mockDeleteProps.current?.setMenuOpen(false));

    expect(mockCloseMenu).toHaveBeenCalledTimes(1);
  });

  it('prefers the newest cached copy over an older point entry', () => {
    const client = mockClient.current as QueryClient;
    client.setQueryData(
      [QueryKeys.conversation, 'convo-1'],
      { conversationId: 'convo-1', pinned: false },
      { updatedAt: Date.now() - 1000 },
    );
    client.setQueryData(
      [QueryKeys.allConversations],
      {
        pages: [{ conversations: [{ conversationId: 'convo-1', pinned: true }], nextCursor: null }],
        pageParams: [undefined],
      },
      { updatedAt: Date.now() },
    );
    mockState.cached = { conversationId: 'convo-1', pinned: false };
    const { result } = setup();

    expect(labels(result.current.items)).toContain('Unpin');
  });

  it('leaves an archived chat for a new one once the archive lands', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Archive').onClick?.({} as never));
    expect(mockArchive.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', isArchived: true });
    act(() => mockArchive.mock.calls[0][1].onSuccess());

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  it('stays on a chat it just restored from the archive', () => {
    mockState.cached = { conversationId: 'convo-1', isArchived: true };
    const { result } = setup();

    act(() => find(result.current.items, 'Unarchive').onClick?.({} as never));
    act(() => mockArchive.mock.calls[0][1].onSuccess());

    expect(mockArchive.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', isArchived: false });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });

  it('duplicates the open chat', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'Duplicate').onClick?.({} as never));

    expect(mockDuplicate).toHaveBeenCalledWith({ conversationId: 'convo-1' });
  });
});
