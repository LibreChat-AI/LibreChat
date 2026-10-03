// useQueryParams.spec.ts
jest.mock('recoil', () => {
  const originalModule = jest.requireActual('recoil');
  return {
    ...originalModule,
    atom: jest.fn().mockImplementation((config) => ({
      key: config.key,
      default: config.default,
    })),
    useRecoilValue: jest.fn(),
  };
});

// Move mock store definition after the mocks
jest.mock('~/store', () => ({
  modularChat: { key: 'modularChat', default: false },
  availableTools: { key: 'availableTools', default: [] },
}));

import { renderHook, act } from '@testing-library/react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import useQueryParams from './useQueryParams';
import { useChatContext, useChatFormContext } from '~/Providers';
import useSubmitMessage from '~/hooks/Messages/useSubmitMessage';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import store from '~/store';

// Other mocks
jest.mock('react-router-dom', () => ({
  useSearchParams: jest.fn(),
}));

jest.mock('@tanstack/react-query', () => ({
  useQueryClient: jest.fn(),
  useQuery: jest.fn(),
}));

jest.mock('~/Providers', () => ({
  useChatContext: jest.fn(),
  useChatFormContext: jest.fn(),
}));

jest.mock('~/hooks/Messages/useSubmitMessage', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/hooks/Conversations/useDefaultConvo', () => ({
  __esModule: true,
  default: jest.fn(),
}));

jest.mock('~/hooks/AuthContext', () => ({
  useAuthContext: jest.fn(),
}));

jest.mock('~/hooks/Agents/useAgentsMap', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}));
jest.mock('~/hooks/Agents/useAgentDefaultPermissionLevel', () => ({
  __esModule: true,
  default: jest.fn(() => ({})),
}));

jest.mock('~/utils', () => {
  const actualUtils = jest.requireActual('~/utils');
  return {
    ...actualUtils,
    // Only mock logger to suppress test output
    logger: { log: jest.fn(), warn: jest.fn(), error: jest.fn() },
    // Mock theme utilities that interact with DOM
    getInitialTheme: jest.fn(() => 'light'),
    applyFontSize: jest.fn(),
  };
});

// Use actual librechat-data-provider with minimal overrides
jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    // Override schema to avoid complex validation in tests
    tQueryParamsSchema: {
      shape: {
        model: { parse: jest.fn((value) => value) },
        endpoint: { parse: jest.fn((value) => value) },
        temperature: { parse: jest.fn((value) => value) },
      },
    },
  };
});

// Mock data-provider hooks while preserving real exports like startupConfigKey
jest.mock('~/data-provider', () => {
  const actual = jest.requireActual<typeof import('~/data-provider')>('~/data-provider');
  return {
    ...actual,
    useGetAgentByIdQuery: jest.fn(() => ({
      data: null,
      isLoading: false,
      error: null,
    })),
    useListAgentsQuery: jest.fn(() => ({
      data: null,
      isLoading: false,
      error: null,
    })),
  };
});

// Mock global window.history
global.window = Object.create(window);
global.window.history = {
  replaceState: jest.fn(),
  pushState: jest.fn(),
  go: jest.fn(),
  back: jest.fn(),
  forward: jest.fn(),
  length: 1,
  scrollRestoration: 'auto',
  state: null,
};

