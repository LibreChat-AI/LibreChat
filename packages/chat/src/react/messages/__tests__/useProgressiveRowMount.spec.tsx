/**
 * @jest-environment jsdom
 */
import React from 'react';
import { act, render, renderHook } from '@testing-library/react';
import type { RowMountWindow } from '../useProgressiveRowMount';
import {
  useWidenedRow,
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

  it('does not window when a submission is already active', () => {
    const { result } = setup({ isSubmitting: true });
    expect(result.current).toBeNull();
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

  it('completes immediately when a submission starts mid-expansion', () => {
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
