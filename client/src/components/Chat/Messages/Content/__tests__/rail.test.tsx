import React from 'react';
import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import {
  FoldRail,
  RailGlyph,
  useFoldPath,
  litFoldPath,
  useRailHover,
  revealFoldHeader,
} from '../rail';

function box(top: number, height = 28) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ top, height }) as DOMRect;
  el.scrollIntoView = jest.fn();
  return el;
}

describe('revealFoldHeader', () => {
  it('scrolls the card to its start when the header is pinned below the card top', () => {
    const root = box(-400);
    const header = box(0);
    revealFoldHeader(root, header);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    expect(header.scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings an unpinned header just into view', () => {
    const root = box(-400);
    const header = box(-400);
    revealFoldHeader(root, header);
    expect(header.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(root.scrollIntoView).not.toHaveBeenCalled();
  });

  it('reserves the sticky phase header height and restores the previous margin', () => {
    const root = box(-400);
    const header = box(-400);
    const phaseHeader = box(0, 36);
    header.style.scrollMarginTop = '8px';
    header.scrollIntoView = jest.fn(() => {
      expect(header.style.scrollMarginTop).toBe('36px');
    });
    revealFoldHeader(root, header, phaseHeader);
    expect(header.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(header.style.scrollMarginTop).toBe('8px');
  });

  it.each([false, true])('reserves the host toolbar for a pinned=%s header', (pinned) => {
    const message = box(0);
    message.className = 'message-render';
    message.style.scrollMarginTop = '64px';
    const root = box(-400);
    const header = box(pinned ? 0 : -400);
    message.append(root);
    root.append(header);
    const target = pinned ? root : header;
    const phaseHeader = pinned ? null : box(0, 36);
    target.scrollIntoView = jest.fn(() => {
      expect(target.style.scrollMarginTop).toBe(pinned ? '64px' : '100px');
    });
    revealFoldHeader(root, header, phaseHeader);
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: pinned ? 'start' : 'nearest',
      behavior: 'instant',
    });
    expect(target.style.scrollMarginTop).toBe('');
  });

  it('does nothing after the fold has unmounted', () => {
    expect(() => revealFoldHeader(null, null)).not.toThrow();
  });
});

describe('FoldRail', () => {
  it('drops the knob when it unmounts under the pointer', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const { unmount } = render(<FoldRail hover={hover} expanded onCollapse={jest.fn()} />);
    render(
      <RailGlyph hover={hover}>
        <span data-testid="glyph" />
      </RailGlyph>,
    );
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('fold-rail-knob')).toBeInTheDocument();
    expect(screen.getByTestId('glyph').parentElement).toHaveClass('invisible');
    unmount();
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    expect(screen.getByTestId('glyph').parentElement).not.toHaveClass('invisible');
  });

  it('keeps the same glyph mounted in layout across hover transitions', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const mounted = jest.fn();
    const unmounted = jest.fn();
    function Glyph() {
      React.useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <span data-testid="glyph" />;
    }
    render(
      <>
        <FoldRail hover={hover} expanded onCollapse={jest.fn()} />
        <RailGlyph hover={hover}>
          <Glyph />
        </RailGlyph>
      </>,
    );
    const glyph = screen.getByTestId('glyph');
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('glyph')).toBe(glyph);
    fireEvent.mouseLeave(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('glyph')).toBe(glyph);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('clears hover and disables the rail when a retained body collapses', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const collapse = jest.fn();
    const { rerender } = render(<FoldRail hover={hover} expanded onCollapse={collapse} />);
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(hover.get()).toBe(true);
    rerender(<FoldRail hover={hover} expanded={false} onCollapse={collapse} />);
    expect(hover.get()).toBe(false);
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    fireEvent.click(screen.getByTestId('fold-rail'));
    expect(hover.get()).toBe(false);
    expect(collapse).not.toHaveBeenCalled();
    expect(screen.getByTestId('fold-rail')).toBeDisabled();
  });
});

