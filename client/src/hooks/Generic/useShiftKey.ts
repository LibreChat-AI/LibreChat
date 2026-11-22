import { useState, useEffect } from 'react';

/**
 * Hook to track whether the shift key is currently being held down.
 * Ignores shift when Alt is also pressed to avoid conflicts with
 * accessibility keyboard shortcuts (Shift+Alt is used for screen readers).
 *
 * While `enabled` is false it listens to nothing and reports the key as up. In a list where one
 * row answers to shift, each row passes whether it is that row: a listener per row ran for every
 * row on each key press, and holding shift rendered them all.
 * @returns boolean indicating if shift key is pressed (without Alt)
 */
export default function useShiftKey(enabled = true): boolean {
  const [isShiftHeld, setIsShiftHeld] = useState(false);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const handleKeyDown = (e: KeyboardEvent) => {
      // Only set shift if Alt is not pressed (Alt+Shift is used for a11y)
      if (e.key === 'Shift' && !e.altKey) {
        setIsShiftHeld(true);
      }
      // If Alt is pressed while shift is held, reset shift state
      if (e.key === 'Alt' && e.shiftKey) {
        setIsShiftHeld(false);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'Shift') {
        setIsShiftHeld(false);
      }
    };

    // Reset shift state when window loses focus
    const handleBlur = () => {
      setIsShiftHeld(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
      /** The key may be released while nothing listens. */
      setIsShiftHeld(false);
    };
  }, [enabled]);

  return enabled && isShiftHeld;
}
