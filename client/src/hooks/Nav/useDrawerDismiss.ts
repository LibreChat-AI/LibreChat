import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent, RefObject } from 'react';
import { MOBILE_DRAWER_ID, TRANSITION_MS } from '~/components/UnifiedSidebar/constants';
import { getDrawerAnimationStartedAt, setDrawerSlideListener } from './useDrawerSwipe';
import { OPEN_SIDEBAR_ID } from '~/components/Chat/Menus/OpenSidebar';

/**
 * Every path that closes the mobile drawer leaves the same two problems, so
 * they are answered once here rather than per control: the surfaces the user
 * acted on stop being focusable, and the drawer and pane keep moving after the
 * state has already committed.
 */
export default function useDrawerDismiss({
  expanded,
  isSmallScreen,
  prefersReducedMotion,
  paneRef,
  setOpen,
}: {
  expanded: boolean;
  isSmallScreen: boolean;
  prefersReducedMotion: boolean;
  paneRef: RefObject<HTMLElement>;
  setOpen: (open: boolean) => void;
}): {
  isSliding: boolean;
  onScrimClick: (event: MouseEvent<HTMLElement>) => void;
} {
  /** Whether either surface is still travelling. Recoil's flip is deferred
   *  past the first frames and the transition outlives it at the other end, so
   *  the committed state brackets the wrong window; a tap outside it reaches a
   *  control on the pane sliding underneath. The scrim holds the pointer and
   *  the pane stays inert for exactly this. */
  const [isSliding, setIsSliding] = useState(false);
  const wasExpandedRef = useRef(expanded);
  const wasSmallScreenRef = useRef(isSmallScreen);
  /** The guard puts `inert` back on the pane, and both the opener and the pane
   *  itself sit inside it, so a handoff made while it is armed would only be
   *  dropped to the body. An armed close records the debt here and the release
   *  below pays it, whether the release comes from the timer or from a
   *  dependency change cancelling the guard. */
  const handoffPendingRef = useRef(false);
  const guardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Read from the slide listener below, which fires outside React's render. */
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;

  const armGuard = useCallback((duration: number, handoff: boolean) => {
    if (guardTimerRef.current != null) {
      clearTimeout(guardTimerRef.current);
    }
    handoffPendingRef.current = handoffPendingRef.current || handoff;
    setIsSliding(true);
    guardTimerRef.current = setTimeout(() => {
      guardTimerRef.current = null;
      setIsSliding(false);
    }, duration);
  }, []);

  const disarmGuard = useCallback(() => {
    if (guardTimerRef.current != null) {
      clearTimeout(guardTimerRef.current);
      guardTimerRef.current = null;
    }
    setIsSliding(false);
  }, []);

  /** Layout rather than passive: the guard below has to be armed in the frame
   *  the close commits. A passive effect runs after paint, leaving one frame
   *  where the pane has dropped `inert` and the scrim has not yet taken the
   *  pointer back, which is a tap reaching a control still sliding past. */
  useLayoutEffect(() => {
    const wasExpanded = wasExpandedRef.current;
    const wasSmallScreen = wasSmallScreenRef.current;
    wasExpandedRef.current = expanded;
    wasSmallScreenRef.current = isSmallScreen;

    /** Leaving mobile unmounts the drawer and the scrim, so focus sitting on
     *  either goes with them, exactly as it does on a close. */
    if (wasSmallScreen && !isSmallScreen) {
      restoreDrawerFocus(paneRef.current);
      return;
    }

    if (!isSmallScreen || !wasExpanded || expanded) {
      return;
    }

    const remaining = closeGuardDuration({
      wasSmallScreen,
      prefersReducedMotion,
      pane: paneRef.current,
    });

    /** Nothing is still moving, so the pane never takes `inert` back and the
     *  handoff can land in this frame. Runs for a breakpoint crossing too: the
     *  expanded desktop sidebar is replaced by the closed mobile drawer, so
     *  focus inside it is dropped just as surely as by a deliberate close. */
    if (remaining == null) {
      restoreDrawerFocus(paneRef.current);
      return;
    }

    /** Timer rather than transitionend: the scrim unmounts when the viewport
     *  crosses to desktop, and a handler that never fires would strand the
     *  guard on. */
    armGuard(remaining, true);
    return disarmGuard;
  }, [expanded, isSmallScreen, prefersReducedMotion, paneRef, armGuard, disarmGuard]);

  /** Every slide that starts while the committed state is closed: an open,
   *  before its deferred flip lands, and a close whose open never committed at
   *  all (a second toggle retargeting inside that window, or an open drag that
   *  falls short). Neither reaches the effect above, and on the default
   *  configuration nothing else covers the pane while the drawer travels over
   *  it. A committed close still arms above, where the deadline is what is
   *  left of the motion rather than all of it. */
  useEffect(() => {
    if (!isSmallScreen || prefersReducedMotion) {
      return;
    }
    setDrawerSlideListener((next) => {
      if (expandedRef.current) {
        return;
      }
      /** Only a close strands focus: an open hands it to the drawer's header. */
      armGuard(TRANSITION_MS, !next);
    });
    return () => {
      setDrawerSlideListener(null);
      disarmGuard();
    };
  }, [isSmallScreen, prefersReducedMotion, armGuard, disarmGuard]);

  /** Keyed off the release rather than the close, so a guard cancelled by a
   *  dependency change hands focus over too: its timer is gone, and the effect
   *  above has already recorded the close it will never rerun for. */
  useLayoutEffect(() => {
    if (isSliding || !handoffPendingRef.current) {
      return;
    }
    handoffPendingRef.current = false;
    restoreDrawerFocus(paneRef.current);
  }, [isSliding, paneRef]);

  const onScrimClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      /** The scrim goes aria-hidden on close, so focus cannot stay here; the
       *  effect above hands it on once the pane has shed `inert`. */
      event.currentTarget.blur();
      /** Still the pointer target through the guard, where closing again would
       *  be a no-op that never reaches that effect. */
      if (!expanded) {
        return;
      }
      setOpen(false);
    },
    [expanded, setOpen],
  );

  return { isSliding, onScrimClick };
}

