import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { Provider as JotaiProvider, createStore } from 'jotai';
import { activeGenerationCreatedAtByConvoId } from '@librechat/chat/react';
import type { ResumeSubmitTransport } from '../ApprovalContext';
import ApprovalProvider, {
  ResumeSubmitContext,
  useApprovalContext,
  useResumeSubmit,
} from '../ApprovalContext';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import { ChatContext } from '~/Providers/ChatContext';

const mockApprovalMutate = jest.fn();
const mockAskMutate = jest.fn();
const getEphemeralAgent = jest.fn(() => ({ mcp: ['server'] }));

jest.mock('~/data-provider', () => ({
  useSubmitToolApprovalMutation: () => ({ mutate: mockApprovalMutate }),
  useSubmitAskAnswerMutation: () => ({ mutate: mockAskMutate }),
}));

const chatContextValue = {
  conversation: {
    conversationId: 'conversation-1',
    endpoint: 'agents',
    endpointType: 'custom',
    agent_id: 'agent-1',
    model: 'model-1',
    spec: 'spec-1',
    promptPrefix: 'be brief',
  },
  getMessages: () => [{ messageId: 'm1', content: [{ type: 'text', text: 'hi' }] }],
  setMessages: jest.fn(),
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
      <JotaiProvider store={jotaiStore}>
        <ChatSettingsContext.Provider value={{ ...defaultChatSettings, getEphemeralAgent }}>
          <ChatContext.Provider value={chatContextValue}>
            <ApprovalProvider>{children}</ApprovalProvider>
          </ChatContext.Provider>
        </ChatSettingsContext.Provider>
      </JotaiProvider>
    );
  };

describe('app approval resume host', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('sends conversation fields, the epoch and the ephemeral agent', () => {
    const { result } = renderHook(
      () => ({
        approval: useApprovalContext(),
        resume: useResumeSubmit(),
      }),
      { wrapper: createWrapper(1000) },
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

    expect(mockApprovalMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
        endpoint: 'agents',
        endpointType: 'custom',
        agent_id: 'agent-1',
        model: 'model-1',
        spec: 'spec-1',
        promptPrefix: 'be brief',
        ephemeralAgent: { mcp: ['server'] },
        actionId: 'action-1',
        decisions: [{ tool_call_id: 'call-1', decision: 'approve' }],
      }),
      expect.any(Object),
    );
    expect(mockAskMutate).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'conversation-1',
        generationCreatedAt: 1000,
        actionId: 'ask-1',
        answer: 'answer',
        ephemeralAgent: { mcp: ['server'] },
      }),
      expect.any(Object),
    );
  });

  test('omits the epoch when the client has not observed one', () => {
    const { result } = renderHook(() => useResumeSubmit(), { wrapper: createWrapper(null) });
    act(() => result.current.submitAskAnswer('ask-1', 'answer'));
    expect(mockAskMutate.mock.calls[0][0]).not.toHaveProperty('generationCreatedAt');
  });

  test('an explicit transport replaces the chat mutation until it is cleared', async () => {
    const first: ResumeSubmitTransport = {
      submitToolApproval: jest.fn(async () => {}),
      submitAskAnswer: jest.fn(async () => {}),
    };
    let transport: ResumeSubmitTransport | null = first;
    const ChatWrapper = createWrapper(1000);
    const { result, rerender } = renderHook(() => useResumeSubmit(), {
      wrapper: ({ children }) => (
        <ChatWrapper>
          <ResumeSubmitContext.Provider value={transport}>{children}</ResumeSubmitContext.Provider>
        </ChatWrapper>
      ),
    });
    await act(async () => result.current.submitAskAnswer('host-action', 'first'));
    expect(first.submitAskAnswer).toHaveBeenCalledWith('host-action', 'first');
    expect(mockAskMutate).not.toHaveBeenCalled();
    transport = null;
    rerender();
    act(() => result.current.submitAskAnswer('chat-action', 'ordinary'));
    expect(mockAskMutate).toHaveBeenCalledWith(
      expect.objectContaining({ actionId: 'chat-action', answer: 'ordinary' }),
      expect.any(Object),
    );
  });
});
