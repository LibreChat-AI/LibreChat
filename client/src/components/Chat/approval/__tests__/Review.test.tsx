import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { EModelEndpoint, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  activeGenerationCreatedAtByConvoId,
  pendingApprovalActionFamily,
} from '@librechat/chat/react';
import type { Agents, TConfig } from 'librechat-data-provider';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import ApprovalProvider from '~/components/Chat/Messages/Content/ApprovalContext';
import { PendingToolApprovalButton, PendingToolApprovalPanel } from '../Review';
import { ChatContext } from '~/Providers/ChatContext';
import store from '~/store';

const mockApprovalMutate = jest.fn();
type PanelConfig = Pick<TConfig, 'toolApproval'> | null;

jest.mock('@librechat/client', () => ({
  ...jest.requireActual('@librechat/client'),
  /** The approval card in each row is the chat package's, which localizes through this module. */
  useLocalize: () => jest.requireMock<{ useLocalize: () => unknown }>('~/hooks').useLocalize(),
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
  useGetAgentsConfig: jest.requireActual('~/hooks/Agents/useGetAgentsConfig').default,
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
  useGetEndpointsQuery: jest.requireActual('~/data-provider/Endpoints/queries')
    .useGetEndpointsQuery,
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

function renderApproval(initialConfig: PanelConfig = null) {
  const jotaiStore = createStore();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, cacheTime: 0 } },
  });
  let action = pendingAction;
  if (initialConfig != null) {
    queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: initialConfig });
  }
  jotaiStore.set(pendingApprovalActionFamily('conversation-1'), action);
  jotaiStore.set(activeGenerationCreatedAtByConvoId('conversation-1'), 1000);
  const tree = () => (
    <RecoilRoot initializeState={({ set }) => set(store.queriesEnabled, false)}>
      <JotaiProvider store={jotaiStore}>
        <QueryClientProvider client={queryClient}>
          <ChatSettingsContext.Provider value={{ ...defaultChatSettings, getEphemeralAgent }}>
            <ChatContext.Provider value={chatContextValue}>
              <ApprovalProvider pendingAction={action}>
                <PendingToolApprovalPanel conversationId="conversation-1" />
                <PendingToolApprovalButton conversationId="conversation-1" />
              </ApprovalProvider>
            </ChatContext.Provider>
          </ChatSettingsContext.Provider>
        </QueryClientProvider>
      </JotaiProvider>
    </RecoilRoot>
  );
  const result = render(tree());
  return {
    setConfig: async (nextConfig: NonNullable<PanelConfig>) => {
      await act(async () => {
        queryClient.setQueryData([QueryKeys.endpoints], { [EModelEndpoint.agents]: nextConfig });
      });
    },
    nextAction: () => {
      action = { ...pendingAction, actionId: `${action.actionId}-next` };
      act(() => jotaiStore.set(pendingApprovalActionFamily('conversation-1'), action));
      result.rerender(tree());
    },
  };
}

describe('app composer review panel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('Continue sends the whole batch with the conversation fields through the app host', async () => {
    renderApproval();

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

  const expandedConfigs: Array<[string, PanelConfig]> = [
    ['missing config', null],
    ['missing panel', { toolApproval: {} }],
    ['expanded', { toolApproval: { panel: 'expanded' } }],
  ];

  test.each(expandedConfigs)('%s opens a restored pending approval', (_label, config) => {
    renderApproval(config);
    expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
  });

  test('collapsed can be opened manually and still submits approve and reject decisions', () => {
    renderApproval({ toolApproval: { panel: 'collapsed' } });
    expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pending-tool-approval-button'));
    expect(screen.getByText('npm test -- new')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Approve' })[0]);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[1]);
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(mockApprovalMutate).toHaveBeenCalledTimes(1);
    expect(mockApprovalMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        actionId: 'action-1',
        decisions: [
          expect.objectContaining({ tool_call_id: 'call-1', decision: 'approve' }),
          expect.objectContaining({ tool_call_id: 'call-2', decision: 'reject' }),
        ],
      }),
      expect.any(Object),
    );
  });

  test('late collapsed config retracts automatic expansion and expanded config opens it again', async () => {
    const { setConfig } = renderApproval();
    expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

    await setConfig({ toolApproval: { panel: 'collapsed' } });
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument(),
    );

    await setConfig({ toolApproval: { panel: 'expanded' } });
    expect(await screen.findByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
  });

  test.each(['expanded', 'collapsed'] as const)(
    '%s preserves manual open and close through config changes and later actions',
    async (panel) => {
      const { setConfig, nextAction } = renderApproval({ toolApproval: { panel } });
      if (panel === 'expanded') {
        fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
      }
      fireEvent.click(screen.getByTestId('pending-tool-approval-button'));

      await setConfig({ toolApproval: { panel: 'collapsed' } });
      nextAction();
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
      await setConfig({ toolApproval: { panel: 'expanded' } });
      nextAction();
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
    },
  );

  test('late collapsed config preserves a panel reopened manually while config was loading', async () => {
    const { setConfig } = renderApproval();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
    fireEvent.click(screen.getByTestId('pending-tool-approval-button'));

    await setConfig({ toolApproval: { panel: 'collapsed' } });
    expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
  });
});
