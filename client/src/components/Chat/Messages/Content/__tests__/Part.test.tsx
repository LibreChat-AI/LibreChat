import React from 'react';
import { render, screen } from '@testing-library/react';
import { Constants, ContentTypes, Tools } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import Part from '../Part';

jest.mock('../MessageContent', () => ({
  ErrorMessage: ({ text }: { text: string }) => <div data-testid="error-message">{text}</div>,
}));
jest.mock('../AskUserQuestion', () => ({
  __esModule: true,
  default: ({ actionId, question }: { actionId: string; question?: string }) => (
    <div data-testid="ask-user-question" data-action-id={actionId}>
      {question}
    </div>
  ),
}));
jest.mock('../ToolApproval', () => ({
  __esModule: true,
  default: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval" data-tool-call-id={toolCallId} />
  ),
}));
/** Web search is the chat package's card now; this stands in for its module. */
jest.mock('@librechat/chat/dist/components/parts/WebSearch.cjs', () => ({
  ...jest.requireActual('@librechat/chat/dist/components/parts/WebSearch.cjs'),
  WebSearchCall: () => <div data-testid="web-search" />,
}));
jest.mock('../Parts', () => ({
  SubagentCall: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="subagent-call" data-tool-call-id={toolCallId} />
  ),
}));
jest.mock('../toolCallSlots', () => ({}));
jest.mock('@librechat/chat/components', () => ({
  ...jest.requireActual('@librechat/chat/components'),
}));

const asPart = (part: Record<string, unknown>) => part as unknown as TMessageContentParts;

const call = (name: string, toolCall: Record<string, unknown> = {}) =>
  asPart({
    type: ContentTypes.TOOL_CALL,
    [ContentTypes.TOOL_CALL]: {
      id: 'call_1',
      name,
      args: '{}',
      output: 'done',
      progress: 1,
      ...toolCall,
    },
  });

const draw = (part: TMessageContentParts) =>
  render(<Part part={part} isSubmitting={false} showCursor={false} isCreatedByUser={false} />);

describe('the app’s part renderers, over the chat package’s', () => {
  it('draws an error part with the app’s error message, from whichever field holds the text', () => {
    const { unmount } = draw(asPart({ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'bad' }));
    expect(screen.getByTestId('error-message')).toHaveTextContent('bad');
    unmount();
    draw(asPart({ type: ContentTypes.ERROR, text: { value: 'worse' } }));
    expect(screen.getByTestId('error-message')).toHaveTextContent('worse');
  });

  it('claims a paused question for the app’s ask card', () => {
    draw(
      asPart({
        type: 'ask_user_question',
        ask_user_question: { actionId: 'action-1', question: 'Which?' },
      }),
    );
    const card = screen.getByTestId('ask-user-question');
    expect(card).toHaveAttribute('data-action-id', 'action-1');
    expect(card).toHaveTextContent('Which?');
  });

  it('draws a subagent call with the app’s card and a web search with the package’s', () => {
    const { unmount } = draw(call(Constants.SUBAGENT as string));
    expect(screen.getByTestId('subagent-call')).toHaveAttribute('data-tool-call-id', 'call_1');
    unmount();
    draw(call(Tools.web_search));
    expect(screen.getByTestId('web-search')).toBeInTheDocument();
  });

  it('puts approval controls under any tool call that is paused with nothing to show yet', () => {
    draw(call(Tools.web_search, { output: '', approval: { actionId: 'a1' } }));
    expect(screen.getByTestId('web-search')).toBeInTheDocument();
    expect(screen.getByTestId('tool-approval')).toHaveAttribute('data-tool-call-id', 'call_1');
  });

  it('shows no approval controls once the call has output, or when it never paused', () => {
    const { unmount } = draw(call(Tools.web_search, { approval: { actionId: 'a1' } }));
    expect(screen.queryByTestId('tool-approval')).not.toBeInTheDocument();
    unmount();
    draw(call(Tools.web_search, { output: '' }));
    expect(screen.queryByTestId('tool-approval')).not.toBeInTheDocument();
  });

  it('leaves every other part to the chat package', () => {
    draw(asPart({ type: ContentTypes.ACTIVITY_LABEL, [ContentTypes.ACTIVITY_LABEL]: 'Searched' }));
    expect(screen.getByText('Searched')).toBeInTheDocument();
  });
});
