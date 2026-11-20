import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

let mockIsSmallScreen = true;
let mockRouteConversationId = 'other-convo';
let mockActiveConversationId: string | null = null;
const mockNavigate = jest.fn();
const mockToggleNav = jest.fn();
const mockSetDocumentTitle = jest.fn();
let mockOwnershipEnabled = true;
let mockOwnershipVersion: number | undefined = 1;
const mockRename = jest.fn().mockResolvedValue({});
const mockConvoOptionsProps: { isPopoverActive: boolean }[] = [];
let mockCloseMenu: () => void = () => undefined;

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => mockIsSmallScreen,
  useRemScale: () => 1,
  useToastContext: () => ({ showToast: jest.fn() }),
  Spinner: () => <div data-testid="spinner" />,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNavigateToConvo: () => ({ navigateToConvo: mockNavigate }),
  useShiftKey: () => false,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({
    data: {
      sharedLinksEnabled: false,
      interface: { runningChatRename: mockOwnershipEnabled },
      conversationTitleOwnershipVersion: mockOwnershipVersion,
    },
  }),
  useUpdateConversationMutation: () => ({ mutateAsync: mockRename }),
  usePinConversationMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: mockRouteConversationId }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => mockActiveConversationId,
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { conversationIdByIndex: () => 'conversationIdByIndex' },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  logger: { error: jest.fn() },
  isConversationUnseen: () => false,
  setDocumentTitle: (...args: unknown[]) => mockSetDocumentTitle(...args),
  hasRealTitle: (title: string) => !!title && title !== 'New Chat',
}));

jest.mock('../ConvoOptions', () => ({
  ConvoOptions: (props: {
    isPopoverActive: boolean;
    canRename: boolean;
    renameHandler: () => void;
    setIsPopoverActive: (o: boolean) => void;
  }) => {
    mockConvoOptionsProps.push(props);
    mockCloseMenu = () => props.setIsPopoverActive(false);
    return (
      <div data-testid="convo-options" data-open={props.isPopoverActive}>
        <button disabled={!props.canRename} onClick={props.renameHandler}>
          {'Rename'}
        </button>
      </div>
    );
  },
}));

jest.mock('../ConversationEndpointIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="convo-icon" />,
}));

jest.mock('../ConvoLink', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => <span>{title}</span>,
}));

jest.mock('../RenameForm', () => ({
  __esModule: true,
  default: ({
    titleInput,
    onSubmit,
  }: {
    titleInput: string;
    onSubmit: (title: string) => void;
  }) => (
    <button data-testid="rename-form" onClick={() => onSubmit(titleInput)}>
      {'Save'}
    </button>
  ),
}));

import Conversation from '../Convo';

const conversation = {
  conversationId: 'convo-1',
  title: 'Mobile UI redesign',
} as TConversation;

const renderRow = (isGenerating = false, row = conversation) =>
  render(
    <DndProvider backend={HTML5Backend}>
      <Conversation
        conversation={row}
        isGenerating={isGenerating}
        retainView={jest.fn()}
        toggleNav={mockToggleNav}
      />
    </DndProvider>,
  );

describe('Conversation row on touch', () => {
  beforeEach(() => {
    mockConvoOptionsProps.length = 0;
    mockIsSmallScreen = true;
  });

  it('offers a reachable overflow trigger without hover', () => {
    renderRow();

    expect(screen.getByTestId('convo-options-trigger')).toBeInTheDocument();
    expect(screen.queryByTestId('convo-options')).not.toBeInTheDocument();
  });

  it('opens the menu on the very first tap', () => {
    renderRow();

    fireEvent.click(screen.getByTestId('convo-options-trigger'));

    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
  });

  it('survives focus arriving before the press completes', () => {
    renderRow();

    /**
     * Touch focuses the button mid-tap. The trigger must not be swapped out
     * from under the finger, or the click never lands on it.
     */
    fireEvent.focus(screen.getByTestId('convo-options-trigger'));

    expect(screen.getByTestId('convo-options-trigger')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('convo-options-trigger'));

    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
  });

  it('keeps the real menu mounted once dismissed, so focus has somewhere to return', () => {
    renderRow();

    fireEvent.click(screen.getByTestId('convo-options-trigger'));
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');

    /**
     * Ariakit returns focus to its own trigger on close. Swapping back to the
     * lightweight button would destroy that node mid-dismissal and strand
     * focus on the document.
     */
    act(() => mockCloseMenu());

    expect(screen.getByTestId('convo-options')).toBeInTheDocument();
    expect(screen.queryByTestId('convo-options-trigger')).not.toBeInTheDocument();
  });

  it('does not open from a press that turns into a scroll', () => {
    renderRow();

    /**
     * A press that becomes a vertical swipe fires `pointerdown` but never a
     * click. Committing on the earlier event opened the menu mid-scroll.
     */
    fireEvent.pointerDown(screen.getByTestId('convo-options-trigger'));

    expect(screen.queryByTestId('convo-options')).not.toBeInTheDocument();
  });

  it('leaves the desktop hover reveal alone', () => {
    mockIsSmallScreen = false;
    renderRow();

    expect(screen.queryByTestId('convo-options-trigger')).not.toBeInTheDocument();
  });
});

