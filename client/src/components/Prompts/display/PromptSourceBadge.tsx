import { Cloud } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type { TPromptGroupSource } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/**
 * Marks a prompt group managed outside LibreChat (Langfuse). Renders nothing
 * for a native group, so callers can set this unconditionally as an item's
 * icon without a separate guard.
 *
 * `interactive` (default `true`) renders the focusable, tooltip-anchored
 * form used standalone, e.g. in `ChatGroupItem`. Pass `interactive={false}`
 * wherever this icon is itself nested inside another interactive element —
 * the Ariakit Select trigger (`SelectIcon`) or a `SelectItem` option label in
 * the Builder's combobox — where a focusable, tooltip-triggering child would
 * create a nested-interactive violation. The non-interactive form keeps the
 * same single accessible name (`role="img"` + `aria-label`) with no
 * `tabIndex` and no tooltip, rather than pairing a visible label with the
 * icon and duplicating that name.
 */
export default function PromptSourceBadge({
  source,
  interactive = true,
}: {
  source: TPromptGroupSource;
  interactive?: boolean;
}) {
  const localize = useLocalize();
  if (source !== 'langfuse') {
    return null;
  }
  const label = localize('com_ui_prompt_source_langfuse');
  if (!interactive) {
    return (
      <span role="img" aria-label={label} className="flex shrink-0 items-center">
        <Cloud className="text-text-secondary size-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <TooltipAnchor
      description={label}
      side="top"
      render={
        <span tabIndex={0} role="img" aria-label={label} className="flex shrink-0 items-center">
          <Cloud className="text-text-secondary size-3.5" aria-hidden="true" />
        </span>
      }
    />
  );
}