/**
 * Two folds, one inside the other, laid out on a 32px row pitch:
 *
 *   phase header        glyph  10
 *   panel A             top    40
 *     row               glyph  50
 *     group header      glyph  82
 *     panel B           top   104
 *       row             glyph 114
 *       row             glyph 146
 *       row             glyph 178
 *     row               glyph 220
 */
function foldFixture() {
  const at = <T extends HTMLElement>(el: T, top: number, height = 20): T => {
    el.getBoundingClientRect = () => ({ top, height, bottom: top + height }) as DOMRect;
    return el;
  };
  const glyph = (top: number) => {
    const el = at(document.createElement('span'), top);
    el.className = 'fold-glyph';
    return el;
  };
  const panel = (top: number) => {
    const el = at(document.createElement('div'), top, 0);
    el.setAttribute('data-fold-panel', '');
    const rail = at(document.createElement('button'), top, 0);
    rail.setAttribute('data-fold-rail', '');
    el.append(rail);
    return { el, rail };
  };
  const root = document.createElement('div');
  root.setAttribute('data-fold-root', '');
  const outerHeader = glyph(10);
  const a = panel(40);
  const b = panel(104);
  const rows = {
    a1: glyph(50),
    header: glyph(82),
    b1: glyph(114),
    b2: glyph(146),
    b3: glyph(178),
    a2: glyph(220),
  };
  const group = document.createElement('div');
  group.append(rows.header, b.el);
  b.el.append(rows.b1, rows.b2, rows.b3);
  a.el.append(rows.a1, group, rows.a2);
  root.append(outerHeader, a.el);
  document.body.append(root);
  return { root, outerHeader, a, b, rows };
}

describe('litFoldPath', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('lights every fold that holds the row, innermost first, down to its center', () => {
    const { root, a, b, rows } = foldFixture();
    expect(litFoldPath(root, rows.b2, 150)).toEqual([
      { rail: b.rail, length: 156 - 104 - 2, end: true },
      { rail: a.rail, length: 156 - 40 - 2, end: false },
    ]);
  });

  it('ends a nested header at the fold that holds it', () => {
    const { root, a, rows } = foldFixture();
    expect(litFoldPath(root, rows.header, 90)).toEqual([
      { rail: a.rail, length: 92 - 40 - 2, end: true },
    ]);
  });

  it('counts the margin above a glyph as that row', () => {
    const { root, b, rows } = foldFixture();
    expect(litFoldPath(root, rows.b2, 141)[0]).toEqual({ rail: b.rail, length: 50, end: true });
  });

  it('points at the row above when the pointer is inside an open body', () => {
    const { root, b } = foldFixture();
    const body = document.createElement('pre');
    b.el.append(body);
    expect(litFoldPath(root, body, 205)[0]).toEqual({
      rail: b.rail,
      length: 188 - 104 - 2,
      end: true,
    });
  });

  it('searches only the hovered column when document order is not vertical order', () => {
    const { root, a, rows } = foldFixture();
    const left = document.createElement('div');
    const right = document.createElement('div');
    left.setAttribute('data-fold-column', '');
    right.setAttribute('data-fold-column', '');
    left.append(rows.a1, rows.a2);
    right.append(rows.header);
    a.el.replaceChildren(a.rail, left, right);
    const body = document.createElement('pre');
    left.append(body);
    const cache = new WeakMap<Element, Element[]>();
    expect(litFoldPath(root, rows.a2, 225, cache)).toEqual([
      { rail: a.rail, length: 188, end: true },
    ]);
    expect(litFoldPath(root, body, 260, cache)[0].length).toBe(188);
    expect(litFoldPath(root, rows.header, 90, cache)[0].length).toBe(50);
    expect(litFoldPath(root, a.el, 225, cache)).toEqual([]);
  });

  it('excludes nested columns but keeps a nested panel in its surrounding column', () => {
    const { root, a, b, rows } = foldFixture();
    const column = document.createElement('div');
    const nested = document.createElement('div');
    column.setAttribute('data-fold-column', '');
    nested.setAttribute('data-fold-column', '');
    nested.append(rows.b1);
    column.append(rows.a1, rows.a2, nested, b.el);
    a.el.replaceChildren(a.rail, column);
    expect(litFoldPath(root, rows.a2, 225)[0].length).toBe(188);
    expect(litFoldPath(root, rows.b1, 120)[0].length).toBe(82);
    expect(litFoldPath(root, rows.b2, 150)).toEqual([
      { rail: b.rail, length: 50, end: true },
      { rail: a.rail, length: 114, end: false },
    ]);
  });

  it('leaves the rails and the outermost header alone', () => {
    const { root, b, outerHeader } = foldFixture();
    expect(litFoldPath(root, b.rail, 150)).toEqual([]);
    expect(litFoldPath(root, outerHeader, 15)).toEqual([]);
  });
});

