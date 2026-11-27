import { useEffect } from 'react';
import { atom, useAtomValue, useStore } from 'jotai';

/**
 * Whether shift is held, tracked once for the page however many components ask: three window
 * listeners for as long as anything keeps the atom mounted, in place of three per component.
 */
const shiftAtom = atom(false);

shiftAtom.onMount = (set) => {
  const handleKeyDown = (e: KeyboardEvent) => {
    // Only set shift if Alt is not pressed (Alt+Shift is used for a11y)
    if (e.key === 'Shift' && !e.altKey) {
      set(true);
    }
    // If Alt is pressed while shift is held, reset shift state
    if (e.key === 'Alt' && e.shiftKey) {
      set(false);
    }
  };

  const handleKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'Shift') {
      set(false);
    }
  };

  // Reset shift state when window loses focus
  const handleBlur = () => {
    set(false);
  };

  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);
  window.addEventListener('blur', handleBlur);

  return () => {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    window.removeEventListener('blur', handleBlur);
    /** The key may be released while nothing listens: the next caller must not read it as held. */
    set(false);
  };
};

/** What a caller that is not enabled reads: the key up, and never a change. */
const upAtom = atom(() => false);

/**
 * Hook to track whether the shift key is currently being held down.
 * Ignores shift when Alt is also pressed to avoid conflicts with
 * accessibility keyboard shortcuts (Shift+Alt is used for screen readers).
 *
 * While `enabled` is false the caller reads the key as up and is not rendered when it changes.
 * In a list where one row answers to shift, each row passes whether it is that row: the key
 * then renders that row alone, and a row that becomes the one while shift is already down
 * reads it as down at once, since the key is tracked for the page and not per row.
 * @returns boolean indicating if shift key is pressed (without Alt)
 */
export default function useShiftKey(enabled = true): boolean {
  const store = useStore();
  /**
   * Every caller keeps the key tracked, enabled or not; only an enabled one reads it. The
   * callback is this caller's own: a store holds its subscribers as a set, so callers sharing
   * one function would be one subscriber, and the first to unmount would stop the tracking.
   */
  useEffect(() => store.sub(shiftAtom, () => {}), [store]);
  return useAtomValue(enabled ? shiftAtom : upAtom);
}
