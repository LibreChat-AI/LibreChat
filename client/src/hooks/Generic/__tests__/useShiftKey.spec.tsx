import { StrictMode } from 'react';
import { Provider, createStore } from 'jotai';
import { act, fireEvent, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import useShiftKey from '../useShiftKey';

const press = (key: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(window, { key, ...init });
  });

const release = () =>
  act(() => {
    fireEvent.keyUp(window, { key: 'Shift' });
  });

/** A caller that counts its renders. */
const reader = (enabled: boolean) => {
  let renders = 0;
  const view = renderHook(
    (props: { enabled: boolean }) => {
      renders += 1;
      return useShiftKey(props.enabled);
    },
    { initialProps: { enabled } },
  );
  return { ...view, renders: () => renders };
};

describe('useShiftKey', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('follows the shift key while it is held', () => {
    const { result } = renderHook(() => useShiftKey());
    expect(result.current).toBe(false);

    press('Shift');
    expect(result.current).toBe(true);

    release();
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

  it('listens once for the page, however many callers there are', () => {
    const listen = jest.spyOn(window, 'addEventListener');
    const forget = jest.spyOn(window, 'removeEventListener');

    const callers = Array.from({ length: 12 }, (_, index) => reader(index === 0));
    expect(listen.mock.calls.map(([type]) => type)).toEqual(['keydown', 'keyup', 'blur']);

    callers.slice(1).forEach((caller) => caller.unmount());
    expect(forget).not.toHaveBeenCalled();

    callers[0].unmount();
    expect(forget.mock.calls.map(([type]) => type)).toEqual(['keydown', 'keyup', 'blur']);
  });

  it('keeps tracking the key while any caller is left, enabled or not', () => {
    const forget = jest.spyOn(window, 'removeEventListener');
    /** A list with no open row: nothing reads the key, and rows come and go as it scrolls. */
    const gone = reader(false);
    const left = reader(false);

    gone.unmount();
    expect(forget).not.toHaveBeenCalled();

    press('Shift');
    left.rerender({ enabled: true });
    expect(left.result.current).toBe(true);
  });

  it('reads the key as up, and is not rendered for it, while it is not enabled', () => {
    const active = reader(true);
    const idle = reader(false);
    const before = idle.renders();

    press('Shift');

    expect(active.result.current).toBe(true);
    expect(idle.result.current).toBe(false);
    expect(idle.renders()).toBe(before);
  });

  it('reads a key already held as down the moment it is enabled', () => {
    const first = reader(true);
    const second = reader(false);
    press('Shift');

    /** The reader holds shift and opens another row: one stops answering, the other starts. */
    first.rerender({ enabled: false });
    second.rerender({ enabled: true });

    expect(first.result.current).toBe(false);
    expect(second.result.current).toBe(true);

    release();
    expect(second.result.current).toBe(false);
  });

  it('does not render its reader again for a key that repeats', () => {
    const active = reader(true);
    press('Shift');
    const before = active.renders();

    press('Shift', { repeat: true });
    press('Shift', { repeat: true });

    expect(active.renders()).toBe(before);
    expect(active.result.current).toBe(true);
  });

  it('follows the key where effects run twice', () => {
    const listen = jest.spyOn(window, 'addEventListener');
    const forget = jest.spyOn(window, 'removeEventListener');
    const { result, unmount } = renderHook(() => useShiftKey(), { wrapper: StrictMode });

    press('Shift');
    expect(result.current).toBe(true);

    unmount();
    expect(forget.mock.calls.length).toBe(listen.mock.calls.length);
  });

  it('tracks the key in the store its caller reads from', () => {
    const store = createStore();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <Provider store={store}>{children}</Provider>
    );
    const inside = renderHook(() => useShiftKey(), { wrapper });
    const outside = renderHook(() => useShiftKey());

    press('Shift');

    expect(inside.result.current).toBe(true);
    expect(outside.result.current).toBe(true);
  });

  it('forgets a key that was down when the last caller went away', () => {
    const first = renderHook(() => useShiftKey());
    press('Shift');
    first.unmount();

    /** Every value the next caller reads, its first render included. */
    const read: boolean[] = [];
    renderHook(() => {
      const isShiftHeld = useShiftKey();
      read.push(isShiftHeld);
      return isShiftHeld;
    });

    expect(read).not.toContain(true);
  });
});
