import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import AskUserQuestionCall from '../AskUserQuestionCall';
import { FailedRevealContext } from '../reveal';
import store from '~/store';

const translations: Record<string, string> = {
  com_ui_asked: 'Asked',
  com_ui_asking: 'Asking',
  com_ui_question_failed: "Question wasn't shown",
  com_ui_question_failed_description:
    "The agent couldn't show this question and may retry automatically.",
  com_ui_question_unanswered: 'No answer was given',
  com_ui_you_answered: 'You answered:',
  com_ui_asked_n_questions: 'Asked {{0}} questions',
  com_ui_asking_n_questions: 'Asking {{0}} questions',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) => {
    const template = translations[key] ?? key;
    return values == null
      ? template
      : template.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => values[name] ?? '');
  },
  /** The disclosure is the behaviour under test — keep the real hook. */
  useExpandCollapse: jest.requireActual('~/hooks/Messages/useExpandCollapse').default,
}));

jest.mock('~/utils/approval', () => ({
  getSubmittedAskAnswer: () => undefined,
  parseAskUserQuestionArgs: (args: string | Record<string, unknown> | undefined) => {
    if (typeof args === 'string') {
      return JSON.parse(args) as Record<string, unknown>;
    }
    return args ?? null;
  },
  parseAskUserQuestionsArgs: (args: string | Record<string, unknown> | undefined) => {
    const parsed = typeof args === 'string' ? JSON.parse(args) : args;
    return Array.isArray(parsed?.questions) ? parsed : null;
  },
}));

jest.mock('../AskUserQuestionProgress', () => ({
  __esModule: true,
  default: () => {
    const { createElement } = jest.requireActual<typeof React>('react');
    return createElement('div', { 'data-testid': 'ask-progress' });
  },
}));

jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => {
    const { createElement } = jest.requireActual<typeof React>('react');
    return createElement('div', null, children);
  },
}));

/** Settled records mount collapsed, exactly like every other tool card. */
const renderCall = (ui: React.ReactElement, autoExpand = false) =>
  render(
    <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, autoExpand)}>
      {ui}
    </RecoilRoot>,
  );

