import { renderHook, act } from '@testing-library/react';
import useOuterScrollWindow from '../useOuterScrollWindow';

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

  /** Reports a size change for everything it watches, the way a collapsing
   *  section above the list reaches the hook. */
  trigger() {
    this.callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
  }
}

/** Frames run only when the test says so, which is how coalescing is observed:
 *  several scroll events must leave one pending frame, not one each. */
class FrameQueue {
  pending = new Map<number, FrameRequestCallback>();
  private next = 1;

  request = (callback: FrameRequestCallback): number => {
    const handle = this.next++;
    this.pending.set(handle, callback);
    return handle;
  };

  cancel = (handle: number): void => {
    this.pending.delete(handle);
  };

  flush(): number {
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    callbacks.forEach((callback) => callback(performance.now()));
    return callbacks.length;
  }
}

const setRect = (element: HTMLElement, top: number, height: number) => {
  element.getBoundingClientRect = () =>
    ({
      top,
      bottom: top + height,
      height,
      left: 0,
      right: 0,
      width: 0,
      x: 0,
      y: top,
      toJSON: () => ({}),
    }) as DOMRect;
};

const setClientHeight = (element: HTMLElement, height: number) => {
  Object.defineProperty(element, 'clientHeight', { value: height, configurable: true });
};

/**
 * A scroll viewport holding a wrapper, with the windowed node laid out below
 * some other content: the node's top sits `offset` pixels into the wrapper.
 */
function layout({ offset, viewportHeight = 500 }: { offset: number; viewportHeight?: number }) {
  const viewport = document.createElement('div');
  const content = document.createElement('div');
  const node = document.createElement('div');
  content.appendChild(node);
  viewport.appendChild(content);
  document.body.appendChild(viewport);

  setClientHeight(viewport, viewportHeight);
  setRect(viewport, 0, viewportHeight);
  setRect(content, 0, 3000);
  setRect(node, offset, 2000);

  /** Moves the viewport's scroll position, with the rects the browser would
   *  report at that offset: everything inside shifts up by the same amount. */
  const scrollTo = (scrollTop: number, nodeOffset = offset) => {
    viewport.scrollTop = scrollTop;
    setRect(node, nodeOffset - scrollTop, 2000);
  };

  return { viewport, content, node, scrollTo };
}

