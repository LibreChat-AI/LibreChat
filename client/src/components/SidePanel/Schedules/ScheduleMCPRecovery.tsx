import type { ScheduleMCPOutcome } from 'librechat-data-provider';
import { scheduleMCPStatusLabel, scheduleMCPNeedsAgentRecovery } from './errors';
import { useLocalize } from '~/hooks';

export default function ScheduleMCPRecovery({
  outcomes,
  fallbackAgentId,
  agentNames,
  onOpenAgent,
}: {
  outcomes: ScheduleMCPOutcome[];
  fallbackAgentId: string;
  agentNames?: Record<string, string>;
  onOpenAgent: (agentId: string) => void;
}) {
  const localize = useLocalize();
  const failures = outcomes.filter((item) => item.status !== 'ready');
  if (failures.length === 0) return null;

  return (
    <div className="space-y-1" role="alert">
      {failures.map((item, index) => {
        const ownerId = item.agentId ?? fallbackAgentId;
        const ownerLabel = agentNames?.[ownerId] ?? ownerId;
        return (
          <div
            key={`${item.server}:${ownerId}:${item.status}:${index}`}
            className="text-text-secondary flex flex-wrap items-baseline gap-x-2 text-xs"
          >
            <p>
              {item.server} ({ownerLabel}): {localize(scheduleMCPStatusLabel(item))}
            </p>
            {scheduleMCPNeedsAgentRecovery([item]) && (
              <button
                type="button"
                className="text-text-primary underline"
                aria-label={`${item.server}, ${ownerLabel}: ${localize('com_ui_schedule_mcp_open_agent')}`}
                onClick={() => onOpenAgent(ownerId)}
              >
                {localize('com_ui_schedule_mcp_open_agent')}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
