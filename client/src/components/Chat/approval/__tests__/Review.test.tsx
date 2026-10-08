import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import { PendingToolApprovalButton, PendingToolApprovalPanel } from '../Review';
import { composerOverlayCountFamily } from '~/components/Chat/Input/overlay';
import ApprovalProvider from '../../Messages/Content/ApprovalContext';
import { pendingApprovalActionFamily } from '../state';

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  TextareaAutosize: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  TooltipAnchor: ({ render }: { render: React.ReactNode }) => render,
}));

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string | number>) => {
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
      com_ui_collapse: 'Collapse',
    };
    return labels[key] ?? key;
  },
}));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/store/agents', () => ({
  useGetEphemeralAgent: () => () => undefined,
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
      <RecoilRoot>
        <JotaiProvider store={jotaiStore}>
          <ApprovalProvider pendingAction={pendingAction}>
            <PendingToolApprovalPanel conversationId="conversation-1" />
            <PendingToolApprovalButton conversationId="conversation-1" />
          </ApprovalProvider>
        </JotaiProvider>
      </RecoilRoot>,
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
});
