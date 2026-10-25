import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { activeGenerationCreatedAtByConvoId } from '@librechat/chat/react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { Agents } from 'librechat-data-provider';
import type { ShortcutBinding } from '~/utils/shortcuts';
import {
  approvalPanelOpenFamily,
  pendingApprovalActionFamily,
} from '~/components/Chat/approval/state';
import { ChatSurfaceProvider } from '~/components/Chat/Subagents/surface';
import ApprovalProvider, { useApprovalContext } from '../ApprovalContext';
import { ChatContext } from '~/Providers/ChatContext';
import ToolApproval from '../ToolApproval';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values?: Record<string | number, string | number>) => {
    if (key === 'com_ui_submit_decisions') {
      return `Submit ${values?.[0]} decisions`;
    }
    const map: Record<string, string> = {
      com_ui_approve: 'Approve',
      com_ui_approve_always: 'Always allow',
      com_ui_approve_always_hint: 'Runs without asking for this conversation',
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

const mockMutate = jest.fn();
const mockInsertTextAtCursor = jest.fn();

/** jsdom has no execCommand, so the newline path is observed through the mock. */
jest.mock('~/utils/textarea', () => ({
  ...jest.requireActual('~/utils/textarea'),
  forceResize: jest.fn(),
  insertTextAtCursor: (...args: unknown[]) => mockInsertTextAtCursor(...args),
}));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: mockMutate }),
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

function DecisionProbe() {
  const { getDecisions } = useApprovalContext();
  return <output data-testid="decisions">{JSON.stringify(getDecisions('action-1'))}</output>;
}

const decisions = () => JSON.parse(screen.getByTestId('decisions').textContent ?? '[]');

