import { render, screen } from '@testing-library/react';
import type { MenuItemProps } from '~/common';

const mockAccess: Record<string, boolean> = {};
const mockBookmarkArgs: { enabled?: boolean }[] = [];
const mockHookState = {
  multiConvo: { show: true, addConversation: jest.fn() },
  temporary: { show: true, isTemporary: false, toggle: jest.fn() },
  bookmarks: {
    show: true,
    items: [{ id: 'tag-1', label: 'work' }] as MenuItemProps[],
    bookmarks: [],
    hasBookmarks: false,
    isLoading: false,
    triggerAriaLabel: 'bookmarks',
    dialog: <div data-testid="bookmark-dialog" />,
  },
  exportShare: {
    show: true,
    items: [{ label: 'share' }, { label: 'export' }] as MenuItemProps[],
    hasSharedLink: false,
    dialogs: <div data-testid="export-dialogs" />,
  },
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useHasAccess: ({ permissionType }: { permissionType: string }) =>
    mockAccess[permissionType] ?? true,
}));

jest.mock('~/hooks/Chat/useMultiConvo', () => ({
  __esModule: true,
  default: () => mockHookState.multiConvo,
}));
jest.mock('~/hooks/Chat/useTemporaryChat', () => ({
  __esModule: true,
  default: () => mockHookState.temporary,
}));
jest.mock('~/hooks/Chat/useBookmarkItems', () => ({
  __esModule: true,
  default: (args: { enabled?: boolean } = {}) => {
    mockBookmarkArgs.push(args);
    return mockHookState.bookmarks;
  },
}));
jest.mock('~/hooks/Chat/useExportShare', () => ({
  __esModule: true,
  default: () => mockHookState.exportShare,
}));

/** The real MenuButton needs the MenuProvider that DropdownPopup supplies, which is mocked out below. */
jest.mock('@ariakit/react', () => ({
  MenuButton: ({
    children,
    render: _render,
    ...props
  }: React.ComponentProps<'button'> & { render?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

/**
 * Mirrors DropdownPopup's real contract: `separate` entries render as a divider
 * *instead of* an item, and `show: false` entries are dropped. A looser mock
 * hides the bug where a flag on an actionable item silently deletes it.
 */
jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
  TooltipAnchor: ({ render: node }: { render: React.ReactNode }) => node,
  DropdownPopup: ({ trigger, items }: { trigger: React.ReactNode; items: MenuItemProps[] }) => (
    <div>
      {trigger}
      <ul data-testid="menu-items">
        {items
          .filter((item) => item.show !== false)
          .map((item, index) =>
            item.separate === true ? (
              <li key={index} data-kind="separator" />
            ) : (
              <li key={index} data-kind="item" data-sub={item.subItems != null}>
                {item.label}
              </li>
            ),
          )}
      </ul>
    </div>
  ),
}));

import HeaderMenu from '../HeaderMenu';

const rows = () => Array.from(screen.getByTestId('menu-items').children);
const labels = () =>
  rows()
    .filter((node) => node.getAttribute('data-kind') === 'item')
    .map((node) => node.textContent);

describe('HeaderMenu', () => {
  beforeEach(() => {
    mockBookmarkArgs.length = 0;
    for (const key of Object.keys(mockAccess)) {
      delete mockAccess[key];
    }
    mockHookState.multiConvo.show = true;
    mockHookState.temporary.show = true;
    mockHookState.bookmarks.show = true;
    mockHookState.exportShare.show = true;
    mockHookState.exportShare.hasSharedLink = false;
    mockHookState.temporary.isTemporary = false;
  });

  it('collapses every secondary action behind one trigger', () => {
    render(<HeaderMenu />);

    expect(screen.getByTestId('header-overflow-menu')).toBeInTheDocument();
    expect(labels()).toEqual([
      'com_ui_bookmarks',
      'com_ui_add_multi_conversation',
      'share',
      'export',
      'com_ui_temporary',
    ]);
  });

  it('keeps every action reachable when groups are divided', () => {
    render(<HeaderMenu />);

    /** A divider is its own entry; flagging an action as one deletes it. */
    expect(labels()).toContain('share');
    expect(labels()).toContain('com_ui_temporary');
    expect(rows().filter((node) => node.getAttribute('data-kind') === 'separator')).toHaveLength(2);
  });

  it('nests bookmarks rather than flattening every tag into the top level', () => {
    render(<HeaderMenu />);

    expect(rows()[0]).toHaveAttribute('data-sub', 'true');
  });

  it('renders nothing when no action survives its gate', () => {
    mockHookState.multiConvo.show = false;
    mockHookState.temporary.show = false;
    mockHookState.bookmarks.show = false;
    mockHookState.exportShare.show = false;

    render(<HeaderMenu />);

    expect(screen.queryByTestId('header-overflow-menu')).not.toBeInTheDocument();
  });

  it('drops actions the user lacks permission for', () => {
    mockAccess.BOOKMARKS = false;
    mockAccess.MULTI_CONVO = false;

    render(<HeaderMenu />);

    expect(labels()).toEqual(['share', 'export', 'com_ui_temporary']);
  });

  it('never opens with a leading divider when earlier groups are gated out', () => {
    mockAccess.BOOKMARKS = false;
    mockAccess.MULTI_CONVO = false;

    render(<HeaderMenu />);

    expect(rows()[0]).toHaveAttribute('data-kind', 'item');
  });

  it('does not query bookmark tags without the bookmark permission', () => {
    mockAccess.BOOKMARKS = false;

    render(<HeaderMenu />);

    expect(mockBookmarkArgs.every((args) => args.enabled === false)).toBe(true);
  });

  it('keeps surfacing an active shared link on the collapsed trigger', () => {
    mockHookState.exportShare.hasSharedLink = true;

    render(<HeaderMenu />);

    /** Distinct from the desktop menu's indicator; both are mounted at once. */
    expect(screen.getByTestId('header-menu-shared-link-indicator')).toBeInTheDocument();
    expect(screen.getByTestId('header-overflow-menu')).toHaveAttribute(
      'aria-label',
      'com_ui_export_share_link_active',
    );
  });

  it('offers the trace in its own group only when the header says one is available', () => {
    const { rerender } = render(<HeaderMenu trace={{ show: false, open: jest.fn() }} />);
    expect(labels()).not.toContain('com_ui_trace_view');

    rerender(<HeaderMenu trace={{ show: true, open: jest.fn() }} />);

    expect(labels()).toEqual([
      'com_ui_bookmarks',
      'com_ui_add_multi_conversation',
      'com_ui_trace_view',
      'share',
      'export',
      'com_ui_temporary',
    ]);
    expect(rows().filter((node) => node.getAttribute('data-kind') === 'separator')).toHaveLength(3);
  });

  it('keeps the trace reachable when it is the only action left', () => {
    mockHookState.multiConvo.show = false;
    mockHookState.temporary.show = false;
    mockHookState.bookmarks.show = false;
    mockHookState.exportShare.show = false;

    render(<HeaderMenu trace={{ show: true, open: jest.fn() }} />);

    expect(labels()).toEqual(['com_ui_trace_view']);
    expect(rows()[0]).toHaveAttribute('data-kind', 'item');
  });

  it('shows temporary chat as active to sighted users, not just assistive tech', () => {
    mockHookState.temporary.isTemporary = true;

    render(<HeaderMenu />);

    const temporaryRow = rows().find((node) => node.textContent === 'com_ui_temporary');
    expect(temporaryRow).toBeDefined();
    expect(labels()).toContain('com_ui_temporary');
  });
});