describe('useQueryParams', () => {
  // Setup common mocks before each test
  beforeEach(() => {
    jest.useFakeTimers();

    // Reset mock for window.history.replaceState
    jest.spyOn(window.history, 'replaceState').mockClear();

    // Reset data-provider mocks
    const dataProvider = jest.requireMock('~/data-provider');
    (dataProvider.useGetAgentByIdQuery as jest.Mock).mockReturnValue({
      data: null,
      isLoading: false,
      error: null,
    });

    // Create mocks for all dependencies
    const mockSearchParams = new URLSearchParams();
    (useSearchParams as jest.Mock).mockReturnValue([mockSearchParams, jest.fn()]);

    const mockQueryClient = {
      getQueryData: jest.fn().mockImplementation((key) => {
        if (key === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        if (key === 'endpoints') {
          return {};
        }
        return null;
      }),
    };
    (useQueryClient as jest.Mock).mockReturnValue(mockQueryClient);

    (useRecoilValue as jest.Mock).mockImplementation((atom) => {
      if (atom === store.modularChat) return false;
      if (atom === store.availableTools) return [];
      return null;
    });

    const mockConversation = { model: null, endpoint: null };
    const mockNewConversation = jest.fn();
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: mockConversation,
      newConversation: mockNewConversation,
    });

    const mockMethods = {
      setValue: jest.fn(),
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: jest.fn((callback) => () => callback({ text: 'test message' })),
    };
    (useChatFormContext as jest.Mock).mockReturnValue(mockMethods);

    const mockSubmitMessage = jest.fn();
    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    const mockGetDefaultConversation = jest.fn().mockReturnValue({});
    (useDefaultConvo as jest.Mock).mockReturnValue(mockGetDefaultConversation);

    // Mock useAuthContext
    const { useAuthContext } = jest.requireMock('~/hooks/AuthContext');
    (useAuthContext as jest.Mock).mockReturnValue({
      user: { id: 'test-user-id' },
      isAuthenticated: true,
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  // Helper function to set URL parameters for testing
  const setUrlParams = (params: Record<string, string>) => {
    const searchParams = new URLSearchParams();
    Object.entries(params).forEach(([key, value]) => {
      searchParams.set(key, value);
    });
    (useSearchParams as jest.Mock).mockReturnValue([searchParams, jest.fn()]);
  };

  // Test cases remain the same
  it('should process query parameters on initial render', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: jest.fn((callback) => () => callback({ text: 'test message' })),
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        return null;
      }),
    });

    setUrlParams({ q: 'hello world' });

    // Execute
    renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    // Advance timer to trigger interval
    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert
    expect(mockSetValue).toHaveBeenCalledWith(
      'text',
      'hello world',
      expect.objectContaining({ shouldValidate: true }),
    );
    const mockSetSearchParams = (useSearchParams as jest.Mock).mock.results[0].value[1];
    const [params, options] = mockSetSearchParams.mock.calls[0];
    expect(params).toBeInstanceOf(URLSearchParams);
    expect(params.toString()).toBe('');
    expect(options).toEqual(expect.objectContaining({ replace: true }));
  });

  it('should auto-submit message when submit=true and no settings to apply', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn((callback) => () => callback({ text: 'test message' }));
    const mockSubmitMessage = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        return null;
      }),
    });

    setUrlParams({ q: 'hello world', submit: 'true' });

    // Execute
    renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    // Advance timer to trigger interval
    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert
    expect(mockSetValue).toHaveBeenCalledWith(
      'text',
      'hello world',
      expect.objectContaining({ shouldValidate: true }),
    );
    expect(mockHandleSubmit).toHaveBeenCalled();
    expect(mockSubmitMessage).toHaveBeenCalled();
  });

  it('should defer submission when settings need to be applied first', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn((callback) => () => callback({ text: 'test message' }));
    const mockSubmitMessage = jest.fn();
    const mockNewConversation = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    // Mock getQueryData to return array format for startupConfig and endpoints
    const mockGetQueryData = jest.fn().mockImplementation((key) => {
      const k = Array.isArray(key) ? key[0] : key;
      if (k === 'startupConfig') {
        return { modelSpecs: { list: [] } };
      }
      if (k === 'endpoints') {
        return {};
      }
      return null;
    });

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    (useChatContext as jest.Mock).mockReturnValue({
      conversation: { model: null, endpoint: null },
      newConversation: mockNewConversation,
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: mockGetQueryData,
    });

    setUrlParams({ q: 'hello world', submit: 'true', model: 'gpt-4' });

    // Execute
    const { rerender } = renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    // First interval tick should process params but not submit
    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert initial state
    expect(mockGetQueryData).toHaveBeenCalledWith(expect.anything());
    expect(mockNewConversation).toHaveBeenCalled();
    expect(mockSubmitMessage).not.toHaveBeenCalled(); // Not submitted yet

    // Now mock conversation update to trigger settings application check
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: { model: 'gpt-4', endpoint: null },
      newConversation: mockNewConversation,
    });

    // Re-render to trigger the effect that watches for settings
    rerender();

    // Now the message should be submitted
    expect(mockSetValue).toHaveBeenCalledWith(
      'text',
      'hello world',
      expect.objectContaining({ shouldValidate: true }),
    );
    expect(mockHandleSubmit).toHaveBeenCalled();
    expect(mockSubmitMessage).toHaveBeenCalled();
  });

  it('should submit after timeout if settings never get applied', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn((callback) => () => callback({ text: 'test message' }));
    const mockSubmitMessage = jest.fn();
    const mockNewConversation = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    (useChatContext as jest.Mock).mockReturnValue({
      conversation: { model: null, endpoint: null },
      newConversation: mockNewConversation,
    });

    // Mock startup config and endpoints to allow processing
    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        if (k === 'endpoints') {
          return {};
        }
        return null;
      }),
    });

    setUrlParams({ q: 'hello world', submit: 'true', model: 'non-existent-model' });

    // Execute
    renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    // First interval tick should process params but not submit
    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert initial state
    expect(mockSubmitMessage).not.toHaveBeenCalled(); // Not submitted yet

    // Let the timeout happen naturally
    act(() => {
      // Advance timer to trigger the timeout in the hook
      jest.advanceTimersByTime(3000); // MAX_SETTINGS_WAIT_MS
    });

    // Now the message should be submitted due to timeout
    expect(mockSubmitMessage).toHaveBeenCalled();
  });

  it('should defer submission until the URL agent query resolves', () => {
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn((callback) => () => callback({ text: 'test message' }));
    const mockSubmitMessage = jest.fn();
    const mockNewConversation = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    const conversationWithAgent = { agent_id: 'agent_test_123', endpoint: 'agents' };
    (useChatContext as jest.Mock).mockReturnValue({
      conversation: conversationWithAgent,
      newConversation: mockNewConversation,
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        if (k === 'endpoints') {
          return { agents: {} };
        }
        return null;
      }),
    });

    const dataProvider = jest.requireMock('~/data-provider');
    (dataProvider.useGetAgentByIdQuery as jest.Mock).mockReturnValue({
      data: null,
      isLoading: true,
      error: null,
    });

    const dataProviderMock = jest.requireMock('librechat-data-provider');
    dataProviderMock.tQueryParamsSchema = {
      shape: {
        agent_id: { parse: jest.fn((value) => value) },
        endpoint: { parse: jest.fn((value) => value) },
      },
    };

    setUrlParams({
      q: 'hello world',
      submit: 'true',
      agent_id: 'agent_test_123',
    });

    const { rerender } = renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Should not submit while the agent query is still loading.
    expect(mockSubmitMessage).not.toHaveBeenCalled();

    // Timeout fires with the agent still unresolved → must stay deferred.
    act(() => {
      jest.advanceTimersByTime(3000);
    });
    expect(mockSubmitMessage).not.toHaveBeenCalled();

    // Agent resolves; the urlAgent-keyed effect should now fire the submission.
    (dataProvider.useGetAgentByIdQuery as jest.Mock).mockReturnValue({
      data: { id: 'agent_test_123', name: 'Test Agent' },
      isLoading: false,
      error: null,
    });
    rerender();

    expect(mockSetValue).toHaveBeenCalledWith(
      'text',
      'hello world',
      expect.objectContaining({ shouldValidate: true }),
    );
    expect(mockHandleSubmit).toHaveBeenCalled();
    expect(mockSubmitMessage).toHaveBeenCalled();
  });

  it('should mark as submitted when no submit parameter is present', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn((callback) => () => callback({ text: 'test message' }));
    const mockSubmitMessage = jest.fn();
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        return null;
      }),
    });

    setUrlParams({ model: 'gpt-4' }); // No submit=true

    // Execute
    renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    // First interval tick should process params
    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert initial state - submission should be marked as handled
    expect(mockSubmitMessage).not.toHaveBeenCalled();

    // Try to advance timer past the timeout
    act(() => {
      jest.advanceTimersByTime(4000);
    });

    // Submission still shouldn't happen
    expect(mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('should handle empty query parameters', () => {
    // Setup
    const mockSetValue = jest.fn();
    const mockHandleSubmit = jest.fn();
    const mockSubmitMessage = jest.fn();

    // Force replaceState to be called
    window.history.replaceState = jest.fn();

    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn().mockReturnValue(''),
      handleSubmit: mockHandleSubmit,
    });

    (useSubmitMessage as jest.Mock).mockReturnValue({
      submitMessage: mockSubmitMessage,
    });

    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn().mockImplementation((key) => {
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        return null;
      }),
    });

    setUrlParams({}); // Empty params
    const mockTextAreaRef = {
      current: {
        focus: jest.fn(),
        setSelectionRange: jest.fn(),
      } as unknown as HTMLTextAreaElement,
    };

    // Execute
    renderHook(() => useQueryParams({ textAreaRef: mockTextAreaRef }));

    act(() => {
      jest.advanceTimersByTime(100);
    });

    // Assert
    expect(mockSetValue).not.toHaveBeenCalled();
    expect(mockHandleSubmit).not.toHaveBeenCalled();
    expect(mockSubmitMessage).not.toHaveBeenCalled();
    const mockSetSearchParams = (useSearchParams as jest.Mock).mock.results[0].value[1];
    const [params, options] = mockSetSearchParams.mock.calls[0];
    expect(params).toBeInstanceOf(URLSearchParams);
    expect(params.toString()).toBe('');
    expect(options).toEqual(expect.objectContaining({ replace: true }));
  });
});
