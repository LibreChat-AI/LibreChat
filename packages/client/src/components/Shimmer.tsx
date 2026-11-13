import type { HTMLAttributes, ReactElement } from 'react';
import { cn } from '~/utils';

export type ShimmerProps = Omit<HTMLAttributes<HTMLSpanElement>, 'children'> & {
  /** The label. Text only: the sweep is a second copy of it, drawn from an attribute. */
  children: string;
  /** False renders the label at rest, with no sweep and no extra elements. */
  active?: boolean;
};

/**
 * The sweep an in-flight label carries: a running tool call, streaming
 * reasoning, the elapsed timer.
 *
 * The label's own glyphs sit at the sweep's dim stop. Over them a masked band
 * slides across the label while a second, brighter copy of the text inside it
 * slides back by the same distance, so the glyphs hold still and only the gap
 * in the mask travels. Both moves are transforms, so the browser's compositor
 * runs the sweep on its own: no style, paint or commit on the main thread per
 * frame, however long the transcript around the label is, and no stutter when
 * the main thread is busy. Animating a gradient behind `background-clip: text`
 * repainted the label every frame instead, and each of those paints walked the
 * transcript.
 *
 * The copy is generated content, so the text exists once in the document: one
 * match for a text query, one string for a reader to select or copy.
 */
export function Shimmer({
  children,
  active = true,
  className,
  ...props
}: ShimmerProps): ReactElement {
  return (
    <span {...props} className={cn(active && 'shimmer', className)}>
      {children}
      {active && (
        <span className="shimmer-clip" aria-hidden="true">
          <span className="shimmer-band">
            <span className="shimmer-copy" data-text={children} />
          </span>
        </span>
      )}
    </span>
  );
}
