import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import ApprovalProvider from '../ApprovalContext';
import AskUserQuestion from '../AskUserQuestion';

const mockSubmitAnswer = jest.fn();
const mockSetAnswerText = jest.fn();
let mockPopoverVisible = false;
let mockCollapsed = false;
let mockLiveActionId: string | null = null;
let mockChecked: number[] = [];
let mockAnswerText = '';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => {
    const labels: Record<string, string> = {
      com_ui_your_answer: 'Your answer',
      com_ui_skip: 'Skip',
      com_ui_submit: 'Submit',
      com_ui_submitting: 'Submitting',
    };
    return labels[key] ?? key;
  },
}));

jest.mock('~/hooks/Input/useAskAnswerMode', () => ({
  __esModule: true,
  default: () => ({
    popoverVisible: mockPopoverVisible,
    collapsed: mockCollapsed,
    expand: jest.fn(),
    liveAsk: mockLiveActionId == null ? null : { actionId: mockLiveActionId },
    checked: mockChecked,
    toggleChecked: jest.fn(),
    submitOption: jest.fn(),
    submitAnswer: mockSubmitAnswer,
    answerText: mockAnswerText,
    setAnswerText: mockSetAnswerText,
  }),
}));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/store/agents', () => ({
  useGetEphemeralAgent: () => () => undefined,
}));

jest.mock('~/Providers/ChatContext', () => ({
  ChatContext: jest.requireActual('react').createContext({
    conversation: { conversationId: 'conversation-1' },
  }),
}));

const tree = (
  key: string,
  question: Agents.AskUserQuestionRequest = { question: 'Which environment?' },
) => (
  <RecoilRoot>
    <ApprovalProvider>
      <AskUserQuestion key={key} actionId="ask-1" question={question} />
    </ApprovalProvider>
  </RecoilRoot>
);

describe('AskUserQuestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPopoverVisible = false;
    mockCollapsed = false;
    mockLiveActionId = null;
    mockChecked = [];
    mockAnswerText = '';
  });

  test('restores a typed answer after the card remounts inside the same message', () => {
    const view = render(tree('direct'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your answer' }), {
      target: { value: 'Use staging first' },
    });

    view.rerender(tree('phase-slice'));

    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue('Use staging first');
  });

  test('submits checked options together with free text carried from the composer', () => {
    mockCollapsed = true;
    mockLiveActionId = 'ask-1';
    mockChecked = [0];
    mockAnswerText = 'carried free-form answer';

    render(
      tree('live', {
        question: 'Choose a source',
        multiSelect: true,
        options: [{ label: 'Public data', value: 'public' }],
      }),
    );

    expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveValue(
      'carried free-form answer',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockSubmitAnswer).toHaveBeenCalledWith(['public', 'carried free-form answer']);
  });
});
