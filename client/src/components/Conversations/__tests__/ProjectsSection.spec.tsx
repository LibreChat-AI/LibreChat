import { MemoryRouter } from 'react-router-dom';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type Page = { conversations: { conversationId: string; title: string }[]; nextCursor: null };

const mockListChats = jest.fn<Promise<Page>, [string]>();

const mockProjects = [
  { _id: 'p1', name: 'Home' },
  { _id: 'p2', name: 'Guardrails' },
];

jest.mock('~/data-provider', () => {
  const { useInfiniteQuery } = jest.requireActual('@tanstack/react-query');
  return {
    useActiveJobs: () => ({ data: undefined }),
    useProjectsInfiniteQuery: () => ({
      data: { pages: [{ projects: mockProjects, nextCursor: null }] },
      isLoading: false,
    }),
    /** The real observer, so the spec sees what a disabled query actually reports. */
    useConversationsInfiniteQuery: (params: { projectId: string }, config: object) =>
      useInfiniteQuery({
        queryKey: ['project-chats', params.projectId],
        queryFn: () => mockListChats(params.projectId),
        ...config,
      }),
  };
});

jest.mock('react-dnd', () => ({
  useDrop: () => [{ isDropOver: false, canDrop: false }, () => undefined],
}));

jest.mock('../dnd', () => ({
  CONVERSATION_DRAG_TYPE: 'conversation',
  markExternalHover: () => undefined,
  useAssignDroppedConversation: () => () => Promise.resolve(true),
  useEffectiveProjectId: () => () => null,
}));

jest.mock('recoil', () => ({ useRecoilValue: () => null }));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationIdByIndex: () => null, conversationByIndex: () => null },
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useLocalStorage: () => [true, () => undefined],
  useNewConvo: () => ({ newConversation: () => undefined }),
}));

jest.mock('~/utils', () => ({
  clearMessagesCache: () => undefined,
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  rowActionClasses: () => '',
}));

jest.mock('~/components/ui', () => ({
  Collapse: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('@librechat/client', () => ({
  Button: (props: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  Skeleton: () => <div />,
  Spinner: () => <div />,
  TooltipAnchor: ({ render: anchor }: { render: React.ReactNode }) => <>{anchor}</>,
  /** The real menu store and provider, so the trigger is Ariakit's own and adds what it adds. */
  DropdownPopup: function DropdownPopup({
    trigger,
    menuId,
    isOpen,
    setIsOpen,
  }: {
    trigger: React.ReactNode;
    menuId: string;
    isOpen: boolean;
    setIsOpen: (open: boolean) => void;
  }) {
    const Ariakit = jest.requireActual('@ariakit/react');
    const menu = Ariakit.useMenuStore({ open: isOpen, setOpen: setIsOpen });
    return (
      <Ariakit.MenuProvider store={menu}>
        {trigger}
        {isOpen && <div data-testid={`menu-${menuId}`} />}
      </Ariakit.MenuProvider>
    );
  },
  NewChatIcon: () => null,
  buttonVariants: () => '',
}));

jest.mock('~/components/Projects/ProjectCreateDialog', () => () => null);
jest.mock('~/components/Projects/ProjectDeleteDialog', () => () => null);
jest.mock('~/components/Projects/ProjectEditDialog', () => () => null);

jest.mock('../Convo', () => ({
  __esModule: true,
  default: ({ conversation }: { conversation: { title: string } }) => (
    <div>{conversation.title}</div>
  ),
}));

import ProjectsSection from '../ProjectsSection';

const renderSection = () =>
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <MemoryRouter>
        <ProjectsSection toggleNav={() => undefined} isAuthenticated />
      </MemoryRouter>
    </QueryClientProvider>,
  );

describe('ProjectsSection closed projects', () => {
  let resolveChats: (page: Page) => void;

  beforeEach(() => {
    mockListChats.mockImplementation(
      () =>
        new Promise<Page>((resolve) => {
          resolveChats = resolve;
        }),
    );
  });

  it('mounts neither skeletons nor an empty notice for a project that was never opened', () => {
    renderSection();

    expect(screen.queryByTestId('project-chats-loading-p1')).not.toBeInTheDocument();
    expect(screen.queryByTestId('project-chats-loading-p2')).not.toBeInTheDocument();
    expect(screen.queryByText('com_ui_no_project_chats')).not.toBeInTheDocument();
    expect(mockListChats).not.toHaveBeenCalled();
  });

  it('shows skeletons the moment a project opens, then its chats', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));

    expect(screen.getByTestId('project-chats-loading-p1')).toBeInTheDocument();
    expect(screen.queryByTestId('project-chats-loading-p2')).not.toBeInTheDocument();
    expect(mockListChats).toHaveBeenCalledWith('p1');

    await act(async () => {
      resolveChats({ conversations: [{ conversationId: 'c1', title: 'First' }], nextCursor: null });
    });

    expect(await screen.findByTestId('project-chats-p1')).toHaveTextContent('First');
    expect(screen.queryByTestId('project-chats-loading-p1')).not.toBeInTheDocument();
  });

  it('calls a project empty only once its chats came back empty', async () => {
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(screen.queryByText('com_ui_no_project_chats')).not.toBeInTheDocument();

    await act(async () => {
      resolveChats({ conversations: [], nextCursor: null });
    });

    expect(await screen.findByText('com_ui_no_project_chats')).toBeInTheDocument();
  });
});

