import React from 'react';
import { RecoilRoot, useRecoilValue } from 'recoil';
import { renderHook, act } from '@testing-library/react';
import { MOBILE_DRAWER_ID } from '~/components/UnifiedSidebar/constants';
import useSidebarToggle from '../useSidebarToggle';
import useDrawerSwipe from '../useDrawerSwipe';
import store from '~/store';

/**
 * Exercises the real seam: useSidebarToggle must start the drawer slide
 * through the swipe hook's animator BEFORE the Recoil flip commits, defer
 * follow-up work past the slide, and fall back to immediate application when
 * the animator is not active (desktop).
 */
const setup = (enabled: boolean, rafMode: 'sync' | 'captured' = 'sync') => {
  const pane = document.createElement('div');
  const drawer = document.createElement('div');
  drawer.id = MOBILE_DRAWER_ID;
  Object.defineProperty(drawer, 'clientWidth', { value: 375, configurable: true });
  document.body.append(pane, drawer);

  jest.spyOn(window, 'matchMedia').mockReturnValue({
    matches: false,
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
  } as unknown as MediaQueryList);
  const queued: FrameRequestCallback[] = [];
  jest
    .spyOn(window, 'requestAnimationFrame')
    .mockImplementation((callback: FrameRequestCallback) => {
      if (rafMode === 'sync') {
        callback(0);
        return 0;
      }
      queued.push(callback);
      return queued.length;
    });
  const flushFrames = () => {
    while (queued.length) {
      queued.shift()?.(0);
    }
  };

  const paneRef = { current: pane };
  /** The atom defaults to true (desktop); every scenario here starts from a
   *  CLOSED mobile drawer, so seed it closed. */
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <RecoilRoot initializeState={({ set }) => set(store.sidebarExpanded, false)}>
      {children}
    </RecoilRoot>
  );
  const rendered = renderHook(
    () => {
      useDrawerSwipe({ paneRef, enabled, open: false, onOpenChange: jest.fn() });
      return {
        toggle: useSidebarToggle(),
        expanded: useRecoilValue(store.sidebarExpanded),
      };
    },
    { wrapper },
  );

  return {
    ...rendered,
    drawer,
    flushFrames,
    cleanup: () => {
      rendered.unmount();
      pane.remove();
      drawer.remove();
    },
  };
};

describe('useSidebarToggle', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    document.getElementById(MOBILE_DRAWER_ID)?.remove();
    /** Committed flips persist through the atom's localStorage effect, which
     *  overrides the next test's `initializeState` seed. */
    localStorage.clear();
  });

  it('starts the drawer slide and reports the slide mode (mobile)', () => {
    jest.useFakeTimers();
    const harness = setup(true);

    let mode = '';
    act(() => {
      mode = harness.result.current.toggle.setSidebarOpen(true);
    });

    expect(mode).toBe('slide');
    expect(harness.drawer.style.transform).toBe('translate3d(0, 0, 0)');
    expect(harness.result.current.expanded).toBe(true);
    jest.useRealTimers();
    harness.cleanup();
  });

  it('flips state immediately without animating when the hook is disabled (desktop)', () => {
    const harness = setup(false);

    let mode = '';
    act(() => {
      mode = harness.result.current.toggle.setSidebarOpen(true);
    });

    expect(mode).toBe('none');
    expect(harness.drawer.style.transform).toBe('');
    expect(harness.result.current.expanded).toBe(true);
    harness.cleanup();
  });

  it('defers afterSlide past the slide frames on mobile', () => {
    const harness = setup(true, 'captured');

    const afterSlide = jest.fn();
    act(() => {
      harness.result.current.toggle.setSidebarOpen(true, afterSlide);
    });
    expect(afterSlide).not.toHaveBeenCalled();

    act(() => {
      harness.flushFrames();
    });
    expect(afterSlide).toHaveBeenCalledTimes(1);
    harness.cleanup();
  });

  it('runs afterSlide immediately on desktop', () => {
    const harness = setup(false);

    const afterSlide = jest.fn();
    act(() => {
      harness.result.current.toggle.setSidebarOpen(true, afterSlide);
    });

    expect(afterSlide).toHaveBeenCalledTimes(1);
    harness.cleanup();
  });

  /** The user action carried by afterSlide (navigation, focus) must survive
   *  an animator teardown mid-deferral — only the sidebar flip goes stale. */
  it('still runs afterSlide when the animator is torn down mid-deferral', () => {
    const harness = setup(true, 'captured');

    const afterSlide = jest.fn();
    act(() => {
      harness.result.current.toggle.setSidebarOpen(true, afterSlide);
    });
    harness.rerender();
    harness.cleanup();
    act(() => {
      harness.flushFrames();
    });

    expect(afterSlide).toHaveBeenCalledTimes(1);
  });

  /** Two presses inside the deferral window must alternate — the second
   *  inverts the pending target, not the still-uncommitted atom value. */
  it('alternates rapid toggles instead of piling onto the same direction', () => {
    const harness = setup(true, 'captured');

    act(() => {
      harness.result.current.toggle.toggleSidebar();
      harness.result.current.toggle.toggleSidebar();
    });
    act(() => {
      harness.flushFrames();
    });

    expect(harness.result.current.expanded).toBe(false);
    expect(harness.drawer.style.transform).toBe('translate3d(-100%, 0, 0)');
    harness.cleanup();
  });
});
