import { renderHook } from '@testing-library/react';
import useDrawerSwipe, {
  findHorizontalScrollBlocker,
  getPendingDrawerFlip,
  kickDrawerAnimation,
  setDrawerSlideListener,
} from '../useDrawerSwipe';
import {
  DRAWER_UNPAINTED,
  MOBILE_DRAWER_ID,
  MOBILE_PANE_SHIFT,
  MOBILE_SCRIM_ID,
  TRANSITION_MS,
} from '~/components/UnifiedSidebar/constants';

/** Mirrors the hook's own settle buffer: the window between React writing the
 *  resting value and the release handing the inline styles back. */
const SETTLE_BUFFER_MS = 80;

const DRAWER_WIDTH = 375;

const createTouch = (x: number, y: number, identifier = 0) =>
  ({ clientX: x, clientY: y, identifier }) as Touch;

const touchEvent = (
  type: string,
  touches: Touch[],
  timeStamp: number,
  changedTouches?: Touch[],
): TouchEvent => {
  const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
  Object.defineProperty(event, 'touches', { value: touches });
  Object.defineProperty(event, 'changedTouches', {
    value: changedTouches ?? [createTouch(0, 0, 0)],
  });
  Object.defineProperty(event, 'timeStamp', { value: timeStamp });
  return event;
};

type Harness = {
  pane: HTMLDivElement;
  drawer: HTMLDivElement;
  onOpenChange: jest.Mock;
  swipe: (
    surface: HTMLElement,
    points: Array<{ x: number; y: number; t: number; target?: Element }>,
    end?: boolean,
  ) => TouchEvent[];
  rerender: (props: { open: boolean; enabled: boolean }) => void;
  unmount: () => void;
};

/** Default: the drawer covers the viewport, which is the shipped default. Pass
 *  a wider viewport to model the strip setting, where it does not. */
const setup = (open: boolean, reducedMotion = false, viewportWidth = DRAWER_WIDTH): Harness => {
  const pane = document.createElement('div');
  const drawer = document.createElement('div');
  drawer.id = MOBILE_DRAWER_ID;
  Object.defineProperty(drawer, 'clientWidth', { value: DRAWER_WIDTH, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: viewportWidth, configurable: true });
  document.body.append(pane, drawer);

  jest.spyOn(window, 'matchMedia').mockReturnValue({
    matches: reducedMotion,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as MediaQueryList);
  jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });

  const onOpenChange = jest.fn();
  const paneRef = { current: pane };
  const { unmount, rerender } = renderHook(
    (props: { open: boolean; enabled: boolean }) =>
      useDrawerSwipe({ paneRef, enabled: props.enabled, open: props.open, onOpenChange }),
    { initialProps: { open, enabled: true } },
  );

  const swipe: Harness['swipe'] = (surface, points, end = true) => {
    const events: TouchEvent[] = [];
    points.forEach(({ x, y, t, target }, index) => {
      const event = touchEvent(index === 0 ? 'touchstart' : 'touchmove', [createTouch(x, y)], t);
      (target ?? surface).dispatchEvent(event);
      events.push(event);
    });
    if (end) {
      const last = points[points.length - 1];
      surface.dispatchEvent(touchEvent('touchend', [], last.t + 16));
    }
    return events;
  };

  return {
    pane,
    drawer,
    onOpenChange,
    swipe,
    rerender,
    unmount: () => {
      unmount();
      pane.remove();
      drawer.remove();
    },
  };
};

function attachScrim(opacity: string) {
  const scrim = document.createElement('button');
  scrim.id = MOBILE_SCRIM_ID;
  scrim.style.opacity = opacity;
  document.body.append(scrim);
  return scrim;
}

afterEach(() => {
  document.getElementById(MOBILE_DRAWER_ID)?.remove();
  document.getElementById(MOBILE_SCRIM_ID)?.remove();
});