describe('AskUserQuestionCall', () => {
  const args = JSON.stringify({
    question: 'How would you like me to get the data?',
    options: [{ label: 'Use public data', value: 'public' }],
  });

  test('renders the progress card while the call is live and unanswered', () => {
    renderCall(<AskUserQuestionCall args={args} output="" toolCallId="call_1" isSubmitting />);

    expect(screen.getByTestId('ask-progress')).toBeInTheDocument();
    expect(screen.queryByText('You answered:')).not.toBeInTheDocument();
  });

  test.each(['cancelled', 'failed'] as const)(
    'does not render a terminal %s question as pending while its message streams',
    (runStepStatus) => {
      renderCall(
        <AskUserQuestionCall
          args={args}
          output=""
          toolCallId="call_1"
          isSubmitting
          runStepStatus={runStepStatus}
        />,
      );

      expect(screen.queryByTestId('ask-progress')).not.toBeInTheDocument();
      expect(screen.getByTestId('ask-user-question-call')).toBeInTheDocument();
    },
  );

  test('mounts collapsed and opens on click, like any other tool card', () => {
    renderCall(<AskUserQuestionCall args={args} output="public" />);

    const header = screen.getByRole('button');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    /** The collapsed line still says what was asked. */
    expect(header).toHaveTextContent('Asked');
    expect(header).toHaveTextContent('How would you like me to get the data?');

    fireEvent.click(header);

    expect(header).toHaveAttribute('aria-expanded', 'true');
  });

  test.each([
    { failed: true, runStepStatus: 'completed' as const },
    { failed: false, runStepStatus: 'failed' as const },
  ])('reveals a terminal question failure from its parent fold (%p)', (failure) => {
    const call = <AskUserQuestionCall args={args} output="" {...failure} />;
    const tree = (tick: number) => (
      <RecoilRoot>
        <FailedRevealContext.Provider value={{ tick, claimFocus: () => true }}>
          {call}
        </FailedRevealContext.Provider>
      </RecoilRoot>
    );
    const { rerender } = render(tree(0));
    const button = screen.getByRole('button', { name: /Question wasn't shown/ });
    expect(button).toHaveAttribute('aria-expanded', 'false');

    rerender(tree(1));

    expect(button).toHaveAttribute('aria-expanded', 'true');
    expect(button).toHaveFocus();
    expect(button).toHaveTextContent('failed');
  });

  test('opens at mount when auto-expand is on', () => {
    renderCall(<AskUserQuestionCall args={args} output="public" />, true);

    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });

  test('summarizes a batch by its question count', () => {
    renderCall(
      <AskUserQuestionCall
        args={JSON.stringify({
          questions: [
            { id: 'environment', question: 'Where should this run?' },
            { id: 'window', question: 'Which window?' },
          ],
        })}
        output={JSON.stringify({ answers: { environment: 'staging', window: '7d' } })}
      />,
    );

    expect(screen.getByRole('button')).toHaveTextContent('Asked 2 questions');
  });

  test('keeps authored line breaks in a multi-paragraph answer', () => {
    const answer = 'First point\n\nSecond point';
    renderCall(<AskUserQuestionCall args={args} output={answer} />);

    /** Identity normalizer: the default one collapses the very newlines
     *  this asserts are preserved. */
    expect(screen.getByText(answer, { normalizer: (text) => text })).toHaveClass(
      'whitespace-pre-wrap',
    );
  });

  test('reads as settled when a run is stopped before the question is answered', () => {
    renderCall(<AskUserQuestionCall args={args} output="" toolCallId="call_1" />);

    const header = screen.getByRole('button');
    /** The pause ended; only its panel says the answer never came, and that
     *  panel starts closed — a present-tense summary would strand the record
     *  as permanently in flight. */
    expect(header).toHaveTextContent('Asked');
    expect(header).not.toHaveTextContent('Asking');
    expect(screen.getByText('No answer was given')).toBeInTheDocument();
  });

  test('announces a rejected question from outside the collapsed panel', () => {
    renderCall(<AskUserQuestionCall args={args} output="Error processing tool" failed />);

    const announcement = screen.getByRole('status');
    expect(announcement).toHaveTextContent("Question wasn't shown");
    expect(announcement).toHaveTextContent(
      "The agent couldn't show this question and may retry automatically.",
    );
    /** `useExpandCollapse` marks the closed panel inert, so an announcement
     *  inside it would never reach the accessibility tree. */
    expect(announcement.closest('[inert]')).toBeNull();
  });

  test('renders a successful tool result as the user answer', () => {
    renderCall(<AskUserQuestionCall args={args} output="public" />);

    expect(screen.getByText('You answered:')).toBeInTheDocument();
    expect(screen.getByText('Use public data')).toBeInTheDocument();
  });

  test('holds the streaming cursor under the answered card while the resume is in flight', () => {
    const { container } = renderCall(
      <AskUserQuestionCall
        args={args}
        output="public"
        toolCallId="call_1"
        isSubmitting
        showCursor
      />,
    );

    expect(screen.getByText('You answered:')).toBeInTheDocument();
    expect(container.querySelector('.result-thinking')).not.toBeNull();
  });

  test('shows no cursor once the record is not the streaming tail', () => {
    const settled = renderCall(<AskUserQuestionCall args={args} output="public" showCursor />);
    expect(settled.container.querySelector('.result-thinking')).toBeNull();

    const midStream = renderCall(
      <AskUserQuestionCall args={args} output="public" toolCallId="call_1" isSubmitting />,
    );
    expect(midStream.container.querySelector('.result-thinking')).toBeNull();
  });

  test('renders schema rejection as an internal question failure, not a user answer', () => {
    const output =
      'Error processing tool: Received tool input did not match expected schema ' +
      '✖ String must contain at most 120 character(s) → at options[0].label';

    renderCall(<AskUserQuestionCall args={args} output={output} failed />);

    expect(screen.getByText("Question wasn't shown")).toBeInTheDocument();
    expect(
      screen.getByText("The agent couldn't show this question and may retry automatically."),
    ).toBeInTheDocument();
    expect(screen.queryByText('You answered:')).not.toBeInTheDocument();
    expect(screen.queryByText(/Received tool input did not match expected schema/)).toBeNull();
  });

  test('preserves a user answer that contains the complete schema error text', () => {
    const output =
      'Error processing tool: Received tool input did not match expected schema ' +
      '✖ String must contain at most 120 character(s) → at options[0].label';

    renderCall(<AskUserQuestionCall args={args} output={output} />);

    expect(screen.getByText('You answered:')).toBeInTheDocument();
    expect(screen.getByText(output)).toBeInTheDocument();
    expect(screen.queryByText("Question wasn't shown")).not.toBeInTheDocument();
  });

  test('renders each question and answer from one completed batch', () => {
    renderCall(
      <AskUserQuestionCall
        args={JSON.stringify({
          questions: [
            {
              id: 'environment',
              header: 'Environment',
              question: 'Where should this run?',
              description: 'Choose the deployment target.',
              options: [{ label: 'Staging', value: 'staging' }],
            },
            { id: 'window', question: 'Which window?' },
          ],
        })}
        output={JSON.stringify({ answers: { environment: 'staging', window: '7d' } })}
      />,
    );

    expect(screen.getByText('Environment')).toBeInTheDocument();
    expect(screen.getByText('Where should this run?')).toBeInTheDocument();
    expect(screen.getByText('Choose the deployment target.')).toBeInTheDocument();
    expect(screen.getByText('Staging')).toBeInTheDocument();
    expect(screen.getByText('Which window?')).toBeInTheDocument();
    expect(screen.getByText('7d')).toBeInTheDocument();
  });

  test('renders a failed batch without implying the user declined to answer', () => {
    renderCall(
      <AskUserQuestionCall
        args={{ questions: [{ id: 'environment', question: 'Where should this run?' }] }}
        output="Error processing tool"
        failed
      />,
    );

    expect(screen.getByText("Question wasn't shown")).toBeInTheDocument();
    expect(
      screen.getByText("The agent couldn't show this question and may retry automatically."),
    ).toBeInTheDocument();
    expect(screen.queryByText('No answer was given')).not.toBeInTheDocument();
  });
});
