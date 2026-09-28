import { ChartNoAxesGantt } from 'lucide-react';
import { Button, TooltipAnchor } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** Header control that opens the conversation trace over the chat. */
export default function TraceButton({ onClick }: { onClick: () => void }) {
  const localize = useLocalize();
  const label = localize('com_ui_trace_view');

  return (
    <TooltipAnchor
      description={label}
      render={
        <Button
          size="icon"
          variant="outline"
          aria-label={label}
          onClick={onClick}
          data-testid="header-trace-button"
          className="size-9 flex-shrink-0 rounded-xl bg-presentation hover:bg-surface-tertiary"
        >
          <ChartNoAxesGantt className="icon-md" aria-hidden="true" />
        </Button>
      }
    />
  );
}
