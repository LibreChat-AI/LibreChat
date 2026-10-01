import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Moves focus to the returned ref's element when the panel's own state
 * advances (drop zone -> summary -> progress -> report), so the keyboard and
 * screen-reader user follows the flow instead of being dropped on `<body>` by
 * the button they just pressed unmounting. The DOM focus manager is an
 * external system, which is why this is an effect rather than derived state.
 *
 * It moves focus only when focus was already lost or is already inside this
 * panel. Unconditional focus-on-mount made the panel hostile: the settings
 * search mounts every matching setting as you type, so a single keystroke
 * matching "Import" ripped the caret out of the search box, and each
 * poll-driven phase change stole focus from whatever else the user was
 * operating in the dialog (WCAG 3.2.1, 2.4.3).
 */
export default function useAutoFocus<T extends HTMLElement, K>(focusKey: K): RefObject<T> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return;
    }

    const active = document.activeElement;
    const focusWasLost = active === null || active === document.body;
    const focusIsOurs = active instanceof Node && element.parentElement?.contains(active) === true;
    if (!focusWasLost && !focusIsOurs) {
      return;
    }

    element.focus();
  }, [focusKey]);

  return ref;
}
