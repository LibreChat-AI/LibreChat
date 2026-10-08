import { useEffect, useRef } from 'react';
import {
  TRANSITION_MS,
  MOBILE_DRAWER_ID,
  MOBILE_DRAWER_WIDTH,
  MOBILE_DRAWER_TRANSITION,
  MOBILE_PANE_SHIFT,
  MOBILE_SCRIM_ID,
  SIDEBAR_TRANSITION,
  DRAWER_UNPAINTED,
} from '~/components/UnifiedSidebar/constants';

/** Horizontal travel before the gesture claims the touch (also the tap filter). */
const ACTIVATION_DISTANCE = 10;
/** |dx| must beat |dy| by this ratio to claim; otherwise vertical scroll wins. */
const AXIS_LOCK_RATIO = 1.5;
/** Fraction of the drawer width past which release commits the open/close. */
const COMMIT_DISTANCE_RATIO = 0.35;
/** px/ms — a flick past this commits regardless of distance… */
const COMMIT_VELOCITY = 0.3;
/** …but never from a twitch shorter than this. */
const FLICK_MIN_DISTANCE = 24;
/** A release this long after the last move is a hold, not a flick. */
const VELOCITY_HOLD_MS = 100;
/** Inline styles are cleared this long after TRANSITION_MS, then classes own the state. */
const SETTLE_BUFFER_MS = 80;

/**
 * Whether the drawer hides the pane entirely, which is what makes repositioning
 * the pane instantly invisible. A geometric fact rather than a reading of the
 * setting: the reveal is safe exactly when there is nothing uncovered to see it
 * in, however the width was arrived at.
 */
const drawerCoversPane = (drawer: HTMLElement): boolean =>
  (drawer.clientWidth || window.innerWidth) >= window.innerWidth;

/** Same kick as the drawer/pane transforms: the scrim must not wait for the
 *  Recoil commit, which a large conversation can delay past the slide. */
const setScrimOpacity = (open: boolean) => {
  const scrim = document.getElementById(MOBILE_SCRIM_ID);
  if (scrim == null) {
    return;
  }
  scrim.style.opacity = open ? '1' : '0';
  /** Recoil still has expanded=false during an open kick, so the class
   *  pointer-events-none would leave the fading-in scrim click-through. Every
   *  close hands capture back to the expanded/isSliding classes, which hold it
   *  for exactly the slide; keeping the override would outlive them by the
   *  settle buffer and swallow taps on the strip. */
  scrim.style.pointerEvents = open ? 'auto' : '';
};

/**
 * A close whose open never committed — a second toggle retargets the slide
 * inside the deferred flip, or an open drag falls short and snaps back — moves
 * the pane without `expanded` ever changing, so the dismiss guard has no state
 * transition to arm from. The slide reports itself here instead.
 */
let slideListener: ((next: boolean) => void) | null = null;

export function setDrawerSlideListener(listener: ((next: boolean) => void) | null): void {
  slideListener = listener;
}

export function notifyDrawerSlide(next: boolean): void {
  slideListener?.(next);
}

/** Surfaces where a horizontal drag means selection or caret work, never navigation. */
const TEXT_SURFACE_SELECTOR = 'textarea, input, select, [contenteditable="true"]';

let drawerAnimator: ((next: boolean) => void) | null = null;

/** How a kicked toggle was handled: no animator (desktop/logged out — state
 * applied immediately), reduced-motion snap (applied immediately, no slide
 * frames), or a deferred slide. */
export type DrawerKickMode = 'none' | 'snap' | 'slide';

/** Target of a slide whose state flip is still deferred, or null when no
 * flip is pending. Lets rapid toggles invert the LATEST intent instead of
 * the stale committed atom value. */
let pendingFlipTarget: boolean | null = null;

export function getPendingDrawerFlip(): boolean | null {
  return pendingFlipTarget;
}

/** Compositor clock for the in-flight slide, so the close guard can expire
 *  at the animation deadline rather than TRANSITION_MS after a delayed commit. */
