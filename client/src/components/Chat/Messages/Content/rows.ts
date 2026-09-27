/**
 * The vertical box of a live tool row: a 20px line with 6px margins above and
 * below, shared by every call card header and by the streaming cursor a
 * collapsed phase card renders beneath itself. The two trade places on every
 * absorb → next-call cycle of a run, so they must occupy the same height or
 * everything under the card moves on each swap.
 */
export const TOOL_ROW_CLASSES = 'relative my-1.5 flex h-5 shrink-0 items-center gap-2.5';

/**
 * The leading glyph slot of a row: 24px wide, the width of the message
 * header's avatar, and the row's own 20px tall. A 16px tool icon, the 14px
 * phase check and the 12px cursor dot all center in it, so every row's glyph
 * sits on the avatar's axis, and with the row's 8px gap every row's text
 * starts where the header's name does. `min-w` rather than `w`, so a stacked
 * icon strip can run wider without overlapping its label; never taller than
 * `TOOL_ROW_CLASSES`, whose `ProgressText` content is absolutely positioned
 * and would carry a taller slot 2px below the row's center.
 */
export const ROW_GLYPH_SLOT = 'flex h-5 min-w-6 shrink-0 items-center justify-center';

/**
 * The panel under an open header: its rows step in by one glyph slot and a
 * hairline hangs from the header's glyph down their left, so what is under the
 * header reads as under it. Carried by the panel's clipping wrapper, the one
 * `overflow-hidden` element the fold animation needs: the inset then lies
 * INSIDE the clip, which is what lets a failed row's stripe, drawn 12px left
 * of the row, show at all. The line is a pseudo-element, out of flow, so the
 * height animation is untouched; it starts at the wrapper's top and stops
 * short of the last row's bottom margin.
 */
export const FOLD_RAIL_CLASSES =
  "relative pl-6 before:absolute before:bottom-1.5 before:left-[11px] before:top-0.5 before:w-px before:bg-border-medium before:content-['']";
