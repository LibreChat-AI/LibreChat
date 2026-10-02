import { useState } from 'react';
import { TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

interface MemoryUsageBadgeProps {
  percentage: number;
  tokenLimit: number;
  totalTokens?: number;
  /** Custom current value for tooltip (overrides totalTokens) */
  tooltipCurrent?: number;
  /** Custom max value for tooltip (overrides tokenLimit) */
  tooltipMax?: number;
}

const getStatusColor = (pct: number): string => {
  if (pct > 90) {
    return 'bg-status-error-subtle text-status-error';
  }
  if (pct > 75) {
    return 'bg-status-warning-subtle text-status-warning';
  }
  return 'bg-status-success-subtle text-status-success';
};

/**
 * How full the memory is, in either of the two ways that answer it: the share of
 * the budget, or the count against it. Which one is wanted depends on the question
 * being asked, so the badge carries both and a click swaps them, with the one that
 * is hidden shown on hover.
 */
export default function MemoryUsageBadge({
  percentage,
  tokenLimit,
  totalTokens,
  tooltipCurrent,
  tooltipMax,
}: MemoryUsageBadgeProps) {
  const localize = useLocalize();
  const [showTokens, setShowTokens] = useState(false);

  const tokenLabel = localize('com_ui_tokens');
  const current = tooltipCurrent ?? totalTokens;
  const max = tooltipMax ?? tokenLimit;

  const tokenText =
    current !== undefined
      ? `${current.toLocaleString()} / ${max.toLocaleString()} ${tokenLabel}`
      : `${max.toLocaleString()} ${tokenLabel}`;
  const percentText = `${percentage}% ${localize('com_ui_used').toLowerCase()}`;

  return (
    <>
      {/* The button's name changes silently while focus is elsewhere, so a create,
          edit or delete that moves the usage is announced from here instead. */}
      <span className="sr-only" role="status" aria-atomic="true">
        {`${localize('com_ui_usage')}: ${percentage}%`}
      </span>
      <TooltipAnchor
        /** The reading the badge is not showing, so hovering answers the other
         *  question without having to click for it. */
        description={showTokens ? percentText : tokenText}
        side="top"
        render={
          <button
            type="button"
            onClick={() => setShowTokens((shown) => !shown)}
            /** The name has to carry the words on the face of the control, or a voice
             *  command that reads them back matches nothing (WCAG 2.5.3). */
            aria-label={`${localize('com_ui_usage')}: ${showTokens ? tokenText : percentText}`}
            className={cn(
              'inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1',
              'text-xs font-medium hover:underline',
              'focus-visible:ring-border-heavy focus-visible:ring-2 focus-visible:outline-hidden',
              getStatusColor(percentage),
            )}
          >
            {showTokens ? tokenText : percentText}
          </button>
        }
      />
    </>
  );
}
