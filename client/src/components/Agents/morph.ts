import type { TargetAndTransition, Transition } from 'framer-motion';

/**
 * Shared-layout morph between a marketplace card and its detail dialog.
 *
 * The card and the dialog each render their own surface layer plus their own
 * arrangement of the same identity fields. Matching `layoutId`s hand the surface
 * and those fields from one layout to the other, so the information rearranges
 * itself instead of the dialog being a scaled-up card. Everything that only
 * exists in the dialog fades in separately, after the geometry is under way.
 */

/**
 * One curve for the whole morph, after the "Good vs Great animations" rules
 * from animations.dev (Emil Kowalski): an `ease-out` for something entering or
 * leaving, because starting at full speed is what reads as a response to the
 * click and the long settle is what keeps it from looking abrupt. This is the
 * cubic one rather than the quartic: the quartic spends its first third almost
 * at full speed, which reads as a snap followed by a glide on a box this large.
 *
 * Everything the morph moves shares it: surface, dim, identity fields and the
 * description's words. A second curve or a second duration anywhere in here
 * reads as two animations that happen to have been started together.
 */
const EASE_OUT: [number, number, number, number] = [0.33, 1, 0.68, 1];

/**
 * {@link EASE_OUT} as a CSS timing function. The word-level description morph
 * runs on CSS transitions instead of through the animation loop — a paragraph
 * is hundreds of words, the compositor can carry them without a frame of
 * JavaScript each, and a transition can be interrupted mid-flight where a
 * keyframe animation restarts.
 */
export const EASE_OUT_CSS = `cubic-bezier(${EASE_OUT.join(', ')})`;

/** `--theme-surface-radius`'s own default, for a root that has not set it. */
const FALLBACK_SURFACE_RADIUS_REM = 1;

/**
 * The theme's surface radius in pixels.
 *
 * A scaling projection can only keep a corner from distorting if it owns the
 * radius as a number, which a `rounded-theme-surface` class cannot give it. So
 * the token is resolved once per morph — never per card, never per frame — and
 * both endpoints animate the same value the stylesheet would have painted.
 */
export const readSurfaceRadius = (): number => {
  const root = document.documentElement;
  const styles = getComputedStyle(root);
  const rootFontSize = parseFloat(styles.fontSize) || 16;
  const token = styles.getPropertyValue('--theme-surface-radius').trim();
  const value = parseFloat(token);
  if (!Number.isFinite(value)) {
    return FALLBACK_SURFACE_RADIUS_REM * rootFontSize;
  }
  return token.endsWith('px') ? value : value * rootFontSize;
};

/**
 * Card surface to dialog surface. A UI transition should stay near or under
 * 300ms, or it starts reading as latency however fast the code behind it is.
 * The morph crosses the viewport and re-wraps a paragraph while it runs, and
 * the eye has to follow the box across that distance, so it sits at the top of
 * that budget rather than under it.
 */
const OPEN_MS = 300;
export const MORPH_OPEN_TRANSITION: Transition = { duration: OPEN_MS / 1000, ease: EASE_OUT };

/**
 * Dialog surface back into the card.
 *
 * The close is two phases, because the surface cannot start contracting until
 * this dialog unmounts and gives it back: a short handover, where the
 * dialog-only controls leave and the words return to the card's wrapping, and
 * then the contraction. The handover is deliberately the shorter of the two —
 * it is the part where the box has not moved yet, and every millisecond of it
 * is read as the click not having registered.
 */
const HANDOFF_MS = 70;
const CLOSE_MS = 210;
export const MORPH_CLOSE_TRANSITION: Transition = { duration: CLOSE_MS / 1000, ease: EASE_OUT };
/** What the two phases cost together, which is the open's budget. */
const CLOSE_TOTAL_MS = HANDOFF_MS + CLOSE_MS;

/**
 * The page dim is animated here rather than by the dialog's own overlay: it has
 * to run its full 0 -> 1 range on open, and its full 1 -> 0 range across both
 * phases of the close, which outlive the dialog's mount. Starting it on the
 * click is what makes the close feel immediate while the box is still still.
 *
 * It spans the geometry exactly — the same duration in each direction — but
 * ramps linearly where the geometry eases. An `ease-out` is how a moving thing
 * decelerates; run on an alpha it spends two thirds of the distance in the
 * first third of the time, and since a scrim at 80% black already looks black
 * at half of it, the page reads as fully dim while the box is still growing.
 * Linear is what makes the dim and the morph look like the same length.
 */
