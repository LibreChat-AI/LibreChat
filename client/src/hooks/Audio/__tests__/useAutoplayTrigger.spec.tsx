import React from 'react';
import { RecoilRoot } from 'recoil';
import { getDefaultStore } from 'jotai';
import { renderHook } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isSubmittingFamily, resetSubmitting } from '@librechat/chat/react';
import { Constants, QueryKeys, ContentTypes } from 'librechat-data-provider';
import type { TMessage, TConversation } from 'librechat-data-provider';
import useAutoplayTrigger from '../useAutoplayTrigger';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import store from '~/store';

const conversationId = 'convo-1';

const assistantMessage = {
  messageId: 'assistant-1',
  conversationId,
  parentMessageId: Constants.NO_PARENT,
  isCreatedByUser: false,
  text: 'The capital of Germany is Berlin.',
} as TMessage;

const renderTrigger = (message: TMessage) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData([QueryKeys.messages, conversationId], [message]);

  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
        <RecoilRoot
          initializeState={({ set }) => {
            set(store.conversationByIndex(0), { conversationId } as TConversation);
            getDefaultStore().set(activeRunFamily(0), 'run-1');
            set(store.audioRunFamily(0), null);
            getDefaultStore().set(isSubmittingFamily(0), false);
          }}
        >
          <Routes>
            <Route path="/c/:conversationId" element={<>{children}</>} />
          </Routes>
        </RecoilRoot>
      </MemoryRouter>
    </QueryClientProvider>
  );

  return renderHook(() => useAutoplayTrigger(0), { wrapper }).result;
};

afterEach(() => {
  resetSubmitting(getDefaultStore());
});

describe('useAutoplayTrigger', () => {
  it('plays a finalized answer', () => {
    expect(renderTrigger(assistantMessage).current.shouldPlay).toBe(true);
  });

  /** A turn stopped mid-reasoning persists its reasoning as `text` beside the parts; playing
   *  it would open a server stream with nothing to speak. */
  it('does not play a stopped turn that only reasoned', () => {
    const result = renderTrigger({
      ...assistantMessage,
      text: 'Recalling European capitals.',
      content: [{ type: ContentTypes.THINK, think: 'Recalling European capitals.' }],
    });

    expect(result.current.shouldPlay).toBe(false);
  });
});
