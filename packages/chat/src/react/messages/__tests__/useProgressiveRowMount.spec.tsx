/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import type { RowMountWindow } from '../useProgressiveRowMount';
import {
  useWidenedRow,
  useRowMounted,
  createRowGates,
  RowMountProvider,
  useProgressiveRowMount,
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