describe('useDrawerSwipe — opening from the chat pane', () => {
  it('follows the finger and commits past the distance threshold', () => {
    const harness = setup(false);
    const events = harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 120, y: 104, t: 50 },
        { x: 220, y: 108, t: 100 },
      ],
      false,
    );

    expect(events[1].defaultPrevented).toBe(true);
    expect(harness.drawer.style.transform).toBe(`translate3d(${200 - DRAWER_WIDTH}px, 0, 0)`);
    expect(harness.pane.style.transform).toBe('translate3d(200px, 0, 0)');
    expect(harness.drawer.style.transition).toBe('none');

    harness.pane.dispatchEvent(touchEvent('touchend', [], 120));

    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    expect(harness.drawer.style.transform).toBe('translate3d(0, 0, 0)');
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    harness.unmount();
  });

  it('reverts a slow swipe released under the threshold', () => {
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 60, y: 100, t: 200 },
      { x: 80, y: 100, t: 400 },
    ]);

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(harness.pane.style.transform).toBe('translate3d(0, 0, 0)');
    harness.unmount();
  });

  it('commits a fast flick that never reaches the distance threshold', () => {
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 50, y: 100, t: 20 },
      { x: 80, y: 100, t: 40 },
    ]);

    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    harness.unmount();
  });

  it('cedes the touch to vertical scrolling once the axis locks that way', () => {
    const harness = setup(false);
    const events = harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 24, y: 140, t: 50 },
      { x: 90, y: 180, t: 100 },
    ]);

    expect(events[1].defaultPrevented).toBe(false);
    expect(events[2].defaultPrevented).toBe(false);
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    harness.unmount();
  });

  it('defers to a horizontal scroller that can still pan the same way', () => {
    const harness = setup(false);
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'scrollWidth', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
    scroller.scrollLeft = 120;
    harness.pane.append(scroller);

    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0, target: scroller },
      { x: 220, y: 100, t: 50, target: scroller },
      { x: 260, y: 100, t: 100, target: scroller },
    ]);

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('');
    harness.unmount();
  });

  it('claims the drag when that scroller is already parked at its edge', () => {
    const harness = setup(false);
    const scroller = document.createElement('div');
    scroller.style.overflowX = 'auto';
    Object.defineProperty(scroller, 'scrollWidth', { value: 600, configurable: true });
    Object.defineProperty(scroller, 'clientWidth', { value: 300, configurable: true });
    scroller.scrollLeft = 0;
    harness.pane.append(scroller);

    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0, target: scroller },
      { x: 220, y: 100, t: 50, target: scroller },
    ]);

    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    harness.unmount();
  });

  it('never claims a drag that starts in a text surface', () => {
    const harness = setup(false);
    const textarea = document.createElement('textarea');
    harness.pane.append(textarea);

    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0, target: textarea },
      { x: 220, y: 100, t: 50, target: textarea },
    ]);

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('');
    harness.unmount();
  });

  it('snaps without tracking under prefers-reduced-motion', () => {
    const harness = setup(false, true);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 240, y: 100, t: 50 },
    ]);

    expect(harness.drawer.style.transform).toBe('');
    expect(harness.pane.style.transform).toBe('');
    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    /** The snap must suppress the shared 300ms transition for the flip. */
    expect(harness.drawer.style.transition).toBe('none');
    expect(harness.pane.style.transition).toBe('none');
    harness.unmount();
  });

  /**
   * Nor once the flip settles: the strip setting changes the drawer's width
   * without passing through any of these paths, so a transition handed back
   * here would leave that change animating for a user who asked for none.
   */
  it('leaves no transition behind after a snap settles', () => {
    jest.useFakeTimers();
    const harness = setup(false, true);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 240, y: 100, t: 50 },
    ]);

    jest.runAllTimers();

    expect(harness.drawer.style.transition).toBe('none');
    expect(harness.pane.style.transition).toBe('none');
    jest.useRealTimers();
    harness.unmount();
  });

  it('reverts cleanly when the browser cancels the touch', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 220, y: 100, t: 50 },
      ],
      false,
    );
    harness.pane.dispatchEvent(touchEvent('touchcancel', [], 80));

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    harness.unmount();
  });
});

