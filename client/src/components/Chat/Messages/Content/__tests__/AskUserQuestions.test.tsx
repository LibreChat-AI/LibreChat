import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import { ASK_USER_DECLINED_ANSWER } from '~/utils/approval';
import AskUserQuestions from '../AskUserQuestions';

const mockSubmitAskAnswer = jest.fn();
let mockStatus = 'idle';

jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  useAskSubmitStatus: () => ({ getAskStatus: () => mockStatus }),
  useResumeSubmit: () => ({ submitAskAnswer: mockSubmitAskAnswer }),
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<number, number>) => {
    const labels: Record<string, string> = {
      com_ui_question_number: `Question ${values?.[0] ?? ''}`,
      com_ui_question_step: `Question ${values?.[0] ?? ''} of ${values?.[1] ?? ''}`,
      com_ui_question_step_answered: `Go to question ${values?.[0] ?? ''}, answered`,
      com_ui_question_step_unanswered: `Go to question ${values?.[0] ?? ''}, not answered`,
      com_ui_question_navigation: 'Question navigation',
      com_ui_questions_remaining_one: `${values?.[0] ?? ''} question still needs an answer`,
      com_ui_questions_remaining: `${values?.[0] ?? ''} questions still need an answer`,
      com_ui_your_answer: 'Your answer',
      com_ui_back: 'Back',
      com_ui_next: 'Next',
      com_ui_skip: 'Skip',
      com_ui_submit: 'Submit',
      com_ui_submitting: 'Submitting',
    };
    return labels[key] ?? key;
  },
}));

const questions: Agents.AskUserQuestionBatchItem[] = [
  {
    id: 'environment',
    header: 'Environment',
    question: 'Where should this run?',
    options: [
      { label: 'Staging', value: 'staging' },
      { label: 'Production', value: 'production' },
    ],
  },
  { id: 'window', question: 'Which time window?' },
];

const renderBatch = (actionId: string, batch: Agents.AskUserQuestionBatchItem[] = questions) =>
  render(
    <RecoilRoot>
      <AskUserQuestions actionId={actionId} questions={batch} />
    </RecoilRoot>,
  );

/** Every step stays mounted for the swap animation; only the active one is
 *  exposed, the rest sit in a closed, `aria-hidden` collapse. */
const isShown = (text: string) => screen.getByText(text).closest('[aria-hidden="true"]') == null;

describe('AskUserQuestions', () => {
  beforeEach(() => {
    mockStatus = 'idle';
    mockSubmitAskAnswer.mockClear();
  });

  test('shows one question at a time and walks the batch with Next/Back', () => {
    renderBatch('ask-steps');

    expect(isShown('Where should this run?')).toBe(true);
    expect(isShown('Which time window?')).toBe(false);
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    expect(isShown('Which time window?')).toBe(true);
    expect(isShown('Where should this run?')).toBe(false);
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(isShown('Where should this run?')).toBe(true);
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  test('advances automatically when a single-select choice is picked', () => {
    renderBatch('ask-advance');

    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));

    expect(isShown('Which time window?')).toBe(true);
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
  });

  test('does not auto-advance a multi-select question', () => {
    renderBatch('ask-multi', [
      {
        id: 'regions',
        question: 'Which regions?',
        multiSelect: true,
        options: [
          { label: 'us-east', value: 'us-east' },
          { label: 'eu-west', value: 'eu-west' },
        ],
      },
      { id: 'window', question: 'Which time window?' },
    ]);

    fireEvent.click(screen.getByRole('checkbox', { name: /us-east/ }));

    expect(isShown('Which regions?')).toBe(true);
    expect(screen.getByText('Question 1 of 2')).toBeInTheDocument();
  });

  test('submits one answer map after every question is complete', () => {
    renderBatch('ask-batch');

    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Which time window/ }), {
      target: { value: 'Last seven days' },
    });

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(mockSubmitAskAnswer).toHaveBeenCalledWith(
      'ask-batch',
      {
        environment: 'staging',
        window: 'Last seven days',
      },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('keeps Submit gated on the last step until every question is answered', () => {
    renderBatch('ask-gated');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
    expect(
      screen.getByRole('button', { name: '2 questions still need an answer' }),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByRole('textbox', { name: /Which time window/ }), {
      target: { value: 'Today' },
    });
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: '1 question still needs an answer' }));
    expect(isShown('Where should this run?')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });

  test('jumps to any question from the step dots and marks answered ones', () => {
    renderBatch('ask-dots');

    fireEvent.click(screen.getByRole('button', { name: 'Go to question 2, not answered' }));
    expect(isShown('Which time window?')).toBe(true);

    fireEvent.change(screen.getByRole('textbox', { name: /Which time window/ }), {
      target: { value: 'Today' },
    });
    expect(screen.getByRole('button', { name: 'Go to question 2, answered' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Go to question 1, not answered' }));
    expect(isShown('Where should this run?')).toBe(true);
  });

  test('retains partial answers and the current step across surface remounts', () => {
    const view = renderBatch('ask-remount');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.change(screen.getByRole('textbox', { name: /Which time window/ }), {
      target: { value: 'Today' },
    });

    view.rerender(
      <RecoilRoot>
        <AskUserQuestions actionId="ask-remount" questions={questions} />
      </RecoilRoot>,
    );

    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Which time window/ })).toHaveValue('Today');
  });

  test('leaves a single-question batch free of stepper chrome', () => {
    renderBatch('ask-single', [
      { id: 'confirmation', question: 'Continue?', options: [{ label: 'Yes', value: 'yes' }] },
    ]);

    expect(screen.queryByRole('button', { name: 'Next' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Back' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Question navigation' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockSubmitAskAnswer).toHaveBeenCalledWith(
      'ask-single',
      { confirmation: 'yes' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('supports question ids inherited by ordinary objects', () => {
    renderBatch('ask-prototype-id', [
      {
        id: 'constructor',
        question: 'Continue?',
        options: [{ label: 'Yes', value: 'yes' }],
      },
    ]);

    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockSubmitAskAnswer).toHaveBeenCalledWith(
      'ask-prototype-id',
      { constructor: 'yes' },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  test('keeps an expired batch readable but freezes steps mid-submit', () => {
    mockStatus = 'expired';
    const view = renderBatch('ask-expired');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(isShown('Which time window?')).toBe(true);

    mockStatus = 'submitting';
    view.rerender(
      <RecoilRoot>
        <AskUserQuestions actionId="ask-expired" questions={questions} />
      </RecoilRoot>,
    );
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
  });

  test('skips the whole batch from any step', () => {
    renderBatch('ask-skip');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Skip' }));

    expect(mockSubmitAskAnswer).toHaveBeenCalledWith(
      'ask-skip',
      { environment: ASK_USER_DECLINED_ANSWER, window: ASK_USER_DECLINED_ANSWER },
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });
});
