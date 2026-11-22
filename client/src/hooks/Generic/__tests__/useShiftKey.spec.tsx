import { act, fireEvent, renderHook } from '@testing-library/react';
import useShiftKey from '../useShiftKey';

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key, ...init });
  });

describe('useShiftKey', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('follows the shift key while it is held', () => {
    const { result } = renderHook(() => useShiftKey());
    expect(result.current).toBe(false);

    press('Shift');
    expect(result.current).toBe(true);

    act(() => {
      fireEvent.keyUp(window, { key: 'Shift' });
    });
    expect(result.current).toBe(false);
  });

  it('leaves shift with alt to the screen reader shortcuts', () => {
    const { result } = renderHook(() => useShiftKey());

    press('Shift', { altKey: true });
    expect(result.current).toBe(false);

    press('Shift');
    press('Alt', { shiftKey: true });
    expect(result.current).toBe(false);
  });

  it('reports the key as up once the window loses focus', () => {
    const { result } = renderHook(() => useShiftKey());

    press('Shift');
    act(() => {
      fireEvent.blur(window);
    });

    expect(result.current).toBe(false);
  });

  it('listens to nothing while it is not enabled', () => {
    const listen = jest.spyOn(window, 'addEventListener');
    const { result } = renderHook(() => useShiftKey(false));

    press('Shift');

    expect(result.current).toBe(false);
    expect(listen).not.toHaveBeenCalled();
  });

  it('starts listening when it is enabled and stops when it no longer is', () => {
    const listen = jest.spyOn(window, 'addEventListener');
    const forget = jest.spyOn(window, 'removeEventListener');
    const { result, rerender } = renderHook(({ enabled }) => useShiftKey(enabled), {
      initialProps: { enabled: false },
    });

    rerender({ enabled: true });
    expect(listen.mock.calls.map(([type]) => type)).toEqual(['keydown', 'keyup', 'blur']);
    press('Shift');
    expect(result.current).toBe(true);

    rerender({ enabled: false });
    expect(forget.mock.calls.map(([type]) => type)).toEqual(['keydown', 'keyup', 'blur']);
    expect(result.current).toBe(false);

    /** Released while nothing listened: enabled again, the key reads as up. */
    rerender({ enabled: true });
    expect(result.current).toBe(false);
  });
});
