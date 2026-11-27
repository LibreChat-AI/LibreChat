/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Provider } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ApprovalResumeHost } from '../../../../react/approval';
import type { AskCardMode } from '../../../../react/parts/ask';
import { createMessagePartsHost } from '../../../../__fixtures__/partsHost';
import { ApprovalResumeHostProvider } from '../../../../react/approval';
import { MessagePartsHostProvider } from '../../../../react/host';
import { ChatContext } from '../../../../react/chat/context';
import { initEnglish } from '../../../../__fixtures__/i18n';
import { HostedQuestion } from '../../../approval/hosted';
import ApprovalProvider from '../../../approval/context';
import PausedQuestion from '../Paused';

beforeAll(initEnglish);

const mockAnswer = jest.fn();

const resumeHost = (): ApprovalResumeHost => ({
  readFields: () => ({ conversationId: 'c-1' }),
  submitToolApproval: () => undefined,
  submitAskAnswer: (body, callbacks) => mockAnswer(body, callbacks),
  readMessages: () => null,
});

const question = {
  question: 'Which environment?',
  options: [
    { label: 'Staging', value: 'staging' },
    { label: 'Production', value: 'production' },
  ],
};

const liveMode = (actionId: string): AskCardMode => ({
  popoverVisible: false,
  collapsed: true,
  expand: jest.fn(),
  liveAsk: { actionId },
  checked: [],
  toggleChecked: jest.fn(),
  submitOption: jest.fn(),
  submitAnswer: jest.fn(),
  answerText: '',
  setAnswerText: jest.fn(),
});

/** A store of its own per render: an answer's status is shared state, keyed by the action. */
const inChat = (node: React.ReactNode, index = 0) => (
  <Provider>
    <ChatContext.Provider value={{ index, conversation: { conversationId: 'c-1' } } as never}>
      <ApprovalProvider>{node}</ApprovalProvider>
    </ChatContext.Provider>
  </Provider>
);

beforeEach(() => mockAnswer.mockClear());

describe('PausedQuestion', () => {
  it('answers through the resume host it is given', () => {
    render(
      inChat(<PausedQuestion actionId="ask-1" question={question} resumeHost={resumeHost()} />),
    );

    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));
    expect(mockAnswer).toHaveBeenCalledWith(
      { conversationId: 'c-1', actionId: 'ask-1', answer: 'staging' },
      expect.anything(),
    );
  });

  it('answers through a resume host provided above it', () => {
    render(
      inChat(
        <ApprovalResumeHostProvider host={resumeHost()}>
          <PausedQuestion actionId="ask-1" question={question} />
        </ApprovalResumeHostProvider>,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: /Production/ }));
    expect(mockAnswer).toHaveBeenCalledTimes(1);
  });

  it('with no way to resume, keeps the question readable, disables its controls and says why', () => {
    render(inChat(<PausedQuestion actionId="ask-1" question={question} />));

    const note = "This question can't be answered from here.";
    expect(screen.getByText('Which environment?')).toBeInTheDocument();
    expect(screen.getByText(note)).toBeInTheDocument();
    expect(screen.getByRole('group')).toHaveAccessibleDescription(note);
    for (const name of [/Staging/, /Production/, 'Skip', 'Submit']) {
      expect(screen.getByRole('button', { name })).toBeDisabled();
    }
    expect(screen.getByRole('textbox', { name: 'Type your answer…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('offers the move to the composer only in the main pane', () => {
    const card = (
      <PausedQuestion
        actionId="ask-1"
        question={question}
        answerMode={liveMode('ask-1')}
        resumeHost={resumeHost()}
      />
    );
    const move = { name: 'Answer from the message box' };

    const main = render(inChat(card, 0));
    expect(screen.getByRole('button', move)).toBeInTheDocument();
    main.unmount();

    render(inChat(card, 1));
    expect(screen.queryByRole('button', move)).not.toBeInTheDocument();
  });
});

describe('HostedQuestion', () => {
  it('reads the composer mode for its conversation and the resume host from the host', () => {
    const useAskAnswerMode = jest.fn((_id: string | null | undefined) => liveMode('ask-1'));
    const host = createMessagePartsHost({
      useAskAnswerMode,
      useApprovalResumeHost: resumeHost,
    });
    render(
      inChat(
        <MessagePartsHostProvider host={host}>
          <HostedQuestion actionId="ask-1" question={question} />
        </MessagePartsHostProvider>,
      ),
    );

    expect(useAskAnswerMode).toHaveBeenCalledWith('c-1');
    expect(screen.getByRole('button', { name: 'Answer from the message box' })).toBeInTheDocument();
  });

  it('without host hooks, answers in its card only and says it cannot be answered here', () => {
    render(
      inChat(
        <MessagePartsHostProvider host={createMessagePartsHost()}>
          <HostedQuestion actionId="ask-1" question={question} />
        </MessagePartsHostProvider>,
      ),
    );

    expect(
      screen.queryByRole('button', { name: 'Answer from the message box' }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("This question can't be answered from here.")).toBeInTheDocument();
  });
});
