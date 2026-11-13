import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import useAskAnswerMode from '~/hooks/Input/useAskAnswerMode';
import { ChatContext } from '~/Providers/ChatContext';
import AskUserQuestion from '../AskUserQuestion';

/**
 * A live pause starts in the chat card, in thread order, so it fits a phone screen and never
 * covers the composer. The card's chevron moves it into the composer popover and the popover's
 * chevron moves it back. These cover both halves of the handover across the REAL atoms the
 * popover and the chat card share; a collapse that kept a batch's composer disabled once
 * stranded the user with nothing to type in and no way out short of a reload.
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
  useCachedMessages: () => ({ data: mockLiveAsk }),
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
    <Provider store={createStore()}>
      <RecoilRoot>
        <ChatContext.Provider
          value={{ conversation: { conversationId: 'conversation-1' } } as never}
        >
          <ComposerProbe />
          <AskUserQuestion
            actionId="act-1"
            question={mockLiveAsk.question}
            questions={mockLiveAsk.questions}
          />
        </ChatContext.Provider>
      </RecoilRoot>
    </Provider>,
  );

const moveToComposer = () => fireEvent.click(screen.getByLabelText('Answer from the message box'));
const flag = (id: string) => screen.getByTestId(id).textContent;

describe('a live ask_user_question between the chat and the composer', () => {
  describe('batched questions', () => {
    beforeEach(() => {
      mockLiveAsk = {
        actionId: 'act-1',
        question: mockSingle,
        questions: mockBatch,
        messageId: 'message-1',
      };
    });

    it('starts in the chat card and leaves the composer free', () => {
      renderPause();

      expect(flag('popover-visible')).toBe('false');
      expect(flag('active')).toBe('false');
      expect(flag('composer-locked')).toBe('false');
      expect(flag('composer-answers')).toBe('false');
      expect(
        screen.getByText('North star or full funnel?').closest('[aria-hidden="true"]'),
      ).toBeNull();
    });

    it('locks the composer only while the batch is in the popover', () => {
      renderPause();
      moveToComposer();

      expect(flag('active')).toBe('true');
      expect(flag('popover-visible')).toBe('true');
      expect(flag('composer-locked')).toBe('true');
      /** The popover owns the question; the card only holds its place in the
       *  thread, hidden, so moving the batch back reflows nothing. */
      expect(
        screen.getByText('North star or full funnel?').closest('[aria-hidden="true"]'),
      ).not.toBeNull();
      expect(screen.queryByLabelText('Answer from the message box')).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId('collapse-from-popover'));

      expect(flag('popover-visible')).toBe('false');
      expect(flag('active')).toBe('false');
      expect(flag('composer-locked')).toBe('false');
      expect(
        screen.getByText('North star or full funnel?').closest('[aria-hidden="true"]'),
      ).toBeNull();
    });
  });

  describe('a single question', () => {
    beforeEach(() => {
      mockLiveAsk = { actionId: 'act-1', question: mockSingle, messageId: 'message-1' };
    });

    it('answers from the card until it is moved to the composer', () => {
      renderPause();

      expect(flag('composer-answers')).toBe('false');
      expect(flag('composer-locked')).toBe('false');
      expect(screen.getByText('Which environment?')).toBeInTheDocument();

      moveToComposer();

      expect(flag('active')).toBe('true');
      expect(flag('composer-answers')).toBe('true');
      expect(flag('popover-visible')).toBe('true');

      fireEvent.click(screen.getByTestId('collapse-from-popover'));

      expect(flag('composer-answers')).toBe('false');
      expect(flag('popover-visible')).toBe('false');
    });
  });
});
