import * as React from 'react';
import { cn } from '~/utils';

/** Static class lookups — Tailwind cannot see an interpolated `bg-series-${n}`. */
const SERIES_FILL = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
  'bg-series-6',
  'bg-series-7',
  'bg-series-8',
] as const;

const SERIES_TINT = [
  'bg-series-1/25',
  'bg-series-2/25',
  'bg-series-3/25',
  'bg-series-4/25',
  'bg-series-5/25',
  'bg-series-6/25',
  'bg-series-7/25',
  'bg-series-8/25',
] as const;

const SERIES_EDGE = [
  'ring-series-1',
  'ring-series-2',
  'ring-series-3',
  'ring-series-4',
  'ring-series-5',
  'ring-series-6',
  'ring-series-7',
  'ring-series-8',
] as const;

export const SERIES_SLOT_COUNT: number = SERIES_FILL.length;

/** Wraps out-of-range slots so a caller can never render an untinted segment. */
const slotIndex = (slot: number): number =>
  (((Math.trunc(slot) - 1) % SERIES_SLOT_COUNT) + SERIES_SLOT_COUNT) % SERIES_SLOT_COUNT;

export interface MeterSegment {
  /** Stable identity for keys; also the legend key's pairing id */
  id: string;
  value: number;
  /** 1-based slot in the categorical series scale */
  slot: number;
  /** Same hue, hatched — present but held out of the active set */
  hatched?: boolean;
  /** Translucent fill with a solid edge, for the one segment that grows */
  outlined?: boolean;
}

/** A hatch can't be expressed with semantic utilities; the stripe colour is
 *  still read from the theme at paint time so it follows every theme. */
const hatchStyle = (spacing: string): React.CSSProperties => ({
  backgroundImage: `repeating-linear-gradient(135deg, transparent 0 ${spacing}, rgb(var(--surface-tertiary)) ${spacing} calc(${spacing} + 2px))`,
});

export function seriesSwatchClass(segment: Pick<MeterSegment, 'slot' | 'outlined'>): string {
  const index = slotIndex(segment.slot);
  return segment.outlined
    ? cn(SERIES_TINT[index], 'ring-1 ring-inset', SERIES_EDGE[index])
    : SERIES_FILL[index];
}

/** The legend key. Lives beside the meter so a row and its segment cannot drift. */
export interface MeterSwatchProps extends React.ComponentPropsWithoutRef<'span'> {
  segment: Pick<MeterSegment, 'slot' | 'hatched' | 'outlined'>;
}

export function MeterSwatch({
  segment,
  className,
  ...props
}: MeterSwatchProps): React.ReactElement {
  return (
    <span
      aria-hidden="true"
      className={cn('size-2 flex-none rounded-sm', seriesSwatchClass(segment), className)}
      style={segment.hatched ? hatchStyle('1.5px') : undefined}
      {...props}
    />
  );
}

export interface SegmentedMeterProps extends React.ComponentPropsWithoutRef<'div'> {
  segments: MeterSegment[];
  /** Denominator for every segment width; the shortfall renders as free track */
  max: number;
  /** Segment id the caller considers active; every other segment recedes.
   *  Pairs a legend row with its slice of the bar on hover. */
  highlightId?: string | null;
}

/** Surface gap between touching fills, and the floor that keeps a present
 *  category from rendering as nothing. Both in px. */
const SEGMENT_GAP = 2;
const SEGMENT_MIN = 2;

/**
 * A part-to-whole meter: one tinted segment per series, free space left as
 * bare track.
 *
 * Each segment surrenders its share of the gap budget, so the fills and the
 * gaps between them together span exactly the used fraction — a bar reading
 * half full means half the window is used, however many categories are in it.
 *
 * The one deliberate overshoot is the {@link SEGMENT_MIN} floor: a category
 * present but too small to see is rounded up, and that rounding comes out of
 * free space, never out of a neighbouring category. It is bounded by
 * `SEGMENT_MIN` per sub-pixel category — on a 288px meter, five such categories
 * read about 3 percentage points fuller than the window actually is, and the
 * exact figures stay in the legend beside the bar.
 */
export const SegmentedMeter: React.ForwardRefExoticComponent<
  SegmentedMeterProps & React.RefAttributes<HTMLDivElement>
> = React.forwardRef<HTMLDivElement, SegmentedMeterProps>(
  ({ segments, max, highlightId, className, ...props }, ref) => {
    const rendered = segments.filter((segment) => segment.value > 0);
    const gapBudget = Math.max(rendered.length - 1, 0) * SEGMENT_GAP;
    const fractions = rendered.map((segment) => Math.min(segment.value / max, 1));
    const filled = Math.min(
      fractions.reduce((sum, fraction) => sum + fraction, 0),
      1,
    );

    return (
      <div
        ref={ref}
        className={cn(
          'flex h-2 w-full gap-[2px] overflow-hidden rounded-full bg-surface-tertiary',
          className,
        )}
        {...props}
      >
        {rendered.map((segment, index) => {
          const fraction = fractions[index];
          /** Each segment gives up its share of the gap budget, so the fills and
           *  the gaps between them together span exactly `filled` of the track. */
          const gapShare = filled > 0 ? (gapBudget * fraction) / filled : 0;

          return (
            <div
              key={segment.id}
              aria-hidden="true"
              className={cn(
                'h-full transition-[width,opacity] duration-300 motion-reduce:transition-none',
                seriesSwatchClass(segment),
                highlightId != null && segment.id !== highlightId && 'opacity-40',
              )}
              style={{
                width: `calc(${fraction} * 100% - ${gapShare.toFixed(3)}px)`,
                minWidth: `${SEGMENT_MIN}px`,
                ...(segment.hatched ? hatchStyle('2.5px') : undefined),
              }}
            />
          );
        })}
      </div>
    );
  },
);
SegmentedMeter.displayName = 'SegmentedMeter';
