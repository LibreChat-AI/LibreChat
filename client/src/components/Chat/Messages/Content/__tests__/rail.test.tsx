import React from 'react';
import { act, render, renderHook, screen, fireEvent } from '@testing-library/react';
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

  it('lights every fold that holds the row, innermost first, each into its own branch', () => {
    const { root, a, b, rows } = foldFixture();
    expect(litFoldPath(root, rows.b2, 150)).toEqual([
      { rail: b.rail, branch: 1 },
      { rail: a.rail, branch: 1 },
    ]);
  });

  it('ends a nested header at the fold that holds it', () => {
    const { root, a, rows } = foldFixture();
    expect(litFoldPath(root, rows.header, 90)).toEqual([{ rail: a.rail, branch: 1 }]);
  });

  it('counts the margin above a glyph as that row', () => {
    const { root, b, rows } = foldFixture();
    expect(litFoldPath(root, rows.b2, 141)[0]).toEqual({ rail: b.rail, branch: 1 });
  });

  it('points at the row above when the pointer is inside an open body', () => {
    const { root, b } = foldFixture();
    const body = document.createElement('pre');
    b.el.append(body);
    expect(litFoldPath(root, body, 205)[0]).toEqual({ rail: b.rail, branch: 2 });
  });

  it('leaves rows in parallel columns without a branch to light', () => {
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
    expect(litFoldPath(root, rows.a2, 225, cache)).toEqual([]);
    expect(litFoldPath(root, body, 260, cache)).toEqual([]);
    expect(litFoldPath(root, rows.header, 90, cache)).toEqual([]);
    expect(litFoldPath(root, a.el, 225, cache)).toEqual([]);
  });

  it('still lights a nested panel that sits in a column of its parent', () => {
    const { root, a, b, rows } = foldFixture();
    const column = document.createElement('div');
    const nested = document.createElement('div');
    column.setAttribute('data-fold-column', '');
    nested.setAttribute('data-fold-column', '');
    nested.append(rows.b1);
    column.append(rows.a1, rows.a2, nested, b.el);
    a.el.replaceChildren(a.rail, column);
    expect(litFoldPath(root, rows.a2, 225)).toEqual([]);
    expect(litFoldPath(root, rows.b1, 120)).toEqual([]);
    expect(litFoldPath(root, rows.b2, 150)).toEqual([{ rail: b.rail, branch: 0 }]);
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
  /** What sits under the pointer when a layout change has the hook hit-test again. */
  const hit = jest.fn<Element | null, [number, number]>(() => null);
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
    hit.mockReset().mockReturnValue(null);
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: hit });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(document, 'elementFromPoint');
    window.matchMedia = allMotion;
    document.body.innerHTML = '';
  });

  /** Gives each fixture rail the lit path and the row centers `FoldRail` renders. */
  const traced = (rail: HTMLElement, centers: number[]) => {
    rail.dataset.centers = centers.join(',');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('data-fold-trace', '');
    rail.append(path);
    return path;
  };
  /** The setup's `matchMedia` is already a mock, so swap it rather than spy on it. */
  const allMotion = window.matchMedia;
  const reduceMotion = () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
      }) as MediaQueryList) as typeof window.matchMedia;
  };

  it('paints the path onto the rails and clears it when the pointer leaves', () => {
    reduceMotion();
    const { root, a, b, rows } = foldFixture();
    /** Centers relative to each rail's top. */
    const bPath = traced(b.rail, [20, 52, 84]);
    const aPath = traced(a.rail, [20, 52, 190]);
    const { unmount } = renderHook(() => useFoldPath({ current: root }, true));

    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBe('1');
    expect(a.rail.dataset.foldLit).toBe('1');
    expect(bPath).toHaveAttribute('data-lit');
    expect(bPath).toHaveAttribute('d', 'M 11.5 2 V 44 A 8 8 0 0 0 19.5 52 H 22');
    expect(aPath).toHaveAttribute('d', 'M 11.5 2 V 44 A 8 8 0 0 0 19.5 52 H 22');

    pointer('pointermove', rows.a2, 225);
    expect(b.rail.dataset.foldLit).toBeUndefined();
    expect(bPath).not.toHaveAttribute('data-lit');
    expect(a.rail.dataset.foldLit).toBe('2');
    expect(aPath).toHaveAttribute('d', 'M 11.5 2 V 182 A 8 8 0 0 0 19.5 190 H 22');

    pointer('pointerleave', root, 0);
    expect(a.rail.dataset.foldLit).toBeUndefined();
    expect(aPath).not.toHaveAttribute('data-lit');
    unmount();
  });

  it('travels the tree from one row to the next: out of the branch, along the trunk, in', () => {
    const { root, b, rows } = foldFixture();
    const path = traced(b.rail, [20, 52, 84]);
    renderHook(() => useFoldPath({ current: root }, true));
    const shape = () => {
      const d = path.getAttribute('d') ?? '';
      return { d, tip: Number(/V ([\d.]+)/.exec(d)?.[1]), branch: d.includes(' A ') };
    };
    const frameAt = (now: number) => {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(now));
    };

    pointer('pointermove', rows.b3, 180, 'mouse', false);
    frameAt(0);
    frameAt(0);
    frameAt(1000);
    expect(path).toHaveAttribute('d', 'M 11.5 2 V 76 A 8 8 0 0 0 19.5 84 H 22');
    expect(frames).toHaveLength(0);

    /** From the third row to the second, sampled every 10ms. */
    pointer('pointermove', rows.b2, 150, 'mouse', false);
    frameAt(2000);
    const seen: Array<ReturnType<typeof shape>> = [];
    for (let now = 2000; frames.length > 0; now += 10) {
      frameAt(now);
      seen.push(shape());
    }
    expect(seen[seen.length - 1].d).toBe('M 11.5 2 V 44 A 8 8 0 0 0 19.5 52 H 22');
    for (let i = 0; i < seen.length; i++) {
      const { tip, branch } = seen[i];
      /** Never above the row it is heading for, never back via the top. */
      expect(tip).toBeGreaterThanOrEqual(44);
      expect(tip).toBeLessThanOrEqual(76);
      if (i > 0) {
        expect(tip).toBeLessThanOrEqual(seen[i - 1].tip);
      }
      /** A branch is only ever drawn from a branch point, so nothing leaves the tree. */
      if (branch) {
        expect([44, 76]).toContain(tip);
      }
    }
    expect(seen.some(({ tip, branch }) => !branch && tip > 44 && tip < 76)).toBe(true);
  });

  it('keeps traveling, without a jump, when the row it is heading for moves mid-trip', async () => {
    const { root, b, rows } = foldFixture();
    const path = traced(b.rail, [20, 52, 84]);
    renderHook(() => useFoldPath({ current: root }, true));
    const tipOf = () => Number(/V ([\d.]+)/.exec(path.getAttribute('d') ?? '')?.[1]);
    const frameAt = (now: number) => {
      const pending = frames;
      frames = [];
      pending.forEach((callback) => callback(now));
    };

    pointer('pointermove', rows.b1, 120, 'mouse', false);
    frameAt(0);
    frameAt(0);
    frameAt(1000);
    expect(tipOf()).toBe(12);

    pointer('pointermove', rows.b3, 180, 'mouse', false);
    frameAt(2000);
    const tips = [tipOf()];
    for (let now = 2000; now <= 2040; now += 5) {
      frameAt(now);
      tips.push(tipOf());
    }
    /** A fold above the third row opens: the row is 16px further down now. */
    hit.mockReturnValue(rows.b3);
    b.rail.dataset.centers = '20,52,100';
    await Promise.resolve();
    for (let now = 2045; frames.length > 0; now += 5) {
      frameAt(now);
      tips.push(tipOf());
    }
    expect(path).toHaveAttribute('d', 'M 11.5 2 V 92 A 8 8 0 0 0 19.5 100 H 22');
    for (let i = 1; i < tips.length; i++) {
      expect(tips[i]).toBeGreaterThanOrEqual(tips[i - 1]);
      expect(tips[i] - tips[i - 1]).toBeLessThan(10);
    }
  });

  it('follows no touch, and clears on a touch press', () => {
    const { root, a, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));

    pointer('pointermove', rows.a1, 55, 'touch');
    expect(a.rail.dataset.foldLit).toBeUndefined();

    pointer('pointermove', rows.a1, 55);
    expect(a.rail.dataset.foldLit).toBe('0');
    pointer('pointerdown', rows.a1, 55, 'touch');
    expect(a.rail.dataset.foldLit).toBeUndefined();
  });

  it('keeps the path through a click that folds the rows, re-hit under the pointer', async () => {
    const { root, a, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBe('1');

    /** Folding the group unmounts its panel; the group's header is now under the pointer. */
    hit.mockReturnValue(rows.header);
    pointer('pointerdown', rows.b2, 150);
    b.el.remove();
    await Promise.resolve();
    flushFrames();
    expect(hit).toHaveBeenCalledWith(100, 150);
    expect(b.rail.dataset.foldLit).toBeUndefined();
    expect(a.rail.dataset.foldLit).toBe('1');
  });

  it('cancels a queued paint when a touch presses before the frame', () => {
    const { root, a, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150, 'mouse', false);
    expect(frames).toHaveLength(1);
    pointer('pointerdown', rows.b2, 150, 'touch');
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
    expect(b.rail.dataset.foldLit).toBe('0');
    pointer('pointermove', rows.b2, 150);
    pointer('pointermove', rows.b3, 180);
    expect(query).toHaveBeenCalledTimes(1);
    expect(b.rail.dataset.foldLit).toBe('2');
  });

  it('relights under the pointer when streamed text moves the rows', async () => {
    const { root, b, rows } = foldFixture();
    rows.b1.append(document.createTextNode('output'));
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b2, 150);
    expect(b.rail.dataset.foldLit).toBe('1');

    /** The first row's output grows and pushes the rows below it out from under the pointer. */
    rows.b2.getBoundingClientRect = () => ({ top: 178, height: 20 }) as DOMRect;
    rows.b3.getBoundingClientRect = () => ({ top: 210, height: 20 }) as DOMRect;
    hit.mockReturnValue(rows.b1);
    rows.b1.firstChild!.textContent = 'growing output';
    await Promise.resolve();
    flushFrames();
    expect(b.rail.dataset.foldLit).toBe('0');
  });

  it('uses a fresh move over a pending re-hit in the same frame', async () => {
    const { root, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    pointer('pointermove', rows.b1, 120);
    rows.b1.setAttribute('class', 'fold-glyph changed');
    await Promise.resolve();
    pointer('pointermove', rows.b3, 180);
    expect(hit).not.toHaveBeenCalled();
    expect(b.rail.dataset.foldLit).toBe('2');
  });

  it('rebuilds cached glyphs after rows are inserted or removed', async () => {
    const { root, b, rows } = foldFixture();
    const query = jest.spyOn(b.el, 'querySelectorAll');
    renderHook(() => useFoldPath({ current: root }, true));
    hit.mockReturnValue(rows.b1);
    pointer('pointermove', rows.b1, 120);
    const added = rows.b2.cloneNode() as HTMLElement;
    added.getBoundingClientRect = () => ({ top: 210, height: 20 }) as DOMRect;
    b.el.append(added);
    await Promise.resolve();
    flushFrames();
    expect(b.rail.dataset.foldLit).toBe('0');
    pointer('pointermove', added, 215);
    expect(b.rail.dataset.foldLit).toBe('3');
    added.remove();
    await Promise.resolve();
    pointer('pointermove', rows.b3, 180);
    expect(b.rail.dataset.foldLit).toBe('2');
    expect(query).toHaveBeenCalledTimes(3);
  });

  it.each(['class', 'style', 'hidden', 'open', 'data-centers'])(
    're-hits on a disclosure %s change',
    async (attribute) => {
      const { root, b, rows } = foldFixture();
      renderHook(() => useFoldPath({ current: root }, true));
      pointer('pointermove', rows.b2, 150);
      rows.b1.setAttribute(attribute, 'changed');
      await Promise.resolve();
      flushFrames();
      expect(hit).toHaveBeenCalledWith(100, 150);
      expect(b.rail.dataset.foldLit).toBeUndefined();
    },
  );

  it('re-hits when resizing or scrolling moves the rows under the pointer', () => {
    const { root, b, rows } = foldFixture();
    renderHook(() => useFoldPath({ current: root }, true));
    hit.mockReturnValue(rows.b2);
    pointer('pointermove', rows.b2, 150);
    resize([], {} as ResizeObserver);
    flushFrames();
    expect(b.rail.dataset.foldLit).toBe('1');
    root.dispatchEvent(new Event('scroll'));
    flushFrames();
    expect(b.rail.dataset.foldLit).toBe('1');
    expect(hit).toHaveBeenCalledTimes(2);

    /** Scrolled out from under the pointer: nothing of this fold is there any more. */
    hit.mockReturnValue(document.body);
    window.dispatchEvent(new Event('resize'));
    flushFrames();
    expect(b.rail.dataset.foldLit).toBeUndefined();
  });

  it.each([false, true])(
    'relights after a preceding message shifts the fold, with a queued paint=%s',
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
      expect(b.rail.dataset.foldLit).toBe('1');
      if (queued) {
        pointer('pointermove', rows.b2, 150, 'mouse', false);
      }
      /** 32px down, the row above the one that was hovered is now under the pointer. */
      offset = 32;
      hit.mockReturnValue(rows.b1);
      expect(observe.mock.calls.some(([element]) => element === transcript)).toBe(true);
      resize([], {} as ResizeObserver);
      flushFrames();
      expect(b.rail.dataset.foldLit).toBe('0');
      expect(a.rail.dataset.foldLit).toBe('1');
      expect(query).toHaveBeenCalledTimes(1);
      unmount();
      expect(disconnect).toHaveBeenCalledTimes(1);
    },
  );

  it('re-hit-tests one queued paint after scrolling instead of discarding a fresh move', () => {
    const { root, a, b, rows } = foldFixture();
    rows.a2.getBoundingClientRect = () => ({ top: 140, height: 20 }) as DOMRect;
    hit.mockReturnValue(rows.a2);
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
    expect(a.rail.dataset.foldLit).toBe('2');
  });

  it.each([null, document.body])(
    'clears a queued path when scrolling moves the pointer outside the fold (%p)',
    (target) => {
      const { root, a, b, rows } = foldFixture();
      hit.mockReturnValue(target);
      renderHook(() => useFoldPath({ current: root }, true));
      pointer('pointermove', rows.b2, 150);
      pointer('pointermove', rows.b3, 180, 'mouse', false);
      root.dispatchEvent(new Event('scroll'));
      flushFrames();
      expect(a.rail.dataset.foldLit).toBeUndefined();
      expect(b.rail.dataset.foldLit).toBeUndefined();
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
    expect(b.rail.dataset.foldLit).toBe('1');
  });
});

