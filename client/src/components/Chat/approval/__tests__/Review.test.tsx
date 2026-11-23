import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  activeGenerationCreatedAtByConvoId,
  pendingApprovalActionFamily,
} from '@librechat/chat/react';
import type { Agents } from 'librechat-data-provider';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import ApprovalProvider from '~/components/Chat/Messages/Content/ApprovalContext';
import { ChatContext } from '~/Providers/ChatContext';
import { PendingToolApprovalPanel } from '../Review';

const mockApprovalMutate = jest.fn();

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

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string | number>) => {
    const labels: Record<string, string> = {
      com_ui_review_action: 'Review 1 action',
      com_ui_review_actions: `Review ${values?.[0]} actions`,
      com_ui_review_create_file: `Create ${values?.[0]}`,
      com_ui_review_run_command: 'Run command',
      com_ui_proposed_contents: 'Proposed contents',
      com_ui_proposed_command: 'Proposed command',
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
  useSubmitToolApprovalMutation: () => ({ mutate: mockApprovalMutate }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/store/agents', () => ({
  useGetEphemeralAgent: () => () => undefined,
}));

const getEphemeralAgent = jest.fn(() => ({ mcp: ['server'] }));

const chatContextValue = {
  conversation: {
    conversationId: 'conversation-1',
    endpoint: 'agents',
    agent_id: 'agent-1',
    model: 'model-1',
  },
  getMessages: () => [],
  setMessages: jest.fn(),
} as unknown as React.ContextType<typeof ChatContext>;

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

describe('app composer review panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Continue sends the whole batch with the conversation fields through the app host', async () => {
    const jotaiStore = createStore();
    jotaiStore.set(pendingApprovalActionFamily('conversation-1'), pendingAction);
    jotaiStore.set(activeGenerationCreatedAtByConvoId('conversation-1'), 1000);
    render(
      <RecoilRoot>
        <JotaiProvider store={jotaiStore}>
          <ChatSettingsContext.Provider value={{ ...defaultChatSettings, getEphemeralAgent }}>
            <ChatContext.Provider value={chatContextValue}>
              <ApprovalProvider pendingAction={pendingAction}>
                <PendingToolApprovalPanel conversationId="conversation-1" />
              </ApprovalProvider>
            </ChatContext.Provider>
          </ChatSettingsContext.Provider>
        </JotaiProvider>
      </RecoilRoot>,
    );

    await screen.findByRole('region', { name: 'Review 2 actions' });
    const approvals = screen.getAllByRole('button', { name: 'Approve' });
    fireEvent.click(approvals[0]);
    fireEvent.click(approvals[1]);
    const submit = screen.getByRole('button', { name: 'Continue' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    expect(mockApprovalMutate).toHaveBeenCalledTimes(1);
    expect(mockApprovalMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
        endpoint: 'agents',
        agent_id: 'agent-1',
        model: 'model-1',
        ephemeralAgent: { mcp: ['server'] },
        actionId: 'action-1',
        decisions: [
          expect.objectContaining({ tool_call_id: 'call-1', decision: 'approve' }),
          expect.objectContaining({ tool_call_id: 'call-2', decision: 'approve' }),
        ],
      }),
      expect.any(Object),
    );
  });
});
