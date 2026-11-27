/** The welcome screen's greeting animates one grapheme at a time, and the
 * moment its last one settles is the screen's cue to come alive: the composer
 * takes focus, and a welcome backdrop can answer from that character.
 *
 * Announced rather than passed down, so neither a backdrop behind the greeting
 * nor the composer below it needs a handle on the other, and a third thing can
 * listen later without threading a prop through `ChatView`. Fired once per visit
 * to the welcome screen.
 *
 * Coordinates are viewport coordinates, as `getBoundingClientRect` reports
 * them, and mark the centre of that final character. */

export const GREETING_SETTLED = 'librechat:welcome-greeting-settled';

export interface GreetingSettled {
  clientX: number;
  clientY: number;
}

export function announceGreetingSettled(clientX: number, clientY: number): void {
  window.dispatchEvent(
    new CustomEvent<GreetingSettled>(GREETING_SETTLED, { detail: { clientX, clientY } }),
  );
}

/** Popups that own focus while they are open. Refocusing the composer behind
 * one is the regression in #15624: Ariakit records `document.activeElement` at
 * open time as the menu's disclosure, and a menu whose disclosure became the
 * textarea could never close again. */
const popupSelector = '[role="menu"],[role="listbox"],[role="dialog"],[role="alertdialog"]';

const isVisible = (element: Element): boolean => {
  const { width, height } = element.getBoundingClientRect();
  if (width === 0 || height === 0) {
    return false;
  }
  const style = getComputedStyle(element);
  return style.visibility !== 'hidden' && style.display !== 'none';
};

/** Whether the composer may take the caret when the greeting settles.
 *
 * The cue arrives on a timer, seconds after the screen mounts, so by then the
 * person may already be typing, have sent the message, or have something open.
 * The caret is only claimed while nothing else holds it, which keeps the
 * welcome screen's convenience from becoming a focus steal.
 *
 * Presence is not openness here: the composer keeps dialog-role nodes mounted
 * and zero-sized, so an open popup has to be judged by whether it renders. */
export function canClaimWelcomeFocus(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (active && active !== doc.body && active !== doc.documentElement) {
    return false;
  }
  return !Array.from(doc.querySelectorAll(popupSelector)).some(isVisible);
}

/** A touchscreen keeps its keyboard down until the person taps the composer, by
 * the same test `useFocusChatEffect` applies on navigation. */
export function isTouchFirst(win: Window = window): boolean {
  const coarse = win.matchMedia?.('(pointer: coarse)').matches ?? false;
  const hover = win.matchMedia?.('(hover: hover)').matches ?? true;
  return coarse || !hover;
}

/** Returns the unsubscribe, so an effect can hand it straight back. */
export function onGreetingSettled(listener: (settled: GreetingSettled) => void): () => void {
  const handler = (event: Event) => {
    const { detail } = event as CustomEvent<GreetingSettled>;
    if (detail) {
      listener(detail);
    }
  };
  window.addEventListener(GREETING_SETTLED, handler);
  return () => window.removeEventListener(GREETING_SETTLED, handler);
}
