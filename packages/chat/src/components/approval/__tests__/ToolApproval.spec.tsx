/**
 * @jest-environment jsdom
 */
import React from 'react';
import { Provider, createStore, useAtomValue } from 'jotai';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { SCHEDULE_APPROVAL_REASON, SUBSCRIPTION_APPROVAL_REASON } from 'librechat-data-provider';
import type { Agents } from 'librechat-data-provider';
import type { ApprovalResumeHost } from '../../../react/approval';
import type { ShortcutBinding } from '../../../core/shortcuts';
import {
  approvalPanelOpenFamily,
  pendingApprovalActionFamily,
  ApprovalResumeHostProvider,
} from '../../../react/approval';
import ApprovalProvider, { ResumeSubmitContext, useApprovalContext } from '../context';
import { activeGenerationCreatedAtByConvoId } from '../../../react/steer/atoms';
import { createMessagePartsHost } from '../../../__fixtures__/partsHost';
import { ChatSurfaceProvider } from '../../../react/subagents/provider';
import { MessagePartsHostProvider } from '../../../react/host';
import { ChatContext } from '../../../react/chat/context';
import { initEnglish } from '../../../__fixtures__/i18n';
import { HostedToolApproval } from '../hosted';
import ToolApproval from '../ToolApproval';

const mockMutate = jest.fn();
const mockInsertTextAtCursor = jest.fn();

/** jsdom has no execCommand, so the newline path is observed through the mock. */
jest.mock('../../../core/textarea', () => ({
  ...jest.requireActual('../../../core/textarea'),
  forceResize: jest.fn(),
  insertTextAtCursor: (...args: unknown[]) => mockInsertTextAtCursor(...args),
}));

beforeAll(initEnglish);

/**
 * The ordinary chat resume, the way a host builds it: the conversation the card renders in, the
 * paused generation it observed, and the request that sends the decisions.
 */
function useChatResumeHost(): ApprovalResumeHost {
  const conversationId = React.useContext(ChatContext)?.conversation?.conversationId;
  const generationCreatedAt = useAtomValue(
    activeGenerationCreatedAtByConvoId(conversationId ?? 'new'),
  );
  return React.useMemo(
    () => ({
      readFields: () =>
        conversationId == null
          ? null
          : {
              conversationId,
              ...(generationCreatedAt != null && { generationCreatedAt }),
            },
      submitToolApproval: (body, callbacks) => mockMutate(body, callbacks),
      submitAskAnswer: () => undefined,
      readMessages: () => null,
    }),
    [conversationId, generationCreatedAt],
  );
}

function ResumeHost({ children }: { children: React.ReactNode }) {
  return (
    <ApprovalResumeHostProvider host={useChatResumeHost()}>{children}</ApprovalResumeHostProvider>
  );
}