describe('ProjectsSection row menus', () => {
  /** Ariakit's menu trigger is a hovercard anchor: it adds this to the document as it mounts. */
  const anchors = (listen: jest.SpyInstance) =>
    listen.mock.calls.filter(([type]) => type === 'mouseleave').length;
  const triggers = () => screen.getAllByRole('button', { name: 'com_ui_more_options' });
  const menus = () => document.querySelectorAll('[data-testid^="menu-"]');
  /** jsdom has no PointerEvent: React derives enter from `pointerover`, typed here by hand. */
  const enter = (target: Element, pointerType: string) => {
    const event = new MouseEvent('pointerover', { bubbles: true, relatedTarget: null });
    Object.defineProperty(event, 'pointerType', { value: pointerType });
    act(() => {
      target.dispatchEvent(event);
    });
  };

  let listen: jest.SpyInstance;
  beforeEach(() => {
    listen = jest.spyOn(document, 'addEventListener');
  });
  afterEach(() => {
    listen.mockRestore();
  });

  it('adds nothing to the document for rows nobody has reached', () => {
    renderSection();

    expect(triggers()).toHaveLength(2);
    expect(anchors(listen)).toBe(0);
  });

  it('mounts the real trigger for a row the mouse enters, and keeps it', () => {
    renderSection();
    const row = screen.getByRole('button', { name: 'Home' }).parentElement!;

    enter(row, 'mouse');
    expect(anchors(listen)).toBe(1);
    enter(document.body, 'mouse');
    enter(row, 'mouse');

    expect(anchors(listen)).toBe(1);
    expect(menus()).toHaveLength(0);
  });

  it('mounts the real trigger once focus reaches the row, before Tab gets to it', () => {
    renderSection();

    act(() => screen.getByRole('button', { name: 'Home' }).focus());

    expect(anchors(listen)).toBe(1);
  });

  it('keeps the placeholder through a touch, and hands its click to the real trigger', () => {
    renderSection();
    const [placeholder] = triggers();

    enter(placeholder, 'touch');
    act(() => placeholder.focus());
    expect(anchors(listen)).toBe(0);
    expect(triggers()[0]).toBe(placeholder);

    fireEvent.click(placeholder);

    expect(anchors(listen)).toBe(1);
    expect(menus()).toHaveLength(1);
    expect(triggers()[0]).not.toBe(placeholder);
    /** Ariakit took the click itself, so it knows its trigger and opened from it. */
    expect(triggers()[0]).toHaveAttribute('aria-expanded', 'true');
  });

  it.each(['ArrowDown', 'ArrowUp'])(
    'opens the menu from %s when focus came back onto the placeholder',
    (key) => {
      renderSection();
      /** Shift+Tab from the row below reaches the options button before anything else in the row. */
      const placeholder = triggers()[1];
      act(() => placeholder.focus());
      expect(anchors(listen)).toBe(0);

      fireEvent.keyDown(placeholder, { key });

      const trigger = triggers()[1];
      expect(trigger).not.toBe(placeholder);
      expect(trigger).toHaveFocus();
      expect(trigger).toHaveAttribute('aria-expanded', 'true');
      expect(menus()).toHaveLength(1);
    },
  );

  it('leaves other keys to the placeholder', () => {
    renderSection();
    const placeholder = triggers()[1];
    act(() => placeholder.focus());

    fireEvent.keyDown(placeholder, { key: 'Tab', shiftKey: true });

    expect(triggers()[1]).toBe(placeholder);
    expect(anchors(listen)).toBe(0);
  });
});
