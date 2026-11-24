import { useId } from 'react';
import { Link2Off, RotateCw } from 'lucide-react';
import { Chip, IconButton, TooltipAnchor } from '@librechat/client';
import type { DiscordGuild } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** One connected server: its name and state, with the actions an administrator can take on it. */
export default function Server({
  guild,
  disabled,
  onReconnect,
  onDisconnect,
}: {
  guild: DiscordGuild;
  disabled: boolean;
  onReconnect: (guild: DiscordGuild, trigger: HTMLButtonElement) => void;
  onDisconnect: (guild: DiscordGuild, trigger: HTMLButtonElement) => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const active = guild.status === 'active';
  return (
    <div role="group" aria-labelledby={`${id}-name`} className="flex items-center gap-3 py-2">
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
        <p id={`${id}-name`} className="text-sm font-medium break-words">
          {guild.guildName}
        </p>
        <Chip tone={active ? 'success' : 'neutral'}>
          {localize(active ? 'com_ui_discord_connected' : 'com_ui_discord_disconnected')}
        </Chip>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <TooltipAnchor
          description={localize('com_ui_discord_reconnect')}
          render={
            <IconButton
              label={localize('com_ui_discord_reconnect_named', { 0: guild.guildName })}
              variant="ghost"
              size="sm"
              shape="control"
              disabled={disabled}
              onClick={(event) => onReconnect(guild, event.currentTarget)}
            >
              <RotateCw className="size-4" aria-hidden="true" />
            </IconButton>
          }
        />
        {active && (
          <TooltipAnchor
            description={localize('com_ui_discord_disconnect')}
            render={
              <IconButton
                label={localize('com_ui_discord_disconnect_named', { 0: guild.guildName })}
                variant="ghost"
                size="sm"
                shape="control"
                disabled={disabled}
                onClick={(event) => onDisconnect(guild, event.currentTarget)}
              >
                <Link2Off className="size-4" aria-hidden="true" />
              </IconButton>
            }
          />
        )}
      </div>
    </div>
  );
}
