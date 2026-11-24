/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import type { RowMountWindow } from '../useProgressiveRowMount';
import {
  pinsByHand,
  useWidenedRow,
  useRowMounted,
  createRowGates,
  RowMountProvider,
  useProgressiveRowMount,
  finishProgressiveRowMounts,
  completeProgressiveRowMounts,
} from '../useProgressiveRowMount';

type HookProps = {
  tailDepth: number | undefined;
  anchorBottom: boolean;
  isSubmitting: boolean;
  conversationId: string | null | undefined;
};

describe('useProgressiveRowMount', () => {
  let frames: Array<FrameRequestCallback | undefined>;
  const scrollableRef = { current: null } as React.RefObject<HTMLDivElement | null>;

  /** Runs only the frames scheduled BEFORE this flush, so one call advances
   *  the expansion by exactly one step even though each step schedules the
   *  next frame during the act() flush. */
  const flushFrames = () =>
    act(() => {
      const pending = frames.length;
      for (let index = 0; index < pending; index += 1) {
        const frame = frames[index];
        frames[index] = undefined;
        frame?.(index);
      }
    });

  beforeEach(() => {
    frames = [];
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as unknown as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = jest.fn((handle: number) => {
      frames[handle - 1] = undefined;
    }) as unknown as typeof window.cancelAnimationFrame;
  });

  const setup = (initial: Partial<HookProps> = {}) => {
    const props: HookProps = {
      tailDepth: 267,
      anchorBottom: false,
      isSubmitting: false,
      conversationId: 'convo-a',
      ...initial,
    };
    return renderHook(
      (current: HookProps) => useProgressiveRowMount({ ...current, scrollableRef }),
      { initialProps: props },
    );
  };

  it('does not window short threads', () => {
    const { result } = setup({ tailDepth: 20 });
    expect(result.current).toBeNull();
  });

  it('mounts every row at once for a run under way in a thread anchored at its start', () => {
    /** The reply is written at the end, which a window at the start does not hold. */
    const { result } = setup({ isSubmitting: true });
    expect(result.current).toBeNull();
  });

  it('keeps windowing a thread anchored at its end while a run is under way', () => {
    const { result } = setup({ isSubmitting: true, anchorBottom: true });
    expect(result.current).toEqual({ start: 252, end: Number.POSITIVE_INFINITY });
  });

  it('widens in small steps beside a reply in flight, each committed without a transition', () => {
    const transition = jest.spyOn(React, 'startTransition');
    const { result } = setup({ isSubmitting: true, anchorBottom: true });

    flushFrames();
    expect(result.current).toEqual({ start: 248, end: Number.POSITIVE_INFINITY });
    flushFrames();
    expect(result.current).toEqual({ start: 244, end: Number.POSITIVE_INFINITY });
    /** A reply's frames are urgent updates: each would discard a transition's render. */
    expect(transition).not.toHaveBeenCalled();
    transition.mockRestore();
  });

  it('goes on widening when a run starts part way through, and takes larger steps once it ends', () => {
    const props = { tailDepth: 267, anchorBottom: true, conversationId: 'convo-a' };
    const { result, rerender } = setup({ anchorBottom: true });
    flushFrames();
    expect(result.current).toEqual({ start: 220, end: Number.POSITIVE_INFINITY });

    rerender({ ...props, isSubmitting: true });
    expect(result.current).toEqual({ start: 220, end: Number.POSITIVE_INFINITY });
    flushFrames();
    expect(result.current).toEqual({ start: 216, end: Number.POSITIVE_INFINITY });

    rerender({ ...props, isSubmitting: false });
    flushFrames();
    expect(result.current).toEqual({ start: 184, end: Number.POSITIVE_INFINITY });
  });

  it('anchors the first window at the top by default', () => {
    const { result } = setup();
    expect(result.current).toEqual({ start: 0, end: 15 });
  });

  it('anchors the first window at the tail for bottom anchoring', () => {
    const { result } = setup({ anchorBottom: true });
    expect(result.current).toEqual({ start: 252, end: Number.POSITIVE_INFINITY });
  });

  it('widens per frame until the whole path is covered, then lifts the restriction', () => {
    const { result } = setup();
    const seen: RowMountWindow[] = [result.current];

    for (let i = 0; i < 20 && result.current != null; i += 1) {
      flushFrames();
      seen.push(result.current);
    }

    expect(result.current).toBeNull();
    const ends = seen.filter((w): w is NonNullable<RowMountWindow> => w != null).map((w) => w.end);
    for (let i = 1; i < ends.length; i += 1) {
      expect(ends[i]).toBeGreaterThan(ends[i - 1]);
    }
    /** The final widening and the covered-check that lifts the restriction
     *  land in the same flush, so the last observable window sits within one
     *  chunk of the tail. */
    expect(ends[ends.length - 1]).toBeGreaterThanOrEqual(267 - 32);
  });

  it('completes immediately when a run starts while a thread anchored at its start is widening', () => {
    const { result, rerender } = setup();
    expect(result.current).not.toBeNull();

    rerender({
      tailDepth: 267,
      anchorBottom: false,
      isSubmitting: true,
      conversationId: 'convo-a',
    });
    expect(result.current).toBeNull();
  });

  it('force-completes in-flight mounts for DOM consumers, resolving after paint', async () => {
    const { result } = setup();
    expect(result.current).not.toBeNull();

    let resolved = false;
    let completion: Promise<void> = Promise.resolve();
    act(() => {
      completion = completeProgressiveRowMounts().then(() => {
        resolved = true;
      });
    });
    expect(result.current).toBeNull();

    flushFrames();
    flushFrames();
    await act(async () => {
      await completion;
    });
    expect(resolved).toBe(true);

    /** With nothing in flight it resolves immediately, no frames needed. */
    await expect(completeProgressiveRowMounts()).resolves.toBeUndefined();
  });

  it('finishes in-flight mounts within the call, for an action that answers in its own event', () => {
    const { result } = setup();
    expect(result.current).not.toBeNull();

    let finished = false;
    act(() => {
      finished = finishProgressiveRowMounts();
      /** No frame has passed and no promise has settled: the rows are in already. */
      expect(result.current).toBeNull();
    });
    expect(finished).toBe(true);

    /** With nothing in flight there is nothing to finish, and it says so. */
    expect(finishProgressiveRowMounts()).toBe(false);
  });

  it('tells a thread whose latest rows are still to come from one that has them', () => {
    /** Opened at its end: what is waiting is older than the rows already in. */
    const fromEnd = setup({ anchorBottom: true });
    let finished = true;
    act(() => {
      finished = finishProgressiveRowMounts('later');
    });
    expect(finished).toBe(false);
    expect(fromEnd.result.current).not.toBeNull();
    fromEnd.unmount();

    /** Opened at its start: the latest rows are the ones waiting. */
    const fromStart = setup({ anchorBottom: false });
    expect(fromStart.result.current).toEqual({ start: 0, end: 15 });
    act(() => {
      finished = finishProgressiveRowMounts('later');
      expect(fromStart.result.current).toBeNull();
    });
    expect(finished).toBe(true);
  });

  it('re-arms a fresh window when the conversation changes', () => {
    const { result, rerender } = setup();

    while (result.current != null) {
      flushFrames();
    }
    expect(result.current).toBeNull();

    rerender({
      tailDepth: 199,
      anchorBottom: false,
      isSubmitting: false,
      conversationId: 'convo-b',
    });
    expect(result.current).toEqual({ start: 0, end: 15 });
  });
});

