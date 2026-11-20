import * as React from 'react';
import { cn } from '~/utils';

/** A categorical series slot, or the error role for an identity that is destructive by nature. */
export type SeriesLabelHue = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 'error';

const dotClassNames: Record<SeriesLabelHue, string> = {
  1: 'bg-series-1',
  2: 'bg-series-2',
  3: 'bg-series-3',
  4: 'bg-series-4',
  5: 'bg-series-5',
  6: 'bg-series-6',
  7: 'bg-series-7',
  8: 'bg-series-8',
  error: 'bg-status-error',
};

export interface SeriesLabelProps extends React.HTMLAttributes<HTMLSpanElement> {
  hue?: SeriesLabelHue;
}

/**
 * Small identity text (an HTTP verb, a principal type) keyed to a categorical
 * hue. The series slots are contracted as marks at 3:1, so the hue rides on a
 * decorative leading dot and the label stays on `text-secondary` at 4.5:1.
 * Typography belongs to the caller.
 */
const SeriesLabel: React.ForwardRefExoticComponent<
  SeriesLabelProps & React.RefAttributes<HTMLSpanElement>
> = React.forwardRef<HTMLSpanElement, SeriesLabelProps>(
  ({ hue, className, children, ...props }, ref) => (
    <span
      ref={ref}
      className={cn('text-text-secondary inline-flex items-center gap-1.5', className)}
      {...props}
    >
      {hue != null && (
        <span
          aria-hidden="true"
          className={cn('size-2 shrink-0 rounded-full', dotClassNames[hue])}
        />
      )}
      {children}
    </span>
  ),
);

SeriesLabel.displayName = 'SeriesLabel';

export { SeriesLabel };
