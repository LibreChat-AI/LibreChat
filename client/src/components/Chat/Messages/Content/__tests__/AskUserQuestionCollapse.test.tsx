import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { ChatContext } from '~/Providers/ChatContext';
import AskUserQuestion from '../AskUserQuestion';

/**
 * Collapsing a live pause used to strand the user: the popover carried the only
 * dismiss, and a batch kept the composer disabled for as long as the pause was
 * active — so after the chevron there was nothing to type in, nothing to send
 * with, no stop button, and no × anywhere. Reloading the page was the only way
 * out. These cover both halves of the handover across the REAL recoil atoms the
 * popover and the chat card share.
 */

const mockBatch: Agents.AskUserQuestionBatchItem[] = [
  { id: 'scope', header: 'Dashboard scope', question: 'North star or full funnel?' },
  { id: 'window', question: 'Which time window?' },
];

const mockSingle = {
  question: 'Which environment?',
  options: [{ label: 'Staging', value: 'staging' }],
} as Agents.AskUserQuestionRequest;

let mockLiveAsk: {
  actionId: string;
  question: Agents.AskUserQuestionRequest;
  questions?: Agents.AskUserQuestionBatchItem[];
  messageId: string;
} = {
  actionId: 'act-1',
  question: mockSingle,
  questions: mockBatch,
  messageId: 'message-1',
};

jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: () => ({ data: mockLiveAsk }),
}));
jest.mock('~/components/Chat/Messages/Content/ApprovalContext', () => ({
  useApprovalContext: () => ({ getAskAnswerDraft: () => '', setAskAnswerDraft: jest.fn() }),
  useAskSubmitStatus: () => ({ getAskStatus: () => 'idle' }),
  useResumeSubmit: () => ({ submitAskAnswer: jest.fn() }),
}));
jest.mock('~/Providers', () => ({ useOptionalChatFormContext: () => null }));

/** Stands in for the composer: publishes the flags ChatForm gates on. */
function ComposerProbe() {
  const ask = useAskAnswerMode('conversation-1');
  return (
    <div>
      <span data-testid="composer-locked">{String(ask.composerLocked)}</span>
      <span data-testid="composer-answers">{String(ask.composerAnswers)}</span>
      <span data-testid="popover-visible">{String(ask.popoverVisible)}</span>
      <span data-testid="active">{String(ask.active)}</span>
      <button data-testid="collapse-from-popover" onClick={ask.collapse} />
    </div>
  );
}

const renderPause = () =>
  render(
    <RecoilRoot>
      <ChatContext.Provider value={{ conversation: { conversationId: 'conversation-1' } } as never}>
        <ComposerProbe />
        <AskUserQuestion
          actionId="act-1"
          question={mockLiveAsk.question}
          questions={mockLiveAsk.questions}
        />
      </ChatContext.Provider>
    </RecoilRoot>,
  );

describe('collapsing a live ask_user_question', () => {
  describe('batched questions', () => {
    beforeEach(() => {
      mockLiveAsk = {
        actionId: 'act-1',
        question: mockSingle,
        questions: mockBatch,
        messageId: 'message-1',
      };
    });

    it('locks the composer only while the popover is up', () => {
      renderPause();
      expect(screen.getByTestId('composer-locked').textContent).toBe('true');
      /** The popover owns the question, so the card stays out of the way. */
      expect(screen.queryByText('North star or full funnel?')).toBeNull();

      fireEvent.click(screen.getByTestId('collapse-from-popover'));

      expect(screen.getByTestId('popover-visible').textContent).toBe('false');
      /** The pause is still live, but the card owns it outside answer mode. */
      expect(screen.getByTestId('active').textContent).toBe('false');
      expect(screen.getByText('North star or full funnel?')).toBeInTheDocument();
      /** The composer is a normal composer again. */
      expect(screen.getByTestId('composer-locked').textContent).toBe('false');
      expect(screen.getByTestId('composer-answers').textContent).toBe('false');
    });

    it('moves the collapsed card back to the popover', () => {
      renderPause();
      fireEvent.click(screen.getByTestId('collapse-from-popover'));

      fireEvent.click(screen.getByLabelText('Expand'));

      expect(screen.getByTestId('active').textContent).toBe('true');
      expect(screen.getByTestId('popover-visible').textContent).toBe('true');
      expect(screen.getByTestId('composer-locked').textContent).toBe('true');
      expect(screen.queryByLabelText('Expand')).not.toBeInTheDocument();
    });
  });

  describe('a single question', () => {
    beforeEach(() => {
      mockLiveAsk = { actionId: 'act-1', question: mockSingle, messageId: 'message-1' };
    });

    it('releases the composer until the card moves back to the popover', () => {
      renderPause();
      expect(screen.getByTestId('composer-answers').textContent).toBe('true');
      expect(screen.getByTestId('composer-locked').textContent).toBe('false');

      fireEvent.click(screen.getByTestId('collapse-from-popover'));

      /** The card now owns the answer, so the normal composer is available. */
      expect(screen.getByTestId('composer-answers').textContent).toBe('false');
      expect(screen.getByText('Which environment?')).toBeInTheDocument();

      fireEvent.click(screen.getByLabelText('Answer from the message box'));

      expect(screen.getByTestId('active').textContent).toBe('true');
      expect(screen.getByTestId('composer-answers').textContent).toBe('true');
      expect(screen.getByTestId('popover-visible').textContent).toBe('true');
    });
  });
});
