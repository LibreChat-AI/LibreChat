import type { CSSProperties, JSX } from 'react';
import { cn } from '~/utils';

/** Enough offset for the lift to travel around the row rather than pulse in unison. */
const DOT_STAGGER_MS = 160;

export interface LoadingDotsProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** Three reads as motion without implying measured progress. */
  count?: number;
}

/**
 * A waiting indicator for text-height contexts — inside a button label, beside
 * a status line — where a spinner reads as heavier than the text it follows.
 * Dots inherit `currentColor`, so they take the colour of whatever they sit in.
 * Decorative by construction: callers own the live region that announces the
 * wait, and reduced-motion users get static dots.
 */
export function LoadingDots({ count = 3, className, ...props }: LoadingDotsProps): JSX.Element {
  return (
    <span
      className={cn('inline-flex items-center gap-[3px]', className)}
      aria-hidden="true"
      {...props}
    >
      {Array.from({ length: count }, (_, index) => (
        <span
          key={index}
          className="animate-loading-dot size-1 rounded-full bg-current motion-reduce:animate-none motion-reduce:opacity-60"
          style={{ '--loading-dot-delay': `${index * DOT_STAGGER_MS}ms` } as CSSProperties}
        />
      ))}
    </span>
  );
}

export default LoadingDots;
