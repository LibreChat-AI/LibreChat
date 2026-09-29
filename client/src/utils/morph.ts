import { flushSync } from 'react-dom';

/**
 * Runs a state update inside a same-document view transition when supported,
 * so elements sharing a `view-transition-name` morph (position, size, shape)
 * between the two states instead of swapping. Falls back to applying the
 * update directly. Call from user-event handlers only: the update is flushed
 * synchronously so the browser can snapshot the old and new layouts.
 */
export function morphTransition(update: () => void): void {
  if (
    typeof document.startViewTransition !== 'function' ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    update();
    return;
  }
  document.startViewTransition(() => {
    flushSync(update);
  });
}
