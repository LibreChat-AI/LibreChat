/**
 * Steering identity colors, shared by the composer chips, the row menus and the
 * inline delivery receipt so one steer reads the same everywhere it appears.
 *
 * Written as semantic status roles rather than palette hues. Both marks carry
 * state, and the receipt renders its label in the steer color at 12px, so the
 * identity has to clear the 4.5:1 text floor as well as the 3:1 floor for
 * graphical objects — on every canvas, including the enhanced-contrast themes.
 * A fixed palette hue cannot: `amber-600` label text lands at 3.19:1 on the
 * high-contrast light canvas, and the `amber-500`/`cyan-500` marks at 1.97:1
 * and 2.43:1, because a raw utility does not move when the theme does.
 *
 * `status-warning` and `status-info` are the theme-aware roles nearest the
 * amber and cyan identities they replace, and they clear both floors in every
 * theme: 4.69:1 and 4.83:1 at worst on the default light surfaces, 8.42:1 and
 * 10.31:1 at high contrast light, and higher on both dark canvases. The roles
 * also match the semantics — a steer preempts the running response, a queued
 * message is merely waiting.
 */
export const STEER_ICON = 'text-status-warning';
export const STEER_DOT = 'bg-status-warning';
export const QUEUE_ICON = 'text-status-info';