let animationStartedAt: number | null = null;

export function markDrawerAnimationStart(at: number | null = performance.now()): void {
  animationStartedAt = at;
}

export function getDrawerAnimationStartedAt(): number | null {
  return animationStartedAt;
}

/**
 * Starts the drawer/pane slide imperatively and owns WHEN the caller's state
 * flip runs. Wrapping the flip in `startTransition` is not enough: Recoil
 * notifies subscribers outside the transition scope, so the commit — which a
 * large conversation stretches to hundreds of ms of context re-renders plus
 * the pane's `inert` recalc — flushes synchronously inside the tap's task and
 * delays the slide's first frame (measured ~250ms on a 60-message thread at
 * 4× throttle).
 *
 * So: start the slide imperatively, then run `applyState` three frames
 * later — the animator writes the target transforms in frame 1, frame 2
 * paints the first interpolated position, and by frame 3 the transform
 * animation is compositor-driven (`willChange` is set in the tap's task), so
 * the commit lands mid-slide without stuttering or delaying it. When the
 * swipe hook is not active — desktop, logged out — `applyState` runs
 * immediately and React animates the layout as before.
 *
 * Returns how the toggle was handled, so callers can keep affordances off
 * the paths where they do not apply — e.g. the desktop focus timer only
 * runs on 'none', and follow-up work defers only on 'slide'.
 */
export function kickDrawerAnimation(next: boolean, applyState: () => void): DrawerKickMode {
  const animator = drawerAnimator;
  if (animator == null) {
    applyState();
    return 'none';
  }
  animator(next);
  /** Reduced motion snaps — there are no slide frames to protect, and
   * deferring would let a slow-frame device outrun the 80ms window that
   * restores transitions, turning the snap back into a full slide. The
   * urgent commit runs inside this same task, which the restore timer
   * cannot preempt. */
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    applyState();
    return 'snap';
  }
  pendingFlipTarget = next;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        /** Applies only while still the LATEST un-superseded intent. A
         * retarget hands the state to its own deferred flip — this one
         * transiently committing the old direction would re-register the
         * animator and get the newer flip judged stale. Teardown and
         * re-registration (breakpoint cross, logout, route change) clear
         * the pending target in the effect cleanup, so stale flips drop
         * out here as well instead of toggling the DESKTOP sidebar or
         * persisting drawer state past logout. */
        if (pendingFlipTarget !== next) {
          return;
        }
        pendingFlipTarget = null;
        applyState();
      });
    });
  });
  return 'slide';
}

/**
 * Walks from `start` up to `boundary` looking for a horizontal scroller that
 * can still consume a pan in `direction` (1 = finger moving right, which
 * reveals content to the left, i.e. needs `scrollLeft > 0`). A rightward
 * swipe inside a code block only defers to the block while it can actually
 * scroll that way — parked at its edge, the drawer may claim the drag.
 */
export function findHorizontalScrollBlocker(
  start: Element | null,
  boundary: Element,
  direction: 1 | -1,
): Element | null {
  let node: Element | null = start;
  while (node != null) {
    if (node instanceof HTMLElement && node.scrollWidth > node.clientWidth + 1) {
      const style = window.getComputedStyle(node);
      if (style.overflowX === 'auto' || style.overflowX === 'scroll') {
        const maxScroll = node.scrollWidth - node.clientWidth;
        /** RTL scrollers report `scrollLeft` in [-max, 0] with 0 at the right
         * edge; normalize to visual distance-from-left-edge so the finger
         * direction maps the same way in both document directions. */
        const fromLeftEdge =
          style.direction === 'rtl' ? node.scrollLeft + maxScroll : node.scrollLeft;
        const remaining = direction === 1 ? fromLeftEdge : maxScroll - fromLeftEdge;
        if (remaining > 1) {
          return node;
        }
      }
    }
    if (node === boundary) {
      return null;
    }
    node = node.parentElement;
  }
  return null;
}

