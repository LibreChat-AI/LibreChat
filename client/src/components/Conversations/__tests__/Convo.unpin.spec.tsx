import { DndProvider } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { TConversation } from 'librechat-data-provider';

type PinVariables = { conversationId: string; pinned: boolean };
type PinOptions = { onSuccess?: () => void; onError?: () => void };

const pinCalls: Array<{ variables: PinVariables; options?: PinOptions }> = [];

jest.mock('@librechat/client', () => ({
  useMediaQuery: () => false,
  useToastContext: () => ({ showToast: jest.fn() }),
  Spinner: () => <div data-testid="spinner" />,
  TooltipAnchor: ({ render: trigger }: { render: React.ReactNode }) => trigger,
  /* Stands in for the shared primitive: the row's actions compose through it,
   * so it has to pass its props to a real button for these assertions. */
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button type="button" {...props}>
      {children}
    </button>
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
  usePinConversationMutation: () => ({
    mutate: (variables: PinVariables, options?: PinOptions) => {
      pinCalls.push({ variables, options });
    },
  }),
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
  setDocumentTitle: jest.fn(),
}));

jest.mock('../ConvoOptions', () => ({
  ConvoOptions: () => <div data-testid="convo-options" />,
}));

jest.mock('../ConversationEndpointIcon', () => ({
  __esModule: true,
  default: () => <div data-testid="convo-icon" />,
}));

/** The real row's only focusable element is the link button inside it; the row
 *  element itself is a plain div, so a focus target has to be found in here. */
jest.mock('../ConvoLink', () => ({
  __esModule: true,
  default: ({ title }: { title: string }) => (
    <button type="button" aria-label={`open ${title}`}>
      {title}
    </button>
  ),
}));

jest.mock('../RenameForm', () => ({
  __esModule: true,
  default: () => <form data-testid="rename-form" />,
}));

import Conversation from '../Convo';

const pinned = (id: string, title: string) =>
  ({ conversationId: id, title, pinned: true }) as unknown as TConversation;

const renderPinnedSection = (conversations: TConversation[]) =>
  render(
    <DndProvider backend={HTML5Backend}>
      <div role="region" data-pinned-section="" aria-label="com_ui_pinned">
        {conversations.map((conversation) => (
          <Conversation
            key={conversation.conversationId}
            conversation={conversation}
            retainView={jest.fn()}
            toggleNav={jest.fn()}
          />
        ))}
      </div>
    </DndProvider>,
  );

