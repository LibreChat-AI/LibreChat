import React from 'react';
import { RecoilRoot } from 'recoil';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { TMessage, TConversation } from 'librechat-data-provider';
import StreamAudio from '../StreamAudio';
import store from '~/store';

jest.mock('~/hooks', () => ({ useAuthContext: () => ({ token: 'token' }) }));

const conversationId = 'convo-1';

const match = jest.fn(async (_key: string) => ({ blob: async () => new Blob() }));

describe('StreamAudio cache', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'caches', {
      writable: true,
      configurable: true,
      value: { open: async () => ({ match, put: jest.fn() }) },
    });
    URL.createObjectURL = jest.fn(() => 'blob:audio');
    URL.revokeObjectURL = jest.fn();
  });

  /** Audio cached before reasoning was filtered is keyed by the full text; looking up the
   *  spoken answer instead means that recording is never replayed. */
  it('looks up cached audio by the spoken answer, not the stored text', async () => {
    const message = {
      messageId: 'assistant-1',
      conversationId,
      parentMessageId: Constants.NO_PARENT,
      isCreatedByUser: false,
      text: ':::thinking\nRecalling European capitals.\n:::\nThe capital of Germany is Berlin.',
    } as TMessage;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    queryClient.setQueryData([QueryKeys.messages, conversationId], [message]);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/c/${conversationId}`]}>
          <RecoilRoot
            initializeState={({ set }) => {
              set(store.automaticPlayback, true);
              set(store.conversationByIndex(0), { conversationId } as TConversation);
              set(store.activeRunFamily(0), 'run-1');
              set(store.audioRunFamily(0), null);
              set(store.isSubmittingFamily(0), false);
            }}
          >
            <Routes>
              <Route path="/c/:conversationId" element={<StreamAudio index={0} />} />
            </Routes>
          </RecoilRoot>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(match).toHaveBeenCalled());
    expect(match).toHaveBeenCalledWith('The capital of Germany is Berlin.');
  });
});
