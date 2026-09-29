import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import ToolCallLimitNotice from '../ToolCallLimitNotice';
import { ChatContext } from '~/Providers/ChatContext';

const TRANSLATIONS: Record<string, string> = {
  com_ui_tool_call_limit_title: 'Reached the tool call limit for this turn',
  com_ui_tool_call_limit_body: 'The agent used every step allowed in a single turn.',
  com_ui_tool_call_limit_continue: 'Keep going',
  com_ui_tool_call_limit_continue_prompt: 'Keep going from where you stopped.',
  com_ui_tool_call_limit_answer: 'Answer now',
  com_ui_tool_call_limit_answer_prompt: 'Stop using tools and answer now.',
  com_ui_tool_call_limit_dismiss: 'Dismiss',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => TRANSLATIONS[key] ?? key,
}));

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

    expect(screen.getByText(TRANSLATIONS.com_ui_tool_call_limit_title)).toBeInTheDocument();
    expect(screen.getByText(TRANSLATIONS.com_ui_tool_call_limit_body)).toBeInTheDocument();
    /** An `alert` role would announce this as a failure; it is a normal outcome. */
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('names its container for screen readers', () => {
    renderNotice();

    expect(
      screen.getByRole('group', { name: TRANSLATIONS.com_ui_tool_call_limit_title }),
    ).toBeInTheDocument();
  });

  it('continues the turn as a new request carrying the continue instruction', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(
      screen.getByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_continue }),
    );

    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      { text: TRANSLATIONS.com_ui_tool_call_limit_continue_prompt },
      { overrideFiles: [], overrideManualSkills: [], overrideQuotes: [] },
    );
  });

  it('asks for an immediate answer instead of more tool use', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(
      screen.getByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_answer }),
    );

    expect(ask).toHaveBeenCalledWith(
      { text: TRANSLATIONS.com_ui_tool_call_limit_answer_prompt },
      { overrideFiles: [], overrideManualSkills: [], overrideQuotes: [] },
    );
  });

  it('offers no actions with no live chat behind it, as in a shared link or export', () => {
    renderNotice();

    expect(
      screen.queryByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_continue }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_answer }),
    ).not.toBeInTheDocument();
    /** The explanation and the way to hide it must survive. */
    expect(screen.getByText(TRANSLATIONS.com_ui_tool_call_limit_body)).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_dismiss }),
    ).toBeInTheDocument();
  });

  it('offers no actions on a message that is not the branch tail', () => {
    const ask = jest.fn();
    renderNotice({ ask, isSubmitting: false, latestMessageId: 'some-newer-message' });

    expect(
      screen.queryByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_continue }),
    ).not.toBeInTheDocument();
    expect(ask).not.toHaveBeenCalled();
  });

  it('offers no actions while a generation is already running', () => {
    renderNotice({ ask: jest.fn(), isSubmitting: true, latestMessageId: 'response-1' });

    expect(
      screen.queryByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_continue }),
    ).not.toBeInTheDocument();
  });

  it('can be dismissed', () => {
    renderNotice({ ask: jest.fn(), isSubmitting: false, latestMessageId: 'response-1' });

    fireEvent.click(
      screen.getByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_dismiss }),
    );

    expect(screen.queryByText(TRANSLATIONS.com_ui_tool_call_limit_title)).not.toBeInTheDocument();
  });

  it('shows the notice again when switching to another sibling message', () => {
    const ask = jest.fn();
    const { rerender } = renderNotice({
      ask,
      isSubmitting: false,
      latestMessageId: 'response-1',
    });

    fireEvent.click(
      screen.getByRole('button', { name: TRANSLATIONS.com_ui_tool_call_limit_dismiss }),
    );
    expect(screen.queryByText(TRANSLATIONS.com_ui_tool_call_limit_title)).not.toBeInTheDocument();

    rerender(
      <ChatContext.Provider
        value={chatContextValue({ ask, isSubmitting: false, latestMessageId: 'response-2' })}
      >
        <ToolCallLimitNotice message={{ messageId: 'response-2' } as TMessage} />
      </ChatContext.Provider>,
    );

    expect(screen.getByText(TRANSLATIONS.com_ui_tool_call_limit_title)).toBeInTheDocument();
  });
});