describe('pinned conversation row unpin', () => {
  beforeEach(() => {
    pinCalls.length = 0;
  });

  it('unpins from the row badge without opening the options menu', () => {
    renderPinnedSection([pinned('c1', 'First'), pinned('c2', 'Second')]);

    fireEvent.click(screen.getAllByTestId('convo-unpin-button')[0]);

    expect(pinCalls).toHaveLength(1);
    expect(pinCalls[0].variables).toEqual({ conversationId: 'c1', pinned: false });
  });

  /** Activating the badge focuses it, by click or by keyboard; the focus
   *  handoff only applies when the row that is going away actually held it. */
  const activateUnpin = (index: number) => {
    const button = screen.getAllByTestId('convo-unpin-button')[index];
    button.focus();
    fireEvent.click(button);
  };

  it('hands focus to a neighbouring row, not the row that is going away', () => {
    renderPinnedSection([pinned('c1', 'First'), pinned('c2', 'Second')]);

    activateUnpin(0);
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    /* The unpinned row is still mounted at this point: focus has to skip it,
     * and land on something actually focusable rather than the row div. */
    expect(document.activeElement).toBe(screen.getByLabelText('open Second'));
  });
  it('does not steal focus when focus moves away before deferred success', () => {
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    renderPinnedSection([pinned('c1', 'First'), pinned('c2', 'Second')]);

    activateUnpin(0);
    elsewhere.focus();
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    expect(document.activeElement).toBe(elsewhere);
    elsewhere.remove();
  });

  it('restores focus when the focused row is removed before deferred success', () => {
    const first = pinned('c1', 'First');
    const second = pinned('c2', 'Second');
    const { rerender } = renderPinnedSection([first, second]);

    activateUnpin(0);
    rerender(
      <DndProvider backend={HTML5Backend}>
        <div role="region" data-pinned-section="" aria-label="com_ui_pinned">
          <Conversation
            key={second.conversationId}
            conversation={second}
            retainView={jest.fn()}
            toggleNav={jest.fn()}
          />
        </div>
      </DndProvider>,
    );
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    expect(document.activeElement).toBe(screen.getByLabelText('open Second'));
  });

  it('falls back to the row above when the last row is unpinned', () => {
    renderPinnedSection([pinned('c1', 'First'), pinned('c2', 'Second')]);

    activateUnpin(1);
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    expect(document.activeElement).toBe(screen.getByLabelText('open First'));
  });

  it('falls back to New Chat when no other row survives', () => {
    /* The id has to be one a real control carries: the expanded panel's New
     * Chat button. A made-up one would let this pass while focus fell to the
     * document in the app. */
    const newChat = document.createElement('button');
    newChat.setAttribute('data-testid', 'new-chat-button');
    document.body.appendChild(newChat);

    renderPinnedSection([pinned('c1', 'Only')]);

    activateUnpin(0);
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    expect(document.activeElement).toBe(newChat);
    newChat.remove();
  });

  it('does not steal focus when the removed row never had it', () => {
    renderPinnedSection([pinned('c1', 'First'), pinned('c2', 'Second')]);

    /* A pointer user unpinning a row they were not keyboard-focused on should
     * keep whatever they had focused, not be yanked into the sidebar. */
    fireEvent.click(screen.getAllByTestId('convo-unpin-button')[0]);
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    expect(document.activeElement).not.toBe(screen.getByLabelText('open Second'));
  });

  it('keeps focus on the surviving row when it is outside the pinned section', () => {
    /* The same row renders inside an expanded project, where unpinning only
     * clears the flag and the row stays put. The pin badge that had focus does
     * not survive though, so focus moves to the row's own link rather than
     * being left on a removed control or dropped to the document. */
    render(
      <DndProvider backend={HTML5Backend}>
        <div role="region" aria-label="chats">
          <Conversation
            conversation={pinned('c1', 'Project Chat')}
            retainView={jest.fn()}
            toggleNav={jest.fn()}
          />
          <Conversation
            conversation={pinned('c2', 'Other')}
            retainView={jest.fn()}
            toggleNav={jest.fn()}
          />
        </div>
      </DndProvider>,
    );

    const button = screen.getAllByTestId('convo-unpin-button')[0];
    button.focus();
    fireEvent.click(button);
    act(() => {
      pinCalls[0].options?.onSuccess?.();
    });

    /* Its own row, not the neighbour: this row is not going anywhere. */
    expect(document.activeElement).toBe(screen.getByLabelText('open Project Chat'));
  });

  it('reports the rename ending when the row is removed mid-rename', () => {
    /* The owner releases a renaming row's drag source. A row taken away while
     * renaming, for instance by unpinning it from the project list that also
     * renders it, would otherwise never report the rename ending and stay
     * undraggable once it came back. */
    const onRenamingChange = jest.fn();
    const { unmount } = render(
      <DndProvider backend={HTML5Backend}>
        <div role="region" data-pinned-section="" aria-label="com_ui_pinned">
          <Conversation
            conversation={pinned('c1', 'Renaming')}
            retainView={jest.fn()}
            toggleNav={jest.fn()}
            onRenamingChange={onRenamingChange}
          />
        </div>
      </DndProvider>,
    );

    onRenamingChange.mockClear();
    unmount();

    expect(onRenamingChange).toHaveBeenCalledWith(false);
  });
});
