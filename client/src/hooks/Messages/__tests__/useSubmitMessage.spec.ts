import { act, renderHook } from '@testing-library/react';
import { useRecoilValue, useSetRecoilState } from 'recoil';
import type { TReasoningOverride } from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useGetLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { useAuthContext } from '~/hooks/AuthContext';
import useSubmitMessage from '../useSubmitMessage';

const mockSetActivePrompt = jest.fn();

jest.mock('recoil', () => ({
  useRecoilValue: jest.fn(),
  useSetRecoilState: jest.fn(),
}));

jest.mock('librechat-data-provider', () => ({
  replaceSpecialVars: jest.fn(({ text }) => text),
}));

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
  useChatFormContext: jest.fn(),
  useAddedChatContext: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: jest.fn(),
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useGetLatestMessage: jest.fn(),
}));

jest.mock('~/store', () => ({
  __esModule: true,
  default: {
    autoSendPrompts: 'autoSendPrompts',
    activePromptByIndex: jest.fn(() => 'activePromptByIndex'),
  },
}));

const mockUseRecoilValue = useRecoilValue as jest.Mock;
const mockUseSetRecoilState = useSetRecoilState as jest.Mock;
const mockUseChatContext = useChatContext as jest.Mock;
const mockUseChatFormContext = useChatFormContext as jest.Mock;
const mockUseAddedChatContext = useAddedChatContext as jest.Mock;
const mockUseAuthContext = useAuthContext as jest.Mock;
const mockUseGetLatestMessage = useGetLatestMessage as jest.Mock;

describe('useSubmitMessage', () => {
  const ask = jest.fn();
  const reset = jest.fn();
  const setMessages = jest.fn();
  const getMessages = jest.fn();

  beforeEach(() => {
    jest.clearAllMocks();
    mockUseRecoilValue.mockReturnValue(false);
    mockUseSetRecoilState.mockReturnValue(mockSetActivePrompt);
    mockUseAuthContext.mockReturnValue({ user: { id: 'user-1' } });
    mockUseAddedChatContext.mockReturnValue({ conversation: null });
    mockUseChatFormContext.mockReturnValue({ reset, getValues: jest.fn(() => '') });
    mockUseGetLatestMessage.mockReturnValue(() => ({ messageId: 'assistant-message' }));
    getMessages.mockReturnValue([{ messageId: 'assistant-message' }]);
    mockUseChatContext.mockReturnValue({
      ask,
      index: 0,
      getMessages,
      setMessages,
    });
  });

  it('propagates blocked submits so direct callers can preserve their text', () => {
    ask.mockReturnValue(false);

    const { result } = renderHook(() => useSubmitMessage());

    let submitted: false | void = undefined;
    act(() => {
      submitted = result.current.submitMessage({ text: 'dictated follow-up' });
    });

    expect(submitted).toBe(false);
    expect(reset).not.toHaveBeenCalled();
  });

  it.each([false, true])('preserves a refused automatic prompt (accepted=%s)', (accepted) => {
    mockUseRecoilValue.mockReturnValue(true);
    ask.mockReturnValue(accepted);
    const { result } = renderHook(() => useSubmitMessage());
    act(() => result.current.submitPrompt('selected prompt'));
    expect(ask).toHaveBeenCalledWith({ text: 'selected prompt' }, expect.any(Object));
    if (accepted) {
      expect(mockSetActivePrompt).not.toHaveBeenCalled();
      expect(reset).toHaveBeenCalled();
    } else {
      expect(mockSetActivePrompt).toHaveBeenCalledWith('selected prompt');
      expect(reset).not.toHaveBeenCalled();
    }
  });

  it('reads the tail at call time and appends it to root when missing', () => {
    const rootMessages = [{ messageId: 'root-user' }];
    const latest = { messageId: 'assistant-tail', text: 'tail' };
    const reader = jest.fn(() => latest);
    mockUseGetLatestMessage.mockReturnValue(reader);
    getMessages.mockReturnValue(rootMessages);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage());
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(reader).toHaveBeenCalled();
    expect(setMessages).toHaveBeenCalledWith([...rootMessages, latest]);
    expect(ask).toHaveBeenCalled();
    expect(reset).toHaveBeenCalled();
  });

  it('does not append when the latest message is already in root', () => {
    const latest = { messageId: 'assistant-tail' };
    mockUseGetLatestMessage.mockReturnValue(() => latest);
    getMessages.mockReturnValue([latest]);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage());
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
  });

  it('does not append when there is no latest message', () => {
    mockUseGetLatestMessage.mockReturnValue(() => null);
    getMessages.mockReturnValue([{ messageId: 'root-user' }]);
    ask.mockReturnValue(true);

    const { result } = renderHook(() => useSubmitMessage());
    act(() => {
      result.current.submitMessage({ text: 'hello' });
    });

    expect(setMessages).not.toHaveBeenCalled();
    expect(ask).toHaveBeenCalled();
  });

  it('uses the recovery source as the stable user row and forwards the attempt fields', () => {
    ask.mockReturnValue(true);
    const { result } = renderHook(() => useSubmitMessage());

    act(() => {
      result.current.submitMessage({
        text: 'recover once',
        overrideClientRequestId: 'attempt-uuid',
        overrideRecoverySteerId: 'source-steer',
      });
    });

    expect(ask).toHaveBeenCalledWith(
      { text: 'recover once', overrideUserMessageId: 'source-steer' },
      expect.objectContaining({
        overrideClientRequestId: 'attempt-uuid',
        overrideRecoverySteerId: 'source-steer',
      }),
    );
  });

  it('forwards a queued reasoning override without resetting it on refusal', () => {
    ask.mockReturnValue(false);
    const { result } = renderHook(() => useSubmitMessage());
    const override = { key: 'thinkingLevel', value: 'high' } as TReasoningOverride;

    act(() => {
      result.current.submitMessage({ text: 'queued thought', overrideReasoning: override });
    });

    expect(ask).toHaveBeenCalledWith(
      { text: 'queued thought' },
      expect.objectContaining({ overrideReasoning: override }),
    );
    expect(reset).not.toHaveBeenCalled();
  });
});
