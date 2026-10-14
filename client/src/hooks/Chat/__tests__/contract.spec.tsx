import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import { RetentionMode } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TModelSpec } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import type { ChatSettings } from '../contract';
import { ChatSettingsContext, defaultChatSettings } from '~/Providers/ChatSettingsContext';
import useTemporaryChat from '../useTemporaryChat';
import useChatHelpers from '../useChatHelpers';
import useTokenLimits from '../useTokenLimits';
import store from '~/store';

/** No `useGetStartupConfig`: a hook that still read the deployment config directly would throw. */
jest.mock('~/data-provider', () => ({
  useTokenConfigQuery: () => ({ data: undefined }),
  useGetAgentByIdQuery: () => ({ data: undefined }),
  useAbortStreamMutation: () => ({ mutateAsync: jest.fn() }),
  supportsGenerationProtocolV2: () => false,
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => null,
  useLatestMessageId: () => null,
}));

jest.mock('~/hooks/Chat/useChatFunctions', () => ({
  __esModule: true,
  default: () => ({ ask: jest.fn(), regenerate: jest.fn() }),
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/hooks/Chat/useSteerConvert', () => ({
  __esModule: true,
  default: () => jest.fn(),
}));

function createWrapper(
  initializeState?: (snapshot: MutableSnapshot) => void,
  settings: ChatSettings = defaultChatSettings,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot initializeState={initializeState}>
          <ChatSettingsContext.Provider value={settings}>{children}</ChatSettingsContext.Provider>
        </RecoilRoot>
      </QueryClientProvider>
    );
  };
}

function renderChatHelpers(
  paramId?: string,
  initializeState?: (snapshot: MutableSnapshot) => void,
) {
  return renderHook(() => useChatHelpers(0, paramId), { wrapper: createWrapper(initializeState) });
}

describe('useChatHelpers contract members', () => {
  it('reports the route id as the messages key before the conversation catches up', () => {
    const { result } = renderChatHelpers('convo-2', ({ set }) => {
      set(store.conversationByIndex(0), { conversationId: 'convo-1' } as TConversation);
    });

    expect(result.current.conversation?.conversationId).toBe('convo-1');
    expect(result.current.messagesKey).toBe('convo-2');
  });

  it('reports an empty messages key before the pane has a conversation', () => {
    expect(renderChatHelpers().result.current.messagesKey).toBe('');
  });

  it('falls back to the conversation id without a route id', () => {
    const { result } = renderChatHelpers(undefined, ({ set }) => {
      set(store.conversationByIndex(0), { conversationId: 'convo-1' } as TConversation);
    });

    expect(result.current.messagesKey).toBe('convo-1');
  });
});

describe('substitute host config', () => {
  const modelSpecs = [
    { name: 'long', label: 'Long', preset: { endpoint: 'openAI', maxContextTokens: 4_096 } },
  ] as TModelSpec[];
  const hostSettings: ChatSettings = {
    ...defaultChatSettings,
    config: {
      feedbackEnabled: true,
      canRenameRunningChat: true,
      retentionMode: RetentionMode.EPHEMERAL,
      modelSpecs,
    },
  };
  const wrapper = createWrapper(undefined, hostSettings);

  it('reaches the chat helpers', () => {
    const { result } = renderHook(() => useChatHelpers(0), { wrapper });

    expect(result.current.feedbackEnabled).toBe(true);
  });

  it('reaches temporary chat', () => {
    const { result } = renderHook(() => useTemporaryChat(), { wrapper });

    expect(result.current.isEnforced).toBe(true);
  });

  it('reaches the token limits', () => {
    const conversation = { endpoint: 'openAI', spec: 'long' } as TConversation;
    const { result } = renderHook(() => useTokenLimits(conversation), { wrapper });

    expect(result.current.maxContextTokens).toBe(4_096);
  });

  it('leaves them on their defaults without a host', () => {
    const conversation = { endpoint: 'openAI', spec: 'long' } as TConversation;
    const { result } = renderHook(
      () => ({
        helpers: useChatHelpers(0),
        temporary: useTemporaryChat(),
        limits: useTokenLimits(conversation),
      }),
      { wrapper: createWrapper() },
    );

    expect(result.current.helpers.feedbackEnabled).toBe(false);
    expect(result.current.temporary.isEnforced).toBe(false);
    expect(result.current.limits.maxContextTokens).toBeUndefined();
  });
});
