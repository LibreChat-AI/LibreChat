/** @jest-environment jsdom */
import { renderHook } from '@testing-library/react';
import { sameItems } from '../../core/same';
import { useShared } from '../shared';

describe('useShared', () => {
  it('keeps the earlier value while the next one is the same, and takes one that differs', () => {
    const first = [1, 2];
    const { result, rerender } = renderHook(({ value }) => useShared(value, sameItems), {
      initialProps: { value: first },
    });
    expect(result.current).toBe(first);

    rerender({ value: [1, 2] });
    expect(result.current).toBe(first);

    const changed = [1, 3];
    rerender({ value: changed });
    expect(result.current).toBe(changed);

    rerender({ value: [1, 3] });
    expect(result.current).toBe(changed);
  });

  it('does not compare a value with itself', () => {
    const same = jest.fn(() => false);
    const value = { id: 1 };
    const { result, rerender } = renderHook(() => useShared(value, same));
    rerender();
    expect(result.current).toBe(value);
    expect(same).not.toHaveBeenCalled();
  });
});
