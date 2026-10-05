import { useCallback, useEffect, useRef, useState } from 'react';
import * as Ariakit from '@ariakit/react';
import type { ReactNode } from 'react';
import { cn } from '~/utils';

/** Hover pacing: a brief intent delay so sweeping past the gauge doesn't pop
 *  the card open, and a grace period for the pointer to travel into it. */
const SHOW_DELAY_MS = 100;
const HIDE_DELAY_MS = 150;

interface UsagePopoverProps {
  /** Pending hover work is dropped when this changes (the viewed conversation) */
  resetKey: string;
  /** Accessible name of the gauge button */
  label: string;
  /** Accessible name of the opened card */
  cardLabel: string;
  busy?: boolean;
  /** The gauge face; receives whether the card is open */
  trigger: (open: boolean) => ReactNode;
  /** Card content, mounted only while the card is open */
  children: ReactNode;
}

/**
 * The composer gauge's disclosure: hover opens the card, a click pins it, and
 * keyboard and touch users get the same card through click / Enter / Space.
 */
export default function UsagePopover({
  resetKey,
  label,
  cardLabel,
  busy = false,
  trigger,
  children,
}: UsagePopoverProps) {
  const popover = Ariakit.usePopoverStore({ placement: 'top' });
  const popoverOpen = Ariakit.useStoreState(popover, 'open');
  const disclosureRef = useRef<HTMLButtonElement>(null);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Ariakit only restores focus to the trigger on hide when it took focus on
   * show, so keep `autoFocusOnShow` on for click/keyboard opens (Escape returns
   * focus to the gauge) and off for hover so it never pulls focus off the
   * composer mid-typing.
   */
  const [focusOnShow, setFocusOnShow] = useState(true);
  /** A click pins an open popover: hover no longer holds it, so the pointer can
   *  leave without it closing. Cleared when the popover closes by any path
   *  (Escape, outside click, a second click). */
  const pinnedRef = useRef(false);
  /** The pin state as of the pointerdown that precedes a mouse click. The
   *  pointerdown may hide the popover (hideOnInteractOutside does not exempt
   *  the disclosure's inner elements), which clears `pinnedRef` via the close
   *  effect before the click handler runs; the click must decide from this
   *  snapshot instead. */
  const pinAtPointerDownRef = useRef(false);

  const cancelTimers = useCallback(() => {
    if (showTimerRef.current != null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    if (hideTimerRef.current != null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const openByPointer = useCallback(() => {
    if (pinnedRef.current) {
      return;
    }
    cancelTimers();
    if (popover.getState().open) {
      return;
    }
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      setFocusOnShow(false);
      popover.show();
    }, SHOW_DELAY_MS);
  }, [cancelTimers, popover]);
  const scheduleHide = useCallback(() => {
    if (pinnedRef.current) {
      return;
    }
    cancelTimers();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      popover.hide();
    }, HIDE_DELAY_MS);
  }, [cancelTimers, popover]);

  useEffect(() => {
    if (!popoverOpen) {
      pinnedRef.current = false;
    }
  }, [popoverOpen]);

  /** Pending hover work must not outlive its target: cancel it on unmount and
   *  when the branch changes under the pointer, so a delayed show cannot open
   *  the popover for a conversation the user has navigated away from. */
  useEffect(() => cancelTimers, [cancelTimers, resetKey]);

  return (
    <>
      {/* Hover shows the card; the disclosure keeps click / Enter / Space
          working for touch and keyboard users. Taps also emit pointer
          enter/leave, so the hover timers are gated to hover-capable pointers
          or a tap would hide the popover it just opened. */}
      <Ariakit.PopoverDisclosure
        ref={disclosureRef}
        store={popover}
        type="button"
        data-testid="token-usage"
        aria-label={label}
        aria-busy={busy}
        aria-haspopup="dialog"
        onPointerDown={() => {
          pinAtPointerDownRef.current = pinnedRef.current;
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== 'touch') {
            openByPointer();
          }
        }}
        onPointerLeave={(e) => {
          if (e.pointerType !== 'touch') {
            scheduleHide();
          }
        }}
        onClick={(e) => {
          cancelTimers();
          e.preventDefault();
          /** Mouse clicks (detail > 0) decide from the pointerdown snapshot:
           *  the pointerdown may have hidden the popover and cleared the live
           *  pin before this handler ran. Keyboard clicks carry no pointerdown,
           *  so the live pin state is the truth there. */
          const wasPinned = e.detail > 0 ? pinAtPointerDownRef.current : pinnedRef.current;
          if (wasPinned) {
            pinnedRef.current = false;
            popover.hide();
            return;
          }
          if (!popover.getState().open) {
            setFocusOnShow(true);
          }
          pinnedRef.current = true;
          popover.show();
        }}
        className={cn(
          'size-theme-control rounded-theme-control-round flex items-center justify-center transition-colors',
          'hover:bg-surface-hover focus-visible:ring-text-primary focus-visible:ring-2 focus-visible:outline-hidden',
          'animate-in fade-in zoom-in-95 duration-300',
        )}
      >
        {trigger(popoverOpen)}
      </Ariakit.PopoverDisclosure>
      {/* Focus the labelled dialog on keyboard/click open so screen readers
          enter and announce the card, and so focus stays contained instead
          of falling back to the body (which the composer's global focus logic
          would steal). The visible ring is suppressed via focus:outline-hidden,
          and finalFocus returns focus to the gauge trigger on close. */}
      <Ariakit.Popover
        store={popover}
        gutter={8}
        portal
        unmountOnHide
        autoFocusOnShow={focusOnShow}
        finalFocus={disclosureRef}
        /* Without this the gauge could not close its own popup: mousedown on
           the trigger counts as "outside", so Ariakit hid the popup and the
           button's own click immediately re-opened it. */
        hideOnInteractOutside={(event) => !disclosureRef.current?.contains(event.target as Node)}
        aria-label={cardLabel}
        onPointerEnter={cancelTimers}
        onPointerLeave={(e) => {
          if (e.pointerType !== 'touch') {
            scheduleHide();
          }
        }}
        className={cn(
          'border-border-medium bg-surface-secondary text-text-primary z-[200] max-h-[calc(100dvh-1rem)] max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-xl border p-3 shadow-lg focus:outline-hidden',
          'origin-bottom translate-y-1 scale-95 opacity-0 transition duration-150 ease-out motion-reduce:transition-none',
          'data-[enter]:translate-y-0 data-[enter]:scale-100 data-[enter]:opacity-100',
          'data-[leave]:translate-y-1 data-[leave]:scale-95 data-[leave]:opacity-0',
        )}
      >
        {children}
      </Ariakit.Popover>
    </>
  );
}