describe('ToolApproval', () => {
  test('hides Always allow unless the server offered it', () => {
    renderCards(<ToolApproval approval={approval()} toolCallId="call-1" args={{}} />);
    expect(screen.queryByRole('button', { name: 'Always allow' })).not.toBeInTheDocument();
  });

  test('Always allow submits a session-scoped approve and is mutually exclusive with Approve', () => {
    renderCards(
      <>
        <ToolApproval
          approval={{ ...approval(), allow_always: true }}
          toolCallId="call-1"
          args={{}}
        />
        <DecisionProbe />
      </>,
    );
    const always = screen.getByRole('button', { name: 'Always allow' });
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect(always).toHaveAccessibleDescription('Runs without asking for this conversation');

    fireEvent.click(always);
    expect(always).toHaveAttribute('aria-pressed', 'true');
    expect(approve).toHaveAttribute('aria-pressed', 'false');
    expect(decisions()).toEqual([
      { tool_call_id: 'call-1', decision: 'approve', scope: 'session' },
    ]);
    expect(screen.getByRole('button', { name: 'Submit' })).toBeEnabled();

    fireEvent.click(approve);
    expect(always).toHaveAttribute('aria-pressed', 'false');
    expect(approve).toHaveAttribute('aria-pressed', 'true');
    expect(decisions()).toEqual([{ tool_call_id: 'call-1', decision: 'approve' }]);

    fireEvent.click(always);
    fireEvent.click(always);
    expect(decisions()).toEqual([]);
  });

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

  test('invalid edit JSON marks the field invalid and names the error', () => {
    renderCards(<ToolApproval approval={approval(['edit'])} toolCallId="call-1" args={{ a: 1 }} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const field = screen.getByRole('textbox', { name: 'Edit' });
    fireEvent.change(field, { target: { value: '{' } });

    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Invalid JSON');
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

  describe('submitting from a decision field', () => {
    const conversationId = 'conversation-1';

    beforeEach(() => {
      mockMutate.mockClear();
      mockInsertTextAtCursor.mockClear();
    });

    const renderLive = (
      allowed: Agents.ToolApprovalDecisionType[],
      {
        enterToSend = true,
        shortcutsEnabled = true,
        submitOverride,
      }: {
        enterToSend?: boolean;
        shortcutsEnabled?: boolean;
        submitOverride?: ShortcutBinding | null;
      } = {},
    ) => {
      const store = createStore();
      store.set(activeGenerationCreatedAtByConvoId(conversationId), 1000);
      render(
        <RecoilRoot>
          <Provider store={store}>
            <ChatContext.Provider value={{ conversation: { conversationId } } as never}>
              <ChatSurfaceProvider
                value={{
                  enterToSend,
                  maximizeChatSpace: false,
                  showScrollButton: false,
                  composerBindings: {
                    shortcutsEnabled,
                    submitOverride,
                    yieldedChords: new Set(),
                  },
                  claimForeground: jest.fn(),
                  handOffComposerText: jest.fn(),
                }}
              >
                <ApprovalProvider>
                  <ToolApproval approval={approval(allowed)} toolCallId="call-1" args={{ a: 1 }} />
                </ApprovalProvider>
              </ChatSurfaceProvider>
            </ChatContext.Provider>
          </Provider>
        </RecoilRoot>,
      );
    };

    const submittedDecisions = () =>
      mockMutate.mock.calls.map(([payload]) => (payload as { decisions: unknown }).decisions);

    test('Enter in the reject reason submits with Enter-to-send on; Shift, IME and held Enter do not', () => {
      renderLive(['approve', 'reject']);
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      const reason = screen.getByRole('textbox', { name: 'Reject' });
      fireEvent.change(reason, { target: { value: 'not now' } });

      fireEvent.keyDown(reason, { key: 'Enter', shiftKey: true });
      fireEvent.keyDown(reason, { key: 'Enter', isComposing: true });
      fireEvent.keyDown(reason, { key: 'Enter', keyCode: 229 });
      fireEvent.keyDown(reason, { key: 'Enter', repeat: true });
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.keyDown(reason, { key: 'Enter' });
      expect(submittedDecisions()).toEqual([
        [{ tool_call_id: 'call-1', decision: 'reject', reason: 'not now' }],
      ]);
    });

    test('with Enter-to-send off, Enter writes a newline and Ctrl/Cmd+Enter submits', () => {
      renderLive(['reject'], { enterToSend: false });
      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      const reason = screen.getByRole('textbox', { name: 'Reject' });

      fireEvent.keyDown(reason, { key: 'Enter' });
      expect(mockInsertTextAtCursor).toHaveBeenCalledWith(reason, '\n');
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.keyDown(reason, { key: 'Enter', metaKey: true });
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    test('Enter in an empty response does not submit', () => {
      renderLive(['approve', 'respond']);
      fireEvent.click(screen.getByRole('button', { name: 'Respond' }));
      const response = screen.getByRole('textbox', { name: 'Respond' });

      fireEvent.keyDown(response, { key: 'Enter' });
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.change(response, { target: { value: 'use the cache' } });
      fireEvent.keyDown(response, { key: 'Enter' });
      expect(submittedDecisions()).toEqual([
        [{ tool_call_id: 'call-1', decision: 'respond', responseText: 'use the cache' }],
      ]);
    });

    test('Enter in the JSON edit field never submits; Ctrl+Enter submits valid JSON only', () => {
      renderLive(['approve', 'edit']);
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      const editor = screen.getByRole('textbox', { name: 'Edit' });

      const enter = fireEvent.keyDown(editor, { key: 'Enter' });
      expect(enter).toBe(true);
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.change(editor, { target: { value: '{ "a": ' } });
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.change(editor, { target: { value: '{ "a": 2 }' } });
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true, repeat: true });
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
      expect(submittedDecisions()).toEqual([
        [{ tool_call_id: 'call-1', decision: 'edit', editedArguments: { a: 2 } }],
      ]);
    });

    test('a submit shortcut rebound off Enter submits from either field', () => {
      const ctrlJ: ShortcutBinding = {
        key: 'J',
        ctrl: true,
        meta: false,
        alt: false,
        shift: false,
      };
      renderLive(['reject', 'edit'], { submitOverride: ctrlJ });
      fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit' }), { key: 'j', ctrlKey: true });
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });

    test('Ctrl+Enter in the JSON edit field follows the composer submit chord', () => {
      const altEnter: ShortcutBinding = {
        key: 'Enter',
        ctrl: false,
        meta: false,
        alt: true,
        shift: false,
      };
      const cases: Array<{ shortcutsEnabled?: boolean; submitOverride: ShortcutBinding | null }> = [
        { shortcutsEnabled: false, submitOverride: null },
        { submitOverride: null },
        { submitOverride: altEnter },
      ];
      for (const options of cases) {
        cleanup();
        renderLive(['approve', 'edit'], options);
        fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const editor = screen.getByRole('textbox', { name: 'Edit' });
        fireEvent.change(editor, { target: { value: '{ "a": 2 }' } });
        expect(fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true })).toBe(true);
        expect(fireEvent.keyDown(editor, { key: 'Enter', metaKey: true })).toBe(true);
      }
      expect(mockMutate).not.toHaveBeenCalled();

      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Edit' }), {
        key: 'Enter',
        altKey: true,
      });
      expect(mockMutate).toHaveBeenCalledTimes(1);
    });
  });
});
