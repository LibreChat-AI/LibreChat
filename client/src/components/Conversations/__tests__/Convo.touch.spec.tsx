import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

let mockIsSmallScreen = true;
const mockConvoOptionsProps: { isPopoverActive: boolean }[] = [];
let mockCloseMenu: () => void = () => undefined;

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => mockIsSmallScreen,
  useToastContext: () => ({ showToast: jest.fn() }),
  Spinner: () => <div data-testid="spinner" />,
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => (
    <button {...props}>{children}</button>
  ),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useNavigateToConvo: () => ({ navigateToConvo: jest.fn() }),
  useShiftKey: () => false,
}));

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { sharedLinksEnabled: false } }),
  useUpdateConversationMutation: () => ({ mutateAsync: jest.fn() }),
  usePinConversationMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'other-convo' }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => [],
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: { allConversationsSelector: 'allConversationsSelector' },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  logger: { error: jest.fn() },
}));

jest.mock('../ConvoOptions', () => ({
  ConvoOptions: (props: { isPopoverActive: boolean; setIsPopoverActive: (o: boolean) => void }) => {
    mockConvoOptionsProps.push(props);
    mockCloseMenu = () => props.setIsPopoverActive(false);
    return <div data-testid="convo-options" data-open={props.isPopoverActive} />;
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
  default: () => <form data-testid="rename-form" />,
}));

import Conversation from '../Convo';

const conversation = {
  conversationId: 'convo-1',
  title: 'Mobile UI redesign',
} as TConversation;

const renderRow = () =>
  render(
    <DndProvider backend={HTML5Backend}>
      <Conversation conversation={conversation} retainView={jest.fn()} toggleNav={jest.fn()} />
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
