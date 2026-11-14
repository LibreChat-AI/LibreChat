import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { composerOverlayCountFamily, pendingApprovalActionFamily } from '@librechat/chat/react';
import type { Agents } from 'librechat-data-provider';
import { PendingToolApprovalButton, PendingToolApprovalPanel } from '../Review';
import ApprovalProvider from '../../Messages/Content/ApprovalContext';

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

type PanelConfig = { toolApproval?: { panel?: 'expanded' | 'collapsed' } };

/** Agents endpoint config the mocked `useGetAgentsConfig` exposes, as React Query would. */
let mockAgentsConfig: PanelConfig | null = null;
/** Subscribers the mocked hook registers, so a config update re-renders its consumers. */
const mockAgentsConfigListeners = new Set<() => void>();

/** Updates the mocked config and notifies mounted consumers, like a resolved config query. */
function setMockAgentsConfig(config: PanelConfig | null) {
  mockAgentsConfig = config;
  act(() => {
    mockAgentsConfigListeners.forEach((listener) => listener());
  });
}

jest.mock('~/hooks', () => {
  const React = jest.requireActual('react') as typeof import('react');
  return {
    useGetAgentsConfig: () => {
      React.useSyncExternalStore(
        (listener: () => void) => {
          mockAgentsConfigListeners.add(listener);
          return () => {
            mockAgentsConfigListeners.delete(listener);
          };
        },
        () => mockAgentsConfig,
      );
      return { agentsConfig: mockAgentsConfig };
    },
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
  };
});

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: jest.fn() }),
  useSubmitAskAnswerMutation: () => ({ mutate: jest.fn() }),
}));

jest.mock('~/store/agents', () => ({
  useGetEphemeralAgent: () => () => undefined,
}));

beforeEach(() => {
  mockAgentsConfig = null;
  mockAgentsConfigListeners.clear();
});

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

  describe('collapsing from the keyboard', () => {
    function Harness() {
      const triggerRef = React.useRef<HTMLButtonElement>(null);
      return (
        <>
          <PendingToolApprovalPanel conversationId="conversation-1" triggerRef={triggerRef} />
          <PendingToolApprovalButton conversationId="conversation-1" triggerRef={triggerRef} />
        </>
      );
    }

    const renderPanel = () => {
      const jotaiStore = createStore();
      jotaiStore.set(pendingApprovalActionFamily('conversation-1'), pendingAction);
      render(
        <RecoilRoot>
          <JotaiProvider store={jotaiStore}>
            <ApprovalProvider pendingAction={pendingAction}>
              <Harness />
            </ApprovalProvider>
          </JotaiProvider>
        </RecoilRoot>,
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

  describe('review panel expansion config', () => {
    /** Renders the panel and toggle with a pending action already restored, as a reload does. */
    function renderApproval(action: Agents.PendingAction = pendingAction) {
      const jotaiStore = createStore();
      jotaiStore.set(pendingApprovalActionFamily('conversation-1'), action);
      const tree = (nextAction: Agents.PendingAction) => (
        <RecoilRoot>
          <JotaiProvider store={jotaiStore}>
            <ApprovalProvider pendingAction={nextAction}>
              <PendingToolApprovalPanel conversationId="conversation-1" />
              <PendingToolApprovalButton conversationId="conversation-1" />
            </ApprovalProvider>
          </JotaiProvider>
        </RecoilRoot>
      );
      const result = render(tree(action));
      return {
        /** Another action for the same conversation, as a resume would produce. */
        nextAction: (nextAction: Agents.PendingAction) => {
          act(() => {
            jotaiStore.set(pendingApprovalActionFamily('conversation-1'), nextAction);
          });
          result.rerender(tree(nextAction));
        },
      };
    }

    const expandedConfigs: Array<[string, PanelConfig | null]> = [
      ['no configured value', null],
      ['expanded', { toolApproval: { panel: 'expanded' } }],
    ];

    it.each(expandedConfigs)('opens a restored pending approval for %s', (_label, config) => {
      mockAgentsConfig = config;
      renderApproval();

      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
      expect(screen.getByTestId('pending-tool-approval-button')).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    test('collapsed leaves a restored pending approval closed until the user opens it', () => {
      mockAgentsConfig = { toolApproval: { panel: 'collapsed' } };
      renderApproval();

      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
      const toggle = screen.getByTestId('pending-tool-approval-button');
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(toggle);
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
      expect(screen.getByText('npm test -- new')).toBeInTheDocument();

      /** Approval decisions and the batch submit still work from a manually opened panel. */
      const approve = screen.getAllByRole('button', { name: 'Approve' })[0];
      fireEvent.click(approve);
      fireEvent.click(screen.getAllByRole('button', { name: 'Reject' })[1]);
      expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled();

      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
    });

    test('a config that resolves collapsed after the pause retracts the automatic open', () => {
      mockAgentsConfig = null;
      renderApproval();
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      setMockAgentsConfig({ toolApproval: { panel: 'collapsed' } });

      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
      expect(screen.getByTestId('pending-tool-approval-button')).toHaveAttribute(
        'aria-expanded',
        'false',
      );
    });

    test('a config that resolves expanded after the pause opens the panel', () => {
      mockAgentsConfig = { toolApproval: { panel: 'collapsed' } };
      renderApproval();
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();

      setMockAgentsConfig({ toolApproval: { panel: 'expanded' } });

      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();
    });

    test('collapsed keeps the open state the user set through a config update and next action', () => {
      mockAgentsConfig = { toolApproval: { panel: 'collapsed' } };
      const { nextAction } = renderApproval();
      fireEvent.click(screen.getByTestId('pending-tool-approval-button'));
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      setMockAgentsConfig({ toolApproval: { panel: 'collapsed' } });
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      nextAction({ ...pendingAction, actionId: 'action-2' });
      expect(screen.getByRole('region', { name: 'Review 2 actions' })).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Collapse' }));
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();

      nextAction({ ...pendingAction, actionId: 'action-3' });
      expect(screen.queryByRole('region', { name: 'Review 2 actions' })).not.toBeInTheDocument();
    });
  });
});
