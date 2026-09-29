export const COLLAPSED_WIDTH = 52;
export const EXPANDED_MIN = 360;

/**
 * How much of the viewport the mobile drawer covers.
 *
 * Full width by default, where the drawer reads as its own screen and the
 * swipe closes it. Opting into the strip stops it short of the edge so a slice
 * of the conversation stays visible, which keeps the drawer reading as a layer
 * over the conversation and gives the close gesture a target to tap.
 *
 * Both the drawer and the pane read the one custom property, so their travel
 * cannot drift apart (see SIDEBAR_TRANSITION) and the setting can change at
 * runtime without threading a number through either. The fallback is the
 * default, so anything rendered outside the property's scope still agrees.
 */
export const MOBILE_DRAWER_WIDTH_VAR = '--mobile-drawer-width';
export const MOBILE_DRAWER_FULL_WIDTH = '100%';
export const MOBILE_DRAWER_STRIP_WIDTH = '80%';
export const MOBILE_DRAWER_WIDTH = `var(${MOBILE_DRAWER_WIDTH_VAR}, ${MOBILE_DRAWER_FULL_WIDTH})`;
export const MOBILE_PANE_SHIFT = `translateX(${MOBILE_DRAWER_WIDTH})`;
export const TRANSITION_MS = 300;
/**
 * Decelerating, but it settles rather than crawls. The previous
 * cubic-bezier(0.2, 0, 0, 1) spent its last third of time on a few percent of
 * distance, which reads as the drawer sticking just before it lands — most
 * obvious on close, where the tail is the part you watch.
 */
export const EASING = 'cubic-bezier(0.32, 0.72, 0, 1)';

/**
 * The drawer and the chat pane move as one object, so they must stay
 * frame-locked; a second copy of this string is a visible seam mid-animation.
 */
export const SIDEBAR_TRANSITION = `transform ${TRANSITION_MS}ms ${EASING}`;

/**
 * The drawer also transitions its width, because that is the one property the
 * pane tracks through its own transform. Changing the strip setting while the
 * drawer is open would otherwise jump the width in a frame while the pane
 * eased across 300ms, leaving the newly exposed slice with no conversation
 * under it. Only the drawer needs this: the pane's width is flex-driven and
 * animating it would reach the desktop sidebar's collapse as well.
 */
export const MOBILE_DRAWER_TRANSITION = `${SIDEBAR_TRANSITION}, width ${TRANSITION_MS}ms ${EASING}`;

/**
 * The mobile drawer is opaque and full-screen, so it sits above the chat.
 *
 * This ranks the drawer only *within* `Root`'s `relative z-0` stacking
 * context, so it cannot occlude anything portaled to `document.body` no
 * matter the value. Menus opened from inside the drawer should therefore keep
 * portaling: rendering them in place puts them under the nav's
 * `overflow-hidden` and the virtualized list, and the drawer's transform makes
 * it their containing block, which clips them.
 */
export const DRAWER_Z_INDEX = 110;

/**
 * Lets the swipe gesture (mounted in Root, which owns the chat pane) reach
 * the drawer element without threading a ref across sibling trees.
 */
export const MOBILE_DRAWER_ID = 'mobile-drawer';

/**
 * What a closed, settled drawer's `visibility` is.
 *
 * Translating the drawer off the viewport hides it without taking it out of the
 * paint, and iOS Safari composites the scroller inside it separately — that
 * layer can be left behind at the position it held while open, painting the
 * Projects and Pinned rows over the conversation. Not painting a closed drawer
 * removes the layer the artifact is made of.
 *
 * Shared because React renders it and the slide's release hands it back (see
 * useDrawerSwipe): React will not re-assert a style prop whose value it has not
 * changed, so the release must write this exact value rather than clear the
 * property, and the two sides cannot be allowed to drift.
 *
 * `visibility` and not `display`: the chats list is virtualized against this
 * subtree and an undisplayed one reports no viewport, and the swipe gesture
 * measures the closed drawer's width.
 */
export const DRAWER_UNPAINTED = 'hidden';

/**
 * Lets a kicked toggle start the scrim fade with the drawer, rather than
 * waiting for the deferred Recoil commit that a large conversation stalls.
 */
export const MOBILE_SCRIM_ID = 'mobile-drawer-scrim';
