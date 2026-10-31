import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { activeGenerationCreatedAtByConvoId } from '@librechat/chat/react';
import type { ResumeSubmitTransport } from '../ApprovalContext';
import ApprovalProvider, {
  ResumeSubmitContext,
  useApprovalContext,
  useAskSubmitStatus,
  useResumeSubmit,
} from '../ApprovalContext';
import { ChatContext } from '~/Providers/ChatContext';

const mockApprovalMutate = jest.fn();
const mockAskMutate = jest.fn();

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: mockApprovalMutate }),
  useSubmitAskAnswerMutation: () => ({ mutate: mockAskMutate }),
}));

jest.mock('~/store/agents', () => ({
  useGetEphemeralAgent: () => () => undefined,
}));

const chatContextValue = {
  conversation: {
    conversationId: 'conversation-1',
    endpoint: 'agents',
    agent_id: 'agent-1',
  },
} as unknown as React.ContextType<typeof ChatContext>;

const createWrapper = (generationCreatedAt: number | null) =>
  function ResumeWrapper({ children }: { children: React.ReactNode }) {
    const [jotaiStore] = React.useState(() => {
      const created = createStore();
      if (generationCreatedAt != null) {
        created.set(activeGenerationCreatedAtByConvoId('conversation-1'), generationCreatedAt);
      }
      return created;
    });
    return (
      <RecoilRoot>
        <JotaiProvider store={jotaiStore}>
          <ChatContext.Provider value={chatContextValue}>
            <ApprovalProvider>{children}</ApprovalProvider>
          </ChatContext.Provider>
        </JotaiProvider>
      </RecoilRoot>
    );
  };

const wrapper = createWrapper(1000);

