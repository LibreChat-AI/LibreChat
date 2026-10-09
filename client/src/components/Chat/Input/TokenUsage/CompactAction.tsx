import { memo, useId } from 'react';
import { ScrollText } from 'lucide-react';
import { Button, Spinner, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** The usage popover sits at z-200, above the tooltip default (150). */
const TOOLTIP_Z_INDEX = 250;

interface CompactActionProps {
  compact: () => void;
  canCompact: boolean;
  isCompacting: boolean;
}

/**
 * Manual context compaction, surfaced where the context usage is already read.
 * Presentational on purpose: the popover unmounts on hide, so the hook that
 * drives the submission lives in the always-mounted indicator above.
 */
function CompactAction({ compact, canCompact, isCompacting }: CompactActionProps) {
  const localize = useLocalize();
  const descriptionId = useId();
  const description = localize('com_ui_context_compact_info');

  return (
    <div>
      <TooltipAnchor
        side="bottom"
        zIndex={TOOLTIP_Z_INDEX}
        description={description}
        render={
          <Button
            type="button"
            variant="outline"
            onClick={compact}
            disabled={!canCompact}
            aria-busy={isCompacting}
            aria-describedby={descriptionId}
            className="h-8 w-full justify-center gap-2 text-sm"
          >
            {isCompacting ? (
              <Spinner className="size-4" />
            ) : (
              <ScrollText className="size-4" aria-hidden="true" />
            )}
            {isCompacting
              ? localize('com_ui_context_compacting')
              : localize('com_ui_context_compact')}
          </Button>
        }
      />
      {/* Ariakit's tooltip anchor sets no `aria-describedby`, and the tooltip
          exists only while hovered, so the copy stays reachable here. */}
      <span id={descriptionId} className="sr-only">
        {description}
      </span>
    </div>
  );
}

export default memo(CompactAction);
