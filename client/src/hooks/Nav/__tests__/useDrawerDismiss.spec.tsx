import { act, renderHook } from '@testing-library/react';
import {
  MOBILE_DRAWER_ID,
  MOBILE_DRAWER_TRANSITION,
  SIDEBAR_TRANSITION,
  TRANSITION_MS,
} from '~/components/UnifiedSidebar/constants';
import { markDrawerAnimationStart, notifyDrawerSlide } from '../useDrawerSwipe';
import { OPEN_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';
import useDrawerDismiss from '../useDrawerDismiss';

type Props = {
  expanded: boolean;
  isSmallScreen: boolean;
  prefersReducedMotion: boolean;
};

/**
 * Defaults to a pane the close is animating, which is the shape the pointer
 * guard exists for. Pass `none` to model the reveal close, where the pane is
 * repositioned instantly and never moves under the user.
 */
function setup({
  expanded,
  isSmallScreen,
  prefersReducedMotion = false,
  paneTransition = SIDEBAR_TRANSITION,
  drawerTransition = MOBILE_DRAWER_TRANSITION,
}: Omit<Props, 'prefersReducedMotion'> & {
  prefersReducedMotion?: boolean;
  paneTransition?: string;
  drawerTransition?: string;
}) {
  const pane = document.createElement('div');
  pane.tabIndex = -1;
  pane.style.transition = paneTransition;
  const drawer = document.createElement('div');
  drawer.id = MOBILE_DRAWER_ID;
  drawer.style.transition = drawerTransition;
  document.body.append(pane, drawer);
  const paneRef: React.RefObject<HTMLElement> = { current: pane };
  const setOpen = jest.fn();

  const view = renderHook((props: Props) => useDrawerDismiss({ ...props, paneRef, setOpen }), {
    initialProps: { expanded, isSmallScreen, prefersReducedMotion },
  });

  return { ...view, pane, setOpen };
}

function addOpener() {
  const opener = document.createElement('button');
  opener.id = OPEN_SIDEBAR_ID;
  document.body.appendChild(opener);
  return opener;
}

function clickScrim(onScrimClick: (event: React.MouseEvent<HTMLElement>) => void) {
  const scrim = document.createElement('button');
  document.body.appendChild(scrim);
  scrim.focus();
  act(() => {
    onScrimClick({ currentTarget: scrim } as unknown as React.MouseEvent<HTMLElement>);
  });
  return scrim;
}

describe('useDrawerDismiss', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    markDrawerAnimationStart(null);
    jest.restoreAllMocks();
    jest.useRealTimers();
    document.body.innerHTML = '';
  });

  describe('the pointer guard', () => {
    it('holds the scrim through the close transition', () => {
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });
      expect(result.current.isSliding).toBe(false);

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });
      expect(result.current.isSliding).toBe(false);
    });

    /**
     * Crossing to mobile derives the drawer closed with nothing to animate, so
     * arming here would leave a transparent full-screen scrim over the whole
     * viewport, swallowing every tap for the length of the guard.
     */
    it('does not arm when an expanded desktop sidebar crosses into mobile', () => {
      const { result, rerender } = setup({ expanded: true, isSmallScreen: false });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(false);
    });

    /**
     * The reveal close repositions the pane instantly, but the drawer is still
     * sliding away. Dropping inert on the pane at the Recoil commit would let
     * a second tap hit a conversation control as it uncovers.
     */
    it('arms through a reveal close while the drawer is still sliding', () => {
      const { result, rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        paneTransition: 'none',
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(true);
    });

    it('does not arm when neither surface is transitioning', () => {
      const { result, rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        paneTransition: 'none',
        drawerTransition: 'none',
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(false);
    });

    /**
     * The slide started at kick time; a delayed Recoil commit must not add a
     * fresh 300ms of pointer-blocking after the surfaces have already settled.
     */
    it('holds the guard only for the time left on the animation deadline', () => {
      markDrawerAnimationStart(0);
      jest.spyOn(performance, 'now').mockReturnValue(200);
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);

      act(() => {
        jest.advanceTimersByTime(100);
      });
      expect(result.current.isSliding).toBe(false);
    });

    it('does not arm when the animation deadline has already passed', () => {
      markDrawerAnimationStart(0);
      jest.spyOn(performance, 'now').mockReturnValue(TRANSITION_MS + 50);
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(false);
    });

    /**
     * A swipe animates the pane at any drawer width, so reading the width
     * instead of the pane left the default configuration unguarded through the
     * one close path that does move it.
     */
    it('arms for a close that animates the pane behind a full-width drawer', () => {
      const { result, rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        paneTransition: SIDEBAR_TRANSITION,
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(true);
    });

    it('does not arm under reduced motion, where both surfaces snap', () => {
      const { result, rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        prefersReducedMotion: true,
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: true });

      expect(result.current.isSliding).toBe(false);
    });

    it('releases the guard when the viewport crosses to desktop mid-close', () => {
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });
      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);

      rerender({ expanded: false, isSmallScreen: false, prefersReducedMotion: false });

      expect(result.current.isSliding).toBe(false);
    });
  });

  describe('focus after the close', () => {
    it('hands focus to the opener when the close dropped it', () => {
      const opener = addOpener();
      const { rerender } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(document.activeElement).toBe(opener);
    });

    /**
     * The guard puts `inert` back on the pane for its duration, and both the
     * opener and the pane itself sit inside it, so a handoff made at the commit
     * would be ejected to the body with nothing left to run it again.
     */
    it('waits for the close guard to release before handing focus over', () => {
      const opener = addOpener();
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);
      expect(document.activeElement).toBe(document.body);

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(result.current.isSliding).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    /** Every close path goes through the committed state, not just the scrim. */
    it('restores focus under reduced motion too', () => {
      const opener = addOpener();
      const { rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        prefersReducedMotion: true,
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: true });

      expect(document.activeElement).toBe(opener);
    });

    /**
     * A route that returns a loading or error state before its header renders
     * has no opener, while the shortcut and the pane swipe still open the
     * drawer.
     */
    it('falls back to the pane when the route renders no opener', () => {
      const { rerender, pane } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(document.activeElement).toBe(pane);
    });

    it('leaves focus alone when something else took it deliberately', () => {
      addOpener();
      const composer = document.createElement('textarea');
      document.body.appendChild(composer);
      const { rerender } = setup({ expanded: true, isSmallScreen: true });
      composer.focus();

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(document.activeElement).toBe(composer);
    });

    /**
     * The drawer's own Escape handler closes it without going through the
     * scrim, so a keyboard user who tabbed to the scrim keeps focus on it as it
     * becomes aria-hidden and untabbable.
     */
    it('reclaims focus from the scrim when Escape closed the drawer', () => {
      const opener = addOpener();
      const scrim = document.createElement('button');
      document.body.appendChild(scrim);
      const { rerender } = setup({ expanded: true, isSmallScreen: true });
      scrim.focus();
      scrim.setAttribute('aria-hidden', 'true');
      scrim.tabIndex = -1;

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(document.activeElement).toBe(opener);
    });

    /**
     * The expanded desktop sidebar is replaced by the closed mobile drawer, so
     * focus inside it is dropped. The guard is right to stay disarmed there,
     * since nothing animates, but the focus handoff still has to run.
     */
    it('restores focus when an expanded desktop sidebar crosses into mobile', () => {
      const opener = addOpener();
      const { result, rerender } = setup({ expanded: true, isSmallScreen: false });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      expect(document.activeElement).toBe(opener);
      expect(result.current.isSliding).toBe(false);
    });

    it('restores focus on a close that snaps under reduced motion', () => {
      const opener = addOpener();
      const { rerender } = setup({
        expanded: true,
        isSmallScreen: true,
        prefersReducedMotion: true,
      });

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: true });

      expect(document.activeElement).toBe(opener);
    });

    /**
     * Leaving mobile unmounts the drawer and the scrim, so focus sitting on
     * either goes with them. The opener stays mounted across breakpoints but is
     * hidden on desktop, where focusing it does nothing, so the pane takes it.
     */
    it('hands focus to the pane when the viewport leaves mobile', () => {
      const opener = addOpener();
      /** Hidden the way the header hides it at this breakpoint. */
      opener.focus = () => undefined;
      const { rerender, pane } = setup({ expanded: true, isSmallScreen: true });

      rerender({ expanded: true, isSmallScreen: false, prefersReducedMotion: false });

      expect(document.activeElement).toBe(pane);
    });

    /**
     * A dependency change cancels the guard and takes its timer, and with it
     * the handoff, before the replacement run can see the close: its
     * `wasExpanded` is already false. The debt has to survive that.
     */
    it('hands focus over when a motion-preference change cancels the guard', () => {
      const opener = addOpener();
      const { result, rerender } = setup({ expanded: true, isSmallScreen: true });
      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: true });

      expect(result.current.isSliding).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    it('reclaims focus stranded inside the drawer once it goes inert', () => {
      const opener = addOpener();
      const drawer = document.createElement('div');
      drawer.setAttribute('inert', '');
      const close = document.createElement('button');
      drawer.appendChild(close);
      document.body.appendChild(drawer);
      const { rerender } = setup({ expanded: true, isSmallScreen: true });
      close.focus();

      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(document.activeElement).toBe(opener);
    });
  });

  describe('a slide the committed state never reports', () => {
    /**
     * A second toggle inside the deferred flip retargets the slide without
     * `expanded` ever having flipped, and an open drag that falls short snaps
     * both surfaces back the same way. The pane moves either way, so the guard
     * has to cover it.
     */
    it('arms for a close slide that never committed an open', () => {
      const { result } = setup({ expanded: false, isSmallScreen: true });

      act(() => {
        notifyDrawerSlide(false);
      });

      expect(result.current.isSliding).toBe(true);

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });
      expect(result.current.isSliding).toBe(false);
    });

    it('hands focus over when that guard releases', () => {
      const opener = addOpener();
      const { result } = setup({ expanded: false, isSmallScreen: true });

      act(() => {
        notifyDrawerSlide(false);
      });
      expect(document.activeElement).toBe(document.body);

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(result.current.isSliding).toBe(false);
      expect(document.activeElement).toBe(opener);
    });

    /** The committed close arms above, for what is LEFT of the motion. */
    it('leaves a committed close to the state transition', () => {
      const { result } = setup({ expanded: true, isSmallScreen: true });

      act(() => {
        notifyDrawerSlide(false);
      });

      expect(result.current.isSliding).toBe(false);
    });

    /**
     * The deferred flip leaves the opening frames outside the committed state
     * too, and without the strip nothing else covers the pane while the drawer
     * travels over it.
     */
    it('arms for an opening slide the flip has not committed', () => {
      const { result } = setup({ expanded: false, isSmallScreen: true });

      act(() => {
        notifyDrawerSlide(true);
      });

      expect(result.current.isSliding).toBe(true);

      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });
      expect(result.current.isSliding).toBe(false);
    });

    /** Only a close strands focus; the drawer's header takes it on an open. */
    it('does not reclaim focus when an opening slide releases', () => {
      const opener = addOpener();
      const { result } = setup({ expanded: false, isSmallScreen: true });

      act(() => {
        notifyDrawerSlide(true);
      });
      act(() => {
        jest.advanceTimersByTime(TRANSITION_MS);
      });

      expect(result.current.isSliding).toBe(false);
      expect(document.activeElement).not.toBe(opener);
    });

    it('does not arm under reduced motion, where the slide snaps', () => {
      const { result } = setup({
        expanded: false,
        isSmallScreen: true,
        prefersReducedMotion: true,
      });

      act(() => {
        notifyDrawerSlide(false);
      });

      expect(result.current.isSliding).toBe(false);
    });
  });

  describe('the scrim itself', () => {
    it('closes the drawer and gives up its own focus', () => {
      const { result, setOpen } = setup({ expanded: true, isSmallScreen: true });

      const scrim = clickScrim(result.current.onScrimClick);

      expect(setOpen).toHaveBeenCalledWith(false);
      expect(document.activeElement).not.toBe(scrim);
    });

    /**
     * The scrim stays the pointer target through the guard, where the state has
     * already committed. Closing again would be a no-op that never reaches the
     * focus handoff, so the tap has to be swallowed outright.
     */
    it('swallows a tap landing after the close has committed', () => {
      const { result, rerender, setOpen } = setup({ expanded: true, isSmallScreen: true });
      rerender({ expanded: false, isSmallScreen: true, prefersReducedMotion: false });
      expect(result.current.isSliding).toBe(true);
      setOpen.mockClear();

      const scrim = clickScrim(result.current.onScrimClick);

      expect(setOpen).not.toHaveBeenCalled();
      expect(document.activeElement).not.toBe(scrim);
    });
  });
});
