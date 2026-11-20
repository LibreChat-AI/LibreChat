/**
 * A desktop notification click focuses this window on its way to another conversation.
 *
 * That focus is not the user catching up on whatever happened to be open: they are leaving it
 * for the chat the notification named, and its reply was never on screen. The click flags the
 * focus event it is about to cause, and the seen trigger consumes the flag instead of
 * acknowledging a reply nobody read.
 */
let suppressedAt: number | null = null;

/**
 * How long the flag stays good for.
 *
 * `window.focus()` is a request, not a guarantee: a browser that refuses to raise the window
 * produces no focus event at all, and an unbounded flag would then be spent on the next genuine
 * focus, minutes later, silently withholding that conversation's acknowledgement. A focus the
 * click did cause arrives in the same task or the one after it, so anything beyond a couple of
 * seconds belongs to the user rather than to the notification.
 */
const SUPPRESSION_TTL_MS = 2_000;

/** Only meaningful while the window is unfocused, which is the only time alerts fire; a click
 *  that raises no focus event would otherwise leave the flag set for a later, genuine one. */
export const suppressFocusAcknowledgement = (): void => {
  if (document.hasFocus()) {
    return;
  }
  suppressedAt = Date.now();
};

export const consumeFocusSuppression = (): boolean => {
  if (suppressedAt === null) {
    return false;
  }
  const isLive = Date.now() - suppressedAt < SUPPRESSION_TTL_MS;
  suppressedAt = null;
  return isLive;
};