type DrawerSwipeOptions = {
  /** The chat pane that mirrors the drawer's motion (Root's Outlet wrapper). */
  paneRef: React.RefObject<HTMLDivElement | null>;
  enabled: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type Sample = { t: number; x: number };

type Gesture = {
  phase: 'tracking' | 'claimed' | 'dead';
  opening: boolean;
  /** Identifier of the initiating touch — a second finger never becomes it. */
  touchId: number;
  startX: number;
  startY: number;
  dx: number;
  width: number;
  reducedMotion: boolean;
  drawer: HTMLElement;
  pane: HTMLElement;
  prevSample: Sample;
  lastSample: Sample;
  raf: number | null;
  /** Set before scheduling so coalescing holds even if rAF fires synchronously. */
  rafScheduled: boolean;
};

/**
 * What the two surfaces settle back to. Nothing under reduced motion, where
 * every drawer move snaps: handing an animating value back would leave the
 * element ready to ease the next change, and the strip setting changes the
 * drawer's width without passing through the snap path at all.
 */
const settledTransitions = (): { drawer: string; pane: string } =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ? { drawer: 'none', pane: 'none' }
    : { drawer: MOBILE_DRAWER_TRANSITION, pane: SIDEBAR_TRANSITION };

/** Returns every transient inline property to what React/classes render for
 * `paneOpen`. The drawer's transform is class-driven so clearing suffices, but
 * the pane's is a React style prop React will NOT re-assert while its value is
 * unchanged — an open pane must get its committed transform back explicitly. */
const releaseInlineStyles = (drawer: HTMLElement, pane: HTMLElement, paneOpen: boolean) => {
  const settled = settledTransitions();
  drawer.style.transform = '';
  drawer.style.willChange = '';
  /** Re-asserted rather than cleared, for the same reason as the width below:
   *  a closed drawer is not painted (see DRAWER_UNPAINTED), React has already
   *  written that value by the time this runs — the travel window closes at
   *  TRANSITION_MS and this runs a buffer later — and clearing the property
   *  would drop it while React believes its unchanged prop is still applied.
   *  The drawer would be painted again, closed, which is the whole artifact. */
  drawer.style.visibility = paneOpen ? '' : DRAWER_UNPAINTED;
  /** The close pins a measured width, and clearing would drop the declarative
   * value with it: React will not re-assert a style prop whose value it has
   * not changed. */
  drawer.style.width = MOBILE_DRAWER_WIDTH;
  drawer.style.transition = settled.drawer;
  pane.style.transform = paneOpen ? MOBILE_PANE_SHIFT : '';
  pane.style.willChange = '';
  pane.style.transition = settled.pane;
  markDrawerAnimationStart(null);
  const scrim = document.getElementById(MOBILE_SCRIM_ID);
  if (scrim != null) {
    scrim.style.pointerEvents = '';
  }
};

const dragTransforms = (gesture: Gesture): { drawer: string; pane: string } => {
  const progress = gesture.opening
    ? Math.min(Math.max(gesture.dx, 0), gesture.width)
    : Math.min(Math.max(gesture.dx, -gesture.width), 0) + gesture.width;
  return {
    drawer: `translate3d(${progress - gesture.width}px, 0, 0)`,
    pane: `translate3d(${progress}px, 0, 0)`,
  };
};

/**
 * Follow-the-finger swipe between the mobile drawer and the chat pane, which
 * move as one object (see SIDEBAR_TRANSITION). Built on touch events with a
 * selectively non-passive `touchmove` — `touch-action` on the app shell would
 * silently kill every horizontal scroller in the chat (code blocks, tables,
 * carousels), and React's own onTouchMove registers passive, so
 * `preventDefault` there is a no-op. During a drag both elements get direct
 * rAF-coalesced transform writes and no React state changes; release animates
 * to the nearest state and only then flips `useSidebarState`.
 *
 * Open listens on the pane (portaled overlays mount to `body`, outside it) and
 * close on the drawer, which carries `touch-pan-y` since it has no horizontal
 * scrollers of its own. On an iOS Safari tab the system back gesture owns the
 * outer edge and is not preventable, which is exactly why activation is the
 * whole pane rather than an edge zone; installed standalone, the edge is ours.
 */
export default function useDrawerSwipe({
  paneRef,
  enabled,
  open,
  onOpenChange,
}: DrawerSwipeOptions) {
  const gestureRef = useRef<Gesture | null>(null);
  /** `id` is null while a kicked settle waits for its staged frame — the
   * release deadline runs on the frame clock, not the wall clock. */
  const settleRef = useRef<{
    id: ReturnType<typeof setTimeout> | null;
    target: boolean;
    drawer: HTMLElement;
    pane: HTMLElement;
  } | null>(null);
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;

  useEffect(() => {
    /** A settle whose target the world has since contradicted — drawer closed
     * via a button inside its 380ms window, or the breakpoint crossed and
     * disabled the hook — must not fire: its stale write would strand the
     * pane offscreen with React believing nothing changed. A settle that
     * AGREES with `open` keeps running so its handoff finishes undisturbed. */
    const pending = settleRef.current;
    if (pending != null && (!enabled || pending.target !== open)) {
      if (pending.id != null) {
        clearTimeout(pending.id);
      }
      settleRef.current = null;
      releaseInlineStyles(pending.drawer, pending.pane, enabled && open);
    }
    /** A gesture surviving into a new effect run was interrupted — its
     * listeners are gone, so its drag styles must resolve to the CURRENT
     * state (this closure knows it; the torn-down one did not). */
    const abandoned = gestureRef.current;
    if (abandoned != null) {
      if (abandoned.phase === 'claimed' && !abandoned.reducedMotion) {
        releaseInlineStyles(abandoned.drawer, abandoned.pane, enabled && open);
      }
      if (abandoned.raf != null) {
        cancelAnimationFrame(abandoned.raf);
      }
      gestureRef.current = null;
    }
    if (!enabled) {
      return;
    }
    const pane = paneRef.current;
    const drawer = document.getElementById(MOBILE_DRAWER_ID);
    if (pane == null || drawer == null) {
      return;
    }
    const opening = !open;
    const surface = opening ? pane : drawer;

    const clearDrag = (gesture: Gesture) => {
      if (gesture.raf != null) {
        cancelAnimationFrame(gesture.raf);
      }
      gestureRef.current = null;
    };

    /** Arms the inline-style handoff: after the shared transition has played
     * out, every transient property returns to what React/classes render. */
    const scheduleRelease = (drawerEl: HTMLElement, paneEl: HTMLElement, next: boolean) => {
      const id = setTimeout(() => {
        settleRef.current = null;
        releaseInlineStyles(drawerEl, paneEl, next);
      }, TRANSITION_MS + SETTLE_BUFFER_MS);
      settleRef.current = { id, target: next, drawer: drawerEl, pane: paneEl };
    };

    /** Animates both elements to `next`, flips state, then returns ownership
     * of every inline property to what React/classes render for that state. */
    const settle = (gesture: Gesture, next: boolean) => {
      clearDrag(gesture);
      if (gesture.reducedMotion) {
        if (next !== open) {
          /** Snap: suppress the shared 300ms transition for this state flip,
           * then hand it back once the render has committed. */
          gesture.drawer.style.transition = 'none';
          gesture.pane.style.transition = 'none';
          onOpenChangeRef.current(next);
          const id = setTimeout(() => {
            settleRef.current = null;
            const settled = settledTransitions();
            gesture.drawer.style.transition = settled.drawer;
            gesture.pane.style.transition = settled.pane;
          }, SETTLE_BUFFER_MS);
          settleRef.current = { id, target: next, drawer: gesture.drawer, pane: gesture.pane };
        }
        return;
      }
      const { drawer: drawerEl, pane: paneEl } = gesture;
      drawerEl.style.transition = MOBILE_DRAWER_TRANSITION;
      paneEl.style.transition = SIDEBAR_TRANSITION;
      drawerEl.style.transform = next ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)';
      paneEl.style.transform = next ? MOBILE_PANE_SHIFT : 'translate3d(0, 0, 0)';
      markDrawerAnimationStart();
      notifyDrawerSlide(next);
      setScrimOpacity(next);
      if (next !== open) {
        onOpenChangeRef.current(next);
      }
      scheduleRelease(drawerEl, paneEl, next);
    };

    /** Imperative slide for button/keyboard toggles: same transforms and
     * release lifecycle as a gesture settle, but the CALLER owns the state
     * flip — nothing here calls `onOpenChange`. A drag in progress owns the
     * inline styles, so it wins; an in-flight settle already heading to
     * `next` needs no second start. */
    const animateTo = (next: boolean) => {
      /** The committed `open` goes stale while a flip is deferred — a rapid
       * second toggle must compare against the in-flight settle's target or
       * it early-returns and the visual never retargets (the state would
       * still alternate, then snap at release). */
      const effectiveTarget = settleRef.current?.target ?? open;
      if (next === effectiveTarget || gestureRef.current != null) {
        return;
      }
      const pending = settleRef.current;
      if (pending != null) {
        if (pending.id != null) {
          clearTimeout(pending.id);
        }
        settleRef.current = null;
      }
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        /** Snap: suppress the shared transition through the state flip the
         * caller is about to make, then hand it back once committed. */
        drawer.style.transition = 'none';
        pane.style.transition = 'none';
        const id = setTimeout(() => {
          settleRef.current = null;
          const settled = settledTransitions();
          drawer.style.transition = settled.drawer;
          pane.style.transition = settled.pane;
        }, SETTLE_BUFFER_MS);
        settleRef.current = { id, target: next, drawer, pane };
        return;
      }
      drawer.style.willChange = 'transform';
      /** Same reason as the drag above, and the closing direction needs it too:
       *  the deferred flip that commits `expanded` lands after these frames. */
      drawer.style.visibility = 'visible';
      if (next) {
        pane.style.willChange = 'transform';
      }
      /** Armed BEFORE the frame below (id: null — no deadline yet) so the
       * staged write can verify its target is still wanted, and so a
       * touchstart in between defers to the pending settle. A retarget or
       * a reconciliation cancel clears/replaces the settle and thereby
       * voids the write. */
      settleRef.current = { id: null, target: next, drawer, pane };
      /** The transforms are written in a FRESH frame task, not the tap's own
       * task: a transition armed inside the click task is not reliably
       * created for the offscreen drawer (observed via `transitionrun`
       * firing only after the state-flip commit, ~270ms late, even with a
       * forced reflow in-task), while the same write from a clean task
       * starts interpolating by the following frame. The reflow then pins
       * the transition-start recalc to this frame instead of 2–3 later.
       * The release deadline starts HERE, with the transition itself — a
       * wall-clock deadline armed at kick time can expire before a delayed
       * first frame (backgrounded tab, long stall) and abort the slide. */
      requestAnimationFrame(() => {
        const armed = settleRef.current;
        if (armed == null || armed.target !== next || armed.id != null) {
          return;
        }
        drawer.style.transition = MOBILE_DRAWER_TRANSITION;
        /** A width transition still in flight (the strip setting changing, or
         * a rotation re-resolving the percentage) runs on its own clock, so
         * the drawer's edge and the pane's would separate for the rest of it.
         * Pinning the measured width settles the drawer onto this slide's
         * clock; the opening kick hands the property back. */
        drawer.style.width = next
          ? MOBILE_DRAWER_WIDTH
          : `${drawer.getBoundingClientRect().width || window.innerWidth}px`;
        drawer.style.transform = next ? 'translate3d(0, 0, 0)' : 'translate3d(-100%, 0, 0)';
        markDrawerAnimationStart();
        notifyDrawerSlide(next);
        setScrimOpacity(next);
        if (next) {
          pane.style.transition = SIDEBAR_TRANSITION;
          pane.style.transform = MOBILE_PANE_SHIFT;
        } else if (drawerCoversPane(drawer)) {
          /** A programmatic close is a REVEAL while the drawer is full width:
           * the pane repositions instantly beneath the opaque cover and only
           * the drawer slides away, uncovering content already in place.
           * Animating the pane in from the right makes every tap-to-navigate
           * close visibly shift the chat leftward while the new conversation
           * commits into the moving layer mid-slide. */
          pane.style.transition = 'none';
          pane.style.transform = 'none';
        } else {
          /** With the strip enabled that jump would land in the visible slice,
           * so both surfaces animate together, which is the motion the drag
           * path already produces in `settle`. */
          pane.style.transition = SIDEBAR_TRANSITION;
          pane.style.transform = 'translate3d(0, 0, 0)';
        }
        void drawer.getBoundingClientRect();
        armed.id = setTimeout(() => {
          settleRef.current = null;
          releaseInlineStyles(drawer, pane, next);
        }, TRANSITION_MS + SETTLE_BUFFER_MS);
      });
    };
    drawerAnimator = animateTo;

    const onTouchStart = (event: TouchEvent) => {
      if (gestureRef.current != null || settleRef.current != null || event.touches.length !== 1) {
        return;
      }
      const target = event.target as Element | null;
      if (target?.closest(TEXT_SURFACE_SELECTOR) != null) {
        return;
      }
      const touch = event.touches[0];
      const sample = { t: event.timeStamp, x: touch.clientX };
      gestureRef.current = {
        phase: 'tracking',
        opening,
        touchId: touch.identifier,
        startX: touch.clientX,
        startY: touch.clientY,
        dx: 0,
        width: drawer.clientWidth || window.innerWidth,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
        drawer,
        pane,
        prevSample: sample,
        lastSample: sample,
        raf: null,
        rafScheduled: false,
      };
    };

    const scheduleDragFrame = (gesture: Gesture) => {
      if (gesture.reducedMotion || gesture.rafScheduled) {
        return;
      }
      gesture.rafScheduled = true;
      gesture.raf = requestAnimationFrame(() => {
        gesture.rafScheduled = false;
        gesture.raf = null;
        const transforms = dragTransforms(gesture);
        gesture.drawer.style.transform = transforms.drawer;
        gesture.pane.style.transform = transforms.pane;
      });
    };

    const onTouchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (gesture == null || gesture.phase === 'dead') {
        return;
      }
      const touch = Array.from(event.touches).find(
        (candidate) => candidate.identifier === gesture.touchId,
      );
      if (event.touches.length !== 1 || touch == null) {
        if (gesture.phase === 'claimed') {
          settle(gesture, open);
        } else {
          clearDrag(gesture);
        }
        return;
      }
      const dx = touch.clientX - gesture.startX;
      const dy = touch.clientY - gesture.startY;

      if (gesture.phase === 'tracking') {
        const horizontal = Math.abs(dx) >= ACTIVATION_DISTANCE;
        const wins = Math.abs(dx) >= Math.abs(dy) * AXIS_LOCK_RATIO;
        if (horizontal && wins) {
          const direction = dx > 0 ? 1 : -1;
          const wrongWay = gesture.opening ? direction !== 1 : direction !== -1;
          const blocker = wrongWay
            ? null
            : findHorizontalScrollBlocker(event.target as Element | null, surface, direction);
          if (wrongWay || blocker != null) {
            gesture.phase = 'dead';
            return;
          }
          gesture.phase = 'claimed';
          if (!gesture.reducedMotion) {
            gesture.drawer.style.transition = 'none';
            gesture.pane.style.transition = 'none';
            gesture.drawer.style.willChange = 'transform';
            gesture.pane.style.willChange = 'transform';
            /** The drag paints the drawer before any state flip: it follows the
             *  finger out of a closed state, which is not painted. */
            gesture.drawer.style.visibility = 'visible';
            /** Dropping the transition lands a width still easing toward the
             *  strip target on that target in this frame, so the touchstart
             *  snapshot is now stale — and the paired transforms below read it
             *  for both surfaces, which would hold a gap open for the whole
             *  drag. */
            gesture.width = gesture.drawer.clientWidth || window.innerWidth;
          }
        } else if (Math.abs(dy) >= ACTIVATION_DISTANCE) {
          gesture.phase = 'dead';
          return;
        } else {
          return;
        }
      }

      event.preventDefault();
      gesture.dx = dx;
      gesture.prevSample = gesture.lastSample;
      gesture.lastSample = { t: event.timeStamp, x: touch.clientX };
      scheduleDragFrame(gesture);
    };

    const onTouchEnd = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (gesture == null) {
        return;
      }
      /** Only the initiating finger's lift ends the gesture; a second finger
       * lifting is not a release. */
      const initiatingEnded = Array.from(event.changedTouches).some(
        (candidate) => candidate.identifier === gesture.touchId,
      );
      if (!initiatingEnded) {
        return;
      }
      if (gesture.phase !== 'claimed') {
        clearDrag(gesture);
        return;
      }
      /** The initiating finger left while another remains — ambiguous, so
       * revert rather than let the survivor inherit half a gesture. */
      if (event.touches.length > 0) {
        settle(gesture, open);
        return;
      }
      const progress = gesture.opening ? gesture.dx : -gesture.dx;
      const elapsed = gesture.lastSample.t - gesture.prevSample.t;
      /** A flick's momentum expires if the finger holds still before lifting —
       * velocity is only trusted when release follows the last move promptly. */
      const held = event.timeStamp - gesture.lastSample.t > VELOCITY_HOLD_MS;
      const velocity =
        !held && elapsed > 0 ? (gesture.lastSample.x - gesture.prevSample.x) / elapsed : 0;
      const towardTarget = gesture.opening ? velocity : -velocity;
      const committed =
        progress >= gesture.width * COMMIT_DISTANCE_RATIO ||
        (towardTarget >= COMMIT_VELOCITY && progress >= FLICK_MIN_DISTANCE);
      settle(gesture, committed ? gesture.opening : open);
    };

    const onTouchCancel = () => {
      const gesture = gestureRef.current;
      if (gesture == null) {
        return;
      }
      if (gesture.phase === 'claimed') {
        settle(gesture, open);
      } else {
        clearDrag(gesture);
      }
    };

    surface.addEventListener('touchstart', onTouchStart, { passive: true });
    surface.addEventListener('touchmove', onTouchMove, { passive: false });
    surface.addEventListener('touchend', onTouchEnd, { passive: true });
    surface.addEventListener('touchcancel', onTouchCancel, { passive: true });
    return () => {
      drawerAnimator = null;
      /** A pending intent from the torn-down world must not leak into the
       * next one — a desktop toggle right after a breakpoint cross has to
       * invert the committed value, and the deferred flip that would have
       * consumed this target now drops out of its superseded check. */
      pendingFlipTarget = null;
      surface.removeEventListener('touchstart', onTouchStart);
      surface.removeEventListener('touchmove', onTouchMove);
      surface.removeEventListener('touchend', onTouchEnd);
      surface.removeEventListener('touchcancel', onTouchCancel);
      /** Interrupted gestures are resolved by the NEXT effect run, which
       * knows the new state; here only the frame is cancelled so nothing
       * writes after teardown. Unmount discards the DOM with its styles. */
      const gesture = gestureRef.current;
      if (gesture?.raf != null) {
        cancelAnimationFrame(gesture.raf);
        gesture.raf = null;
        gesture.rafScheduled = false;
      }
    };
  }, [enabled, open, paneRef]);

  useEffect(
    () => () => {
      if (settleRef.current?.id != null) {
        clearTimeout(settleRef.current.id);
      }
    },
    [],
  );
}
