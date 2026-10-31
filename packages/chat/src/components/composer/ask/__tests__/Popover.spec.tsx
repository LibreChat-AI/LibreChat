/**
 * @jest-environment jsdom
 */
import React, { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { AskAnswerView, AskPopoverProps } from '../Popover';
import AskPopover from '../Popover';

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  useLocalize: () => (key: string) => key,
}));

jest.mock('../../../../react/overlay', () => ({
  useComposerOverlay: jest.fn(),
}));

/**
 * The ask popover's keyboard and focus contract: Escape moves the question to the chat and puts
 * focus back in the draft once the popover is gone; arrows and digits reach the host's handler
 * from inside the popover; single-select rows submit, multi-select Submit folds in the draft;
 * a failed answer is announced; a batch renders through the host's card.
 */

const view = (overrides: Partial<AskAnswerView> = {}): AskAnswerView => ({
  liveAsk: {
    actionId: 'ask-1',
    messageId: 'm-1',
    question: { question: 'Which environment?', description: 'Pick one' },
  },
  popoverVisible: true,
  options: [
    { label: 'Staging', value: 's' },
    { label: 'Production', value: 'p' },
  ],
  selected: null,
  checked: [],
  multiSelect: false,
  locked: false,
  errored: false,
  canSubmit: false,
  toggleChecked: jest.fn(),
  submit: jest.fn(() => true),
  submitOption: jest.fn(() => true),
  skip: jest.fn(() => true),
  collapse: jest.fn(),
  handlePopoverKeyDown: jest.fn(() => true),
  ...overrides,
});

/** Hosts the popover over a real textarea, with `collapse` hiding it the way answer mode does. */
function Host({
  initial,
  draft = '',
  renderQuestions = () => null,
}: {
  initial: AskAnswerView;
  draft?: string;
  renderQuestions?: AskPopoverProps['renderQuestions'];
}) {
  const [visible, setVisible] = useState(true);
  const textAreaRef = React.useRef<HTMLTextAreaElement>(null);
  const ask: AskAnswerView = {
    ...initial,
    popoverVisible: visible,
    collapse: () => {
      initial.collapse();
      setVisible(false);
    },
  };
  return (
    <>
      <textarea ref={textAreaRef} aria-label="Composer" defaultValue={draft} />
      <AskPopover
        conversationId="c-1"
        ask={ask}
        useComposerText={() => draft}
        textAreaRef={textAreaRef}
        renderQuestions={renderQuestions}
      />
    </>
  );
}

describe('AskPopover', () => {
  it('moves the question to the chat on Escape and returns focus to the draft', () => {
    const ask = view();
    render(<Host initial={ask} />);
    const option = screen.getByRole('button', { name: /Staging/ });
    option.focus();

    act(() => {
      fireEvent.keyDown(option, { key: 'Escape' });
    });

    expect(ask.collapse).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Which environment?')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Composer' }));
  });

  it('returns focus to the draft after the chevron moves the question too', () => {
    const ask = view();
    render(<Host initial={ask} />);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'com_ui_ask_move_to_chat' }));
    });

    expect(ask.collapse).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('Which environment?')).toBeNull();
  });

  it('hands arrow and digit keys from inside the popover to the host', () => {
    const ask = view();
    render(<Host initial={ask} />);
    const option = screen.getByRole('button', { name: /Staging/ });

    fireEvent.keyDown(option, { key: 'ArrowDown' });
    fireEvent.keyDown(option, { key: '2' });

    expect(ask.handlePopoverKeyDown).toHaveBeenCalledTimes(2);
    expect(ask.collapse).not.toHaveBeenCalled();
  });

  it('submits a single-select row on click and skips on Skip', () => {
    const ask = view();
    render(<Host initial={ask} />);

    fireEvent.click(screen.getByRole('button', { name: /Production/ }));
    fireEvent.click(screen.getByRole('button', { name: 'com_ui_skip' }));

    expect(ask.submitOption).toHaveBeenCalledWith(1);
    expect(ask.skip).toHaveBeenCalledTimes(1);
  });

  it('folds the draft into a multi-select Submit, enabled by the draft alone', () => {
    const ask = view({ multiSelect: true });
    render(<Host initial={ask} draft="  and the canary  " />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Staging/ }));
    expect(ask.toggleChecked).toHaveBeenCalledWith(0);

    const submit = screen.getByRole('button', { name: /com_ui_submit/ });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    expect(ask.submit).toHaveBeenCalledWith('  and the canary  ');
  });

  it('points the hint at the draft and announces a failed answer', () => {
    render(<Host initial={view({ errored: true })} />);

    fireEvent.click(screen.getByRole('button', { name: 'com_ui_ask_type_below' }));
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Composer' }));
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_ask_answer_error');
  });

  it('renders a batch through the host card, with Escape wired to move it to the chat', () => {
    const ask = view({
      liveAsk: {
        actionId: 'ask-2',
        messageId: 'm-2',
        question: { question: 'First?' },
        questions: [{ id: 'q1', question: 'First?' }],
      },
    });
    const renderQuestions = jest.fn<
      React.ReactNode,
      Parameters<AskPopoverProps['renderQuestions']>
    >(({ onEscape, headerAction }) => (
      <div>
        <button type="button" onClick={onEscape}>
          escape
        </button>
        {headerAction}
      </div>
    ));
    render(<Host initial={ask} renderQuestions={renderQuestions} />);

    expect(renderQuestions).toHaveBeenCalledWith(
      expect.objectContaining({ questions: [{ id: 'q1', question: 'First?' }] }),
    );
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'escape' }));
    });
    expect(ask.collapse).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Composer' }));
  });

  it('renders nothing while the question sits in the chat', () => {
    const { container } = render(
      <AskPopover
        conversationId="c-1"
        ask={view({ popoverVisible: false })}
        useComposerText={() => ''}
        renderQuestions={() => null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
