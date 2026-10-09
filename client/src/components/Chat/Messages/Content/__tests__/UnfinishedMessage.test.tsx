import React from 'react';
import { Constants } from 'librechat-data-provider';
import { render, screen } from '@testing-library/react';
import type { TMessage } from 'librechat-data-provider';
import { UnfinishedMessage } from '../MessageContent';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

/** `Container` reads message context for sequential-agent layout; not under test. */
jest.mock('../Container', () => ({
  __esModule: true,
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

jest.mock('~/components/Messages/Content/Error', () => ({
  __esModule: true,
  default: ({ text }: { text: string }) => <span>{text}</span>,
}));

jest.mock('../ToolCallLimitNotice', () => ({
  __esModule: true,
  default: () => <div data-testid="tool-call-limit-notice" />,
}));

/** `Constants` is a heterogeneous enum, so its members are not directly
 *  assignable to `finish_reason`'s `string`; coerce rather than duplicate the value. */
const TOOL_CALL_LIMIT = String(Constants.TOOL_CALL_LIMIT_FINISH_REASON);

const message = (overrides: Partial<TMessage> = {}) =>
  ({ messageId: 'response-1', ...overrides }) as TMessage;

describe('UnfinishedMessage', () => {
  it('routes a step-limit turn to the actionable notice, not an error box', () => {
    render(<UnfinishedMessage message={message({ finish_reason: TOOL_CALL_LIMIT })} />);

    expect(screen.getByTestId('tool-call-limit-notice')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the generic incomplete warning for every other unfinished turn', () => {
    render(<UnfinishedMessage message={message()} />);

    expect(screen.queryByTestId('tool-call-limit-notice')).not.toBeInTheDocument();
    expect(screen.getByText('com_ui_response_incomplete')).toBeInTheDocument();
  });

  it('does not mistake an unrelated finish reason for the step limit', () => {
    render(<UnfinishedMessage message={message({ finish_reason: 'length' })} />);

    expect(screen.queryByTestId('tool-call-limit-notice')).not.toBeInTheDocument();
  });

  it('localizes the generic warning instead of hardcoding English', () => {
    render(<UnfinishedMessage message={message()} />);

    expect(screen.queryByText(/The response is incomplete/)).not.toBeInTheDocument();
  });
});
