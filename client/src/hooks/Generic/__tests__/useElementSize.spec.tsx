import { renderHook, act } from '@testing-library/react';
import useElementSize from '../useElementSize';

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];
  callback: ResizeObserverCallback;
  observed: Element[] = [];
  disconnected = false;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  observe(element: Element) {
    this.observed.push(element);
  }

  unobserve() {}

  disconnect() {
    this.disconnected = true;
  }

  trigger(contentRect: { width: number; height: number }) {
    this.callback(
      [{ contentRect, target: this.observed[0] } as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
}

describe('useElementSize', () => {
  const originalResizeObserver = window.ResizeObserver;

  beforeEach(() => {
    MockResizeObserver.instances = [];
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
  });

  afterAll(() => {
    window.ResizeObserver = originalResizeObserver;
  });

  it('reports zero size before an element is attached', () => {
    const { result } = renderHook(() => useElementSize<HTMLDivElement>());
    expect(result.current.width).toBe(0);
    expect(result.current.height).toBe(0);
  });

  it('observes the attached element and reports floored content-box size', () => {
    const { result } = renderHook(() => useElementSize<HTMLDivElement>());
    const node = document.createElement('div');

    act(() => result.current.ref(node));

    const observer = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
    expect(observer.observed).toContain(node);

    act(() => observer.trigger({ width: 320.6, height: 480.2 }));
    expect(result.current.width).toBe(320);
    expect(result.current.height).toBe(480);

    act(() => observer.trigger({ width: 360, height: 480 }));
    expect(result.current.width).toBe(360);
  });

  it('re-observes when the element remounts', () => {
    const { result } = renderHook(() => useElementSize<HTMLDivElement>());
    const first = document.createElement('div');
    const second = document.createElement('div');

    act(() => result.current.ref(first));
    const firstObserver = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];

    act(() => result.current.ref(null));
    expect(firstObserver.disconnected).toBe(true);

    act(() => result.current.ref(second));
    const secondObserver = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
    expect(secondObserver).not.toBe(firstObserver);
    expect(secondObserver.observed).toContain(second);
  });

  it('disconnects the observer on unmount', () => {
    const { result, unmount } = renderHook(() => useElementSize<HTMLDivElement>());
    const node = document.createElement('div');

    act(() => result.current.ref(node));
    const observer = MockResizeObserver.instances[MockResizeObserver.instances.length - 1];

    unmount();
    expect(observer.disconnected).toBe(true);
  });

  it('falls back to offset measurements when ResizeObserver is unavailable', () => {
    window.ResizeObserver = undefined as unknown as typeof ResizeObserver;

    const { result } = renderHook(() => useElementSize<HTMLDivElement>());
    const node = document.createElement('div');
    let offsetWidth = 280;
    Object.defineProperty(node, 'offsetWidth', { get: () => offsetWidth, configurable: true });
    Object.defineProperty(node, 'offsetHeight', { value: 500 });

    act(() => result.current.ref(node));
    expect(result.current.width).toBe(280);
    expect(result.current.height).toBe(500);

    offsetWidth = 320;
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.width).toBe(320);
  });
});
