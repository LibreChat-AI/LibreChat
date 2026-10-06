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
};
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
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: jest.fn() }) }));
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
  useAssignConversationToProjectMutation: () => ({ mutate: mockAssign }),
  useDuplicateConversationMutation: () => ({ mutate: mockDuplicate }),
  useProjectsInfiniteQuery: (_params: unknown, config?: { enabled?: boolean }) => {
    mockProjectsConfig.current = config;
    return {
      data: mockState.projects && { pages: [{ projects: mockState.projects }] },
      isError: mockState.projectsError,
      hasNextPage: false,
      fetchNextPage: jest.fn(),
      isFetchingNextPage: false,
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
    show: true,
    hasSharedLink: false,
    items: [{ label: 'share' }, { label: 'export' }],
    dialogs: null,
  }),
}));

const setup = (readOnly = false) =>
  renderHook(() =>
    useChatOptions({ isSharedButtonEnabled: true, closeMenu: mockCloseMenu, readOnly }),
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
    const { result } = setup();

    expect(labels(result.current.items)).not.toContain('com_ui_remove_from_project');
    expect(labels(find(result.current.items, 'com_ui_change_project').subItems ?? [])).toContain(
      'com_ui_remove_from_project',
    );
  });

  it('offers removal inside the submenu only when the chat is in a project', () => {
    const { result } = setup();

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
    const { result } = setup();
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    expect(find(subItems, 'Alpha').ariaChecked).toBe(false);
    expect(find(subItems, 'Beta')).toMatchObject({ ariaChecked: true, disabled: true });
  });

  it('offers the projects as one exclusive choice', () => {
    mockState.projects = [
      { _id: 'project-1', name: 'Alpha' },
      { _id: 'project-2', name: 'Beta' },
    ];
    const { result } = setup();
    const subItems = find(result.current.items, 'com_ui_change_project').subItems ?? [];

    expect(find(subItems, 'Alpha').ariaRole).toBe('menuitemradio');
    expect(find(subItems, 'Beta').ariaRole).toBe('menuitemradio');
  });

  it('assigns the picked project and mirrors it into the open chat', () => {
    mockState.projects = [{ _id: 'project-1', name: 'Alpha' }];
    const { result } = setup();
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

  it('shows a loading row, then an empty row, then a failed row in the submenu', () => {
    const { result, rerender } = setup();
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
    const { result } = setup();

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