/** What the browser says of `overflow-anchor`, for the tests that depend on it. */
const originalCSS = (globalThis as { CSS?: unknown }).CSS;
const browserAnchors = (anchors: boolean) => {
  (globalThis as { CSS?: unknown }).CSS = { supports: () => anchors };
};
const restoreCSS = () => {
  (globalThis as { CSS?: unknown }).CSS = originalCSS;
};

describe('pinsByHand', () => {
  afterEach(restoreCSS);

  it('leaves an idle thread to a browser that anchors scroll itself', () => {
    browserAnchors(true);
    expect(pinsByHand(false)).toBe(false);
  });

  it('holds the reader itself beside a reply in flight, even there', () => {
    browserAnchors(true);
    expect(pinsByHand(true)).toBe(true);
  });

  it('holds the reader itself wherever the browser does not anchor', () => {
    browserAnchors(false);
    expect(pinsByHand(false)).toBe(true);
    expect(pinsByHand(true)).toBe(true);
  });
});

describe('row gates', () => {
  let frames: Array<FrameRequestCallback | undefined>;
  const scrollableRef = { current: null } as React.RefObject<HTMLDivElement | null>;
  const renders = new Map<number, number>();

  beforeEach(() => {
    frames = [];
    renders.clear();
    window.requestAnimationFrame = jest.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }) as unknown as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = jest.fn((handle: number) => {
      frames[handle - 1] = undefined;
    }) as unknown as typeof window.cancelAnimationFrame;
  });

  /** Memoized, as the thread's rows are: the hook's host renders on every step. */
  const Row = React.memo(function Row({ depth }: { depth: number }) {
    renders.set(depth, (renders.get(depth) ?? 0) + 1);
    return useRowMounted(depth) ? <div data-testid={`row-${depth}`} /> : null;
  });

  /** The thread the way `MessagesView` wires it: the hook publishes to the provider's gates. */
  function Thread({ isSubmitting = false }: { isSubmitting?: boolean }) {
    const [gates] = React.useState(createRowGates);
    const mountWindow = useProgressiveRowMount({
      tailDepth: 59,
      anchorBottom: true,
      isSubmitting,
      conversationId: 'convo-a',
      scrollableRef,
      gates,
    });
    return (
      <RowMountProvider mountWindow={mountWindow} gates={gates}>
        {Array.from({ length: 60 }, (_, depth) => (
          <Row key={depth} depth={depth} />
        ))}
      </RowMountProvider>
    );
  }

  const step = () =>
    act(() => {
      const pending = frames.length;
      for (let index = 0; index < pending; index += 1) {
        const frame = frames[index];
        frames[index] = undefined;
        frame?.(index);
      }
    });

  const mounted = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid]'), (row) =>
      Number((row as HTMLElement).dataset.testid?.slice(4)),
    );

  it('mounts the rows a step adds and renders no other row for it', () => {
    const { container } = render(<Thread />);
    expect(mounted(container)).toEqual(Array.from({ length: 16 }, (_, index) => 44 + index));

    renders.clear();
    step();
    expect(mounted(container)[0]).toBe(12);
    /** Only the rows that entered the window rendered: a step costs what it adds, not a
     *  render of every row in the thread. */
    expect(Array.from(renders.keys()).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 32 }, (_, index) => 12 + index),
    );

    renders.clear();
    step();
    expect(mounted(container)).toHaveLength(60);
    expect(Array.from(renders.keys()).sort((a, b) => a - b)).toEqual(
      Array.from({ length: 12 }, (_, index) => index),
    );
  });

  it('mounts a few rows a frame beside a reply in flight', () => {
    const { container } = render(<Thread isSubmitting />);
    expect(mounted(container)).toHaveLength(16);
    step();
    expect(mounted(container)).toHaveLength(20);
    step();
    expect(mounted(container)).toHaveLength(24);
  });

  it('mounts a row in its first commit when its level only now has a depth inside the window', () => {
    const commits: boolean[] = [];
    function Level({ depth }: { depth: number }) {
      const mounted = useRowMounted(depth);
      React.useLayoutEffect(() => {
        commits.push(mounted);
      });
      return mounted ? <div data-testid={`row-${depth}`} /> : null;
    }
    /** The level under the last message is empty, and reads as depth 0, until a turn arrives. */
    const tree = (depth: number) => (
      <RowMountProvider mountWindow={{ start: 44, end: Number.POSITIVE_INFINITY }}>
        <Level depth={depth} />
      </RowMountProvider>
    );
    const { container, rerender } = render(tree(0));
    expect(mounted(container)).toEqual([]);

    commits.length = 0;
    rerender(tree(60));
    expect(commits).toEqual([true]);
    expect(mounted(container)).toEqual([60]);
  });

  /**
   * A reader who has scrolled up is held in place while rows mount above them: the scroll
   * position moves by exactly what the step added. What a row adds is not settled when it
   * mounts. A long user message measures itself in a layout effect and renders again clamped.
   */
  describe('holding the reader while rows mount above them', () => {
    const FULL = 900;
    const CLAMPED = 400;
    /** Where the first row mounted so far sits in the document: below everything added. */
    let anchorOffset: number;
    let container: HTMLDivElement;
    let rect: jest.SpyInstance;
    /** What the browser does to the scroll position when the long message collapses. */
    let onClamp: () => void;

    beforeEach(() => {
      anchorOffset = 100;
      onClamp = () => undefined;
      container = document.createElement('div');
      document.body.appendChild(container);
      container.scrollTop = 5000;
      rect = jest
        .spyOn(Element.prototype, 'getBoundingClientRect')
        .mockImplementation(() => ({ top: anchorOffset - container.scrollTop }) as DOMRect);
    });

    afterEach(() => {
      rect.mockRestore();
      container.remove();
    });

    /** Measures itself in a layout effect and renders again clamped, as a long user turn does. */
    function LongMessage() {
      const [clamped, setClamped] = React.useState(false);
      React.useLayoutEffect(() => setClamped(true), []);
      React.useLayoutEffect(() => {
        if (clamped) {
          onClamp();
        }
      }, [clamped]);
      anchorOffset = 100 + (clamped ? CLAMPED : FULL);
      return null;
    }
    const Message = React.memo(function Message({ depth }: { depth: number }) {
      const visible = useRowMounted(depth);
      if (!visible) {
        return null;
      }
      return <div className="message-render">{depth === 20 ? <LongMessage /> : null}</div>;
    });
    function Reading({
      onInsertAbove,
      isSubmitting = false,
    }: {
      onInsertAbove?: (height: number) => void;
      isSubmitting?: boolean;
    }) {
      const [gates] = React.useState(createRowGates);
      const ref = React.useRef(container);
      const mountWindow = useProgressiveRowMount({
        tailDepth: 59,
        anchorBottom: true,
        isSubmitting,
        conversationId: 'convo-a',
        scrollableRef: ref,
        gates,
        onInsertAbove,
      });
      return (
        <RowMountProvider mountWindow={mountWindow} gates={gates}>
          {Array.from({ length: 60 }, (_, depth) => (
            <Message key={depth} depth={depth} />
          ))}
        </RowMountProvider>
      );
    }

    /** The step that mounts the long message, and the microtask after its commit. */
    const mountLongMessage = () =>
      act(async () => {
        const pending = frames.length;
        for (let index = 0; index < pending; index += 1) {
          const frame = frames[index];
          frames[index] = undefined;
          frame?.(index);
        }
      });

    /**
     * The scroll position moves by exactly what the step added. What a row adds is not
     * settled when it mounts: the long message is counted at its full height first.
     */
    it('moves a reader who scrolled up by what the step added once its rows have settled', async () => {
      render(<Reading />, { container });
      await mountLongMessage();
      expect(container.scrollTop).toBe(5000 + CLAMPED);
    });

    it('says how much height a step added above the reader', async () => {
      /** The thread is as tall as the rows in it. */
      Object.defineProperty(container, 'scrollHeight', {
        get: () => 1000 + (container.getElementsByClassName('message-render').length - 16) * 30,
        configurable: true,
      });
      const added = jest.fn();
      render(<Reading onInsertAbove={added} />, { container });
      expect(added).not.toHaveBeenCalled();

      await mountLongMessage();
      expect(added).toHaveBeenCalledTimes(1);
      expect(added).toHaveBeenCalledWith(32 * 30);
    });

    it('waits for the reader to stop scrolling before it mounts the next rows', async () => {
      const now = jest.spyOn(performance, 'now').mockReturnValue(10_000);
      try {
        render(<Reading />, { container });
        const rows = () => container.getElementsByClassName('message-render').length;
        expect(rows()).toBe(16);

        container.dispatchEvent(new Event('wheel'));
        await mountLongMessage();
        expect(rows()).toBe(16);

        /** Still turning the wheel a moment later: still waiting. */
        now.mockReturnValue(10_100);
        container.dispatchEvent(new Event('wheel'));
        now.mockReturnValue(10_200);
        await mountLongMessage();
        expect(rows()).toBe(16);

        now.mockReturnValue(10_300);
        await mountLongMessage();
        expect(rows()).toBe(48);
      } finally {
        now.mockRestore();
      }
    });

    describe('in a browser that anchors scroll itself', () => {
      beforeEach(() => browserAnchors(true));
      afterEach(restoreCSS);

      it('writes no scroll position for a reader anywhere below the top', async () => {
        const write = jest.fn();
        let top = 5000;
        Object.defineProperty(container, 'scrollTop', {
          get: () => top,
          set: (value: number) => {
            write(value);
            top = value;
          },
          configurable: true,
        });
        render(<Reading />, { container });
        await mountLongMessage();
        expect(container.getElementsByClassName('message-render')).toHaveLength(48);
        expect(write).not.toHaveBeenCalled();
      });

      /** Scroll anchoring selects no anchor at the scroll origin. A reader who scrolled past
       *  the rows mounted so far is there, and nothing else would hold the row they reached. */
      it('holds a reader at the very top itself', async () => {
        container.scrollTop = 0;
        render(<Reading />, { container });
        await mountLongMessage();
        expect(container.scrollTop).toBe(CLAMPED);
      });
    });

    it('leaves a reader on the end where the browser put them as the content shrank', async () => {
      /** The content ends where the reader is, so the scroll position cannot stay past it. */
      onClamp = () => {
        container.scrollTop = 5000 + CLAMPED;
      };
      render(<Reading />, { container });
      await mountLongMessage();
      expect(container.scrollTop).toBe(5000 + CLAMPED);
    });

    /**
     * `finishProgressiveRowMounts` and `completeProgressiveRowMounts` land the rest of the
     * thread above the reader in the commit that also ends the window, which is the commit the
     * scroller starts anchoring again in. Whether the browser holds the reader through it is
     * not something the mount can know beforehand, so it looks: the row is put back where it
     * sat when it is not there, and left alone when it is.
     */
    describe('through the commit that finishes the mount', () => {
      afterEach(restoreCSS);

      /** Every row still to come, the long message among them, and the microtask after. */
      const finish = () =>
        act(async () => {
          finishProgressiveRowMounts();
        });

      const rows = () => container.getElementsByClassName('message-render').length;

      /**
       * A browser whose anchoring holds the reader: by the time anything can measure it, the
       * scroll position has moved by what landed above them. Returns what records a position
       * written on top of that.
       */
      const browserHolds = () => {
        const write = jest.fn();
        Object.defineProperty(container, 'scrollTop', {
          get: () => 5000 + anchorOffset - 100,
          set: write,
          configurable: true,
        });
        return write;
      };

      it.each([false, true])(
        'puts the reader back where the browser does not anchor (reply in flight: %s)',
        async (isSubmitting) => {
          browserAnchors(false);
          render(<Reading isSubmitting={isSubmitting} />, { container });
          expect(rows()).toBe(16);
          await finish();
          expect(rows()).toBe(60);
          expect(container.scrollTop).toBe(5000 + CLAMPED);
        },
      );

      it.each([false, true])(
        'writes no scroll position where the browser held the reader, and says what landed above them (reply in flight: %s)',
        async (isSubmitting) => {
          browserAnchors(true);
          Object.defineProperty(container, 'scrollHeight', {
            get: () => 1000 + (rows() - 16) * 30,
            configurable: true,
          });
          const write = browserHolds();
          const added = jest.fn();
          render(<Reading isSubmitting={isSubmitting} onInsertAbove={added} />, { container });
          await finish();
          expect(rows()).toBe(60);
          expect(write).not.toHaveBeenCalled();
          expect(added).toHaveBeenCalledTimes(1);
          expect(added).toHaveBeenCalledWith(44 * 30);
        },
      );

      /**
       * WebKit beside a reply: the scroller's anchoring was off while the mount held the reader,
       * and the browser holds nothing through the commit that turns it back on.
       */
      it.each([false, true])(
        'puts the reader back where a browser that anchors did not hold them (reply in flight: %s)',
        async (isSubmitting) => {
          browserAnchors(true);
          render(<Reading isSubmitting={isSubmitting} />, { container });
          await finish();
          expect(rows()).toBe(60);
          expect(container.scrollTop).toBe(5000 + CLAMPED);
        },
      );

      /** Scroll anchoring selects no anchor at the scroll origin. */
      it.each([false, true])(
        'puts a reader at the very top back (browser anchors: %s)',
        async (anchors) => {
          browserAnchors(anchors);
          container.scrollTop = 0;
          render(<Reading />, { container });
          await finish();
          expect(container.scrollTop).toBe(CLAMPED);
        },
      );

      it('holds the reader the same way for a consumer that waits for the paint', async () => {
        browserAnchors(true);
        render(<Reading isSubmitting />, { container });
        await act(async () => {
          void completeProgressiveRowMounts();
        });
        expect(rows()).toBe(60);
        expect(container.scrollTop).toBe(5000 + CLAMPED);
      });
    });
  });

  /**
   * Chromium keeps a scroll position in whole pixels, and rows are not whole pixels tall.
   * Beside a reply in flight a step lands on every frame, so whatever each one leaves out of
   * the position adds up: the row a reader is on sinks a little with every step.
   */
  describe('holding the reader to the pixel over many steps', () => {
    /** Four of these to a step: 100.375px, which no scroll position can move by. */
    const ROW = 25.09375;
    const START = 5000;
    /** Rows that are some other height, by depth. */
    const heights = new Map<number, number>();
    let container: HTMLDivElement;
    let rect: jest.SpyInstance;
    let top: number;
    /** How the browser turns what it is asked for into a position it can hold. */
    let snap: (value: number) => number;
    /** The end of the scroll range. */
    let limit: number;

    beforeEach(() => {
      heights.clear();
      top = START;
      snap = Math.round;
      limit = Number.POSITIVE_INFINITY;
      container = document.createElement('div');
      document.body.appendChild(container);
      Object.defineProperty(container, 'scrollTop', {
        get: () => top,
        set: (value: number) => {
          top = Math.min(limit, Math.max(0, snap(value)));
        },
        configurable: true,
      });
      /** Each row sits below the rows mounted above it. */
      rect = jest.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
        this: Element,
      ) {
        let offset = 100;
        for (const row of Array.from(container.getElementsByClassName('message-render'))) {
          if (row === this) {
            break;
          }
          offset += heights.get(Number((row as HTMLElement).dataset.depth)) ?? ROW;
        }
        return { top: offset - top } as DOMRect;
      });
    });

    afterEach(() => {
      rect.mockRestore();
      container.remove();
    });

    /** Mounts taller than it stays, as a long user turn does: clamped in a layout effect. */
    function Settling({ depth, to }: { depth: number; to: number }) {
      const [settled, setSettled] = React.useState(false);
      React.useLayoutEffect(() => setSettled(true), []);
      heights.set(depth, settled ? to : to + 500);
      return null;
    }
    const Message = React.memo(function Message({
      depth,
      settles,
    }: {
      depth: number;
      settles?: number;
    }) {
      if (!useRowMounted(depth)) {
        return null;
      }
      return (
        <div className="message-render" data-depth={depth}>
          {settles == null ? null : <Settling depth={depth} to={settles} />}
        </div>
      );
    });
    function Reading({
      conversationId = 'convo-a',
      settling,
    }: {
      conversationId?: string;
      /** The depth of a row that settles to another height, and the height. */
      settling?: [number, number];
    }) {
      const [gates] = React.useState(createRowGates);
      const ref = React.useRef(container);
      const mountWindow = useProgressiveRowMount({
        tailDepth: 59,
        anchorBottom: true,
        isSubmitting: true,
        conversationId,
        scrollableRef: ref,
        gates,
      });
      return (
        <RowMountProvider key={conversationId} mountWindow={mountWindow} gates={gates}>
          {Array.from({ length: 60 }, (_, depth) => (
            <Message
              key={depth}
              depth={depth}
              settles={settling?.[0] === depth ? settling[1] : undefined}
            />
          ))}
        </RowMountProvider>
      );
    }

    /** One step of four rows, and the microtask after its commit. */
    const mountStep = () =>
      act(async () => {
        const pending = frames.length;
        for (let index = 0; index < pending; index += 1) {
          const frame = frames[index];
          frames[index] = undefined;
          frame?.(index);
        }
      });
    const rows = () => container.getElementsByClassName('message-render');
    /** Where the row the reader is on sits on their screen: the thread's last. */
    const reading = () => rows()[rows().length - 1].getBoundingClientRect().top;

    it('keeps the row a reader is on where it was, though no step is a whole number of pixels', async () => {
      render(<Reading />, { container });
      const place = reading();
      for (let step = 1; step <= 11; step += 1) {
        await mountStep();
        expect(rows()).toHaveLength(16 + step * 4);
        /** Never further off than the half pixel a rounded position can be. */
        expect(Math.abs(reading() - place)).toBeLessThanOrEqual(0.5);
      }
      /** Every step's 0.375px is in the position: 44 rows are 1104.125px. */
      expect(top).toBe(START + 1104);
    });

    it('does the same where the browser drops the part of a pixel instead of rounding', async () => {
      snap = Math.floor;
      render(<Reading />, { container });
      const place = reading();
      for (let step = 1; step <= 11; step += 1) {
        await mountStep();
        expect(Math.abs(reading() - place)).toBeLessThan(1);
      }
      expect(top).toBe(START + 1104);
    });

    it('holds a reader whose position a browser can keep exactly, as before', async () => {
      snap = (value) => value;
      render(<Reading />, { container });
      const place = reading();
      for (let step = 1; step <= 11; step += 1) {
        await mountStep();
        expect(reading()).toBe(place);
      }
    });

    it('starts again from the position a reader scrolls to', async () => {
      render(<Reading />, { container });
      await mountStep();
      expect(top).toBe(START + 100);

      /** The reader moves: what the last step left out belonged to where they were. */
      top = 4000;
      await mountStep();
      expect(top).toBe(4100);

      /** And from there on the steps add up again: two are 200.75px. */
      await mountStep();
      expect(top).toBe(4201);
    });

    it('counts a row that settles to another height after its step at the height it settled to', async () => {
      /** In the second step, 500px taller as it mounts than the 40.6875px it stays. */
      render(<Reading settling={[38, 40.6875]} />, { container });
      const place = reading();
      for (let step = 1; step <= 11; step += 1) {
        await mountStep();
        expect(Math.abs(reading() - place)).toBeLessThanOrEqual(0.5);
      }
      /** 43 rows and the settled one: 1119.71875px. */
      expect(top).toBe(START + 1120);
    });

    it('makes up nothing a later step cannot have been short of: the end of the scroll range', async () => {
      /** The thread ends 50px on, and the browser stops the position there. */
      limit = START + 50;
      render(<Reading />, { container });
      await mountStep();
      expect(top).toBe(START + 50);

      /** With room again, the next step moves by its own rows and no more. */
      limit = Number.POSITIVE_INFINITY;
      await mountStep();
      expect(top).toBe(START + 150);
    });

    it('carries nothing from one conversation into the next', async () => {
      const { rerender } = render(<Reading />, { container });
      await mountStep();
      expect(top).toBe(START + 100);

      /** The next thread opens on the same scroller, which happens to be where the last
       *  step left it. */
      rerender(<Reading conversationId="convo-b" />);
      expect(rows()).toHaveLength(16);
      await mountStep();
      expect(rows()).toHaveLength(20);
      expect(top).toBe(START + 200);
    });
  });

  it('follows the window a commit later when nothing publishes to the gates', () => {
    const tree = (mountWindow: RowMountWindow) => (
      <RowMountProvider mountWindow={mountWindow}>
        <Row depth={0} />
        <Row depth={1} />
      </RowMountProvider>
    );
    const { container, rerender } = render(tree({ start: 1, end: 1 }));
    expect(mounted(container)).toEqual([1]);
    rerender(tree({ start: 0, end: 1 }));
    expect(mounted(container)).toEqual([0, 1]);
  });
});