export const BACKDROP_ENTER_TRANSITION: Transition = {
  duration: OPEN_MS / 1000,
  ease: 'linear',
};
export const BACKDROP_EXIT_TRANSITION: Transition = {
  duration: CLOSE_TOTAL_MS / 1000,
  ease: 'linear',
};

type MorphPart = 'surface' | 'avatar' | 'title' | 'category' | 'owner' | 'description';

const MORPH_PREFIX: Record<MorphPart, string> = {
  surface: 'agent-card-',
  avatar: 'agent-avatar-',
  title: 'agent-title-',
  category: 'agent-category-',
  owner: 'agent-owner-',
  description: 'agent-description-',
};

/** Stable shared-layout id for one field of one agent. */
export const agentMorphId = (part: MorphPart, agentId: string): string =>
  `${MORPH_PREFIX[part]}${agentId}`;

/**
 * `layoutDependency` for the dialog side. Layout is only measured when this
 * value changes, which keeps the virtualized grid's per-scroll rerenders from
 * measuring every card; the card side passes its `expanded` flag. The two sides
 * must never be equal, or a promoted node has nothing to resume from and the
 * morph degrades to a cut.
 */
export const DIALOG_MORPH_DEPENDENCY = 'dialog';

/**
 * Dialog-only content. It enters on the geometry's own budget, and leaves
 * inside the handover, because the surface is waiting on it: an exit as long as
 * the contraction would hold the box still for as long as it then takes to
 * move.
 */
export const DETAIL_INITIAL: TargetAndTransition = { opacity: 0, y: 6 };
export const DETAIL_ENTER: TargetAndTransition = {
  opacity: 1,
  y: 0,
  transition: MORPH_OPEN_TRANSITION,
};
export const DETAIL_EXIT: TargetAndTransition = {
  opacity: 0,
  y: 6,
  transition: { duration: HANDOFF_MS / 1000, ease: EASE_OUT },
};

/** Reduced motion, or no source card to morph from: opacity only. */
export const DETAIL_FADE_INITIAL: TargetAndTransition = { opacity: 0 };
export const DETAIL_FADE_ENTER: TargetAndTransition = {
  opacity: 1,
  transition: { duration: 0.12, ease: 'linear' },
};

/**
 * Word-level description morph.
 *
 * The card clamps the description to three lines, so handing the paragraph over
 * as one block slides the card's wrapping into place and then swaps it for the
 * dialog's. Instead every word the card showed travels from that wrapping into
 * this one, and the lines the clamp hid fade in where they land.
 *
 * The words move, and only move: same curve and the same start as the surface
 * carrying them, no per-word delay, no blur and no scaling. They run short of
 * the geometry's duration, though — a word crosses a fraction of the distance
 * the box does, and copy that is still sliding is copy you cannot read, so it
 * settles into the new wrapping and is legible while the box finishes landing
 * around it.
 */
const WORD_FRACTION = 0.7;
export const WORD_TRAVEL_MS = Math.round(OPEN_MS * WORD_FRACTION);
/** The lines the card's clamp hid have nowhere to travel from, so they fade. */
export const WORD_FADE_MS = WORD_TRAVEL_MS;
/** Longest a word can still be in flight, after which the hints come back off. */
export const WORD_SETTLE_MS = Math.max(WORD_TRAVEL_MS, WORD_FADE_MS) + 40;
/**
 * The return trip, which takes the whole handover rather than the open's
 * fraction of it. The handover is short already, and the way back has no box
 * growing around it to hide under: the words are the only thing moving, so
 * clipping them further just reads as the copy snapping into place.
 */
export const WORD_RETURN_MS = HANDOFF_MS;

/**
 * How long the dialog stays mounted after Radix reports a close, so its
 * dialog-only content can leave and its words can hand the card's wrapping back
 * before the surface is. Nothing else belongs in here: the box cannot move
 * until this elapses, so it is the whole of the close's perceived latency.
 */
export const MORPH_HANDOFF_MS = HANDOFF_MS;

/**
 * Card content with no counterpart in the dialog ("View details" and the footer
 * rule). It leaves early rather than pretending to become one of the dialog's
 * controls.
 */
export const CARD_HANDOFF_VARIANTS = {
  rest: { opacity: 1, transition: MORPH_CLOSE_TRANSITION },
  handoff: { opacity: 0, transition: MORPH_OPEN_TRANSITION },
} as const;
