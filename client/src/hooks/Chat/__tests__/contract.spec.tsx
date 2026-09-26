import React from 'react';
import { RecoilRoot } from 'recoil';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TConversation, TMessage, TSubmission } from 'librechat-data-provider';
import type { MutableSnapshot } from 'recoil';
import useChatHelpers from '../useChatHelpers';
import store from '~/store';

jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: undefined }),
  useAbortStreamMutation: () => ({ mutateAsync: jest.fn() }),
  supportsGenerationProtocolV2: () => false,
}));

jest.mock('~/hooks/Messages/useLatestMessage', () => ({
  useLatestMessage: () => null,
  useLatestMessageId: () => null,
}));

let submit: ((submission: TSubmission) => void) | undefined;

jest.mock('~/hooks/Chat/useChatFunctions', () => ({
  __esModule: true,
  default: (options: { setSubmission: (submission: TSubmission) => void }) => {
    submit = options.setSubmission;
    return { ask: jest.fn(), regenerate: jest.fn() };
  },
}));

jest.mock('~/hooks/useNewConvo', () => ({
  __esModule: true,
  default: () => ({ newConversation: jest.fn() }),
}));

jest.mock('~/hooks/Chat/useSteerConvert', () => ({
  __esModule: true,
  default: () => jest.fn(),
}));

const initialResponse: TMessage = {
  messageId: 'response-1',
  conversationId: 'convo-1',
  parentMessageId: 'user-1',
  isCreatedByUser: false,
  text: '',
  content: [],
};

function renderChatHelpers(
  paramId?: string,
  initializeState?: (snapshot: MutableSnapshot) => void,
) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <RecoilRoot initializeState={initializeState}>{children}</RecoilRoot>
    </QueryClientProvider>
  );
  return renderHook((route: string | undefined = paramId) => useChatHelpers(0, route), {
    wrapper,
    initialProps: paramId,
  });
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

  it('serves the response ask submitted while the turn is in flight', () => {
    const { result } = renderChatHelpers('convo-1', ({ set }) => {
      set(store.isSubmittingFamily(0), true);
    });

    act(() => submit?.({ initialResponse } as TSubmission));

    expect(result.current.initialResponse).toBe(initialResponse);
  });

  it('drops the submitted response once the turn settles', () => {
    const { result } = renderChatHelpers('convo-1', ({ set }) => {
      set(store.isSubmittingFamily(0), true);
    });
    act(() => submit?.({ initialResponse } as TSubmission));
    expect(result.current.initialResponse).toBe(initialResponse);

    act(() => result.current.setIsSubmitting(false));

    expect(result.current.initialResponse).toBeUndefined();
  });

  it('hides the submitted response once the pane moves to another chat', () => {
    const { result, rerender } = renderChatHelpers('convo-1', ({ set }) => {
      set(store.isSubmittingFamily(0), true);
    });
    act(() => submit?.({ initialResponse } as TSubmission));
    expect(result.current.initialResponse).toBe(initialResponse);

    rerender('convo-2');

    expect(result.current.isSubmitting).toBe(true);
    expect(result.current.initialResponse).toBeUndefined();
  });

  it('has no submitted response for a run restored outside ask', () => {
    const { result } = renderChatHelpers('convo-1', ({ set }) => {
      set(store.isSubmittingFamily(0), true);
      set(store.submissionByIndex(0), { initialResponse } as TSubmission);
    });

    expect(result.current.initialResponse).toBeUndefined();
  });
});
