/**
 * @jest-environment jsdom
 */
import { act, render, renderHook, screen } from '@testing-library/react';
import { Provider, createStore, useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { TSubmission } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import {
  clearSubmissions,
  submissionByIndex,
  isSubmittingFamily,
  anySubmittingAtom,
  useClearSubmissions,
} from '../submission';

function Indicator({ index }: { index: number }) {
  const isSubmitting = useAtomValue(isSubmittingFamily(index));
  return <p>{isSubmitting ? 'streaming' : 'idle'}</p>;
}

describe('isSubmittingFamily', () => {
  it('shows a component and a hook in the same store the same value', () => {
    render(<Indicator index={10} />);
    const { result } = renderHook(() => useAtom(isSubmittingFamily(10)));
    expect(screen.getByText('idle')).toBeInTheDocument();

    act(() => result.current[1](true));

    expect(result.current[0]).toBe(true);
    expect(screen.getByText('streaming')).toBeInTheDocument();

    act(() => result.current[1](false));
    expect(screen.getByText('idle')).toBeInTheDocument();
  });

  it('accepts an updater function', () => {
    const { result } = renderHook(() => useAtom(isSubmittingFamily(11)));
    act(() => result.current[1]((previous) => !previous));
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
  });

  it('keeps panes independent', () => {
    const { result } = renderHook(() => ({
      main: useAtom(isSubmittingFamily(12)),
      added: useAtom(isSubmittingFamily(13)),
    }));
    act(() => result.current.added[1](true));
    expect(result.current.added[0]).toBe(true);
    expect(result.current.main[0]).toBe(false);
    act(() => result.current.added[1](false));
  });
});

describe('anySubmittingAtom', () => {
  it('is true while any pane generates, including one first used after the first read', () => {
    const { result } = renderHook(() => ({
      any: useAtomValue(anySubmittingAtom),
      first: useAtom(isSubmittingFamily(20)),
      second: useAtom(isSubmittingFamily(21)),
    }));
    expect(result.current.any).toBe(false);

    act(() => result.current.second[1](true));
    expect(result.current.any).toBe(true);

    act(() => result.current.first[1](true));
    act(() => result.current.second[1](false));
    expect(result.current.any).toBe(true);

    act(() => result.current.first[1](false));
    expect(result.current.any).toBe(false);
  });
});

describe('submissionByIndex', () => {
  const run = (id: string) => ({ userMessage: { messageId: id } }) as unknown as TSubmission;

  it('shows a component and a hook in the same store the same submission', () => {
    function Probe() {
      const submission = useAtomValue(submissionByIndex(30));
      return <p>{submission?.userMessage.messageId ?? 'none'}</p>;
    }
    render(<Probe />);
    const { result } = renderHook(() => useSetAtom(submissionByIndex(30)));
    act(() => result.current(run('m1')));
    expect(screen.getByText('m1')).toBeInTheDocument();
    act(() => result.current(null));
    expect(screen.getByText('none')).toBeInTheDocument();
  });

  it('clears every pane, or every pane but the first when asked', () => {
    const store = createStore();
    store.set(submissionByIndex(0), run('main'));
    store.set(submissionByIndex(1), run('added'));

    clearSubmissions(store, true);
    expect(store.get(submissionByIndex(0))).not.toBeNull();
    expect(store.get(submissionByIndex(1))).toBeNull();

    clearSubmissions(store);
    expect(store.get(submissionByIndex(0))).toBeNull();
  });

  it('clears through the store the caller renders in', () => {
    const store = createStore();
    store.set(submissionByIndex(2), run('x'));
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const { result } = renderHook(() => useClearSubmissions(), { wrapper });
    act(() => result.current());
    expect(store.get(submissionByIndex(2))).toBeNull();
  });
});