describe('useDrawerSwipe — closing from the drawer', () => {
  it('closes on a committed leftward swipe', () => {
    const harness = setup(true);
    harness.swipe(harness.drawer, [
      { x: 350, y: 100, t: 0 },
      { x: 250, y: 100, t: 50 },
      { x: 150, y: 100, t: 100 },
    ]);

    expect(harness.onOpenChange).toHaveBeenCalledWith(false);
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(harness.pane.style.transform).toBe('translate3d(0, 0, 0)');
    harness.unmount();
  });

  it('starts the scrim fade when a swipe commits the close', () => {
    const harness = setup(true, false, Math.round(DRAWER_WIDTH / 0.8));
    const scrim = attachScrim('1');
    harness.swipe(harness.drawer, [
      { x: 350, y: 100, t: 0 },
      { x: 250, y: 100, t: 50 },
      { x: 150, y: 100, t: 100 },
    ]);

    expect(scrim.style.opacity).toBe('0');
    expect(harness.onOpenChange).toHaveBeenCalledWith(false);
    harness.unmount();
  });

  it('ignores a rightward swipe while already open', () => {
    const harness = setup(true);
    harness.swipe(harness.drawer, [
      { x: 50, y: 100, t: 0 },
      { x: 250, y: 100, t: 50 },
    ]);

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    harness.unmount();
  });
});

describe('useDrawerSwipe — interruptions and re-arming', () => {
  it('cancels a stale settle when a button closes the drawer inside its window', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 220, y: 100, t: 50 },
    ]);
    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);

    harness.rerender({ open: true, enabled: true });
    harness.rerender({ open: false, enabled: true });
    expect(harness.pane.style.transform).toBe('');
    expect(harness.drawer.style.transform).toBe('');

    jest.runAllTimers();
    expect(harness.pane.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  it('keeps a settle that agrees with the state change it caused', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 220, y: 100, t: 50 },
    ]);

    harness.rerender({ open: true, enabled: true });
    expect(harness.drawer.style.transform).toBe('translate3d(0, 0, 0)');

    jest.runAllTimers();
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    expect(harness.drawer.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  it('ignores a second finger lifting mid-drag and settles only on full release', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 220, y: 100, t: 50 },
      ],
      false,
    );

    harness.pane.dispatchEvent(
      touchEvent('touchend', [createTouch(220, 100, 0)], 80, [createTouch(80, 200, 1)]),
    );
    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.pane.style.transform).toBe('translate3d(200px, 0, 0)');

    harness.pane.dispatchEvent(touchEvent('touchend', [], 100));
    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    harness.unmount();
  });

  it('releases drag styles when an external toggle interrupts a held drag', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 220, y: 100, t: 50 },
      ],
      false,
    );
    expect(harness.drawer.style.transition).toBe('none');

    harness.rerender({ open: true, enabled: true });
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.drawer.style.transition).not.toBe('none');
    /** React committed the open pane transform before this cleanup and will
     * not re-assert it — the release must restore it, not clear it. */
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    harness.unmount();
  });

  it('cancels a stale settle when crossing the breakpoint disables the hook', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 220, y: 100, t: 50 },
    ]);
    harness.rerender({ open: true, enabled: true });
    harness.rerender({ open: true, enabled: false });

    expect(harness.pane.style.transform).toBe('');
    jest.runAllTimers();
    expect(harness.pane.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  it('reverts when the initiating finger lifts while a second remains', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 220, y: 100, t: 50 },
      ],
      false,
    );

    harness.pane.dispatchEvent(
      touchEvent('touchend', [createTouch(80, 200, 1)], 80, [createTouch(220, 100, 0)]),
    );

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    harness.unmount();
  });

  it('expires flick momentum when the finger holds still before lifting', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 50, y: 100, t: 20 },
        { x: 80, y: 100, t: 40 },
      ],
      false,
    );
    harness.pane.dispatchEvent(touchEvent('touchend', [], 600));

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    harness.unmount();
  });

  it('arms itself when enabled flips true after the surfaces exist', () => {
    const harness = setup(false);
    harness.rerender({ open: false, enabled: false });
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 220, y: 100, t: 50 },
    ]);
    expect(harness.onOpenChange).not.toHaveBeenCalled();

    harness.rerender({ open: false, enabled: true });
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 200 },
      { x: 220, y: 100, t: 250 },
    ]);
    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    harness.unmount();
  });
});

