import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import ApprovalProvider from '../ApprovalContext';
import ToolApproval from '../ToolApproval';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string | number>) => {
    if (key === 'com_ui_submit_decisions') {
      return `Submit ${values?.[0]} decisions`;
    }
    const map: Record<string, string> = {
      com_ui_approve: 'Approve',
      com_ui_reject: 'Reject',
      com_ui_edit: 'Edit',
      com_ui_respond: 'Respond',
      com_ui_submit: 'Submit',
      com_ui_submitting: 'Submitting',
      com_ui_invalid_json: 'Invalid JSON',
      com_ui_reject_reason_placeholder: 'Reason',
      com_ui_tool_response_placeholder: 'Response',
    };
    return map[key] ?? key;
  },
}));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/Providers/ChatContext', () => ({
  ChatContext: jest.requireActual('react').createContext(null),
}));

const approval = (
  allowed: Agents.ToolApprovalDecisionType[] = ['approve', 'reject'],
): NonNullable<Agents.ToolCall['approval']> => ({
  actionId: 'action-1',
  allowed_decisions: allowed,
});

const renderCards = (cards: React.ReactNode) =>
  render(
    <RecoilRoot>
      <ApprovalProvider>{cards}</ApprovalProvider>
    </RecoilRoot>,
  );

describe('ToolApproval', () => {
  test('enables Submit immediately after Approve is the first decision (#14390)', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />);

    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));

    expect(submit).toBeEnabled();
  });

  test('deselecting the active decision disables Submit again', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />);

    const approve = screen.getByRole('button', { name: 'Approve' });
    fireEvent.click(approve);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();

    fireEvent.click(approve);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeDisabled();
  });

  test('a respond decision only counts once its text is non-empty', () => {
    renderCards(<ToolApproval approval={approval(['respond'])} toolCallId="call-1" args={{}} />);

    fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
    const submit = screen.getByRole('button', { name: 'Submit' });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByRole('textbox', { name: 'Respond' }), {
      target: { value: 'use the staging table' },
    });
    expect(submit).toBeEnabled();
  });

  test('every decision field names its own text, placeholder and border tokens', () => {
    renderCards(
      <ToolApproval
        approval={approval(['approve', 'reject', 'edit', 'respond'])}
        toolCallId="call-1"
        args={{ a: 1 }}
      />,
    );

    for (const decision of ['Reject', 'Respond', 'Edit'] as const) {
      const toggle = screen.getByRole('button', { name: decision });
      fireEvent.click(toggle);
      const field = screen.getByRole('textbox', { name: decision });
      // A bare `textarea` inherits its colour, so the tokens have to be named here.
      expect(field).toHaveClass('text-text-primary');
      expect(field).toHaveClass('border-border-xheavy');
      if (decision !== 'Edit') {
        expect(field).toHaveClass('placeholder:text-text-secondary');
      }
      fireEvent.click(toggle);
    }
  });

  test('invalid edit JSON replaces the field border rather than doubling it', () => {
    renderCards(<ToolApproval approval={approval(['edit'])} toolCallId="call-1" args={{ a: 1 }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit' });
    fireEvent.change(field, { target: { value: '{' } });

    expect(field).toHaveClass('border-red-500');
    expect(field).not.toHaveClass('border-border-xheavy');
    expect(screen.getByText('Invalid JSON')).toBeInTheDocument();
  });

  test('multiple paused calls share one Submit that requires every decision', () => {
    renderCards(
      <>
        <ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
        <ToolApproval approval={approval()} toolCallId="call-2" args={{ b: 2 }} />
      </>,
    );

    const submit = screen.getByRole('button', { name: 'Submit 2 decisions' });
    expect(submit).toBeDisabled();

    const [approveFirst, approveSecond] = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(approveFirst);
    expect(submit).toBeDisabled();

    fireEvent.click(approveSecond);
    expect(submit).toBeEnabled();
  });

  test('duplicated review surfaces show and submit the same decision state', () => {
    renderCards(
      <>
        <ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
        <ToolApproval
          approval={approval()}
          toolCallId="call-1"
          args={{ a: 1 }}
          showSubmit={false}
        />
      </>,
    );

    const [timelineApprove, composerApprove] = screen.getAllByRole('button', { name: 'Approve' });
    const [timelineReject, composerReject] = screen.getAllByRole('button', { name: 'Reject' });

    fireEvent.click(timelineApprove);
    expect(timelineApprove).toHaveAttribute('aria-pressed', 'true');
    expect(composerApprove).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(composerReject);
    expect(timelineApprove).toHaveAttribute('aria-pressed', 'false');
    expect(composerApprove).toHaveAttribute('aria-pressed', 'false');
    expect(timelineReject).toHaveAttribute('aria-pressed', 'true');
    expect(composerReject).toHaveAttribute('aria-pressed', 'true');
    const [timelineReason, composerReason] = screen.getAllByRole('textbox', { name: 'Reject' });
    fireEvent.change(timelineReason, { target: { value: 'not on this machine' } });
    expect(timelineReason).toHaveValue('not on this machine');
    expect(composerReason).toHaveValue('not on this machine');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });

  test('restores a selected decision when the card remounts inside the same message', () => {
    const tree = (key: string) => (
      <RecoilRoot>
        <ApprovalProvider>
          <ToolApproval key={key} approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
        </ApprovalProvider>
      </RecoilRoot>
    );
    const view = render(tree('direct'));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');

    view.rerender(tree('phase-slice'));

    expect(screen.getByRole('button', { name: 'Approve' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();
  });
});
