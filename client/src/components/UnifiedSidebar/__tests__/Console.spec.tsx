import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { BarChart3, MessagesSquare, NotebookPen } from 'lucide-react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { ConsoleProps } from '../Console';
import type { NavLink } from '~/common';
import { filesDialogTriggerAtom, showFilesDialogAtom } from '~/store/filesDialog';
import { settingsOpenAtom } from '~/components/Nav/Settings';
import Console from '../Console';

const mockNewChat = jest.fn();
const mockLogout = jest.fn();
let mockShowMarketplace = true;

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useShowMarketplace: () => mockShowMarketplace,
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: () => ({ user: { name: 'Test User' }, logout: mockLogout }),
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: {} }),
}));

jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutAriaKey: (key: string) => (key === 'newChat' ? 'Control+Shift+O' : 'Control+B'),
  useShortcutHint: (_key: string, label: string) => label,
}));

jest.mock('~/hooks/Conversations/useNewChat', () => ({
  __esModule: true,
  default: ({ onNewChat }: { onNewChat?: () => void } = {}) => ({
    handleNewChatClick: (event: React.MouseEvent<HTMLElement>) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      event.preventDefault();
      mockNewChat();
      onNewChat?.();
    },
  }),
}));

jest.mock('~/store', () => {
  const { atom } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      showShortcutsDialog: atom({ key: 'console-shortcuts-dialog', default: false }),
    },
  };
});

jest.mock('~/components/Nav/SettingsTabs/General/ArchivedChatsModal', () => ({
  ArchivedChatsModal: () => null,
}));

jest.mock('~/components/Chat/Menus/OpenSidebar', () => ({
  CLOSE_SIDEBAR_ID: 'close-sidebar-button',
}));

jest.mock('~/utils', () => ({
  cn: (...classes: (string | boolean | undefined)[]) => classes.filter(Boolean).join(' '),
  openInNewTab: jest.fn(),
  policyUrls: () => ({}),
}));

const createLinks = (): NavLink[] => [
  { id: 'conversations', title: 'com_ui_chat_history', icon: MessagesSquare },
  { id: 'prompts', title: 'com_ui_prompts', icon: NotebookPen },
];

function Location() {
  return <output data-testid="location">{useLocation().pathname}</output>;
}

function browserClick(element: HTMLElement, init?: MouseEventInit) {
  let prevented = false;
  // Observe React's cancellation before stopping JSDOM's unsupported navigation.
  document.addEventListener(
    'click',
    (event) => {
      prevented = event.defaultPrevented;
      event.preventDefault();
    },
    { once: true },
  );
  fireEvent.click(element, init);
  return prevented;
}

async function renderConsole(overrides: Partial<ConsoleProps> = {}) {
  const store = createStore();
  let props: ConsoleProps = {
    links: createLinks(),
    railExpanded: true,
    onToggleRail: jest.fn(),
    activeId: 'conversations',
    onSelect: jest.fn(),
    panelExpanded: true,
    onTogglePanel: jest.fn(),
    onNewChat: jest.fn(),
    appTitle: 'Test App',
    ...overrides,
  };
  function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={['/c/new']}>
        <RecoilRoot>
          <Provider store={store}>
            {children}
            <Location />
          </Provider>
        </RecoilRoot>
      </MemoryRouter>
    );
  }
  const view = render(<Console {...props} />, { wrapper: Wrapper });
  await screen.findByTestId('nav-user');
  return {
    ...view,
    props,
    store,
    rerenderConsole(next: Partial<ConsoleProps>) {
      props = { ...props, ...next };
      view.rerender(<Console {...props} />);
    },
  };
}

