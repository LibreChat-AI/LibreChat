import React from 'react';
import { render, screen } from '@testing-library/react';
import { Constants, ContentTypes, Tools } from 'librechat-data-provider';
import type { TMessageContentParts } from 'librechat-data-provider';
import Part from '../Part';

/** An error part is the chat package's card now; this stands in for its module. */
jest.mock('@librechat/chat/dist/components/errors/ErrorMessage.cjs', () => ({
  ...jest.requireActual('@librechat/chat/dist/components/errors/ErrorMessage.cjs'),
  __esModule: true,
  default: ({ text }: { text: string }) => <div data-testid="error-message">{text}</div>,
}));
jest.mock('~/components/Messages/Content/Error/register', () => ({}));
/** The paused question and the approval controls are the chat package's; the app supplies only
 *  how they resume, so they stand in by their package module here. */
jest.mock('@librechat/chat/dist/components/approval/hosted.cjs', () => ({
  HostedQuestion: ({ actionId, question }: { actionId: string; question?: string }) => (
    <div data-testid="ask-user-question" data-action-id={actionId}>
      {question}
    </div>
  ),
  HostedToolApproval: ({ toolCallId }: { toolCallId: string }) => (
    <div data-testid="tool-approval" data-tool-call-id={toolCallId} />
  ),
}));
/** Web search is the chat package's card now; this stands in for its module. */
jest.mock('@librechat/chat/dist/components/parts/WebSearch.cjs', () => ({
  ...jest.requireActual('@librechat/chat/dist/components/parts/WebSearch.cjs'),
  WebSearchCall: () => <div data-testid="web-search" />,
}));
/** The subagent card is the chat package's now; this stands in for its module. */
jest.mock('@librechat/chat/dist/components/parts/SubagentCall.cjs', () => ({
  ...jest.requireActual('@librechat/chat/dist/components/parts/SubagentCall.cjs'),
  __esModule: true,
  default: ({ toolCallId }: { toolCallId: string }) => (
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
  it('draws an error part with the package’s error message, from whichever field holds the text', () => {
    const { unmount } = draw(asPart({ type: ContentTypes.ERROR, [ContentTypes.ERROR]: 'bad' }));
    expect(screen.getByTestId('error-message')).toHaveTextContent('bad');
    unmount();
    draw(asPart({ type: ContentTypes.ERROR, text: { value: 'worse' } }));
    expect(screen.getByTestId('error-message')).toHaveTextContent('worse');
  });

  it('claims a paused question for the package’s ask card', () => {
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

  it('draws a subagent call and a web search with the package’s cards', () => {
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
