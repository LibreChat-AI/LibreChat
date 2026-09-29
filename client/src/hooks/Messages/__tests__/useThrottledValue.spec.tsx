import React from 'react';
import { act, renderHook } from '@testing-library/react';
import useThrottledValue from '../useThrottledValue';

describe('useThrottledValue', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(0);
  });
  afterEach(() => jest.useRealTimers());

  it('keeps trailing updates alive after Strict Mode effect cleanup', () => {
    const { result, rerender } = renderHook(({ value }) => useThrottledValue(value, 500), {
      initialProps: { value: 'first' },
      wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode>,
    });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ value: 'latest' });
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(result.current).toBe('latest');
  });

  it('cancels a queued frame when switching to pass-through and starts a fresh window', () => {
    jest.setSystemTime(1000);
    const { result, rerender, unmount } = renderHook(
      ({ value, interval }) => useThrottledValue(value, interval),
      { initialProps: { value: 'first', interval: 500 } },
    );
    rerender({ value: 'queued', interval: 500 });
    act(() => jest.advanceTimersByTime(100));
    rerender({ value: 'short', interval: 0 });
    expect(result.current).toBe('short');
    expect(jest.getTimerCount()).toBe(0);

    rerender({ value: 'fills the row', interval: 0 });
    rerender({ value: 'fills the row', interval: 500 });
    rerender({ value: 'next full line', interval: 500 });
    act(() => jest.advanceTimersByTime(400));
    expect(result.current).toBe('fills the row');
    act(() => jest.advanceTimersByTime(100));
    expect(result.current).toBe('next full line');
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('paints the leading change and the latest trailing value, then releases its timer', () => {
    jest.setSystemTime(1000);
    const { result, rerender, unmount } = renderHook(({ value }) => useThrottledValue(value, 500), {
      initialProps: { value: 'first' },
    });
    act(() => {
      jest.advanceTimersByTime(500);
    });
    rerender({ value: 'leading' });
    expect(result.current).toBe('leading');
    rerender({ value: 'middle' });
    act(() => {
      jest.advanceTimersByTime(100);
    });
    rerender({ value: 'trailing' });
    expect(result.current).toBe('leading');
    act(() => {
      jest.advanceTimersByTime(400);
    });
    expect(result.current).toBe('trailing');
    rerender({ value: 'pending' });
    unmount();
    expect(jest.getTimerCount()).toBe(0);
  });
});
