/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, renderHook } from '@testing-library/react';
import { QueuedTurnPortalProvider, useQueuedTurnPortal } from '../QueuedTurnPortal';

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <QueuedTurnPortalProvider>{children}</QueuedTurnPortalProvider>
);

describe('QueuedTurnPortal', () => {
  it('is null outside a provider', () => {
    const { result } = renderHook(() => useQueuedTurnPortal());
    expect(result.current).toBeNull();
  });

  it('keeps the same target object when an identical mount point is set again', () => {
    const { result } = renderHook(() => useQueuedTurnPortal(), { wrapper });
    const element = document.createElement('span');

    act(() => result.current?.setTarget({ conversationId: 'c1', clientRequestId: 'r1', element }));
    const first = result.current?.target;
    expect(first).toEqual({ conversationId: 'c1', clientRequestId: 'r1', element });

    act(() => result.current?.setTarget({ conversationId: 'c1', clientRequestId: 'r1', element }));
    expect(result.current?.target).toBe(first);

    act(() => result.current?.setTarget({ conversationId: 'c1', clientRequestId: 'r2', element }));
    expect(result.current?.target?.clientRequestId).toBe('r2');

    act(() => result.current?.setTarget(null));
    expect(result.current?.target).toBeNull();
  });
});