describe('FoldRail branches', () => {
  let measure: ResizeObserverCallback;

  beforeEach(() => {
    /** The rail measures in a layout effect, before its later siblings' refs attach. */
    jest.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      return { top: Number(this.dataset.top ?? 0), height: 20 } as DOMRect;
    });
    jest.spyOn(window, 'ResizeObserver').mockImplementation((callback) => {
      measure = callback;
      return { observe: jest.fn(), unobserve: jest.fn(), disconnect: jest.fn() };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function Panel({ rows, expanded = true }: { rows: number[]; expanded?: boolean }) {
    const hover = useRailHover();
    return (
      <div data-fold-panel="">
        <FoldRail hover={hover} expanded={expanded} onCollapse={jest.fn()} />
        {rows.map((top) => (
          <span key={top} className="fold-glyph" data-top={top} />
        ))}
        <div data-fold-panel="">
          <span className="fold-glyph" data-top={500} />
        </div>
      </div>
    );
  }

  it('branches the trunk into each of its own rows, hidden from assistive tech', () => {
    render(<Panel rows={[6, 38]} />);
    const rail = screen.getByTestId('fold-rail');
    expect(rail).toHaveAttribute('aria-hidden', 'true');
    expect(rail).toHaveAttribute('data-centers', '16,48');
    const drawn = Array.from(screen.getByTestId('fold-rail-tree').querySelectorAll('g > path'));
    expect(drawn.map((path) => path.getAttribute('d'))).toEqual([
      'M 11.5 2 V 40',
      'M 11.5 8 A 8 8 0 0 0 19.5 16 H 22',
      'M 11.5 40 A 8 8 0 0 0 19.5 48 H 22',
    ]);
    /** The lit path has no shape until `useFoldPath` traces it to a row. */
    expect(screen.getByTestId('fold-rail-path')).not.toHaveAttribute('d');
  });

  it('adds a branch when a streamed row resizes the panel', () => {
    const { rerender } = render(<Panel rows={[6]} />);
    expect(screen.getByTestId('fold-rail')).toHaveAttribute('data-centers', '16');
    rerender(<Panel rows={[6, 38]} />);
    act(() => measure([], {} as ResizeObserver));
    expect(screen.getByTestId('fold-rail')).toHaveAttribute('data-centers', '16,48');
  });

  it('keeps a plain hairline for a panel without rows of its own', () => {
    render(<Panel rows={[]} />);
    expect(screen.queryByTestId('fold-rail-tree')).toBeNull();
  });

  it('fades the branches out as the fold collapses', () => {
    const { rerender } = render(<Panel rows={[6]} />);
    expect(screen.getByTestId('fold-rail-tree')).toHaveClass('opacity-100');
    rerender(<Panel rows={[6]} expanded={false} />);
    expect(screen.getByTestId('fold-rail-tree')).toHaveClass('opacity-0');
  });
});
