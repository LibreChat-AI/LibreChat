import React from 'react';
import { RecoilRoot } from 'recoil';
import { ASK_USER_DECLINED_ANSWER } from '@librechat/chat';
import { ChatSurfaceProvider } from '@librechat/chat/react';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ShortcutBinding } from '@librechat/chat';
import type { Agents } from 'librechat-data-provider';
import ApprovalProvider from '../ApprovalContext';
import AskUserQuestion from '../AskUserQuestion';

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

const yieldedChords = new Set<string>();
let submitOverride: ShortcutBinding | undefined;

const tree = (
  key: string,
  question: Agents.AskUserQuestionRequest = { question: 'Which environment?' },
  enterToSend = true,
  actionId = 'ask-1',
) => (
  <RecoilRoot>
    <ChatSurfaceProvider
      value={{
        enterToSend,
        maximizeChatSpace: false,
        showScrollButton: false,
        composerBindings: { shortcutsEnabled: true, submitOverride, yieldedChords },
        claimForeground: jest.fn(),
        handOffComposerText: jest.fn(),
      }}
    >
      <ApprovalProvider>
        <AskUserQuestion key={key} actionId={actionId} question={question} />
      </ApprovalProvider>
    </ChatSurfaceProvider>
  </RecoilRoot>
);

const withOptions: Agents.AskUserQuestionRequest = {
  question: 'Which environment?',
  options: [
    { label: 'Staging', value: 'staging' },
    { label: 'Production', value: 'production' },
  ],
};

describe('AskUserQuestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPopoverVisible = false;
    mockCollapsed = false;
    mockLiveActionId = null;
    mockChecked = [];
    mockAnswerText = '';
    submitOverride = undefined;
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

    test('a submit shortcut rebound off Enter submits the answer', () => {
      submitOverride = { meta: false, ctrl: true, alt: false, shift: false, key: 'J' };
      render(liveTree(true));
      fireEvent.keyDown(answerBox(), { key: 'j', ctrlKey: true });
      expect(mockSubmitAnswer).toHaveBeenCalledWith(['Use staging first']);
    });

    test('does not submit an empty answer', () => {
      render(liveTree(true, '   '));
      fireEvent.keyDown(answerBox(), { key: 'Enter' });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });
  });

  describe('Escape', () => {
    const liveTree = (answerText = '') => {
      mockCollapsed = true;
      mockLiveActionId = 'ask-1';
      mockAnswerText = answerText;
      return tree('live', { question: 'Which environment?' });
    };
    const answerBox = () => screen.getByRole('textbox', { name: 'Your answer' });

    test('skips the question when nothing is entered', () => {
      render(liveTree());
      fireEvent.keyDown(answerBox(), { key: 'Escape' });
      expect(mockSubmitAnswer).toHaveBeenCalledWith([ASK_USER_DECLINED_ANSWER]);
    });

    test('keeps a typed answer instead of skipping', () => {
      render(liveTree('Use staging first'));
      fireEvent.keyDown(answerBox(), { key: 'Escape' });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });

    test('keeps checked options instead of skipping', () => {
      mockCollapsed = true;
      mockLiveActionId = 'ask-1';
      mockChecked = [0];
      render(
        tree('live', {
          question: 'Choose a source',
          multiSelect: true,
          options: [{ label: 'Public data', value: 'public' }],
        }),
      );
      fireEvent.keyDown(answerBox(), { key: 'Escape' });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });

    test('ignores Escape that cancels an IME composition or carries a modifier', () => {
      render(liveTree());
      fireEvent.keyDown(answerBox(), { key: 'Escape', isComposing: true });
      fireEvent.keyDown(answerBox(), { key: 'Escape', shiftKey: true });
      expect(mockSubmitAnswer).not.toHaveBeenCalled();
    });
  });

  describe('arrival focus', () => {
    /* jsdom has no layout, so without an observer `useArrivalFocus` arrives at once. The shared
       inert observer never reports, so nothing would arrive and the negative cases would pass
       without testing anything. */
    const inertObserver = window.IntersectionObserver;

    beforeEach(() => {
      Reflect.deleteProperty(window, 'IntersectionObserver');
    });

    afterEach(() => {
      window.IntersectionObserver = inertObserver;
      document.getElementById('prompt-textarea')?.remove();
    });

    test('puts the user on the first option when a live question arrives', () => {
      mockLiveActionId = 'arrive-option';
      render(tree('arrive', withOptions, true, 'arrive-option'));
      expect(screen.getByRole('button', { name: /Staging/ })).toHaveFocus();
    });

    test('puts the user in the answer field when the question has no options', () => {
      mockLiveActionId = 'arrive-field';
      render(tree('arrive', { question: 'Which environment?' }, true, 'arrive-field'));
      expect(screen.getByRole('textbox', { name: 'Your answer' })).toHaveFocus();
    });

    test('takes focus from the empty composer that sent the turn', () => {
      const composer = document.createElement('textarea');
      composer.id = 'prompt-textarea';
      document.body.appendChild(composer);
      composer.focus();

      mockLiveActionId = 'arrive-composer';
      render(tree('arrive', withOptions, true, 'arrive-composer'));
      expect(screen.getByRole('button', { name: /Staging/ })).toHaveFocus();
    });

    test('leaves focus alone while the user is drafting in the composer', () => {
      const composer = document.createElement('textarea');
      composer.id = 'prompt-textarea';
      composer.value = 'half a thought';
      document.body.appendChild(composer);
      composer.focus();

      mockLiveActionId = 'arrive-draft';
      render(tree('arrive', withOptions, true, 'arrive-draft'));
      expect(composer).toHaveFocus();
    });

    test('arrives once, not again when the card remounts', () => {
      mockLiveActionId = 'arrive-once';
      const view = render(tree('arrive', withOptions, true, 'arrive-once'));
      expect(screen.getByRole('button', { name: /Staging/ })).toHaveFocus();
      view.unmount();

      render(tree('arrive', withOptions, true, 'arrive-once'));
      expect(document.body).toHaveFocus();
    });

    test('does not take focus while the question is in the composer popover', () => {
      mockLiveActionId = 'arrive-popover';
      mockPopoverVisible = true;
      render(tree('arrive', withOptions, true, 'arrive-popover'));
      expect(document.body).toHaveFocus();
    });

    test('does not take focus for a question that is not the live pause', () => {
      render(tree('arrive', withOptions, true, 'arrive-not-live'));
      expect(document.body).toHaveFocus();
    });
  });
});