describe('useWidenedRow', () => {
  function Row({ id }: { id: string }) {
    return <div data-testid={id} data-widened={useWidenedRow()} />;
  }

  const thread = (mountWindow: RowMountWindow, ids: string[]) => (
    <RowMountProvider mountWindow={mountWindow}>
      {ids.map((id) => (
        <Row key={id} id={id} />
      ))}
    </RowMountProvider>
  );

  it('tells the rows a widening step adds from the ones the thread opened on', () => {
    const opened: RowMountWindow = { start: 252, end: Number.POSITIVE_INFINITY };
    const { getByTestId, rerender } = render(thread(opened, ['tail']));
    expect(getByTestId('tail').dataset.widened).toBe('false');

    rerender(thread({ start: 220, end: Number.POSITIVE_INFINITY }, ['tail', 'earlier']));
    expect(getByTestId('earlier').dataset.widened).toBe('true');
    /** Fixed for the row's life: the rows it opened on do not change sides. */
    expect(getByTestId('tail').dataset.widened).toBe('false');

    /** The whole thread mounted: a turn arriving now arrives where the reader is. */
    rerender(thread(null, ['tail', 'earlier', 'arrived']));
    expect(getByTestId('arrived').dataset.widened).toBe('false');
    expect(getByTestId('earlier').dataset.widened).toBe('true');
  });

  it('is false in a thread mounted whole and outside any thread', () => {
    const whole = render(thread(null, ['row']));
    expect(whole.getByTestId('row').dataset.widened).toBe('false');
    whole.unmount();

    const { getByTestId } = render(<Row id="lone" />);
    expect(getByTestId('lone').dataset.widened).toBe('false');
  });
});
