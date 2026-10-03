import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

let mockIsUnseen = false;

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
  useToastContext: () => ({ showToast: jest.fn() }),
  Spinner: ({ className }: { className?: string }) => (
    <svg data-testid="status-ring" className={className} />
  ),
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
  useProjectName: () => 'Scheduling',
}));

jest.mock('react-router-dom', () => ({
  useParams: () => ({ conversationId: 'other-convo' }),
}));

jest.mock('recoil', () => ({
  useRecoilValue: () => [],
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    allConversationsSelector: 'allConversationsSelector',
    conversationIdByIndex: () => 'conversationIdByIndex',
  },
}));

jest.mock('~/utils', () => ({
  cn: (...classes: unknown[]) => classes.filter(Boolean).join(' '),
  logger: { error: jest.fn() },
  setDocumentTitle: jest.fn(),
  isConversationUnseen: () => mockIsUnseen,
}));

jest.mock('../ConvoOptions', () => ({
  ConvoOptions: () => <div data-testid="convo-options" />,
}));

jest.mock('../ConversationEndpointIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="convo-icon" />,
}));

jest.mock('../RenameForm', () => ({
  __esModule: true,
  default: () => <form data-testid="rename-form" />,
}));

import Conversation from '../Convo';

const conversation = {
  conversationId: 'convo-1',
  title: 'Tool Approval UI',
} as TConversation;

const renderRow = (props: { isGenerating?: boolean; convo?: TConversation } = {}) =>
  render(
    <DndProvider backend={HTML5Backend}>
      <Conversation
        conversation={props.convo ?? conversation}
        retainView={jest.fn()}
        toggleNav={jest.fn()}
        isGenerating={props.isGenerating}
        showProjectBadge
      />
    </DndProvider>,
  );

const rowButton = () => screen.getByRole('button', { name: /^com_ui_conversation_label/ });
const unreadDot = (container: HTMLElement) =>
  container.querySelector('span[aria-hidden="true"].bg-status-info');

describe('Conversation row status', () => {
  beforeEach(() => {
    mockIsUnseen = false;
  });

  it('rings the avatar while running and keeps the row menu reachable', () => {
    renderRow({ isGenerating: true });

    const ring = screen.getByTestId('status-ring');
    expect(rowButton()).toContainElement(ring);
    expect(rowButton()).toHaveAccessibleName('com_ui_conversation_label, com_ui_generating');
    /* The trailing slot used to hold the spinner in place of the menu, so a running chat
       could not be renamed or archived from the list. */
    fireEvent.mouseEnter(screen.getByTestId('convo-item'));
    expect(screen.getByTestId('convo-options')).toBeInTheDocument();
  });

  it('marks an unseen reply on the avatar and in the title weight', () => {
    mockIsUnseen = true;
    const { container } = renderRow();

    const dot = unreadDot(container);
    expect(dot).not.toBeNull();
    expect(rowButton()).toContainElement(dot as HTMLElement);
    expect(rowButton()).toHaveAccessibleName('com_ui_conversation_label, com_ui_unread');
    expect(screen.getByText('Tool Approval UI').parentElement).toHaveClass('font-semibold');
  });

  it('shows only the ring when a chat with an unseen reply runs again', () => {
    mockIsUnseen = true;
    const { container } = renderRow({ isGenerating: true });

    expect(screen.getByTestId('status-ring')).toBeInTheDocument();
    expect(unreadDot(container)).toBeNull();
    expect(rowButton()).toHaveAccessibleName('com_ui_conversation_label, com_ui_generating');
    expect(screen.getByText('Tool Approval UI').parentElement).not.toHaveClass('font-semibold');
  });

  it('draws no status on an idle, read chat', () => {
    const { container } = renderRow();

    expect(screen.queryByTestId('status-ring')).not.toBeInTheDocument();
    expect(unreadDot(container)).toBeNull();
    expect(rowButton()).toHaveAccessibleName('com_ui_conversation_label');
  });

  it('names the project of a filed chat listed under Chats', () => {
    renderRow({ convo: { ...conversation, chatProjectId: 'project-1' } as TConversation });

    expect(screen.getByTestId('convo-project-badge')).toHaveAttribute('title', 'com_ui_in_project');
    expect(rowButton()).toHaveAccessibleDescription('com_ui_in_project');
  });
});
