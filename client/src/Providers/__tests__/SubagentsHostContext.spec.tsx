import { renderHook } from '@testing-library/react';
import { appSubagentsHost } from '../SubagentsHostContext';

const mockThreadRefetch = jest.fn();
const mockPartRefetch = jest.fn();

jest.mock('~/data-provider', () => ({
  ...jest.requireActual('~/data-provider'),
  useSubagentThreadQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    isPreviousData: false,
    isReadinessPending: false,
    refetch: mockThreadRefetch,
  }),
  useToolCallPartQuery: () => ({ data: undefined, isError: false, refetch: mockPartRefetch }),
}));

describe('appSubagentsHost reads', () => {
  /** The thread panel revalidates in an effect that depends on `refetch`; a callback that
   *  changed every render would refetch on every fetch-state render instead of once. */
  it('hands back the thread query refetch itself, stable across renders', () => {
    const { result, rerender } = renderHook(() =>
      appSubagentsHost.useThread('parent', 'thread', 'task', { keepPreviousData: true }),
    );
    const first = result.current.refetch;
    rerender();
    expect(result.current.refetch).toBe(first);
    expect(first).toBe(mockThreadRefetch);
  });

  it('hands back the stored tool part refetch itself, stable across renders', () => {
    const { result, rerender } = renderHook(() =>
      appSubagentsHost.useToolCallPart(
        { conversationId: 'c', messageId: 'm', partIndex: 0 },
        { enabled: true },
      ),
    );
    const first = result.current.refetch;
    rerender();
    expect(result.current.refetch).toBe(first);
    expect(first).toBe(mockPartRefetch);
  });
});
