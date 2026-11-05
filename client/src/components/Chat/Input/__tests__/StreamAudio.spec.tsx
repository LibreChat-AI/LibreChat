import React from 'react';
import { TextEncoder } from 'util';
import { webcrypto } from 'crypto';
import { RecoilRoot } from 'recoil';
import { getDefaultStore } from 'jotai';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { Constants, QueryKeys } from 'librechat-data-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isSubmittingFamily, resetSubmitting } from '@librechat/chat/react';
import type { TMessage, TConversation } from 'librechat-data-provider';
import { getTTSCacheKey, setCachedTTSAudio, getTTSCacheGeneration } from '~/utils';
import { activeRunFamily } from '~/hooks/SSE/atoms';
import StreamAudio from '../StreamAudio';
import store from '~/store';

jest.mock('~/hooks', () => ({ useAuthContext: () => ({ token: 'token' }) }));

const conversationId = 'convo-1';

const recording = new Blob(['spoken answer'], { type: 'audio/mpeg' });
const fetchMock = jest.fn(() => Promise.reject(new Error('not cached')));

afterEach(() => {
  resetSubmitting(getDefaultStore());
});

describe('StreamAudio cache', () => {
  beforeAll(() => {
    Object.defineProperty(global, 'crypto', { value: webcrypto, configurable: true });
    Object.assign(global, { TextEncoder });
    Object.assign(global, { fetch: fetchMock });
    URL.createObjectURL = jest.fn(() => 'blob:audio');
    URL.revokeObjectURL = jest.fn();
  });

  /** Audio cached before reasoning was filtered is keyed by the full text; looking up the
   *  spoken answer instead means that recording is never replayed. */
  it('looks up cached audio by the spoken answer, not the stored text', async () => {
    const key = await getTTSCacheKey('The capital of Germany is Berlin.');
    setCachedTTSAudio(key as string, recording, getTTSCacheGeneration());
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
              getDefaultStore().set(activeRunFamily(0), 'run-1');
              set(store.audioRunFamily(0), null);
              getDefaultStore().set(isSubmittingFamily(0), false);
            }}
          >
            <Routes>
              <Route path="/c/:conversationId" element={<StreamAudio index={0} />} />
            </Routes>
          </RecoilRoot>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(URL.createObjectURL).toHaveBeenCalledWith(recording));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