/**
 * How much of the close is still moving, or null when nothing is. Crossing the
 * breakpoint derives the drawer closed with nothing to animate, and both
 * surfaces snap under reduced motion; arming anyway would leave a transparent
 * full-screen scrim swallowing taps for the length of the guard.
 */
function closeGuardDuration({
  wasSmallScreen,
  prefersReducedMotion,
  pane,
}: {
  wasSmallScreen: boolean;
  prefersReducedMotion: boolean;
  pane: HTMLElement | null;
}): number | null {
  if (!wasSmallScreen || prefersReducedMotion) {
    return null;
  }

  /** The guard exists to cover anything still moving. The reveal close
   *  repositions the pane instantly (`transition: none`) while the drawer keeps
   *  sliding, and a swipe animates the pane at any width, so asking only one
   *  surface misses a path. */
  const paneTransition = pane?.style.transition ?? '';
  const drawerTransition = document.getElementById(MOBILE_DRAWER_ID)?.style.transition ?? '';
  const stillMoving = (transition: string) => transition !== '' && transition !== 'none';
  if (!stillMoving(paneTransition) && !stillMoving(drawerTransition)) {
    return null;
  }

  /** The slide started at kick time. A delayed Recoil commit must not add a
   *  fresh TRANSITION_MS after the compositor has already settled. */
  const startedAt = getDrawerAnimationStartedAt();
  const remaining =
    startedAt == null
      ? TRANSITION_MS
      : Math.max(0, TRANSITION_MS - (performance.now() - startedAt));
  return remaining === 0 ? null : remaining;
}

/**
 * The drawer goes `inert` and the scrim `aria-hidden`, so whichever control
 * closed the drawer stops being focusable. Inert drops focus to the body on its
 * own; `aria-hidden` does not, which is what Escape on a focused scrim leaves
 * behind. Anything that took focus deliberately, a composer autofocused after
 * picking a conversation, keeps it.
 */
function restoreDrawerFocus(pane: HTMLElement | null): void {
  const active = document.activeElement;
  const lost =
    !(active instanceof HTMLElement) ||
    active === document.body ||
    active.closest('[inert]') != null ||
    active.closest('[aria-hidden="true"]') != null;
  if (!lost) {
    return;
  }

  const opener = document.getElementById(OPEN_SIDEBAR_ID);
  if (opener != null) {
    opener.focus();
    /** It stays mounted across breakpoints but is hidden on desktop, where the
     *  focus simply does not take, so confirm it rather than assume it. */
    if (document.activeElement === opener) {
      return;
    }
  }

  /** Routes that return a loading or error state before rendering their header
   *  have no opener, while the shortcut and the pane swipe still open the
   *  drawer, so fall back to the pane rather than leaving focus on the body. */
  pane?.focus();
}
