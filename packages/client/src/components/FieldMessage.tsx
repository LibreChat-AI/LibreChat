import * as React from 'react';
import { cn } from '~/utils';

/** Reserved helper heights, keyed by the number of `leading-4` lines. */
const reservedLines = {
  1: 'min-h-4',
  2: 'min-h-8',
  3: 'min-h-12',
} as const;

export interface FieldMessageProps {
  id: string;
  /** Validation failure text; takes precedence over the hint */
  message?: string | null;
  /** Resting helper text shown while the field is valid */
  hint?: string | null;
  /** Helper lines to reserve; raise it when the longest message wraps */
  lines?: keyof typeof reservedLines;
  className?: string;
}

/**
 * Helper line rendered under a form field. It reserves `lines` worth of vertical
 * space up front, so swapping between the hint, an error, and nothing never
 * shifts the surrounding layout. Fields whose longest message wraps at the
 * narrowest supported width should reserve the height that message needs.
 */
function FieldMessage({
  id,
  message,
  hint,
  lines = 1,
  className,
}: FieldMessageProps): React.JSX.Element {
  return (
    <p
      id={id}
      role={message ? 'alert' : undefined}
      className={cn(
        reservedLines[lines],
        'text-xs leading-4',
        message ? 'text-text-destructive' : 'text-text-secondary',
        className,
      )}
    >
      {message || hint || ''}
    </p>
  );
}

export { FieldMessage };