describe('Conversation context menu', () => {
  beforeEach(() => {
    mockConvoOptionsProps.length = 0;
    mockIsSmallScreen = false;
  });

  it.each([false, true])('opens on right-click (generating: %s)', (isGenerating) => {
    renderRow(isGenerating);
    fireEvent.contextMenu(screen.getByTestId('convo-item'), { clientX: 120, clientY: 80 });
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
    expect(mockConvoOptionsProps.at(-1)).toEqual(
      expect.objectContaining({
        isGenerating,
        contextMenuPosition: { x: 120, y: 80 },
      }),
    );
    act(() => mockCloseMenu());
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'false');
    expect(mockConvoOptionsProps.at(-1)).toEqual(
      expect.objectContaining({ contextMenuPosition: undefined }),
    );
  });

  it('offers a clickable running menu before hover', () => {
    renderRow(true);
    const trigger = screen.getByRole('button', { name: 'com_nav_convo_menu_options' });
    expect(trigger).toBeVisible();
    fireEvent.click(trigger);
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
  });
});

describe('Conversation context menu on small screens', () => {
  it('keeps the real trigger mounted after an externally opened menu closes', () => {
    mockIsSmallScreen = true;
    renderRow(true);
    fireEvent.contextMenu(screen.getByTestId('convo-item'), { clientX: 120, clientY: 80 });
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
    act(() => mockCloseMenu());
    expect(screen.getByTestId('convo-options')).toBeInTheDocument();
    expect(screen.queryByTestId('convo-options-trigger')).not.toBeInTheDocument();
  });
});

describe('Conversation title ownership rollout', () => {
  beforeEach(() => {
    mockRename.mockClear();
    mockOwnershipEnabled = true;
    mockOwnershipVersion = 1;
  });
  afterEach(() => {
    mockOwnershipEnabled = true;
    mockOwnershipVersion = 1;
  });

  it.each([
    [false, 1],
    [true, undefined],
  ])('disables rename on unsafe running rows (enabled %s, protocol %s)', (enabled, version) => {
    mockOwnershipEnabled = enabled;
    mockOwnershipVersion = version;
    renderRow(true);
    fireEvent.contextMenu(screen.getByTestId('convo-item'));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });
  it('also fences an unowned placeholder after a final-timing stream ends', () => {
    mockOwnershipEnabled = false;
    renderRow(false, { ...conversation, title: 'New Chat' });
    fireEvent.contextMenu(screen.getByTestId('convo-item'));
    expect(screen.getByRole('button', { name: 'Rename' })).toBeDisabled();
  });
  it.each([false, true])(
    'claims an unchanged unowned title (generating %s)',
    async (generating) => {
      renderRow(generating, { ...conversation, title: 'New Chat' });
      fireEvent.contextMenu(screen.getByTestId('convo-item'));
      fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
      await act(async () => fireEvent.click(screen.getByTestId('rename-form')));
      expect(mockRename).toHaveBeenCalledWith({ conversationId: 'convo-1', title: 'New Chat' });
    },
  );
  it('keeps unchanged owned titles as a no-op', async () => {
    renderRow(false, { ...conversation, titleSetByUser: true });
    fireEvent.contextMenu(screen.getByTestId('convo-item'));
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }));
    await act(async () => fireEvent.click(screen.getByTestId('rename-form')));
    expect(mockRename).not.toHaveBeenCalled();
  });
});

describe('Conversation row activation', () => {
  beforeEach(() => {
    mockIsSmallScreen = true;
    mockRouteConversationId = 'convo-1';
    mockActiveConversationId = 'convo-1';
    mockToggleNav.mockReset();
    mockNavigate.mockReset();
    mockSetDocumentTitle.mockReset();
  });

  afterEach(() => {
    mockRouteConversationId = 'other-convo';
    mockActiveConversationId = null;
  });

  it.each([false, true])(
    'dismisses the current mobile chat without navigating (running=%s)',
    (running) => {
      renderRow(running);
      fireEvent.click(screen.getByText(conversation.title!));

      expect(mockToggleNav).toHaveBeenCalledTimes(1);
      expect(mockToggleNav).toHaveBeenCalledWith();
      expect(mockNavigate).not.toHaveBeenCalled();
      expect(mockSetDocumentTitle).not.toHaveBeenCalled();
    },
  );

  it('dismisses the current chat while its new-chat route still has the draft ID', () => {
    mockRouteConversationId = 'new';
    renderRow(true);
    fireEvent.click(screen.getByText(conversation.title!));

    expect(mockToggleNav).toHaveBeenCalledWith();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('leaves the desktop sidebar open for the current chat', () => {
    mockIsSmallScreen = false;
    renderRow();
    fireEvent.click(screen.getByText(conversation.title!));

    expect(mockToggleNav).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not dismiss the drawer from the current chat overflow menu', () => {
    renderRow();
    fireEvent.contextMenu(screen.getByTestId('convo-item'));
    expect(screen.getByTestId('convo-options')).toHaveAttribute('data-open', 'true');
    fireEvent.click(screen.getByText(conversation.title!));

    expect(mockToggleNav).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('keeps navigation to another chat deferred until the drawer slide', () => {
    mockRouteConversationId = 'other-convo';
    renderRow();
    fireEvent.click(screen.getByText(conversation.title!));

    expect(mockToggleNav).toHaveBeenCalledWith(expect.any(Function));
    expect(mockNavigate).not.toHaveBeenCalled();
    mockToggleNav.mock.calls[0][0]();
    expect(mockNavigate).toHaveBeenCalledWith(conversation, { currentConvoId: 'other-convo' });
  });

  it.each(['ctrlKey', 'metaKey'])(
    'preserves opening the current chat in a new tab with %s',
    (modifier) => {
      const open = jest.spyOn(window, 'open').mockImplementation(() => null);
      renderRow();
      fireEvent.click(screen.getByText(conversation.title!), { [modifier]: true });

      expect(open).toHaveBeenCalledWith(`${window.location.origin}/c/convo-1`, '_blank');
      expect(mockToggleNav).toHaveBeenCalledWith();
      expect(mockNavigate).not.toHaveBeenCalled();
    },
  );
});
