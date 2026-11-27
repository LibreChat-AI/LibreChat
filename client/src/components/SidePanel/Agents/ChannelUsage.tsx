import { InfoHoverCard } from '@librechat/client';
import { Info, Hash, Link2, MessageSquare } from 'lucide-react';
import { useLocalize } from '~/hooks';

interface ChannelUsageProps {
  /** The bot's name in Slack, taken from the manifest. */
  name: string;
  /** Per-user connections ask each Slack user to link their account once. */
  perUser: boolean;
  /** Admins also get a hint about what the deployment must run. */
  isAdmin?: boolean;
}

/** How to talk to the connected bot: its handle, where to use it, and the one-time link. */
export default function ChannelUsage({ name, perUser, isAdmin = false }: ChannelUsageProps) {
  const localize = useLocalize();
  const items = [
    { icon: Hash, text: localize('com_ui_channels_usage_channel', { 0: name }) },
    { icon: MessageSquare, text: localize('com_ui_channels_usage_dm') },
    ...(perUser ? [{ icon: Link2, text: localize('com_ui_channels_usage_link') }] : []),
  ];
  return (
    <section className="bg-surface-secondary space-y-2.5 rounded-xl p-4">
      <div className="flex items-center gap-1.5">
        <h4 className="text-sm font-medium">
          {localize('com_ui_channels_usage_title', { 0: name })}
        </h4>
        {isAdmin && (
          <InfoHoverCard text={localize('com_ui_channels_gateway_admin_note')}>
            <Info className="text-text-tertiary size-3.5" aria-hidden="true" />
          </InfoHoverCard>
        )}
      </div>
      <ul className="text-text-secondary space-y-1.5 text-sm">
        {items.map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-start gap-2">
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
