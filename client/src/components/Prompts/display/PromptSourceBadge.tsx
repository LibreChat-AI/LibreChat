import { Cloud } from 'lucide-react';
import { TooltipAnchor } from '@librechat/client';
import type { TPromptGroupSource } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** Pass `interactive={false}` when nested in another interactive element. */
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
