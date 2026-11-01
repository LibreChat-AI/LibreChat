import React from 'react';
import { Provider, createStore } from 'jotai';
import { renderHook } from '@testing-library/react';
import { resolveThreadRows } from '@librechat/chat';
import type { TMessage } from 'librechat-data-provider';
import useThreadRows from '../useThreadRows';

/** The thread helpers are package exports, which cannot be spied on in place; wrap the real
 *  resolver so calls are recorded and rows still resolve. */
jest.mock('@librechat/chat', () => {
  const actual = jest.requireActual('@librechat/chat');
  return { ...actual, resolveThreadRows: jest.fn(actual.resolveThreadRows) };
});

function history(conversationId: string, count: number): TMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    messageId: `${conversationId}-${index}`,
    parentMessageId: index === 0 ? null : `${conversationId}-${index - 1}`,
    conversationId,
    text: `${index}`,
  })) as TMessage[];
}

function setup(messages: TMessage[] | null, conversationId: string) {
  const store = createStore();
  return renderHook(
    (props: { messages: TMessage[] | null; conversationId: string }) =>
      useThreadRows(props.messages, props.conversationId),
    {
      initialProps: { messages, conversationId },
      wrapper: ({ children }: { children: React.ReactNode }) => (
        <Provider store={store}>{children}</Provider>
      ),
    },
  );
}

describe('useThreadRows ownership', () => {
  it('does not index the departing large thread for row reuse in another conversation', () => {
    const resolve = jest.mocked(resolveThreadRows);
    resolve.mockClear();
    const large = history('large', 12_000);
    const small = history('small', 2);
    const { result, rerender } = setup(large, 'large');
    expect(result.current).toHaveLength(12_000);

    rerender({ messages: small, conversationId: 'small' });

    expect(result.current).toHaveLength(2);
    expect(resolve.mock.calls[resolve.mock.calls.length - 1][3]).toBeNull();
    expect(result.current?.[0].source).toBe(small[0]);
  });

  it('preserves row identity for unchanged messages within the same conversation', () => {
    const messages = history('same', 3);
    const { result, rerender } = setup(messages, 'same');
    const first = result.current?.[0];
    const tail = result.current?.[2];

    rerender({
      messages: [messages[0], messages[1], { ...messages[2], text: 'updated' }],
      conversationId: 'same',
    });

    expect(result.current?.[0]).toBe(first);
    expect(result.current?.[2]).not.toBe(tail);
  });

  it('releases the previous rows when the transcript is absent', () => {
    const resolve = jest.mocked(resolveThreadRows);
    resolve.mockClear();
    const messages = history('same', 3);
    const { result, rerender } = setup(messages, 'same');

    rerender({ messages: null, conversationId: 'same' });
    expect(result.current).toBeNull();
    rerender({ messages, conversationId: 'same' });

    expect(resolve.mock.calls[resolve.mock.calls.length - 1][3]).toBeNull();
  });
});
