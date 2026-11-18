import { memo, useCallback, useState } from 'react';
import { cn, Shimmer } from '@librechat/client';
import type { NamedExoticComponent } from 'react';

/** Matches `EXPAND_TRANSITION` so the panel and ticker follow the same curve.
 *  The shared class sets animation timing: Tailwind's `ease-*` also names
 *  transition timing, which makes an arbitrary easing value ambiguous. */
export const FOLD_EASING = 'duration-300 animation-ease-fold';

/**
 * The phase header is a ticker, not a title. A client-synthesized card
 * re-titles itself every time it absorbs another finished block, and swapping
 * that text instantly is what makes the absorbed row look like it simply
 * vanished from under the reader. The retired line rises out of the clipped
 * row while the new summary comes up from below, so the work visibly moves
 * into the line that now stands for it.
 */
/**
 * The shimmering text of a live line, on its own element. `.shimmer` declares
 * `position` and `display`, so sharing an element with the ticker would undo
 * the slide's absolute placement; the retired line would sit inline beside
 * its successor. `align-top` keeps the inline box from adding descender space,
 * which made a live row 2px taller than the settled row it becomes.
 */
function LiveLine({ text }: { text: string }) {
  return <Shimmer className="max-w-full truncate align-top">{text}</Shimmer>;
}

type PhaseLabelProps = {
  text: string;
  animate: boolean;
  /** Identity of what produced `text`. A streamed sentence keeps its source
   *  while it grows, and sliding a line out to bring a longer copy of itself
   *  in would read as flicker, so an unchanged source extends in place. */
  source?: string;
  live?: boolean;
  /** Claim the row's free space, the default. Cleared when something has to
   *  sit immediately after the text; the box then measures the line itself,
   *  so its neighbour reads as part of it instead of drifting to the margin. */
  grow?: boolean;
  /** Id for the current line, so a live disclosure can be named by it alone. */
  lineId?: string;
};

const PhaseLabel: NamedExoticComponent<PhaseLabelProps> = memo(function PhaseLabel({
  text,
  animate,
  source,
  live = false,
  grow = true,
  lineId,
}: PhaseLabelProps) {
  const [lines, setLines] = useState<{
    current: string;
    retired: string | null;
    entered: boolean;
    source?: string;
  }>({ current: text, retired: null, entered: false, source });

  /** Adjusted during render rather than in an effect. A passive effect runs
   *  after paint, so a swap with no animation would leave the previous summary
   *  on screen for a frame while the button's `aria-label` already carried the
   *  new one. React re-renders this component immediately instead. */
  if (lines.current !== text || lines.source !== source) {
    const moved = source == null || source !== lines.source;
    const swaps = animate && lines.current.length > 0 && moved;
    setLines({
      current: text,
      retired: swaps ? lines.current : null,
      entered: swaps || (lines.entered && source != null && source === lines.source),
      source,
    });
  }

  /** Clears only the retired line. `entered` outlives it on purpose: dropping
   *  the incoming line's animation class the moment its partner's
   *  `animationend` fires would snap a still-running slide back to its resting
   *  position. The class is inert once the animation has finished, and the
   *  element is keyed by its text, so it cannot replay. */
  const clearRetired = useCallback(() => {
    setLines((previous) => (previous.retired == null ? previous : { ...previous, retired: null }));
  }, []);

  return (
    <span
      className={cn(
        'tool-status-text relative block min-w-0 overflow-hidden text-start',
        grow && 'flex-1',
      )}
      title={text}
    >
      {lines.retired != null && (
        <span
          key={`retired-${lines.retired}`}
          className={cn(
            'absolute inset-x-0 top-0 block truncate',
            'animate-out fade-out-0 slide-out-to-top-5 animation-fill-forwards',
            FOLD_EASING,
          )}
          /** The sweep on the inner span loops forever and its `animationend`
           *  never comes; only this element's own slide may clear the line. */
          onAnimationEnd={(event) => event.target === event.currentTarget && clearRetired()}
          aria-hidden="true"
        >
          {live ? <LiveLine text={lines.retired} /> : lines.retired}
        </span>
      )}
      <span
        /** Keyed by source while live, so a growing sentence updates one
         *  element instead of remounting; and replaying its slide; per paint. */
        key={`current-${source ?? lines.current}`}
        id={lineId}
        className={cn(
          'block truncate',
          lines.entered && `animate-in fade-in-0 slide-in-from-bottom-5 ${FOLD_EASING}`,
        )}
      >
        {live ? <LiveLine text={lines.current} /> : lines.current}
      </span>
    </span>
  );
});

export default PhaseLabel;