describe('Console navigation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    mockShowMarketplace = true;
  });

  afterEach(async () => {
    await act(async () => {
      document.documentElement.dir = 'ltr';
    });
  });

  it.each([true, false])(
    'renders a single accessible rail with labels expanded=%s',
    async (railExpanded) => {
      await renderConsole({ railExpanded });
      const rail = screen.getByRole('navigation', { name: 'com_nav_navigation' });
      const history = screen.getByRole('button', { name: 'com_ui_chat_history' });
      expect(rail).toHaveClass(railExpanded ? 'w-48' : 'w-12');
      expect(history).toHaveAttribute('aria-pressed', 'true');
      if (railExpanded) {
        expect(history).toHaveTextContent('com_ui_chat_history');
      } else {
        expect(history).not.toHaveTextContent('com_ui_chat_history');
      }
      expect(history.querySelector('span') != null).toBe(railExpanded);
      expect(screen.getAllByTestId('nav-user')).toHaveLength(1);
      expect(screen.getAllByTestId('new-chat-button')).toHaveLength(1);
      expect(screen.getAllByTestId('nav-agents-marketplace-button')).toHaveLength(1);
      expect(rail.querySelector('[hidden] button')).toBeNull();
    },
  );

  it.each([
    [true, true],
    [true, false],
    [false, true],
    [false, false],
  ])('keeps labels=%s independent of panel=%s', async (railExpanded, panelExpanded) => {
    const { props, rerenderConsole } = await renderConsole({ railExpanded, panelExpanded });
    const toggle = screen.getByTestId('console-rail-toggle');
    act(() => toggle.focus());
    fireEvent.click(toggle);
    expect(props.onToggleRail).toHaveBeenCalledTimes(1);
    expect(props.onToggleRail).toHaveBeenCalledWith();
    expect(props.onTogglePanel).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    rerenderConsole({ railExpanded: !railExpanded });
    expect(screen.getByTestId('console-rail-toggle')).toHaveFocus();
    expect(
      screen.getByRole('button', {
        name: panelExpanded ? 'com_nav_close_sidebar' : 'com_nav_open_sidebar',
      }),
    ).toHaveAttribute('aria-expanded', String(panelExpanded));
    expect(screen.getByTestId('nav-panel-conversations')).toHaveAttribute('aria-pressed', 'true');
  });

  it('toggles only the secondary panel and preserves the labelled rail', async () => {
    const { props, rerenderConsole } = await renderConsole();
    fireEvent.click(screen.getByRole('button', { name: 'com_nav_close_sidebar' }));
    expect(props.onTogglePanel).toHaveBeenCalledTimes(1);
    expect(props.onTogglePanel).toHaveBeenCalledWith();
    expect(props.onToggleRail).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    rerenderConsole({ panelExpanded: false });
    expect(screen.getByTestId('console-rail-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('button', { name: 'com_nav_open_sidebar' })).toHaveAttribute(
      'aria-controls',
      'console-sidebar-panel',
    );
  });

  it.each(['conversations', 'insights'])(
    'sends %s to the host once without running route or panel callbacks',
    async (id) => {
      const onClick = jest.fn();
      const { props } = await renderConsole({
        links: [
          ...createLinks(),
          { id: 'insights', title: 'com_insights_navigation', icon: BarChart3, onClick },
        ],
      });
      fireEvent.click(screen.getByTestId(`nav-panel-${id}`));
      expect(props.onSelect).toHaveBeenCalledTimes(1);
      expect(props.onSelect).toHaveBeenCalledWith(id);
      expect(onClick).not.toHaveBeenCalled();
      expect(props.onToggleRail).not.toHaveBeenCalled();
      expect(props.onTogglePanel).not.toHaveBeenCalled();
    },
  );

  it('falls back to the route callback only when no adapter was supplied', async () => {
    const onClick = jest.fn();
    const { props } = await renderConsole({
      onSelect: undefined,
      links: [{ id: 'insights', title: 'com_insights_navigation', icon: BarChart3, onClick }],
    });
    fireEvent.click(screen.getByTestId('nav-panel-insights'));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledWith(expect.objectContaining({ type: 'click' }));
    expect(props.onTogglePanel).not.toHaveBeenCalled();
    expect(props.onToggleRail).not.toHaveBeenCalled();
  });

  it('leaves disabled destinations inert even when both callbacks exist', async () => {
    const onClick = jest.fn();
    const { props } = await renderConsole({
      links: [
        {
          id: 'insights',
          title: 'com_insights_navigation',
          icon: BarChart3,
          disabled: true,
          onClick,
        },
      ],
    });
    const target = screen.getByTestId('nav-panel-insights');
    expect(target).toBeDisabled();
    fireEvent.click(target);
    expect(onClick).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onTogglePanel).not.toHaveBeenCalled();
  });

  it('does not invent destinations when permission-filtered links are empty', async () => {
    mockShowMarketplace = false;
    await renderConsole({ links: [] });
    expect(screen.queryByTestId('nav-panel-prompts')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-panel-conversations')).not.toBeInTheDocument();
    expect(screen.queryByTestId('nav-agents-marketplace-button')).not.toBeInTheDocument();
    expect(screen.getByTestId('new-chat-button')).toBeInTheDocument();
    expect(screen.getByTestId('nav-user')).toBeInTheDocument();
  });

  it.each([true, false])(
    'supports a full-page destination with labels=%s and no panel toggle',
    async (railExpanded) => {
      const panelToggleRef = React.createRef<HTMLButtonElement>();
      const { props, rerenderConsole } = await renderConsole({
        railExpanded,
        panelToggleRef,
        panelExpanded: false,
        onTogglePanel: undefined,
        activeId: 'prompts',
      });
      expect(panelToggleRef.current).toBe(screen.getByTestId('nav-panel-prompts'));
      expect(screen.queryByTestId('open-sidebar-button')).not.toBeInTheDocument();
      expect(screen.queryByTestId('close-sidebar-button')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('console-rail-toggle'));
      rerenderConsole({ railExpanded: !railExpanded });
      expect(screen.getByTestId('nav-panel-prompts')).toHaveAttribute('aria-pressed', 'true');
      expect(props.onSelect).not.toHaveBeenCalled();
    },
  );

  it('exposes keyboard shortcuts and activates a destination with the keyboard', async () => {
    const { props } = await renderConsole({ railExpanded: false });
    expect(screen.getByTestId('new-chat-button')).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+Shift+O',
    );
    expect(screen.getByTestId('close-sidebar-button')).toHaveAttribute(
      'aria-keyshortcuts',
      'Control+B',
    );
    act(() => screen.getByTestId('nav-panel-prompts').focus());
    await userEvent.setup().keyboard('{Enter}');
    expect(props.onSelect).toHaveBeenCalledTimes(1);
    expect(props.onSelect).toHaveBeenCalledWith('prompts');
  });

  it('uses the shared New Chat action without implicitly toggling either pane', async () => {
    const { props } = await renderConsole();
    fireEvent.click(screen.getByTestId('new-chat-button'));
    expect(mockNewChat).toHaveBeenCalledTimes(1);
    expect(props.onNewChat).toHaveBeenCalledTimes(1);
    expect(props.onTogglePanel).not.toHaveBeenCalled();
    expect(props.onToggleRail).not.toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it.each([{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }])(
    'preserves modified New Chat clicks: %o',
    async (modifiers) => {
      const { props } = await renderConsole();
      expect(browserClick(screen.getByTestId('new-chat-button'), modifiers)).toBe(false);
      expect(mockNewChat).not.toHaveBeenCalled();
      expect(props.onNewChat).not.toHaveBeenCalled();
      expect(props.onTogglePanel).not.toHaveBeenCalled();
    },
  );

  it('preserves Marketplace routing without changing rail or panel state', async () => {
    const { props } = await renderConsole();
    expect(
      browserClick(screen.getByTestId('nav-agents-marketplace-button'), { ctrlKey: true }),
    ).toBe(false);
    expect(screen.getByTestId('location')).toHaveTextContent('/c/new');
    fireEvent.click(screen.getByTestId('nav-agents-marketplace-button'));
    expect(screen.getByTestId('location')).toHaveTextContent('/agents');
    expect(props.onTogglePanel).not.toHaveBeenCalled();
    expect(props.onToggleRail).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    'keeps account files/settings actions connected with labels=%s',
    async (railExpanded) => {
      const user = userEvent.setup();
      const { store, props } = await renderConsole({ railExpanded });
      const trigger = screen.getByRole('button', { name: 'com_nav_account_settings' });
      jest.spyOn(trigger, 'offsetWidth', 'get').mockReturnValue(36);
      if (railExpanded) {
        expect(trigger).toHaveTextContent('Test User');
      } else {
        expect(trigger).not.toHaveTextContent('Test User');
      }
      await user.click(trigger);
      const files = await screen.findByTestId('nav-files');
      await user.click(files);
      expect(store.get(showFilesDialogAtom)).toBe(true);
      expect(store.get(filesDialogTriggerAtom)?.current).toBe(trigger);
      await user.click(trigger);
      const settings = await screen.findByTestId('nav-settings');
      await user.click(settings);
      expect(store.get(settingsOpenAtom)).toBe(true);
      expect(props.onTogglePanel).not.toHaveBeenCalled();
      expect(props.onToggleRail).not.toHaveBeenCalled();
    },
  );

  it('retains account-menu Escape focus and logout behavior in the icon rail', async () => {
    const user = userEvent.setup();
    await renderConsole({ railExpanded: false });
    const trigger = screen.getByTestId('nav-user');
    // JSDOM has no layout; Ariakit restores focus only to visible elements.
    jest.spyOn(trigger, 'offsetWidth', 'get').mockReturnValue(36);
    await user.click(trigger);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const logout = await screen.findByRole('menuitem', { name: 'com_nav_log_out' });
    await user.click(logout);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it('uses upstream branding and logical edges in RTL without selecting another feature', async () => {
    await act(async () => {
      document.documentElement.dir = 'rtl';
    });
    const { props, rerenderConsole } = await renderConsole({ appTitle: 'Another Brand' });
    expect(screen.getByText('Another Brand')).toBeInTheDocument();
    expect(screen.getByTestId('console-navigation')).toHaveClass('border-e');
    await act(async () => rerenderConsole({ railExpanded: false }));
    expect(screen.getByRole('img', { name: 'Another Brand' })).toHaveAttribute(
      'src',
      'assets/logo.svg',
    );
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('resolves the branding asset under a configured app base', async () => {
    const base = document.createElement('base');
    base.href = 'https://example.test/librechat/';
    document.head.prepend(base);
    try {
      await renderConsole({ railExpanded: false, appTitle: 'Another Brand' });
      expect(screen.getByRole('img', { name: 'Another Brand' })).toHaveProperty(
        'src',
        'https://example.test/librechat/assets/logo.svg',
      );
    } finally {
      base.remove();
    }
  });
});
