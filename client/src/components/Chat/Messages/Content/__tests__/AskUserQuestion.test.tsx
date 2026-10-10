import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import ApprovalProvider from '../ApprovalContext';
import AskUserQuestion from '../AskUserQuestion';
import store from '~/store';

const mockSubmitAnswer = jest.fn();
const mockSetAnswerText = jest.fn();
const mockInsertTextAtCursor = jest.fn();
let mockPopoverVisible = false;
let mockCollapsed = false;
let mockLiveActionId: string | null = null;
let mockChecked: number[] = [];
let mockAnswerText = '';

/** jsdom has no execCommand, so the newline path is observed through the mock. */
jest.mock('~/utils/textarea', () => ({
  ...jest.requireActual('~/utils/textarea'),
  forceResize: jest.fn(),
  insertTextAtCursor: (...args: unknown[]) => mockInsertTextAtCursor(...args),
}));

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
  enterToSend = true,
) => (
  <RecoilRoot initializeState={({ set }) => set(store.enterToSend, enterToSend)}>
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

  describe('answer box keyboard submit', () => {
    const liveTree = (enterToSend: boolean, answerText = 'Use staging first') => {
      mockCollapsed = true;
      mockLiveActionId = 'ask-1';
      mockAnswerText = answerText;
      return tree('live', { question: 'Which environment?' }, enterToSend);
    };
    const answerBox = () => screen.getByRole('textbox', { name: 'Your answer' });

    test('Enter submits when Enter-to-send is on', () => {
      render(liveTree(true));
      fireEvent.keyDown(answerBox(), { key: 'Enter' });
      expect(mockSubmitAnswer).toHaveBeenCalledWith(['Use staging first']);
    });

    test('Ctrl+Enter and Cmd+Enter submit when Enter-to-send is off', () => {
      render(liveTree(false));
      fireEvent.keyDown(answerBox(), { key: 'Enter', ctrlKey: true });
      fireEvent.keyDown(answerBox(), { key: 'Enter', metaKey: true });
      expect(mockSubmitAnswer).toHaveBeenCalledTimes(2);
    });

    test('plain Enter writes a newline instead of submitting when Enter-to-send is off', () => {
      render(liveTree(false));
      fireEvent.keyDown(answerBox(), { key: 'Enter' });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
      expect(mockInsertTextAtCursor).toHaveBeenCalledWith(answerBox(), '\n');
    });

    test('Shift+Enter never submits', () => {
      render(liveTree(true));
      fireEvent.keyDown(answerBox(), { key: 'Enter', shiftKey: true });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });

    test('Enter confirming an IME composition does not submit', () => {
      render(liveTree(true));
      fireEvent.keyDown(answerBox(), { key: 'Enter', keyCode: 229 });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });

    test('does not submit an empty answer', () => {
      render(liveTree(true, '   '));
      fireEvent.keyDown(answerBox(), { key: 'Enter' });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });
  });
});