describe('useOuterScrollWindow', () => {
  const originalResizeObserver = window.ResizeObserver;
  const originalRaf = window.requestAnimationFrame;
  const originalCancelRaf = window.cancelAnimationFrame;
  let frames: FrameQueue;

  beforeEach(() => {
    MockResizeObserver.instances = [];
    window.ResizeObserver = MockResizeObserver as unknown as typeof ResizeObserver;
    frames = new FrameQueue();
    window.requestAnimationFrame = frames.request as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = frames.cancel as typeof window.cancelAnimationFrame;
  });

  afterEach(() => {
    window.ResizeObserver = originalResizeObserver;
    window.requestAnimationFrame = originalRaf;
    window.cancelAnimationFrame = originalCancelRaf;
    document.body.innerHTML = '';
  });

  it('reports nothing until a viewport and a node are both attached', () => {
    const { viewport } = layout({ offset: 200 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, null));

    expect(result.current).toMatchObject({ height: 0, scrollTop: 0 });
  });

  it('windows only the slice of the list the viewport shows', () => {
    const { viewport, content, node, scrollTo } = layout({ offset: 200 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    /** 200px of other content sits above it in a 500px viewport. */
    expect(result.current.height).toBe(300);
    expect(result.current.scrollTop).toBe(0);

    act(() => {
      scrollTo(120);
      viewport.dispatchEvent(new Event('scroll'));
      frames.flush();
    });

    /** Scrolled less than the content above the list: the list has not started
     *  moving through the viewport yet, it has only grown into it. */
    expect(result.current.scrollTop).toBe(0);
    expect(result.current.height).toBe(420);
  });

  it('keeps a single pixel of window while the list sits below the fold', () => {
    const { viewport, content, node } = layout({ offset: 700 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    /** Not a screenful — nothing of it is on display — but not nothing either:
     *  a list told it has no window renders no rows, and a list that renders
     *  no rows has no height to be scrolled into view with. Anything that must
     *  know whether the reader can see it asks, rather than reading a height
     *  that is deliberately never zero. */
    expect(result.current.height).toBe(1);
    expect(result.current.isOnScreen()).toBe(false);
  });

  it('reports the list as on screen as soon as it reaches the fold', () => {
    const { viewport, content, node, scrollTo } = layout({ offset: 700 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));
    expect(result.current.isOnScreen()).toBe(false);

    act(() => {
      scrollTo(260);
      viewport.dispatchEvent(new Event('scroll'));
      frames.flush();
    });

    expect(result.current.isOnScreen()).toBe(true);
    expect(result.current.height).toBe(60);
  });

  it('answers from the layout as it stands, not from the last frame', () => {
    const { viewport, content, node } = layout({ offset: 700 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));
    expect(result.current.isOnScreen()).toBe(false);

    /** A commit that swaps what the viewport holds moves the list before any
     *  observer or frame has run: a caller acting inside that commit must not
     *  be told where the list used to be. No scroll event, no frame flushed. */
    setRect(node, 100, 2000);
    expect(result.current.isOnScreen()).toBe(true);

    setRect(node, 900, 2000);
    expect(result.current.isOnScreen()).toBe(false);
  });

  it('translates the viewport scroll into the list own coordinates', () => {
    const { viewport, content, node, scrollTo } = layout({ offset: 200 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    act(() => {
      scrollTo(900);
      viewport.dispatchEvent(new Event('scroll'));
      frames.flush();
    });

    expect(result.current.scrollTop).toBe(700);
  });

  it('coalesces a burst of scroll events into one measurement', () => {
    const { viewport, content, node, scrollTo } = layout({ offset: 200 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    act(() => {
      for (const top of [300, 400, 500]) {
        scrollTo(top);
        viewport.dispatchEvent(new Event('scroll'));
      }
      expect(frames.pending.size).toBe(1);
      frames.flush();
    });

    /** The single frame reads the position the burst ended at. */
    expect(result.current.scrollTop).toBe(300);
  });

  it('re-measures when a section above the list collapses', () => {
    const { viewport, content, node, scrollTo } = layout({ offset: 400 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    act(() => {
      scrollTo(900);
      viewport.dispatchEvent(new Event('scroll'));
      frames.flush();
    });
    expect(result.current.scrollTop).toBe(500);

    /** The section above shrinks by 150px: no scroll event, no viewport or list
     *  resize — only the wrapper's height changes, and the list has moved up. */
    act(() => {
      setRect(node, 400 - 150 - 900, 2000);
      setRect(content, 0, 2850);
      MockResizeObserver.instances.forEach((observer) => observer.trigger());
      frames.flush();
    });

    expect(result.current.scrollTop).toBe(650);
  });

  it('watches the wrapper for layout changes when ResizeObserver is unavailable', () => {
    window.ResizeObserver = undefined as unknown as typeof ResizeObserver;
    const { viewport, content, node } = layout({ offset: 400 });
    const { result } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    viewport.scrollTop = 900;
    setRect(node, 400 - 900, 2000);
    act(() => {
      content.dispatchEvent(new Event('transitionend', { bubbles: true }));
      frames.flush();
    });
    expect(result.current.scrollTop).toBe(500);

    /** The collapse that shortens the wrapper reaches the hook the same way. */
    setRect(node, 400 - 150 - 900, 2000);
    act(() => {
      content.dispatchEvent(new Event('transitionend', { bubbles: true }));
      frames.flush();
    });
    expect(result.current.scrollTop).toBe(650);
  });

  it('stops listening when the consumer unmounts', () => {
    const { viewport, content, node } = layout({ offset: 200 });
    const removeListener = jest.spyOn(viewport, 'removeEventListener');
    const { result, unmount } = renderHook(() => useOuterScrollWindow(viewport, content));
    act(() => result.current.ref(node));

    unmount();

    expect(MockResizeObserver.instances.every((observer) => observer.disconnected)).toBe(true);
    expect(removeListener).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
