import { cn } from '@librechat/client';
import { Check, CircleX, TriangleAlert } from 'lucide-react';
import type { ReactElement } from 'react';
import { FOLD_EASING } from '../PhaseLabel';
import { ROW_GLYPH_SLOT } from '../rows';

export type PhaseGlyphProps = {
  failed: boolean;
  partial?: boolean;
};

export type PhaseMarkerProps = PhaseGlyphProps & {
  label: string;
  animate?: boolean;
};

/** The header's icon slot. Its only job is geometric: every other row in the
 *  transcript opens with the same glyph slot and an 8px gap, so a summary
 *  rendered without one sits to the left of the rows it replaces. The fold
 *  then moves its own text sideways at the moment the reader is trying to
 *  follow it. */
export function PhaseGlyph({ failed, partial = false }: PhaseGlyphProps): ReactElement {
  let Icon = Check;
  let tone = 'text-text-secondary';
  if (failed) {
    Icon = CircleX;
    tone = 'text-status-error';
  } else if (partial) {
    Icon = TriangleAlert;
    tone = 'text-status-warning';
  }
  return (
    <span className={cn(ROW_GLYPH_SLOT, tone)} aria-hidden="true">
      <Icon size={14} />
    </span>
  );
}

/** A phase summary with no activity rows to disclose. */
export default function PhaseMarker({
  label,
  failed,
  partial = false,
  animate = false,
}: PhaseMarkerProps): ReactElement {
  return (
    <div
      className={cn(
        'text-text-secondary mt-1 mb-2 flex min-h-7 w-full items-center gap-2 py-1',
        animate && `animate-in fade-in-0 motion-reduce:animate-none ${FOLD_EASING}`,
      )}
      data-testid="activity-phase-card"
    >
      <PhaseGlyph failed={failed} partial={partial} />
      <span
        className="tool-status-text min-w-0 flex-1 truncate text-start font-medium"
        role="status"
        title={label}
      >
        {label}
      </span>
    </div>
  );
}
