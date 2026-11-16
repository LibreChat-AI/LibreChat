import {
  Button,
  HoverCard,
  HoverCardContent,
  HoverCardPortal,
  HoverCardTrigger,
} from '@librechat/client';
import type { AgentChannel } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import ChannelStatus, { statusColors } from './ChannelStatus';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/** One row of the details list: a quiet label and a value, the same size and spacing for every field. */
function Row({
  label,
  children,
  mono = false,
}: {
  label: string;
  children: ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-1 leading-5">
      <dt className="text-text-secondary shrink-0">{label}</dt>
      <dd className={cn('text-text-primary min-w-0 text-end break-all', mono && 'font-mono')}>
        {children}
      </dd>
    </div>
  );
}

/** What identifies a connection: its state, how accounts are used and the IDs support asks for. */
export function ChannelDetails({ channel }: { channel: AgentChannel }) {
  const localize = useLocalize();
  return (
    <dl className="text-sm">
      <Row label={localize('com_ui_channels_status_label')}>
        <ChannelStatus status={channel.status} className="text-text-primary text-sm" />
      </Row>
      <Row label={localize('com_ui_channels_connection_type')}>
        {localize(
          channel.credentialMode === 'shared'
            ? 'com_ui_channel_link_shared'
            : 'com_ui_channel_link_per_user',
        )}
      </Row>
      <Row label={localize('com_ui_channels_connection_id_label')} mono>
        {channel.channelId}
      </Row>
      {channel.slack?.teamId && (
        <Row label={localize('com_ui_channels_workspace_label')} mono>
          {channel.slack.teamId}
        </Row>
      )}
      {channel.slack?.appId && (
        <Row label={localize('com_ui_channels_app_id')} mono>
          {channel.slack.appId}
        </Row>
      )}
    </dl>
  );
}

/** The Slack mark with a dot for the connection's state; hovering or focusing it shows the details. */
export function ChannelHeaderIcon({ channel }: { channel: AgentChannel }) {
  const localize = useLocalize();
  return (
    <HoverCard openDelay={100}>
      <HoverCardTrigger asChild>
        <Button
          type="button"
          variant="hit-area"
          className="relative size-10 shrink-0"
          aria-label={localize('com_ui_channels_connection_details')}
        >
          <span className="border-border-light bg-surface-secondary flex size-10 items-center justify-center rounded-xl border">
            <img src="assets/slack.svg" alt="" className="size-5" />
          </span>
          <span
            aria-hidden="true"
            className={cn(
              'ring-surface-dialog absolute -end-0.5 -bottom-0.5 size-3 rounded-full ring-2',
              statusColors[channel.status],
            )}
          />
        </Button>
      </HoverCardTrigger>
      <HoverCardPortal>
        <HoverCardContent side="bottom" align="start" className="w-96">
          <ChannelDetails channel={channel} />
        </HoverCardContent>
      </HoverCardPortal>
    </HoverCard>
  );
}