describe('useDrawerSwipe — kickDrawerAnimation (button toggles)', () => {
  it('slides both elements before the state flip runs, then hands off to classes', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    /** The sync rAF mock collapses the two-frame deferral, so capturing the
     *  transform inside `applyState` proves the slide started first. */
    const transformAtApply: string[] = [];
    kickDrawerAnimation(true, () => {
      transformAtApply.push(harness.drawer.style.transform);
    });

    expect(transformAtApply).toEqual(['translate3d(0, 0, 0)']);
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    expect(harness.drawer.style.willChange).toBe('transform');
    expect(harness.onOpenChange).not.toHaveBeenCalled();

    harness.rerender({ open: true, enabled: true });
    expect(harness.drawer.style.transform).toBe('translate3d(0, 0, 0)');

    jest.runAllTimers();
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.drawer.style.willChange).toBe('');
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    jest.useRealTimers();
    harness.unmount();
  });

  it('applies state immediately when the hook is disabled (desktop width animation)', () => {
    const harness = setup(false);
    harness.rerender({ open: false, enabled: false });

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);

    expect(applyState).toHaveBeenCalledTimes(1);
    expect(harness.drawer.style.transform).toBe('');
    harness.unmount();
  });

  it('applies state immediately after unmount', () => {
    const harness = setup(false);
    harness.unmount();

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);

    expect(applyState).toHaveBeenCalledTimes(1);
  });

  it('retargets an in-flight slide when the user toggles back', () => {
    jest.useFakeTimers();
    const harness = setup(false);

    kickDrawerAnimation(true, jest.fn());
    harness.rerender({ open: true, enabled: true });
    kickDrawerAnimation(false, jest.fn());

    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    /** Retargeting to a close takes the reveal, since this drawer covers. */
    expect(harness.pane.style.transform).toBe('none');

    harness.rerender({ open: false, enabled: true });
    jest.runAllTimers();
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.pane.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  it('does not re-start a slide already heading to the same target', () => {
    jest.useFakeTimers();
    const harness = setup(false);

    kickDrawerAnimation(true, jest.fn());
    harness.drawer.style.transform = 'translate3d(-10px, 0, 0)';
    kickDrawerAnimation(true, jest.fn());

    expect(harness.drawer.style.transform).toBe('translate3d(-10px, 0, 0)');
    jest.useRealTimers();
    harness.unmount();
  });

  it('defers to a drag that owns the inline styles but still applies state', () => {
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 120, y: 104, t: 50 },
      ],
      false,
    );

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);

    expect(harness.pane.style.transform).toBe('translate3d(100px, 0, 0)');
    expect(applyState).toHaveBeenCalledTimes(1);
    harness.pane.dispatchEvent(touchEvent('touchend', [], 400));
    harness.unmount();
  });

  /**
   * The transition is not handed back after the snap either. The strip setting
   * changes the drawer's width without passing through this path, so a restored
   * transition would leave that one change animating for a user who asked for
   * no motion.
   */
  it('snaps under reduced motion and leaves no transition behind', () => {
    jest.useFakeTimers();
    const harness = setup(false, true);

    kickDrawerAnimation(true, jest.fn());

    expect(harness.drawer.style.transition).toBe('none');
    expect(harness.drawer.style.transform).toBe('');

    harness.rerender({ open: true, enabled: true });
    jest.runAllTimers();
    expect(harness.drawer.style.transition).toBe('none');
    expect(harness.pane.style.transition).toBe('none');
    jest.useRealTimers();
    harness.unmount();
  });

  /** The counterpart: with motion allowed, the surfaces do get them back. */
  it('hands the transitions back once a slide settles', () => {
    jest.useFakeTimers();
    const harness = setup(false);

    kickDrawerAnimation(true, jest.fn());
    harness.rerender({ open: true, enabled: true });
    jest.runAllTimers();

    expect(harness.drawer.style.transition).toContain('transform');
    expect(harness.pane.style.transition).toContain('transform');
    jest.useRealTimers();
    harness.unmount();
  });

  /** Deferring past the 80ms transition-restore window would let the state
   *  flip animate at full duration on a slow-frame device — for exactly the
   *  users who opted out of motion. */
  it('applies state synchronously under reduced motion, without frame deferral', () => {
    const harness = setup(false, true);
    (window.requestAnimationFrame as jest.Mock).mockImplementation(() => 0);

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);

    expect(applyState).toHaveBeenCalledTimes(1);
    harness.unmount();
  });

  it('drops a deferred state flip when the animator is torn down mid-deferral', () => {
    const harness = setup(false);
    const queued: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as jest.Mock).mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);
    harness.rerender({ open: false, enabled: false });
    while (queued.length) {
      queued.shift()?.(0);
    }

    expect(applyState).not.toHaveBeenCalled();
    expect(harness.drawer.style.transform).toBe('');
    harness.unmount();
  });

  /** The release deadline must run on the same clock as the staged frame:
   *  armed at kick time, a delayed first frame lets the wall-clock timeout
   *  clear the settle first, and the frame then aborts the slide. */
  it('waits for the staged frame before starting the release deadline', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    const queued: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as jest.Mock).mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });

    kickDrawerAnimation(true, jest.fn());
    jest.advanceTimersByTime(500);
    queued.shift()?.(0);

    expect(harness.drawer.style.transform).toBe('translate3d(0, 0, 0)');
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);

    harness.rerender({ open: true, enabled: true });
    jest.advanceTimersByTime(400);
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.pane.style.transform).toBe(MOBILE_PANE_SHIFT);
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * A reveal while the drawer covers the pane: repositioning instantly under an
   * opaque full-width layer is invisible, and animating the pane in from the
   * right instead makes every tap-to-navigate close visibly shift the chat
   * while the new conversation commits into the moving layer.
   */
  it('reveals rather than animating when the drawer covers the pane', () => {
    jest.useFakeTimers();
    const harness = setup(true);

    kickDrawerAnimation(false, jest.fn());

    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(harness.drawer.style.transition).not.toBe('none');
    expect(harness.pane.style.transform).toBe('none');
    expect(harness.pane.style.transition).toBe('none');

    harness.rerender({ open: false, enabled: true });
    jest.runAllTimers();
    expect(harness.drawer.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * With the strip enabled the drawer stops short of the edge, so that instant
   * reposition would land in the visible slice. Both surfaces animate together
   * instead, matching what a finger drag already produces.
   */
  /**
   * The pane tracks the drawer's width through its own transform, so a runtime
   * width change has to move on the same curve or the newly exposed slice has
   * no conversation under it for the length of the transition.
   */
  it('transitions the drawer width alongside its transform', () => {
    jest.useFakeTimers();
    const harness = setup(true, false, Math.round(DRAWER_WIDTH / 0.8));

    kickDrawerAnimation(false, jest.fn());

    expect(harness.drawer.style.transition).toContain('width');
    expect(harness.drawer.style.transition).toContain('transform');
    /** Flex-driven, and animating it would reach the desktop collapse too. */
    expect(harness.pane.style.transition).toContain('transform');
    expect(harness.pane.style.transition).not.toContain('width');
    jest.useRealTimers();
    harness.unmount();
  });

  it('animates both surfaces when a strip of chat is left visible', () => {
    jest.useFakeTimers();
    const harness = setup(true, false, Math.round(DRAWER_WIDTH / 0.8));

    kickDrawerAnimation(false, jest.fn());

    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    expect(harness.drawer.style.transition).not.toBe('none');
    expect(harness.pane.style.transform).toBe('translate3d(0, 0, 0)');
    expect(harness.pane.style.transition).not.toBe('none');

    harness.rerender({ open: false, enabled: true });
    jest.runAllTimers();
    expect(harness.pane.style.transition).not.toBe('none');
    expect(harness.drawer.style.transform).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  /** A superseded flip must never transiently commit the old direction —
   *  its commit would re-register the animator and get the NEWER flip
   *  dropped, stranding the drawer at the first intent. */
  it('discards a superseded deferred flip so only the latest intent commits', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    const queued: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as jest.Mock).mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });

    const applyOpen = jest.fn();
    const applyClose = jest.fn();
    kickDrawerAnimation(true, applyOpen);
    kickDrawerAnimation(false, applyClose);
    while (queued.length) {
      queued.shift()?.(0);
    }

    expect(applyOpen).not.toHaveBeenCalled();
    expect(applyClose).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    jest.useRealTimers();
    harness.unmount();
  });

  /** A desktop toggle right after a breakpoint cross must invert the
   *  committed value, not a leftover mobile intent. */
  it('clears the pending flip target when the animator tears down', () => {
    const harness = setup(false);
    const queued: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as jest.Mock).mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });

    kickDrawerAnimation(true, jest.fn());
    expect(getPendingDrawerFlip()).toBe(true);
    harness.rerender({ open: false, enabled: false });

    expect(getPendingDrawerFlip()).toBeNull();
    harness.unmount();
  });

  it('applies the deferred state flip when the animator is still live', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    const queued: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as jest.Mock).mockImplementation((callback) => {
      queued.push(callback);
      return queued.length;
    });

    const applyState = jest.fn();
    kickDrawerAnimation(true, applyState);
    while (queued.length) {
      queued.shift()?.(0);
    }

    expect(applyState).toHaveBeenCalledTimes(1);
    jest.runAllTimers();
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * The drawer slide starts in the kick's frame; Recoil commits three frames
   * later (longer on a large conversation). Driving the scrim from expanded
   * would leave it opaque over a drawer that has already gone, then fade it
   * for another 300ms.
   */
  it('starts the scrim fade with the drawer slide, before the state flip', () => {
    jest.useFakeTimers();
    const harness = setup(true, false, Math.round(DRAWER_WIDTH / 0.8));
    const scrim = attachScrim('1');
    const opacityAtApply: string[] = [];
    kickDrawerAnimation(false, () => {
      opacityAtApply.push(scrim.style.opacity);
    });

    expect(opacityAtApply).toEqual(['0']);
    jest.useRealTimers();
    harness.unmount();
  });

  it('starts the scrim fade-in with the open slide', () => {
    jest.useFakeTimers();
    const harness = setup(false, false, Math.round(DRAWER_WIDTH / 0.8));
    const scrim = attachScrim('0');
    const opacityAtApply: string[] = [];
    kickDrawerAnimation(true, () => {
      opacityAtApply.push(scrim.style.opacity);
    });

    expect(opacityAtApply).toEqual(['1']);
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * Recoil still has expanded=false for those three frames, so the class
   * pointer-events-none would leave the fading-in scrim click-through: a tap
   * on the exposed strip would hit a conversation control instead of dismiss.
   */
  it('captures pointer events on the scrim as soon as the open slide starts', () => {
    jest.useFakeTimers();
    const harness = setup(false, false, Math.round(DRAWER_WIDTH / 0.8));
    const scrim = attachScrim('0');
    scrim.style.pointerEvents = 'none';
    const pointerAtApply: string[] = [];
    kickDrawerAnimation(true, () => {
      pointerAtApply.push(scrim.style.pointerEvents);
    });

    expect(pointerAtApply).toEqual(['auto']);
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * A dismiss inside the opening settle window leaves that slide's override in
   * place, and inline styles beat the closed pointer-events-none class. The
   * guard expires at the animation deadline but the release runs a buffer
   * later, so the invisible scrim would keep swallowing taps in between.
   */
  it('releases the pointer override when the close slide starts', () => {
    jest.useFakeTimers();
    const harness = setup(true, false, Math.round(DRAWER_WIDTH / 0.8));
    const scrim = attachScrim('1');
    scrim.style.pointerEvents = 'auto';
    const pointerAtApply: string[] = [];
    kickDrawerAnimation(false, () => {
      pointerAtApply.push(scrim.style.pointerEvents);
    });

    expect(pointerAtApply).toEqual(['']);
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * Two toggles inside the three-frame flip window leave expanded false
   * throughout, so the dismiss guard sees no state transition to arm from. The
   * slide has to report itself or nothing covers the pane as it uncovers.
   */
  it('reports a close slide that cancels an uncommitted open', () => {
    jest.useFakeTimers();
    const harness = setup(false, false, Math.round(DRAWER_WIDTH / 0.8));
    const slides: boolean[] = [];
    setDrawerSlideListener((next) => slides.push(next));
    const frames: FrameRequestCallback[] = [];
    (window.requestAnimationFrame as unknown as jest.Mock).mockImplementation(
      (callback: FrameRequestCallback) => {
        frames.push(callback);
        return 0;
      },
    );
    const applyState = jest.fn();

    kickDrawerAnimation(true, applyState);
    frames.shift()?.(0);
    /** The deferred flip never reaches its third frame: the second kick lands
     *  first, which is the whole point of this path. */
    frames.length = 0;

    kickDrawerAnimation(false, applyState);
    frames.shift()?.(0);

    expect(applyState).not.toHaveBeenCalled();
    expect(slides).toEqual([true, false]);
    setDrawerSlideListener(null);
    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * The strip setting and a rotation both restart the drawer's width
   * transition, which then runs on its own clock. Driving the drawer's edge
   * from that clock and the pane's from the close would open a gap between
   * the two surfaces for the rest of the slide.
   */
  it('pins the drawer width to the close slide and hands it back on open', () => {
    jest.useFakeTimers();
    const viewportWidth = Math.round(DRAWER_WIDTH / 0.8);
    const harness = setup(true, false, viewportWidth);

    kickDrawerAnimation(false, jest.fn());
    expect(harness.drawer.style.width).toBe(`${viewportWidth}px`);

    kickDrawerAnimation(true, jest.fn());
    expect(harness.drawer.style.width).not.toBe(`${viewportWidth}px`);

    jest.useRealTimers();
    harness.unmount();
  });

  /**
   * Dropping the transition on claim lands a width still easing toward the
   * strip target on that target in the same frame, so the touchstart snapshot
   * is stale. Both surfaces read it, so the stale value holds a gap open
   * between the drawer's edge and the pane for the rest of the drag.
   */
  it('remeasures the drawer width when a gesture claims mid width transition', () => {
    const harness = setup(false);
    Object.defineProperty(harness.drawer, 'clientWidth', { value: 340, configurable: true });
    harness.pane.dispatchEvent(touchEvent('touchstart', [createTouch(0, 0)], 0));
    Object.defineProperty(harness.drawer, 'clientWidth', { value: 300, configurable: true });

    harness.pane.dispatchEvent(touchEvent('touchmove', [createTouch(20, 0)], 16));
    harness.pane.dispatchEvent(touchEvent('touchmove', [createTouch(60, 0)], 32));

    expect(harness.drawer.style.transform).toBe('translate3d(-240px, 0, 0)');
    expect(harness.pane.style.transform).toBe('translate3d(60px, 0, 0)');
    harness.unmount();
  });
});

/**
 * A closed drawer is not painted at all (see UnifiedSidebar), so every path
 * that moves it has to claim painting for the travel and hand it back once the
 * slide is over: claimed too late the opening frames are invisible, released
 * too late — or never — and the settled drawer keeps the off-screen layer whose
 * stale tiles this is all here to avoid.
 */
describe('useDrawerSwipe — painting through the travel', () => {
  it('paints the drawer for a drag that opens it out of a closed state', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    harness.swipe(
      harness.pane,
      [
        { x: 20, y: 100, t: 0 },
        { x: 120, y: 104, t: 50 },
      ],
      false,
    );

    expect(harness.drawer.style.visibility).toBe('visible');

    harness.pane.dispatchEvent(touchEvent('touchend', [], 120));
    jest.runAllTimers();

    expect(harness.onOpenChange).toHaveBeenCalledWith(true);
    expect(harness.drawer.style.visibility).toBe('');
    jest.useRealTimers();
    harness.unmount();
  });

  /** The drawer never commits open here, so nothing else would ever resolve the
   *  inline override: the settle has to land on the closed value itself. */
  it('settles a drag that snaps back on the unpainted value', () => {
    jest.useFakeTimers();
    const harness = setup(false);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 60, y: 100, t: 200 },
      { x: 80, y: 100, t: 400 },
    ]);
    jest.runAllTimers();

    expect(harness.onOpenChange).not.toHaveBeenCalled();
    expect(harness.drawer.style.visibility).toBe(DRAWER_UNPAINTED);
    jest.useRealTimers();
    harness.unmount();
  });

  it.each([
    ['open', false, true, ''],
    ['close', true, false, DRAWER_UNPAINTED],
  ])(
    'paints a kicked %s slide before its state flip commits, then settles',
    (_name, open, next, settled) => {
      jest.useFakeTimers();
      const harness = setup(open);
      const visibilityAtApply: string[] = [];
      kickDrawerAnimation(next, () => {
        visibilityAtApply.push(harness.drawer.style.visibility);
      });

      expect(visibilityAtApply).toEqual(['visible']);

      jest.advanceTimersByTime(400);

      expect(harness.drawer.style.visibility).toBe(settled);
      jest.useRealTimers();
      harness.unmount();
    },
  );

  /**
   * The regression that made the first pass of this change a no-op for every
   * button and keyboard close. React owns the resting value and writes
   * `hidden` when the travel window closes at TRANSITION_MS; the release runs a
   * buffer later, and clearing the property there dropped that value while
   * React still believed its unchanged prop was applied — so React never wrote
   * it again and the settled, closed drawer was painted for the rest of the
   * session. Modelled the way the pane's transform already is: the declarative
   * value is in the DOM before the release, and the release must respect it.
   */
  it('leaves a settled close on the value React rendered, not cleared', () => {
    jest.useFakeTimers();
    const harness = setup(true);
    kickDrawerAnimation(false, () => undefined);
    /** What React writes once `isSliding` expires, mid-way through the buffer
     *  the release waits out. */
    jest.advanceTimersByTime(TRANSITION_MS);
    harness.drawer.style.visibility = DRAWER_UNPAINTED;

    jest.advanceTimersByTime(SETTLE_BUFFER_MS + 20);

    expect(harness.drawer.style.visibility).toBe(DRAWER_UNPAINTED);
    jest.useRealTimers();
    harness.unmount();
  });

  /** A gesture surviving into a new effect run was interrupted, and the run that
   *  inherits it resolves the drag styles to the state it finds rather than to
   *  the gesture's own target. That is the other path that can strand the
   *  claim — here an external close commits while a close drag is still held. */
  it('resolves an interrupted drag to the state that superseded it', () => {
    jest.useFakeTimers();
    const harness = setup(true);
    harness.swipe(
      harness.drawer,
      [
        { x: 350, y: 100, t: 0 },
        { x: 250, y: 100, t: 50 },
      ],
      false,
    );

    expect(harness.drawer.style.visibility).toBe('visible');

    harness.rerender({ open: false, enabled: true });

    expect(harness.drawer.style.visibility).toBe(DRAWER_UNPAINTED);
    jest.useRealTimers();
    harness.unmount();
  });

  /** Reduced motion has no travel to paint: the state flip is the whole
   *  transition, so nothing claims painting and React's value stands alone. */
  it('never claims painting under reduced motion', () => {
    jest.useFakeTimers();
    const harness = setup(false, true);
    harness.swipe(harness.pane, [
      { x: 20, y: 100, t: 0 },
      { x: 240, y: 100, t: 50 },
    ]);
    kickDrawerAnimation(false, jest.fn());
    jest.runAllTimers();

    expect(harness.drawer.style.visibility).not.toBe('visible');
    jest.useRealTimers();
    harness.unmount();
  });
});

describe('findHorizontalScrollBlocker', () => {
  const scroller = (scrollLeft: number) => {
    const el = document.createElement('div');
    el.style.overflowX = 'auto';
    Object.defineProperty(el, 'scrollWidth', { value: 600, configurable: true });
    Object.defineProperty(el, 'clientWidth', { value: 300, configurable: true });
    el.scrollLeft = scrollLeft;
    return el;
  };

  it('is direction-aware at either edge', () => {
    const boundary = document.createElement('div');
    const atStart = scroller(0);
    const child = document.createElement('span');
    atStart.append(child);
    boundary.append(atStart);

    expect(findHorizontalScrollBlocker(child, boundary, 1)).toBeNull();
    expect(findHorizontalScrollBlocker(child, boundary, -1)).toBe(atStart);

    const atEnd = scroller(300);
    const endChild = document.createElement('span');
    atEnd.append(endChild);
    boundary.append(atEnd);

    expect(findHorizontalScrollBlocker(endChild, boundary, 1)).toBe(atEnd);
    expect(findHorizontalScrollBlocker(endChild, boundary, -1)).toBeNull();
  });

  it('normalizes RTL scroll offsets before deciding', () => {
    const boundary = document.createElement('div');
    const rtl = scroller(0);
    rtl.style.direction = 'rtl';
    const child = document.createElement('span');
    rtl.append(child);
    boundary.append(rtl);

    expect(findHorizontalScrollBlocker(child, boundary, 1)).toBe(rtl);
    expect(findHorizontalScrollBlocker(child, boundary, -1)).toBeNull();

    rtl.scrollLeft = -300;
    expect(findHorizontalScrollBlocker(child, boundary, 1)).toBeNull();
    expect(findHorizontalScrollBlocker(child, boundary, -1)).toBe(rtl);
  });

  it('stops searching at the boundary element', () => {
    const outer = scroller(120);
    const boundary = document.createElement('div');
    const child = document.createElement('span');
    boundary.append(child);
    outer.append(boundary);

    expect(findHorizontalScrollBlocker(child, boundary, 1)).toBeNull();
  });
});
