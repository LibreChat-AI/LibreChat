/**
 * @jest-environment jsdom
 */
import React from 'react';
import { renderHook } from '@testing-library/react';
import { MessageContext, MessagePartIndex, useMessageContext } from '../message';

const surrounding: MessageContext = {
  messageId: 'message-1',
  conversationId: 'convo-1',
  isExpanded: true,
  isSubmitting: false,
  isLatestMessage: true,
  partIndex: 0,
};

describe('MessagePartIndex', () => {
  it('provides the surrounding message at the part position', () => {
    const { result } = renderHook(() => useMessageContext(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MessageContext.Provider value={surrounding}>
          <MessagePartIndex index={3}>{children}</MessagePartIndex>
        </MessageContext.Provider>
      ),
    });
    expect(result.current).toEqual({ ...surrounding, partIndex: 3 });
  });

  it('sets only the position outside a message', () => {
    const { result } = renderHook(() => useMessageContext(), {
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <MessagePartIndex index={1}>{children}</MessagePartIndex>
      ),
    });
    expect(result.current).toEqual({ partIndex: 1 });
  });
});
