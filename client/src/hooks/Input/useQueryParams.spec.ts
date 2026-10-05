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
import { useLocation, useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useRecoilValue } from 'recoil';
import { EModelEndpoint, parseConvo } from 'librechat-data-provider';
import type { TConversation, TStartupConfig } from 'librechat-data-provider';
import buildDefaultConvo from '~/utils/buildDefaultConvo';
import useQueryParams from './useQueryParams';
import { useChatContext, useChatFormContext } from '~/Providers';
import useSubmitMessage from '~/hooks/Messages/useSubmitMessage';
import useDefaultConvo from '~/hooks/Conversations/useDefaultConvo';
import store from '~/store';

// Other mocks
jest.mock('react-router-dom', () => ({
  useSearchParams: jest.fn(),
  useLocation: jest.fn(),
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
    (useLocation as jest.Mock).mockReturnValue({ pathname: '/c/new', key: 'origin' });

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
        const k = Array.isArray(key) ? key[0] : key;
        if (k === 'startupConfig') {
          return { modelSpecs: { list: [] } };
        }
        if (k === 'endpoints') {
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

  const mountQuery = (
    params: Record<string, string>,
    startupConfig: {
      modelSpecs?: Partial<NonNullable<TStartupConfig['modelSpecs']>>;
      interface?: Partial<NonNullable<TStartupConfig['interface']>>;
    } | null = { modelSpecs: { list: [] } },
  ) => {
    const textAreaRef = { current: document.createElement('textarea') };
    const mockSetValue = jest.fn((_field: string, text: string) => {
      textAreaRef.current.value = text;
    });
    const mockSubmitMessage = jest.fn();
    const mockNewConversation = jest.fn();
    const mockSetSearchParams = jest.fn();
    const searchParams = new URLSearchParams(params);
    (useSearchParams as jest.Mock).mockReturnValue([searchParams, mockSetSearchParams]);
    (useQueryClient as jest.Mock).mockReturnValue({
      getQueryData: jest.fn((key) => {
        if (key[0] === 'startupConfig') {
          return startupConfig;
        }
        if (key[0] === 'endpoints') {
          return { MyProvider: { type: 'custom' }, agents: {} };
        }
        return null;
      }),
    });
    (useChatFormContext as jest.Mock).mockReturnValue({
      setValue: mockSetValue,
      getValues: jest.fn(() => textAreaRef.current.value),
      handleSubmit: jest.fn((callback) => () => callback({ text: textAreaRef.current.value })),
    });
    (useSubmitMessage as jest.Mock).mockReturnValue({ submitMessage: mockSubmitMessage });
    const updateConversation = (conversation: Partial<TConversation>) => {
      (useChatContext as jest.Mock).mockReturnValue({
        conversation,
        newConversation: mockNewConversation,
      });
    };
    updateConversation({ endpoint: EModelEndpoint.openAI, model: 'gpt-4o' });
    const hook = renderHook(() => useQueryParams({ textAreaRef }));
    act(() => jest.advanceTimersByTime(100));
    return {
      ...hook,
      mockSetValue,
      mockSubmitMessage,
      mockNewConversation,
      mockSetSearchParams,
      updateConversation,
      textAreaRef,
      updateRoute: (pathname: string, params: Record<string, string> = {}) => {
        (useLocation as jest.Mock).mockReturnValue({ pathname, key: 'destination' });
        (useSearchParams as jest.Mock).mockReturnValue([
          new URLSearchParams(params),
          mockSetSearchParams,
        ]);
      },
    };
  };

  it('shows the URL prompt and pending state before the requested agent is ready', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' });
    expect(hook.mockSetValue).toHaveBeenCalledWith('text', 'hi', { shouldValidate: true });
    expect(hook.result.current).toEqual(
      expect.objectContaining({ isPreparing: true, settingsError: false }),
    );
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
    expect(hook.mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        template: expect.objectContaining({ agent_id: 'agent_test' }),
        preset: expect.objectContaining({ endpoint: 'agents', agent_id: 'agent_test' }),
        keepComposerState: true,
      }),
    );

    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.result.current).toEqual(
      expect.objectContaining({ isPreparing: false, settingsError: false }),
    );
    act(() => jest.advanceTimersByTime(4000));
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it('matches the canonical custom endpoint instead of its URL casing', () => {
    const hook = mountQuery({ endpoint: 'myprovider', q: 'hi', submit: 'true' });
    hook.updateConversation({
      endpoint: 'MyProvider' as EModelEndpoint,
      endpointType: EModelEndpoint.custom,
    });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isPreparing).toBe(false);
  });

  it('matches an agent after the conversation intentionally clears its model', () => {
    const hook = mountQuery({
      agent_id: 'agent_test',
      model: 'gpt-4o',
      q: 'hi',
      submit: 'true',
    });
    hook.updateConversation({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_test',
      model: undefined,
    });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it('keeps the timeout alive across conversation rerenders without sending to the wrong agent', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true', projectId: 'p1' });
    act(() => jest.advanceTimersByTime(1000));
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_other' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(2000));
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.result.current).toEqual(
      expect.objectContaining({ isPreparing: false, settingsError: true }),
    );
    expect(hook.mockSetValue).toHaveBeenCalledTimes(1);
    const [params, options] = hook.mockSetSearchParams.mock.calls[0];
    expect(params.toString()).toBe('projectId=p1');
    expect(options).toEqual({ replace: true });
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('submits using the latest conversation-bound callback', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' });
    const latestSubmit = jest.fn();
    (useSubmitMessage as jest.Mock).mockReturnValue({ submitMessage: latestSubmit });
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    expect(latestSubmit).toHaveBeenCalledWith({ text: 'hi' });
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('waits for the resolved model spec rather than accepting any conversation', () => {
    const hook = mountQuery(
      { spec: 'helper', q: 'hi', submit: 'true' },
      {
        modelSpecs: {
          list: [
            {
              name: 'helper',
              label: 'Helper',
              preset: { endpoint: 'agents', agent_id: 'agent_test', model: 'gpt-4o' },
            },
          ],
        },
      },
    );
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    hook.updateConversation({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_other',
      spec: 'helper',
    });
    hook.rerender();
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    hook.updateConversation({
      endpoint: EModelEndpoint.agents,
      agent_id: 'agent_test',
      spec: 'helper',
    });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it('stages the prompt even before startup config has loaded', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' }, null);
    expect(hook.mockSetValue).toHaveBeenCalledWith('text', 'hi', { shouldValidate: true });
    expect(hook.mockNewConversation).not.toHaveBeenCalled();
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('honors the server policy disabling auto-submit while still staging the prompt', () => {
    const hook = mountQuery(
      { agent_id: 'agent_test', q: 'hi', submit: 'true' },
      { interface: { autoSubmitFromUrl: false } },
    );
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    expect(hook.mockSetValue).toHaveBeenCalledWith('text', 'hi', { shouldValidate: true });
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.result.current).toEqual(
      expect.objectContaining({ isPreparing: false, settingsError: false }),
    );
  });

  it('matches nullable spec settings after the endpoint schema removes them', () => {
    const preset = { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', temperature: null };
    const hook = mountQuery(
      { spec: 'helper', q: 'hi', submit: 'true' },
      { modelSpecs: { list: [{ name: 'helper', label: 'Helper', preset }] } },
    );
    const conversation = parseConvo({
      endpoint: EModelEndpoint.openAI,
      conversation: { ...preset, spec: 'helper' },
    });
    expect(conversation?.temperature).toBeUndefined();
    hook.updateConversation({ ...conversation, endpoint: EModelEndpoint.openAI });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.settingsError).toBe(false);
  });

  it.each([
    { endpoint: EModelEndpoint.openAI, endpointType: undefined },
    { endpoint: 'MyProvider' as EModelEndpoint, endpointType: EModelEndpoint.custom },
  ])('matches nullable endpoint metadata for $endpoint', ({ endpoint, endpointType }) => {
    const preset = { endpoint, endpointType: null, model: 'gpt-4o' };
    const hook = mountQuery(
      { spec: 'helper', q: 'hi', submit: 'true' },
      { modelSpecs: { list: [{ name: 'helper', label: 'Helper', preset }] } },
    );
    const conversation = buildDefaultConvo({
      models: ['gpt-4o'],
      endpoint,
      conversation: { conversationId: 'new', endpointType } as TConversation,
      lastConversationSetup: { ...preset, spec: 'helper' } as TConversation,
    });
    expect(conversation.endpointType).toBe(endpointType);
    hook.updateConversation(conversation);
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.settingsError).toBe(false);
  });

  it.each([{ tools: [] }, { tools: ['web_search'] }])(
    'matches preset tools retained by the conversation builder: $tools',
    ({ tools }) => {
      const preset = { endpoint: EModelEndpoint.openAI, model: 'gpt-4o', tools };
      const hook = mountQuery(
        { spec: 'helper', q: 'hi', submit: 'true' },
        { modelSpecs: { list: [{ name: 'helper', label: 'Helper', preset }] } },
      );
      const conversation = buildDefaultConvo({
        models: ['gpt-4o'],
        endpoint: EModelEndpoint.openAI,
        conversation: { conversationId: 'new' } as TConversation,
        lastConversationSetup: { ...preset, spec: 'helper' } as TConversation,
      });
      expect(conversation.tools).toEqual(tools);
      hook.updateConversation(conversation);
      hook.rerender();
      expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
      expect(hook.result.current.settingsError).toBe(false);
    },
  );

  it('preserves explicit URL overrides over visible spec defaults', () => {
    const hook = mountQuery(
      { spec: 'helper', temperature: '0.1', q: 'hi', submit: 'true' },
      {
        modelSpecs: {
          list: [
            {
              name: 'helper',
              label: 'Helper',
              preset: { endpoint: 'openAI', model: 'gpt-4o', temperature: 0.8 },
            },
          ],
        },
      },
    );
    expect(hook.mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({ preset: expect.objectContaining({ temperature: 0.1 }) }),
    );
    hook.updateConversation({
      endpoint: EModelEndpoint.openAI,
      model: 'gpt-4o',
      spec: 'helper',
      temperature: 0.1,
    });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
  });

  it('preserves menu-hidden spec names for the server to resolve', () => {
    const hook = mountQuery({ spec: 'hidden', endpoint: 'openAI', q: 'hi', submit: 'true' });
    expect(hook.mockNewConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        preset: expect.objectContaining({ spec: 'hidden', endpoint: 'openAI' }),
      }),
    );
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    hook.updateConversation({ endpoint: EModelEndpoint.openAI, model: 'gpt-4o', spec: 'hidden' });
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.result.current.settingsError).toBe(false);
  });

  it('cancels pending URL setup before startup config arrives', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' }, null);
    hook.textAreaRef.current.value = 'destination draft';
    hook.updateRoute('/c/other-chat');
    hook.updateConversation({ conversationId: 'other-chat', endpoint: EModelEndpoint.openAI });
    hook.rerender();
    act(() => jest.advanceTimersByTime(6000));
    expect(hook.textAreaRef.current.value).toBe('destination draft');
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
  });

  it('cancels a pending URL request when the new-chat project changes', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true', projectId: 'p1' });
    hook.textAreaRef.current.value = 'project two draft';
    hook.updateRoute('/c/new', { projectId: 'p2' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(4000));
    expect(hook.textAreaRef.current.value).toBe('project two draft');
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
    expect(hook.result.current.isPreparing).toBe(false);
  });

  it('does not submit or clean the destination URL if validation finishes after navigation', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' });
    let finishValidation: (() => void) | undefined;
    const methods = (useChatFormContext as jest.Mock).mock.results.at(-1)?.value;
    methods.handleSubmit.mockImplementation((callback) => () => {
      finishValidation = () => callback({ text: 'hi' });
    });
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    expect(finishValidation).toBeDefined();
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
    hook.updateRoute('/c/other-chat');
    hook.updateConversation({ conversationId: 'other-chat', endpoint: EModelEndpoint.openAI });
    hook.rerender();
    act(() => finishValidation?.());
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
  });

  it.each(['valid', 'invalid'])(
    'ignores superseded %s validation callbacks after a new prompt URL',
    (outcome) => {
      const hook = mountQuery({ agent_id: 'agent_test', q: 'old', submit: 'true' });
      const completions: { valid: () => void; invalid: () => void }[] = [];
      const methods = (useChatFormContext as jest.Mock).mock.results.at(-1)?.value;
      methods.handleSubmit.mockImplementation(
        (valid: (data: { text: string }) => void, invalid: () => void) => () => {
          const text = hook.textAreaRef.current.value;
          completions.push({ valid: () => valid({ text }), invalid });
        },
      );
      hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
      hook.rerender();
      expect(completions).toHaveLength(1);
      hook.updateRoute('/c/new', { q: 'new', submit: 'true' });
      hook.rerender();
      act(() => jest.advanceTimersByTime(100));
      expect(completions).toHaveLength(2);
      expect(hook.textAreaRef.current.value).toBe('new');
      act(() => completions[0][outcome]());
      expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
      expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
      expect(hook.result.current.isPreparing).toBe(true);
      act(() => completions[1].valid());
      expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
      expect(hook.mockSubmitMessage).toHaveBeenCalledWith({ text: 'new' });
      expect(hook.mockSetSearchParams).toHaveBeenCalledTimes(1);
      act(() => jest.advanceTimersByTime(4000));
      expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    },
  );

  it('handles the same prompt URL again only after a separate navigation', () => {
    const hook = mountQuery({ q: 'same', submit: 'true' });
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    hook.updateRoute('/c/new', { submit: 'true', q: 'same' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(100));
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    hook.updateRoute('/c/new');
    hook.rerender();
    hook.updateRoute('/c/new', { q: 'same', submit: 'true' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(100));
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(2);
  });

  it('retains a refused auto-submission without retrying it', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' });
    hook.mockSubmitMessage.mockReturnValue(false);
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(4000));
    hook.rerender();
    expect(hook.mockSubmitMessage).toHaveBeenCalledTimes(1);
    expect(hook.textAreaRef.current.value).toBe('hi');
    expect(hook.result.current.isPreparing).toBe(false);
  });

  it('clears the pending timer on unmount', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: 'hi', submit: 'true' });
    hook.unmount();
    act(() => jest.advanceTimersByTime(4000));
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.mockSetSearchParams).not.toHaveBeenCalled();
  });

  it('does not submit a whitespace-only prompt', () => {
    const hook = mountQuery({ agent_id: 'agent_test', q: '  ', submit: 'true' });
    hook.updateConversation({ endpoint: EModelEndpoint.agents, agent_id: 'agent_test' });
    hook.rerender();
    act(() => jest.advanceTimersByTime(4000));
    expect(hook.mockSubmitMessage).not.toHaveBeenCalled();
    expect(hook.result.current.isPreparing).toBe(false);
  });

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
    expect(mockSetValue).toHaveBeenCalledWith('text', 'hello world', { shouldValidate: true });
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

  it('should retain the prompt after timeout if settings never get applied', () => {
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

    expect(mockSubmitMessage).not.toHaveBeenCalled();
    expect(mockSetValue).toHaveBeenCalledWith('text', 'hello world', { shouldValidate: true });
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
