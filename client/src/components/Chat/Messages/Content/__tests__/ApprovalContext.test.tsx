import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import type { MutableSnapshot } from 'recoil';
import ApprovalProvider, { useApprovalContext, useResumeSubmit } from '../ApprovalContext';
import { ChatContext } from '~/Providers/ChatContext';
import store from '~/store';

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
    const jotaiStore = React.useRef(createStore()).current;
    const initializeState = (snapshot: MutableSnapshot) => {
      if (generationCreatedAt != null) {
        snapshot.set(
          store.activeGenerationCreatedAtByConvoId('conversation-1'),
          generationCreatedAt,
        );
      }
    };
    return (
      <RecoilRoot initializeState={initializeState}>
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
