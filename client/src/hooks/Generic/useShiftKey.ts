import { useEffect, useCallback, useSyncExternalStore } from 'react';

/**
 * Whether shift is held, tracked once for the page however many components ask: three window
 * listeners while any of them is mounted, in place of three per component.
 */
let held = false;
let users = 0;
const readers = new Set<() => void>();

function set(next: boolean): void {
  if (held === next) {
    return;
  }
  held = next;
  for (const notify of readers) {
    notify();
  }
}

function handleKeyDown(e: KeyboardEvent): void {
  // Only set shift if Alt is not pressed (Alt+Shift is used for a11y)
  if (e.key === 'Shift' && !e.altKey) {
    set(true);
  }
  // If Alt is pressed while shift is held, reset shift state
  if (e.key === 'Alt' && e.shiftKey) {
    set(false);
  }
}

function handleKeyUp(e: KeyboardEvent): void {
  if (e.key === 'Shift') {
    set(false);
  }
}

// Reset shift state when window loses focus
function handleBlur(): void {
  set(false);
}

function track(): () => void {
  users += 1;
  if (users === 1) {
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
  }
  return () => {
    users -= 1;
    if (users === 0) {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      /** The key may be released while nothing listens. */
      held = false;
    }
  };
}

const up = (): boolean => false;
const read = (): boolean => held;
const none = (): void => {};

function subscribe(notify: () => void): () => void {
  readers.add(notify);
  return () => {
    readers.delete(notify);
  };
}

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
  useEffect(track, []);
  const isShiftHeld = useSyncExternalStore(
    useCallback((notify: () => void) => (enabled ? subscribe(notify) : none), [enabled]),
    enabled ? read : up,
    up,
  );
  return isShiftHeld;
}