const pendingAction: import('librechat-data-provider').Agents.PendingAction = {
  actionId: 'action-1',
  streamId: 'stream-1',
  payload: {
    type: 'tool_approval',
    action_requests: [
      { name: 'create_file', arguments: { path: 'one.ts' }, tool_call_id: 'call-1' },
      { name: 'bash_tool', arguments: { command: 'npm test' }, tool_call_id: 'call-2' },
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
  createdAt: 1000,
};

describe('useResumeSubmit', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('passes full selected batches and answers through a host while owning submission state outside chat', async () => {
    const pending = Promise.withResolvers<void>();
    const transport: ResumeSubmitTransport = {
      submitToolApproval: jest.fn(() => pending.promise),
      submitAskAnswer: jest.fn(async () => {}),
    };
    const onSuccess = jest.fn();
    const hostWrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider>
        <ResumeSubmitContext.Provider value={transport}>
          <ApprovalProvider>{children}</ApprovalProvider>
        </ResumeSubmitContext.Provider>
      </JotaiProvider>
    );
    const { result } = renderHook(
      () => ({
        approval: useApprovalContext(),
        first: useResumeSubmit(),
        second: useResumeSubmit(),
      }),
      { wrapper: hostWrapper },
    );
    const decisions: import('librechat-data-provider').Agents.ToolApprovalResolution[] = [
      { tool_call_id: 'approve', decision: 'approve', scope: 'session' },
      {
        tool_call_id: 'edit',
        decision: 'edit',
        editedArguments: { path: 'new.ts', nested: { enabled: true } },
      },
      { tool_call_id: 'respond', decision: 'respond', responseText: 'Use the existing file.' },
      { tool_call_id: 'reject', decision: 'reject', reason: 'Do not run this command.' },
    ];
    act(() => {
      for (const decision of decisions) {
        result.current.approval.registerToolCall('approval-action', decision.tool_call_id);
        result.current.approval.setDecision('approval-action', decision.tool_call_id, decision);
      }
      result.current.first.submitToolApproval('approval-action');
      result.current.second.submitToolApproval('approval-action');
    });
    expect(transport.submitToolApproval).toHaveBeenCalledTimes(1);
    expect(transport.submitToolApproval).toHaveBeenCalledWith('approval-action', decisions);
    expect(result.current.approval.getStatus('approval-action')).toBe('submitting');
    await act(async () => {
      pending.resolve();
    });
    expect(result.current.approval.getStatus('approval-action')).toBe('submitted');
    await act(async () => {
      result.current.first.submitAskAnswer('single-action', 'answer', { onSuccess });
      result.current.first.submitAskAnswer('batch-action', { first: 'yes', second: 'no' });
    });
    expect(transport.submitAskAnswer).toHaveBeenNthCalledWith(1, 'single-action', 'answer');
    expect(transport.submitAskAnswer).toHaveBeenNthCalledWith(2, 'batch-action', {
      first: 'yes',
      second: 'no',
    });
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(mockApprovalMutate).not.toHaveBeenCalled();
    expect(mockAskMutate).not.toHaveBeenCalled();
  });

  test('switches host transports without changing hook order and restores ordinary chat submission', async () => {
    const first: ResumeSubmitTransport = {
      submitToolApproval: jest.fn(async () => {}),
      submitAskAnswer: jest.fn(async () => {}),
    };
    const second: ResumeSubmitTransport = {
      submitToolApproval: jest.fn(async () => {}),
      submitAskAnswer: jest.fn(async () => {}),
    };
    let transport: ResumeSubmitTransport | null = null;
    const ChatWrapper = createWrapper(1000);
    const hostWrapper = ({ children }: { children: React.ReactNode }) => (
      <ChatWrapper>
        <ResumeSubmitContext.Provider value={transport}>{children}</ResumeSubmitContext.Provider>
      </ChatWrapper>
    );
    const { result, rerender } = renderHook(() => useResumeSubmit(), { wrapper: hostWrapper });
    transport = first;
    rerender();
    await act(async () => result.current.submitAskAnswer('host-first', 'first'));
    expect(first.submitAskAnswer).toHaveBeenCalledWith('host-first', 'first');
    transport = second;
    rerender();
    await act(async () => result.current.submitAskAnswer('host-second', 'second'));
    expect(second.submitAskAnswer).toHaveBeenCalledWith('host-second', 'second');
    expect(mockAskMutate).not.toHaveBeenCalled();
    transport = null;
    rerender();
    act(() => result.current.submitAskAnswer('chat-action', 'ordinary'));
    expect(mockAskMutate).toHaveBeenCalledTimes(1);
    expect(mockAskMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        actionId: 'chat-action',
        answer: 'ordinary',
      }),
      expect.any(Object),
    );
  });

  test.each(['tool', 'ask'] as const)(
    'owns pending, retryable failure and success for %s host submissions across hook instances',
    async (kind) => {
      const first = Promise.withResolvers<void>();
      const retry = Promise.withResolvers<void>();
      const send = jest
        .fn()
        .mockImplementationOnce(() => first.promise)
        .mockImplementationOnce(() => retry.promise);
      const transport: ResumeSubmitTransport = { submitToolApproval: send, submitAskAnswer: send };
      const hostWrapper = ({ children }: { children: React.ReactNode }) => (
        <JotaiProvider>
          <ApprovalProvider>
            <ResumeSubmitContext.Provider value={transport}>
              {children}
            </ResumeSubmitContext.Provider>
          </ApprovalProvider>
        </JotaiProvider>
      );
      const { result } = renderHook(
        () => ({
          approval: useApprovalContext(),
          ask: useAskSubmitStatus(),
          first: useResumeSubmit(),
          second: useResumeSubmit(),
        }),
        { wrapper: hostWrapper },
      );
      const onSuccess = jest.fn();
      const submit = (surface: 'first' | 'second') =>
        kind === 'tool'
          ? result.current[surface].submitToolApproval('action')
          : result.current[surface].submitAskAnswer('action', 'answer', { onSuccess });
      const status = () =>
        kind === 'tool'
          ? result.current.approval.getStatus('action')
          : result.current.ask.getAskStatus('action');
      act(() => {
        result.current.approval.registerToolCall('action', 'tool');
        result.current.approval.setDecision('action', 'tool', {
          tool_call_id: 'tool',
          decision: 'approve',
        });
        submit('first');
        submit('second');
      });
      expect(send).toHaveBeenCalledTimes(1);
      expect(status()).toBe('submitting');
      await act(async () => {
        first.reject(new Error('temporary'));
      });
      expect(status()).toBe('error');
      expect(onSuccess).not.toHaveBeenCalled();
      act(() => {
        submit('second');
        submit('first');
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(status()).toBe('submitting');
      await act(async () => {
        retry.resolve();
      });
      expect(status()).toBe('submitted');
      act(() => {
        submit('first');
        submit('second');
      });
      expect(send).toHaveBeenCalledTimes(2);
      expect(onSuccess).toHaveBeenCalledTimes(kind === 'ask' ? 1 : 0);
    },
  );

  test.each(['tool', 'ask'] as const)(
    'keeps expired %s host submissions terminal and catches synchronous transport errors',
    async (kind) => {
      const send = jest
        .fn<Promise<void>, []>()
        .mockImplementationOnce(() => {
          throw new Error('synchronous failure');
        })
        .mockRejectedValueOnce({ response: { status: 409 } });
      const transport: ResumeSubmitTransport = { submitToolApproval: send, submitAskAnswer: send };
      const hostWrapper = ({ children }: { children: React.ReactNode }) => (
        <JotaiProvider>
          <ApprovalProvider>
            <ResumeSubmitContext.Provider value={transport}>
              {children}
            </ResumeSubmitContext.Provider>
          </ApprovalProvider>
        </JotaiProvider>
      );
      const { result } = renderHook(
        () => ({
          approval: useApprovalContext(),
          ask: useAskSubmitStatus(),
          submit: useResumeSubmit(),
        }),
        { wrapper: hostWrapper },
      );
      const submit = () =>
        kind === 'tool'
          ? result.current.submit.submitToolApproval('action')
          : result.current.submit.submitAskAnswer('action', 'answer');
      const status = () =>
        kind === 'tool'
          ? result.current.approval.getStatus('action')
          : result.current.ask.getAskStatus('action');
      act(() => {
        result.current.approval.registerToolCall('action', 'tool');
        result.current.approval.setDecision('action', 'tool', {
          tool_call_id: 'tool',
          decision: 'approve',
        });
      });
      await act(async () => submit());
      expect(status()).toBe('error');
      await act(async () => submit());
      expect(status()).toBe('expired');
      act(() => submit());
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  test('accepts only action identity and payload without requiring chat stream metadata', () => {
    const hostWrapper = ({ children }: { children: React.ReactNode }) => (
      <JotaiProvider>
        <ApprovalProvider
          pendingAction={{ actionId: pendingAction.actionId, payload: pendingAction.payload }}
        >
          {children}
        </ApprovalProvider>
      </JotaiProvider>
    );
    const { result } = renderHook(() => useApprovalContext(), { wrapper: hostWrapper });
    expect(result.current.getRegisteredCount('action-1')).toBe(2);
    expect(result.current.getLeadToolCallId('action-1')).toBe('call-1');
    expect(result.current.isReady('action-1')).toBe(false);
  });

  test('synchronously deduplicates tool approval submissions and unlocks a retryable error', () => {
    const { result } = renderHook(
      () => ({
        approval: useApprovalContext(),
        resume: useResumeSubmit(),
      }),
      { wrapper },
    );

    act(() => {
      result.current.approval.registerToolCall('action-1', 'call-1');
      result.current.approval.setDecision('action-1', 'call-1', {
        tool_call_id: 'call-1',
        decision: 'approve',
      });
    });

    act(() => {
      result.current.resume.submitToolApproval('action-1');
      result.current.resume.submitToolApproval('action-1');
    });
    expect(mockApprovalMutate).toHaveBeenCalledTimes(1);
    expect(mockApprovalMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
        actionId: 'action-1',
      }),
      expect.any(Object),
    );

    const firstOptions = mockApprovalMutate.mock.calls[0][1] as {
      onError: (error: unknown) => void;
    };
    act(() => firstOptions.onError(new Error('temporary failure')));

    act(() => {
      result.current.resume.submitToolApproval('action-1');
      result.current.resume.submitToolApproval('action-1');
    });
    expect(mockApprovalMutate).toHaveBeenCalledTimes(2);
  });

  test('shares the synchronous submit lock across timeline and composer surfaces', () => {
    const { result } = renderHook(
      () => ({
        approval: useApprovalContext(),
        timeline: useResumeSubmit(),
        composer: useResumeSubmit(),
      }),
      { wrapper },
    );

    act(() => {
      result.current.approval.registerToolCall('action-1', 'call-1');
      result.current.approval.setDecision('action-1', 'call-1', {
        tool_call_id: 'call-1',
        decision: 'approve',
      });
      result.current.timeline.submitToolApproval('action-1');
      result.current.composer.submitToolApproval('action-1');
    });

    expect(mockApprovalMutate).toHaveBeenCalledTimes(1);
  });

  test('uses the server action payload as batch membership even when a card is hidden', () => {
    const authoritativeWrapper = ({ children }: { children: React.ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={createStore()}>
          <ApprovalProvider pendingAction={pendingAction}>{children}</ApprovalProvider>
        </JotaiProvider>
      </RecoilRoot>
    );
    const { result } = renderHook(() => useApprovalContext(), {
      wrapper: authoritativeWrapper,
    });

    expect(result.current.getRegisteredCount('action-1')).toBe(2);
    expect(result.current.getLeadToolCallId('action-1')).toBe('call-1');

    act(() => {
      result.current.setDecision('action-1', 'call-1', {
        tool_call_id: 'call-1',
        decision: 'approve',
      });
    });
    expect(result.current.isReady('action-1')).toBe(false);

    act(() => {
      result.current.setDecision('action-1', 'call-2', {
        tool_call_id: 'call-2',
        decision: 'reject',
      });
    });
    expect(result.current.isReady('action-1')).toBe(true);

    act(() => result.current.unregisterToolCall('action-1', 'call-2'));
    expect(result.current.getRegisteredCount('action-1')).toBe(2);
    expect(result.current.isReady('action-1')).toBe(true);
  });

  test('nested approval providers reuse the chat-level decision state', () => {
    const nestedWrapper = ({ children }: { children: React.ReactNode }) => (
      <RecoilRoot>
        <JotaiProvider store={createStore()}>
          <ApprovalProvider pendingAction={pendingAction}>
            <ApprovalProvider>{children}</ApprovalProvider>
          </ApprovalProvider>
        </JotaiProvider>
      </RecoilRoot>
    );
    const { result } = renderHook(() => useApprovalContext(), { wrapper: nestedWrapper });

    expect(result.current.getRegisteredCount('action-1')).toBe(2);
  });

  test('retains a decision across a transient card unregister and re-register', () => {
    const { result } = renderHook(() => useApprovalContext(), { wrapper });
    const decision = { tool_call_id: 'call-1', decision: 'approve' } as const;

    act(() => {
      result.current.registerToolCall('action-1', 'call-1');
      result.current.setDecision('action-1', 'call-1', decision);
    });
    act(() => result.current.unregisterToolCall('action-1', 'call-1'));

    expect(result.current.getDecisions('action-1')).toEqual([]);
    expect(result.current.getDecision('action-1', 'call-1')).toEqual(decision);

    act(() => result.current.registerToolCall('action-1', 'call-1'));
    expect(result.current.getDecisions('action-1')).toEqual([decision]);
    expect(result.current.isReady('action-1')).toBe(true);
  });

  test('keeps approval and ask-answer resume controls inert before the generation epoch exists', () => {
    const { result } = renderHook(
      () => ({
        approval: useApprovalContext(),
        resume: useResumeSubmit(),
      }),
      { wrapper: createWrapper(null) },
    );

    act(() => {
      result.current.approval.registerToolCall('action-1', 'call-1');
      result.current.approval.setDecision('action-1', 'call-1', {
        tool_call_id: 'call-1',
        decision: 'approve',
      });
      result.current.resume.submitToolApproval('action-1');
      result.current.resume.submitAskAnswer('ask-1', 'answer');
    });

    expect(mockApprovalMutate).not.toHaveBeenCalled();
    expect(mockAskMutate).not.toHaveBeenCalled();
  });

  test('synchronously deduplicates ask answers and unlocks a retryable error', () => {
    const { result } = renderHook(() => useResumeSubmit(), { wrapper });

    act(() => {
      result.current.submitAskAnswer('ask-1', 'answer');
      result.current.submitAskAnswer('ask-1', 'answer');
    });
    expect(mockAskMutate).toHaveBeenCalledTimes(1);
    expect(mockAskMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
        actionId: 'ask-1',
        answer: 'answer',
      }),
      expect.any(Object),
    );

    const firstOptions = mockAskMutate.mock.calls[0][1] as {
      onError: (error: unknown) => void;
    };
    act(() => firstOptions.onError(new Error('temporary failure')));

    act(() => {
      result.current.submitAskAnswer('ask-1', 'answer');
      result.current.submitAskAnswer('ask-1', 'answer');
    });
    expect(mockAskMutate).toHaveBeenCalledTimes(2);
  });
});
