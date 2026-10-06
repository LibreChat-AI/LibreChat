import '@testing-library/jest-dom';
import { QueryKeys } from 'librechat-data-provider';
import { render, screen, renderHook, act } from '@testing-library/react';
import type { QueryClient } from '@tanstack/react-query';
import type { MenuItemProps } from '~/common';
import useChatOptions from '../useChatOptions';

const mockState = {
  conversation: { conversationId: 'convo-1', title: 'Hello', pinned: false } as Record<
    string,
    unknown
  >,
  cached: undefined as Record<string, unknown> | undefined,
  route: 'convo-1' as string | undefined,
  activeJobs: [] as string[],
  startupConfig: undefined as Record<string, unknown> | undefined,
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

jest.mock('recoil', () => ({ useRecoilValue: () => mockState.conversation }));
jest.mock('@tanstack/react-query', () => ({ useQueryClient: () => mockClient.current }));
jest.mock('react-router-dom', () => ({
  useNavigate: () => mockNavigate,
  useParams: () => ({ conversationId: mockState.route }),
}));
jest.mock('@librechat/client', () => ({
  Spinner: () => null,
  useToastContext: () => ({ showToast: jest.fn() }),
}));
jest.mock('~/store', () => ({ __esModule: true, default: { conversationByIndex: () => ({}) } }));
jest.mock('~/common', () => ({ NotificationSeverity: { SUCCESS: 'success', ERROR: 'error' } }));
jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNewConvo: () => ({ newConversation: mockNewConversation }),
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
}));
jest.mock('~/Providers', () => ({
  useChatContext: () => ({ setConversation: mockSetConversation }),
  useLiveAnnouncer: () => ({ announcePolite: mockAnnounce }),
}));
jest.mock('~/data-provider', () => ({
  useGetConvoIdQuery: () => ({ data: mockState.cached }),
  useGetStartupConfig: () => ({ data: mockState.startupConfig }),
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

const setup = (readOnly = false, isMenuOpen = false) =>
  renderHook(() =>
    useChatOptions({ isSharedButtonEnabled: true, closeMenu: mockCloseMenu, readOnly, isMenuOpen }),
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
    mockClient.current = new (jest.requireActual('@tanstack/react-query').QueryClient)();
    mockState.route = 'convo-1';
    mockState.activeJobs = [];
    mockState.startupConfig = undefined;
    mockState.projects = undefined;
    mockState.projectsError = false;
    mockState.hasNextPage = false;
    mockState.exportShow = true;
    mockState.fetching = false;
    mockState.fetchingNext = false;
    mockState.assigning = undefined;
    mockProjectsConfig.current = undefined;
  });

  it('lists share and export first, then the sidebar actions for the open chat', () => {
    const { result } = setup();

    expect(labels(result.current.items)).toEqual([
      'share',
      'export',
      'com_ui_rename',
      'com_ui_pin',
      'com_ui_change_project',
      'com_ui_duplicate',
      'com_ui_archive',
      'com_ui_delete',
    ]);
  });

  it('leaves out mark unread, which the open chat can never need', () => {
    const { result } = setup();

    expect(labels(result.current.items)).not.toContain('com_ui_mark_unread');
  });

  it('keeps the dialog-opening items open and anchored so their dialogs can restore focus', () => {
    const { result } = setup();

    for (const label of ['com_ui_rename', 'com_ui_delete']) {
      const item = find(result.current.items, label);
      expect(item.hideOnClick).toBe(false);
      expect(item.ref).toBeDefined();
    }
  });

  it('reads pin and archive state from the cached conversation over the chat state', () => {
    mockState.cached = { conversationId: 'convo-1', pinned: true, isArchived: true };
    const { result } = setup();

    expect(labels(result.current.items)).toEqual(
      expect.arrayContaining(['com_ui_unpin', 'com_ui_unarchive']),
    );
  });

  it('folds project removal into the change project submenu instead of a top-level item', () => {
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    const { result } = setup(false, true);

    expect(labels(result.current.items)).not.toContain('com_ui_remove_from_project');
    expect(labels(find(result.current.items, 'com_ui_change_project').subItems ?? [])).toContain(
      'com_ui_remove_from_project',
    );
  });

  it('offers removal inside the submenu only when the chat is in a project', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result } = setup(false, true);

    expect(
      labels(find(result.current.items, 'com_ui_change_project').subItems ?? []),
    ).not.toContain('com_ui_remove_from_project');
  });

  it('lists every project in the submenu and marks the current one', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-2' };
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

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
    const beta = find(find(result.current.items, 'com_ui_change_project').subItems ?? [], 'Beta');

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
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    expect(find(subItems, 'Alpha').ariaRole).toBe('menuitemradio');
    expect(find(subItems, 'Beta').ariaRole).toBe('menuitemradio');
  });

  it('assigns the picked project and mirrors it into the open chat', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

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
      { initialProps: { isMenuOpen: false } },
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
      { initialProps: { isMenuOpen: false } },
    );
    const rows = () => labels(find(result.current.items, 'com_ui_change_project').subItems ?? []);
    expect(rows()).not.toContain('Alpha');

    rerender({ isMenuOpen: true });
    expect(rows()).toContain('Alpha');
  });

  it('keeps the loaded projects and offers a retry when the next page fails', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    expect(labels(subItems)).toEqual(
      expect.arrayContaining(['Alpha', 'com_ui_projects_load_error', 'com_ui_retry']),
    );
    expect(labels(subItems)).not.toContain('com_ui_load_more');
    expect(find(subItems, 'com_ui_retry').hideOnClick).toBe(false);
  });

  it('offers a retry when the first page fails', async () => {
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    await act(async () => {
      find(subItems, 'com_ui_retry').onClick?.({} as never);
    });
    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockFetchNextPage).not.toHaveBeenCalled();
  });

  it('retries a failed refresh with a refetch when there is no next page to ask for', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = false;
    mockState.projectsError = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    await act(async () => {
      find(subItems, 'com_ui_retry').onClick?.({} as never);
    });

    expect(mockRefetch).toHaveBeenCalledTimes(1);
    expect(mockFetchNextPage).not.toHaveBeenCalled();
  });

  it('retries the page request that failed, not a refetch of the pages already held', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'com_ui_change_project').subItems ?? [];
    mockFetchNextPage.mockResolvedValueOnce({ isError: true });
    await act(async () => {
      find(rows(), 'com_ui_load_more').onClick?.({} as never);
    });
    mockState.projectsError = true;
    rerender();

    await act(async () => {
      find(rows(), 'com_ui_retry').onClick?.({} as never);
    });

    expect(mockFetchNextPage).toHaveBeenCalledTimes(2);
    expect(mockRefetch).not.toHaveBeenCalled();
  });

  it('ignores Retry while its request is already running and says so', async () => {
    mockState.projects = [];
    mockState.projectsError = true;
    mockState.fetching = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    await act(async () => {
      find(subItems, 'com_ui_loading').onClick?.({} as never);
    });

    expect(mockRefetch).not.toHaveBeenCalled();
    expect(labels(subItems)).not.toContain('com_ui_retry');
  });

  it('keeps Load more focusable and inert while the next page loads', async () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    mockState.hasNextPage = true;
    mockState.fetchingNext = true;
    const { result } = setup(false, true);
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];
    const paging = find(subItems, 'com_ui_loading');

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
    const rows = () => find(result.current.items, 'com_ui_change_project').subItems ?? [];
    const idOf = (label: string) => find(rows(), label).id;
    const before = { alpha: idOf('Alpha'), more: idOf('com_ui_load_more') };

    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
      { _id: 'project-3', name: 'Gamma' },
    ];
    rerender();

    expect(before.alpha).toBeDefined();
    expect(idOf('Alpha')).toBe(before.alpha);
    expect(idOf('com_ui_load_more')).toBe(before.more);
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
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    expect(find(subItems, 'Alpha').disabled).toBe(true);
    expect(find(subItems, 'Beta').disabled).toBe(true);
    expect(find(subItems, 'com_ui_remove_from_project').disabled).toBe(true);
  });

  it('does not fetch projects for a chat whose options group is not shown', () => {
    mockState.exportShow = false;
    renderHook(() =>
      useChatOptions({ isSharedButtonEnabled: true, closeMenu: mockCloseMenu, isMenuOpen: true }),
    );

    expect(mockProjectsConfig.current?.enabled).toBe(false);
  });

  it('shows a loading row, then an empty row, then a failed row in the submenu', () => {
    const { result, rerender } = setup(false, true);
    const rows = () => find(result.current.items, 'com_ui_change_project').subItems ?? [];
    expect(rows()[0]).toMatchObject({ label: 'com_ui_loading', disabled: true });

    mockState.projects = [];
    rerender();
    expect(rows()[0]).toMatchObject({ label: 'com_ui_no_projects', disabled: true });

    mockState.projects = undefined;
    mockState.projectsError = true;
    rerender();
    expect(rows()[0]).toMatchObject({ label: 'com_ui_projects_load_error', disabled: true });
  });

  it('pins an unpinned chat', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'com_ui_pin').onClick?.({} as never));

    expect(mockPin).toHaveBeenCalledWith(
      { conversationId: 'convo-1', pinned: true },
      expect.any(Object),
    );
  });

  it('mirrors a landed pin into the open chat when no cached conversation carries it', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'com_ui_pin').onClick?.({} as never));
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

    act(() => find(result.current.items, 'com_ui_pin').onClick?.({} as never));
    act(() => mockPin.mock.calls[0][1].onSuccess());

    const [updater] = mockSetConversation.mock.calls[0];
    const other = { conversationId: 'convo-2', pinned: false };
    expect(updater(other)).toBe(other);
  });

  it('mirrors a landed project removal into the open chat', () => {
    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    const { result } = setup(false, true);

    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];
    act(() => find(subItems, 'com_ui_remove_from_project').onClick?.({} as never));
    act(() => mockAssign.mock.calls[0][1].onSuccess());

    expect(mockAssign.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', projectId: null });
    const [updater] = mockSetConversation.mock.calls[0];
    expect(updater({ conversationId: 'convo-1', chatProjectId: 'project-1' })).toEqual({
      conversationId: 'convo-1',
      chatProjectId: null,
    });
  });

  it('offers only share and export on a read-only subagent thread', () => {
    const { result } = setup(true);

    expect(labels(result.current.items)).toEqual(['share', 'export']);
  });

  it('disables rename while the chat is generating without title ownership support', () => {
    mockState.activeJobs = ['convo-1'];
    const { result } = setup();

    expect(find(result.current.items, 'com_ui_rename').disabled).toBe(true);
  });

  it('keeps rename enabled while generating when the deployment supports title ownership', () => {
    mockState.activeJobs = ['convo-1'];
    mockState.startupConfig = {
      conversationTitleOwnershipVersion: 1,
      interface: { runningChatRename: true },
    };
    const { result } = setup();

    expect(find(result.current.items, 'com_ui_rename').disabled).toBe(false);
  });

  it('keeps rename enabled for a chat that is not generating', () => {
    const { result } = setup();

    expect(find(result.current.items, 'com_ui_rename').disabled).toBe(false);
  });

  it('stays on a chat opened while the archive request was in flight', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_archive').onClick?.({} as never));
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
      'com_ui_rename',
      'com_ui_duplicate',
      'com_ui_delete',
    ]);
  });

  it('tells assistive technology which items open a dialog', () => {
    const { result } = setup();

    expect(find(result.current.items, 'com_ui_rename')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'rename-conversation-dialog',
    });
    expect(find(result.current.items, 'com_ui_delete')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'delete-conversation-dialog',
    });
  });

  it('closes an open dialog when another chat becomes the open one', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_rename').onClick?.({} as never));
    const { rerender: rerenderDialogs } = render(<>{result.current.dialogs}</>);
    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();

    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    rerenderDialogs(<>{result.current.dialogs}</>);

    expect(screen.queryByTestId('rename-dialog')).not.toBeInTheDocument();
  });

  it('does not reopen a dialog when the first chat comes back', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_delete').onClick?.({} as never));
    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    mockState.conversation = { conversationId: 'convo-1', title: 'Hello' };
    rerender();
    render(<>{result.current.dialogs}</>);

    expect(screen.queryByTestId('delete-dialog')).not.toBeInTheDocument();
  });

  it('tells the delete dialog which chat is open when the request settles', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_delete').onClick?.({} as never));
    render(<>{result.current.dialogs}</>);
    const props = mockDeleteProps.current;
    mockState.route = 'convo-2';
    rerender();

    expect(props?.getCurrentConversationId()).toBe('convo-2');
  });

  it('keeps a newer chat dialog open when an earlier delete settles', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_delete').onClick?.({} as never));
    const first = render(<>{result.current.dialogs}</>);
    const settleEarlierDelete = mockDeleteProps.current?.setShowDeleteDialog;
    first.unmount();
    mockState.route = 'convo-2';
    mockState.conversation = { conversationId: 'convo-2', title: 'Other' };
    rerender();
    act(() => find(result.current.items, 'com_ui_rename').onClick?.({} as never));
    act(() => settleEarlierDelete?.(false));
    render(<>{result.current.dialogs}</>);

    expect(screen.getByTestId('rename-dialog')).toBeInTheDocument();
  });

  it('dismisses the menu and dialogs when the route moves before the chat state does', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_rename').onClick?.({} as never));
    mockCloseMenu.mockClear();
    mockState.route = 'convo-2';
    rerender();
    render(<>{result.current.dialogs}</>);

    expect(mockCloseMenu).toHaveBeenCalled();
    expect(screen.queryByTestId('rename-dialog')).not.toBeInTheDocument();
  });

  it('does not let a delete that settles later close the menu of the chat opened since', () => {
    const { result, rerender } = setup();

    act(() => find(result.current.items, 'com_ui_delete').onClick?.({} as never));
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

    act(() => find(result.current.items, 'com_ui_delete').onClick?.({} as never));
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

    expect(labels(result.current.items)).toContain('com_ui_unpin');
  });

  it('leaves an archived chat for a new one once the archive lands', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'com_ui_archive').onClick?.({} as never));
    expect(mockArchive.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', isArchived: true });
    act(() => mockArchive.mock.calls[0][1].onSuccess());

    expect(mockNewConversation).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('/c/new', { replace: true });
  });

  it('stays on a chat it just restored from the archive', () => {
    mockState.cached = { conversationId: 'convo-1', isArchived: true };
    const { result } = setup();

    act(() => find(result.current.items, 'com_ui_unarchive').onClick?.({} as never));
    act(() => mockArchive.mock.calls[0][1].onSuccess());

    expect(mockArchive.mock.calls[0][0]).toEqual({ conversationId: 'convo-1', isArchived: false });
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockNewConversation).not.toHaveBeenCalled();
  });

  it('duplicates the open chat', () => {
    const { result } = setup();

    act(() => find(result.current.items, 'com_ui_duplicate').onClick?.({} as never));

    expect(mockDuplicate).toHaveBeenCalledWith({ conversationId: 'convo-1' });
  });
});
