import type { AgentChannel } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

const statusLabels: Record<AgentChannel['status'], TranslationKeys> = {
  pending_install: 'com_ui_channels_pending',
  active: 'com_ui_channels_active',
  disabled: 'com_ui_channels_disabled',
  deleting: 'com_ui_channels_deleting',
};

export const statusColors: Record<AgentChannel['status'], string> = {
  pending_install: 'bg-status-warning',
  active: 'bg-status-success',
  disabled: 'bg-status-neutral',
  deleting: 'bg-status-info',
};

export default function ChannelStatus({
  status,
  pendingLabel = 'com_ui_channels_pending',
  className,
  dot = true,
}: {
  status: AgentChannel['status'];
  pendingLabel?: TranslationKeys;
  className?: string;
  /** Off where the status dot is already drawn elsewhere, such as on the row's icon. */
  dot?: boolean;
}) {
  const localize = useLocalize();
  return (
    <span
      className={cn(
        'text-text-secondary inline-flex shrink-0 items-center gap-1.5 text-xs',
        className,
      )}
    >
      {dot && (
        <span aria-hidden="true" className={`size-1.5 rounded-full ${statusColors[status]}`} />
      )}
      {localize(status === 'pending_install' ? pendingLabel : statusLabels[status])}
    </span>
  );
}
