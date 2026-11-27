/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { ChatContext } from '../../../react/chat/context';
import ToolCallLimitNotice from '../ToolCallLimitNotice';
import { initEnglish } from '../../../__fixtures__/i18n';

beforeAll(initEnglish);

const MESSAGE = { messageId: 'response-1' } as TMessage;

type NoticeChatContext = NonNullable<React.ContextType<typeof ChatContext>>;

/**
 * The notice only reads `ask`, `isSubmitting`, and `latestMessageId`. The real
 * context is a large helper return type, so a partial cannot overlap it for
 * TypeScript without going through `unknown`.
 */
function chatContextValue(context: Partial<NoticeChatContext>): NoticeChatContext {
  return context as unknown as NoticeChatContext;
}

function renderNotice(context?: Partial<NoticeChatContext>, message: TMessage = MESSAGE) {
  if (context == null) {
    return render(<ToolCallLimitNotice message={message} />);
  }
  return render(
    <ChatContext.Provider value={chatContextValue(context)}>
      <ToolCallLimitNotice message={message} />
    </ChatContext.Provider>,
  );
}

describe('ToolCallLimitNotice', () => {
  it('explains what happened rather than reporting an error', () => {
    renderNotice();

    expect(screen.getByText('Reached the tool call limit for this turn')).toBeInTheDocument();
    expect(
      screen.getByText(
        'The agent used every step allowed in a single turn, so it stopped before finishing. Everything above is saved. Choose how to carry on.',
      ),
    ).toBeInTheDocument();
    /** An `alert` role would announce this as a failure; it is a normal outcome. */
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names its container for screen readers', () => {
    renderNotice();

    expect(
      screen.getByRole('group', { name: 'Reached the tool call limit for this turn' }),
    ).toBeInTheDocument();
  });

  it('continues the turn as a new request carrying the continue instruction', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }));

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      { text: 'Keep going from where you stopped.' },
      {
        overrideFiles: [],
        overrideManualSkills: [],
        overrideQuotes: [],
        overrideReasoning: null,
      },
    );
  });

  it('asks for an immediate answer instead of more tool use', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Answer now' }));

    expect(ask).toHaveBeenCalledWith(
      {
        text: 'Stop using tools and answer now with what you already have. Say briefly what you could not finish checking.',
      },
      {
        overrideFiles: [],
        overrideManualSkills: [],
        overrideQuotes: [],
        overrideReasoning: null,
      },
    );
  });

  it('offers no actions in a conversation the reader takes no turn in', () => {
    renderNotice({
      ask: jest.fn(),
      readOnly: true,
      isSubmitting: false,
      latestMessageId: 'response-1',
    });

    expect(screen.queryByRole('button', { name: 'Keep going' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Answer now' })).toBeNull();
  });

  it('offers no actions with no live chat behind it, as in a shared link or export', () => {
    renderNotice();

    expect(screen.queryByRole('button', { name: 'Keep going' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Answer now' })).not.toBeInTheDocument();
    /** The explanation and the way to hide it must survive. */
    expect(
      screen.getByText(
        'The agent used every step allowed in a single turn, so it stopped before finishing. Everything above is saved. Choose how to carry on.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Dismiss this notice' })).toBeInTheDocument();
  });

  it('offers no actions on a message that is not the branch tail', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'some-newer-message' });

    expect(screen.queryByRole('button', { name: 'Keep going' })).not.toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });

  it('offers no actions while a generation is already running', () => {
    renderNotice({ ask: jest.fn(), isSubmitting: true, latestMessageId: 'response-1' });

    expect(screen.queryByRole('button', { name: 'Keep going' })).not.toBeInTheDocument();
  });

  it('can be dismissed', () => {
    renderNotice({ ask: jest.fn(), isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this notice' }));

    expect(screen.queryByText('Reached the tool call limit for this turn')).not.toBeInTheDocument();
  });

  it('shows the notice again when switching to another sibling message', () => {
    const ask = jest.fn();
    const { rerender } = renderNotice({
      ask,
      isSubmitting: false,
      latestMessageId: 'response-1',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss this notice' }));
    expect(screen.queryByText('Reached the tool call limit for this turn')).not.toBeInTheDocument();

    rerender(
      <ChatContext.Provider
        value={chatContextValue({ ask, isSubmitting: false, latestMessageId: 'response-2' })}
      >
        <ToolCallLimitNotice message={{ messageId: 'response-2' } as TMessage} />
      </ChatContext.Provider>,
    );

    expect(screen.getByText('Reached the tool call limit for this turn')).toBeInTheDocument();
  });
});
