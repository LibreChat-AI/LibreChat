/**
 * @jest-environment jsdom
 */
import React, { useEffect } from 'react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import type { ApprovalRequestRenderProps, ApprovalReviewCopy } from '../Review';
import type { ApprovalResumeHost } from '../../../react/approval';
import { ApprovalResumeHostProvider, pendingApprovalActionFamily } from '../../../react/approval';
import { PendingToolApprovalButton, PendingToolApprovalPanel } from '../Review';
import { composerOverlayCountFamily } from '../../../react/overlay';
import ApprovalProvider, { useApprovalContext } from '../context';

const localize: ApprovalReviewCopy = (key, values) => {
  const labels: Record<string, string> = {
    com_ui_review_action: 'Review 1 action',
    com_ui_review_actions: `Review ${values?.[0]} actions`,
    com_ui_review_run_command: 'Run command',
    com_ui_review_create_file: `Create ${values?.[0]}`,
    com_ui_review_create_file_generic: 'Create file',
    com_ui_review_edit_file: `Edit ${values?.[0]}`,
    com_ui_review_edit_file_generic: 'Edit file',
    com_ui_proposed_command: 'Proposed command',
    com_ui_proposed_contents: 'Proposed contents',
    com_ui_proposed_replacements: 'Proposed replacements',
    com_ui_proposed_arguments: 'Proposed arguments',
    com_ui_decisions_selected: `${values?.[0]} of ${values?.[1]} decisions selected`,
    com_ui_approve: 'Approve',
    com_ui_reject: 'Reject',
    com_ui_continue: 'Continue',
    com_ui_submitting: 'Submitting',
    com_ui_collapse: 'Collapse',
  };
  return labels[key] ?? key;
};

function FakeRequest({ approval, toolCallId }: ApprovalRequestRenderProps) {
  const { registerToolCall, unregisterToolCall, setDecision } = useApprovalContext();
  useEffect(() => {
    registerToolCall(approval.actionId, toolCallId);
    return () => unregisterToolCall(approval.actionId, toolCallId);
  }, [approval.actionId, toolCallId, registerToolCall, unregisterToolCall]);
  return (
    <button
      type="button"
      onClick={() =>
        setDecision(approval.actionId, toolCallId, {
          tool_call_id: toolCallId,
          decision: 'approve',
        })
      }
    >
      Approve
    </button>
  );
}

function renderRequest(props: ApprovalRequestRenderProps) {
  return <FakeRequest {...props} />;
}

