import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import {
  approvalPanelOpenFamily,
  pendingApprovalActionFamily,
} from '~/components/Chat/approval/state';
import { ChatContext } from '~/Providers/ChatContext';
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
      com_ui_approval_review_in_composer: 'Review in composer',
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
          surface="composer"
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

  describe('while the composer review panel presents the pending action', () => {
    const conversationId = 'convo-1';
    const pendingAction: Agents.PendingAction = {
      actionId: 'action-1',
      streamId: 'stream-1',
      conversationId,
      createdAt: 1000,
      payload: {
        type: 'tool_approval',
        action_requests: [{ name: 'probe', tool_call_id: 'call-1', arguments: { a: 1 } }],
        review_configs: [
          {
            action_name: 'probe',
            tool_call_id: 'call-1',
            allowed_decisions: ['approve', 'reject'],
          },
        ],
      },
    };

    const renderWithComposer = (open: boolean, extra?: React.ReactNode) => {
      const store = createStore();
      store.set(pendingApprovalActionFamily(conversationId), pendingAction);
      store.set(approvalPanelOpenFamily(conversationId), open);
      render(
        <RecoilRoot>
          <Provider store={store}>
            <ChatContext.Provider value={{ conversation: { conversationId } } as never}>
              <ApprovalProvider pendingAction={pendingAction}>
                <div data-testid="thread">
                  <ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
                </div>
                <div data-testid="composer">
                  <ToolApproval
                    approval={approval()}
                    toolCallId="call-1"
                    args={{ a: 1 }}
                    surface="composer"
                  />
                </div>
                {extra}
              </ApprovalProvider>
            </ChatContext.Provider>
          </Provider>
        </RecoilRoot>,
      );
      return store;
    };

    test('the thread card is a record with no decisions or Submit while the panel is open', () => {
      renderWithComposer(true);
      const thread = screen.getByTestId('thread');

      expect(thread).toHaveTextContent('Review in composer');
      expect(thread.querySelectorAll('button')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    test('collapsing the panel hands the decisions and Submit back to the thread card', () => {
      const store = renderWithComposer(true);

      act(() => store.set(approvalPanelOpenFamily(conversationId), false));

      const thread = screen.getByTestId('thread');
      expect(thread).not.toHaveTextContent('Review in composer');
      fireEvent.click(within(thread).getByRole('button', { name: 'Approve' }));
      expect(within(thread).getByRole('button', { name: 'Submit' })).toBeEnabled();
      expect(
        within(screen.getByTestId('composer')).queryByRole('button', { name: 'Submit' }),
      ).not.toBeInTheDocument();
    });

    test('a thread card for a different action keeps its controls', () => {
      renderWithComposer(
        true,
        <div data-testid="other-action">
          <ToolApproval
            approval={{ actionId: 'action-2', allowed_decisions: ['approve'] }}
            toolCallId="call-9"
            args={{}}
          />
        </div>,
      );

      const other = screen.getByTestId('other-action');
      expect(other).not.toHaveTextContent('Review in composer');
      expect(within(other).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByTestId('thread')).toHaveTextContent('Review in composer');
    });
  });
});
