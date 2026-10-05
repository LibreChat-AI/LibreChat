import { renderHook, act } from '@testing-library/react';
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
};
const mockPin = jest.fn();
const mockArchive = jest.fn();
const mockAssign = jest.fn();
const mockDuplicate = jest.fn();
const mockNavigate = jest.fn();
const mockNewConversation = jest.fn();
const mockSetConversation = jest.fn();
const mockAnnounce = jest.fn();

jest.mock('recoil', () => ({ useRecoilValue: () => mockState.conversation }));
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
}));
jest.mock('~/components/Conversations/ConvoOptions', () => ({ ProjectButton: () => null }));
jest.mock('~/components/Conversations/ConvoOptions/DeleteButton', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('~/components/Chat/Rename', () => ({ __esModule: true, default: () => null }));
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
  renderHook(() => useChatOptions({ isSharedButtonEnabled: true, closeMenu: jest.fn(), readOnly }));
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
    mockState.route = 'convo-1';
    mockState.activeJobs = [];
    mockState.startupConfig = undefined;
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

    for (const label of ['com_ui_rename', 'com_ui_change_project', 'com_ui_delete']) {
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

  it('offers removal from a project only when the chat is in one', () => {
    const { result, rerender } = setup();
    expect(labels(result.current.items)).not.toContain('com_ui_remove_from_project');

    mockState.cached = { conversationId: 'convo-1', chatProjectId: 'project-1' };
    rerender();
    expect(labels(result.current.items)).toContain('com_ui_remove_from_project');
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

    act(() => find(result.current.items, 'com_ui_remove_from_project').onClick?.({} as never));
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
    expect(find(result.current.items, 'com_ui_change_project')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'project-conversation-dialog',
    });
    expect(find(result.current.items, 'com_ui_delete')).toMatchObject({
      ariaHasPopup: 'dialog',
      ariaControls: 'delete-conversation-dialog',
    });
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
