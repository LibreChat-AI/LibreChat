import React from 'react';
import { Provider, createStore } from 'jotai';
import { renderHook } from '@testing-library/react';
import { composerOverlayCountFamily, useComposerOverlay } from '../overlay';

const CONVO_ID = 'convo-1';

describe('useComposerOverlay', () => {
  let jotaiStore = createStore();
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <Provider store={jotaiStore}>{children}</Provider>
  );
  const count = (conversationId = CONVO_ID) =>
    jotaiStore.get(composerOverlayCountFamily(conversationId));

  beforeEach(() => {
    jotaiStore = createStore();
  });

  it('counts the panel only while it is open', () => {
    const { rerender, unmount } = renderHook(
      ({ open }: { open: boolean }) => useComposerOverlay(CONVO_ID, open),
      { wrapper, initialProps: { open: false } },
    );
    expect(count()).toBe(0);

    rerender({ open: true });
    expect(count()).toBe(1);

    rerender({ open: false });
    expect(count()).toBe(0);

    rerender({ open: true });
    unmount();
    expect(count()).toBe(0);
  });

  it('adds up across panels so the last to close releases the band', () => {
    const first = renderHook(() => useComposerOverlay(CONVO_ID, true), { wrapper });
    const second = renderHook(() => useComposerOverlay(CONVO_ID, true), { wrapper });
    expect(count()).toBe(2);

    first.unmount();
    expect(count()).toBe(1);

    second.unmount();
    expect(count()).toBe(0);
  });

  it('follows the panel to another conversation', () => {
    const { rerender } = renderHook(
      ({ conversationId }: { conversationId: string }) => useComposerOverlay(conversationId, true),
      { wrapper, initialProps: { conversationId: CONVO_ID } },
    );
    expect(count()).toBe(1);

    rerender({ conversationId: 'convo-2' });
    expect(count()).toBe(0);
    expect(count('convo-2')).toBe(1);
  });
});