/** A promise and the functions that settle it. */
function deferred() {
  let resolve: () => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const approval = (
  allowed: Agents.ToolApprovalDecisionType[] = ['approve', 'reject'],
): NonNullable<Agents.ToolCall['approval']> => ({
  actionId: 'action-1',
  allowed_decisions: allowed,
});

const renderCards = (cards: React.ReactNode) =>
  render(
    <ApprovalProvider>
      <ResumeHost>{cards}</ResumeHost>
    </ApprovalProvider>,
  );

function DecisionProbe() {
  const { getDecisions } = useApprovalContext();
  return <output data-testid="decisions">{JSON.stringify(getDecisions('action-1'))}</output>;
}

const decisions = () => JSON.parse(screen.getByTestId('decisions').textContent ?? '[]');

describe('ToolApproval', () => {
  test("says a coded explanation in the reader's language and shows any other as sent", () => {
    renderCards(
      <ToolApproval
        approval={{ ...approval(), description: SCHEDULE_APPROVAL_REASON }}
        toolCallId="call-1"
        args={{}}
      />,
    );
    expect(
      screen.getByText('You asked to approve each use of this tool when this schedule runs.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(SCHEDULE_APPROVAL_REASON)).not.toBeInTheDocument();
    cleanup();
    renderCards(
      <ToolApproval
        approval={{ ...approval(), description: SUBSCRIPTION_APPROVAL_REASON }}
        toolCallId="call-1"
        args={{}}
      />,
    );
    expect(
      screen.getByText(
        'You asked to approve each use of this tool when this event subscription runs.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(SUBSCRIPTION_APPROVAL_REASON)).not.toBeInTheDocument();
    cleanup();
    renderCards(
      <ToolApproval
        approval={{ ...approval(), description: 'Deletes a file' }}
        toolCallId="call-1"
        args={{}}
      />,
    );
    expect(screen.getByText('Deletes a file')).toBeInTheDocument();
  });

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
    expect(always).toHaveAccessibleDescription(
      'This tool will run without asking for the rest of this conversation.',
    );

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

  test('every decision field is the shared form field, with its control boundary and tokens', () => {
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
      /* A bare `textarea` inherits its colour, so the field variant names the text, placeholder
         and boundary tokens: the boundary is the form-control role, drawn for 3:1. */
      expect(field).toHaveClass('lc-field');
      expect(field).toHaveClass('text-field-text');
      expect(field).toHaveClass('border-border-control');
      expect(field).toHaveClass('placeholder:text-text-secondary');
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

  test('hosted cards submit the selected batch and keep decisions locked through acknowledgement', async () => {
    const first = deferred();
    const retry = deferred();
    const send = jest
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => retry.promise);
    render(
      <Provider>
        <ApprovalProvider>
          <ResumeSubmitContext.Provider
            value={{ submitToolApproval: send, submitAskAnswer: async () => {} }}
          >
            <ToolApproval approval={approval(['edit'])} toolCallId="call-1" args={{ old: true }} />
            <ToolApproval approval={approval(['reject'])} toolCallId="call-2" args={{}} />
          </ResumeSubmitContext.Provider>
        </ApprovalProvider>
      </Provider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const editor = screen.getByRole('textbox', { name: 'Edit' });
    fireEvent.change(editor, { target: { value: '{"path":"new.ts"}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const reason = screen.getByRole('textbox', { name: 'Reject' });
    fireEvent.change(reason, { target: { value: 'Keep the existing file.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit 2 decisions' }));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('action-1', [
      { tool_call_id: 'call-1', decision: 'edit', editedArguments: { path: 'new.ts' } },
      { tool_call_id: 'call-2', decision: 'reject', reason: 'Keep the existing file.' },
    ]);
    expect(editor).toBeDisabled();
    expect(reason).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Reject' })).toBeDisabled();
    await act(async () => {
      first.reject(new Error('temporary'));
    });
    expect(editor).toBeEnabled();
    expect(reason).toHaveValue('Keep the existing file.');
    fireEvent.click(screen.getByRole('button', { name: 'Submit 2 decisions' }));
    expect(send).toHaveBeenCalledTimes(2);
    await act(async () => {
      retry.resolve();
    });
    expect(editor).toBeDisabled();
    expect(reason).toBeDisabled();
    expect(mockMutate).not.toHaveBeenCalled();
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
      <ApprovalProvider>
        <ResumeHost>
          <ToolApproval key={key} approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
        </ResumeHost>
      </ApprovalProvider>
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
        <Provider store={store}>
          <ChatContext.Provider value={{ conversation: { conversationId } } as never}>
            <ApprovalProvider pendingAction={pendingAction}>
              <ResumeHost>
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
              </ResumeHost>
            </ApprovalProvider>
          </ChatContext.Provider>
        </Provider>,
      );
      return store;
    };

    test('the thread card is a record with no decisions or Submit while the panel is open', () => {
      renderWithComposer(true);
      const thread = screen.getByTestId('thread');

      expect(thread).toHaveTextContent('Review this request in the panel above the message box.');
      expect(thread.querySelectorAll('button')).toHaveLength(0);
      expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: 'Approve' })).toHaveLength(1);
    });

    test('collapsing the panel hands the decisions and Submit back to the thread card', () => {
      const store = renderWithComposer(true);

      act(() => store.set(approvalPanelOpenFamily(conversationId), false));

      const thread = screen.getByTestId('thread');
      expect(thread).not.toHaveTextContent(
        'Review this request in the panel above the message box.',
      );
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
      expect(other).not.toHaveTextContent(
        'Review this request in the panel above the message box.',
      );
      expect(within(other).getByRole('button', { name: 'Approve' })).toBeInTheDocument();
      expect(screen.getByTestId('thread')).toHaveTextContent(
        'Review this request in the panel above the message box.',
      );
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
                <ResumeHost>
                  <ToolApproval approval={approval(allowed)} toolCallId="call-1" args={{ a: 1 }} />
                </ResumeHost>
              </ApprovalProvider>
            </ChatSurfaceProvider>
          </ChatContext.Provider>
        </Provider>,
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

  describe('in a view with no way to resume the run', () => {
    beforeEach(() => mockMutate.mockClear());

    test('draws the controls disabled and says the request cannot be answered here', () => {
      render(
        <ApprovalProvider>
          <ToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
        </ApprovalProvider>,
      );

      const note = "This request can't be answered from here.";
      expect(screen.getByText(note)).toBeInTheDocument();
      for (const name of ['Approve', 'Reject']) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveAccessibleDescription(note);
      }
      expect(screen.queryByRole('button', { name: 'Submit' })).not.toBeInTheDocument();
    });

    test('a resume host passed to the card is enough to answer it', () => {
      function Card() {
        return (
          <ToolApproval
            approval={approval()}
            toolCallId="call-1"
            args={{ a: 1 }}
            resumeHost={useChatResumeHost()}
          />
        );
      }
      render(
        <ChatContext.Provider value={{ conversation: { conversationId: 'c-1' } } as never}>
          <ApprovalProvider>
            <Card />
          </ApprovalProvider>
        </ChatContext.Provider>,
      );

      expect(screen.queryByText("This request can't be answered from here.")).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(mockMutate).toHaveBeenCalledWith(
        {
          conversationId: 'c-1',
          actionId: 'action-1',
          decisions: [{ tool_call_id: 'call-1', decision: 'approve' }],
        },
        expect.anything(),
      );
    });
  });

  describe('inside a message', () => {
    beforeEach(() => mockMutate.mockClear());

    const drawHosted = (host: ReturnType<typeof createMessagePartsHost>) =>
      render(
        <ChatContext.Provider value={{ conversation: { conversationId: 'c-1' } } as never}>
          <MessagePartsHostProvider host={host}>
            <ApprovalProvider>
              <HostedToolApproval approval={approval()} toolCallId="call-1" args={{ a: 1 }} />
            </ApprovalProvider>
          </MessagePartsHostProvider>
        </ChatContext.Provider>,
      );

    test('resumes through the host’s resume hook', () => {
      drawHosted(createMessagePartsHost({ useApprovalResumeHost: useChatResumeHost }));

      fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
      expect(mockMutate).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'c-1',
          decisions: [{ tool_call_id: 'call-1', decision: 'reject' }],
        }),
        expect.anything(),
      );
    });

    test('without a resume hook, is disabled and says why', () => {
      drawHosted(createMessagePartsHost());

      expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
      expect(screen.getByText("This request can't be answered from here.")).toBeInTheDocument();
    });
  });
});
