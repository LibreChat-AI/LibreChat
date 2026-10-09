import { renderHook, act } from '@testing-library/react';
import useDebouncedInput from '../useDebouncedInput';

describe('useDebouncedInput', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  /** Callers do not memoize either callback: setOption is a plain arrow in
   *  useSetIndexOptions and the dynamic settings pass `setter` inline. If the
   *  debouncer depended on them it would be rebuilt every render, so the flush
   *  would reach an instance holding nothing while the previous instance's
   *  timer still fired the superseded value. */
  it('flushes the pending edit even though the callbacks change identity', () => {
    const committed: unknown[] = [];
    const render = () =>
      renderHook(
        ({ tick }: { tick: number }) =>
          useDebouncedInput<string>({
            optionKey: 'promptPrefix',
            initialValue: '',
            /** A new function every render, as the real call sites pass. */
            setOption: () => (value: unknown) => committed.push([tick, value]),
            setter: () => ({}) as never,
          }),
        { initialProps: { tick: 0 } },
      );

    const { result, rerender } = render();

    act(() => {
      result.current[0]('edited', false);
    });
    rerender({ tick: 1 });
    expect(committed).toHaveLength(0);

    act(() => {
      result.current[3]();
    });

    expect(committed).toHaveLength(1);
    expect((committed[0] as unknown[])[1]).toBe('edited');
  });

  it('does not commit before the delay elapses', () => {
    const committed: unknown[] = [];
    const { result } = renderHook(() =>
      useDebouncedInput<string>({
        optionKey: 'promptPrefix',
        initialValue: '',
        setOption: () => (value: unknown) => committed.push(value),
        setter: () => ({}) as never,
      }),
    );

    act(() => {
      result.current[0]('typed', false);
    });
    expect(committed).toHaveLength(0);

    act(() => {
      jest.advanceTimersByTime(1000);
    });
    expect(committed).toEqual(['typed']);
  });
});