describe('useFoldPath', () => {
  let frames: FrameRequestCallback[] = [];
  let resize: ResizeObserverCallback;
  const observe = jest.fn();
  const disconnect = jest.fn();
  const flushFrames = () => {
    const pending = frames;
    frames = [];
    pending.forEach((callback) => callback(0));
  };
  /** Moves are coalesced into the next frame, as a browser would run them. */
  const pointer = (
    type: string,
    target: Element,
    clientY: number,
    pointerType = 'mouse',
    flush = true,
  ) => {
    const event = new Event(type, { bubbles: type !== 'pointerleave' });
    Object.assign(event, { clientX: 100, clientY, pointerType });
    target.dispatchEvent(event);
    if (flush) {
      flushFrames();
    }
  };

  beforeEach(() => {
    frames = [];
    jest.spyOn(window, 'ResizeObserver').mockImplementation((callback) => {
      resize = callback;
      return { observe, unobserve: jest.fn(), disconnect };
    });
    jest.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback);
      return frames.length;
    });
    jest.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frames = [];
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('paints the path onto the rails and clears it when the pointer leaves', () => {
    const { root, a, b, rows } = foldFixture();
    const { unmount } = renderHook(() => useFoldPath({ current: root }, true));

    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBe('end');
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('50px');
    expect(a.rail.dataset.foldLit).toBe('through');
    expect(a.rail.style.getPropertyValue('--fold-lit')).toBe('114px');

    pointer('pointermove', rows.a2, 225);
    expect(b.rail.dataset.foldLit).toBeUndefined();
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('');
    expect(a.rail.dataset.foldLit).toBe('end');

    pointer('pointerleave', root, 0);
    expect(a.rail.dataset.foldLit).toBeUndefined();
    unmount();
  });

  it('follows no touch, and drops the path on a press that may move the rows', () => {
    const { root, a, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));

    pointer('pointermove', rows.a1, 55, 'touch');
    expect(a.rail.dataset.foldLit).toBeUndefined();

    pointer('pointermove', rows.a1, 55);
    expect(a.rail.dataset.foldLit).toBe('end');
    pointer('pointerdown', rows.a1, 55);
    expect(a.rail.dataset.foldLit).toBeUndefined();
  });

  it('cancels a queued paint when the pointer presses before the frame', () => {
    const { root, a, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150, 'mouse', false);
    expect(frames).toHaveLength(1);
    pointer('pointerdown', rows.b2, 150);
    expect(window.cancelAnimationFrame).toHaveBeenCalledWith(1);
    expect(frames).toHaveLength(0);
    expect(a.rail.dataset.foldLit).toBeUndefined();
    expect(b.rail.dataset.foldLit).toBeUndefined();
  });

  it('reuses the panel glyph list across pointer frames', async () => {
    const { root, b, rows } = foldFixture();
    const query = jest.spyOn(b.el, 'querySelectorAll');
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b1, 120);
    await Promise.resolve();
    expect(b.rail.dataset.foldLit).toBe('end');
    pointer('pointermove', rows.b2, 150);
    pointer('pointermove', rows.b3, 180);
    expect(query).toHaveBeenCalledTimes(1);
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('82px');
  });

  it('clears on streamed text changes without relighting a queued frame', async () => {
    const { root, b, rows } = foldFixture();
    rows.b1.append(document.createTextNode('output'));
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150);
    await Promise.resolve();
    pointer('pointermove', rows.b2, 150, 'mouse', false);
    rows.b1.firstChild!.textContent = 'growing output';
    await Promise.resolve();
    flushFrames();
    expect(b.rail.dataset.foldLit).toBeUndefined();
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('');
  });

  it('rebuilds cached glyphs after rows are inserted or removed', async () => {
    const { root, b, rows } = foldFixture();
    const query = jest.spyOn(b.el, 'querySelectorAll');
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b1, 120);
    const added = rows.b2.cloneNode() as HTMLElement;
    added.getBoundingClientRect = () => ({ top: 210, height: 20 }) as DOMRect;
    b.el.append(added);
    await Promise.resolve();
    expect(b.rail.dataset.foldLit).toBeUndefined();
    pointer('pointermove', added, 215);
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('114px');
    added.remove();
    await Promise.resolve();
    pointer('pointermove', rows.b3, 180);
    expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('82px');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each(['class', 'style', 'hidden', 'open'])(
    'clears on a disclosure %s change',
    async (attribute) => {
      const { root, b, rows } = foldFixture();
      renderHook(() => useFoldPath({ current: root }, true));
      pointer('pointermove', rows.b2, 150);
      rows.b1.setAttribute(attribute, 'changed');
      await Promise.resolve();
      expect(b.rail.dataset.foldLit).toBeUndefined();
    },
  );

  it('clears when resizing or scrolling moves the hovered row', () => {
    const { root, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150);
    resize([], {} as ResizeObserver);
    expect(b.rail.dataset.foldLit).toBeUndefined();
    pointer('pointermove', rows.b2, 150);
    root.dispatchEvent(new Event('scroll'));
    expect(b.rail.dataset.foldLit).toBeUndefined();
    pointer('pointermove', rows.b2, 150);
    window.dispatchEvent(new Event('resize'));
    expect(b.rail.dataset.foldLit).toBeUndefined();
  });

  it.each([false, true])(
    'clears after a preceding message shifts the fold, with a queued paint=%s',
    (queued) => {
      const { root, a, b, rows } = foldFixture();
      const transcript = document.createElement('div');
      const previous = document.createElement('div');
      const message = document.createElement('div');
      message.className = 'message-render';
      message.append(root);
      transcript.append(previous, message);
      document.body.append(transcript);
      let offset = 0;
      root.getBoundingClientRect = message.getBoundingClientRect = () =>
        ({ top: offset, height: 250 }) as DOMRect;
      for (const element of [a.rail, b.rail, ...Object.values(rows)]) {
        const rect = element.getBoundingClientRect();
        element.getBoundingClientRect = () => ({ ...rect, top: rect.top + offset });
      }
      const query = jest.spyOn(b.el, 'querySelectorAll');
      const { unmount } = renderHook(() => useFoldPath({ current: root }, true));
      pointer('pointermove', rows.b2, 150);
      expect(b.rail.dataset.foldLit).toBe('end');
      if (queued) {
        pointer('pointermove', rows.b2, 150, 'mouse', false);
      }
      offset = 32;
      if (observe.mock.calls.some(([element]) => element === transcript)) {
        resize([], {} as ResizeObserver);
      }
      flushFrames();
      expect(root.getBoundingClientRect()).toMatchObject({ top: 32, height: 250 });
      expect(message.getBoundingClientRect()).toMatchObject({ top: 32, height: 250 });
      expect(a.rail.dataset.foldLit).toBeUndefined();
      expect(b.rail.dataset.foldLit).toBeUndefined();
      expect(a.rail.style.getPropertyValue('--fold-lit')).toBe('');
      expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('');
      pointer('pointermove', rows.b1, 150);
      expect(b.rail.dataset.foldLit).toBe('end');
      expect(b.rail.style.getPropertyValue('--fold-lit')).toBe('18px');
      expect(query).toHaveBeenCalledTimes(1);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('re-hit-tests one queued paint after scrolling instead of discarding a fresh move', () => {
    const { root, a, b, rows } = foldFixture();
    rows.a2.getBoundingClientRect = () => ({ top: 140, height: 20 }) as DOMRect;
    const hit = jest.fn(() => rows.a2);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
    try {
      renderHook(() => useFoldPath({ current: root }, true));
      pointer('pointermove', rows.b2, 150, 'mouse', false);
      root.dispatchEvent(new Event('scroll'));
      root.dispatchEvent(new Event('scroll'));
      expect(frames).toHaveLength(1);
      expect(hit).not.toHaveBeenCalled();
      flushFrames();
      expect(hit).toHaveBeenCalledTimes(1);
      expect(hit).toHaveBeenCalledWith(100, 150);
      expect(b.rail.dataset.foldLit).toBeUndefined();
      expect(a.rail.dataset.foldLit).toBe('end');
      expect(a.rail.style.getPropertyValue('--fold-lit')).toBe('108px');
    } finally {
      Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it.each([null, document.body])(
    'clears a queued path when scrolling moves the pointer outside the fold (%p)',
    (target) => {
      const { root, a, b, rows } = foldFixture();
      Object.defineProperty(document, 'elementFromPoint', {
        configurable: true,
        value: jest.fn(() => target),
      });
      try {
        renderHook(() => useFoldPath({ current: root }, true));
        pointer('pointermove', rows.b2, 150);
        pointer('pointermove', rows.b3, 180, 'mouse', false);
        root.dispatchEvent(new Event('scroll'));
        flushFrames();
        expect(a.rail.dataset.foldLit).toBeUndefined();
        expect(b.rail.dataset.foldLit).toBeUndefined();
      } finally {
        Reflect.deleteProperty(document, 'elementFromPoint');
      }
    },
  );

  it('disconnects observers and cancels pending work on unmount', async () => {
    const { root, b, rows } = foldFixture();
    const { unmount } = renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150);
    pointer('pointermove', rows.b3, 180, 'mouse', false);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(frames).toHaveLength(0);
    expect(b.rail.dataset.foldLit).toBeUndefined();
    rows.b1.remove();
    await Promise.resolve();
    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBeUndefined();
  });

  it('leaves a fold nested in another to the outer one', () => {
    const { root, b, rows } = foldFixture();
    const inner = document.createElement('div');
    inner.setAttribute('data-fold-root', '');
    root.append(inner);
    renderHook(() => useFoldPath({ current: inner }, true));

    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBeUndefined();
  });

  it('waits for the panel before listening', () => {
    const { root, b, rows } = foldFixture();
    const { rerender } = renderHook(({ hasBody }) => useFoldPath({ current: root }, hasBody), {
      initialProps: { hasBody: false },
    });
    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBeUndefined();

    rerender({ hasBody: true });
    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBe('end');
  });
});

describe('FoldRail path segment', () => {
  it('draws the lit path inside the rail, hidden from assistive tech', () => {
    function Rail() {
      const hover = useRailHover();
      return <FoldRail hover={hover} expanded onCollapse={jest.fn()} />;
    }
    render(<Rail />);
    const rail = screen.getByTestId('fold-rail');
    expect(rail).toHaveAttribute('data-fold-rail');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    expect(rail).toContainElement(screen.getByTestId('fold-rail-path'));
  });
});
