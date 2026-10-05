import React, { useCallback, useState } from 'react';
import { createStore, Provider } from 'jotai';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { MediaAsset } from 'librechat-data-provider';
import { mediaChatHandoff } from '~/components/Media/handoff';
import { useMediaChatHandoff } from '../Media/handoff';

const handoff = {
  scope: 'owner',
  conversationId: 'new',
  asset: {
    file_id: 'original',
    filepath: '/images/owner/original.png',
    filename: 'original.png',
    type: 'image/png',
    bytes: 12,
  },
};
function setup() {
  const store = createStore();
  store.set(mediaChatHandoff, handoff);
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={store}>{children}</Provider>
  );
  return { store, wrapper };
}

test('claims the handoff once when attaching synchronously rerenders the composer', async () => {
  const env = setup();
  const attached = jest.fn();
  const onError = jest.fn();
  const isCurrentSession = () => true;
  const { result } = renderHook(
    () => {
      const [files, setFiles] = useState<string[]>([]);
      const attach = useCallback(async () => {
        attached();
        setFiles([...files, 'original']);
        await Promise.resolve();
      }, [files]);
      useMediaChatHandoff({
        scope: 'owner',
        conversationId: 'new',
        ready: true,
        isCurrentSession,
        attach,
        onError,
      });
      return files;
    },
    { wrapper: env.wrapper },
  );
  await waitFor(() => expect(env.store.get(mediaChatHandoff)).toBeNull());
  expect(result.current).toEqual(['original']);
  expect(attached).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});

test('never clears another session or a newer handoff after asynchronous completion', async () => {
  const env = setup();
  let finish = () => {};
  let currentSession = true;
  const attach = jest.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  renderHook(
    () =>
      useMediaChatHandoff({
        scope: 'owner',
        conversationId: 'new',
        ready: true,
        isCurrentSession: () => currentSession,
        attach,
        onError: () => {},
      }),
    { wrapper: env.wrapper },
  );
  const next = { ...handoff, scope: 'another-owner' };
  act(() => {
    currentSession = false;
    env.store.set(mediaChatHandoff, next);
  });
  await act(async () => {
    finish();
  });
  expect(env.store.get(mediaChatHandoff)).toBe(next);
  expect(attach).toHaveBeenCalledTimes(1);
});

test('keeps an unsupported handoff and retries only after the destination attachment policy changes', async () => {
  const env = setup();
  const onError = jest.fn();
  const unsupported = jest.fn(async (): Promise<void> => {
    throw new Error('Unsupported input');
  });
  const supported = jest.fn(async () => {});
  const isCurrentSession = () => true;
  const { rerender } = renderHook(
    ({ attach }: { attach: (asset: MediaAsset) => Promise<void> }) =>
      useMediaChatHandoff({
        scope: 'owner',
        conversationId: 'new',
        ready: true,
        isCurrentSession,
        attach,
        onError,
      }),
    { wrapper: env.wrapper, initialProps: { attach: unsupported } },
  );
  await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
  rerender({ attach: unsupported });
  expect(unsupported).toHaveBeenCalledTimes(1);
  expect(env.store.get(mediaChatHandoff)).toBe(handoff);
  rerender({ attach: supported });
  await waitFor(() => expect(env.store.get(mediaChatHandoff)).toBeNull());
  expect(supported).toHaveBeenCalledTimes(1);
});
