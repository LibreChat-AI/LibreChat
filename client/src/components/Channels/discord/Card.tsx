import { useId } from 'react';
import { ChevronRight, Pencil, Plus, Settings2 } from 'lucide-react';
import {
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  IconButton,
  TooltipAnchor,
} from '@librechat/client';
import type { DiscordApplication, DiscordGuild } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';
import { HealthChip } from './health';
import Server from './Server';

type Trigger = HTMLButtonElement;

/** One Discord application: its credential health in the header, its servers and Connect inside. */
export default function Card({
  app,
  servers,
  open,
  disabled,
  onOpenChange,
  onEdit,
  onSettings,
  onConnect,
  onReconnect,
  onDisconnect,
}: {
  app: DiscordApplication;
  servers: DiscordGuild[];
  open: boolean;
  disabled: boolean;
  onOpenChange: (open: boolean) => void;
  onEdit: (app: DiscordApplication, trigger: Trigger) => void;
  onSettings: (app: DiscordApplication, trigger: Trigger) => void;
  onConnect: (app: DiscordApplication, trigger: Trigger) => void;
  onReconnect: (guild: DiscordGuild, trigger: Trigger) => void;
  onDisconnect: (guild: DiscordGuild, trigger: Trigger) => void;
}) {
  const localize = useLocalize();
  const id = useId();
  const name = app.name || app.applicationId;
  return (
    <div className="border-border-light rounded-lg border">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <div className="relative flex items-center gap-2 rounded-lg p-3">
          <CollapsibleTrigger asChild>
            <Button
              variant={null}
              className="absolute inset-0 h-full w-full"
              aria-labelledby={`${id}-label`}
            />
          </CollapsibleTrigger>
          <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-2 text-sm">
            <ChevronRight
              className={open ? 'size-4 shrink-0 rotate-90' : 'size-4 shrink-0'}
              aria-hidden="true"
            />
            <span id={`${id}-label`} className="flex min-w-0 flex-1 flex-col items-start">
              <span className="max-w-full truncate font-medium">
                {app.name || localize('com_ui_discord_app')}
              </span>
              <span className="text-text-secondary max-w-full truncate font-mono text-xs">
                {app.applicationId}
              </span>
            </span>
            <HealthChip app={app} />
          </div>
          <div className="relative z-10 flex shrink-0 items-center gap-2">
            <TooltipAnchor
              description={localize('com_ui_discord_app_rotate')}
              render={
                <IconButton
                  label={localize('com_ui_discord_rotate_named', { 0: name })}
                  variant="ghost"
                  size="sm"
                  shape="inset"
                  disabled={disabled}
                  onClick={(event) => onEdit(app, event.currentTarget)}
                >
                  <Pencil className="size-4" aria-hidden="true" />
                </IconButton>
              }
            />
            <TooltipAnchor
              description={localize('com_ui_discord_settings')}
              render={
                <IconButton
                  label={localize('com_ui_discord_settings_named', { 0: name })}
                  variant="ghost"
                  size="sm"
                  shape="inset"
                  disabled={disabled}
                  onClick={(event) => onSettings(app, event.currentTarget)}
                >
                  <Settings2 className="size-4" aria-hidden="true" />
                </IconButton>
              }
            />
          </div>
        </div>
        <CollapsibleContent motion="height" className="overflow-hidden">
          <div className="border-border-light space-y-3 border-t p-3">
            {servers.map((guild) => (
              <Server
                key={guild.installationId}
                guild={guild}
                disabled={disabled}
                onReconnect={onReconnect}
                onDisconnect={onDisconnect}
              />
            ))}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={disabled}
                aria-label={localize('com_ui_discord_connect_named', { 0: name })}
                onClick={(event) => onConnect(app, event.currentTarget)}
              >
                <Plus className="size-4" aria-hidden="true" />
                {localize('com_ui_discord_connect')}
              </Button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