jest.mock('@librechat/client', () => ({
  Button: jest
    .requireActual('react')
    .forwardRef(
      (
        { children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>,
        ref: React.Ref<HTMLButtonElement>,
      ) => (
        <button ref={ref} {...props}>
          {children}
        </button>
      ),
    ),
  TextareaAutosize: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
}));

const pendingAction: Agents.PendingAction = {
  actionId: 'action-1',
  streamId: 'stream-1',
  conversationId: 'conversation-1',
  createdAt: 1000,
  payload: {
    type: 'tool_approval',
    action_requests: [
      {
        name: 'create_file',
        source: 'librechat_code',
        tool_call_id: 'call-1',
        arguments: { path: 'src/new.ts', content: 'export const value = 1;' },
      },
      {
        name: 'bash_tool',
        source: 'librechat_code',
        tool_call_id: 'call-2',
        arguments: { command: 'npm test -- new' },
      },
    ],
    review_configs: [
      {
        action_name: 'create_file',
        tool_call_id: 'call-1',
        allowed_decisions: ['approve', 'reject'],
      },
      {
        action_name: 'bash_tool',
        tool_call_id: 'call-2',
        allowed_decisions: ['approve', 'reject'],
      },
    ],
  },
};

describe('PendingToolApproval', () => {
  test('reviews the authoritative batch beside the composer and can be collapsed', async () => {
    const jotaiStore = createStore();
    jotaiStore.set(pendingApprovalActionFamily('conversation-1'), pendingAction);
    render(
      <JotaiProvider store={jotaiStore}>
        <ApprovalProvider pendingAction={pendingAction}>
          <PendingToolApprovalPanel
            conversationId="conversation-1"
            localize={localize}
            renderRequest={renderRequest}
          />
          <PendingToolApprovalButton conversationId="conversation-1" localize={localize} />
        </ApprovalProvider>
      </JotaiProvider>,
    );

    expect(await screen.findByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
    expect(jotaiStore.get(composerOverlayCountFamily('conversation-1'))).toBe(1);
    expect(screen.getByText(/Create src\/new\.ts/)).toBeInTheDocument();
    expect(screen.getByText('npm test -- new')).toBeInTheDocument();
    expect(screen.getByText('0 of 2 decisions selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();

    const approvals = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(approvals[0]);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled();
    fireEvent.click(approvals[1]);
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    expect(screen.getByText('2 of 2 decisions selected')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
    expect(jotaiStore.get(composerOverlayCountFamily('conversation-1'))).toBe(0);
    expect(screen.getByTestId('pending-tool-approval-button')).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  describe('resuming through the host', () => {
    const createHost = (fields: ReturnType<ApprovalResumeHost['readFields']>) => {
      const submitToolApproval = jest.fn();
      const host: ApprovalResumeHost = {
        readFields: () => fields,
        submitToolApproval,
        submitAskAnswer: jest.fn(),
        readMessages: () => null,
      };
      return { host, submitToolApproval };
    };

    const renderWithHost = (host: ApprovalResumeHost) => {
      const jotaiStore = createStore();
      jotaiStore.set(pendingApprovalActionFamily('conversation-1'), pendingAction);
      render(
        <JotaiProvider store={jotaiStore}>
          <ApprovalResumeHostProvider host={host}>
            <ApprovalProvider pendingAction={pendingAction}>
              <PendingToolApprovalPanel
                conversationId="conversation-1"
                localize={localize}
                renderRequest={renderRequest}
              />
            </ApprovalProvider>
          </ApprovalResumeHostProvider>
        </JotaiProvider>,
      );
      return jotaiStore;
    };

    const approveBoth = async () => {
      await screen.findByRole('region', { name: 'Review 2 actions' });
      for (const approve of screen.getAllByRole('button', { name: 'Approve' })) {
        fireEvent.click(approve);
      }
    };

    test('Continue sends the whole batch and closes the review once the host accepts it', async () => {
      const { host, submitToolApproval } = createHost({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
      });
      const jotaiStore = renderWithHost(host);
      await approveBoth();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(submitToolApproval).toHaveBeenCalledTimes(1);
      expect(submitToolApproval).toHaveBeenCalledWith(
        {
          conversationId: 'conversation-1',
          generationCreatedAt: 1000,
          actionId: 'action-1',
          decisions: [
            { tool_call_id: 'call-1', decision: 'approve' },
            { tool_call_id: 'call-2', decision: 'approve' },
          ],
        },
        expect.any(Object),
      );
      expect(screen.getByRole('button', { name: 'Submitting' })).toBeDisabled();

      act(() => submitToolApproval.mock.calls[0][1].onSuccess());
      expect(jotaiStore.get(pendingApprovalActionFamily('conversation-1'))).toBeNull();
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
    });

    test('a failed submit keeps the batch and lets Continue retry', async () => {
      const { host, submitToolApproval } = createHost({ conversationId: 'conversation-1' });
      renderWithHost(host);
      await approveBoth();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      act(() => submitToolApproval.mock.calls[0][1].onError(new Error('offline')));
      expect(screen.getByText('2 of 2 decisions selected')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(submitToolApproval).toHaveBeenCalledTimes(2);
    });

    test('Continue does nothing while the host has no live conversation', async () => {
      const { host, submitToolApproval } = createHost(null);
      renderWithHost(host);
      await approveBoth();

      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      expect(submitToolApproval).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();
    });
  });

  describe('collapsing from the keyboard', () => {
    function Harness() {
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <PendingToolApprovalPanel
            conversationId="conversation-1"
            triggerRef={triggerRef}
            localize={localize}
            renderRequest={renderRequest}
          />
          <PendingToolApprovalButton
            conversationId="conversation-1"
            triggerRef={triggerRef}
            localize={localize}
          />
        </>
      );
    }

    const renderPanel = () => {
      const jotaiStore = createStore();
      jotaiStore.set(pendingApprovalActionFamily('conversation-1'), pendingAction);
      render(
        <JotaiProvider store={jotaiStore}>
          <ApprovalProvider pendingAction={pendingAction}>
            <Harness />
          </ApprovalProvider>
        </JotaiProvider>,
      );
      return jotaiStore;
    };

    test('Escape collapses the panel, keeps decisions and returns focus to the toggle', async () => {
      renderPanel();
      await screen.findByRole('region', { name: 'Review 2 actions' });
      const approve = screen.getAllByRole('button', { name: 'Approve' })[0];
      fireEvent.click(approve);
      approve.focus();

      fireEvent.keyDown(approve, { key: 'Escape', isComposing: true });
      fireEvent.keyDown(approve, { key: 'Escape', keyCode: 229 });
      fireEvent.keyDown(approve, { key: 'Escape', shiftKey: true });
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      fireEvent.keyDown(approve, { key: 'Escape' });
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
      const toggle = screen.getByTestId('pending-tool-approval-button');
      expect(toggle).toHaveFocus();
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(toggle);
      expect(screen.getByText('1 of 2 decisions selected')).toBeInTheDocument();
    });

    test('the Collapse button also returns focus to the toggle', async () => {
      renderPanel();
      await screen.findByRole('region', { name: 'Review 2 actions' });
      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
      expect(screen.getByTestId('pending-tool-approval-button')).toHaveFocus();
    });
  });
});
