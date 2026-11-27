import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChatContext } from '~/Providers/ChatContext';
import AskUserQuestions from '../AskUserQuestions';
import ApprovalProvider from '../ApprovalContext';
import AskUserQuestion from '../AskUserQuestion';

const mockMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useCachedMessages: () => ({ data: null }),
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: mockMutate }),
}));

const conversation = {
  conversation: { conversationId: 'conversation-1', endpoint: 'agents' },
  getMessages: () => [],
  setMessages: jest.fn(),
};

function renderQuestion() {
  return render(
    <ChatContext.Provider value={conversation as never}>
      <ApprovalProvider>
        <AskUserQuestion
          actionId="ask-1"
          question={{
            question: 'Which environment?',
            options: [{ label: 'Staging', value: 'staging' }],
          }}
        />
      </ApprovalProvider>
    </ChatContext.Provider>,
  );
}

describe('ask card adapters', () => {
  beforeEach(() => {
    mockMutate.mockClear();
  });

  test('restores a typed answer through the approval host after the card remounts', () => {
    const view = renderQuestion();
    fireEvent.change(screen.getByRole('textbox', { name: 'Type your answer…' }), {
      target: { value: 'Use staging first' },
    });

    view.rerender(
      <ChatContext.Provider value={conversation as never}>
        <ApprovalProvider>
          <AskUserQuestion
            key="again"
            actionId="ask-1"
            question={{ question: 'Which environment?' }}
          />
        </ApprovalProvider>
      </ChatContext.Provider>,
    );

    expect(screen.getByRole('textbox', { name: 'Type your answer…' })).toHaveValue(
      'Use staging first',
    );
  });

  test('submits a chosen option through the resume mutation', () => {
    renderQuestion();
    fireEvent.click(screen.getByRole('button', { name: /Staging/ }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        actionId: 'ask-1',
        answer: 'staging',
      }),
      expect.any(Object),
    );
  });

  test('submits a batch through the resume mutation', () => {
    render(
      <ChatContext.Provider value={conversation as never}>
        <ApprovalProvider>
          <AskUserQuestions
            actionId="ask-batch"
            questions={[
              { id: 'confirm', question: 'Continue?', options: [{ label: 'Yes', value: 'yes' }] },
            ]}
          />
        </ApprovalProvider>
      </ChatContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: /Yes/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));

    expect(mockMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        actionId: 'ask-batch',
        answers: { confirm: 'yes' },
      }),
      expect.any(Object),
    );
  });
});
