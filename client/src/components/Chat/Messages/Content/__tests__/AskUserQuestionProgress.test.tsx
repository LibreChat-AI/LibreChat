import React from 'react';
import { render, screen } from '@testing-library/react';
import AskUserQuestionProgress from '../AskUserQuestionProgress';
import { ToolPreparation } from '../preparation';

const translations: Record<string, string> = {
  com_ui_asking: 'Asking',
  com_ui_tool_name_ask_user_question: 'Question',
};

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string, string>) =>
    key === 'com_ui_tool_preparing' ? `Preparing ${values?.[0]}` : (translations[key] ?? key),
}));

jest.mock('~/Providers/ChatContext', () => {
  const { createContext } = jest.requireActual<typeof React>('react');
  return {
    ChatContext: createContext({ conversation: { conversationId: 'convo-1' } }),
  };
});

let mockLivePauses: { ids: string[]; hasUnattributed: boolean } = {
  ids: [],
  hasUnattributed: false,
};

jest.mock('~/data-provider', () => ({
  useGetMessagesByConvoId: () => ({ data: mockLivePauses }),
}));

describe('AskUserQuestionProgress', () => {
  beforeEach(() => {
    mockLivePauses = { ids: [], hasUnattributed: false };
  });

  test('streams the question text from partial args', () => {
    render(
      <AskUserQuestionProgress
        args={'{"question":"Which environment should I dep'}
        toolCallId="call_1"
      />,
    );

    expect(screen.getByText('Asking')).toBeInTheDocument();
    expect(screen.getByText('Which environment should I dep')).toBeInTheDocument();
  });

  test('decodes JSON escapes in the streaming question', () => {
    render(
      <AskUserQuestionProgress args={'{"question":"Caf\\u00e9 or \\"bar\\"'} toolCallId="call_1" />,
    );

    expect(screen.getByText('Café or "bar"')).toBeInTheDocument();
  });

  test('streams the first question from partial batched args', () => {
    render(
      <AskUserQuestionProgress
        args={'{"questions":[{"id":"environment","question":"Which environ'}
        toolCallId="call_1"
      />,
    );

    expect(screen.getByText('Which environ')).toBeInTheDocument();
  });

  test('reads the first question from settled batched args', () => {
    render(
      <AskUserQuestionProgress
        args={{ questions: [{ id: 'environment', question: 'Which environment?' }] }}
        toolCallId="call_1"
      />,
    );

    expect(screen.getByText('Which environment?')).toBeInTheDocument();
  });

  test('renders a skeleton line before any question text streams', () => {
    render(<AskUserQuestionProgress args="" toolCallId="call_1" />);

    expect(screen.getByText('Asking')).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  test('hides once the interactive pause for this call is live', () => {
    mockLivePauses = { ids: ['call_1'], hasUnattributed: false };

    const { container } = render(
      <AskUserQuestionProgress args={'{"question":"Ready?"}'} toolCallId="call_1" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  test('hides for an unattributed live pause (no tool_call_id on the payload)', () => {
    mockLivePauses = { ids: [], hasUnattributed: true };

    const { container } = render(
      <AskUserQuestionProgress args={'{"question":"Ready?"}'} toolCallId="call_1" />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  test("stays visible while a DIFFERENT call's pause is interactive", () => {
    mockLivePauses = { ids: ['call_1'], hasUnattributed: false };

    render(
      <AskUserQuestionProgress args={'{"question":"Second question?"}'} toolCallId="call_2" />,
    );

    expect(screen.getByText('Second question?')).toBeInTheDocument();
  });

  test('hides when its own pause is live alongside a newer sibling pause', () => {
    mockLivePauses = { ids: ['call_1', 'call_2'], hasUnattributed: false };

    const { container } = render(
      <AskUserQuestionProgress args={'{"question":"First question?"}'} toolCallId="call_1" />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});

describe('question preparation transitions', () => {
  test('announces preparation until measured dispatch, then asking until its interactive pause', () => {
    mockLivePauses = { ids: [], hasUnattributed: false };
    const frame = (args: string, toolDispatchedAt?: number) => (
      <ToolPreparation
        call={{ name: 'ask_user_question', args, toolPreparationStartedAt: 0, toolDispatchedAt }}
        isSubmitting
      >
        <AskUserQuestionProgress args={args} toolCallId="call_1" />
      </ToolPreparation>
    );
    const { rerender } = render(frame('{"question":"Which environment'));
    expect(screen.getByRole('status')).toHaveTextContent('Preparing Question');
    expect(screen.getByText('Which environment')).toBeInTheDocument();
    rerender(frame('{"question":"Which environment?"}'));
    expect(screen.getByRole('status')).toHaveTextContent('Preparing Question');
    rerender(frame('{"question":"Which environment?"}', 100));
    expect(screen.getByRole('status')).toHaveTextContent('Asking');
    mockLivePauses = { ids: ['call_1'], hasUnattributed: false };
    rerender(frame('{"question":"Which environment?"}', 100));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
